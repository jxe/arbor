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
}
