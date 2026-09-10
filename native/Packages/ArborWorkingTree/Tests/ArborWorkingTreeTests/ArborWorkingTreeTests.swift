import ArborKit
import ArborObjectStore
import ArborWire
import Foundation
import Testing
@testable import ArborWorkingTree

/// The two state-store seams a working tree runs on.
enum StoreKind: String, CaseIterable, Sendable {
    case durable
    case inMemory
}

func openWorkingTree(
    _ kind: StoreKind,
    at root: URL,
    tree: TreeID,
    platform: any ObjectStore = EmptyObjectStore(),
    clock: @escaping WorkingTree.Clock = Date.init
) async throws -> WorkingTree {
    switch kind {
    case .durable: try await WorkingTree.open(at: root, tree: tree, platform: platform, clock: clock)
    case .inMemory: try await WorkingTree.inMemory(tree: tree, platform: platform, clock: clock)
    }
}

@Suite("Shared replica semantics")
struct WorkingTreeFixtureTests {
    @Test("Directory projection never materializes generated child links")
    func directorySourceIsExact() throws {
        let fixture = try JSONDecoder().decode(
            DirectoryFixture.self,
            from: Data(contentsOf: fixtureDirectory().appending(path: "directory-documents.json"))
        )
        for item in fixture.cases {
            let root = WorkingTreeNode(path: item.directory, kind: .directory, source: item.source.isEmpty ? nil : item.source)
            #expect((root.source ?? "") == item.source, Comment(rawValue: item.name))
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
            case "file": bytes = WorkingTreeWireCodec.file(Data(base64Encoded: vector.model.bytesBase64!)!)
            case "directory":
                bytes = WorkingTreeWireCodec.directory(
                    vector.model.entries!.map { ($0.name, $0.hash, $0.tree) },
                    childrenSource: vector.model.childrenSource
                )
            default: throw WorkingTreeError.corruptState("Unknown fixture object")
            }
            #expect(bytes.base64EncodedString() == vector.canonicalCborBase64)
            #expect(WorkingTreeWireCodec.hash(bytes) == vector.hash)
        }
    }
}

@Suite("Offline provider")
struct WorkingTreeProviderTests {
    @Test("Browsing, exact editing, structure, assets, collections, and indexes remain offline", arguments: StoreKind.allCases)
    func completeProvider(kind: StoreKind) async throws {
        try await withTemporaryReplica { root in
            let tree: TreeID = "tr_offline"
            let workingTree = try await openWorkingTree(kind, at: root, tree: tree, clock: { Date(timeIntervalSince1970: 1_800_000_000) })
            let provider = WorkingTreeProvider(workingTree: workingTree)
            let rootRef = WorkspaceReference(tree: tree, path: "/")

            let initialHeads = try await workingTree.heads()
            let initialRootNode = try await provider.resolve(rootRef)
            guard case let .directoryDocument(initialSource, _, stored) = initialRootNode.surface else {
                Issue.record("Expected the root directory document")
                return
            }
            #expect(initialSource.isEmpty)
            #expect(!stored)
            #expect(try await workingTree.heads() == initialHeads)

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
            let pageID = try #require(created.reference.stableKey)
            guard case let .markdown(createdSource, createdRevision) = created.surface else {
                Issue.record("Expected Markdown")
                return
            }
            #expect(WorkingTreeSemantics.pageID(in: createdSource) == markdownID(fromStableKey: pageID))

            let notesNode = try await provider.resolve(notes.reference)
            guard case let .directoryDocument(notesSource, _, notesStored) = notesNode.surface else {
                Issue.record("Expected a complete directory document")
                return
            }
            #expect(notesSource.isEmpty)
            #expect(!notesStored)
            let notesSession = try await provider.openDocument(notes.reference)
            let notesSnapshot = try await notesSession.snapshot()
            let admittedNotes = try await notesSession.admit(
                source: notesSnapshot.source,
                baseContentRevision: notesSnapshot.contentRevision
            )
            #expect(admittedNotes.reference.stableKey != nil)
            #expect(WorkingTreeSemantics.pageID(in: admittedNotes.source) == markdownID(fromStableKey: admittedNotes.reference.stableKey))
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
            #expect(renamed.reference.stableKey == pageID)
            #expect(renamed.reference.path == "/notes/renamed")
            #expect(try await session.snapshot().reference.path == "/notes/renamed")

            let archive = try #require(try await provider.perform(.createDirectory(parent: rootRef, name: "archive")))
            let moved = try #require(try await provider.perform(.move(reference: renamed.reference, destination: archive.reference)))
            #expect(moved.reference.stableKey == pageID)
            #expect(moved.reference.path == "/archive/renamed")

            let copied = try #require(try await provider.perform(.copy(reference: moved.reference, destination: notes.reference)))
            #expect(copied.reference.path == "/notes/renamed")
            #expect(copied.reference.stableKey != pageID)
            await #expect(throws: WorkingTreeError.self) {
                _ = try await provider.perform(.rename(reference: copied.reference, name: "renamed"))
            }

            let trashed = try #require(try await provider.perform(.trash(reference: moved.reference)))
            #expect(trashed.reference.stableKey == pageID)
            #expect(trashed.reference.path == "/Trash/archive/renamed")
            let restored = try #require(try await provider.perform(.restore(reference: trashed.reference)))
            #expect(restored.reference.stableKey == pageID)
            #expect(restored.reference.path == "/archive/renamed")

            let asset = WorkspaceAsset(name: "diagram.bin", mediaType: "application/octet-stream", bytes: Data([0, 1, 2, 3]))
            let storedAsset = try await provider.store(asset: asset, in: archive.reference)
            #expect(storedAsset.reference.path.contains("diagram.bin"))
            #expect(storedAsset.markdownSource == storedAsset.reference.path)
            #expect(try await provider.readFile(storedAsset.reference) == asset.bytes)
            #expect(try await provider.store(asset: asset, in: archive.reference) == storedAsset)
            await #expect(throws: WorkingTreeError.self) {
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

            let restoredLink = try #require(buildCanonicalLink(
                from: "/",
                toPath: "/archive/renamed",
                stableKey: restored.reference.stableKey
            ))
            let linker = try #require(try await provider.perform(.createMarkdown(
                parent: rootRef,
                name: "linker",
                source: "# Linker\n\n[Today](\(restoredLink))\n"
            )))
            let linkedSearch = try await provider.search("durable edit", in: tree)
            #expect(linkedSearch.first { $0.reference.stableKey == pageID }?.backlinkCount == 1)
            #expect(linkedSearch.first { $0.reference.stableKey == pageID }?.modifiedAt
                == Date(timeIntervalSince1970: 1_800_000_000))
            #expect(try await provider.search("", in: tree).contains {
                $0.reference.stableKey == pageID
            })
            #expect(try await provider.backlinks(to: restored.reference).contains { $0.reference == linker.reference })

            await #expect(throws: WorkspaceProviderError.invalidAction("Canopy history is not available yet")) {
                _ = try await session.history()
            }
            await #expect(throws: WorkspaceProviderError.invalidAction("Canopy history is not available yet")) {
                _ = try await session.recover(revision: "local-0")
            }

            let beforeRebuild = try await provider.search("Offline first", in: tree)
            try await workingTree.deleteRebuildableIndexes()
            #expect(try await provider.search("Offline first", in: tree) == beforeRebuild)

            let snapshot = try await workingTree.currentSnapshot()
            let snapshotHeads = try await workingTree.heads()
            #expect(snapshot.root == snapshotHeads.materializedRoot)
            for object in snapshot.objects {
                let text = String(decoding: object.bytes ?? Data(), as: UTF8.self)
                #expect(!text.contains("journals/pages"))
                #expect(!text.contains("history/"))
                #expect(!text.contains("indexes/"))
                #expect(!text.contains("heads.json"))
            }
            if kind == .durable {
                let privateEntries = try FileManager.default.contentsOfDirectory(atPath: root.path)
                #expect(Set(privateEntries).isSuperset(of: ["control", "indexes", "journals", "materialized", "objects"]))
                #expect(!privateEntries.contains("history"))
                // The node index carries no file bytes once a transaction has stored them.
                let stateText = String(decoding: try Data(contentsOf: root.appending(path: "materialized/tree.json")), as: UTF8.self)
                #expect(!stateText.contains("\"inline\""))
            }
            // Every file is held by hash and still readable through the overlay.
            let storedNode = try await workingTree.resolve(storedAsset.reference)
            #expect(storedNode.ref?.isInline == false)
            #expect(try await workingTree.fileBytes(storedAsset.reference) == asset.bytes)
            #expect(try await workingTree.diagnostics().isEmpty)

            try await workingTree.recordAccepted(root: snapshot.root, update: "up_local")
            #expect(try await workingTree.heads().pendingRoot == nil)
            _ = try await provider.perform(.createDirectory(parent: rootRef, name: "pending"))
            let pendingHeads = try await workingTree.heads()
            #expect(pendingHeads.acceptedRoot == snapshot.root)
            #expect(pendingHeads.pendingRoot == pendingHeads.materializedRoot)

            await session.close()
            await #expect(throws: WorkingTreeError.self) { _ = try await session.snapshot() }
            await workingTree.close()

            guard kind == .durable else { return }
            let reopened = try await WorkingTree.open(at: root, tree: tree)
            let reopenedProvider = WorkingTreeProvider(workingTree: reopened)
            #expect(try await reopenedProvider.resolve(.init(tree: tree, path: "/stale", stableKey: pageID)).reference.path == "/archive/renamed")
            #expect(try await reopenedProvider.search("Offline first", in: tree).contains { $0.reference.stableKey == pageID })
            #expect(try await reopenedProvider.readFile(storedAsset.reference) == asset.bytes)
        }
    }

    @Test("System replacement is root-checked and cannot overwrite pending local work", arguments: StoreKind.allCases)
    func systemReplacementBoundary(kind: StoreKind) async throws {
        try await withTemporaryReplica { root in
            let tree: TreeID = "tr_system"
            let workingTree = try await openWorkingTree(kind, at: root, tree: tree)
            let initial = try await workingTree.currentSnapshot()
            try await workingTree.recordAccepted(root: initial.root, update: "up_initial")

            let source = "---\nid: pg_remote\n---\n\n# Remote\n"
            let replacementState = WorkingTreeState(
                tree: tree.rawValue,
                nodes: [
                    WorkingTreeNode(path: "/", kind: .directory),
                    WorkingTreeNode(path: "/remote", pageID: "pg_remote", kind: .markdown, source: source),
                    WorkingTreeNode(path: "/nested", kind: .boundary, boundaryTree: "tr_nested")
                ]
            )
            let expected = try WorkingTreeWireCodec.snapshot(for: replacementState)
            try await workingTree.replaceFromSystem(WorkingTreeSystemReplacement(
                root: expected.root,
                update: "up_remote",
                cursor: "up_remote",
                nodes: [
                    WorkingTreeSystemNode(path: "/", content: .directory()),
                    WorkingTreeSystemNode(path: "/remote", pageID: "pg_remote", content: .markdown(source: source)),
                    WorkingTreeSystemNode(path: "/nested", content: .boundary(tree: "tr_nested"))
                ]
            ))
            let replacedHeads = try await workingTree.heads()
            #expect(replacedHeads.materializedRoot == expected.root)
            #expect(replacedHeads.acceptedRoot == expected.root)
            #expect(replacedHeads.acceptedUpdate == "up_remote")
            #expect(replacedHeads.pendingRoot == nil)

            let provider = WorkingTreeProvider(workingTree: workingTree)
            #expect(try await provider.resolve(.init(tree: tree, path: "/nested")).surface.isReadOnly)
            _ = try await provider.perform(.createDirectory(parent: .init(tree: tree, path: "/"), name: "local"))
            await #expect(throws: WorkingTreeError.pendingLocalChanges) {
                try await workingTree.replaceFromSystem(WorkingTreeSystemReplacement(
                    root: initial.root,
                    update: "up_stale",
                    nodes: [WorkingTreeSystemNode(path: "/", content: .directory())]
                ))
            }
        }
    }

    @Test("A fresh tree can be seeded ahead of its accepted base and keeps that seed pending", arguments: StoreKind.allCases)
    func pendingSeedFromSystem(kind: StoreKind) async throws {
        try await withTemporaryReplica { root in
            let tree: TreeID = "tr_pending_seed"
            let workingTree = try await openWorkingTree(kind, at: root, tree: tree)
            let source = "---\nid: pg_folder\n---\n\n# Folder\n"
            let seeded = WorkingTreeState(
                tree: tree.rawValue,
                nodes: [
                    WorkingTreeNode(path: "/", kind: .directory),
                    WorkingTreeNode(path: "/folder", pageID: "pg_folder", kind: .markdown, source: source)
                ]
            )
            let expected = try WorkingTreeWireCodec.snapshot(for: seeded)
            let acceptedRoot = "sha256:" + String(repeating: "a", count: 64)
            try await workingTree.initializePendingFromSystem(
                WorkingTreeSystemReplacement(
                    root: expected.root,
                    update: "up_folder",
                    nodes: [
                        WorkingTreeSystemNode(path: "/", content: .directory()),
                        WorkingTreeSystemNode(path: "/folder", pageID: "pg_folder", content: .markdown(source: source))
                    ]
                ),
                acceptedRoot: acceptedRoot,
                acceptedUpdate: "up_accepted",
                acceptedCursor: "up_accepted"
            )
            let heads = try await workingTree.heads()
            #expect(heads.materializedRoot == expected.root)
            #expect(heads.pendingRoot == expected.root)
            #expect(heads.acceptedRoot == acceptedRoot)
            #expect(heads.acceptedUpdate == "up_accepted")
            #expect(heads.generation == 1)

            // Only a fresh tree may be seeded this way.
            await #expect(throws: WorkingTreeError.pendingLocalChanges) {
                try await workingTree.initializePendingFromSystem(
                    WorkingTreeSystemReplacement(
                        root: expected.root,
                        update: "up_folder",
                        nodes: [
                            WorkingTreeSystemNode(path: "/", content: .directory()),
                            WorkingTreeSystemNode(path: "/folder", pageID: "pg_folder", content: .markdown(source: source))
                        ]
                    ),
                    acceptedRoot: acceptedRoot,
                    acceptedUpdate: "up_accepted"
                )
            }
        }
    }

    @Test("A read-only provider presents nodes as not writable and refuses every write", arguments: StoreKind.allCases)
    func readOnlyProvider(kind: StoreKind) async throws {
        try await withTemporaryReplica { root in
            let tree: TreeID = "tr_readonly"
            let workingTree = try await openWorkingTree(kind, at: root, tree: tree)
            let source = "---\nid: pg_page\n---\n\n# Page\n"
            let state = WorkingTreeState(
                tree: tree.rawValue,
                nodes: [
                    WorkingTreeNode(path: "/", kind: .directory),
                    WorkingTreeNode(path: "/page", pageID: "pg_page", kind: .markdown, source: source)
                ]
            )
            let expected = try WorkingTreeWireCodec.snapshot(for: state)
            try await workingTree.initializeFromSystem(WorkingTreeSystemReplacement(
                root: expected.root,
                update: "up_page",
                nodes: [
                    WorkingTreeSystemNode(path: "/", content: .directory()),
                    WorkingTreeSystemNode(path: "/page", pageID: "pg_page", content: .markdown(source: source))
                ]
            ))
            let provider = WorkingTreeProvider(workingTree: workingTree, readOnly: true)
            #expect(await provider.capabilities() == .readOnly)
            let page = try await provider.resolve(.init(tree: tree, path: "/page"))
            #expect(!page.isWritable)
            await #expect(throws: (any Error).self) {
                _ = try await provider.perform(.createDirectory(parent: .init(tree: tree, path: "/"), name: "local"))
            }
            let session = try await provider.openDocument(page.reference)
            let snapshot = try await session.snapshot()
            #expect(snapshot.source == source)
            await #expect(throws: (any Error).self) {
                _ = try await session.admit(source: source + "more\n", baseContentRevision: snapshot.contentRevision)
            }
            #expect(try await workingTree.heads().materializedRoot == expected.root)
        }
    }

    @Test("An open document session observes a system replacement", arguments: StoreKind.allCases)
    func documentSessionObservesSystemReplacement(kind: StoreKind) async throws {
        try await withTemporaryReplica { root in
            let tree: TreeID = "tr_observation"
            let workingTree = try await openWorkingTree(kind, at: root, tree: tree)
            let provider = WorkingTreeProvider(workingTree: workingTree)
            let home = WorkspaceReference(tree: tree, path: "/")
            let created = try #require(try await provider.perform(.createMarkdown(
                parent: home,
                name: "note",
                source: "---\nid: pg_note\n---\n\n# Before\n"
            )))
            let accepted = try await workingTree.currentSnapshot()
            try await workingTree.recordAccepted(root: accepted.root, update: "up_before")
            let session = try await provider.openDocument(created.reference)
            let before = try await session.snapshot()
            let updates = try await session.updates()
            var iterator = updates.makeAsyncIterator()
            _ = try await iterator.next()

            let afterSource = "---\nid: pg_note\n---\n\n# After\n"
            let replacementState = WorkingTreeState(
                tree: tree.rawValue,
                nodes: [
                    WorkingTreeNode(path: "/", kind: .directory),
                    WorkingTreeNode(path: "/note", pageID: "pg_note", kind: .markdown, source: afterSource)
                ]
            )
            let replacement = try WorkingTreeWireCodec.snapshot(for: replacementState)
            try await workingTree.replaceFromSystem(WorkingTreeSystemReplacement(
                root: replacement.root,
                update: "up_after",
                cursor: "up_after",
                nodes: [
                    WorkingTreeSystemNode(path: "/", content: .directory()),
                    WorkingTreeSystemNode(path: "/note", pageID: "pg_note", content: .markdown(source: afterSource))
                ]
            ))

            let observed = try #require(try await iterator.next())
            #expect(observed.source == afterSource)
            #expect(observed.contentRevision != before.contentRevision)
            await session.close()
        }
    }

    @Test("Creating a child beneath Markdown preserves a sibling body", arguments: StoreKind.allCases)
    func markdownLeafBecomesSiblingBodyDirectory(kind: StoreKind) async throws {
        try await withTemporaryReplica { root in
            let tree: TreeID = "tr_promoteleaf"
            let workingTree = try await openWorkingTree(kind, at: root, tree: tree)
            let leaf = try await workingTree.createMarkdown(
                parent: .init(tree: tree, path: "/"),
                name: "x",
                source: "# X\n"
            )
            let leafReference = WorkspaceReference(
                tree: tree,
                path: leaf.path,
                stableKey: leaf.pageID.map(markdownStableKey)
            )
            let child = try await workingTree.createMarkdown(
                parent: leafReference,
                name: "child",
                source: "# Child\n"
            )

            let promoted = try await workingTree.resolve(leafReference)
            #expect(promoted.kind == .directory)
            #expect(promoted.directoryBodyPlacement == .siblingMarkdown)
            #expect(promoted.source == leaf.source)
            let expected = try WorkingTreeWireCodec.snapshot(for: WorkingTreeState(
                tree: tree.rawValue,
                nodes: [
                    WorkingTreeNode(path: "/", kind: .directory),
                    promoted,
                    child,
                ]
            ))
            #expect(try await workingTree.currentSnapshot().root == expected.root)

            await workingTree.close()
            guard kind == .durable else { return }
            let reopened = try await WorkingTree.open(at: root, tree: tree)
            #expect(try await reopened.currentSnapshot().root == expected.root)
            #expect(try await reopened.resolve(leafReference).directoryBodyPlacement == .siblingMarkdown)
        }
    }

    @Test("Old directory records decode as _index Markdown placement")
    func legacyDirectoryBodyDecoding() throws {
        let source = "---\nid: pg_legacy\n---\n\n# Legacy\n"
        let data = try JSONSerialization.data(withJSONObject: [
            "path": "/legacy",
            "pageID": "pg_legacy",
            "kind": "directory",
            "source": source,
        ])
        let record = try JSONDecoder().decode(WorkingTreeNode.self, from: data)

        #expect(record.directoryBodyPlacement == nil)
        #expect(record.shadowedSiblingMarkdownSource == nil)
        let snapshot = try WorkingTreeWireCodec.snapshot(for: WorkingTreeState(
            tree: "tr_legacy",
            nodes: [WorkingTreeNode(path: "/", kind: .directory), record]
        ))
        #expect(!snapshot.root.isEmpty)
    }

    @Test("Duplicate logical paths throw instead of trapping")
    func duplicateLogicalPaths() {
        let state = WorkingTreeState(
            tree: "tr_duplicatepaths",
            nodes: [
                WorkingTreeNode(path: "/", kind: .directory),
                WorkingTreeNode(path: "/same", kind: .directory),
                WorkingTreeNode(path: "/same", kind: .markdown, source: "# Same\n"),
            ]
        )

        #expect(throws: WorkingTreeError.self) {
            _ = try WorkingTreeWireCodec.snapshot(for: state)
        }
    }

    @Test("Repeated mutations and restarts preserve exact roots and unique identities")
    func restartProperty() async throws {
        try await withTemporaryReplica { root in
            let tree: TreeID = "tr_property"
            var workingTree = try await WorkingTree.open(at: root, tree: tree)
            var provider = WorkingTreeProvider(workingTree: workingTree)
            let rootRef = WorkspaceReference(tree: tree, path: "/")
            let directory = try #require(try await provider.perform(.createDirectory(parent: rootRef, name: "many")))
            let names = ["z", "ä", "A"] + (0..<32).map { "node-\(String(format: "%02d", $0))" }
            var identities = Set<String>()
            for name in names.reversed() {
                let node = try #require(try await provider.perform(.createMarkdown(
                    parent: directory.reference,
                    name: name,
                    source: "# \(name)\n"
                )))
                #expect(identities.insert(try #require(node.reference.stableKey)).inserted)
            }
            let before = try await workingTree.currentSnapshot()
            let beforeHeads = try await workingTree.heads()
            await workingTree.close()

            workingTree = try await WorkingTree.open(at: root, tree: tree)
            provider = WorkingTreeProvider(workingTree: workingTree)
            #expect(try await workingTree.currentSnapshot() == before)
            #expect(try await workingTree.heads() == beforeHeads)
            let complete = try await provider.resolve(directory.reference)
            guard case let .directoryDocument(source, _, _) = complete.surface else {
                Issue.record("Expected directory document")
                return
            }
            #expect(source.isEmpty)
            let orderedNames = try await provider.children(of: directory.reference).map {
                String($0.reference.path.split(separator: "/").last ?? "")
            }
            #expect(try #require(orderedNames.firstIndex(of: "A")) < #require(orderedNames.firstIndex(of: "z")))
            #expect(try #require(orderedNames.firstIndex(of: "z")) < #require(orderedNames.firstIndex(of: "ä")))

            let selected = try await provider.resolve(.init(tree: tree, path: "/many/node-00"))
            let session = try await provider.openDocument(selected.reference)
            for generation in 0..<10 {
                let current = try await session.snapshot()
                let next = current.source + "generation \(generation)\n"
                _ = try await session.admit(source: next, baseContentRevision: current.contentRevision)
            }
            let final = try await workingTree.currentSnapshot()
            await workingTree.close()
            let reopened = try await WorkingTree.open(at: root, tree: tree)
            #expect(try await reopened.currentSnapshot() == final)
            #expect(try await reopened.heads().generation == beforeHeads.generation + 10)
        }
    }

    @Test("Object-store damage is visible as a provider diagnostic")
    func diagnostics() async throws {
        try await withTemporaryReplica { root in
            let tree: TreeID = "tr_diagnostic"
            let workingTree = try await WorkingTree.open(at: root, tree: tree)
            let snapshot = try await workingTree.currentSnapshot()
            let rootObject = root.appending(path: "objects/\(snapshot.root.dropFirst("sha256:".count))")
            try Data("damaged".utf8).write(to: rootObject)
            let provider = WorkingTreeProvider(workingTree: workingTree)
            let children = try await provider.children(of: .init(tree: tree, path: "/"))
            let diagnostic = try #require(children.first { if case .diagnostic = $0.surface { true } else { false } })
            #expect(!diagnostic.isWritable)
            #expect(try await provider.resolve(diagnostic.reference).surface == diagnostic.surface)
        }
    }
}

@Suite("Legacy replica history cleanup", .serialized)
struct WorkingTreeHistoryCleanupTests {
    @Test("Legacy history is reclaimed after journal recovery without changing heads")
    func reclaimsHistoryAfterRecovery() async throws {
        try await withTemporaryReplica { root in
            let tree: TreeID = "tr_historycleanup"
            let initial = try await WorkingTree.open(at: root, tree: tree)
            let accepted = try await initial.currentSnapshot()
            try await initial.recordAccepted(root: accepted.root, update: "up_initial")
            await initial.close()

            let crashing = try await WorkingTree.open(
                at: root,
                tree: tree,
                faultInjector: OneShotFault(.afterMaterialization)
            )
            let provider = WorkingTreeProvider(workingTree: crashing)
            await #expect(throws: WorkingTreeError.self) {
                _ = try await provider.perform(.createMarkdown(
                    parent: WorkspaceReference(tree: tree, path: "/"),
                    name: "pending",
                    source: "# Pending\n"
                ))
            }

            let history = root.appending(path: "history", directoryHint: .isDirectory)
            try FileManager.default.createDirectory(at: history, withIntermediateDirectories: false)
            try Data("legacy snapshot".utf8).write(to: history.appending(path: "000000000001.json"))

            let reopened = try await WorkingTree.open(at: root, tree: tree)
            let heads = try await reopened.heads()
            #expect(heads.pendingRoot == heads.materializedRoot)
            #expect(heads.acceptedRoot == accepted.root)
            #expect(try await reopened.documentSnapshot(.init(tree: tree, path: "/pending")).source.contains("Pending"))
            #expect(try journalFiles(root).isEmpty)
            #expect(!FileManager.default.fileExists(atPath: history.path))
            try await expectNoHistoryTombstones(in: root)

            let children = Set(try FileManager.default.contentsOfDirectory(atPath: root.path))
            #expect(children.isSuperset(of: ["control", "indexes", "journals", "materialized", "objects"]))
        }
    }

    @Test("Cleanup retries tombstones and ignores similarly named children")
    func retriesOnlyHistoryTombstones() async throws {
        try await withTemporaryReplica { root in
            let tree: TreeID = "tr_historyretry"
            let workingTree = try await WorkingTree.open(at: root, tree: tree)
            await workingTree.close()

            let tombstone = root.appending(
                path: ".obsolete-history-9a1f760e-b55f-4cd7-9e49-462fb4020505",
                directoryHint: .isDirectory
            )
            try FileManager.default.createDirectory(at: tombstone, withIntermediateDirectories: false)
            try Data("old".utf8).write(to: tombstone.appending(path: "record.json"))
            let similar = root.appending(path: ".obsolete-history-leftover", directoryHint: .isDirectory)
            try FileManager.default.createDirectory(at: similar, withIntermediateDirectories: false)

            _ = try await WorkingTree.open(at: root, tree: tree)
            try await expectNoHistoryTombstones(in: root)
            #expect(FileManager.default.fileExists(atPath: similar.path))
        }
    }

    @Test("Malformed legacy history is nonterminal and can be retried later")
    func cleanupFailureIsNonterminal() async throws {
        try await withTemporaryReplica { root in
            let tree: TreeID = "tr_historyfailure"
            let initial = try await WorkingTree.open(at: root, tree: tree)
            await initial.close()

            let history = root.appending(path: "history")
            try Data("not a directory".utf8).write(to: history)
            let stillUsable = try await WorkingTree.open(at: root, tree: tree)
            #expect(try await stillUsable.heads().generation == 0)
            #expect(FileManager.default.fileExists(atPath: history.path))
            await stillUsable.close()

            try FileManager.default.removeItem(at: history)
            try FileManager.default.createDirectory(at: history, withIntermediateDirectories: false)
            try Data("old".utf8).write(to: history.appending(path: "record.json"))
            _ = try await WorkingTree.open(at: root, tree: tree)
            #expect(!FileManager.default.fileExists(atPath: history.path))
            try await expectNoHistoryTombstones(in: root)
        }
    }
}

@Suite("Crash recovery", .serialized)
struct WorkingTreeCrashTests {
    @Test("Every durable transaction boundary replays idempotently")
    func transactionBoundaries() async throws {
        for point in WorkingTreeFailurePoint.allCases {
            try await withTemporaryReplica { root in
                let tree = TreeID(rawValue: "tr_crash_\(point.rawValue)")
                let workingTree = try await WorkingTree.open(at: root, tree: tree, faultInjector: OneShotFault(point))
                let provider = WorkingTreeProvider(workingTree: workingTree)
                await #expect(throws: WorkingTreeError.self) {
                    _ = try await provider.perform(.createMarkdown(
                        parent: WorkspaceReference(tree: tree, path: "/"),
                        name: "survives",
                        source: "# Survives\n"
                    ))
                }
                let admittedJournals = try journalFiles(root)
                #expect(admittedJournals.count == 1)
                #expect(admittedJournals[0].deletingLastPathComponent().lastPathComponent != "X3RyZWU")

                let recovered = try await WorkingTree.open(at: root, tree: tree)
                let recoveredProvider = WorkingTreeProvider(workingTree: recovered)
                let node = try await recoveredProvider.resolve(.init(tree: tree, path: "/survives"))
                #expect(node.reference.stableKey != nil, Comment(rawValue: point.rawValue))
                let heads = try await recovered.heads()
                #expect(heads.generation == 1)
                #expect(heads.materializedRoot == heads.pendingRoot)
                #expect(try journalFiles(root).isEmpty)

                await recovered.close()
                let again = try await WorkingTree.open(at: root, tree: tree)
                #expect(try await again.heads() == heads)
            }
        }
    }

    @Test("Move and Trash crashes retain PageID recovery identity")
    func structuralRecovery() async throws {
        try await withTemporaryReplica { root in
            let tree: TreeID = "tr_structuralcrash"
            let initial = try await WorkingTree.open(at: root, tree: tree)
            let provider = WorkingTreeProvider(workingTree: initial)
            let rootRef = WorkspaceReference(tree: tree, path: "/")
            let note = try #require(try await provider.perform(.createMarkdown(parent: rootRef, name: "note", source: "# Note\n")))
            let pageID = try #require(note.reference.stableKey)
            let destination = try #require(try await provider.perform(.createDirectory(parent: rootRef, name: "destination")))
            await initial.close()

            let moving = try await WorkingTree.open(at: root, tree: tree, faultInjector: OneShotFault(.afterMaterialization))
            let movingProvider = WorkingTreeProvider(workingTree: moving)
            await #expect(throws: WorkingTreeError.self) {
                _ = try await movingProvider.perform(.move(reference: note.reference, destination: destination.reference))
            }
            let moved = try await WorkingTree.open(at: root, tree: tree)
            let movedProvider = WorkingTreeProvider(workingTree: moved)
            let movedNode = try await movedProvider.resolve(.init(tree: tree, path: "/stale", stableKey: pageID))
            #expect(movedNode.reference.path == "/destination/note")
            await moved.close()

            let trashing = try await WorkingTree.open(at: root, tree: tree, faultInjector: OneShotFault(.afterControl))
            let trashingProvider = WorkingTreeProvider(workingTree: trashing)
            await #expect(throws: WorkingTreeError.self) {
                _ = try await trashingProvider.perform(.trash(reference: movedNode.reference))
            }
            let trashed = try await WorkingTree.open(at: root, tree: tree)
            let trashedProvider = WorkingTreeProvider(workingTree: trashed)
            let trashedNode = try await trashedProvider.resolve(.init(tree: tree, path: "/stale", stableKey: pageID))
            #expect(trashedNode.reference.path == "/Trash/destination/note")
            let restored = try #require(try await trashedProvider.perform(.restore(reference: trashedNode.reference)))
            #expect(restored.reference.path == "/destination/note")
            #expect(restored.reference.stableKey == pageID)
        }
    }
}

private final class OneShotFault: WorkingTreeFaultInjector, @unchecked Sendable {
    private let lock = NSLock()
    private let target: WorkingTreeFailurePoint
    private var fired = false

    init(_ target: WorkingTreeFailurePoint) { self.target = target }

    func reached(_ point: WorkingTreeFailurePoint) throws {
        lock.lock()
        defer { lock.unlock() }
        if point == target, !fired {
            fired = true
            throw WorkingTreeError.simulatedCrash(point)
        }
    }
}

private func withTemporaryReplica(_ operation: (URL) async throws -> Void) async throws {
    let root = FileManager.default.temporaryDirectory.appending(path: "arbor-replica-\(UUID().uuidString)", directoryHint: .isDirectory)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    try await operation(root)
}

private func expectNoHistoryTombstones(in root: URL) async throws {
    let deadline = ContinuousClock.now + .seconds(2)
    while ContinuousClock.now < deadline {
        let children = try FileManager.default.contentsOfDirectory(atPath: root.path)
        if !children.contains(where: {
            let prefix = ".obsolete-history-"
            guard $0.hasPrefix(prefix) else { return false }
            return UUID(uuidString: String($0.dropFirst(prefix.count))) != nil
        }) { return }
        try await Task.sleep(for: .milliseconds(10))
    }
    Issue.record("Legacy history tombstones were not removed before the deadline")
}

private func fixtureDirectory() -> URL {
    if let configured = ProcessInfo.processInfo.environment["ARBOR_PROTOCOL_FIXTURES"] { return URL(filePath: configured) }
    var current = URL(filePath: #filePath).deletingLastPathComponent()
    while current.path != "/" {
        let candidate = current.appending(path: "conformance", directoryHint: .isDirectory)
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
            var stableKey: String?
        }
        var name: String
        var directory: String
        var source: String
        var children: [Child]
        var expectedGeneratedChildren: [String]
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
            var childrenSource: WorkingTreeCollectionFileDescriptor?
        }
        var model: Model
        var canonicalCborBase64: String
        var hash: String
    }
    var objects: [Vector]
}
