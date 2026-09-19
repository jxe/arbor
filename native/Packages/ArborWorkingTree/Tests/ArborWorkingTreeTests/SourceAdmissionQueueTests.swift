import ArborKit
import ArborObjectStore
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
        struct Trace: Decodable {
            struct Edit: Decodable {
                struct Part: Decodable { let source: [Int]; let replacement: [Int] }
                let offset: Int; let length: Int; let replacement: String; let lineage: [Part]?
                var edit: WorkspaceSourceEdit {
                    .init(utf8Range: offset..<(offset + length), replacement: replacement,
                          lineage: lineage?.map { .init(source: $0.source[0]..<$0.source[1], replacement: $0.replacement[0]..<$0.replacement[1]) })
                }
            }
            let name: String; let generations: [[Edit]]; let source: String
            let frames: [WireSemanticValue]?; let compacted: [WireSemanticValue]?
        }
        let tree: String; let sourcePath: String; let source: String; let changes: [Change]
        let requests: [String: WireUpdateRequest]
        let traces: [Trace]
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
        var sources: [String: String] = [:]
        for change in f.changes {
            let parent = records.first { $0.change == change.basis.change }
            let graph = try parent?.candidate ?? graph(f.source)
            let source = parent.flatMap { sources[$0.change] } ?? f.source
            let basis = WorkspaceDocumentSnapshot(reference: .init(tree: TreeID(rawValue: f.tree), path: "/nested/note"), source: source, contentRevision: change.revision)
            let patch = WorkspaceDocumentPatch(baseContentRevision: change.revision,
                edits: [.init(utf8Range: change.offset..<(change.offset + change.length), replacement: change.replacement, expected: change.expected)])
            records.append(try SourceAdmissionRecord(change: change.change, tree: f.tree,
                basis: parent.map { .authored(change: $0.change) } ?? .accepted(.init(root: graph.root, update: change.basis.update!)),
                graph: graph, sourcePath: f.sourcePath,
                intent: .init(basis: basis, patch: patch, source: patch.applying(to: source))))
            sources[change.change] = try patch.applying(to: source)
        }
        return records
    }

    /// The fixture stores frames as plain JSON; the wire element decodes them.
    private func frames(_ raw: [WireSemanticValue]?) throws -> [WireTraceFrame]? {
        guard let raw, case let .object(last)? = raw.last, case let .string(after)? = last["after"] else { return nil }
        let element: WireSemanticValue = .object(["change": .string("trace"), "candidate": .string(after), "trace": .array(raw),
                                                  "resolves": .array([]), "objects": .array([]), "deltas": .array([])])
        return try JSONDecoder().decode(WireCandidateUpdate.self, from: JSONEncoder().encode(element)).trace
    }

    @Test("Shared trace vectors: one frame per generation, and compaction agrees with the TypeScript queue and Canopy")
    func sharedTraces() async throws {
        let f = try fixture()
        #expect(!f.traces.isEmpty)
        for value in f.traces {
            let graph = try graph(f.source)
            var source = f.source
            let chain = try value.generations.map { edits -> WorkspaceDocumentGeneration in
                let patch = WorkspaceDocumentPatch(baseContentRevision: "r1", edits: edits.map(\.edit))
                source = try patch.applying(to: source)
                return .init(patch: patch, source: source)
            }
            #expect(source == value.source, Comment(rawValue: value.name))
            let basis = WorkspaceDocumentSnapshot(reference: .init(tree: TreeID(rawValue: f.tree), path: "/nested/note"), source: f.source, contentRevision: "r1")
            let intent = try WorkspaceDocumentIntent(basis: basis,
                patch: .init(baseContentRevision: "r1", edits: [.init(utf8Range: 0..<f.source.utf8.count, replacement: source)]),
                source: source, generations: chain)
            let accepted: SourceAdmissionBasis = .accepted(.init(root: graph.root, update: "up_r1"))
            let plain = try SourceAdmissionRecord(change: "trace", tree: f.tree, basis: accepted, graph: graph, sourcePath: f.sourcePath, intent: intent, compact: false)
            let compact = try SourceAdmissionRecord(change: "trace", tree: f.tree, basis: accepted, graph: graph, sourcePath: f.sourcePath, intent: intent)
            let expectedFrames = try frames(value.frames), expectedCompacted = try frames(value.compacted)
            #expect(plain.update.trace == expectedFrames, Comment(rawValue: value.name))
            #expect(compact.update.trace == expectedCompacted, Comment(rawValue: value.name))
            #expect(SourceAdmissionRecord.compactTrace(expectedFrames ?? []) == (expectedCompacted ?? []), Comment(rawValue: value.name))
            // Both forms name the same candidate, carry only its objects and the same delta.
            #expect(compact.candidate == plain.candidate)
            #expect(compact.update.objects == plain.update.objects && compact.update.deltas == plain.update.deltas)
            #expect(plain.update.trace?.count == value.generations.filter { !$0.isEmpty }.count)
            try plain.validate(); try compact.validate()
            let root = try root(); defer { try? FileManager.default.removeItem(at: root) }
            try await SourceAdmissionQueue(tree: f.tree, stateRoot: root).retain(compact)
            #expect(try await SourceAdmissionQueue(tree: f.tree, stateRoot: root).retained() == [compact])
            #expect(try JSONDecoder().decode(SourceAdmissionRecord.self, from: JSONEncoder().encode(plain)) == plain)
        }
    }

    @Test("A generation list validates as a chain, drops generations that changed nothing, and keys frames uniquely")
    func generationChain() throws {
        let f = try fixture(), graph = try graph(f.source)
        let basis = WorkspaceDocumentSnapshot(reference: .init(tree: TreeID(rawValue: f.tree), path: "/nested/note"), source: f.source, contentRevision: "r1")
        let whole = WorkspaceDocumentPatch(baseContentRevision: "r1", edits: [.init(utf8Range: 0..<6, replacement: "After")])
        let first = try whole.applying(to: f.source)
        let empty = WorkspaceDocumentGeneration(patch: .init(baseContentRevision: "r1", edits: []), source: f.source)
        let intent = try WorkspaceDocumentIntent(basis: basis, patch: whole, source: first, generations: [empty, .init(patch: whole, source: first)])
        let record = try SourceAdmissionRecord(change: "chain", tree: f.tree, basis: .accepted(.init(root: graph.root, update: "up_r1")), graph: graph, sourcePath: f.sourcePath, intent: intent)
        #expect(record.update.trace?.count == 1)
        #expect(record.update.trace?.first?.operations.map(\.key) == ["edit-0-0"])
        #expect(throws: (any Error).self) { try WorkspaceDocumentIntent(basis: basis, patch: whole, source: first, generations: [empty]) }
        let onlyEmpty = try WorkspaceDocumentIntent(basis: basis, patch: .init(baseContentRevision: "r1", edits: []), source: f.source, generations: [empty])
        #expect(throws: (any Error).self) {
            try SourceAdmissionRecord(change: "none", tree: f.tree, basis: .accepted(.init(root: graph.root, update: "up_r1")), graph: graph, sourcePath: f.sourcePath, intent: onlyEmpty)
        }
    }

    @Test("Undo is a plain edit; settled records drop without a release step")
    func plainUndo() async throws {
        let f = try fixture(), root = try root(); defer { try? FileManager.default.removeItem(at: root) }
        let tree = TreeID(rawValue: f.tree), reference = WorkspaceReference(tree: tree, path: "/nested/note")
        // A document long enough that a delta is smaller than resending the file.
        let source = f.source + String(repeating: "filler line\n", count: 400)
        let graph = try graph(source)
        let edit = WorkspaceDocumentPatch(baseContentRevision: "r1", edits: [.init(utf8Range: 0..<6, replacement: "After", expected: "Before")])
        let edited = try edit.applying(to: source)
        let first = try SourceAdmissionRecord(change: "edit", tree: f.tree, basis: .accepted(.init(root: graph.root, update: "up_r1")), graph: graph,
            sourcePath: f.sourcePath, intent: .init(basis: .init(reference: reference, source: source, contentRevision: "r1"), patch: edit, source: edited))
        // The editor's undo produces an ordinary patch against the latest candidate.
        let undoPatch = WorkspaceDocumentPatch(baseContentRevision: "c1", edits: [.init(utf8Range: 0..<5, replacement: "Before", expected: "After")])
        let undo = try SourceAdmissionRecord(change: "undo", tree: f.tree, basis: .authored(change: first.change), graph: first.candidate,
            sourcePath: f.sourcePath, intent: .init(basis: .init(reference: reference, source: edited, contentRevision: "c1"), patch: undoPatch, source: source))
        #expect(undo.update.trace?.allSatisfy { $0.operations.allSatisfy { $0.kind == "editSource" } } == true)
        #expect(undo.candidate.root == graph.root)
        // Records carry no document bytes: only hashes, the wire element, and a capture digest.
        let encoded = String(decoding: try JSONEncoder().encode(undo), as: UTF8.self)
        #expect(!encoded.contains("filler line"))
        #expect(undo.document?.intentDigest.hasPrefix("sha256:") == true)
        // An accepted-basis source edit ships the file, and any changed
        // directory a splice would shrink, as deltas against retained bases.
        #expect(!first.update.deltas.isEmpty)
        #expect(!first.update.objects.contains { object in first.update.deltas.contains { $0.result == object.hash } })
        for delta in first.update.deltas {
            let baseObject = try #require(graph.objects.first { $0.hash == delta.base })
            let resultObject = try #require(first.candidate.objects.first { $0.hash == delta.result })
            #expect(try delta.apply(to: baseObject.bytes) == resultObject.bytes)
        }
        #expect(first.update.deltas.contains { $0.result == (try? WireObjectCodec.hash(WireObjectCodec.encode(.file(Data(edited.utf8))))) })
        #expect(undo.update.deltas.isEmpty)
        let queue = try await SourceAdmissionQueue(tree: f.tree, stateRoot: root)
        try await queue.retain([first, undo])
        let reopened = try await SourceAdmissionQueue(tree: f.tree, stateRoot: root)
        #expect(try await reopened.retained() == [first, undo])
        // Settled records go as soon as nothing pending depends on them. While
        // the tail is preserved for an open editor, the newest record and its
        // authored ancestry stay; releasing the tail empties the journal.
        _ = try await reopened.compact(settled: [first.change])
        #expect(try await reopened.retained().map(\.change) == [first.change, undo.change])
        _ = try await reopened.compact(settled: [first.change, undo.change])
        #expect(try await reopened.retained().map(\.change) == [first.change, undo.change])
        #expect(try await reopened.compact(settled: [first.change, undo.change], preservingSettledTail: false))
        #expect(try await reopened.retained().isEmpty)
    }

    @Test("Page creation records reproduce their original graph without an undo transaction")
    func pageCreation() async throws {
        struct Fixture: Decodable {
            let tree: String; let document: String; let source: String; let createdSource: String; let createdPath: String
        }
        let directory = ProcessInfo.processInfo.environment["ARBOR_PROTOCOL_FIXTURES"].map { URL(fileURLWithPath: $0) }
            ?? URL(fileURLWithPath: #filePath).deletingLastPathComponent().appending(path: "../../../../../conformance")
        let f = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: directory.appending(path: "page-conversion-undo.json")))
        let graph = try graph(f.source), file = Data(f.createdSource.utf8)
        let rootObject = try #require(graph.objects.first { $0.hash == graph.root })
        guard case let .directory(entries, _) = try WireObjectCodec.decode(rootObject.bytes, kind: .directory) else { return }
        let bytes = try WireObjectCodec.encode(.directory([.init(name: String(f.createdPath.dropFirst()), file: WireObjectCodec.hash(file))] + entries))
        let candidate = WireSnapshot(root: WireObjectCodec.hash(bytes), objects: graph.objects.filter { $0.hash != graph.root } + [file, bytes].map { .init(hash: WireObjectCodec.hash($0), bytes: $0) })
        let created = try SourceAdmissionRecord(change: "creation", tree: f.tree, basis: .accepted(.init(root: graph.root, update: "r1")), graph: graph, candidate: candidate,
            creation: .init(document: .init(tree: TreeID(rawValue: f.tree), path: f.document), removals: [f.createdPath]))
        #expect(throws: (any Error).self) {
            try SourceAdmissionRecord(change: "wrong", tree: f.tree, basis: .accepted(.init(root: graph.root, update: "r1")), graph: graph, candidate: candidate,
                creation: .init(document: .init(tree: TreeID(rawValue: f.tree), path: f.document), removals: ["/elsewhere"]))
        }
        let root = try root(); defer { try? FileManager.default.removeItem(at: root) }
        let queue = try await SourceAdmissionQueue(tree: f.tree, stateRoot: root)
        try await queue.retain([created])
        let reopened = try await SourceAdmissionQueue(tree: f.tree, stateRoot: root)
        #expect(try await reopened.retained() == [created])
    }

    @Test("Shared cross-document copy fixture binds exact foreign source bytes")
    func sharedCrossDocumentCopy() throws {
        struct Fixture: Decodable {
            struct Edit: Decodable { let offset: Int; let length: Int; let replacement: String; let copies: [Copy] }
            struct Copy: Decodable { let source: [Int]; let replacement: [Int]; let document: WorkspaceCopyDocument }
            let tree: String; let original: String; let destination: String; let sourcePath: String; let destinationPath: String; let edit: Edit
        }
        let directory = ProcessInfo.processInfo.environment["ARBOR_PROTOCOL_FIXTURES"].map { URL(fileURLWithPath: $0) }
            ?? URL(fileURLWithPath: #filePath).deletingLastPathComponent().appending(path: "../../../../../conformance")
        let f = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: directory.appending(path: "cross-document-copy.json")))
        let origin = Data(f.original.utf8), destination = Data(f.destination.utf8)
        let root = try WireObjectCodec.encode(.directory([.init(name: "destination.md", file: WireObjectCodec.hash(destination)), .init(name: "source.md", file: WireObjectCodec.hash(origin))]))
        let graph = WireSnapshot(root: WireObjectCodec.hash(root), objects: [root, origin, destination].map { .init(hash: WireObjectCodec.hash($0), bytes: $0) })
        let basis = WorkspaceDocumentSnapshot(reference: .init(tree: TreeID(rawValue: f.tree), path: "/destination"), source: f.destination, contentRevision: "r1")
        let patch = WorkspaceDocumentPatch(baseContentRevision: "r1", edits: [.init(utf8Range: f.edit.offset..<(f.edit.offset + f.edit.length), replacement: f.edit.replacement,
            copies: f.edit.copies.map { .init(source: $0.source[0]..<$0.source[1], replacement: $0.replacement[0]..<$0.replacement[1], document: $0.document) })])
        let record = try SourceAdmissionRecord(tree: f.tree, basis: .accepted(.init(root: graph.root, update: "r1")), graph: graph, sourcePath: f.destinationPath,
            intent: .init(basis: basis, patch: patch, source: f.destination + f.edit.replacement))
        let copied = record.update.trace?.first?.operations.first
        #expect(copied?.kind == "copySource")
        guard case let .object(source)? = copied?.fields["source"], case let .object(material)? = source["material"] else { Issue.record("Missing material"); return }
        #expect(material["path"] == .string(f.sourcePath))
        var wrong = patch; wrong.edits[0].copies?[0].document?.path = "/missing.md"
        #expect(throws: (any Error).self) {
            try SourceAdmissionRecord(tree: f.tree, basis: .accepted(.init(root: graph.root, update: "r1")), graph: graph, sourcePath: f.destinationPath,
                intent: .init(basis: basis, patch: wrong, source: f.destination + f.edit.replacement))
        }
    }

    @Test("Shared requests retain same-root dependencies and restart with original operation identities")
    func sharedRequests() async throws {
        let f = try fixture(), root = try root(); defer { try? FileManager.default.removeItem(at: root) }
        let queue = try await SourceAdmissionQueue(tree: f.tree, stateRoot: root), all = try records(f)
        for record in all { try await queue.retain(record) }
        let reopened = try await SourceAdmissionQueue(tree: f.tree, stateRoot: root)
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
        let full = try await reopened.request(through: "change-b")
        let compact = try await reopened.request(through: "change-b", accepted: ["change-a"])
        #expect(compact.base == full.base)
        #expect(compact.request.updates[0].objects.isEmpty)
        #expect(compact.request.updates[0].deltas.isEmpty)
        #expect(compact.request.updates[1] == full.request.updates[1])
        #expect(updateRequestDigests(tree: f.tree, base: full.base, updates: full.request.updates)
            == updateRequestDigests(tree: f.tree, base: compact.base, updates: compact.request.updates))
        #expect(try await reopened.retained() == all)
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
        let queue = try await SourceAdmissionQueue(tree: f.tree, stateRoot: root)
        try await queue.retain(record)
        #expect(try await tree.heads().acceptedRoot == peer.root)
        #expect(try await tree.heads().pendingRoot == nil)
        await tree.close()
        let reopened = try await SourceAdmissionQueue(tree: f.tree, stateRoot: root)
        #expect(try await reopened.request(through: record.change).base.update == "up_r1")
        #expect(record.graph.root == captured.graph.root)
        #expect(record.graph.root != peer.root)
        #expect(try await reopened.retained().first?.document?.reference.path == captured.document.reference.path)
    }

    @Test("Missing parents, altered candidates, and reused identities leave all retained work intact")
    func invalidRecords() async throws {
        let f = try fixture(), root = try root(); defer { try? FileManager.default.removeItem(at: root) }
        let queue = try await SourceAdmissionQueue(tree: f.tree, stateRoot: root), all = try records(f)
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
        await #expect(throws: (any Error).self) { try await SourceAdmissionQueue(tree: f.tree, stateRoot: root) }
        #expect(try Data(contentsOf: path) == corrupt)
    }

    @Test("A failed disk commit retries the same record and concurrent owners do not lose appends")
    func durability() async throws {
        let f = try fixture(), root = try root(); defer { try? FileManager.default.removeItem(at: root) }
        let queue = try await SourceAdmissionQueue(tree: f.tree, stateRoot: root), other = try await SourceAdmissionQueue(tree: f.tree, stateRoot: root), all = try records(f)
        let path = root.appending(path: "sync/source-admissions.json")
        try FileManager.default.createDirectory(at: path, withIntermediateDirectories: false)
        await #expect(throws: (any Error).self) { try await queue.retain(all[0]) }
        try FileManager.default.removeItem(at: path)
        async let a: Void = queue.retain(all[0])
        async let c: Void = other.retain(all[2])
        _ = try await (a, c)
        #expect(try await queue.retained().count == 2)
    }

    @Test("Journal stores object hashes once and compacts only dependency-free accepted records")
    func objectStorageAndCompaction() async throws {
        let f = try fixture(), root = try root(); defer { try? FileManager.default.removeItem(at: root) }
        let asset = Data(repeating: 0x5a, count: 1_000_000), assetHash = WireObjectCodec.hash(asset)
        let source = Data(f.source.utf8), sourceHash = WireObjectCodec.hash(source)
        let nested = try WireObjectCodec.encode(.directory([.init(name: "note.md", file: sourceHash)])), nestedHash = WireObjectCodec.hash(nested)
        let rootBytes = try WireObjectCodec.encode(.directory([
            .init(name: "asset.bin", file: assetHash), .init(name: "nested", directory: nestedHash),
        ]))
        let initialGraph = WireSnapshot(root: WireObjectCodec.hash(rootBytes), objects: [asset, source, nested, rootBytes].map {
            .init(hash: WireObjectCodec.hash($0), bytes: $0)
        })
        var graph = initialGraph
        var all: [SourceAdmissionRecord] = []
        var sources: [String: String] = [:]
        for change in f.changes {
            let prior = all.first { $0.change == change.basis.change }
            graph = prior?.candidate ?? initialGraph
            let basisSource = prior.flatMap { sources[$0.change] } ?? f.source
            let basis = WorkspaceDocumentSnapshot(reference: .init(tree: TreeID(rawValue: f.tree), path: "/nested/note"),
                source: basisSource, contentRevision: change.revision)
            let patch = WorkspaceDocumentPatch(baseContentRevision: change.revision,
                edits: [.init(utf8Range: change.offset..<(change.offset + change.length), replacement: change.replacement, expected: change.expected)])
            all.append(try SourceAdmissionRecord(change: change.change, tree: f.tree,
                basis: prior.map { .authored(change: $0.change) } ?? .accepted(.init(root: graph.root, update: change.basis.update!)),
                graph: graph, sourcePath: f.sourcePath, intent: .init(basis: basis, patch: patch, source: patch.applying(to: basisSource))))
            sources[change.change] = try patch.applying(to: basisSource)
        }
        let platform = try DirectoryObjectStore(
            directory: root.appending(path: "platform-objects"),
            retentionPolicy: .retainAll
        )
        try platform.store(Dictionary(uniqueKeysWithValues: initialGraph.objects.map { ($0.hash, $0.bytes) }))
        let queue = try await SourceAdmissionQueue(tree: f.tree, stateRoot: root, platform: platform)
        for record in all { try await queue.retain(record) }
        let journal = root.appending(path: "sync/source-admissions.json")
        let journalBytes = try Data(contentsOf: journal)
        #expect(journalBytes.count < 100_000)
        #expect(!String(decoding: journalBytes, as: UTF8.self).contains("\"bytes\""))
        let objectDirectory = root.appending(path: "sync/source-admission-objects")
        #expect(!FileManager.default.fileExists(atPath: objectDirectory.appending(path: String(assetHash.dropFirst(7))).path))
        #expect(try await SourceAdmissionQueue(tree: f.tree, stateRoot: root, platform: platform).retained() == all)

        // The replica store keeps accepted hashes even when the live head no
        // longer reaches them; source journals may still reference that basis.
        try platform.retain(reachableFrom: [], files: [])
        #expect(try await platform.bytes(assetHash) == asset)

        _ = try await queue.compact(settled: [all[0].change, all[1].change])
        #expect(try await queue.retained().map(\.change) == [all[2].change])
        #expect(try await queue.compact(settled: [all[2].change], preservingSettledTail: false))
        #expect(try await queue.retained().isEmpty)
        #expect(try FileManager.default.contentsOfDirectory(atPath: objectDirectory.path).isEmpty)
    }

    @Test("A fully settled embedded-object journal is scanned without decoding its snapshots")
    func settledLegacyMigration() async throws {
        let f = try fixture(), root = try root(); defer { try? FileManager.default.removeItem(at: root) }
        let all = try records(f), path = root.appending(path: "sync/source-admissions.json")
        try FileManager.default.createDirectory(at: path.deletingLastPathComponent(), withIntermediateDirectories: true)
        let encoded = String(decoding: try JSONEncoder().encode(all), as: UTF8.self)
            .replacingOccurrences(of: "\"tree\":\"(f.tree)\"", with: "\"tree\":42")
        try Data(encoded.utf8).write(to: path)
        let legacySize = try Data(contentsOf: path).count
        let queue = try await SourceAdmissionQueue(tree: f.tree, stateRoot: root, settled: Set(all.map(\.change)))
        #expect(try await queue.retained().isEmpty)
        #expect((try Data(contentsOf: path)).count < legacySize)
        let raw = try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: path)) as? [String: Any])
        #expect(raw["schema"] as? Int == 4)
    }

    @Test("Pending legacy migration remains self-contained when its old platform basis is gone")
    func pendingLegacyMigration() async throws {
        let f = try fixture(), root = try root(); defer { try? FileManager.default.removeItem(at: root) }
        let all = try records(f), path = root.appending(path: "sync/source-admissions.json")
        try FileManager.default.createDirectory(at: path.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder().encode(all).write(to: path)
        let migrated = try await SourceAdmissionQueue(tree: f.tree, stateRoot: root, platform: EmptyObjectStore())
        #expect(try await migrated.retained() == all)
        let reopened = try await SourceAdmissionQueue(tree: f.tree, stateRoot: root, platform: EmptyObjectStore())
        #expect(try await reopened.retained() == all)
    }
}

extension SourceAdmissionQueueTests {
    @Test("Explicit entry transfers survive queue recovery with their authored operation")
    func entryTransfers() async throws {
        let graph = try graph("Source\r\n")
        for kind in [EntryTransfer.Kind.moveEntry, .copyEntry] {
            let root = try root(); defer { try? FileManager.default.removeItem(at:root) }
            let transfer = EntryTransfer(kind:kind,source:"/nested/note.md",parent:"/",name:"moved.md")
            let prepared = try transfer.prepare(graph:graph)
            let record = try SourceAdmissionRecord(tree:"tr_entry",basis:.accepted(.init(root:graph.root,update:"basis")),graph:graph,candidate:prepared.candidate,entryTransfer:transfer)
            let queue = try await SourceAdmissionQueue(tree:"tr_entry",stateRoot:root)
            try await queue.retain(record)
            let reopened = try await SourceAdmissionQueue(tree:"tr_entry",stateRoot:root)
            #expect(try await reopened.retained() == [record])
            #expect(record.update.trace?.first?.operations.first?.kind == kind.rawValue)
            #expect(throws:(any Error).self) { try EntryTransfer(kind:kind,source:"/nested",parent:"/nested",name:"loop").prepare(graph:graph) }
        }
    }
}
