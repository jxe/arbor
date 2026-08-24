import Foundation

public actor InMemoryWorkspaceProvider: WorkspaceProvider {
    private var nodesByIdentity: [WorkspaceIdentity: WorkspaceNode]
    private var childrenByIdentity: [WorkspaceIdentity: [WorkspaceIdentity]]

    public init(nodes: [WorkspaceNode], children: [WorkspaceIdentity: [WorkspaceIdentity]] = [:]) {
        self.nodesByIdentity = Dictionary(uniqueKeysWithValues: nodes.map { ($0.id, $0) })
        self.childrenByIdentity = children
    }

    public static func sample() -> InMemoryWorkspaceProvider {
        let tree: TreeID = "tr_sample"
        let root = WorkspaceNode(
            reference: WorkspaceReference(tree: tree, path: "/"),
            title: "Home",
            surface: .directory(summary: "A deterministic Arbor workspace"),
            provenance: .init(authority: .local, sourceDescription: "In-memory preview")
        )
        let welcome = WorkspaceNode(
            reference: WorkspaceReference(tree: tree, path: "/welcome", pageID: "pg_welcome"),
            title: "Welcome",
            surface: .markdown(source: "# Welcome\n\nNative Arbor is ready for a provider.\n", contentRevision: "r1"),
            provenance: .init(authority: .local, sourceDescription: "In-memory preview", contentRevision: "r1")
        )
        let files = WorkspaceNode(
            reference: WorkspaceReference(tree: tree, path: "/files"),
            title: "Files",
            surface: .directory(summary: nil),
            provenance: .init(authority: .local, sourceDescription: "In-memory preview")
        )
        let image = WorkspaceNode(
            reference: WorkspaceReference(tree: tree, path: "/files/arbor.png"),
            title: "arbor.png",
            surface: .file(name: "arbor.png", byteCount: 12_480, mediaType: "image/png"),
            provenance: .init(authority: .local, sourceDescription: "In-memory preview")
        )
        let collection = WorkspaceNode(
            reference: WorkspaceReference(tree: tree, path: "/people"),
            title: "People",
            surface: .collection(kind: "CSV", rowCount: 3),
            provenance: .init(authority: .local, sourceDescription: "In-memory preview"),
            isWritable: false
        )
        let placeholder = WorkspaceNode(
            reference: WorkspaceReference(tree: tree, path: "/offline"),
            title: "Offline item",
            surface: .placeholder(message: "This item is not materialized."),
            provenance: .init(authority: .synchronized, sourceDescription: "Remote replica"),
            materialization: .placeholder,
            isWritable: false
        )
        let diagnostic = WorkspaceNode(
            reference: WorkspaceReference(tree: tree, path: "/diagnostic"),
            title: "Provider diagnostic",
            surface: .diagnostic(title: "Provider unavailable", detail: "Reconnect to continue."),
            provenance: .init(authority: .diagnostic, sourceDescription: "Provider status"),
            isWritable: false
        )
        let historical = WorkspaceNode(
            reference: WorkspaceReference(tree: tree, path: "/welcome", pageID: "pg_welcome_history"),
            title: "Welcome · Earlier version",
            surface: .historical(source: "# Welcome\n", revision: "r0"),
            provenance: .init(authority: .historical, sourceDescription: "Local history", contentRevision: "r0"),
            isWritable: false
        )
        return InMemoryWorkspaceProvider(
            nodes: [root, welcome, files, image, collection, placeholder, diagnostic, historical],
            children: [
                root.id: [welcome.id, files.id, collection.id, placeholder.id, diagnostic.id],
                files.id: [image.id]
            ]
        )
    }

    public func resolve(_ reference: WorkspaceReference) async throws -> WorkspaceNode {
        if let node = nodesByIdentity[reference.identity] { return node }
        if let pageID = reference.pageID,
           let node = nodesByIdentity.values.first(where: { $0.reference.tree == reference.tree && $0.reference.pageID == pageID }) {
            return node
        }
        if let node = nodesByIdentity.values.first(where: { $0.reference.tree == reference.tree && $0.reference.pathHint == reference.pathHint }) {
            return node
        }
        throw WorkspaceProviderError.notFound(reference)
    }

    public func children(of reference: WorkspaceReference) async throws -> [WorkspaceNode] {
        let node = try await resolve(reference)
        return childrenByIdentity[node.id, default: []].compactMap { nodesByIdentity[$0] }
    }

    public func search(_ query: String, in tree: TreeID) async throws -> [WorkspaceSearchResult] {
        let needle = query.localizedLowercase
        return nodesByIdentity.values
            .filter { $0.reference.tree == tree && ($0.title.localizedLowercase.contains(needle) || source(of: $0).localizedLowercase.contains(needle)) }
            .sorted { $0.title < $1.title }
            .map { WorkspaceSearchResult(reference: $0.reference, title: $0.title, excerpt: source(of: $0).isEmpty ? nil : source(of: $0)) }
    }

    public func backlinks(to reference: WorkspaceReference) async throws -> [WorkspaceSearchResult] {
        let target = reference.pathHint
        return nodesByIdentity.values.compactMap { node in
            guard source(of: node).contains(target) else { return nil }
            return WorkspaceSearchResult(reference: node.reference, title: node.title, excerpt: target)
        }
    }

    public func perform(_ action: WorkspaceStructuralAction) async throws -> WorkspaceNode? {
        switch action {
        case let .rename(reference, name):
            var node = try await resolve(reference)
            guard node.isWritable else { throw WorkspaceProviderError.readOnly(reference) }
            let parent = node.reference.parent?.pathHint ?? "/"
            let path = parent == "/" ? "/\(name)" : "\(parent)/\(name)"
            let oldIdentity = node.id
            node.reference.pathHint = path
            node.title = name
            nodesByIdentity.removeValue(forKey: oldIdentity)
            nodesByIdentity[node.id] = node
            if oldIdentity != node.id {
                for key in childrenByIdentity.keys where childrenByIdentity[key]?.contains(oldIdentity) == true {
                    childrenByIdentity[key] = childrenByIdentity[key]?.map { $0 == oldIdentity ? node.id : $0 }
                }
            }
            return node
        case let .createMarkdown(parent, name, source):
            let parentNode = try await resolve(parent)
            let path = parentNode.reference.pathHint == "/" ? "/\(name)" : "\(parentNode.reference.pathHint)/\(name)"
            let node = WorkspaceNode(
                reference: WorkspaceReference(tree: parent.tree, path: path, pageID: PageID(rawValue: "pg_\(UUID().uuidString.lowercased())")),
                title: name,
                surface: .markdown(source: source, contentRevision: "r1"),
                provenance: parentNode.provenance
            )
            nodesByIdentity[node.id] = node
            childrenByIdentity[parentNode.id, default: []].append(node.id)
            return node
        case let .createDirectory(parent, name):
            let parentNode = try await resolve(parent)
            let path = parentNode.reference.pathHint == "/" ? "/\(name)" : "\(parentNode.reference.pathHint)/\(name)"
            let node = WorkspaceNode(
                reference: WorkspaceReference(tree: parent.tree, path: path),
                title: name,
                surface: .directory(summary: nil),
                provenance: parentNode.provenance
            )
            nodesByIdentity[node.id] = node
            childrenByIdentity[parentNode.id, default: []].append(node.id)
            return node
        case .move, .trash, .restore:
            throw WorkspaceProviderError.invalidAction("The deterministic provider does not materialize this action")
        }
    }

    public func store(asset: WorkspaceAsset, in parent: WorkspaceReference) async throws -> WorkspaceReference {
        let parentNode = try await resolve(parent)
        let path = parentNode.reference.pathHint == "/" ? "/\(asset.name)" : "\(parentNode.reference.pathHint)/\(asset.name)"
        let node = WorkspaceNode(
            reference: WorkspaceReference(tree: parent.tree, path: path),
            title: asset.name,
            surface: .file(name: asset.name, byteCount: asset.bytes.count, mediaType: asset.mediaType),
            provenance: parentNode.provenance
        )
        nodesByIdentity[node.id] = node
        childrenByIdentity[parentNode.id, default: []].append(node.id)
        return node.reference
    }

    public func openDocument(_ reference: WorkspaceReference) async throws -> any WorkspaceDocumentSession {
        let node = try await resolve(reference)
        guard case let .markdown(source, revision) = node.surface else {
            throw WorkspaceProviderError.notDocument(node.reference)
        }
        return InMemoryDocumentSession(snapshot: .init(reference: node.reference, source: source, contentRevision: revision))
    }

    private func source(of node: WorkspaceNode) -> String {
        switch node.surface {
        case let .markdown(source, _), let .historical(source, _): source
        default: ""
        }
    }
}

public actor InMemoryDocumentSession: WorkspaceDocumentSession {
    public nonisolated let identity: WorkspaceIdentity
    private var current: WorkspaceDocumentSnapshot
    private var revisions: [WorkspaceDocumentSnapshot]
    private var isClosed = false

    public init(snapshot: WorkspaceDocumentSnapshot) {
        self.identity = snapshot.reference.identity
        self.current = snapshot
        self.revisions = [snapshot]
    }

    public func snapshot() async throws -> WorkspaceDocumentSnapshot { current }

    public func admit(source: String, baseContentRevision: String) async throws -> WorkspaceDocumentSnapshot {
        guard !isClosed else { throw WorkspaceProviderError.invalidAction("Document session is closed") }
        guard baseContentRevision == current.contentRevision else {
            throw WorkspaceDocumentConflict(current: current, submittedSource: source)
        }
        current.source = source
        current.contentRevision = "r\(revisions.count + 1)"
        revisions.append(current)
        return current
    }

    public func flush() async throws {}

    public func history() async throws -> [WorkspaceHistoryEntry] {
        revisions.enumerated().map { index, revision in
            WorkspaceHistoryEntry(
                id: revision.contentRevision,
                revision: revision.contentRevision,
                title: index == revisions.count - 1 ? "Current" : "Revision \(index + 1)",
                timestamp: Date(timeIntervalSince1970: Double(index))
            )
        }
    }

    public func recover(revision: String) async throws -> WorkspaceDocumentSnapshot {
        guard let recovered = revisions.first(where: { $0.contentRevision == revision }) else {
            throw WorkspaceProviderError.invalidAction("Unknown revision")
        }
        current.source = recovered.source
        current.contentRevision = "r\(revisions.count + 1)"
        revisions.append(current)
        return current
    }

    public func close() async { isClosed = true }
}
