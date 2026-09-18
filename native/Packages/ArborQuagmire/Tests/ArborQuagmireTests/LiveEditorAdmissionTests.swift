import ArborKit
import ArborWire
import ArborWorkingTree
@testable import ArborQuagmire
import Foundation
import Quagmire
import QuagmireExtras
import Testing

/// Uses Quagmire's ledger, the real document session and publication coordinator,
/// and a disposable Canopy supplied by the protocol harness. No admission mocks.
@MainActor
@Suite("Live editor admission", .serialized)
struct LiveEditorAdmissionTests {
    private func place(_ current: WireCurrentTree, client: ArborWireClient) async throws -> WorkingTree {
        let tree = try await WorkingTree.inMemory(tree: TreeID(rawValue: current.tree.id))
        let snapshot = try await client.snapshot(tree: current.tree.id, root: current.tree.root)
        try await tree.initializeFromSystem(SnapshotBridge.replacement(snapshot: snapshot,
            tree: TreeID(rawValue: current.tree.id), update: current.tree.update, cursor: current.observedThrough))
        return tree
    }

    private func freshUndoPage(client: ArborWireClient, tree: String) async throws -> WorkspaceReference {
        let current = try await client.descriptor(tree: tree)
        let snapshot = try await client.snapshot(tree: tree, root: current.tree.root)
        let root = try #require(snapshot.objects.first { $0.hash == snapshot.root })
        guard case let .directory(original, descriptor) = try WireObjectCodec.decode(root.bytes, kind: .directory) else {
            throw WorkspaceProviderError.invalidAction("Expected directory")
        }
        let name = "undo-" + UUID().uuidString
        let file = Data("Causal second\n\nRetained tail\n".utf8), hash = WireObjectCodec.hash(file)
        var entries = original; entries.append(.init(name: name + ".md", file: hash))
        entries.sort { $0.name.utf8.lexicographicallyPrecedes($1.name.utf8) }
        let bytes = try WireObjectCodec.encode(.directory(entries, childrenSource: descriptor))
        let update = WireCandidateUpdate(candidate: WireObjectCodec.hash(bytes), change: UUID().uuidString,
            operations: nil, objects: [.init(hash: hash, bytes: file), .init(hash: WireObjectCodec.hash(bytes), bytes: bytes)])
        let request = try await client.prepareUpdates(tree: tree, base: .init(root: snapshot.root, update: current.tree.update), updates: [update])
        _ = try await client.submitUpdateResponse(request)
        return .init(tree: TreeID(rawValue: tree), path: "/" + name)
    }

    private func edit(_ binding: ArborDocumentBinding, text: String) {
        binding.document.transaction(name: "Typing") {
            _ = binding.document.setText(binding.document.children[0].id, AttributedString(text))
        }
        binding.admitCurrentGeneration()
    }

    @Test("Cross-document copies and page conversion undo retain their authored scope", arguments: [false, true])
    func crossDocumentActions(peerEdit: Bool) async throws {
        let env = ProcessInfo.processInfo.environment
        guard let address = env["ARBOR_SOURCE_TEST_URL"], let url = URL(string: address),
              let token = env["ARBOR_SOURCE_TEST_TOKEN"], let treeID = env["ARBOR_CROSS_DOCUMENT_TEST_TREE"] else { return }
        let root = FileManager.default.temporaryDirectory.appending(path: "cross-document-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let client = ArborWireClient(origin: url, credential: token)
        let source = try await freshUndoPage(client: client, tree: treeID)
        let destination = try await freshUndoPage(client: client, tree: treeID)
        let tree = try await place(client.descriptor(tree: treeID), client: client)
        let coordinator = try UpdateCoordinator(workingTree: tree, transport: ArborWireReplicaTransport(client: client), stateRoot: root,
            sourceOperationEmission: true, publicationDelay: .seconds(3600), publicationMaxDelay: .seconds(3600))
        let provider = WorkingTreeProvider(workingTree: tree, sourceCoordinator: coordinator)
        let session = try await provider.openDocument(source)
        let binding = try await ArborDocumentBinding.open(reference: source, session: session, debounce: .seconds(3600))
        let host = ArborEditorHost(binding: binding, provider: provider, linkPreviewService: LinkPreviewService(cacheDirectory: root.appending(path: "previews")))
        let undo = UndoManager(); undo.groupsByEvent = false; binding.document.undoManager = undo
        binding.document.didCommitTransaction = { _ in binding.admitCurrentGeneration() }
        let original = try await session.snapshot().source
        #expect(await host.copyToDocument(ArborDocumentReferenceCodec.encode(destination), blocks: [binding.document.children[0]], from: binding.document))
        _ = try await coordinator.syncOnce()
        let queue = try await SourceAdmissionQueue(tree: treeID, stateRoot: root)
        #expect(try await queue.retained().contains { $0.update.operations?.contains { $0.kind == "copySource" } == true })
        let action = UUID(), block = binding.document.children[0]
        let page = try #require(await host.createDocument(title: "Converted " + action.uuidString, requestedReference: nil,
            initialContent: [block], transaction: action))
        binding.document.withTransactionIdentity(action) {
            binding.document.transaction(name: "Create Document") {
                binding.document.replaceSubtree(block.id, with: [.documentLink(label: AttributedString("Converted"), reference: page, id: block.id)])
            }
        }
        binding.admitCurrentGeneration(); await binding.flush()
        #expect(binding.lastError == nil)
        _ = try await coordinator.syncOnce()
        let created = try #require(ArborDocumentReferenceCodec.decode(page))
        #expect(try await provider.resolve(created).reference.stableKey != nil)
        if peerEdit {
            let capture = try await tree.captureSourceAdmissionBasis(created)
            let text = capture.document.source + "\nPeer work must survive undo\n"
            let patch = WorkspaceDocumentPatch(baseContentRevision: capture.document.contentRevision,
                edits: [.init(utf8Range: capture.document.source.utf8.count..<capture.document.source.utf8.count, replacement: "\nPeer work must survive undo\n")])
            let record = try capture.prepare(intent: .init(basis: capture.document, patch: patch, source: text))
            let request = try await client.prepareUpdates(tree: treeID, base: #require(capture.accepted), updates: [record.update])
            _ = try await client.submitUpdateResponse(request)
            _ = try await coordinator.recoverWatchGap()
        }
        undo.undo(); binding.admitCurrentGeneration(); await binding.flush()
        #expect(binding.lastError == nil)
        #expect(try await session.snapshot().source == original)
        if peerEdit {
            let accepted = try await client.descriptor(tree: treeID)
            #expect(accepted.tree.conflicted)
            let inspection = try await client.conflicts(tree: treeID, state: accepted.tree.update, root: accepted.tree.root)
            guard case let .array(decisions)? = inspection.fields["decisions"] else { Issue.record("Missing decisions"); return }
            #expect(!decisions.isEmpty)
        } else {
            await #expect(throws: (any Error).self) { try await provider.resolve(created) }
        }
        let retained = try await queue.retained()
        #expect(retained.contains { $0.undoOf != nil && $0.creation != nil && $0.update.operations?.contains { $0.kind == "removeEntry" } == true })
        let reopened = try await SourceAdmissionQueue(tree: treeID, stateRoot: root)
        #expect(try await reopened.retained() == retained)
        undo.redo(); binding.admitCurrentGeneration(); await binding.flush()
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
        let recovery = root.appending(path: "editor"), queueRoot = root.appending(path: "client")
        let client = ArborWireClient(origin: url, credential: token)
        let initial = try await client.descriptor(tree: treeID)
        var tree = try await place(initial, client: client)
        let reference = WorkspaceReference(tree: TreeID(rawValue: treeID), path: "/page")
        let transport = ArborWireReplicaTransport(client: client)
        var coordinator = try UpdateCoordinator(workingTree: tree, transport: transport, stateRoot: queueRoot,
            sourceOperationEmission: true, publicationDelay: .seconds(3600), publicationMaxDelay: .seconds(3600))
        var session = try await WorkingTreeProvider(workingTree: tree, sourceCoordinator: coordinator).openDocument(reference)
        let r1 = try await session.snapshot()
        var binding: ArborDocumentBinding? = try await .open(reference: reference, session: session,
            debounce: .seconds(3600), recoveryRoot: recovery)
        edit(try #require(binding), text: "Exact local intent \(UUID())")
        let authored = try #require(binding?.lastEnqueuedSource)

        let capture = try await tree.captureSourceAdmissionBasis(reference)
        let peerSource = "Peer before admission \(UUID())\n"
        let peerIntent = try WorkspaceDocumentIntent(basis: capture.document,
            patch: .init(baseContentRevision: capture.document.contentRevision,
                         edits: [.init(utf8Range: 0..<capture.document.source.utf8.count,
                                       replacement: peerSource, expected: capture.document.source)]), source: peerSource)
        let peer = try capture.prepare(intent: peerIntent)
        let request = try await client.prepareUpdates(tree: treeID, base: #require(capture.accepted), updates: [peer.update])
        _ = try await client.submitUpdateResponse(request)
        if recoverDraft { binding?.stopObserving() }
        _ = try await coordinator.recoverWatchGap()
        let remote = try await client.descriptor(tree: treeID)
        #expect(try await tree.heads().acceptedUpdate == remote.tree.update)
        #expect(binding?.conflict == nil)

        if recoverDraft {
            let unadmitted = try await SourceAdmissionQueue(tree: treeID, stateRoot: queueRoot)
            #expect(try await unadmitted.retained().isEmpty)
            // Lose the editor before debounce/admission, retaining only its own
            // recovery journal. Rebuild the replica at R2 and recover the R1 draft.
            binding?.stopObserving()
            binding = nil
            await session.close(); await coordinator.close(); await tree.close()
            tree = try await place(remote, client: client)
            coordinator = try UpdateCoordinator(workingTree: tree, transport: transport, stateRoot: queueRoot,
                sourceOperationEmission: true, publicationDelay: .seconds(3600), publicationMaxDelay: .seconds(3600))
            session = try await WorkingTreeProvider(workingTree: tree, sourceCoordinator: coordinator).openDocument(reference)
            binding = try await .open(reference: reference, session: session, debounce: .seconds(3600), recoveryRoot: recovery)
        }
        await binding?.flush()
        #expect(binding?.lastError == nil)
        #expect(binding?.conflict == nil)
        let queue = try await SourceAdmissionQueue(tree: treeID, stateRoot: queueRoot)
        let record = try #require(try await queue.retained().first)
        #expect(record.intent?.basis.source == r1.source)
        #expect(record.intent?.basis.contentRevision == r1.contentRevision)
        #expect(record.intent?.source == authored)
        #expect(record.basis == .accepted(.init(root: initial.tree.root, update: initial.tree.update)))
        await binding?.close(); binding = nil
        await coordinator.close(); await tree.close()

        // Reopen after durable client admission, then publish its original request.
        tree = try await place(remote, client: client)
        coordinator = try UpdateCoordinator(workingTree: tree, transport: transport, stateRoot: queueRoot,
            sourceOperationEmission: true, publicationDelay: .seconds(3600), publicationMaxDelay: .seconds(3600))
        let accepted = try await coordinator.syncOnce()
        #expect(accepted.acceptedConflicted == true)
        #expect(try await coordinator.presentation().state == .current)
        session = try await WorkingTreeProvider(workingTree: tree, sourceCoordinator: coordinator).openDocument(reference)
        binding = try await .open(reference: reference, session: session, debounce: .seconds(3600), recoveryRoot: recovery)
        #expect(try await session.snapshot().source == peerSource)
        #expect(binding?.conflict == nil)
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
                throw ArborWireValidationError.invalidValue("Missing alternative identity")
            }
            return id
        }
        #expect(alternatives.count == 2)
        let resolution = WireCandidateUpdate(candidate: current.tree.root, operations: [],
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
        let client = ArborWireClient(origin:url,credential:token), transport = ArborWireReplicaTransport(client:ArborWireClient(origin:url,credential:token))
        let initial = try await client.descriptor(tree:treeID)
        var tree = try await place(initial,client:client)
        var coordinator = try UpdateCoordinator(workingTree:tree,transport:transport,stateRoot:root,
            sourceOperationEmission:true,publicationDelay:.seconds(3600),publicationMaxDelay:.seconds(3600))
        let reference = WorkspaceReference(tree:TreeID(rawValue:treeID),path:"/page")
        var session = try await WorkingTreeProvider(workingTree:tree,sourceCoordinator:coordinator).openDocument(reference)
        let original = try await session.snapshot()
        let recovery = root.appending(path:"editor")
        var binding: ArborDocumentBinding? = try await .open(reference:reference,session:session,debounce:.seconds(3600),recoveryRoot:recovery)
        let document = try #require(binding?.document)
        document.didCommitTransaction = { [weak binding] _ in binding?.admitCurrentGeneration() }
        _ = document.insertCopies(of:[document.children[0]],at:.init(parent:nil,position:0))
        let authored = try #require(binding?.lastEnqueuedSource)
        var expected = authored
        if recoverDraft {
            binding?.stopObserving(); binding = nil
            await session.close(); await coordinator.close(); await tree.close()
            tree = try await place(initial,client:client)
            coordinator = try UpdateCoordinator(workingTree:tree,transport:transport,stateRoot:root,
                sourceOperationEmission:true,publicationDelay:.seconds(3600),publicationMaxDelay:.seconds(3600))
            session = try await WorkingTreeProvider(workingTree:tree,sourceCoordinator:coordinator).openDocument(reference)
            binding = try await .open(reference:reference,session:session,debounce:.seconds(3600),recoveryRoot:recovery)
            let restored = try #require(binding)
            restored.document.transaction(name:"Edit immediately after recovery") {
                _ = restored.document.insertSubtree(.paragraph(text:AttributedString("After recovery")),at:.init(parent:nil,position:restored.document.children.count))
            }
            restored.admitCurrentGeneration()
            expected = try #require(restored.lastEnqueuedSource)
        }
        await binding?.flush()
        #expect(binding?.lastError == nil)
        let records = try await SourceAdmissionQueue(tree:treeID,stateRoot:root).retained()
        let record = try #require(records.first)
        let final = try #require(records.last)
        #expect(record.intent?.basis.source == original.source)
        #expect(record.intent?.source == authored)
        #expect(record.update.operations?.contains { $0.kind == "copySource" } == true)
        await binding?.close(); binding = nil; await coordinator.close(); await tree.close()
        tree = try await place(initial,client:client)
        coordinator = try UpdateCoordinator(workingTree:tree,transport:transport,stateRoot:root,
            sourceOperationEmission:true,publicationDelay:.seconds(3600),publicationMaxDelay:.seconds(3600))
        _ = try await coordinator.syncOnce()
        #expect(try await coordinator.presentation().state == .current)
        #expect(try await client.descriptor(tree:treeID).tree.root == final.candidate.root)
        let source = try await WorkingTreeProvider(workingTree:tree,sourceCoordinator:coordinator).openDocument(reference).snapshot().source
        #expect(source == expected)
        await coordinator.close(); await tree.close()
    }
    @Test("Offline undo resumes after reconnect or losing the editor and client", arguments: [false, true])
    func offlineUndoRecovery(restart: Bool) async throws {
        let env = ProcessInfo.processInfo.environment
        guard let address = env["ARBOR_SOURCE_TEST_URL"], let url = URL(string: address),
              let token = env["ARBOR_SOURCE_TEST_TOKEN"], let treeID = env["ARBOR_SOURCE_TEST_TREE"] else { return }
        let root = FileManager.default.temporaryDirectory.appending(path: "offline-undo-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let recovery = root.appending(path: "editor"), client = ArborWireClient(origin: url, credential: token)
        let reference = try await freshUndoPage(client: client, tree: treeID)
        var tree = try await place(client.descriptor(tree: treeID), client: client)
        var coordinator = try UpdateCoordinator(workingTree: tree, transport: ArborWireReplicaTransport(client: client),
            stateRoot: root, sourceOperationEmission: true, publicationDelay: .seconds(3600), publicationMaxDelay: .seconds(3600))
        var session = try await WorkingTreeProvider(workingTree: tree, sourceCoordinator: coordinator).openDocument(reference)
        var binding: ArborDocumentBinding? = try await .open(reference: reference, session: session, debounce: .seconds(3600), recoveryRoot: recovery)
        let original = try await session.snapshot().source
        let manager = UndoManager(); manager.groupsByEvent = false
        let document = try #require(binding?.document); document.undoManager = manager
        document.didCommitTransaction = { [weak binding] _ in binding?.admitCurrentGeneration() }
        document.transaction(name: "Typing") { _ = document.setText(document.children[0].id, AttributedString("Offline undo target")) }
        await binding?.flush(); _ = try await coordinator.syncOnce()
        await coordinator.setTransportAvailable(false)
        manager.undo(); await binding?.flush()
        #expect(binding?.lastError != nil)
        let queue = try await SourceAdmissionQueue(tree: treeID, stateRoot: root)
        let retained = try await queue.retained()
        #expect(retained.last?.undoOf == retained.first?.change)
        // Independent reads keep the installed projection, not the historical inverse candidate.
        #expect(try await session.snapshot().source != original)
        if !restart {
            await coordinator.setTransportAvailable(true)
            _ = try await coordinator.syncOnce()
            for _ in 0..<500 {
                if binding?.lastError == nil { break }
                try await Task.sleep(for: .milliseconds(10))
            }
            #expect(binding?.lastError == nil)
            #expect(try await session.snapshot().source == original)
            await binding?.close(); await coordinator.close(); await tree.close()
            return
        }
        binding?.stopObserving(); binding = nil
        await session.close(); await coordinator.close(); await tree.close()
        tree = try await place(client.descriptor(tree: treeID), client: client)
        coordinator = try UpdateCoordinator(workingTree: tree, transport: ArborWireReplicaTransport(client: client),
            stateRoot: root, sourceOperationEmission: true, publicationDelay: .seconds(3600), publicationMaxDelay: .seconds(3600))
        session = try await WorkingTreeProvider(workingTree: tree, sourceCoordinator: coordinator).openDocument(reference)
        binding = try await .open(reference: reference, session: session, debounce: .seconds(3600), recoveryRoot: recovery)
        await binding?.flush()
        #expect(binding?.lastError == nil)
        #expect(try await session.snapshot().source == original)
        #expect(try await queue.retained() == retained)
        await binding?.close(); await coordinator.close(); await tree.close()
    }

    @Test("Coalesced editor undo and redo publish named inverses through Canopy", arguments: [0, 1, 2, 6, 3, 4, 5])
    func causalUndoPublication(scenario: Int) async throws {
        // Clean cases: settled typing, a peer append, undo before admission, and
        // copy. Repeat typing cases on the shared fixture's unresolved history;
        // those projections may retain alternatives, but later edits must work.
        let inheritedChoices = (3...5).contains(scenario), mode = scenario % 3, copying = scenario == 6
        let env = ProcessInfo.processInfo.environment
        guard let address = env["ARBOR_SOURCE_TEST_URL"], let url = URL(string: address),
              let token = env["ARBOR_SOURCE_TEST_TOKEN"], let treeID = env["ARBOR_SOURCE_TEST_TREE"] else { return }
        let root = FileManager.default.temporaryDirectory.appending(path: "undo-editor-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let client = ArborWireClient(origin: url, credential: token)
        let reference = inheritedChoices ? WorkspaceReference(tree: TreeID(rawValue: treeID), path: "/page") : try await freshUndoPage(client: client, tree: treeID)
        let tree = try await place(client.descriptor(tree: treeID), client: client)
        let coordinator = try UpdateCoordinator(workingTree: tree, transport: ArborWireReplicaTransport(client: client),
            stateRoot: root, sourceOperationEmission: true, publicationDelay: .seconds(3600), publicationMaxDelay: .seconds(3600))
        let session = try await WorkingTreeProvider(workingTree: tree, sourceCoordinator: coordinator).openDocument(reference)
        let binding = try await ArborDocumentBinding.open(reference: reference, session: session, debounce: .seconds(3600), recoveryRoot: root.appending(path: "editor"))
        let original = try await session.snapshot().source
        let manager = UndoManager(); manager.groupsByEvent = false
        let document = binding.document; document.undoManager = manager
        document.didCommitTransaction = { _ in binding.admitCurrentGeneration() }
        if copying {
            _ = document.insertCopies(of: [document.children[0]], at: .init(parent: nil, position: 0))
        } else {
            for text in ["Causal first", "Causal second"] {
                document.transaction(name: "Typing", coalesceKey: "typing") {
                    _ = document.setText(document.children[0].id, AttributedString(text))
                }
            }
        }
        let authored = try #require(binding.lastEnqueuedSource)
        if mode != 2 {
            await binding.flush()
            #expect(binding.lastError == nil)
            _ = try await coordinator.syncOnce()
        }
        let queue = try await SourceAdmissionQueue(tree: treeID, stateRoot: root)
        #expect(try await queue.retained().count == (mode == 2 ? 0 : copying ? 1 : 2))
        var suffix = ""
        if mode == 1 {
            binding.stopObserving()
            let capture = try await tree.captureSourceAdmissionBasis(reference)
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
        let undoSource = try await session.snapshot().source
        if !inheritedChoices { #expect(undoSource == original + suffix) }
        let recoveryStore = try EditorRecoveryStore(root: root.appending(path: "editor"), reference: reference)
        #expect(recoveryStore.isSaved(try #require(recoveryStore.revisions().first)))
        let undone = try await queue.retained()
        #expect(undone.count == (copying ? 2 : 4))
        #expect(undone.suffix(copying ? 1 : 2).allSatisfy { $0.update.operations?.allSatisfy { $0.kind == "undoOperation" } == true })
        manager.redo()
        await binding.flush()
        #expect(binding.lastError == nil)
        let redoSource = try await session.snapshot().source
        if !inheritedChoices { #expect(redoSource == authored + suffix) }
        if inheritedChoices && mode == 2 {
            document.transaction(name: "Continue after accepted undo choices") {
                _ = document.setText(document.children[0].id, AttributedString("After accepted undo choices"))
            }
            await binding.flush()
            #expect(binding.lastError == nil)
            _ = try await coordinator.syncOnce()
        }
        await binding.close(); await coordinator.close(); await tree.close()
    }


}
