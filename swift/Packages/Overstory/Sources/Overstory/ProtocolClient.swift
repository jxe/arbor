import Foundation
import os

public protocol ProtocolCredentialProvider: Sendable {
    func credential() async throws -> String?
    /// Called when Canopy rejects the credential (401), so a provider that
    /// caches it reads it again for the next request.
    func invalidate() async
}

private struct StaticProtocolCredential: ProtocolCredentialProvider, Sendable {
    private let value: String?

    init(_ value: String?) { self.value = value }
    func credential() async throws -> String? { value }
    func invalidate() {}
}

public actor ProtocolClient {
    public typealias RetryDelay = @Sendable (_ attempt: Int) async throws -> Void

    /// Wait 100 ms before the first retry and 500 ms before each later one.
    public static let defaultRetryDelay: RetryDelay = { attempt in
        try await Task.sleep(for: .milliseconds(attempt == 1 ? 100 : 500))
    }

    /// Submissions are idempotent by request digest, so a lost exchange is retried this many times in all.
    private static let updateAttempts = 3

    private let origin: URL
    private let credentialProvider: any ProtocolCredentialProvider
    private let sessionSource: @Sendable () -> URLSession
    private var session: URLSession { sessionSource() }
    private let retryDelay: RetryDelay
    /// How requests that carry objects travel (tree operations §4.4).
    private let wireEncoding: ProtocolWireEncoding
    private let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        // Protocol retries are byte-stable as well as semantically identical.
        encoder.outputFormatting = [.sortedKeys]
        return encoder
    }()
    private let decoder = JSONDecoder()

    public init(
        origin: URL,
        credential: String? = nil,
        session: URLSession = .shared,
        retryDelay: @escaping RetryDelay = ProtocolClient.defaultRetryDelay,
        encoding: ProtocolWireEncoding = .cbor
    ) {
        self.origin = origin
        self.credentialProvider = StaticProtocolCredential(credential)
        self.sessionSource = { session }
        self.retryDelay = retryDelay
        self.wireEncoding = encoding
    }

    public init(
        origin: URL,
        credentialProvider: any ProtocolCredentialProvider,
        session: URLSession = .shared,
        retryDelay: @escaping RetryDelay = ProtocolClient.defaultRetryDelay,
        encoding: ProtocolWireEncoding = .cbor
    ) {
        self.origin = origin
        self.credentialProvider = credentialProvider
        self.sessionSource = { session }
        self.retryDelay = retryDelay
        self.wireEncoding = encoding
    }

    /// A client whose requests use `sessions`' current session, so renewing it
    /// moves this client to fresh connections too.
    public init(
        origin: URL,
        credentialProvider: any ProtocolCredentialProvider,
        sessions: ProtocolSession,
        retryDelay: @escaping RetryDelay = ProtocolClient.defaultRetryDelay,
        encoding: ProtocolWireEncoding = .cbor
    ) {
        self.origin = origin
        self.credentialProvider = credentialProvider
        self.sessionSource = { sessions.current }
        self.retryDelay = retryDelay
        self.wireEncoding = encoding
    }

    /// The account at its home host. A placement host's descriptor is
    /// refused: read it with `placementAccount()`.
    public func account() async throws -> ProtocolAccountSnapshot {
        let value = try await anyAccount()
        switch value.account {
        case let .home(account):
            return ProtocolAccountSnapshot(account: account)
        case let .placement(account):
            throw ProtocolValidationError.invalidValue("\(canonicalOrigin) is a placement host for this profile; its home host is \(account.homeHost)")
        }
    }

    /// The account at a placement host (accounts §1.3).
    public func placementAccount() async throws -> ProtocolPlacementAccountSnapshot {
        let value = try await anyAccount()
        guard case let .placement(account) = value.account else {
            throw ProtocolValidationError.invalidValue("\(canonicalOrigin) is this profile's home host, not a placement host")
        }
        return ProtocolPlacementAccountSnapshot(account: account)
    }

    /// The account descriptor as the host sent it, home or placement.
    public func anyAccount() async throws -> ProtocolAnyAccountSnapshot {
        let value: ProtocolAnyAccountSnapshot = try await get(path: "/.arbor/account")
        switch value.account {
        case let .home(account):
            _ = try account.community.validated()
            _ = try account.configuration.validated()
            for profile in account.writableProfiles { _ = try profile.validated() }
        case let .placement(account):
            _ = try account.validated()
        }
        guard !value.account.id.isEmpty else {
            throw ProtocolValidationError.invalidValue("Malformed account snapshot")
        }
        return value
    }

    public func trees() async throws -> ProtocolRemoteSnapshot<[ProtocolTreeDescriptor]> {
        let value: ProtocolRemoteSnapshot<[ProtocolTreeDescriptor]> = try await get(path: "/.arbor/trees")
        return ProtocolRemoteSnapshot(snapshot: try value.snapshot.map { try $0.validated() })
    }

    /// The tree resource itself: its current descriptor and the cursor to watch after.
    public func descriptor(tree: String) async throws -> ProtocolCurrentTree {
        let value: ProtocolCurrentTree = try await get(path: "/.arbor/trees/\(component(tree))")
        return try value.validated(expectedTree: tree)
    }

    public func conflicts(tree: String, state: String, root: String, after: String? = nil, conflict: String? = nil) async throws -> ProtocolDecisionPageContract {
        guard after == nil || conflict == nil else { throw ProtocolValidationError.invalidValue("Conflicting inspection options") }
        func queryValue(_ value: String) -> String { value.addingPercentEncoding(withAllowedCharacters: .alphanumerics)! }
        var query = "state=\(queryValue(state))"
        if let after { query += "&after=\(queryValue(after))" }
        if let conflict { query += "&conflict=\(queryValue(conflict))" }
        let page: ProtocolDecisionPageContract = try await get(path: "/.arbor/trees/\(component(tree))/conflicts?\(query)")
        try page.validateContext(tree: tree, state: state, root: root)
        return page
    }

    /// The configuration of the tree whose canonical root is `path`
    /// (`/~joe/todos;arbor-config`), answered only to the tree's administrators.
    public func resolveConfiguration(path: String) async throws -> ProtocolLocatorResolution {
        let encoded = "/" + path.split(separator: "/").map { component(String($0)) }.joined(separator: "/")
        let value: ProtocolLocatorResolution = try await get(path: "/.well-known/arbor\(encoded);arbor-config")
        _ = try value.enclosingTree.validated()
        guard value.ref.tree == value.enclosingTree.id, value.enclosingTree.kind == "tree-configuration", !value.observedThrough.isEmpty else {
            throw ProtocolValidationError.invalidValue("Malformed configuration resolution")
        }
        return value
    }

    public func resolve(path: String) async throws -> ProtocolLocatorResolution {
        let encoded = path == "/" ? "" : "/" + path.split(separator: "/").map { component(String($0)) }.joined(separator: "/")
        let value: ProtocolLocatorResolution = try await get(path: "/.well-known/arbor\(encoded)")
        _ = try value.enclosingTree.validated()
        guard value.ref.tree == value.enclosingTree.id, !value.observedThrough.isEmpty else {
            throw ProtocolValidationError.invalidValue("Malformed locator resolution")
        }
        return value
    }

    public func object(tree: String, hash: String) async throws -> Data {
        try validateObjectHash(hash)
        var request = try await authorizedRequest(path: "/.arbor/trees/\(component(tree))/objects/\(component(hash))")
        request.setValue("application/octet-stream", forHTTPHeaderField: "Accept")
        let (data, response) = try await logged(request, kind: .read, name: "objects", tree: tree)
        let status = try statusCode(response)
        try validate(data: data, status: status)
        let actual = ProtocolObjectCodec.hash(data)
        guard actual == hash else { throw ProtocolValidationError.objectHashMismatch(expected: hash, actual: actual) }
        return data
    }

    public func snapshot(tree: String, root: String) async throws -> ProtocolSnapshot {
        try validateObjectHash(root)
        var request = try await authorizedRequest(
            path: "/.arbor/trees/\(component(tree))/snapshots/\(component(root))"
        )
        request.setValue("application/cbor", forHTTPHeaderField: "Accept")
        let (data, response) = try await logged(request, kind: .read, name: "snapshot", tree: tree)
        let status = try statusCode(response)
        try validate(data: data, status: status)
        guard let http = response as? HTTPURLResponse,
              http.value(forHTTPHeaderField: "Content-Type")?.lowercased().hasPrefix("application/cbor") == true else {
            throw ProtocolValidationError.invalidValue("Snapshot response is not application/cbor")
        }
        return try ProtocolSnapshotBundleCodec.decode(data, root: root)
    }

    /// Descriptive metadata of the current root's file entries: never part of
    /// any hash, and describing `update`, which may be newer than a snapshot
    /// just installed (the watch corrects that).
    public func entryMetadata(tree: String) async throws -> ProtocolEntryMetadata {
        let value: ProtocolEntryMetadata = try await get(path: "/.arbor/trees/\(component(tree))/entry-metadata")
        guard !value.update.isEmpty, value.entries.keys.allSatisfy({ $0.hasPrefix("/") }) else {
            throw ProtocolValidationError.invalidValue("Malformed entry metadata")
        }
        return value
    }

    public func prepareUpdate(
        tree: String,
        base: ProtocolUpdateBase,
        snapshot: ProtocolSnapshot,
        ifCurrent: String? = nil
    ) throws -> PreparedProtocolUpdate {
        guard !tree.isEmpty, !base.update.isEmpty else { throw ProtocolValidationError.invalidValue("Update identity is empty") }
        try validateObjectHash(base.root)
        _ = try ProtocolObjectGraph.validate(snapshot)
        let request = ProtocolUpdateRequest(
            base: base,
            candidate: snapshot.root,
            ifCurrent: ifCurrent,
            objects: snapshot.objects
        )
        return try prepareUpdates(tree: tree, base: base, updates: request.updates)
    }

    public func prepareUpdates(
        tree: String,
        base: ProtocolUpdateBase,
        updates: [ProtocolCandidateUpdate]
    ) throws -> PreparedProtocolUpdate {
        guard !tree.isEmpty, !base.update.isEmpty, !updates.isEmpty else {
            throw ProtocolValidationError.invalidValue("Update string identity is empty")
        }
        try validateObjectHash(base.root)
        let request = ProtocolUpdateRequest(base: base.update, updates: updates)
        return try prepared(tree: tree, request: request, requestDigests: updateRequestDigests(tree: tree, base: base, updates: updates))
    }

    /// Fix a request's body in this client's encoding; every retry sends these bytes.
    func prepared(tree: String, request: ProtocolUpdateRequest, requestDigests: [String]) throws -> PreparedProtocolUpdate {
        PreparedProtocolUpdate(
            tree: tree,
            body: try wireEncoding.encode(request),
            requestDigests: requestDigests,
            contentType: wireEncoding.storedContentType
        )
    }

    public func submitUpdate(_ prepared: PreparedProtocolUpdate) async throws -> ProtocolUpdateResult {
        (try await submitUpdateResponse(prepared)).result
    }

    public func submitUpdateResponse(_ prepared: PreparedProtocolUpdate) async throws -> ProtocolUpdateResponse {
        var request = try await authorizedRequest(path: "/.arbor/trees/\(component(prepared.tree))/updates")
        request.httpMethod = "POST"
        // The body keeps the encoding it was prepared in; the success answers in the same one.
        request.setValue(prepared.encoding.mediaType, forHTTPHeaderField: "Content-Type")
        request.setValue(prepared.encoding.mediaType, forHTTPHeaderField: "Accept")
        request.httpBody = prepared.body

        var lastError: Error = URLError(.unknown)
        let log = ProtocolNetworkLog.current
        for attempt in 0..<Self.updateAttempts {
            var entry = ProtocolNetworkLogEntry(kind: .update, name: "updates", tree: prepared.tree)
            entry.method = "POST"
            entry.attempt = attempt + 1
            entry.bytesOut = prepared.body.count
            entry.requestDigests = prepared.requestDigests
            log?.noteUpdateSent(digests: prepared.requestDigests, at: entry.at)
            do {
                let (data, response) = try await loggedData(request, entry: &entry)
                let status = try statusCode(response)
                // A success is read in the encoding its Content-Type names; errors are always JSON.
                let answered = ProtocolWireEncoding(contentType: (response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Type"))
                let decoded = status < 400 ? Result { try answered.decode(ProtocolUpdateResponse.self, from: data) } : nil
                if case let .success(value)? = decoded {
                    entry.updateIDs = value.results.map { element in
                        switch element.result { case .accepted(let update), .unchanged(let update): update.id }
                    }
                    if case .accepted(let update) = value.results.last?.result { entry.root = update.root }
                    log?.noteUpdateResponded(digests: prepared.requestDigests)
                }
                log?.record(entry)
                if status == 409, let conflict = try? decoder.decode(ProtocolUpdateConflict.self, from: data), conflict.error == "conflict" {
                    let validated = try conflict.validated()
                    guard validated.details.failedIndex < prepared.requestDigests.count,
                          validated.details.completed.map(\.requestDigest) == Array(prepared.requestDigests.prefix(validated.details.failedIndex)) else {
                        throw ProtocolValidationError.invalidValue("Server conflict update-string identity mismatch")
                    }
                    throw ProtocolUpdateConflictError(conflict: validated)
                }
                if status >= 500 {
                    lastError = decodeHTTPError(data: data, status: status)
                } else {
                    try validate(data: data, status: status)
                    guard let value = try decoded?.get(), value.results.map(\.requestDigest) == prepared.requestDigests else {
                        throw ProtocolValidationError.invalidValue("Server response update-string identity mismatch")
                    }
                    return value
                }
            } catch let error as URLError {
                // Only a lost exchange or a server failure (above) is retried; a response
                // that fails validation would fail identically again.
                lastError = error
            }
            if attempt < Self.updateAttempts - 1 { try await retryDelay(attempt + 1) }
        }
        throw lastError
    }

    public func createPairing() async throws -> ProtocolPairingOffer {
        let value: ProtocolPairingOffer = try await post(path: "/.arbor/pairings", body: EmptyBody())
        return try value.validated()
    }

    public func claimPairing(
        id: String,
        secret: String,
        device: ProtocolPairingDevice
    ) async throws -> ProtocolPairingClaim {
        _ = try device.validated()
        let value: ProtocolPairingClaim = try await put(
            path: "/.arbor/pairings/\(component(id))/claim",
            body: PairingClaimBody(secret: secret, device: device),
            authorized: false
        )
        return try value.validated()
    }

    /// A challenge for claiming an account with the profile key (accounts
    /// §1.2). Placement accounts have none: they come from reservations (§1.3).
    public func createAccountChallenge(account: String? = nil, profileTree: String, configurationTree: String, inviteCode: String? = nil) async throws -> ProtocolAccountChallenge {
        let value: ProtocolAccountChallenge = try await post(
            path: "/.arbor/account-challenges",
            body: AccountChallengeRequest(account: account, profileTree: profileTree, configurationTree: configurationTree, inviteCode: inviteCode),
            authorized: false
        )
        return try value.validated()
    }

    public func joinAccount(_ value: ProtocolExistingProfileClaimRequest) async throws -> ProtocolAccountClaimResult {
        _ = try value.device.validated()
        // The configuration is its tree's activation element: one complete snapshot (accounts §1.2).
        let configuration = value.configuration
        guard configuration.trace == nil, configuration.resolves.isEmpty, configuration.ifCurrent == nil, configuration.deltas.isEmpty else {
            throw ProtocolValidationError.invalidValue("A claim's configuration is a snapshot activation element")
        }
        _ = try ProtocolObjectGraph.validate(ProtocolSnapshot(root: configuration.candidate, objects: configuration.objects))
        let result: ProtocolAccountClaimResult = try await put(path: "/.arbor/accounts", body: value, authorized: false, encoding: wireEncoding)
        _ = try result.configuration.validated()
        return result
    }

    /// A single-use challenge for one of this profile's key devices (accounts §5.1).
    public func createDeviceSessionChallenge(profileTree: String, device: String) async throws -> ProtocolDeviceSessionChallenge {
        let value: ProtocolDeviceSessionChallenge = try await post(
            path: "/.arbor/device-sessions/challenges",
            body: DeviceSessionChallengeRequest(profileTree: profileTree, device: device),
            authorized: false
        )
        let challenge = try value.validated()
        guard challenge.origin == canonicalOrigin else {
            throw ProtocolValidationError.invalidValue("Device session challenge names another host")
        }
        return challenge
    }

    /// Exchange a signed challenge for a session token at this host.
    public func openDeviceSession(challenge: ProtocolDeviceSessionChallenge, signature: String) async throws -> ProtocolDeviceSession {
        try await post(
            path: "/.arbor/device-sessions",
            body: DeviceSessionRequest(challenge: challenge.validated(), signature: signature),
            authorized: false
        )
    }

    public func access(tree: String) async throws -> ProtocolTreeAccess {
        try await get(path: "/.arbor/trees/\(component(tree))/access")
    }

    public func directory() async throws -> ProtocolRemoteSnapshot<[ProtocolProfileDirectoryEntry]> {
        try await get(path: "/.arbor/directory")
    }

    /// How long a watch stream may go without a byte before it is taken for
    /// dead: two of the keepalive intervals a host may leave (tree operations
    /// §4.2), as the TypeScript transport allows.
    public static let watchIdleTimeout: Duration = .seconds(60)

    /// A tree's watch stream, resuming strictly after the observation `after`
    /// names, or at the tree's current head without it. `onOpen` runs once the
    /// host has answered with an event stream, before any event arrives. The
    /// stream fails with `URLError(.timedOut)` after `idleTimeout` without a
    /// byte, keepalives included.
    public func watch(
        tree: String,
        after: String? = nil,
        idleTimeout: Duration = ProtocolClient.watchIdleTimeout,
        onOpen: (@Sendable () async -> Void)? = nil
    ) async throws -> AsyncThrowingStream<ProtocolWatchEvent, Error> {
        let query = after.map { "?after=\($0.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-._~")))!)" } ?? ""
        var request = try await authorizedRequest(path: "/.arbor/trees/\(component(tree))/watch\(query)")
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        let session = session
        let credentialProvider = credentialProvider
        let finalRequest = request
        let log = ProtocolNetworkLog.current
        return AsyncThrowingStream { continuation in
            let idle = WatchIdleClock()
            let task = Task {
                let connectedAt = Date()
                var frames = 0
                var connect = ProtocolNetworkLogEntry(kind: .watchConnect, name: "watch", tree: tree, at: connectedAt)
                connect.cursor = after
                func disconnect(_ error: Error?) {
                    var entry = ProtocolNetworkLogEntry(kind: .watchDisconnect, name: "watch", tree: tree)
                    entry.durationMs = Date().timeIntervalSince(connectedAt) * 1000
                    entry.bytesIn = frames
                    entry.error = error.map(Self.describe)
                    log?.record(entry)
                }
                do {
                    let (bytes, response) = try await session.bytes(for: finalRequest)
                    idle.heard()
                    guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
                    connect.status = http.statusCode
                    connect.durationMs = Date().timeIntervalSince(connectedAt) * 1000
                    log?.record(connect)
                    guard http.statusCode < 400 else {
                        if http.statusCode == 401 { await credentialProvider.invalidate() }
                        var body = Data()
                        for try await byte in bytes { body.append(byte) }
                        throw Self.httpError(data: body, status: http.statusCode)
                    }
                    guard http.value(forHTTPHeaderField: "Content-Type")?.lowercased().hasPrefix("text/event-stream") == true else {
                        throw ProtocolValidationError.malformedSSE("Watch response is not an event stream")
                    }
                    await onOpen?()
                    var parser = ProtocolSSEParser()
                    for try await byte in bytes {
                        idle.heard()
                        for frame in try parser.append(byte: byte) {
                            if frame.event == "resync-required" {
                                let change = try JSONDecoder().decode(ProtocolResyncChange.self, from: Data(frame.data.utf8))
                                throw ProtocolHTTPError(status: 409, code: "resync-required", message: change.reason, retryable: true)
                            }
                            guard frame.event == "tree.update" else {
                                throw ProtocolValidationError.malformedSSE("Unsupported tree watch event")
                            }
                            guard let cursor = frame.id, !cursor.isEmpty else {
                                throw ProtocolValidationError.malformedSSE("Tree update has no cursor")
                            }
                            let change = try JSONDecoder().decode(ProtocolTreeUpdateFrame.self, from: Data(frame.data.utf8))
                                .validated(tree: tree)
                            let transition = change.transition
                            frames += 1
                            if let log {
                                let digest = transition.requestDigest
                                var entry = ProtocolNetworkLogEntry(kind: .watchFrame, name: "watch", tree: tree)
                                entry.cursor = cursor
                                entry.root = transition.update.root
                                entry.updateIDs = [transition.update.id]
                                entry.bytesIn = frame.data.utf8.count
                                entry.requestDigests = digest.map { [$0] }
                                if let digest, let trip = log.roundTrip(for: digest, at: entry.at) {
                                    entry.roundTripMs = trip.roundTripMs
                                    entry.afterResponseMs = trip.afterResponseMs
                                }
                                log.record(entry)
                            }
                            continuation.yield(ProtocolWatchEvent(
                                cursor: cursor, treeID: tree, access: change.access, canonical: change.canonical, transition: transition))
                        }
                    }
                    _ = try parser.finish()
                    disconnect(nil)
                    continuation.finish()
                } catch where idle.expired {
                    let error = URLError(.timedOut)
                    if connect.status == nil { connect.error = Self.describe(error); log?.record(connect) }
                    disconnect(error)
                    continuation.finish(throwing: error)
                } catch is CancellationError {
                    if connect.status == nil { connect.error = "cancelled"; log?.record(connect) }
                    disconnect(CancellationError())
                    continuation.finish()
                } catch {
                    if connect.status == nil { connect.error = Self.describe(error); connect.durationMs = Date().timeIntervalSince(connectedAt) * 1000; log?.record(connect) }
                    disconnect(error)
                    continuation.finish(throwing: error)
                }
            }
            let watchdog = Task {
                await idle.expire(after: idleTimeout)
                if idle.expired { task.cancel() }
            }
            continuation.onTermination = { _ in task.cancel(); watchdog.cancel() }
        }
    }

    private func get<T: Decodable>(path: String) async throws -> T {
        try await perform(authorizedRequest(path: path))
    }

    private func post<T: Decodable, Body: Encodable>(path: String, body: Body, authorized: Bool = true) async throws -> T {
        var request = authorized ? try await authorizedRequest(path: path) : URLRequest(url: url(path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try encoder.encode(body)
        return try await perform(request)
    }

    /// A PUT whose body travels in `encoding`; its success answers JSON.
    private func put<T: Decodable, Body: Encodable>(path: String, body: Body, authorized: Bool = true, encoding: ProtocolWireEncoding = .json) async throws -> T {
        var request = authorized ? try await authorizedRequest(path: path) : URLRequest(url: url(path))
        request.httpMethod = "PUT"
        request.setValue(encoding.mediaType, forHTTPHeaderField: "Content-Type")
        request.httpBody = try encoding == .json ? encoder.encode(body) : encoding.encode(body)
        return try await perform(request)
    }

    private func perform<T: Decodable>(_ request: URLRequest) async throws -> T {
        let (data, response) = try await logged(request, kind: .read, name: Self.logName(request), tree: Self.logTree(request))
        let status = try statusCode(response)
        try validate(data: data, status: status)
        return try decoder.decode(T.self, from: data)
    }

    private func validate(data: Data, status: Int) throws {
        guard status >= 400 else { return }
        throw decodeHTTPError(data: data, status: status)
    }

    private func decodeHTTPError(data: Data, status: Int) -> ProtocolHTTPError {
        Self.httpError(data: data, status: status)
    }

    private static func httpError(data: Data, status: Int) -> ProtocolHTTPError {
        let envelope = try? JSONDecoder().decode(ProtocolErrorEnvelope.self, from: data)
        return ProtocolHTTPError(
            status: status,
            code: envelope?.error ?? "http-error",
            message: envelope?.message,
            retryable: envelope?.retryable ?? (envelope == nil || status >= 500),
            homeHost: envelope?.homeHost,
            challenge: envelope?.challenge
        )
    }

    private func statusCode(_ response: URLResponse) throws -> Int {
        guard let response = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        return response.statusCode
    }

    private func authorizedRequest(path: String) async throws -> URLRequest {
        var request = URLRequest(url: url(path))
        if let credential = try await credentialProvider.credential() {
            guard !credential.isEmpty else { throw ProtocolValidationError.invalidValue("Credential is empty") }
            request.setValue("Bearer \(credential)", forHTTPHeaderField: "Authorization")
        }
        return request
    }

    private func url(_ path: String) -> URL { URL(string: path, relativeTo: origin)!.absoluteURL }

    /// Perform a request and record it in the installed network log, if any.
    private func logged(_ request: URLRequest, kind: ProtocolNetworkLogEntry.Kind, name: String, tree: String?) async throws -> (Data, URLResponse) {
        var entry = ProtocolNetworkLogEntry(kind: kind, name: name, tree: tree)
        entry.method = request.httpMethod ?? "GET"
        entry.bytesOut = request.httpBody?.count
        let result = try await loggedData(request, entry: &entry)
        ProtocolNetworkLog.current?.record(entry)
        return result
    }

    /// Fill `entry` with timing, status, byte counts, server phases, or the error.
    private func loggedData(_ request: URLRequest, entry: inout ProtocolNetworkLogEntry) async throws -> (Data, URLResponse) {
        let started = Date()
        entry.at = started
        do {
            let (data, response) = try await session.data(for: request)
            entry.durationMs = Date().timeIntervalSince(started) * 1000
            entry.bytesIn = data.count
            if let http = response as? HTTPURLResponse {
                if http.statusCode == 401 { await credentialProvider.invalidate() }
                entry.status = http.statusCode
                entry.serverTiming = ProtocolNetworkLog.parseServerTiming(http.value(forHTTPHeaderField: "Server-Timing"))
            }
            return (data, response)
        } catch {
            entry.durationMs = Date().timeIntervalSince(started) * 1000
            entry.error = Self.describe(error)
            ProtocolNetworkLog.current?.record(entry)
            throw error
        }
    }

    private static func describe(_ error: Error) -> String {
        if error is CancellationError { return "cancelled" }
        if let error = error as? URLError { return "URLError \(error.code.rawValue): \(error.localizedDescription)" }
        return String(describing: error)
    }

    private static func logName(_ request: URLRequest) -> String {
        guard let path = request.url?.path else { return "request" }
        if path.hasPrefix("/.arbor/trees/") {
            let rest = path.dropFirst("/.arbor/trees/".count).split(separator: "/", maxSplits: 1)
            return rest.count > 1 ? String(rest[1]) : "descriptor"
        }
        return path
    }

    private static func logTree(_ request: URLRequest) -> String? {
        guard let path = request.url?.path, path.hasPrefix("/.arbor/trees/") else { return nil }
        return path.dropFirst("/.arbor/trees/".count).split(separator: "/", maxSplits: 1).first.map(String.init)?.removingPercentEncoding
    }

    /// This client's origin as a challenge spells it: `scheme://host[:port]`.
    public nonisolated var canonicalOrigin: String { webOrigin(origin) ?? "" }

    private func component(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/")))!
    }
}

/// The semantic identity of an update request as canonical CBOR bytes; the
/// same encoding that addresses wire objects, so every Arbor identity uses one
/// hash rule.
public func canonicalUpdateIntent(
    tree: String,
    base: ProtocolUpdateBase,
    candidate: String,
    change: String,
    trace: [ProtocolTraceFrame]? = nil,
    resolves: [ProtocolResolutionDeclaration] = [],
    ifCurrent: String? = nil
) -> Data {
    canonicalUpdateIntent(
        tree: tree,
        base: .text(base.update),
        candidate: candidate,
        change: change,
        trace: trace,
        resolves: resolves,
        ifCurrent: ifCurrent
    )
}

private func canonicalUpdateIntent(
    tree: String,
    base: CanonicalCBORValue,
    candidate: String,
    change: String,
    trace: [ProtocolTraceFrame]? = nil,
    resolves: [ProtocolResolutionDeclaration],
    ifCurrent: String?
) -> Data {
    CanonicalCBOR.encode(.map([
        ("domain", .text("arbor-update/2")),
        ("change", .text(change)),
        ("trace", trace.map { .array($0.map(\.semantic.cbor)) } ?? .null),
        ("tree", .text(tree)),
        ("base", base),
        ("candidate", .text(candidate)),
        ("resolves", .array(resolves.map { $0.semantic.cbor })),
        ("ifCurrent", ifCurrent.map(CanonicalCBORValue.text) ?? .null),
    ]))
}

public func updateRequestDigests(
    tree: String,
    base: ProtocolUpdateBase,
    updates: [ProtocolCandidateUpdate]
) -> [String] {
    updateRequestDigests(tree: tree, base: base.update, updates: updates)
}

public func updateRequestDigests(tree: String, base: String?, updates: [ProtocolCandidateUpdate]) -> [String] {
    updateRequestIdentities(tree: tree, base: base, updates: updates).map(\.digest)
}

/// Each update's canonical intent bytes and digest; every update after the
/// first is based on its predecessor's digest and candidate.
func updateRequestIdentities(tree: String, base: String?, updates: [ProtocolCandidateUpdate]) -> [(bytes: Data, digest: String)] {
    var basis: CanonicalCBORValue = base.map(CanonicalCBORValue.text) ?? .null
    var result: [(bytes: Data, digest: String)] = []
    for update in updates {
        let bytes = canonicalUpdateIntent(
            tree: tree,
            base: basis,
            candidate: update.candidate,
            change: update.change,
            trace: update.trace,
            resolves: update.resolves,
            ifCurrent: update.ifCurrent
        )
        let digest = ProtocolObjectCodec.hash(bytes)
        result.append((bytes, digest))
        basis = .map([
            ("requestDigest", .text(digest)),
            ("candidate", .text(update.candidate)),
        ])
    }
    return result
}

private struct EmptyBody: Encodable {}
private struct AccountChallengeRequest: Encodable {
    var account: String?
    var profileTree: String
    var configurationTree: String
    var inviteCode: String?
}
private struct DeviceSessionChallengeRequest: Encodable {
    var profileTree: String
    var device: String
}
private struct DeviceSessionRequest: Encodable {
    var challenge: ProtocolDeviceSessionChallenge
    var signature: String
}
private struct PairingClaimBody: Encodable {
    var secret: String
    var device: ProtocolPairingDevice
}
private struct ProtocolErrorEnvelope: Decodable {
    var error: String
    var message: String
    var retryable: Bool
    /// `details.homeHost` and `details.challenge`, when the details carry
    /// them; details of any other shape leave them nil rather than failing
    /// the envelope.
    var homeHost: String?
    var challenge: String?

    private enum CodingKeys: String, CodingKey { case error, message, retryable, details }
    private struct Details: Decodable { var homeHost: String?; var challenge: String? }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        error = try values.decode(String.self, forKey: .error)
        message = try values.decode(String.self, forKey: .message)
        retryable = try values.decode(Bool.self, forKey: .retryable)
        let details = (try? values.decodeIfPresent(Details.self, forKey: .details)) ?? nil
        homeHost = details?.homeHost
        challenge = details?.challenge
    }
}

/// When a watch stream last heard from its host, and whether it then went
/// quiet for longer than its idle timeout.
private final class WatchIdleClock: Sendable {
    private let state = OSAllocatedUnfairLock(initialState: (heard: ContinuousClock.now, expired: false))

    func heard() { state.withLock { $0.heard = .now } }

    var expired: Bool { state.withLock { $0.expired } }

    /// Return once `timeout` passes without `heard()`, marking the clock
    /// expired, or once the calling task is cancelled.
    func expire(after timeout: Duration) async {
        while !Task.isCancelled {
            let deadline = state.withLock { $0.heard } + timeout
            if ContinuousClock.now >= deadline {
                state.withLock { $0.expired = true }
                return
            }
            try? await Task.sleep(until: deadline)
        }
    }
}
