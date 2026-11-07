import OverstoryWorkspace
import OverstoryObjectStore
import Overstory
import Foundation
import OSLog

/// The node index of one tree plus the local objects it has produced, over a
/// state store (disk on iOS, memory on the Mac) and a layered object store
/// (the tree's own overlay in front of the platform's accepted bytes).
public actor WorkingTree {
    public typealias Clock = @Sendable () -> Date
    private static let log = Logger(subsystem: "org.arbor.native", category: "WorkingTree")

    private let store: any WorkingTreeStateStore
    private let overlay: any ObjectOverlay
    private let platform: any ObjectStore
    private let faultInjector: any WorkingTreeFaultInjector
    private let clock: Clock
    private var state: WorkingTreeState { didSet { snapshotMemo = nil } }
    /// `WorkingTreeProtocolCodec.snapshot(for: state)`, kept until `state`
    /// changes: a save reads it several times, and building it hashes every page.
    private var snapshotMemo: WorkingTreeSnapshot?
    /// Entries and directories of the last snapshot built, so the next one
    /// encodes and hashes only what changed.
    private let codecMemo = WorkingTreeSnapshotMemo()
    /// Positions in `state.nodes` by parent path, built on first use after a
    /// transaction. Derived metadata written in place keeps positions valid.
    private var childPositions: [String: [Int]]?
    private var control: WorkingTreeControl
    private var index: WorkingTreeSearchIndex
    private var terminal = false
    private var changeObservers: [UUID: AsyncStream<Int>.Continuation] = [:]
    /// Hashes the platform store could not serve on the last attempt. A file
    /// held by such a reference is presented as a placeholder until a later
    /// read succeeds.
    private var missingHashes: Set<String> = []
    /// The tree this one was forked from. A fork that loads a directory asks
    /// its parent to load it as well, so later forks start with it loaded.
    private var parent: WorkingTree?
    /// Whether an accepted state this tree installs keeps directories it has
    /// not loaded unloaded (Browse, Alongside Story Sync) rather than loading
    /// every one (Replica).
    private var loadsLazily = false
    /// The folder Story Sync keeps this tree in, when it runs alongside: a
    /// Markdown body is read from its file there when that file still reads
    /// as the accepted entry, and from the object sources otherwise.
    private var pageFolder: URL?
    /// A path read (tree operations §1.2.4) at an accepted root: the
    /// directories from the root down to a path and the objects it names, in
    /// one request. When set, a path with unloaded directories on the way is
    /// filled by one read instead of one per object.
    public typealias PathReader = @Sendable (_ root: String, _ path: String) async throws -> [String: Data]
    private var pathReader: PathReader?

    private init(
        store: any WorkingTreeStateStore,
        overlay: any ObjectOverlay,
        platform: any ObjectStore,
        faultInjector: any WorkingTreeFaultInjector,
        clock: @escaping Clock,
        state: WorkingTreeState,
        control: WorkingTreeControl,
        index: WorkingTreeSearchIndex,
        parent: WorkingTree? = nil,
        loadsLazily: Bool = false,
        pageFolder: URL? = nil
    ) {
        self.parent = parent
        self.loadsLazily = loadsLazily
        self.pageFolder = pageFolder
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
        let overlay = try DirectoryObjectStore(directory: files.objectsDirectory, retentionPolicy: .retainAll)
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
            let snapshot = try WorkingTreeProtocolCodec.snapshot(for: state)
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
            let snapshot = try WorkingTreeProtocolCodec.snapshot(for: state)
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
        if let snapshotMemo { return snapshotMemo }
        let snapshot = try WorkingTreeProtocolCodec.snapshot(for: state, memo: codecMemo)
        snapshotMemo = snapshot
        return snapshot
    }

    /// Local source views changed without changing the accepted projection.
    func invalidateDocumentViews() {
        for continuation in changeObservers.values { continuation.yield(control.generation) }
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
    func completeSnapshot() async throws -> ProtocolSnapshot {
        let sparse = try currentSnapshot()
        var objects: [ProtocolObjectEnvelope] = []
        objects.reserveCapacity(sparse.objects.count)
        for object in sparse.objects {
            let bytes: Data
            if let inline = object.bytes { bytes = inline } else { bytes = try await objectBytes(hash: object.hash) }
            objects.append(ProtocolObjectEnvelope(hash: object.hash, bytes: bytes))
        }
        return ProtocolSnapshot(root: sparse.root, objects: objects)
    }

    /// The current graph as far as this tree's own bytes go: every object the
    /// state carries inline plus every referenced object the overlay holds.
    /// Platform-served files are omitted, so the result validates in
    /// `.lazyDirectories`; nothing is fetched. Candidate bodies and durable heads
    /// are cut from this, never from the platform store.
    public func localSnapshot() throws -> ProtocolSnapshot {
        let sparse = try currentSnapshot()
        var objects: [ProtocolObjectEnvelope] = []
        objects.reserveCapacity(sparse.objects.count)
        for object in sparse.objects {
            if let inline = object.bytes {
                objects.append(ProtocolObjectEnvelope(hash: object.hash, bytes: inline))
            } else if let held = try overlay.storedBytes(object.hash) {
                objects.append(ProtocolObjectEnvelope(hash: object.hash, bytes: held))
            }
        }
        return ProtocolSnapshot(root: sparse.root, objects: objects)
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
        var files = Set<String>()
        for node in state.nodes where node.kind == .file {
            if case let .hash(hash, _, _)? = node.ref { files.insert(hash) }
        }
        do { try overlay.retain(reachableFrom: roots, files: files) } catch {
            // Collection is best effort: unreachable bytes only cost space.
            Self.log.error("overlay collection failed: \(String(describing: error), privacy: .public)")
        }
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

    public func replaceFromSystem(_ replacement: WorkingTreeSystemReplacement) throws {
        try requireOpen()
        guard control.pendingRoot == nil else { throw WorkingTreeError.pendingLocalChanges }
        try replaceWithAccepted(replacement, mutation: "system-replacement")
    }

    private func replaceWithAccepted(_ replacement: WorkingTreeSystemReplacement, mutation: String) throws {
        let replacementState = try state(from: replacement)
        let computed = try WorkingTreeProtocolCodec.snapshot(for: replacementState, memo: codecMemo)
        guard computed.root == replacement.root else { throw WorkingTreeError.corruptState("System replacement root mismatch") }
        // Collection objects are referenced from the state, not carried in it;
        // the overlay holds them first, and retention keeps what stays reachable.
        try overlay.store(replacement.nodes.reduce(into: [String: Data]()) { $0.merge($1.collectionObjects) { first, _ in first } })
        try transact(
            mutation: mutation,
            pageKey: "_system",
            accepted: (replacement.root, replacement.update, replacement.cursor),
            recordsModificationDates: mutation != "initialize-from-system",
            changedAt: replacement.acceptedAt,
            snapshot: computed
        ) { next in
            next = replacementState
        }
    }

    /// An in-memory copy of this tree that keeps every node's metadata outside
    /// the hashes (modification dates, file sizes). It reads objects through
    /// this tree's overlay and then this tree, and never writes back to it.
    func fork() throws -> WorkingTree {
        try requireOpen()
        let fork = WorkingTree(
            store: DisposableWorkingTreeStore(),
            overlay: ForkedObjectOverlay(parent: overlay),
            platform: self,
            faultInjector: NoReplicaFaults(),
            clock: clock,
            state: state,
            control: control,
            index: index,
            parent: self,
            loadsLazily: loadsLazily,
            // Bodies the parent has not loaded still come from the folder.
            // Path reads stay with the parent, which a fork asks first.
            pageFolder: pageFolder
        )
        return fork
    }

    /// Dates from the host's entry metadata, keyed by entry path. They describe
    /// `update`: when that is this tree's accepted, materialized state they
    /// are authoritative; otherwise they only date nodes that have no date.
    /// Content and hashes are untouched.
    public func applyEntryDates(_ dates: [String: Date], update: String) throws {
        try requireOpen()
        let exact = control.acceptedUpdate == update && control.acceptedRoot == control.materializedRoot
        var next = state, changed = false
        for index in next.nodes.indices {
            guard let entry = next.nodes[index].bodyEntryPath, let date = dates[entry],
                  exact || next.nodes[index].modifiedAt == nil, next.nodes[index].modifiedAt != date else { continue }
            next.nodes[index].modifiedAt = date
            changed = true
        }
        guard changed else { return }
        try transact(mutation: "entry-metadata", pageKey: "_system", recordsModificationDates: false) { $0 = next }
    }

    /// Replace a fork's nodes with a local candidate. Unlike an accepted
    /// replacement this ignores pending work: a fork is a disposable view.
    /// Modification dates carry over by page ID and path, and changed or new
    /// pages are stamped now.
    func project(_ replacement: WorkingTreeSystemReplacement) throws {
        try requireOpen()
        try replaceWithAccepted(replacement, mutation: "local-projection")
    }

    func state(from replacement: WorkingTreeSystemReplacement) throws -> WorkingTreeState {
        guard !replacement.update.isEmpty else { throw WorkingTreeError.corruptState("System update ID is empty") }
        // Earlier file references by path, built once rather than searched per file.
        var priorFiles: [String: ContentRef]?
        func priorRef(_ path: String) -> ContentRef? {
            if priorFiles == nil {
                priorFiles = Dictionary(state.nodes.compactMap { node in node.ref.map { (node.path, $0) } }, uniquingKeysWith: { first, _ in first })
            }
            return priorFiles?[path]
        }
        let nodes = replacement.nodes.map { node -> WorkingTreeNode in
            switch node.content {
            case let .directory(source):
                return WorkingTreeNode(
                    path: node.path,
                    pageID: node.pageID ?? source.flatMap(WorkingTreeSemantics.pageID(in:)),
                    kind: .directory,
                    source: source,
                    collection: node.collection,
                    collectionObjects: node.collectionObjects.isEmpty ? nil : node.collectionObjects.keys.sorted(),
                    directoryBodyPlacement: node.directoryBodyPlacement,
                    shadowedSiblingMarkdownSource: node.shadowedSiblingMarkdownSource,
                    metadata: node.metadata,
                    subtree: node.unloadedDirectory
                )
            case let .markdown(source):
                return WorkingTreeNode(path: node.path, pageID: node.pageID ?? WorkingTreeSemantics.pageID(in: source), kind: .markdown, source: source, metadata: node.metadata)
            case let .file(ref, mediaType):
                var reference = ref
                if case let .hash(hash, size, type) = ref, size == nil,
                   let previous = priorRef(node.path), previous.objectHash == hash {
                    reference = .hash(hash, size: previous.size, mediaType: type ?? previous.mediaType)
                }
                return WorkingTreeNode(path: node.path, pageID: node.pageID, kind: .file, ref: reference, mediaType: mediaType ?? reference.mediaType, metadata: node.metadata)
            case let .boundary(tree):
                return WorkingTreeNode(path: node.path, kind: .boundary, boundaryTree: tree.rawValue)
            }
        }
        return WorkingTreeState(tree: state.tree, nodes: replacement.pages ? keepingPageSpellings(nodes) : nodes,
                                pages: replacement.pages ? true : nil)
    }

    /// A page reads back from many files: where this replica's source already
    /// reads as the page a replacement brings, keep its spelling, so front
    /// matter's quoting and comments stay put (directory format §3).
    private func keepingPageSpellings(_ nodes: [WorkingTreeNode]) -> [WorkingTreeNode] {
        let previous = Dictionary(state.nodes.map { ($0.path, $0) }, uniquingKeysWith: { first, _ in first })
        func kept(_ next: String?, _ old: String?) -> String? {
            guard let next, let old, next != old, let page = ProtocolPage.parse(Data(next.utf8)),
                  page.isHeld(by: Data(old.utf8)) else { return next }
            return old
        }
        return nodes.map { node in
            guard let old = previous[node.path], old.kind == node.kind else { return node }
            var node = node
            node.source = kept(node.source, old.source)
            node.shadowedSiblingMarkdownSource = kept(node.shadowedSiblingMarkdownSource, old.shadowedSiblingMarkdownSource)
            if node.kind == .file, ProtocolPage.isPageName(WorkingTreeSemantics.name(of: node.path)),
               case let .inline(bytes)? = node.ref, case let .inline(oldBytes)? = old.ref,
               bytes != oldBytes, let page = ProtocolPage.parse(bytes), page.isHeld(by: oldBytes) {
                node.ref = old.ref
            }
            return node
        }
    }

    // MARK: Lazy directories (Clients 003 module 3)

    /// Install accepted states lazily from now on: directories this tree has
    /// not loaded stay unloaded (Browse, Alongside Story Sync).
    public func loadDirectoriesLazily() {
        loadsLazily = true
    }

    /// Keep `objects` (a path read's answer), each checked against its hash,
    /// so the directories and bodies they hold load without another read.
    public func hold(_ objects: [String: Data]) throws {
        try requireOpen()
        var verified: [String: Data] = [:]
        for (hash, bytes) in objects { verified[hash] = try verifyObject(bytes, hash: hash) }
        try overlay.store(verified)
    }

    /// Fill paths with `reader` (the host's path read, or Story Sync's on loopback).
    public func readPaths(with reader: PathReader?) {
        pathReader = reader
    }

    /// Read Markdown bodies from `folder` first (Alongside Story Sync).
    public func readPages(from folder: URL?) {
        pageFolder = folder
    }

    /// The object for Markdown `entry` of the directory at `directory`, from
    /// the page folder: only when the file there rebuilds exactly the entry's
    /// hash, so a file the person is editing, or one Story Sync has not yet
    /// rewritten, is never shown as the accepted page.
    private func folderBody(_ entry: ProtocolDirectoryEntry, in directory: String) -> Data? {
        guard let pageFolder, let expected = entry.hash else { return nil }
        let url = directory.split(separator: "/").reduce(pageFolder) { $0.appending(path: String($1)) }.appending(path: entry.name)
        guard let bytes = try? Data(contentsOf: url) else { return nil }
        var object: Data?
        let rebuilt = ProtocolDirectoryEntry.markdown(name: entry.name, bytes: bytes, pages: entry.page != nil) { encoded in
            object = encoded
            return ProtocolObjectCodec.hash(encoded)
        }
        guard rebuilt.hash == expected, (rebuilt.page != nil) == (entry.page != nil), let object else { return nil }
        return object
    }

    /// Whether some directory is still waiting to load. Search and backlinks
    /// see only what is loaded.
    public func hasUnloadedDirectories() -> Bool {
        state.nodes.contains { $0.subtree != nil }
    }

    /// Load every directory on the way to `path`, `path` itself when it is a
    /// directory, and, with `children`, each directory directly inside it, so
    /// a listing shows which children have bodies. A path that does not
    /// exist loads what is above it and stops. A fork asks the tree it was
    /// forked from to load the same path first.
    public func ensureLoaded(_ path: String, children: Bool = false) async throws {
        try requireOpen()
        guard let target = try? WorkingTreeSemantics.normalizePath(path) else { return }
        if let parent { try? await parent.ensureLoaded(target, children: children) }
        var prefix = "/"
        var prefixes = ["/"]
        for name in target.split(separator: "/") {
            prefix = prefix == "/" ? "/\(name)" : "\(prefix)/\(name)"
            prefixes.append(prefix)
        }
        // One path read brings every directory on the way, held before the
        // loads below read them; a failed read leaves them to the object sources.
        if let pathReader, let root = control.acceptedRoot,
           prefixes.contains(where: { prefix in state.nodes.contains { $0.path == prefix && $0.subtree != nil } }),
           let objects = try? await pathReader(root, target) {
            try? hold(objects)
        }
        for path in prefixes {
            guard let node = state.nodes.first(where: { $0.path == path }) else { return }
            if let hash = node.subtree { try await load([(path: path, hash: hash)]) }
        }
        guard children else { return }
        try await load(childNodes(of: target).compactMap { child in child.subtree.map { (path: child.path, hash: $0) } })
    }

    /// Load every directory at or below `path`: what a copy needs.
    public func loadSubtree(_ path: String) async throws {
        try await ensureLoaded(path)
        guard let target = try? WorkingTreeSemantics.normalizePath(path) else { return }
        if let parent { try? await parent.loadSubtree(target) }
        try await loadAll { $0 == target || WorkingTreeSemantics.isDescendant($0, of: target) }
    }

    /// Load every directory: what search needs, and what a page ID that is
    /// not among the loaded pages needs to resolve.
    public func loadEverything() async throws {
        try requireOpen()
        // The parent loads first (bodies from its folder, objects into the
        // overlay this fork reads), so the fork's own pass reads nothing new.
        if let parent { try? await parent.loadEverything() }
        try await loadAll { _ in true }
    }

    /// Load the unloaded directories whose paths pass `included`, a level at a time.
    private func loadAll(_ included: (String) -> Bool) async throws {
        while true {
            let level: [(path: String, hash: String)] = state.nodes.compactMap { node in
                guard let hash = node.subtree, included(node.path) else { return nil }
                return (path: node.path, hash: hash)
            }
            if level.isEmpty { return }
            try await load(level)
            // A pass that loaded none of them must not spin.
            if level.allSatisfy({ item in state.nodes.contains { $0.path == item.path && $0.subtree == item.hash } }) { return }
        }
    }

    /// One object through `objectBytes`, then `fallback`, checked against its hash.
    private func readObject(_ hash: String, fallback: (@Sendable (String) async throws -> Data)?) async throws -> Data {
        do { return try await objectBytes(hash: hash) }
        catch ObjectStoreError.missing {
            guard let fallback else { throw ObjectStoreError.missing(hash) }
            return try verifyObject(try await fallback(hash), hash: hash)
        }
    }

    /// Read `hashes` concurrently (at most `width` at once).
    private func readObjects(_ hashes: [String], fallback: (@Sendable (String) async throws -> Data)?, width: Int = 16) async throws -> [String: Data] {
        var result: [String: Data] = [:]
        var index = 0
        while index < hashes.count {
            let batch = hashes[index..<min(index + width, hashes.count)]
            index += batch.count
            try await withThrowingTaskGroup(of: (String, Data).self) { group in
                for hash in batch { group.addTask { (hash, try await self.readObject(hash, fallback: fallback)) } }
                for try await (hash, bytes) in group { result[hash] = bytes }
            }
        }
        return result
    }

    /// The directory object `hash` with the objects a node needs from it: its
    /// Markdown bodies and its collection's tables and rows, each checked
    /// against its hash. A body comes from the overlay, then the page folder,
    /// then the object sources; the reads run concurrently. Child directories
    /// are not read.
    private func directoryObjects(_ hash: String, at path: String, fallback: (@Sendable (String) async throws -> Data)? = nil) async throws -> [ProtocolObjectEnvelope] {
        let bytes = try await readObject(hash, fallback: fallback)
        guard case let .directory(entries, collection) = try ProtocolObjectCodec.decode(bytes, kind: .directory) else {
            throw ProtocolValidationError.incompleteGraph(hash)
        }
        var found: [String: Data] = [:]
        var wanted: [String] = []
        for entry in entries where entry.directory == nil {
            guard let child = entry.hash, entry.page != nil || entry.name.hasSuffix(".md") || entry.name.hasSuffix(".mdx"),
                  found[child] == nil, !wanted.contains(child) else { continue }
            if let local = try overlay.storedBytes(child) { found[child] = local }
            else if let file = folderBody(entry, in: path) { found[child] = file }
            else { wanted.append(child) }
        }
        let tables = collection?.tables.map(\.table) ?? []
        found.merge(try await readObjects(wanted + tables, fallback: fallback)) { first, _ in first }
        var chunks: [String] = []
        for table in tables {
            guard let tableBytes = found[table], case let .table(object) = try ProtocolObjectCodec.decode(tableBytes, kind: .table) else { continue }
            chunks += object.chunks.map(\.chunk)
        }
        found.merge(try await readObjects(chunks, fallback: fallback)) { first, _ in first }
        return [ProtocolObjectEnvelope(hash: hash, bytes: bytes)]
            + found.filter { $0.key != hash }.map { ProtocolObjectEnvelope(hash: $0.key, bytes: $0.value) }.sorted { $0.hash < $1.hash }
    }

    /// `directoryObjects` for several directories at once.
    private func directoriesObjects(_ directories: [(path: String, hash: String)], fallback: (@Sendable (String) async throws -> Data)? = nil) async throws -> [Int: [ProtocolObjectEnvelope]] {
        try await withThrowingTaskGroup(of: (Int, [ProtocolObjectEnvelope]).self) { group in
            for (position, directory) in directories.enumerated() {
                group.addTask { (position, try await self.directoryObjects(directory.hash, at: directory.path, fallback: fallback)) }
            }
            var result: [Int: [ProtocolObjectEnvelope]] = [:]
            for try await (position, objects) in group { result[position] = objects }
            return result
        }
    }

    /// The accepted graph at `root` as far as this tree holds it: every
    /// directory a lazy tree has loaded (by path), or every directory, with
    /// their Markdown bodies and collections. Objects come through
    /// `objectBytes`, so unchanged ones are local; `fallback` serves what the
    /// stores lack. Each level is read concurrently. Replaces the catch-up
    /// spine walk.
    public func acceptedGraph(root: String, fallback: (@Sendable (String) async throws -> Data)? = nil) async throws -> ProtocolSnapshot {
        try requireOpen()
        let loaded = Set(state.nodes.lazy.filter { $0.kind == .directory && $0.subtree == nil }.map(\.path))
        var objects: [String: Data] = [:]
        var level: [(path: String, hash: String)] = [(path: "/", hash: root)], seen = Set<String>()
        while !level.isEmpty {
            level = level.filter { seen.insert($0.hash).inserted }
            let read = try await directoriesObjects(level, fallback: fallback)
            var next: [(path: String, hash: String)] = []
            for (position, directory) in level.enumerated() {
                guard let envelopes = read[position] else { continue }
                for object in envelopes { objects[object.hash] = object.bytes }
                guard case let .directory(entries, _) = try ProtocolObjectCodec.decode(envelopes[0].bytes, kind: .directory) else { continue }
                for entry in entries {
                    guard let child = entry.directory else { continue }
                    let path = WorkingTreeSemantics.child(entry.name, of: directory.path)
                    if !loadsLazily || loaded.contains(path) { next.append((path: path, hash: child)) }
                }
            }
            level = next
        }
        let graph = ProtocolSnapshot(root: root, objects: objects.map { ProtocolObjectEnvelope(hash: $0.key, bytes: $0.value) }.sorted { $0.hash < $1.hash })
        _ = try ProtocolObjectGraph.validate(graph, mode: .lazyDirectories)
        return graph
    }

    /// `graph` (an earlier candidate or accepted graph, cut when fewer
    /// directories were loaded) with the directories `candidate` changes
    /// filled in: wherever both name a directory at the same path, the
    /// candidate holds it and the hashes differ, the base directory is read
    /// (with its bodies and collection) so a change can be computed between
    /// them. Unchanged directories are left as they are.
    public func hydrating(_ graph: ProtocolSnapshot, toward candidate: ProtocolSnapshot) async throws -> ProtocolSnapshot {
        try requireOpen()
        var objects = Dictionary(graph.objects.map { ($0.hash, $0.bytes) }, uniquingKeysWith: { first, _ in first })
        let held = Dictionary(candidate.objects.map { ($0.hash, $0.bytes) }, uniquingKeysWith: { first, _ in first })
        func entries(_ bytes: Data?) throws -> [ProtocolDirectoryEntry] {
            guard let bytes, case let .directory(entries, _) = try ProtocolObjectCodec.decode(bytes, kind: .directory) else { return [] }
            return entries
        }
        var pending: [(base: String, next: String, path: String)] = [(graph.root, candidate.root, "/")]
        var added = false
        while let pair = pending.popLast() {
            guard pair.base != pair.next, let nextBytes = held[pair.next] else { continue }
            if objects[pair.base] == nil {
                // A base directory no source still holds stays out; the change
                // is then computed as before, from what the graph has.
                guard let read = try? await directoryObjects(pair.base, at: pair.path) else { continue }
                for object in read where objects[object.hash] == nil { objects[object.hash] = object.bytes }
                added = true
            }
            let nextEntries = try entries(nextBytes)
            for entry in try entries(objects[pair.base]) {
                guard let base = entry.directory,
                      let next = nextEntries.first(where: { $0.name == entry.name })?.directory else { continue }
                pending.append((base, next, WorkingTreeSemantics.child(entry.name, of: pair.path)))
            }
        }
        guard added else { return graph }
        let result = ProtocolSnapshot(root: graph.root, objects: objects.map { ProtocolObjectEnvelope(hash: $0.key, bytes: $0.value) }.sorted { $0.hash < $1.hash })
        _ = try ProtocolObjectGraph.validate(result, mode: .lazyDirectories)
        return result
    }

    /// Read the unloaded directories in `directories` (concurrently) and
    /// splice their entries into the state. Nothing hashed changes, so the
    /// result must have the same root: a directory whose bytes do not rebuild
    /// the accepted hash is refused.
    private func load(_ directories: [(path: String, hash: String)]) async throws {
        guard !directories.isEmpty else { return }
        let read = try await directoriesObjects(directories)
        var next = state
        var stored: [String: Data] = [:]
        for (position, directory) in directories.enumerated() {
            guard let objects = read[position] else { continue }
            // Another load may have finished, or an install moved on, while this one read.
            guard let slot = next.nodes.firstIndex(where: { $0.path == directory.path }),
                  next.nodes[slot].subtree == directory.hash else { continue }
            let (node, children, pages) = try spliced(next.nodes[slot], hash: directory.hash, objects: objects)
            next.nodes[slot] = node
            next.nodes.append(contentsOf: children)
            if pages { next.pages = true }
            for object in objects { stored[object.hash] = object.bytes }
        }
        guard !stored.isEmpty else { return }
        let snapshot = try WorkingTreeProtocolCodec.snapshot(for: next, memo: codecMemo)
        guard snapshot.root == control.materializedRoot else {
            throw WorkingTreeError.corruptState("A loaded directory does not rebuild the accepted root")
        }
        try Self.validate(next, control: nil, checked: state)
        // Kept so a later install or replay reads them locally.
        try overlay.store(stored)
        state = next
        snapshotMemo = snapshot
        childPositions = nil
        index = makeIndex(state: state, generation: control.generation)
    }

    /// The unloaded directory `current` once its object `hash` and `objects`
    /// are read: the node itself, its children, and whether they hold pages.
    private func spliced(_ current: WorkingTreeNode, hash: String, objects: [ProtocolObjectEnvelope]) throws -> (WorkingTreeNode, [WorkingTreeNode], Bool) {
        let path = current.path
        let graph = ProtocolSnapshot(root: hash, objects: objects)
        let replacement = try SnapshotBridge.replacement(snapshot: graph, tree: treeID(), update: control.acceptedUpdate ?? "lazy",
                                                         mode: .lazyDirectories)
        var nodes = replacement.nodes
        guard let top = nodes.firstIndex(where: { $0.path == "/" }) else { throw WorkingTreeError.corruptState("Loaded directory has no root") }
        let body = nodes.remove(at: top)
        for position in nodes.indices { nodes[position].path = path + nodes[position].path }
        var directory = current
        directory.subtree = nil
        directory.collection = body.collection
        directory.collectionObjects = body.collectionObjects.isEmpty ? nil : body.collectionObjects.keys.sorted()
        if case let .directory(source?) = body.content {
            // `_index.md` holds the body; a sibling `<name>.md` is then shadowed.
            directory.shadowedSiblingMarkdownSource = current.directoryBodyPlacement == .siblingMarkdown ? current.source : nil
            directory.directoryBodyPlacement = nil
            directory.source = source
            directory.pageID = WorkingTreeSemantics.pageID(in: source)
        }
        let children = try state(from: WorkingTreeSystemReplacement(root: hash, update: replacement.update, nodes: nodes, pages: replacement.pages)).nodes
        return (directory, children, replacement.pages)
    }

    func deleteRebuildableIndexes() throws {
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
        let snapshot = try WorkingTreeProtocolCodec.snapshot(for: state)
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
        let path = try WorkingTreeSemantics.normalizePath(reference.path)
        if let pageID = markdownID(fromStableKey: reference.stableKey) {
            let owners = state.nodes.filter { $0.pageID == pageID }
            // A copy in Trash answers only to its own path while a live page holds the ID.
            if Self.isTrashed(path), let trashed = owners.first(where: { $0.path == path }) { return trashed }
            let live = owners.filter { !Self.isTrashed($0.path) }
            if live.count > 1 { throw WorkingTreeError.duplicatePageID(paths: live.map(\.path)) }
            if let node = live.first ?? owners.first { return node }
        }
        guard let node = state.nodes.first(where: { $0.path == path }) else { throw WorkingTreeError.notFound(reference) }
        return node
    }

    private static func isTrashed(_ path: String) -> Bool {
        path == "/Trash" || path.hasPrefix("/Trash/")
    }

    func children(of reference: WorkspaceReference) throws -> [WorkingTreeNode] {
        let parent = try resolve(reference)
        guard parent.kind == .directory else { throw WorkingTreeError.notDirectory(reference) }
        return childNodes(of: parent.path).filter { !WorkingTreeSemantics.isStoreFile($0) }
            .sorted { WorkingTreeSemantics.compareUTF8($0.path, $1.path) }
    }

    private func childNodes(of path: String) -> [WorkingTreeNode] {
        let positions: [String: [Int]]
        if let childPositions { positions = childPositions } else {
            var built: [String: [Int]] = [:]
            for (position, node) in state.nodes.enumerated() {
                if let parent = WorkingTreeSemantics.parent(of: node.path) { built[parent, default: []].append(position) }
            }
            childPositions = built
            positions = built
        }
        return (positions[path] ?? []).map { state.nodes[$0] }
    }

    func completeSource(for node: WorkingTreeNode) -> String? {
        switch node.kind {
        case .markdown: node.source ?? ""
        case .directory: node.source ?? ""
        case .file, .boundary: nil
        }
    }

    func revision(for node: WorkingTreeNode) -> String {
        WorkingTreeSemantics.documentRevision(node: node, children: node.kind == .directory ? childNodes(of: node.path) : [])
    }

    func collection(for directory: WorkingTreeNode) async -> (kind: String, rows: Int?)? {
        guard directory.kind == .directory else { return nil }
        // A logical collection's rows are in the tree. A one-table collection
        // counts its rows without the schema; with more tables, only the
        // schema says which one is the main model's.
        if let reference = directory.collection {
            if reference.tables.isEmpty { return ("Collection", 0) }
            guard reference.tables.count == 1,
                  let bytes = try? await objectBytes(hash: reference.tables[0].table),
                  case let .table(table)? = try? ProtocolObjectCodec.decode(bytes, kind: .table) else { return ("Collection", nil) }
            return ("Collection", table.rows)
        }
        guard let storeFile = childNodes(of: directory.path).first(where: WorkingTreeSemantics.isStoreFile) else { return nil }
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
        default: return nil
        }
    }

    /// A logical collection's checked schema and its rows as data-file layout
    /// rows (Schema language 006): read-only, from the tree's own objects.
    func collectionRows(for directory: WorkingTreeNode) async throws -> WorkspaceCollectionRows {
        guard directory.kind == .directory, let reference = directory.collection else { throw WorkspaceCollectionError.notCollection }
        guard let schemaFile = childNodes(of: directory.path).first(where: { WorkingTreeSemantics.name(of: $0.path) == "schema.usl" }) else {
            throw WorkspaceCollectionError.noSchema
        }
        let schema = compileUSL(String(decoding: try await payload(of: schemaFile), as: UTF8.self))
        if let first = schema.diagnostics.first { throw WorkspaceCollectionError.schema(first.message) }
        var tables: USLLogicalTables = [:]
        do {
            for table in reference.tables {
                guard case let .table(object) = try ProtocolObjectCodec.decode(try await objectBytes(hash: table.table), kind: .table) else { continue }
                var rows: [USLLogicalRow] = []
                for chunk in object.chunks {
                    rows += try ProtocolObjectCodec.decodeRows(try await objectBytes(hash: chunk.chunk)).map(Self.logicalRow)
                }
                tables[table.model] = rows
            }
        } catch ObjectStoreError.missing {
            throw WorkspaceCollectionError.missingRows
        }
        do {
            let layout = try uslLayout(schema, store: .files)
            return WorkspaceCollectionRows(schema: schema, rows: try uslRowsFromLogical(schema, layout: layout, tables: tables))
        } catch let error as USLLayoutError {
            throw WorkspaceCollectionError.unreadable(error.message)
        }
    }

    private static func logicalRow(_ row: ProtocolLogicalRow) -> USLLogicalRow {
        USLLogicalRow(
            key: row.key.map { USLKeyPart(name: $0.field, value: jsonValue($0.value)) },
            fields: row.fields.mapValues(jsonValue),
            created: row.created,
            modified: row.modified
        )
    }

    private static func jsonValue(_ value: ProtocolReadValue) -> JSONValue {
        switch value {
        case .null: .null
        case .bool(let flag): .bool(flag)
        case .number(let n): .number(n)
        case .string(let text): .string(text)
        case .array(let items): .array(items.map(jsonValue))
        case .object(let members): .object(members.mapValues(jsonValue))
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
        for source in index.entries {
            for link in source.links where link.tree == nil || link.tree == state.tree {
                inboundByPath[link.path, default: []].insert(source.path)
                if let stableKey = link.stableKey {
                    inboundByStableKey[stableKey, default: []].insert(source.path)
                }
            }
        }
        return Dictionary(uniqueKeysWithValues: index.entries.map { target in
            var sources = inboundByPath[target.path, default: []]
            if let pageID = target.pageID {
                sources.formUnion(inboundByStableKey[markdownStableKey(pageID), default: []])
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
            guard !next.nodes.contains(where: { $0.pageID == pageID && !Self.isTrashed($0.path) }) else { throw WorkingTreeError.collision("PageID \(pageID)") }
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
        let digest = String(ProtocolObjectCodec.hash(asset.bytes).dropFirst("sha256:".count))
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
            guard case let .file(payload) = try ProtocolObjectCodec.decode(object, kind: .file) else {
                throw WorkingTreeError.corruptState("File reference \(hash) is not a file object")
            }
            // This is derived metadata; it does not admit a new content generation.
            if let index = state.nodes.firstIndex(where: { $0.path == node.path && $0.ref?.objectHash == hash }) {
                state.nodes[index].ref = .hash(hash, size: payload.count, mediaType: state.nodes[index].ref?.mediaType)
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
        guard parent.kind == .directory || parent.kind == .markdown else { throw WorkingTreeError.notDirectory(destination) }
        guard !WorkingTreeSemantics.isDescendant(parent.path, of: node.path), parent.path != node.path else {
            throw WorkingTreeError.invalidPath(parent.path)
        }
        return try relocate(node, to: WorkingTreeSemantics.child(WorkingTreeSemantics.name(of: node.path), of: parent.path), mutation: "move", parent: parent)
    }

    @discardableResult
    func copy(_ reference: WorkspaceReference, destination: WorkspaceReference) throws -> WorkingTreeNode {
        let node = try resolve(reference)
        let parent = try resolve(destination)
        guard parent.kind == .directory || parent.kind == .markdown else { throw WorkingTreeError.notDirectory(destination) }
        guard parent.path != node.path, !WorkingTreeSemantics.isDescendant(parent.path, of: node.path) else {
            throw WorkingTreeError.invalidPath(parent.path)
        }
        let target = WorkingTreeSemantics.child(WorkingTreeSemantics.name(of: node.path), of: parent.path)
        var copied: WorkingTreeNode!
        try transact(mutation: "copy", pageKey: node.pageID ?? "_tree") { next in
            try prepareParentForChildren(parent, in: &next)
            try refuseCollision(target, in: next)
            let sourceNodes = next.nodes.filter { $0.path == node.path || WorkingTreeSemantics.isDescendant($0.path, of: node.path) }
            // A copy gives every page a new ID, so it needs every page loaded.
            if let unloaded = sourceNodes.first(where: { $0.subtree != nil }) {
                throw WorkingTreeError.corruptState("\(unloaded.path) must load before it is copied")
            }
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
            // A page moved back to this tree while its old copy stayed in Trash holds the ID now.
            let restoring = next.nodes.filter { $0.path == node.path || WorkingTreeSemantics.isDescendant($0.path, of: node.path) }
            for pageID in restoring.compactMap(\.pageID) {
                if let live = next.nodes.first(where: { $0.pageID == pageID && !Self.isTrashed($0.path) }) {
                    throw WorkingTreeError.collision(live.path)
                }
            }
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

    /// Capture source, tree graph and accepted identity atomically. This does not
    /// pin the live projection or discard newer work when the editor submits later.
    /// Capture identity and graph in one actor turn for structural admission.
    func captureLocalTrash() throws -> WorkingTreeLocalTrash {
        let nodes = state.nodes.filter { $0.path == "/Trash" || $0.path.hasPrefix("/Trash/") }
        var objects: [ProtocolObjectEnvelope] = []
        for hash in Set(nodes.compactMap { $0.ref?.objectHash }).sorted() {
            if let bytes = try overlay.storedBytes(hash) { objects.append(.init(hash: hash, bytes: bytes)) }
        }
        return WorkingTreeLocalTrash(nodes: nodes, objects: objects)
    }

    /// Local trash never enters the protocol projection. Candidate staging restores
    /// it from the same durable record as the structural snapshot.
    func installLocalTrash(_ trash: WorkingTreeLocalTrash) throws {
        try trash.validate()
        try overlay.store(Dictionary(uniqueKeysWithValues: trash.objects.map { ($0.hash, $0.bytes) }))
        guard let root = control.acceptedRoot, let update = control.acceptedUpdate else {
            throw WorkingTreeError.corruptState("Trash staging requires an accepted graph")
        }
        try transact(mutation: "local-trash", pageKey: "_tree", accepted: (root, update, control.acceptedCursor),
                     recordsModificationDates: false) { next in
            next.nodes.removeAll { $0.path == "/Trash" || $0.path.hasPrefix("/Trash/") }
            next.nodes.append(contentsOf: trash.nodes)
        }
    }

    func captureAcceptedGraph() throws -> (base: ProtocolUpdateBase, graph: ProtocolSnapshot) {
        let graph = try localSnapshot()
        guard control.pendingRoot == nil, let root = control.acceptedRoot,
              let update = control.acceptedUpdate, root == graph.root else {
            throw ProtocolValidationError.invalidValue("Legacy local work has no admission dependency")
        }
        return (ProtocolUpdateBase(root: root, update: update), graph)
    }

    public func captureSourceBasis(_ reference: WorkspaceReference) throws -> CapturedSourceBasis {
        let (document, sourcePath) = try captureSourceDocument(reference)
        let graph = try localSnapshot()
        let accepted: ProtocolUpdateBase?
        if control.pendingRoot == nil, let root = control.acceptedRoot, let update = control.acceptedUpdate, root == graph.root {
            accepted = ProtocolUpdateBase(root: root, update: update)
        } else { accepted = nil }
        return CapturedSourceBasis(document: document, graph: graph, accepted: accepted, sourcePath: sourcePath)
    }

    /// The document `reference` names and the path of its source file,
    /// without the tree's snapshot.
    func captureSourceDocument(_ reference: WorkspaceReference) throws -> (document: WorkspaceDocumentSnapshot, sourcePath: String) {
        let node = try resolve(reference)
        guard node.kind == .markdown || node.kind == .directory else { throw WorkingTreeError.notDocument(reference) }
        let sourcePath = node.kind == .markdown || node.directoryBodyPlacement == .siblingMarkdown
            ? node.path + ".md" : (node.path == "/" ? "/_index.md" : node.path + "/_index.md")
        return (try documentSnapshot(reference), sourcePath)
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
                guard !next.nodes.contains(where: { $0.pageID == admittedID && !Self.isTrashed($0.path) }) else {
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
    ) throws -> WorkspaceDocumentSnapshot {
        let current = try documentSnapshot(reference)
        guard current.contentRevision == patch.baseContentRevision else {
            throw WorkingTreeError.staleRevision(expected: patch.baseContentRevision, actual: current.contentRevision)
        }
        return try writeDocument(reference, source: try patch.applying(to: current.source), baseRevision: patch.baseContentRevision)
    }

    func workspaceReference(_ node: WorkingTreeNode) -> WorkspaceReference {
        WorkspaceReference(
            tree: TreeID(rawValue: state.tree),
            path: node.path,
            stableKey: node.pageID.map(markdownStableKey)
        )
    }

    public func treeID() -> TreeID { TreeID(rawValue: state.tree) }

    private func relocate(_ node: WorkingTreeNode, to destination: String, mutation: String, parent: WorkingTreeNode? = nil) throws -> WorkingTreeNode {
        var moved: WorkingTreeNode!
        try transact(mutation: mutation, pageKey: node.pageID ?? "_tree") { next in
            if let parent { try prepareParentForChildren(parent, in: &next) }
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
        changedAt: Date? = nil,
        snapshot: WorkingTreeSnapshot? = nil,
        change: (inout WorkingTreeState) throws -> Void
    ) throws {
        try requireOpen()
        var next = state
        try change(&next)
        let changedAt = changedAt ?? clock()
        if recordsModificationDates {
            applyModificationDates(from: state, to: &next, changedAt: changedAt, incoming: accepted != nil)
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
            let token = store.keepsWrites ? try store.writeJournal(pageKey: pageKey, id: intent.id, try Self.encode(intent)) : ""
            try faultInjector.reached(.afterJournal)
            // Dates are outside the hashes, so a snapshot of the state before
            // they were stamped is the snapshot of `next`.
            try finish(intent, journalToken: token, injectFaults: true, snapshot: snapshot)
        } catch {
            terminal = true
            throw error
        }
    }

    private func applyModificationDates(
        from previous: WorkingTreeState,
        to next: inout WorkingTreeState,
        changedAt: Date,
        incoming: Bool
    ) {
        // Several nodes can hold a page ID (a copy in Trash, or a duplicate from elsewhere).
        let previousByPageID = Dictionary(
            previous.nodes.compactMap { node in node.pageID.map { ($0, node) } },
            uniquingKeysWith: { first, _ in first }
        )
        let previousByPath = Dictionary(uniqueKeysWithValues: previous.nodes.map { ($0.path, $0) })
        for index in next.nodes.indices {
            let candidate = next.nodes[index]
            let samePage = previousByPath[candidate.path].flatMap { $0.pageID == candidate.pageID ? $0 : nil }
            let old = samePage ?? candidate.pageID.flatMap { previousByPageID[$0] } ?? previousByPath[candidate.path]
            // A date the change itself carries (the host's accepted time) stands.
            // Local mutations start with a copy of the old node, including its
            // date. Only incoming replacements carry an authoritative new date.
            let stamp = incoming ? (candidate.modifiedAt ?? changedAt) : changedAt
            guard let old else {
                next.nodes[index].modifiedAt = stamp
                continue
            }
            // Unchanged content keeps all of its metadata; a change keeps the
            // other descriptive fields and moves only the date.
            next.nodes[index].metadata = old.metadata
            if old.withoutMetadata != candidate.withoutMetadata { next.nodes[index].modifiedAt = stamp }
        }
    }

    private func finish(_ intent: WorkingTreeMutationIntent, journalToken: String, injectFaults: Bool, snapshot computed: WorkingTreeSnapshot? = nil) throws {
        try Self.validate(intent.state, control: nil, checked: state)
        let snapshot = try computed ?? WorkingTreeProtocolCodec.snapshot(for: intent.state, memo: codecMemo)
        try overlay.store(snapshot.inlineObjectsByHash)
        if injectFaults { try faultInjector.reached(.afterObjects) }
        // Bytes the overlay now holds are referenced, not carried, from here on.
        var nextState = intent.state, referenced = false
        for position in nextState.nodes.indices {
            if case let .inline(bytes)? = nextState.nodes[position].ref {
                referenced = true
                nextState.nodes[position].ref = .hash(
                    ContentRef.inline(bytes).objectHash,
                    size: bytes.count,
                    mediaType: nextState.nodes[position].mediaType
                )
            }
        }
        if store.keepsWrites { try store.writeState(try Self.encode(nextState)) }
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
        // A tree whose store keeps nothing builds its index when first searched.
        let nextIndex: WorkingTreeSearchIndex
        if store.keepsWrites {
            try store.writeControl(try Self.encode(nextControl))
            if injectFaults { try faultInjector.reached(.afterControl) }
            nextIndex = makeIndex(state: nextState, generation: intent.generation)
            try store.writeIndex(try Self.encode(nextIndex))
            try store.removeJournal(token: journalToken)
        } else {
            nextIndex = index
        }
        state = nextState
        // Without inline bytes turned into references, the snapshot built
        // above is exactly the new state's.
        if !referenced { snapshotMemo = snapshot }
        childPositions = nil
        control = nextControl
        index = nextIndex
        // A disposable fork collects its in-memory overlay now and then, not
        // on every projection: collection walks every directory.
        if intent.acceptedRoot != nil, store.keepsWrites || intent.generation % 32 == 0 {
            retainOverlay(nextControl, state: nextState)
        }
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
           loaded.format == WorkingTreeSearchIndex.currentFormat,
           loaded.generation == control.generation {
            index = loaded
        } else {
            try rebuildIndex()
        }
    }

    private func rebuildIndex() throws {
        let rebuilt = makeIndex(state: state, generation: control.generation)
        if store.keepsWrites { try store.writeIndex(try Self.encode(rebuilt)) }
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
                    markdownBody: node.markdownBody,
                    title: WorkingTreeSemantics.title(for: node),
                    source: source,
                    links: WorkingTreeSemantics.linkTargets(in: source, sourceDirectory: WorkingTreeSemantics.sourceDirectory(for: node)),
                    modifiedAt: node.modifiedAt
                )
            }.sorted { WorkingTreeSemantics.compareUTF8($0.path, $1.path) }
        )
    }

    private func requireOpen() throws {
        if terminal { throw WorkingTreeError.closed }
    }

    /// `checked` is a state already validated: a node equal to its node at the
    /// same path passed the checks of the node alone and only has its place
    /// in the tree checked again.
    private static func validate(_ state: WorkingTreeState, control: WorkingTreeControl?, checked: WorkingTreeState? = nil) throws {
        guard state.schema == WorkingTreeState.currentSchema, !state.tree.isEmpty else {
            throw WorkingTreeError.corruptState("Unsupported working tree state")
        }
        if let control {
            guard control.schema == 1, control.tree == state.tree else { throw WorkingTreeError.corruptState("Replica control mismatch") }
            let snapshot = try WorkingTreeProtocolCodec.snapshot(for: state)
            guard snapshot.root == control.materializedRoot else { throw WorkingTreeError.corruptState("Materialized root does not match state") }
        }
        let paths = state.nodes.map(\.path)
        guard Set(paths).count == paths.count else { throw WorkingTreeError.corruptState("Duplicate logical path") }
        guard state.nodes.contains(where: { $0.path == "/" && $0.kind == .directory }) else {
            throw WorkingTreeError.corruptState("Missing root directory")
        }
        let directories = Set(state.nodes.lazy.filter { $0.kind == .directory }.map(\.path))
        let parents = Set(state.nodes.lazy.compactMap { WorkingTreeSemantics.parent(of: $0.path) })
        let known = checked.map { Dictionary($0.nodes.map { ($0.path, $0) }, uniquingKeysWith: { first, _ in first }) }
        for node in state.nodes {
            if let old = known?[node.path], old == node {
                if node.path != "/", let parent = WorkingTreeSemantics.parent(of: node.path), !directories.contains(parent) {
                    throw WorkingTreeError.corruptState("Missing parent directory for \(node.path)")
                }
                if node.kind == .boundary, parents.contains(node.path) {
                    throw WorkingTreeError.corruptState("Nested tree boundary has local children")
                }
                if node.subtree != nil, parents.contains(node.path) {
                    throw WorkingTreeError.corruptState("Unloaded directory has children")
                }
                continue
            }
            guard try WorkingTreeSemantics.normalizePath(node.path) == node.path else { throw WorkingTreeError.corruptState("Noncanonical path") }
            if node.path != "/" { try WorkingTreeSemantics.validateName(WorkingTreeSemantics.name(of: node.path)) }
            if node.path != "/", let parent = WorkingTreeSemantics.parent(of: node.path) {
                guard directories.contains(parent) else {
                    throw WorkingTreeError.corruptState("Missing parent directory for \(node.path)")
                }
            }
            if node.kind == .markdown, WorkingTreeSemantics.name(of: node.path) == "_index" {
                throw WorkingTreeError.corruptState("Reserved directory body appears as a Markdown child")
            }
            if node.kind == .file, WorkingTreeSemantics.name(of: node.path) == "_index.md" {
                throw WorkingTreeError.corruptState("Reserved directory body appears as an ordinary file")
            }
            if (node.collection != nil || node.collectionObjects != nil) && node.kind != .directory {
                throw WorkingTreeError.corruptState("A collection is attached to a non-directory node")
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
            if let subtree = node.subtree {
                guard node.kind == .directory, node.path != "/", !subtree.isEmpty, !parents.contains(node.path),
                      node.source == nil || node.directoryBodyPlacement == .siblingMarkdown,
                      node.collection == nil, node.shadowedSiblingMarkdownSource == nil else {
                    throw WorkingTreeError.corruptState("Malformed unloaded directory \(node.path)")
                }
            }
            if node.kind == .boundary {
                guard node.boundaryTree?.isEmpty == false, node.source == nil, node.ref == nil else {
                    throw WorkingTreeError.corruptState("Malformed nested tree boundary")
                }
                guard !parents.contains(node.path) else {
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

extension WorkingTree: ObjectStore {
    public func bytes(_ hash: String) async throws -> Data {
        try await objectBytes(hash: hash)
    }
}
