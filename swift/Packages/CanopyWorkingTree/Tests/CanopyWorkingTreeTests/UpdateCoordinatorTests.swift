import CanopyAppKit
import OverstoryObjectStore
@testable import CanopyWorkingTree
@testable import Overstory
import Foundation
import Testing

private actor ClosureTransport: UpdateTransport {
    typealias Submit = @Sendable (PreparedWireUpdate, Int) async throws -> WireUpdateResponse
    let initial: WireSnapshot
    private(set) var current: WireSnapshot
    private(set) var snapshots: [String: WireSnapshot]
    private(set) var currentUpdate: String
    private(set) var currentObservedThrough: String
    let submitter: Submit
    /// Serve an accepted candidate as the current tree afterwards, the way Canopy does.
    let advancesCurrentOnAccept: Bool
    private(set) var requests: [PreparedWireUpdate] = []
    private(set) var descriptorRequests = 0
    private(set) var snapshotRequests = 0
    private(set) var requestedRoots: [String] = []

    init(
        initial: WireSnapshot,
        current: WireSnapshot? = nil,
        additionalSnapshots: [WireSnapshot] = [],
        currentUpdate: String = "up_initial",
        currentObservedThrough: String? = nil,
        advancesCurrentOnAccept: Bool = false,
        submitter: @escaping Submit
    ) {
        self.initial = initial
        self.current = current ?? initial
        self.snapshots = Dictionary(
            ([initial, current].compactMap { $0 } + additionalSnapshots).map { ($0.root, $0) },
            uniquingKeysWith: { _, latest in latest }
        )
        self.currentUpdate = currentUpdate
        self.currentObservedThrough = currentObservedThrough ?? currentUpdate
        self.advancesCurrentOnAccept = advancesCurrentOnAccept
        self.submitter = submitter
    }

    func submit(_ prepared: PreparedWireUpdate) async throws -> WireUpdateResponse {
        requests.append(prepared)
        let response = try await submitter(prepared, requests.count)
        if advancesCurrentOnAccept, let final = response.results.last {
            let request = try JSONDecoder().decode(WireUpdateRequest.self, from: prepared.body)
            var known = current
            for update in request.updates {
                known = try completeCandidate(WireUpdateRequest(base: request.base, updates: [update]), retained: known)
                snapshots[known.root] = known
            }
            switch final.result {
            case let .accepted(update), let .unchanged(update):
                if let snapshot = snapshots[update.root] {
                    current = snapshot
                    currentUpdate = update.id
                    currentObservedThrough = update.id
                }
            }
        }
        return response
    }

    func descriptor(tree: String) async throws -> WireCurrentTree {
        descriptorRequests += 1
        return WireCurrentTree(
            tree: WireTreeDescriptor(
                id: tree,
                kind: "ordinary",
                root: current.root,
                access: "write",
                canonical: WireCanonicalDescriptor(path: "/~owner/\(tree)", endpoint: "https://arbor.example"),
                update: currentUpdate
            ),
            observedThrough: currentObservedThrough
        )
    }

    func snapshot(tree _: String, root: String) async throws -> WireSnapshot {
        snapshotRequests += 1
        requestedRoots.append(root)
        guard let snapshot = snapshots[root] else { throw UpdateError.returnedSnapshotMismatch }
        return snapshot
    }
}

private actor FirstRequestGate {
    private var continuation: CheckedContinuation<Void, Never>?
    private(set) var waiting = false

    func hold() async {
        waiting = true
        await withCheckedContinuation { continuation = $0 }
    }

    func release() {
        continuation?.resume()
        continuation = nil
        waiting = false
    }
}

private struct InjectedSyncCrash: Error {}

private struct OnePointFault: UpdateFaultInjector {
    let point: UpdateFailurePoint
    func reached(_ point: UpdateFailurePoint) throws {
        if point == self.point { throw InjectedSyncCrash() }
    }
}

private final class FirstPreparationFault: UpdateFaultInjector, @unchecked Sendable {
    private let lock = NSLock()
    private var fired = false
    func reached(_ point: UpdateFailurePoint) throws {
        guard point == .beforeRequestPersistence else { return }
        let fail = lock.withLock { () -> Bool in
            if fired { return false }
            fired = true
            return true
        }
        if fail { throw InjectedSyncCrash() }
    }
}

@Suite("Working-tree update coordinator")
struct UpdateCoordinatorTests {
    @Test("Old-format uncertain requests remain intact and are never submitted by the upgraded coordinator")
    func oldRequestRecovery() async throws {
        try await withTemporaryRoot { root in
            let tree = "tr_oldrequest"
            let initial = try snapshot(markdown: "# Retained work\n")
            let transport = ClosureTransport(initial: initial) { _, _ in throw URLError(.notConnectedToInternet) }
            let workingTree = try await placeWorkingTree(tree: descriptor(tree:tree,snapshot:initial,update:"up_initial"),at:root.appending(path:"replica"),transport:transport)
            let oldIntent = CanonicalCBOR.encode(.map([
                ("domain",.text("arbor-update")),("tree",.text(tree)),("base",.text("up_initial")),
                ("change",.text("old-change")),("candidate",.text(initial.root)),("operations",.null),
                ("ifMatch",.text("modelHash")),("onConflict",.text("merge"))
            ]))
            let digest = WireObjectCodec.hash(oldIntent)
            let body = try JSONSerialization.data(withJSONObject:["base":"up_initial","updates":[[
                "change":"old-change","candidate":initial.root,"operations":NSNull(),"ifMatch":"modelHash","objects":[],"deltas":[]
            ]]])
            var control = UpdateControl()
            control.attempt = UpdateAttempt(tree:tree,base:.init(root:initial.root,update:"up_initial"),candidate:initial.root,generation:1,body:body,requestDigests:[digest],digest:digest)
            let state = root.appending(path:"state")
            let files = try UpdateControlFiles(root:state)
            try files.write(control)
            let original = try Data(contentsOf:files.controlURL)
            #expect(throws: ArborWireValidationError.self) {
                try UpdateCoordinator(workingTree:workingTree,transport:transport,stateRoot:state)
            }
            #expect(try Data(contentsOf:files.controlURL) == original)
            #expect(await transport.requests.isEmpty)
        }
    }

    @Test("Native materialization preserves exact Wire collection-file descriptors")
    func collectionFileDescriptorRoundTrip() async throws {
        try await withTemporaryRoot { root in
            let source = try WireObjectCodec.object(.file(Data(#"[{"id":"one"}]"#.utf8)))
            let schema = try WireObjectCodec.object(.file(Data("export const schema = value\n".utf8)))
            let descriptor = WireCollectionFileDescriptor(
                format: "json",
                source: "_store.json",
                schemaSource: "schema.ts",
                schemaFingerprint: "sha256:" + String(repeating: "3", count: 64),
                childSetHash: "sha256:" + String(repeating: "4", count: 64)
            )
            let directory = try WireObjectCodec.object(.directory([
                .init(name: "_store.json", file: source.hash),
                .init(name: "schema.ts", file: schema.hash),
            ], childrenSource: descriptor))
            let snapshot = WireSnapshot(root: directory.hash, objects: [directory, schema, source])
            let replacement = try SnapshotBridge.replacement(
                snapshot: snapshot,
                tree: TreeID(rawValue: "tr_collection"),
                update: "up_collection"
            )
            let workingTree = try await WorkingTree.open(at: root.appending(path: "collection"), tree: TreeID(rawValue: "tr_collection"))
            try await workingTree.initializeFromSystem(replacement)
            let rebuilt = try await workingTree.currentSnapshot()
            #expect(rebuilt.root == snapshot.root)
            #expect(Set(rebuilt.objects.map(\.hash)) == Set(snapshot.objects.map(\.hash)))
        }
    }

    @Test("A sparse spine with typed entries bridges to the same replacement as the complete snapshot")
    func sparseBridgeEqualsFullBridge() async throws {
        let note = try WireObjectCodec.object(.file(Data("---\nid: pg_note\n---\n\n# Note\n".utf8)))
        let photo = try WireObjectCodec.object(.file(Data([0xff, 0xd8, 0xff, 0xe0])))
        let clip = try WireObjectCodec.object(.file(Data("not really audio".utf8)))
        let album = try WireObjectCodec.object(.directory([.init(name: "photo.jpg", file: photo.hash)]))
        let root = try WireObjectCodec.object(.directory([
            .init(name: "album", directory: album.hash),
            .init(name: "clip.unknownext", file: clip.hash),
            .init(name: "note.md", file: note.hash),
        ]))
        let tree = TreeID(rawValue: "tr_sparsebridge")
        let full = WireSnapshot(root: root.hash, objects: [root, album, note, photo, clip])
        let spine = WireSnapshot(root: root.hash, objects: [root, album, note])
        let complete = try SnapshotBridge.replacement(snapshot: full, tree: tree, update: "up_1")
        let sparse = try SnapshotBridge.replacement(snapshot: spine, tree: tree, update: "up_1", mode: .sparseFiles)
        #expect(sparse.root == complete.root)
        #expect(sparse.nodes.map(\.path) == complete.nodes.map(\.path))
        let sparsePhoto = try #require(sparse.nodes.first { $0.path == "/album/photo.jpg" })
        #expect(sparsePhoto.content == .file(ref: .hash(photo.hash, size: nil, mediaType: "image/jpeg")))
        let sparseClip = try #require(sparse.nodes.first { $0.path == "/clip.unknownext" })
        #expect(sparseClip.content == .file(ref: .hash(clip.hash, size: nil, mediaType: SnapshotBridge.inferredMediaType(for: "clip.unknownext"))))
        // Markdown and directories are identical between the two.
        #expect(sparse.nodes.filter { $0.path == "/" || $0.path == "/note" || $0.path == "/album" }
            == complete.nodes.filter { $0.path == "/" || $0.path == "/note" || $0.path == "/album" })

        // Both install to the same root, one in memory with a platform store and
        // one from complete objects.
        let platform = InMemoryObjectOverlay()
        try platform.store([photo.hash: photo.bytes, clip.hash: clip.bytes])
        let sparseTree = try await WorkingTree.inMemory(tree: tree, platform: platform)
        try await sparseTree.initializeFromSystem(sparse)
        let completeTree = try await WorkingTree.inMemory(tree: tree)
        try await completeTree.initializeFromSystem(complete)
        #expect(try await sparseTree.currentSnapshot().root == root.hash)
        #expect(try await completeTree.currentSnapshot().root == root.hash)
        // Both hold every file by hash after installing; the sparse tree serves
        // them from the platform, the complete tree from its own overlay.
        #expect(try await sparseTree.currentSnapshot().sparseHashes == [photo.hash, clip.hash])
        #expect(try await completeTree.currentSnapshot().sparseHashes == [photo.hash, clip.hash])
        #expect(try await completeTree.fileBytes(.init(tree: tree, path: "/album/photo.jpg")) == Data([0xff, 0xd8, 0xff, 0xe0]))
        #expect(try await sparseTree.fileBytes(.init(tree: tree, path: "/album/photo.jpg")) == Data([0xff, 0xd8, 0xff, 0xe0]))
        #expect(try await sparseTree.completeSnapshot().objects.map(\.hash).sorted() == full.objects.map(\.hash).sorted())

        // A missing directory must never become a lazy file.
        let rootless = WireSnapshot(root: root.hash, objects: [root, note])
        #expect(throws: ArborWireValidationError.self) {
            _ = try SnapshotBridge.replacement(snapshot: rootless, tree: tree, update: "up_1", mode: .sparseFiles)
        }
        // Markdown must be present in a sparse spine.
        let noMarkdown = WireSnapshot(root: root.hash, objects: [root, album])
        #expect(throws: ArborWireValidationError.self) {
            _ = try SnapshotBridge.replacement(snapshot: noMarkdown, tree: tree, update: "up_1", mode: .sparseFiles)
        }
        // Complete mode requires the omitted file payloads too.
        #expect(throws: ArborWireValidationError.self) {
            _ = try SnapshotBridge.replacement(snapshot: spine, tree: tree, update: "up_1")
        }
    }

    @Test("March-Out-My-Work sibling Markdown and directory place as one exact logical node")
    func siblingMarkdownDirectoryRoundTrip() async throws {
        try await withTemporaryRoot { root in
            let tree: TreeID = "tr_siblingbody"
            let source = "---\nid: pg_march\n---\n\n# March Out My Work\n"
            let original = try directoryBodySnapshot(stem: "March-Out-My-Work", siblingSource: source)
            let replacement = try SnapshotBridge.replacement(snapshot: original, tree: tree, update: "up_initial")

            #expect(replacement.nodes.filter { $0.path == "/March-Out-My-Work" }.count == 1)
            let logical = try #require(replacement.nodes.first { $0.path == "/March-Out-My-Work" })
            #expect(logical.content == .directory(source: source))
            #expect(logical.directoryBodyPlacement == .siblingMarkdown)
            #expect(replacement.nodes.contains { $0.path == "/March-Out-My-Work/child" })

            var workingTree = try await WorkingTree.open(at: root.appending(path: "replica"), tree: tree)
            try await workingTree.initializeFromSystem(replacement)
            #expect(try await workingTree.currentSnapshot().root == original.root)
            await workingTree.close()

            workingTree = try await WorkingTree.open(at: root.appending(path: "replica"), tree: tree)
            #expect(try await workingTree.currentSnapshot().root == original.root)
            let session = try await WorkingTreeProvider(workingTree: workingTree).openDocument(
                .init(tree: tree, path: "/March-Out-My-Work", stableKey: markdownStableKey("pg_march"))
            )
            let before = try await session.snapshot()
            let editedSource = before.source + "\nEdited without moving the body.\n"
            _ = try await session.admit(source: editedSource, baseContentRevision: before.contentRevision)
            let expected = try directoryBodySnapshot(stem: "March-Out-My-Work", siblingSource: editedSource)
            #expect(try await workingTree.currentSnapshot().root == expected.root)
        }
    }

    @Test("Sibling Markdown placement survives structural operations")
    func siblingMarkdownStructuralOperations() async throws {
        try await withTemporaryRoot { root in
            let tree: TreeID = "tr_siblingstructure"
            let source = "---\nid: pg_pair\n---\n\n# Pair\n"
            let original = try directoryBodySnapshot(stem: "pair", siblingSource: source)
            let replacement = try SnapshotBridge.replacement(snapshot: original, tree: tree, update: "up_initial")
            let workingTree = try await WorkingTree.open(at: root.appending(path: "replica"), tree: tree)
            try await workingTree.initializeFromSystem(replacement)
            let provider = WorkingTreeProvider(workingTree: workingTree)
            let rootReference = WorkspaceReference(tree: tree, path: "/")

            let renamed = try #require(try await provider.perform(.rename(
                reference: .init(tree: tree, path: "/pair", stableKey: markdownStableKey("pg_pair")),
                name: "renamed"
            )))
            var snapshot = try await workingTree.currentSnapshot()
            #expect(try wireEntryNames(snapshot: snapshot, directory: snapshot.root).isSuperset(of: ["renamed", "renamed.md"]))

            let archive = try #require(try await provider.perform(.createDirectory(parent: rootReference, name: "archive")))
            let moved = try #require(try await provider.perform(.move(reference: renamed.reference, destination: archive.reference)))
            snapshot = try await workingTree.currentSnapshot()
            let rootEntries = try wireDirectoryEntries(snapshot: snapshot, directory: snapshot.root)
            let archiveHash = try #require(rootEntries.first { $0.name == "archive" }?.hash)
            #expect(try wireEntryNames(snapshot: snapshot, directory: archiveHash).isSuperset(of: ["renamed", "renamed.md"]))

            _ = try #require(try await provider.perform(.copy(reference: moved.reference, destination: rootReference)))
            snapshot = try await workingTree.currentSnapshot()
            #expect(try wireEntryNames(snapshot: snapshot, directory: snapshot.root).isSuperset(of: ["renamed", "renamed.md"]))

            let beforeTrash = snapshot.root
            let trashed = try #require(try await provider.perform(.trash(reference: moved.reference)))
            _ = try #require(try await provider.perform(.restore(reference: trashed.reference)))
            #expect(try await workingTree.currentSnapshot().root == beforeTrash)
        }
    }

    @Test("_index Markdown shadows a sibling body without losing its bytes")
    func shadowedSiblingBodyRoundTrip() async throws {
        try await withTemporaryRoot { root in
            let tree: TreeID = "tr_shadowedbody"
            let indexSource = "---\nid: pg_index\n---\n\n# Index wins\n"
            let siblingSource = "# Shadowed sibling stays exact\n"
            let original = try directoryBodySnapshot(
                stem: "x",
                siblingSource: siblingSource,
                indexSource: indexSource
            )
            let replacement = try SnapshotBridge.replacement(snapshot: original, tree: tree, update: "up_initial")
            let logical = try #require(replacement.nodes.first { $0.path == "/x" })
            #expect(logical.content == .directory(source: indexSource))
            #expect(logical.directoryBodyPlacement == nil)
            #expect(logical.shadowedSiblingMarkdownSource == siblingSource)

            var workingTree = try await WorkingTree.open(at: root.appending(path: "replica"), tree: tree)
            try await workingTree.initializeFromSystem(replacement)
            #expect(try await workingTree.currentSnapshot().root == original.root)
            await workingTree.close()
            workingTree = try await WorkingTree.open(at: root.appending(path: "replica"), tree: tree)
            #expect(try await workingTree.currentSnapshot().root == original.root)
        }
    }

    @Test("Multiple sibling bodies fail before logical materialization")
    func ambiguousSiblingBodies() throws {
        let markdown = try WireObjectCodec.object(.file(Data("# Markdown\n".utf8)))
        let mdx = try WireObjectCodec.object(.file(Data("# MDX\n".utf8)))
        let directory = try WireObjectCodec.object(.directory([]))
        let root = try WireObjectCodec.object(.directory([
            .init(name: "x", directory: directory.hash),
            .init(name: "x.md", file: markdown.hash),
            .init(name: "x.mdx", file: mdx.hash),
        ]))
        let snapshot = WireSnapshot(root: root.hash, objects: [root, directory, markdown, mdx])

        #expect(throws: ArborWireValidationError.self) {
            _ = try SnapshotBridge.replacement(snapshot: snapshot, tree: "tr_ambiguous", update: "up_initial")
        }

        let plain = try WireObjectCodec.object(.file(Data("plain".utf8)))
        let duplicateRoot = try WireObjectCodec.object(.directory([
            .init(name: "same", file: plain.hash),
            .init(name: "same.md", file: markdown.hash),
        ]))
        let duplicate = WireSnapshot(root: duplicateRoot.hash, objects: [duplicateRoot, plain, markdown])
        #expect(throws: ArborWireValidationError.self) {
            _ = try SnapshotBridge.replacement(snapshot: duplicate, tree: "tr_duplicate", update: "up_initial")
        }
    }

    @Test("One-sided synchronization accepts its candidate without a returned snapshot")
    func placementAndSync() async throws {
        try await withTemporaryRoot { root in
            let tree = "tr_sync"
            let initial = try snapshot(markdown: "---\nid: pg_note\n---\n\n# Note\n\nBase\n")
            let transport = ClosureTransport(initial: initial) { prepared, _ in
                let request = try JSONDecoder().decode(WireUpdateRequest.self, from: prepared.body)
                let candidate = try completeCandidate(request, retained: initial)
                let update = accepted(id: "up_local", tree: tree, root: candidate.root, base: initial.root, candidate: candidate.root)
                return WireUpdateResponse(result: .accepted(update), requestDigest: prepared.requestDigest, observedThrough: update.id)
            }
            let workingTree = try await placeWorkingTree(
                tree: descriptor(tree: tree, snapshot: initial, update: "up_initial"),
                at: root.appending(path: "replica"),
                transport: transport
            )
            let provider = WorkingTreeProvider(workingTree: workingTree)
            let session = try await provider.openDocument(.init(tree: TreeID(rawValue: tree), path: "/note", stableKey: markdownStableKey("pg_note")))
            let base = try await session.snapshot()
            _ = try await session.admit(source: base.source + "Local\n", baseContentRevision: base.contentRevision)

            let coordinator = try UpdateCoordinator(workingTree: workingTree, transport: transport, stateRoot: root)
            let result = try await coordinator.syncOnce()
            #expect(result.state == .current)
            #expect(try await workingTree.heads().pendingRoot == nil)
            #expect((try await session.snapshot()).source.hasSuffix("Local\n"))
            #expect(await transport.requests.count == 1)
        }
    }

    @Test("A provider-confirmed editor patch syncs immediately and falls back by size")
    func immediateEditorPatch() async throws {
        try await withTemporaryRoot { root in
            let tree = "tr_patch"
            let initialSource = "---\nid: pg_note\n---\n\n# Note\n\nBase\n" + String(repeating: "Shared text.\n", count: 1_024)
            let initial = try snapshot(markdown: initialSource)
            let transport = ClosureTransport(initial: initial) { prepared, call in
                let request = try JSONDecoder().decode(WireUpdateRequest.self, from: prepared.body)
                let update = accepted(
                    id: "up_patch_\(call)",
                    tree: tree,
                    root: request.candidate,
                    base: initial.root,
                    candidate: request.candidate
                )
                return WireUpdateResponse(result: .accepted(update), requestDigest: prepared.requestDigest, observedThrough: update.id)
            }
            let workingTree = try await placeWorkingTree(
                tree: descriptor(tree: tree, snapshot: initial, update: "up_initial"),
                at: root.appending(path: "replica"),
                transport: transport
            )
            let coordinator = try UpdateCoordinator(
                workingTree: workingTree,
                transport: transport,
                stateRoot: root.appending(path: "sync")
            )
            let provider = WorkingTreeProvider(workingTree: workingTree) { admission in
                try await coordinator.syncImmediately(admission)
            }
            let session = try await provider.openDocument(
                .init(tree: TreeID(rawValue: tree), path: "/note", stableKey: markdownStableKey("pg_note"))
            )
            let base = try await session.snapshot()
            let baseBytes = Data(base.source.utf8)
            let target = Data("Base".utf8)
            let range = try #require(baseBytes.range(of: target))
            _ = try await session.admit(patch: WorkspaceDocumentPatch(
                baseContentRevision: base.contentRevision,
                edits: [WorkspaceSourceEdit(
                    utf8Range: range,
                    replacement: "Edited",
                    expected: "Base"
                )]
            ))
            for _ in 0..<100 where await transport.requests.count < 1 {
                try await Task.sleep(for: .milliseconds(10))
            }
            let firstPrepared = try #require(await transport.requests.first)
            let first = try JSONDecoder().decode(WireUpdateRequest.self, from: firstPrepared.body)
            let delta = try #require(first.deltas.first)
            #expect(delta.instructions.contains(.insert(Data("Edited".utf8))))
            #expect(delta.instructions.contains(where: { if case .copy = $0 { return true } else { return false } }))
            #expect(!first.objects.contains(where: { $0.hash == delta.result }))

            let large = try await session.snapshot()
            let fallbackSource = "---\nid: pg_note\n---\n\n# Small fallback\n"
            _ = try await session.admit(patch: WorkspaceDocumentPatch(
                baseContentRevision: large.contentRevision,
                edits: [WorkspaceSourceEdit(
                    utf8Range: 0..<Data(large.source.utf8).count,
                    replacement: fallbackSource,
                    expected: large.source
                )]
            ))
            for _ in 0..<100 where await transport.requests.count < 2 {
                try await Task.sleep(for: .milliseconds(10))
            }
            let secondPrepared = try #require(await transport.requests.dropFirst().first)
            let second = try JSONDecoder().decode(WireUpdateRequest.self, from: secondPrepared.body)
            #expect(second.deltas.isEmpty)
            #expect(!second.objects.isEmpty)
            #expect(try await workingTree.heads().pendingRoot == nil)
        }
    }

    @Test("A later native edit is one retained successor; no concurrent request is posted until the prefix resolves")
    func oneRequestInFlightWithOneSuccessor() async throws {
        try await withTemporaryRoot { root in
            let tree = "tr_successor"
            let initial = try snapshot(markdown: "---\nid: pg_note\n---\n\n# Note\n\nBase\n")
            let gate = FirstRequestGate()
            let transport = ClosureTransport(initial: initial) { prepared, call in
                if call == 1 { await gate.hold() }
                let request = try JSONDecoder().decode(WireUpdateRequest.self, from: prepared.body)
                var previous = initial.root
                let results = request.updates.enumerated().map { index, candidate in
                    let update = accepted(
                        id: "up_successor_\(call)_\(index + 1)",
                        tree: tree,
                        root: candidate.candidate,
                        base: previous,
                        candidate: candidate.candidate
                    )
                    previous = candidate.candidate
                    return WireUpdateElementResult(
                        result: .accepted(update),
                        requestDigest: prepared.requestDigests[index]
                    )
                }
                return WireUpdateResponse(results: results, observedThrough: "up_successor_\(call)_\(results.count)")
            }
            let workingTree = try await placeWorkingTree(
                tree: descriptor(tree: tree, snapshot: initial, update: "up_initial"),
                at: root.appending(path: "replica"),
                transport: transport
            )
            let coordinator = try UpdateCoordinator(workingTree: workingTree, transport: transport, stateRoot: root.appending(path: "sync"))
            let provider = WorkingTreeProvider(workingTree: workingTree) { admission in try await coordinator.syncImmediately(admission) }
            let session = try await provider.openDocument(
                .init(tree: TreeID(rawValue: tree), path: "/note", stableKey: markdownStableKey("pg_note"))
            )
            let first = try await session.snapshot()
            _ = try await session.admit(patch: WorkspaceDocumentPatch(
                baseContentRevision: first.contentRevision,
                edits: [.init(utf8Range: Data(first.source.utf8).count..<Data(first.source.utf8).count, replacement: "One\n")]
            ))
            // The admission is durable before any request; publication follows the trailing delay.
            #expect(await transport.requests.isEmpty)
            for _ in 0..<200 where !(await gate.waiting) { try await Task.sleep(for: .milliseconds(10)) }
            #expect(await gate.waiting)
            let second = try await session.snapshot()
            _ = try await session.admit(patch: WorkspaceDocumentPatch(
                baseContentRevision: second.contentRevision,
                edits: [.init(utf8Range: Data(second.source.utf8).count..<Data(second.source.utf8).count, replacement: "Two\n")]
            ))
            try await Task.sleep(for: .milliseconds(400))
            // The second generation is retained as the single successor of the request in flight.
            #expect(await transport.requests.count == 1)
            #expect(await coordinator.syncState.kind == "submitting-pending")
            await gate.release()
            for _ in 0..<200 where await transport.requests.count < 2 { try await Task.sleep(for: .milliseconds(10)) }
            for _ in 0..<200 where try await workingTree.heads().pendingRoot != nil { try await Task.sleep(for: .milliseconds(10)) }
            let requests = await transport.requests
            #expect(requests.count == 2)
            let prefix = try JSONDecoder().decode(WireUpdateRequest.self, from: requests[0].body)
            let successor = try JSONDecoder().decode(WireUpdateRequest.self, from: requests[1].body)
            #expect(prefix.updates.count == 1)
            // The successor is a new request against the applied base, not a longer concurrent prefix.
            #expect(successor.updates.count == 1)
            #expect(successor.base == "up_successor_1_1")
            #expect(successor.updates.first?.candidate == (try await workingTree.heads().materializedRoot))
            #expect(try await workingTree.heads().pendingRoot == nil)
            #expect(await coordinator.syncState.kind == "current")
        }
    }

    @Test("A preparation failure is reported and reconnect retries the preserved head")
    func preparationFailureCanResume() async throws {
        try await withTemporaryRoot { root in
            let tree = "tr_preparation_failure"
            let initial = try snapshot(markdown: "---\nid: pg_note\n---\n\n# Note\n")
            let transport = ClosureTransport(initial: initial) { prepared, _ in
                let request = try JSONDecoder().decode(WireUpdateRequest.self, from: prepared.body)
                let update = accepted(id: "up_recovered", tree: tree, root: request.candidate, base: initial.root, candidate: request.candidate)
                return WireUpdateResponse(result: .accepted(update), requestDigest: prepared.requestDigest, observedThrough: update.id)
            }
            let workingTree = try await placeWorkingTree(tree: descriptor(tree: tree, snapshot: initial, update: "up_initial"), at: root.appending(path: "replica"), transport: transport)
            let stateRoot = root.appending(path: "sync")
            let coordinator = try UpdateCoordinator(workingTree: workingTree, transport: transport, stateRoot: stateRoot,
                faultInjector: FirstPreparationFault(), publicationDelay: .milliseconds(10), publicationMaxDelay: .milliseconds(30))
            let provider = WorkingTreeProvider(workingTree: workingTree) { admission in try await coordinator.syncImmediately(admission) }
            let session = try await provider.openDocument(.init(tree: TreeID(rawValue: tree), path: "/note", stableKey: markdownStableKey("pg_note")))
            let before = try await session.snapshot()
            _ = try await session.admit(patch: WorkspaceDocumentPatch(baseContentRevision: before.contentRevision,
                edits: [.init(utf8Range: before.source.utf8.count..<before.source.utf8.count, replacement: "Keep this edit\n")]))
            for _ in 0..<100 where await coordinator.syncState.kind != "offline" { try await Task.sleep(for: .milliseconds(5)) }
            #expect(await coordinator.syncState.kind == "offline")
            #expect(try await coordinator.presentation().detail?.contains("InjectedSyncCrash") == true)
            let retained = try #require(try UpdateControlFiles(root: stateRoot).load().head)
            #expect(await transport.requests.isEmpty)
            await coordinator.setTransportAvailable(false)
            await coordinator.setTransportAvailable(true)
            #expect(await transport.requests.count == 1)
            #expect(try await workingTree.heads().acceptedRoot == retained.root)
            #expect(try await workingTree.heads().pendingRoot == nil)
        }
    }

    @Test("Filesystem acknowledgement before publication does not strand the next native edit")
    func filesystemAcknowledgementBeforePublication() async throws {
        try await withTemporaryRoot { root in
            let tree = "tr_external_ack"
            let initial = try snapshot(markdown: "---\nid: pg_note\n---\n\n# Note\n\nBase\n")
            let transport = ClosureTransport(initial: initial) { prepared, call in
                let request = try JSONDecoder().decode(WireUpdateRequest.self, from: prepared.body)
                let update = accepted(id: "up_native_\(call)", tree: tree, root: request.candidate, base: initial.root, candidate: request.candidate)
                return WireUpdateResponse(result: .accepted(update), requestDigest: prepared.requestDigest, observedThrough: update.id)
            }
            let workingTree = try await placeWorkingTree(
                tree: descriptor(tree: tree, snapshot: initial, update: "up_initial"),
                at: root.appending(path: "replica"), transport: transport
            )
            let coordinator = try UpdateCoordinator(workingTree: workingTree, transport: transport,
                stateRoot: root.appending(path: "sync"), publicationDelay: .milliseconds(100), publicationMaxDelay: .milliseconds(200))
            let provider = WorkingTreeProvider(workingTree: workingTree) { admission in try await coordinator.syncImmediately(admission) }
            let session = try await provider.openDocument(.init(tree: TreeID(rawValue: tree), path: "/note", stableKey: markdownStableKey("pg_note")))
            let first = try await session.snapshot()
            _ = try await session.admit(patch: WorkspaceDocumentPatch(baseContentRevision: first.contentRevision,
                edits: [.init(utf8Range: first.source.utf8.count..<first.source.utf8.count, replacement: "First\n")]))
            for _ in 0..<50 where await coordinator.syncState.kind != "locally-pending" {
                try await Task.sleep(for: .milliseconds(1))
            }
            #expect(await coordinator.syncState.kind == "locally-pending")
            let acknowledged = try await workingTree.heads().materializedRoot
            // The shared filesystem provider learns the daemon accepted these exact bytes
            // before Native's trailing publication task begins its pass.
            try await workingTree.recordAccepted(root: acknowledged, update: "up_external", cursor: "cursor_external")
            for _ in 0..<200 where await coordinator.syncState.kind != "current" {
                try await Task.sleep(for: .milliseconds(10))
            }
            #expect(await transport.requests.isEmpty)
            #expect(await coordinator.syncState.kind == "current")
            let second = try await session.snapshot()
            _ = try await session.admit(patch: WorkspaceDocumentPatch(baseContentRevision: second.contentRevision,
                edits: [.init(utf8Range: second.source.utf8.count..<second.source.utf8.count, replacement: "Second\n")]))
            for _ in 0..<100 where try await workingTree.heads().pendingRoot != nil {
                try await Task.sleep(for: .milliseconds(10))
            }
            #expect(await transport.requests.count == 1)
            let request = try #require(await transport.requests.first)
            #expect(try JSONDecoder().decode(WireUpdateRequest.self, from: request.body).base == "up_external")
            #expect(try await workingTree.heads().pendingRoot == nil)
        }
    }

    @Test("A burst of native admissions before the publication delay becomes one request")
    func burstCoalescesBeforePublication() async throws {
        try await withTemporaryRoot { root in
            let tree = "tr_burst"
            let initial = try snapshot(markdown: "---\nid: pg_note\n---\n\n# Note\n\nBase\n")
            let transport = ClosureTransport(initial: initial) { prepared, call in
                let request = try JSONDecoder().decode(WireUpdateRequest.self, from: prepared.body)
                let update = accepted(id: "up_burst_\(call)", tree: tree, root: request.candidate, base: initial.root, candidate: request.candidate)
                return WireUpdateResponse(result: .accepted(update), requestDigest: prepared.requestDigest, observedThrough: update.id)
            }
            let workingTree = try await placeWorkingTree(
                tree: descriptor(tree: tree, snapshot: initial, update: "up_initial"),
                at: root.appending(path: "replica"),
                transport: transport
            )
            let coordinator = try UpdateCoordinator(workingTree: workingTree, transport: transport, stateRoot: root.appending(path: "sync"))
            let provider = WorkingTreeProvider(workingTree: workingTree) { admission in try await coordinator.syncImmediately(admission) }
            let session = try await provider.openDocument(
                .init(tree: TreeID(rawValue: tree), path: "/note", stableKey: markdownStableKey("pg_note"))
            )
            for index in 1...15 {
                let current = try await session.snapshot()
                _ = try await session.admit(patch: WorkspaceDocumentPatch(
                    baseContentRevision: current.contentRevision,
                    edits: [.init(utf8Range: Data(current.source.utf8).count..<Data(current.source.utf8).count, replacement: "Move \(index)\n")]
                ))
            }
            #expect(await transport.requests.isEmpty)
            for _ in 0..<300 where try await workingTree.heads().pendingRoot != nil { try await Task.sleep(for: .milliseconds(10)) }
            let requests = await transport.requests
            #expect(requests.count == 1)
            let request = try JSONDecoder().decode(WireUpdateRequest.self, from: try #require(requests.first?.body))
            #expect(request.updates.count == 1)
            #expect(request.candidate == (try await workingTree.heads().materializedRoot))
            #expect((try await session.snapshot()).source.hasSuffix("Move 15\n"))
        }
    }

    @Test("Offline native admissions become one latest successor of an ambiguous prefix")
    func offlineAdmissionsCompactBehindAmbiguousPrefix() async throws {
        try await withTemporaryRoot { root in
            let tree = "tr_offlinecompaction"
            let initial = try snapshot(markdown: "---\nid: pg_note\n---\n\n# Note\n\nBase\n")
            let gate = FirstRequestGate()
            let transport = ClosureTransport(initial: initial) { prepared, call in
                if call == 1 { await gate.hold() }
                let request = try JSONDecoder().decode(WireUpdateRequest.self, from: prepared.body)
                var previous = initial.root
                let results = request.updates.enumerated().map { index, candidate in
                    let update = accepted(
                        id: "up_offline_\(call)_\(index + 1)",
                        tree: tree,
                        root: candidate.candidate,
                        base: previous,
                        candidate: candidate.candidate
                    )
                    previous = candidate.candidate
                    return WireUpdateElementResult(
                        result: .accepted(update),
                        requestDigest: prepared.requestDigests[index]
                    )
                }
                return WireUpdateResponse(results: results, observedThrough: "up_offline_\(call)_\(results.count)")
            }
            let workingTree = try await placeWorkingTree(
                tree: descriptor(tree: tree, snapshot: initial, update: "up_initial"),
                at: root.appending(path: "replica"),
                transport: transport
            )
            let coordinator = try UpdateCoordinator(
                workingTree: workingTree,
                transport: transport,
                stateRoot: root.appending(path: "sync")
            )
            let provider = WorkingTreeProvider(workingTree: workingTree) { admission in
                try await coordinator.syncImmediately(admission)
            }
            let session = try await provider.openDocument(
                .init(tree: TreeID(rawValue: tree), path: "/note", stableKey: markdownStableKey("pg_note"))
            )
            var current = try await session.snapshot()
            _ = try await session.admit(patch: WorkspaceDocumentPatch(
                baseContentRevision: current.contentRevision,
                edits: [.init(
                    utf8Range: Data(current.source.utf8).count..<Data(current.source.utf8).count,
                    replacement: "Before offline\n"
                )]
            ))
            for _ in 0..<100 where !(await gate.waiting) { try await Task.sleep(for: .milliseconds(10)) }

            await coordinator.setTransportAvailable(false)
            for index in 1...37 {
                current = try await session.snapshot()
                _ = try await session.admit(patch: WorkspaceDocumentPatch(
                    baseContentRevision: current.contentRevision,
                    edits: [.init(
                        utf8Range: Data(current.source.utf8).count..<Data(current.source.utf8).count,
                        replacement: "Offline \(index)\n"
                    )]
                ))
            }
            try await Task.sleep(for: .milliseconds(50))
            #expect(await transport.requests.count == 1)

            let latestRoot = try await workingTree.heads().materializedRoot
            await coordinator.setTransportAvailable(true)
            let requests = await transport.requests
            #expect(requests.count == 2)
            let prefix = try JSONDecoder().decode(WireUpdateRequest.self, from: requests[0].body)
            let resumed = try JSONDecoder().decode(WireUpdateRequest.self, from: requests[1].body)
            #expect(prefix.updates.count == 1)
            #expect(resumed.updates.count == 2)
            #expect(Array(resumed.updates.prefix(1)) == prefix.updates)
            #expect(resumed.updates.last?.candidate == latestRoot)

            await gate.release()
            for _ in 0..<100 where try await workingTree.heads().pendingRoot != nil {
                try await Task.sleep(for: .milliseconds(10))
            }
            #expect(try await workingTree.heads().pendingRoot == nil)
        }
    }

    @Test("A clean watch invalidation reads the coherent current snapshot without submitting")
    func cleanWatchPull() async throws {
        try await withTemporaryRoot { root in
            let tree = "tr_watchpull"
            let initial = try snapshot(markdown: "---\nid: pg_note\n---\n\n# Note\n\nOne\n")
            let remote = try snapshot(markdown: "---\nid: pg_note\n---\n\n# Note\n\nTwo\n")
            let bootstrap = ClosureTransport(initial: initial) { _, _ in
                throw ArborWireValidationError.invalidValue("Placement must not submit")
            }
            let workingTree = try await placeWorkingTree(
                tree: descriptor(tree: tree, snapshot: initial, update: "up_initial"),
                at: root.appending(path: "replica"),
                transport: bootstrap
            )
            let remoteTransport = ClosureTransport(initial: remote, currentUpdate: "up_remote") { _, _ in
                throw ArborWireValidationError.invalidValue("A clean watch pull must not submit")
            }
            let coordinator = try UpdateCoordinator(workingTree: workingTree, transport: remoteTransport, stateRoot: root)
            let event = WireWatchEvent(
                id: "up_remote",
                tree: descriptor(tree: tree, snapshot: remote, update: "up_remote")
            )
            let result = try await coordinator.observe(event)
            #expect(result.state == .current)
            #expect(result.acceptedRoot == remote.root)
            #expect(try await workingTree.heads().acceptedCursor == "up_remote")
            #expect(await remoteTransport.descriptorRequests == 1)
            #expect(await remoteTransport.requestedRoots == [remote.root])
            #expect(await remoteTransport.requests.isEmpty)
        }
    }

    @Test("A clean watch applies an accepted transition without fetching a snapshot", arguments: [false, true])
    func cleanWatchTransition(net: Bool) async throws {
        try await withTemporaryRoot { root in
            let tree = "tr_watchtransition"
            let initial = try snapshot(markdown: "---\nid: pg_note\n---\n\n# Note\n\nOne\n")
            let remote = try snapshot(markdown: "---\nid: pg_note\n---\n\n# Note\n\nTwo\n")
            let transport = ClosureTransport(initial: initial) { _, _ in
                throw ArborWireValidationError.invalidValue("A clean watch transition must not submit")
            }
            let workingTree = try await placeWorkingTree(
                tree: descriptor(tree: tree, snapshot: initial, update: "up_initial"),
                at: root.appending(path: "replica"),
                transport: transport
            )
            let snapshotRequestsBefore = await transport.snapshotRequests
            let initialFile = try #require(initial.objects.first { $0.hash != initial.root })
            let remoteFile = try #require(remote.objects.first { $0.hash != remote.root })
            let update = WireAcceptedUpdate(
                id: "up_remote",
                tree: tree,
                root: remote.root,
                previous: .init(id: net ? "up_intermediate" : "up_initial", root: initial.root),
                acceptedAt: 1_800_000_000_000
            )
            let transition = WireAcceptedTransition(
                update: update,
                objects: [try #require(remote.objects.first { $0.hash == remote.root })],
                deltas: [WireObjectDelta(
                    base: initialFile.hash,
                    result: remoteFile.hash,
                    instructions: [.insert(remoteFile.bytes)]
                )],
                from: net ? .init(id: "up_initial", root: initial.root) : nil
            )
            let coordinator = try UpdateCoordinator(workingTree: workingTree, transport: transport, stateRoot: root)
            let result = try await coordinator.observe(WireWatchEvent(
                id: update.id,
                tree: descriptor(tree: tree, snapshot: remote, update: update.id),
                transitions: [transition]
            ))

            #expect(result.state == .current)
            #expect(result.acceptedRoot == remote.root)
            #expect(await transport.snapshotRequests == snapshotRequestsBefore)
            #expect(await transport.requests.isEmpty)
            #expect(try await workingTree.heads().acceptedCursor == update.id)
        }
    }

    @Test("A same-root conflict transition persists through coordinator restart")
    func sameRootConflictMetadata() async throws {
        try await withTemporaryRoot { root in
            let tree = "tr_metadataconflict"
            let initial = try snapshot(markdown: "# Existing projection\n")
            let transport = ClosureTransport(initial: initial) { _, _ in
                throw ArborWireValidationError.invalidValue("Metadata watch must not submit")
            }
            let workingTree = try await placeWorkingTree(
                tree: descriptor(tree: tree, snapshot: initial, update: "up_initial"),
                at: root.appending(path: "replica"), transport: transport
            )
            let update = WireAcceptedUpdate(id: "up_conflicted", tree: tree, root: initial.root,
                previous: .init(id: "up_initial", root: initial.root), acceptedAt: 1, conflicted: true)
            var remote = descriptor(tree: tree, snapshot: initial, update: update.id)
            remote.conflicted = true
            let coordinator = try UpdateCoordinator(workingTree: workingTree, transport: transport, stateRoot: root)
            let result = try await coordinator.observe(WireWatchEvent(id: "observation-metadata", tree: remote,
                transitions: [.init(update: update, objects: [], deltas: [])]))
            #expect(result.state == .current)
            #expect(result.acceptedConflicted == true)
            #expect(try await workingTree.heads().acceptedCursor == "observation-metadata")
            let restarted = try UpdateCoordinator(workingTree: workingTree, transport: transport, stateRoot: root)
            #expect(try await restarted.presentation().acceptedConflicted == true)
        }
    }

    @Test("An expired watch cursor pulls a coherent snapshot and resumes after its observation boundary")
    func watchGapRecovery() async throws {
        try await withTemporaryRoot { root in
            let tree = "tr_watchgap"
            let initial = try snapshot(markdown: "---\nid: pg_note\n---\n\n# Note\n\nOne\n")
            let remote = try snapshot(markdown: "---\nid: pg_note\n---\n\n# Note\n\nTwo\n")
            let bootstrap = ClosureTransport(initial: initial) { _, _ in
                throw ArborWireValidationError.invalidValue("Placement must not submit")
            }
            let workingTree = try await placeWorkingTree(
                tree: descriptor(tree: tree, snapshot: initial, update: "up_initial"),
                at: root.appending(path: "replica"),
                transport: bootstrap
            )
            let remoteTransport = ClosureTransport(
                initial: remote,
                currentUpdate: "up_remote",
                currentObservedThrough: "observation_after_remote"
            ) { _, _ in
                throw ArborWireValidationError.invalidValue("Gap recovery must not submit")
            }
            let coordinator = try UpdateCoordinator(workingTree: workingTree, transport: remoteTransport, stateRoot: root)

            let result = try await coordinator.recoverWatchGap()

            #expect(result.state == .current)
            #expect(result.acceptedRoot == remote.root)
            #expect(try await workingTree.heads().acceptedUpdate == "up_remote")
            #expect(try await coordinator.watchCursor() == "observation_after_remote")
            #expect(await remoteTransport.descriptorRequests == 1)
            #expect(await remoteTransport.requestedRoots == [remote.root])
            #expect(await remoteTransport.requests.isEmpty)
        }
    }

    @Test("A clean replica pulls current Canopy state when transport returns")
    func cleanReconnectPull() async throws {
        try await withTemporaryRoot { root in
            let tree = "tr_cleanreconnect"
            let initial = try snapshot(markdown: "---\nid: pg_note\n---\n\n# Note\n\nOld\n")
            let remote = try snapshot(markdown: "---\nid: pg_note\n---\n\n# Note\n\nCurrent\n")
            let bootstrap = ClosureTransport(initial: initial) { _, _ in
                throw ArborWireValidationError.invalidValue("Placement must not submit")
            }
            let workingTree = try await placeWorkingTree(
                tree: descriptor(tree: tree, snapshot: initial, update: "up_initial"),
                at: root.appending(path: "replica"),
                transport: bootstrap
            )
            let remoteTransport = ClosureTransport(
                initial: remote,
                currentUpdate: "up_remote",
                currentObservedThrough: "observation_after_remote"
            ) { _, _ in
                throw ArborWireValidationError.invalidValue("A clean reconnect must not submit")
            }
            let coordinator = try UpdateCoordinator(
                workingTree: workingTree,
                transport: remoteTransport,
                stateRoot: root.appending(path: "sync"),
                transportAvailable: false
            )

            await coordinator.setTransportAvailable(true)

            #expect(try await workingTree.heads().materializedRoot == remote.root)
            #expect(try await coordinator.watchCursor() == "observation_after_remote")
            #expect(await remoteTransport.descriptorRequests == 1)
            #expect(await remoteTransport.requestedRoots == [remote.root])
            #expect(await remoteTransport.requests.isEmpty)
        }
    }

    @Test("A watch retries a lost response even without a matching digest", arguments: [false, true])
    func watchDigestRecovery(net: Bool) async throws {
        try await withTemporaryRoot { root in
            let tree = "tr_watchdigest"
            let initial = try snapshot(markdown: "---\nid: pg_note\n---\n\n# Note\n\nBase\n")
            let transport = ClosureTransport(initial: initial) { prepared, call in
                if call == 1 { throw InjectedSyncCrash() }
                let request = try JSONDecoder().decode(WireUpdateRequest.self, from: prepared.body)
                let update = accepted(
                    id: "up_local",
                    tree: tree,
                    root: request.candidate,
                    base: initial.root,
                    candidate: request.candidate
                )
                return WireUpdateResponse(
                    result: .accepted(update),
                    requestDigest: prepared.requestDigest,
                    reconciliation: nil,
                    observedThrough: update.id
                )
            }
            let workingTree = try await placeWorkingTree(
                tree: descriptor(tree: tree, snapshot: initial, update: "up_initial"),
                at: root.appending(path: "replica"),
                transport: transport
            )
            let session = try await WorkingTreeProvider(workingTree: workingTree).openDocument(
                .init(tree: TreeID(rawValue: tree), path: "/note", stableKey: markdownStableKey("pg_note"))
            )
            let base = try await session.snapshot()
            _ = try await session.admit(source: base.source + "Local\n", baseContentRevision: base.contentRevision)
            let coordinator = try UpdateCoordinator(workingTree: workingTree, transport: transport, stateRoot: root)
            await #expect(throws: InjectedSyncCrash.self) { try await coordinator.syncOnce() }
            let frozen = try #require(await transport.requests.first)
            let request = try JSONDecoder().decode(WireUpdateRequest.self, from: frozen.body)
            let eventTree = WireTreeDescriptor(
                id: tree,
                kind: "ordinary",
                root: request.candidate,
                access: "write",
                canonical: WireCanonicalDescriptor(
                    path: "/~owner/watch-digest",
                    endpoint: "https://example.test"
                ),
                update: net ? "up_net" : "up_local"
            )
            let result = try await coordinator.observe(.init(
                id: net ? "observation_net" : "observation_local",
                tree: eventTree,
                requestDigest: net ? nil : frozen.requestDigest,
                transitions: net ? [.init(
                    update: .init(id: "up_net", tree: tree, root: request.candidate,
                        previous: .init(id: "up_local", root: request.candidate), acceptedAt: 1_800_000_000_000),
                    objects: [], from: .init(id: "up_initial", root: initial.root))] : []
            ))
            #expect(result.state == .current)
            #expect(await transport.requests.count == 2)
            #expect(await transport.requests.last?.body == frozen.body)
            // A frame echoing our own digest is that update's observation, so a
            // reconnect resumes after it; a replayed transition records nothing.
            #expect(try await workingTree.heads().acceptedCursor == (net ? nil : "observation_local"))
        }
    }

    @Test("A frozen request advances the base beneath newer admitted local work")
    func localTail() async throws {
        try await withTemporaryRoot { root in
            let tree = "tr_tail"
            let initial = try snapshot(markdown: "---\nid: pg_note\n---\n\n# Note\n\nBase\n")
            let bootstrap = ClosureTransport(initial: initial) { _, _ in throw InjectedSyncCrash() }
            let workingTree = try await placeWorkingTree(
                tree: descriptor(tree: tree, snapshot: initial, update: "up_initial"),
                at: root.appending(path: "replica"),
                transport: bootstrap
            )
            let provider = WorkingTreeProvider(workingTree: workingTree)
            let reference = WorkspaceReference(tree: TreeID(rawValue: tree), path: "/note", stableKey: markdownStableKey("pg_note"))
            let session = try await provider.openDocument(reference)
            let base = try await session.snapshot()
            let candidate = try await session.admit(source: base.source + "Candidate\n", baseContentRevision: base.contentRevision)

            let transport = ClosureTransport(initial: initial) { prepared, call in
                let request = try JSONDecoder().decode(WireUpdateRequest.self, from: prepared.body)
                if call == 1 {
                    let current = try await session.snapshot()
                    _ = try await session.admit(source: current.source + "Tail\n", baseContentRevision: current.contentRevision)
                }
                let returned = try completeCandidate(request, retained: initial)
                let update = accepted(id: "up_\(call)", tree: tree, root: returned.root, base: initial.root, candidate: returned.root)
                return WireUpdateResponse(result: .accepted(update), requestDigest: prepared.requestDigest, reconciliation: WireTransitionPayload(objects: returned.objects), observedThrough: update.id)
            }
            let coordinator = try UpdateCoordinator(workingTree: workingTree, transport: transport, stateRoot: root)
            // The accepted frozen candidate advances the base beneath the retained
            // successor, which publishes against that base without waiting, so one
            // explicit synchronization settles both requests.
            let settled = try await coordinator.syncOnce()
            #expect(settled.state == .current)
            #expect(await coordinator.syncState.kind == "current")
            #expect((try await session.snapshot()).source.hasSuffix("Candidate\nTail\n"))
            #expect(try await workingTree.heads().pendingRoot == nil)
            let requests = await transport.requests
            #expect(requests.count == 2)
            let firstRequest = try JSONDecoder().decode(WireUpdateRequest.self, from: requests[0].body)
            let secondRequest = try JSONDecoder().decode(WireUpdateRequest.self, from: requests[1].body)
            #expect(firstRequest.base == "up_initial")
            #expect(firstRequest.candidate != secondRequest.candidate)
            #expect(secondRequest.base == "up_1")
            #expect(try await workingTree.heads().acceptedRoot == secondRequest.candidate)
            #expect(try await workingTree.heads().acceptedUpdate == "up_2")
            #expect(candidate.contentRevision != (try await session.snapshot()).contentRevision)
        }
    }

    @Test("A legacy 409 retains the exact attempt across restart without a conflict hold or implicit rebase")
    func rejectedRequestRecovery() async throws {
        try await withTemporaryRoot { root in
            let tree = "tr_conflict"
            let initial = try snapshot(markdown: "---\nid: pg_note\n---\n\n# Note\n\nBase\n")
            let remote = try snapshot(markdown: "---\nid: pg_note\n---\n\n# Note\n\nRemote\n")
            let draft = try snapshot(markdown: "---\nid: pg_note\n---\n\n# Note\n\nLocal\nRemote\n")
            let bootstrap = ClosureTransport(initial: initial) { _, _ in throw InjectedSyncCrash() }
            let workingTree = try await placeWorkingTree(
                tree: descriptor(tree: tree, snapshot: initial, update: "up_initial"),
                at: root.appending(path: "replica"),
                transport: bootstrap
            )
            let session = try await WorkingTreeProvider(workingTree: workingTree).openDocument(
                .init(tree: TreeID(rawValue: tree), path: "/note", stableKey: markdownStableKey("pg_note"))
            )
            let localBase = try await session.snapshot()
            _ = try await session.admit(source: localBase.source + "Local\n", baseContentRevision: localBase.contentRevision)
            let current = accepted(id: "up_remote", tree: tree, root: remote.root, base: initial.root, candidate: remote.root)
            let conflict = WireUpdateConflict(
                message: "unsafe",
                current: current,
                base: initial.root,
                candidate: try await workingTree.currentSnapshot().root,
                draft: WireConflictDraft(root: draft.root, objects: draft.objects),
                conflicts: [.init(path: "/note.md", reason: "frontmatter-conflict")]
            )
            let conflictTransport = ClosureTransport(initial: initial) { _, _ in
                throw WireUpdateConflictError(conflict: conflict)
            }
            let coordinator = try UpdateCoordinator(workingTree: workingTree, transport: conflictTransport, stateRoot: root)
            await #expect(throws: WireUpdateConflictError.self) { try await coordinator.syncOnce() }
            let files = try UpdateControlFiles(root: root)
            let retained = try #require(files.load().attempt)
            #expect(retained.candidate == conflict.candidate)
            #expect(try await coordinator.presentation().state == .requestPending)
            await coordinator.close()

            let accepting = ClosureTransport(initial: initial) { prepared, _ in
                let request = try JSONDecoder().decode(WireUpdateRequest.self, from: prepared.body)
                #expect(request.base == "up_initial")
                #expect(prepared.body == retained.body)
                #expect(prepared.requestDigests == retained.allRequestDigests)
                let candidate = try completeCandidate(request, retained: initial)
                return WireUpdateResponse(
                    result: .accepted(accepted(id: "up_resolved", tree: tree, root: candidate.root, base: initial.root, candidate: candidate.root)),
                    requestDigest: prepared.requestDigest,
                    observedThrough: "up_resolved"
                )
            }
            let resumed = try UpdateCoordinator(workingTree: workingTree, transport: accepting, stateRoot: root)
            #expect(try await resumed.syncOnce().state == .current)
        }
    }

    @Test("Every coordinator crash point replays one semantic intent")
    func crashRecovery() async throws {
        for point in UpdateFailurePoint.allCases where point != .duringMaterialization && point != .afterMaterialization {
            try await withTemporaryRoot { root in
                let tree = "tr_fault_\(point.rawValue)"
                let initial = try snapshot(markdown: "---\nid: pg_note\n---\n\n# Note\n")
                let transport = ClosureTransport(initial: initial) { prepared, _ in
                    let request = try JSONDecoder().decode(WireUpdateRequest.self, from: prepared.body)
                    let candidate = try completeCandidate(request, retained: initial)
                    return WireUpdateResponse(
                        result: .accepted(accepted(id: "up_done", tree: tree, root: candidate.root, base: initial.root, candidate: candidate.root)),
                        requestDigest: prepared.requestDigest,
                            observedThrough: "up_done"
                    )
                }
                let workingTree = try await placeWorkingTree(
                    tree: descriptor(tree: tree, snapshot: initial, update: "up_initial"),
                    at: root.appending(path: "replica"),
                    transport: transport
                )
                let provider = WorkingTreeProvider(workingTree: workingTree)
                _ = try await provider.perform(.createMarkdown(
                    parent: .init(tree: TreeID(rawValue: tree), path: "/"),
                    name: "local",
                    source: "# Local\n"
                ))
                let crashing = try UpdateCoordinator(
                    workingTree: workingTree,
                    transport: transport,
                    stateRoot: root,
                    faultInjector: OnePointFault(point: point)
                )
                await #expect(throws: InjectedSyncCrash.self) { _ = try await crashing.syncOnce() }
                let resumed = try UpdateCoordinator(workingTree: workingTree, transport: transport, stateRoot: root)
                #expect(try await resumed.syncOnce().state == .current)
                let requests = await transport.requests
                let frozen = try JSONDecoder().decode(WireUpdateRequest.self, from: try #require(requests.first).body)
                #expect(frozen.objects.count < (try await workingTree.currentSnapshot()).objects.count)
                if requests.count > 1 {
                    #expect(Set(requests.map(\.requestDigest)).count == 1)
                    #expect(Set(requests.map(\.body)).count == 1)
                }
            }
        }
    }

    @Test("Materialization crashes replay the exact merged response safely")
    func materializationCrashRecovery() async throws {
        for point in [UpdateFailurePoint.duringMaterialization, .afterMaterialization] {
            try await withTemporaryRoot { root in
                let tree = "tr_materialize_\(point.rawValue)"
                let initial = try snapshot(markdown: "---\nid: pg_note\n---\n\n# Note\n\nBase\n")
                let merged = try snapshot(markdown: "---\nid: pg_note\n---\n\n# Note\n\nBase\nLocal\nRemote\n")
                let transport = ClosureTransport(initial: initial) { prepared, _ in
                    let update = WireAcceptedUpdate(
                        id: "up_merged",
                        tree: tree,
                        root: merged.root,
                        previous: .init(id: "up_initial", root: initial.root),
                        acceptedAt: 1_800_000_000_000
                    )
                    return WireUpdateResponse(result: .accepted(update), requestDigest: prepared.requestDigest, reconciliation: WireTransitionPayload(objects: merged.objects), observedThrough: update.id)
                }
                let workingTree = try await placeWorkingTree(
                    tree: descriptor(tree: tree, snapshot: initial, update: "up_initial"),
                    at: root.appending(path: "replica"),
                    transport: transport
                )
                let session = try await WorkingTreeProvider(workingTree: workingTree).openDocument(
                    .init(tree: TreeID(rawValue: tree), path: "/note", stableKey: markdownStableKey("pg_note"))
                )
                let base = try await session.snapshot()
                _ = try await session.admit(source: base.source + "Local\n", baseContentRevision: base.contentRevision)

                let crashing = try UpdateCoordinator(
                    workingTree: workingTree,
                    transport: transport,
                    stateRoot: root,
                    faultInjector: OnePointFault(point: point)
                )
                await #expect(throws: InjectedSyncCrash.self) { _ = try await crashing.syncOnce() }
                let resumed = try UpdateCoordinator(workingTree: workingTree, transport: transport, stateRoot: root)
                #expect(try await resumed.syncOnce().state == .current)
                #expect(try await workingTree.heads().acceptedRoot == merged.root)
                let requests = await transport.requests
                #expect(requests.count == 2)
                #expect(Set(requests.map(\.requestDigest)).count == 1)
                #expect(Set(requests.map(\.body)).count == 1)
            }
        }
    }
}

@Suite("Working-tree update coordinator: sparse bodies and durable head")
struct UpdateCoordinatorPhase3Tests {
    @Test("A durable head survives a stop before the publication delay and is submitted as one request")
    func durableHeadSurvivesStop() async throws {
        try await withTemporaryRoot { root in
            let tree = "tr_head"
            let initial = try snapshot(markdown: "---\nid: pg_note\n---\n\n# Note\n\nBase\n")
            let transport = ClosureTransport(initial: initial) { prepared, _ in
                let request = try JSONDecoder().decode(WireUpdateRequest.self, from: prepared.body)
                let candidate = try completeCandidate(request, retained: initial)
                let update = accepted(id: "up_head", tree: tree, root: candidate.root, base: initial.root, candidate: candidate.root)
                return WireUpdateResponse(result: .accepted(update), requestDigest: prepared.requestDigest, observedThrough: update.id)
            }
            let workingTree = try await placeWorkingTree(
                tree: descriptor(tree: tree, snapshot: initial, update: "up_initial"),
                at: root.appending(path: "replica"),
                transport: transport
            )
            let stopped = try UpdateCoordinator(
                workingTree: workingTree,
                transport: transport,
                stateRoot: root,
                publicationDelay: .seconds(30),
                publicationMaxDelay: .seconds(60)
            )
            let provider = WorkingTreeProvider(workingTree: workingTree) { admission in try await stopped.syncImmediately(admission) }
            let session = try await provider.openDocument(.init(tree: TreeID(rawValue: tree), path: "/note", stableKey: markdownStableKey("pg_note")))
            try await admitAppend(session, "Unpublished\n")
            try await waitForHead(root: root, workingTree: workingTree)
            let head = try #require(try UpdateControlFiles(root: root).load().head)
            let localRoot = try await workingTree.heads().materializedRoot
            #expect(head.root == localRoot)
            #expect(head.base.update == "up_initial")
            #expect(!head.objects.isEmpty)
            #expect(head.objects.allSatisfy { !initial.objects.map(\.hash).contains($0.hash) })
            #expect(await transport.requests.isEmpty)
            await stopped.close()

            let resumed = try UpdateCoordinator(workingTree: workingTree, transport: transport, stateRoot: root)
            #expect(try await resumed.syncOnce().state == .current)
            let requests = await transport.requests
            #expect(requests.count == 1)
            let request = try JSONDecoder().decode(WireUpdateRequest.self, from: try #require(requests.first).body)
            #expect(request.candidate == localRoot)
            #expect(Set(request.objects.map(\.hash)) == Set(head.objects.map(\.hash)))
            let control = try UpdateControlFiles(root: root).load()
            #expect(control.head == nil)
            #expect(control.attempt == nil)
            #expect(control.schema == 3)
        }
    }

    @Test("A recovered attempt whose tree was re-seeded is applied once and pulls current instead of re-submitting")
    func recoveredAttemptPullsCurrent() async throws {
        try await withTemporaryRoot { root in
            let tree = "tr_reseed"
            let initial = try snapshot(markdown: "---\nid: pg_note\n---\n\n# Note\n\nBase\n")
            let transport = ClosureTransport(initial: initial, advancesCurrentOnAccept: true) { prepared, _ in
                let request = try JSONDecoder().decode(WireUpdateRequest.self, from: prepared.body)
                let candidate = try completeCandidate(request, retained: initial)
                let update = accepted(id: "up_reseed", tree: tree, root: candidate.root, base: initial.root, candidate: candidate.root)
                return WireUpdateResponse(result: .accepted(update), requestDigest: prepared.requestDigest, observedThrough: update.id)
            }
            // A Mac-style tree: memory state, memory overlay; only the update control is durable.
            let first = try await placeInMemory(tree: tree, transport: transport)
            let stopped = try UpdateCoordinator(
                workingTree: first,
                transport: transport,
                stateRoot: root,
                publicationDelay: .seconds(30),
                publicationMaxDelay: .seconds(60)
            )
            let provider = WorkingTreeProvider(workingTree: first) { admission in try await stopped.syncImmediately(admission) }
            let session = try await provider.openDocument(.init(tree: TreeID(rawValue: tree), path: "/note", stableKey: markdownStableKey("pg_note")))
            try await admitAppend(session, "Lost with the process\n")
            try await waitForHead(root: root, workingTree: first)
            let editedRoot = try await first.heads().materializedRoot
            #expect(try UpdateControlFiles(root: root).load().head?.root == editedRoot)
            await stopped.close()
            await first.close()

            // Relaunch: the tree is re-seeded from Canopy's current state.
            let second = try await placeInMemory(tree: tree, transport: transport)
            #expect(try await second.heads().materializedRoot == initial.root)
            let resumed = try UpdateCoordinator(workingTree: second, transport: transport, stateRoot: root)
            let result = try await resumed.syncOnce()
            #expect(result.state == .current)
            #expect(await transport.requests.count == 1)
            #expect(try await second.heads().materializedRoot == editedRoot)
            #expect(try await second.heads().acceptedUpdate == "up_reseed")
            #expect(try await second.heads().pendingRoot == nil)
            let control = try UpdateControlFiles(root: root).load()
            #expect(control.attempt == nil && control.head == nil && control.nextBase == nil)
            _ = try await resumed.syncOnce()
            #expect(await transport.requests.count == 1)
        }
    }

    @Test("A Mac save is not acknowledged when head persistence fails, and flush retries the exact edit")
    func failedHeadPersistenceIsNotAcknowledged() async throws {
        try await withTemporaryRoot { root in
            let tree = "tr_disk_failure"
            let initial = try snapshot(markdown: "---\nid: pg_note\n---\n\n# Note\n\nBase\n")
            let transport = ClosureTransport(initial: initial) { _, _ in
                throw ArborWireValidationError.invalidValue("Offline test must not upload")
            }
            let workingTree = try await placeInMemory(tree: tree, transport: transport)
            let coordinator = try UpdateCoordinator(workingTree: workingTree, transport: transport,
                                                    stateRoot: root, transportAvailable: false)
            let files = try UpdateControlFiles(root: root)
            // A directory at the destination forces the atomic rename to fail.
            try FileManager.default.createDirectory(at: files.controlURL, withIntermediateDirectories: true)
            let provider = WorkingTreeProvider(workingTree: workingTree) { admission in
                try await coordinator.syncImmediately(admission)
            }
            let session = try await provider.openDocument(.init(tree: TreeID(rawValue: tree), path: "/note"))
            await #expect(throws: (any Error).self) { try await admitAppend(session, "Retain offline\n") }
            #expect(try await session.snapshot().source.contains("Retain offline"))
            await #expect(throws: (any Error).self) { try await session.flush() }
            try FileManager.default.removeItem(at: files.controlURL)
            try await session.flush()
            // No polling: returning from flush is the disk durability boundary.
            let head = try #require(try files.load().head)
            #expect(head.root == (try await workingTree.heads()).materializedRoot)
            #expect(await transport.requests.isEmpty)
            await coordinator.close()
        }
    }

    @Test("A source admission also persists a Mac head before returning")
    func sourceAdmissionDurability() async throws {
        try await withTemporaryRoot { root in
            let tree = "tr_source_durable"
            let initial = try snapshot(markdown: "---\nid: pg_note\n---\n\n# Note\n\nBase\n")
            let transport = ClosureTransport(initial: initial) { _, _ in
                throw ArborWireValidationError.invalidValue("Offline test must not upload")
            }
            let workingTree = try await placeInMemory(tree: tree, transport: transport)
            let coordinator = try UpdateCoordinator(workingTree: workingTree, transport: transport,
                                                    stateRoot: root, transportAvailable: false)
            let provider = WorkingTreeProvider(workingTree: workingTree) { admission in
                try await coordinator.syncImmediately(admission)
            }
            let session = try await provider.openDocument(.init(tree: TreeID(rawValue: tree), path: "/note"))
            let base = try await session.snapshot()
            _ = try await session.admit(source: base.source + "Offline source edit\n", baseContentRevision: base.contentRevision)
            #expect(try UpdateControlFiles(root: root).load().head?.root == (try await workingTree.heads()).materializedRoot)
            #expect(await transport.requests.isEmpty)
            await coordinator.close()
        }
    }

    @Test("Candidate envelopes come from the overlay only; platform-served files are never packed or fetched")
    func sparseCandidateFromOverlay() async throws {
        let tree = "tr_sparse"
        let note = try WireObjectCodec.object(.file(Data("---\nid: pg_note\n---\n\n# Note\n\nBase\n".utf8)))
        let photo = try WireObjectCodec.object(.file(Data(repeating: 0xab, count: 4_096)))
        let rootDirectory = try WireObjectCodec.object(.directory([
            .init(name: "note.md", file: note.hash),
            .init(name: "photo.bin", file: photo.hash),
        ]))
        let complete = WireSnapshot(root: rootDirectory.hash, objects: [rootDirectory, note, photo].sorted { $0.hash < $1.hash })
        let spine = WireSnapshot(root: rootDirectory.hash, objects: [rootDirectory, note].sorted { $0.hash < $1.hash })
        let platform = CountingObjectStore(objects: [photo.hash: photo.bytes])
        let overlay = InMemoryObjectOverlay()
        let workingTree = try await WorkingTree.open(store: InMemoryWorkingTreeStore(), overlay: overlay, platform: platform, tree: TreeID(rawValue: tree))
        try await workingTree.initializeFromSystem(try SnapshotBridge.replacement(
            snapshot: spine,
            tree: TreeID(rawValue: tree),
            update: "up_initial",
            mode: .sparseFiles
        ))
        let transport = ClosureTransport(initial: complete) { prepared, _ in
            let request = try JSONDecoder().decode(WireUpdateRequest.self, from: prepared.body)
            let candidate = try completeCandidate(request, retained: complete)
            let update = accepted(id: "up_sparse", tree: tree, root: candidate.root, base: complete.root, candidate: candidate.root)
            return WireUpdateResponse(result: .accepted(update), requestDigest: prepared.requestDigest, observedThrough: update.id)
        }
        try await withTemporaryRoot { root in
            let coordinator = try UpdateCoordinator(workingTree: workingTree, transport: transport, stateRoot: root)
            let session = try await WorkingTreeProvider(workingTree: workingTree).openDocument(.init(tree: TreeID(rawValue: tree), path: "/note", stableKey: markdownStableKey("pg_note")))
            let base = try await session.snapshot()
            _ = try await session.admit(source: base.source + "Sparse\n", baseContentRevision: base.contentRevision)
            let held = try overlay.hashes()
            #expect(try await coordinator.syncOnce().state == .current)
            let request = try JSONDecoder().decode(WireUpdateRequest.self, from: try #require(await transport.requests.first).body)
            let sent = Set(request.objects.map(\.hash))
            #expect(!sent.isEmpty)
            #expect(sent.isSubset(of: held))
            #expect(!sent.contains(photo.hash))
            #expect(await platform.fetches == 0)
            #expect(try await workingTree.heads().pendingRoot == nil)
        }
    }

    @Test("A reconciliation delta fetches its base through the object store exactly once")
    func deltaBaseFetchedOnce() async throws {
        let tree = "tr_delta"
        let note = try WireObjectCodec.object(.file(Data("---\nid: pg_note\n---\n\n# Note\n\nBase\n".utf8)))
        let photo = try WireObjectCodec.object(.file(Data(repeating: 0x01, count: 2_048)))
        let rootDirectory = try WireObjectCodec.object(.directory([
            .init(name: "note.md", file: note.hash),
            .init(name: "photo.bin", file: photo.hash),
        ]))
        let spine = WireSnapshot(root: rootDirectory.hash, objects: [rootDirectory, note].sorted { $0.hash < $1.hash })
        let platform = CountingObjectStore(objects: [photo.hash: photo.bytes])
        let workingTree = try await WorkingTree.open(store: InMemoryWorkingTreeStore(), overlay: InMemoryObjectOverlay(), platform: platform, tree: TreeID(rawValue: tree))
        try await workingTree.initializeFromSystem(try SnapshotBridge.replacement(
            snapshot: spine,
            tree: TreeID(rawValue: tree),
            update: "up_initial",
            mode: .sparseFiles
        ))
        // The remote side replaced the photo; Canopy expresses it as a delta against the retained base.
        let photo2 = try WireObjectCodec.object(.file(Data(repeating: 0x02, count: 2_048)))
        let delta = try WireObjectDelta(base: photo.hash, result: photo2.hash, instructions: [.insert(photo2.bytes)]).validated()
        let transport = ClosureTransport(initial: spine) { prepared, _ in
            let request = try JSONDecoder().decode(WireUpdateRequest.self, from: prepared.body)
            let localNote = try #require(request.objects.first { $0.hash != request.candidate })
            let mergedRoot = try WireObjectCodec.object(.directory([
                .init(name: "note.md", file: localNote.hash),
                .init(name: "photo.bin", file: photo2.hash),
            ]))

            let update = WireAcceptedUpdate(
                id: "up_merged", tree: tree, root: mergedRoot.hash, previous: .init(id: "up_initial", root: rootDirectory.hash),
                acceptedAt: 1_800_000_000_000
            )
            return WireUpdateResponse(
                result: .accepted(update),
                requestDigest: prepared.requestDigest,
                reconciliation: WireTransitionPayload(objects: [mergedRoot], deltas: [delta]),
                observedThrough: update.id
            )
        }
        try await withTemporaryRoot { root in
            let coordinator = try UpdateCoordinator(workingTree: workingTree, transport: transport, stateRoot: root)
            let reference = WorkspaceReference(tree: TreeID(rawValue: tree), path: "/note", stableKey: markdownStableKey("pg_note"))
            let session = try await WorkingTreeProvider(workingTree: workingTree).openDocument(reference)
            let base = try await session.snapshot()
            _ = try await session.admit(source: base.source + "Local\n", baseContentRevision: base.contentRevision)
            #expect(try await coordinator.syncOnce().state == .current)
            #expect(await platform.fetches == 1)
            #expect(await platform.fetched == [photo.hash])
            #expect(try await workingTree.heads().acceptedUpdate == "up_merged")
            let bytes = try await WorkingTreeProvider(workingTree: workingTree).readFile(.init(tree: TreeID(rawValue: tree), path: "/photo.bin"))
            #expect(bytes == Data(repeating: 0x02, count: 2_048))
            #expect(await platform.fetches == 1)
        }
    }

    @Test("Resubmission reads envelopes from the persisted attempt: wiping the overlay between prepare and resend changes nothing")
    func overlayWipedBetweenPrepareAndResend() async throws {
        let tree = "tr_gc"
        let initial = try snapshot(markdown: "---\nid: pg_note\n---\n\n# Note\n\nBase\n")
        let overlay = InMemoryObjectOverlay()
        let transport = ClosureTransport(initial: initial) { prepared, call in
            if call == 1 { throw URLError(.networkConnectionLost) }
            let request = try JSONDecoder().decode(WireUpdateRequest.self, from: prepared.body)
            let candidate = try completeCandidate(request, retained: initial)
            let update = accepted(id: "up_gc", tree: tree, root: candidate.root, base: initial.root, candidate: candidate.root)
            return WireUpdateResponse(result: .accepted(update), requestDigest: prepared.requestDigest, observedThrough: update.id)
        }
        let workingTree = try await WorkingTree.open(store: InMemoryWorkingTreeStore(), overlay: overlay, tree: TreeID(rawValue: tree))
        try await workingTree.initializeFromSystem(try SnapshotBridge.replacement(snapshot: initial, tree: TreeID(rawValue: tree), update: "up_initial"))
        try await withTemporaryRoot { root in
            let coordinator = try UpdateCoordinator(workingTree: workingTree, transport: transport, stateRoot: root)
            let provider = WorkingTreeProvider(workingTree: workingTree)
            let imported = try await provider.importFile(name: "asset.bin", bytes: Data(repeating: 0x7f, count: 1_024), in: .init(tree: TreeID(rawValue: tree), path: "/"))
            _ = imported
            let assetHash = try WireObjectCodec.object(.file(Data(repeating: 0x7f, count: 1_024))).hash
            #expect(overlay.contains(assetHash))
            await #expect(throws: URLError.self) { _ = try await coordinator.syncOnce() }
            #expect(await coordinator.syncState.kind == "offline")
            let prepared = try #require(await transport.requests.first)
            #expect(try JSONDecoder().decode(WireUpdateRequest.self, from: prepared.body).objects.contains { $0.hash == assetHash })

            // A collection that keeps nothing: the request in flight must not notice.
            try overlay.retain(reachableFrom: [])
            #expect(!overlay.contains(assetHash))
            #expect(try overlay.hashes().isEmpty)

            await coordinator.setTransportAvailable(false)
            await coordinator.setTransportAvailable(true)
            let requests = await transport.requests
            #expect(requests.count == 2)
            #expect(requests[0].body == requests[1].body)
            #expect(requests[0].requestDigests == requests[1].requestDigests)
            #expect(try await workingTree.heads().pendingRoot == nil)
            #expect(await coordinator.syncState.kind == "current")
        }
    }
}

/// Append `text` through a patch admission (the path that reaches the coordinator).
private func admitAppend(_ session: any WorkspaceDocumentSession, _ text: String) async throws {
    let current = try await session.snapshot()
    let end = Data(current.source.utf8).count
    _ = try await session.admit(patch: WorkspaceDocumentPatch(
        baseContentRevision: current.contentRevision,
        edits: [WorkspaceSourceEdit(utf8Range: end..<end, replacement: text)]
    ))
}

/// Wait for the durable head to name the tree's materialized root.
private func waitForHead(root: URL, workingTree: WorkingTree) async throws {
    let expected = try await workingTree.heads().materializedRoot
    for _ in 0..<300 where (try? UpdateControlFiles(root: root).load().head?.root) != expected {
        try await Task.sleep(for: .milliseconds(10))
    }
}

/// A platform object store that counts what the working tree asks it for.
private actor CountingObjectStore: ObjectStore {
    let objects: [String: Data]
    private(set) var fetches = 0
    private(set) var fetched: [String] = []

    init(objects: [String: Data]) { self.objects = objects }

    func bytes(_ hash: String) async throws -> Data {
        fetches += 1
        fetched.append(hash)
        guard let bytes = objects[hash] else { throw ObjectStoreError.missing(hash) }
        return bytes
    }
}

/// Records what a live transport was asked to submit.
private actor RecordingTransport: UpdateTransport {
    let inner: any UpdateTransport
    private(set) var requests: [PreparedWireUpdate] = []

    init(_ inner: any UpdateTransport) { self.inner = inner }

    func submit(_ prepared: PreparedWireUpdate) async throws -> WireUpdateResponse {
        requests.append(prepared)
        return try await inner.submit(prepared)
    }

    func descriptor(tree: String) async throws -> WireCurrentTree { try await inner.descriptor(tree: tree) }
    func snapshot(tree: String, root: String) async throws -> WireSnapshot { try await inner.snapshot(tree: tree, root: root) }
}

private func placeInMemory(tree: String, transport: any UpdateTransport) async throws -> WorkingTree {
    let current = try await transport.descriptor(tree: tree)
    let snapshot = try await transport.snapshot(tree: tree, root: current.tree.root)
    let workingTree = try await WorkingTree.inMemory(tree: TreeID(rawValue: tree))
    try await workingTree.initializeFromSystem(try SnapshotBridge.replacement(
        snapshot: snapshot,
        tree: TreeID(rawValue: tree),
        update: current.tree.update,
        cursor: current.observedThrough
    ))
    return workingTree
}

@Suite("Live native peers", .serialized)
struct LiveNativePeerTests {
    @Test("Two Swift replicas converge through the temporary server")
    func twoReplicas() async throws {
        guard let originValue = ProcessInfo.processInfo.environment["ARBOR_WIRE_TEST_URL"],
              let origin = URL(string: originValue),
              let token = ProcessInfo.processInfo.environment["ARBOR_WIRE_TEST_TOKEN"],
              let treeID = ProcessInfo.processInfo.environment["ARBOR_WIRE_TEST_TREE"] else { return }
        try await withTemporaryRoot { root in
            let client = ArborWireClient(origin: origin, credential: token, retryDelay: { _ in })
            let tree = try await client.descriptor(tree: treeID).tree
            let transport = RecordingTransport(ArborWireReplicaTransport(client: client))
            let mac = try await placeWorkingTree(
                tree: tree,
                at: root.appending(path: "mac"),
                transport: transport
            )
            let tablet = try await placeWorkingTree(
                tree: tree,
                at: root.appending(path: "tablet"),
                transport: transport
            )
            let reference = WorkspaceReference(tree: TreeID(rawValue: tree.id), path: "/note", stableKey: markdownStableKey("pg_note"))
            let macSession = try await WorkingTreeProvider(workingTree: mac).openDocument(reference)
            let tabletSession = try await WorkingTreeProvider(workingTree: tablet).openDocument(reference)
            let macBase = try await macSession.snapshot()
            let tabletBase = try await tabletSession.snapshot()
            _ = try await macSession.admit(source: macBase.source + "Mac addition\n", baseContentRevision: macBase.contentRevision)
            _ = try await tabletSession.admit(source: tabletBase.source + "Tablet addition\n", baseContentRevision: tabletBase.contentRevision)

            let macSync = try UpdateCoordinator(workingTree: mac, transport: transport, stateRoot: root.appending(path: "mac-state"))
            let tabletSync = try UpdateCoordinator(workingTree: tablet, transport: transport, stateRoot: root.appending(path: "tablet-state"))
            _ = try await macSync.syncOnce()
            let merged = try await tabletSync.syncOnce()
            #expect(merged.state == .current || merged.state == .autoMerged)
            _ = try await macSync.syncOnce()

            let remote = try await client.descriptor(tree: tree.id).tree
            #expect(try await mac.heads().materializedRoot == remote.root)
            #expect(try await tablet.heads().materializedRoot == remote.root)
            let source = (try await macSession.snapshot()).source
            #expect(source.contains("Mac addition"))
            #expect(source.contains("Tablet addition"))
            // Every body is sparse: only objects the base does not retain travel.
            let total = (try await mac.currentSnapshot()).objects.count
            for prepared in await transport.requests {
                let request = try JSONDecoder().decode(WireUpdateRequest.self, from: prepared.body)
                #expect(request.updates.allSatisfy { $0.objects.count < total })
            }
        }
    }
}

private func snapshot(markdown: String) throws -> WireSnapshot {
    let file = try WireObjectCodec.object(.file(Data(markdown.utf8)))
    let root = try WireObjectCodec.object(.directory([.init(name: "note.md", file: file.hash)]))
    return WireSnapshot(root: root.hash, objects: [file, root].sorted { $0.hash < $1.hash })
}

private func snapshot(files: [String: String]) throws -> WireSnapshot {
    var objects: [WireObjectEnvelope] = []
    let entries = try files.keys.sorted { $0.utf8.lexicographicallyPrecedes($1.utf8) }.map { name in
        let file = try WireObjectCodec.object(.file(Data(files[name, default: ""].utf8)))
        objects.append(file)
        return WireDirectoryEntry(name: name, file: file.hash)
    }
    let root = try WireObjectCodec.object(.directory(entries))
    objects.append(root)
    return WireSnapshot(root: root.hash, objects: objects.sorted { $0.hash < $1.hash })
}

private func directoryBodySnapshot(
    stem: String,
    siblingSource: String,
    indexSource: String? = nil
) throws -> WireSnapshot {
    let child = try WireObjectCodec.object(.file(Data("# Child\n".utf8)))
    var directoryEntries = [WireDirectoryEntry(name: "child.md", file: child.hash)]
    var objects = [child]
    if let indexSource {
        let index = try WireObjectCodec.object(.file(Data(indexSource.utf8)))
        directoryEntries.append(.init(name: "_index.md", file: index.hash))
        objects.append(index)
    }
    directoryEntries.sort { $0.name.utf8.lexicographicallyPrecedes($1.name.utf8) }
    let directory = try WireObjectCodec.object(.directory(directoryEntries))
    let sibling = try WireObjectCodec.object(.file(Data(siblingSource.utf8)))
    let root = try WireObjectCodec.object(.directory([
        .init(name: stem, directory: directory.hash),
        .init(name: stem + ".md", file: sibling.hash),
    ]))
    objects.append(contentsOf: [directory, sibling, root])
    return WireSnapshot(root: root.hash, objects: objects.sorted { $0.hash < $1.hash })
}

private func wireDirectoryEntries(snapshot: WireSnapshot, directory hash: String) throws -> [WireDirectoryEntry] {
    let envelope = try #require(snapshot.objects.first { $0.hash == hash })
    guard case let .directory(entries, _) = try WireObjectCodec.decode(envelope.bytes, kind: .directory) else {
        throw ArborWireValidationError.invalidValue("Expected directory object")
    }
    return entries
}

private func wireEntryNames(snapshot: WireSnapshot, directory hash: String) throws -> Set<String> {
    Set(try wireDirectoryEntries(snapshot: snapshot, directory: hash).map(\.name))
}

private func wireDirectoryEntries(snapshot: WorkingTreeSnapshot, directory hash: String) throws -> [WireDirectoryEntry] {
    let object = try #require(snapshot.objects.first { $0.hash == hash })
    guard case let .directory(entries, _) = try WireObjectCodec.decode(try #require(object.bytes), kind: .directory) else {
        throw ArborWireValidationError.invalidValue("Expected directory object")
    }
    return entries
}

private func wireEntryNames(snapshot: WorkingTreeSnapshot, directory hash: String) throws -> Set<String> {
    Set(try wireDirectoryEntries(snapshot: snapshot, directory: hash).map(\.name))
}

private func completeCandidate(_ request: WireUpdateRequest, retained: WireSnapshot) throws -> WireSnapshot {
    var envelopes = Dictionary(uniqueKeysWithValues: retained.objects.map { ($0.hash, $0) })
    for object in request.objects { envelopes[object.hash] = object }
    var pending = [(request.candidate, WireEntryKind.directory)]
    var visited = Set<String>()
    var objects: [WireObjectEnvelope] = []
    while let (hash, kind) = pending.popLast() {
        if !visited.insert(hash).inserted { continue }
        let envelope = try #require(envelopes[hash])
        objects.append(envelope)
        if case let .directory(entries, _) = try WireObjectCodec.decode(envelope.bytes, kind: kind) {
            for entry in entries {
                if let hash = entry.hash, let kind = entry.kind { pending.append((hash, kind)) }
            }
        }
    }
    return WireSnapshot(root: request.candidate, objects: objects.sorted { $0.hash < $1.hash })
}

private func descriptor(tree: String, snapshot: WireSnapshot, update: String) -> WireTreeDescriptor {
    WireTreeDescriptor(
        id: tree,
        kind: "ordinary",
        root: snapshot.root,
        access: "write",
        canonical: WireCanonicalDescriptor(
            path: "/~owner/\(tree)",
            endpoint: "https://arbor.example"
        ),
        update: update
    )
}

private func accepted(id: String, tree: String, root: String, base: String, candidate: String) -> WireAcceptedUpdate {
    WireAcceptedUpdate(
        id: id,
        tree: tree,
        root: root,
        previous: .init(id: "up_initial", root: base),
        acceptedAt: 1_800_000_000_000
    )
}

/// Test-local placement: install the transport's current complete snapshot as
/// the accepted base of a fresh durable working tree (what the app's
/// `WorkingTreePlacementService` in `OverstoryClient` does).
private func placeWorkingTree(
    tree: WireTreeDescriptor,
    at root: URL,
    transport: any UpdateTransport,
    platform: any ObjectStore = EmptyObjectStore()
) async throws -> WorkingTree {
    let current = try await transport.descriptor(tree: tree.id)
    let snapshot = try await transport.snapshot(tree: tree.id, root: current.tree.root)
    let workingTree = try await WorkingTree.open(at: root, tree: TreeID(rawValue: tree.id), platform: platform)
    let replacement = try SnapshotBridge.replacement(
        snapshot: snapshot,
        tree: TreeID(rawValue: tree.id),
        update: current.tree.update,
        cursor: current.observedThrough
    )
    try await workingTree.initializeFromSystem(replacement)
    return workingTree
}

private func withTemporaryRoot(_ body: (URL) async throws -> Void) async throws {
    let root = FileManager.default.temporaryDirectory.appending(path: "arbor-sync-\(UUID().uuidString)", directoryHint: .isDirectory)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    try await body(root)
}

private actor SourceModeTransport: UpdateTransport {
    let initial: WireSnapshot
    let peer: WireSnapshot
    let gate: FirstRequestGate?
    var received: [PreparedWireUpdate] = []
    var receipts: [String: WireUpdateElementResult] = [:]
    var snapshots: [String: WireSnapshot]
    var current: WireSnapshot
    var currentID = "up_peer"
    init(initial: WireSnapshot, peer: WireSnapshot, gate: FirstRequestGate? = nil) {
        self.initial = initial; self.peer = peer; self.gate = gate; current = peer
        snapshots = [initial.root: initial]; snapshots[peer.root] = peer
    }
    func submit(_ prepared: PreparedWireUpdate) async throws -> WireUpdateResponse {
        received.append(prepared)
        if received.count == 1, let gate { await gate.hold() }
        let request = try JSONDecoder().decode(WireUpdateRequest.self, from: prepared.body)
        #expect(request.base == "up_initial")
        var candidate = initial
        var results: [WireUpdateElementResult] = []
        for (index, element) in request.updates.enumerated() {
            #expect(element.trace?.allSatisfy { $0.operations.allSatisfy { $0.kind == "editSource" } } == true)
            // Like Canopy's immutable store, retain earlier authored candidates
            // even when their accepted projection selected the peer's bytes.
            candidate = try snapshots[element.candidate] ?? completeCandidate(WireUpdateRequest(base: request.base, updates: [element]), retained: candidate)
            snapshots[candidate.root] = candidate
            let digest = prepared.requestDigests[index]
            if let receipt = receipts[digest] { results.append(receipt); continue }
            let selected = receipts.isEmpty ? peer : candidate
            let update = WireAcceptedUpdate(id: "up_source_\(receipts.count)", tree: "tr_source_sessions", root: selected.root,
                previous: .init(id: currentID, root: current.root), acceptedAt: 1_800_000_000_000, conflicted: true)
            let result = WireUpdateElementResult(result: .accepted(update), requestDigest: digest,
                reconciliation: selected.root == candidate.root ? nil : .init(objects: selected.objects))
            receipts[digest] = result; results.append(result)
            current = selected; currentID = update.id
        }
        return WireUpdateResponse(results: results, observedThrough: "cursor_\(currentID)")
    }
    func descriptor(tree: String) throws -> WireCurrentTree {
        WireCurrentTree(tree: WireTreeDescriptor(id: tree, kind: "ordinary", root: current.root, access: "write",
            canonical: nil, update: currentID, conflicted: !receipts.isEmpty), observedThrough: "cursor_\(currentID)")
    }
    func advanceIdentity() { currentID = "up_later" }
    func snapshot(tree: String, root: String) throws -> WireSnapshot {
        guard let value = snapshots[root] else { throw UpdateError.returnedSnapshotMissing }
        return value
    }
}

@Suite("Source session publication")
struct SourceSessionPublicationTests {
    let treeID: TreeID = "tr_source_sessions"
    func makeTree(_ snapshot: WireSnapshot, update: String) async throws -> WorkingTree {
        let tree = try await WorkingTree.inMemory(tree: treeID)
        try await tree.initializeFromSystem(SnapshotBridge.replacement(snapshot: snapshot, tree: treeID, update: update))
        return tree
    }
    func replace(_ source: String, session: any WorkspaceDocumentSession, basis: WorkspaceDocumentSnapshot) async throws -> WorkspaceDocumentSnapshot {
        try await session.admit(intent: .init(basis: basis, patch: .init(baseContentRevision: basis.contentRevision,
            edits: [.init(utf8Range: 0..<basis.source.utf8.count, replacement: source, expected: basis.source)]), source: source))
    }

    @Test("R1 admission after an R2 watch stays durable and a hidden-candidate successor publishes normally")
    func staleAndSuccessor() async throws {
        try await withTemporaryRoot { root in
            let initial = try snapshot(markdown: "Before\n"), peer = try snapshot(markdown: "Peer\n")
            let gate = FirstRequestGate(), transport = SourceModeTransport(initial: initial, peer: peer, gate: gate)
            let tree = try await makeTree(initial, update: "up_initial")
            let coordinator = try UpdateCoordinator(workingTree: tree, transport: transport, stateRoot: root,
                sourceOperationEmission: true, publicationDelay: .seconds(3600), publicationMaxDelay: .seconds(3600))
            let provider = WorkingTreeProvider(workingTree: tree, sourceCoordinator: coordinator)
            let session = try await provider.openDocument(.init(tree: treeID, path: "/note"))
            let r1 = try await session.snapshot()
            try await tree.replaceFromSystem(SnapshotBridge.replacement(snapshot: peer, tree: treeID, update: "up_peer"))
            let mine = try await replace("Mine\n", session: session, basis: r1)
            #expect(try await session.snapshot().source == "Mine\n")
            #expect(try await tree.heads().acceptedRoot == peer.root)
            let publishing = Task { try await coordinator.syncOnce() }
            for _ in 0..<500 where !(await gate.waiting) { try await Task.sleep(for: .milliseconds(1)) }
            #expect(await gate.waiting)
            _ = try await replace("Mine again\n", session: session, basis: mine)
            let secondSession = try await provider.openDocument(.init(tree: treeID, path: "/note"))
            #expect(try await secondSession.snapshot().source == "Mine again\n")
            await gate.release()
            let state = try await publishing.value
            #expect(state.acceptedConflicted == true)
            #expect(try await session.snapshot().source == "Mine again\n")
            #expect(try await coordinator.presentation().state == .current)
            let requests = await transport.received
            #expect(requests.count == 2)
            #expect(requests[0].requestDigests.first == requests[1].requestDigests.first)
            let second = try JSONDecoder().decode(WireUpdateRequest.self, from: requests[1].body)
            #expect(second.updates.count == 2)
            #expect(second.updates[0].objects.isEmpty)
            #expect(second.updates[0].deltas.isEmpty)
            #expect(!second.updates[1].objects.isEmpty)
            #expect(try await tree.heads().acceptedRoot == second.updates.last?.candidate)
            await coordinator.close(); await session.close(); await secondSession.close(); await tree.close()
        }
    }

    @Test("Unsent successors batch behind an immutable in-flight source request")
    func batchedSuccessors() async throws {
        try await withTemporaryRoot { root in
            let initial = try snapshot(markdown: "Before\n")
            let gate = FirstRequestGate(), transport = SourceModeTransport(initial: initial, peer: initial, gate: gate)
            let tree = try await makeTree(initial, update: "up_initial")
            let coordinator = try UpdateCoordinator(workingTree: tree, transport: transport, stateRoot: root,
                sourceOperationEmission: true, publicationDelay: .seconds(3600), publicationMaxDelay: .seconds(3600))
            let provider = WorkingTreeProvider(workingTree: tree, sourceCoordinator: coordinator)
            let session = try await provider.openDocument(.init(tree: treeID, path: "/note"))
            let basis = try await session.snapshot()
            var local = try await replace("First\n", session: session, basis: basis)
            let publishing = Task { try await coordinator.syncOnce() }
            for _ in 0..<500 where !(await gate.waiting) { try await Task.sleep(for: .milliseconds(1)) }
            #expect(await gate.waiting)
            for text in ["Second\n", "Third\n", "Fourth\n"] {
                local = try await replace(text, session: session, basis: local)
            }
            #expect(await transport.received.count == 1)
            await gate.release()
            _ = try await publishing.value
            let requests = await transport.received
            #expect(requests.count == 2)
            let batch = try JSONDecoder().decode(WireUpdateRequest.self, from: requests[1].body)
            #expect(batch.updates.count == 4)
            #expect(requests[0].requestDigests.first == requests[1].requestDigests.first)
            #expect(batch.updates.first?.objects.isEmpty == true)
            #expect(try await session.snapshot().source == "Fourth\n")
            #expect(try await coordinator.presentation().state == .current)
            await coordinator.close(); await session.close(); await tree.close()
        }
    }

    @Test("Concurrent admission retries retain one identity and a legacy client cannot ignore the journal")
    func concurrentRetryAndModeGate() async throws {
        try await withTemporaryRoot { root in
            let initial = try snapshot(markdown: "Before\n")
            let tree = try await makeTree(initial, update: "up_initial")
            let transport = SourceModeTransport(initial: initial, peer: initial)
            let coordinator = try UpdateCoordinator(workingTree: tree, transport: transport, stateRoot: root,
                sourceOperationEmission: true, publicationDelay: .seconds(3600), publicationMaxDelay: .seconds(3600))
            let basis = try await coordinator.sourceSnapshot(.init(tree: treeID, path: "/note"))
            let intent = try WorkspaceDocumentIntent(basis: basis, patch: .init(baseContentRevision: basis.contentRevision,
                edits: [.init(utf8Range: 0..<basis.source.utf8.count, replacement: "Mine\n", expected: basis.source)]), source: "Mine\n")
            async let first = coordinator.admitSourceIntent(intent)
            async let second = coordinator.admitSourceIntent(intent)
            let (a, b) = try await (first, second)
            #expect(a.contentRevision == b.contentRevision)
            let queue = try await SourceAdmissionQueue(tree: treeID.rawValue, stateRoot: root)
            #expect(try await queue.retained().count == 1)
            await coordinator.close()
            #expect(throws: (any Error).self) {
                _ = try UpdateCoordinator(workingTree: tree, transport: transport, stateRoot: root)
            }
            #expect(try await queue.retained().count == 1)
            await tree.close()
        }
    }

    @Test("Replaying an accepted receipt catches up to a later equal-root accepted identity")
    func replayCatchesUp() async throws {
        try await withTemporaryRoot { root in
            let initial = try snapshot(markdown: "Before\n"), peer = try snapshot(markdown: "Peer\n")
            let tree = try await makeTree(initial, update: "up_initial")
            let transport = SourceModeTransport(initial: initial, peer: peer)
            let coordinator = try UpdateCoordinator(workingTree: tree, transport: transport, stateRoot: root,
                sourceOperationEmission: true, faultInjector: OnePointFault(point: .afterServerAcceptance),
                publicationDelay: .seconds(3600), publicationMaxDelay: .seconds(3600))
            let provider = WorkingTreeProvider(workingTree: tree, sourceCoordinator: coordinator)
            #expect(await provider.capabilities().structuralActions == true)
            #expect(try await tree.heads().pendingRoot == nil)
            let session = try await provider.openDocument(.init(tree: treeID, path: "/note"))
            _ = try await replace("Mine\n", session: session, basis: session.snapshot())
            do { _ = try await coordinator.syncOnce(); Issue.record("Expected injected failure") } catch { }
            await transport.advanceIdentity()
            await coordinator.close(); await session.close()
            let reopened = try UpdateCoordinator(workingTree: tree, transport: transport, stateRoot: root,
                sourceOperationEmission: true, publicationDelay: .seconds(3600), publicationMaxDelay: .seconds(3600))
            _ = try await reopened.syncOnce()
            #expect(try await tree.heads().acceptedUpdate == "up_later")
            #expect(try await reopened.sourceSnapshot(.init(tree: treeID, path: "/note")).source == "Peer\n")
            await reopened.close(); await tree.close()
        }
    }

    @Test("Every publication failure retains exact source work and restart completes acceptance", arguments: UpdateFailurePoint.allCases)
    func sourceRestart(point: UpdateFailurePoint) async throws {
        try await withTemporaryRoot { root in
            let initial = try snapshot(markdown: "Before\n"), peer = try snapshot(markdown: "Peer\n")
            let transport = SourceModeTransport(initial: initial, peer: peer)
            let tree = try await makeTree(initial, update: "up_initial")
            let coordinator = try UpdateCoordinator(workingTree: tree, transport: transport, stateRoot: root,
                sourceOperationEmission: true, faultInjector: OnePointFault(point: point),
                publicationDelay: .seconds(3600), publicationMaxDelay: .seconds(3600))
            let session = try await WorkingTreeProvider(workingTree: tree, sourceCoordinator: coordinator).openDocument(.init(tree: treeID, path: "/note"))
            _ = try await replace("Mine\n", session: session, basis: session.snapshot())
            await #expect(throws: (any Error).self) { try await coordinator.syncOnce() }
            let prior = await transport.received.first
            await coordinator.close(); await tree.close()
            let reopenedTree = try await makeTree(peer, update: "up_peer")
            let reopened = try UpdateCoordinator(workingTree: reopenedTree, transport: transport, stateRoot: root,
                sourceOperationEmission: true, publicationDelay: .seconds(3600), publicationMaxDelay: .seconds(3600))
            let state = try await reopened.syncOnce()
            #expect(state.acceptedConflicted == true)
            #expect(try await reopenedTree.heads().acceptedUpdate == "up_source_0")
            #expect(try await reopened.presentation().state == .current)
            if let prior { #expect(await transport.received.last?.body == prior.body) }
            await reopened.close(); await reopenedTree.close(); await session.close()
        }
    }
}

extension SourceSessionPublicationTests {
    @Test("Structural snapshots and source edits share durable ancestry and pending provider reads")
    func mixedAdmissions() async throws {
        try await withTemporaryRoot { root in
            let initial = try snapshot(markdown: "Before\n")
            let tree = try await makeTree(initial, update: "up_initial")
            let transport = SourceModeTransport(initial: initial, peer: initial)
            let coordinator = try UpdateCoordinator(workingTree: tree, transport: transport, stateRoot: root,
                sourceOperationEmission: true, publicationDelay: .seconds(3600), publicationMaxDelay: .seconds(3600))
            let provider = WorkingTreeProvider(workingTree: tree, sourceCoordinator: coordinator)
            let parent = WorkspaceReference(tree: treeID, path: "/")
            let created = try #require(try await provider.perform(.createMarkdown(parent: parent, name: "created", source: "New\n")))
            let session = try await provider.openDocument(created.reference)
            let basis = try await session.snapshot()
            let changed = basis.source + "More\n"
            _ = try await replace(changed, session: session, basis: basis)
            let directory = try #require(try await provider.perform(.createDirectory(parent: parent, name: "group")))
            let moved = try #require(try await provider.perform(.move(reference: created.reference, destination: directory.reference)))
            #expect(moved.reference.path == "/group/created")
            #expect(try await provider.openDocument(moved.reference).snapshot().source == changed)
            let body = try await provider.openDocument(directory.reference)
            let empty = try await body.snapshot()
            #expect(empty.source.isEmpty)
            _ = try await replace("Directory body\n", session: body, basis: empty)
            let imported = try await provider.importFile(name: "payload.bin", bytes: Data([0, 1, 255]), in: directory.reference)
            #expect(try await provider.readFile(imported.reference) == Data([0, 1, 255]))
            let trashed = try #require(try await provider.perform(.trash(reference: moved.reference)))
            let restored = try #require(try await provider.perform(.restore(reference: trashed.reference)))
            #expect(restored.reference.path == moved.reference.path)
            #expect(try await tree.heads().acceptedRoot == initial.root)
            #expect(try await tree.heads().pendingRoot == nil)
            let queue = try await SourceAdmissionQueue(tree: treeID.rawValue, stateRoot: root)
            let records = try await queue.retained()
            #expect(records.count == 8)
            #expect(records[0].update.trace == nil)
            #expect(records[1].update.trace?.first?.operations.first?.kind == "editSource")
            #expect(records[3].update.trace?.first?.operations.first?.kind == "moveEntry")
            #expect(records[4].update.trace == nil) // New directory material, not a made-up source identity.
            for index in 1..<records.count { #expect(records[index].basis == .authored(change: records[index - 1].change)) }
            await coordinator.close(); await session.close(); await body.close()
            let reopened = try UpdateCoordinator(workingTree: tree, transport: transport, stateRoot: root,
                sourceOperationEmission: true, publicationDelay: .seconds(3600), publicationMaxDelay: .seconds(3600))
            let recovered = WorkingTreeProvider(workingTree: tree, sourceCoordinator: reopened)
            #expect(try await recovered.openDocument(restored.reference).snapshot().source == changed)
            #expect(try await recovered.openDocument(directory.reference).snapshot().source == "Directory body\n")
            #expect(try await recovered.readFile(imported.reference) == Data([0, 1, 255]))
            await reopened.close(); await tree.close()
        }
    }
}

extension SourceSessionPublicationTests {
    @Test("Failed structural retention leaves the projection untouched and retries the same prepared candidate")
    func structuralRetentionFailure() async throws {
        try await withTemporaryRoot { root in
            let initial = try snapshot(markdown: "Before\n"), tree = try await makeTree(initial, update: "up_initial")
            let transport = SourceModeTransport(initial: initial, peer: initial)
            let coordinator = try UpdateCoordinator(workingTree: tree, transport: transport, stateRoot: root,
                sourceOperationEmission: true, publicationDelay: .seconds(3600), publicationMaxDelay: .seconds(3600))
            let provider = WorkingTreeProvider(workingTree: tree, sourceCoordinator: coordinator)
            let action = WorkspaceStructuralAction.createMarkdown(parent: .init(tree: treeID, path: "/"), name: "retained", source: "Exact\r\n")
            let lock = root.appending(path: "sync/source-admissions.lock")
            try FileManager.default.createDirectory(at: lock, withIntermediateDirectories: true)
            do { _ = try await provider.perform(action); Issue.record("Expected retention failure") } catch { }
            #expect(try await tree.heads().acceptedRoot == initial.root)
            #expect(try await tree.heads().pendingRoot == nil)
            let queue = try await SourceAdmissionQueue(tree: treeID.rawValue, stateRoot: root)
            #expect(try await queue.retained().isEmpty)
            try FileManager.default.removeItem(at: lock)
            let created = try #require(try await provider.perform(action))
            #expect(try await queue.retained().count == 1)
            #expect(try await provider.openDocument(created.reference).snapshot().source.hasSuffix("Exact\r\n") == true)
            let readOnly = WorkingTreeProvider(workingTree: tree, readOnly: true, sourceCoordinator: coordinator)
            #expect(try await readOnly.resolve(created.reference).isWritable == false)
            do { _ = try await readOnly.perform(.trash(reference: created.reference)); Issue.record("Read-only source provider mutated") }
            catch is WorkspaceProviderError { }
            await coordinator.close(); await tree.close()
        }
    }
}

extension SourceSessionPublicationTests {
    @Test("Private trashed bytes survive losing the staging tree and are restored from the journal")
    func trashRestart() async throws {
        try await withTemporaryRoot { root in
            let initial = try snapshot(markdown: "Before\n"), tree = try await makeTree(initial, update: "up_initial")
            let transport = SourceModeTransport(initial: initial, peer: initial)
            let coordinator = try UpdateCoordinator(workingTree: tree, transport: transport, stateRoot: root,
                sourceOperationEmission: true, publicationDelay: .seconds(3600), publicationMaxDelay: .seconds(3600))
            let provider = WorkingTreeProvider(workingTree: tree, sourceCoordinator: coordinator)
            let bytes = Data([0, 255, 17])
            let file = try await provider.importFile(name: "private.bin", bytes: bytes, in: .init(tree: treeID, path: "/"))
            let trashed = try #require(try await provider.perform(.trash(reference: file.reference)))
            let records = try await SourceAdmissionQueue(tree: treeID.rawValue, stateRoot: root).retained()
            #expect(records.last?.candidate.root == initial.root)
            #expect(records.last?.localTrash?.objects.contains(where: { $0.bytes == bytes }) == true)
            await coordinator.close(); await tree.close()
            let clean = try await makeTree(initial, update: "up_initial")
            let reopened = try UpdateCoordinator(workingTree: clean, transport: transport, stateRoot: root,
                sourceOperationEmission: true, publicationDelay: .seconds(3600), publicationMaxDelay: .seconds(3600))
            let recovered = WorkingTreeProvider(workingTree: clean, sourceCoordinator: reopened)
            #expect(try await recovered.readFile(trashed.reference) == bytes)
            let restored = try #require(try await recovered.perform(.restore(reference: trashed.reference)))
            #expect(restored.reference.path == "/private.bin")
            #expect(try await recovered.readFile(restored.reference) == bytes)
            await reopened.close(); await clean.close()
        }
    }
}

extension SourceSessionPublicationTests {
    @Test("A stale editor branch keeps pending creations visible and gates structure across restart")
    func branchedAdmissions() async throws {
        try await withTemporaryRoot { root in
            let initial = try snapshot(markdown: "Before\n"), tree = try await makeTree(initial, update: "up_initial")
            let transport = SourceModeTransport(initial: initial, peer: initial)
            let coordinator = try UpdateCoordinator(workingTree: tree, transport: transport, stateRoot: root,
                sourceOperationEmission: true, publicationDelay: .seconds(3600), publicationMaxDelay: .seconds(3600))
            let provider = WorkingTreeProvider(workingTree: tree, sourceCoordinator: coordinator)
            let parent = WorkspaceReference(tree: treeID, path: "/")
            let old = try await provider.openDocument(.init(tree: treeID, path: "/note"))
            let r1 = try await old.snapshot()
            let created = try #require(try await provider.perform(.createMarkdown(parent: parent, name: "created", source: "New\n")))
            let edited = try await replace("Old editor edit\n", session: old, basis: r1)
            #expect(try await provider.children(of: parent).contains { $0.reference.path == created.reference.path })
            #expect(await provider.capabilities().structuralActions == false)
            #expect(await provider.capabilities().assets == false)
            await #expect(throws: UpdateError.awaitingCanopyReconciliation) {
                try await provider.perform(.rename(reference: created.reference, name: "renamed"))
            }
            await #expect(throws: UpdateError.awaitingCanopyReconciliation) {
                try await provider.importFile(name: "blocked.bin", bytes: Data([1]), in: parent)
            }
            await #expect(throws: UpdateError.awaitingCanopyReconciliation) {
                try await provider.store(asset: .init(name: "blocked.bin", bytes: Data([1])), in: parent)
            }
            _ = try await replace("Still editable\n", session: old, basis: edited)
            let added = try await provider.openDocument(created.reference)
            let addedBasis = try await added.snapshot()
            _ = try await replace(addedBasis.source + "More\n", session: added, basis: addedBasis)
            let queue = try await SourceAdmissionQueue(tree: treeID.rawValue, stateRoot: root)
            let records = try await queue.retained()
            #expect(records.count == 4)
            #expect(records[1].basis == .accepted(.init(root: initial.root, update: "up_initial")))
            #expect(records[2].basis == .authored(change: records[1].change))
            #expect(records[3].basis == .authored(change: records[0].change))
            #expect(try await coordinator.presentation().localRoot == records[0].candidate.root)
            await old.close(); await added.close(); await coordinator.close()
            let reopened = try UpdateCoordinator(workingTree: tree, transport: transport, stateRoot: root,
                sourceOperationEmission: true, publicationDelay: .seconds(3600), publicationMaxDelay: .seconds(3600))
            let recovered = WorkingTreeProvider(workingTree: tree, sourceCoordinator: reopened)
            #expect(await recovered.capabilities().structuralActions == false)
            #expect(try await recovered.resolve(created.reference).reference.path == created.reference.path)
            #expect(try await recovered.openDocument(created.reference).snapshot().source == addedBasis.source + "More\n")
            #expect(try await recovered.openDocument(.init(tree: treeID, path: "/note")).snapshot().source == "Still editable\n")
            #expect(try await queue.retained() == records)
            await reopened.close(); await tree.close()
        }
    }

    @Test("A stale source candidate never replaces a newer accepted navigation graph")
    func staleSourceNavigation() async throws {
        try await withTemporaryRoot { root in
            let initial = try snapshot(markdown: "Before\n"), tree = try await makeTree(initial, update: "up_initial")
            let peer = try snapshot(files: ["note.md": "Peer\n", "peer-created.md": "Keep me\n"])
            let coordinator = try UpdateCoordinator(workingTree: tree, transport: SourceModeTransport(initial: initial, peer: peer), stateRoot: root,
                sourceOperationEmission: true, publicationDelay: .seconds(3600), publicationMaxDelay: .seconds(3600))
            let provider = WorkingTreeProvider(workingTree: tree, sourceCoordinator: coordinator)
            let old = try await provider.openDocument(.init(tree: treeID, path: "/note")), r1 = try await old.snapshot()
            try await tree.replaceFromSystem(SnapshotBridge.replacement(snapshot: peer, tree: treeID, update: "up_peer"))
            _ = try await replace("Local\n", session: old, basis: r1)
            #expect(try await provider.resolve(.init(tree: treeID, path: "/peer-created")).reference.path == "/peer-created")
            #expect(try await old.snapshot().source == "Local\n")
            #expect(await provider.capabilities().structuralActions == false)
            #expect(try await coordinator.presentation().localRoot == peer.root)
            await old.close(); await coordinator.close(); await tree.close()
        }
    }
}

extension SourceSessionPublicationTests {
    @Test("Clean snapshot controls activate source admission and source journals never downgrade")
    func releaseSelection() async throws {
        try await withTemporaryRoot { root in
            let initial = try snapshot(markdown: "Before\n"), tree = try await makeTree(initial, update: "up_initial")
            let transport = SourceModeTransport(initial: initial, peer: initial)
            try UpdateControlFiles(root: root).write(UpdateControl())
            let source = try UpdateCoordinator(workingTree: tree, transport: transport, stateRoot: root,
                sourceOperationEmission: true)
            #expect(source.sourceOperationEmission)
            let provider = WorkingTreeProvider(workingTree: tree, sourceCoordinator: source)
            let session = try await provider.openDocument(.init(tree: treeID, path: "/note"))
            #expect(await session.admissionPolicy == .retainedBasis)
            let basis = try await session.snapshot()
            _ = try await replace("Retained\n", session: session, basis: basis)
            await session.close(); await source.close()
            #expect(throws: ArborWireValidationError.self) {
                try UpdateCoordinator(workingTree: tree, transport: transport, stateRoot: root)
            }
            #expect(try await SourceAdmissionQueue(tree: treeID.rawValue, stateRoot: root).retained().count == 1)
            await tree.close()
        }
    }
}

extension SourceSessionPublicationTests {
    @Test("Sibling-body actions retain compound intent and private trash across restart", arguments: [false, true])
    func compoundStructuralAdmissions(shadowed: Bool) async throws {
        try await withTemporaryRoot { root in
            let source = "---\nid: pg_pair\n---\n\n# Café\r\n"
            let initial = try directoryBodySnapshot(stem:"pair",siblingSource:shadowed ? "Shadowed exact bytes\r\n" : source,indexSource:shadowed ? source : nil)
            let tree = try await makeTree(initial,update:"up_initial")
            let transport = SourceModeTransport(initial:initial,peer:initial)
            let coordinator = try UpdateCoordinator(workingTree:tree,transport:transport,stateRoot:root,
                sourceOperationEmission:true,publicationDelay:.seconds(3600),publicationMaxDelay:.seconds(3600))
            let provider = WorkingTreeProvider(workingTree:tree,sourceCoordinator:coordinator)
            let parent = WorkspaceReference(tree:treeID,path:"/")
            let renamed = try #require(try await provider.perform(.rename(reference:.init(tree:treeID,path:"/pair"),name:"renamed")))
            let group = try #require(try await provider.perform(.createDirectory(parent:parent,name:"group")))
            let moved = try #require(try await provider.perform(.move(reference:renamed.reference,destination:group.reference)))
            let copied = try #require(try await provider.perform(.copy(reference:moved.reference,destination:parent)))
            let copiedSource = try await provider.openDocument(copied.reference).snapshot().source
            #expect(copiedSource != source) // Fresh PageID, with copy provenance.
            #expect(copiedSource.hasSuffix("# Café\r\n"))
            let trashed = try #require(try await provider.perform(.trash(reference:moved.reference)))
            let queue = try await SourceAdmissionQueue(tree:treeID.rawValue,stateRoot:root)
            let before = try await queue.retained()
            #expect(before[0].update.trace?.flatMap(\.operations).map(\.kind) == ["moveEntry","moveEntry"])
            #expect(before[2].update.trace?.flatMap(\.operations).map(\.kind) == ["moveEntry","moveEntry"])
            #expect(before[3].update.trace?.flatMap(\.operations).filter { $0.kind == "copyEntry" }.count == 2)
            #expect(before[3].update.trace?.flatMap(\.operations).contains { $0.kind == "editSource" } == true)
            #expect(before[4].update.trace?.flatMap(\.operations).map(\.kind) == ["removeEntry","removeEntry"])
            await coordinator.close(); await tree.close()
            let reopenedTree = try await makeTree(initial,update:"up_initial")
            let reopened = try UpdateCoordinator(workingTree:reopenedTree,transport:transport,stateRoot:root,
                sourceOperationEmission:true,publicationDelay:.seconds(3600),publicationMaxDelay:.seconds(3600))
            let recovered = WorkingTreeProvider(workingTree:reopenedTree,sourceCoordinator:reopened)
            #expect(before.last?.localTrash?.nodes.contains { $0.path == trashed.reference.path && $0.source == source } == true)
            let restored = try #require(try await recovered.perform(.restore(reference:trashed.reference)))
            #expect(restored.reference.path == moved.reference.path)
            #expect(try await recovered.openDocument(restored.reference).snapshot().source == source)
            let after = try await SourceAdmissionQueue(tree:treeID.rawValue,stateRoot:root).retained()
            #expect(Array(after.prefix(before.count)) == before)
            #expect(after.last?.candidate.root == before[3].candidate.root)
            #expect(after.last?.update.trace == nil) // Creation from private Trash.
            await reopened.close(); await reopenedTree.close()
        }
    }
}
