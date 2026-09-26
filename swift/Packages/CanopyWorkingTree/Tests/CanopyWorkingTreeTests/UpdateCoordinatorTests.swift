import CanopyAppKit
import OverstoryObjectStore
@testable import CanopyWorkingTree
@testable import Overstory
import Foundation
import Testing

private actor ClosureTransport: UpdateTransport {
    typealias Submit = @Sendable (PreparedProtocolUpdate, Int) async throws -> ProtocolUpdateResponse
    let initial: ProtocolSnapshot
    private(set) var current: ProtocolSnapshot
    private(set) var snapshots: [String: ProtocolSnapshot]
    private(set) var currentUpdate: String
    private(set) var currentObservedThrough: String
    let submitter: Submit
    /// Serve an accepted candidate as the current tree afterwards, the way Canopy does.
    let advancesCurrentOnAccept: Bool
    private(set) var requests: [PreparedProtocolUpdate] = []
    private(set) var descriptorRequests = 0
    private(set) var snapshotRequests = 0
    private(set) var requestedRoots: [String] = []

    init(
        initial: ProtocolSnapshot,
        current: ProtocolSnapshot? = nil,
        additionalSnapshots: [ProtocolSnapshot] = [],
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

    func submit(_ prepared: PreparedProtocolUpdate) async throws -> ProtocolUpdateResponse {
        requests.append(prepared)
        let response = try await submitter(prepared, requests.count)
        if advancesCurrentOnAccept, let final = response.results.last {
            let request = try JSONDecoder().decode(ProtocolUpdateRequest.self, from: prepared.body)
            var known = current
            for update in request.updates {
                known = try completeCandidate(update, retained: known)
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

    func descriptor(tree: String) async throws -> ProtocolCurrentTree {
        descriptorRequests += 1
        return ProtocolCurrentTree(
            tree: ProtocolTreeDescriptor(
                id: tree,
                kind: "ordinary",
                root: current.root,
                access: "write",
                canonical: ProtocolCanonicalDescriptor(path: "/~owner/\(tree)", endpoint: "https://arbor.example"),
                update: currentUpdate
            ),
            observedThrough: currentObservedThrough
        )
    }

    func snapshot(tree _: String, root: String) async throws -> ProtocolSnapshot {
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
    @Test("Earlier unpublished work is refused without being rewritten; a clean earlier control converts")
    func earlierControlUpgrade() async throws {
        try await withTemporaryRoot { root in
            let tree = "tr_oldrequest"
            let initial = try snapshot(markdown: "# Retained work\n")
            let transport = ClosureTransport(initial: initial) { _, _ in throw URLError(.notConnectedToInternet) }
            let workingTree = try await placeWorkingTree(tree: descriptor(tree:tree,snapshot:initial,update:"up_initial"),at:root.appending(path:"replica"),transport:transport)
            let state = root.appending(path:"state")
            let files = try UpdateControlFiles(root:state)
            // Schema 3 with a snapshot head: unpublished work of the removed snapshot path.
            let earlier = #"{"attempt":null,"head":{"base":{"root":"r","update":"up_initial"},"generation":1,"objects":[],"root":"h"},"presentation":{"localAdditions":false,"remoteAdditions":false,"state":"locallyPending"},"schema":3,"sourceMode":true}"#
            try files.atomicWrite(Data(earlier.utf8), to: files.controlURL)
            let original = try Data(contentsOf:files.controlURL)
            #expect(throws: UpdateError.earlierPendingWork("update-control.json")) {
                try UpdateCoordinator(workingTree:workingTree,transport:transport,stateRoot:state)
            }
            #expect(try Data(contentsOf:files.controlURL) == original)
            #expect(await transport.requests.isEmpty)

            // A clean schema-3 control keeps its settled changes and becomes schema 4.
            let clean = #"{"presentation":{"localAdditions":false,"remoteAdditions":false,"state":"current"},"schema":3,"sourceAcceptedChanges":["c1"],"sourceMode":true}"#
            try files.atomicWrite(Data(clean.utf8), to: files.controlURL)
            let converted = try files.load()
            #expect(converted.settled == ["c1"])
            #expect(converted.schema == UpdateControl.currentSchema)
            _ = try UpdateCoordinator(workingTree:workingTree,transport:transport,stateRoot:state)
        }
    }

    @Test("Native materialization preserves exact protocol collection-file descriptors")
    func collectionFileDescriptorRoundTrip() async throws {
        try await withTemporaryRoot { root in
            let source = try ProtocolObjectCodec.object(.file(Data(#"[{"id":"one"}]"#.utf8)))
            let schema = try ProtocolObjectCodec.object(.file(Data("overstory-schema-version = 1\nrow = { id: tstr }\n".utf8)))
            let descriptor = ProtocolCollectionFileDescriptor(
                format: "json",
                source: "_store.json",
                schemaSource: "schema.cddl",
                schemaFingerprint: "sha256:" + String(repeating: "3", count: 64),
                childSetHash: "sha256:" + String(repeating: "4", count: 64)
            )
            let directory = try ProtocolObjectCodec.object(.directory([
                .init(name: "_store.json", file: source.hash),
                .init(name: "schema.cddl", file: schema.hash),
            ], childrenSource: descriptor))
            let snapshot = ProtocolSnapshot(root: directory.hash, objects: [directory, schema, source])
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
        let note = try ProtocolObjectCodec.object(.file(Data("---\nid: pg_note\n---\n\n# Note\n".utf8)))
        let photo = try ProtocolObjectCodec.object(.file(Data([0xff, 0xd8, 0xff, 0xe0])))
        let clip = try ProtocolObjectCodec.object(.file(Data("not really audio".utf8)))
        let album = try ProtocolObjectCodec.object(.directory([.init(name: "photo.jpg", file: photo.hash)]))
        let root = try ProtocolObjectCodec.object(.directory([
            .init(name: "album", directory: album.hash),
            .init(name: "clip.unknownext", file: clip.hash),
            .init(name: "note.md", file: note.hash),
        ]))
        let tree = TreeID(rawValue: "tr_sparsebridge")
        let full = ProtocolSnapshot(root: root.hash, objects: [root, album, note, photo, clip])
        let spine = ProtocolSnapshot(root: root.hash, objects: [root, album, note])
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
        let rootless = ProtocolSnapshot(root: root.hash, objects: [root, note])
        #expect(throws: ProtocolValidationError.self) {
            _ = try SnapshotBridge.replacement(snapshot: rootless, tree: tree, update: "up_1", mode: .sparseFiles)
        }
        // Markdown must be present in a sparse spine.
        let noMarkdown = ProtocolSnapshot(root: root.hash, objects: [root, album])
        #expect(throws: ProtocolValidationError.self) {
            _ = try SnapshotBridge.replacement(snapshot: noMarkdown, tree: tree, update: "up_1", mode: .sparseFiles)
        }
        // Complete mode requires the omitted file payloads too.
        #expect(throws: ProtocolValidationError.self) {
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
            #expect(try protocolEntryNames(snapshot: snapshot, directory: snapshot.root).isSuperset(of: ["renamed", "renamed.md"]))

            let archive = try #require(try await provider.perform(.createDirectory(parent: rootReference, name: "archive")))
            let moved = try #require(try await provider.perform(.move(reference: renamed.reference, destination: archive.reference)))
            snapshot = try await workingTree.currentSnapshot()
            let rootEntries = try protocolDirectoryEntries(snapshot: snapshot, directory: snapshot.root)
            let archiveHash = try #require(rootEntries.first { $0.name == "archive" }?.hash)
            #expect(try protocolEntryNames(snapshot: snapshot, directory: archiveHash).isSuperset(of: ["renamed", "renamed.md"]))

            _ = try #require(try await provider.perform(.copy(reference: moved.reference, destination: rootReference)))
            snapshot = try await workingTree.currentSnapshot()
            #expect(try protocolEntryNames(snapshot: snapshot, directory: snapshot.root).isSuperset(of: ["renamed", "renamed.md"]))

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
        let markdown = try ProtocolObjectCodec.object(.file(Data("# Markdown\n".utf8)))
        let mdx = try ProtocolObjectCodec.object(.file(Data("# MDX\n".utf8)))
        let directory = try ProtocolObjectCodec.object(.directory([]))
        let root = try ProtocolObjectCodec.object(.directory([
            .init(name: "x", directory: directory.hash),
            .init(name: "x.md", file: markdown.hash),
            .init(name: "x.mdx", file: mdx.hash),
        ]))
        let snapshot = ProtocolSnapshot(root: root.hash, objects: [root, directory, markdown, mdx])

        #expect(throws: ProtocolValidationError.self) {
            _ = try SnapshotBridge.replacement(snapshot: snapshot, tree: "tr_ambiguous", update: "up_initial")
        }

        let plain = try ProtocolObjectCodec.object(.file(Data("plain".utf8)))
        let duplicateRoot = try ProtocolObjectCodec.object(.directory([
            .init(name: "same", file: plain.hash),
            .init(name: "same.md", file: markdown.hash),
        ]))
        let duplicate = ProtocolSnapshot(root: duplicateRoot.hash, objects: [duplicateRoot, plain, markdown])
        #expect(throws: ProtocolValidationError.self) {
            _ = try SnapshotBridge.replacement(snapshot: duplicate, tree: "tr_duplicate", update: "up_initial")
        }
    }

    @Test("One local change publishes and installs its accepted candidate")
    func placementAndSync() async throws {
        try await withTemporaryRoot { root in
            let tree = "tr_sync"
            let initial = try snapshot(markdown: "---\nid: pg_note\n---\n\n# Note\n\nBase\n")
            let transport = acceptingTransport(tree: tree, initial: initial)
            let workingTree = try await placeWorkingTree(
                tree: descriptor(tree: tree, snapshot: initial, update: "up_initial"),
                at: root.appending(path: "replica"),
                transport: transport
            )
            let coordinator = try UpdateCoordinator(workingTree: workingTree, transport: transport, stateRoot: root.appending(path: "sync"))
            let session = try await noteSession(workingTree, coordinator, tree: tree)
            try await admitAppend(session, "Local\n")
            #expect(try await workingTree.heads().acceptedRoot == initial.root)

            let result = try await coordinator.syncOnce()
            #expect(result.state == .current)
            #expect((try await session.snapshot()).source.hasSuffix("Local\n"))
            #expect(await transport.requests.count == 1)
            #expect(try await pendingChanges(root.appending(path: "sync"), tree: tree).isEmpty)
            #expect(try await workingTree.heads().acceptedUpdate == "up_1")
        }
    }

    @Test("A rejected session is retried once with a fresh one, and a second rejection stays")
    func authenticationRetry() async throws {
        try await withTemporaryRoot { root in
            let tree = "tr_session"
            let initial = try snapshot(markdown: "---\nid: pg_note\n---\n\n# Note\n\nBase\n")
            let expired = ProtocolHTTPError(status: 401, code: "unauthenticated", message: "session expired", retryable: false)
            let transport = acceptingTransport(tree: tree, initial: initial) { call in if call == 1 || call == 3 { throw expired } }
            let workingTree = try await placeWorkingTree(
                tree: descriptor(tree: tree, snapshot: initial, update: "up_initial"),
                at: root.appending(path: "replica"),
                transport: transport
            )
            let coordinator = try UpdateCoordinator(workingTree: workingTree, transport: transport, stateRoot: root.appending(path: "sync"))
            let session = try await noteSession(workingTree, coordinator, tree: tree)
            try await admitAppend(session, "Local\n")
            _ = try await coordinator.syncOnce()
            for _ in 0..<200 where await transport.requests.count < 2 { try await Task.sleep(for: .milliseconds(10)) }
            #expect(await transport.requests.count == 2)
            for _ in 0..<200 where try await workingTree.heads().acceptedUpdate != "up_1" { try await Task.sleep(for: .milliseconds(10)) }
            #expect(try await workingTree.heads().acceptedUpdate == "up_1")

            // Within the minute, a second rejection is a revocation: no automatic retry.
            try await admitAppend(session, "More\n")
            _ = try await coordinator.syncOnce()
            try await Task.sleep(for: .milliseconds(200))
            #expect(await transport.requests.count == 3)
        }
    }

    @Test("An editor patch against a retained accepted file publishes as a delta, and falls back by size")
    func editorPatchDelta() async throws {
        try await withTemporaryRoot { root in
            let tree = "tr_patch"
            let initialSource = "---\nid: pg_note\n---\n\n# Note\n\nBase\n" + String(repeating: "Shared text.\n", count: 1_024)
            let initial = try snapshot(markdown: initialSource)
            let transport = acceptingTransport(tree: tree, initial: initial)
            let workingTree = try await placeWorkingTree(
                tree: descriptor(tree: tree, snapshot: initial, update: "up_initial"),
                at: root.appending(path: "replica"),
                transport: transport
            )
            let coordinator = try UpdateCoordinator(workingTree: workingTree, transport: transport, stateRoot: root.appending(path: "sync"))
            let session = try await noteSession(workingTree, coordinator, tree: tree)
            let base = try await session.snapshot()
            let range = try #require(Data(base.source.utf8).range(of: Data("Base".utf8)))
            _ = try await session.admit(patch: WorkspaceDocumentPatch(
                baseContentRevision: base.contentRevision,
                edits: [WorkspaceSourceEdit(utf8Range: range, replacement: "Edited", expected: "Base")]
            ))
            _ = try await coordinator.syncOnce()
            let first = try JSONDecoder().decode(ProtocolUpdateRequest.self, from: try #require(await transport.requests.first).body)
            let element = try #require(first.updates.last)
            let delta = try #require(element.deltas.first { $0.instructions.contains(.insert(Data("Edited".utf8))) })
            #expect(delta.instructions.contains(where: { if case .copy = $0 { return true } else { return false } }))
            #expect(!element.objects.contains { $0.hash == delta.result })

            let large = try await session.snapshot()
            let fallbackSource = "---\nid: pg_note\n---\n\n# Small fallback\n"
            _ = try await session.admit(patch: WorkspaceDocumentPatch(
                baseContentRevision: large.contentRevision,
                edits: [WorkspaceSourceEdit(utf8Range: 0..<Data(large.source.utf8).count, replacement: fallbackSource, expected: large.source)]
            ))
            _ = try await coordinator.syncOnce()
            let second = try JSONDecoder().decode(ProtocolUpdateRequest.self, from: try #require(await transport.requests.last).body)
            let replaced = try #require(second.updates.last)
            #expect(!replaced.deltas.contains { $0.instructions.contains(.insert(Data(fallbackSource.utf8))) })
            #expect(replaced.objects.contains { $0.hash == (try? ProtocolObjectCodec.object(.file(Data(fallbackSource.utf8))))?.hash })
            #expect(await coordinator.syncState.kind == "current")
        }
    }

    @Test("A later edit is one retained successor; its request repeats the settled prefix exactly")
    func oneRequestInFlightWithOneSuccessor() async throws {
        try await withTemporaryRoot { root in
            let tree = "tr_successor"
            let initial = try snapshot(markdown: "---\nid: pg_note\n---\n\n# Note\n\nBase\n")
            let gate = FirstRequestGate()
            let transport = acceptingTransport(tree: tree, initial: initial) { call in if call == 1 { await gate.hold() } }
            let workingTree = try await placeWorkingTree(
                tree: descriptor(tree: tree, snapshot: initial, update: "up_initial"),
                at: root.appending(path: "replica"),
                transport: transport
            )
            let coordinator = try UpdateCoordinator(workingTree: workingTree, transport: transport, stateRoot: root.appending(path: "sync"))
            let session = try await noteSession(workingTree, coordinator, tree: tree)
            try await admitAppend(session, "One\n")
            // The change is durable before any request; publication follows the trailing delay.
            #expect(await transport.requests.isEmpty)
            try await waitUntil { await gate.waiting }
            try await admitAppend(session, "Two\n")
            try await Task.sleep(for: .milliseconds(400))
            // The second change is the single successor of the request in flight.
            #expect(await transport.requests.count == 1)
            #expect(await coordinator.syncState.kind == "submitting-pending")
            await gate.release()
            try await waitUntil {
                let count = await transport.requests.count
                return await coordinator.syncState.kind == "current" && count == 2
            }
            let requests = await transport.requests
            #expect(requests.count == 2)
            let prefix = try JSONDecoder().decode(ProtocolUpdateRequest.self, from: requests[0].body)
            let successor = try JSONDecoder().decode(ProtocolUpdateRequest.self, from: requests[1].body)
            #expect(prefix.updates.count == 1)
            // One chain: the settled first change is repeated without its objects, then the successor once.
            #expect(successor.base == "up_initial")
            #expect(successor.updates.count == 2)
            #expect(requests[1].requestDigests.first == requests[0].requestDigests.first)
            #expect(successor.updates[0].objects.isEmpty && successor.updates[0].deltas.isEmpty)
            #expect(try await workingTree.heads().acceptedRoot == successor.updates.last?.candidate)
            #expect((try await session.snapshot()).source.hasSuffix("One\nTwo\n"))
        }
    }

    @Test("A preparation failure is reported and reconnect retries the retained change")
    func preparationFailureCanResume() async throws {
        try await withTemporaryRoot { root in
            let tree = "tr_preparation_failure"
            let initial = try snapshot(markdown: "---\nid: pg_note\n---\n\n# Note\n")
            let transport = acceptingTransport(tree: tree, initial: initial)
            let workingTree = try await placeWorkingTree(tree: descriptor(tree: tree, snapshot: initial, update: "up_initial"), at: root.appending(path: "replica"), transport: transport)
            let stateRoot = root.appending(path: "sync")
            let coordinator = try UpdateCoordinator(workingTree: workingTree, transport: transport, stateRoot: stateRoot,
                faultInjector: FirstPreparationFault(), publicationDelay: .milliseconds(10), publicationMaxDelay: .milliseconds(30))
            let session = try await noteSession(workingTree, coordinator, tree: tree)
            try await admitAppend(session, "Keep this edit\n")
            try await waitUntil { await coordinator.syncState.kind == "offline" }
            #expect(try await coordinator.presentation().detail?.contains("InjectedSyncCrash") == true)
            let retained = try #require(try await pendingChanges(stateRoot, tree: tree).last)
            #expect(await transport.requests.isEmpty)
            await coordinator.setTransportAvailable(false)
            await coordinator.setTransportAvailable(true)
            #expect(await transport.requests.count == 1)
            #expect(try await workingTree.heads().acceptedRoot == retained.candidate.root)
            #expect(await coordinator.syncState.kind == "current")
        }
    }

    @Test("A burst of edits before the publication delay becomes one request")
    func burstCoalescesBeforePublication() async throws {
        try await withTemporaryRoot { root in
            let tree = "tr_burst"
            let initial = try snapshot(markdown: "---\nid: pg_note\n---\n\n# Note\n\nBase\n")
            let transport = acceptingTransport(tree: tree, initial: initial)
            let workingTree = try await placeWorkingTree(
                tree: descriptor(tree: tree, snapshot: initial, update: "up_initial"),
                at: root.appending(path: "replica"),
                transport: transport
            )
            let coordinator = try UpdateCoordinator(workingTree: workingTree, transport: transport, stateRoot: root.appending(path: "sync"))
            let session = try await noteSession(workingTree, coordinator, tree: tree)
            for index in 1...15 { try await admitAppend(session, "Move \(index)\n") }
            #expect(await transport.requests.isEmpty)
            try await waitUntil {
                let sent = await transport.requests.count
                return await coordinator.syncState.kind == "current" && sent > 0
            }
            let requests = await transport.requests
            #expect(requests.count == 1)
            let request = try JSONDecoder().decode(ProtocolUpdateRequest.self, from: try #require(requests.first?.body))
            // One element per authored change, in log order.
            #expect(request.updates.count == 15)
            #expect(request.updates.last?.candidate == (try await workingTree.heads().acceptedRoot))
            #expect((try await session.snapshot()).source.hasSuffix("Move 15\n"))
        }
    }

    @Test("Offline changes append once to an ambiguous prefix on reconnection")
    func offlineChangesAppendToAmbiguousPrefix() async throws {
        try await withTemporaryRoot { root in
            let tree = "tr_offlinecompaction"
            let initial = try snapshot(markdown: "---\nid: pg_note\n---\n\n# Note\n\nBase\n")
            let gate = FirstRequestGate()
            let transport = acceptingTransport(tree: tree, initial: initial) { call in if call == 1 { await gate.hold() } }
            let workingTree = try await placeWorkingTree(
                tree: descriptor(tree: tree, snapshot: initial, update: "up_initial"),
                at: root.appending(path: "replica"),
                transport: transport
            )
            let coordinator = try UpdateCoordinator(workingTree: workingTree, transport: transport, stateRoot: root.appending(path: "sync"))
            let session = try await noteSession(workingTree, coordinator, tree: tree)
            try await admitAppend(session, "Before offline\n")
            try await waitUntil { await gate.waiting }

            await coordinator.setTransportAvailable(false)
            for index in 1...37 { try await admitAppend(session, "Offline \(index)\n") }
            try await Task.sleep(for: .milliseconds(50))
            #expect(await transport.requests.count == 1)

            // The hanging first attempt is still in flight; reconnection extends it once.
            let reconnect = Task { await coordinator.setTransportAvailable(true) }
            try await waitUntil { await transport.requests.count == 2 }
            let requests = await transport.requests
            let prefix = try JSONDecoder().decode(ProtocolUpdateRequest.self, from: requests[0].body)
            let resumed = try JSONDecoder().decode(ProtocolUpdateRequest.self, from: requests[1].body)
            #expect(prefix.updates.count == 1)
            #expect(resumed.updates.count == 38)
            #expect(Array(resumed.updates.prefix(1)) == prefix.updates)
            #expect(Array(requests[1].requestDigests.prefix(1)) == requests[0].requestDigests)

            await gate.release()
            await reconnect.value
            try await waitUntil { await coordinator.syncState.kind == "current" }
            #expect((try await session.snapshot()).source.hasSuffix("Offline 37\n"))
        }
    }

    @Test("A clean watch invalidation reads the coherent current snapshot without submitting")
    func cleanWatchPull() async throws {
        try await withTemporaryRoot { root in
            let tree = "tr_watchpull"
            let initial = try snapshot(markdown: "---\nid: pg_note\n---\n\n# Note\n\nOne\n")
            let remote = try snapshot(markdown: "---\nid: pg_note\n---\n\n# Note\n\nTwo\n")
            let bootstrap = ClosureTransport(initial: initial) { _, _ in
                throw ProtocolValidationError.invalidValue("Placement must not submit")
            }
            let workingTree = try await placeWorkingTree(
                tree: descriptor(tree: tree, snapshot: initial, update: "up_initial"),
                at: root.appending(path: "replica"),
                transport: bootstrap
            )
            let remoteTransport = ClosureTransport(initial: remote, currentUpdate: "up_remote") { _, _ in
                throw ProtocolValidationError.invalidValue("A clean watch pull must not submit")
            }
            let coordinator = try UpdateCoordinator(workingTree: workingTree, transport: remoteTransport, stateRoot: root)
            let event = ProtocolWatchEvent(
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
                throw ProtocolValidationError.invalidValue("A clean watch transition must not submit")
            }
            let workingTree = try await placeWorkingTree(
                tree: descriptor(tree: tree, snapshot: initial, update: "up_initial"),
                at: root.appending(path: "replica"),
                transport: transport
            )
            let snapshotRequestsBefore = await transport.snapshotRequests
            let initialFile = try #require(initial.objects.first { $0.hash != initial.root })
            let remoteFile = try #require(remote.objects.first { $0.hash != remote.root })
            let update = ProtocolAcceptedUpdate(
                id: "up_remote",
                tree: tree,
                root: remote.root,
                previous: .init(id: net ? "up_intermediate" : "up_initial", root: initial.root),
                acceptedAt: 1_800_000_000_000
            )
            let transition = ProtocolAcceptedTransition(
                update: update,
                objects: [try #require(remote.objects.first { $0.hash == remote.root })],
                deltas: [ProtocolObjectDelta(
                    base: initialFile.hash,
                    result: remoteFile.hash,
                    instructions: [.insert(remoteFile.bytes)]
                )],
                from: net ? .init(id: "up_initial", root: initial.root) : nil
            )
            let coordinator = try UpdateCoordinator(workingTree: workingTree, transport: transport, stateRoot: root)
            let result = try await coordinator.observe(ProtocolWatchEvent(
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
                throw ProtocolValidationError.invalidValue("Metadata watch must not submit")
            }
            let workingTree = try await placeWorkingTree(
                tree: descriptor(tree: tree, snapshot: initial, update: "up_initial"),
                at: root.appending(path: "replica"), transport: transport
            )
            let update = ProtocolAcceptedUpdate(id: "up_conflicted", tree: tree, root: initial.root,
                previous: .init(id: "up_initial", root: initial.root), acceptedAt: 1, conflicted: true)
            var remote = descriptor(tree: tree, snapshot: initial, update: update.id)
            remote.conflicted = true
            let coordinator = try UpdateCoordinator(workingTree: workingTree, transport: transport, stateRoot: root)
            let result = try await coordinator.observe(ProtocolWatchEvent(id: "observation-metadata", tree: remote,
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
                throw ProtocolValidationError.invalidValue("Placement must not submit")
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
                throw ProtocolValidationError.invalidValue("Gap recovery must not submit")
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
                throw ProtocolValidationError.invalidValue("Placement must not submit")
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
                throw ProtocolValidationError.invalidValue("A clean reconnect must not submit")
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

    @Test("A watch retries a lost response, with or without a matching digest", arguments: [false, true])
    func watchDigestRecovery(net: Bool) async throws {
        try await withTemporaryRoot { root in
            let tree = "tr_watchdigest"
            let initial = try snapshot(markdown: "---\nid: pg_note\n---\n\n# Note\n\nBase\n")
            let transport = acceptingTransport(tree: tree, initial: initial) { call in if call == 1 { throw InjectedSyncCrash() } }
            let workingTree = try await placeWorkingTree(
                tree: descriptor(tree: tree, snapshot: initial, update: "up_initial"),
                at: root.appending(path: "replica"),
                transport: transport
            )
            let coordinator = try UpdateCoordinator(workingTree: workingTree, transport: transport, stateRoot: root)
            let session = try await noteSession(workingTree, coordinator, tree: tree)
            try await admitAppend(session, "Local\n")
            _ = try await coordinator.syncOnce()
            #expect(await coordinator.syncState.kind == "offline")
            let frozen = try #require(await transport.requests.first)
            let request = try JSONDecoder().decode(ProtocolUpdateRequest.self, from: frozen.body)
            let candidate = try #require(request.updates.last?.candidate)
            let eventTree = ProtocolTreeDescriptor(
                id: tree, kind: "ordinary", root: candidate, access: "write",
                canonical: ProtocolCanonicalDescriptor(path: "/~owner/watch-digest", endpoint: "https://example.test"),
                update: net ? "up_net" : "up_1"
            )
            let result = try await coordinator.observe(.init(
                id: net ? "observation_net" : "observation_local",
                tree: eventTree,
                requestDigest: net ? nil : frozen.requestDigest,
                transitions: []
            ))
            #expect(result.state == .current)
            #expect(await transport.requests.count == 2)
            #expect(await transport.requests.last?.body == frozen.body)
            #expect(try await workingTree.heads().acceptedRoot == candidate)
        }
    }

    @Test("Watch acceptance reuses the in-flight POST, replaying only if its response is lost", arguments: [false, true])
    func watchBeforePostResponse(lost: Bool) async throws {
        try await withTemporaryRoot { root in
            let tree = "tr_watch_before_post"
            let initial = try snapshot(markdown: "---\nid: pg_note\n---\n\n# Note\n\nBase\n")
            let gate = FirstRequestGate()
            let transport = acceptingTransport(tree: tree, initial: initial) { call in
                if call == 1 {
                    await gate.hold()
                    if lost { throw InjectedSyncCrash() }
                }
            }
            let workingTree = try await placeWorkingTree(
                tree: descriptor(tree: tree, snapshot: initial, update: "up_initial"),
                at: root.appending(path: "replica"), transport: transport
            )
            let coordinator = try UpdateCoordinator(workingTree: workingTree, transport: transport, stateRoot: root)
            let session = try await noteSession(workingTree, coordinator, tree: tree)
            try await admitAppend(session, "Local\n")
            try await waitUntil { await gate.waiting }
            let frozen = try #require(await transport.requests.first)
            let request = try JSONDecoder().decode(ProtocolUpdateRequest.self, from: frozen.body)
            let candidate = try #require(request.updates.last?.candidate)
            let observation = Task {
                try await coordinator.observe(.init(
                    id: "up_1",
                    tree: .init(id: tree, kind: "ordinary", root: candidate, access: "write", canonical: nil, update: "up_1"),
                    requestDigest: frozen.requestDigest, transitions: []
                ))
            }
            try await waitUntil { await coordinator.syncState.kind == "accepted-pending-apply" }
            // Keep the response withheld while the watch's apply effect runs.
            // A second POST here would wait behind the same acceptance on the host.
            try await Task.sleep(for: .milliseconds(50))
            let countBeforeResponse = await transport.requests.count
            await gate.release()
            let presentation = try await observation.value
            #expect(countBeforeResponse == 1)
            #expect(presentation.state == .current)
            #expect(await transport.requests.count == (lost ? 2 : 1))
            #expect(await transport.requests.last?.body == frozen.body)
            #expect(try await workingTree.heads().acceptedRoot == candidate)
            #expect(try await pendingChanges(root, tree: tree).isEmpty)
        }
    }

    @Test("A change appended while its predecessor is in flight publishes on the settled chain")
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
            let holder = SessionHolder()
            let transport = acceptingTransport(tree: tree, initial: initial) { call in
                if call == 1, let session = await holder.session { try await admitAppend(session, "Tail\n") }
            }
            let coordinator = try UpdateCoordinator(workingTree: workingTree, transport: transport, stateRoot: root)
            let session = try await noteSession(workingTree, coordinator, tree: tree)
            await holder.set(session)
            try await admitAppend(session, "Candidate\n")
            // The tail is appended while the first request is in flight and
            // publishes on the settled chain, so one synchronization settles both.
            let settled = try await coordinator.syncOnce()
            #expect(settled.state == .current)
            #expect((try await session.snapshot()).source.hasSuffix("Candidate\nTail\n"))
            let requests = await transport.requests
            #expect(requests.count == 2)
            let first = try JSONDecoder().decode(ProtocolUpdateRequest.self, from: requests[0].body)
            let second = try JSONDecoder().decode(ProtocolUpdateRequest.self, from: requests[1].body)
            #expect(first.base == "up_initial" && second.base == "up_initial")
            #expect(second.updates.count == 2)
            #expect(try await workingTree.heads().acceptedRoot == second.updates.last?.candidate)
            #expect(try await workingTree.heads().acceptedUpdate == "up_2")
        }
    }

    @Test("A definitive rejection is held across restart, keeps later changes, and leaves only when discarded")
    func rejectedRequestIsHeld() async throws {
        try await withTemporaryRoot { root in
            let tree = "tr_conflict"
            let initial = try snapshot(markdown: "---\nid: pg_note\n---\n\n# Note\n\nBase\n")
            let remote = try snapshot(markdown: "---\nid: pg_note\n---\n\n# Note\n\nRemote\n")
            let workingTree = try await placeWorkingTree(
                tree: descriptor(tree: tree, snapshot: initial, update: "up_initial"),
                at: root.appending(path: "replica"),
                transport: ClosureTransport(initial: initial) { _, _ in throw InjectedSyncCrash() }
            )
            let current = accepted(id: "up_remote", tree: tree, root: remote.root, base: initial.root, candidate: remote.root)
            let rejecting = ClosureTransport(initial: initial, current: remote, currentUpdate: "up_remote") { prepared, _ in
                let request = try JSONDecoder().decode(ProtocolUpdateRequest.self, from: prepared.body)
                throw ProtocolUpdateConflictError(conflict: ProtocolUpdateConflict(
                    message: "stale guard", current: current, base: initial.root,
                    candidate: try #require(request.updates.last?.candidate), draft: ProtocolConflictDraft(root: initial.root), conflicts: []))
            }
            let coordinator = try UpdateCoordinator(workingTree: workingTree, transport: rejecting, stateRoot: root)
            let session = try await noteSession(workingTree, coordinator, tree: tree)
            try await admitAppend(session, "Local\n")
            _ = try await coordinator.syncOnce()
            #expect(await coordinator.syncState.kind == "held")
            #expect(try await coordinator.presentation().state == .conflict)
            let files = try UpdateControlFiles(root: root)
            let retained = try #require(files.load().attempt)
            #expect(try files.load().held?.reason == .rejected)
            // Later work waits with the held chain; nothing more is sent.
            try await admitAppend(session, "Later\n")
            _ = try await coordinator.syncOnce()
            #expect(await rejecting.requests.count == 1)
            #expect((try await session.snapshot()).source.hasSuffix("Local\nLater\n"))
            await coordinator.close()

            let restarted = try UpdateCoordinator(workingTree: workingTree, transport: rejecting, stateRoot: root)
            _ = try await restarted.syncOnce()
            #expect(await restarted.syncState.kind == "held")
            #expect(await rejecting.requests.count == 1)
            #expect(try UpdateControlFiles(root: root).load().attempt == retained)

            try await restarted.discardHeldChanges()
            #expect(await restarted.syncState.kind == "current")
            #expect(try await workingTree.heads().acceptedRoot == remote.root)
            #expect(try await pendingChanges(root, tree: tree).isEmpty)
            #expect(try UpdateControlFiles(root: root).load().held == nil)
        }
    }

    @Test("An unsupported operation holds the exact request instead of stopping the tree")
    func unsupportedRequestIsHeld() async throws {
        try await withTemporaryRoot { root in
            let tree = "tr_unsupported"
            let initial = try snapshot(markdown: "---\nid: pg_note\n---\n\n# Note\n\nBase\n")
            let transport = ClosureTransport(initial: initial) { _, _ in
                throw ProtocolHTTPError(status: 422, code: "unsupported-operation", message: "moveSource", retryable: false)
            }
            let workingTree = try await placeWorkingTree(
                tree: descriptor(tree: tree, snapshot: initial, update: "up_initial"),
                at: root.appending(path: "replica"), transport: transport
            )
            let coordinator = try UpdateCoordinator(workingTree: workingTree, transport: transport, stateRoot: root)
            let session = try await noteSession(workingTree, coordinator, tree: tree)
            try await admitAppend(session, "Local\n")
            _ = try await coordinator.syncOnce()
            #expect(await coordinator.syncState.kind == "held")
            #expect(try await coordinator.presentation().detail?.contains("newer Canopy") == true)
            #expect(try UpdateControlFiles(root: root).load().held?.reason == .unsupported)
        }
    }

    @Test("Every coordinator crash point replays one semantic intent")
    func crashRecovery() async throws {
        for point in UpdateFailurePoint.allCases where point != .duringMaterialization && point != .afterMaterialization {
            try await withTemporaryRoot { root in
                let tree = "tr_fault_\(point.rawValue)"
                let initial = try snapshot(markdown: "---\nid: pg_note\n---\n\n# Note\n")
                let transport = acceptingTransport(tree: tree, initial: initial)
                let workingTree = try await placeWorkingTree(
                    tree: descriptor(tree: tree, snapshot: initial, update: "up_initial"),
                    at: root.appending(path: "replica"),
                    transport: transport
                )
                let crashing = try UpdateCoordinator(
                    workingTree: workingTree,
                    transport: transport,
                    stateRoot: root,
                    faultInjector: OnePointFault(point: point)
                )
                _ = try await WorkingTreeProvider(workingTree: workingTree, coordinator: crashing).perform(.createMarkdown(
                    parent: .init(tree: TreeID(rawValue: tree), path: "/"),
                    name: "local",
                    source: "# Local\n"
                ))
                _ = try await crashing.syncOnce()
                #expect(await crashing.syncState.kind != "current", Comment(rawValue: point.rawValue))
                await crashing.close()
                let resumed = try UpdateCoordinator(workingTree: workingTree, transport: transport, stateRoot: root)
                #expect(try await resumed.syncOnce().state == .current, Comment(rawValue: point.rawValue))
                let requests = await transport.requests
                let frozen = try JSONDecoder().decode(ProtocolUpdateRequest.self, from: try #require(requests.first).body)
                #expect(frozen.updates.flatMap(\.objects).count < (try await workingTree.currentSnapshot()).objects.count)
                if requests.count > 1 {
                    #expect(Set(requests.map(\.requestDigest)).count == 1)
                    #expect(Set(requests.map(\.body)).count == 1)
                }
                #expect(try await pendingChanges(root, tree: tree).isEmpty)
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
                let transport = ClosureTransport(initial: initial, current: merged, currentUpdate: "up_merged") { prepared, _ in
                    let update = ProtocolAcceptedUpdate(
                        id: "up_merged",
                        tree: tree,
                        root: merged.root,
                        previous: .init(id: "up_initial", root: initial.root),
                        acceptedAt: 1_800_000_000_000
                    )
                    return ProtocolUpdateResponse(result: .accepted(update), requestDigest: prepared.requestDigests.last!, reconciliation: ProtocolTransitionPayload(objects: merged.objects), observedThrough: update.id)
                }
                let workingTree = try await placeWorkingTree(
                    tree: descriptor(tree: tree, snapshot: initial, update: "up_initial"),
                    at: root.appending(path: "replica"),
                    transport: ClosureTransport(initial: initial) { _, _ in throw InjectedSyncCrash() }
                )
                let crashing = try UpdateCoordinator(
                    workingTree: workingTree,
                    transport: transport,
                    stateRoot: root,
                    faultInjector: OnePointFault(point: point)
                )
                let session = try await noteSession(workingTree, crashing, tree: tree)
                try await admitAppend(session, "Local\n")
                _ = try await crashing.syncOnce()
                await crashing.close()
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

@Suite("Working-tree update coordinator: sparse bodies and durable changes")
struct UpdateCoordinatorPhase3Tests {
    @Test("A local change survives a stop before the publication delay and is submitted as one request")
    func localChangeSurvivesStop() async throws {
        try await withTemporaryRoot { root in
            let tree = "tr_head"
            let initial = try snapshot(markdown: "---\nid: pg_note\n---\n\n# Note\n\nBase\n")
            let transport = acceptingTransport(tree: tree, initial: initial)
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
            let session = try await noteSession(workingTree, stopped, tree: tree)
            try await admitAppend(session, "Unpublished\n")
            let change = try #require(try await pendingChanges(root, tree: tree).last)
            #expect(change.basis == .accepted(.init(root: initial.root, update: "up_initial")))
            #expect(!change.update.objects.isEmpty || !change.update.deltas.isEmpty)
            #expect(change.update.objects.allSatisfy { !initial.objects.map(\.hash).contains($0.hash) })
            #expect(await transport.requests.isEmpty)
            await stopped.close()

            let resumed = try UpdateCoordinator(workingTree: workingTree, transport: transport, stateRoot: root)
            #expect(try await resumed.syncOnce().state == .current)
            let requests = await transport.requests
            #expect(requests.count == 1)
            let request = try JSONDecoder().decode(ProtocolUpdateRequest.self, from: try #require(requests.first).body)
            #expect(request.updates == [change.update])
            #expect(try await workingTree.heads().acceptedRoot == change.candidate.root)
            let control = try UpdateControlFiles(root: root).load()
            #expect(control.attempt == nil)
            #expect(control.schema == UpdateControl.currentSchema)
        }
    }

    @Test("A retained request whose tree was re-seeded is submitted once and installs the host's state")
    func reseededTreeRecoversRequest() async throws {
        try await withTemporaryRoot { root in
            let tree = "tr_reseed"
            let initial = try snapshot(markdown: "---\nid: pg_note\n---\n\n# Note\n\nBase\n")
            let transport = acceptingTransport(tree: tree, initial: initial)
            // A Mac-style tree: memory state, memory overlay; only the sync directory is durable.
            let first = try await placeInMemory(tree: tree, transport: transport)
            let stopped = try UpdateCoordinator(workingTree: first, transport: transport, stateRoot: root,
                faultInjector: OnePointFault(point: .duringUpload))
            let session = try await noteSession(first, stopped, tree: tree)
            try await admitAppend(session, "Lost with the process\n")
            _ = try await stopped.syncOnce()
            let persisted = try #require(try UpdateControlFiles(root: root).load().attempt)
            #expect(await transport.requests.isEmpty)
            await stopped.close()
            await first.close()

            // Relaunch: the tree is re-seeded from Canopy's current state.
            let second = try await placeInMemory(tree: tree, transport: transport)
            #expect(try await second.heads().materializedRoot == initial.root)
            let resumed = try UpdateCoordinator(workingTree: second, transport: transport, stateRoot: root)
            let result = try await resumed.syncOnce()
            #expect(result.state == .current)
            #expect(await transport.requests.count == 1)
            #expect(await transport.requests.first?.body == persisted.body)
            #expect(try await second.heads().materializedRoot == persisted.candidate)
            #expect(try await second.heads().acceptedUpdate == "up_1")
            #expect(try UpdateControlFiles(root: root).load().attempt == nil)
            _ = try await resumed.syncOnce()
            #expect(await transport.requests.count == 1)
        }
    }

    @Test("A save is not acknowledged when the change log cannot be written, and a retry succeeds")
    func failedAppendIsNotAcknowledged() async throws {
        try await withTemporaryRoot { root in
            let tree = "tr_disk_failure"
            let initial = try snapshot(markdown: "---\nid: pg_note\n---\n\n# Note\n\nBase\n")
            let transport = ClosureTransport(initial: initial) { _, _ in
                throw ProtocolValidationError.invalidValue("Offline test must not upload")
            }
            let workingTree = try await placeInMemory(tree: tree, transport: transport)
            let coordinator = try UpdateCoordinator(workingTree: workingTree, transport: transport,
                                                    stateRoot: root, transportAvailable: false)
            let files = try UpdateControlFiles(root: root)
            let session = try await noteSession(workingTree, coordinator, tree: tree)
            let before = try await session.snapshot()
            // A directory at the destination forces the atomic rename to fail.
            try FileManager.default.createDirectory(at: files.changeLogURL, withIntermediateDirectories: true)
            await #expect(throws: (any Error).self) {
                _ = try await session.admit(patch: WorkspaceDocumentPatch(baseContentRevision: before.contentRevision,
                    edits: [.init(utf8Range: before.source.utf8.count..<before.source.utf8.count, replacement: "Retain offline\n")]))
            }
            try FileManager.default.removeItem(at: files.changeLogURL)
            #expect(try await session.snapshot().source.contains("Retain offline") == false)
            try await admitAppend(session, "Retain offline\n")
            // No polling: returning from the append is the durability boundary.
            #expect(try await pendingChanges(root, tree: tree).count == 1)
            #expect(try await session.snapshot().source.contains("Retain offline"))
            #expect(await transport.requests.isEmpty)
            await coordinator.close()
        }
    }

    @Test("Change envelopes carry only new objects; platform-served files are never packed or fetched")
    func sparseCandidateFromOverlay() async throws {
        let tree = "tr_sparse"
        let note = try ProtocolObjectCodec.object(.file(Data("---\nid: pg_note\n---\n\n# Note\n\nBase\n".utf8)))
        let photo = try ProtocolObjectCodec.object(.file(Data(repeating: 0xab, count: 4_096)))
        let rootDirectory = try ProtocolObjectCodec.object(.directory([
            .init(name: "note.md", file: note.hash),
            .init(name: "photo.bin", file: photo.hash),
        ]))
        let complete = ProtocolSnapshot(root: rootDirectory.hash, objects: [rootDirectory, note, photo].sorted { $0.hash < $1.hash })
        let spine = ProtocolSnapshot(root: rootDirectory.hash, objects: [rootDirectory, note].sorted { $0.hash < $1.hash })
        let platform = CountingObjectStore(objects: [photo.hash: photo.bytes])
        let workingTree = try await WorkingTree.open(store: InMemoryWorkingTreeStore(), overlay: InMemoryObjectOverlay(), platform: platform, tree: TreeID(rawValue: tree))
        try await workingTree.initializeFromSystem(try SnapshotBridge.replacement(
            snapshot: spine,
            tree: TreeID(rawValue: tree),
            update: "up_initial",
            mode: .sparseFiles
        ))
        let transport = acceptingTransport(tree: tree, initial: complete)
        try await withTemporaryRoot { root in
            let coordinator = try UpdateCoordinator(workingTree: workingTree, transport: transport, stateRoot: root)
            let session = try await noteSession(workingTree, coordinator, tree: tree)
            try await admitAppend(session, "Sparse\n")
            #expect(try await coordinator.syncOnce().state == .current)
            let request = try JSONDecoder().decode(ProtocolUpdateRequest.self, from: try #require(await transport.requests.first).body)
            let sent = Set(request.updates.flatMap(\.objects).map(\.hash))
            #expect(!sent.isEmpty)
            #expect(!sent.contains(photo.hash))
            #expect(!sent.contains(note.hash))
            #expect(await platform.fetches == 0)
        }
    }

    @Test("A reconciliation delta fetches its base through the object store exactly once")
    func deltaBaseFetchedOnce() async throws {
        let tree = "tr_delta"
        let note = try ProtocolObjectCodec.object(.file(Data("---\nid: pg_note\n---\n\n# Note\n\nBase\n".utf8)))
        let photo = try ProtocolObjectCodec.object(.file(Data(repeating: 0x01, count: 2_048)))
        let rootDirectory = try ProtocolObjectCodec.object(.directory([
            .init(name: "note.md", file: note.hash),
            .init(name: "photo.bin", file: photo.hash),
        ]))
        let spine = ProtocolSnapshot(root: rootDirectory.hash, objects: [rootDirectory, note].sorted { $0.hash < $1.hash })
        let platform = CountingObjectStore(objects: [photo.hash: photo.bytes])
        let workingTree = try await WorkingTree.open(store: InMemoryWorkingTreeStore(), overlay: InMemoryObjectOverlay(), platform: platform, tree: TreeID(rawValue: tree))
        try await workingTree.initializeFromSystem(try SnapshotBridge.replacement(
            snapshot: spine,
            tree: TreeID(rawValue: tree),
            update: "up_initial",
            mode: .sparseFiles
        ))
        // The remote side replaced the photo; Canopy expresses it as a delta against the retained base.
        let photo2 = try ProtocolObjectCodec.object(.file(Data(repeating: 0x02, count: 2_048)))
        let delta = try ProtocolObjectDelta(base: photo.hash, result: photo2.hash, instructions: [.insert(photo2.bytes)]).validated()
        let merged = MergedRootBox()
        let transport = ClosureTransport(initial: spine) { prepared, _ in
            let request = try JSONDecoder().decode(ProtocolUpdateRequest.self, from: prepared.body)
            let element = try #require(request.updates.last)
            // The element carries the new note and root, whole or as deltas; the photo is never sent.
            let localNote = try #require((element.objects.map(\.hash) + element.deltas.map(\.result)).first { $0 != element.candidate })
            let mergedRoot = try ProtocolObjectCodec.object(.directory([
                .init(name: "note.md", file: localNote),
                .init(name: "photo.bin", file: photo2.hash),
            ]))
            await merged.set(mergedRoot.hash)
            let update = ProtocolAcceptedUpdate(
                id: "up_merged", tree: tree, root: mergedRoot.hash, previous: .init(id: "up_initial", root: rootDirectory.hash),
                acceptedAt: 1_800_000_000_000
            )
            var result = ProtocolUpdateResponse(
                result: .accepted(update),
                requestDigest: prepared.requestDigests.last!,
                reconciliation: ProtocolTransitionPayload(objects: [mergedRoot], deltas: [delta]),
                observedThrough: update.id
            )
            result.head = .init(update: update.id, root: mergedRoot.hash, conflicted: false, observedThrough: update.id)
            return result
        }
        try await withTemporaryRoot { root in
            let coordinator = try UpdateCoordinator(workingTree: workingTree, transport: transport, stateRoot: root)
            let session = try await noteSession(workingTree, coordinator, tree: tree)
            try await admitAppend(session, "Local\n")
            #expect(try await coordinator.syncOnce().state == .current)
            #expect(await platform.fetches == 1)
            #expect(await platform.fetched == [photo.hash])
            #expect(try await workingTree.heads().acceptedUpdate == "up_merged")
            #expect(try await workingTree.heads().acceptedRoot == (await merged.root))
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
        let transport = acceptingTransport(tree: tree, initial: initial) { call in if call == 1 { throw URLError(.networkConnectionLost) } }
        let workingTree = try await WorkingTree.open(store: InMemoryWorkingTreeStore(), overlay: overlay, tree: TreeID(rawValue: tree))
        try await workingTree.initializeFromSystem(try SnapshotBridge.replacement(snapshot: initial, tree: TreeID(rawValue: tree), update: "up_initial"))
        try await withTemporaryRoot { root in
            let coordinator = try UpdateCoordinator(workingTree: workingTree, transport: transport, stateRoot: root)
            let provider = WorkingTreeProvider(workingTree: workingTree, coordinator: coordinator)
            _ = try await provider.importFile(name: "asset.bin", bytes: Data(repeating: 0x7f, count: 1_024), in: .init(tree: TreeID(rawValue: tree), path: "/"))
            let assetHash = try ProtocolObjectCodec.object(.file(Data(repeating: 0x7f, count: 1_024))).hash
            _ = try await coordinator.syncOnce()
            #expect(await coordinator.syncState.kind == "offline")
            let prepared = try #require(await transport.requests.first)
            #expect(try JSONDecoder().decode(ProtocolUpdateRequest.self, from: prepared.body).updates.flatMap(\.objects).contains { $0.hash == assetHash })

            // A collection that keeps nothing: the request in flight must not notice.
            try overlay.retain(reachableFrom: [])
            #expect(try overlay.hashes().isEmpty)

            await coordinator.setTransportAvailable(false)
            await coordinator.setTransportAvailable(true)
            let requests = await transport.requests
            #expect(requests.count == 2)
            #expect(requests[0].body == requests[1].body)
            #expect(requests[0].requestDigests == requests[1].requestDigests)
            #expect(await coordinator.syncState.kind == "current")
        }
    }
}

/// A session on `/note` whose edits are local changes published by `coordinator`.
private func noteSession(_ workingTree: WorkingTree, _ coordinator: UpdateCoordinator, tree: String) async throws -> any WorkspaceDocumentSession {
    try await WorkingTreeProvider(workingTree: workingTree, coordinator: coordinator)
        .openDocument(.init(tree: TreeID(rawValue: tree), path: "/note", stableKey: markdownStableKey("pg_note")))
}

/// Append `text` to the document as one editor generation.
private func admitAppend(_ session: any WorkspaceDocumentSession, _ text: String) async throws {
    let current = try await session.snapshot()
    let end = Data(current.source.utf8).count
    _ = try await session.admit(patch: WorkspaceDocumentPatch(
        baseContentRevision: current.contentRevision,
        edits: [WorkspaceSourceEdit(utf8Range: end..<end, replacement: text)]
    ))
}

/// The change log's unsettled changes under `stateRoot`.
private func pendingChanges(_ stateRoot: URL, tree: String) async throws -> [LocalChange] {
    let settled = Set(try UpdateControlFiles(root: stateRoot).load().settled)
    return try await ChangeLog(tree: tree, stateRoot: stateRoot).retained().filter { !settled.contains($0.change) }
}

private func waitUntil(_ condition: @Sendable () async throws -> Bool) async throws {
    for _ in 0..<500 where !(try await condition()) { try await Task.sleep(for: .milliseconds(10)) }
    #expect(try await condition())
}

/// A transport that accepts every element as submitted, numbering accepted
/// updates, and serves the accepted candidate as the host's current state.
private func acceptingTransport(tree: String, initial: ProtocolSnapshot, before: @escaping @Sendable (Int) async throws -> Void = { _ in }) -> ClosureTransport {
    let accepted = AcceptedCounter()
    return ClosureTransport(initial: initial, advancesCurrentOnAccept: true) { prepared, call in
        try await before(call)
        let request = try JSONDecoder().decode(ProtocolUpdateRequest.self, from: prepared.body)
        let number = await accepted.next()
        var previous = initial.root
        let results = request.updates.enumerated().map { index, element in
            let update = ProtocolAcceptedUpdate(id: index == request.updates.count - 1 ? "up_\(number)" : "up_\(number)_\(index)",
                tree: tree, root: element.candidate, previous: .init(id: "up_initial", root: previous), acceptedAt: 1_800_000_000_000)
            previous = element.candidate
            return ProtocolUpdateElementResult(result: .accepted(update), requestDigest: prepared.requestDigests[index])
        }
        return ProtocolUpdateResponse(results: results, observedThrough: "up_\(number)")
    }
}

private actor AcceptedCounter {
    private var value = 0
    func next() -> Int { value += 1; return value }
}

private actor SessionHolder {
    private(set) var session: (any WorkspaceDocumentSession)?
    func set(_ session: any WorkspaceDocumentSession) { self.session = session }
}

private actor MergedRootBox {
    private(set) var root: String?
    func set(_ root: String) { self.root = root }
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
    private(set) var requests: [PreparedProtocolUpdate] = []

    init(_ inner: any UpdateTransport) { self.inner = inner }

    func submit(_ prepared: PreparedProtocolUpdate) async throws -> ProtocolUpdateResponse {
        requests.append(prepared)
        return try await inner.submit(prepared)
    }

    func descriptor(tree: String) async throws -> ProtocolCurrentTree { try await inner.descriptor(tree: tree) }
    func snapshot(tree: String, root: String) async throws -> ProtocolSnapshot { try await inner.snapshot(tree: tree, root: root) }
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
            let client = ProtocolClient(origin: origin, credential: token, retryDelay: { _ in })
            let tree = try await client.descriptor(tree: treeID).tree
            let transport = RecordingTransport(ProtocolReplicaTransport(client: client))
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
            let macSync = try UpdateCoordinator(workingTree: mac, transport: transport, stateRoot: root.appending(path: "mac-state"))
            let tabletSync = try UpdateCoordinator(workingTree: tablet, transport: transport, stateRoot: root.appending(path: "tablet-state"))
            let macSession = try await WorkingTreeProvider(workingTree: mac, coordinator: macSync).openDocument(reference)
            let tabletSession = try await WorkingTreeProvider(workingTree: tablet, coordinator: tabletSync).openDocument(reference)
            let macBase = try await macSession.snapshot()
            let tabletBase = try await tabletSession.snapshot()
            _ = try await macSession.admit(source: macBase.source + "Mac addition\n", baseContentRevision: macBase.contentRevision)
            _ = try await tabletSession.admit(source: tabletBase.source + "Tablet addition\n", baseContentRevision: tabletBase.contentRevision)
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
                let request = try JSONDecoder().decode(ProtocolUpdateRequest.self, from: prepared.body)
                #expect(request.updates.allSatisfy { $0.objects.count < total })
            }
            await macSync.close(); await tabletSync.close()
        }
    }
}

private func snapshot(markdown: String) throws -> ProtocolSnapshot {
    let file = try ProtocolObjectCodec.object(.file(Data(markdown.utf8)))
    let root = try ProtocolObjectCodec.object(.directory([.init(name: "note.md", file: file.hash)]))
    return ProtocolSnapshot(root: root.hash, objects: [file, root].sorted { $0.hash < $1.hash })
}

private func snapshot(files: [String: String]) throws -> ProtocolSnapshot {
    var objects: [ProtocolObjectEnvelope] = []
    let entries = try files.keys.sorted { $0.utf8.lexicographicallyPrecedes($1.utf8) }.map { name in
        let file = try ProtocolObjectCodec.object(.file(Data(files[name, default: ""].utf8)))
        objects.append(file)
        return ProtocolDirectoryEntry(name: name, file: file.hash)
    }
    let root = try ProtocolObjectCodec.object(.directory(entries))
    objects.append(root)
    return ProtocolSnapshot(root: root.hash, objects: objects.sorted { $0.hash < $1.hash })
}

private func directoryBodySnapshot(
    stem: String,
    siblingSource: String,
    indexSource: String? = nil
) throws -> ProtocolSnapshot {
    let child = try ProtocolObjectCodec.object(.file(Data("# Child\n".utf8)))
    var directoryEntries = [ProtocolDirectoryEntry(name: "child.md", file: child.hash)]
    var objects = [child]
    if let indexSource {
        let index = try ProtocolObjectCodec.object(.file(Data(indexSource.utf8)))
        directoryEntries.append(.init(name: "_index.md", file: index.hash))
        objects.append(index)
    }
    directoryEntries.sort { $0.name.utf8.lexicographicallyPrecedes($1.name.utf8) }
    let directory = try ProtocolObjectCodec.object(.directory(directoryEntries))
    let sibling = try ProtocolObjectCodec.object(.file(Data(siblingSource.utf8)))
    let root = try ProtocolObjectCodec.object(.directory([
        .init(name: stem, directory: directory.hash),
        .init(name: stem + ".md", file: sibling.hash),
    ]))
    objects.append(contentsOf: [directory, sibling, root])
    return ProtocolSnapshot(root: root.hash, objects: objects.sorted { $0.hash < $1.hash })
}

private func protocolDirectoryEntries(snapshot: ProtocolSnapshot, directory hash: String) throws -> [ProtocolDirectoryEntry] {
    let envelope = try #require(snapshot.objects.first { $0.hash == hash })
    guard case let .directory(entries, _) = try ProtocolObjectCodec.decode(envelope.bytes, kind: .directory) else {
        throw ProtocolValidationError.invalidValue("Expected directory object")
    }
    return entries
}

private func protocolEntryNames(snapshot: ProtocolSnapshot, directory hash: String) throws -> Set<String> {
    Set(try protocolDirectoryEntries(snapshot: snapshot, directory: hash).map(\.name))
}

private func protocolDirectoryEntries(snapshot: WorkingTreeSnapshot, directory hash: String) throws -> [ProtocolDirectoryEntry] {
    let object = try #require(snapshot.objects.first { $0.hash == hash })
    guard case let .directory(entries, _) = try ProtocolObjectCodec.decode(try #require(object.bytes), kind: .directory) else {
        throw ProtocolValidationError.invalidValue("Expected directory object")
    }
    return entries
}

private func protocolEntryNames(snapshot: WorkingTreeSnapshot, directory hash: String) throws -> Set<String> {
    Set(try protocolDirectoryEntries(snapshot: snapshot, directory: hash).map(\.name))
}

private func completeCandidate(_ request: ProtocolUpdateRequest, retained: ProtocolSnapshot) throws -> ProtocolSnapshot {
    try completeCandidate(request.updates[0], retained: retained)
}

/// Rebuild one element's complete candidate from what the host retains plus
/// the element's objects and deltas.
private func completeCandidate(_ element: ProtocolCandidateUpdate, retained: ProtocolSnapshot) throws -> ProtocolSnapshot {
    var envelopes = Dictionary(uniqueKeysWithValues: retained.objects.map { ($0.hash, $0) })
    for object in element.objects { envelopes[object.hash] = object }
    for delta in element.deltas {
        let base = try #require(envelopes[delta.base])
        envelopes[delta.result] = ProtocolObjectEnvelope(hash: delta.result, bytes: try delta.apply(to: base.bytes))
    }
    var pending = [(element.candidate, ProtocolEntryKind.directory)]
    var visited = Set<String>()
    var objects: [ProtocolObjectEnvelope] = []
    while let (hash, kind) = pending.popLast() {
        if !visited.insert(hash).inserted { continue }
        let envelope = try #require(envelopes[hash])
        objects.append(envelope)
        if case let .directory(entries, _) = try ProtocolObjectCodec.decode(envelope.bytes, kind: kind) {
            for entry in entries {
                if let hash = entry.hash, let kind = entry.kind { pending.append((hash, kind)) }
            }
        }
    }
    return ProtocolSnapshot(root: element.candidate, objects: objects.sorted { $0.hash < $1.hash })
}

private func descriptor(tree: String, snapshot: ProtocolSnapshot, update: String) -> ProtocolTreeDescriptor {
    ProtocolTreeDescriptor(
        id: tree,
        kind: "ordinary",
        root: snapshot.root,
        access: "write",
        canonical: ProtocolCanonicalDescriptor(
            path: "/~owner/\(tree)",
            endpoint: "https://arbor.example"
        ),
        update: update
    )
}

private func accepted(id: String, tree: String, root: String, base: String, candidate: String) -> ProtocolAcceptedUpdate {
    ProtocolAcceptedUpdate(
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
    tree: ProtocolTreeDescriptor,
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
    let initial: ProtocolSnapshot
    let peer: ProtocolSnapshot
    let gate: FirstRequestGate?
    var received: [PreparedProtocolUpdate] = []
    var receipts: [String: ProtocolUpdateElementResult] = [:]
    var snapshots: [String: ProtocolSnapshot]
    var current: ProtocolSnapshot
    var currentID = "up_peer"
    init(initial: ProtocolSnapshot, peer: ProtocolSnapshot, gate: FirstRequestGate? = nil) {
        self.initial = initial; self.peer = peer; self.gate = gate; current = peer
        snapshots = [initial.root: initial]; snapshots[peer.root] = peer
    }
    func submit(_ prepared: PreparedProtocolUpdate) async throws -> ProtocolUpdateResponse {
        received.append(prepared)
        if received.count == 1, let gate { await gate.hold() }
        let request = try JSONDecoder().decode(ProtocolUpdateRequest.self, from: prepared.body)
        #expect(request.base == "up_initial")
        var candidate = initial
        var results: [ProtocolUpdateElementResult] = []
        for (index, element) in request.updates.enumerated() {
            #expect(element.trace?.allSatisfy { $0.operations.allSatisfy { $0.kind == "editSource" } } == true)
            // Like Canopy's immutable store, retain earlier authored candidates
            // even when their accepted projection selected the peer's bytes.
            candidate = try snapshots[element.candidate] ?? completeCandidate(element, retained: candidate)
            snapshots[candidate.root] = candidate
            let digest = prepared.requestDigests[index]
            if let receipt = receipts[digest] { results.append(receipt); continue }
            let selected = receipts.isEmpty ? peer : candidate
            let update = ProtocolAcceptedUpdate(id: "up_source_\(receipts.count)", tree: "tr_source_sessions", root: selected.root,
                previous: .init(id: currentID, root: current.root), acceptedAt: 1_800_000_000_000, conflicted: true)
            let result = ProtocolUpdateElementResult(result: .accepted(update), requestDigest: digest,
                reconciliation: selected.root == candidate.root ? nil : .init(objects: selected.objects))
            receipts[digest] = result; results.append(result)
            current = selected; currentID = update.id
        }
        return ProtocolUpdateResponse(results: results, observedThrough: "cursor_\(currentID)")
    }
    func descriptor(tree: String) throws -> ProtocolCurrentTree {
        ProtocolCurrentTree(tree: ProtocolTreeDescriptor(id: tree, kind: "ordinary", root: current.root, access: "write",
            canonical: nil, update: currentID, conflicted: !receipts.isEmpty), observedThrough: "cursor_\(currentID)")
    }
    func advanceIdentity() { currentID = "up_later" }
    func snapshot(tree: String, root: String) throws -> ProtocolSnapshot {
        guard let value = snapshots[root] else { throw UpdateError.returnedSnapshotMissing }
        return value
    }
}

@Suite("Source session publication")
struct SourceSessionPublicationTests {
    let treeID: TreeID = "tr_source_sessions"
    func makeTree(_ snapshot: ProtocolSnapshot, update: String) async throws -> WorkingTree {
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
            let coordinator = try UpdateCoordinator(workingTree: tree, transport: transport, stateRoot: root , publicationDelay: .seconds(3600), publicationMaxDelay: .seconds(3600))
            let provider = WorkingTreeProvider(workingTree: tree, coordinator: coordinator)
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
            let second = try JSONDecoder().decode(ProtocolUpdateRequest.self, from: requests[1].body)
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
            let coordinator = try UpdateCoordinator(workingTree: tree, transport: transport, stateRoot: root , publicationDelay: .seconds(3600), publicationMaxDelay: .seconds(3600))
            let provider = WorkingTreeProvider(workingTree: tree, coordinator: coordinator)
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
            let batch = try JSONDecoder().decode(ProtocolUpdateRequest.self, from: requests[1].body)
            #expect(batch.updates.count == 4)
            #expect(requests[0].requestDigests.first == requests[1].requestDigests.first)
            #expect(batch.updates.first?.objects.isEmpty == true)
            #expect(try await session.snapshot().source == "Fourth\n")
            #expect(try await coordinator.presentation().state == .current)
            await coordinator.close(); await session.close(); await tree.close()
        }
    }

    @Test("Concurrent append retries retain one identity")
    func concurrentRetry() async throws {
        try await withTemporaryRoot { root in
            let initial = try snapshot(markdown: "Before\n")
            let tree = try await makeTree(initial, update: "up_initial")
            let transport = SourceModeTransport(initial: initial, peer: initial)
            let coordinator = try UpdateCoordinator(workingTree: tree, transport: transport, stateRoot: root , publicationDelay: .seconds(3600), publicationMaxDelay: .seconds(3600))
            let basis = try await coordinator.sourceSnapshot(.init(tree: treeID, path: "/note"))
            let intent = try WorkspaceDocumentIntent(basis: basis, patch: .init(baseContentRevision: basis.contentRevision,
                edits: [.init(utf8Range: 0..<basis.source.utf8.count, replacement: "Mine\n", expected: basis.source)]), source: "Mine\n")
            async let first = coordinator.appendSourceIntent(intent)
            async let second = coordinator.appendSourceIntent(intent)
            let (a, b) = try await (first, second)
            #expect(a.contentRevision == b.contentRevision)
            let queue = try await ChangeLog(tree: treeID.rawValue, stateRoot: root)
            #expect(try await queue.retained().count == 1)
            await coordinator.close()
            await tree.close()
        }
    }

    @Test("Replaying an accepted receipt catches up to a later equal-root accepted identity")
    func replayCatchesUp() async throws {
        try await withTemporaryRoot { root in
            let initial = try snapshot(markdown: "Before\n"), peer = try snapshot(markdown: "Peer\n")
            let tree = try await makeTree(initial, update: "up_initial")
            let transport = SourceModeTransport(initial: initial, peer: peer)
            let coordinator = try UpdateCoordinator(workingTree: tree, transport: transport, stateRoot: root , faultInjector: OnePointFault(point: .afterServerAcceptance),
                publicationDelay: .seconds(3600), publicationMaxDelay: .seconds(3600))
            let provider = WorkingTreeProvider(workingTree: tree, coordinator: coordinator)
            #expect(await provider.capabilities().structuralActions == true)
            #expect(try await tree.heads().pendingRoot == nil)
            let session = try await provider.openDocument(.init(tree: treeID, path: "/note"))
            _ = try await replace("Mine\n", session: session, basis: session.snapshot())
            _ = try await coordinator.syncOnce()
            #expect(await coordinator.syncState.kind == "offline")
            await transport.advanceIdentity()
            await coordinator.close(); await session.close()
            let reopened = try UpdateCoordinator(workingTree: tree, transport: transport, stateRoot: root , publicationDelay: .seconds(3600), publicationMaxDelay: .seconds(3600))
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
            let coordinator = try UpdateCoordinator(workingTree: tree, transport: transport, stateRoot: root , faultInjector: OnePointFault(point: point),
                publicationDelay: .seconds(3600), publicationMaxDelay: .seconds(3600))
            let session = try await WorkingTreeProvider(workingTree: tree, coordinator: coordinator).openDocument(.init(tree: treeID, path: "/note"))
            _ = try await replace("Mine\n", session: session, basis: session.snapshot())
            _ = try await coordinator.syncOnce()
            #expect(await coordinator.syncState.kind != "current")
            let prior = await transport.received.first
            await coordinator.close(); await tree.close()
            let reopenedTree = try await makeTree(peer, update: "up_peer")
            let reopened = try UpdateCoordinator(workingTree: reopenedTree, transport: transport, stateRoot: root , publicationDelay: .seconds(3600), publicationMaxDelay: .seconds(3600))
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
            let coordinator = try UpdateCoordinator(workingTree: tree, transport: transport, stateRoot: root , publicationDelay: .seconds(3600), publicationMaxDelay: .seconds(3600))
            let provider = WorkingTreeProvider(workingTree: tree, coordinator: coordinator)
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
            let queue = try await ChangeLog(tree: treeID.rawValue, stateRoot: root)
            let records = try await queue.retained()
            #expect(records.count == 8)
            #expect(records[0].update.trace == nil)
            #expect(records[1].update.trace?.first?.operations.first?.kind == "editSource")
            #expect(records[3].update.trace?.first?.operations.first?.kind == "moveEntry")
            // New directory material is added, not edited from a made-up source identity.
            #expect(records[4].update.trace?.first?.operations.map(\.kind) == ["addEntry"])
            for index in 1..<records.count { #expect(records[index].basis == .authored(change: records[index - 1].change)) }
            await coordinator.close(); await session.close(); await body.close()
            let reopened = try UpdateCoordinator(workingTree: tree, transport: transport, stateRoot: root , publicationDelay: .seconds(3600), publicationMaxDelay: .seconds(3600))
            let recovered = WorkingTreeProvider(workingTree: tree, coordinator: reopened)
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
            let coordinator = try UpdateCoordinator(workingTree: tree, transport: transport, stateRoot: root , publicationDelay: .seconds(3600), publicationMaxDelay: .seconds(3600))
            let provider = WorkingTreeProvider(workingTree: tree, coordinator: coordinator)
            let action = WorkspaceStructuralAction.createMarkdown(parent: .init(tree: treeID, path: "/"), name: "retained", source: "Exact\r\n")
            let lock = root.appending(path: "sync/change-log.lock")
            try FileManager.default.createDirectory(at: lock, withIntermediateDirectories: true)
            do { _ = try await provider.perform(action); Issue.record("Expected retention failure") } catch { }
            #expect(try await tree.heads().acceptedRoot == initial.root)
            #expect(try await tree.heads().pendingRoot == nil)
            let queue = try await ChangeLog(tree: treeID.rawValue, stateRoot: root)
            #expect(try await queue.retained().isEmpty)
            try FileManager.default.removeItem(at: lock)
            let created = try #require(try await provider.perform(action))
            #expect(try await queue.retained().count == 1)
            #expect(try await provider.openDocument(created.reference).snapshot().source.hasSuffix("Exact\r\n") == true)
            let readOnly = WorkingTreeProvider(workingTree: tree, readOnly: true, coordinator: coordinator)
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
            let coordinator = try UpdateCoordinator(workingTree: tree, transport: transport, stateRoot: root , publicationDelay: .seconds(3600), publicationMaxDelay: .seconds(3600))
            let provider = WorkingTreeProvider(workingTree: tree, coordinator: coordinator)
            let bytes = Data([0, 255, 17])
            let file = try await provider.importFile(name: "private.bin", bytes: bytes, in: .init(tree: treeID, path: "/"))
            let trashed = try #require(try await provider.perform(.trash(reference: file.reference)))
            let records = try await ChangeLog(tree: treeID.rawValue, stateRoot: root).retained()
            #expect(records.last?.candidate.root == initial.root)
            #expect(records.last?.localTrash?.objects.contains(where: { $0.bytes == bytes }) == true)
            await coordinator.close(); await tree.close()
            let clean = try await makeTree(initial, update: "up_initial")
            let reopened = try UpdateCoordinator(workingTree: clean, transport: transport, stateRoot: root , publicationDelay: .seconds(3600), publicationMaxDelay: .seconds(3600))
            let recovered = WorkingTreeProvider(workingTree: clean, coordinator: reopened)
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
            let coordinator = try UpdateCoordinator(workingTree: tree, transport: transport, stateRoot: root , publicationDelay: .seconds(3600), publicationMaxDelay: .seconds(3600))
            let provider = WorkingTreeProvider(workingTree: tree, coordinator: coordinator)
            let parent = WorkspaceReference(tree: treeID, path: "/")
            let old = try await provider.openDocument(.init(tree: treeID, path: "/note"))
            let r1 = try await old.snapshot()
            let created = try #require(try await provider.perform(.createMarkdown(parent: parent, name: "created", source: "New\n")))
            let edited = try await replace("Old editor edit\n", session: old, basis: r1)
            #expect(try await provider.children(of: parent).contains { $0.reference.path == created.reference.path })
            #expect(await provider.capabilities().structuralActions == false)
            #expect(await provider.capabilities().assets == false)
            await #expect(throws: UpdateError.awaitingHostReconciliation) {
                try await provider.perform(.rename(reference: created.reference, name: "renamed"))
            }
            await #expect(throws: UpdateError.awaitingHostReconciliation) {
                try await provider.importFile(name: "blocked.bin", bytes: Data([1]), in: parent)
            }
            await #expect(throws: UpdateError.awaitingHostReconciliation) {
                try await provider.store(asset: .init(name: "blocked.bin", bytes: Data([1])), in: parent)
            }
            _ = try await replace("Still editable\n", session: old, basis: edited)
            let added = try await provider.openDocument(created.reference)
            let addedBasis = try await added.snapshot()
            _ = try await replace(addedBasis.source + "More\n", session: added, basis: addedBasis)
            let queue = try await ChangeLog(tree: treeID.rawValue, stateRoot: root)
            let records = try await queue.retained()
            #expect(records.count == 4)
            #expect(records[1].basis == .accepted(.init(root: initial.root, update: "up_initial")))
            #expect(records[2].basis == .authored(change: records[1].change))
            #expect(records[3].basis == .authored(change: records[0].change))
            #expect(try await coordinator.presentation().localRoot == records[0].candidate.root)
            await old.close(); await added.close(); await coordinator.close()
            let reopened = try UpdateCoordinator(workingTree: tree, transport: transport, stateRoot: root , publicationDelay: .seconds(3600), publicationMaxDelay: .seconds(3600))
            let recovered = WorkingTreeProvider(workingTree: tree, coordinator: reopened)
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
            let coordinator = try UpdateCoordinator(workingTree: tree, transport: SourceModeTransport(initial: initial, peer: peer), stateRoot: root , publicationDelay: .seconds(3600), publicationMaxDelay: .seconds(3600))
            let provider = WorkingTreeProvider(workingTree: tree, coordinator: coordinator)
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
    @Test("A journal written under its earlier name is adopted by the change log")
    func earlierJournalAdopted() async throws {
        try await withTemporaryRoot { root in
            let initial = try snapshot(markdown: "Before\n"), tree = try await makeTree(initial, update: "up_initial")
            let transport = SourceModeTransport(initial: initial, peer: initial)
            let coordinator = try UpdateCoordinator(workingTree: tree, transport: transport, stateRoot: root, publicationDelay: .seconds(3600), publicationMaxDelay: .seconds(3600))
            let session = try await WorkingTreeProvider(workingTree: tree, coordinator: coordinator).openDocument(.init(tree: treeID, path: "/note"))
            _ = try await replace("Retained\n", session: session, basis: session.snapshot())
            await session.close(); await coordinator.close()
            let sync = root.appending(path: "sync")
            let manager = FileManager.default
            try manager.moveItem(at: sync.appending(path: "change-log.json"), to: sync.appending(path: "source-admissions.json"))
            try manager.moveItem(at: sync.appending(path: "change-log-objects"), to: sync.appending(path: "source-admission-objects"))
            let adopted = try await ChangeLog(tree: treeID.rawValue, stateRoot: root).retained()
            #expect(adopted.count == 1)
            #expect(manager.fileExists(atPath: sync.appending(path: "change-log.json").path))
            #expect(!manager.fileExists(atPath: sync.appending(path: "source-admissions.json").path))
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
            let coordinator = try UpdateCoordinator(workingTree:tree,transport:transport,stateRoot:root ,publicationDelay:.seconds(3600),publicationMaxDelay:.seconds(3600))
            let provider = WorkingTreeProvider(workingTree:tree,coordinator:coordinator)
            let parent = WorkspaceReference(tree:treeID,path:"/")
            let renamed = try #require(try await provider.perform(.rename(reference:.init(tree:treeID,path:"/pair"),name:"renamed")))
            let group = try #require(try await provider.perform(.createDirectory(parent:parent,name:"group")))
            let moved = try #require(try await provider.perform(.move(reference:renamed.reference,destination:group.reference)))
            let copied = try #require(try await provider.perform(.copy(reference:moved.reference,destination:parent)))
            let copiedSource = try await provider.openDocument(copied.reference).snapshot().source
            #expect(copiedSource != source) // Fresh PageID, with copy provenance.
            #expect(copiedSource.hasSuffix("# Café\r\n"))
            let trashed = try #require(try await provider.perform(.trash(reference:moved.reference)))
            let queue = try await ChangeLog(tree:treeID.rawValue,stateRoot:root)
            let before = try await queue.retained()
            #expect(before[0].update.trace?.flatMap(\.operations).map(\.kind) == ["moveEntry","moveEntry"])
            #expect(before[2].update.trace?.flatMap(\.operations).map(\.kind) == ["moveEntry","moveEntry"])
            #expect(before[3].update.trace?.flatMap(\.operations).filter { $0.kind == "copyEntry" }.count == 2)
            #expect(before[3].update.trace?.flatMap(\.operations).contains { $0.kind == "editSource" } == true)
            #expect(before[4].update.trace?.flatMap(\.operations).map(\.kind) == ["removeEntry","removeEntry"])
            await coordinator.close(); await tree.close()
            let reopenedTree = try await makeTree(initial,update:"up_initial")
            let reopened = try UpdateCoordinator(workingTree:reopenedTree,transport:transport,stateRoot:root ,publicationDelay:.seconds(3600),publicationMaxDelay:.seconds(3600))
            let recovered = WorkingTreeProvider(workingTree:reopenedTree,coordinator:reopened)
            #expect(before.last?.localTrash?.nodes.contains { $0.path == trashed.reference.path && $0.source == source } == true)
            let restored = try #require(try await recovered.perform(.restore(reference:trashed.reference)))
            #expect(restored.reference.path == moved.reference.path)
            #expect(try await recovered.openDocument(restored.reference).snapshot().source == source)
            let after = try await ChangeLog(tree:treeID.rawValue,stateRoot:root).retained()
            #expect(Array(after.prefix(before.count)) == before)
            #expect(after.last?.candidate.root == before[3].candidate.root)
            #expect(after.last?.update.trace == nil) // Creation from private Trash.
            await reopened.close(); await reopenedTree.close()
        }
    }
}

extension SourceSessionPublicationTests {
    @Test("Pending source work keeps accepted modification dates in provider reads")
    func pendingReadsKeepDates() async throws {
        try await withTemporaryRoot { root in
            let initial = try snapshot(files: ["a.md": "A\n", "b.md": "---\nid: pg_b\n---\nB\n"])
            let aDate = Date(timeIntervalSince1970: 1_789_000_000), bDate = Date(timeIntervalSince1970: 1_788_000_000)
            let tree = try await WorkingTree.inMemory(tree: treeID)
            try await tree.initializeFromSystem(SnapshotBridge.replacement(snapshot: initial, tree: treeID,
                update: "up_initial", entryMetadata: ["/a.md": EntryMetadata(modifiedAt: aDate), "/b.md": EntryMetadata(modifiedAt: bDate)]))
            let coordinator = try UpdateCoordinator(workingTree: tree, transport: SourceModeTransport(initial: initial, peer: initial),
                stateRoot: root , publicationDelay: .seconds(3600), publicationMaxDelay: .seconds(3600))
            let provider = WorkingTreeProvider(workingTree: tree, coordinator: coordinator)
            func dates() async throws -> [String: Date] {
                Dictionary(uniqueKeysWithValues: try await provider.search("", in: treeID).compactMap { result in
                    result.modifiedAt.map { (result.reference.path, $0) }
                })
            }
            let started = Date()
            let session = try await provider.openDocument(.init(tree: treeID, path: "/a"))
            _ = try await replace("A edited\n", session: session, basis: try await session.snapshot())
            var pending = try await dates()
            #expect(pending["/b"] == bDate)
            #expect(try #require(pending["/a"]) >= started)

            // Reads between edits reuse one view instead of rebuilding it.
            #expect(try await coordinator.sourceReadProvider().workingTree === coordinator.sourceReadProvider().workingTree)

            let parent = WorkspaceReference(tree: treeID, path: "/")
            let group = try #require(try await provider.perform(.createDirectory(parent: parent, name: "group")))
            _ = try #require(try await provider.perform(.move(reference: .init(tree: treeID, path: "/b"), destination: group.reference)))
            pending = try await dates()
            // A move is a modification here, exactly as on the live working tree.
            #expect(try #require(pending["/group/b"]) >= started)
            #expect(try #require(pending["/a"]) >= started)
            #expect(try await tree.heads().acceptedRoot == initial.root)
            await coordinator.close(); await session.close(); await tree.close()
        }
    }
}
