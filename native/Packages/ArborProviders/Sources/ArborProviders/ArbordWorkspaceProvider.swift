import ArborClient
import ArborKit
import Foundation

public struct ArbordWorkspaceProvider: WorkspaceProvider, Sendable {
    public let client: ArborClient

    public init(client: ArborClient) {
        self.client = client
    }

    public func resolve(_ reference: WorkspaceReference) async throws -> WorkspaceNode {
        try Self.workspaceNode(from: await client.node(reference.nodeRef), fallbackTree: reference.tree)
    }

    public func children(of reference: WorkspaceReference) async throws -> [WorkspaceNode] {
        let children = try await client.allChildren(reference.nodeRef)
        var result: [WorkspaceNode] = []
        result.reserveCapacity(children.count)
        for child in children {
            let childReference = WorkspaceReference(
                tree: TreeID(rawValue: childTree(child, fallback: reference.tree.rawValue)),
                path: child.path,
                pageID: child.pageID.map(PageID.init(rawValue:))
            )
            result.append(try await resolve(childReference))
        }
        return result
    }

    public func search(_ query: String, in tree: TreeID) async throws -> [WorkspaceSearchResult] {
        var cursor: String?
        var result: [WorkspaceSearchResult] = []
        repeat {
            let page = try await client.search(query, tree: tree.rawValue, cursor: cursor)
            result.append(contentsOf: page.results.map { item in
                WorkspaceSearchResult(
                    reference: WorkspaceReference(
                        tree: TreeID(rawValue: item.tree ?? tree.rawValue),
                        path: item.path,
                        pageID: item.pageID.map(PageID.init(rawValue:))
                    ),
                    title: item.title,
                    excerpt: item.excerpt.isEmpty ? nil : item.excerpt
                )
            })
            cursor = page.nextCursor
        } while cursor != nil
        return result
    }

    public func backlinks(to reference: WorkspaceReference) async throws -> [WorkspaceSearchResult] {
        var cursor: String?
        var result: [WorkspaceSearchResult] = []
        repeat {
            let page = try await client.backlinks(reference.nodeRef, cursor: cursor)
            result.append(contentsOf: page.entries.map { entry in
                WorkspaceSearchResult(
                    reference: WorkspaceReference(
                        tree: TreeID(rawValue: entry.ref.tree ?? reference.tree.rawValue),
                        path: entry.ref.path,
                        pageID: entry.ref.pageID.map(PageID.init(rawValue:))
                    ),
                    title: entry.title,
                    excerpt: entry.context.isEmpty ? nil : entry.context
                )
            })
            cursor = page.nextCursor
        } while cursor != nil
        return result
    }

    public func perform(_ action: WorkspaceStructuralAction) async throws -> WorkspaceNode? {
        let request: WorkspaceOperation
        let fallback: WorkspaceReference
        switch action {
        case let .createMarkdown(parent, name, source):
            let path = Self.childPath(parent.pathHint, name: name)
            request = WorkspaceOperation(op: "createMarkdown", tree: parent.tree.rawValue, path: path, source: source)
            fallback = WorkspaceReference(tree: parent.tree, path: path)
        case let .createDirectory(parent, name):
            let path = Self.childPath(parent.pathHint, name: name)
            request = WorkspaceOperation(op: "createDirectory", tree: parent.tree.rawValue, path: path)
            fallback = WorkspaceReference(tree: parent.tree, path: path)
        case let .rename(reference, name):
            request = WorkspaceOperation(op: "rename", ref: reference.nodeRef, name: name)
            fallback = WorkspaceReference(
                tree: reference.tree,
                path: Self.childPath(reference.parent?.pathHint ?? "/", name: name),
                pageID: reference.pageID
            )
        case let .move(reference, destination):
            request = WorkspaceOperation(op: "move", refs: [reference.nodeRef], destination: destination.nodeRef)
            fallback = WorkspaceReference(
                tree: destination.tree,
                path: Self.childPath(destination.pathHint, name: Self.name(of: reference.pathHint)),
                pageID: reference.pageID
            )
        case let .copy(reference, destination):
            request = WorkspaceOperation(op: "copy", refs: [reference.nodeRef], destination: destination.nodeRef)
            fallback = WorkspaceReference(
                tree: destination.tree,
                path: Self.childPath(destination.pathHint, name: Self.name(of: reference.pathHint))
            )
        case let .trash(reference):
            request = WorkspaceOperation(op: "trash", refs: [reference.nodeRef])
            fallback = WorkspaceReference(tree: reference.tree, path: "/Trash" + reference.pathHint, pageID: reference.pageID)
        case let .restore(reference):
            // Trash is deliberately outside the managed PageID owner index. A
            // restore therefore addresses the visible Trash path, then lets
            // arbord surface the same identity again after materialization.
            request = WorkspaceOperation(
                op: "restore",
                refs: [NodeRef(tree: reference.tree.rawValue, path: reference.pathHint)]
            )
            let restored = reference.pathHint.hasPrefix("/Trash/")
                ? String(reference.pathHint.dropFirst("/Trash".count))
                : reference.pathHint
            fallback = WorkspaceReference(tree: reference.tree, path: restored, pageID: reference.pageID)
        }

        let receipt = try await client.mutateStructural([request])
        let effect = receipt.effects.last(where: { $0.kind != "deleted" }) ?? receipt.effects.last
        let resolved = effect.map { value in
            WorkspaceReference(
                tree: TreeID(rawValue: value.tree ?? fallback.tree.rawValue),
                path: value.path,
                pageID: value.pageID.map(PageID.init(rawValue:)) ?? fallback.pageID
            )
        } ?? fallback
        return try await resolveOrFallback(resolved, fallback: fallback)
    }

    public func store(asset: WorkspaceAsset, in parent: WorkspaceReference) async throws -> WorkspaceReference {
        let result = try await client.asset(
            directory: parent.nodeRef,
            filename: asset.name,
            contentType: asset.mediaType ?? "application/octet-stream",
            data: asset.bytes
        )
        return WorkspaceReference(tree: parent.tree, path: result.path)
    }

    public func openDocument(_ reference: WorkspaceReference) async throws -> any WorkspaceDocumentSession {
        var node = try await resolve(reference)
        guard node.surface.supportsDocumentSession else {
            throw WorkspaceProviderError.notDocument(node.reference)
        }
        guard node.isWritable else { throw WorkspaceProviderError.readOnly(node.reference) }
        if node.reference.pageID == nil, let revision = node.provenance.contentRevision {
            _ = try await client.mutateContent(WorkspaceOperation(
                op: "ensureDocumentIdentity",
                ref: node.reference.nodeRef,
                baseContentRevision: revision
            ))
            node = try await resolve(node.reference)
        }
        return ArbordDocumentSession(client: client, reference: node.reference)
    }

    private func resolveOrFallback(
        _ reference: WorkspaceReference,
        fallback: WorkspaceReference
    ) async throws -> WorkspaceNode {
        do { return try await resolve(reference) }
        catch {
            // Structural receipts can retain an identity that is temporarily
            // outside arbord's managed PageID index (notably Trash). The path
            // is still an exact postcondition supplied by the operation.
            return try await resolve(WorkspaceReference(tree: fallback.tree, path: fallback.pathHint))
        }
    }

    private static func workspaceNode(from snapshot: NodeSnapshot, fallbackTree: TreeID) throws -> WorkspaceNode {
        let tree = TreeID(rawValue: snapshot.tree ?? snapshot.ref.tree ?? fallbackTree.rawValue)
        let reference = WorkspaceReference(
            tree: tree,
            path: snapshot.path,
            pageID: snapshot.ref.pageID.map(PageID.init(rawValue:))
        )
        let surface: WorkspaceSurface
        switch snapshot.kind {
        case "markdown":
            guard let document = snapshot.document, let revision = snapshot.contentRevision else {
                throw WorkspaceProviderError.invalidAction("arbord returned an incomplete Markdown node")
            }
            surface = .markdown(source: document.source, contentRevision: revision)
        case "directory":
            guard let document = snapshot.document, let revision = snapshot.contentRevision else {
                surface = .directory(summary: snapshot.diagnostics.first?.message)
                break
            }
            surface = .directoryDocument(
                source: document.source,
                contentRevision: revision,
                stored: snapshot.bodyState == "stored"
            )
        case "collection", "database":
            surface = .collection(
                kind: snapshot.collection?.backing ?? snapshot.kind,
                rowCount: snapshot.collection?.total
            )
        case "file":
            surface = .file(name: snapshot.name, byteCount: nil, mediaType: nil)
        default:
            if snapshot.materialization == "placeholder" {
                surface = .placeholder(message: "This node is not materialized on this Mac.")
            } else if let diagnostic = snapshot.diagnostics.first {
                surface = .diagnostic(title: diagnostic.code, detail: diagnostic.message)
            } else {
                surface = .diagnostic(title: "Unsupported node", detail: "arbord returned kind \(snapshot.kind)")
            }
        }
        return WorkspaceNode(
            reference: reference,
            title: snapshot.name.isEmpty ? Self.name(of: snapshot.path) : snapshot.name,
            surface: surface,
            provenance: WorkspaceProvenance(
                authority: snapshot.writable ? .local : .historical,
                sourceDescription: snapshot.enclosingTree?.canonical ?? snapshot.enclosingTree?.name ?? "Local arbord",
                physicalURL: snapshot.enclosingTree?.osPath.map { URL(fileURLWithPath: $0) },
                contentRevision: snapshot.contentRevision
            ),
            materialization: Self.materialization(snapshot.materialization),
            isWritable: snapshot.writable
        )
    }

    private static func materialization(_ value: String) -> WorkspaceMaterialization {
        switch value {
        case "available": .available
        case "downloading": .downloading
        case "placeholder": .placeholder
        default: .unavailable
        }
    }

    private static func childPath(_ parent: String, name: String) -> String {
        parent == "/" ? "/\(name)" : "\(parent)/\(name)"
    }

    private static func name(of path: String) -> String {
        path.split(separator: "/").last.map(String.init) ?? "Home"
    }

    private func childTree(_ child: TreeChild, fallback: String) -> String {
        // Child payloads predate an explicit tree field. The enclosing request
        // remains authoritative until the protocol adds it to TreeChild.
        fallback
    }
}

public actor ArbordDocumentSession: WorkspaceDocumentSession {
    public nonisolated let identity: WorkspaceIdentity
    private let client: ArborClient
    private let initialReference: WorkspaceReference
    private var terminal = false

    public init(client: ArborClient, reference: WorkspaceReference) {
        self.client = client
        self.initialReference = reference
        self.identity = reference.identity
    }

    public func snapshot() async throws -> WorkspaceDocumentSnapshot {
        try requireOpen()
        return try Self.documentSnapshot(await client.node(initialReference.nodeRef), fallback: initialReference)
    }

    public func admit(source: String, baseContentRevision: String) async throws -> WorkspaceDocumentSnapshot {
        try await admit(source: source, baseContentRevision: baseContentRevision, sourceEdits: nil)
    }

    public func admit(patch: WorkspaceDocumentPatch) async throws -> WorkspaceDocumentSnapshot {
        let current = try await snapshot()
        guard current.contentRevision == patch.baseContentRevision else {
            throw WorkspacePatchError.staleRevision(
                expected: patch.baseContentRevision,
                actual: current.contentRevision
            )
        }
        let source = try patch.applying(to: current.source)
        let edits = patch.edits.map { edit in
            ProtocolSourceEdit(
                offset: edit.utf8Range.lowerBound,
                length: edit.utf8Range.count,
                replacement: edit.replacement,
                expected: edit.expected
            )
        }
        return try await admit(
            source: source,
            baseContentRevision: patch.baseContentRevision,
            sourceEdits: edits
        )
    }

    private func admit(
        source: String,
        baseContentRevision: String,
        sourceEdits: [ProtocolSourceEdit]?
    ) async throws -> WorkspaceDocumentSnapshot {
        try requireOpen()
        do {
            _ = try await client.mutateContent(WorkspaceOperation(
                op: "writeMarkdown",
                ref: initialReference.nodeRef,
                baseContentRevision: baseContentRevision,
                source: source,
                sourceEdits: sourceEdits
            ))
            return try await snapshot()
        } catch let error as ArbordServerError where error.value.code == "stale-content-revision" {
            let current: WorkspaceDocumentSnapshot
            if let serverSnapshot = error.value.current {
                current = try Self.documentSnapshot(serverSnapshot, fallback: initialReference)
            } else {
                current = try await snapshot()
            }
            throw WorkspaceDocumentConflict(current: current, submittedSource: source)
        }
    }

    public func flush() async throws {
        try requireOpen()
        // Arbord acknowledges a mutation only after its journal and authored
        // file transaction are durable, so there is no buffered provider tail.
    }

    public func history() async throws -> [WorkspaceHistoryEntry] {
        try requireOpen()
        var cursor: String?
        var result: [WorkspaceHistoryEntry] = []
        repeat {
            let page = try await client.recovery(initialReference.nodeRef, cursor: cursor)
            result.append(contentsOf: page.entries.compactMap { entry in
                guard entry.kind == "block", let hash = entry.hash else { return nil }
                let seconds = entry.changedAt > 10_000_000_000 ? entry.changedAt / 1_000 : entry.changedAt
                return WorkspaceHistoryEntry(
                    id: hash,
                    revision: hash,
                    title: entry.status == "purged" ? "Recover removed content" : "Recover prior content",
                    timestamp: Date(timeIntervalSince1970: seconds)
                )
            })
            cursor = page.nextCursor
        } while cursor != nil
        return result.sorted { $0.timestamp > $1.timestamp }
    }

    public func recover(revision: String) async throws -> WorkspaceDocumentSnapshot {
        try requireOpen()
        let current = try await snapshot()
        _ = try await client.mutateContent(WorkspaceOperation(
            op: "restoreRecovery",
            ref: initialReference.nodeRef,
            baseContentRevision: current.contentRevision,
            hash: revision
        ))
        return try await snapshot()
    }

    public func close() async { terminal = true }

    private func requireOpen() throws {
        if terminal { throw WorkspaceProviderError.invalidAction("The arbord document session is closed") }
    }

    private static func documentSnapshot(
        _ node: NodeSnapshot,
        fallback: WorkspaceReference
    ) throws -> WorkspaceDocumentSnapshot {
        guard let source = node.document?.source, let revision = node.contentRevision else {
            throw WorkspaceProviderError.notDocument(fallback)
        }
        return WorkspaceDocumentSnapshot(
            reference: WorkspaceReference(
                tree: TreeID(rawValue: node.tree ?? node.ref.tree ?? fallback.tree.rawValue),
                path: node.path,
                pageID: node.ref.pageID.map(PageID.init(rawValue:))
            ),
            source: source,
            contentRevision: revision
        )
    }
}

private extension WorkspaceReference {
    var nodeRef: NodeRef {
        if let pageID {
            return .pageID(pageID.rawValue, pathHint: pathHint, tree: tree.rawValue)
        }
        return .path(pathHint, tree: tree.rawValue)
    }
}
