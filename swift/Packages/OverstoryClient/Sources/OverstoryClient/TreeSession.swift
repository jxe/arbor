import OverstoryWorkspace
import OverstoryObjectStore
import OverstoryWorkingTree
import Overstory
import Foundation

/// How a session holds a tree (Clients 003). The settings don't interact: what
/// to fetch ahead, where objects come from, and whether the index and change
/// log live on disk. The three ways an app holds a tree are named
/// combinations of them (`browse`, `replica`, `alongsideStorySync`).
public struct TreeSessionSettings: Sendable {
    public enum Prefetch: Sendable, Equatable {
        /// Only what the opened pages need: a directory loads, with its
        /// Markdown bodies, the first time a path below it is asked for.
        case openedPages
        case directoriesAndPages
        case everything
    }

    /// One place objects come from. The chain is tried in order and every
    /// object is checked against its hash, so the order is only about speed.
    public enum Source: Sendable {
        /// The tree's host, through the session's client.
        case host
        case store(any ObjectStore)
    }

    public enum Index: Sendable {
        /// Rebuilt on every open; nothing kept.
        case memory
        /// A replica on disk, reopened while its wire format matches.
        case disk(TreeReplicaStorage)
    }

    public var prefetch: Prefetch
    public var sources: [Source]
    public var index: Index
    /// Where the change log and update state live. Nil opens the tree
    /// read-only: no coordinator, and the session follows the host itself.
    public var changeLog: URL?
    /// The folder Story Sync writes this tree into, for a session that runs
    /// alongside it. Pages are read from it first, each only when its file
    /// still reads as the accepted entry.
    public var folder: URL?
    /// Where a path read (one request for the directories down to a page)
    /// is asked: Story Sync's loopback reads alongside it. Nil asks the
    /// session's host when the host is a source, and otherwise reads object
    /// by object.
    public var pathReads: ProtocolClient?
    public var readOnly: Bool
    public var transportAvailable: Bool
    public var pollInterval: Duration?

    public init(
        prefetch: Prefetch,
        sources: [Source],
        index: Index,
        changeLog: URL?,
        folder: URL? = nil,
        readOnly: Bool = false,
        transportAvailable: Bool = true,
        pollInterval: Duration? = .seconds(30)
    ) {
        self.prefetch = prefetch
        self.sources = sources
        self.index = index
        self.changeLog = changeLog
        self.folder = folder
        self.readOnly = readOnly || changeLog == nil
        self.transportAvailable = transportAvailable
        self.pollInterval = pollInterval
    }

    /// Browse: opened pages, from the host, nothing on disk. Visits.
    public static func browse() -> Self {
        .init(prefetch: .openedPages, sources: [.host], index: .memory, changeLog: nil, readOnly: true)
    }

    /// Replica: everything, kept on disk and fetched from the host. iPhone
    /// trees and the Mac's writable remote trees.
    public static func replica(_ storage: TreeReplicaStorage, changeLog: URL, readOnly: Bool = false, transportAvailable: Bool = true) -> Self {
        .init(prefetch: .everything, sources: [.host], index: .disk(storage), changeLog: changeLog, readOnly: readOnly, transportAvailable: transportAvailable)
    }

    /// Alongside Story Sync: objects only from Story Sync's loopback reads
    /// (`reads`), the index in memory, the change log on disk, and the folder
    /// Story Sync keeps. Writes and watching still go to the host.
    public static func alongsideStorySync(reads: ProtocolClient, tree: String, folder: URL?, changeLog: URL, transportAvailable: Bool = true) -> Self {
        var settings = Self(
            prefetch: .openedPages,
            sources: [.store(HostObjectStore(client: reads, tree: tree))],
            index: .memory,
            changeLog: changeLog,
            folder: folder,
            transportAvailable: transportAvailable
        )
        settings.pathReads = reads
        return settings
    }
}

/// Where a replica lives on disk, and where an incompatible one is moved.
public struct TreeReplicaStorage: Sendable {
    public var root: URL
    /// The wire format this app places replicas under. A replica placed under
    /// another format cannot resume against the host and is placed again.
    public var format: String
    /// A fresh directory that keeps an incompatible replica and its change log
    /// for recovery.
    public var recoveryArchive: @Sendable () -> URL
    public var recoveryName: String
    public var changeLogRecoveryName: String

    public init(root: URL, format: String, recoveryArchive: @escaping @Sendable () -> URL, recoveryName: String, changeLogRecoveryName: String) {
        self.root = root
        self.format = format
        self.recoveryArchive = recoveryArchive
        self.recoveryName = recoveryName
        self.changeLogRecoveryName = changeLogRecoveryName
    }
}

/// What the caller already read of the tree's accepted state: the current
/// tree, and, when it has it, a graph of it (some directories and their
/// Markdown bodies; a directory it lacks loads on first use).
public struct TreeOpening: Sendable {
    public var current: ProtocolCurrentTree
    public var spine: ProtocolSnapshot?

    public init(current: ProtocolCurrentTree, spine: ProtocolSnapshot? = nil) {
        self.current = current
        self.spine = spine
    }
}

/// One open tree: its working tree, the workspace an editor uses, and, when
/// it can be edited, the coordinator that publishes its changes. Every way an
/// app holds a tree opens through `TreeSession.open`.
public struct TreeSession: Sendable {
    public let tree: ProtocolTreeDescriptor
    public let client: ProtocolClient
    public let settings: TreeSessionSettings
    public let workingTree: WorkingTree
    public let objects: any ObjectStore
    public let coordinator: UpdateCoordinator?
    public let provider: WorkingTreeProvider
    /// The watch cursor the session's accepted state was read at, when known.
    public let observedThrough: String?

    /// Open `tree` from `client`'s host with `settings`. `opening` is the
    /// accepted state the caller already read; without it the session reads it.
    public static func open(
        _ tree: ProtocolTreeDescriptor,
        client: ProtocolClient,
        settings: TreeSessionSettings,
        opening: TreeOpening? = nil
    ) async throws -> TreeSession {
        let treeID = TreeID(rawValue: tree.id)
        let objects = ObjectSourceChain(settings.sources.map { source -> any ObjectStore in
            switch source {
            case .host: HostObjectStore(client: client, tree: tree.id)
            case let .store(store): store
            }
        })
        let transport = ProtocolReplicaTransport(client: client)
        let workingTree: WorkingTree
        var observedThrough = opening?.current.tree.update
        switch settings.index {
        case .memory:
            let current: ProtocolCurrentTree
            if let given = opening?.current { current = given } else { current = try await client.descriptor(tree: tree.id) }
            observedThrough = current.tree.update
            workingTree = try await WorkingTree.inMemory(tree: treeID, platform: objects)
            if settings.prefetch == .openedPages { await workingTree.loadDirectoriesLazily() }
            await workingTree.readPages(from: settings.folder)
            let hostIsSource = settings.sources.contains { if case .host = $0 { true } else { false } }
            if let reads = settings.pathReads ?? (hostIsSource ? client : nil) {
                let id = tree.id
                await workingTree.readPaths { root, path in try await reads.pathRead(tree: id, root: root, path: path) }
            }
            // Lazily, the root directory and its bodies; otherwise every directory.
            let graph: ProtocolSnapshot
            if let given = opening?.spine { graph = given } else { graph = try await workingTree.acceptedGraph(root: current.tree.root) }
            try await workingTree.initializeFromSystem(SnapshotBridge.replacement(
                snapshot: graph,
                tree: treeID,
                update: current.tree.update,
                cursor: current.tree.update,
                mode: .lazyDirectories
            ))
            if settings.prefetch != .openedPages { try await workingTree.loadEverything() }
        case let .disk(storage):
            workingTree = try await openOrPlaceReplica(tree, storage: storage, changeLog: settings.changeLog, transport: transport, platform: objects)
        }
        var coordinator: UpdateCoordinator?
        if let changeLog = settings.changeLog {
            let platformObjects: any ObjectStore
            if case .disk = settings.index { platformObjects = workingTree } else { platformObjects = objects }
            coordinator = try UpdateCoordinator(
                workingTree: workingTree,
                transport: transport,
                stateRoot: changeLog,
                transportAvailable: settings.transportAvailable,
                platformObjectStore: platformObjects,
                pollInterval: settings.pollInterval
            )
        }
        let provider = WorkingTreeProvider(
            workingTree: workingTree,
            readOnly: settings.readOnly,
            materializedRoot: settings.folder,
            coordinator: coordinator
        )
        return TreeSession(
            tree: tree,
            client: client,
            settings: settings,
            workingTree: workingTree,
            objects: objects,
            coordinator: coordinator,
            provider: provider,
            observedThrough: observedThrough
        )
    }

    /// Open the durable replica at `storage.root`, or place it afresh from a
    /// snapshot. A replica records the wire format it was placed under; when
    /// the format changed (accepted-update ids, cursors and request shapes are
    /// not continuous across it), the replica and its change log are moved
    /// aside for recovery and the tree is placed again. An old journal is never
    /// replayed against reset accepted history.
    private static func openOrPlaceReplica(
        _ tree: ProtocolTreeDescriptor,
        storage: TreeReplicaStorage,
        changeLog: URL?,
        transport: ProtocolReplicaTransport,
        platform: any ObjectStore
    ) async throws -> WorkingTree {
        let formatMarker = storage.root.appending(path: "wire-format")
        let placedFormat = (try? String(contentsOf: formatMarker, encoding: .utf8))?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if placedFormat == storage.format,
           FileManager.default.fileExists(atPath: storage.root.appending(path: "materialized/tree.json").path) {
            return try await WorkingTree.open(at: storage.root, tree: TreeID(rawValue: tree.id), platform: platform)
        }
        var archive: URL?
        for (source, name) in [(storage.root, storage.recoveryName), (changeLog, storage.changeLogRecoveryName)] {
            guard let source, FileManager.default.fileExists(atPath: source.path) else { continue }
            let directory = archive ?? storage.recoveryArchive()
            archive = directory
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try FileManager.default.moveItem(at: source, to: directory.appending(path: name))
        }
        let current = try await transport.descriptor(tree: tree.id)
        let snapshot = try await transport.snapshot(tree: tree.id, root: current.tree.root)
        guard !current.tree.update.isEmpty else { throw UpdateError.replicaIsNotPlaced }
        let workingTree = try await WorkingTree.open(at: storage.root, tree: TreeID(rawValue: tree.id), platform: platform)
        try await workingTree.initializeFromSystem(SnapshotBridge.replacement(
            snapshot: snapshot,
            tree: TreeID(rawValue: tree.id),
            update: current.tree.update,
            cursor: current.tree.update
        ))
        try storage.format.write(to: formatMarker, atomically: true, encoding: .utf8)
        return workingTree
    }

    /// Follow the host's watch for a read-only session. An accepted update
    /// that chains from what the session holds is replayed from the event's
    /// own transitions; a gap, or a batch that does not chain, re-reads the
    /// current spine. An editable session follows through its coordinator
    /// instead (`HostWatchRunner`).
    public func follow(
        after cursor: String?,
        maximumReconnectDelay: Duration = .seconds(5),
        onChange: @escaping @Sendable () async -> Void = {}
    ) -> Task<Void, Never> {
        Task { await runFollow(after: cursor ?? observedThrough, maximumReconnectDelay: maximumReconnectDelay, onChange: onChange) }
    }

    private func runFollow(after cursor: String?, maximumReconnectDelay: Duration, onChange: @escaping @Sendable () async -> Void) async {
        var after = cursor
        await runObservationLoop(maximumDelay: maximumReconnectDelay) { connected in
            do {
                // A lazy session asks for frames without objects and reads
                // again only the directories it holds (§1.1.3).
                let lazy = settings.prefetch == .openedPages
                let events = try await client.watch(tree: tree.id, after: after, withoutObjects: lazy)
                for try await event in events {
                    connected()
                    try Task.checkCancellation()
                    after = event.id
                    guard event.treeID == tree.id else { continue }
                    let heads = try await workingTree.heads()
                    if event.update.root == heads.materializedRoot {
                        try await workingTree.recordAccepted(root: event.update.root, update: event.update.id, cursor: event.id)
                        continue
                    }
                    var replayed = false
                    if !lazy { replayed = (try? await workingTree.applyAcceptedTransitions(event)) != nil }
                    if !replayed {
                        try await pull(root: event.update.root, update: event.update.id, cursor: event.id)
                    }
                    await onChange()
                }
            } catch let error as ProtocolHTTPError where error.code == "resync-required" {
                after = try await pullCurrent()
                connected()
                await onChange()
            }
            return .reconnect
        }
    }

    /// Re-read the current tree and, when its root moved, the directories the
    /// session holds; returns the cursor to watch after.
    @discardableResult
    public func pullCurrent() async throws -> String {
        let current = try await client.descriptor(tree: tree.id)
        let heads = try await workingTree.heads()
        if current.tree.root != heads.materializedRoot {
            try await pull(root: current.tree.root, update: current.tree.update, cursor: current.tree.update)
        }
        return current.tree.update
    }

    /// Move to the accepted state at `root`: the directories the session
    /// has loaded are read again there (unchanged ones are already held),
    /// and the rest stay unloaded.
    private func pull(root: String, update: String, cursor: String) async throws {
        let graph = try await workingTree.acceptedGraph(root: root)
        try await workingTree.replaceFromSystem(SnapshotBridge.replacement(
            snapshot: graph,
            tree: TreeID(rawValue: tree.id),
            update: update,
            cursor: cursor,
            mode: .lazyDirectories
        ))
    }

    /// Open the page at `path` ahead of the editor: one path read (tree
    /// operations §1.2.4) brings the directories down to it, then its
    /// listing loads. Without a path read, or when it fails, the directories
    /// load object by object through the sources.
    public func openPage(_ path: String) async throws {
        try await workingTree.ensureLoaded(path, children: true)
    }
}
