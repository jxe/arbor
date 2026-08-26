import ArborClient
import ArborKit
import Foundation

public struct ArborSyncWorkspaceProvider: WorkspaceProvider, Sendable {
    public let client: ArborSyncRESTClient

    public init(client: ArborSyncRESTClient) {
        self.client = client
    }

    public func resolve(_ reference: WorkspaceReference) async throws -> WorkspaceNode {
        try await resolve(.reference(reference))
    }

    public func children(of reference: WorkspaceReference) async throws -> [WorkspaceNode] {
        try await children(of: .reference(reference))
    }

    public func resolve(_ location: WorkspaceLocation) async throws -> WorkspaceNode {
        switch location {
        case let .localPath(path):
            let snapshot = try await client.node(.path(path, tree: "local"))
            return try Self.workspaceNode(from: snapshot, fallbackTree: "local", requestedLocation: location)
        case let .reference(reference):
            let snapshot = try await client.node(reference.nodeRef)
            return try Self.workspaceNode(from: snapshot, fallbackTree: reference.tree, requestedLocation: location)
        case let .remote(locator, rootLocator):
            let resolved = try await client.resolve(locator)
            let snapshot = try await client.node(.path(resolved.ref.path, tree: resolved.ref.tree))
            return try Self.workspaceNode(
                from: snapshot,
                fallbackTree: TreeID(rawValue: snapshot.tree),
                requestedLocation: .remote(locator: locator, rootLocator: rootLocator)
            )
        }
    }

    public func children(of location: WorkspaceLocation) async throws -> [WorkspaceNode] {
        switch location {
        case let .localPath(path):
            let parent = try await resolve(location)
            let children = try await client.allChildren(.path(path, tree: "local"))
            let parentPath = parent.location.pathHint
            return try await resolveAll(children.map { child in
                .local(URL(fileURLWithPath: parentPath).appending(path: child.name).path)
            })
        case let .reference(reference):
            let children = try await client.allChildren(reference.nodeRef)
            return try await resolveAll(children.map { child in
                .reference(WorkspaceReference(
                    tree: TreeID(rawValue: childTree(child, fallback: reference.tree.rawValue)),
                    path: child.path,
                    pageID: child.pageID.map(PageID.init(rawValue:))
                ))
            })
        case let .remote(locator, rootLocator):
            let resolved = try await client.resolve(locator)
            let snapshot = try await client.node(.path(resolved.ref.path, tree: resolved.ref.tree))
            return try await resolveAll((snapshot.children ?? []).map { child in
                .remote(locator: Self.appendingRemotePath(child.name, to: locator), rootLocator: rootLocator)
            })
        }
    }

    public func search(_ query: String, in tree: TreeID) async throws -> [WorkspaceSearchResult] {
        var cursor: String?
        var result: [WorkspaceSearchResult] = []
        repeat {
            let page = try await client.search(tree: tree.rawValue, query: query, cursor: cursor)
            result.append(contentsOf: page.results.map { item in
                WorkspaceSearchResult(
                    reference: WorkspaceReference(
                        tree: TreeID(rawValue: item.tree),
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
                        tree: TreeID(rawValue: entry.ref.tree),
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
            // arborsync surface the same identity again after materialization.
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
                tree: TreeID(rawValue: value.tree),
                path: value.path,
                pageID: value.pageID.map(PageID.init(rawValue:)) ?? fallback.pageID
            )
        } ?? fallback
        return try await resolveOrFallback(resolved, fallback: fallback)
    }

    public func store(asset: WorkspaceAsset, in parent: WorkspaceReference) async throws -> WorkspaceStoredAsset {
        let result = try await client.asset(
            directory: parent.nodeRef,
            filename: asset.name,
            contentType: asset.mediaType ?? "application/octet-stream",
            data: asset.bytes
        )
        return WorkspaceStoredAsset(
            reference: WorkspaceReference(tree: parent.tree, path: result.path),
            markdownSource: result.markdownPath
        )
    }

    public func readFile(_ reference: WorkspaceReference) async throws -> Data {
        try await client.file(reference.nodeRef).bytes
    }

    public func openDocument(_ reference: WorkspaceReference) async throws -> any WorkspaceDocumentSession {
        var node = try await resolve(reference)
        guard node.surface.supportsDocumentSession else {
            throw WorkspaceProviderError.notDocument(node.reference)
        }
        guard node.isWritable else { throw WorkspaceProviderError.readOnly(node.reference) }
        // A local path outside every placed tree is deliberately addressed by
        // its filesystem path. It remains editable, but it must not acquire an
        // Arbor PageID merely because the editor opened it. Managed tree nodes
        // still establish durable identity before the session begins.
        if Self.requiresDocumentIdentity(node), let revision = node.provenance.contentRevision {
            _ = try await client.mutateContent(WorkspaceOperation(
                op: "ensureDocumentIdentity",
                ref: node.reference.nodeRef,
                baseContentRevision: revision
            ))
            node = try await resolve(node.reference)
        }
        return ArborSyncDocumentSession(client: client, reference: node.reference)
    }

    private func resolveOrFallback(
        _ reference: WorkspaceReference,
        fallback: WorkspaceReference
    ) async throws -> WorkspaceNode {
        do { return try await resolve(reference) }
        catch {
            // Structural receipts can retain an identity that is temporarily
            // outside arborsync's managed PageID index (notably Trash). The path
            // is still an exact postcondition supplied by the operation.
            return try await resolve(WorkspaceReference(tree: fallback.tree, path: fallback.pathHint))
        }
    }

    private func resolveAll(_ locations: [WorkspaceLocation]) async throws -> [WorkspaceNode] {
        try await withThrowingTaskGroup(of: (Int, WorkspaceNode).self) { group in
            for (index, location) in locations.enumerated() {
                group.addTask { (index, try await resolve(location)) }
            }
            var loaded: [(Int, WorkspaceNode)] = []
            loaded.reserveCapacity(locations.count)
            for try await item in group { loaded.append(item) }
            return loaded.sorted { $0.0 < $1.0 }.map(\.1)
        }
    }

    static func workspaceNode(
        from snapshot: NodeSnapshot,
        fallbackTree: TreeID,
        requestedLocation: WorkspaceLocation? = nil
    ) throws -> WorkspaceNode {
        let tree = TreeID(rawValue: snapshot.tree)
        let reference = WorkspaceReference(
            tree: tree,
            path: snapshot.path,
            pageID: snapshot.ref.pageID.map(PageID.init(rawValue:))
        )
        let treeRootURL = snapshot.enclosingTree?.osPath.map { URL(fileURLWithPath: $0) }
        let physicalURL = treeRootURL.map { root in
            snapshot.path == "/" ? root : root.appending(path: snapshot.path.trimmingCharacters(in: CharacterSet(charactersIn: "/")))
        } ?? (snapshot.tree == "local" ? URL(fileURLWithPath: snapshot.path) : nil)
        let location: WorkspaceLocation = switch requestedLocation {
        case .some(.localPath): physicalURL.map { .local($0.path) } ?? .local(snapshot.path)
        case let .some(.remote(locator, rootLocator)):
            .remote(
                locator: Self.canonicalRemoteLocator(snapshot: snapshot, fallback: locator),
                rootLocator: snapshot.enclosingTree?.canonical?.httpURL ?? rootLocator
            )
        default: .reference(reference)
        }
        let surface: WorkspaceSurface
        switch snapshot.kind {
        case "markdown":
            guard let document = snapshot.document, let revision = snapshot.contentRevision else {
                throw WorkspaceProviderError.invalidAction("arborsync returned an incomplete Markdown node")
            }
            surface = .markdown(source: document.source, contentRevision: revision)
        case "directory":
            guard let document = snapshot.document, let revision = snapshot.contentRevision else {
                surface = .directory(summary: snapshot.diagnostics.first?.message)
                break
            }
            // Implicit directory Markdown is a real editable projection. In a
            // managed tree the session establishes PageID identity first; in
            // ordinary filesystem space it remains path-addressed, and the
            // first authored edit materializes `_index.md` without an ID.
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
                surface = .diagnostic(title: "Unsupported node", detail: "arborsync returned kind \(snapshot.kind)")
            }
        }
        return WorkspaceNode(
            reference: reference,
            location: location,
            title: Self.displayTitle(
                source: snapshot.document?.source,
                fallback: snapshot.name.isEmpty ? Self.name(of: snapshot.path) : snapshot.name
            ),
            surface: surface,
            provenance: WorkspaceProvenance(
                authority: snapshot.writable ? .local : .historical,
                sourceDescription: snapshot.enclosingTree?.canonical?.locator ?? snapshot.enclosingTree?.name ?? "Local arborsync",
                physicalURL: physicalURL,
                treeRootURL: treeRootURL,
                contentRevision: snapshot.contentRevision
            ),
            materialization: Self.materialization(snapshot.materialization),
            isWritable: snapshot.writable
        )
    }

    static func displayTitle(source: String?, fallback: String) -> String {
        if let source {
            for line in source.split(whereSeparator: \.isNewline) where line.hasPrefix("# ") {
                let title = line.dropFirst(2).trimmingCharacters(in: .whitespaces)
                if !title.isEmpty { return title }
            }
        }
        return fallback
    }

    static func requiresDocumentIdentity(_ node: WorkspaceNode) -> Bool {
        node.reference.tree.rawValue != "local" && node.reference.pageID == nil
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

    private static func appendingRemotePath(_ name: String, to locator: String) -> String {
        guard let url = URL(string: locator) else { return locator }
        return url.appending(path: name).absoluteString
    }

    private static func canonicalRemoteLocator(snapshot: NodeSnapshot, fallback: String) -> String {
        guard let root = snapshot.enclosingTree?.canonical?.httpURL,
              let rootURL = URL(string: root) else { return fallback }
        guard snapshot.path != "/" else { return rootURL.absoluteString }
        return snapshot.path.split(separator: "/").reduce(rootURL) { partial, component in
            partial.appending(path: String(component))
        }.absoluteString
    }

    private func childTree(_ child: TreeChild, fallback: String) -> String {
        // Child payloads predate an explicit tree field. The enclosing request
        // remains authoritative until the protocol adds it to TreeChild.
        fallback
    }
}

public actor ArborSyncDocumentSession: WorkspaceDocumentSession {
    public nonisolated let identity: WorkspaceIdentity
    private let client: ArborSyncRESTClient
    private let initialReference: WorkspaceReference
    private var terminal = false

    public init(client: ArborSyncRESTClient, reference: WorkspaceReference) {
        self.client = client
        self.initialReference = reference
        self.identity = reference.identity
    }

    public func snapshot() async throws -> WorkspaceDocumentSnapshot {
        try requireOpen()
        return try Self.documentSnapshot(await client.node(initialReference.nodeRef), fallback: initialReference)
    }

    public func updates() async throws -> AsyncThrowingStream<WorkspaceDocumentSnapshot, Error> {
        try requireOpen()
        let client = self.client
        let reference = initialReference
        let view = try await client.openNodeView(reference.nodeRef)
        let initial = try Self.documentSnapshot(view.snapshot, fallback: reference)
        return AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    continuation.yield(initial)
                    var revision = view.snapshot.contentRevision
                    for try await update in view.updates {
                        let snapshot: NodeSnapshot
                        switch update {
                        case let .resync(value):
                            snapshot = value
                        case let .event(event):
                            guard Self.targets(event, reference: reference) else { continue }
                            snapshot = try await client.node(reference.nodeRef)
                        }
                        guard snapshot.contentRevision != revision else { continue }
                        revision = snapshot.contentRevision
                        continuation.yield(try Self.documentSnapshot(snapshot, fallback: reference))
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
        guard !patch.edits.isEmpty else { return current }
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
        } catch let error as ArborSyncServerError where error.value.code == "conflict" && error.value.details?.workspaceRevision == true {
            let current = try await snapshot()
            throw WorkspaceDocumentConflict(current: current, submittedSource: source)
        }
    }

    public func flush() async throws {
        try requireOpen()
        // ArborSync acknowledges a mutation only after its journal and authored
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

    private nonisolated static func targets(
        _ event: WorkspaceEvent,
        reference: WorkspaceReference
    ) -> Bool {
        if event.tree != reference.tree.rawValue { return false }
        if let pageID = reference.pageID?.rawValue, let eventPageID = event.change.pageID {
            return pageID == eventPageID
        }
        return event.change.path == reference.pathHint || event.change.previousPath == reference.pathHint
    }

    private func requireOpen() throws {
        if terminal { throw WorkspaceProviderError.invalidAction("The arborsync document session is closed") }
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
                tree: TreeID(rawValue: node.tree),
                path: node.path,
                pageID: node.ref.pageID.map(PageID.init(rawValue:))
            ),
            source: source,
            contentRevision: revision
        )
    }
}

private extension JSONValue {
    var workspaceRevision: Bool {
        guard case let .object(fields) = self, fields["kind"] == .string("workspace-revision") else { return false }
        return true
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
