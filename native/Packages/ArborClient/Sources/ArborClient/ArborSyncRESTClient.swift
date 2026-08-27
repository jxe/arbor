import Foundation

public struct ArborSyncServerError: Error, LocalizedError, Sendable {
    public var status: Int
    public var value: ArborSyncErrorValue

    public var errorDescription: String? { value.message }
}

public struct AmbiguousMutationError: Error, Sendable {
    public var request: MutationRequest
    public var message: String
}

public struct InvalidMutationDomainError: Error, Sendable, Equatable {
    public var message: String

    public init(_ message: String) {
        self.message = message
    }
}

public struct ImportEntry: Sendable {
    public enum Kind: String, Sendable {
        case file
        case directory
    }

    public var path: String
    public var kind: Kind
    public var data: Data?
    public var filename: String?

    public init(path: String, kind: Kind, data: Data? = nil, filename: String? = nil) {
        self.path = path
        self.kind = kind
        self.data = data
        self.filename = filename
    }
}

public struct AssetResult: Codable, Sendable, Equatable {
    public var receipt: MutationReceipt
    public var path: String
    public var markdownPath: String
}

public struct FileRead: Sendable, Equatable {
    public var bytes: Data
    public var revision: String
}

public actor ArborSyncRESTClient {
    public typealias MutationIDGenerator = @Sendable () -> String
    public typealias RetryDelay = @Sendable (_ attempt: Int) async throws -> Void

    private let baseURL: URL
    private let session: URLSession
    private let mutationIDGenerator: MutationIDGenerator
    private let retryDelay: RetryDelay
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    public init(
        baseURL: URL,
        session: URLSession = .shared,
        mutationIDGenerator: @escaping MutationIDGenerator = { UUID().uuidString.lowercased() },
        retryDelay: @escaping RetryDelay = { attempt in
            try await Task.sleep(for: .milliseconds(attempt == 1 ? 100 : 500))
        }
    ) {
        self.baseURL = baseURL
        self.session = session
        self.mutationIDGenerator = mutationIDGenerator
        self.retryDelay = retryDelay
    }

    public func status() async throws -> ArborSyncStatus {
        try await get(path: "/v1/status", items: [])
    }

    public func openSession(_ path: String) async throws -> NodeSnapshot {
        struct Request: Encodable { var path: String }
        var request = URLRequest(url: url("/v1/sessions"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try encoder.encode(Request(path: path))
        return try await perform(request)
    }

    public func trees() async throws -> SnapshotEnvelope<[LocalTreeDescriptor]> {
        try await get(path: "/v1/trees", items: [])
    }

    public func resolve(_ locator: String) async throws -> LocatorResolution {
        try await get(path: "/v1/resolve", items: [URLQueryItem(name: "locator", value: locator)])
    }

    public func treeID() async throws -> String {
        var request = URLRequest(url: url("/v1/tree-ids"))
        request.httpMethod = "POST"
        let generated: GeneratedTreeID = try await perform(request)
        return generated.id
    }

    public func createCommunityPairing() async throws -> WirePairingOffer {
        var request = URLRequest(url: url("/v1/bootstrap/pairings"))
        request.httpMethod = "POST"
        return try await perform(request)
    }

    public func prepareContentMutation(
        _ operation: WorkspaceOperation,
        mutationID: String? = nil
    ) throws -> MutationRequest {
        guard operation.isContentOperation else {
            throw InvalidMutationDomainError("A content mutation requires writeText, writeMarkdown, or restoreRecovery")
        }
        return MutationRequest(
            mutationID: mutationID ?? mutationIDGenerator(),
            operations: [operation]
        )
    }

    public func prepareStructuralMutation(
        _ operations: [WorkspaceOperation],
        mutationID: String? = nil
    ) throws -> MutationRequest {
        guard !operations.isEmpty else {
            throw InvalidMutationDomainError("A structural mutation requires at least one operation")
        }
        guard !operations.contains(where: \.isContentOperation) else {
            throw InvalidMutationDomainError("A structural mutation cannot contain content operations")
        }
        return MutationRequest(
            mutationID: mutationID ?? mutationIDGenerator(),
            operations: operations
        )
    }

    public func node(_ ref: NodeRef) async throws -> NodeSnapshot {
        try await hydrateNode(try await nodeSnapshot(ref))
    }

    /// Read the exact current bytes of an ordinary file.
    public func file(_ ref: NodeRef) async throws -> FileRead {
        var components = URLComponents(url: url("/v1/file"), resolvingAgainstBaseURL: false)!
        components.queryItems = queryItems(ref)
        let (data, response) = try await session.data(for: URLRequest(url: components.url!))
        try validate(data: data, status: try statusCode(response))
        guard let http = response as? HTTPURLResponse,
              let revision = http.value(forHTTPHeaderField: "ETag")?.trimmingCharacters(in: CharacterSet(charactersIn: "\"")),
              !revision.isEmpty else {
            throw URLError(.badServerResponse)
        }
        return FileRead(bytes: data, revision: revision)
    }

    public func writeText(
        _ ref: NodeRef,
        baseContentRevision: String,
        source: String,
        mutationID: String? = nil
    ) async throws -> MutationReceipt {
        try await mutateContent(
            WorkspaceOperation(op: "writeText", ref: ref, baseContentRevision: baseContentRevision, source: source),
            mutationID: mutationID
        )
    }

    public func claimProfile(origin: String, handle: String, path: String, displayName: String? = nil) async throws -> MutationReceipt {
        var request = URLRequest(url: url("/v1/bootstrap/claims"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try encoder.encode(ClaimBootstrapBody(origin: origin, handle: handle, path: path, displayName: displayName))
        return try await perform(request)
    }

    public func forgetLocalAccount() async throws {
        var request = URLRequest(url: url("/v1/local/forget"))
        request.httpMethod = "POST"
        let _: ForgetResult = try await perform(request)
    }

    public func openNodeView(_ ref: NodeRef) async throws -> ObservedNodeView {
        let snapshot = try await nodeSnapshot(ref)
        let observedRef = snapshot.ref.pageID.map {
            NodeRef.pageID($0, pathHint: snapshot.path, tree: snapshot.tree)
        } ?? .path(snapshot.path, tree: snapshot.tree)
        let updates = nodeUpdates(ref: observedRef, after: snapshot.observedThrough)
        return ObservedNodeView(snapshot: try await hydrateNode(snapshot), updates: updates)
    }

    private func nodeSnapshot(_ ref: NodeRef) async throws -> NodeSnapshot {
        try await get(path: "/v1/node", ref: ref)
    }

    private func hydrateNode(_ initial: NodeSnapshot) async throws -> NodeSnapshot {
        var snapshot = initial
        if snapshot.kind == "directory" || snapshot.kind == "collection" {
            let ref = snapshot.ref.pageID.map {
                NodeRef.pageID($0, pathHint: snapshot.ref.path, tree: snapshot.tree)
            } ?? .path(snapshot.ref.path, tree: snapshot.tree)
            snapshot.children = try await allChildren(ref)
        }
        return snapshot
    }

    public func children(_ ref: NodeRef, cursor: String? = nil) async throws -> ChildrenPage {
        try await get(path: "/v1/children", ref: ref, extra: cursor.map { [URLQueryItem(name: "cursor", value: $0)] } ?? [])
    }

    public func allChildren(_ ref: NodeRef) async throws -> [TreeChild] {
        var items: [TreeChild] = []
        var cursor: String?
        repeat {
            let page = try await children(ref, cursor: cursor)
            items.append(contentsOf: page.items)
            cursor = page.nextCursor
        } while cursor != nil
        return items
    }

    public func search(tree: String, query: String, cursor: String? = nil) async throws -> SearchPage {
        var items = [URLQueryItem(name: "tree", value: tree), URLQueryItem(name: "q", value: query)]
        if let cursor { items.append(URLQueryItem(name: "cursor", value: cursor)) }
        return try await get(path: "/v1/search", items: items)
    }

    public func backlinks(_ ref: NodeRef, cursor: String? = nil) async throws -> BacklinksPage {
        try await get(
            path: "/v1/backlinks",
            ref: ref,
            extra: cursor.map { [URLQueryItem(name: "cursor", value: $0)] } ?? []
        )
    }

    public func collection(
        _ ref: NodeRef,
        cursor: String? = nil,
        table: String? = nil
    ) async throws -> CollectionPage {
        var extra: [URLQueryItem] = []
        if let cursor { extra.append(URLQueryItem(name: "cursor", value: cursor)) }
        if let table { extra.append(URLQueryItem(name: "table", value: table)) }
        return try await get(path: "/v1/collection", ref: ref, extra: extra)
    }

    public func recovery(
        _ ref: NodeRef,
        recursive: Bool = false,
        cursor: String? = nil
    ) async throws -> RecoveryPage {
        var extra: [URLQueryItem] = []
        if recursive { extra.append(URLQueryItem(name: "recursive", value: "true")) }
        if let cursor { extra.append(URLQueryItem(name: "cursor", value: cursor)) }
        return try await get(path: "/v1/recovery", ref: ref, extra: extra)
    }

    public func mutate(_ request: MutationRequest) async throws -> MutationReceipt {
        try validateMutationDomain(request)
        let body = try encoder.encode(request)
        var lastMessage = "unknown transport failure"
        for attempt in 0..<3 {
            do {
                var urlRequest = URLRequest(url: url("/v1/mutations"))
                urlRequest.httpMethod = "POST"
                urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
                urlRequest.httpBody = body
                let (data, response) = try await session.data(for: urlRequest)
                let status = try statusCode(response)
                if status == 500 {
                    lastMessage = (try? decoder.decode(ArborSyncErrorEnvelope.self, from: data).message) ?? "arborsync returned 500"
                    throw RetryableServerError()
                }
                try validate(data: data, status: status)
                return try decoder.decode(MutationReceipt.self, from: data)
            } catch let error as ArborSyncServerError {
                throw error
            } catch {
                lastMessage = String(describing: error)
                if attempt < 2 { try await retryDelay(attempt + 1) }
            }
        }
        throw AmbiguousMutationError(request: request, message: lastMessage)
    }

    public func mutateContent(
        _ operation: WorkspaceOperation,
        mutationID: String? = nil
    ) async throws -> MutationReceipt {
        try await mutate(prepareContentMutation(operation, mutationID: mutationID))
    }

    public func mutateStructural(
        _ operations: [WorkspaceOperation],
        mutationID: String? = nil
    ) async throws -> MutationReceipt {
        try await mutate(prepareStructuralMutation(operations, mutationID: mutationID))
    }

    public func asset(
        directory: NodeRef,
        filename: String,
        contentType: String,
        data: Data,
        mutationID: String? = nil
    ) async throws -> AssetResult {
        let id = mutationID ?? mutationIDGenerator()
        let metadata = try encoder.encode(AssetMetadata(mutationID: id, directory: directory, filename: filename))
        let boundary = "Arbor-\(UUID().uuidString)"
        let body = multipart(
            boundary: boundary,
            fields: [("metadata", metadata, nil, "application/json")],
            files: [("file", data, filename, contentType)]
        )
        var request = URLRequest(url: url("/v1/assets"))
        request.httpMethod = "POST"
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        request.httpBody = body
        return try await performIdempotent(request)
    }

    public func importEntries(
        destination: NodeRef,
        entries: [ImportEntry],
        mutationID: String? = nil
    ) async throws -> MutationReceipt {
        let id = mutationID ?? mutationIDGenerator()
        var files: [(String, Data, String, String)] = []
        let manifest = entries.enumerated().map { index, entry -> ImportManifestEntry in
            guard entry.kind == .file else {
                return ImportManifestEntry(path: entry.path, kind: entry.kind.rawValue, field: nil)
            }
            let field = "file-\(index)"
            files.append((field, entry.data ?? Data(), entry.filename ?? URL(fileURLWithPath: entry.path).lastPathComponent, "application/octet-stream"))
            return ImportManifestEntry(path: entry.path, kind: entry.kind.rawValue, field: field)
        }
        let metadata = try encoder.encode(ImportMetadata(mutationID: id, destination: destination, entries: manifest))
        let boundary = "Arbor-\(UUID().uuidString)"
        let body = multipart(
            boundary: boundary,
            fields: [("metadata", metadata, nil, "application/json")],
            files: files
        )
        var request = URLRequest(url: url("/v1/imports"))
        request.httpMethod = "POST"
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        request.httpBody = body
        return try await performIdempotent(request)
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

    private func nodeUpdates(
        ref: NodeRef,
        after initialCursor: String
    ) -> AsyncThrowingStream<ObservedNodeUpdate, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                var cursor = initialCursor
                while !Task.isCancelled {
                    do {
                        for try await event in self.observations(after: cursor) {
                            cursor = event.cursor
                            continuation.yield(.event(event))
                        }
                        continuation.finish()
                        return
                    } catch let error as ArborSyncServerError where error.value.code == "resync-required" {
                        do {
                            let snapshot = try await self.node(ref)
                            cursor = snapshot.observedThrough
                            continuation.yield(.resync(snapshot))
                        } catch {
                            continuation.finish(throwing: error)
                            return
                        }
                    } catch is CancellationError {
                        continuation.finish()
                        return
                    } catch {
                        continuation.finish(throwing: error)
                        return
                    }
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    private func validateMutationDomain(_ request: MutationRequest) throws {
        guard !request.mutationID.isEmpty, !request.operations.isEmpty else {
            throw InvalidMutationDomainError("A mutation requires a non-empty mutation ID and operations array")
        }
        guard request.operations.allSatisfy({ operation in
            operation.ref?.tree.isEmpty != true
                && operation.refs?.contains(where: { $0.tree.isEmpty }) != true
                && operation.destination?.tree.isEmpty != true
                && (operation.path == nil || operation.tree?.isEmpty == false)
        }) else {
            throw InvalidMutationDomainError("Every mutation reference requires explicit tree scope")
        }
        let contentCount = request.operations.filter(\.isContentOperation).count
        if contentCount > 0 && (contentCount != 1 || request.operations.count != 1) {
            throw InvalidMutationDomainError(
                "A content mutation contains exactly one operation and cannot be mixed with structural operations"
            )
        }
    }

    private func get<T: Decodable>(
        path: String,
        ref: NodeRef,
        extra: [URLQueryItem] = []
    ) async throws -> T {
        try await get(path: path, items: queryItems(ref) + extra)
    }

    private func get<T: Decodable>(
        path: String,
        items: [URLQueryItem]
    ) async throws -> T {
        var components = URLComponents(url: url(path), resolvingAgainstBaseURL: false)!
        components.queryItems = items
        return try await perform(URLRequest(url: components.url!))
    }

    private func perform<T: Decodable>(_ request: URLRequest) async throws -> T {
        let (data, response) = try await session.data(for: request)
        let status = try statusCode(response)
        try validate(data: data, status: status)
        return try decoder.decode(T.self, from: data)
    }

    private func performIdempotent<T: Decodable>(_ request: URLRequest) async throws -> T {
        var lastError: Error = URLError(.unknown)
        for attempt in 0..<3 {
            do {
                let (data, response) = try await session.data(for: request)
                let status = try statusCode(response)
                if status == 500 {
                    lastError = (try? decoder.decode(ArborSyncErrorEnvelope.self, from: data))
                        .map { ArborSyncServerError(status: status, value: $0.value) }
                        ?? URLError(.badServerResponse)
                    throw RetryableServerError()
                }
                try validate(data: data, status: status)
                return try decoder.decode(T.self, from: data)
            } catch let error as ArborSyncServerError {
                throw error
            } catch {
                if !(error is RetryableServerError) {
                    lastError = error
                }
                if attempt < 2 {
                    try await retryDelay(attempt + 1)
                }
            }
        }
        throw lastError
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

    private func queryItems(_ ref: NodeRef) -> [URLQueryItem] {
        var items: [URLQueryItem] = [URLQueryItem(name: "tree", value: ref.tree)]
        if let path = ref.path {
            items.append(URLQueryItem(name: "path", value: path))
        } else if let pageID = ref.pageID {
            items.append(URLQueryItem(name: "pageID", value: pageID))
            if let pathHint = ref.pathHint {
                items.append(URLQueryItem(name: "pathHint", value: pathHint))
            }
        }
        return items
    }

    private func multipart(
        boundary: String,
        fields: [(String, Data, String?, String)],
        files: [(String, Data, String, String)]
    ) -> Data {
        var result = Data()
        for (name, data, filename, contentType) in fields + files {
            result.append(Data("--\(boundary)\r\n".utf8))
            let disposition = filename.map { "; filename=\"\($0)\"" } ?? ""
            result.append(Data("Content-Disposition: form-data; name=\"\(name)\"\(disposition)\r\n".utf8))
            result.append(Data("Content-Type: \(contentType)\r\n\r\n".utf8))
            result.append(data)
            result.append(Data("\r\n".utf8))
        }
        result.append(Data("--\(boundary)--\r\n".utf8))
        return result
    }
}

private struct GeneratedTreeID: Decodable { var id: String }
private struct ClaimBootstrapBody: Encodable { var origin: String; var handle: String; var path: String; var displayName: String? }
private struct ForgetResult: Decodable { var forgotten: Bool }
private struct LocalResyncObservation: Decodable { var cursor: String; var tree: String; var kind: String }

private struct RetryableServerError: Error {}

private struct AssetMetadata: Codable {
    var mutationID: String
    var directory: NodeRef
    var filename: String
}

private struct ImportManifestEntry: Codable {
    var path: String
    var kind: String
    var field: String?
}

private struct ImportMetadata: Codable {
    var mutationID: String
    var destination: NodeRef
    var entries: [ImportManifestEntry]
}
