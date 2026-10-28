import StoryKit
import Overstory
@testable import OverstoryWorkingTree
import Foundation
import Testing

@Suite("Page entries in a working tree")
struct PageEntryTests {
    let tree = TreeID(rawValue: "tr_pages")
    let page = ProtocolPage(id: "p1", properties: [.init("title", .string("A"))], body: Data("Hello world\n".utf8))

    func graph(_ page: ProtocolPage) throws -> ProtocolSnapshot {
        let bytes = try page.encoded()
        let nested = try ProtocolObjectCodec.encode(.directory([.init(name: "note.md", page: ProtocolObjectCodec.hash(bytes))]))
        let root = try ProtocolObjectCodec.encode(.directory([.init(name: "nested", directory: ProtocolObjectCodec.hash(nested))]))
        return ProtocolSnapshot(root: ProtocolObjectCodec.hash(root), objects: [bytes, nested, root].map { .init(hash: ProtocolObjectCodec.hash($0), bytes: $0) })
    }

    /// The page at /nested/note.md in `snapshot`.
    func pageAt(_ snapshot: ProtocolSnapshot) throws -> ProtocolPage? {
        let objects = try ProtocolObjectGraph.validate(snapshot, mode: .sparseFiles)
        guard case let .directory(root, _)? = objects[snapshot.root], let nested = root.first?.directory,
              case let .directory(entries, _)? = objects[nested], let hash = entries.first?.page,
              case let .page(page)? = objects[hash] else { return nil }
        return page
    }

    func capture() async throws -> (WorkingTree, String) {
        let workingTree = try await WorkingTree.inMemory(tree: tree)
        let snapshot = try graph(page)
        let replacement = try SnapshotBridge.replacement(snapshot: snapshot, tree: tree, update: "up_1")
        #expect(replacement.pages)
        try await workingTree.initializeFromSystem(replacement)
        #expect(try await workingTree.currentSnapshot().root == snapshot.root)
        return (workingTree, snapshot.root)
    }

    @Test("A page entry installs as the file it is written as and reads back to the same root")
    func roundTrip() async throws {
        let (workingTree, _) = try await capture()
        let captured = try await workingTree.captureSourceBasis(.init(tree: tree, path: "/nested/note"))
        #expect(captured.document.source == "---\nid: p1\ntitle: A\n---\nHello world\n")
        await workingTree.close()
    }

    @Test("A body edit is an editSource on the page's body; a front-matter edit goes as a snapshot")
    func edits() async throws {
        let (workingTree, _) = try await capture()
        let captured = try await workingTree.captureSourceBasis(.init(tree: tree, path: "/nested/note"))
        let source = captured.document.source
        func edit(_ expected: String, _ replacement: String, change: String) throws -> LocalChange {
            let start = Array(source.utf8).firstRange(of: Array(expected.utf8))!.lowerBound
            let patch = WorkspaceDocumentPatch(baseContentRevision: captured.document.contentRevision,
                edits: [.init(utf8Range: start..<(start + expected.utf8.count), replacement: replacement, expected: expected)])
            return try captured.prepare(intent: WorkspaceDocumentIntent(basis: captured.document, patch: patch, source: patch.applying(to: source)), change: change)
        }

        let body = try edit("world", "there", change: "body")
        let operation = try #require(body.update.trace?.first?.operations.first)
        #expect(operation.kind == "editSource")
        guard case let .object(target)? = operation.fields["source"] else { Issue.record("No source"); return }
        #expect(target["range"] == .array([.integer(6), .integer(11)]))
        let edited = try #require(try pageAt(body.candidate))
        #expect(edited.properties == page.properties)
        #expect(edited.body == Data("Hello there\n".utf8))

        let property = try edit("title: A", "title: B", change: "property")
        #expect(property.update.trace == nil)
        #expect(try pageAt(property.candidate)?.properties == [.init("title", .string("B"))])
        await workingTree.close()
    }

    @Test("A property choice resolves to the page with that property set")
    func propertyValues() throws {
        let date = try PageValue(json: .object(["$date": .string("2026-10-28")]))
        #expect(date == .date("2026-10-28"))
        #expect(date.json == .object(["$date": .string("2026-10-28")]))
        let wrapped = PageValue.map(["$date": .string("x")])
        #expect(try PageValue(json: wrapped.json) == wrapped)
        #expect(page.setting("title", to: nil).properties.isEmpty)
        #expect(page.setting("status", to: .string("done")).properties.map(\.name) == ["title", "status"])
    }
}
