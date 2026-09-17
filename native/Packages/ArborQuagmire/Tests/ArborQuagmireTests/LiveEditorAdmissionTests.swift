import ArborKit
import ArborWire
import ArborWorkingTree
@testable import ArborQuagmire
import Foundation
import Quagmire
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

    private func edit(_ binding: ArborDocumentBinding, text: String) {
        binding.document.transaction(name: "Typing") {
            _ = binding.document.setText(binding.document.children[0].id, AttributedString(text))
        }
        binding.admitCurrentGeneration()
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
            let unadmitted = try SourceAdmissionQueue(tree: treeID, stateRoot: queueRoot)
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
        let queue = try SourceAdmissionQueue(tree: treeID, stateRoot: queueRoot)
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
