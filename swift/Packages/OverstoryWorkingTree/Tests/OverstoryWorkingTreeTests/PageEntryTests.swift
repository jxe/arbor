import OverstoryWorkspace
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

@Suite("Page IDs held more than once")
struct DuplicatePageIDTests {
    let tree = TreeID(rawValue: "tr_duplicates")

    func opened(_ pages: [(path: String, id: String)]) async throws -> WorkingTree {
        let workingTree = try await WorkingTree.inMemory(tree: tree)
        let nodes = pages.map { WorkingTreeNode(path: $0.path, pageID: $0.id, kind: .markdown, source: "---\nid: \($0.id)\n---\n\n# Page\n") }
        let state = WorkingTreeState(tree: tree.rawValue, nodes: [WorkingTreeNode(path: "/", kind: .directory)] + nodes)
        try await workingTree.initializeFromSystem(WorkingTreeSystemReplacement(
            root: try WorkingTreeProtocolCodec.snapshot(for: state).root,
            update: "up_1",
            nodes: [WorkingTreeSystemNode(path: "/", content: .directory())] + nodes.map {
                WorkingTreeSystemNode(path: $0.path, pageID: $0.pageID, content: .markdown(source: $0.source!))
            }
        ))
        return workingTree
    }

    func keyed(_ path: String, _ id: String) -> WorkspaceReference {
        WorkspaceReference(tree: tree, path: path, stableKey: markdownStableKey(id))
    }

    @Test("A tree with a duplicated ID opens, and only those pages report it")
    func duplicateOpens() async throws {
        let workingTree = try await opened([(path: "/a", id: "pg_same"), (path: "/b", id: "pg_same"), (path: "/c", id: "pg_other")])
        #expect(try await workingTree.resolve(keyed("/c", "pg_other")).path == "/c")
        #expect(try await workingTree.children(of: .init(tree: tree, path: "/")).count == 3)
        await #expect(throws: WorkingTreeError.duplicatePageID(paths: ["/a", "/b"])) {
            _ = try await workingTree.resolve(keyed("/a", "pg_same"))
        }
        // Another page can still change.
        _ = try await workingTree.createMarkdown(parent: .init(tree: tree, path: "/"), name: "d", source: "# D\n")
        await workingTree.close()
    }

    @Test("A live page and its copy in Trash each answer to their own path")
    func movedBackOverTrash() async throws {
        let workingTree = try await opened([(path: "/page", id: "pg_moved")])
        let trashed = try await workingTree.trash(keyed("/page", "pg_moved"))
        #expect(trashed.path == "/Trash/page")
        // The stale reference finds the Trash copy until a live page holds the ID.
        #expect(try await workingTree.resolve(keyed("/page", "pg_moved")).path == "/Trash/page")

        let back = try await workingTree.createMarkdown(parent: .init(tree: tree, path: "/"), name: "back", source: "---\nid: pg_moved\n---\n\n# Back\n")
        #expect(back.path == "/back")
        #expect(try await workingTree.resolve(keyed("/page", "pg_moved")).path == "/back")
        #expect(try await workingTree.resolve(keyed("/Trash/page", "pg_moved")).path == "/Trash/page")

        await #expect(throws: WorkingTreeError.collision("/back")) {
            _ = try await workingTree.restore(keyed("/Trash/page", "pg_moved"))
        }
        await workingTree.close()
    }
}
