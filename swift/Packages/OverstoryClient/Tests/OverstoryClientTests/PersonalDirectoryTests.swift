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
            #expect(people.rows.values.allSatisfy(\.isEmpty))
            let trees = try await provider.collectionRows(WorkspaceReference(tree: tree, path: PersonalDirectory.trees))
            #expect(trees.rows.values.allSatisfy(\.isEmpty))
        }
    }

    @Test("Sightings and visits are new rows the schemas accept")
    func rows() async throws {
        try await withSeedTree { provider, tree in
            let at = Date(timeIntervalSince1970: 1_800_000_000)
            let people = try await provider.collectionRows(WorkspaceReference(tree: tree, path: PersonalDirectory.people))
            let sighting = RowEdit.directory(DirectorySighting(person: "tr_ada", tie: .group, name: "Ada", handle: "ada", host: "arb.example", tree: "tr_club"), device: "Mac", at: at)
            let placeholder = RowEdit.directory(DirectorySighting(person: "contact:grace", tie: .invited), device: nil, at: at)
            let rows = try applyRowEdits(people.schema, people.rows, [sighting, placeholder])
            let sightings = try #require(rows["Sighting"])
            #expect(sightings.count == 2)
            let ada = try #require(sightings.first { $0["person"] == .string("tr_ada") })
            #expect(ada["kind"] == .string("Group") && ada["tree"] == .string("tr_club") && ada["device"] == .string("Mac"))
            #expect(ada["at"] == .string("2027-01-15T08:00:00.000Z"))
            #expect(sightings.first { $0["person"] == .string("contact:grace") }?["device"] == nil)

            let trees = try await provider.collectionRows(WorkspaceReference(tree: tree, path: PersonalDirectory.trees))
            let visit = RowEdit.directory(DirectoryVisit(tree: "tr_notes", path: "/ideas", title: "Ideas", host: "arb.example", at: at), device: "iPhone")
            let visits = try #require(try applyRowEdits(trees.schema, trees.rows, [visit])["Visit"])
            #expect(visits.first?["how"] == .string("Opened") && visits.first?["path"] == .string("/ideas"))
        }
    }
}
