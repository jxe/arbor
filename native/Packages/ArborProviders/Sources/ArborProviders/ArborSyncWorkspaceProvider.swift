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
                fallbackTree: TreeID(rawValue: snapshot.ref.tree),
                requestedLocation: .remote(locator: locator, rootLocator: rootLocator)
            )
        }
    }

    public func children(of location: WorkspaceLocation) async throws -> [WorkspaceNode] {
        switch location {
        case let .localPath(path):
            let children = try await client.allChildren(.path(path, tree: "local"))
            return children.map { child in
                Self.workspaceNode(
                    from: child,
                    fallbackTree: "local",
                    requestedLocation: .local(URL(fileURLWithPath: path).appending(path: child.name).path)
                )
            }
        case let .reference(reference):
            let children = try await client.allChildren(reference.nodeRef)
            return children.map { Self.workspaceNode(from: $0, fallbackTree: reference.tree) }
        case let .remote(locator, rootLocator):
            let resolved = try await client.resolve(locator)
            let snapshot = try await client.node(.path(resolved.ref.path, tree: resolved.ref.tree))
            let children = try await client.allChildren(snapshot.ref)
            return children.map { child in
                Self.workspaceNode(
                    from: child,
                    fallbackTree: TreeID(rawValue: child.ref.tree),
                    requestedLocation: .remote(
                        locator: Self.appendingRemotePath(child.name, to: locator),
                        rootLocator: rootLocator
                    )
                )
            }
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
                        tree: TreeID(rawValue: item.ref.tree),
                        path: item.ref.path,
                        stableKey: item.ref.stableKey
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
                        stableKey: entry.ref.stableKey
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
            let path = Self.childPath(parent.path, name: name)
            request = WorkspaceOperation(op: "createMarkdown", tree: parent.tree.rawValue, path: path, source: source)
            fallback = WorkspaceReference(tree: parent.tree, path: path)
        case let .createDirectory(parent, name):
            let path = Self.childPath(parent.path, name: name)
            request = WorkspaceOperation(op: "createDirectory", tree: parent.tree.rawValue, path: path)
            fallback = WorkspaceReference(tree: parent.tree, path: path)
        case let .rename(reference, name):
            request = WorkspaceOperation(op: "rename", ref: reference.nodeRef, name: name)
            fallback = WorkspaceReference(
                tree: reference.tree,
                path: Self.childPath(reference.parent?.path ?? "/", name: name),
                stableKey: reference.stableKey
            )
        case let .move(reference, destination):
            request = WorkspaceOperation(op: "move", refs: [reference.nodeRef], destination: destination.nodeRef)
            fallback = WorkspaceReference(
                tree: destination.tree,
                path: Self.childPath(destination.path, name: Self.name(of: reference.path)),
                stableKey: reference.stableKey
            )
        case let .copy(reference, destination):
            request = WorkspaceOperation(op: "copy", refs: [reference.nodeRef], destination: destination.nodeRef)
            fallback = WorkspaceReference(
                tree: destination.tree,
                path: Self.childPath(destination.path, name: Self.name(of: reference.path))
            )
        case let .trash(reference):
            request = WorkspaceOperation(op: "trash", refs: [reference.nodeRef])
            fallback = WorkspaceReference(tree: reference.tree, path: "/Trash" + reference.path, stableKey: reference.stableKey)
        case let .restore(reference):
            // Trash is deliberately outside the managed PageID owner index. A
            // restore therefore addresses the visible Trash path, then lets
            // arborsync surface the same identity again after materialization.
            request = WorkspaceOperation(
                op: "restore",
                refs: [NodeRef(tree: reference.tree.rawValue, path: reference.path)]
            )
            let restored = reference.path.hasPrefix("/Trash/")
                ? String(reference.path.dropFirst("/Trash".count))
                : reference.path
            fallback = WorkspaceReference(tree: reference.tree, path: restored, stableKey: reference.stableKey)
        }

        let receipt = try await client.mutateStructural([request])
        let effect = receipt.effects.last(where: { $0.kind != "deleted" }) ?? receipt.effects.last
        let resolved = effect.map { value in
            WorkspaceReference(
                tree: TreeID(rawValue: value.ref.tree),
                path: value.ref.path,
                stableKey: value.ref.stableKey ?? fallback.stableKey
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
            return try await resolve(WorkspaceReference(tree: fallback.tree, path: fallback.path))
        }
    }

    static func workspaceNode(
        from snapshot: NodeSnapshot,
        fallbackTree: TreeID,
        requestedLocation: WorkspaceLocation? = nil
    ) throws -> WorkspaceNode {
        let tree = TreeID(rawValue: snapshot.ref.tree)
        let reference = WorkspaceReference(
            tree: tree,
            path: snapshot.ref.path,
            stableKey: snapshot.ref.stableKey
        )
        let treeRootURL = snapshot.enclosingTree?.osPath.map { URL(fileURLWithPath: $0) }
        let physicalURL = treeRootURL.map { root in
            snapshot.ref.path == "/" ? root : root.appending(path: snapshot.ref.path.trimmingCharacters(in: CharacterSet(charactersIn: "/")))
        } ?? (snapshot.ref.tree == "local" ? URL(fileURLWithPath: snapshot.ref.path) : nil)
        let location: WorkspaceLocation = switch requestedLocation {
        case .some(.localPath): physicalURL.map { .local($0.path) } ?? .local(snapshot.ref.path)
        case let .some(.remote(locator, rootLocator)):
            .remote(
                locator: Self.canonicalRemoteLocator(snapshot: snapshot, fallback: locator),
                rootLocator: snapshot.enclosingTree?.canonical?.httpURL ?? rootLocator
            )
        default: .reference(reference)
        }
        let content = snapshot.content
        let contentCapability = snapshot.capabilities.content
        let childrenCapability = snapshot.capabilities.children
        let writable = contentCapability?.writable == true
            || childrenCapability?.writable == true
            || snapshot.capabilities.properties?.writable == true
        let surface: WorkspaceSurface
        if snapshot.materialization == "placeholder" {
            surface = .placeholder(message: "This node is not materialized on this Mac.")
        } else if contentCapability?.format == "markdown", let content, let revision = contentCapability?.revision {
            if childrenCapability != nil {
                surface = .directoryDocument(
                    source: content.source,
                    contentRevision: revision,
                    stored: content.representation?.state == "stored"
                )
            } else {
                surface = .markdown(source: content.source, contentRevision: revision)
            }
        } else if let childrenCapability {
            if childrenCapability.schema != nil || childrenCapability.backing?.type != "expanded-files" {
                surface = .collection(
                    kind: childrenCapability.backing?.format
                        ?? childrenCapability.backing?.driver
                        ?? "structured",
                    rowCount: childrenCapability.total
                )
            } else {
                surface = .directory(summary: snapshot.diagnostics.first?.message)
            }
        } else if contentCapability != nil {
            surface = .file(name: snapshot.name, byteCount: nil, mediaType: contentCapability?.mediaType)
        } else if let diagnostic = snapshot.diagnostics.first {
            surface = .diagnostic(title: diagnostic.code, detail: diagnostic.message)
        } else {
            surface = .diagnostic(title: "Unsupported node", detail: "arborsync returned no presentable capability")
        }
        return WorkspaceNode(
            reference: reference,
            location: location,
            title: Self.displayTitle(
                source: snapshot.content?.source,
                fallback: snapshot.name.isEmpty ? Self.name(of: snapshot.ref.path) : snapshot.name
            ),
            surface: surface,
            provenance: WorkspaceProvenance(
                authority: writable ? .local : .historical,
                sourceDescription: snapshot.enclosingTree?.canonical?.arborURL ?? snapshot.enclosingTree?.name ?? "Local arborsync",
                physicalURL: physicalURL,
                treeRootURL: treeRootURL,
                contentRevision: snapshot.capabilities.content?.revision
            ),
            materialization: Self.materialization(snapshot.materialization),
            isWritable: writable
        )
    }

    /// Child pages deliberately contain summaries rather than hydrated content.
    /// They are sufficient for navigation chrome; selecting a child resolves its
    /// full snapshot before the document or directory surface is presented.
    static func workspaceNode(
        from summary: NodeSummary,
        fallbackTree: TreeID,
        requestedLocation: WorkspaceLocation? = nil
    ) -> WorkspaceNode {
        let tree = TreeID(rawValue: summary.ref.tree.isEmpty ? fallbackTree.rawValue : summary.ref.tree)
        let reference = WorkspaceReference(
            tree: tree,
            path: summary.ref.path,
            stableKey: summary.ref.stableKey
        )
        let location = requestedLocation ?? .reference(reference)
        let contentCapability = summary.capabilities.content
        let childrenCapability = summary.capabilities.children
        let writable = contentCapability?.writable == true
            || childrenCapability?.writable == true
            || summary.capabilities.properties?.writable == true
        let surface: WorkspaceSurface
        if summary.materialization == "placeholder" {
            surface = .placeholder(message: "This node is not materialized on this Mac.")
        } else if contentCapability?.format == "markdown", let revision = contentCapability?.revision {
            surface = childrenCapability == nil
                ? .markdown(source: "", contentRevision: revision)
                : .directoryDocument(source: "", contentRevision: revision, stored: false)
        } else if let childrenCapability {
            if childrenCapability.schema != nil || childrenCapability.backing?.type != "expanded-files" {
                surface = .collection(
                    kind: childrenCapability.backing?.format
                        ?? childrenCapability.backing?.driver
                        ?? "structured",
                    rowCount: childrenCapability.total
                )
            } else {
                surface = .directory(summary: summary.diagnostics.first?.message)
            }
        } else if contentCapability != nil {
            surface = .file(name: summary.name, byteCount: nil, mediaType: contentCapability?.mediaType)
        } else if let diagnostic = summary.diagnostics.first {
            surface = .diagnostic(title: diagnostic.code, detail: diagnostic.message)
        } else {
            surface = .diagnostic(title: "Unsupported node", detail: "arborsync returned no presentable capability")
        }
        let title: String
        if case let .string(propertyTitle)? = summary.properties["title"], !propertyTitle.isEmpty {
            title = propertyTitle
        } else {
            title = summary.name.isEmpty ? Self.name(of: summary.ref.path) : summary.name
        }
        let physicalURL: URL? = if case let .localPath(path) = location { URL(fileURLWithPath: path) } else { nil }
        return WorkspaceNode(
            reference: reference,
            location: location,
            title: title,
            surface: surface,
            provenance: WorkspaceProvenance(
                authority: writable ? .local : .historical,
                sourceDescription: "Local arborsync",
                physicalURL: physicalURL,
                contentRevision: contentCapability?.revision
            ),
            materialization: Self.materialization(summary.materialization),
            isWritable: writable
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
        node.reference.tree.rawValue != "local" && node.reference.stableKey == nil
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
        guard snapshot.ref.path != "/" else { return rootURL.absoluteString }
        return snapshot.ref.path.split(separator: "/").reduce(rootURL) { partial, component in
            partial.appending(path: String(component))
        }.absoluteString
    }

}

public actor ArborSyncDocumentSession: WorkspaceDocumentSession {
    public nonisolated let identity: WorkspaceIdentity
    private let client: ArborSyncRESTClient
    private let initialReference: WorkspaceReference
    private var terminal = false
    private var admissionSnapshots: [String: WorkspaceDocumentSnapshot] = [:]
    private var admissionWatchGate = AdmissionWatchGate()

    public init(client: ArborSyncRESTClient, reference: WorkspaceReference) {
        self.client = client
        self.initialReference = reference
        self.identity = reference.identity
    }

    public func snapshot() async throws -> WorkspaceDocumentSnapshot {
        try requireOpen()
        let snapshot = try Self.documentSnapshot(await client.editorNode(initialReference.nodeRef), fallback: initialReference)
        rememberAuthoritative(snapshot)
        switch admissionWatchGate.observe(snapshot.contentRevision) {
        case .publish:
            return snapshot
        case let .retain(revision):
            // The filesystem can still expose an earlier accepted prefix after
            // this session has admitted a later one. Preserve read-your-writes
            // for the editor consuming an already-emitted watch notification.
            return admissionSnapshots[revision] ?? snapshot
        }
    }

    public func updates() async throws -> AsyncThrowingStream<WorkspaceDocumentSnapshot, Error> {
        try requireOpen()
        let client = self.client
        let reference = initialReference
        let view = try await client.openNodeView(reference.nodeRef, admissionBasis: true)
        let initial = try Self.documentSnapshot(view.snapshot, fallback: reference)
        return AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    self.rememberAuthoritative(initial)
                    continuation.yield(initial)
                    var revision = view.snapshot.capabilities.content?.revision
                    for try await update in view.updates {
                        let snapshot: NodeSnapshot
                        switch update {
                        case let .resync(value):
                            snapshot = value
                        case let .event(event):
                            guard Self.targets(event, reference: reference) else { continue }
                            snapshot = try await client.editorNode(reference.nodeRef)
                        }
                        guard snapshot.capabilities.content?.revision != revision else { continue }
                        revision = snapshot.capabilities.content?.revision
                        let document = try Self.documentSnapshot(snapshot, fallback: reference)
                        self.rememberAuthoritative(document)
                        if case .publish = self.admissionWatchGate.observe(document.contentRevision) {
                            continuation.yield(document)
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
    }

    public func admit(source: String, baseContentRevision: String) async throws -> WorkspaceDocumentSnapshot {
        try await admit(source: source, baseContentRevision: baseContentRevision, sourceEdits: nil)
    }

    public func admit(patch: WorkspaceDocumentPatch) async throws -> WorkspaceDocumentSnapshot {
        if let base = admissionSnapshots[patch.baseContentRevision], let admissionBasis = base.admissionBasis {
            guard !patch.edits.isEmpty else { return base }
            let edits = patch.edits.map { edit in
                ProtocolSourceEdit(
                    offset: edit.utf8Range.lowerBound,
                    length: edit.utf8Range.count,
                    replacement: edit.replacement,
                    expected: edit.expected
                )
            }
            return try await admitThroughCanopy(
                source: patch.applying(to: base.source),
                baseContentRevision: patch.baseContentRevision,
                admissionBasis: admissionBasis,
                sourceEdits: edits
            )
        }
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
        if let base = admissionSnapshots[baseContentRevision], let admissionBasis = base.admissionBasis {
            return try await admitThroughCanopy(
                source: source,
                baseContentRevision: baseContentRevision,
                admissionBasis: admissionBasis,
                sourceEdits: sourceEdits
            )
        }
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

    private func admitThroughCanopy(
        source: String,
        baseContentRevision: String,
        admissionBasis: String,
        sourceEdits: [ProtocolSourceEdit]?
    ) async throws -> WorkspaceDocumentSnapshot {
        do {
            let value = try await client.admitDocumentCandidate(
                ref: initialReference.nodeRef,
                admissionBasis: admissionBasis,
                baseContentRevision: baseContentRevision,
                source: source,
                sourceEdits: sourceEdits
            )
            let snapshot = try Self.documentSnapshot(value, fallback: initialReference)
            rememberAdmission(snapshot, after: baseContentRevision)
            return snapshot
        } catch let error as ArborSyncServerError where error.value.code == "conflict" {
            let current = try await snapshot()
            throw WorkspaceDocumentConflict(current: current, submittedSource: source)
        }
    }

    private func rememberAuthoritative(_ snapshot: WorkspaceDocumentSnapshot) {
        admissionSnapshots[snapshot.contentRevision] = Self.retainingAdmissionChain(
            admissionSnapshots[snapshot.contentRevision],
            whenObserving: snapshot
        )
        trimAdmissionSnapshots(keeping: snapshot.contentRevision)
    }

    private func rememberAdmission(_ snapshot: WorkspaceDocumentSnapshot, after predecessor: String) {
        // A successful admission is the only response that advances the
        // client's still-open cumulative update string. It therefore replaces
        // an authoritative basis cached for the same source revision.
        admissionSnapshots[snapshot.contentRevision] = snapshot
        admissionWatchGate.admitted(snapshot.contentRevision, after: predecessor)
        trimAdmissionSnapshots(keeping: snapshot.contentRevision)
    }

    static func retainingAdmissionChain(
        _ existing: WorkspaceDocumentSnapshot?,
        whenObserving snapshot: WorkspaceDocumentSnapshot
    ) -> WorkspaceDocumentSnapshot {
        guard let existing,
              existing.source == snapshot.source,
              existing.admissionBasis != nil else { return snapshot }
        // Materialization commonly echoes the revision just admitted with a
        // freshly minted basis. Retain the admission response instead: later
        // edits must extend its cumulative string, even if that echo arrives
        // between two local commits.
        return existing
    }

    private func trimAdmissionSnapshots(keeping revision: String) {
        if admissionSnapshots.count > 32 {
            let retained = Set(admissionWatchGate.pending).union([revision])
            admissionSnapshots = admissionSnapshots.filter { retained.contains($0.key) }
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

    nonisolated static func targets(
        _ event: WorkspaceEvent,
        reference: WorkspaceReference
    ) -> Bool {
        if event.tree != reference.tree.rawValue { return false }
        // Arbor Sync emits a root-scoped invalidation after it materializes an
        // accepted, cursor-ordered Wire transition. It is deliberately broad:
        // every open document in the tree must refetch rather than depend on a
        // filesystem watcher correctly attributing identical bytes.
        if event.change.origin == "sync", event.change.ref.path == "/" { return true }
        if let stableKey = reference.stableKey, let eventStableKey = event.change.ref.stableKey {
            return stableKey == eventStableKey
        }
        return event.change.ref.path == reference.path || event.change.previousPath == reference.path
    }

    private func requireOpen() throws {
        if terminal { throw WorkspaceProviderError.invalidAction("The arborsync document session is closed") }
    }

    private static func documentSnapshot(
        _ node: NodeSnapshot,
        fallback: WorkspaceReference
    ) throws -> WorkspaceDocumentSnapshot {
        guard let source = node.content?.source, let revision = node.capabilities.content?.revision else {
            throw WorkspaceProviderError.notDocument(fallback)
        }
        return WorkspaceDocumentSnapshot(
            reference: WorkspaceReference(
                tree: TreeID(rawValue: node.ref.tree),
                path: node.ref.path,
                stableKey: node.ref.stableKey
            ),
            source: source,
            contentRevision: revision,
            admissionBasis: node.admissionBasis
        )
    }
}

struct AdmissionWatchGate {
    enum Observation: Equatable {
        case publish
        case retain(String)
    }

    private(set) var pending: [String] = []

    mutating func admitted(_ revision: String, after predecessor: String) {
        // Reintroduce the predecessor even if its watch echo was already
        // published. A later admission can race with consumption of that
        // already-emitted event.
        if pending.last != predecessor { pending = [predecessor] }
        if pending.last != revision { pending.append(revision) }
    }

    mutating func observe(_ revision: String) -> Observation {
        guard let index = pending.firstIndex(of: revision) else {
            // An unknown authoritative revision is a concurrent or transformed
            // result, not an echo of one of this session's optimistic prefixes.
            pending.removeAll()
            return .publish
        }
        guard index == pending.index(before: pending.endIndex) else {
            return .retain(pending.last!)
        }
        pending.removeAll()
        return .publish
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
        NodeRef(
            tree: tree.rawValue,
            path: path,
            stableKey: stableKey
        )
    }
}
