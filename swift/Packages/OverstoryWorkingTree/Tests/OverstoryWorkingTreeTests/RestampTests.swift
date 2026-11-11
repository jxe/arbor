import OverstoryWorkspace
import Overstory
@testable import OverstoryWorkingTree
import Foundation
import Testing

/// Queued edits made at different times publish as one update under the last
/// edit's time (TS: tests/integration/overstoryd/source-acceptance.test.ts,
/// "queued edits made at different times publish as one update under the
/// last edit's time").
@Suite("Restamped batches")
struct RestampTests {
    let tree = "tr_batch"
    let early = "2026-11-11T10:00:00.000Z", late = "2026-11-11T10:05:00.000Z"

    /// `/nested/left/note.md` and `/nested/right/note.md`, each a file dated
    /// `times`, holding `left` and `right`.
    func graph(left: String, right: String, leftTimes: (Int, Int) = (0, 0), rightTimes: (Int, Int) = (0, 0)) throws -> ProtocolSnapshot {
        var objects: [ProtocolObjectEnvelope] = []
        func side(_ source: String, _ times: (Int, Int)) throws -> String {
            let file = try ProtocolObjectCodec.object(.file(Data(source.utf8)))
            let directory = try ProtocolObjectCodec.object(.directory([.init(name: "note.md", file: file.hash, created: times.0, modified: times.1)]))
            objects += [file, directory]
            return directory.hash
        }
        let nested = try ProtocolObjectCodec.object(.directory([
            .init(name: "left", directory: try side(left, leftTimes)), .init(name: "right", directory: try side(right, rightTimes)),
        ]))
        let root = try ProtocolObjectCodec.object(.directory([.init(name: "nested", directory: nested.hash)]))
        objects += [nested, root]
        return ProtocolSnapshot(root: root.hash, objects: Dictionary(objects.map { ($0.hash, $0) }, uniquingKeysWith: { a, _ in a }).values.sorted { $0.hash < $1.hash })
    }

    func edit(_ graph: ProtocolSnapshot, basis: LocalChangeBasis, side: String, from source: String, to replacement: String, at: String) throws -> LocalChange {
        let reference = WorkspaceReference(tree: TreeID(rawValue: tree), path: "/nested/\(side)/note")
        let patch = WorkspaceDocumentPatch(baseContentRevision: "r", edits: [.init(utf8Range: 0..<3, replacement: replacement)])
        return try LocalChange(tree: tree, basis: basis, graph: graph, sourcePath: "/nested/\(side)/note.md",
            intent: .init(basis: .init(reference: reference, source: source, contentRevision: "r"), patch: patch, source: try patch.applying(to: source)), at: at)
    }

    @Test("Two edits at different times publish as one update dated by the last, every touched entry restamped")
    func mixedTimes() throws {
        let start = try graph(left: "Old\r\n", right: "Old\r\n")
        let first = try edit(start, basis: .accepted(.init(root: start.root, update: "up_1")), side: "left", from: "Old\r\n", to: "One", at: early)
        let second = try edit(first.candidate, basis: .authored(change: first.change), side: "right", from: "Old\r\n", to: "Two", at: late)
        let lateMs = try #require(ProtocolEntryTime.milliseconds(late)), earlyMs = try #require(ProtocolEntryTime.milliseconds(early))
        // Locally, each edit stamped its own entry with its own time.
        #expect(second.candidate.root == (try graph(left: "One\r\n", right: "Two\r\n", leftTimes: (0, earlyMs), rightTimes: (0, lateMs))).root)

        let group = try #require(try LocalChange.publication([first, second], previous: []))
        #expect(group.update.at == late)
        #expect(group.update.trace?.count == 2)  // Two files: two frames.
        var held: [String: Data] = [:]
        for record in [first, second] { for object in record.graph.objects + record.candidate.objects { held[object.hash] = object.bytes } }
        let restamped = try #require(try LocalChange.restamped(group.update, from: start.root, held: held))
        let expected = try graph(left: "One\r\n", right: "Two\r\n", leftTimes: (0, lateMs), rightTimes: (0, lateMs))
        #expect(restamped.update.candidate == expected.root)
        let trace = try #require(restamped.update.trace)
        #expect(trace.first?.before == start.root)
        #expect(zip(trace, trace.dropFirst()).allSatisfy { $0.after == $1.before })
        #expect(trace.last?.after == expected.root)
        #expect(trace.map(\.operations) == group.update.trace?.map(\.operations))
        // The new directories travel; the request still validates.
        for hash in [expected.root] { #expect(restamped.update.objects.contains { $0.hash == hash }) }
        _ = try JSONEncoder().encode(ProtocolUpdateRequest(base: "up_1", updates: [restamped.update]))
        if let dump = ProcessInfo.processInfo.environment["P003_RESTAMP_DUMP"] {
            let objects = held.merging(restamped.generated) { a, _ in a }.mapValues { $0.base64EncodedString() }
            let update = try JSONSerialization.jsonObject(with: JSONEncoder().encode(restamped.update))
            try JSONSerialization.data(withJSONObject: ["objects": objects, "update": update]).write(to: URL(fileURLWithPath: dump))
        }

        // An update after it continues from the restamped root.
        let third = try edit(second.candidate, basis: .authored(change: second.change), side: "left", from: "One\r\n", to: "Thr", at: late)
        let continued = try #require(try LocalChange.restamped(third.update, from: expected.root, held: held.merging(restamped.generated) { a, _ in a }))
        #expect(continued.update.trace?.first?.before == expected.root)
        #expect(continued.update.candidate == (try graph(left: "Thr\r\n", right: "Two\r\n", leftTimes: (0, lateMs), rightTimes: (0, lateMs))).root)
    }

    @Test("A batch at one time is left as it is")
    func sameTime() throws {
        let start = try graph(left: "Old\r\n", right: "Old\r\n")
        let first = try edit(start, basis: .accepted(.init(root: start.root, update: "up_1")), side: "left", from: "Old\r\n", to: "One", at: late)
        let second = try edit(first.candidate, basis: .authored(change: first.change), side: "right", from: "Old\r\n", to: "Two", at: late)
        let group = try #require(try LocalChange.publication([first, second], previous: []))
        let restamped = try #require(try LocalChange.restamped(group.update, from: start.root, held: [:].merging((first.graph.objects + first.candidate.objects + second.candidate.objects).map { ($0.hash, $0.bytes) }) { a, _ in a }))
        #expect(restamped.update == group.update)
    }

    @Test("A batch made at different times that relocates an entry is not composed")
    func relocationsStayApart() throws {
        let start = try graph(left: "Old\r\n", right: "Old\r\n")
        let first = try edit(start, basis: .accepted(.init(root: start.root, update: "up_1")), side: "left", from: "Old\r\n", to: "One", at: early)
        let transfer = EntryTransfer(kind: .copyEntry, source: "/nested/left/note.md", parent: "/nested", name: "copy.md")
        let lateMs = try #require(ProtocolEntryTime.milliseconds(late))
        let copied = try transfer.prepare(graph: first.candidate, at: lateMs)
        let second = try LocalChange(tree: tree, basis: .authored(change: first.change), graph: first.candidate, candidate: copied.candidate, entryTransfer: transfer, at: late)
        // The copy is a new entry, created and modified when it was made.
        #expect(try LocalChange.entry(at: "/nested/copy.md", in: second.candidate).map { [$0.created, $0.modified] } == [lateMs, lateMs])
        #expect(try LocalChange.publication([first, second], previous: []) == nil)
    }
}
