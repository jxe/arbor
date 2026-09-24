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
        let stored = try WorkingTreeProtocolCodec.snapshot(for: original)
        let snapshot = ProtocolSnapshot(root: stored.root, objects: try stored.objects.map {
            ProtocolObjectEnvelope(hash: $0.hash, bytes: try #require($0.bytes))
        })
        let dates = ["/": Date(timeIntervalSince1970: 1_789_473_600), "/note": Date(timeIntervalSince1970: 1_789_387_200)]
        // Entry metadata is keyed by each page's body entry.
        let entries = ["/_index.md": EntryMetadata(modifiedAt: dates["/"]), "/note.md": EntryMetadata(modifiedAt: dates["/note"])]
        let replacement = try SnapshotBridge.replacement(snapshot: snapshot, tree: tree, update: "up_initial", entryMetadata: entries)
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

    private func snapshot(_ state: WorkingTreeState) throws -> ProtocolSnapshot {
        let stored = try WorkingTreeProtocolCodec.snapshot(for: state)
        return ProtocolSnapshot(root: stored.root, objects: try stored.objects.map {
            ProtocolObjectEnvelope(hash: $0.hash, bytes: try #require($0.bytes))
        })
    }

    private let tree = TreeID(rawValue: "tr_recency")
    private func day(_ n: Double) -> Date { Date(timeIntervalSince1970: 1_788_000_000 + n * 86_400) }

    @Test("Entry metadata dates each node by its body entry, files included")
    func bodyEntries() async throws {
        let state = WorkingTreeState(tree: tree.rawValue, nodes: [
            WorkingTreeNode(path: "/", kind: .directory, source: "# Home\n"),
            WorkingTreeNode(path: "/note", kind: .markdown, source: "Note\n"),
            WorkingTreeNode(path: "/Trip", kind: .directory, source: "Trip body\n"),
            WorkingTreeNode(path: "/Trip/day", kind: .markdown, source: "Day\n"),
            WorkingTreeNode(path: "/Home", kind: .directory, source: "Sibling body\n", directoryBodyPlacement: .siblingMarkdown),
            WorkingTreeNode(path: "/Home/room", kind: .markdown, source: "Room\n"),
            WorkingTreeNode(path: "/photo.png", kind: .file, ref: .inline(Data([1, 2, 3])), mediaType: "image/png"),
        ])
        let entries: [String: EntryMetadata] = [
            "/_index.md": .init(modifiedAt: day(1)), "/note.md": .init(modifiedAt: day(2)),
            "/Trip/_index.md": .init(modifiedAt: day(3)), "/Trip/day.md": .init(modifiedAt: day(4)),
            "/Home.md": .init(modifiedAt: day(5)), "/Home/room.md": .init(modifiedAt: day(6)),
            "/photo.png": .init(modifiedAt: day(7)),
        ]
        let workingTree = try await WorkingTree.inMemory(tree: tree)
        try await workingTree.initializeFromSystem(try SnapshotBridge.replacement(snapshot: try snapshot(state), tree: tree, update: "up_1", entryMetadata: entries))
        let expected = ["/": day(1), "/note": day(2), "/Trip": day(3), "/Trip/day": day(4), "/Home": day(5), "/Home/room": day(6), "/photo.png": day(7)]
        for (path, date) in expected {
            #expect(try await workingTree.resolve(.init(tree: tree, path: path)).modifiedAt == date, "\(path)")
        }
    }

    @Test("Canopy dates are authoritative for the accepted state, and otherwise fill only undated nodes")
    func applyEntryDates() async throws {
        let state = WorkingTreeState(tree: tree.rawValue, nodes: [
            WorkingTreeNode(path: "/", kind: .directory, source: "# Home\n"),
            WorkingTreeNode(path: "/a", kind: .markdown, source: "A\n"),
            WorkingTreeNode(path: "/b", kind: .markdown, source: "B\n"),
        ])
        let workingTree = try await WorkingTree.inMemory(tree: tree)
        try await workingTree.initializeFromSystem(try SnapshotBridge.replacement(snapshot: try snapshot(state), tree: tree, update: "up_1",
            entryMetadata: ["/a.md": .init(modifiedAt: day(1))]))
        let a = WorkspaceReference(tree: tree, path: "/a"), b = WorkspaceReference(tree: tree, path: "/b")
        // Dates for a newer update only fill the gap.
        try await workingTree.applyEntryDates(["/a.md": day(9), "/b.md": day(8)], update: "up_2")
        #expect(try await workingTree.resolve(a).modifiedAt == day(1))
        #expect(try await workingTree.resolve(b).modifiedAt == day(8))
        // Dates for this tree's accepted update win.
        try await workingTree.applyEntryDates(["/a.md": day(5)], update: "up_1")
        #expect(try await workingTree.resolve(a).modifiedAt == day(5))
        #expect(try await workingTree.currentSnapshot().root == (try snapshot(state)).root)
    }

    @Test("An accepted replacement dates what it changes with Canopy's time and keeps the rest")
    func acceptedTime() async throws {
        let first = WorkingTreeState(tree: tree.rawValue, nodes: [
            WorkingTreeNode(path: "/", kind: .directory, source: "# Home\n"),
            WorkingTreeNode(path: "/a", kind: .markdown, source: "A\n"),
            WorkingTreeNode(path: "/b", kind: .markdown, source: "B\n"),
        ])
        var second = first; second.nodes[1].source = "A edited\n"
        let workingTree = try await WorkingTree.inMemory(tree: tree, clock: { Date(timeIntervalSince1970: 0) })
        try await workingTree.initializeFromSystem(try SnapshotBridge.replacement(snapshot: try snapshot(first), tree: tree, update: "up_1",
            entryMetadata: ["/a.md": .init(modifiedAt: day(1)), "/b.md": .init(modifiedAt: day(2))]))
        try await workingTree.replaceFromSystem(try SnapshotBridge.replacement(snapshot: try snapshot(second), tree: tree, update: "up_2", acceptedAt: day(3)))
        #expect(try await workingTree.resolve(.init(tree: tree, path: "/a")).modifiedAt == day(3))
        #expect(try await workingTree.resolve(.init(tree: tree, path: "/b")).modifiedAt == day(2))
    }

    @Test("State written before entry metadata keeps its dates")
    func legacyDates() throws {
        let json = #"{"path":"/a","kind":"markdown","source":"A","modifiedAt":1788000000000}"#
        let node = try WorkingTree.decode(WorkingTreeNode.self, from: Data(json.utf8))
        #expect(node.modifiedAt == Date(timeIntervalSince1970: 1_788_000_000))
        var moved = node; moved.modifiedAt = day(1)
        let encoded = String(decoding: try WorkingTree.encode(moved), as: UTF8.self)
        #expect(encoded.contains("\"metadata\"") && !encoded.contains("\"modifiedAt\":1788000000000"))
    }
}
