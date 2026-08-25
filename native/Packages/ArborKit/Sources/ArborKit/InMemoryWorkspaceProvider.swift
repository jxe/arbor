import Foundation

public actor InMemoryWorkspaceProvider: WorkspaceProvider {
    private var nodesByIdentity: [WorkspaceIdentity: WorkspaceNode]
    private var childrenByIdentity: [WorkspaceIdentity: [WorkspaceIdentity]]
    private var fileBytesByIdentity: [WorkspaceIdentity: Data] = [:]

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
        case let .move(reference, destination):
            let node = try await resolve(reference)
            let destinationNode = try await resolve(destination)
            let name = node.reference.pathHint.split(separator: "/").last.map(String.init) ?? node.title
            let path = destinationNode.reference.pathHint == "/" ? "/\(name)" : "\(destinationNode.reference.pathHint)/\(name)"
            return try relocate(node, to: path, newTitle: nil)
        case let .copy(reference, destination):
            let node = try await resolve(reference)
            let destinationNode = try await resolve(destination)
            let name = node.reference.pathHint.split(separator: "/").last.map(String.init) ?? node.title
            let path = destinationNode.reference.pathHint == "/" ? "/\(name)" : "\(destinationNode.reference.pathHint)/\(name)"
            return try copySubtree(node, to: path, parent: destinationNode)
        case let .trash(reference):
            let node = try await resolve(reference)
            return try relocate(node, to: "/Trash\(node.reference.pathHint)", newTitle: nil)
        case let .restore(reference):
            let node = try await resolve(reference)
            guard node.reference.pathHint.hasPrefix("/Trash/") else {
                throw WorkspaceProviderError.invalidAction("Only Trash nodes can be restored")
            }
            return try relocate(
                node,
                to: String(node.reference.pathHint.dropFirst("/Trash".count)),
                newTitle: nil
            )
        }
    }

    public func store(asset: WorkspaceAsset, in parent: WorkspaceReference) async throws -> WorkspaceStoredAsset {
        let parentNode = try await resolve(parent)
        let path = parentNode.reference.pathHint == "/" ? "/\(asset.name)" : "\(parentNode.reference.pathHint)/\(asset.name)"
        let node = WorkspaceNode(
            reference: WorkspaceReference(tree: parent.tree, path: path),
            title: asset.name,
            surface: .file(name: asset.name, byteCount: asset.bytes.count, mediaType: asset.mediaType),
            provenance: parentNode.provenance
        )
        nodesByIdentity[node.id] = node
        fileBytesByIdentity[node.id] = asset.bytes
        childrenByIdentity[parentNode.id, default: []].append(node.id)
        return WorkspaceStoredAsset(reference: node.reference, markdownSource: node.reference.pathHint)
    }

    public func readFile(_ reference: WorkspaceReference) async throws -> Data {
        let node = try await resolve(reference)
        guard case .file = node.surface else { throw WorkspaceProviderError.notFound(reference) }
        guard let bytes = fileBytesByIdentity[node.id] else { throw WorkspaceProviderError.notFound(reference) }
        return bytes
    }

    public func openDocument(_ reference: WorkspaceReference) async throws -> any WorkspaceDocumentSession {
        let node = try await resolve(reference)
        let snapshot: WorkspaceDocumentSnapshot
        switch node.surface {
        case let .markdown(source, revision), let .directoryDocument(source, revision, _):
            snapshot = .init(reference: node.reference, source: source, contentRevision: revision)
        default:
            throw WorkspaceProviderError.notDocument(node.reference)
        }
        guard node.isWritable else { throw WorkspaceProviderError.readOnly(node.reference) }
        return InMemoryDocumentSession(provider: self, snapshot: snapshot)
    }

    private func source(of node: WorkspaceNode) -> String {
        switch node.surface {
        case let .markdown(source, _), let .directoryDocument(source, _, _), let .historical(source, _): source
        default: ""
        }
    }

    fileprivate func persist(_ snapshot: WorkspaceDocumentSnapshot) throws {
        guard var node = nodesByIdentity[snapshot.reference.identity]
            ?? nodesByIdentity.values.first(where: { $0.reference.pathHint == snapshot.reference.pathHint }) else {
            throw WorkspaceProviderError.notFound(snapshot.reference)
        }
        switch node.surface {
        case .markdown:
            node.surface = .markdown(source: snapshot.source, contentRevision: snapshot.contentRevision)
        case let .directoryDocument(_, _, stored):
            node.surface = .directoryDocument(
                source: snapshot.source,
                contentRevision: snapshot.contentRevision,
                stored: stored
            )
        default:
            throw WorkspaceProviderError.notDocument(snapshot.reference)
        }
        node.provenance.contentRevision = snapshot.contentRevision
        nodesByIdentity[node.id] = node
    }

    fileprivate func admit(
        reference: WorkspaceReference,
        source: String,
        baseContentRevision: String
    ) throws -> WorkspaceDocumentSnapshot {
        guard let node = nodesByIdentity[reference.identity]
            ?? nodesByIdentity.values.first(where: { $0.reference.pathHint == reference.pathHint }) else {
            throw WorkspaceProviderError.notFound(reference)
        }
        let currentSource: String
        let currentRevision: String
        switch node.surface {
        case let .markdown(source, revision), let .directoryDocument(source, revision, _):
            currentSource = source
            currentRevision = revision
        default:
            throw WorkspaceProviderError.notDocument(reference)
        }
        guard currentRevision == baseContentRevision else {
            throw WorkspaceDocumentConflict(
                current: WorkspaceDocumentSnapshot(
                    reference: node.reference,
                    source: currentSource,
                    contentRevision: currentRevision
                ),
                submittedSource: source
            )
        }
        let number = Int(currentRevision.drop(while: { !$0.isNumber })) ?? 0
        let admitted = WorkspaceDocumentSnapshot(
            reference: node.reference,
            source: source,
            contentRevision: "r\(number + 1)"
        )
        try persist(admitted)
        return admitted
    }

    private func relocate(_ node: WorkspaceNode, to path: String, newTitle: String?) throws -> WorkspaceNode {
        if nodesByIdentity.values.contains(where: {
            $0.reference.tree == node.reference.tree && $0.reference.pathHint == path && $0.id != node.id
        }) {
            throw WorkspaceProviderError.invalidAction("Destination already exists")
        }
        let oldPath = node.reference.pathHint
        let rootIdentity = node.id
        var movedRoot: WorkspaceNode?
        let affected = nodesByIdentity.values
            .filter { $0.reference.tree == node.reference.tree && ($0.reference.pathHint == oldPath || $0.reference.pathHint.hasPrefix(oldPath + "/")) }
            .sorted { $0.reference.pathHint.count < $1.reference.pathHint.count }
        for var value in affected {
            let oldID = value.id
            let suffix = String(value.reference.pathHint.dropFirst(oldPath.count))
            value.reference.pathHint = path + suffix
            if suffix.isEmpty, let newTitle { value.title = newTitle }
            nodesByIdentity.removeValue(forKey: oldID)
            nodesByIdentity[value.id] = value
            if oldID != value.id {
                if let bytes = fileBytesByIdentity.removeValue(forKey: oldID) {
                    fileBytesByIdentity[value.id] = bytes
                }
                if let children = childrenByIdentity.removeValue(forKey: oldID) {
                    childrenByIdentity[value.id] = children
                }
                for key in Array(childrenByIdentity.keys) {
                    childrenByIdentity[key] = childrenByIdentity[key]?.map { $0 == oldID ? value.id : $0 }
                }
            }
            if suffix.isEmpty { movedRoot = value }
        }
        guard let movedRoot else { throw WorkspaceProviderError.notFound(node.reference) }
        for key in Array(childrenByIdentity.keys) {
            childrenByIdentity[key]?.removeAll { $0 == rootIdentity || $0 == movedRoot.id }
        }
        let parentPath = movedRoot.reference.parent?.pathHint ?? "/"
        if let parent = nodesByIdentity.values.first(where: {
            $0.reference.tree == movedRoot.reference.tree && $0.reference.pathHint == parentPath
        }) {
            childrenByIdentity[parent.id, default: []].append(movedRoot.id)
        }
        return movedRoot
    }

    private func copySubtree(
        _ node: WorkspaceNode,
        to path: String,
        parent: WorkspaceNode
    ) throws -> WorkspaceNode {
        if nodesByIdentity.values.contains(where: { $0.reference.tree == node.reference.tree && $0.reference.pathHint == path }) {
            throw WorkspaceProviderError.invalidAction("Destination already exists")
        }
        let sourcePath = node.reference.pathHint
        let affected = nodesByIdentity.values
            .filter { $0.reference.tree == node.reference.tree && ($0.reference.pathHint == sourcePath || $0.reference.pathHint.hasPrefix(sourcePath + "/")) }
            .sorted { $0.reference.pathHint.count < $1.reference.pathHint.count }
        var copiedByOldID: [WorkspaceIdentity: WorkspaceIdentity] = [:]
        var copiedRoot: WorkspaceNode?
        for value in affected {
            var copied = value
            let suffix = String(value.reference.pathHint.dropFirst(sourcePath.count))
            copied.reference.pathHint = path + suffix
            if value.reference.pageID != nil { copied.reference.pageID = PageID(rawValue: "pg_\(UUID().uuidString.lowercased())") }
            nodesByIdentity[copied.id] = copied
            if let bytes = fileBytesByIdentity[value.id] { fileBytesByIdentity[copied.id] = bytes }
            copiedByOldID[value.id] = copied.id
            if suffix.isEmpty { copiedRoot = copied }
        }
        for value in affected {
            guard let copiedID = copiedByOldID[value.id] else { continue }
            childrenByIdentity[copiedID] = childrenByIdentity[value.id, default: []].compactMap { copiedByOldID[$0] }
        }
        if let copiedRoot { childrenByIdentity[parent.id, default: []].append(copiedRoot.id) }
        guard let copiedRoot else { throw WorkspaceProviderError.notFound(node.reference) }
        return copiedRoot
    }
}

public actor InMemoryDocumentSession: WorkspaceDocumentSession {
    public nonisolated let identity: WorkspaceIdentity
    private var current: WorkspaceDocumentSnapshot
    private var revisions: [WorkspaceDocumentSnapshot]
    private var isClosed = false
    private let provider: InMemoryWorkspaceProvider?

    public init(provider: InMemoryWorkspaceProvider, snapshot: WorkspaceDocumentSnapshot) {
        self.provider = provider
        self.identity = snapshot.reference.identity
        self.current = snapshot
        self.revisions = [snapshot]
    }

    public init(snapshot: WorkspaceDocumentSnapshot) {
        self.provider = nil
        self.identity = snapshot.reference.identity
        self.current = snapshot
        self.revisions = [snapshot]
    }

    public func snapshot() async throws -> WorkspaceDocumentSnapshot { current }

    public func admit(source: String, baseContentRevision: String) async throws -> WorkspaceDocumentSnapshot {
        guard !isClosed else { throw WorkspaceProviderError.invalidAction("Document session is closed") }
        if let provider {
            current = try await provider.admit(
                reference: current.reference,
                source: source,
                baseContentRevision: baseContentRevision
            )
        } else {
            guard baseContentRevision == current.contentRevision else {
                throw WorkspaceDocumentConflict(current: current, submittedSource: source)
            }
            current.source = source
            current.contentRevision = "r\(revisions.count + 1)"
        }
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
        try await provider?.persist(current)
        return current
    }

    public func close() async { isClosed = true }
}
