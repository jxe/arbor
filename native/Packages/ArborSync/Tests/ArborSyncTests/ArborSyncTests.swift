import ArborKit
import ArborReplica
@testable import ArborSync
import ArborWire
import Foundation
import Testing

private actor ClosureTransport: ReplicaAuthorityTransport {
    typealias Submit = @Sendable (PreparedAuthorityUpdate, Int) async throws -> AuthorityUpdateResponse
    let initial: AuthoritySnapshot
    let submitter: Submit
    private(set) var requests: [PreparedAuthorityUpdate] = []

    init(initial: AuthoritySnapshot, submitter: @escaping Submit) {
        self.initial = initial
        self.submitter = submitter
    }

    func submit(_ prepared: PreparedAuthorityUpdate) async throws -> AuthorityUpdateResponse {
        requests.append(prepared)
        return try await submitter(prepared, requests.count)
    }

    func snapshot(root: String) async throws -> AuthoritySnapshot {
        guard root == initial.root else { throw ArborWireValidationError.incompleteGraph(root) }
        return initial
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
struct ArborSyncTests {
    @Test("Pairing payload is versioned and authority scoped")
    func pairingPayload() throws {
        let payload = PairingPayload(
            origin: URL(string: "https://arbor.example")!,
            pairing: .init(id: "pa_test", secret: "secret")
        )
        #expect(try payload.validated() == payload)
    }

    @Test("One-sided synchronization accepts its candidate without a returned snapshot")
    func placementAndSync() async throws {
        try await withTemporaryRoot { root in
            let tree = "tr_sync"
            let initial = try snapshot(markdown: "---\nid: pg_note\n---\n\n# Note\n\nBase\n")
            let transport = ClosureTransport(initial: initial) { prepared, _ in
                let request = try JSONDecoder().decode(AuthorityUpdateRequest.self, from: prepared.body)
                let candidate = try completeCandidate(request, retained: initial)
                let update = accepted(id: "up_local", tree: tree, root: candidate.root, base: request.base.root, candidate: candidate.root)
                #expect(request.returnSnapshot == .ifResultDiffers)
                return AuthorityUpdateResponse(result: .accepted(update), snapshot: nil)
            }
            let replica = try await ReplicaPlacementService.place(
                tree: descriptor(tree: tree, snapshot: initial, update: "up_initial"),
                at: root.appending(path: "replica"),
                transport: transport
            )
            let provider = ReplicaWorkspaceProvider(replica: replica)
            let session = try await provider.openDocument(.init(tree: TreeID(rawValue: tree), path: "/note", pageID: "pg_note"))
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
                let request = try JSONDecoder().decode(AuthorityUpdateRequest.self, from: prepared.body)
                let update = accepted(
                    id: "up_patch_\(call)",
                    tree: tree,
                    root: request.candidate,
                    base: request.base.root,
                    candidate: request.candidate
                )
                return AuthorityUpdateResponse(result: .accepted(update), snapshot: nil)
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
                .init(tree: TreeID(rawValue: tree), path: "/note", pageID: "pg_note")
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
            let first = try JSONDecoder().decode(AuthorityUpdateRequest.self, from: firstPrepared.body)
            let patch = try #require(first.filePatches?.first)
            #expect(first.returnSnapshot == .ifResultDiffers)
            #expect(patch.edits == [AuthorityFilePatchEdit(
                offset: range.lowerBound,
                length: range.count,
                bytes: Data("Edited".utf8)
            )])
            #expect(!first.objects.contains(where: { $0.hash == patch.result }))

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
            let second = try JSONDecoder().decode(AuthorityUpdateRequest.self, from: secondPrepared.body)
            #expect(second.filePatches == nil)
            #expect(!second.objects.isEmpty)
            #expect(try await replica.heads().pendingRoot == nil)
        }
    }

    @Test("A frozen request never absorbs newer admitted local work")
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
            let reference = WorkspaceReference(tree: TreeID(rawValue: tree), path: "/note", pageID: "pg_note")
            let session = try await provider.openDocument(reference)
            let base = try await session.snapshot()
            let candidate = try await session.admit(source: base.source + "Candidate\n", baseContentRevision: base.contentRevision)

            let transport = ClosureTransport(initial: initial) { prepared, call in
                let request = try JSONDecoder().decode(AuthorityUpdateRequest.self, from: prepared.body)
                if call == 1 {
                    let current = try await session.snapshot()
                    _ = try await session.admit(source: current.source + "Tail\n", baseContentRevision: current.contentRevision)
                }
                let returned = try completeCandidate(request, retained: initial)
                let update = accepted(id: "up_\(call)", tree: tree, root: returned.root, base: request.base.root, candidate: returned.root)
                return AuthorityUpdateResponse(result: .accepted(update), snapshot: returned)
            }
            let coordinator = try ReplicaSyncCoordinator(replica: replica, transport: transport, stateRoot: root)
            let first = try await coordinator.syncOnce()
            #expect(first.state == .locallyPending)
            #expect(first.acceptedRoot == initial.root)
            #expect((try await session.snapshot()).source.hasSuffix("Candidate\nTail\n"))
            #expect(try await replica.heads().acceptedRoot == initial.root)

            let second = try await coordinator.syncOnce()
            #expect(second.state == .current)
            #expect(try await replica.heads().pendingRoot == nil)
            let requests = await transport.requests
            #expect(requests.count == 2)
            let firstRequest = try JSONDecoder().decode(AuthorityUpdateRequest.self, from: requests[0].body)
            let secondRequest = try JSONDecoder().decode(AuthorityUpdateRequest.self, from: requests[1].body)
            #expect(firstRequest.candidate != secondRequest.candidate)
            #expect(firstRequest.base == secondRequest.base)
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
                .init(tree: TreeID(rawValue: tree), path: "/note", pageID: "pg_note")
            )
            let localBase = try await session.snapshot()
            _ = try await session.admit(source: localBase.source + "Local\n", baseContentRevision: localBase.contentRevision)
            let current = accepted(id: "up_remote", tree: tree, root: remote.root, base: initial.root, candidate: remote.root)
            let conflict = AuthorityUpdateConflict(
                message: "unsafe",
                current: current,
                base: initial.root,
                candidate: try await replica.currentSnapshot().root,
                draft: draft,
                currentSnapshot: remote,
                conflicts: [.init(path: "/note.md", reason: "frontmatter-conflict")]
            )
            let conflictTransport = ClosureTransport(initial: initial) { _, _ in
                throw AuthorityUpdateConflictError(conflict: conflict)
            }
            let coordinator = try ReplicaSyncCoordinator(replica: replica, transport: conflictTransport, stateRoot: root)
            #expect(try await coordinator.syncOnce().state == .conflict)
            #expect(try await coordinator.conflict()?.draft == draft.root)
            try await coordinator.resolveConflictKeepingLocal()

            let accepting = ClosureTransport(initial: initial) { prepared, _ in
                let request = try JSONDecoder().decode(AuthorityUpdateRequest.self, from: prepared.body)
                #expect(request.base.root == remote.root)
                #expect(request.base.update == "up_remote")
                let candidate = try completeCandidate(request, retained: initial)
                return AuthorityUpdateResponse(
                    result: .accepted(accepted(id: "up_resolved", tree: tree, root: candidate.root, base: remote.root, candidate: candidate.root)),
                    snapshot: candidate
                )
            }
            let resumed = try ReplicaSyncCoordinator(replica: replica, transport: accepting, stateRoot: root)
            #expect(try await resumed.syncOnce().state == .current)
        }
    }

    @Test("Every coordinator crash point replays one semantic intent")
    func crashRecovery() async throws {
        for point in ReplicaSyncFailurePoint.allCases where point != .duringMaterialization && point != .afterMaterialization {
            try await withTemporaryRoot { root in
                let tree = "tr_fault_\(point.rawValue)"
                let initial = try snapshot(markdown: "---\nid: pg_note\n---\n\n# Note\n")
                let transport = ClosureTransport(initial: initial) { prepared, _ in
                    let request = try JSONDecoder().decode(AuthorityUpdateRequest.self, from: prepared.body)
                    let candidate = try completeCandidate(request, retained: initial)
                    return AuthorityUpdateResponse(
                        result: .accepted(accepted(id: "up_done", tree: tree, root: candidate.root, base: request.base.root, candidate: candidate.root)),
                        snapshot: candidate
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
                let frozen = try JSONDecoder().decode(AuthorityUpdateRequest.self, from: try #require(requests.first).body)
                #expect(frozen.returnSnapshot == .ifResultDiffers)
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
                    let request = try JSONDecoder().decode(AuthorityUpdateRequest.self, from: prepared.body)
                    let summary = AuthorityMergeSummary(version: "markdown-additive-v1", approximatePlacements: 0)
                    let update = AuthorityAcceptedUpdate(
                        id: "up_merged",
                        tree: tree,
                        root: merged.root,
                        previousRoot: initial.root,
                        kind: "merged",
                        acceptedAt: 1_800_000_000_000,
                        baseRoot: request.base.root,
                        candidateRoot: request.candidate,
                        remoteRoot: initial.root,
                        merge: summary
                    )
                    return AuthorityUpdateResponse(result: .merged(update, summary), snapshot: merged)
                }
                let replica = try await ReplicaPlacementService.place(
                    tree: descriptor(tree: tree, snapshot: initial, update: "up_initial"),
                    at: root.appending(path: "replica"),
                    transport: transport
                )
                let session = try await ReplicaWorkspaceProvider(replica: replica).openDocument(
                    .init(tree: TreeID(rawValue: tree), path: "/note", pageID: "pg_note")
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
    @Test("Two Swift replicas converge through the temporary authority")
    func twoReplicas() async throws {
        guard let originValue = ProcessInfo.processInfo.environment["ARBOR_WIRE_TEST_URL"],
              let origin = URL(string: originValue),
              let token = ProcessInfo.processInfo.environment["ARBOR_WIRE_TEST_TOKEN"] else { return }
        try await withTemporaryRoot { root in
            let client = ArborAuthorityClient(origin: origin, credential: token, retryDelay: { _ in })
            let initial = try snapshot(markdown: "---\nid: pg_note\n---\n\n# Note\n\nBase\n")
            let tree = try await client.createTree(
                canonicalPath: "/~owner/native-\(UUID().uuidString.lowercased())",
                snapshot: initial
            )
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
            let reference = WorkspaceReference(tree: TreeID(rawValue: tree.id), path: "/note", pageID: "pg_note")
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

            let remote = try await client.ref(tree: tree.id)
            #expect(try await mac.heads().materializedRoot == remote.ref)
            #expect(try await tablet.heads().materializedRoot == remote.ref)
            let source = (try await macSession.snapshot()).source
            #expect(source.contains("Mac addition"))
            #expect(source.contains("Tablet addition"))
        }
    }
}

private func snapshot(markdown: String) throws -> AuthoritySnapshot {
    let file = try WireObjectCodec.object(.file(Data(markdown.utf8)))
    let root = try WireObjectCodec.object(.directory([.init(name: "note.md", hash: file.hash)]))
    return AuthoritySnapshot(root: root.hash, objects: [file, root].sorted { $0.hash < $1.hash })
}

private func completeCandidate(_ request: AuthorityUpdateRequest, retained: AuthoritySnapshot) throws -> AuthoritySnapshot {
    var envelopes = Dictionary(uniqueKeysWithValues: retained.objects.map { ($0.hash, $0) })
    for object in request.objects { envelopes[object.hash] = object }
    var pending = [request.candidate]
    var visited = Set<String>()
    var objects: [AuthorityObject] = []
    while let hash = pending.popLast() {
        if !visited.insert(hash).inserted { continue }
        let envelope = try #require(envelopes[hash])
        objects.append(envelope)
        if case let .directory(entries) = try WireObjectCodec.decode(envelope.bytes) {
            pending.append(contentsOf: entries.compactMap(\.hash))
        }
    }
    return AuthoritySnapshot(root: request.candidate, objects: objects.sorted { $0.hash < $1.hash })
}

private func descriptor(tree: String, snapshot: AuthoritySnapshot, update: String) -> AuthorityTreeDescriptor {
    AuthorityTreeDescriptor(
        id: tree,
        canonicalPath: "/~owner/\(tree)",
        kind: "shared-subtree",
        ref: snapshot.root,
        publicAccess: "none",
        access: "write",
        httpURL: "https://arbor.example/~owner/\(tree)",
        arborURL: "arbor://arbor.example/~owner/\(tree)",
        update: update
    )
}

private func accepted(id: String, tree: String, root: String, base: String, candidate: String) -> AuthorityAcceptedUpdate {
    AuthorityAcceptedUpdate(
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
