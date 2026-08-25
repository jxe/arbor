import ArborKit
import Foundation
import Testing
@testable import ArborReplica

@Suite("Shared replica semantics")
struct ReplicaFixtureTests {
    @Test("Directory completion matches the shared TypeScript fixture")
    func directoryCompletion() throws {
        let fixture = try JSONDecoder().decode(
            DirectoryFixture.self,
            from: Data(contentsOf: fixtureDirectory().appending(path: "directory-documents.json"))
        )
        for item in fixture.cases {
            let root = ReplicaNodeRecord(path: item.directory, kind: .directory, source: item.source.isEmpty ? nil : item.source)
            let children = item.children.map {
                ReplicaNodeRecord(path: $0.path, pageID: $0.pageID, kind: .markdown, source: $0.pageID.map { "---\nid: \($0)\n---\n" })
            }
            let state = ReplicaState(tree: "tr_fixture", nodes: [root] + children)
            #expect(ReplicaSemantics.completeDirectorySource(node: root, state: state) == item.expectedSource, Comment(rawValue: item.name))
        }
    }

    @Test("Replica object bytes and hashes match ArborWire vectors")
    func wireObjects() throws {
        let fixture = try JSONDecoder().decode(
            WireFixture.self,
            from: Data(contentsOf: fixtureDirectory().appending(path: "wire-objects.json"))
        )
        for vector in fixture.objects {
            let bytes: Data
            switch vector.model.type {
            case "file": bytes = ReplicaWireCodec.file(Data(base64Encoded: vector.model.bytesBase64!)!)
            case "directory":
                bytes = ReplicaWireCodec.directory(vector.model.entries!.map { ($0.name, $0.hash, $0.tree) })
            default: throw ReplicaError.corruptState("Unknown fixture object")
            }
            #expect(bytes.base64EncodedString() == vector.canonicalCborBase64)
            #expect(ReplicaWireCodec.hash(bytes) == vector.hash)
        }
    }
}

@Suite("Offline provider")
struct ReplicaProviderTests {
    @Test("Browsing, exact editing, structure, assets, collections, history, and indexes remain offline")
    func completeProvider() async throws {
        try await withTemporaryReplica { root in
            let tree: TreeID = "tr_offline"
            let replica = try await ArborReplica.open(at: root, tree: tree, clock: { Date(timeIntervalSince1970: 1_800_000_000) })
            let provider = ReplicaWorkspaceProvider(replica: replica)
            let rootRef = WorkspaceReference(tree: tree, path: "/")

            let initialHeads = try await replica.heads()
            let initialRootNode = try await provider.resolve(rootRef)
            guard case let .directoryDocument(initialSource, _, stored) = initialRootNode.surface else {
                Issue.record("Expected the root directory document")
                return
            }
            #expect(initialSource.isEmpty)
            #expect(!stored)
            #expect(try await replica.heads() == initialHeads)

            let rootSession = try await provider.openDocument(rootRef)
            let rootBase = try await rootSession.snapshot()
            let notes = try #require(try await provider.perform(.createDirectory(parent: rootRef, name: "notes")))
            await #expect(throws: WorkspaceDocumentConflict.self) {
                _ = try await rootSession.admit(source: rootBase.source, baseContentRevision: rootBase.contentRevision)
            }
            await rootSession.close()
            let created = try #require(try await provider.perform(.createMarkdown(
                parent: notes.reference,
                name: "today",
                source: "# Today\n\nOffline first.\n"
            )))
            let pageID = try #require(created.reference.pageID)
            guard case let .markdown(createdSource, createdRevision) = created.surface else {
                Issue.record("Expected Markdown")
                return
            }
            #expect(ReplicaSemantics.pageID(in: createdSource) == pageID.rawValue)

            let notesNode = try await provider.resolve(notes.reference)
            guard case let .directoryDocument(notesSource, _, notesStored) = notesNode.surface else {
                Issue.record("Expected a complete directory document")
                return
            }
            #expect(notesSource.hasSuffix("[today](today)\n"))
            #expect(!notesStored)
            let notesSession = try await provider.openDocument(notes.reference)
            let notesSnapshot = try await notesSession.snapshot()
            let admittedNotes = try await notesSession.admit(
                source: notesSnapshot.source,
                baseContentRevision: notesSnapshot.contentRevision
            )
            #expect(admittedNotes.reference.pageID != nil)
            #expect(ReplicaSemantics.pageID(in: admittedNotes.source) == admittedNotes.reference.pageID?.rawValue)
            guard case let .directoryDocument(_, _, admittedStored) = try await provider.resolve(admittedNotes.reference).surface else {
                Issue.record("Expected the stored directory document")
                return
            }
            #expect(admittedStored)
            await notesSession.close()

            let session = try await provider.openDocument(created.reference)
            let editedSource = createdSource + "A durable edit.\n"
            let edited = try await session.admit(source: editedSource, baseContentRevision: createdRevision)
            #expect(edited.source == editedSource)
            await #expect(throws: WorkspaceDocumentConflict.self) {
                _ = try await session.admit(source: editedSource + "stale", baseContentRevision: createdRevision)
            }

            let renamed = try #require(try await provider.perform(.rename(reference: created.reference, name: "renamed")))
            #expect(renamed.reference.pageID == pageID)
            #expect(renamed.reference.pathHint == "/notes/renamed")
            #expect(try await session.snapshot().reference.pathHint == "/notes/renamed")

            let archive = try #require(try await provider.perform(.createDirectory(parent: rootRef, name: "archive")))
            let moved = try #require(try await provider.perform(.move(reference: renamed.reference, destination: archive.reference)))
            #expect(moved.reference.pageID == pageID)
            #expect(moved.reference.pathHint == "/archive/renamed")

            let copied = try #require(try await provider.perform(.copy(reference: moved.reference, destination: notes.reference)))
            #expect(copied.reference.pathHint == "/notes/renamed")
            #expect(copied.reference.pageID != pageID)
            await #expect(throws: ReplicaError.self) {
                _ = try await provider.perform(.rename(reference: copied.reference, name: "renamed"))
            }

            let trashed = try #require(try await provider.perform(.trash(reference: moved.reference)))
            #expect(trashed.reference.pageID == pageID)
            #expect(trashed.reference.pathHint == "/Trash/archive/renamed")
            let restored = try #require(try await provider.perform(.restore(reference: trashed.reference)))
            #expect(restored.reference.pageID == pageID)
            #expect(restored.reference.pathHint == "/archive/renamed")

            let asset = WorkspaceAsset(name: "diagram.bin", mediaType: "application/octet-stream", bytes: Data([0, 1, 2, 3]))
            let storedAsset = try await provider.store(asset: asset, in: archive.reference)
            #expect(storedAsset.reference.pathHint.contains("diagram.bin"))
            #expect(storedAsset.markdownSource == storedAsset.reference.pathHint)
            #expect(try await provider.readFile(storedAsset.reference) == asset.bytes)
            #expect(try await provider.store(asset: asset, in: archive.reference) == storedAsset)
            await #expect(throws: ReplicaError.self) {
                _ = try await provider.store(asset: WorkspaceAsset(name: "../escape", bytes: Data()), in: archive.reference)
            }

            let people = try #require(try await provider.perform(.createDirectory(parent: rootRef, name: "people")))
            _ = try await provider.importFile(
                name: "_store.csv",
                bytes: Data("name,role\nAda,Researcher\nGrace,Engineer\n".utf8),
                mediaType: "text/csv",
                in: people.reference
            )
            let collection = try await provider.resolve(people.reference)
            #expect(collection.surface == .collection(kind: "CSV", rowCount: 2))

            let linker = try #require(try await provider.perform(.createMarkdown(
                parent: rootRef,
                name: "linker",
                source: "# Linker\n\n[Today](/archive/renamed#\(pageID.rawValue))\n"
            )))
            #expect(try await provider.search("durable edit", in: tree).contains { $0.reference.pageID == pageID })
            #expect(try await provider.backlinks(to: restored.reference).contains { $0.reference == linker.reference })

            let history = try await session.history()
            let createdHistory = try #require(history.first { $0.title == "create-markdown" })
            let recovered = try await session.recover(revision: createdHistory.revision)
            #expect(recovered.source.contains("Offline first."))
            #expect(!recovered.source.contains("A durable edit."))

            let beforeRebuild = try await provider.search("Offline first", in: tree)
            try await replica.deleteRebuildableIndexes()
            #expect(try await provider.search("Offline first", in: tree) == beforeRebuild)

            let snapshot = try await replica.currentSnapshot()
            let snapshotHeads = try await replica.heads()
            #expect(snapshot.root == snapshotHeads.materializedRoot)
            for object in snapshot.objects {
                let text = String(decoding: object.bytes, as: UTF8.self)
                #expect(!text.contains("journals/pages"))
                #expect(!text.contains("history/"))
                #expect(!text.contains("indexes/"))
                #expect(!text.contains("heads.json"))
            }
            let privateEntries = try FileManager.default.contentsOfDirectory(atPath: root.path)
            #expect(Set(privateEntries).isSuperset(of: ["control", "history", "indexes", "journals", "materialized", "objects"]))

            try await replica.recordAccepted(root: snapshot.root, update: "up_local")
            #expect(try await replica.heads().pendingRoot == nil)
            _ = try await provider.perform(.createDirectory(parent: rootRef, name: "pending"))
            let pendingHeads = try await replica.heads()
            #expect(pendingHeads.acceptedRoot == snapshot.root)
            #expect(pendingHeads.pendingRoot == pendingHeads.materializedRoot)

            await session.close()
            await #expect(throws: ReplicaError.self) { _ = try await session.snapshot() }
            await replica.close()

            let reopened = try await ArborReplica.open(at: root, tree: tree)
            let reopenedProvider = ReplicaWorkspaceProvider(replica: reopened)
            #expect(try await reopenedProvider.resolve(.init(tree: tree, path: "/stale", pageID: pageID)).reference.pathHint == "/archive/renamed")
            #expect(try await reopenedProvider.search("Offline first", in: tree).contains { $0.reference.pageID == pageID })
        }
    }

    @Test("System replacement is root-checked and cannot overwrite pending local work")
    func systemReplacementBoundary() async throws {
        try await withTemporaryReplica { root in
            let tree: TreeID = "tr_system"
            let replica = try await ArborReplica.open(at: root, tree: tree)
            let initial = try await replica.currentSnapshot()
            try await replica.recordAccepted(root: initial.root, update: "up_initial")

            let source = "---\nid: pg_remote\n---\n\n# Remote\n"
            let replacementState = ReplicaState(
                tree: tree.rawValue,
                nodes: [
                    ReplicaNodeRecord(path: "/", kind: .directory),
                    ReplicaNodeRecord(path: "/remote", pageID: "pg_remote", kind: .markdown, source: source),
                    ReplicaNodeRecord(path: "/nested", kind: .boundary, boundaryTree: "tr_nested")
                ]
            )
            let expected = try ReplicaWireCodec.snapshot(for: replacementState)
            try await replica.replaceFromSystem(ReplicaSystemReplacement(
                root: expected.root,
                update: "up_remote",
                cursor: "up_remote",
                nodes: [
                    ReplicaSystemNode(path: "/", content: .directory()),
                    ReplicaSystemNode(path: "/remote", pageID: "pg_remote", content: .markdown(source: source)),
                    ReplicaSystemNode(path: "/nested", content: .boundary(tree: "tr_nested"))
                ]
            ))
            let replacedHeads = try await replica.heads()
            #expect(replacedHeads.materializedRoot == expected.root)
            #expect(replacedHeads.acceptedRoot == expected.root)
            #expect(replacedHeads.acceptedUpdate == "up_remote")
            #expect(replacedHeads.pendingRoot == nil)

            let provider = ReplicaWorkspaceProvider(replica: replica)
            #expect(try await provider.resolve(.init(tree: tree, path: "/nested")).surface.isReadOnly)
            _ = try await provider.perform(.createDirectory(parent: .init(tree: tree, path: "/"), name: "local"))
            await #expect(throws: ReplicaError.pendingLocalChanges) {
                try await replica.replaceFromSystem(ReplicaSystemReplacement(
                    root: initial.root,
                    update: "up_stale",
                    nodes: [ReplicaSystemNode(path: "/", content: .directory())]
                ))
            }
        }
    }

    @Test("An open document session observes a system replacement")
    func documentSessionObservesSystemReplacement() async throws {
        try await withTemporaryReplica { root in
            let tree: TreeID = "tr_observation"
            let replica = try await ArborReplica.open(at: root, tree: tree)
            let provider = ReplicaWorkspaceProvider(replica: replica)
            let home = WorkspaceReference(tree: tree, path: "/")
            let created = try #require(try await provider.perform(.createMarkdown(
                parent: home,
                name: "note",
                source: "---\nid: pg_note\n---\n\n# Before\n"
            )))
            let accepted = try await replica.currentSnapshot()
            try await replica.recordAccepted(root: accepted.root, update: "up_before")
            let session = try await provider.openDocument(created.reference)
            let before = try await session.snapshot()
            let updates = try await session.updates()
            var iterator = updates.makeAsyncIterator()
            _ = try await iterator.next()

            let afterSource = "---\nid: pg_note\n---\n\n# After\n"
            let replacementState = ReplicaState(
                tree: tree.rawValue,
                nodes: [
                    ReplicaNodeRecord(path: "/", kind: .directory),
                    ReplicaNodeRecord(path: "/note", pageID: "pg_note", kind: .markdown, source: afterSource)
                ]
            )
            let replacement = try ReplicaWireCodec.snapshot(for: replacementState)
            try await replica.replaceFromSystem(ReplicaSystemReplacement(
                root: replacement.root,
                update: "up_after",
                cursor: "up_after",
                nodes: [
                    ReplicaSystemNode(path: "/", content: .directory()),
                    ReplicaSystemNode(path: "/note", pageID: "pg_note", content: .markdown(source: afterSource))
                ]
            ))

            let observed = try #require(try await iterator.next())
            #expect(observed.source == afterSource)
            #expect(observed.contentRevision != before.contentRevision)
            await session.close()
        }
    }

    @Test("Repeated mutations and restarts preserve exact roots and unique identities")
    func restartProperty() async throws {
        try await withTemporaryReplica { root in
            let tree: TreeID = "tr_property"
            var replica = try await ArborReplica.open(at: root, tree: tree)
            var provider = ReplicaWorkspaceProvider(replica: replica)
            let rootRef = WorkspaceReference(tree: tree, path: "/")
            let directory = try #require(try await provider.perform(.createDirectory(parent: rootRef, name: "many")))
            let names = ["z", "ä", "A"] + (0..<32).map { "node-\(String(format: "%02d", $0))" }
            var identities = Set<PageID>()
            for name in names.reversed() {
                let node = try #require(try await provider.perform(.createMarkdown(
                    parent: directory.reference,
                    name: name,
                    source: "# \(name)\n"
                )))
                #expect(identities.insert(try #require(node.reference.pageID)).inserted)
            }
            let before = try await replica.currentSnapshot()
            let beforeHeads = try await replica.heads()
            await replica.close()

            replica = try await ArborReplica.open(at: root, tree: tree)
            provider = ReplicaWorkspaceProvider(replica: replica)
            #expect(try await replica.currentSnapshot() == before)
            #expect(try await replica.heads() == beforeHeads)
            let complete = try await provider.resolve(directory.reference)
            guard case let .directoryDocument(source, _, _) = complete.surface else {
                Issue.record("Expected directory document")
                return
            }
            #expect(source.firstIndex(of: "A")! < source.firstIndex(of: "z")!)
            #expect(source.firstIndex(of: "z")! < source.firstIndex(of: "ä")!)

            let selected = try await provider.resolve(.init(tree: tree, path: "/many/node-00"))
            let session = try await provider.openDocument(selected.reference)
            for generation in 0..<10 {
                let current = try await session.snapshot()
                let next = current.source + "generation \(generation)\n"
                _ = try await session.admit(source: next, baseContentRevision: current.contentRevision)
            }
            let final = try await replica.currentSnapshot()
            await replica.close()
            let reopened = try await ArborReplica.open(at: root, tree: tree)
            #expect(try await reopened.currentSnapshot() == final)
            #expect(try await reopened.heads().generation == beforeHeads.generation + 10)
        }
    }

    @Test("Object-store damage is visible as a provider diagnostic")
    func diagnostics() async throws {
        try await withTemporaryReplica { root in
            let tree: TreeID = "tr_diagnostic"
            let replica = try await ArborReplica.open(at: root, tree: tree)
            let snapshot = try await replica.currentSnapshot()
            let rootObject = root.appending(path: "objects/\(snapshot.root.dropFirst("sha256:".count))")
            try Data("damaged".utf8).write(to: rootObject)
            let provider = ReplicaWorkspaceProvider(replica: replica)
            let children = try await provider.children(of: .init(tree: tree, path: "/"))
            let diagnostic = try #require(children.first { if case .diagnostic = $0.surface { true } else { false } })
            #expect(!diagnostic.isWritable)
            #expect(try await provider.resolve(diagnostic.reference).surface == diagnostic.surface)
        }
    }
}

@Suite("Crash recovery", .serialized)
struct ReplicaCrashTests {
    @Test("Every durable transaction boundary replays idempotently")
    func transactionBoundaries() async throws {
        for point in ReplicaFailurePoint.allCases {
            try await withTemporaryReplica { root in
                let tree = TreeID(rawValue: "tr_crash_\(point.rawValue)")
                let replica = try await ArborReplica.open(at: root, tree: tree, faultInjector: OneShotFault(point))
                let provider = ReplicaWorkspaceProvider(replica: replica)
                await #expect(throws: ReplicaError.self) {
                    _ = try await provider.perform(.createMarkdown(
                        parent: WorkspaceReference(tree: tree, path: "/"),
                        name: "survives",
                        source: "# Survives\n"
                    ))
                }
                let admittedJournals = try journalFiles(root)
                #expect(admittedJournals.count == 1)
                #expect(admittedJournals[0].deletingLastPathComponent().lastPathComponent != "X3RyZWU")

                let recovered = try await ArborReplica.open(at: root, tree: tree)
                let recoveredProvider = ReplicaWorkspaceProvider(replica: recovered)
                let node = try await recoveredProvider.resolve(.init(tree: tree, path: "/survives"))
                #expect(node.reference.pageID != nil, Comment(rawValue: point.rawValue))
                let heads = try await recovered.heads()
                #expect(heads.generation == 1)
                #expect(heads.materializedRoot == heads.pendingRoot)
                #expect(try journalFiles(root).isEmpty)

                await recovered.close()
                let again = try await ArborReplica.open(at: root, tree: tree)
                #expect(try await again.heads() == heads)
            }
        }
    }

    @Test("Move and Trash crashes retain PageID recovery identity")
    func structuralRecovery() async throws {
        try await withTemporaryReplica { root in
            let tree: TreeID = "tr_structural_crash"
            let initial = try await ArborReplica.open(at: root, tree: tree)
            let provider = ReplicaWorkspaceProvider(replica: initial)
            let rootRef = WorkspaceReference(tree: tree, path: "/")
            let note = try #require(try await provider.perform(.createMarkdown(parent: rootRef, name: "note", source: "# Note\n")))
            let pageID = try #require(note.reference.pageID)
            let destination = try #require(try await provider.perform(.createDirectory(parent: rootRef, name: "destination")))
            await initial.close()

            let moving = try await ArborReplica.open(at: root, tree: tree, faultInjector: OneShotFault(.afterMaterialization))
            let movingProvider = ReplicaWorkspaceProvider(replica: moving)
            await #expect(throws: ReplicaError.self) {
                _ = try await movingProvider.perform(.move(reference: note.reference, destination: destination.reference))
            }
            let moved = try await ArborReplica.open(at: root, tree: tree)
            let movedProvider = ReplicaWorkspaceProvider(replica: moved)
            let movedNode = try await movedProvider.resolve(.init(tree: tree, path: "/stale", pageID: pageID))
            #expect(movedNode.reference.pathHint == "/destination/note")
            await moved.close()

            let trashing = try await ArborReplica.open(at: root, tree: tree, faultInjector: OneShotFault(.afterHistory))
            let trashingProvider = ReplicaWorkspaceProvider(replica: trashing)
            await #expect(throws: ReplicaError.self) {
                _ = try await trashingProvider.perform(.trash(reference: movedNode.reference))
            }
            let trashed = try await ArborReplica.open(at: root, tree: tree)
            let trashedProvider = ReplicaWorkspaceProvider(replica: trashed)
            let trashedNode = try await trashedProvider.resolve(.init(tree: tree, path: "/stale", pageID: pageID))
            #expect(trashedNode.reference.pathHint == "/Trash/destination/note")
            let restored = try #require(try await trashedProvider.perform(.restore(reference: trashedNode.reference)))
            #expect(restored.reference.pathHint == "/destination/note")
            #expect(restored.reference.pageID == pageID)
        }
    }
}

private final class OneShotFault: ReplicaFaultInjector, @unchecked Sendable {
    private let lock = NSLock()
    private let target: ReplicaFailurePoint
    private var fired = false

    init(_ target: ReplicaFailurePoint) { self.target = target }

    func reached(_ point: ReplicaFailurePoint) throws {
        lock.lock()
        defer { lock.unlock() }
        if point == target, !fired {
            fired = true
            throw ReplicaError.simulatedCrash(point)
        }
    }
}

private func withTemporaryReplica(_ operation: (URL) async throws -> Void) async throws {
    let root = FileManager.default.temporaryDirectory.appending(path: "arbor-replica-\(UUID().uuidString)", directoryHint: .isDirectory)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    try await operation(root)
}

private func fixtureDirectory() -> URL {
    if let configured = ProcessInfo.processInfo.environment["ARBOR_PROTOCOL_FIXTURES"] { return URL(filePath: configured) }
    var current = URL(filePath: #filePath).deletingLastPathComponent()
    while current.path != "/" {
        let candidate = current.appending(path: "spec/fixtures", directoryHint: .isDirectory)
        if FileManager.default.fileExists(atPath: candidate.path) { return candidate }
        current.deleteLastPathComponent()
    }
    fatalError("Could not locate protocol fixtures")
}

private func journalFiles(_ root: URL) throws -> [URL] {
    let directory = root.appending(path: "journals/pages", directoryHint: .isDirectory)
    let enumerator = FileManager.default.enumerator(at: directory, includingPropertiesForKeys: nil)
    return (enumerator?.allObjects as? [URL] ?? []).filter { $0.pathExtension == "json" }
}

private struct DirectoryFixture: Decodable {
    struct Case: Decodable {
        struct Child: Decodable {
            var name: String
            var path: String
            var pageID: String?
        }
        var name: String
        var directory: String
        var source: String
        var children: [Child]
        var expectedSource: String
    }
    var cases: [Case]
}

private struct WireFixture: Decodable {
    struct Vector: Decodable {
        struct Model: Decodable {
            struct Entry: Decodable {
                var name: String
                var hash: String?
                var tree: String?
            }
            var type: String
            var bytesBase64: String?
            var entries: [Entry]?
        }
        var model: Model
        var canonicalCborBase64: String
        var hash: String
    }
    var objects: [Vector]
}
