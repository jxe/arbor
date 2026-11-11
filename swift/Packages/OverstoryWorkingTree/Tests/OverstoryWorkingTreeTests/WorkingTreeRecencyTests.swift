import OverstoryWorkspace
import StoryKit
import Overstory
import Foundation
import Testing
@testable import OverstoryWorkingTree

/// A node's date is its content entry's `modified` time (data model §6): the
/// tree reads it from the directory entries it holds, with no other request.
struct WorkingTreeRecencyTests {
    private let tree = TreeID(rawValue: "tr_recency")
    private func day(_ n: Double) -> Date { Date(timeIntervalSince1970: 1_788_000_000 + n * 86_400) }

    /// `state` with each node in `dates` given entry times modified then.
    private func dated(_ state: WorkingTreeState, _ dates: [String: Date]) -> WorkingTreeState {
        var state = state
        for index in state.nodes.indices {
            guard let date = dates[state.nodes[index].path], let content = state.nodes[index].contentHash else { continue }
            let ms = ProtocolEntryTime.milliseconds(date)
            state.nodes[index].times = WorkingTreeEntryTimes(content: content, created: ms, modified: ms)
        }
        return state
    }

    private func snapshot(_ state: WorkingTreeState) throws -> ProtocolSnapshot {
        let stored = try WorkingTreeProtocolCodec.snapshot(for: state)
        return ProtocolSnapshot(root: stored.root, objects: try stored.objects.map {
            ProtocolObjectEnvelope(hash: $0.hash, bytes: try #require($0.bytes))
        })
    }

    @Test("Entry times date the tree's pages and survive indexing, acceptance, and reopen")
    func bootstrapDates() async throws {
        let dates = ["/": day(2), "/note": day(1)]
        let state = dated(WorkingTreeState(tree: tree.rawValue, nodes: [
            WorkingTreeNode(path: "/", kind: .directory, source: "# Home\n"),
            WorkingTreeNode(path: "/note", kind: .markdown, source: "A note\n"),
        ]), dates)
        let snapshot = try snapshot(state)
        let folder = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: folder) }
        let workingTree = try await WorkingTree.open(at: folder, tree: tree)
        try await workingTree.initializeFromSystem(try SnapshotBridge.replacement(snapshot: snapshot, tree: tree, update: "up_initial"))
        #expect(try await workingTree.currentSnapshot().root == snapshot.root)
        #expect(try await WorkingTreeProvider(workingTree: workingTree).search("", in: tree).allSatisfy { $0.modifiedAt == dates[$0.reference.path] })
        try await workingTree.replaceFromSystem(try SnapshotBridge.replacement(snapshot: snapshot, tree: tree, update: "up_next"))
        try await workingTree.deleteRebuildableIndexes()
        let reopened = try await WorkingTree.open(at: folder, tree: tree)
        let results = try await WorkingTreeProvider(workingTree: reopened).search("", in: tree)
        #expect(results.count == 2)
        #expect(results.allSatisfy { $0.modifiedAt == dates[$0.reference.path] })
    }

    @Test("Local edits advance existing dates, survive reopen, and leave unchanged pages alone")
    func localEditDates() async throws {
        let folder = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: folder) }
        let first = dated(WorkingTreeState(tree: tree.rawValue, nodes: [
            WorkingTreeNode(path: "/", kind: .directory, source: "# Home\n"),
            WorkingTreeNode(path: "/a", kind: .markdown, source: "A\n"),
            WorkingTreeNode(path: "/b", kind: .markdown, source: "B\n"),
        ]), ["/": day(0), "/a": day(1), "/b": day(2)])
        let firstEdit = day(3), secondEdit = day(4)
        var workingTree = try await WorkingTree.open(at: folder, tree: tree, clock: { firstEdit })
        try await workingTree.initializeFromSystem(try SnapshotBridge.replacement(snapshot: try snapshot(first), tree: tree, update: "up_1"))
        let reference = WorkspaceReference(tree: tree, path: "/a")
        #expect(try await workingTree.resolve(reference).modifiedAt == day(1))
        let initial = try await workingTree.documentSnapshot(reference)
        let edited = try await workingTree.writeDocument(reference, source: "First edit\n", baseRevision: initial.contentRevision)
        #expect(try await workingTree.resolve(reference).modifiedAt == firstEdit)
        workingTree = try await WorkingTree.open(at: folder, tree: tree, clock: { secondEdit })
        #expect(try await workingTree.resolve(reference).modifiedAt == firstEdit)
        // A no-op does not become recent just because it was acknowledged again.
        _ = try await workingTree.writeDocument(reference, source: edited.source, baseRevision: edited.contentRevision)
        #expect(try await workingTree.resolve(reference).modifiedAt == firstEdit)
        _ = try await workingTree.writeDocument(reference, source: "Second edit\n", baseRevision: edited.contentRevision)
        let results = try await WorkingTreeProvider(workingTree: workingTree).search("", in: tree)
        #expect(results.first { $0.reference.path == "/a" }?.modifiedAt == secondEdit)
        #expect(results.first { $0.reference.path == "/b" }?.modifiedAt == day(2))
        // The edit also stamped the entry itself.
        #expect(try await workingTree.resolve(reference).times?.modified == ProtocolEntryTime.milliseconds(secondEdit))
        let reopened = try await WorkingTree.open(at: folder, tree: tree)
        #expect(try await reopened.resolve(reference).modifiedAt == secondEdit)
    }

    @Test("Each node is dated by its content entry, files and sibling bodies included")
    func bodyEntries() async throws {
        let expected = ["/": day(1), "/note": day(2), "/Trip": day(3), "/Trip/day": day(4), "/Home": day(5), "/Home/room": day(6), "/photo.png": day(7)]
        let state = dated(WorkingTreeState(tree: tree.rawValue, nodes: [
            WorkingTreeNode(path: "/", kind: .directory, source: "# Home\n"),
            WorkingTreeNode(path: "/note", kind: .markdown, source: "Note\n"),
            WorkingTreeNode(path: "/Trip", kind: .directory, source: "Trip body\n"),
            WorkingTreeNode(path: "/Trip/day", kind: .markdown, source: "Day\n"),
            WorkingTreeNode(path: "/Home", kind: .directory, source: "Sibling body\n", directoryBodyPlacement: .siblingMarkdown),
            WorkingTreeNode(path: "/Home/room", kind: .markdown, source: "Room\n"),
            WorkingTreeNode(path: "/photo.png", kind: .file, ref: .inline(Data([1, 2, 3])), mediaType: "image/png"),
        ]), expected)
        let workingTree = try await WorkingTree.inMemory(tree: tree)
        try await workingTree.initializeFromSystem(try SnapshotBridge.replacement(snapshot: try snapshot(state), tree: tree, update: "up_1"))
        for (path, date) in expected {
            #expect(try await workingTree.resolve(.init(tree: tree, path: path)).modifiedAt == date, "\(path)")
        }
    }

    @Test("An accepted replacement dates what it changes by its entries and keeps the rest")
    func acceptedTime() async throws {
        let base = WorkingTreeState(tree: tree.rawValue, nodes: [
            WorkingTreeNode(path: "/", kind: .directory, source: "# Home\n"),
            WorkingTreeNode(path: "/a", kind: .markdown, source: "A\n"),
            WorkingTreeNode(path: "/b", kind: .markdown, source: "B\n"),
        ])
        let first = dated(base, ["/": day(0), "/a": day(1), "/b": day(2)])
        var edited = base; edited.nodes[1].source = "A edited\n"
        let second = dated(edited, ["/": day(0), "/a": day(3), "/b": day(2)])
        let workingTree = try await WorkingTree.inMemory(tree: tree, clock: { Date(timeIntervalSince1970: 0) })
        try await workingTree.initializeFromSystem(try SnapshotBridge.replacement(snapshot: try snapshot(first), tree: tree, update: "up_1"))
        try await workingTree.replaceFromSystem(try SnapshotBridge.replacement(snapshot: try snapshot(second), tree: tree, update: "up_2", acceptedAt: day(9)))
        #expect(try await workingTree.resolve(.init(tree: tree, path: "/a")).modifiedAt == day(3))
        #expect(try await workingTree.resolve(.init(tree: tree, path: "/b")).modifiedAt == day(2))
    }

    @Test("A node's date is read only from its entry metadata")
    func datesOnlyFromMetadata() throws {
        let bare = #"{"path":"/a","kind":"markdown","source":"A","modifiedAt":1788000000000}"#
        var node = try WorkingTree.decode(WorkingTreeNode.self, from: Data(bare.utf8))
        #expect(node.modifiedAt == nil)
        node.modifiedAt = day(1)
        let encoded = String(decoding: try WorkingTree.encode(node), as: UTF8.self)
        #expect(encoded.contains("\"metadata\"") && !encoded.contains("\"modifiedAt\":1788000000000"))
        #expect(try WorkingTree.decode(WorkingTreeNode.self, from: Data(encoded.utf8)).modifiedAt == day(1))
    }
}
