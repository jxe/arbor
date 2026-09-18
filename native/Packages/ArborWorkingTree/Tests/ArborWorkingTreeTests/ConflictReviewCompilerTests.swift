import ArborWire
import Foundation
import Testing
@testable import ArborWorkingTree

@Suite("Grouped review compilation")
struct ConflictReviewCompilerTests {
    struct Fixture {
        var objects: [String: Data] = [:]
        mutating func file(_ source: String) throws -> String { try store(.file(Data(source.utf8))) }
        mutating func directory(_ entries: [WireDirectoryEntry]) throws -> String {
            try store(.directory(entries.sorted { $0.name < $1.name }, childrenSource: nil))
        }
        mutating func store(_ object: WireObject) throws -> String {
            let bytes = try WireObjectCodec.encode(object), hash = WireObjectCodec.hash(bytes)
            objects[hash] = bytes; return hash
        }
        func snapshot(_ root: String) -> WireSnapshot {
            var reachable = Set<String>()
            func visit(_ hash: String, kind: WireEntryKind) {
                guard reachable.insert(hash).inserted else { return }
                if kind == .directory, case let .directory(entries, _) = try! WireObjectCodec.decode(objects[hash]!, kind: .directory) {
                    for entry in entries { if let hash = entry.hash, let kind = entry.kind { visit(hash, kind: kind) } }
                }
            }
            visit(root, kind: .directory)
            return .init(root: root, objects: reachable.map { .init(hash: $0, bytes: objects[$0]!) })
        }
        func decision(_ id: String, path: String, values: [[String: String]], dependencies: [String] = [], root: String) throws -> ConflictReviewDecision {
            let components = path.split(separator: "/").map(String.init)
            let parent = "/" + components.dropLast().joined(separator: "/")
            let alternatives: [[String: Any]] = values.enumerated().map { index, value in
                var result: [String: Any] = ["id": "\(id)-\(index)", "revision": "r-\(index)", "value": value]
                if path != "/" { result["placement"] = ["parent": ["material": ["kind": "basis", "path": parent, "object": root]], "name": components.last!] }
                return result
            }
            return try JSONDecoder().decode(ConflictReviewDecision.self, from: JSONSerialization.data(withJSONObject: [
                "id": id, "kind": path == "/" ? "directory" : "entry", "selected": "\(id)-0", "alternatives": alternatives,
                "affected": [["material": ["kind": "basis", "path": path, "object": root]]], "dependencies": dependencies, "actions": ["resolveConflict"]
            ]))
        }
    }
    private func draft(_ root: String, _ decisions: [ConflictReviewDecision]) -> ConflictReviewDraft {
        let snapshot = ConflictReviewSnapshot(tree: "tr_review", state: "accepted", root: root, decisions: decisions)
        return .init(snapshot: snapshot, decision: decisions[0], alternative: decisions[0].selected)
    }

    @Test func childChoiceOverridesChosenDirectoryAndMissingChoicesBlockPreview() throws {
        var f = Fixture()
        let original = try f.file("original\n"), other = try f.file("other\n")
        let directory = try f.directory([.init(name: "note.md", file: original)])
        let root = try f.directory([.init(name: "folder", directory: directory)])
        let parent = try f.decision("parent", path: "/folder", values: [["directory": directory]], dependencies: ["child"], root: root)
        let child = try f.decision("child", path: "/folder/note.md", values: [["file": original], ["file": other]], root: root)
        var proposal = draft(root, [parent, child])
        #expect(proposal.obligations.count == 1)
        #expect(throws: ConflictReviewProposalError.self) { try ConflictReviewCompiler.compile(proposal, base: f.snapshot(root), material: f.objects) }
        try proposal.choose(child.id, alternative: "child-1")
        let preview = try ConflictReviewCompiler.compile(proposal, base: f.snapshot(root), material: f.objects)
        #expect(preview.changes.first(where: { $0.path == "/folder/note.md" })?.after?.file == other)
        #expect(preview.fingerprint == (try proposal.fingerprint()))
        #expect(proposal.snapshot.group(containing: child.id).count == 2)
        // Removing a child must not be undone by reinstalling its parent version.
        proposal.set(.init(alternative: "child-0", remove: true), for: child.id)
        let removed = try ConflictReviewCompiler.compile(proposal, base: f.snapshot(root), material: f.objects)
        #expect(removed.changes.first(where: { $0.path == "/folder/note.md" })?.after == nil)
        proposal.destination = "/moved"
        let moved = try ConflictReviewCompiler.compile(proposal, base: f.snapshot(root), material: f.objects)
        #expect(!moved.changes.contains { $0.path == "/moved/note.md" && $0.after != nil })
    }

    @Test func rootRemovalRequiresExplicitChildDisposition() throws {
        var f = Fixture()
        let file = try f.file("retained"), folder = try f.directory([.init(name: "note.md", file: file)])
        let root = try f.directory([.init(name: "folder", directory: folder)]), empty = try f.directory([])
        let parent = try f.decision("root", path: "/", values: [["directory": root], ["directory": empty]], dependencies: ["child"], root: root)
        let child = try f.decision("child", path: "/folder/note.md", values: [["file": file]], root: root)
        var proposal = draft(root, [parent, child]); try proposal.choose(parent.id, alternative: "root-1")
        try proposal.choose(child.id, alternative: "child-0")
        #expect(throws: ConflictReviewProposalError.self) { try ConflictReviewCompiler.compile(proposal, base: f.snapshot(root), material: f.objects) }
        proposal.set(.init(alternative: "child-0", destination: "/rescued.md"), for: child.id)
        let rescued = try ConflictReviewCompiler.compile(proposal, base: f.snapshot(root), material: f.objects)
        #expect(rescued.changes.first(where: { $0.path == "/rescued.md" })?.after?.file == file)
        proposal.set(.init(alternative: "child-0", remove: true), for: child.id)
        #expect(try ConflictReviewCompiler.compile(proposal, base: f.snapshot(root), material: f.objects).candidate.root == empty)
    }

    @Test func swapsAreAtomicAndCollisionsDoNotOverwriteUnrelatedEntries() throws {
        var f = Fixture()
        let a = try f.file("A"), b = try f.file("B"), c = try f.file("C")
        let root = try f.directory([.init(name: "a", file: a), .init(name: "b", file: b), .init(name: "c", file: c)])
        let first = try f.decision("a", path: "/a", values: [["file": a]], dependencies: ["b"], root: root)
        let second = try f.decision("b", path: "/b", values: [["file": b]], root: root)
        var proposal = draft(root, [first, second]); proposal.destination = "/b"
        proposal.set(.init(alternative: "b-0", destination: "/a"), for: "b")
        let swapped = try ConflictReviewCompiler.compile(proposal, base: f.snapshot(root), material: f.objects)
        #expect(swapped.changes.first(where: { $0.path == "/a" })?.after?.file == b)
        #expect(swapped.changes.first(where: { $0.path == "/b" })?.after?.file == a)
        #expect(!swapped.changes.contains { $0.path == "/c" })
        proposal.destination = "/c"
        #expect(throws: ConflictReviewProposalError.self) { try ConflictReviewCompiler.compile(proposal, base: f.snapshot(root), material: f.objects) }
        proposal.destination = "/a"
        #expect(throws: ConflictReviewProposalError.self) { try ConflictReviewCompiler.compile(proposal, base: f.snapshot(root), material: f.objects) }
    }

    @Test func boundariesCannotBeTraversedAndUnreviewedChoicesAreProtected() throws {
        var f = Fixture()
        let a = try f.file("A"), b = try f.file("B")
        let root = try f.directory([.init(name: "a", file: a), .init(name: "linked", tree: "tr_0123456789abcdefghijklmnopqrstuv")])
        let first = try f.decision("a", path: "/a", values: [["file": a], ["file": b]], root: root)
        var proposal = draft(root, [first]); proposal.destination = "/linked/child"
        #expect(throws: ConflictReviewProposalError.self) { try ConflictReviewCompiler.compile(proposal, base: f.snapshot(root), material: f.objects) }
        proposal.destination = nil; proposal.alternative = "a-1"
        let other = try f.decision("other", path: "/", values: [["directory": root]], root: root)
        #expect(throws: ConflictReviewProposalError.self) { try ConflictReviewCompiler.compile(proposal, base: f.snapshot(root), material: f.objects, allDecisions: [other]) }
    }

    @Test func secondaryCompositionFingerprintPreservesScalarSpellingAndJournalRecovery() throws {
        var f = Fixture(); let file = try f.file("x"), root = try f.directory([.init(name: "a", file: file), .init(name: "b", file: file)])
        let a = try f.decision("a", path: "/a", values: [["file": file]], dependencies: ["b"], root: root)
        let b = try f.decision("b", path: "/b", values: [["file": file]], root: root)
        var proposal = draft(root, [a, b]); proposal.set(.init(alternative: "b-0", source: "é\r\n"), for: "b")
        let before = try proposal.fingerprint()
        proposal.set(.init(alternative: "b-0", source: "e\u{301}\r\n"), for: "b")
        #expect(try proposal.fingerprint() != before)
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let files = try UpdateControlFiles(root: directory); try files.writeReview(.init(drafts: [proposal]))
        let reopened = try #require(files.loadReview().drafts.first)
        #expect(try reopened.fingerprint() == proposal.fingerprint())
        let preview = try ConflictReviewCompiler.compile(reopened, base: f.snapshot(root), material: f.objects)
        #expect(preview.changes.first(where: { $0.path == "/b" })?.after?.file == WireObjectCodec.hash(Data("e\u{301}\r\n".utf8)))
    }
}
