import CanopyAppKit
import Overstory
import OverstoryObjectStore
import Foundation

/// Appending local changes, and the views that read through them. Every
/// source appends here: editor generations (`appendSourceIntent`), structural
/// actions, assets and imports (`appendStructure`). A change is durable in the
/// change log before the machine learns of its tip.
extension UpdateCoordinator {
    enum StructuralChange: Codable, Sendable {
        case action(WorkspaceStructuralAction)
        case pageCreation(parent: WorkspaceReference, name: String, source: String, transaction: String, document: WorkspaceReference)
        case asset(WorkspaceAsset, parent: WorkspaceReference)
        case imported(name: String, bytes: Data, mediaType: String?, parent: WorkspaceReference)
    }

    /// Append one structural change. Appends are serialized so a structural
    /// capture cannot race a newly retained source branch; publication is the
    /// machine's and stays independent.
    func appendStructure(_ change: StructuralChange) async throws -> WorkspaceNode {
        try requireOpen()
        return try await afterEarlierAppends { try await self.retainStructure(change) }.value
    }

    /// Run `append` after every earlier append settles, and make later
    /// appends wait for this one, whatever its outcome.
    private func afterEarlierAppends<T: Sendable>(_ append: @escaping @Sendable () async throws -> T) -> Task<T, any Error> {
        let previous = appendTail
        let task = Task {
            await previous?.value
            return try await append()
        }
        appendTail = Task { _ = try? await task.value }
        return task
    }

    private func retainStructure(_ structural: StructuralChange) async throws -> WorkspaceNode {
        try requireOpen()
        let key = try sortedKeysJSON(structural)
        guard try await structuralActionsAvailable() else { throw UpdateError.awaitingHostReconciliation }
        let prepared: (record: LocalChange, node: WorkspaceNode)
        if let previous = preparedStructures[key] { prepared = previous }
        else {
            let graph: ProtocolSnapshot, basis: LocalChangeBasis
            if let latest = try await pendingLocalChanges().last {
                graph = latest.candidate; basis = .authored(change: latest.change)
            } else {
                let captured = try await workingTree.captureAcceptedGraph()
                graph = captured.graph; basis = .accepted(captured.base)
            }
            let staging = try await projectedTree(graph, from: currentLocalView(changeLog().retained()) ?? workingTree)
            let provider = WorkingTreeProvider(workingTree: staging)
            do {
                var transferred: WorkingTreeNode?
                var transferKind = EntryTransfer.Kind.moveEntry
                var isTrash = false
                if case let .action(action) = structural {
                    switch action {
                    case let .copy(reference, _):
                        transferred = try await staging.resolve(reference); transferKind = .copyEntry
                    case let .trash(reference):
                        transferred = try await staging.resolve(reference); isTrash = true
                    case let .rename(reference, _), let .move(reference, _):
                        transferred = try await staging.resolve(reference)
                    default: break
                    }
                }
                let node: WorkspaceNode
                switch structural {
                case let .action(action):
                    guard let result = try await provider.perform(action) else { throw ProtocolValidationError.invalidValue("Structural action returned no node") }
                    node = result
                case let .pageCreation(parent, name, source, _, _):
                    guard let result = try await provider.perform(.createMarkdown(parent: parent, name: name, source: source)) else { throw ProtocolValidationError.invalidValue("Page creation returned no node") }
                    node = result
                case let .asset(asset, parent):
                    let stored = try await provider.store(asset: asset, in: parent)
                    node = try await provider.resolve(stored.reference)
                case let .imported(name, bytes, mediaType, parent):
                    node = try await provider.importFile(name: name, bytes: bytes, mediaType: mediaType, in: parent)
                }
                let candidate = try await staging.localSnapshot()
                var actions: EntryActions?
                if let old = transferred, old.kind != .boundary {
                    let moved = try await staging.resolve(node.reference)
                    func path(_ n: WorkingTreeNode) -> String { n.kind == .markdown ? n.path + ".md" : n.path }
                    var paths = [(path(old), path(moved))]
                    if old.directoryBodyPlacement == .siblingMarkdown || old.shadowedSiblingMarkdownSource != nil {
                        paths.append((old.path + ".md", moved.path + ".md"))
                    }
                    if isTrash {
                        actions = EntryActions(removals: paths.map { $0.0 })
                    } else {
                        let transfers = try paths.map { source, destination in
                            let parts = destination.split(separator:"/").map(String.init)
                            let transfer = EntryTransfer(kind:transferKind,source:source,parent:parts.count == 1 ? "/" : "/"+parts.dropLast().joined(separator:"/"),name:parts.last!)
                            return try transferKind == .copyEntry ? transfer.capturingRewrites(graph:graph,candidate:candidate) : transfer
                        }
                        actions = EntryActions(transfers:transfers)
                    }
                }
                var creation: SourcePageCreation?
                if case let .pageCreation(_, _, _, _, document) = structural {
                    // Remove the first branch introduced by creation. A promoted
                    // Markdown parent's sibling body stays exactly where it was.
                    let parts = (node.reference.path + ".md").dropFirst().split(separator: "/").map(String.init)
                    let objects = try ProtocolObjectGraph.validate(graph, mode: .sparseFiles)
                    var hash = graph.root, prefix: [String] = []
                    for part in parts {
                        prefix.append(part)
                        guard case let .directory(entries, _)? = objects[hash] else { throw ProtocolValidationError.invalidValue("Invalid creation parent") }
                        guard let entry = entries.first(where: { $0.name == part }) else { break }
                        guard let next = entry.directory else { throw ProtocolValidationError.invalidValue("Creation overwrote an existing entry") }
                        hash = next
                    }
                    creation = .init(document: document, removals: ["/" + prefix.joined(separator: "/")])
                }
                var record = try LocalChange(tree: await workingTree.treeID().rawValue, basis: basis,
                    graph: graph, candidate:candidate, entryActions:actions, creation:creation)
                record.localTrash = try await staging.captureLocalTrash()
                prepared = (record, node)
                preparedStructures[key] = prepared
                await staging.close()
            } catch { await staging.close(); throw error }
        }
        try await changeLog().retain(prepared.record)
        preparedStructures[key] = nil
        await ensureEntered()
        await publishTip()
        await workingTree.invalidateDocumentViews()
        return prepared.node
    }

    private struct SourceViewToken: Codable {
        var base: ProtocolUpdateBase
        var reference: WorkspaceReference
        var path: String
    }

    public func copyDocument(_ snapshot: WorkspaceDocumentSnapshot) async throws -> WorkspaceCopyDocument {
        let intent = try WorkspaceDocumentIntent(basis: snapshot, patch: .init(baseContentRevision: snapshot.contentRevision, edits: []), source: snapshot.source)
        let view = try await sourceView(for: intent)
        return WorkspaceCopyDocument(path: view.sourcePath, source: view.document.source)
    }

    func changeLog() async throws -> ChangeLog {
        if let log { return log }
        let opened = try await ChangeLog(tree: await workingTree.treeID().rawValue,
                                         stateRoot: files.directory.deletingLastPathComponent(),
                                         platform: platformObjectStore,
                                         settled: Set(control.settled))
        log = opened
        return opened
    }

    /// The change log's unsettled changes, in log order.
    func pendingLocalChanges(_ retained: [LocalChange]? = nil) async throws -> [LocalChange] {
        let records: [LocalChange]
        if let retained { records = retained }
        else { records = try await changeLog().retained() }
        let settled = Set(control.settled)
        return records.filter { !settled.contains($0.change) }
    }

    /// Local candidates are authored branches, not merged tree projections. Only
    /// a single dependency chain based on the installed graph permits structure.
    /// Comparing roots here checks display coherence; authored identities remain
    /// unchanged in every retained request.
    func localViewState(_ retained: [LocalChange]? = nil) async throws -> (navigation: LocalChange?, structural: Bool) {
        let records = try await pendingLocalChanges(retained)
        guard let first = records.first else { return (nil, true) }
        let accepted = try await workingTree.heads().acceptedRoot
        let linear = zip(records, records.dropFirst()).allSatisfy { previous, next in
            next.basis == .authored(change: previous.change)
        }
        if linear && first.graph.root == accepted { return (records.last, true) }

        // Keep pending creations/moves visible while Canopy reconciles branches.
        // Document sessions independently read their own retained source intent.
        // If the structural prefix has settled, the installed projection owns it.
        guard let index = records.lastIndex(where: { $0.document == nil }) else { return (nil, false) }
        var navigation = records[index]
        for record in records.dropFirst(index + 1) {
            guard record.basis == .authored(change: navigation.change) else { break }
            navigation = record
        }
        return (navigation, false)
    }

    func structuralActionsAvailable() async throws -> Bool {
        try requireOpen()
        return try await localViewState().structural
    }

    func hasLocalChanges() async throws -> Bool { !(try await pendingLocalChanges()).isEmpty }

    private struct LocalSourceToken: Codable {
        var change: String
        var reference: WorkspaceReference
    }

    struct LocalViewKey: Equatable {
        var generation: Int
        var candidate: String?
        var trash: String?
    }

    /// Bring `tree`, a fork, to `graph` (its own graph when nil) and, when asked,
    /// install the retained local trash. Node metadata outside the hashes, such
    /// as modification dates, carries over from what `tree` held before.
    private func prepare(_ tree: WorkingTree, at graph: ProtocolSnapshot?, includeTrash: Bool) async throws {
        let heads = try await tree.heads()
        let target = graph?.root ?? heads.materializedRoot
        if heads.materializedRoot != target || heads.acceptedRoot != target {
            let snapshot: ProtocolSnapshot
            if let graph { snapshot = graph } else { snapshot = try await tree.localSnapshot() }
            try await tree.project(SnapshotBridge.replacement(snapshot: snapshot, tree: await workingTree.treeID(),
                update: "local-candidate", mode: .sparseFiles))
        }
        if includeTrash {
            let trash: WorkingTreeLocalTrash
            if let retained = try await changeLog().retained().last(where: { $0.localTrash != nil })?.localTrash { trash = retained }
            else { trash = try await workingTree.captureLocalTrash() }
            if !trash.nodes.isEmpty { try await tree.installLocalTrash(trash) }
        }
    }

    /// A disposable fork of `base` at `graph`. The caller closes it.
    private func projectedTree(_ graph: ProtocolSnapshot, from base: WorkingTree, includeTrash: Bool = true) async throws -> WorkingTree {
        let tree = try await base.fork()
        do { try await prepare(tree, at: graph, includeTrash: includeTrash) }
        catch { await tree.close(); throw error }
        return tree
    }

    /// The tree reads show while source work is retained: the navigation
    /// candidate plus retained local trash, as a fork of the accepted working
    /// tree. It is kept between reads and projected forward in place as the
    /// candidate changes; nil means reads use the working tree itself.
    private func currentLocalView(_ retained: [LocalChange]) async throws -> WorkingTree? {
        let navigation = try await localViewState(retained).navigation
        let trashRecord = retained.last(where: { $0.localTrash != nil })
        guard navigation != nil || trashRecord?.localTrash?.nodes.isEmpty == false else {
            localView = nil
            return nil
        }
        let key = LocalViewKey(generation: try await workingTree.heads().generation,
                               candidate: navigation?.candidate.root, trash: trashRecord?.change)
        if let localView, localView.key == key { return localView.tree }
        // A new accepted state starts again from the working tree; otherwise the
        // previous view moves forward, keeping dates stamped for earlier edits.
        let tree: WorkingTree
        if let localView, localView.key.generation == key.generation { tree = localView.tree }
        else { tree = try await workingTree.fork() }
        localView = nil
        try await prepare(tree, at: navigation?.candidate, includeTrash: true)
        localView = (key, tree)
        return tree
    }

    /// Provider reads see locally created/moved entries through the local view,
    /// never a replacement of the accepted working tree.
    func sourceReadProvider(
        readOnly: Bool = false,
        materializedRoot: URL? = nil
    ) async throws -> WorkingTreeProvider {
        WorkingTreeProvider(
            workingTree: try await currentLocalView(changeLog().retained()) ?? workingTree,
            readOnly: readOnly,
            materializedRoot: materializedRoot
        )
    }

    private func localSourceView(_ record: LocalChange, reference: WorkspaceReference? = nil) async throws -> CapturedSourceBasis {
        guard let reference = reference ?? record.document?.reference else {
            throw ProtocolValidationError.invalidValue("A structural candidate requires a document reference")
        }
        let base = try await currentLocalView(changeLog().retained()) ?? workingTree
        let captured: CapturedSourceBasis
        if try await base.heads().materializedRoot == record.candidate.root {
            captured = try await base.captureSourceBasis(reference)
        } else {
            let tree = try await projectedTree(record.candidate, from: base, includeTrash: false)
            do { captured = try await tree.captureSourceBasis(reference) }
            catch { await tree.close(); throw error }
            await tree.close()
        }
        var document = captured.document
        document.contentRevision = "source-candidate:" + (try sortedKeysJSON(LocalSourceToken(change: record.change, reference: captured.document.reference))).base64EncodedString()
        return CapturedSourceBasis(document: document, graph: record.candidate, accepted: nil, sourcePath: captured.sourcePath)
    }

    public func sourceSnapshot(_ reference: WorkspaceReference) async throws -> WorkspaceDocumentSnapshot {
        try requireOpen()
        if let pending = try await pendingSourceSnapshot(reference) { return pending }
        let captured = try await workingTree.captureSourceBasis(reference)
        // A change can be appended while the accepted basis is captured.
        if let pending = try await pendingSourceSnapshot(reference) { return pending }
        guard let accepted = captured.accepted else { throw ProtocolValidationError.invalidValue("This document has no accepted basis to edit against") }
        let token = "source-accepted:" + (try sortedKeysJSON(SourceViewToken(base: accepted, reference: captured.document.reference, path: captured.sourcePath))).base64EncodedString()
        var document = captured.document; document.contentRevision = token
        sourceViews[token] = CapturedSourceBasis(document: document, graph: captured.graph, accepted: accepted, sourcePath: captured.sourcePath)
        return document
    }

    /// The hidden candidate view of `reference` when retained source work touches it.
    private func pendingSourceSnapshot(_ reference: WorkspaceReference) async throws -> WorkspaceDocumentSnapshot? {
        guard let latest = try await pendingLocalChanges().last(where: {
            $0.document == nil || $0.documentReferences.contains { $0.identity == reference.identity }
        }) else { return nil }
        let view = try await localSourceView(latest, reference: reference)
        sourceViews[view.document.contentRevision] = view
        return view.document
    }

    private func localPredecessor(_ revision: String) throws -> String? {
        if revision.hasPrefix("source-local:") { return String(revision.dropFirst("source-local:".count)) }
        if revision.hasPrefix("source-candidate:"), let data = Data(base64Encoded: String(revision.dropFirst("source-candidate:".count))) {
            return try JSONDecoder().decode(LocalSourceToken.self, from: data).change
        }
        return nil
    }

    private func sourceView(for intent: WorkspaceDocumentIntent) async throws -> CapturedSourceBasis {
        let revision = intent.basis.contentRevision
        if let view = sourceViews[revision] { return view }
        let records = try await changeLog().retained()
        if let predecessor = try localPredecessor(revision), let parent = records.first(where: { $0.change == predecessor }) {
            var view = try await localSourceView(parent, reference: intent.basis.reference)
            // Preserve the old revision spelling when recovering an older journal.
            var document = view.document; document.contentRevision = revision
            view = CapturedSourceBasis(document: document, graph: view.graph, accepted: nil, sourcePath: view.sourcePath)
            return view
        }
        guard revision.hasPrefix("source-accepted:"),
              let data = Data(base64Encoded: String(revision.dropFirst("source-accepted:".count))) else {
            throw ProtocolValidationError.invalidValue("The edit's original tree basis is unavailable; its recovery draft is retained")
        }
        let token = try JSONDecoder().decode(SourceViewToken.self, from: data)
        guard token.reference == intent.basis.reference, token.reference.tree == (await workingTree.treeID()) else {
            throw ProtocolValidationError.invalidValue("Recovered source basis has a different scope")
        }
        let local = try await workingTree.localSnapshot()
        let graph: ProtocolSnapshot
        if local.root == token.base.root { graph = local }
        else if let retained = records.first(where: { $0.graph.root == token.base.root }) { graph = retained.graph }
        else { graph = try await transport.snapshot(tree: token.reference.tree.rawValue, root: token.base.root) }
        guard graph.root == token.base.root else { throw UpdateError.returnedSnapshotMismatch }
        return CapturedSourceBasis(document: intent.basis, graph: graph, accepted: token.base, sourcePath: token.path)
    }

    /// Append one editor generation as a local change. The client, not the
    /// editor bridge, binds and durably retains the original basis; the
    /// returned snapshot is the change's candidate view of the document.
    public func appendSourceIntent(_ intent: WorkspaceDocumentIntent) async throws -> WorkspaceDocumentSnapshot {
        try requireOpen()
        let task = afterEarlierAppends { try await self.retainSourceIntent(intent) }
        let log = Self.changeLogLog
        log.notice("append begin edits=\(intent.patch.edits.count) bytes=\(intent.source.utf8.count)")
        // The journal rewrite is client-side latency the editor waits on; report
        // it beside the network events so it can be weighed against them.
        var note = ProtocolNetworkLogEntry(kind: .note, name: "change-log-append")
        do {
            let result = try await task.value
            note.durationMs = Date().timeIntervalSince(note.at) * 1000
            // Journal size only; never read the journal back on this path.
            if let size = try? FileManager.default.attributesOfItem(atPath: files.changeLogURL.path)[.size] as? Int {
                note.bytesOut = size
            }
            ProtocolNetworkLog.current?.record(note)
            log.notice("append succeeded")
            return result
        } catch {
            note.durationMs = Date().timeIntervalSince(note.at) * 1000
            note.error = String(describing: error)
            ProtocolNetworkLog.current?.record(note)
            log.error("append failed: \(String(describing: error), privacy: .public)")
            throw error
        }
    }

    private func retainSourceIntent(_ intent: WorkspaceDocumentIntent) async throws -> WorkspaceDocumentSnapshot {
        try requireOpen()
        try intent.validate()
        let queue = try await changeLog()
        let intentBytes = try sortedKeysJSON(intent)
        // Exact retries reuse the retained identity: the record remembers a
        // digest of the captured intent rather than the intent's sources.
        let digest = LocalChange.intentDigest(intent)
        let existing = try await queue.retained().last { $0.document?.intentDigest == digest }
        let record: LocalChange
        if let existing { record = existing }
        else {
            let view = try await sourceView(for: intent)
            let parent = try localPredecessor(intent.basis.contentRevision)
            if let prepared = preparedSourceIntents[intentBytes] { record = prepared }
            else {
                record = try view.prepare(intent: intent, predecessor: parent)
                preparedSourceIntents[intentBytes] = record
            }
        }
        try await queue.retain(record)
        let local = try await localSourceView(record)
        sourceViews[local.document.contentRevision] = local
        await ensureEntered()
        await publishTip()
        await workingTree.invalidateDocumentViews()
        return local.document
    }

    /// Append one Move to Document as a single local change over both
    /// documents. Its basis is the one retained tree that holds both exactly as
    /// the editor read them; when their local work sits on different chains
    /// there is none, and the caller decides what to do instead.
    public func appendSourceTransfer(_ transfer: WorkspaceDocumentTransfer) async throws -> WorkspaceDocumentTransferResult {
        try requireOpen()
        let task = afterEarlierAppends { try await self.retainSourceTransfer(transfer) }
        return try await task.value
    }

    private func retainSourceTransfer(_ transfer: WorkspaceDocumentTransfer) async throws -> WorkspaceDocumentTransferResult {
        try requireOpen()
        try transfer.validate()
        let queue = try await changeLog()
        let digest = LocalChange.transferDigest(transfer)
        let records = try await queue.retained()
        let record: LocalChange
        if let existing = records.last(where: { $0.document?.intentDigest == digest && $0.transfer != nil }) { record = existing }
        else {
            func view(_ snapshot: WorkspaceDocumentSnapshot) async throws -> CapturedSourceBasis {
                try await sourceView(for: WorkspaceDocumentIntent(basis: snapshot, patch: .init(baseContentRevision: snapshot.contentRevision, edits: []), source: snapshot.source))
            }
            let origin = try await view(transfer.origin), destination = try await view(transfer.destination)
            guard Data(origin.document.source.utf8) == Data(transfer.origin.source.utf8),
                  Data(destination.document.source.utf8) == Data(transfer.destination.source.utf8) else {
                throw ProtocolValidationError.invalidValue("A transfer does not name its documents' captured sources")
            }
            guard let basis = try transferBasis(origin: origin, originRevision: transfer.origin.contentRevision,
                                                destination: destination, destinationRevision: transfer.destination.contentRevision,
                                                records: records) else {
                throw WorkspaceTransferError.basesDiverged
            }
            record = try LocalChange(tree: transfer.origin.reference.tree.rawValue, basis: basis.basis, graph: basis.graph,
                                     originPath: origin.sourcePath, destinationPath: destination.sourcePath, transfer: transfer)
        }
        try await queue.retain(record)
        let origin = try await localSourceView(record, reference: transfer.origin.reference)
        let destination = try await localSourceView(record, reference: transfer.destination.reference)
        sourceViews[origin.document.contentRevision] = origin
        sourceViews[destination.document.contentRevision] = destination
        await ensureEntered()
        await publishTip()
        await workingTree.invalidateDocumentViews()
        return .init(origin: origin.document, destination: destination.document)
    }

    /// The basis of a transfer, decided from record ancestry and never from
    /// equal roots: both views rest on one accepted base, or one view's
    /// record descends from the other's with nothing between them touching
    /// the other document or the tree's structure. The graph holds both files.
    private func transferBasis(origin: CapturedSourceBasis, originRevision: String,
                               destination: CapturedSourceBasis, destinationRevision: String,
                               records: [LocalChange]) throws -> (basis: LocalChangeBasis, graph: ProtocolSnapshot)? {
        let byChange = Dictionary(records.map { ($0.change, $0) }, uniquingKeysWith: { first, _ in first })
        /// The record and its local ancestors, nearest first, and the accepted
        /// base the chain rests on.
        func chain(_ change: String) -> (records: [LocalChange], base: ProtocolUpdateBase?)? {
            var result: [LocalChange] = [], cursor = change
            while let record = byChange[cursor] {
                result.append(record)
                switch record.basis {
                case let .accepted(base): return (result, base)
                case let .authored(parent): cursor = parent
                }
            }
            // A settled ancestor left the log: the chain rests on it, not on a base.
            return result.isEmpty ? nil : (result, nil)
        }
        /// Whether `descendant`'s view already holds `other` exactly as read at
        /// `ancestor` (a record, or nil for `other`'s accepted base).
        func holds(_ descendant: String, ancestor: String?, otherBase: ProtocolUpdateBase?, other: WorkspaceReference) -> Bool {
            guard let (line, base) = chain(descendant) else { return false }
            for record in line {
                if record.change == ancestor { return true }
                if record.document == nil || record.documentReferences.contains(where: { $0.identity == other.identity }) { return false }
            }
            return ancestor == nil && base != nil && base == otherBase
        }
        let a = try localPredecessor(originRevision), b = try localPredecessor(destinationRevision)
        let graph: ProtocolSnapshot, basis: LocalChangeBasis
        switch (a, b) {
        case (nil, nil):
            guard let base = origin.accepted, base == destination.accepted, origin.graph.root == destination.graph.root else { return nil }
            basis = .accepted(base); graph = origin.graph
        case let (a?, b):
            if a == b || holds(a, ancestor: b, otherBase: destination.accepted, other: destination.document.reference) {
                basis = .authored(change: a); graph = origin.graph
            } else if let b, holds(b, ancestor: a, otherBase: origin.accepted, other: origin.document.reference) {
                basis = .authored(change: b); graph = destination.graph
            } else { return nil }
        case let (nil, b?):
            guard holds(b, ancestor: nil, otherBase: origin.accepted, other: origin.document.reference) else { return nil }
            basis = .authored(change: b); graph = destination.graph
        }
        // Both files must be present; each view's graph holds its own file.
        var bytes = Dictionary(origin.graph.objects.map { ($0.hash, $0.bytes) }, uniquingKeysWith: { first, _ in first })
        for object in destination.graph.objects + graph.objects { bytes[object.hash] = object.bytes }
        return (basis, try ProtocolGraph.reachable(from: graph.root, in: bytes))
    }
}
