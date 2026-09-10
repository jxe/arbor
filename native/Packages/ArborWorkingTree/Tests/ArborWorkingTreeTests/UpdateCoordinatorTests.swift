import ArborKit
import ArborReplica
@testable import CanopyClient
import ArborWire
import Foundation
import Testing

private actor ClosureTransport: ReplicaWireTransport {
    typealias Submit = @Sendable (PreparedWireUpdate, Int) async throws -> WireUpdateResponse
    let initial: WireSnapshot
    let current: WireSnapshot
    let snapshots: [String: WireSnapshot]
    let currentUpdate: String
    let currentObservedThrough: String
    let submitter: Submit
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
        self.submitter = submitter
    }

    func submit(_ prepared: PreparedWireUpdate) async throws -> WireUpdateResponse {
        requests.append(prepared)
        return try await submitter(prepared, requests.count)
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
        guard let snapshot = snapshots[root] else { throw ReplicaSyncError.returnedSnapshotMismatch }
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

private struct OnePointFault: ReplicaSyncFaultInjector {
    let point: ReplicaSyncFailurePoint
    func reached(_ point: ReplicaSyncFailurePoint) throws {
        if point == self.point { throw InjectedSyncCrash() }
    }
}

@Suite("Native replica synchronization")
struct ReplicaSynchronizationTests {
    @Test("Pairing payload is versioned and server scoped")
    func pairingPayload() throws {
        let payload = PairingPayload(
            origin: URL(string: "https://arbor.example")!,
            pairing: .init(id: "pa_test", secret: "secret")
        )
        #expect(try payload.validated() == payload)
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
                .init(name: "_store.json", hash: source.hash),
                .init(name: "schema.ts", hash: schema.hash),
            ], childrenSource: descriptor))
            let snapshot = WireSnapshot(root: directory.hash, objects: [directory, schema, source])
            let replacement = try SnapshotBridge.replacement(
                snapshot: snapshot,
                tree: TreeID(rawValue: "tr_collection"),
                update: "up_collection"
            )
            let replica = try await ArborReplica.open(at: root.appending(path: "collection"), tree: TreeID(rawValue: "tr_collection"))
            try await replica.initializeFromSystem(replacement)
            let rebuilt = try await replica.currentSnapshot()
            #expect(rebuilt.root == snapshot.root)
            #expect(Set(rebuilt.objects.map(\.hash)) == Set(snapshot.objects.map(\.hash)))
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

            var replica = try await ArborReplica.open(at: root.appending(path: "replica"), tree: tree)
            try await replica.initializeFromSystem(replacement)
            #expect(try await replica.currentSnapshot().root == original.root)
            await replica.close()

            replica = try await ArborReplica.open(at: root.appending(path: "replica"), tree: tree)
            #expect(try await replica.currentSnapshot().root == original.root)
            let session = try await ReplicaWorkspaceProvider(replica: replica).openDocument(
                .init(tree: tree, path: "/March-Out-My-Work", stableKey: markdownStableKey("pg_march"))
            )
            let before = try await session.snapshot()
            let editedSource = before.source + "\nEdited without moving the body.\n"
            _ = try await session.admit(source: editedSource, baseContentRevision: before.contentRevision)
            let expected = try directoryBodySnapshot(stem: "March-Out-My-Work", siblingSource: editedSource)
            #expect(try await replica.currentSnapshot().root == expected.root)
        }
    }

    @Test("Sibling Markdown placement survives structural operations")
    func siblingMarkdownStructuralOperations() async throws {
        try await withTemporaryRoot { root in
            let tree: TreeID = "tr_siblingstructure"
            let source = "---\nid: pg_pair\n---\n\n# Pair\n"
            let original = try directoryBodySnapshot(stem: "pair", siblingSource: source)
            let replacement = try SnapshotBridge.replacement(snapshot: original, tree: tree, update: "up_initial")
            let replica = try await ArborReplica.open(at: root.appending(path: "replica"), tree: tree)
            try await replica.initializeFromSystem(replacement)
            let provider = ReplicaWorkspaceProvider(replica: replica)
            let rootReference = WorkspaceReference(tree: tree, path: "/")

            let renamed = try #require(try await provider.perform(.rename(
                reference: .init(tree: tree, path: "/pair", stableKey: markdownStableKey("pg_pair")),
                name: "renamed"
            )))
            var snapshot = try await replica.currentSnapshot()
            #expect(try wireEntryNames(snapshot: snapshot, directory: snapshot.root).isSuperset(of: ["renamed", "renamed.md"]))

            let archive = try #require(try await provider.perform(.createDirectory(parent: rootReference, name: "archive")))
            let moved = try #require(try await provider.perform(.move(reference: renamed.reference, destination: archive.reference)))
            snapshot = try await replica.currentSnapshot()
            let rootEntries = try wireDirectoryEntries(snapshot: snapshot, directory: snapshot.root)
            let archiveHash = try #require(rootEntries.first { $0.name == "archive" }?.hash)
            #expect(try wireEntryNames(snapshot: snapshot, directory: archiveHash).isSuperset(of: ["renamed", "renamed.md"]))

            _ = try #require(try await provider.perform(.copy(reference: moved.reference, destination: rootReference)))
            snapshot = try await replica.currentSnapshot()
            #expect(try wireEntryNames(snapshot: snapshot, directory: snapshot.root).isSuperset(of: ["renamed", "renamed.md"]))

            let beforeTrash = snapshot.root
            let trashed = try #require(try await provider.perform(.trash(reference: moved.reference)))
            _ = try #require(try await provider.perform(.restore(reference: trashed.reference)))
            #expect(try await replica.currentSnapshot().root == beforeTrash)
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

            var replica = try await ArborReplica.open(at: root.appending(path: "replica"), tree: tree)
            try await replica.initializeFromSystem(replacement)
            #expect(try await replica.currentSnapshot().root == original.root)
            await replica.close()
            replica = try await ArborReplica.open(at: root.appending(path: "replica"), tree: tree)
            #expect(try await replica.currentSnapshot().root == original.root)
        }
    }

    @Test("Multiple sibling bodies fail before logical materialization")
    func ambiguousSiblingBodies() throws {
        let markdown = try WireObjectCodec.object(.file(Data("# Markdown\n".utf8)))
        let mdx = try WireObjectCodec.object(.file(Data("# MDX\n".utf8)))
        let directory = try WireObjectCodec.object(.directory([]))
        let root = try WireObjectCodec.object(.directory([
            .init(name: "x", hash: directory.hash),
            .init(name: "x.md", hash: markdown.hash),
            .init(name: "x.mdx", hash: mdx.hash),
        ]))
        let snapshot = WireSnapshot(root: root.hash, objects: [root, directory, markdown, mdx])

        #expect(throws: ArborWireValidationError.self) {
            _ = try SnapshotBridge.replacement(snapshot: snapshot, tree: "tr_ambiguous", update: "up_initial")
        }

        let plain = try WireObjectCodec.object(.file(Data("plain".utf8)))
        let duplicateRoot = try WireObjectCodec.object(.directory([
            .init(name: "same", hash: plain.hash),
            .init(name: "same.md", hash: markdown.hash),
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
            let replica = try await ReplicaPlacementService.place(
                tree: descriptor(tree: tree, snapshot: initial, update: "up_initial"),
                at: root.appending(path: "replica"),
                transport: transport
            )
            let provider = ReplicaWorkspaceProvider(replica: replica)
            let session = try await provider.openDocument(.init(tree: TreeID(rawValue: tree), path: "/note", stableKey: markdownStableKey("pg_note")))
            let base = try await session.snapshot()
            _ = try await session.admit(source: base.source + "Local\n", baseContentRevision: base.contentRevision)

            let coordinator = try ReplicaSyncCoordinator(replica: replica, transport: transport, stateRoot: root)
            let result = try await coordinator.syncOnce()
            #expect(result.state == .current)
            #expect(try await replica.heads().pendingRoot == nil)
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
            let replica = try await ReplicaPlacementService.place(
                tree: descriptor(tree: tree, snapshot: initial, update: "up_initial"),
                at: root.appending(path: "replica"),
                transport: transport
            )
            let coordinator = try ReplicaSyncCoordinator(
                replica: replica,
                transport: transport,
                stateRoot: root.appending(path: "sync")
            )
            let provider = ReplicaWorkspaceProvider(replica: replica) { admission in
                await coordinator.syncImmediately(admission)
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
            #expect(try await replica.heads().pendingRoot == nil)
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
            let replica = try await ReplicaPlacementService.place(
                tree: descriptor(tree: tree, snapshot: initial, update: "up_initial"),
                at: root.appending(path: "replica"),
                transport: transport
            )
            let coordinator = try ReplicaSyncCoordinator(replica: replica, transport: transport, stateRoot: root.appending(path: "sync"))
            let provider = ReplicaWorkspaceProvider(replica: replica) { admission in await coordinator.syncImmediately(admission) }
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
            for _ in 0..<200 where try await replica.heads().pendingRoot != nil { try await Task.sleep(for: .milliseconds(10)) }
            let requests = await transport.requests
            #expect(requests.count == 2)
            let prefix = try JSONDecoder().decode(WireUpdateRequest.self, from: requests[0].body)
            let successor = try JSONDecoder().decode(WireUpdateRequest.self, from: requests[1].body)
            #expect(prefix.updates.count == 1)
            // The successor is a new request against the applied base, not a longer concurrent prefix.
            #expect(successor.updates.count == 1)
            #expect(successor.base == "up_successor_1_1")
            #expect(successor.updates.first?.candidate == (try await replica.heads().materializedRoot))
            #expect(try await replica.heads().pendingRoot == nil)
            #expect(await coordinator.syncState.kind == "current")
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
            let replica = try await ReplicaPlacementService.place(
                tree: descriptor(tree: tree, snapshot: initial, update: "up_initial"),
                at: root.appending(path: "replica"),
                transport: transport
            )
            let coordinator = try ReplicaSyncCoordinator(replica: replica, transport: transport, stateRoot: root.appending(path: "sync"))
            let provider = ReplicaWorkspaceProvider(replica: replica) { admission in await coordinator.syncImmediately(admission) }
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
            for _ in 0..<300 where try await replica.heads().pendingRoot != nil { try await Task.sleep(for: .milliseconds(10)) }
            let requests = await transport.requests
            #expect(requests.count == 1)
            let request = try JSONDecoder().decode(WireUpdateRequest.self, from: try #require(requests.first?.body))
            #expect(request.updates.count == 1)
            #expect(request.candidate == (try await replica.heads().materializedRoot))
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
            let replica = try await ReplicaPlacementService.place(
                tree: descriptor(tree: tree, snapshot: initial, update: "up_initial"),
                at: root.appending(path: "replica"),
                transport: transport
            )
            let coordinator = try ReplicaSyncCoordinator(
                replica: replica,
                transport: transport,
                stateRoot: root.appending(path: "sync")
            )
            let provider = ReplicaWorkspaceProvider(replica: replica) { admission in
                await coordinator.syncImmediately(admission)
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

            let latestRoot = try await replica.heads().materializedRoot
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
            for _ in 0..<100 where try await replica.heads().pendingRoot != nil {
                try await Task.sleep(for: .milliseconds(10))
            }
            #expect(try await replica.heads().pendingRoot == nil)
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
            let replica = try await ReplicaPlacementService.place(
                tree: descriptor(tree: tree, snapshot: initial, update: "up_initial"),
                at: root.appending(path: "replica"),
                transport: bootstrap
            )
            let remoteTransport = ClosureTransport(initial: remote, currentUpdate: "up_remote") { _, _ in
                throw ArborWireValidationError.invalidValue("A clean watch pull must not submit")
            }
            let coordinator = try ReplicaSyncCoordinator(replica: replica, transport: remoteTransport, stateRoot: root)
            let event = WireWatchEvent(
                id: "up_remote",
                tree: descriptor(tree: tree, snapshot: remote, update: "up_remote")
            )
            let result = try await coordinator.observe(event)
            #expect(result.state == .current)
            #expect(result.acceptedRoot == remote.root)
            #expect(try await replica.heads().acceptedCursor == "up_remote")
            #expect(await remoteTransport.descriptorRequests == 1)
            #expect(await remoteTransport.requestedRoots == [remote.root])
            #expect(await remoteTransport.requests.isEmpty)
        }
    }

    @Test("A clean watch applies an accepted transition without fetching a snapshot")
    func cleanWatchTransition() async throws {
        try await withTemporaryRoot { root in
            let tree = "tr_watchtransition"
            let initial = try snapshot(markdown: "---\nid: pg_note\n---\n\n# Note\n\nOne\n")
            let remote = try snapshot(markdown: "---\nid: pg_note\n---\n\n# Note\n\nTwo\n")
            let transport = ClosureTransport(initial: initial) { _, _ in
                throw ArborWireValidationError.invalidValue("A clean watch transition must not submit")
            }
            let replica = try await ReplicaPlacementService.place(
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
                previousRoot: initial.root,
                kind: "accepted",
                acceptedAt: 1_800_000_000_000
            )
            let transition = WireAcceptedTransition(
                update: update,
                objects: [try #require(remote.objects.first { $0.hash == remote.root })],
                deltas: [WireObjectDelta(
                    base: initialFile.hash,
                    result: remoteFile.hash,
                    instructions: [.insert(remoteFile.bytes)]
                )]
            )
            let coordinator = try ReplicaSyncCoordinator(replica: replica, transport: transport, stateRoot: root)
            let result = try await coordinator.observe(WireWatchEvent(
                id: update.id,
                tree: descriptor(tree: tree, snapshot: remote, update: update.id),
                transitions: [transition]
            ))

            #expect(result.state == .current)
            #expect(result.acceptedRoot == remote.root)
            #expect(await transport.snapshotRequests == snapshotRequestsBefore)
            #expect(await transport.requests.isEmpty)
            #expect(try await replica.heads().acceptedCursor == update.id)
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
            let replica = try await ReplicaPlacementService.place(
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
            let coordinator = try ReplicaSyncCoordinator(replica: replica, transport: remoteTransport, stateRoot: root)

            let result = try await coordinator.recoverWatchGap()

            #expect(result.state == .current)
            #expect(result.acceptedRoot == remote.root)
            #expect(try await replica.heads().acceptedUpdate == "up_remote")
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
            let replica = try await ReplicaPlacementService.place(
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
            let coordinator = try ReplicaSyncCoordinator(
                replica: replica,
                transport: remoteTransport,
                stateRoot: root.appending(path: "sync"),
                transportAvailable: false
            )

            await coordinator.setTransportAvailable(true)

            #expect(try await replica.heads().materializedRoot == remote.root)
            #expect(try await coordinator.watchCursor() == "observation_after_remote")
            #expect(await remoteTransport.descriptorRequests == 1)
            #expect(await remoteTransport.requestedRoots == [remote.root])
            #expect(await remoteTransport.requests.isEmpty)
        }
    }

    @Test("A matching watch digest recovers a lost update response without reconnecting")
    func watchDigestRecovery() async throws {
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
            let replica = try await ReplicaPlacementService.place(
                tree: descriptor(tree: tree, snapshot: initial, update: "up_initial"),
                at: root.appending(path: "replica"),
                transport: transport
            )
            let session = try await ReplicaWorkspaceProvider(replica: replica).openDocument(
                .init(tree: TreeID(rawValue: tree), path: "/note", stableKey: markdownStableKey("pg_note"))
            )
            let base = try await session.snapshot()
            _ = try await session.admit(source: base.source + "Local\n", baseContentRevision: base.contentRevision)
            let coordinator = try ReplicaSyncCoordinator(replica: replica, transport: transport, stateRoot: root)
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
                update: "up_local"
            )
            let result = try await coordinator.observe(.init(
                id: "up_local",
                tree: eventTree,
                requestDigest: frozen.requestDigest
            ))
            #expect(result.state == .current)
            #expect(await transport.requests.count == 2)
            #expect(try await replica.heads().acceptedCursor == "up_local")
        }
    }

    @Test("A frozen request advances the base beneath newer admitted local work")
    func localTail() async throws {
        try await withTemporaryRoot { root in
            let tree = "tr_tail"
            let initial = try snapshot(markdown: "---\nid: pg_note\n---\n\n# Note\n\nBase\n")
            let bootstrap = ClosureTransport(initial: initial) { _, _ in throw InjectedSyncCrash() }
            let replica = try await ReplicaPlacementService.place(
                tree: descriptor(tree: tree, snapshot: initial, update: "up_initial"),
                at: root.appending(path: "replica"),
                transport: bootstrap
            )
            let provider = ReplicaWorkspaceProvider(replica: replica)
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
            let coordinator = try ReplicaSyncCoordinator(replica: replica, transport: transport, stateRoot: root)
            // The accepted frozen candidate advances the base beneath the retained
            // successor, which publishes against that base without waiting, so one
            // explicit synchronization settles both requests.
            let settled = try await coordinator.syncOnce()
            #expect(settled.state == .current)
            #expect(await coordinator.syncState.kind == "current")
            #expect((try await session.snapshot()).source.hasSuffix("Candidate\nTail\n"))
            #expect(try await replica.heads().pendingRoot == nil)
            let requests = await transport.requests
            #expect(requests.count == 2)
            let firstRequest = try JSONDecoder().decode(WireUpdateRequest.self, from: requests[0].body)
            let secondRequest = try JSONDecoder().decode(WireUpdateRequest.self, from: requests[1].body)
            #expect(firstRequest.base == "up_initial")
            #expect(firstRequest.candidate != secondRequest.candidate)
            #expect(secondRequest.base == "up_1")
            #expect(try await replica.heads().acceptedRoot == secondRequest.candidate)
            #expect(try await replica.heads().acceptedUpdate == "up_2")
            #expect(candidate.contentRevision != (try await session.snapshot()).contentRevision)
        }
    }

    @Test("Conflict keeps both graphs and explicit local choice uses the returned remote base")
    func conflictResolution() async throws {
        try await withTemporaryRoot { root in
            let tree = "tr_conflict"
            let initial = try snapshot(markdown: "---\nid: pg_note\n---\n\n# Note\n\nBase\n")
            let remote = try snapshot(markdown: "---\nid: pg_note\n---\n\n# Note\n\nRemote\n")
            let draft = try snapshot(markdown: "---\nid: pg_note\n---\n\n# Note\n\nLocal\nRemote\n")
            let bootstrap = ClosureTransport(initial: initial) { _, _ in throw InjectedSyncCrash() }
            let replica = try await ReplicaPlacementService.place(
                tree: descriptor(tree: tree, snapshot: initial, update: "up_initial"),
                at: root.appending(path: "replica"),
                transport: bootstrap
            )
            let session = try await ReplicaWorkspaceProvider(replica: replica).openDocument(
                .init(tree: TreeID(rawValue: tree), path: "/note", stableKey: markdownStableKey("pg_note"))
            )
            let localBase = try await session.snapshot()
            _ = try await session.admit(source: localBase.source + "Local\n", baseContentRevision: localBase.contentRevision)
            let current = accepted(id: "up_remote", tree: tree, root: remote.root, base: initial.root, candidate: remote.root)
            let conflict = WireUpdateConflict(
                message: "unsafe",
                current: current,
                base: initial.root,
                candidate: try await replica.currentSnapshot().root,
                draft: WireConflictDraft(root: draft.root, objects: draft.objects),
                conflicts: [.init(path: "/note.md", reason: "frontmatter-conflict")]
            )
            let conflictTransport = ClosureTransport(initial: initial) { _, _ in
                throw WireUpdateConflictError(conflict: conflict)
            }
            let coordinator = try ReplicaSyncCoordinator(replica: replica, transport: conflictTransport, stateRoot: root)
            #expect(try await coordinator.syncOnce().state == .conflict)
            #expect(try await coordinator.conflict()?.draft == draft.root)
            let retainedConflict = try DurableSyncFiles(root: root).load().conflict
            let retainedLocalRoot = try await replica.currentSnapshot().root
            #expect(retainedConflict?.attempt?.candidate == retainedLocalRoot)
            #expect(retainedConflict?.attempt?.allRequestDigests.count == 1)

            var sequencedControl = try DurableSyncFiles(root: root).load()
            var sequencedAttempt = try #require(sequencedControl.conflict?.attempt)
            var sequencedRequest = try JSONDecoder().decode(WireUpdateRequest.self, from: sequencedAttempt.body)
            sequencedRequest.updates.append(try #require(sequencedRequest.updates.first))
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.sortedKeys]
            sequencedAttempt.body = try encoder.encode(sequencedRequest)
            sequencedAttempt.requestDigests = sequencedAttempt.allRequestDigests + ["unattempted-suffix"]
            sequencedAttempt.digest = "unattempted-suffix"
            sequencedControl.conflict?.attempt = sequencedAttempt
            try DurableSyncFiles(root: root).write(sequencedControl)
            let sequencedCoordinator = try ReplicaSyncCoordinator(replica: replica, transport: conflictTransport, stateRoot: root)
            await #expect(throws: ReplicaSyncError.conflictSequenceRequiresReview) {
                try await sequencedCoordinator.resolveConflictKeepingLocal()
            }
            var originalControl = sequencedControl
            originalControl.conflict?.attempt = retainedConflict?.attempt
            try DurableSyncFiles(root: root).write(originalControl)
            try await coordinator.resolveConflictKeepingLocal()

            let accepting = ClosureTransport(initial: initial) { prepared, _ in
                let request = try JSONDecoder().decode(WireUpdateRequest.self, from: prepared.body)
                #expect(request.base == "up_remote")
                let candidate = try completeCandidate(request, retained: initial)
                return WireUpdateResponse(
                    result: .accepted(accepted(id: "up_resolved", tree: tree, root: candidate.root, base: remote.root, candidate: candidate.root)),
                    requestDigest: prepared.requestDigest,
                    observedThrough: "up_resolved"
                )
            }
            let resumed = try ReplicaSyncCoordinator(replica: replica, transport: accepting, stateRoot: root)
            #expect(try await resumed.syncOnce().state == .current)
        }
    }

    @Test("Conflict workspace exposes content and submits per-path draft and edited choices")
    func conflictWorkspaceResolution() async throws {
        try await withTemporaryRoot { root in
            let tree = "tr_conflict_workspace"
            let initial = try snapshot(files: [
                "current.md": "---\nid: pg_current\n---\n\n# Current choice\n\nBase current\n",
                "mine.md": "---\nid: pg_mine\n---\n\n# Mine choice\n\nBase mine\n",
                "note.md": "---\nid: pg_note\n---\n\n# Note\n\nBase\n",
                "other.md": "---\nid: pg_other\n---\n\n# Other\n\nBase other\n",
            ])
            let remote = try snapshot(files: [
                "current.md": "---\nid: pg_current\n---\n\n# Current choice\n\nRemote current\n",
                "mine.md": "---\nid: pg_mine\n---\n\n# Mine choice\n\nRemote mine\n",
                "note.md": "---\nid: pg_note\n---\n\n# Note\n\nRemote\n",
                "other.md": "---\nid: pg_other\n---\n\n# Other\n\nRemote other\n",
            ])
            let draft = try snapshot(files: [
                "current.md": "---\nid: pg_current\n---\n\n# Current choice\n\nMine current\nRemote current\n",
                "mine.md": "---\nid: pg_mine\n---\n\n# Mine choice\n\nMine mine\nRemote mine\n",
                "note.md": "---\nid: pg_note\n---\n\n# Note\n\nMine\nRemote\n",
                "other.md": "---\nid: pg_other\n---\n\n# Other\n\nMine other\nRemote other\n",
            ])
            let bootstrap = ClosureTransport(initial: initial) { _, _ in throw InjectedSyncCrash() }
            let replica = try await ReplicaPlacementService.place(
                tree: descriptor(tree: tree, snapshot: initial, update: "up_initial"),
                at: root.appending(path: "replica"),
                transport: bootstrap
            )
            let provider = ReplicaWorkspaceProvider(replica: replica)
            let currentChoice = try await provider.openDocument(.init(tree: .init(rawValue: tree), path: "/current", stableKey: markdownStableKey("pg_current")))
            let mineChoice = try await provider.openDocument(.init(tree: .init(rawValue: tree), path: "/mine", stableKey: markdownStableKey("pg_mine")))
            let note = try await provider.openDocument(.init(tree: .init(rawValue: tree), path: "/note", stableKey: markdownStableKey("pg_note")))
            let other = try await provider.openDocument(.init(tree: .init(rawValue: tree), path: "/other", stableKey: markdownStableKey("pg_other")))
            let currentChoiceBase = try await currentChoice.snapshot()
            let mineChoiceBase = try await mineChoice.snapshot()
            let noteBase = try await note.snapshot()
            let otherBase = try await other.snapshot()
            _ = try await currentChoice.admit(source: currentChoiceBase.source.replacingOccurrences(of: "Base current", with: "Mine current"), baseContentRevision: currentChoiceBase.contentRevision)
            _ = try await mineChoice.admit(source: mineChoiceBase.source.replacingOccurrences(of: "Base mine", with: "Mine mine"), baseContentRevision: mineChoiceBase.contentRevision)
            _ = try await note.admit(source: noteBase.source.replacingOccurrences(of: "Base", with: "Mine"), baseContentRevision: noteBase.contentRevision)
            _ = try await other.admit(source: otherBase.source.replacingOccurrences(of: "Base other", with: "Mine other"), baseContentRevision: otherBase.contentRevision)
            let localRoot = try await replica.currentSnapshot().root
            let current = accepted(id: "up_remote", tree: tree, root: remote.root, base: initial.root, candidate: remote.root)
            let conflict = WireUpdateConflict(
                message: "unsafe",
                current: current,
                base: initial.root,
                candidate: localRoot,
                draft: WireConflictDraft(root: draft.root, objects: draft.objects),
                conflicts: [
                    .init(path: "/current.md", reason: "frontmatter-conflict"),
                    .init(path: "/mine.md", reason: "frontmatter-conflict"),
                    .init(path: "/note.md", reason: "frontmatter-conflict"),
                    .init(path: "/other.md", reason: "frontmatter-conflict"),
                ]
            )
            let transport = ClosureTransport(
                initial: initial,
                current: remote,
                additionalSnapshots: [draft],
                currentUpdate: "up_remote",
                currentObservedThrough: "cursor_remote"
            ) { prepared, call in
                if call == 1 { throw WireUpdateConflictError(conflict: conflict) }
                let request = try JSONDecoder().decode(WireUpdateRequest.self, from: prepared.body)
                #expect(request.base == "up_remote")
                let candidate = try completeCandidate(request, retained: remote)
                return WireUpdateResponse(
                    result: .accepted(accepted(id: "up_resolved", tree: tree, root: candidate.root, base: remote.root, candidate: candidate.root)),
                    requestDigest: prepared.requestDigest,
                    observedThrough: "up_resolved"
                )
            }
            let coordinator = try ReplicaSyncCoordinator(replica: replica, transport: transport, stateRoot: root)
            #expect(try await coordinator.syncOnce().state == .conflict)
            let workspace = try #require(try await coordinator.conflictWorkspace())
            #expect(workspace.items.count == 4)
            let noteItem = try #require(workspace.items.first { $0.path == "/note.md" })
            #expect(noteItem.base.editableText?.contains("Base") == true)
            #expect(noteItem.current.editableText?.contains("Remote") == true)
            #expect(noteItem.mine.editableText?.contains("Mine") == true)
            #expect(noteItem.draft.editableText?.contains("Mine\nRemote") == true)
            #expect(noteItem.offersBoth)
            #expect(await transport.snapshotRequests == 2)

            let restarted = try ReplicaSyncCoordinator(replica: replica, transport: transport, stateRoot: root)
            #expect(try await restarted.conflictWorkspace()?.items == workspace.items)
            #expect(await transport.snapshotRequests == 2)

            try await restarted.resolveConflict([
                "/current.md": .current,
                "/mine.md": .mine,
                "/note.md": .both,
                "/other.md": .edit("---\nid: pg_other\n---\n\n# Other\n\nReviewed\n"),
            ])
            #expect(try await restarted.syncOnce().state == .current)
            #expect((try await currentChoice.snapshot()).source.contains("Remote current"))
            #expect(!(try await currentChoice.snapshot()).source.contains("Mine current"))
            #expect((try await mineChoice.snapshot()).source.contains("Mine mine"))
            #expect(!(try await mineChoice.snapshot()).source.contains("Remote mine"))
            #expect((try await note.snapshot()).source.contains("Mine\nRemote"))
            #expect((try await other.snapshot()).source.hasSuffix("Reviewed\n"))
            #expect(try DurableSyncFiles(root: root).load().conflict == nil)
        }
    }

    @Test("Every coordinator crash point replays one semantic intent")
    func crashRecovery() async throws {
        for point in ReplicaSyncFailurePoint.allCases where point != .duringMaterialization && point != .afterMaterialization {
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
                let replica = try await ReplicaPlacementService.place(
                    tree: descriptor(tree: tree, snapshot: initial, update: "up_initial"),
                    at: root.appending(path: "replica"),
                    transport: transport
                )
                let provider = ReplicaWorkspaceProvider(replica: replica)
                _ = try await provider.perform(.createMarkdown(
                    parent: .init(tree: TreeID(rawValue: tree), path: "/"),
                    name: "local",
                    source: "# Local\n"
                ))
                let crashing = try ReplicaSyncCoordinator(
                    replica: replica,
                    transport: transport,
                    stateRoot: root,
                    faultInjector: OnePointFault(point: point)
                )
                await #expect(throws: InjectedSyncCrash.self) { _ = try await crashing.syncOnce() }
                let resumed = try ReplicaSyncCoordinator(replica: replica, transport: transport, stateRoot: root)
                #expect(try await resumed.syncOnce().state == .current)
                let requests = await transport.requests
                let frozen = try JSONDecoder().decode(WireUpdateRequest.self, from: try #require(requests.first).body)
                #expect(frozen.objects.count < (try await replica.currentSnapshot()).objects.count)
                if requests.count > 1 {
                    #expect(Set(requests.map(\.requestDigest)).count == 1)
                    #expect(Set(requests.map(\.body)).count == 1)
                }
            }
        }
    }

    @Test("Materialization crashes replay the exact merged response safely")
    func materializationCrashRecovery() async throws {
        for point in [ReplicaSyncFailurePoint.duringMaterialization, .afterMaterialization] {
            try await withTemporaryRoot { root in
                let tree = "tr_materialize_\(point.rawValue)"
                let initial = try snapshot(markdown: "---\nid: pg_note\n---\n\n# Note\n\nBase\n")
                let merged = try snapshot(markdown: "---\nid: pg_note\n---\n\n# Note\n\nBase\nLocal\nRemote\n")
                let transport = ClosureTransport(initial: initial) { prepared, _ in
                    let request = try JSONDecoder().decode(WireUpdateRequest.self, from: prepared.body)
                    let summary = WireMergeSummary(version: "markdown-additive-v1", approximatePlacements: 0)
                    let update = WireAcceptedUpdate(
                        id: "up_merged",
                        tree: tree,
                        root: merged.root,
                        previousRoot: initial.root,
                        kind: "merged",
                        acceptedAt: 1_800_000_000_000,
                        baseRoot: initial.root,
                        candidateRoot: request.candidate,
                        remoteRoot: initial.root,
                        merge: summary
                    )
                    return WireUpdateResponse(result: .merged(update, summary), requestDigest: prepared.requestDigest, reconciliation: WireTransitionPayload(objects: merged.objects), observedThrough: update.id)
                }
                let replica = try await ReplicaPlacementService.place(
                    tree: descriptor(tree: tree, snapshot: initial, update: "up_initial"),
                    at: root.appending(path: "replica"),
                    transport: transport
                )
                let session = try await ReplicaWorkspaceProvider(replica: replica).openDocument(
                    .init(tree: TreeID(rawValue: tree), path: "/note", stableKey: markdownStableKey("pg_note"))
                )
                let base = try await session.snapshot()
                _ = try await session.admit(source: base.source + "Local\n", baseContentRevision: base.contentRevision)

                let crashing = try ReplicaSyncCoordinator(
                    replica: replica,
                    transport: transport,
                    stateRoot: root,
                    faultInjector: OnePointFault(point: point)
                )
                await #expect(throws: InjectedSyncCrash.self) { _ = try await crashing.syncOnce() }
                let resumed = try ReplicaSyncCoordinator(replica: replica, transport: transport, stateRoot: root)
                #expect(try await resumed.syncOnce().state == .autoMerged)
                #expect(try await replica.heads().acceptedRoot == merged.root)
                let requests = await transport.requests
                #expect(requests.count == 2)
                #expect(Set(requests.map(\.requestDigest)).count == 1)
                #expect(Set(requests.map(\.body)).count == 1)
            }
        }
    }
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
            let transport = ArborWireReplicaTransport(client: client)
            let mac = try await ReplicaPlacementService.place(
                tree: tree,
                at: root.appending(path: "mac"),
                transport: transport
            )
            let tablet = try await ReplicaPlacementService.place(
                tree: tree,
                at: root.appending(path: "tablet"),
                transport: transport
            )
            let reference = WorkspaceReference(tree: TreeID(rawValue: tree.id), path: "/note", stableKey: markdownStableKey("pg_note"))
            let macSession = try await ReplicaWorkspaceProvider(replica: mac).openDocument(reference)
            let tabletSession = try await ReplicaWorkspaceProvider(replica: tablet).openDocument(reference)
            let macBase = try await macSession.snapshot()
            let tabletBase = try await tabletSession.snapshot()
            _ = try await macSession.admit(source: macBase.source + "Mac addition\n", baseContentRevision: macBase.contentRevision)
            _ = try await tabletSession.admit(source: tabletBase.source + "Tablet addition\n", baseContentRevision: tabletBase.contentRevision)

            let macSync = try ReplicaSyncCoordinator(replica: mac, transport: transport, stateRoot: root.appending(path: "mac-state"))
            let tabletSync = try ReplicaSyncCoordinator(replica: tablet, transport: transport, stateRoot: root.appending(path: "tablet-state"))
            _ = try await macSync.syncOnce()
            let merged = try await tabletSync.syncOnce()
            #expect(merged.state == .autoMerged || merged.state == .approximatePlacement)
            _ = try await macSync.syncOnce()

            let remote = try await client.descriptor(tree: tree.id).tree
            #expect(try await mac.heads().materializedRoot == remote.root)
            #expect(try await tablet.heads().materializedRoot == remote.root)
            let source = (try await macSession.snapshot()).source
            #expect(source.contains("Mac addition"))
            #expect(source.contains("Tablet addition"))
        }
    }
}

private func snapshot(markdown: String) throws -> WireSnapshot {
    let file = try WireObjectCodec.object(.file(Data(markdown.utf8)))
    let root = try WireObjectCodec.object(.directory([.init(name: "note.md", hash: file.hash)]))
    return WireSnapshot(root: root.hash, objects: [file, root].sorted { $0.hash < $1.hash })
}

private func snapshot(files: [String: String]) throws -> WireSnapshot {
    var objects: [WireObjectEnvelope] = []
    let entries = try files.keys.sorted { $0.utf8.lexicographicallyPrecedes($1.utf8) }.map { name in
        let file = try WireObjectCodec.object(.file(Data(files[name, default: ""].utf8)))
        objects.append(file)
        return WireDirectoryEntry(name: name, hash: file.hash)
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
    var directoryEntries = [WireDirectoryEntry(name: "child.md", hash: child.hash)]
    var objects = [child]
    if let indexSource {
        let index = try WireObjectCodec.object(.file(Data(indexSource.utf8)))
        directoryEntries.append(.init(name: "_index.md", hash: index.hash))
        objects.append(index)
    }
    directoryEntries.sort { $0.name.utf8.lexicographicallyPrecedes($1.name.utf8) }
    let directory = try WireObjectCodec.object(.directory(directoryEntries))
    let sibling = try WireObjectCodec.object(.file(Data(siblingSource.utf8)))
    let root = try WireObjectCodec.object(.directory([
        .init(name: stem, hash: directory.hash),
        .init(name: stem + ".md", hash: sibling.hash),
    ]))
    objects.append(contentsOf: [directory, sibling, root])
    return WireSnapshot(root: root.hash, objects: objects.sorted { $0.hash < $1.hash })
}

private func wireDirectoryEntries(snapshot: WireSnapshot, directory hash: String) throws -> [WireDirectoryEntry] {
    let envelope = try #require(snapshot.objects.first { $0.hash == hash })
    guard case let .directory(entries, _) = try WireObjectCodec.decode(envelope.bytes) else {
        throw ArborWireValidationError.invalidValue("Expected directory object")
    }
    return entries
}

private func wireEntryNames(snapshot: WireSnapshot, directory hash: String) throws -> Set<String> {
    Set(try wireDirectoryEntries(snapshot: snapshot, directory: hash).map(\.name))
}

private func wireDirectoryEntries(snapshot: ReplicaSnapshot, directory hash: String) throws -> [WireDirectoryEntry] {
    let object = try #require(snapshot.objects.first { $0.hash == hash })
    guard case let .directory(entries, _) = try WireObjectCodec.decode(object.bytes) else {
        throw ArborWireValidationError.invalidValue("Expected directory object")
    }
    return entries
}

private func wireEntryNames(snapshot: ReplicaSnapshot, directory hash: String) throws -> Set<String> {
    Set(try wireDirectoryEntries(snapshot: snapshot, directory: hash).map(\.name))
}

private func completeCandidate(_ request: WireUpdateRequest, retained: WireSnapshot) throws -> WireSnapshot {
    var envelopes = Dictionary(uniqueKeysWithValues: retained.objects.map { ($0.hash, $0) })
    for object in request.objects { envelopes[object.hash] = object }
    var pending = [request.candidate]
    var visited = Set<String>()
    var objects: [WireObjectEnvelope] = []
    while let hash = pending.popLast() {
        if !visited.insert(hash).inserted { continue }
        let envelope = try #require(envelopes[hash])
        objects.append(envelope)
        if case let .directory(entries, _) = try WireObjectCodec.decode(envelope.bytes) {
            for entry in entries {
                if let hash = entry.hash { pending.append(hash) }
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
        previousRoot: base,
        kind: "accepted",
        acceptedAt: 1_800_000_000_000,
        baseRoot: base,
        candidateRoot: candidate,
        remoteRoot: base
    )
}

private func withTemporaryRoot(_ body: (URL) async throws -> Void) async throws {
    let root = FileManager.default.temporaryDirectory.appending(path: "arbor-sync-\(UUID().uuidString)", directoryHint: .isDirectory)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    try await body(root)
}
