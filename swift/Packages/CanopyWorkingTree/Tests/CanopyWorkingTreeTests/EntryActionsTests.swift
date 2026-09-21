import Overstory
@testable import CanopyWorkingTree
import Foundation
import Testing

@Test("Compound entry fixtures retain exact basis references through recovery")
func compoundEntryFixtures() async throws {
    struct Case: Decodable { let name: String; let actions: EntryActions; let candidate: WireSnapshot; let operations: [WireSourceOperation] }
    struct Fixture: Decodable { let change: String; let graph: WireSnapshot; let cases: [Case] }
    let path = URL(fileURLWithPath:#filePath).deletingLastPathComponent().appending(path:"../../../../../docs/overstory-spec/conformance/entry-actions.json")
    let fixture = try JSONDecoder().decode(Fixture.self,from:Data(contentsOf:path))
    for value in fixture.cases {
        let root = FileManager.default.temporaryDirectory.appending(path:UUID().uuidString)
        defer { try? FileManager.default.removeItem(at:root) }
        let record = try SourceAdmissionRecord(change:fixture.change,tree:"tr_compound",basis:.accepted(.init(root:fixture.graph.root,update:"basis")),graph:fixture.graph,candidate:value.candidate,entryActions:value.actions)
        #expect(record.update.trace?.flatMap(\.operations) == value.operations)
        let queue = try await SourceAdmissionQueue(tree:"tr_compound",stateRoot:root)
        try await queue.retain(record)
        let reopened = try await SourceAdmissionQueue(tree:"tr_compound",stateRoot:root)
        #expect(try await reopened.retained() == [record])
        #expect(throws:(any Error).self) { try EntryActions(removals:["/pair","/pair/child.md"]).prepare(graph:fixture.graph,changeID:"invalid") }
    }
}
