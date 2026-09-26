import Foundation

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
    private let session: URLSession
    private let retryDelay: RetryDelay
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
        retryDelay: @escaping RetryDelay = ProtocolClient.defaultRetryDelay
    ) {
        self.origin = origin
        self.credentialProvider = StaticProtocolCredential(credential)
        self.session = session
        self.retryDelay = retryDelay
    }

    public init(
        origin: URL,
        credentialProvider: any ProtocolCredentialProvider,
        session: URLSession = .shared,
        retryDelay: @escaping RetryDelay = ProtocolClient.defaultRetryDelay
    ) {
        self.origin = origin
        self.credentialProvider = credentialProvider
        self.session = session
        self.retryDelay = retryDelay
    }

    public func account() async throws -> ProtocolAccountSnapshot {
        let value: ProtocolAccountSnapshot = try await get(path: "/.arbor/account")
        _ = try value.account.community.validated()
        _ = try value.account.configuration.validated()
        for profile in value.account.writableProfiles { _ = try profile.validated() }
        guard !value.account.id.isEmpty, !value.observedThrough.isEmpty else {
            throw ProtocolValidationError.invalidValue("Malformed account snapshot")
        }
        return value
    }

    public func trees() async throws -> ProtocolSnapshotEnvelope<[ProtocolTreeDescriptor]> {
        let value: ProtocolSnapshotEnvelope<[ProtocolTreeDescriptor]> = try await get(path: "/.arbor/trees")
        return ProtocolSnapshotEnvelope(snapshot: try value.snapshot.map { try $0.validated() }, observedThrough: value.observedThrough)
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
        request.setValue("application/cbor", forHTTPHeaderField: "Accept")
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
        return PreparedProtocolUpdate(
            tree: tree,
            body: try encoder.encode(request),
            requestDigests: updateRequestDigests(tree: tree, base: base, updates: updates)
        )
    }

    public func submitUpdate(_ prepared: PreparedProtocolUpdate) async throws -> ProtocolUpdateResult {
        (try await submitUpdateResponse(prepared)).result
    }

    public func submitUpdateResponse(_ prepared: PreparedProtocolUpdate) async throws -> ProtocolUpdateResponse {
        var request = try await authorizedRequest(path: "/.arbor/trees/\(component(prepared.tree))/updates")
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
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
                let decoded = status < 400 ? Result { try decoder.decode(ProtocolUpdateResponse.self, from: data) } : nil
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
        _ = try ProtocolObjectGraph.validate(value.configuration)
        let result: ProtocolAccountClaimResult = try await put(path: "/.arbor/accounts", body: value, authorized: false)
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

    public func createProfileResetChallenge(profileTree: String, device: ProtocolProfileResetDevice) async throws -> ProtocolProfileResetChallenge {
        let value: ProtocolProfileResetChallenge = try await post(
            path: "/.arbor/profile-resets/challenges",
            body: ProfileResetChallengeRequest(profileTree: profileTree, device: device.validated()),
            authorized: false
        )
        let challenge = try value.validated()
        guard challenge.device == device, challenge.profileTree == profileTree,
              challenge.origin == canonicalOrigin else {
            throw ProtocolValidationError.invalidValue("Reset challenge does not match the request")
        }
        return challenge
    }

    /// Record a pending reset signed by the profile key.
    public func requestProfileReset(challenge: ProtocolProfileResetChallenge, publicKey: String, signature: String) async throws -> ProtocolPendingProfileReset {
        let value: ProfileResetEnvelope = try await put(
            path: "/.arbor/profile-resets/\(component(challenge.profileTree))",
            body: ProfileResetRequest(challenge: challenge.validated(), publicKey: publicKey, signature: signature),
            authorized: false
        )
        guard let reset = value.reset else { throw ProtocolValidationError.invalidValue("Reset response has no reset") }
        return reset
    }

    public func pendingProfileReset(profileTree: String) async throws -> ProtocolPendingProfileReset? {
        let value: ProfileResetEnvelope = try await get(path: "/.arbor/profile-resets/\(component(profileTree))")
        return value.reset
    }

    public func cancelProfileReset(profileTree: String) async throws {
        var request = try await authorizedRequest(path: "/.arbor/profile-resets/\(component(profileTree))")
        request.httpMethod = "DELETE"
        let (data, response) = try await logged(request, kind: .read, name: Self.logName(request), tree: Self.logTree(request))
        try validate(data: data, status: statusCode(response))
    }

    public func access(tree: String) async throws -> ProtocolTreeAccessSnapshot {
        try await get(path: "/.arbor/trees/\(component(tree))/access")
    }

    public func directory() async throws -> ProtocolSnapshotEnvelope<[ProtocolProfileDirectoryEntry]> {
        try await get(path: "/.arbor/directory")
    }

    public func watch(tree: String, lastEventID: String? = nil) async throws -> AsyncThrowingStream<ProtocolWatchEvent, Error> {
        var request = try await authorizedRequest(path: "/.arbor/trees/\(component(tree))/watch")
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        // Ask for an immediate comment and periodic keepalives; this parser skips them.
        request.setValue("1", forHTTPHeaderField: "Arbor-Watch-Keepalive")
        if let lastEventID { request.setValue(lastEventID, forHTTPHeaderField: "Last-Event-ID") }
        let session = session
        let credentialProvider = credentialProvider
        let finalRequest = request
        let log = ProtocolNetworkLog.current
        return AsyncThrowingStream { continuation in
            let task = Task {
                let connectedAt = Date()
                var frames = 0
                var connect = ProtocolNetworkLogEntry(kind: .watchConnect, name: "watch", tree: tree, at: connectedAt)
                connect.cursor = lastEventID
                func disconnect(_ error: Error?) {
                    var entry = ProtocolNetworkLogEntry(kind: .watchDisconnect, name: "watch", tree: tree)
                    entry.durationMs = Date().timeIntervalSince(connectedAt) * 1000
                    entry.bytesIn = frames
                    entry.error = error.map(Self.describe)
                    log?.record(entry)
                }
                do {
                    let (bytes, response) = try await session.bytes(for: finalRequest)
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
                    var parser = ProtocolSSEParser()
                    for try await byte in bytes {
                        for frame in try parser.append(Data([byte])) {
                            guard let id = frame.id, !id.isEmpty, let kind = frame.event, !kind.isEmpty else {
                                throw ProtocolValidationError.malformedSSE("Observation event has no ID or kind")
                            }
                            if kind == "resync-required" {
                                let event = try JSONDecoder().decode(ProtocolResyncObservation.self, from: Data(frame.data.utf8))
                                guard event.cursor.utf8.elementsEqual(id.utf8), event.kind == kind else {
                                    throw ProtocolValidationError.malformedSSE("Resync frame fields disagree")
                                }
                                throw ProtocolHTTPError(status: 409, code: "resync-required", message: event.change.reason, retryable: true)
                            }
                            guard kind == "tree.update" else {
                                throw ProtocolValidationError.malformedSSE("Unsupported tree watch event")
                            }
                            let event = try JSONDecoder().decode(ProtocolTreeRefObservation.self, from: Data(frame.data.utf8))
                            guard event.cursor.utf8.elementsEqual(id.utf8), event.kind == kind, event.tree == tree else {
                                throw ProtocolValidationError.malformedSSE("Observation frame fields disagree")
                            }
                            let descriptor = try event.change.descriptor.validated()
                            let transitions = event.change.transitions
                            guard !transitions.isEmpty,
                                  transitions.last?.update.id.utf8.elementsEqual(descriptor.update.utf8) == true,
                                  transitions.last?.update.root == descriptor.root,
                                  transitions.last?.update.conflicted == descriptor.conflicted else {
                                throw ProtocolValidationError.malformedSSE("Tree ref transition batch does not end at its descriptor")
                            }
                            var seen = Set<Data>()
                            if let predecessor = transitions.first?.transportBasis { seen.insert(Data(predecessor.id.utf8)) }
                            for (index, transition) in transitions.enumerated() {
                                guard seen.insert(Data(transition.update.id.utf8)).inserted else {
                                    throw ProtocolValidationError.malformedSSE("Repeated accepted identity")
                                }
                                guard transition.update.tree == tree else {
                                    throw ProtocolValidationError.malformedSSE("Tree ref transition belongs to another tree")
                                }
                                if index > 0 {
                                    let previous = transitions[index - 1].update
                                    guard transition.transportBasis?.root == previous.root,
                                          transition.transportBasis?.id.utf8.elementsEqual(previous.id.utf8) == true else {
                                        throw ProtocolValidationError.malformedSSE("Tree ref transition batch is not contiguous")
                                    }
                                }
                            }
                            if let outerDigest = event.change.requestDigest,
                               let finalDigest = transitions.last?.requestDigest,
                               outerDigest != finalDigest {
                                throw ProtocolValidationError.malformedSSE("Tree ref request digests disagree")
                            }
                            frames += 1
                            if let log {
                                let digest = event.change.requestDigest ?? transitions.last?.requestDigest
                                var entry = ProtocolNetworkLogEntry(kind: .watchFrame, name: "watch", tree: tree)
                                entry.cursor = event.cursor
                                entry.root = descriptor.root
                                entry.updateIDs = transitions.map(\.update.id)
                                if entry.updateIDs?.isEmpty == true { entry.updateIDs = [descriptor.update] }
                                entry.bytesIn = frame.data.utf8.count
                                entry.requestDigests = digest.map { [$0] }
                                if let digest, let trip = log.roundTrip(for: digest, at: entry.at) {
                                    entry.roundTripMs = trip.roundTripMs
                                    entry.afterResponseMs = trip.afterResponseMs
                                }
                                log.record(entry)
                            }
                            continuation.yield(ProtocolWatchEvent(
                                cursor: event.cursor,
                                treeID: event.tree,
                                kind: event.kind,
                                tree: descriptor,
                                requestDigest: event.change.requestDigest ?? transitions.last?.requestDigest,
                                transitions: transitions
                            ))
                        }
                    }
                    _ = try parser.finish()
                    disconnect(nil)
                    continuation.finish()
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
            continuation.onTermination = { _ in task.cancel() }
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

    private func put<T: Decodable, Body: Encodable>(path: String, body: Body, authorized: Bool = true) async throws -> T {
        var request = authorized ? try await authorizedRequest(path: path) : URLRequest(url: url(path))
        request.httpMethod = "PUT"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try encoder.encode(body)
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
            retryable: envelope?.retryable ?? (status >= 500)
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
    private var canonicalOrigin: String { webOrigin(origin) ?? "" }

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
private struct ProfileResetChallengeRequest: Encodable {
    var profileTree: String
    var device: ProtocolProfileResetDevice
}
private struct ProfileResetRequest: Encodable {
    var challenge: ProtocolProfileResetChallenge
    var publicKey: String
    var signature: String
}
private struct ProfileResetEnvelope: Decodable {
    var reset: ProtocolPendingProfileReset?
}
private struct PairingClaimBody: Encodable {
    var secret: String
    var device: ProtocolPairingDevice
}
private struct ProtocolErrorEnvelope: Decodable {
    var error: String
    var message: String
    var retryable: Bool
}
