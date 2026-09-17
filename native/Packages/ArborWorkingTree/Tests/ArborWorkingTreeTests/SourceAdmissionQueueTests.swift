import ArborKit
import ArborWire
@testable import ArborWorkingTree
import Foundation
import Testing

@Suite("Durable source admission queue")
struct SourceAdmissionQueueTests {
    struct Fixture: Decodable {
        struct Change: Decodable {
            struct Basis: Decodable { let kind: String; let update: String?; let change: String? }
            let change: String; let basis: Basis; let revision: String
            let offset: Int; let length: Int; let expected: String; let replacement: String
        }
        let tree: String; let sourcePath: String; let source: String; let changes: [Change]
        let requests: [String: WireUpdateRequest]
    }
    func fixture() throws -> Fixture {
        let directory = ProcessInfo.processInfo.environment["ARBOR_PROTOCOL_FIXTURES"].map { URL(fileURLWithPath: $0) }
            ?? URL(fileURLWithPath: #filePath).deletingLastPathComponent().appending(path: "../../../../../conformance")
        return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: directory.appending(path: "source-admission-queue.json")))
    }
    func root() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appending(path: "source-queue-\(UUID())")
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }
    func graph(_ source: String) throws -> WireSnapshot {
        let file = Data(source.utf8), fileHash = WireObjectCodec.hash(file)
        let nested = try WireObjectCodec.encode(.directory([.init(name: "note.md", file: fileHash)])), nestedHash = WireObjectCodec.hash(nested)
        let root = try WireObjectCodec.encode(.directory([.init(name: "nested", directory: nestedHash)]))
        return WireSnapshot(root: WireObjectCodec.hash(root), objects: [file, nested, root].map { .init(hash: WireObjectCodec.hash($0), bytes: $0) })
    }
    func records(_ f: Fixture) throws -> [SourceAdmissionRecord] {
        var records: [SourceAdmissionRecord] = []
        for change in f.changes {
            let parent = records.first { $0.change == change.basis.change }
            let graph = try parent?.candidate ?? graph(f.source)
            let source = parent?.intent?.source ?? f.source
            let basis = WorkspaceDocumentSnapshot(reference: .init(tree: TreeID(rawValue: f.tree), path: "/nested/note"), source: source, contentRevision: change.revision)
            let patch = WorkspaceDocumentPatch(baseContentRevision: change.revision,
                edits: [.init(utf8Range: change.offset..<(change.offset + change.length), replacement: change.replacement, expected: change.expected)])
            records.append(try SourceAdmissionRecord(change: change.change, tree: f.tree,
                basis: parent.map { .authored(change: $0.change) } ?? .accepted(.init(root: graph.root, update: change.basis.update!)),
                graph: graph, sourcePath: f.sourcePath,
                intent: .init(basis: basis, patch: patch, source: patch.applying(to: source))))
        }
        return records
    }

    @Test("Shared requests retain same-root dependencies and restart with original operation identities")
    func sharedRequests() async throws {
        let f = try fixture(), root = try root(); defer { try? FileManager.default.removeItem(at: root) }
        let queue = try SourceAdmissionQueue(tree: f.tree, stateRoot: root), all = try records(f)
        for record in all { try await queue.retain(record) }
        let reopened = try SourceAdmissionQueue(tree: f.tree, stateRoot: root)
        #expect(try await reopened.retained() == all)
        try await reopened.retain(all[0])
        #expect(try await reopened.retained().count == 3)
        #expect(Set(all.map { $0.candidate.root }).count == 1)
        for record in all {
            let request = try await reopened.request(through: record.change)
            #expect(request.request == f.requests[record.change])
        }
        #expect(try await reopened.request(through: "change-b").request.updates.map(\.change) == ["change-a", "change-b"])
        #expect(try await reopened.request(through: "change-c").base.update == "up_r2")
    }

    @Test("An R1 capture survives a newer watch and process loss without relabeling the edit")
    func capturedBasis() async throws {
        let f = try fixture(), root = try root(); defer { try? FileManager.default.removeItem(at: root) }
        let tree = try await WorkingTree.inMemory(tree: TreeID(rawValue: f.tree))
        try await tree.initializeFromSystem(SnapshotBridge.replacement(snapshot: graph(f.source), tree: TreeID(rawValue: f.tree), update: "up_r1"))
        let captured = try await tree.captureSourceAdmissionBasis(.init(tree: TreeID(rawValue: f.tree), path: "/nested/note"))
        let peer = try graph("Peer at R2\n")
        try await tree.replaceFromSystem(SnapshotBridge.replacement(snapshot: peer, tree: TreeID(rawValue: f.tree), update: "up_r2"))
        let patch = WorkspaceDocumentPatch(baseContentRevision: captured.document.contentRevision,
            edits: [.init(utf8Range: 0..<6, replacement: "After", expected: "Before")])
        let intent = try WorkspaceDocumentIntent(basis: captured.document, patch: patch, source: patch.applying(to: captured.document.source))
        #expect(throws: (any Error).self) { try captured.prepare(intent: intent, predecessor: "invented-parent") }
        let record = try captured.prepare(intent: intent, change: "captured-r1")
        let queue = try SourceAdmissionQueue(tree: f.tree, stateRoot: root)
        try await queue.retain(record)
        #expect(try await tree.heads().acceptedRoot == peer.root)
        #expect(try await tree.heads().pendingRoot == nil)
        await tree.close()
        let reopened = try SourceAdmissionQueue(tree: f.tree, stateRoot: root)
        #expect(try await reopened.request(through: record.change).base.update == "up_r1")
        #expect(record.graph.root == captured.graph.root)
        #expect(record.graph.root != peer.root)
        #expect(try await reopened.retained().first?.intent?.basis.source == f.source)
    }

    @Test("Missing parents, altered candidates, and reused identities leave all retained work intact")
    func invalidRecords() async throws {
        let f = try fixture(), root = try root(); defer { try? FileManager.default.removeItem(at: root) }
        let queue = try SourceAdmissionQueue(tree: f.tree, stateRoot: root), all = try records(f)
        await #expect(throws: (any Error).self) { try await queue.retain(all[1]) }
        #expect(try await queue.retained().isEmpty)
        try await queue.retain(all[0])
        var json = try #require(try JSONSerialization.jsonObject(with: JSONEncoder().encode(all[2])) as? [String: Any])
        json["change"] = all[0].change
        let altered = try JSONDecoder().decode(SourceAdmissionRecord.self, from: JSONSerialization.data(withJSONObject: json))
        await #expect(throws: (any Error).self) { try await queue.retain(altered) }
        #expect(try await queue.retained() == [all[0]])
        let path = root.appending(path: "sync/source-admissions.json"), corrupt = Data("[{\"change\":\"broken\"}]".utf8)
        try corrupt.write(to: path)
        #expect(throws: (any Error).self) { try SourceAdmissionQueue(tree: f.tree, stateRoot: root) }
        #expect(try Data(contentsOf: path) == corrupt)
    }

    @Test("A failed disk commit retries the same record and concurrent owners do not lose appends")
    func durability() async throws {
        let f = try fixture(), root = try root(); defer { try? FileManager.default.removeItem(at: root) }
        let queue = try SourceAdmissionQueue(tree: f.tree, stateRoot: root), other = try SourceAdmissionQueue(tree: f.tree, stateRoot: root), all = try records(f)
        let path = root.appending(path: "sync/source-admissions.json")
        try FileManager.default.createDirectory(at: path, withIntermediateDirectories: false)
        await #expect(throws: (any Error).self) { try await queue.retain(all[0]) }
        try FileManager.default.removeItem(at: path)
        async let a: Void = queue.retain(all[0])
        async let c: Void = other.retain(all[2])
        _ = try await (a, c)
        #expect(try await queue.retained().count == 2)
    }
}
