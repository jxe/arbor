import CanopyAppKit
import Overstory
import Foundation
import Testing
@testable import CanopyWorkingTree

struct WorkingTreeRecencyTests {
    @Test("Bootstrap dates survive indexing, acceptance, and reopen without changing content hashes")
    func bootstrapDates() async throws {
        let tree = TreeID(rawValue: "tr_recency")
        let original = WorkingTreeState(tree: tree.rawValue, nodes: [
            WorkingTreeNode(path: "/", kind: .directory, source: "# Home\n"),
            WorkingTreeNode(path: "/note", kind: .markdown, source: "A note\n"),
        ])
        let stored = try WorkingTreeWireCodec.snapshot(for: original)
        let snapshot = WireSnapshot(root: stored.root, objects: try stored.objects.map {
            WireObjectEnvelope(hash: $0.hash, bytes: try #require($0.bytes))
        })
        let dates = ["/": Date(timeIntervalSince1970: 1_789_473_600), "/note": Date(timeIntervalSince1970: 1_789_387_200)]
        let replacement = try SnapshotBridge.replacement(snapshot: snapshot, tree: tree, update: "up_initial", modifiedAtByPath: dates)
        let folder = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: folder) }
        let workingTree = try await WorkingTree.open(at: folder, tree: tree)
        try await workingTree.initializeFromSystem(replacement)
        #expect(try await workingTree.currentSnapshot().root == snapshot.root)
        let provider = WorkingTreeProvider(workingTree: workingTree)
        #expect(try await provider.search("", in: tree).allSatisfy { $0.modifiedAt == dates[$0.reference.path] })
        // Acceptance has no filesystem metadata, but must retain known dates.
        try await workingTree.replaceFromSystem(try SnapshotBridge.replacement(snapshot: snapshot, tree: tree, update: "up_next"))
        try await workingTree.deleteRebuildableIndexes()
        let reopened = try await WorkingTree.open(at: folder, tree: tree)
        let results = try await WorkingTreeProvider(workingTree: reopened).search("", in: tree)
        #expect(results.count == 2)
        #expect(results.allSatisfy { $0.modifiedAt == dates[$0.reference.path] })
    }
}
