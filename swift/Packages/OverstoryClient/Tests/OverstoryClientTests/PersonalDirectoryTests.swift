import StoryKit
import OverstoryWorkingTree
@testable import OverstoryClient
import Overstory
import Foundation
import Testing

@Suite("Personal directory (People 001)")
struct PersonalDirectoryTests {
    private func withSeedTree(_ body: (WorkingTreeProvider, TreeID) async throws -> Void) async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "story-directory-\(UUID().uuidString)", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let tree = TreeID(rawValue: "tr_directory")
        let workingTree = try await WorkingTree.open(at: root, tree: tree)
        try await workingTree.initializeFromSystem(try SnapshotBridge.replacement(snapshot: try PersonalDirectory.seed(), tree: tree, update: "up_seed", cursor: "up_seed"))
        try await body(WorkingTreeProvider(workingTree: workingTree), tree)
    }

    @Test("The seed is a valid tree with empty People and Trees collections")
    func seed() async throws {
        try await withSeedTree { provider, tree in
            let people = try await provider.collectionRows(WorkspaceReference(tree: tree, path: PersonalDirectory.people))
            #expect(people.rows.values.allSatisfy { $0.isEmpty })
            let trees = try await provider.collectionRows(WorkspaceReference(tree: tree, path: PersonalDirectory.trees))
            #expect(trees.rows.values.allSatisfy { $0.isEmpty })
        }
    }

    @Test("Ties are keyed by the fact, visits are new rows, and the schemas accept them")
    func rows() async throws {
        try await withSeedTree { provider, tree in
            let at = Date(timeIntervalSince1970: 1_800_000_000)
            let people = try await provider.collectionRows(WorkspaceReference(tree: tree, path: PersonalDirectory.people))
            let tie = DirectoryTie(person: "tr_ada", kind: .group, group: "tr_club", name: "Ada", handle: "ada", host: "arb.example")
            #expect(tie.id == "Group-tr_ada-tr_club")
            let placeholder = DirectoryTie(person: "contact:grace", kind: .invited)
            let rows = try applyRowEdits(people.schema, people.rows, [.directory(tie, at: at), .directory(placeholder, at: at)])
            let ties = try #require(rows["Tie"])
            #expect(ties.count == 2)
            let ada = try #require(ties.first { $0["person"] == .string("tr_ada") })
            #expect(ada["kind"] == .string("Group") && ada["group"] == .string("tr_club") && ada["id"] == .string(tie.id))
            // The same fact again is the same row, which the rows refuse to make twice.
            #expect(throws: (any Error).self) { try applyRowEdits(people.schema, rows, [.directory(tie, at: at)]) }

            let trees = try await provider.collectionRows(WorkspaceReference(tree: tree, path: PersonalDirectory.trees))
            let tree = DirectoryTree(id: "tr_notes", title: "Notes", path: "/~ada/notes", host: "arb.example", owner: "tr_ada")
            let visit = DirectoryVisit(tree: tree, path: "/ideas", title: "Ideas", at: at)
            let applied = try applyRowEdits(trees.schema, trees.rows, [.directory(tree, parent: nil, at: at), .directory(visit, device: "iPhone"),
                                                                      .directoryPlacement(tree: "tr_notes", device: "iPhone", at: at)])
            let row = try #require(applied["Tree"]?.first)
            #expect(row["id"] == .string("tr_notes") && row["owner"] == .string("tr_ada") && row["kind"] == .string("Tree"))
            #expect(applied["Placement"]?.first?["id"] == .string("tr_notes-iPhone"))
            let visits = try #require(applied["Visit"])
            #expect(visits.first?["how"] == .string("Opened") && visits.first?["path"] == .string("/ideas") && visits.first?["tree"] == .string("tr_notes"))
            #expect(visits.first?["at"] == .string("2027-01-15T08:00:00.000Z"))
        }
    }
}
