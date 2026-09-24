#if os(macOS)
import Foundation
import CanopyAppKit
import Overstory

struct ArborSyncServerError: Error, LocalizedError, Sendable {
    var status: Int
    var value: ArborSyncErrorValue

    init(status: Int, value: ArborSyncErrorValue) {
        self.status = status
        self.value = value
    }

    var errorDescription: String? { value.message }
}

/// One claimed Canopy account of the data home, as `GET /v1/accounts` reports it (`LocalAccountSummary` in `@arbor/core`).
struct LocalHostAccountDescriptor: Codable, Sendable, Equatable, Identifiable {
    var configurationTree: String
    var canopy: String?
    var handle: String?
    var profileTree: String?
    var deviceID: String?
    var credentialAvailable: Bool
    var diagnostics: [ArborSyncDiagnostic]
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

/// The daemon's control surface as the Mac app sees it: status, trees,
/// accounts and the data-home onboarding routes (identity, claim, pairing
/// claim), held-change discard, sync, and the three loopback services a
/// working-tree client uses (bootstrap, credential, objects) plus the event
/// stream. The daemon has no editor path; editing happens in the working tree.
/// Pairing offers go to the host directly through `ProtocolClient` (Native 011).
actor ArborSyncRESTClient {
    private let baseURL: URL
    private let session: URLSession
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    init(baseURL: URL, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.session = session
    }

    func status() async throws -> ArborSyncServiceStatus {
        try await get(path: "/v1/status", items: [])
    }

    func trees() async throws -> SnapshotEnvelope<[LocalTreeDescriptor]> {
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

    func restoreIdentity(backup: Data, path: String) async throws {
        let value = try JSONSerialization.jsonObject(with: backup)
        try await onboardingPost("/v1/me/restore", body: ["path": path, "backup": value])
    }

    func backupIdentity(destination: String) async throws {
        try await onboardingPost("/v1/me/backup", body: ["destination": destination])
    }

    func claimPairing(payload: Data? = nil) async throws {
        var body: [String: Any] = [:]
        if let payload { body["payload"] = try JSONSerialization.jsonObject(with: payload) }
        try await onboardingPost("/v1/bootstrap/pairings/claim", body: body)
    }

    func cancelPendingClaim() async throws {
        try await onboardingPost("/v1/bootstrap/accounts/cancel", body: [:])
    }

    func claimAccount(account: String, path: String) async throws {
        try await onboardingPost("/v1/bootstrap/accounts", body: ["account": account, "path": path])
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
            throw ProtocolValidationError.invalidValue("Arbor Sync did not confirm synchronization")
        }
    }

    // MARK: Loopback services for a same-installation working-tree client

    /// `GET /v1/bootstrap?tree=`: the daemon's accepted Canopy base and sparse spine.
    /// The spine is decoded and validated in `.sparseFiles` mode against `accepted.root`;
    /// daemon-local pending and conflict state never enters another client's bootstrap.
    func bootstrap(tree: String) async throws -> TreeBootstrap {
        let envelope: TreeBootstrapEnvelope = try await get(
            path: "/v1/bootstrap",
            items: [URLQueryItem(name: "tree", value: tree)]
        )
        guard let bundle = Data(base64Encoded: envelope.spine) else {
            throw TreeBootstrapError.invalidSpine("spine is not base64")
        }
        let spine = try ProtocolSnapshotBundleCodec.decode(bundle, root: envelope.accepted.root, mode: .sparseFiles)
        return TreeBootstrap(
            tree: envelope.tree,
            accepted: envelope.accepted,
            spine: spine,
            observedThrough: envelope.observedThrough
        )
    }

    /// `GET /v1/credential`: the Canopy account credential the daemon holds for
    /// `configurationTree` (or the only connected account when omitted).
    func credential(configurationTree: String? = nil) async throws -> String {
        let value: TreeCredential = try await get(
            path: "/v1/credential",
            items: configurationTree.map { [URLQueryItem(name: "configurationTree", value: $0)] } ?? []
        )
        guard !value.token.isEmpty else {
            throw ProtocolValidationError.invalidValue("Arbor Sync returned an empty credential")
        }
        return value.token
    }

    /// `GET /v1/objects/{hash}?tree=[&origin=]`: one canonical wire object, hash-verified
    /// before it is returned. A 404 surfaces as `ArborSyncServerError` with status 404.
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
                var reconnectAttempt = 0
                while !Task.isCancelled {
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
                            throw ArborSyncServerError(status: status, value: try decoder.decode(ArborSyncErrorValue.self, from: data))
                        }
                        reconnectAttempt = 0
                        var parser = ProtocolSSEParser()
                        for try await byte in bytes {
                            for frame in try parser.append(Data([byte])) {
                                let data = Data(frame.data.utf8)
                                if frame.event == "resync-required" {
                                    let event = try decoder.decode(LocalResyncObservation.self, from: data)
                                    guard frame.id == event.cursor, event.kind == frame.event else {
                                        throw URLError(.cannotParseResponse)
                                    }
                                    throw ArborSyncServerError(
                                        status: 409,
                                        value: ArborSyncErrorValue(
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
                    } catch let error as ArborSyncServerError {
                        continuation.finish(throwing: error)
                        return
                    } catch is CancellationError {
                        continuation.finish()
                        return
                    } catch {
                        reconnectAttempt += 1
                    }
                    // A cleanly closed stream reconnects too, but never without a delay.
                    do {
                        try await Task.sleep(for: observationReconnectDelay(afterFailures: reconnectAttempt))
                    } catch {
                        break
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
        let value = (try? decoder.decode(ArborSyncErrorValue.self, from: data))
            ?? ArborSyncErrorValue(
                code: "internal-error",
                message: HTTPURLResponse.localizedString(forStatusCode: status),
                retryable: false
            )
        throw ArborSyncServerError(status: status, value: value)
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
    var spine: String
    var observedThrough: String
}
#endif
