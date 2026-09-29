import CanopyAppKit
import Overstory
@testable import CanopyWorkingTree
import Foundation
import Testing

@Suite("Coalesced publications")
struct PublicationTests {
    struct Fixture: Decodable {
        struct Case: Decodable {
            struct Step: Decodable {
                struct Move: Decodable { var source: [Int]; var anchor: [Int]; var side: WorkspaceSourceMove.Side }
                struct Edit: Decodable { var range: [Int]; var replacement: String }
                var moves: [Move]?; var edits: [Edit]?; var source: String
            }
            var name: String; var source: String; var steps: [Step]; var frames: Int; var kinds: [String]
        }
        var cases: [Case]
    }
    @Test("Shared move and mixed-edit vectors preserve the original records and publish one update")
    func sharedPublications() throws {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appending(path: "../../../../../tests/fixtures/coalesced-publication.json")
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
        for value in fixture.cases {
            let file = try ProtocolObjectCodec.object(.file(Data(value.source.utf8)))
            let root = try ProtocolObjectCodec.object(.directory([.init(name: "note.md", file: file.hash)]))
            var graph = ProtocolSnapshot(root: root.hash, objects: [file, root])
            var source = value.source, records: [LocalChange] = []
            for (index, step) in value.steps.enumerated() {
                let basis = WorkspaceDocumentSnapshot(reference: .init(tree: "tr_publication", path: "/note"), source: source, contentRevision: "r\(index)")
                let patch = WorkspaceDocumentPatch(baseContentRevision: basis.contentRevision,
                    edits: (step.edits ?? []).map { .init(utf8Range: $0.range[0]..<$0.range[1], replacement: $0.replacement) },
                    moves: step.moves?.map { .init(source: $0.source[0]..<$0.source[1], anchor: $0.anchor[0]..<$0.anchor[1], side: $0.side) })
                #expect(try patch.applying(to: source) == step.source)
                let record = try LocalChange(change: "c\(index)", tree: "tr_publication", basis: records.last.map { .authored(change: $0.change) } ?? .accepted(.init(root: graph.root, update: "up_initial")), graph: graph, sourcePath: "/note.md", intent: .init(basis: basis, patch: patch, source: step.source))
                records.append(record); graph = record.candidate; source = step.source
            }
            let before = try sortedKeysJSON(records)
            let published = try #require(try LocalChange.publication(records, previous: []), Comment(rawValue: value.name))
            #expect(published.changes == records.map(\.change))
            #expect(published.update.trace?.count == value.frames, Comment(rawValue: value.name))
            #expect(published.update.trace?.flatMap(\.operations).map(\.kind) == value.kinds)
            #expect(published.update.candidate == records.last?.candidate.root)
            #expect(try sortedKeysJSON(records) == before)
            #expect(try LocalChange.publication(records, previous: []) == published)
            #expect(try JSONDecoder().decode(ChangePublication.self, from: sortedKeysJSON(published)) == published)
        }
    }
    @Test("A frozen batch preserves disjoint branches and refuses overlapping origins")
    func frozenBranch() async throws {
        let fixture = try Self.branchFixture()
        let (a, b, c, d) = (fixture[0], fixture[1], fixture[2], fixture[3])
        let records = Dictionary(uniqueKeysWithValues: fixture.map { ($0.change, $0) })
        let group = try #require(try LocalChange.publication([a,b], previous: []))
        let before = try sortedKeysJSON(fixture)
        let continuations = try #require(try LocalChange.branchPublications(group, shared: 1, branch: [c,d], records: records))
        #expect(continuations.count == 2)
        #expect(continuations[0].update.trace?.first?.before == group.update.candidate)
        #expect(continuations[1].update.trace?.first?.before == continuations[0].update.candidate)
        #expect(try sortedKeysJSON(fixture) == before)
        let restored = try JSONDecoder().decode(ChangePublication.self, from: sortedKeysJSON(group))
        #expect(try LocalChange.branchPublications(restored, shared: 1, branch: [c,d], records: records) == continuations)
        #expect(try LocalChange.branchPublications(group, shared: 1, branch: [b], records: records) == nil)
        let directory = FileManager.default.temporaryDirectory.appending(path: "publication-retention-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let log = try await ChangeLog(tree: a.tree, stateRoot: directory)
        for record in fixture { try await log.retain(record) }
        _ = try await log.compact(settled: [a.change, b.change, c.change], preservingSettledTail: false, publications: [group.changes])
        #expect(try await log.retained().map(\.change) == fixture.map(\.change))
    }

    static func branchFixture(tree: String = "tr_publication") throws -> [LocalChange] {
        let files = try ["A", "B", "C"].map { try ProtocolObjectCodec.object(.file(Data($0.utf8))) }
        let root = try ProtocolObjectCodec.object(.directory(zip(["a.md", "b.md", "c.md"], files).map { .init(name: $0, file: $1.hash) }))
        let graph = ProtocolSnapshot(root: root.hash, objects: files + [root])
        func edit(_ change: String, _ parent: LocalChange?, _ path: String, _ source: String, _ next: String) throws -> LocalChange {
            let basis = WorkspaceDocumentSnapshot(reference: .init(tree: TreeID(rawValue: tree), path: path), source: source, contentRevision: change)
            return try LocalChange(change: change, tree: tree, basis: parent.map { .authored(change: $0.change) } ?? .accepted(.init(root: graph.root, update: "up_initial")),
                graph: parent?.candidate ?? graph, sourcePath: path,
                intent: .init(basis: basis, patch: .init(baseContentRevision: change, edits: [.init(utf8Range: 0..<source.utf8.count, replacement: next)]), source: next))
        }
        let a = try edit("a", nil, "/a.md", "A", "AA"), b = try edit("b", a, "/b.md", "B", "BB"), c = try edit("c", a, "/c.md", "C", "CC")
        return [a,b,c,try edit("d", c, "/c.md", "CC", "CCC")]
    }

}
