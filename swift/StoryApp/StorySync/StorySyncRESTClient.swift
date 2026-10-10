#if os(macOS)
import Foundation
import StoryKit
import Overstory
import OverstoryClient

struct StorySyncServerError: Error, LocalizedError, Sendable {
    var status: Int
    var value: StorySyncErrorValue

    init(status: Int, value: StorySyncErrorValue) {
        self.status = status
        self.value = value
    }

    var errorDescription: String? { value.message }

    /// A refused credential as the protocol client reports a host's refusal:
    /// a device the host no longer lists is a 401, a host that cannot check it
    /// now keeps its retryable status, and a named home host stays named.
    var credentialRefusal: ProtocolHTTPError {
        var homeHost: String?
        if case let .object(details)? = value.details, case let .string(host)? = details["homeHost"] { homeHost = host }
        return ProtocolHTTPError(status: status == 409 ? 401 : status, code: value.code, message: value.message,
                                 retryable: value.retryable, homeHost: homeHost)
    }
}

/// The running Story Sync has no placement route yet; the `story` command
/// places the data home's account instead.
struct StorySyncPlacementUnavailable: Error, LocalizedError, Equatable, Sendable {
    var host: String
    var errorDescription: String? {
        "This version of Story Sync can't add hosts yet. Place a folder on \(host) with `story place` in Terminal; the host then appears here."
    }
}

/// One claimed Canopy account of the data home, as `GET /v1/accounts` reports it (`LocalAccountSummary` in `@story/core`).
struct LocalHostAccountDescriptor: Codable, Sendable, Equatable, Identifiable {
    var configurationTree: String
    var host: String?
    var handle: String?
    var profileTree: String?
    var deviceID: String?
    var credentialAvailable: Bool
    var diagnostics: [StorySyncDiagnostic]
    var id: String { configurationTree }
}

struct LocalProfileIdentity: Codable, Sendable, Equatable {
    var profileTree: String
    var publicKey: String
    var profilePath: String
    var keyAvailable: Bool
}

struct LocalPendingClaim: Codable, Sendable, Equatable {
    var canCancel: Bool?
    var account: String
    var path: String
}

struct LocalPendingPairing: Codable, Sendable, Equatable {
    var origin: String
}

struct LocalHostAccountsEnvelope: Codable, Sendable {
    var accounts: [LocalHostAccountDescriptor]
    var identity: LocalProfileIdentity?
    var pendingClaim: LocalPendingClaim?
    var pendingPairing: LocalPendingPairing?
}

/// `POST /v1/bootstrap/placements`'s answer: the placement connection the data
/// home now holds (`HostPlacementRecord`).
struct LocalPlacementConnection: Codable, Sendable, Equatable {
    var placement: NativePlacementAccount
}

/// The daemon's control surface as the Mac app sees it: status, trees,
/// accounts and the data-home onboarding routes (identity, claim, pairing
/// claim), held-change discard, sync, and the three loopback services a
/// working-tree client uses (bootstrap, credential, objects) plus the event
/// stream. The daemon has no editor path; editing happens in the working tree.
/// Pairing offers go to the host directly through `ProtocolClient` (Native 011).
actor StorySyncRESTClient {
    private let baseURL: URL
    private let session: URLSession
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    init(baseURL: URL, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.session = session
    }

    func status() async throws -> StorySyncServiceStatus {
        try await get(path: "/v1/status", items: [])
    }

    func trees() async throws -> ProtocolSnapshotEnvelope<[LocalTreeDescriptor]> {
        try await get(path: "/v1/trees", items: [])
    }

    /// Discard a tree's held request and every change authored on it; the folder returns to the accepted state.
    func discardHeld(tree: String) async throws {
        struct Request: Encodable { var tree: String }
        struct Response: Decodable { var tree: String }
        var request = URLRequest(url: url("/v1/held/discard"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try encoder.encode(Request(tree: tree))
        let _: Response = try await perform(request)
    }

    func accounts() async throws -> [LocalHostAccountDescriptor] {
        let value: LocalHostAccountsEnvelope = try await get(path: "/v1/accounts", items: [])
        return value.accounts
    }

    func onboardingState() async throws -> LocalHostAccountsEnvelope {
        try await get(path: "/v1/accounts", items: [])
    }

    func createIdentity(path: String) async throws {
        try await onboardingPost("/v1/me", body: ["path": path])
    }

    /// A version-2 backup needs its passphrase; a version-1 backup has none.
    func restoreIdentity(backup: Data, path: String, passphrase: String?) async throws {
        let value = try JSONSerialization.jsonObject(with: backup)
        var body: [String: Any] = ["path": path, "backup": value]
        if let passphrase { body["passphrase"] = passphrase }
        try await onboardingPost("/v1/me/restore", body: body)
    }

    func backupIdentity(destination: String, passphrase: String) async throws {
        try await onboardingPost("/v1/me/backup", body: ["destination": destination, "passphrase": passphrase])
    }

    func claimPairing(payload: Data? = nil) async throws {
        var body: [String: Any] = [:]
        if let payload { body["payload"] = try JSONSerialization.jsonObject(with: payload) }
        try await onboardingPost("/v1/bootstrap/pairings/claim", body: body)
    }

    func cancelPendingClaim() async throws {
        try await onboardingPost("/v1/bootstrap/accounts/cancel", body: [:])
    }

    func claimAccount(account: String, path: String, inviteCode: String? = nil) async throws {
        var body = ["account": account, "path": path]
        if let inviteCode { body["inviteCode"] = inviteCode }
        try await onboardingPost("/v1/bootstrap/accounts", body: body)
    }

    /// `POST /v1/bootstrap/placements {host}`: connect the data home's profile
    /// to its placement account at `host` (accounts §1.3), which the host's
    /// community created by reserving the profile's URL at its home host, as
    /// `story place` does on first use (`connectPlacementAccount` in
    /// `@ovst/client`). It answers the connection record the data home
    /// now holds. A daemon without the route sends the POST to its browser
    /// surface, which answers 405.
    @discardableResult
    func connectPlacement(host: String) async throws -> LocalPlacementConnection {
        let body = ["host": host]
        var request = URLRequest(url: url("/v1/bootstrap/placements"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        do {
            return try await perform(request)
        } catch let error as StorySyncServerError where error.status == 405 {
            throw StorySyncPlacementUnavailable(host: host)
        }
    }

    private func onboardingPost(_ path: String, body: [String: Any]) async throws {
        var request = URLRequest(url: url(path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        // Account bootstrap returns an effects array; identity routes return envelopes.
        let (data, response) = try await session.data(for: request)
        try validate(data: data, status: statusCode(response))
    }

    func synchronize(configurationTree: String? = nil) async throws {
        struct Request: Encodable { var configurationTree: String? }
        struct Response: Decodable { var synchronized: Bool }
        var request = URLRequest(url: url("/v1/sync"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try encoder.encode(Request(configurationTree: configurationTree))
        let response: Response = try await perform(request)
        guard response.synchronized else {
            throw ProtocolValidationError.invalidValue("Story Sync did not confirm synchronization")
        }
    }

    // MARK: Loopback services for a same-installation working-tree client

    /// `GET /v1/bootstrap?tree=`: the daemon's accepted Canopy base and sparse spine.
    /// The spine is decoded and validated in `.sparseFiles` mode against `accepted.root`;
    /// daemon-local pending and conflict state never enters another client's bootstrap.
    func bootstrap(tree: String) async throws -> TreeBootstrap {
        // The route answers canonical CBOR only, with `spine` as the bundle's bytes.
        var components = URLComponents(url: url("/v1/bootstrap"), resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "tree", value: tree)]
        var request = URLRequest(url: components.url!)
        request.setValue("application/cbor", forHTTPHeaderField: "Accept")
        let (data, response) = try await session.data(for: request)
        try validate(data: data, status: try statusCode(response))
        let envelope = try CanonicalCBORDecoder().decode(TreeBootstrapEnvelope.self, from: data)
        let spine: ProtocolSnapshot
        do {
            spine = try ProtocolSnapshotBundleCodec.decode(envelope.spine, root: envelope.accepted.root, mode: .sparseFiles)
        } catch {
            throw TreeBootstrapError.invalidSpine(String(describing: error))
        }
        return TreeBootstrap(
            tree: envelope.tree,
            accepted: envelope.accepted,
            spine: spine,
            observedThrough: envelope.observedThrough
        )
    }

    /// `GET /v1/credential`: the Canopy account credential the daemon holds for
    /// `configurationTree` (or the only connected account when omitted). With
    /// `origin`, the session is for that host: the account's home host, or one
    /// of its placement hosts (accounts §1.3), which the same device key opens.
    /// `origin` requires `configurationTree`.
    func credential(configurationTree: String? = nil, origin: String? = nil) async throws -> String {
        var items: [URLQueryItem] = []
        if let configurationTree { items.append(URLQueryItem(name: "configurationTree", value: configurationTree)) }
        if let origin {
            guard configurationTree != nil else {
                throw ProtocolValidationError.invalidValue("A credential for a host names its account's configuration tree")
            }
            items.append(URLQueryItem(name: "origin", value: origin))
        }
        let value: TreeCredential = try await get(path: "/v1/credential", items: items)
        guard !value.token.isEmpty else {
            throw ProtocolValidationError.invalidValue("Story Sync returned an empty credential")
        }
        return value.token
    }

    /// `GET /v1/objects/{hash}?tree=[&origin=]`: one canonical wire object, hash-verified
    /// before it is returned. A 404 surfaces as `StorySyncServerError` with status 404.
    func object(tree: String, hash: String, origin: URL? = nil) async throws -> Data {
        guard hash.range(of: #"^sha256:[a-f0-9]{64}$"#, options: .regularExpression) != nil else {
            throw ProtocolValidationError.invalidHash(hash)
        }
        var components = URLComponents(url: url("/v1/objects/\(hash)"), resolvingAgainstBaseURL: false)!
        var items = [URLQueryItem(name: "tree", value: tree)]
        if let origin { items.append(URLQueryItem(name: "origin", value: origin.absoluteString)) }
        components.queryItems = items
        var request = URLRequest(url: components.url!)
        request.setValue("application/cbor", forHTTPHeaderField: "Accept")
        let (data, response) = try await session.data(for: request)
        try validate(data: data, status: try statusCode(response))
        let actual = ProtocolObjectCodec.hash(data)
        guard actual == hash else {
            throw ProtocolValidationError.objectHashMismatch(expected: hash, actual: actual)
        }
        return data
    }

    func observations(after initialCursor: String) -> AsyncThrowingStream<WorkspaceEvent, Error> {
        let baseURL = self.baseURL
        let session = self.session
        let decoder = self.decoder
        return AsyncThrowingStream { continuation in
            let task = Task {
                var cursor = initialCursor
                // A cleanly closed stream reconnects too, but never without a delay.
                await runObservationLoop { connected in
                    do {
                        var components = URLComponents(url: baseURL.appending(path: "/v1/events"), resolvingAgainstBaseURL: false)!
                        components.queryItems = [URLQueryItem(name: "after", value: cursor)]
                        var request = URLRequest(url: components.url!)
                        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                        let (bytes, response) = try await session.bytes(for: request)
                        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                        if status >= 400 {
                            var data = Data()
                            for try await byte in bytes { data.append(byte) }
                            throw StorySyncServerError(status: status, value: try decoder.decode(StorySyncErrorValue.self, from: data))
                        }
                        connected()
                        var parser = ProtocolSSEParser()
                        for try await byte in bytes {
                            for frame in try parser.append(byte: byte) {
                                let data = Data(frame.data.utf8)
                                if frame.event == "resync-required" {
                                    let event = try decoder.decode(LocalResyncObservation.self, from: data)
                                    guard frame.id == event.cursor, event.kind == frame.event else {
                                        throw URLError(.cannotParseResponse)
                                    }
                                    throw StorySyncServerError(
                                        status: 409,
                                        value: StorySyncErrorValue(
                                            code: "resync-required",
                                            message: "The observation cursor is no longer retained",
                                            retryable: true,
                                            tree: event.tree,
                                            path: nil,
                                            details: nil
                                        )
                                    )
                                }
                                let event = try decoder.decode(WorkspaceEvent.self, from: data)
                                guard frame.id == event.cursor, frame.event == event.kind else {
                                    throw URLError(.cannotParseResponse)
                                }
                                cursor = event.cursor
                                continuation.yield(event)
                            }
                        }
                        _ = try parser.finish()
                        return .reconnect
                    } catch let error as StorySyncServerError {
                        continuation.finish(throwing: error)
                        return .stop
                    }
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    private func get<T: Decodable>(
        path: String,
        items: [URLQueryItem]
    ) async throws -> T {
        var components = URLComponents(url: url(path), resolvingAgainstBaseURL: false)!
        components.queryItems = items.isEmpty ? nil : items
        return try await perform(URLRequest(url: components.url!))
    }

    private func perform<T: Decodable>(_ request: URLRequest) async throws -> T {
        let (data, response) = try await session.data(for: request)
        let status = try statusCode(response)
        try validate(data: data, status: status)
        return try decoder.decode(T.self, from: data)
    }

    private func validate(data: Data, status: Int) throws {
        guard status >= 400 else { return }
        let value = (try? decoder.decode(StorySyncErrorValue.self, from: data))
            ?? StorySyncErrorValue(
                code: "internal-error",
                message: HTTPURLResponse.localizedString(forStatusCode: status),
                retryable: false
            )
        throw StorySyncServerError(status: status, value: value)
    }

    private func statusCode(_ response: URLResponse) throws -> Int {
        guard let response = response as? HTTPURLResponse else {
            throw URLError(.badServerResponse)
        }
        return response.statusCode
    }

    private func url(_ path: String) -> URL {
        baseURL.appending(path: path)
    }
}

private struct LocalResyncObservation: Decodable { var cursor: String; var tree: String; var kind: String }

private struct TreeBootstrapEnvelope: Decodable {
    var tree: TreeBootstrapDescriptor
    var accepted: TreeBootstrapAccepted
    /// The sparse snapshot bundle's bytes: a CBOR byte string.
    var spine: Data
    var observedThrough: String
}
#endif
