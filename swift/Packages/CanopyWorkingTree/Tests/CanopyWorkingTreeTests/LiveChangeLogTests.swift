import CanopyAppKit
import Overstory
import Foundation
import Testing
@testable import CanopyWorkingTree

/// The protocol harness gives this scenario its own disposable tree without a filesystem checkout.
/// It deliberately uses the production transport and coordinator, not a receipt stub.
@Suite("Live source admission", .serialized)
struct LiveChangeLogTests {
    private func intent(_ source: String, from basis: WorkspaceDocumentSnapshot) throws -> WorkspaceDocumentIntent {
        // Preserve the existing final newline: this is a range edit, not the
        // whole-file replacement already covered by the earlier server slice.
        #expect(basis.source.hasSuffix("\n") && source.hasSuffix("\n"))
        return try .init(basis: basis, patch: .init(baseContentRevision: basis.contentRevision,
            edits: [.init(utf8Range: 0..<(basis.source.utf8.count - 1), replacement: String(source.dropLast()),
                expected: String(basis.source.dropLast()))]), source: source)
    }

    private func place(_ current: ProtocolCurrentTree, client: ProtocolClient) async throws -> WorkingTree {
        let tree = try await WorkingTree.inMemory(tree: TreeID(rawValue: current.tree.id))
        let snapshot = try await client.snapshot(tree: current.tree.id, root: current.tree.root)
        try await tree.initializeFromSystem(SnapshotBridge.replacement(snapshot: snapshot,
            tree: TreeID(rawValue: current.tree.id), update: current.tree.update, cursor: current.observedThrough))
        return tree
    }

    @Test("Stale admission survives several peer updates, restart, hidden continuation and resolution", arguments: ["/page", "/sub/child"])
    func staleAdmissionThroughHost(path: String) async throws {
        let environment = ProcessInfo.processInfo.environment
        guard let address = environment["ARBOR_SOURCE_TEST_URL"], let origin = URL(string: address),
              let token = environment["ARBOR_SOURCE_TEST_TOKEN"],
              let treeID = environment["ARBOR_SOURCE_TEST_TREE"] else { return }
        let root = FileManager.default.temporaryDirectory.appending(path: "source-live-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let client = ProtocolClient(origin: origin, credential: token)
        let peer = ProtocolClient(origin: origin, credential: token)
        let transport = ProtocolReplicaTransport(client: client)
        let initial = try await client.descriptor(tree: treeID)
        let tree = try await place(initial, client: client)
        let reference = WorkspaceReference(tree: TreeID(rawValue: treeID), path: path)
        let coordinator = try UpdateCoordinator(workingTree: tree, transport: transport, stateRoot: root , publicationDelay: .seconds(3600), publicationMaxDelay: .seconds(3600))
        let session = try await WorkingTreeProvider(workingTree: tree, coordinator: coordinator).openDocument(reference)
        let r1 = try await session.snapshot()

        // A peer changes exactly the same source while our editor still holds R1.
        let captured = try await tree.captureSourceBasis(reference)
        let peerEdit = try captured.prepare(intent: intent("Intermediate peer\n", from: captured.document))
        let peerRequest = try await peer.prepareUpdates(tree: treeID,
            base: .init(root: initial.tree.root, update: initial.tree.update), updates: [peerEdit.update])
        _ = try await peer.submitUpdateResponse(peerRequest)
        _ = try await coordinator.recoverWatchGap()
        let nextCapture = try await tree.captureSourceBasis(reference)
        let nextPeer = try nextCapture.prepare(intent: intent("Peer at R2\n", from: nextCapture.document))
        let nextRequest = try await peer.prepareUpdates(tree: treeID, base: #require(nextCapture.accepted), updates: [nextPeer.update])
        _ = try await peer.submitUpdateResponse(nextRequest)
        _ = try await coordinator.recoverWatchGap()
        let r2 = try await client.descriptor(tree: treeID)
        #expect(try await tree.heads().acceptedUpdate == r2.tree.update)
        let local = try await session.admit(intent: intent("My retained alternative\n", from: r1))
        #expect(try await tree.heads().acceptedRoot == r2.tree.root)
        #expect(try await session.snapshot().source == local.source)
        let queue = try await ChangeLog(tree: treeID, stateRoot: root)
        let original = try #require(try await queue.retained().first)
        #expect(original.basis == .accepted(.init(root: initial.tree.root, update: initial.tree.update)))
        await session.close(); await coordinator.close(); await tree.close()

        // Recreate the in-memory replica as Native does, using the server's R2.
        // Only the separate admission journal carries the unpublished R1 intent.
        let reopenedTree = try await place(r2, client: client)
        let reopened = try UpdateCoordinator(workingTree: reopenedTree, transport: transport, stateRoot: root , publicationDelay: .seconds(3600), publicationMaxDelay: .seconds(3600))
        let reopenedSession = try await WorkingTreeProvider(workingTree: reopenedTree, coordinator: reopened).openDocument(reference)
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
        let expectedHashes = Set(["Peer at R2", "My continued alternative"].map { ProtocolObjectCodec.hash(Data($0.utf8)) })
        // The successor advances the same scoped choice. The unchanged final
        // newline stays outside it; no whole-file enclosure is introduced.
        #expect(decisions.count == 1)
        let complete = decisions.compactMap { value -> [String: ProtocolReadValue]? in
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
        #expect(Set(hashes) == expectedHashes)
        #expect(try await peer.conflicts(tree: treeID, state: firstConflict.tree.update, root: firstConflict.tree.root) == firstInspection)
        let identities = try alternatives.map { value -> String in
            guard case let .object(fields) = value, case let .string(id) = fields["id"] else {
                throw ProtocolValidationError.invalidValue("Missing alternative identity")
            }
            return id
        }
        let guards = try decisions.map { value -> ProtocolResolutionDeclaration in
            guard case let .object(d) = value, case let .string(id) = d["id"], case let .array(values) = d["alternatives"] else { throw ProtocolValidationError.invalidValue("Missing guard") }
            return .init(state:current.tree.update, conflict:id, alternatives:try values.map { value in
                guard case let .object(a) = value, case let .string(id) = a["id"] else { throw ProtocolValidationError.invalidValue("Missing alternative") }
                return id
            })
        }
        #expect(guards.contains { $0.conflict == conflict && Set($0.alternatives) == Set(identities) })
        let resolution = ProtocolCandidateUpdate(candidate: current.tree.root, trace: [], resolves:guards, objects: [])
        var staleResolution = resolution
        staleResolution.change = UUID().uuidString
        staleResolution.resolves[0].state = firstConflict.tree.update
        let staleRequest = try await peer.prepareUpdates(tree: treeID,
            base: .init(root: current.tree.root, update: current.tree.update), updates: [staleResolution])
        do {
            _ = try await peer.submitUpdateResponse(staleRequest)
            Issue.record("Stale resolution must not clear the newer decision")
        } catch is ProtocolUpdateConflictError { }
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

extension LiveChangeLogTests {
    @Test("Mixed structural and source admissions restart and publish through Canopy")
    func mixedStructuralPublication() async throws {
        let environment = ProcessInfo.processInfo.environment
        guard let address = environment["ARBOR_SOURCE_TEST_URL"], let origin = URL(string: address),
              let token = environment["ARBOR_SOURCE_TEST_TOKEN"], let treeID = environment["ARBOR_SOURCE_TEST_TREE"] else { return }
        let root = FileManager.default.temporaryDirectory.appending(path: "structure-live-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let client = ProtocolClient(origin: origin, credential: token)
        let transport = ProtocolReplicaTransport(client: client)
        let initial = try await client.descriptor(tree: treeID)
        let tree = try await place(initial, client: client)
        let coordinator = try UpdateCoordinator(workingTree: tree, transport: transport, stateRoot: root , publicationDelay: .seconds(3600), publicationMaxDelay: .seconds(3600))
        let provider = WorkingTreeProvider(workingTree: tree, coordinator: coordinator)
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
        let records = try await ChangeLog(tree: treeID, stateRoot: root).retained()
        #expect(records.count == 10)
        await session.close(); await coordinator.close(); await tree.close()

        let current = try await client.descriptor(tree: treeID)
        let reopenedTree = try await place(current, client: client)
        let interrupted = try UpdateCoordinator(workingTree: reopenedTree, transport: transport, stateRoot: root , faultInjector: StructuralPublicationCrash(),
            publicationDelay: .seconds(3600), publicationMaxDelay: .seconds(3600))
        // Uncertain acceptance leaves the exact request retained, not current.
        _ = try await interrupted.syncOnce()
        #expect(await interrupted.syncState.kind != "current")
        // The complete queued chain reaches Canopy in the first frozen batch,
        // even when the client loses its acknowledgement before installation.
        #expect(try await client.descriptor(tree: treeID).tree.root == records.last?.candidate.root)
        await interrupted.close()
        let reopened = try UpdateCoordinator(workingTree: reopenedTree, transport: transport, stateRoot: root , publicationDelay: .seconds(3600), publicationMaxDelay: .seconds(3600))
        let recovered = WorkingTreeProvider(workingTree: reopenedTree, coordinator: reopened)
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
        let client = ProtocolClient(origin: origin, credential: token)
        let transport = ProtocolReplicaTransport(client: client)
        let initial = try await client.descriptor(tree: treeID), tree = try await place(initial, client: client)
        let coordinator = try UpdateCoordinator(workingTree: tree, transport: transport, stateRoot: root , publicationDelay: .seconds(3600), publicationMaxDelay: .seconds(3600))
        let provider = WorkingTreeProvider(workingTree: tree, coordinator: coordinator)
        let parent = WorkspaceReference(tree: TreeID(rawValue: treeID), path: "/")
        let old = try await provider.openDocument(.init(tree: parent.tree, path: "/page")), r1 = try await old.snapshot()
        let created = try #require(try await provider.perform(.createMarkdown(parent: parent, name: "branch-" + UUID().uuidString, source: "Created locally\n")))
        let first = try await old.admit(intent: intent("Old editor branch\n", from: r1))
        _ = try await old.admit(intent: intent("Old editor continued\n", from: first))
        let added = try await provider.openDocument(created.reference), a1 = try await added.snapshot()
        let addedSource = a1.source + "Continued locally\n"
        _ = try await added.admit(intent: intent(addedSource, from: a1))
        #expect(await provider.capabilities().structuralActions == false)
        await #expect(throws: UpdateError.awaitingHostReconciliation) {
            try await provider.perform(.rename(reference: created.reference, name: "blocked"))
        }
        let queue = try await ChangeLog(tree: treeID, stateRoot: root), records = try await queue.retained()
        #expect(records.count == 4)
        #expect(records[1].basis == .accepted(.init(root: initial.tree.root, update: initial.tree.update)))
        #expect(records[2].basis == .authored(change: records[1].change))
        #expect(records[3].basis == .authored(change: records[0].change))
        await old.close(); await added.close(); await coordinator.close(); await tree.close()

        let recoveredTree = try await place(client.descriptor(tree: treeID), client: client)
        let interrupted = try UpdateCoordinator(workingTree: recoveredTree, transport: transport, stateRoot: root , faultInjector: StructuralPublicationCrash(),
            publicationDelay: .seconds(3600), publicationMaxDelay: .seconds(3600))
        let waiting = WorkingTreeProvider(workingTree: recoveredTree, coordinator: interrupted)
        #expect(try await waiting.resolve(created.reference).reference.path == created.reference.path)
        #expect(await waiting.capabilities().structuralActions == false)
        // Uncertain acceptance leaves the exact request retained, not current.
        _ = try await interrupted.syncOnce()
        #expect(await interrupted.syncState.kind != "current")
        await interrupted.close()
        let reopened = try UpdateCoordinator(workingTree: recoveredTree, transport: transport, stateRoot: root , publicationDelay: .seconds(3600), publicationMaxDelay: .seconds(3600))
        let resumed = WorkingTreeProvider(workingTree: recoveredTree, coordinator: reopened)
        _ = try await reopened.syncOnce()
        #expect(try await reopened.presentation().state == .current)
        #expect(try await resumed.openDocument(created.reference).snapshot().source == addedSource)
        #expect(try await resumed.openDocument(.init(tree: parent.tree, path: "/page")).snapshot().source == "Old editor continued\n")
        #expect(await resumed.capabilities().structuralActions == true)
        let renamed = try #require(try await resumed.perform(.rename(reference: created.reference, name: "resumed-" + UUID().uuidString)))
        _ = try await reopened.syncOnce()
        #expect(try await resumed.resolve(renamed.reference).reference.path == renamed.reference.path)
        let compacted = try await queue.retained()
        // Other open document bases remain valid even when the newest action
        // belongs to a different page. Compaction keeps each document's tail.
        #expect(!records.map(\.change).contains(try #require(compacted.last).change))
        for record in records where record.document != nil {
            let latest = records.last { $0.document?.reference.identity == record.document?.reference.identity }
            if record.change == latest?.change { #expect(compacted.contains { $0.change == record.change }) }
        }
        await reopened.close(); await recoveredTree.close()
    }

}

private struct StructuralPublicationCrash: UpdateFaultInjector {
    struct Failure: Error {}
    func reached(_ point: UpdateFailurePoint) throws {
        if point == .afterServerAcceptance { throw Failure() }
    }
}

extension LiveChangeLogTests {
    @Test("Compound sibling-body operations publish through Canopy after restart")
    func compoundStructuralPublication() async throws {
        let environment = ProcessInfo.processInfo.environment
        guard let address = environment["ARBOR_SOURCE_TEST_URL"], let origin = URL(string:address),
              let token = environment["ARBOR_SOURCE_TEST_TOKEN"], let treeID = environment["ARBOR_SOURCE_TEST_TREE"] else { return }
        struct Fixture: Decodable { let graph: ProtocolSnapshot }
        let path = URL(fileURLWithPath:#filePath).deletingLastPathComponent().appending(path:"../../../../../docs/overstory-spec/conformance/entry-actions.json")
        let fixture = try JSONDecoder().decode(Fixture.self,from:Data(contentsOf:path))
        let root = FileManager.default.temporaryDirectory.appending(path:"compound-live-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at:root) }
        let client = ProtocolClient(origin:origin,credential:token)
        let transport = ProtocolReplicaTransport(client:client)
        let current = try await client.descriptor(tree:treeID)
        let snapshot = try await client.snapshot(tree:treeID,root:current.tree.root)
        let objects = Dictionary(uniqueKeysWithValues:snapshot.objects.map { ($0.hash,$0.bytes) })
        let fixtureObjects = Dictionary(uniqueKeysWithValues:fixture.graph.objects.map { ($0.hash,$0.bytes) })
        guard case let .directory(existing,descriptor) = try ProtocolObjectCodec.decode(#require(objects[snapshot.root]),kind:.directory),
              case let .directory(additions,_) = try ProtocolObjectCodec.decode(#require(fixtureObjects[fixture.graph.root]),kind:.directory) else { Issue.record("Expected directories"); return }
        let bytes = try ProtocolObjectCodec.encode(.directory((existing + additions).sorted { $0.name < $1.name },childrenSource:descriptor))
        let seed = ProtocolCandidateUpdate(candidate:ProtocolObjectCodec.hash(bytes),change:UUID().uuidString,objects:fixture.graph.objects + [.init(hash:ProtocolObjectCodec.hash(bytes),bytes:bytes)])
        _ = try await client.submitUpdateResponse(client.prepareUpdates(tree:treeID,base:.init(root:current.tree.root,update:current.tree.update),updates:[seed]))
        let initial = try await client.descriptor(tree:treeID), tree = try await place(initial,client:client)
        let coordinator = try UpdateCoordinator(workingTree:tree,transport:transport,stateRoot:root ,publicationDelay:.seconds(3600),publicationMaxDelay:.seconds(3600))
        let provider = WorkingTreeProvider(workingTree:tree,coordinator:coordinator)
        let parent = WorkspaceReference(tree:TreeID(rawValue:treeID),path:"/")
        let moved = try #require(try await provider.perform(.move(reference:.init(tree:parent.tree,path:"/pair"),destination:.init(tree:parent.tree,path:"/archive"))))
        let copied = try #require(try await provider.perform(.copy(reference:moved.reference,destination:parent)))
        let renamed = try #require(try await provider.perform(.rename(reference:copied.reference,name:"compound-copy")))
        let trashed = try #require(try await provider.perform(.trash(reference:moved.reference)))
        _ = try await provider.perform(.restore(reference:trashed.reference))
        let records = try await ChangeLog(tree:treeID,stateRoot:root).retained()
        #expect(records.count == 5)
        #expect(records[0].update.trace?.flatMap(\.operations).map(\.kind) == ["moveEntry","moveEntry"])
        #expect(records[1].update.trace?.flatMap(\.operations).filter { $0.kind == "copyEntry" }.count == 2)
        #expect(records[3].update.trace?.flatMap(\.operations).map(\.kind) == ["removeEntry","removeEntry"])
        #expect(records[4].update.trace == nil)
        await coordinator.close(); await tree.close()
        let clean = try await place(initial,client:client)
        let recovered = try UpdateCoordinator(workingTree:clean,transport:transport,stateRoot:root ,publicationDelay:.seconds(3600),publicationMaxDelay:.seconds(3600))
        _ = try await recovered.syncOnce()
        #expect(try await recovered.presentation().state == .current)
        #expect(try await client.descriptor(tree:treeID).tree.root == records.last?.candidate.root)
        let reopened = WorkingTreeProvider(workingTree:clean,coordinator:recovered)
        #expect(try await reopened.openDocument(renamed.reference).snapshot().source.hasSuffix("# Café\r\n"))
        #expect(try await reopened.openDocument(moved.reference).snapshot().source.contains("pg_pair"))
        await recovered.close(); await clean.close()
    }
}

extension LiveChangeLogTests {
    @Test("Native review reads hidden material, resolves exact content and recovers a lost response", arguments: ["choose", "compose", "lost-response", "continued-edit", "group-remove", "group-rescue", "group-keep", "group-lost-response"])
    func nativeReviewThroughHost(mode: String) async throws {
        let environment = ProcessInfo.processInfo.environment
        guard let address = environment["ARBOR_SOURCE_TEST_URL"], let origin = URL(string: address),
              let token = environment["ARBOR_SOURCE_TEST_TOKEN"],
              let trees = environment["ARBOR_REVIEW_TEST_TREES"],
              let treeID = try JSONDecoder().decode([String: String].self, from: Data(trees.utf8))[mode] else { return }
        let root = FileManager.default.temporaryDirectory.appending(path: "review-live-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let client = ProtocolClient(origin: origin, credential: token)
        let transport = ReviewResponseLossTransport(client: client)
        let initial = try await client.descriptor(tree: treeID)
        let tree = try await place(initial, client: client)
        let coordinator = try UpdateCoordinator(workingTree: tree, transport: transport, stateRoot: root , publicationDelay: .seconds(3600), publicationMaxDelay: .seconds(3600))
        let reference = WorkspaceReference(tree: TreeID(rawValue: treeID), path: "/page")
        let session = try await WorkingTreeProvider(workingTree: tree, coordinator: coordinator).openDocument(reference)
        let basis = try await session.snapshot()
        let capture = try await tree.captureSourceBasis(reference)
        let peer = try capture.prepare(intent: intent("Peer review version\n", from: capture.document))
        let prepared = try await client.prepareUpdates(tree: treeID,
            base: .init(root: initial.tree.root, update: initial.tree.update), updates: [peer.update])
        _ = try await client.submitUpdateResponse(prepared)
        _ = try await session.admit(intent: intent("Hidden review version\n", from: basis))
        _ = try await coordinator.syncOnce()
        let inspection = try await coordinator.inspectChoices()
        let decision = try #require(inspection.decisions.first { $0.path == "/page.md" })
        var hiddenID = decision.selected
        let hiddenFragment = decision.sourceRange == nil ? "Hidden review version\n" : "Hidden review version"
        let peerFragment = decision.sourceRange == nil ? "Peer review version\n" : "Peer review version"
        func expectedSource(_ replacement: String) async throws -> String {
            guard let range = decision.sourceRange else { return replacement }
            let snapshot = try await client.snapshot(tree: treeID, root: inspection.root)
            let bytes = try #require(snapshot.objects.first { $0.hash == decision.affected[0].material.object }?.bytes)
            var result = bytes; result.replaceSubrange(range, with: Data(replacement.utf8))
            return try #require(String(data: result, encoding: .utf8))
        }
        #expect(decision.supportsIndependentResolution)
        var sourceBytes = Set<Data>()
        for alternative in decision.alternatives {
            let content = try #require(try await coordinator.reviewContent(alternative))
            sourceBytes.insert(content)
            if content == Data(hiddenFragment.utf8) { hiddenID = alternative.id }
        }
        #expect(sourceBytes.contains(Data(hiddenFragment.utf8)))
        #expect(sourceBytes.contains(Data(peerFragment.utf8)))
        if mode.hasPrefix("group-") {
            // Deleting an ancestor of an unresolved leaf produces a coupled root choice.
            let projected = try await client.snapshot(tree: treeID, root: inspection.root)
            let rootBytes = try #require(projected.objects.first { $0.hash == projected.root }?.bytes)
            guard case let .directory(entries, metadata) = try ProtocolObjectCodec.decode(rootBytes, kind: .directory) else { throw ConflictReviewError.unavailable }
            let deletionBytes = try ProtocolObjectCodec.encode(.directory(entries.filter { $0.name != "page.md" }, childrenSource: metadata))
            let deletionRoot = ProtocolObjectCodec.hash(deletionBytes)
            let deletion = ProtocolCandidateUpdate(candidate: deletionRoot, trace: nil,
                objects: [.init(hash: deletionRoot, bytes: deletionBytes)])
            let deletionRequest = try await client.prepareUpdates(tree: treeID,
                base: .init(root: inspection.root, update: inspection.state), updates: [deletion])
            _ = try await client.submitUpdateResponse(deletionRequest)
            _ = try await coordinator.recoverWatchGap()
            let coupled = try await coordinator.inspectChoices()
            let ancestor = try #require(coupled.decisions.first { $0.dependencies.contains(decision.id) })
            let rootAlternative = try #require(ancestor.alternatives.first { $0.value.directory == (mode == "group-keep" ? coupled.root : deletionRoot) })
            var group = ConflictReviewDraft(snapshot: coupled, decision: ancestor, alternative: rootAlternative.id)
            #expect(group.decisions.count == 2)
            #expect(!group.obligations.isEmpty)
            group.set(.init(alternative: hiddenID, source: mode == "group-keep" ? "Grouped exact\r\n" : nil,
                destination: mode == "group-rescue" ? "/rescued.md" : nil,
                remove: mode == "group-remove" || mode == "group-lost-response"), for: decision.id)
            let preview = try await coordinator.previewReviewDraft(group)
            #expect(preview.changes.contains { $0.path == (mode == "group-rescue" ? "/rescued.md" : "/page.md") })
            if mode == "group-lost-response" {
                await transport.dropNextResponse()
                // A lost response leaves the resolution pending in the change log.
                try await coordinator.applyReviewDraft(group)
                #expect(try await coordinator.reviewSubmissionPending())
                await session.close(); await coordinator.close(); await tree.close()
                let reopenedTree = try await place(try await client.descriptor(tree: treeID), client: client)
                let reopened = try UpdateCoordinator(workingTree: reopenedTree, transport: transport, stateRoot: root , publicationDelay: .seconds(3600), publicationMaxDelay: .seconds(3600))
                _ = try await reopened.syncOnce()
                #expect(await transport.replayedExactBody())
                #expect(try await reopened.reviewDrafts().isEmpty)
                #expect(try await reopened.reviewSubmissionPending() == false)
                await reopened.close(); await reopenedTree.close()
            } else {
                try await coordinator.applyReviewDraft(group)
                #expect(try await coordinator.reviewDrafts().isEmpty)
                await session.close(); await coordinator.close(); await tree.close()
            }
            let accepted = try await client.descriptor(tree: treeID)
            #expect(!accepted.tree.conflicted)
            #expect(accepted.tree.root == preview.candidate.root)
            return
        }
        let source = mode == "choose" ? hiddenFragment : "# Reviewed\r\n\r\nKeep exact spaces  \r\nCafe\u{301} and café\r\n"
        let expected = try await expectedSource(source)
        let draft = ConflictReviewDraft(snapshot: inspection, decision: decision, alternative: hiddenID, source: mode == "choose" ? nil : source)
        try await coordinator.retainReviewDraft(draft)
        #expect(try await coordinator.reviewDrafts().count == 1)
        if mode == "lost-response" {
            await transport.dropNextResponse()
            try await coordinator.applyReviewDraft(draft)
            #expect(try await coordinator.reviewSubmissionPending())
            await session.close(); await coordinator.close(); await tree.close()
            let acceptedCurrent = try await client.descriptor(tree: treeID)
            let reopenedTree = try await place(acceptedCurrent, client: client)
            let reopened = try UpdateCoordinator(workingTree: reopenedTree, transport: transport, stateRoot: root )
            #expect(try await reopened.reviewDrafts().first?.source.map { Data($0.utf8) } == Data(source.utf8))
            _ = try await reopened.syncOnce()
            #expect(try await reopened.reviewSubmissionPending() == false)
            #expect(try await reopened.reviewDrafts().isEmpty)
            #expect(await transport.replayedExactBody())
            let provider = WorkingTreeProvider(workingTree: reopenedTree, coordinator: reopened)
            let reopenedSession = try await provider.openDocument(reference)
            #expect(try await reopenedSession.snapshot().source.utf8.elementsEqual(expected.utf8))
            let current = try await reopenedSession.snapshot()
            _ = try await reopenedSession.admit(intent: .init(basis: current, patch: .init(baseContentRevision: current.contentRevision,
                edits: [.init(utf8Range: 0..<current.source.utf8.count, replacement: "Review completed\n", expected: current.source)]), source: "Review completed\n"))
            _ = try await reopened.syncOnce()
            await reopenedSession.close(); await reopened.close(); await reopenedTree.close()
            return
        }
        if mode == "continued-edit" {
            await transport.holdResolutionResponse()
            let apply = Task { try await coordinator.applyReviewDraft(draft) }
            for _ in 0..<500 {
                if await transport.isHolding { break }
                try await Task.sleep(for: .milliseconds(10))
            }
            guard await transport.isHolding else {
                await transport.releaseResponse()
                try await apply.value
                Issue.record("Resolution never reached response gate"); return
            }
            let laterBasis = try await session.snapshot()
            let later = "Latest local after review\n"
            _ = try await session.admit(intent: .init(basis: laterBasis, patch: .init(baseContentRevision: laterBasis.contentRevision,
                edits: [.init(utf8Range: 0..<laterBasis.source.utf8.count, replacement: later, expected: laterBasis.source)]), source: later))
            var newerDraft = draft; newerDraft.source = "Unsubmitted scratch\n"
            try await coordinator.retainReviewDraft(newerDraft)
            await transport.releaseResponse()
            try await apply.value
            #expect(try await coordinator.reviewDrafts().first?.source == "Unsubmitted scratch\n")
            let latest = try await coordinator.inspectChoices()
            var preserved = try await session.snapshot().source == later
            for choice in latest.decisions {
                for alternative in choice.alternatives {
                    if let content = try await coordinator.reviewContent(alternative),
                       content == Data(later.utf8) || content == Data(later.dropLast().utf8) { preserved = true }
                    if let directory = alternative.value.directory {
                        var pending = [(directory, ProtocolEntryKind.directory)], visited = Set<String>()
                        while let (hash, kind) = pending.popLast() {
                            guard visited.insert(hash).inserted else { continue }
                            let bytes = try await client.object(tree: treeID, hash: hash)
                            if kind == .file, bytes == Data(later.utf8) { preserved = true }
                            if kind == .directory, case let .directory(entries, _) = try ProtocolObjectCodec.decode(bytes, kind: kind) {
                                for entry in entries { if let hash = entry.hash, let kind = entry.kind { pending.append((hash, kind)) } }
                            }
                        }
                    }
                }
            }
            #expect(preserved)
            // The disposable tree may retain a new enclosing choice. Do not
            // choose its source placement implicitly while testing publication.
            try await coordinator.discardReviewDraft(draft.id)
            await session.close(); await coordinator.close(); await tree.close()
            return
        }
        try await coordinator.applyReviewDraft(draft)
        #expect(try await coordinator.reviewSubmissionPending() == false)
        #expect(try await coordinator.reviewDrafts().isEmpty)
        let after = try await coordinator.inspectChoices()
        #expect(!after.decisions.contains { $0.id == decision.id })
        let current = try await session.snapshot()
        #expect(Data(current.source.utf8) == Data(expected.utf8))
        _ = try await session.admit(intent: .init(basis: current, patch: .init(baseContentRevision: current.contentRevision,
            edits: [.init(utf8Range: 0..<current.source.utf8.count, replacement: "Review completed\n", expected: current.source)]), source: "Review completed\n"))
        _ = try await coordinator.syncOnce()
        await session.close(); await coordinator.close(); await tree.close()
    }
}

extension LiveChangeLogTests {
    @Test("Native source-range review preserves and relocates another unresolved choice")
    func independentRangeReview() async throws {
        let environment = ProcessInfo.processInfo.environment
        guard let address = environment["ARBOR_SOURCE_TEST_URL"], let origin = URL(string: address),
              let token = environment["ARBOR_SOURCE_TEST_TOKEN"], let trees = environment["ARBOR_REVIEW_TEST_TREES"],
              let treeID = try JSONDecoder().decode([String: String].self, from: Data(trees.utf8))["independent-ranges"] else { return }
        let root = FileManager.default.temporaryDirectory.appending(path: "range-review-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let client = ProtocolClient(origin: origin, credential: token)
        let tree = try await place(try await client.descriptor(tree: treeID), client: client)
        let coordinator = try UpdateCoordinator(workingTree: tree, transport: ProtocolReplicaTransport(client: client), stateRoot: root , publicationDelay: .seconds(3600), publicationMaxDelay: .seconds(3600))
        let reference = WorkspaceReference(tree: TreeID(rawValue: treeID), path: "/page")
        let session = try await WorkingTreeProvider(workingTree: tree, coordinator: coordinator).openDocument(reference)
        let initialSource = try await session.snapshot()
        _ = try await session.admit(intent: .init(basis: initialSource,
            patch: .init(baseContentRevision: initialSource.contentRevision, edits: [
                .init(utf8Range: 0..<initialSource.source.utf8.count, replacement: "éaaa bccc\r\n", expected: initialSource.source)
            ]), source: "éaaa bccc\r\n"))
        _ = try await coordinator.syncOnce()
        let basis = try await session.snapshot(), captured = try await tree.captureSourceBasis(reference)
        func change(_ first: String, _ second: String, from basis: WorkspaceDocumentSnapshot) throws -> WorkspaceDocumentIntent {
            try .init(basis: basis, patch: .init(baseContentRevision: basis.contentRevision, edits: [
                .init(utf8Range: 2..<5, replacement: first, expected: "aaa"),
                .init(utf8Range: 7..<10, replacement: second, expected: "ccc")
            ]), source: "é\(first) b\(second)\r\n")
        }
        let peer = try captured.prepare(intent: change("AAA", "CCC", from: captured.document))
        let request = try await client.prepareUpdates(tree: treeID, base: #require(captured.accepted), updates: [peer.update])
        _ = try await client.submitUpdateResponse(request)
        _ = try await session.admit(intent: change("X", "Z", from: basis)); _ = try await coordinator.syncOnce()
        let inspection = try await coordinator.inspectChoices()
        #expect(inspection.decisions.count == 2)
        let first = try #require(inspection.decisions.first { $0.sourceRange == 2..<5 })
        let second = try #require(inspection.decisions.first { $0.id != first.id })
        var hidden: String?
        for alternative in first.alternatives {
            if try await coordinator.reviewContent(alternative) == Data("X".utf8) { hidden = alternative.id }
        }
        let draft = ConflictReviewDraft(snapshot: inspection, decision: first, alternative: try #require(hidden))
        let preview = try await coordinator.previewReviewDraft(draft)
        #expect(preview.operations?.map(\.kind) == ["copySource", "editSource"])
        try await coordinator.applyReviewDraft(draft)
        let remaining = try await coordinator.inspectChoices()
        #expect(remaining.decisions.count == 1)
        #expect(remaining.decisions.first?.id == second.id)
        #expect(remaining.decisions.first?.sourceRange == 5..<8)
        #expect(try await session.snapshot().source == "éX bCCC\r\n")
        await session.close(); await coordinator.close(); await tree.close()
    }
}

private actor ReviewResponseLossTransport: UpdateTransport {
    let client: ProtocolClient
    private var shouldDrop = false
    private var shouldHold = false
    private var continuation: CheckedContinuation<Void, Never>?
    var isHolding: Bool { continuation != nil }
    func holdResolutionResponse() { shouldHold = true }
    func releaseResponse() { continuation?.resume(); continuation = nil; shouldHold = false }
    private var dropped: Data?
    private var replay: Data?
    init(client: ProtocolClient) { self.client = client }
    func dropNextResponse() { shouldDrop = true }
    func replayedExactBody() -> Bool { dropped != nil && dropped == replay }
    func submit(_ prepared: PreparedProtocolUpdate) async throws -> ProtocolUpdateResponse {
        let response = try await client.submitUpdateResponse(prepared)
        let request = try JSONDecoder().decode(ProtocolUpdateRequest.self, from: prepared.body)
        if shouldHold, request.updates.contains(where: { !$0.resolves.isEmpty }) {
            await withCheckedContinuation { continuation = $0 }
        }
        if shouldDrop {
            shouldDrop = false; dropped = prepared.body
            throw URLError(.networkConnectionLost)
        }
        if dropped != nil { replay = prepared.body }
        return response
    }
    func descriptor(tree: String) async throws -> ProtocolCurrentTree { try await client.descriptor(tree: tree) }
    func snapshot(tree: String, root: String) async throws -> ProtocolSnapshot { try await client.snapshot(tree: tree, root: root) }
    func conflicts(tree: String, state: String, root: String, after: String?) async throws -> ProtocolDecisionPageContract {
        try await client.conflicts(tree: tree, state: state, root: root, after: after)
    }
    func object(tree: String, hash: String) async throws -> Data { try await client.object(tree: tree, hash: hash) }
}
