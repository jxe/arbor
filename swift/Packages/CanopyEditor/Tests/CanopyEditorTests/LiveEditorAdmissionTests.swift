import CanopyAppKit
import Overstory
import CanopyWorkingTree
@testable import CanopyEditor
import Foundation
import Quagmire
import QuagmireExtras
import Testing

/// Uses Quagmire's ledger, the real document session and publication coordinator,
/// and a disposable Canopy supplied by the protocol harness. No admission mocks.
@MainActor
@Suite("Live editor admission", .serialized)
struct LiveEditorAdmissionTests {
    private func place(_ current: ProtocolCurrentTree, client: ProtocolClient) async throws -> WorkingTree {
        let tree = try await WorkingTree.inMemory(tree: TreeID(rawValue: current.tree.id))
        let snapshot = try await client.snapshot(tree: current.tree.id, root: current.tree.root)
        try await tree.initializeFromSystem(SnapshotBridge.replacement(snapshot: snapshot,
            tree: TreeID(rawValue: current.tree.id), update: current.tree.update, cursor: current.observedThrough))
        return tree
    }

    private func freshUndoPage(client: ProtocolClient, tree: String, content: String = "Causal second\n\nRetained tail\n") async throws -> WorkspaceReference {
        let current = try await client.descriptor(tree: tree)
        let snapshot = try await client.snapshot(tree: tree, root: current.tree.root)
        let root = try #require(snapshot.objects.first { $0.hash == snapshot.root })
        guard case let .directory(original, descriptor) = try ProtocolObjectCodec.decode(root.bytes, kind: .directory) else {
            throw WorkspaceProviderError.invalidAction("Expected directory")
        }
        let name = "undo-" + UUID().uuidString
        let file = Data(content.utf8), hash = ProtocolObjectCodec.hash(file)
        var entries = original; entries.append(.init(name: name + ".md", file: hash))
        entries.sort { $0.name.utf8.lexicographicallyPrecedes($1.name.utf8) }
        let bytes = try ProtocolObjectCodec.encode(.directory(entries, childrenSource: descriptor))
        let update = ProtocolCandidateUpdate(candidate: ProtocolObjectCodec.hash(bytes), change: UUID().uuidString,
            trace: nil, objects: [.init(hash: hash, bytes: file), .init(hash: ProtocolObjectCodec.hash(bytes), bytes: bytes)])
        let request = try await client.prepareUpdates(tree: tree, base: .init(root: snapshot.root, update: current.tree.update), updates: [update])
        _ = try await client.submitUpdateResponse(request)
        return .init(tree: TreeID(rawValue: tree), path: "/" + name)
    }

    private func edit(_ binding: CanopyDocumentBinding, text: String) {
        binding.document.transaction(name: "Typing") {
            _ = binding.document.setText(binding.document.children[0].id, AttributedString(text))
        }
        binding.appendCurrentGeneration()
    }

    @Test("Cross-document copies and page conversion undo retain their authored scope", arguments: [false, true])
    func crossDocumentActions(peerEdit: Bool) async throws {
        let env = ProcessInfo.processInfo.environment
        guard let address = env["ARBOR_SOURCE_TEST_URL"], let url = URL(string: address),
              let token = env["ARBOR_SOURCE_TEST_TOKEN"], let treeID = env["ARBOR_CROSS_DOCUMENT_TEST_TREE"] else { return }
        let root = FileManager.default.temporaryDirectory.appending(path: "cross-document-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let client = ProtocolClient(origin: url, credential: token)
        let source = try await freshUndoPage(client: client, tree: treeID)
        let destination = try await freshUndoPage(client: client, tree: treeID)
        let tree = try await place(client.descriptor(tree: treeID), client: client)
        let coordinator = try UpdateCoordinator(workingTree: tree, transport: ProtocolReplicaTransport(client: client), stateRoot: root , publicationDelay: .seconds(3600), publicationMaxDelay: .seconds(3600))
        let provider = WorkingTreeProvider(workingTree: tree, coordinator: coordinator)
        let session = try await provider.openDocument(source)
        let binding = try await CanopyDocumentBinding.open(reference: source, session: session)
        let host = CanopyEditorHost(binding: binding, provider: provider, linkPreviewService: LinkPreviewService(cacheDirectory: root.appending(path: "previews")))
        let undo = UndoManager(); undo.groupsByEvent = false; binding.document.undoManager = undo
        binding.document.didCommitTransaction = { _ in binding.appendCurrentGeneration() }
        let original = try await session.snapshot().source
        #expect(await host.copyToDocument(CanopyDocumentReferenceCodec.encode(destination), blocks: [binding.document.children[0]], from: binding.document))
        _ = try await coordinator.syncOnce()
        let queue = try await ChangeLog(tree: treeID, stateRoot: root)
        #expect(try await queue.retained().contains { $0.update.trace?.contains { $0.operations.contains { $0.kind == "copySource" } } == true })
        let action = UUID(), block = binding.document.children[0]
        let page = try #require(await host.createDocument(title: "Converted " + action.uuidString, requestedReference: nil,
            initialContent: [block], transaction: action))
        binding.document.withTransactionIdentity(action) {
            binding.document.transaction(name: "Create Document") {
                binding.document.replaceSubtree(block.id, with: [.documentLink(label: AttributedString("Converted"), reference: page, id: block.id)])
            }
        }
        binding.appendCurrentGeneration(); await binding.flush()
        #expect(binding.lastError == nil)
        _ = try await coordinator.syncOnce()
        let created = try #require(CanopyDocumentReferenceCodec.decode(page))
        #expect(try await provider.resolve(created).reference.stableKey != nil)
        if peerEdit {
            let capture = try await tree.captureSourceBasis(created)
            let text = capture.document.source + "\nPeer work must survive undo\n"
            let patch = WorkspaceDocumentPatch(baseContentRevision: capture.document.contentRevision,
                edits: [.init(utf8Range: capture.document.source.utf8.count..<capture.document.source.utf8.count, replacement: "\nPeer work must survive undo\n")])
            let record = try capture.prepare(intent: .init(basis: capture.document, patch: patch, source: text))
            let request = try await client.prepareUpdates(tree: treeID, base: #require(capture.accepted), updates: [record.update])
            _ = try await client.submitUpdateResponse(request)
            _ = try await coordinator.recoverWatchGap()
        }
        undo.undo(); binding.appendCurrentGeneration(); await binding.flush()
        #expect(binding.lastError == nil)
        #expect(try await session.snapshot().source == original)
        // Undo is a plain source edit to the owning document: the created page
        // survives, a peer's work on it is untouched, and no conflict arises.
        #expect(try await provider.resolve(created).reference.stableKey != nil)
        if peerEdit {
            _ = try await coordinator.syncOnce()
            let peerPage = try await tree.captureSourceBasis(created)
            #expect(peerPage.document.source.contains("Peer work must survive undo"))
            #expect(try await client.descriptor(tree: treeID).tree.conflicted == false)
        }
        let retained = try await queue.retained()
        #expect(!retained.contains { $0.update.trace?.contains { $0.operations.contains { $0.kind == "removeEntry" } } == true })
        let reopened = try await ChangeLog(tree: treeID, stateRoot: root)
        #expect(try await reopened.retained() == retained)
        undo.redo(); binding.appendCurrentGeneration(); await binding.flush()
        #expect(binding.lastError == nil)
        #expect(try await provider.resolve(created).reference.stableKey != nil)
        if peerEdit {
            edit(binding, text: "Continued after structural undo")
            await binding.flush()
            #expect(binding.lastError == nil)
            _ = try await coordinator.syncOnce()
            let current = try await client.descriptor(tree: treeID)
            _ = try await client.conflicts(tree: treeID, state: current.tree.update, root: current.tree.root)
        }
        await binding.close(); await coordinator.close(); await tree.close()
    }

    @Test("R1 editor intent survives R2, recovery and accepted conflict without a local hold", arguments: [false, true])
    func staleEditorIntent(recoverDraft: Bool) async throws {
        let env = ProcessInfo.processInfo.environment
        guard let address = env["ARBOR_SOURCE_TEST_URL"], let url = URL(string: address),
              let token = env["ARBOR_SOURCE_TEST_TOKEN"], let treeID = env["ARBOR_SOURCE_TEST_TREE"] else { return }
        let root = FileManager.default.temporaryDirectory.appending(path: "live-editor-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let queueRoot = root.appending(path: "client")
        let client = ProtocolClient(origin: url, credential: token)
        let initial = try await client.descriptor(tree: treeID)
        var tree = try await place(initial, client: client)
        let reference = WorkspaceReference(tree: TreeID(rawValue: treeID), path: "/page")
        let transport = ProtocolReplicaTransport(client: client)
        var coordinator = try UpdateCoordinator(workingTree: tree, transport: transport, stateRoot: queueRoot , publicationDelay: .seconds(3600), publicationMaxDelay: .seconds(3600))
        var session = try await WorkingTreeProvider(workingTree: tree, coordinator: coordinator).openDocument(reference)
        let r1 = try await session.snapshot()
        var binding: CanopyDocumentBinding? = try await .open(reference: reference, session: session)
        // The editor holds R1 and has not captured its edit yet (Quagmire's
        // typing checkpoint) when a peer's R2 is installed beneath it.
        binding?.stopObserving()

        let capture = try await tree.captureSourceBasis(reference)
        let peerSource = "Peer before admission \(UUID())\n"
        let peerIntent = try WorkspaceDocumentIntent(basis: capture.document,
            patch: .init(baseContentRevision: capture.document.contentRevision,
                         edits: [.init(utf8Range: 0..<capture.document.source.utf8.count,
                                       replacement: peerSource, expected: capture.document.source)]), source: peerSource)
        let peer = try capture.prepare(intent: peerIntent)
        let request = try await client.prepareUpdates(tree: treeID, base: #require(capture.accepted), updates: [peer.update])
        _ = try await client.submitUpdateResponse(request)
        _ = try await coordinator.recoverWatchGap()
        let remote = try await client.descriptor(tree: treeID)
        #expect(try await tree.heads().acceptedUpdate == remote.tree.update)

        // The R1-authored edit is appended against R1, not rebased onto R2.
        edit(try #require(binding), text: "Exact local intent \(UUID())")
        let authored = try #require(binding?.lastEnqueuedSource)

        if recoverDraft {
            // The generation is durable in the change log as soon as its append
            // returns. Lose the editor and the in-memory replica, rebuild the
            // replica at R2, and the R1 change is still there.
            await binding?.flush()
            binding = nil
            await session.close(); await coordinator.close(); await tree.close()
            tree = try await place(remote, client: client)
            coordinator = try UpdateCoordinator(workingTree: tree, transport: transport, stateRoot: queueRoot , publicationDelay: .seconds(3600), publicationMaxDelay: .seconds(3600))
            session = try await WorkingTreeProvider(workingTree: tree, coordinator: coordinator).openDocument(reference)
            binding = try await .open(reference: reference, session: session)
            #expect(binding?.lastEnqueuedSource == nil)
            #expect(try await session.snapshot().source == authored)
        }
        await binding?.flush()
        #expect(binding?.lastError == nil)
        let queue = try await ChangeLog(tree: treeID, stateRoot: queueRoot)
        let record = try #require(try await queue.retained().first)
        // Records keep no sources; the basis revision and the candidate's bytes prove the same capture.
        #expect(record.document?.basisRevision == r1.contentRevision)
        #expect(record.graph.objects.contains { $0.bytes == Data(r1.source.utf8) })
        #expect(record.candidate.objects.contains { $0.bytes == Data(authored.utf8) })
        #expect(record.basis == .accepted(.init(root: initial.tree.root, update: initial.tree.update)))
        await binding?.close(); binding = nil
        await coordinator.close(); await tree.close()

        // Reopen after durable client admission, then publish its original request.
        tree = try await place(remote, client: client)
        coordinator = try UpdateCoordinator(workingTree: tree, transport: transport, stateRoot: queueRoot , publicationDelay: .seconds(3600), publicationMaxDelay: .seconds(3600))
        let accepted = try await coordinator.syncOnce()
        #expect(accepted.acceptedConflicted == true)
        #expect(try await coordinator.presentation().state == .current)
        session = try await WorkingTreeProvider(workingTree: tree, coordinator: coordinator).openDocument(reference)
        binding = try await .open(reference: reference, session: session)
        #expect(try await session.snapshot().source == peerSource)
        edit(try #require(binding), text: "Continued after acceptance \(UUID())")
        let continued = try #require(binding?.lastEnqueuedSource)
        await binding?.flush()
        #expect(binding?.lastError == nil)
        _ = try await coordinator.syncOnce()
        #expect(try await coordinator.presentation().state == .current)
        #expect(try await session.snapshot().source == continued)

        // Resolve through Canopy's inspection contract, not a local conflict draft.
        let current = try await client.descriptor(tree: treeID)
        let page = try await client.conflicts(tree: treeID, state: current.tree.update, root: current.tree.root)
        guard case let .array(decisions) = page.fields["decisions"], decisions.count == 1,
              case let .object(decision) = decisions[0], case let .string(id) = decision["id"],
              case let .array(alternatives) = decision["alternatives"] else {
            Issue.record("Expected one accepted whole-entry decision"); return
        }
        let ids = try alternatives.map { value -> String in
            guard case let .object(fields) = value, case let .string(id) = fields["id"] else {
                throw ProtocolValidationError.invalidValue("Missing alternative identity")
            }
            return id
        }
        #expect(alternatives.count == 2)
        let resolution = ProtocolCandidateUpdate(candidate: current.tree.root, trace: [],
            resolves: [.init(state: current.tree.update, conflict: id, alternatives: ids)], objects: [])
        let prepared = try await client.prepareUpdates(tree: treeID,
            base: .init(root: current.tree.root, update: current.tree.update), updates: [resolution])
        _ = try await client.submitUpdateResponse(prepared)
        _ = try await coordinator.recoverWatchGap()
        #expect(try await coordinator.presentation().acceptedConflicted == false)
        #expect(try await session.snapshot().source == continued)
        await binding?.close(); await coordinator.close(); await tree.close()
    }
}

extension LiveEditorAdmissionTests {
    @Test("Explicit editor copy survives draft loss, client restart and Canopy publication",arguments:[false,true])
    func sourceCopyPublication(recoverDraft: Bool) async throws {
        let env = ProcessInfo.processInfo.environment
        guard let address = env["ARBOR_SOURCE_TEST_URL"], let url = URL(string:address),
              let token = env["ARBOR_SOURCE_TEST_TOKEN"], let treeID = env["ARBOR_SOURCE_TEST_TREE"] else { return }
        let root = FileManager.default.temporaryDirectory.appending(path:"copy-editor-\(UUID())")
        defer { try? FileManager.default.removeItem(at:root) }
        let client = ProtocolClient(origin:url,credential:token), transport = ProtocolReplicaTransport(client:ProtocolClient(origin:url,credential:token))
        let initial = try await client.descriptor(tree:treeID)
        var tree = try await place(initial,client:client)
        var coordinator = try UpdateCoordinator(workingTree:tree,transport:transport,stateRoot:root ,publicationDelay:.seconds(3600),publicationMaxDelay:.seconds(3600))
        let reference = WorkspaceReference(tree:TreeID(rawValue:treeID),path:"/page")
        var session = try await WorkingTreeProvider(workingTree:tree,coordinator:coordinator).openDocument(reference)
        let original = try await session.snapshot()

        var binding: CanopyDocumentBinding? = try await .open(reference:reference,session:session)
        let document = try #require(binding?.document)
        document.didCommitTransaction = { [weak binding] _ in binding?.appendCurrentGeneration() }
        _ = document.insertCopies(of:[document.children[0]],at:.init(parent:nil,position:0))
        let authored = try #require(binding?.lastEnqueuedSource)
        var expected = authored
        if recoverDraft {
            // Durable once appended: losing the editor and client keeps it.
            await binding?.flush()
            binding?.stopObserving(); binding = nil
            await session.close(); await coordinator.close(); await tree.close()
            tree = try await place(initial,client:client)
            coordinator = try UpdateCoordinator(workingTree:tree,transport:transport,stateRoot:root ,publicationDelay:.seconds(3600),publicationMaxDelay:.seconds(3600))
            session = try await WorkingTreeProvider(workingTree:tree,coordinator:coordinator).openDocument(reference)
            binding = try await .open(reference:reference,session:session)
            let restored = try #require(binding)
            restored.document.transaction(name:"Edit immediately after recovery") {
                _ = restored.document.insertSubtree(.paragraph(text:AttributedString("After recovery")),at:.init(parent:nil,position:restored.document.children.count))
            }
            restored.appendCurrentGeneration()
            expected = try #require(restored.lastEnqueuedSource)
        }
        await binding?.flush()
        #expect(binding?.lastError == nil)
        let records = try await ChangeLog(tree:treeID,stateRoot:root).retained()
        let record = try #require(records.first)
        let final = try #require(records.last)
        #expect(record.graph.objects.contains { $0.bytes == Data(original.source.utf8) })
        #expect(record.candidate.objects.contains { $0.bytes == Data(authored.utf8) })
        #expect(record.update.trace?.contains { $0.operations.contains { $0.kind == "copySource" } } == true)
        await binding?.close(); binding = nil; await coordinator.close(); await tree.close()
        tree = try await place(initial,client:client)
        coordinator = try UpdateCoordinator(workingTree:tree,transport:transport,stateRoot:root ,publicationDelay:.seconds(3600),publicationMaxDelay:.seconds(3600))
        _ = try await coordinator.syncOnce()
        #expect(try await coordinator.presentation().state == .current)
        #expect(try await client.descriptor(tree:treeID).tree.root == final.candidate.root)
        let source = try await WorkingTreeProvider(workingTree:tree,coordinator:coordinator).openDocument(reference).snapshot().source
        #expect(source == expected)
        await coordinator.close(); await tree.close()
    }
    @Test("Editor undo and redo publish as ordinary edits", arguments: [false, true])
    func plainUndoPublication(peerEdit: Bool) async throws {
        let env = ProcessInfo.processInfo.environment
        guard let address = env["ARBOR_SOURCE_TEST_URL"], let url = URL(string: address),
              let token = env["ARBOR_SOURCE_TEST_TOKEN"], let treeID = env["ARBOR_SOURCE_TEST_TREE"] else { return }
        let root = FileManager.default.temporaryDirectory.appending(path: "plain-undo-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let client = ProtocolClient(origin: url, credential: token)
        let reference = try await freshUndoPage(client: client, tree: treeID)
        let tree = try await place(client.descriptor(tree: treeID), client: client)
        let coordinator = try UpdateCoordinator(workingTree: tree, transport: ProtocolReplicaTransport(client: client),
            stateRoot: root , publicationDelay: .seconds(3600), publicationMaxDelay: .seconds(3600))
        let session = try await WorkingTreeProvider(workingTree: tree, coordinator: coordinator).openDocument(reference)
        let binding = try await CanopyDocumentBinding.open(reference: reference, session: session)
        let original = try await session.snapshot().source
        let manager = UndoManager(); manager.groupsByEvent = false
        let document = binding.document; document.undoManager = manager
        document.didCommitTransaction = { _ in binding.appendCurrentGeneration() }
        for text in ["Plain first", "Plain second"] {
            document.transaction(name: "Typing", coalesceKey: "typing") {
                _ = document.setText(document.children[0].id, AttributedString(text))
            }
        }
        let authored = try #require(binding.lastEnqueuedSource)
        await binding.flush()
        #expect(binding.lastError == nil)
        _ = try await coordinator.syncOnce()
        let queue = try await ChangeLog(tree: treeID, stateRoot: root)
        var suffix = ""
        if peerEdit {
            binding.stopObserving()
            let capture = try await tree.captureSourceBasis(reference)
            suffix = "\n\nIndependent peer contribution\n"
            let patch = WorkspaceDocumentPatch(baseContentRevision: capture.document.contentRevision,
                edits: [.init(utf8Range: capture.document.source.utf8.count..<capture.document.source.utf8.count, replacement: suffix)])
            let peer = try capture.prepare(intent: .init(basis: capture.document, patch: patch, source: capture.document.source + suffix))
            let request = try await client.prepareUpdates(tree: treeID, base: #require(capture.accepted), updates: [peer.update])
            _ = try await client.submitUpdateResponse(request)
            _ = try await coordinator.recoverWatchGap()
        }
        manager.undo()
        await binding.flush()
        #expect(binding.lastError == nil)
        // The editor's local candidate is the plain undo; Canopy merges the peer's
        // independent append, visible once the accepted projection installs.
        _ = try await coordinator.syncOnce()
        #expect(try await session.snapshot().source == original + suffix)
        let retained = try await queue.retained()
        // No inverse operations, no transaction evidence, no document sources in the journal.
        #expect(retained.allSatisfy { $0.update.trace?.allSatisfy { $0.operations.allSatisfy { $0.kind == "editSource" } } == true })
        let journal = String(decoding: try Data(contentsOf: root.appending(path: "sync/change-log.json")), as: UTF8.self)
        #expect(!journal.contains("Plain first"))
        manager.redo()
        await binding.flush()
        #expect(binding.lastError == nil)
        _ = try await coordinator.syncOnce()
        #expect(try await session.snapshot().source == authored + suffix)
        // Settled records leave the journal once accepted; only the document's tail remains.
        #expect(try await queue.retained().count <= 2)
        await binding.close(); await coordinator.close(); await tree.close()
    }

    /// The Markdown-normalization case that used to fail closed: a list item is
    /// inserted, typed into, then nested within one debounced burst, so the
    /// last generation's exact layout differs from a re-encoding against the
    /// oldest basis. Each generation is now its own frame; the three plain
    /// insertions compact into one, and a block reorder in the same burst
    /// is a move in a second frame against the exact intermediate root.
    @Test("A coalesced burst that nests a list item and reorders publishes two frames with a move in the second and is accepted")
    func coalescedListNormalizationFrames() async throws {
        let env = ProcessInfo.processInfo.environment
        guard let address = env["ARBOR_SOURCE_TEST_URL"], let url = URL(string: address),
              let token = env["ARBOR_SOURCE_TEST_TOKEN"], let treeID = env["ARBOR_SOURCE_TEST_TREE"] else { return }
        let root = FileManager.default.temporaryDirectory.appending(path: "coalesced-frames-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let client = ProtocolClient(origin: url, credential: token)
        let reference = try await freshUndoPage(client: client, tree: treeID)
        let tree = try await place(client.descriptor(tree: treeID), client: client)
        let coordinator = try UpdateCoordinator(workingTree: tree, transport: ProtocolReplicaTransport(client: client),
            stateRoot: root , publicationDelay: .seconds(3600), publicationMaxDelay: .seconds(3600))
        let session = try await WorkingTreeProvider(workingTree: tree, coordinator: coordinator).openDocument(reference)
        let binding = try await CanopyDocumentBinding.open(reference: reference, session: session)
        let document = binding.document
        let bullet = Block.bullet(text: AttributedString())
        document.transaction(name: "Insert list item") { _ = document.insertSubtree(bullet, at: .init(parent: nil, position: 1)) }
        binding.appendCurrentGeneration()
        document.transaction(name: "Type list item") { _ = document.setText(bullet.id, AttributedString("the conflict stuff is buggy / weird")) }
        binding.appendCurrentGeneration()
        document.transaction(name: "Continue list") {
            _ = document.insertSubtree(.bullet(text: AttributedString()), at: .init(parent: bullet.id, position: 0))
        }
        binding.appendCurrentGeneration()
        #expect(binding.lastEnqueuedSource?.contains("- the conflict stuff is buggy / weird\n\n  - \n\n") == true)
        document.transaction(name: "Reorder") { _ = document.replaceChildrenReconciled(Array(document.children.reversed())) }
        binding.appendCurrentGeneration()
        let expected = try #require(binding.lastEnqueuedSource)
        #expect(binding.generation == 4)
        await binding.flush()
        #expect(binding.lastError == nil, Comment(rawValue: String(describing: binding.lastError)))
        #expect(try await session.snapshot().source == expected)
        let queue = try await ChangeLog(tree: treeID, stateRoot: root)
        let record = try #require(try await queue.retained().last { $0.document?.reference == reference })
        let frames = try #require(record.update.trace)
        #expect(frames.count == 2, Comment(rawValue: "frames=\(frames.count)"))
        #expect(frames.first?.operations.allSatisfy { $0.kind == "editSource" && $0.fields["lineage"] == nil } == true)
        #expect(frames.last?.operations.first?.kind == "moveSource", Comment(rawValue: "\(frames.last?.operations.map(\.kind) ?? [])"))
        #expect(frames.first?.before == record.graph.root && frames.last?.after == record.candidate.root)
        // Canopy validates the chain frame by frame and accepts it.
        let accepted = try await coordinator.syncOnce()
        #expect(accepted.state == .current, Comment(rawValue: String(describing: accepted)))
        #expect(try await session.snapshot().source == expected)
        await binding.close(); await coordinator.close(); await tree.close()
    }

    /// A reorder is published as a move of the moved paragraph's exact source,
    /// survives a restart as the same request, carries a peer's concurrent
    /// edit to the moved text, and the page keeps editing afterwards.
    @Test("A moved paragraph publishes as a move, replays after restart, and carries a peer's edit", arguments: [false, true])
    func movedParagraph(peerEdit: Bool) async throws {
        let env = ProcessInfo.processInfo.environment
        guard let address = env["ARBOR_SOURCE_TEST_URL"], let url = URL(string: address),
              let token = env["ARBOR_SOURCE_TEST_TOKEN"], let treeID = env["ARBOR_SOURCE_TEST_TREE"] else { return }
        let root = FileManager.default.temporaryDirectory.appending(path: "moved-paragraph-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let client = ProtocolClient(origin: url, credential: token)
        let reference = try await freshUndoPage(client: client, tree: treeID, content: "First para\n\nSecond para\n\nMoved para\n")
        let tree = try await place(client.descriptor(tree: treeID), client: client)
        let transport = ProtocolReplicaTransport(client: client)
        var coordinator = try UpdateCoordinator(workingTree: tree, transport: transport, stateRoot: root,
            publicationDelay: .seconds(3600), publicationMaxDelay: .seconds(3600))
        // The peer authors against the accepted page before the move is published.
        let capture = try await tree.captureSourceBasis(reference)
        let session = try await WorkingTreeProvider(workingTree: tree, coordinator: coordinator).openDocument(reference)
        let binding = try await CanopyDocumentBinding.open(reference: reference, session: session)
        let document = binding.document
        document.transaction(name: "Move Block") {
            var children = document.children
            children.insert(children.removeLast(), at: 0)
            _ = document.replaceChildrenReconciled(children)
        }
        binding.appendCurrentGeneration()
        await binding.flush()
        #expect(binding.lastError == nil)
        let expected = "Moved para\n\nFirst para\n\nSecond para\n\n"
        #expect(try await session.snapshot().source == expected)
        await binding.close()
        let queue = try await ChangeLog(tree: treeID, stateRoot: root)
        let record = try #require(try await queue.retained().last { $0.document?.reference == reference })
        let operations = try #require(record.update.trace).flatMap(\.operations)
        #expect(operations.map(\.kind) == ["moveSource", "editSource"], Comment(rawValue: "\(operations.map(\.kind))"))
        // A restart retains the identical request: no rebasing or re-derivation.
        await coordinator.close()
        coordinator = try UpdateCoordinator(workingTree: tree, transport: transport, stateRoot: root,
            publicationDelay: .seconds(3600), publicationMaxDelay: .seconds(3600))
        let reopened = try #require(try await ChangeLog(tree: treeID, stateRoot: root).retained().last { $0.document?.reference == reference })
        #expect(reopened.update == record.update)
        var final = expected
        if peerEdit {
            let original = capture.document.source, word = try #require(original.range(of: "Moved"))
            let range = original.utf8.distance(from: original.startIndex, to: word.lowerBound)..<original.utf8.distance(from: original.startIndex, to: word.upperBound)
            let patch = WorkspaceDocumentPatch(baseContentRevision: capture.document.contentRevision, edits: [.init(utf8Range: range, replacement: "Peer-edited")])
            let peer = try capture.prepare(intent: .init(basis: capture.document, patch: patch, source: original.replacingOccurrences(of: "Moved", with: "Peer-edited")))
            let request = try await client.prepareUpdates(tree: treeID, base: #require(capture.accepted), updates: [peer.update])
            _ = try await client.submitUpdateResponse(request)
            _ = try await coordinator.recoverWatchGap()
            final = expected.replacingOccurrences(of: "Moved", with: "Peer-edited")
        }
        let accepted = try await coordinator.syncOnce()
        #expect(accepted.state == .current, Comment(rawValue: String(describing: accepted)))
        let provider = WorkingTreeProvider(workingTree: tree, coordinator: coordinator)
        let after = try await provider.openDocument(reference)
        #expect(try await after.snapshot().source == final)
        // Editing continues on the accepted result, inside the moved paragraph.
        let continued = try await CanopyDocumentBinding.open(reference: reference, session: after)
        continued.document.transaction(name: "Typing") {
            _ = continued.document.setText(continued.document.children[0].id, AttributedString("Typed after the move"))
        }
        continued.appendCurrentGeneration()
        await continued.flush()
        #expect(continued.lastError == nil)
        #expect(try await coordinator.syncOnce().state == .current)
        #expect(try await after.snapshot().source == "Typed after the move\n\nFirst para\n\nSecond para\n\n")
        await continued.close(); await coordinator.close(); await tree.close()
    }
}
