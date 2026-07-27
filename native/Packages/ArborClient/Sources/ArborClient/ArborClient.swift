import Foundation

public struct ArbordServerError: Error, Sendable {
    public var status: Int
    public var value: ArbordErrorValue
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

public actor ArborClient {
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

    public func prepareContentMutation(
        _ operation: WorkspaceOperation,
        mutationID: String? = nil
    ) throws -> MutationRequest {
        guard operation.isContentOperation else {
            throw InvalidMutationDomainError("A content mutation requires writeMarkdown or restoreRecovery")
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

    public func openNodeView(_ ref: NodeRef) async throws -> ObservedNodeView {
        let snapshot = try await nodeSnapshot(ref)
        let observedRef = snapshot.ref.pageID.map {
            NodeRef.pageID($0, pathHint: snapshot.path, tree: snapshot.tree ?? snapshot.ref.tree)
        } ?? .path(snapshot.path, tree: snapshot.tree ?? snapshot.ref.tree)
        let updates = nodeUpdates(ref: observedRef, after: snapshot.observedThrough)
        return ObservedNodeView(snapshot: try await hydrateNode(snapshot), updates: updates)
    }

    /// Open a node with its derived directory projection. Mirrors the
    /// TypeScript `openProjectedNodeView`: the snapshot/event handoff is
    /// preserved and resync updates arrive re-hydrated and re-projected.
    public func openProjectedNodeView(_ ref: NodeRef) async throws -> ProjectedNodeView {
        let view = try await openNodeView(ref)
        let rawUpdates = view.updates
        let updates = AsyncThrowingStream<ProjectedNodeUpdate, Error> { continuation in
            let task = Task {
                do {
                    for try await update in rawUpdates {
                        switch update {
                        case .event(let event):
                            continuation.yield(.event(event))
                        case .resync(let snapshot):
                            continuation.yield(.resync(snapshot, projectSnapshot(snapshot)))
                        }
                    }
                    continuation.finish()
                } catch is CancellationError {
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
        return ProjectedNodeView(
            snapshot: view.snapshot,
            projection: projectSnapshot(view.snapshot),
            updates: updates
        )
    }

    private func nodeSnapshot(_ ref: NodeRef) async throws -> NodeSnapshot {
        try await get(path: "/v1/node", ref: ref)
    }

    private func hydrateNode(_ initial: NodeSnapshot) async throws -> NodeSnapshot {
        var snapshot = initial
        if snapshot.kind == "directory" || snapshot.kind == "collection" {
            let ref = snapshot.ref.pageID.map {
                NodeRef.pageID($0, pathHint: snapshot.ref.path, tree: snapshot.tree ?? snapshot.ref.tree)
            } ?? .path(snapshot.ref.path, tree: snapshot.tree ?? snapshot.ref.tree)
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

    public func search(_ query: String, cursor: String? = nil) async throws -> SearchPage {
        var items = [URLQueryItem(name: "q", value: query)]
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
                    lastMessage = (try? decoder.decode(ArbordErrorEnvelope.self, from: data).error.message) ?? "arbord returned 500"
                    throw RetryableServerError()
                }
                try validate(data: data, status: status)
                return try decoder.decode(MutationReceipt.self, from: data)
            } catch let error as ArbordServerError {
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
                            let envelope = try decoder.decode(ArbordErrorEnvelope.self, from: data)
                            throw ArbordServerError(status: status, value: envelope.error)
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
                            let dataLines = text
                                .split(separator: "\n", omittingEmptySubsequences: false)
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
                                let event = try decoder.decode(WorkspaceEvent.self, from: data)
                                cursor = event.cursor
                                continuation.yield(event)
                            }
                        }
                    } catch let error as ArbordServerError {
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
                    } catch let error as ArbordServerError where error.value.code == "resync-required" {
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
                    lastError = (try? decoder.decode(ArbordErrorEnvelope.self, from: data))
                        .map { ArbordServerError(status: status, value: $0.error) }
                        ?? URLError(.badServerResponse)
                    throw RetryableServerError()
                }
                try validate(data: data, status: status)
                return try decoder.decode(T.self, from: data)
            } catch let error as ArbordServerError {
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
        let envelope = (try? decoder.decode(ArbordErrorEnvelope.self, from: data))
            ?? ArbordErrorEnvelope(error: ArbordErrorValue(
                code: "internal-error",
                message: HTTPURLResponse.localizedString(forStatusCode: status),
                retryable: false
            ))
        throw ArbordServerError(status: status, value: envelope.error)
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
        var items: [URLQueryItem] = []
        if let tree = ref.tree { items.append(URLQueryItem(name: "tree", value: tree)) }
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
