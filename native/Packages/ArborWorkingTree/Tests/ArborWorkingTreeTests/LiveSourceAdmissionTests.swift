import ArborKit
import ArborWire
import Foundation
import Testing
@testable import ArborWorkingTree

/// The protocol harness gives this scenario its own disposable tree without a filesystem checkout.
/// It deliberately uses the production transport and coordinator, not a receipt stub.
@Suite("Live source admission", .serialized)
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

    @Test("Stale admission survives several peer updates, restart, hidden continuation and resolution", arguments: ["/page", "/sub/child"])
    func staleAdmissionThroughCanopy(path: String) async throws {
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
        let reference = WorkspaceReference(tree: TreeID(rawValue: treeID), path: path)
        let coordinator = try UpdateCoordinator(workingTree: tree, transport: transport, stateRoot: root,
            sourceOperationEmission: true, publicationDelay: .seconds(3600), publicationMaxDelay: .seconds(3600))
        let session = try await WorkingTreeProvider(workingTree: tree, sourceCoordinator: coordinator).openDocument(reference)
        let r1 = try await session.snapshot()

        // A peer changes exactly the same source while our editor still holds R1.
        let captured = try await tree.captureSourceAdmissionBasis(reference)
        let peerEdit = try captured.prepare(intent: intent("Intermediate peer\n", from: captured.document))
        let peerRequest = try await peer.prepareUpdates(tree: treeID,
            base: .init(root: initial.tree.root, update: initial.tree.update), updates: [peerEdit.update])
        _ = try await peer.submitUpdateResponse(peerRequest)
        _ = try await coordinator.recoverWatchGap()
        let nextCapture = try await tree.captureSourceAdmissionBasis(reference)
        let nextPeer = try nextCapture.prepare(intent: intent("Peer at R2\n", from: nextCapture.document))
        let nextRequest = try await peer.prepareUpdates(tree: treeID, base: #require(nextCapture.accepted), updates: [nextPeer.update])
        _ = try await peer.submitUpdateResponse(nextRequest)
        _ = try await coordinator.recoverWatchGap()
        let r2 = try await client.descriptor(tree: treeID)
        #expect(try await tree.heads().acceptedUpdate == r2.tree.update)
        let local = try await session.admit(intent: intent("My retained alternative\n", from: r1))
        #expect(try await tree.heads().acceptedRoot == r2.tree.root)
        #expect(try await session.snapshot().source == local.source)
        let queue = try await SourceAdmissionQueue(tree: treeID, stateRoot: root)
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
        #expect(try await reopened.presentation().state == .current)
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
        guard case let .array(decisions) = inspection.fields["decisions"], !decisions.isEmpty else {
            Issue.record("Expected accepted choices"); return
        }
        let expectedHashes = Set(["Peer at R2\n", "My continued alternative\n"].map { WireObjectCodec.hash(Data($0.utf8)) })
        // A whole-source continuation can enclose an earlier, narrower choice.
        // Both remain inspectable and are resolved with their complete guards.
        let complete = decisions.compactMap { value -> [String: WireReadValue]? in
            guard case let .object(fields) = value, case let .array(choices) = fields["alternatives"] else { return nil }
            let hashes = choices.compactMap { value -> String? in
                guard case let .object(a) = value, case let .object(v) = a["value"], case let .string(hash) = v["file"] else { return nil }
                return hash
            }
            return Set(hashes) == expectedHashes ? fields : nil
        }
        let decision = try #require(complete.first)
        guard case let .string(conflict) = decision["id"], case let .array(alternatives) = decision["alternatives"] else {
            Issue.record("Missing decision identity"); return
        }
        #expect(alternatives.count == 2)
        if path == "/sub/child" {
            guard case let .array(affected) = decision["affected"], case let .object(parent) = affected.first else {
                Issue.record("Missing nested decision location"); return
            }
            guard case let .object(material) = parent["material"] else { Issue.record("Missing source material"); return }
            #expect(material["path"] == .string("/sub/child.md"))
            #expect(parent["range"] != nil)
        }
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
        let guards = try decisions.map { value -> WireResolutionDeclaration in
            guard case let .object(d) = value, case let .string(id) = d["id"], case let .array(values) = d["alternatives"] else { throw ArborWireValidationError.invalidValue("Missing guard") }
            return .init(state:current.tree.update, conflict:id, alternatives:try values.map { value in
                guard case let .object(a) = value, case let .string(id) = a["id"] else { throw ArborWireValidationError.invalidValue("Missing alternative") }
                return id
            })
        }
        #expect(guards.contains { $0.conflict == conflict && Set($0.alternatives) == Set(identities) })
        let resolution = WireCandidateUpdate(candidate: current.tree.root, operations: [], resolves:guards, objects: [])
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

extension LiveSourceAdmissionTests {
    @Test("Mixed structural and source admissions restart and publish through Canopy")
    func mixedStructuralPublication() async throws {
        let environment = ProcessInfo.processInfo.environment
        guard let address = environment["ARBOR_SOURCE_TEST_URL"], let origin = URL(string: address),
              let token = environment["ARBOR_SOURCE_TEST_TOKEN"], let treeID = environment["ARBOR_SOURCE_TEST_TREE"] else { return }
        let root = FileManager.default.temporaryDirectory.appending(path: "structure-live-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let client = ArborWireClient(origin: origin, credential: token)
        let transport = ArborWireReplicaTransport(client: client)
        let initial = try await client.descriptor(tree: treeID)
        let tree = try await place(initial, client: client)
        let coordinator = try UpdateCoordinator(workingTree: tree, transport: transport, stateRoot: root,
            sourceOperationEmission: true, publicationDelay: .seconds(3600), publicationMaxDelay: .seconds(3600))
        let provider = WorkingTreeProvider(workingTree: tree, sourceCoordinator: coordinator)
        let parent = WorkspaceReference(tree: TreeID(rawValue: treeID), path: "/")
        let name = "created-" + UUID().uuidString
        let created = try #require(try await provider.perform(.createMarkdown(parent: parent, name: name, source: "Created locally\n")))
        let session = try await provider.openDocument(created.reference)
        let original = try await session.snapshot(), editedSource = original.source + "Then edited locally\n"
        _ = try await session.admit(intent: .init(basis: original, patch: .init(baseContentRevision: original.contentRevision,
            edits: [.init(utf8Range: original.source.utf8.count..<original.source.utf8.count, replacement: "Then edited locally\n")]), source: editedSource))
        let directory = try #require(try await provider.perform(.createDirectory(parent: parent, name: "group-" + UUID().uuidString)))
        let moved = try #require(try await provider.perform(.move(reference: created.reference, destination: directory.reference)))
        let copy = try #require(try await provider.perform(.copy(reference: moved.reference, destination: parent)))
        let renamed = try #require(try await provider.perform(.rename(reference: copy.reference, name: "copy-" + UUID().uuidString)))
        let binary = try await provider.importFile(name: "data.bin", bytes: Data([0, 42, 255]), in: directory.reference)
        let asset = try await provider.store(asset: .init(name: "image.bin", bytes: Data([9, 8, 7])), in: directory.reference)
        let trashed = try #require(try await provider.perform(.trash(reference: renamed.reference)))
        _ = try await provider.perform(.restore(reference: trashed.reference))
        #expect(try await tree.heads().acceptedRoot == initial.tree.root)
        let records = try await SourceAdmissionQueue(tree: treeID, stateRoot: root).retained()
        #expect(records.count == 10)
        await session.close(); await coordinator.close(); await tree.close()

        let current = try await client.descriptor(tree: treeID)
        let reopenedTree = try await place(current, client: client)
        let interrupted = try UpdateCoordinator(workingTree: reopenedTree, transport: transport, stateRoot: root,
            sourceOperationEmission: true, faultInjector: StructuralPublicationCrash(),
            publicationDelay: .seconds(3600), publicationMaxDelay: .seconds(3600))
        do { _ = try await interrupted.syncOnce(); Issue.record("Expected uncertain acceptance") }
        catch is StructuralPublicationCrash.Failure { }
        #expect(try await client.descriptor(tree: treeID).tree.root == records.first?.candidate.root)
        await interrupted.close()
        let reopened = try UpdateCoordinator(workingTree: reopenedTree, transport: transport, stateRoot: root,
            sourceOperationEmission: true, publicationDelay: .seconds(3600), publicationMaxDelay: .seconds(3600))
        let recovered = WorkingTreeProvider(workingTree: reopenedTree, sourceCoordinator: reopened)
        #expect(try await recovered.openDocument(moved.reference).snapshot().source == editedSource)
        #expect(try await recovered.readFile(binary.reference) == Data([0, 42, 255]))
        _ = try await reopened.syncOnce()
        #expect(try await reopened.presentation().state == .current)
        #expect(try await client.descriptor(tree: treeID).tree.root == records.last?.candidate.root)
        #expect(try await recovered.openDocument(moved.reference).snapshot().source == editedSource)
        #expect(try await recovered.readFile(asset.reference) == Data([9, 8, 7]))
        #expect(try await recovered.resolve(renamed.reference).reference.path == renamed.reference.path)
        await reopened.close(); await reopenedTree.close()
    }
    @Test("Pending structural and stale source branches wait for Canopy, survive uncertain acceptance and resume")
    func branchedStructuralPublication() async throws {
        let environment = ProcessInfo.processInfo.environment
        guard let address = environment["ARBOR_SOURCE_TEST_URL"], let origin = URL(string: address),
              let token = environment["ARBOR_SOURCE_TEST_TOKEN"], let treeID = environment["ARBOR_SOURCE_TEST_TREE"] else { return }
        let root = FileManager.default.temporaryDirectory.appending(path: "branch-live-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let client = ArborWireClient(origin: origin, credential: token)
        let transport = ArborWireReplicaTransport(client: client)
        let initial = try await client.descriptor(tree: treeID), tree = try await place(initial, client: client)
        let coordinator = try UpdateCoordinator(workingTree: tree, transport: transport, stateRoot: root,
            sourceOperationEmission: true, publicationDelay: .seconds(3600), publicationMaxDelay: .seconds(3600))
        let provider = WorkingTreeProvider(workingTree: tree, sourceCoordinator: coordinator)
        let parent = WorkspaceReference(tree: TreeID(rawValue: treeID), path: "/")
        let old = try await provider.openDocument(.init(tree: parent.tree, path: "/page")), r1 = try await old.snapshot()
        let created = try #require(try await provider.perform(.createMarkdown(parent: parent, name: "branch-" + UUID().uuidString, source: "Created locally\n")))
        let first = try await old.admit(intent: intent("Old editor branch\n", from: r1))
        _ = try await old.admit(intent: intent("Old editor continued\n", from: first))
        let added = try await provider.openDocument(created.reference), a1 = try await added.snapshot()
        let addedSource = a1.source + "Continued locally\n"
        _ = try await added.admit(intent: intent(addedSource, from: a1))
        #expect(await provider.capabilities().structuralActions == false)
        await #expect(throws: UpdateError.awaitingCanopyReconciliation) {
            try await provider.perform(.rename(reference: created.reference, name: "blocked"))
        }
        let queue = try await SourceAdmissionQueue(tree: treeID, stateRoot: root), records = try await queue.retained()
        #expect(records.count == 4)
        #expect(records[1].basis == .accepted(.init(root: initial.tree.root, update: initial.tree.update)))
        #expect(records[2].basis == .authored(change: records[1].change))
        #expect(records[3].basis == .authored(change: records[0].change))
        await old.close(); await added.close(); await coordinator.close(); await tree.close()

        let recoveredTree = try await place(client.descriptor(tree: treeID), client: client)
        let interrupted = try UpdateCoordinator(workingTree: recoveredTree, transport: transport, stateRoot: root,
            sourceOperationEmission: true, faultInjector: StructuralPublicationCrash(),
            publicationDelay: .seconds(3600), publicationMaxDelay: .seconds(3600))
        let waiting = WorkingTreeProvider(workingTree: recoveredTree, sourceCoordinator: interrupted)
        #expect(try await waiting.resolve(created.reference).reference.path == created.reference.path)
        #expect(await waiting.capabilities().structuralActions == false)
        do { _ = try await interrupted.syncOnce(); Issue.record("Expected uncertain acceptance") }
        catch is StructuralPublicationCrash.Failure { }
        await interrupted.close()
        let reopened = try UpdateCoordinator(workingTree: recoveredTree, transport: transport, stateRoot: root,
            sourceOperationEmission: true, publicationDelay: .seconds(3600), publicationMaxDelay: .seconds(3600))
        let resumed = WorkingTreeProvider(workingTree: recoveredTree, sourceCoordinator: reopened)
        _ = try await reopened.syncOnce()
        #expect(try await reopened.presentation().state == .current)
        #expect(try await resumed.openDocument(created.reference).snapshot().source == addedSource)
        #expect(try await resumed.openDocument(.init(tree: parent.tree, path: "/page")).snapshot().source == "Old editor continued\n")
        #expect(await resumed.capabilities().structuralActions == true)
        let renamed = try #require(try await resumed.perform(.rename(reference: created.reference, name: "resumed-" + UUID().uuidString)))
        _ = try await reopened.syncOnce()
        #expect(try await resumed.resolve(renamed.reference).reference.path == renamed.reference.path)
        let compacted = try await queue.retained()
        #expect(compacted.count == 1)
        #expect(!records.map(\.change).contains(compacted[0].change))
        await reopened.close(); await recoveredTree.close()
    }

}

private struct StructuralPublicationCrash: UpdateFaultInjector {
    struct Failure: Error {}
    func reached(_ point: UpdateFailurePoint) throws {
        if point == .afterServerAcceptance { throw Failure() }
    }
}

extension LiveSourceAdmissionTests {
    @Test("Compound sibling-body operations publish through Canopy after restart")
    func compoundStructuralPublication() async throws {
        let environment = ProcessInfo.processInfo.environment
        guard let address = environment["ARBOR_SOURCE_TEST_URL"], let origin = URL(string:address),
              let token = environment["ARBOR_SOURCE_TEST_TOKEN"], let treeID = environment["ARBOR_SOURCE_TEST_TREE"] else { return }
        struct Fixture: Decodable { let graph: WireSnapshot }
        let path = URL(fileURLWithPath:#filePath).deletingLastPathComponent().appending(path:"../../../../../conformance/entry-actions.json")
        let fixture = try JSONDecoder().decode(Fixture.self,from:Data(contentsOf:path))
        let root = FileManager.default.temporaryDirectory.appending(path:"compound-live-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at:root) }
        let client = ArborWireClient(origin:origin,credential:token)
        let transport = ArborWireReplicaTransport(client:client)
        let current = try await client.descriptor(tree:treeID)
        let snapshot = try await client.snapshot(tree:treeID,root:current.tree.root)
        let objects = Dictionary(uniqueKeysWithValues:snapshot.objects.map { ($0.hash,$0.bytes) })
        let fixtureObjects = Dictionary(uniqueKeysWithValues:fixture.graph.objects.map { ($0.hash,$0.bytes) })
        guard case let .directory(existing,descriptor) = try WireObjectCodec.decode(#require(objects[snapshot.root]),kind:.directory),
              case let .directory(additions,_) = try WireObjectCodec.decode(#require(fixtureObjects[fixture.graph.root]),kind:.directory) else { Issue.record("Expected directories"); return }
        let bytes = try WireObjectCodec.encode(.directory((existing + additions).sorted { $0.name < $1.name },childrenSource:descriptor))
        let seed = WireCandidateUpdate(candidate:WireObjectCodec.hash(bytes),change:UUID().uuidString,objects:fixture.graph.objects + [.init(hash:WireObjectCodec.hash(bytes),bytes:bytes)])
        _ = try await client.submitUpdateResponse(client.prepareUpdates(tree:treeID,base:.init(root:current.tree.root,update:current.tree.update),updates:[seed]))
        let initial = try await client.descriptor(tree:treeID), tree = try await place(initial,client:client)
        let coordinator = try UpdateCoordinator(workingTree:tree,transport:transport,stateRoot:root,
            sourceOperationEmission:true,publicationDelay:.seconds(3600),publicationMaxDelay:.seconds(3600))
        let provider = WorkingTreeProvider(workingTree:tree,sourceCoordinator:coordinator)
        let parent = WorkspaceReference(tree:TreeID(rawValue:treeID),path:"/")
        let moved = try #require(try await provider.perform(.move(reference:.init(tree:parent.tree,path:"/pair"),destination:.init(tree:parent.tree,path:"/archive"))))
        let copied = try #require(try await provider.perform(.copy(reference:moved.reference,destination:parent)))
        let renamed = try #require(try await provider.perform(.rename(reference:copied.reference,name:"compound-copy")))
        let trashed = try #require(try await provider.perform(.trash(reference:moved.reference)))
        _ = try await provider.perform(.restore(reference:trashed.reference))
        let records = try await SourceAdmissionQueue(tree:treeID,stateRoot:root).retained()
        #expect(records.count == 5)
        #expect(records[0].update.operations?.map(\.kind) == ["moveEntry","moveEntry"])
        #expect(records[1].update.operations?.filter { $0.kind == "copyEntry" }.count == 2)
        #expect(records[3].update.operations?.map(\.kind) == ["removeEntry","removeEntry"])
        #expect(records[4].update.operations == nil)
        await coordinator.close(); await tree.close()
        let clean = try await place(initial,client:client)
        let recovered = try UpdateCoordinator(workingTree:clean,transport:transport,stateRoot:root,
            sourceOperationEmission:true,publicationDelay:.seconds(3600),publicationMaxDelay:.seconds(3600))
        _ = try await recovered.syncOnce()
        #expect(try await recovered.presentation().state == .current)
        #expect(try await client.descriptor(tree:treeID).tree.root == records.last?.candidate.root)
        let reopened = WorkingTreeProvider(workingTree:clean,sourceCoordinator:recovered)
        #expect(try await reopened.openDocument(renamed.reference).snapshot().source.hasSuffix("# Café\r\n"))
        #expect(try await reopened.openDocument(moved.reference).snapshot().source.contains("pg_pair"))
        await recovered.close(); await clean.close()
    }
}
