import ArborKit
import ArborReplica
import ArborWire
import Foundation

public actor ReplicaSyncCoordinator {
    private let replica: ArborReplica
    private let transport: any ReplicaAuthorityTransport
    private let files: DurableSyncFiles
    private let faultInjector: any ReplicaSyncFaultInjector
    private var control: DurableSyncControl
    private var terminal = false

    public init(
        replica: ArborReplica,
        transport: any ReplicaAuthorityTransport,
        stateRoot: URL,
        faultInjector: any ReplicaSyncFaultInjector = NoReplicaSyncFaults()
    ) throws {
        self.replica = replica
        self.transport = transport
        self.files = try DurableSyncFiles(root: stateRoot)
        self.faultInjector = faultInjector
        self.control = try files.load()
    }

    public func presentation() async throws -> WorkspaceSyncPresentation {
        try requireOpen()
        let heads = try await replica.heads()
        var value = control.presentation
        value.acceptedRoot = heads.acceptedRoot
        value.localRoot = heads.materializedRoot
        if control.conflict != nil { value.state = .conflict }
        else if control.attempt != nil { value.state = .requestPending }
        else if heads.pendingRoot != nil { value.state = .locallyPending }
        return value
    }

    public func conflict() throws -> ReplicaConflictPresentation? {
        try requireOpen()
        guard let stored = control.conflict else { return nil }
        return ReplicaConflictPresentation(
            base: stored.response.base,
            local: stored.localRootAtConflict,
            remote: stored.response.current.root,
            draft: stored.response.draft.root,
            reasons: stored.response.conflicts
        )
    }

    @discardableResult
    public func syncOnce() async throws -> WorkspaceSyncPresentation {
        try requireOpen()
        guard control.conflict == nil else { return try await presentation() }
        let attempt: DurableSyncAttempt
        if let existing = control.attempt { attempt = existing }
        else { attempt = try await createAttempt() }
        do {
            control.presentation = WorkspaceSyncPresentation(
                state: .uploading,
                detail: "Submitting one durable root intent",
                acceptedRoot: attempt.base.root,
                localRoot: attempt.candidate,
                localAdditions: attempt.candidate != attempt.base.root
            )
            try files.write(control)
            try faultInjector.reached(.duringUpload)
            let prepared = PreparedAuthorityUpdate(tree: attempt.tree, body: attempt.body, requestDigest: attempt.digest)
            let response = try await transport.submit(prepared)
            try faultInjector.reached(.afterServerAcceptance)
            try await apply(response, for: attempt)
            return try await presentation()
        } catch let error as AuthorityUpdateConflictError {
            let validated = try error.conflict.validated()
            guard validated.currentSnapshot != nil else { throw ReplicaSyncError.conflictSnapshotMissing }
            control.conflict = DurableSyncConflict(response: validated, localRootAtConflict: attempt.candidate)
            control.attempt = nil
            control.presentation = WorkspaceSyncPresentation(
                state: .conflict,
                detail: validated.conflicts.map { "\($0.path): \($0.reason)" }.joined(separator: ", "),
                acceptedRoot: validated.current.root,
                localRoot: attempt.candidate,
                localAdditions: true,
                remoteAdditions: true
            )
            try files.write(control)
            return control.presentation
        } catch let error as AuthorityHTTPError where error.status == 401 || error.status == 403 {
            control.presentation.state = error.code == "device-revoked" ? .revoked : .authenticationFailure
            control.presentation.detail = error.message ?? error.code
            try files.write(control)
            return control.presentation
        } catch {
            if error is ReplicaSyncError || error is ArborWireValidationError { terminal = true }
            control.presentation.state = .offline
            control.presentation.detail = String(describing: error)
            try? files.write(control)
            throw error
        }
    }

    public func resolveConflictKeepingLocal() throws {
        try requireOpen()
        guard let conflict = control.conflict else { throw ReplicaSyncError.noConflict }
        control.nextBase = AuthorityUpdateBase(root: conflict.response.current.root, update: conflict.response.current.id)
        control.conflict = nil
        control.presentation = WorkspaceSyncPresentation(
            state: .locallyPending,
            detail: "Conflict choice retained the local document as new intent",
            acceptedRoot: control.nextBase?.root,
            localRoot: conflict.localRootAtConflict,
            localAdditions: true,
            remoteAdditions: true
        )
        try files.write(control)
    }

    public func close() { terminal = true }

    private func createAttempt() async throws -> DurableSyncAttempt {
        let heads = try await replica.heads()
        let base: AuthorityUpdateBase
        if let nextBase = control.nextBase {
            base = nextBase
        } else {
            guard let root = heads.acceptedRoot, let update = heads.acceptedUpdate else {
                throw ReplicaSyncError.replicaIsNotPlaced
            }
            base = AuthorityUpdateBase(root: root, update: update)
        }
        let snapshot = try await replica.currentSnapshot()
        let authoritySnapshot = AuthoritySnapshot(
            root: snapshot.root,
            objects: snapshot.objects.map { AuthorityObject(hash: $0.hash, bytes: $0.bytes) }
        )
        _ = try WireObjectGraph.validate(authoritySnapshot)
        let request = AuthorityUpdateRequest(base: base, candidate: snapshot.root, objects: authoritySnapshot.objects, returnSnapshot: true)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let attempt = DurableSyncAttempt(
            tree: (await replica.treeID()).rawValue,
            base: base,
            candidate: snapshot.root,
            generation: heads.generation,
            body: try encoder.encode(request),
            digest: updateRequestDigest(tree: (await replica.treeID()).rawValue, base: base, candidate: snapshot.root)
        )
        try faultInjector.reached(.beforeRequestPersistence)
        control.attempt = attempt
        control.presentation = WorkspaceSyncPresentation(
            state: .requestPending,
            acceptedRoot: base.root,
            localRoot: snapshot.root,
            localAdditions: snapshot.root != base.root
        )
        try files.write(control)
        try faultInjector.reached(.afterRequestPersistence)
        return attempt
    }

    private func apply(_ response: AuthorityUpdateResponse, for attempt: DurableSyncAttempt) async throws {
        guard let snapshot = response.snapshot else { throw ReplicaSyncError.returnedSnapshotMissing }
        _ = try WireObjectGraph.validate(snapshot)
        let accepted: AuthorityAcceptedUpdate
        let merge: AuthorityMergeSummary?
        switch response.result {
        case let .current(update): accepted = update; merge = nil
        case let .accepted(update): accepted = update; merge = nil
        case let .merged(update, summary): accepted = update; merge = summary
        }
        guard snapshot.root == accepted.root else { throw ReplicaSyncError.returnedSnapshotMismatch }
        try faultInjector.reached(.duringGraphDownload)

        let heads = try await replica.heads()
        if heads.materializedRoot != attempt.candidate {
            if heads.materializedRoot == accepted.root, heads.acceptedRoot == accepted.root {
                // A previous process durably installed this exact returned graph
                // before it could clear the attempt. Completing the same attempt
                // is idempotent and must not masquerade as newer local work.
                control.attempt = nil
                control.nextBase = nil
                setAppliedPresentation(accepted: accepted, merge: merge)
                try files.write(control)
                return
            }
            // New local work was acknowledged after this request was frozen. Keep
            // the prior accepted base so the next request performs the authority's
            // three-way reconciliation against both this response and the tail.
            control.attempt = nil
            control.presentation = WorkspaceSyncPresentation(
                state: .locallyPending,
                detail: "Accepted response retained; newer local work is the next root intent",
                acceptedRoot: attempt.base.root,
                localRoot: heads.materializedRoot,
                localAdditions: true,
                remoteAdditions: accepted.root != attempt.candidate,
                approximatePlacements: merge?.approximatePlacements ?? 0
            )
            try files.write(control)
            return
        }

        if accepted.root == attempt.candidate {
            try faultInjector.reached(.beforeBaseAdvancement)
            try await replica.recordAccepted(root: accepted.root, update: accepted.id, cursor: accepted.id)
        } else {
            try faultInjector.reached(.duringMaterialization)
            let replacement = try SnapshotBridge.replacement(
                snapshot: snapshot,
                tree: await replica.treeID(),
                update: accepted.id,
                cursor: accepted.id
            )
            if heads.pendingRoot == nil {
                try await replica.replaceFromSystem(replacement)
            } else {
                try await replica.integrateAccepted(replacement, expectedCandidate: attempt.candidate)
            }
            try faultInjector.reached(.afterMaterialization)
        }
        control.attempt = nil
        control.nextBase = nil
        setAppliedPresentation(accepted: accepted, merge: merge)
        try files.write(control)
    }

    private func setAppliedPresentation(accepted: AuthorityAcceptedUpdate, merge: AuthorityMergeSummary?) {
        let approximations = merge?.approximatePlacements ?? 0
        control.presentation = WorkspaceSyncPresentation(
            state: approximations > 0 ? .approximatePlacement : merge == nil ? .current : .autoMerged,
            detail: merge == nil ? "Current at accepted authority root" : "Authority combined local and remote additions",
            acceptedRoot: accepted.root,
            localRoot: accepted.root,
            localAdditions: accepted.candidateRoot != accepted.baseRoot,
            remoteAdditions: accepted.remoteRoot != accepted.baseRoot,
            approximatePlacements: approximations
        )
    }

    private func requireOpen() throws {
        if terminal { throw ReplicaSyncError.closed }
    }
}

public enum ReplicaPlacementService {
    public static func place(
        tree: AuthorityTreeDescriptor,
        at replicaRoot: URL,
        transport: any ReplicaAuthorityTransport
    ) async throws -> ArborReplica {
        guard let update = tree.update else { throw ReplicaSyncError.replicaIsNotPlaced }
        let snapshot = try await transport.snapshot(root: tree.ref)
        let replica = try await ArborReplica.open(at: replicaRoot, tree: TreeID(rawValue: tree.id))
        let replacement = try SnapshotBridge.replacement(snapshot: snapshot, tree: TreeID(rawValue: tree.id), update: update, cursor: update)
        try await replica.initializeFromSystem(replacement)
        return replica
    }
}
