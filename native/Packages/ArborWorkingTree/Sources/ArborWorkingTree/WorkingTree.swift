import ArborKit
import ArborObjectStore
import ArborWire
import Foundation

/// The node index of one tree plus the local objects it has produced, over a
/// state store (disk on iOS, memory on the Mac) and a layered object store
/// (the tree's own overlay in front of the platform's accepted bytes).
public actor WorkingTree {
    public typealias Clock = @Sendable () -> Date

    private let store: any WorkingTreeStateStore
    private let overlay: any ObjectOverlay
    private let platform: any ObjectStore
    private let faultInjector: any WorkingTreeFaultInjector
    private let clock: Clock
    private var state: WorkingTreeState
    private var control: WorkingTreeControl
    private var index: WorkingTreeSearchIndex
    private var terminal = false
    private var changeObservers: [UUID: AsyncStream<Int>.Continuation] = [:]
    /// Hashes the platform store could not serve on the last attempt. A file
    /// held by such a reference is presented as a placeholder until a later
    /// read succeeds.
    private var missingHashes: Set<String> = []

    private init(
        store: any WorkingTreeStateStore,
        overlay: any ObjectOverlay,
        platform: any ObjectStore,
        faultInjector: any WorkingTreeFaultInjector,
        clock: @escaping Clock,
        state: WorkingTreeState,
        control: WorkingTreeControl,
        index: WorkingTreeSearchIndex
    ) {
        self.store = store
        self.overlay = overlay
        self.platform = platform
        self.faultInjector = faultInjector
        self.clock = clock
        self.state = state
        self.control = control
        self.index = index
    }

    /// Open the iOS layout at `root`: durable files plus a `DirectoryObjectStore`
    /// overlay at `objects/`. `platform` serves hashes the overlay lacks.
    public static func open(
        at root: URL,
        tree: TreeID,
        platform: any ObjectStore = EmptyObjectStore(),
        faultInjector: any WorkingTreeFaultInjector = NoReplicaFaults(),
        clock: @escaping Clock = Date.init
    ) async throws -> WorkingTree {
        let files = try DurableWorkingTreeFiles(root: root)
        let overlay = try DirectoryObjectStore(directory: files.objectsDirectory)
        return try await open(
            store: files,
            overlay: overlay,
            platform: platform,
            tree: tree,
            faultInjector: faultInjector,
            clock: clock
        )
    }

    /// A working tree that keeps nothing on disk: memory state, memory overlay.
    public static func inMemory(
        tree: TreeID,
        platform: any ObjectStore = EmptyObjectStore(),
        faultInjector: any WorkingTreeFaultInjector = NoReplicaFaults(),
        clock: @escaping Clock = Date.init
    ) async throws -> WorkingTree {
        try await open(
            store: InMemoryWorkingTreeStore(),
            overlay: InMemoryObjectOverlay(),
            platform: platform,
            tree: tree,
            faultInjector: faultInjector,
            clock: clock
        )
    }

    public static func open(
        store: any WorkingTreeStateStore,
        overlay: any ObjectOverlay,
        platform: any ObjectStore = EmptyObjectStore(),
        tree: TreeID,
        faultInjector: any WorkingTreeFaultInjector = NoReplicaFaults(),
        clock: @escaping Clock = Date.init
    ) async throws -> WorkingTree {
        let loaded: (WorkingTreeState, WorkingTreeControl)
        if store.hasState {
            let state = try decode(WorkingTreeState.self, from: try store.readState())
            guard state.schema == WorkingTreeState.currentSchema else {
                throw WorkingTreeError.corruptState("Unsupported working tree state schema \(state.schema)")
            }
            guard state.tree == tree.rawValue else { throw WorkingTreeError.corruptState("Working tree ID changed") }
            let snapshot = try WorkingTreeWireCodec.snapshot(for: state)
            let control: WorkingTreeControl
            if store.hasControl {
                control = try decode(WorkingTreeControl.self, from: try store.readControl())
            } else {
                control = WorkingTreeControl(
                    tree: tree.rawValue,
                    materializedRoot: snapshot.root,
                    pendingRoot: snapshot.root,
                    generation: 0
                )
                try overlay.store(snapshot.inlineObjectsByHash)
                try store.writeControl(try encode(control))
            }
            loaded = (state, control)
        } else {
            let state = WorkingTreeState(
                tree: tree.rawValue,
                nodes: [WorkingTreeNode(path: "/", kind: .directory)]
            )
            let snapshot = try WorkingTreeWireCodec.snapshot(for: state)
            let control = WorkingTreeControl(
                tree: tree.rawValue,
                materializedRoot: snapshot.root,
                pendingRoot: snapshot.root,
                generation: 0
            )
            try overlay.store(snapshot.inlineObjectsByHash)
            try store.writeState(try encode(state))
            try store.writeControl(try encode(control))
            loaded = (state, control)
        }

        try validate(loaded.0, control: nil)
        let workingTree = WorkingTree(
            store: store,
            overlay: overlay,
            platform: platform,
            faultInjector: faultInjector,
            clock: clock,
            state: loaded.0,
            control: loaded.1,
            index: WorkingTreeSearchIndex(generation: -1, entries: [])
        )
        try await workingTree.recoverPendingIntents()
        try await workingTree.validateLoadedState()
        try await workingTree.loadOrRebuildIndex()
        if let cleanup = try? store.prepareLegacyCleanup() {
            Task.detached(priority: .utility) { cleanup() }
        }
        return workingTree
    }

    static func encode<T: Encodable>(_ value: T) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        encoder.dateEncodingStrategy = .millisecondsSince1970
        return try encoder.encode(value)
    }

    static func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .millisecondsSince1970
        return try decoder.decode(type, from: data)
    }

    public func heads() throws -> WorkingTreeHeads {
        try requireOpen()
        return control.heads
    }

    public func currentSnapshot() throws -> WorkingTreeSnapshot {
        try requireOpen()
        return try WorkingTreeWireCodec.snapshot(for: state)
    }

    public func changes() throws -> AsyncStream<Int> {
        try requireOpen()
        let id = UUID()
        return AsyncStream(bufferingPolicy: .bufferingNewest(1)) { continuation in
            changeObservers[id] = continuation
            continuation.yield(control.generation)
            continuation.onTermination = { [weak self] _ in
                Task { await self?.removeChangeObserver(id) }
            }
        }
    }

    /// Canonical object bytes: the tree's own overlay first, then the platform
    /// store. Throws `ObjectStoreError.missing` when neither can serve the hash.
    public func objectBytes(hash: String) async throws -> Data {
        try requireOpen()
        if let local = try overlay.storedBytes(hash) {
            missingHashes.remove(hash)
            return local
        }
        do {
            let bytes = try verifyObject(try await platform.bytes(hash), hash: hash)
            missingHashes.remove(hash)
            return bytes
        } catch ObjectStoreError.missing {
            missingHashes.insert(hash)
            throw ObjectStoreError.missing(hash)
        }
    }

    /// The current graph with every object's bytes, fetching referenced file
    /// objects through the object store.
    public func completeSnapshot() async throws -> WireSnapshot {
        let sparse = try currentSnapshot()
        var objects: [WireObjectEnvelope] = []
        objects.reserveCapacity(sparse.objects.count)
        for object in sparse.objects {
            let bytes: Data
            if let inline = object.bytes { bytes = inline } else { bytes = try await objectBytes(hash: object.hash) }
            objects.append(WireObjectEnvelope(hash: object.hash, bytes: bytes))
        }
        return WireSnapshot(root: sparse.root, objects: objects)
    }

    /// The current graph as far as this tree's own bytes go: every object the
    /// state carries inline plus every referenced object the overlay holds.
    /// Platform-served files are omitted, so the result validates in
    /// `.sparseFiles`; nothing is fetched. Candidate bodies and durable heads
    /// are cut from this, never from the platform store.
    public func localSnapshot() throws -> WireSnapshot {
        let sparse = try currentSnapshot()
        var objects: [WireObjectEnvelope] = []
        objects.reserveCapacity(sparse.objects.count)
        for object in sparse.objects {
            if let inline = object.bytes {
                objects.append(WireObjectEnvelope(hash: object.hash, bytes: inline))
            } else if let held = try overlay.storedBytes(object.hash) {
                objects.append(WireObjectEnvelope(hash: object.hash, bytes: held))
            }
        }
        return WireSnapshot(root: sparse.root, objects: objects)
    }

    /// Bytes the tree's own overlay holds for `hash`, or `nil`; never consults the platform.
    public func overlayBytes(hash: String) throws -> Data? {
        try requireOpen()
        return try overlay.storedBytes(hash)
    }

    /// Size and media type of every file the state references by hash, keyed
    /// by hash. Lets a sparse graph derived from this tree be bridged back
    /// without fetching the files it omits.
    public func sparseFileMetadataByHash() throws -> [String: SparseFileMetadata] {
        try requireOpen()
        var result: [String: SparseFileMetadata] = [:]
        for node in state.nodes where node.kind == .file {
            if case let .hash(hash, size, mediaType)? = node.ref {
                result[hash] = SparseFileMetadata(size: size, mediaType: mediaType ?? node.mediaType)
            }
        }
        return result
    }

    /// The kind of an object the overlay holds, read from its prefix; `nil` when
    /// the overlay does not hold it (a platform-served file, or nothing).
    public func objectKind(hash: String) throws -> WireObjectCodec.Kind? {
        try requireOpen()
        guard let bytes = try overlay.storedBytes(hash) else { return nil }
        return WireObjectCodec.kind(ofPrefix: bytes.prefix(WireObjectCodec.kindPrefixLength))
    }

    /// Whether the last read of `node`'s bytes found no store able to serve them.
    func isKnownMissing(_ node: WorkingTreeNode) -> Bool {
        guard case let .hash(hash, _, _)? = node.ref else { return false }
        return missingHashes.contains(hash)
    }

    /// Collect the overlay down to what the materialized and accepted roots
    /// reach. Objects referenced by trashed file nodes are kept as well: the
    /// snapshot omits `/Trash`, but a restore must find their bytes again.
    private func retainOverlay(_ control: WorkingTreeControl, state: WorkingTreeState) {
        var roots: Set<String> = [control.materializedRoot]
        if let accepted = control.acceptedRoot { roots.insert(accepted) }
        for node in state.nodes where node.kind == .file {
            if case let .hash(hash, _, _)? = node.ref { roots.insert(hash) }
        }
        try? overlay.retain(reachableFrom: roots)
    }

    public func recordAccepted(root: String, update: String, cursor: String? = nil) throws {
        try requireOpen()
        guard !update.isEmpty else { throw WorkingTreeError.corruptState("Accepted update ID is empty") }
        guard root == control.materializedRoot else {
            throw WorkingTreeError.corruptState("Accepted root does not match the materialized replica")
        }
        var next = control
        next.acceptedRoot = root
        next.acceptedUpdate = update
        next.acceptedCursor = cursor
        if next.pendingRoot == root { next.pendingRoot = nil }
        try store.writeControl(try Self.encode(next))
        control = next
        retainOverlay(next, state: state)
    }

    public func initializeFromSystem(_ replacement: WorkingTreeSystemReplacement) throws {
        try requireOpen()
        guard control.generation == 0,
              control.acceptedRoot == nil,
              state.nodes.count == 1,
              state.nodes[0].path == "/",
              state.nodes[0].kind == .directory,
              state.nodes[0].source == nil else {
            throw WorkingTreeError.pendingLocalChanges
        }
        try replaceWithAccepted(replacement, mutation: "initialize-from-system")
    }

    /// Seed a fresh working tree with a system snapshot that is *ahead* of the
    /// accepted base: the dirty-daemon bootstrap. The folder's current state
    /// becomes the materialized root and stays pending against the separately
    /// verified accepted authority root, so the adopted request that produced
    /// it can be resubmitted and a later local edit is its successor. Same
    /// generation-0 guards as `initializeFromSystem`; routed like
    /// `replacePendingFromSystem`.
    public func initializePendingFromSystem(
        _ replacement: WorkingTreeSystemReplacement,
        acceptedRoot: String,
        acceptedUpdate: String,
        acceptedCursor: String? = nil
    ) throws {
        try requireOpen()
        guard control.generation == 0,
              control.acceptedRoot == nil,
              state.nodes.count == 1,
              state.nodes[0].path == "/",
              state.nodes[0].kind == .directory,
              state.nodes[0].source == nil else {
            throw WorkingTreeError.pendingLocalChanges
        }
        guard !acceptedUpdate.isEmpty else { throw WorkingTreeError.corruptState("Accepted update ID is empty") }
        let replacementState = try state(from: replacement)
        let computed = try WorkingTreeWireCodec.snapshot(for: replacementState)
        guard computed.root == replacement.root else { throw WorkingTreeError.corruptState("System replacement root mismatch") }
        try transact(
            mutation: "initialize-pending-from-system",
            pageKey: "_system",
            accepted: (acceptedRoot, acceptedUpdate, acceptedCursor),
            retainsPendingAgainstAcceptedBase: true,
            recordsModificationDates: false
        ) { next in
            next = replacementState
        }
    }

    public func integrateAccepted(
        _ replacement: WorkingTreeSystemReplacement,
        expectedCandidate: String
    ) throws {
        try requireOpen()
        guard control.materializedRoot == expectedCandidate,
              control.pendingRoot == expectedCandidate else {
            throw WorkingTreeError.pendingLocalChanges
        }
        try replaceWithAccepted(replacement, mutation: "integrate-accepted")
    }

    public func replaceFromSystem(_ replacement: WorkingTreeSystemReplacement) throws {
        try requireOpen()
        guard control.pendingRoot == nil else { throw WorkingTreeError.pendingLocalChanges }
        try replaceWithAccepted(replacement, mutation: "system-replacement")
    }

    /// Atomically install a reviewed conflict candidate while retaining it as
    /// pending work against the separately verified accepted authority root.
    public func replacePendingFromSystem(
        _ replacement: WorkingTreeSystemReplacement,
        acceptedRoot: String,
        acceptedUpdate: String,
        acceptedCursor: String? = nil
    ) throws {
        try requireOpen()
        guard control.pendingRoot != nil, !acceptedUpdate.isEmpty else { throw WorkingTreeError.pendingLocalChanges }
        let replacementState = try state(from: replacement)
        let computed = try WorkingTreeWireCodec.snapshot(for: replacementState)
        guard computed.root == replacement.root else { throw WorkingTreeError.corruptState("System replacement root mismatch") }
        try transact(
            mutation: "resolve-sync-conflict",
            pageKey: "_system",
            accepted: (acceptedRoot, acceptedUpdate, acceptedCursor),
            retainsPendingAgainstAcceptedBase: true
        ) { next in
            next = replacementState
        }
    }

    private func replaceWithAccepted(_ replacement: WorkingTreeSystemReplacement, mutation: String) throws {
        let replacementState = try state(from: replacement)
        let computed = try WorkingTreeWireCodec.snapshot(for: replacementState)
        guard computed.root == replacement.root else { throw WorkingTreeError.corruptState("System replacement root mismatch") }
        try transact(
            mutation: mutation,
            pageKey: "_system",
            accepted: (replacement.root, replacement.update, replacement.cursor),
            recordsModificationDates: mutation != "initialize-from-system"
        ) { next in
            next = replacementState
        }
    }

    private func state(from replacement: WorkingTreeSystemReplacement) throws -> WorkingTreeState {
        guard !replacement.update.isEmpty else { throw WorkingTreeError.corruptState("System update ID is empty") }
        let nodes = replacement.nodes.map { node -> WorkingTreeNode in
            switch node.content {
            case let .directory(source):
                return WorkingTreeNode(
                    path: node.path,
                    pageID: node.pageID ?? source.flatMap(WorkingTreeSemantics.pageID(in:)),
                    kind: .directory,
                    source: source,
                    childrenSource: node.childrenSource,
                    directoryBodyPlacement: node.directoryBodyPlacement,
                    shadowedSiblingMarkdownSource: node.shadowedSiblingMarkdownSource
                )
            case let .markdown(source):
                return WorkingTreeNode(path: node.path, pageID: node.pageID ?? WorkingTreeSemantics.pageID(in: source), kind: .markdown, source: source)
            case let .file(ref, mediaType):
                return WorkingTreeNode(path: node.path, pageID: node.pageID, kind: .file, ref: ref, mediaType: mediaType ?? ref.mediaType)
            case let .boundary(tree):
                return WorkingTreeNode(path: node.path, kind: .boundary, boundaryTree: tree.rawValue)
            }
        }
        return WorkingTreeState(tree: state.tree, nodes: nodes)
    }

    public func deleteRebuildableIndexes() throws {
        try requireOpen()
        try store.removeIndexes()
        index = WorkingTreeSearchIndex(generation: -1, entries: [])
    }

    /// Integrity of the tree's own overlay. Objects the state carries inline
    /// (directories, Markdown, freshly imported files) must be present and
    /// intact; a referenced file the overlay does not hold is served by the
    /// platform store and is a materialization state, not corruption.
    public func diagnostics() throws -> [WorkingTreeDiagnostic] {
        try requireOpen()
        let snapshot = try WorkingTreeWireCodec.snapshot(for: state)
        var result: [WorkingTreeDiagnostic] = []
        for object in snapshot.objects {
            guard overlay.contains(object.hash) else {
                if object.bytes != nil {
                    result.append(WorkingTreeDiagnostic(
                        id: object.hash,
                        title: "Immutable object missing",
                        detail: "The materialized working tree can rebuild \(object.hash), but the object store is incomplete."
                    ))
                }
                continue
            }
            let stored = try? overlay.storedBytes(object.hash)
            if stored == nil || (object.bytes != nil && stored != object.bytes) {
                result.append(WorkingTreeDiagnostic(
                    id: object.hash,
                    title: "Immutable object damaged",
                    detail: "Stored bytes do not match \(object.hash)."
                ))
            }
        }
        return result.sorted { $0.id < $1.id }
    }

    public func close() {
        terminal = true
        for continuation in changeObservers.values { continuation.finish() }
        changeObservers.removeAll()
    }

    func resolve(_ reference: WorkspaceReference) throws -> WorkingTreeNode {
        try requireOpen()
        guard reference.tree.rawValue == state.tree else { throw WorkingTreeError.notFound(reference) }
        if let pageID = markdownID(fromStableKey: reference.stableKey),
           let node = state.nodes.first(where: { $0.pageID == pageID }) { return node }
        let path = try WorkingTreeSemantics.normalizePath(reference.path)
        guard let node = state.nodes.first(where: { $0.path == path }) else { throw WorkingTreeError.notFound(reference) }
        return node
    }

    func children(of reference: WorkspaceReference) throws -> [WorkingTreeNode] {
        let parent = try resolve(reference)
        guard parent.kind == .directory else { throw WorkingTreeError.notDirectory(reference) }
        return state.nodes.filter {
            WorkingTreeSemantics.parent(of: $0.path) == parent.path && !WorkingTreeSemantics.isStoreFile($0)
        }.sorted { WorkingTreeSemantics.compareUTF8($0.path, $1.path) }
    }

    func completeSource(for node: WorkingTreeNode) -> String? {
        switch node.kind {
        case .markdown: node.source ?? ""
        case .directory: node.source ?? ""
        case .file, .boundary: nil
        }
    }

    func revision(for node: WorkingTreeNode) -> String {
        WorkingTreeSemantics.documentRevision(node: node, state: state)
    }

    func collection(for directory: WorkingTreeNode) async -> (kind: String, rows: Int?)? {
        guard directory.kind == .directory else { return nil }
        guard let storeFile = state.nodes.first(where: {
            WorkingTreeSemantics.parent(of: $0.path) == directory.path && WorkingTreeSemantics.isStoreFile($0)
        }) else { return nil }
        let name = WorkingTreeSemantics.name(of: storeFile.path)
        switch name {
        case "_store.sqlite3": return ("SQLite", nil)
        case "_store.postgres": return ("Postgres", nil)
        case "_store.csv", "_store.json", "_store.jsonl": break
        default: return nil
        }
        let bytes = try? await payload(of: storeFile)
        switch name {
        case "_store.csv":
            guard let bytes else { return ("CSV", nil) }
            let lines = String(decoding: bytes, as: UTF8.self).split(whereSeparator: \.isNewline)
            return ("CSV", max(0, lines.count - 1))
        case "_store.json":
            guard let bytes, let value = try? JSONSerialization.jsonObject(with: bytes),
                  let rows = value as? [Any] else { return ("JSON", nil) }
            return ("JSON", rows.count)
        case "_store.jsonl":
            guard let bytes else { return ("JSONL", nil) }
            return ("JSONL", String(decoding: bytes, as: UTF8.self).split(whereSeparator: \.isNewline).count)
        case "_store.sqlite3": return ("SQLite", nil)
        case "_store.postgres": return ("Postgres", nil)
        default: return nil
        }
    }

    func search(_ query: String) throws -> [WorkingTreeSearchIndex.Entry] {
        try requireOpen()
        if index.generation != control.generation { try rebuildIndex() }
        let needle = query.localizedLowercase
        return index.entries.filter {
            needle.isEmpty
                || $0.title.localizedLowercase.contains(needle)
                || $0.source.localizedLowercase.contains(needle)
        }
    }

    func backlinkCountsByPath() throws -> [String: Int] {
        try requireOpen()
        if index.generation != control.generation { try rebuildIndex() }
        var inboundByPath: [String: Set<String>] = [:]
        var inboundByStableKey: [String: Set<String>] = [:]
        var inboundByLegacyPageID: [String: Set<String>] = [:]
        for source in index.entries {
            for link in source.links where link.tree == nil || link.tree == state.tree {
                inboundByPath[link.path, default: []].insert(source.path)
                if let stableKey = link.stableKey {
                    inboundByStableKey[stableKey, default: []].insert(source.path)
                }
                if let pageID = link.legacyPageID {
                    inboundByLegacyPageID[pageID, default: []].insert(source.path)
                }
            }
        }
        return Dictionary(uniqueKeysWithValues: index.entries.map { target in
            var sources = inboundByPath[target.path, default: []]
            if let pageID = target.pageID {
                sources.formUnion(inboundByStableKey[markdownStableKey(pageID), default: []])
                sources.formUnion(inboundByLegacyPageID[pageID, default: []])
            }
            return (target.path, sources.count)
        })
    }

    func backlinks(to reference: WorkspaceReference) throws -> [WorkingTreeSearchIndex.Entry] {
        let target = try resolve(reference)
        let targetKey = target.pageID.map(markdownStableKey)
        if index.generation != control.generation { try rebuildIndex() }
        return index.entries.filter { entry in
            entry.links.contains { link in
                guard link.tree == nil || link.tree == state.tree else { return false }
                return link.path == target.path
                    || (targetKey != nil && link.stableKey == targetKey)
                    || (target.pageID != nil && link.legacyPageID == target.pageID)
            }
        }
    }

    @discardableResult
    func createMarkdown(parent: WorkspaceReference, name: String, source: String) throws -> WorkingTreeNode {
        try WorkingTreeSemantics.validateName(name)
        guard name != "_index" else { throw WorkingTreeError.invalidName(name) }
        let parentNode = try resolve(parent)
        guard parentNode.kind == .directory || parentNode.kind == .markdown else { throw WorkingTreeError.notDirectory(parent) }
        let path = WorkingTreeSemantics.child(name, of: parentNode.path)
        let suppliedIDs = WorkingTreeSemantics.pageIDValues(in: source)
        guard suppliedIDs.count <= 1 else { throw WorkingTreeError.corruptState("Markdown contains duplicate PageIDs") }
        let pageID = suppliedIDs.first ?? "pg_\(UUID().uuidString.lowercased())"
        let acceptedSource = WorkingTreeSemantics.ensuringPageID(in: source, id: pageID)
        var created: WorkingTreeNode!
        try transact(mutation: "create-markdown", pageKey: pageID) { next in
            try prepareParentForChildren(parentNode, in: &next)
            try refuseCollision(path, in: next)
            guard !next.nodes.contains(where: { $0.pageID == pageID }) else { throw WorkingTreeError.collision("PageID \(pageID)") }
            created = WorkingTreeNode(path: path, pageID: pageID, kind: .markdown, source: acceptedSource)
            next.nodes.append(created)
        }
        return created
    }

    @discardableResult
    func createDirectory(parent: WorkspaceReference, name: String) throws -> WorkingTreeNode {
        try WorkingTreeSemantics.validateName(name)
        let parentNode = try resolve(parent)
        guard parentNode.kind == .directory || parentNode.kind == .markdown else { throw WorkingTreeError.notDirectory(parent) }
        let path = WorkingTreeSemantics.child(name, of: parentNode.path)
        var created: WorkingTreeNode!
        try transact(mutation: "create-directory", pageKey: "_tree") { next in
            try prepareParentForChildren(parentNode, in: &next)
            try refuseCollision(path, in: next)
            created = WorkingTreeNode(path: path, kind: .directory)
            next.nodes.append(created)
        }
        return created
    }

    @discardableResult
    func importFile(name: String, bytes: Data, mediaType: String?, parent: WorkspaceReference) throws -> WorkingTreeNode {
        try WorkingTreeSemantics.validateName(name)
        guard name != "_index.md", !name.hasSuffix(".md") else { throw WorkingTreeError.invalidName(name) }
        let parentNode = try resolve(parent)
        guard parentNode.kind == .directory || parentNode.kind == .markdown else { throw WorkingTreeError.notDirectory(parent) }
        let path = WorkingTreeSemantics.child(name, of: parentNode.path)
        var created: WorkingTreeNode!
        try transact(mutation: "import-file", pageKey: "_tree") { next in
            try prepareParentForChildren(parentNode, in: &next)
            try refuseCollision(path, in: next)
            created = WorkingTreeNode(path: path, kind: .file, ref: .inline(bytes), mediaType: mediaType)
            next.nodes.append(created)
        }
        return created
    }

    @discardableResult
    func storeAsset(_ asset: WorkspaceAsset, in parent: WorkspaceReference) throws -> WorkingTreeNode {
        try WorkingTreeSemantics.validateName(asset.name)
        let parentNode = try resolve(parent)
        guard parentNode.kind == .directory || parentNode.kind == .markdown else { throw WorkingTreeError.notDirectory(parent) }
        let digest = String(WorkingTreeSemantics.sha256(asset.bytes).dropFirst("sha256:".count))
        let uniqueName = "\(digest.prefix(16))-\(asset.name)"
        let path = WorkingTreeSemantics.child(uniqueName, of: parentNode.path)
        if let existing = state.nodes.first(where: { $0.path == path }) {
            guard existing.kind == .file, existing.ref?.objectHash == ContentRef.inline(asset.bytes).objectHash else {
                throw WorkingTreeError.collision(path)
            }
            return existing
        }
        return try importFile(name: uniqueName, bytes: asset.bytes, mediaType: asset.mediaType, parent: parent)
    }

    /// A file node's payload, read through the object store when held by hash.
    public func fileBytes(_ reference: WorkspaceReference) async throws -> Data {
        let node = try resolve(reference)
        guard node.kind == .file, node.ref != nil else { throw WorkingTreeError.notFound(reference) }
        return try await payload(of: node)
    }

    private func payload(of node: WorkingTreeNode) async throws -> Data {
        switch node.ref {
        case let .inline(bytes)?:
            return bytes
        case let .hash(hash, _, _)?:
            let object = try await objectBytes(hash: hash)
            guard case let .file(payload) = try WireObjectCodec.decode(object) else {
                throw WorkingTreeError.corruptState("File reference \(hash) is not a file object")
            }
            return payload
        case nil:
            throw WorkingTreeError.corruptState("File node has no content reference")
        }
    }

    @discardableResult
    func rename(_ reference: WorkspaceReference, name: String) throws -> WorkingTreeNode {
        try WorkingTreeSemantics.validateName(name)
        let node = try resolve(reference)
        if node.kind == .markdown, name == "_index" { throw WorkingTreeError.invalidName(name) }
        if node.kind == .file, name == "_index.md" { throw WorkingTreeError.invalidName(name) }
        guard node.path != "/", let parent = WorkingTreeSemantics.parent(of: node.path) else { throw WorkingTreeError.readOnly(reference) }
        let destination = WorkingTreeSemantics.child(name, of: parent)
        return try relocate(node, to: destination, mutation: "rename")
    }

    @discardableResult
    func move(_ reference: WorkspaceReference, destination: WorkspaceReference) throws -> WorkingTreeNode {
        let node = try resolve(reference)
        let parent = try resolve(destination)
        guard node.path != "/" else { throw WorkingTreeError.readOnly(reference) }
        guard parent.kind == .directory else { throw WorkingTreeError.notDirectory(destination) }
        guard !WorkingTreeSemantics.isDescendant(parent.path, of: node.path), parent.path != node.path else {
            throw WorkingTreeError.invalidPath(parent.path)
        }
        return try relocate(node, to: WorkingTreeSemantics.child(WorkingTreeSemantics.name(of: node.path), of: parent.path), mutation: "move")
    }

    @discardableResult
    func copy(_ reference: WorkspaceReference, destination: WorkspaceReference) throws -> WorkingTreeNode {
        let node = try resolve(reference)
        let parent = try resolve(destination)
        guard parent.kind == .directory else { throw WorkingTreeError.notDirectory(destination) }
        guard parent.path != node.path, !WorkingTreeSemantics.isDescendant(parent.path, of: node.path) else {
            throw WorkingTreeError.invalidPath(parent.path)
        }
        let target = WorkingTreeSemantics.child(WorkingTreeSemantics.name(of: node.path), of: parent.path)
        var copied: WorkingTreeNode!
        try transact(mutation: "copy", pageKey: node.pageID ?? "_tree") { next in
            try refuseCollision(target, in: next)
            let sourceNodes = next.nodes.filter { $0.path == node.path || WorkingTreeSemantics.isDescendant($0.path, of: node.path) }
            for var source in sourceNodes.sorted(by: { $0.path.count < $1.path.count }) {
                source.path = WorkingTreeSemantics.replacingPrefix(source.path, from: node.path, to: target)
                source.trashedFrom = nil
                if let oldID = source.pageID {
                    let newID = "pg_\(UUID().uuidString.lowercased())"
                    source.pageID = newID
                    if let sourceText = source.source { source.source = WorkingTreeSemantics.replacingPageID(in: sourceText, with: newID) }
                    if oldID == node.pageID { copied = source }
                } else if source.path == target { copied = source }
                next.nodes.append(source)
            }
        }
        return copied
    }

    @discardableResult
    func trash(_ reference: WorkspaceReference) throws -> WorkingTreeNode {
        let node = try resolve(reference)
        guard node.path != "/", node.path != "/Trash", !node.path.hasPrefix("/Trash/") else { throw WorkingTreeError.readOnly(reference) }
        let destination = "/Trash" + node.path
        var result: WorkingTreeNode!
        try transact(mutation: "trash", pageKey: node.pageID ?? "_tree") { next in
            if !next.nodes.contains(where: { $0.path == "/Trash" }) {
                next.nodes.append(WorkingTreeNode(path: "/Trash", kind: .directory))
            }
            let ancestors = destination.split(separator: "/").dropLast()
            var current = ""
            for component in ancestors {
                current += "/\(component)"
                if !next.nodes.contains(where: { $0.path == current }) {
                    next.nodes.append(WorkingTreeNode(path: current, kind: .directory))
                }
            }
            try refuseCollision(destination, in: next)
            for index in next.nodes.indices where next.nodes[index].path == node.path || WorkingTreeSemantics.isDescendant(next.nodes[index].path, of: node.path) {
                let original = next.nodes[index].path
                next.nodes[index].path = WorkingTreeSemantics.replacingPrefix(original, from: node.path, to: destination)
                next.nodes[index].trashedFrom = original
                if original == node.path { result = next.nodes[index] }
            }
        }
        return result
    }

    @discardableResult
    func restore(_ reference: WorkspaceReference) throws -> WorkingTreeNode {
        let node = try resolve(reference)
        guard node.path.hasPrefix("/Trash/"), let destination = node.trashedFrom else { throw WorkingTreeError.invalidPath(node.path) }
        var result: WorkingTreeNode!
        try transact(mutation: "restore", pageKey: node.pageID ?? "_tree") { next in
            try refuseCollision(destination, in: next)
            for index in next.nodes.indices where next.nodes[index].path == node.path || WorkingTreeSemantics.isDescendant(next.nodes[index].path, of: node.path) {
                let current = next.nodes[index].path
                let fallback = WorkingTreeSemantics.replacingPrefix(current, from: node.path, to: destination)
                next.nodes[index].path = next.nodes[index].trashedFrom ?? fallback
                next.nodes[index].trashedFrom = nil
                if current == node.path { result = next.nodes[index] }
            }
            pruneEmptyTrashDirectories(&next)
        }
        return result
    }

    func documentSnapshot(_ reference: WorkspaceReference) throws -> WorkspaceDocumentSnapshot {
        let node = try resolve(reference)
        guard let source = completeSource(for: node), node.kind != .file else { throw WorkingTreeError.notDocument(reference) }
        return WorkspaceDocumentSnapshot(reference: workspaceReference(node), source: source, contentRevision: revision(for: node))
    }

    @discardableResult
    func writeDocument(_ reference: WorkspaceReference, source: String, baseRevision: String, mutation: String = "write-document") throws -> WorkspaceDocumentSnapshot {
        let original = try resolve(reference)
        guard original.kind == .markdown || original.kind == .directory else { throw WorkingTreeError.notDocument(reference) }
        let actual = revision(for: original)
        guard baseRevision == actual else { throw WorkingTreeError.staleRevision(expected: baseRevision, actual: actual) }
        let submittedIDs = WorkingTreeSemantics.pageIDValues(in: source)
        guard submittedIDs.count <= 1 else { throw WorkingTreeError.corruptState("Markdown contains duplicate PageIDs") }
        let submittedID = submittedIDs.first
        let admittedID: String?
        let acceptedSource: String
        if original.pageID == nil, original.kind == .directory, submittedID == nil {
            let minted = "pg_\(UUID().uuidString.lowercased())"
            admittedID = minted
            acceptedSource = WorkingTreeSemantics.ensuringPageID(in: source, id: minted)
        } else {
            admittedID = submittedID
            acceptedSource = source
        }
        if let pageID = original.pageID {
            guard submittedID == pageID else {
                throw WorkingTreeError.pageIDChanged(expected: pageID, actual: submittedID)
            }
        }
        var updated: WorkingTreeNode!
        try transact(mutation: mutation, pageKey: original.pageID ?? admittedID ?? "_tree") { next in
            guard let position = next.nodes.firstIndex(where: { $0.path == original.path }) else {
                throw WorkingTreeError.notFound(reference)
            }
            if original.pageID == nil, let admittedID {
                guard !next.nodes.contains(where: { $0.pageID == admittedID }) else {
                    throw WorkingTreeError.collision("PageID \(admittedID)")
                }
                next.nodes[position].pageID = admittedID
            }
            next.nodes[position].source = acceptedSource
            updated = next.nodes[position]
        }
        return WorkspaceDocumentSnapshot(
            reference: workspaceReference(updated),
            source: acceptedSource,
            contentRevision: revision(for: updated)
        )
    }

    func writeDocument(
        _ reference: WorkspaceReference,
        patch: WorkspaceDocumentPatch
    ) throws -> (snapshot: WorkspaceDocumentSnapshot, admission: WorkingTreePatchAdmission) {
        let current = try documentSnapshot(reference)
        guard current.contentRevision == patch.baseContentRevision else {
            throw WorkingTreeError.staleRevision(expected: patch.baseContentRevision, actual: current.contentRevision)
        }
        let before = control.heads
        let submitted = try patch.applying(to: current.source)
        let snapshot = try writeDocument(
            reference,
            source: submitted,
            baseRevision: patch.baseContentRevision
        )
        let baseObject = WorkingTreeWireCodec.file(Data(current.source.utf8))
        let resultObject = WorkingTreeWireCodec.file(Data(snapshot.source.utf8))
        return (
            snapshot,
            WorkingTreePatchAdmission(
                reference: snapshot.reference,
                baseRoot: before.materializedRoot,
                candidateRoot: control.materializedRoot,
                generation: control.generation,
                baseFile: WorkingTreeWireCodec.hash(baseObject),
                resultFile: WorkingTreeWireCodec.hash(resultObject),
                patch: patch,
                baseWasAccepted: before.pendingRoot == nil && before.acceptedRoot == before.materializedRoot
            )
        )
    }

    func workspaceReference(_ node: WorkingTreeNode) -> WorkspaceReference {
        WorkspaceReference(
            tree: TreeID(rawValue: state.tree),
            path: node.path,
            stableKey: node.pageID.map(markdownStableKey)
        )
    }

    public func treeID() -> TreeID { TreeID(rawValue: state.tree) }

    private func relocate(_ node: WorkingTreeNode, to destination: String, mutation: String) throws -> WorkingTreeNode {
        var moved: WorkingTreeNode!
        try transact(mutation: mutation, pageKey: node.pageID ?? "_tree") { next in
            try refuseCollision(destination, in: next)
            for index in next.nodes.indices where next.nodes[index].path == node.path || WorkingTreeSemantics.isDescendant(next.nodes[index].path, of: node.path) {
                let old = next.nodes[index].path
                next.nodes[index].path = WorkingTreeSemantics.replacingPrefix(old, from: node.path, to: destination)
                if old == node.path { moved = next.nodes[index] }
            }
        }
        return moved
    }

    private func transact(
        mutation: String,
        pageKey: String,
        accepted: (root: String, update: String, cursor: String?)? = nil,
        retainsPendingAgainstAcceptedBase: Bool = false,
        recordsModificationDates: Bool = true,
        change: (inout WorkingTreeState) throws -> Void
    ) throws {
        try requireOpen()
        var next = state
        try change(&next)
        let changedAt = clock()
        if recordsModificationDates {
            applyModificationDates(from: state, to: &next, changedAt: changedAt)
        }
        let generation = control.generation + 1
        let intent = WorkingTreeMutationIntent(
            id: UUID().uuidString.lowercased(),
            pageKey: pageKey,
            generation: generation,
            mutation: mutation,
            changedAt: changedAt,
            state: next,
            acceptedRoot: accepted?.root,
            acceptedUpdate: accepted?.update,
            acceptedCursor: accepted?.cursor,
            retainsPendingAgainstAcceptedBase: retainsPendingAgainstAcceptedBase ? true : nil
        )
        do {
            let token = try store.writeJournal(pageKey: pageKey, id: intent.id, try Self.encode(intent))
            try faultInjector.reached(.afterJournal)
            try finish(intent, journalToken: token, injectFaults: true)
        } catch {
            terminal = true
            throw error
        }
    }

    private func applyModificationDates(
        from previous: WorkingTreeState,
        to next: inout WorkingTreeState,
        changedAt: Date
    ) {
        let previousByPageID = Dictionary(
            uniqueKeysWithValues: previous.nodes.compactMap { node in
                node.pageID.map { ($0, node) }
            }
        )
        let previousByPath = Dictionary(uniqueKeysWithValues: previous.nodes.map { ($0.path, $0) })
        for index in next.nodes.indices {
            let candidate = next.nodes[index]
            let old = candidate.pageID.flatMap { previousByPageID[$0] }
                ?? previousByPath[candidate.path]
            guard let old else {
                next.nodes[index].modifiedAt = changedAt
                continue
            }
            var oldContent = old
            var candidateContent = candidate
            oldContent.modifiedAt = nil
            candidateContent.modifiedAt = nil
            next.nodes[index].modifiedAt = oldContent == candidateContent
                ? old.modifiedAt
                : changedAt
        }
    }

    private func finish(_ intent: WorkingTreeMutationIntent, journalToken: String, injectFaults: Bool) throws {
        try Self.validate(intent.state, control: nil)
        let snapshot = try WorkingTreeWireCodec.snapshot(for: intent.state)
        try overlay.store(snapshot.inlineObjectsByHash)
        if injectFaults { try faultInjector.reached(.afterObjects) }
        // Bytes the overlay now holds are referenced, not carried, from here on.
        var nextState = intent.state
        for position in nextState.nodes.indices {
            if case let .inline(bytes)? = nextState.nodes[position].ref {
                nextState.nodes[position].ref = .hash(
                    ContentRef.inline(bytes).objectHash,
                    size: bytes.count,
                    mediaType: nextState.nodes[position].mediaType
                )
            }
        }
        try store.writeState(try Self.encode(nextState))
        if injectFaults { try faultInjector.reached(.afterMaterialization) }
        let nextControl: WorkingTreeControl
        if intent.retainsPendingAgainstAcceptedBase == true {
            guard let acceptedRoot = intent.acceptedRoot, let acceptedUpdate = intent.acceptedUpdate else {
                throw WorkingTreeError.corruptState("Pending system replacement has no accepted base")
            }
            nextControl = WorkingTreeControl(
                tree: state.tree,
                materializedRoot: snapshot.root,
                pendingRoot: snapshot.root == acceptedRoot ? nil : snapshot.root,
                acceptedRoot: acceptedRoot,
                acceptedUpdate: acceptedUpdate,
                acceptedCursor: intent.acceptedCursor,
                generation: intent.generation
            )
        } else if let acceptedRoot = intent.acceptedRoot {
            guard acceptedRoot == snapshot.root, let acceptedUpdate = intent.acceptedUpdate else {
                throw WorkingTreeError.corruptState("System replacement acceptance mismatch")
            }
            nextControl = WorkingTreeControl(
                tree: state.tree,
                materializedRoot: snapshot.root,
                pendingRoot: nil,
                acceptedRoot: acceptedRoot,
                acceptedUpdate: acceptedUpdate,
                acceptedCursor: intent.acceptedCursor,
                generation: intent.generation
            )
        } else {
            nextControl = WorkingTreeControl(
                tree: state.tree,
                materializedRoot: snapshot.root,
                pendingRoot: snapshot.root == control.acceptedRoot ? nil : snapshot.root,
                acceptedRoot: control.acceptedRoot,
                acceptedUpdate: control.acceptedUpdate,
                acceptedCursor: control.acceptedCursor,
                generation: intent.generation
            )
        }
        try store.writeControl(try Self.encode(nextControl))
        if injectFaults { try faultInjector.reached(.afterControl) }
        let nextIndex = makeIndex(state: nextState, generation: intent.generation)
        try store.writeIndex(try Self.encode(nextIndex))
        try store.removeJournal(token: journalToken)
        state = nextState
        control = nextControl
        index = nextIndex
        if intent.acceptedRoot != nil { retainOverlay(nextControl, state: nextState) }
        for continuation in changeObservers.values { continuation.yield(nextControl.generation) }
    }

    private func removeChangeObserver(_ id: UUID) {
        changeObservers.removeValue(forKey: id)
    }

    private func recoverPendingIntents() throws {
        for record in try store.journalRecords() {
            let intent = try Self.decode(WorkingTreeMutationIntent.self, from: record.data)
            if intent.generation <= control.generation {
                try store.removeJournal(token: record.token)
                continue
            }
            guard intent.generation == control.generation + 1 else {
                throw WorkingTreeError.corruptState("Mutation journal generation gap")
            }
            try finish(intent, journalToken: record.token, injectFaults: false)
        }
    }

    private func validateLoadedState() throws {
        try Self.validate(state, control: control)
    }

    private func loadOrRebuildIndex() throws {
        if let data = store.readIndex(),
           let loaded = try? Self.decode(WorkingTreeSearchIndex.self, from: data),
           loaded.generation == control.generation {
            index = loaded
        } else {
            try rebuildIndex()
        }
    }

    private func rebuildIndex() throws {
        let rebuilt = makeIndex(state: state, generation: control.generation)
        try store.writeIndex(try Self.encode(rebuilt))
        index = rebuilt
    }

    private func makeIndex(state: WorkingTreeState, generation: Int) -> WorkingTreeSearchIndex {
        WorkingTreeSearchIndex(
            generation: generation,
            entries: state.nodes.compactMap { node in
                guard node.kind != .file, node.kind != .boundary,
                      node.path != "/Trash", !node.path.hasPrefix("/Trash/") else { return nil }
                let source = node.source ?? ""
                return WorkingTreeSearchIndex.Entry(
                    path: node.path,
                    pageID: node.pageID,
                    title: WorkingTreeSemantics.title(for: node),
                    source: source,
                    links: WorkingTreeSemantics.linkTargets(in: source, relativeTo: WorkingTreeSemantics.linkBase(for: node)),
                    modifiedAt: node.modifiedAt
                )
            }.sorted { WorkingTreeSemantics.compareUTF8($0.path, $1.path) }
        )
    }

    private func requireOpen() throws {
        if terminal { throw WorkingTreeError.closed }
    }

    private static func validate(_ state: WorkingTreeState, control: WorkingTreeControl?) throws {
        guard state.schema == WorkingTreeState.currentSchema, !state.tree.isEmpty else {
            throw WorkingTreeError.corruptState("Unsupported working tree state")
        }
        if let control {
            guard control.schema == 1, control.tree == state.tree else { throw WorkingTreeError.corruptState("Replica control mismatch") }
            let snapshot = try WorkingTreeWireCodec.snapshot(for: state)
            guard snapshot.root == control.materializedRoot else { throw WorkingTreeError.corruptState("Materialized root does not match state") }
        }
        let paths = state.nodes.map(\.path)
        guard Set(paths).count == paths.count else { throw WorkingTreeError.corruptState("Duplicate logical path") }
        guard state.nodes.contains(where: { $0.path == "/" && $0.kind == .directory }) else {
            throw WorkingTreeError.corruptState("Missing root directory")
        }
        let pageIDs = state.nodes.compactMap(\.pageID)
        guard Set(pageIDs).count == pageIDs.count else { throw WorkingTreeError.corruptState("Duplicate PageID") }
        for node in state.nodes {
            guard try WorkingTreeSemantics.normalizePath(node.path) == node.path else { throw WorkingTreeError.corruptState("Noncanonical path") }
            if node.path != "/" { try WorkingTreeSemantics.validateName(WorkingTreeSemantics.name(of: node.path)) }
            if node.path != "/", let parent = WorkingTreeSemantics.parent(of: node.path) {
                guard state.nodes.contains(where: { $0.path == parent && $0.kind == .directory }) else {
                    throw WorkingTreeError.corruptState("Missing parent directory for \(node.path)")
                }
            }
            if node.kind == .markdown, WorkingTreeSemantics.name(of: node.path) == "_index" {
                throw WorkingTreeError.corruptState("Reserved directory body appears as a Markdown child")
            }
            if node.kind == .file, WorkingTreeSemantics.name(of: node.path) == "_index.md" {
                throw WorkingTreeError.corruptState("Reserved directory body appears as an ordinary file")
            }
            if node.childrenSource != nil && node.kind != .directory {
                throw WorkingTreeError.corruptState("Collection-file descriptor is attached to a non-directory node")
            }
            if node.kind != .directory,
               node.directoryBodyPlacement != nil || node.shadowedSiblingMarkdownSource != nil {
                throw WorkingTreeError.corruptState("Directory body placement is attached to a non-directory node")
            }
            if node.path == "/",
               node.directoryBodyPlacement != nil || node.shadowedSiblingMarkdownSource != nil {
                throw WorkingTreeError.corruptState("Replica root body must use _index.md")
            }
            if node.directoryBodyPlacement == .siblingMarkdown,
               node.source == nil || node.shadowedSiblingMarkdownSource != nil {
                throw WorkingTreeError.corruptState("Malformed sibling Markdown directory body")
            }
            if node.shadowedSiblingMarkdownSource != nil, node.source == nil {
                throw WorkingTreeError.corruptState("Shadowed sibling Markdown has no _index.md body")
            }
            if (node.kind == .file || node.kind == .boundary), node.pageID != nil {
                throw WorkingTreeError.corruptState("Non-document node has a PageID")
            }
            if node.kind == .file, node.ref == nil {
                throw WorkingTreeError.corruptState("File node has no content reference")
            }
            if node.kind != .file, node.ref != nil {
                throw WorkingTreeError.corruptState("Content reference is attached to a non-file node")
            }
            if node.kind == .boundary {
                guard node.boundaryTree?.isEmpty == false, node.source == nil, node.ref == nil else {
                    throw WorkingTreeError.corruptState("Malformed nested tree boundary")
                }
                guard !state.nodes.contains(where: { WorkingTreeSemantics.parent(of: $0.path) == node.path }) else {
                    throw WorkingTreeError.corruptState("Nested tree boundary has local children")
                }
            }
            if node.kind != .file, node.kind != .boundary, let source = node.source,
               WorkingTreeSemantics.pageIDValues(in: source).count > 1 {
                throw WorkingTreeError.corruptState("Document contains duplicate PageIDs")
            }
            if let pageID = node.pageID, node.kind != .file, node.kind != .boundary {
                guard WorkingTreeSemantics.pageID(in: node.source ?? "") == pageID else {
                    throw WorkingTreeError.corruptState("Document PageID mismatch")
                }
            }
        }
    }

    private func refuseCollision(_ path: String, in state: WorkingTreeState) throws {
        if state.nodes.contains(where: { $0.path == path }) { throw WorkingTreeError.collision(path) }
    }

    private func prepareParentForChildren(_ parent: WorkingTreeNode, in state: inout WorkingTreeState) throws {
        guard parent.kind == .markdown else { return }
        guard let position = state.nodes.firstIndex(where: { $0.path == parent.path && $0.kind == .markdown }) else {
            throw WorkingTreeError.corruptState("Markdown parent disappeared before child creation")
        }
        state.nodes[position].kind = .directory
        state.nodes[position].directoryBodyPlacement = .siblingMarkdown
    }

    private func pruneEmptyTrashDirectories(_ state: inout WorkingTreeState) {
        var changed = true
        while changed {
            changed = false
            for node in state.nodes where node.kind == .directory && node.path.hasPrefix("/Trash/") && node.trashedFrom == nil {
                if !state.nodes.contains(where: { WorkingTreeSemantics.parent(of: $0.path) == node.path }) {
                    state.nodes.removeAll { $0.path == node.path }
                    changed = true
                    break
                }
            }
        }
        if !state.nodes.contains(where: { $0.path.hasPrefix("/Trash/") }) {
            state.nodes.removeAll { $0.path == "/Trash" }
        }
    }
}
