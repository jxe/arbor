import ArborKit
import Foundation

public actor ArborReplica {
    public typealias Clock = @Sendable () -> Date

    private let files: DurableReplicaFiles
    private let faultInjector: any ReplicaFaultInjector
    private let clock: Clock
    private var state: ReplicaState
    private var control: ReplicaControl
    private var index: ReplicaSearchIndex
    private var terminal = false

    private init(
        files: DurableReplicaFiles,
        faultInjector: any ReplicaFaultInjector,
        clock: @escaping Clock,
        state: ReplicaState,
        control: ReplicaControl,
        index: ReplicaSearchIndex
    ) {
        self.files = files
        self.faultInjector = faultInjector
        self.clock = clock
        self.state = state
        self.control = control
        self.index = index
    }

    public static func open(
        at root: URL,
        tree: TreeID,
        faultInjector: any ReplicaFaultInjector = NoReplicaFaults(),
        clock: @escaping Clock = Date.init
    ) async throws -> ArborReplica {
        let files = try DurableReplicaFiles(root: root)
        let loaded: (ReplicaState, ReplicaControl)
        if FileManager.default.fileExists(atPath: files.stateURL.path) {
            let state = try files.read(ReplicaState.self, from: files.stateURL)
            guard state.tree == tree.rawValue else { throw ReplicaError.corruptState("Replica tree ID changed") }
            let snapshot = try ReplicaWireCodec.snapshot(for: state)
            let control: ReplicaControl
            if FileManager.default.fileExists(atPath: files.controlURL.path) {
                control = try files.read(ReplicaControl.self, from: files.controlURL)
            } else {
                control = ReplicaControl(
                    tree: tree.rawValue,
                    materializedRoot: snapshot.root,
                    pendingRoot: snapshot.root,
                    generation: 0
                )
                try files.store(objects: snapshot.objects)
                if !FileManager.default.fileExists(atPath: files.historyURL(generation: 0).path) {
                    try files.writeDated(
                        ReplicaHistoryRecord(
                            id: "local-0",
                            generation: 0,
                            mutation: "initialize-recovery",
                            changedAt: clock(),
                            root: snapshot.root,
                            state: state
                        ),
                        to: files.historyURL(generation: 0)
                    )
                }
                try files.write(control, to: files.controlURL)
            }
            loaded = (state, control)
        } else {
            let state = ReplicaState(
                tree: tree.rawValue,
                nodes: [ReplicaNodeRecord(path: "/", kind: .directory)]
            )
            let snapshot = try ReplicaWireCodec.snapshot(for: state)
            let control = ReplicaControl(
                tree: tree.rawValue,
                materializedRoot: snapshot.root,
                pendingRoot: snapshot.root,
                generation: 0
            )
            try files.store(objects: snapshot.objects)
            try files.write(state, to: files.stateURL)
            try files.writeDated(
                ReplicaHistoryRecord(
                    id: "local-0",
                    generation: 0,
                    mutation: "initialize",
                    changedAt: clock(),
                    root: snapshot.root,
                    state: state
                ),
                to: files.historyURL(generation: 0)
            )
            try files.write(control, to: files.controlURL)
            loaded = (state, control)
        }

        try validate(loaded.0, control: nil)
        let replica = ArborReplica(
            files: files,
            faultInjector: faultInjector,
            clock: clock,
            state: loaded.0,
            control: loaded.1,
            index: ReplicaSearchIndex(generation: -1, entries: [])
        )
        try await replica.recoverPendingIntents()
        try await replica.validateLoadedState()
        try await replica.loadOrRebuildIndex()
        return replica
    }

    public func heads() throws -> ReplicaHeads {
        try requireOpen()
        return control.heads
    }

    public func currentSnapshot() throws -> ReplicaSnapshot {
        try requireOpen()
        return try ReplicaWireCodec.snapshot(for: state)
    }

    public func storedObjectBytes(hash: String) throws -> Data {
        try requireOpen()
        let bytes = try Data(contentsOf: files.objectURL(hash: hash))
        guard ReplicaSemantics.sha256(bytes) == hash else {
            throw ReplicaError.corruptState("Immutable object hash mismatch for \(hash)")
        }
        return bytes
    }

    public func recordAccepted(root: String, update: String, cursor: String? = nil) throws {
        try requireOpen()
        guard !update.isEmpty else { throw ReplicaError.corruptState("Accepted update ID is empty") }
        guard root == control.materializedRoot else {
            throw ReplicaError.corruptState("Accepted root does not match the materialized replica")
        }
        var next = control
        next.acceptedRoot = root
        next.acceptedUpdate = update
        next.acceptedCursor = cursor
        if next.pendingRoot == root { next.pendingRoot = nil }
        try files.write(next, to: files.controlURL)
        control = next
    }

    public func initializeFromSystem(_ replacement: ReplicaSystemReplacement) throws {
        try requireOpen()
        guard control.generation == 0,
              control.acceptedRoot == nil,
              state.nodes.count == 1,
              state.nodes[0].path == "/",
              state.nodes[0].kind == .directory,
              state.nodes[0].source == nil else {
            throw ReplicaError.pendingLocalChanges
        }
        try replaceWithAccepted(replacement, mutation: "initialize-from-system")
    }

    public func integrateAccepted(
        _ replacement: ReplicaSystemReplacement,
        expectedCandidate: String
    ) throws {
        try requireOpen()
        guard control.materializedRoot == expectedCandidate,
              control.pendingRoot == expectedCandidate else {
            throw ReplicaError.pendingLocalChanges
        }
        try replaceWithAccepted(replacement, mutation: "integrate-accepted")
    }

    public func replaceFromSystem(_ replacement: ReplicaSystemReplacement) throws {
        try requireOpen()
        guard control.pendingRoot == nil else { throw ReplicaError.pendingLocalChanges }
        try replaceWithAccepted(replacement, mutation: "system-replacement")
    }

    private func replaceWithAccepted(_ replacement: ReplicaSystemReplacement, mutation: String) throws {
        guard !replacement.update.isEmpty else { throw ReplicaError.corruptState("System update ID is empty") }
        let nodes = replacement.nodes.map { node -> ReplicaNodeRecord in
            switch node.content {
            case let .directory(source):
                return ReplicaNodeRecord(
                    path: node.path,
                    pageID: node.pageID ?? source.flatMap(ReplicaSemantics.pageID(in:)),
                    kind: .directory,
                    source: source
                )
            case let .markdown(source):
                return ReplicaNodeRecord(path: node.path, pageID: node.pageID ?? ReplicaSemantics.pageID(in: source), kind: .markdown, source: source)
            case let .file(bytes, mediaType):
                return ReplicaNodeRecord(path: node.path, pageID: node.pageID, kind: .file, bytes: bytes, mediaType: mediaType)
            case let .boundary(tree):
                return ReplicaNodeRecord(path: node.path, kind: .boundary, boundaryTree: tree.rawValue)
            }
        }
        let replacementState = ReplicaState(tree: state.tree, nodes: nodes)
        let computed = try ReplicaWireCodec.snapshot(for: replacementState)
        guard computed.root == replacement.root else { throw ReplicaError.corruptState("System replacement root mismatch") }
        try transact(
            mutation: mutation,
            pageKey: "_system",
            accepted: (replacement.root, replacement.update, replacement.cursor)
        ) { next in
            next = replacementState
        }
    }

    public func deleteRebuildableIndexes() throws {
        try requireOpen()
        try files.removeIndexes()
        index = ReplicaSearchIndex(generation: -1, entries: [])
    }

    public func diagnostics() throws -> [ReplicaDiagnostic] {
        try requireOpen()
        let snapshot = try ReplicaWireCodec.snapshot(for: state)
        var result: [ReplicaDiagnostic] = []
        for object in snapshot.objects {
            let url = files.objectURL(hash: object.hash)
            guard FileManager.default.fileExists(atPath: url.path) else {
                result.append(ReplicaDiagnostic(
                    id: object.hash,
                    title: "Immutable object missing",
                    detail: "The materialized replica can rebuild \(object.hash), but the object store is incomplete."
                ))
                continue
            }
            if (try? Data(contentsOf: url)) != object.bytes {
                result.append(ReplicaDiagnostic(
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
    }

    func resolve(_ reference: WorkspaceReference) throws -> ReplicaNodeRecord {
        try requireOpen()
        guard reference.tree.rawValue == state.tree else { throw ReplicaError.notFound(reference) }
        if let pageID = reference.pageID?.rawValue,
           let node = state.nodes.first(where: { $0.pageID == pageID }) { return node }
        let path = try ReplicaSemantics.normalizePath(reference.pathHint)
        guard let node = state.nodes.first(where: { $0.path == path }) else { throw ReplicaError.notFound(reference) }
        return node
    }

    func children(of reference: WorkspaceReference) throws -> [ReplicaNodeRecord] {
        let parent = try resolve(reference)
        guard parent.kind == .directory else { throw ReplicaError.notDirectory(reference) }
        return state.nodes.filter {
            ReplicaSemantics.parent(of: $0.path) == parent.path && !ReplicaSemantics.isStoreFile($0)
        }.sorted { ReplicaSemantics.compareUTF8($0.path, $1.path) }
    }

    func completeSource(for node: ReplicaNodeRecord) -> String? {
        switch node.kind {
        case .markdown: node.source ?? ""
        case .directory: ReplicaSemantics.completeDirectorySource(node: node, state: state)
        case .file, .boundary: nil
        }
    }

    func revision(for node: ReplicaNodeRecord) -> String {
        ReplicaSemantics.documentRevision(node: node, state: state)
    }

    func collection(for directory: ReplicaNodeRecord) -> (kind: String, rows: Int?)? {
        guard directory.kind == .directory else { return nil }
        guard let store = state.nodes.first(where: {
            ReplicaSemantics.parent(of: $0.path) == directory.path && ReplicaSemantics.isStoreFile($0)
        }) else { return nil }
        switch ReplicaSemantics.name(of: store.path) {
        case "_store.csv":
            let lines = String(decoding: store.bytes ?? Data(), as: UTF8.self).split(whereSeparator: \.isNewline)
            return ("CSV", max(0, lines.count - 1))
        case "_store.jsonl":
            return ("JSONL", String(decoding: store.bytes ?? Data(), as: UTF8.self).split(whereSeparator: \.isNewline).count)
        case "_store.sqlite3": return ("SQLite", nil)
        case "_store.postgres": return ("Postgres", nil)
        default: return nil
        }
    }

    func search(_ query: String) throws -> [ReplicaSearchIndex.Entry] {
        try requireOpen()
        if index.generation != control.generation { try rebuildIndex() }
        let needle = query.localizedLowercase
        return index.entries.filter {
            $0.title.localizedLowercase.contains(needle) || $0.source.localizedLowercase.contains(needle)
        }
    }

    func backlinks(to reference: WorkspaceReference) throws -> [ReplicaSearchIndex.Entry] {
        let target = try resolve(reference)
        if index.generation != control.generation { try rebuildIndex() }
        return index.entries.filter { entry in
            entry.links.contains(target.path) || (target.pageID.map { entry.source.contains("#\($0)") } ?? false)
        }
    }

    @discardableResult
    func createMarkdown(parent: WorkspaceReference, name: String, source: String) throws -> ReplicaNodeRecord {
        try ReplicaSemantics.validateName(name)
        guard name != "_index" else { throw ReplicaError.invalidName(name) }
        let parentNode = try resolve(parent)
        guard parentNode.kind == .directory else { throw ReplicaError.notDirectory(parent) }
        let path = ReplicaSemantics.child(name, of: parentNode.path)
        let suppliedIDs = ReplicaSemantics.pageIDValues(in: source)
        guard suppliedIDs.count <= 1 else { throw ReplicaError.corruptState("Markdown contains duplicate PageIDs") }
        let pageID = suppliedIDs.first ?? "pg_\(UUID().uuidString.lowercased())"
        let acceptedSource = ReplicaSemantics.ensuringPageID(in: source, id: pageID)
        var created: ReplicaNodeRecord!
        try transact(mutation: "create-markdown", pageKey: pageID) { next in
            try refuseCollision(path, in: next)
            guard !next.nodes.contains(where: { $0.pageID == pageID }) else { throw ReplicaError.collision("PageID \(pageID)") }
            created = ReplicaNodeRecord(path: path, pageID: pageID, kind: .markdown, source: acceptedSource)
            next.nodes.append(created)
        }
        return created
    }

    @discardableResult
    func createDirectory(parent: WorkspaceReference, name: String) throws -> ReplicaNodeRecord {
        try ReplicaSemantics.validateName(name)
        let parentNode = try resolve(parent)
        guard parentNode.kind == .directory else { throw ReplicaError.notDirectory(parent) }
        let path = ReplicaSemantics.child(name, of: parentNode.path)
        var created: ReplicaNodeRecord!
        try transact(mutation: "create-directory", pageKey: "_tree") { next in
            try refuseCollision(path, in: next)
            created = ReplicaNodeRecord(path: path, kind: .directory)
            next.nodes.append(created)
        }
        return created
    }

    @discardableResult
    func importFile(name: String, bytes: Data, mediaType: String?, parent: WorkspaceReference) throws -> ReplicaNodeRecord {
        try ReplicaSemantics.validateName(name)
        guard name != "_index.md", !name.hasSuffix(".md") else { throw ReplicaError.invalidName(name) }
        let parentNode = try resolve(parent)
        guard parentNode.kind == .directory else { throw ReplicaError.notDirectory(parent) }
        let path = ReplicaSemantics.child(name, of: parentNode.path)
        var created: ReplicaNodeRecord!
        try transact(mutation: "import-file", pageKey: "_tree") { next in
            try refuseCollision(path, in: next)
            created = ReplicaNodeRecord(path: path, kind: .file, bytes: bytes, mediaType: mediaType)
            next.nodes.append(created)
        }
        return created
    }

    @discardableResult
    func storeAsset(_ asset: WorkspaceAsset, in parent: WorkspaceReference) throws -> ReplicaNodeRecord {
        try ReplicaSemantics.validateName(asset.name)
        let parentNode = try resolve(parent)
        guard parentNode.kind == .directory else { throw ReplicaError.notDirectory(parent) }
        let digest = String(ReplicaSemantics.sha256(asset.bytes).dropFirst("sha256:".count))
        let uniqueName = "\(digest.prefix(16))-\(asset.name)"
        let path = ReplicaSemantics.child(uniqueName, of: parentNode.path)
        if let existing = state.nodes.first(where: { $0.path == path }) {
            guard existing.kind == .file, existing.bytes == asset.bytes else { throw ReplicaError.collision(path) }
            return existing
        }
        return try importFile(name: uniqueName, bytes: asset.bytes, mediaType: asset.mediaType, parent: parent)
    }

    @discardableResult
    func rename(_ reference: WorkspaceReference, name: String) throws -> ReplicaNodeRecord {
        try ReplicaSemantics.validateName(name)
        let node = try resolve(reference)
        if node.kind == .markdown, name == "_index" { throw ReplicaError.invalidName(name) }
        if node.kind == .file, name == "_index.md" { throw ReplicaError.invalidName(name) }
        guard node.path != "/", let parent = ReplicaSemantics.parent(of: node.path) else { throw ReplicaError.readOnly(reference) }
        let destination = ReplicaSemantics.child(name, of: parent)
        return try relocate(node, to: destination, mutation: "rename")
    }

    @discardableResult
    func move(_ reference: WorkspaceReference, destination: WorkspaceReference) throws -> ReplicaNodeRecord {
        let node = try resolve(reference)
        let parent = try resolve(destination)
        guard node.path != "/" else { throw ReplicaError.readOnly(reference) }
        guard parent.kind == .directory else { throw ReplicaError.notDirectory(destination) }
        guard !ReplicaSemantics.isDescendant(parent.path, of: node.path), parent.path != node.path else {
            throw ReplicaError.invalidPath(parent.path)
        }
        return try relocate(node, to: ReplicaSemantics.child(ReplicaSemantics.name(of: node.path), of: parent.path), mutation: "move")
    }

    @discardableResult
    func copy(_ reference: WorkspaceReference, destination: WorkspaceReference) throws -> ReplicaNodeRecord {
        let node = try resolve(reference)
        let parent = try resolve(destination)
        guard parent.kind == .directory else { throw ReplicaError.notDirectory(destination) }
        guard parent.path != node.path, !ReplicaSemantics.isDescendant(parent.path, of: node.path) else {
            throw ReplicaError.invalidPath(parent.path)
        }
        let target = ReplicaSemantics.child(ReplicaSemantics.name(of: node.path), of: parent.path)
        var copied: ReplicaNodeRecord!
        try transact(mutation: "copy", pageKey: node.pageID ?? "_tree") { next in
            try refuseCollision(target, in: next)
            let sourceNodes = next.nodes.filter { $0.path == node.path || ReplicaSemantics.isDescendant($0.path, of: node.path) }
            for var source in sourceNodes.sorted(by: { $0.path.count < $1.path.count }) {
                source.path = ReplicaSemantics.replacingPrefix(source.path, from: node.path, to: target)
                source.trashedFrom = nil
                if let oldID = source.pageID {
                    let newID = "pg_\(UUID().uuidString.lowercased())"
                    source.pageID = newID
                    if let sourceText = source.source { source.source = ReplicaSemantics.replacingPageID(in: sourceText, with: newID) }
                    if oldID == node.pageID { copied = source }
                } else if source.path == target { copied = source }
                next.nodes.append(source)
            }
        }
        return copied
    }

    @discardableResult
    func trash(_ reference: WorkspaceReference) throws -> ReplicaNodeRecord {
        let node = try resolve(reference)
        guard node.path != "/", node.path != "/Trash", !node.path.hasPrefix("/Trash/") else { throw ReplicaError.readOnly(reference) }
        let destination = "/Trash" + node.path
        var result: ReplicaNodeRecord!
        try transact(mutation: "trash", pageKey: node.pageID ?? "_tree") { next in
            if !next.nodes.contains(where: { $0.path == "/Trash" }) {
                next.nodes.append(ReplicaNodeRecord(path: "/Trash", kind: .directory))
            }
            let ancestors = destination.split(separator: "/").dropLast()
            var current = ""
            for component in ancestors {
                current += "/\(component)"
                if !next.nodes.contains(where: { $0.path == current }) {
                    next.nodes.append(ReplicaNodeRecord(path: current, kind: .directory))
                }
            }
            try refuseCollision(destination, in: next)
            for index in next.nodes.indices where next.nodes[index].path == node.path || ReplicaSemantics.isDescendant(next.nodes[index].path, of: node.path) {
                let original = next.nodes[index].path
                next.nodes[index].path = ReplicaSemantics.replacingPrefix(original, from: node.path, to: destination)
                next.nodes[index].trashedFrom = original
                if original == node.path { result = next.nodes[index] }
            }
        }
        return result
    }

    @discardableResult
    func restore(_ reference: WorkspaceReference) throws -> ReplicaNodeRecord {
        let node = try resolve(reference)
        guard node.path.hasPrefix("/Trash/"), let destination = node.trashedFrom else { throw ReplicaError.invalidPath(node.path) }
        var result: ReplicaNodeRecord!
        try transact(mutation: "restore", pageKey: node.pageID ?? "_tree") { next in
            try refuseCollision(destination, in: next)
            for index in next.nodes.indices where next.nodes[index].path == node.path || ReplicaSemantics.isDescendant(next.nodes[index].path, of: node.path) {
                let current = next.nodes[index].path
                let fallback = ReplicaSemantics.replacingPrefix(current, from: node.path, to: destination)
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
        guard let source = completeSource(for: node), node.kind != .file else { throw ReplicaError.notDocument(reference) }
        return WorkspaceDocumentSnapshot(reference: workspaceReference(node), source: source, contentRevision: revision(for: node))
    }

    @discardableResult
    func writeDocument(_ reference: WorkspaceReference, source: String, baseRevision: String, mutation: String = "write-document") throws -> WorkspaceDocumentSnapshot {
        let original = try resolve(reference)
        guard original.kind == .markdown || original.kind == .directory else { throw ReplicaError.notDocument(reference) }
        let actual = revision(for: original)
        guard baseRevision == actual else { throw ReplicaError.staleRevision(expected: baseRevision, actual: actual) }
        let submittedIDs = ReplicaSemantics.pageIDValues(in: source)
        guard submittedIDs.count <= 1 else { throw ReplicaError.corruptState("Markdown contains duplicate PageIDs") }
        let submittedID = submittedIDs.first
        let admittedID: String?
        let acceptedSource: String
        if original.pageID == nil, original.kind == .directory, submittedID == nil {
            let minted = "pg_\(UUID().uuidString.lowercased())"
            admittedID = minted
            acceptedSource = ReplicaSemantics.ensuringPageID(in: source, id: minted)
        } else {
            admittedID = submittedID
            acceptedSource = source
        }
        if let pageID = original.pageID {
            guard submittedID == pageID else {
                throw ReplicaError.pageIDChanged(expected: pageID, actual: submittedID)
            }
        }
        var updated: ReplicaNodeRecord!
        try transact(mutation: mutation, pageKey: original.pageID ?? admittedID ?? "_tree") { next in
            guard let position = next.nodes.firstIndex(where: { $0.path == original.path }) else {
                throw ReplicaError.notFound(reference)
            }
            if original.pageID == nil, let admittedID {
                guard !next.nodes.contains(where: { $0.pageID == admittedID }) else {
                    throw ReplicaError.collision("PageID \(admittedID)")
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

    func history(for reference: WorkspaceReference) throws -> [WorkspaceHistoryEntry] {
        let current = try resolve(reference)
        let records = try files.historyURLs().map { try files.readDated(ReplicaHistoryRecord.self, from: $0) }
        var previousSource: String?
        var entries: [WorkspaceHistoryEntry] = []
        for record in records {
            let node = current.pageID.flatMap { id in record.state.nodes.first(where: { $0.pageID == id }) }
                ?? record.state.nodes.first(where: { $0.path == current.path })
            guard let source = node?.source else { continue }
            guard source != previousSource else { continue }
            previousSource = source
            entries.append(WorkspaceHistoryEntry(
                id: record.id,
                revision: record.id,
                title: record.mutation,
                timestamp: record.changedAt
            ))
        }
        return Array(entries.reversed())
    }

    func recover(_ reference: WorkspaceReference, revision: String) throws -> WorkspaceDocumentSnapshot {
        let current = try resolve(reference)
        var selected: ReplicaHistoryRecord?
        for url in try files.historyURLs() {
            let candidate = try files.readDated(ReplicaHistoryRecord.self, from: url)
            if candidate.id == revision {
                selected = candidate
                break
            }
        }
        guard let record = selected else { throw ReplicaError.corruptState("Unknown history revision") }
        let historical = current.pageID.flatMap { id in record.state.nodes.first(where: { $0.pageID == id }) }
            ?? record.state.nodes.first(where: { $0.path == current.path })
        guard let source = historical?.source else { throw ReplicaError.notDocument(reference) }
        return try writeDocument(reference, source: source, baseRevision: self.revision(for: current), mutation: "recover-history")
    }

    func workspaceReference(_ node: ReplicaNodeRecord) -> WorkspaceReference {
        WorkspaceReference(
            tree: TreeID(rawValue: state.tree),
            path: node.path,
            pageID: node.pageID.map(PageID.init(rawValue:))
        )
    }

    public func treeID() -> TreeID { TreeID(rawValue: state.tree) }

    private func relocate(_ node: ReplicaNodeRecord, to destination: String, mutation: String) throws -> ReplicaNodeRecord {
        var moved: ReplicaNodeRecord!
        try transact(mutation: mutation, pageKey: node.pageID ?? "_tree") { next in
            try refuseCollision(destination, in: next)
            for index in next.nodes.indices where next.nodes[index].path == node.path || ReplicaSemantics.isDescendant(next.nodes[index].path, of: node.path) {
                let old = next.nodes[index].path
                next.nodes[index].path = ReplicaSemantics.replacingPrefix(old, from: node.path, to: destination)
                if old == node.path { moved = next.nodes[index] }
            }
        }
        return moved
    }

    private func transact(
        mutation: String,
        pageKey: String,
        accepted: (root: String, update: String, cursor: String?)? = nil,
        change: (inout ReplicaState) throws -> Void
    ) throws {
        try requireOpen()
        var next = state
        try change(&next)
        let generation = control.generation + 1
        let intent = ReplicaMutationIntent(
            id: UUID().uuidString.lowercased(),
            pageKey: pageKey,
            generation: generation,
            mutation: mutation,
            changedAt: clock(),
            state: next,
            acceptedRoot: accepted?.root,
            acceptedUpdate: accepted?.update,
            acceptedCursor: accepted?.cursor
        )
        let journalURL = try files.journalURL(pageKey: pageKey, id: intent.id)
        do {
            try files.writeDated(intent, to: journalURL)
            try faultInjector.reached(.afterJournal)
            try finish(intent, journalURL: journalURL, injectFaults: true)
        } catch {
            terminal = true
            throw error
        }
    }

    private func finish(_ intent: ReplicaMutationIntent, journalURL: URL, injectFaults: Bool) throws {
        try Self.validate(intent.state, control: nil)
        let snapshot = try ReplicaWireCodec.snapshot(for: intent.state)
        try files.store(objects: snapshot.objects)
        if injectFaults { try faultInjector.reached(.afterObjects) }
        try files.write(intent.state, to: files.stateURL)
        if injectFaults { try faultInjector.reached(.afterMaterialization) }
        let history = ReplicaHistoryRecord(
            id: "local-\(intent.generation)",
            generation: intent.generation,
            mutation: intent.mutation,
            changedAt: intent.changedAt,
            root: snapshot.root,
            state: intent.state
        )
        try files.writeDated(history, to: files.historyURL(generation: intent.generation))
        if injectFaults { try faultInjector.reached(.afterHistory) }
        let nextControl: ReplicaControl
        if let acceptedRoot = intent.acceptedRoot {
            guard acceptedRoot == snapshot.root, let acceptedUpdate = intent.acceptedUpdate else {
                throw ReplicaError.corruptState("System replacement acceptance mismatch")
            }
            nextControl = ReplicaControl(
                tree: state.tree,
                materializedRoot: snapshot.root,
                pendingRoot: nil,
                acceptedRoot: acceptedRoot,
                acceptedUpdate: acceptedUpdate,
                acceptedCursor: intent.acceptedCursor,
                generation: intent.generation
            )
        } else {
            nextControl = ReplicaControl(
                tree: state.tree,
                materializedRoot: snapshot.root,
                pendingRoot: snapshot.root == control.acceptedRoot ? nil : snapshot.root,
                acceptedRoot: control.acceptedRoot,
                acceptedUpdate: control.acceptedUpdate,
                acceptedCursor: control.acceptedCursor,
                generation: intent.generation
            )
        }
        try files.write(nextControl, to: files.controlURL)
        if injectFaults { try faultInjector.reached(.afterControl) }
        let nextIndex = makeIndex(state: intent.state, generation: intent.generation)
        try files.write(nextIndex, to: files.indexURL)
        try files.remove(journalURL)
        state = intent.state
        control = nextControl
        index = nextIndex
    }

    private func recoverPendingIntents() throws {
        for url in try files.journalURLs() {
            let intent = try files.readDated(ReplicaMutationIntent.self, from: url)
            if intent.generation <= control.generation {
                try files.remove(url)
                continue
            }
            guard intent.generation == control.generation + 1 else {
                throw ReplicaError.corruptState("Mutation journal generation gap")
            }
            try finish(intent, journalURL: url, injectFaults: false)
        }
    }

    private func validateLoadedState() throws {
        try Self.validate(state, control: control)
    }

    private func loadOrRebuildIndex() throws {
        if FileManager.default.fileExists(atPath: files.indexURL.path),
           let loaded = try? files.read(ReplicaSearchIndex.self, from: files.indexURL),
           loaded.generation == control.generation {
            index = loaded
        } else {
            try rebuildIndex()
        }
    }

    private func rebuildIndex() throws {
        let rebuilt = makeIndex(state: state, generation: control.generation)
        try files.write(rebuilt, to: files.indexURL)
        index = rebuilt
    }

    private func makeIndex(state: ReplicaState, generation: Int) -> ReplicaSearchIndex {
        ReplicaSearchIndex(
            generation: generation,
            entries: state.nodes.compactMap { node in
                guard node.kind != .file, node.kind != .boundary,
                      node.path != "/Trash", !node.path.hasPrefix("/Trash/") else { return nil }
                let source = node.kind == .directory
                    ? ReplicaSemantics.completeDirectorySource(node: node, state: state)
                    : node.source ?? ""
                return ReplicaSearchIndex.Entry(
                    path: node.path,
                    pageID: node.pageID,
                    title: ReplicaSemantics.title(for: node),
                    source: source,
                    links: ReplicaSemantics.links(in: source, relativeTo: node.path)
                )
            }.sorted { ReplicaSemantics.compareUTF8($0.path, $1.path) }
        )
    }

    private func requireOpen() throws {
        if terminal { throw ReplicaError.closed }
    }

    private static func validate(_ state: ReplicaState, control: ReplicaControl?) throws {
        guard state.schema == 1, !state.tree.isEmpty else { throw ReplicaError.corruptState("Unsupported replica state") }
        if let control {
            guard control.schema == 1, control.tree == state.tree else { throw ReplicaError.corruptState("Replica control mismatch") }
            let snapshot = try ReplicaWireCodec.snapshot(for: state)
            guard snapshot.root == control.materializedRoot else { throw ReplicaError.corruptState("Materialized root does not match state") }
        }
        let paths = state.nodes.map(\.path)
        guard Set(paths).count == paths.count else { throw ReplicaError.corruptState("Duplicate logical path") }
        guard state.nodes.contains(where: { $0.path == "/" && $0.kind == .directory }) else {
            throw ReplicaError.corruptState("Missing root directory")
        }
        let pageIDs = state.nodes.compactMap(\.pageID)
        guard Set(pageIDs).count == pageIDs.count else { throw ReplicaError.corruptState("Duplicate PageID") }
        for node in state.nodes {
            guard try ReplicaSemantics.normalizePath(node.path) == node.path else { throw ReplicaError.corruptState("Noncanonical path") }
            if node.path != "/" { try ReplicaSemantics.validateName(ReplicaSemantics.name(of: node.path)) }
            if node.path != "/", let parent = ReplicaSemantics.parent(of: node.path) {
                guard state.nodes.contains(where: { $0.path == parent && $0.kind == .directory }) else {
                    throw ReplicaError.corruptState("Missing parent directory for \(node.path)")
                }
            }
            if node.kind == .markdown, ReplicaSemantics.name(of: node.path) == "_index" {
                throw ReplicaError.corruptState("Reserved directory body appears as a Markdown child")
            }
            if node.kind == .file, ReplicaSemantics.name(of: node.path) == "_index.md" {
                throw ReplicaError.corruptState("Reserved directory body appears as an ordinary file")
            }
            if (node.kind == .file || node.kind == .boundary), node.pageID != nil {
                throw ReplicaError.corruptState("Non-document node has a PageID")
            }
            if node.kind == .boundary {
                guard node.boundaryTree?.isEmpty == false, node.source == nil, node.bytes == nil else {
                    throw ReplicaError.corruptState("Malformed nested tree boundary")
                }
                guard !state.nodes.contains(where: { ReplicaSemantics.parent(of: $0.path) == node.path }) else {
                    throw ReplicaError.corruptState("Nested tree boundary has local children")
                }
            }
            if node.kind != .file, node.kind != .boundary, let source = node.source,
               ReplicaSemantics.pageIDValues(in: source).count > 1 {
                throw ReplicaError.corruptState("Document contains duplicate PageIDs")
            }
            if let pageID = node.pageID, node.kind != .file, node.kind != .boundary {
                guard ReplicaSemantics.pageID(in: node.source ?? "") == pageID else {
                    throw ReplicaError.corruptState("Document PageID mismatch")
                }
            }
        }
    }

    private func refuseCollision(_ path: String, in state: ReplicaState) throws {
        if state.nodes.contains(where: { $0.path == path }) { throw ReplicaError.collision(path) }
    }

    private func pruneEmptyTrashDirectories(_ state: inout ReplicaState) {
        var changed = true
        while changed {
            changed = false
            for node in state.nodes where node.kind == .directory && node.path.hasPrefix("/Trash/") && node.trashedFrom == nil {
                if !state.nodes.contains(where: { ReplicaSemantics.parent(of: $0.path) == node.path }) {
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
