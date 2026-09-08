import ArborKit
import ArborReplica
import ArborWire
import Foundation

/// Effect runner for `DirectSyncMachine` over an `ArborReplica` and a Wire
/// transport. The replica is the durable store; `DurableSyncControl` retains
/// the exact request, conflict, and next base; the machine owns scheduling:
/// one request in flight, one retained successor, a trailing publication delay,
/// and the single ambiguous-recovery transition on reconnection.
public actor ReplicaSyncCoordinator {
    private let replica: ArborReplica
    private let transport: any ReplicaWireTransport
    private let files: DurableSyncFiles
    private let faultInjector: any ReplicaSyncFaultInjector
    private var control: DurableSyncControl
    private var terminal = false
    private var syncActive = false
    private var syncAgain = false
    private var inFlight = Set<String>()
    private var transportAvailable: Bool
    private var machine = DirectSyncMachine.State()
    private let machineOptions: DirectSyncMachine.Options
    private var publicationTask: Task<Void, Never>?
    private var maxPublicationTask: Task<Void, Never>?
    /// The most recent durable editor admission, for the immediate-delta fast path.
    private var latestAdmission: ReplicaPatchAdmission?

    public init(
        replica: ArborReplica,
        transport: any ReplicaWireTransport,
        stateRoot: URL,
        transportAvailable: Bool = true,
        faultInjector: any ReplicaSyncFaultInjector = NoReplicaSyncFaults(),
        publicationDelay: Duration = DirectSyncMachine.publicationDelay,
        publicationMaxDelay: Duration = DirectSyncMachine.publicationMaxDelay
    ) throws {
        self.replica = replica
        self.transport = transport
        self.files = try DurableSyncFiles(root: stateRoot)
        self.faultInjector = faultInjector
        self.control = try files.load()
        self.transportAvailable = transportAvailable
        self.machine = DirectSyncMachine.State(transportAvailable: transportAvailable)
        self.machineOptions = DirectSyncMachine.Options(publicationDelay: publicationDelay, publicationMaxDelay: publicationMaxDelay)
    }

    /// The machine state, for status and tests.
    public var syncState: DirectSyncMachine.State { machine }

    // MARK: Machine

    /// Enter the machine from the replica's accepted base and map the retained
    /// durable control onto its phase: a retained attempt is `prepared` (it is
    /// resubmitted exactly), a retained conflict is `conflict`, and unsent
    /// replica generations are one local head.
    private func ensureMachineEntered() async {
        guard case .unplaced = machine.phase else { return }
        guard let heads = try? await replica.heads(),
              let root = control.nextBase?.root ?? heads.acceptedRoot,
              let update = control.nextBase?.update ?? heads.acceptedUpdate else { return }
        dispatch(.bootstrapInstalled(root: root, update: update, cursor: heads.acceptedCursor))
        if let conflict = control.conflict {
            machine.phase = .conflict(
                request: DirectSyncMachine.PreparedRequest(
                    id: "conflict",
                    base: conflict.response.base,
                    candidate: conflict.localRootAtConflict,
                    digests: []
                ),
                conflict: DirectSyncMachine.ConflictEvidence(
                    current: .init(root: conflict.response.current.root, update: conflict.response.current.id),
                    draft: conflict.response.draft.root,
                    localRoot: conflict.localRootAtConflict
                ),
                head: nil
            )
        } else if let attempt = control.attempt {
            machine.phase = .prepared(request: Self.preparedRequest(attempt), head: nil)
        } else if heads.pendingRoot != nil {
            dispatch(.localHead(root: heads.materializedRoot, origin: .editor))
        }
    }

    private static func preparedRequest(_ attempt: DurableSyncAttempt) -> DirectSyncMachine.PreparedRequest {
        .init(id: attempt.digest, base: attempt.base.update, candidate: attempt.candidate, digests: attempt.allRequestDigests)
    }

    private func dispatch(_ event: DirectSyncMachine.Event) {
        let (next, effects) = DirectSyncMachine.reduce(machine, event, options: machineOptions)
        machine = next
        for effect in effects { run(effect) }
    }

    private func run(_ effect: DirectSyncMachine.Effect) {
        switch effect {
        case let .schedule(timer, delay):
            let task = Task { [weak self] in
                do { try await Task.sleep(for: delay) } catch { return }
                guard let self else { return }
                await self.timerElapsed(timer)
            }
            switch timer {
            case .trailing:
                publicationTask?.cancel()
                publicationTask = task
            case .max:
                maxPublicationTask?.cancel()
                maxPublicationTask = task
            }
        case .cancelTimers:
            publicationTask?.cancel()
            publicationTask = nil
            maxPublicationTask?.cancel()
            maxPublicationTask = nil
        case let .persistRequest(_, _, extends):
            // Request preparation and submission run through the ordinary
            // pass, which persists the exact request before its first attempt.
            let extend = extends != nil
            let admission = latestAdmission
            Task { [weak self] in
                guard let self else { return }
                _ = try? await self.synchronize(admission: admission, extendExistingAttempt: extend)
            }
        case .submit, .apply, .catchUp, .discardMirrorHead, .surfaceConflict, .stop:
            // Submission, materialization, and catch-up are performed inline by
            // the pass that dispatched the event; they report back with
            // `applied`, `conflicted`, or a failure.
            break
        }
    }

    private func timerElapsed(_ timer: DirectSyncMachine.Timer) {
        switch timer {
        case .trailing:
            publicationTask = nil
            dispatch(.publishDelayElapsed)
        case .max:
            maxPublicationTask = nil
            dispatch(.maxDelayElapsed)
        }
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
              final.update.root == event.tree.root else {
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
        let current = try await transport.descriptor(tree: treeID)
        let snapshot = try await transport.snapshot(tree: treeID, root: current.tree.root)
        let update = current.tree.update
        guard !update.isEmpty else { throw ReplicaSyncError.replicaIsNotPlaced }
        let latestHeads = try await replica.heads()
        if latestHeads.pendingRoot != nil || latestHeads.materializedRoot != heads.materializedRoot {
            return try await synchronize(admission: nil)
        }
        do {
            if snapshot.root == latestHeads.materializedRoot {
                try await replica.recordAccepted(root: snapshot.root, update: update, cursor: current.observedThrough)
            } else {
                let replacement = try SnapshotBridge.replacement(
                    snapshot: snapshot,
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
            acceptedRoot: snapshot.root,
            localRoot: snapshot.root
        )
        try files.write(control)
        return control.presentation
    }

    /** Explicit synchronization bypasses the trailing publication delay. */
    @discardableResult
    public func syncOnce() async throws -> WorkspaceSyncPresentation {
        await ensureMachineEntered()
        if case let .locallyPending(_, preparing) = machine.phase, !preparing {
            // Prepare through the pass below rather than through a timer.
            machine.phase = .locallyPending(head: currentHead(), preparing: true)
            run(.cancelTimers)
        }
        return try await synchronize(admission: latestAdmission)
    }

    private func currentHead() -> DirectSyncMachine.LocalHead {
        if case let .locallyPending(head, _) = machine.phase { return head }
        return DirectSyncMachine.LocalHead(root: latestAdmission?.candidateRoot ?? "", origin: .editor)
    }

    /**
     * Nonblocking handoff for one just-durable patch admission. The admission is
     * already durable in ArborReplica; the machine coalesces it with any other
     * unsent generation behind one trailing publication delay, retains it as the
     * single successor of a request in flight, and leaves it in the replica
     * while the transport is unavailable so reconnection appends the latest
     * head once to any ambiguous prefix.
     */
    public func syncImmediately(_ admission: ReplicaPatchAdmission) async {
        latestAdmission = admission
        await ensureMachineEntered()
        dispatch(.localHead(root: admission.candidateRoot, origin: .editor))
    }

    /**
     * Records network-path availability for the Canopy transport. Reconnection immediately
     * submits one longer plural request containing any ambiguous sent prefix
     * plus the replica's latest durable offline state.
     */
    public func setTransportAvailable(_ available: Bool) async {
        let resumed = available && !transportAvailable
        transportAvailable = available
        await ensureMachineEntered()
        // The machine records availability; its resume effects are performed by
        // the explicit recovery branches below so that a request whose first
        // attempt is still hanging can be extended exactly once.
        let phase = machine.phase
        machine.transportAvailable = available
        if !available, case let .locallyPending(head, _) = phase {
            run(.cancelTimers)
            machine.phase = .offline(availability: .transport, request: nil, transmitted: false, head: head)
        }
        guard resumed else { return }
        if syncActive, control.attempt != nil {
            do {
                let attempt = try await extendAttemptToCurrent()
                _ = try await submit(attempt)
            } catch {
                // The durable prefix and latest replica head remain retryable.
            }
            return
        }
        let heads = try? await replica.heads()
        if control.attempt != nil || heads?.pendingRoot != nil || control.nextBase != nil {
            _ = try? await synchronize(admission: nil, extendExistingAttempt: true)
        } else {
            // A clean offline replica can still be behind Canopy. Reconnection
            // is an authoritative catch-up boundary even when there is no local
            // candidate to submit and no watch failure to trigger gap recovery.
            _ = try? await recoverWatchGap()
        }
    }

    private func synchronize(
        admission: ReplicaPatchAdmission?,
        extendExistingAttempt: Bool = false
    ) async throws -> WorkspaceSyncPresentation {
        try requireOpen()
        if syncActive {
            syncAgain = true
            return try await presentation()
        }
        syncActive = true
        defer { syncActive = false }
        await ensureMachineEntered()
        var nextAdmission = admission
        var shouldExtendExistingAttempt = extendExistingAttempt
        var result = try await presentation()
        repeat {
            syncAgain = false
            result = try await syncPass(
                admission: nextAdmission,
                extendExistingAttempt: shouldExtendExistingAttempt
            )
            nextAdmission = latestAdmission
            shouldExtendExistingAttempt = false
            if syncAgain {
                // A successor retained during the request publishes against the
                // applied base as one more pass.
                let heads = try await replica.heads()
                if heads.pendingRoot == nil || control.conflict != nil { syncAgain = false }
                else { syncAgain = true }
            }
        } while syncAgain
        return result
    }

    private func syncPass(
        admission: ReplicaPatchAdmission?,
        extendExistingAttempt: Bool = false
    ) async throws -> WorkspaceSyncPresentation {
        guard control.conflict == nil else { return try await presentation() }
        let attempt: DurableSyncAttempt
        if control.attempt != nil, extendExistingAttempt {
            attempt = try await extendAttemptToCurrent()
        } else if let existing = control.attempt { attempt = existing }
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
            return try await submit(attempt)
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
            noteConflict(validated, attempt: attempt)
            return control.presentation
        } catch let error as WireHTTPError where error.status == 401 || error.status == 403 {
            control.presentation.state = error.code == "device-revoked" ? .revoked : .authenticationFailure
            control.presentation.detail = error.message ?? error.code
            try files.write(control)
            dispatch(.authenticationFailed(reason: error.code))
            return control.presentation
        } catch {
            if error is ReplicaSyncError || error is ArborWireValidationError {
                terminal = true
                dispatch(.validationFailed(reason: String(describing: error)))
            } else {
                dispatch(.transportFailed(id: attempt.digest))
            }
            control.presentation.state = .offline
            control.presentation.detail = String(describing: error)
            try? files.write(control)
            throw error
        }
    }

    private func noteConflict(_ validated: WireUpdateConflict, attempt: DurableSyncAttempt) {
        dispatch(.conflicted(
            id: attempt.digest,
            conflict: DirectSyncMachine.ConflictEvidence(
                current: .init(root: validated.current.root, update: validated.current.id),
                draft: validated.draft.root,
                localRoot: attempt.candidate
            )
        ))
    }

    private func submit(_ attempt: DurableSyncAttempt) async throws -> WorkspaceSyncPresentation {
        guard inFlight.insert(attempt.digest).inserted else { return try await presentation() }
        defer { finishInFlight(attempt.digest) }
        dispatch(.submitStarted(id: attempt.digest))
        do {
            let prepared = PreparedWireUpdate(tree: attempt.tree, body: attempt.body, requestDigests: attempt.allRequestDigests)
            let response = try await transport.submit(prepared)
            try faultInjector.reached(.afterServerAcceptance)
            try await apply(response, for: attempt)
            return try await presentation()
        } catch let error as WireUpdateConflictError {
            guard control.attempt?.allRequestDigests.starts(with: attempt.allRequestDigests) == true else {
                return try await presentation()
            }
            let validated = try error.conflict.validated()
            control.conflict = DurableSyncConflict(response: validated, localRootAtConflict: control.attempt?.candidate ?? attempt.candidate)
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
            noteConflict(validated, attempt: attempt)
            return control.presentation
        } catch {
            if control.attempt?.digest != attempt.digest { return try await presentation() }
            throw error
        }
    }

    private func finishInFlight(_ digest: String) {
        inFlight.remove(digest)
    }

    public func resolveConflictKeepingLocal() throws {
        try requireOpen()
        guard let conflict = control.conflict else { throw ReplicaSyncError.noConflict }
        control.nextBase = WireUpdateBase(root: conflict.response.current.root, update: conflict.response.current.id)
        control.conflict = nil
        if case .conflict = machine.phase { dispatch(.resolveConflict(.local)) }
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

    public func close() {
        terminal = true
        run(.cancelTimers)
    }

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
        let treeID = (await replica.treeID()).rawValue
        let requestDigest = updateRequestDigest(tree: treeID, base: base, candidate: snapshot.root)
        let attempt = DurableSyncAttempt(
            tree: treeID,
            base: base,
            candidate: snapshot.root,
            generation: heads.generation,
            body: try encoder.encode(request),
            requestDigests: [requestDigest],
            digest: requestDigest
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
        notePersisted(attempt)
        return attempt
    }

    /// Record the persisted request in the machine, entering `locally-pending` first if the pass started it.
    private func notePersisted(_ attempt: DurableSyncAttempt) {
        switch machine.phase {
        case .current, .prepared, .submitting, .submittingPending, .acceptedPendingApply, .conflict:
            machine.phase = .locallyPending(head: .init(root: attempt.candidate, origin: .editor), preparing: true)
        default:
            break
        }
        dispatch(.requestPersisted(Self.preparedRequest(attempt)))
    }

    /** Persist and return a longer request while an older prefix remains in flight. */
    private func extendAttemptToCurrent() async throws -> DurableSyncAttempt {
        guard let existing = control.attempt else { return try await createAttempt() }
        var request = try JSONDecoder().decode(WireUpdateRequest.self, from: existing.body)
        let snapshot = try await replica.currentSnapshot()
        guard snapshot.root != existing.candidate else { return existing }
        let retained = (try? await retainedObjectHashes(root: existing.candidate)) ?? []
        let update = WireCandidateUpdate(
            candidate: snapshot.root,
            objects: snapshot.objects
                .filter { !retained.contains($0.hash) }
                .map { WireObjectEnvelope(hash: $0.hash, bytes: $0.bytes) }
        )
        request.updates.append(update)
        let digests = updateRequestDigests(tree: existing.tree, base: existing.base, updates: request.updates)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let attempt = DurableSyncAttempt(
            tree: existing.tree,
            base: existing.base,
            candidate: snapshot.root,
            generation: (try await replica.heads()).generation,
            body: try encoder.encode(request),
            requestDigests: digests,
            digest: digests.last!
        )
        try faultInjector.reached(.beforeRequestPersistence)
        control.attempt = attempt
        control.presentation = WorkspaceSyncPresentation(
            state: .requestPending,
            detail: "Submitting \(request.updates.count) durable root intents",
            acceptedRoot: existing.base.root,
            localRoot: snapshot.root,
            localAdditions: true
        )
        try files.write(control)
        try faultInjector.reached(.afterRequestPersistence)
        if case .offline = machine.phase {
            dispatch(.requestPersisted(Self.preparedRequest(attempt)))
        } else {
            notePersisted(attempt)
        }
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
        guard response.results.map(\.requestDigest) == attempt.allRequestDigests,
              let final = response.results.last else {
            throw ReplicaSyncError.returnedRequestDigestMismatch
        }
        guard control.attempt?.digest == attempt.digest else { return }
        let accepted: WireAcceptedUpdate
        let merge: WireMergeSummary?
        let outcome: DirectSyncMachine.AuthorityResult.Kind
        switch final.result {
        case let .current(update): accepted = update; merge = nil; outcome = .current
        case let .accepted(update): accepted = update; merge = nil; outcome = .accepted
        case let .merged(update, summary): accepted = update; merge = summary; outcome = .merged
        }
        dispatch(.accepted(
            id: attempt.digest,
            result: .init(kind: outcome, root: accepted.root, update: accepted.id, cursor: accepted.id, digests: attempt.allRequestDigests)
        ))
        if final.reconciliation == nil, accepted.root != attempt.candidate {
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
                dispatch(.applied)
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
            // The accepted decision is durable; the retained successor publishes
            // against the advanced base as the next pass.
            if case let .acceptedPendingApply(result, request, head) = machine.phase {
                machine.phase = .acceptedPendingApply(
                    result: result,
                    request: request,
                    head: head ?? .init(root: heads.materializedRoot, origin: .editor)
                )
            }
            dispatch(.applied)
            syncAgain = true
            return
        }

        if accepted.root == attempt.candidate {
            try faultInjector.reached(.beforeBaseAdvancement)
            try await replica.recordAccepted(root: accepted.root, update: accepted.id, cursor: accepted.id)
        } else {
            guard let reconciliation = final.reconciliation else { throw ReplicaSyncError.returnedSnapshotMissing }
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
        dispatch(.applied)
    }

    private func retainedObjectHashes(root: String) async throws -> Set<String> {
        var pending = [root]
        var visited = Set<String>()
        while let hash = pending.popLast() {
            if !visited.insert(hash).inserted { continue }
            let bytes = try await replica.storedObjectBytes(hash: hash)
            let object = try WireObjectCodec.decode(bytes)
            if case let .directory(entries, _) = object {
                for entry in entries {
                    if let hash = entry.hash { pending.append(hash) }
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
        let current = try await transport.descriptor(tree: tree.id)
        let snapshot = try await transport.snapshot(tree: tree.id, root: current.tree.root)
        let update = current.tree.update
        guard !update.isEmpty else { throw ReplicaSyncError.replicaIsNotPlaced }
        let replica = try await ArborReplica.open(at: replicaRoot, tree: TreeID(rawValue: tree.id))
        let replacement = try SnapshotBridge.replacement(
            snapshot: snapshot,
            tree: TreeID(rawValue: tree.id),
            update: update,
            cursor: current.observedThrough
        )
        try await replica.initializeFromSystem(replacement)
        return replica
    }
}
