import ArborKit
import ArborWire
import Foundation
import Testing
@testable import ArborWorkingTree

/// The protocol harness gives this scenario its own disposable tree without a filesystem checkout.
/// It deliberately uses the production transport and coordinator, not a receipt stub.
@Suite("Live source admission")
struct LiveSourceAdmissionTests {
    private func intent(_ source: String, from basis: WorkspaceDocumentSnapshot) throws -> WorkspaceDocumentIntent {
        // Preserve the existing final newline: this is a range edit, not the
        // whole-file replacement already covered by the earlier server slice.
        #expect(basis.source.hasSuffix("\n") && source.hasSuffix("\n"))
        return try .init(basis: basis, patch: .init(baseContentRevision: basis.contentRevision,
            edits: [.init(utf8Range: 0..<(basis.source.utf8.count - 1), replacement: String(source.dropLast()),
                expected: String(basis.source.dropLast()))]), source: source)
    }

    private func place(_ current: WireCurrentTree, client: ArborWireClient) async throws -> WorkingTree {
        let tree = try await WorkingTree.inMemory(tree: TreeID(rawValue: current.tree.id))
        let snapshot = try await client.snapshot(tree: current.tree.id, root: current.tree.root)
        try await tree.initializeFromSystem(SnapshotBridge.replacement(snapshot: snapshot,
            tree: TreeID(rawValue: current.tree.id), update: current.tree.update, cursor: current.observedThrough))
        return tree
    }

    @Test("Stale admission survives restart, continues a hidden candidate, and adopts another client's resolution")
    func staleAdmissionThroughCanopy() async throws {
        let environment = ProcessInfo.processInfo.environment
        guard let address = environment["ARBOR_SOURCE_TEST_URL"], let origin = URL(string: address),
              let token = environment["ARBOR_SOURCE_TEST_TOKEN"],
              let treeID = environment["ARBOR_SOURCE_TEST_TREE"] else { return }
        let root = FileManager.default.temporaryDirectory.appending(path: "source-live-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let client = ArborWireClient(origin: origin, credential: token)
        let peer = ArborWireClient(origin: origin, credential: token)
        let transport = ArborWireReplicaTransport(client: client)
        let initial = try await client.descriptor(tree: treeID)
        let tree = try await place(initial, client: client)
        let reference = WorkspaceReference(tree: TreeID(rawValue: treeID), path: "/page")
        let coordinator = try UpdateCoordinator(workingTree: tree, transport: transport, stateRoot: root,
            sourceOperationEmission: true, publicationDelay: .seconds(3600), publicationMaxDelay: .seconds(3600))
        let session = try await WorkingTreeProvider(workingTree: tree, sourceCoordinator: coordinator).openDocument(reference)
        let r1 = try await session.snapshot()

        // A peer changes exactly the same source while our editor still holds R1.
        let captured = try await tree.captureSourceAdmissionBasis(reference)
        let peerEdit = try captured.prepare(intent: intent("Peer at R2\n", from: captured.document))
        let peerRequest = try await peer.prepareUpdates(tree: treeID,
            base: .init(root: initial.tree.root, update: initial.tree.update), updates: [peerEdit.update])
        _ = try await peer.submitUpdateResponse(peerRequest)
        _ = try await coordinator.recoverWatchGap()
        let r2 = try await client.descriptor(tree: treeID)
        #expect(try await tree.heads().acceptedUpdate == r2.tree.update)
        let local = try await session.admit(intent: intent("My retained alternative\n", from: r1))
        #expect(try await tree.heads().acceptedRoot == r2.tree.root)
        #expect(try await session.snapshot().source == local.source)
        let queue = try SourceAdmissionQueue(tree: treeID, stateRoot: root)
        let original = try #require(try await queue.retained().first)
        #expect(original.basis == .accepted(.init(root: initial.tree.root, update: initial.tree.update)))
        await session.close(); await coordinator.close(); await tree.close()

        // Recreate the in-memory replica as Native does, using the server's R2.
        // Only the separate admission journal carries the unpublished R1 intent.
        let reopenedTree = try await place(r2, client: client)
        let reopened = try UpdateCoordinator(workingTree: reopenedTree, transport: transport, stateRoot: root,
            sourceOperationEmission: true, publicationDelay: .seconds(3600), publicationMaxDelay: .seconds(3600))
        let reopenedSession = try await WorkingTreeProvider(workingTree: reopenedTree, sourceCoordinator: reopened).openDocument(reference)
        #expect(try await reopenedSession.snapshot().contentRevision == local.contentRevision)
        let accepted = try await reopened.syncOnce()
        #expect(accepted.acceptedConflicted == true)
        #expect(try await reopened.conflict() == nil)
        #expect(try await reopenedSession.snapshot().source == "Peer at R2\n")
        let firstConflict = try await peer.descriptor(tree: treeID)
        let firstInspection = try await peer.conflicts(tree: treeID, state: firstConflict.tree.update, root: firstConflict.tree.root)

        // An editor still holding its local candidate can continue that hidden
        // alternative. The visible peer projection must not become its basis.
        _ = try await reopenedSession.admit(intent: intent("My continued alternative\n", from: local))
        _ = try await reopened.syncOnce()
        let records = try await queue.retained()
        #expect(records.count == 2)
        #expect(records.last?.basis == .authored(change: original.change))
        #expect(try await reopenedSession.snapshot().source == "Peer at R2\n")
        let current = try await peer.descriptor(tree: treeID)
        let inspection = try await peer.conflicts(tree: treeID, state: current.tree.update, root: current.tree.root)
        guard case let .array(decisions) = inspection.fields["decisions"], decisions.count == 1,
              case let .object(decision) = decisions[0], case let .string(conflict) = decision["id"],
              case let .array(alternatives) = decision["alternatives"] else {
            Issue.record("Expected one complete accepted decision"); return
        }
        #expect(alternatives.count == 2)
        let hashes = alternatives.compactMap { value -> String? in
            guard case let .object(fields) = value, case let .object(content) = fields["value"],
                  case let .string(hash) = content["file"] else { return nil }
            return hash
        }
        #expect(Set(hashes) == Set(["Peer at R2\n", "My continued alternative\n"].map { WireObjectCodec.hash(Data($0.utf8)) }))
        #expect(try await peer.conflicts(tree: treeID, state: firstConflict.tree.update, root: firstConflict.tree.root) == firstInspection)
        let identities = try alternatives.map { value -> String in
            guard case let .object(fields) = value, case let .string(id) = fields["id"] else {
                throw ArborWireValidationError.invalidValue("Missing alternative identity")
            }
            return id
        }
        let resolution = WireCandidateUpdate(candidate: current.tree.root, operations: [],
            resolves: [.init(state: current.tree.update, conflict: conflict, alternatives: identities)], objects: [])
        var staleResolution = resolution
        staleResolution.change = UUID().uuidString
        staleResolution.resolves[0].state = firstConflict.tree.update
        let staleRequest = try await peer.prepareUpdates(tree: treeID,
            base: .init(root: current.tree.root, update: current.tree.update), updates: [staleResolution])
        do {
            _ = try await peer.submitUpdateResponse(staleRequest)
            Issue.record("Stale resolution must not clear the newer decision")
        } catch is WireUpdateConflictError { }
        #expect(try await peer.descriptor(tree: treeID).tree.update == current.tree.update)
        let resolutionRequest = try await peer.prepareUpdates(tree: treeID,
            base: .init(root: current.tree.root, update: current.tree.update), updates: [resolution])
        _ = try await peer.submitUpdateResponse(resolutionRequest)
        let resolved = try await peer.descriptor(tree: treeID)
        #expect(resolved.tree.conflicted == false)
        #expect(resolved.tree.root == current.tree.root)
        #expect(resolved.tree.update != current.tree.update)
        _ = try await reopened.recoverWatchGap()
        #expect(try await reopenedTree.heads().acceptedUpdate == resolved.tree.update)
        #expect(try await reopened.presentation().acceptedConflicted == false)
        #expect(try await reopenedSession.snapshot().source == "Peer at R2\n")
        await reopenedSession.close(); await reopened.close(); await reopenedTree.close()
    }
}
