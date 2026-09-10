import Foundation
import ArborKit
import ArborWire

public struct ArborSyncServerError: Error, LocalizedError, Sendable {
    public var status: Int
    public var value: ArborSyncErrorValue

    public var errorDescription: String? { value.message }
}

/// One claimed Canopy account of the data home, as `GET /v1/accounts` reports it (`LocalAccountSummary` in `@arbor/core`).
public struct LocalCanopyAccountDescriptor: Codable, Sendable, Equatable, Identifiable {
    public var configurationTree: String
    public var canopy: String?
    public var handle: String?
    public var profileTree: String?
    public var deviceID: String?
    public var credentialAvailable: Bool
    public var diagnostics: [Diagnostic]
    public var id: String { configurationTree }
}

private struct LocalCanopyAccountsEnvelope: Codable {
    var accounts: [LocalCanopyAccountDescriptor]
}

/// The daemon's control surface as a same-installation client sees it: status,
/// trees, accounts, conflicts, sync, pairing, and the three loopback services a
/// working-tree client uses (bootstrap, credential, objects) plus the event
/// stream. The daemon has no editor path; editing happens in the working tree.
public actor ArborSyncRESTClient {
    private let baseURL: URL
    private let session: URLSession
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    public init(baseURL: URL, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.session = session
    }

    public func status() async throws -> ArborSyncStatus {
        try await get(path: "/v1/status", items: [])
    }

    public func trees() async throws -> SnapshotEnvelope<[LocalTreeDescriptor]> {
        try await get(path: "/v1/trees", items: [])
    }

    public func conflict(tree: String) async throws -> ArborSyncConflictWorkspace {
        try await get(path: "/v1/conflicts", items: [URLQueryItem(name: "tree", value: tree)])
    }

    public func resolveConflict(
        tree: String,
        identity: String,
        resolutions: [String: ArborSyncConflictResolution]
    ) async throws {
        struct Resolution: Encodable {
            var choice: String
            var text: String?
        }
        struct Request: Encodable {
            var tree: String
            var identity: String
            var resolutions: [String: Resolution]
        }
        struct Response: Decodable { var effects: [MutationEffect] }
        let encoded = resolutions.mapValues { resolution in
            switch resolution {
            case .current: Resolution(choice: "current")
            case .mine: Resolution(choice: "mine")
            case .both: Resolution(choice: "both")
            case let .edit(text): Resolution(choice: "edit", text: text)
            }
        }
        var request = URLRequest(url: url("/v1/conflicts/resolve"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try encoder.encode(Request(tree: tree, identity: identity, resolutions: encoded))
        let _: Response = try await perform(request)
    }

    public func accounts() async throws -> [LocalCanopyAccountDescriptor] {
        let value: LocalCanopyAccountsEnvelope = try await get(path: "/v1/accounts", items: [])
        return value.accounts
    }

    public func resolve(_ locator: String) async throws -> LocatorResolution {
        try await get(path: "/v1/resolve", items: [URLQueryItem(name: "locator", value: locator)])
    }

    public func synchronize(configurationTree: String? = nil) async throws {
        struct Request: Encodable { var configurationTree: String? }
        struct Response: Decodable { var synchronized: Bool }
        var request = URLRequest(url: url("/v1/sync"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try encoder.encode(Request(configurationTree: configurationTree))
        let response: Response = try await perform(request)
        guard response.synchronized else {
            throw ArborWireValidationError.invalidValue("Arbor Sync did not confirm synchronization")
        }
    }

    public func createCommunityPairing(configurationTree: String? = nil) async throws -> WirePairingOffer {
        var request = URLRequest(url: url("/v1/bootstrap/pairings"))
        request.httpMethod = "POST"
        if let configurationTree {
            struct Request: Encodable { var configurationTree: String }
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try encoder.encode(Request(configurationTree: configurationTree))
        }
        return try await perform(request)
    }

    // MARK: Loopback services for a same-installation working-tree client

    /// `GET /v1/bootstrap?tree=`: the daemon's accepted base, the sparse spine, the lazily
    /// resolved file list, and any verbatim pending string for a placed tree. The spine is
    /// decoded and validated in `.sparseFiles` mode against `accepted.root`, and every
    /// payload-less entry must be listed in `files`.
    public func bootstrap(tree: String) async throws -> TreeBootstrap {
        let envelope: TreeBootstrapEnvelope = try await get(
            path: "/v1/bootstrap",
            items: [URLQueryItem(name: "tree", value: tree)]
        )
        guard let bundle = Data(base64Encoded: envelope.spine) else {
            throw TreeBootstrapError.invalidSpine("spine is not base64")
        }
        let spine = try WireSnapshotBundleCodec.decode(bundle, root: envelope.accepted.root, mode: .sparseFiles)
        try Self.checkSparseEntries(spine, files: envelope.files)
        return TreeBootstrap(
            tree: envelope.tree,
            accepted: envelope.accepted,
            spine: spine,
            files: envelope.files,
            pending: envelope.pending,
            blocked: envelope.blocked,
            observedThrough: envelope.observedThrough
        )
    }

    /// `GET /v1/credential`: the Canopy account credential the daemon holds for
    /// `configurationTree` (or the only connected account when omitted).
    public func credential(configurationTree: String? = nil) async throws -> String {
        let value: TreeCredential = try await get(
            path: "/v1/credential",
            items: configurationTree.map { [URLQueryItem(name: "configurationTree", value: $0)] } ?? []
        )
        guard !value.token.isEmpty else {
            throw ArborWireValidationError.invalidValue("Arbor Sync returned an empty credential")
        }
        return value.token
    }

    /// `GET /v1/objects/{hash}?tree=[&origin=]`: one canonical wire object, hash-verified
    /// before it is returned. A 404 surfaces as `ArborSyncServerError` with status 404.
    public func object(tree: String, hash: String, origin: URL? = nil) async throws -> Data {
        guard hash.range(of: #"^sha256:[a-f0-9]{64}$"#, options: .regularExpression) != nil else {
            throw ArborWireValidationError.invalidHash(hash)
        }
        var components = URLComponents(url: url("/v1/objects/\(hash)"), resolvingAgainstBaseURL: false)!
        var items = [URLQueryItem(name: "tree", value: tree)]
        if let origin { items.append(URLQueryItem(name: "origin", value: origin.absoluteString)) }
        components.queryItems = items
        var request = URLRequest(url: components.url!)
        request.setValue("application/cbor", forHTTPHeaderField: "Accept")
        let (data, response) = try await session.data(for: request)
        try validate(data: data, status: try statusCode(response))
        let actual = WireObjectCodec.hash(data)
        guard actual == hash else {
            throw ArborWireValidationError.objectHashMismatch(expected: hash, actual: actual)
        }
        _ = try WireObjectCodec.decode(data)
        return data
    }

    /// Every reachable entry whose object the spine omits must be a file listed in `files`;
    /// otherwise a daemon bug could silently collapse a subtree into one lazy "file".
    static func checkSparseEntries(_ spine: WireSnapshot, files: [String: TreeBootstrapFile]) throws {
        let objects = try WireObjectGraph.validate(spine, mode: .sparseFiles)
        var visited = Set<String>()
        func visit(_ hash: String, at path: String) throws {
            guard visited.insert(hash).inserted else { return }
            guard let object = objects[hash] else {
                guard files[path] != nil else { throw TreeBootstrapError.unlistedFile(path: path, hash: hash) }
                return
            }
            guard case let .directory(entries, _) = object else { return }
            for entry in entries {
                guard let child = entry.hash else { continue }
                try visit(child, at: path == "/" ? "/\(entry.name)" : "\(path)/\(entry.name)")
            }
        }
        try visit(spine.root, at: "/")
    }

    public func forgetLocalAccount() async throws {
        var request = URLRequest(url: url("/v1/local/forget"))
        request.httpMethod = "POST"
        let _: ForgetResult = try await perform(request)
    }

    public func observations(after initialCursor: String) -> AsyncThrowingStream<WorkspaceEvent, Error> {
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
                            let envelope = try decoder.decode(ArborSyncErrorEnvelope.self, from: data)
                            throw ArborSyncServerError(status: status, value: envelope.value)
                        }
                        reconnectAttempt = 0
                        var frame = Data()
                        for try await byte in bytes {
                            frame.append(byte)
                            let boundaryLength: Int
                            if frame.count >= 2 && frame.suffix(2).elementsEqual([10, 10]) {
                                boundaryLength = 2
                            } else if frame.count >= 4 && frame.suffix(4).elementsEqual([13, 10, 13, 10]) {
                                boundaryLength = 4
                            } else {
                                continue
                            }
                            frame.removeLast(boundaryLength)
                            let text = String(decoding: frame, as: UTF8.self)
                                .replacingOccurrences(of: "\r\n", with: "\n")
                            frame.removeAll(keepingCapacity: true)
                            let lines = text.split(separator: "\n", omittingEmptySubsequences: false)
                            let eventID = lines.first(where: { $0.hasPrefix("id:") }).map {
                                String($0.dropFirst(3)).trimmingCharacters(in: .whitespaces)
                            }
                            let eventKind = lines.first(where: { $0.hasPrefix("event:") }).map {
                                String($0.dropFirst(6)).trimmingCharacters(in: .whitespaces)
                            }
                            let dataLines = lines
                                .filter { $0.hasPrefix("data:") }
                                .map { line in
                                    String(line.dropFirst(5))
                                        .replacingOccurrences(
                                            of: #"^[ \t]"#,
                                            with: "",
                                            options: .regularExpression
                                        )
                                }
                            if !dataLines.isEmpty {
                                let data = Data(dataLines.joined(separator: "\n").utf8)
                                if eventKind == "resync-required" {
                                    let event = try decoder.decode(LocalResyncObservation.self, from: data)
                                    guard eventID == event.cursor, event.kind == eventKind else {
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
                                guard eventID == event.cursor, eventKind == event.kind else {
                                    throw URLError(.cannotParseResponse)
                                }
                                cursor = event.cursor
                                continuation.yield(event)
                            }
                        }
                    } catch let error as ArborSyncServerError {
                        continuation.finish(throwing: error)
                        return
                    } catch is CancellationError {
                        continuation.finish()
                        return
                    } catch {
                        reconnectAttempt += 1
                        try await Task.sleep(for: .milliseconds(min(5_000, 250 * (1 << min(reconnectAttempt - 1, 5)))))
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
        let envelope = (try? decoder.decode(ArborSyncErrorEnvelope.self, from: data))
            ?? ArborSyncErrorEnvelope(
                error: "internal-error",
                message: HTTPURLResponse.localizedString(forStatusCode: status),
                retryable: false
            )
        throw ArborSyncServerError(status: status, value: envelope.value)
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

private struct ForgetResult: Decodable { var forgotten: Bool }
private struct LocalResyncObservation: Decodable { var cursor: String; var tree: String; var kind: String }

private struct TreeBootstrapEnvelope: Decodable {
    var tree: LocalTreeDescriptor
    var accepted: TreeBootstrapAccepted
    var spine: String
    var files: [String: TreeBootstrapFile]
    var pending: TreeBootstrapPending?
    var blocked: TreeBootstrapBlock?
    var observedThrough: String
}
