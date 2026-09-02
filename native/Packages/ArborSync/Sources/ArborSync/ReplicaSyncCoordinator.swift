import ArborKit
import ArborReplica
import ArborWire
import Foundation

public actor ReplicaSyncCoordinator {
    private let replica: ArborReplica
    private let transport: any ReplicaWireTransport
    private let files: DurableSyncFiles
    private let faultInjector: any ReplicaSyncFaultInjector
    private var control: DurableSyncControl
    private var terminal = false
    private var syncActive = false
    private var syncAgain = false

    public init(
        replica: ArborReplica,
        transport: any ReplicaWireTransport,
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
        value.acceptedRoot = control.nextBase?.root ?? heads.acceptedRoot
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

    public func watchCursor() async throws -> String? {
        try requireOpen()
        return try await replica.heads().acceptedCursor
    }

    /** Reestablishes a coherent snapshot-then-follow boundary after watch history expires. */
    @discardableResult
    public func recoverWatchGap() async throws -> WorkspaceSyncPresentation {
        try requireOpen()
        let heads = try await replica.heads()
        if control.attempt != nil || heads.pendingRoot != nil || control.nextBase != nil {
            return try await synchronize(admission: nil)
        }
        return try await pullCurrentSnapshot(treeID: await replica.treeID().rawValue, priorHeads: heads)
    }

    /** Applies one accepted-state invalidation without turning a clean pull into a write. */
    @discardableResult
    public func observe(_ event: WireWatchEvent) async throws -> WorkspaceSyncPresentation {
        try requireOpen()
        let treeID = await replica.treeID().rawValue
        guard event.tree.id == treeID else { return try await presentation() }
        let heads = try await replica.heads()
        if event.id == heads.acceptedCursor { return try await presentation() }
        if let requestDigest = event.requestDigest,
           requestDigest == control.attempt?.digest {
            // The watch won the response race, or the response was lost. Replaying
            // the exact durable request obtains the server's stored response.
            return try await synchronize(admission: nil)
        }
        if control.attempt != nil || heads.pendingRoot != nil || control.nextBase != nil {
            return try await synchronize(admission: nil)
        }
        guard !event.transitions.isEmpty else {
            return try await pullCurrentSnapshot(treeID: event.tree.id, priorHeads: heads)
        }
        do {
            return try await applyAcceptedTransitions(event, priorHeads: heads)
        } catch is ArborWireValidationError {
            return try await pullCurrentSnapshot(treeID: event.tree.id, priorHeads: heads)
        }
    }

    private func applyAcceptedTransitions(
        _ event: WireWatchEvent,
        priorHeads heads: ReplicaHeads
    ) async throws -> WorkspaceSyncPresentation {
        guard let final = event.transitions.last,
              final.update.id == event.tree.update,
              final.update.root == event.tree.ref else {
            throw ArborWireValidationError.invalidValue("Watch transition batch does not match its descriptor")
        }
        let local = try await replica.currentSnapshot()
        let basis = WireSnapshot(
            root: local.root,
            objects: local.objects.map { WireObjectEnvelope(hash: $0.hash, bytes: $0.bytes) }
        )
        let accepted = try WireTransitionReplay.applying(event.transitions, to: basis)
        let latestHeads = try await replica.heads()
        if latestHeads.pendingRoot != nil || latestHeads.materializedRoot != heads.materializedRoot {
            return try await synchronize(admission: nil)
        }
        if accepted.root == latestHeads.materializedRoot {
            try await replica.recordAccepted(root: accepted.root, update: final.update.id, cursor: event.id)
        } else {
            let replacement = try SnapshotBridge.replacement(
                snapshot: accepted,
                tree: await replica.treeID(),
                update: final.update.id,
                cursor: event.id
            )
            try await replica.replaceFromSystem(replacement)
        }
        control.presentation = WorkspaceSyncPresentation(
            state: final.update.merge == nil ? .current : .autoMerged,
            detail: "Applied \(event.transitions.count) ordered accepted transition\(event.transitions.count == 1 ? "" : "s")",
            acceptedRoot: final.update.root,
            localRoot: final.update.root,
            remoteAdditions: true,
            approximatePlacements: final.update.merge?.approximatePlacements ?? 0
        )
        try files.write(control)
        return control.presentation
    }

    private func pullCurrentSnapshot(
        treeID: String,
        priorHeads heads: ReplicaHeads
    ) async throws -> WorkspaceSyncPresentation {
        let current = try await transport.currentSnapshot(tree: treeID)
        let update = current.tree.update
        guard !update.isEmpty else { throw ReplicaSyncError.replicaIsNotPlaced }
        let latestHeads = try await replica.heads()
        if latestHeads.pendingRoot != nil || latestHeads.materializedRoot != heads.materializedRoot {
            return try await synchronize(admission: nil)
        }
        do {
            if current.snapshot.root == latestHeads.materializedRoot {
                try await replica.recordAccepted(root: current.snapshot.root, update: update, cursor: current.observedThrough)
            } else {
                let replacement = try SnapshotBridge.replacement(
                    snapshot: current.snapshot,
                    tree: await replica.treeID(),
                    update: update,
                    cursor: current.observedThrough
                )
                try await replica.replaceFromSystem(replacement)
            }
        } catch ReplicaError.pendingLocalChanges {
            return try await synchronize(admission: nil)
        }
        control.presentation = WorkspaceSyncPresentation(
            state: .current,
            detail: "Applied the server's current snapshot",
            acceptedRoot: current.snapshot.root,
            localRoot: current.snapshot.root
        )
        try files.write(control)
        return control.presentation
    }

    @discardableResult
    public func syncOnce() async throws -> WorkspaceSyncPresentation {
        try await synchronize(admission: nil)
    }

    /** Best-effort, nonblocking-from-the-editor handoff for one just-durable patch admission. */
    public func syncImmediately(_ admission: ReplicaPatchAdmission) async {
        _ = try? await synchronize(admission: admission)
    }

    private func synchronize(admission: ReplicaPatchAdmission?) async throws -> WorkspaceSyncPresentation {
        try requireOpen()
        if syncActive {
            syncAgain = true
            return try await presentation()
        }
        syncActive = true
        defer { syncActive = false }
        var nextAdmission = admission
        var followUp = admission != nil && control.attempt != nil
        var result = try await presentation()
        repeat {
            syncAgain = false
            result = try await syncPass(admission: nextAdmission)
            nextAdmission = nil
            if syncAgain || followUp {
                followUp = false
                let heads = try await replica.heads()
                if heads.pendingRoot == nil || control.conflict != nil { syncAgain = false }
                else { syncAgain = true }
            }
        } while syncAgain
        return result
    }

    private func syncPass(admission: ReplicaPatchAdmission?) async throws -> WorkspaceSyncPresentation {
        guard control.conflict == nil else { return try await presentation() }
        let attempt: DurableSyncAttempt
        if let existing = control.attempt { attempt = existing }
        else { attempt = try await createAttempt(admission: admission) }
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
            let prepared = PreparedWireUpdate(tree: attempt.tree, body: attempt.body, requestDigest: attempt.digest)
            let response = try await transport.submit(prepared)
            try faultInjector.reached(.afterServerAcceptance)
            try await apply(response, for: attempt)
            return try await presentation()
        } catch let error as WireUpdateConflictError {
            let validated = try error.conflict.validated()
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
        } catch let error as WireHTTPError where error.status == 401 || error.status == 403 {
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
        control.nextBase = WireUpdateBase(root: conflict.response.current.root, update: conflict.response.current.id)
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

    private func createAttempt(admission: ReplicaPatchAdmission? = nil) async throws -> DurableSyncAttempt {
        let heads = try await replica.heads()
        let base: WireUpdateBase
        if let nextBase = control.nextBase {
            base = nextBase
        } else {
            guard let root = heads.acceptedRoot, let update = heads.acceptedUpdate else {
                throw ReplicaSyncError.replicaIsNotPlaced
            }
            base = WireUpdateBase(root: root, update: update)
        }
        let snapshot = try await replica.currentSnapshot()
        let wireSnapshot = WireSnapshot(
            root: snapshot.root,
            objects: snapshot.objects.map { WireObjectEnvelope(hash: $0.hash, bytes: $0.bytes) }
        )
        _ = try WireObjectGraph.validate(wireSnapshot)
        let retained = (try? await retainedObjectHashes(root: base.root)) ?? []
        let delta = try await immediateDelta(
            admission,
            heads: heads,
            base: base,
            snapshot: wireSnapshot,
            retained: retained
        )
        let sparseObjects = wireSnapshot.objects.filter {
            !retained.contains($0.hash) && $0.hash != delta?.result
        }
        let request = WireUpdateRequest(
            base: base,
            candidate: snapshot.root,
            objects: sparseObjects,
            deltas: delta.map { [$0] } ?? []
        )
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

    /// Express the just-admitted Markdown edit as an object delta when the
    /// accepted base file is retained locally and the delta is smaller than the
    /// complete result object. Deltas address canonical object bytes, so the
    /// result's header (which carries the new payload length) is inserted and
    /// unchanged payload ranges are copied at their base offsets.
    private func immediateDelta(
        _ admission: ReplicaPatchAdmission?,
        heads: ReplicaHeads,
        base: WireUpdateBase,
        snapshot: WireSnapshot,
        retained: Set<String>
    ) async throws -> WireObjectDelta? {
        guard let admission,
              admission.baseWasAccepted,
              admission.baseRoot == base.root,
              heads.acceptedRoot == admission.baseRoot,
              heads.materializedRoot == admission.candidateRoot,
              heads.pendingRoot == admission.candidateRoot,
              heads.generation == admission.generation,
              snapshot.root == admission.candidateRoot,
              retained.contains(admission.baseFile),
              let resultEnvelope = snapshot.objects.first(where: { $0.hash == admission.resultFile }) else {
            return nil
        }
        let baseBytes = try await replica.storedObjectBytes(hash: admission.baseFile)
        guard case let .file(basePayload) = try WireObjectCodec.decode(baseBytes),
              let baseSource = String(data: basePayload, encoding: .utf8) else {
            return nil
        }
        let resultSource: String
        do { resultSource = try admission.patch.applying(to: baseSource) }
        catch { return nil }
        let resultPayload = Data(resultSource.utf8)
        let reconstructed = try WireObjectCodec.encode(.file(resultPayload))
        guard WireObjectCodec.hash(reconstructed) == admission.resultFile,
              reconstructed == resultEnvelope.bytes else { return nil }

        let baseHeader = baseBytes.count - basePayload.count
        var instructions: [WireObjectDeltaInstruction] = [
            .insert(Data(reconstructed.prefix(reconstructed.count - resultPayload.count)))
        ]
        var cursor = 0
        for edit in admission.patch.edits.sorted(by: { $0.utf8Range.lowerBound < $1.utf8Range.lowerBound }) {
            let lower = edit.utf8Range.lowerBound
            guard lower >= cursor, edit.utf8Range.upperBound <= basePayload.count else { return nil }
            if lower > cursor { instructions.append(.copy(offset: baseHeader + cursor, length: lower - cursor)) }
            let replacement = Data(edit.replacement.utf8)
            if !replacement.isEmpty { instructions.append(.insert(replacement)) }
            cursor = edit.utf8Range.upperBound
        }
        if cursor < basePayload.count {
            instructions.append(.copy(offset: baseHeader + cursor, length: basePayload.count - cursor))
        }
        let delta: WireObjectDelta
        do {
            delta = try WireObjectDelta(base: admission.baseFile, result: admission.resultFile, instructions: instructions).validated()
            guard try delta.apply(to: baseBytes) == reconstructed else { return nil }
        } catch { return nil }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        guard try encoder.encode(delta).count < encoder.encode(resultEnvelope).count else { return nil }
        return delta
    }

    private func apply(_ response: WireUpdateResponse, for attempt: DurableSyncAttempt) async throws {
        guard response.requestDigest == attempt.digest else {
            throw ReplicaSyncError.returnedRequestDigestMismatch
        }
        let accepted: WireAcceptedUpdate
        let merge: WireMergeSummary?
        switch response.result {
        case let .current(update): accepted = update; merge = nil
        case let .accepted(update): accepted = update; merge = nil
        case let .merged(update, summary): accepted = update; merge = summary
        }
        if response.reconciliation == nil, accepted.root != attempt.candidate {
            throw ReplicaSyncError.returnedSnapshotMissing
        }
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
            // New local work was acknowledged after this request was frozen. If
            // the server accepted the frozen candidate exactly, the local tail
            // already descends from that root, so advance the next request's
            // base to it. Reusing the older base would present the accepted
            // candidate and its local successor as independent additions during
            // three-way merge (for example, an empty inserted paragraph and the
            // transcript that immediately replaced it), duplicating both.
            //
            // A genuinely merged response is different: the local tail has not
            // seen its remote additions, so retain the prior base and let the
            // next server merge reconcile both branches.
            if accepted.root == attempt.candidate {
                control.nextBase = WireUpdateBase(root: accepted.root, update: accepted.id)
            }
            control.attempt = nil
            control.presentation = WorkspaceSyncPresentation(
                state: .locallyPending,
                detail: "Accepted response retained; newer local work is the next root intent",
                acceptedRoot: control.nextBase?.root ?? attempt.base.root,
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
            guard let reconciliation = response.reconciliation else { throw ReplicaSyncError.returnedSnapshotMissing }
            // The materialized root is the candidate here, so the local graph is the basis the transition applies to.
            let local = try await replica.currentSnapshot()
            let basis = WireSnapshot(root: local.root, objects: local.objects.map { WireObjectEnvelope(hash: $0.hash, bytes: $0.bytes) })
            let snapshot: WireSnapshot
            do {
                snapshot = try WireTransitionReplay.applying(reconciliation, to: basis, root: accepted.root)
            } catch {
                throw ReplicaSyncError.returnedSnapshotMismatch
            }
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

    private func retainedObjectHashes(root: String) async throws -> Set<String> {
        var pending = [root]
        var visited = Set<String>()
        while let hash = pending.popLast() {
            if !visited.insert(hash).inserted { continue }
            let bytes = try await replica.storedObjectBytes(hash: hash)
            let object = try WireObjectCodec.decode(bytes)
            if case let .directory(entries) = object {
                for entry in entries {
                    if let hash = entry.hash { pending.append(hash) }
                    if let rollup = entry.rollup {
                        pending.append(rollup.source)
                        pending.append(rollup.schemaSource)
                    }
                }
            }
        }
        return visited
    }

    private func setAppliedPresentation(accepted: WireAcceptedUpdate, merge: WireMergeSummary?) {
        let approximations = merge?.approximatePlacements ?? 0
        control.presentation = WorkspaceSyncPresentation(
            state: approximations > 0 ? .approximatePlacement : merge == nil ? .current : .autoMerged,
            detail: merge == nil ? "Current at accepted server root" : "Server combined local and remote additions",
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
        tree: WireTreeDescriptor,
        at replicaRoot: URL,
        transport: any ReplicaWireTransport
    ) async throws -> ArborReplica {
        let current = try await transport.currentSnapshot(tree: tree.id)
        let update = current.tree.update
        guard !update.isEmpty else { throw ReplicaSyncError.replicaIsNotPlaced }
        let replica = try await ArborReplica.open(at: replicaRoot, tree: TreeID(rawValue: tree.id))
        let replacement = try SnapshotBridge.replacement(
            snapshot: current.snapshot,
            tree: TreeID(rawValue: tree.id),
            update: update,
            cursor: current.observedThrough
        )
        try await replica.initializeFromSystem(replacement)
        return replica
    }
}
