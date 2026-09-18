import ArborKit
import ArborWire
import ArborObjectStore
import Foundation
import OSLog

/// Effect runner for `UpdateMachine` over a `WorkingTree` and a Wire
/// transport. The working tree holds the node index; `UpdateControl` retains
/// the durable head with its objects, the exact request (with its envelopes),
/// and the next base; the machine owns scheduling:
/// one request in flight, one retained successor, a trailing publication delay,
/// and the single ambiguous-recovery transition on reconnection.
///
/// Every request body is cut from the tree's own bytes (inline state plus its
/// overlay) minus what the base already retains, so a candidate never carries a
/// platform-served file. Resubmission reads envelopes only from the persisted
/// attempt, never from a live object store.
public actor UpdateCoordinator {
    private let workingTree: WorkingTree
    private let transport: any UpdateTransport
    private let sourceObjectStore: (any ObjectStore)?
    private let files: UpdateControlFiles
    private let faultInjector: any UpdateFaultInjector
    private var control: UpdateControl
    private var terminal = false
    private var syncActive = false
    private var syncAgain = false
    private var inFlight = Set<String>()
    private var transportAvailable: Bool
    private var machine = UpdateMachine.State()
    private let machineOptions: UpdateMachine.Options
    private var publicationTask: Task<Void, Never>?
    private var maxPublicationTask: Task<Void, Never>?
    /// The most recent durable editor admission, for the immediate-delta fast path.
    private var latestAdmission: WorkingTreePatchAdmission?
    /// Enable only after the destination accepts every emitted form.
    public nonisolated let sourceOperationEmission: Bool
    private var sourceQueue: SourceAdmissionQueue?
    private var sourceViews: [String: CapturedSourceAdmissionBasis] = [:]
    private var admissionTail: Task<Void, Never>?
    private var preparedStructures: [Data: (record: SourceAdmissionRecord, node: WorkspaceNode)] = [:]
    private var preparedSourceIntents: [Data: SourceAdmissionRecord] = [:]

    public init(
        workingTree: WorkingTree,
        transport: any UpdateTransport,
        stateRoot: URL,
        transportAvailable: Bool = true,
        sourceOperationEmission: Bool = false,
        sourceObjectStore: (any ObjectStore)? = nil,
        faultInjector: any UpdateFaultInjector = NoUpdateFaults(),
        publicationDelay: Duration = UpdateMachine.publicationDelay,
        publicationMaxDelay: Duration = UpdateMachine.publicationMaxDelay
    ) throws {
        self.sourceOperationEmission = sourceOperationEmission
        self.workingTree = workingTree
        self.transport = transport
        self.sourceObjectStore = sourceObjectStore
        self.files = try UpdateControlFiles(root: stateRoot)
        self.faultInjector = faultInjector
        self.control = try files.load()
        if control.sourceMode == true && !sourceOperationEmission {
            throw ArborWireValidationError.invalidValue("Retained source admissions require the source-enabled client path")
        }
        if sourceOperationEmission {
            guard !control.hasLegacyWork else {
                throw ArborWireValidationError.invalidValue("Retained snapshot work requires recovery before source admission; saved work has not been changed")
            }
        }
        // An incompatible or altered durable request must remain on disk for recovery.
        for attempt in [control.attempt].compactMap({ $0 }) {
            let request = try JSONDecoder().decode(WireUpdateRequest.self, from: attempt.body)
            guard request.base == attempt.base.update,
                  request.updates.last?.candidate == attempt.candidate,
                  attempt.digest == attempt.allRequestDigests.last,
                  updateRequestDigests(tree: attempt.tree, base: attempt.base, updates: request.updates) == attempt.allRequestDigests else {
                throw ArborWireValidationError.invalidValue("Durable update intent does not match its digests")
            }
        }
        if sourceOperationEmission {
            control.sourceMode = true
            try files.write(control)
        }
        self.transportAvailable = transportAvailable
        self.machine = UpdateMachine.State(transportAvailable: transportAvailable)
        self.machineOptions = UpdateMachine.Options(publicationDelay: publicationDelay, publicationMaxDelay: publicationMaxDelay)
    }

    /// The machine state, for status and tests.
    public var syncState: UpdateMachine.State { machine }

    // MARK: Machine

    /// Enter the machine from the replica's accepted base and map the retained
    /// durable control onto its phase: a retained attempt is `prepared` (it is
    /// resubmitted exactly), and unsent
    /// replica generations are one local head.
    private func ensureMachineEntered() async {
        guard case .unplaced = machine.phase else { return }
        guard let heads = try? await workingTree.heads(),
              let root = control.nextBase?.root ?? heads.acceptedRoot,
              let update = control.nextBase?.update ?? heads.acceptedUpdate else { return }
        dispatch(.bootstrapInstalled(root: root, update: update, cursor: heads.acceptedCursor, conflicted: control.acceptedConflicted))
        if let attempt = control.attempt {
            machine.phase = .prepared(request: Self.preparedRequest(attempt), head: nil)
        } else if let head = control.head, let attempt = try? recoverAttempt(from: head, tree: await workingTree.treeID().rawValue) {
            // The process stopped between the durable head and its publication:
            // the head's own objects make it a self-contained one-element request.
            machine.phase = .prepared(request: Self.preparedRequest(attempt), head: nil)
        } else if sourceOperationEmission, let pending = try? await pendingSourceRecords(), let last = pending.last {
            dispatch(.localHead(root: last.candidate.root, origin: .editor))
        } else if heads.pendingRoot != nil {
            dispatch(.localHead(root: heads.materializedRoot, origin: .editor))
        }
    }

    /// Turn a durable head into the exact attempt it would have become.
    private func recoverAttempt(from head: UpdateHead, tree: String) throws -> UpdateAttempt {
        var objects = head.objects
        for hash in head.spilledObjects ?? [] { objects.append(try files.readObject(hash)) }
        let request = WireUpdateRequest(base: head.base, candidate: head.root, objects: objects)
        let attempt = try Self.attempt(tree: tree, base: head.base, generation: head.generation, request: request)
        control.attempt = attempt
        control.head = nil
        control.presentation = WorkspaceSyncPresentation(
            state: .requestPending,
            detail: "Recovered the durable head as one request",
            acceptedRoot: head.base.root,
            localRoot: head.root,
            localAdditions: head.root != head.base.root
        )
        control.presentation.acceptedConflicted = control.acceptedConflicted
        try files.write(control)
        files.retainObjects([])
        return attempt
    }

    /// Encode one request as an immutable attempt: its body carries every envelope it will ever send.
    private static func attempt(
        tree: String,
        base: WireUpdateBase,
        generation: Int,
        request: WireUpdateRequest
    ) throws -> UpdateAttempt {
        guard let last = request.updates.last else { throw UpdateError.requestEmpty }
        let digests = updateRequestDigests(tree: tree, base: base, updates: request.updates)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return UpdateAttempt(
            tree: tree,
            base: base,
            candidate: last.candidate,
            generation: generation,
            body: try encoder.encode(request),
            requestDigests: digests,
            digest: digests.last!
        )
    }

    private static func preparedRequest(_ attempt: UpdateAttempt) -> UpdateMachine.PreparedRequest {
        .init(id: attempt.digest, base: attempt.base.update, candidate: attempt.candidate, digests: attempt.allRequestDigests)
    }

    private func dispatch(_ event: UpdateMachine.Event) {
        let (next, effects) = UpdateMachine.reduce(machine, event, options: machineOptions)
        machine = next
        for effect in effects { run(effect) }
    }

    private func run(_ effect: UpdateMachine.Effect) {
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
        case .submit, .apply, .catchUp, .stop:
            // Submission, materialization, and catch-up are performed inline by
            // the pass that dispatched the event; they report back with
            // `applied` or a failure.
            break
        }
    }

    private func timerElapsed(_ timer: UpdateMachine.Timer) {
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
        let heads = try await workingTree.heads()
        var value = control.presentation
        value.acceptedConflicted = control.acceptedConflicted
        value.acceptedRoot = control.nextBase?.root ?? heads.acceptedRoot
        value.localRoot = heads.materializedRoot
        if control.attempt != nil { value.state = .requestPending }
        else if sourceOperationEmission, try await hasSourceWork() {
            value.state = .locallyPending
            let local = try await sourceLocalViewState()
            value.localRoot = local.navigation?.candidate.root ?? heads.materializedRoot
            value.localAdditions = true
            if !local.structural { value.detail = UpdateError.awaitingCanopyReconciliation.localizedDescription }
        }
        else if heads.pendingRoot != nil { value.state = .locallyPending }
        return value
    }

    public func watchCursor() async throws -> String? {
        try requireOpen()
        return try await workingTree.heads().acceptedCursor
    }

    /** Reestablishes a coherent snapshot-then-follow boundary after watch history expires. */
    @discardableResult
    public func recoverWatchGap() async throws -> WorkspaceSyncPresentation {
        try requireOpen()
        let heads = try await workingTree.heads()
        let reviewPending = try files.loadReview().attempt != nil
        if (try await hasSourceWork()) || control.attempt != nil || heads.pendingRoot != nil || control.nextBase != nil || reviewPending {
            return try await synchronize(admission: nil)
        }
        return try await pullCurrentSnapshot(treeID: await workingTree.treeID().rawValue, priorHeads: heads)
    }

    /** Applies one accepted-state invalidation without turning a clean pull into a write. */
    @discardableResult
    public func observe(_ event: WireWatchEvent) async throws -> WorkspaceSyncPresentation {
        try requireOpen()
        let treeID = await workingTree.treeID().rawValue
        guard event.tree.id == treeID else { return try await presentation() }
        let heads = try await workingTree.heads()
        if heads.acceptedCursor.map({ event.id.utf8.elementsEqual($0.utf8) }) == true { return try await presentation() }
        if let requestDigest = event.requestDigest,
           control.attempt?.allRequestDigests.contains(requestDigest) == true {
            // The watch won the response race, or the response was lost. Replaying
            // the exact durable request obtains the server's stored response.
            return try await synchronize(admission: nil)
        }
        let reviewPending = try files.loadReview().attempt != nil
        if (try await hasSourceWork()) || control.attempt != nil || heads.pendingRoot != nil || control.nextBase != nil || reviewPending {
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
        priorHeads heads: WorkingTreeHeads
    ) async throws -> WorkspaceSyncPresentation {
        guard let final = event.transitions.last,
              final.update.id.utf8.elementsEqual(event.tree.update.utf8),
              final.update.root == event.tree.root else {
            throw ArborWireValidationError.invalidValue("Watch transition batch does not match its descriptor")
        }
        guard let first=event.transitions.first,
              first.transportBasis?.id.utf8.elementsEqual((heads.acceptedUpdate ?? "").utf8) == true,
              first.transportBasis?.root == heads.acceptedRoot else {
            throw ArborWireValidationError.invalidValue("Watch predecessor differs from confirmed accepted state")
        }
        let basis = try await sparseBasis(deltaBases: Set(event.transitions.flatMap { $0.deltas.map(\.base) }))
        let accepted = try WireTransitionReplay.applying(event.transitions, to: basis, mode: .sparseFiles)
        let latestHeads = try await workingTree.heads()
        if latestHeads.pendingRoot != nil || latestHeads.materializedRoot != heads.materializedRoot {
            return try await synchronize(admission: nil)
        }
        if accepted.root == latestHeads.materializedRoot {
            try await workingTree.recordAccepted(root: accepted.root, update: final.update.id, cursor: event.id)
        } else {
            let replacement = try SnapshotBridge.replacement(
                snapshot: accepted,
                tree: await workingTree.treeID(),
                update: final.update.id,
                cursor: event.id,
                mode: .sparseFiles
            )
            try await workingTree.replaceFromSystem(replacement)
        }
        control.head = nil
        control.acceptedConflicted = final.update.conflicted
        control.presentation = WorkspaceSyncPresentation(
            state: .current,
            detail: "Applied \(event.transitions.count) ordered accepted transition\(event.transitions.count == 1 ? "" : "s")",
            acceptedRoot: final.update.root,
            localRoot: final.update.root,
            remoteAdditions: true
        )
        control.presentation.acceptedConflicted = control.acceptedConflicted
        try files.write(control)
        return control.presentation
    }

    /// The tree's own sparse graph plus the bytes every delta in a transition
    /// needs, fetched through the object store once each. Files the transition
    /// does not touch stay absent; the replay and the bridge both run sparse.
    private func sparseBasis(deltaBases: Set<String>) async throws -> WireSnapshot {
        var basis = try await workingTree.localSnapshot()
        let present = Set(basis.objects.map(\.hash))
        for hash in deltaBases.sorted() where !present.contains(hash) {
            basis.objects.append(WireObjectEnvelope(hash: hash, bytes: try await workingTree.objectBytes(hash: hash)))
        }
        return basis
    }

    private func pullCurrentSnapshot(
        treeID: String,
        priorHeads heads: WorkingTreeHeads
    ) async throws -> WorkspaceSyncPresentation {
        let current = try await transport.descriptor(tree: treeID)
        let snapshot = try await transport.snapshot(tree: treeID, root: current.tree.root)
        let update = current.tree.update
        guard !update.isEmpty else { throw UpdateError.replicaIsNotPlaced }
        let latestHeads = try await workingTree.heads()
        if latestHeads.pendingRoot != nil || latestHeads.materializedRoot != heads.materializedRoot {
            return try await synchronize(admission: nil)
        }
        do {
            if snapshot.root == latestHeads.materializedRoot {
                try await workingTree.recordAccepted(root: snapshot.root, update: update, cursor: current.observedThrough)
            } else {
                let replacement = try SnapshotBridge.replacement(
                    snapshot: snapshot,
                    tree: await workingTree.treeID(),
                    update: update,
                    cursor: current.observedThrough
                )
                try await workingTree.replaceFromSystem(replacement)
            }
        } catch WorkingTreeError.pendingLocalChanges {
            return try await synchronize(admission: nil)
        }
        control.head = nil
        control.acceptedConflicted = current.tree.conflicted
        control.presentation = WorkspaceSyncPresentation(
            state: .current,
            detail: "Applied the server's current snapshot",
            acceptedRoot: snapshot.root,
            localRoot: snapshot.root
        )
        control.presentation.acceptedConflicted = control.acceptedConflicted
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

    private func currentHead() -> UpdateMachine.LocalHead {
        if case let .locallyPending(head, _) = machine.phase { return head }
        return UpdateMachine.LocalHead(root: latestAdmission?.candidateRoot ?? "", origin: .editor)
    }

    /// Retain a patch admission on disk before acknowledging the editor. This
    /// is essential for the Mac's in-memory working tree. Publication remains
    /// deferred: coalesce unsent generations behind the publication delay,
    /// retain a successor during an in-flight request, and resume on reconnect.
    public func syncImmediately(_ admission: WorkingTreePatchAdmission) async throws {
        latestAdmission = admission
        await ensureMachineEntered()
        // The head is durable with its objects before the machine learns of it
        // (rule 1): a process that stops before the publication delay recovers
        // it as one request instead of losing the edit.
        try await persistHead()
        dispatch(.localHead(root: admission.candidateRoot, origin: .editor))
    }

    private func persistHead() async throws {
        let heads = try await workingTree.heads()
        guard heads.pendingRoot != nil else { return }
        let base = try currentBase(heads: heads)
        let candidate = try await candidateObjects(base: base.root)
        // Another page can advance the shared tree while its objects are read.
        // Persist the latest complete generation rather than acknowledging an
        // older callback without retaining either generation.
        guard candidate.root == heads.materializedRoot,
              try await workingTree.heads().generation == heads.generation,
              try currentBase(heads: heads) == base else {
            try await persistHead()
            return
        }
        let root = candidate.root
        var envelopes = candidate.objects
        guard control.head?.root != root || control.head?.base != base else { return }
        var spilled: [String] = []
        if envelopes.reduce(0, { $0 + $1.bytes.count }) > UpdateHead.inlineByteCap {
            for envelope in envelopes.sorted(by: { $0.bytes.count > $1.bytes.count }) {
                try files.writeObject(envelope)
                spilled.append(envelope.hash)
            }
            envelopes.removeAll { spilled.contains($0.hash) }
        }
        var retained = control
        retained.head = UpdateHead(
            base: base,
            root: root,
            generation: heads.generation,
            objects: envelopes,
            spilledObjects: spilled.isEmpty ? nil : spilled
        )
        retained.presentation.acceptedConflicted = retained.acceptedConflicted
        try files.write(retained)
        control = retained
        files.retainObjects(Set(spilled))
    }

    private func currentBase(heads: WorkingTreeHeads) throws -> WireUpdateBase {
        if let nextBase = control.nextBase { return nextBase }
        guard let root = heads.acceptedRoot, let update = heads.acceptedUpdate else {
            throw UpdateError.replicaIsNotPlaced
        }
        return WireUpdateBase(root: root, update: update)
    }

    /// The tree's local graph (inline state plus overlay) validated as a sparse
    /// spine, and the subset of it the base does not already retain. Nothing is
    /// fetched: a platform-served file is by definition retained by an accepted
    /// root the authority can reach.
    private func candidateObjects(base: String) async throws -> (root: String, objects: [WireObjectEnvelope]) {
        let local = try await workingTree.localSnapshot()
        _ = try WireObjectGraph.validate(local, mode: .sparseFiles)
        let retained = (try? await retainedObjectHashes(root: base)) ?? []
        return (local.root, local.objects.filter { !retained.contains($0.hash) })
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
        if syncActive, control.attempt != nil, control.sourceAttemptChange == nil {
            do {
                let attempt = try await extendAttemptToCurrent()
                _ = try await submit(attempt)
            } catch {
                // The durable prefix and latest replica head remain retryable.
            }
            return
        }
        let heads = try? await workingTree.heads()
        if ((try? await hasSourceWork()) ?? false) || control.attempt != nil || heads?.pendingRoot != nil || control.nextBase != nil {
            _ = try? await synchronize(admission: nil, extendExistingAttempt: true)
        } else {
            // A clean offline replica can still be behind Canopy. Reconnection
            // is an authoritative catch-up boundary even when there is no local
            // candidate to submit and no watch failure to trigger gap recovery.
            _ = try? await recoverWatchGap()
        }
    }

    private func synchronize(
        admission: WorkingTreePatchAdmission?,
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
                let heads = try await workingTree.heads()
                let sourcePending = try await hasSourceWork()
                if (heads.pendingRoot == nil && !sourcePending) { syncAgain = false }
                else { syncAgain = true }
            }
        } while syncAgain
        return result
    }

    private func syncPass(
        admission: WorkingTreePatchAdmission?,
        extendExistingAttempt: Bool = false
    ) async throws -> WorkspaceSyncPresentation {
        if let review = try files.loadReview().attempt { return try await syncReviewAttempt(review) }
        let sourcePending = try await hasSourceWork()
        if sourceOperationEmission, control.sourceAttemptChange != nil || (control.attempt == nil && sourcePending) {
            return try await syncSourcePass()
        }
        let priorMachine = machine
        let currentHeads = try await workingTree.heads()
        if control.attempt == nil, control.nextBase == nil, currentHeads.pendingRoot == nil {
            // Reading the working tree can yield to a newer admission. Do not
            // retire that admission's scheduling state using an older snapshot.
            guard machine == priorMachine else {
                syncAgain = true
                return try await presentation()
            }
            // The shared provider may acknowledge the candidate before this
            // publication pass runs. Its no-work exit must finish preparation;
            // otherwise later local heads inherit `preparing: true` with no task.
            if let root = currentHeads.acceptedRoot, let update = currentHeads.acceptedUpdate {
                machine.base = .init(root: root, update: update, cursor: currentHeads.acceptedCursor, conflicted: control.acceptedConflicted)
                machine.phase = .current
                run(.cancelTimers)
            }
            if sourceOperationEmission {
                return try await pullCurrentSnapshot(treeID: await workingTree.treeID().rawValue, priorHeads: currentHeads)
            }
            return try await presentation()
        }
        var preparedAttempt: UpdateAttempt?
        do {
            let attempt: UpdateAttempt
            if control.attempt != nil, extendExistingAttempt {
                attempt = try await extendAttemptToCurrent()
            } else if let existing = control.attempt { attempt = existing }
            else { attempt = try await createAttempt(admission: admission) }
            preparedAttempt = attempt
            control.presentation = WorkspaceSyncPresentation(
                state: .uploading,
                detail: "Submitting one durable root intent",
                acceptedRoot: attempt.base.root,
                localRoot: attempt.candidate,
                localAdditions: attempt.candidate != attempt.base.root
            )
            control.presentation.acceptedConflicted = control.acceptedConflicted
            try files.write(control)
            try faultInjector.reached(.duringUpload)
            return try await submit(attempt)
        } catch let error as WireHTTPError where error.status == 401 || error.status == 403 {
            control.presentation.state = error.code == "device-revoked" ? .revoked : .authenticationFailure
            control.presentation.detail = error.message ?? error.code
            control.presentation.acceptedConflicted = control.acceptedConflicted
            try files.write(control)
            dispatch(.authenticationFailed(reason: error.code))
            return control.presentation
        } catch {
            if error is UpdateError || error is ArborWireValidationError || (error as? WireHTTPError)?.code == "unsupported-operation" {
                terminal = true
                dispatch(.validationFailed(reason: String(describing: error)))
            } else {
                dispatch(.transportFailed(id: preparedAttempt?.digest))
            }
            control.presentation.state = .offline
            control.presentation.detail = String(describing: error)
            try? files.write(control)
            throw error
        }
    }

    private func submit(_ attempt: UpdateAttempt) async throws -> WorkspaceSyncPresentation {
        guard inFlight.insert(attempt.digest).inserted else { return try await presentation() }
        defer { finishInFlight(attempt.digest) }
        dispatch(.submitStarted(id: attempt.digest))
        do {
            let prepared = PreparedWireUpdate(tree: attempt.tree, body: attempt.body, requestDigests: attempt.allRequestDigests)
            let response = try await transport.submit(prepared)
            try faultInjector.reached(.afterServerAcceptance)
            try await apply(response, for: attempt)
            return try await presentation()
        } catch {
            if control.attempt?.digest != attempt.digest { return try await presentation() }
            throw error
        }
    }

    private func finishInFlight(_ digest: String) {
        inFlight.remove(digest)
    }

    public func close() {
        terminal = true
        run(.cancelTimers)
    }

    private func createAttempt(admission: WorkingTreePatchAdmission? = nil) async throws -> UpdateAttempt {
        let heads = try await workingTree.heads()
        let base = try currentBase(heads: heads)
        // The candidate is the tree's own bytes minus what the base retains
        // (inline state plus overlay, validated as a sparse spine). A file the
        // platform serves is never packed: an accepted root already reaches it.
        let candidate = try await candidateObjects(base: base.root)
        let delta = try await immediateDelta(admission, heads: heads, base: base, candidate: candidate)
        let request = WireUpdateRequest(
            base: base,
            candidate: candidate.root,
            objects: candidate.objects.filter { $0.hash != delta?.result },
            deltas: delta.map { [$0] } ?? []
        )
        let treeID = (await workingTree.treeID()).rawValue
        let attempt = try Self.attempt(tree: treeID, base: base, generation: heads.generation, request: request)
        try faultInjector.reached(.beforeRequestPersistence)
        control.attempt = attempt
        control.head = nil
        control.presentation = WorkspaceSyncPresentation(
            state: .requestPending,
            acceptedRoot: base.root,
            localRoot: candidate.root,
            localAdditions: candidate.root != base.root
        )
        control.presentation.acceptedConflicted = control.acceptedConflicted
        try files.write(control)
        files.retainObjects([])
        try faultInjector.reached(.afterRequestPersistence)
        notePersisted(attempt)
        return attempt
    }

    /// Record the persisted request in the machine, entering `locally-pending` first if the pass started it.
    private func notePersisted(_ attempt: UpdateAttempt) {
        switch machine.phase {
        case .current, .prepared, .submitting, .submittingPending, .acceptedPendingApply:
            machine.phase = .locallyPending(head: .init(root: attempt.candidate, origin: .editor), preparing: true)
        default:
            break
        }
        dispatch(.requestPersisted(Self.preparedRequest(attempt)))
    }

    /** Persist and return a longer request while an older prefix remains in flight. */
    private func extendAttemptToCurrent() async throws -> UpdateAttempt {
        guard let existing = control.attempt else { return try await createAttempt() }
        var request = try JSONDecoder().decode(WireUpdateRequest.self, from: existing.body)
        let candidate = try await candidateObjects(base: existing.candidate)
        guard candidate.root != existing.candidate else {
            // Nothing to append: an exact resend. Let the reducer leave `offline`
            // through its own resume so the response is accepted, not ignored.
            if case .offline = machine.phase { dispatch(.transportAvailable(true)) }
            return existing
        }
        request.updates.append(WireCandidateUpdate(candidate: candidate.root, objects: candidate.objects))
        let heads = try await workingTree.heads()
        let attempt = try Self.attempt(
            tree: existing.tree,
            base: existing.base,
            generation: heads.generation,
            request: request
        )
        try faultInjector.reached(.beforeRequestPersistence)
        control.attempt = attempt
        control.head = nil
        control.presentation = WorkspaceSyncPresentation(
            state: .requestPending,
            detail: "Submitting \(request.updates.count) durable root intents",
            acceptedRoot: existing.base.root,
            localRoot: candidate.root,
            localAdditions: true
        )
        control.presentation.acceptedConflicted = control.acceptedConflicted
        try files.write(control)
        files.retainObjects([])
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
        _ admission: WorkingTreePatchAdmission?,
        heads: WorkingTreeHeads,
        base: WireUpdateBase,
        candidate: (root: String, objects: [WireObjectEnvelope])
    ) async throws -> WireObjectDelta? {
        guard let admission,
              admission.baseWasAccepted,
              admission.baseRoot == base.root,
              heads.acceptedRoot == admission.baseRoot,
              heads.materializedRoot == admission.candidateRoot,
              heads.pendingRoot == admission.candidateRoot,
              heads.generation == admission.generation,
              candidate.root == admission.candidateRoot,
              let resultEnvelope = candidate.objects.first(where: { $0.hash == admission.resultFile }),
              !candidate.objects.contains(where: { $0.hash == admission.baseFile }) else {
            return nil
        }
        // The base file's bytes come through the object store (overlay, then
        // platform). A miss is not an error: the full result object is sent.
        let baseBytes: Data
        do { baseBytes = try await workingTree.objectBytes(hash: admission.baseFile) } catch { return nil }
        guard case let .file(basePayload) = try WireObjectCodec.decode(baseBytes, kind: .file),
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

        var instructions: [WireObjectDeltaInstruction] = []
        var cursor = 0
        for edit in admission.patch.edits.sorted(by: { $0.utf8Range.lowerBound < $1.utf8Range.lowerBound }) {
            let lower = edit.utf8Range.lowerBound
            guard lower >= cursor, edit.utf8Range.upperBound <= basePayload.count else { return nil }
            if lower > cursor { instructions.append(.copy(offset: cursor, length: lower - cursor)) }
            let replacement = Data(edit.replacement.utf8)
            if !replacement.isEmpty { instructions.append(.insert(replacement)) }
            cursor = edit.utf8Range.upperBound
        }
        if cursor < basePayload.count {
            instructions.append(.copy(offset: cursor, length: basePayload.count - cursor))
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

    private func apply(_ response: WireUpdateResponse, for attempt: UpdateAttempt) async throws {
        guard response.results.map(\.requestDigest) == attempt.allRequestDigests,
              let final = response.results.last else {
            throw UpdateError.returnedRequestDigestMismatch
        }
        guard control.attempt?.digest == attempt.digest else { return }
        let accepted: WireAcceptedUpdate
        let outcome: UpdateMachine.AuthorityResult.Kind
        switch final.result {
        case let .unchanged(update): accepted = update; outcome = .current
        case let .accepted(update): accepted = update; outcome = .accepted
        }
        control.acceptedConflicted = accepted.conflicted
        // A historical receipt does not prove the current observation boundary.
        dispatch(.accepted(
            id: attempt.digest,
            result: .init(kind: outcome, root: accepted.root, update: accepted.id, cursor: nil, digests: attempt.allRequestDigests, conflicted: accepted.conflicted)
        ))
        if final.reconciliation == nil, accepted.root != attempt.candidate {
            throw UpdateError.returnedSnapshotMissing
        }
        try faultInjector.reached(.duringGraphDownload)

        let heads = try await workingTree.heads()
        if heads.materializedRoot != attempt.candidate {
            if heads.materializedRoot == accepted.root, heads.acceptedRoot == accepted.root {
                // A previous process durably installed this exact returned graph
                // before it could clear the attempt. Completing the same attempt
                // is idempotent and must not masquerade as newer local work.
                control.attempt = nil
                control.nextBase = nil
                control.head = nil
                setAppliedPresentation(accepted: accepted)
                control.presentation.acceptedConflicted = control.acceptedConflicted
                try files.write(control)
                dispatch(.applied)
                return
            }
            if heads.pendingRoot == nil {
                // The working tree no longer holds this candidate and has no
                // pending work of its own: it was re-seeded (a Mac relaunch, a
                // re-place) while the durable attempt or head carried the work.
                // The decision is applied; never re-submit the seed. Catch up to
                // the authority's current state instead.
                control.attempt = nil
                control.nextBase = nil
                control.head = nil
                setAppliedPresentation(accepted: accepted)
                control.presentation.acceptedConflicted = control.acceptedConflicted
                try files.write(control)
                dispatch(.applied)
                _ = try await pullCurrentSnapshot(treeID: attempt.tree, priorHeads: heads)
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
                remoteAdditions: accepted.root != attempt.candidate
            )
            control.presentation.acceptedConflicted = control.acceptedConflicted
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
            try await workingTree.recordAccepted(root: accepted.root, update: accepted.id, cursor: nil)
        } else {
            guard let reconciliation = final.reconciliation else { throw UpdateError.returnedSnapshotMissing }
            // The materialized root is the candidate here, so the local graph is
            // the basis the transition applies to: its sparse spine plus every
            // delta base, fetched once each.
            let basis = try await sparseBasis(deltaBases: Set(reconciliation.deltas.map(\.base)))
            let snapshot: WireSnapshot
            do {
                snapshot = try WireTransitionReplay.applying(reconciliation, to: basis, root: accepted.root, mode: .sparseFiles)
            } catch {
                throw UpdateError.returnedSnapshotMismatch
            }
            try faultInjector.reached(.duringMaterialization)
            let replacement = try SnapshotBridge.replacement(
                snapshot: snapshot,
                tree: await workingTree.treeID(),
                update: accepted.id,
                cursor: nil,
                mode: .sparseFiles
            )
            if heads.pendingRoot == nil {
                try await workingTree.replaceFromSystem(replacement)
            } else {
                try await workingTree.integrateAccepted(replacement, expectedCandidate: attempt.candidate)
            }
            try faultInjector.reached(.afterMaterialization)
        }
        control.attempt = nil
        control.nextBase = nil
        // The tree returned to current: no head outlives its acceptance.
        control.head = nil
        setAppliedPresentation(accepted: accepted)
        control.presentation.acceptedConflicted = control.acceptedConflicted
        try files.write(control)
        files.retainObjects([])
        dispatch(.applied)
    }

    /// Every hash reachable from `root`, walking directory objects only. File
    /// hashes are collected from directory entries without fetching file bytes;
    /// directories are always materialized locally, so this never fetches.
    private func retainedObjectHashes(root: String) async throws -> Set<String> {
        var pending = [(hash: root, isDirectory: true)]
        var visited = Set<String>()
        while let next = pending.popLast() {
            if !visited.insert(next.hash).inserted { continue }
            guard next.isDirectory else { continue }
            let bytes = try await workingTree.objectBytes(hash: next.hash)
            guard case let .directory(entries, _) = try WireObjectCodec.decode(bytes, kind: .directory) else { continue }
            // An entry's kind is unknown until its object is seen; peek the
            // overlay-held prefix rather than fetching a file to learn it is one.
            for entry in entries {
                guard let hash = entry.hash else { continue }
                pending.append((hash, entry.directory != nil))
            }
        }
        return visited
    }

    private func setAppliedPresentation(accepted: WireAcceptedUpdate) {
        control.acceptedConflicted = accepted.conflicted
        control.presentation = WorkspaceSyncPresentation(
            state: .current,
            detail: accepted.conflicted ? "Accepted state has unresolved conflicts" : "Current at accepted server root",
            acceptedRoot: accepted.root,
            localRoot: accepted.root
        )
    }

    enum StructuralAdmission: Codable, Sendable {
        case action(WorkspaceStructuralAction)
        case pageCreation(parent: WorkspaceReference, name: String, source: String, transaction: String, document: WorkspaceReference)
        case asset(WorkspaceAsset, parent: WorkspaceReference)
        case imported(name: String, bytes: Data, mediaType: String?, parent: WorkspaceReference)
    }

    /// Serialize local admissions so structural captures cannot race a newly
    /// retained source branch. Publication remains independent.
    func admitStructure(_ admission: StructuralAdmission) async throws -> WorkspaceNode {
        try requireOpen()
        guard sourceOperationEmission else { throw ArborWireValidationError.invalidValue("Source admission is not enabled") }
        let previous = admissionTail
        let task = Task {
            await previous?.value
            return try await self.retainStructure(admission)
        }
        admissionTail = Task { _ = try? await task.value }
        return try await task.value
    }

    private func retainStructure(_ admission: StructuralAdmission) async throws -> WorkspaceNode {
        try requireOpen()
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        let key = try encoder.encode(admission)
        guard try await sourceStructuralActionsAvailable() else { throw UpdateError.awaitingCanopyReconciliation }
        let prepared: (record: SourceAdmissionRecord, node: WorkspaceNode)
        if let previous = preparedStructures[key] { prepared = previous }
        else {
            let graph: WireSnapshot, basis: SourceAdmissionBasis
            if let latest = try await pendingSourceRecords().last {
                graph = latest.candidate; basis = .authored(change: latest.change)
            } else {
                let captured = try await workingTree.captureAdmissionGraph()
                graph = captured.graph; basis = .accepted(captured.base)
            }
            let staging = try await candidateTree(graph)
            let provider = WorkingTreeProvider(workingTree: staging)
            do {
                var transferred: WorkingTreeNode?
                var transferKind = EntryTransfer.Kind.moveEntry
                var isTrash = false
                if case let .action(action) = admission {
                    switch action {
                    case let .copy(reference, _):
                        transferred = try await staging.resolve(reference); transferKind = .copyEntry
                    case let .trash(reference):
                        transferred = try await staging.resolve(reference); isTrash = true
                    case let .rename(reference, _), let .move(reference, _):
                        transferred = try await staging.resolve(reference)
                    default: break
                    }
                }
                let node: WorkspaceNode
                switch admission {
                case let .action(action):
                    guard let result = try await provider.perform(action) else { throw ArborWireValidationError.invalidValue("Structural action returned no node") }
                    node = result
                case let .pageCreation(parent, name, source, _, _):
                    guard let result = try await provider.perform(.createMarkdown(parent: parent, name: name, source: source)) else { throw ArborWireValidationError.invalidValue("Page creation returned no node") }
                    node = result
                case let .asset(asset, parent):
                    let stored = try await provider.store(asset: asset, in: parent)
                    node = try await provider.resolve(stored.reference)
                case let .imported(name, bytes, mediaType, parent):
                    node = try await provider.importFile(name: name, bytes: bytes, mediaType: mediaType, in: parent)
                }
                let candidate = try await staging.localSnapshot()
                var actions: EntryActions?
                if let old = transferred, old.kind != .boundary {
                    let moved = try await staging.resolve(node.reference)
                    func path(_ n: WorkingTreeNode) -> String { n.kind == .markdown ? n.path + ".md" : n.path }
                    var paths = [(path(old), path(moved))]
                    if old.directoryBodyPlacement == .siblingMarkdown || old.shadowedSiblingMarkdownSource != nil {
                        paths.append((old.path + ".md", moved.path + ".md"))
                    }
                    if isTrash {
                        actions = EntryActions(removals: paths.map { $0.0 })
                    } else {
                        let transfers = try paths.map { source, destination in
                            let parts = destination.split(separator:"/").map(String.init)
                            let transfer = EntryTransfer(kind:transferKind,source:source,parent:parts.count == 1 ? "/" : "/"+parts.dropLast().joined(separator:"/"),name:parts.last!)
                            return try transferKind == .copyEntry ? transfer.capturingRewrites(graph:graph,candidate:candidate) : transfer
                        }
                        actions = EntryActions(transfers:transfers)
                    }
                }
                var creation: SourcePageCreation?
                if case let .pageCreation(_, _, _, transaction, document) = admission {
                    // Remove the first branch introduced by creation. A promoted
                    // Markdown parent's sibling body stays exactly where it was.
                    let parts = (node.reference.path + ".md").dropFirst().split(separator: "/").map(String.init)
                    let objects = try WireObjectGraph.validate(graph, mode: .sparseFiles)
                    var hash = graph.root, prefix: [String] = []
                    for part in parts {
                        prefix.append(part)
                        guard case let .directory(entries, _)? = objects[hash] else { throw ArborWireValidationError.invalidValue("Invalid creation parent") }
                        guard let entry = entries.first(where: { $0.name == part }) else { break }
                        guard let next = entry.directory else { throw ArborWireValidationError.invalidValue("Creation overwrote an existing entry") }
                        hash = next
                    }
                    creation = .init(transaction: transaction, document: document, removals: ["/" + prefix.joined(separator: "/")])
                }
                var record = try SourceAdmissionRecord(tree: await workingTree.treeID().rawValue, basis: basis,
                    graph: graph, candidate:candidate, entryActions:actions, creation:creation)
                record.localTrash = try await staging.captureLocalTrash()
                prepared = (record, node)
                preparedStructures[key] = prepared
                await staging.close()
            } catch { await staging.close(); throw error }
        }
        try await admissions().retain(prepared.record)
        preparedStructures[key] = nil
        await ensureMachineEntered()
        dispatch(.localHead(root: prepared.record.candidate.root, origin: .editor))
        if syncActive { syncAgain = true }
        await workingTree.invalidateDocumentViews()
        return prepared.node
    }

    private struct SourceViewToken: Codable {
        var base: WireUpdateBase
        var reference: WorkspaceReference
        var path: String
    }

    public func copyDocument(_ snapshot: WorkspaceDocumentSnapshot) async throws -> WorkspaceCopyDocument {
        let intent = try WorkspaceDocumentIntent(basis: snapshot, patch: .init(baseContentRevision: snapshot.contentRevision, edits: []), source: snapshot.source)
        let view = try await sourceView(for: intent)
        return WorkspaceCopyDocument(path: view.sourcePath, source: view.document.source)
    }

    // Explicitly expired editor transactions remain collectible on later publication.
    private var releasedUndoTransactions = Set<String>()

    public func releaseUndoTransactions(_ ids: Set<String>, reference: WorkspaceReference) async throws {
        try requireOpen()
        let queue = try await admissions()
        guard try await queue.retained().filter({ $0.editorTransactionID.map(ids.contains) == true }).allSatisfy({ $0.editorReference?.identity == reference.identity }) else {
            throw ArborWireValidationError.invalidValue("Undo release belongs to another document")
        }
        releasedUndoTransactions.formUnion(ids)
        _ = try await queue.compact(settled: Set(control.sourceAcceptedChanges ?? []),
                                    releasingTransactions: releasedUndoTransactions)
    }

    private func admissions() async throws -> SourceAdmissionQueue {
        if let sourceQueue { return sourceQueue }
        let queue = try await SourceAdmissionQueue(tree: await workingTree.treeID().rawValue,
                                             stateRoot: files.directory.deletingLastPathComponent(),
                                             platform: sourceObjectStore,
                                             settled: Set(control.sourceAcceptedChanges ?? []))
        sourceQueue = queue
        return queue
    }

    private func pendingSourceRecords(_ retained: [SourceAdmissionRecord]? = nil) async throws -> [SourceAdmissionRecord] {
        guard sourceOperationEmission else { return [] }
        let records: [SourceAdmissionRecord]
        if let retained { records = retained }
        else { records = try await admissions().retained() }
        let accepted = Set(control.sourceAcceptedChanges ?? [])
        return records.filter { !accepted.contains($0.change) }
    }

    /// Local candidates are authored branches, not merged tree projections. Only
    /// a single dependency chain based on the installed graph permits structure.
    /// Comparing roots here checks display coherence; authored identities remain
    /// unchanged in every retained request.
    private func sourceLocalViewState(_ retained: [SourceAdmissionRecord]? = nil) async throws -> (navigation: SourceAdmissionRecord?, structural: Bool) {
        let records = try await pendingSourceRecords(retained)
        guard let first = records.first else { return (nil, true) }
        let accepted = try await workingTree.heads().acceptedRoot
        let linear = zip(records, records.dropFirst()).allSatisfy { previous, next in
            next.basis == .authored(change: previous.change)
        }
        if linear && !records.contains(where: { $0.undoOf != nil }) && first.graph.root == accepted { return (records.last, true) }

        // Keep pending creations/moves visible while Canopy reconciles branches.
        // Document sessions independently read their own retained source intent.
        // If the structural prefix has settled, the installed projection owns it.
        guard let index = records.lastIndex(where: { $0.intent == nil }) else { return (nil, false) }
        var navigation = records[index]
        for record in records.dropFirst(index + 1) {
            guard record.undoOf == nil, record.basis == .authored(change: navigation.change) else { break }
            navigation = record
        }
        return (navigation, false)
    }

    func sourceStructuralActionsAvailable() async throws -> Bool {
        try requireOpen()
        return try await sourceLocalViewState().structural
    }

    private func hasSourceWork() async throws -> Bool { !(try await pendingSourceRecords()).isEmpty }

    private struct LocalSourceToken: Codable {
        var change: String
        var reference: WorkspaceReference
    }

    private func candidateTree(_ graph: WireSnapshot, includeTrash: Bool = true) async throws -> WorkingTree {
        let tree = try await WorkingTree.inMemory(tree: await workingTree.treeID(), platform: workingTree)
        try await tree.initializeFromSystem(SnapshotBridge.replacement(snapshot: graph, tree: await workingTree.treeID(),
            update: "local-candidate", mode: .sparseFiles))
        if includeTrash {
            let trash: WorkingTreeLocalTrash
            if let retained = try await admissions().retained().last(where: { $0.localTrash != nil })?.localTrash { trash = retained }
            else { trash = try await workingTree.captureLocalTrash() }
            if !trash.nodes.isEmpty { try await tree.installLocalTrash(trash) }
        }
        return tree
    }

    /// A disposable view of the retained candidate, never a replacement of the
    /// accepted working tree. Provider reads see locally created/moved entries.
    func sourceReadProvider(readOnly: Bool = false) async throws -> WorkingTreeProvider {
        let retained = try await admissions().retained()
        if let record = try await sourceLocalViewState(retained).navigation {
            return WorkingTreeProvider(workingTree: try await candidateTree(record.candidate), readOnly: readOnly)
        }
        if retained.last(where: { $0.localTrash != nil })?.localTrash?.nodes.isEmpty == false {
            return WorkingTreeProvider(workingTree: try await candidateTree(workingTree.localSnapshot()), readOnly: readOnly)
        }
        return WorkingTreeProvider(workingTree: workingTree, readOnly: readOnly)
    }

    private func localSourceView(_ record: SourceAdmissionRecord, reference: WorkspaceReference? = nil) async throws -> CapturedSourceAdmissionBasis {
        guard let reference = reference ?? record.intent?.basis.reference else {
            throw ArborWireValidationError.invalidValue("A structural candidate requires a document reference")
        }
        let tree = try await candidateTree(record.candidate, includeTrash: false)
        let captured: CapturedSourceAdmissionBasis
        do { captured = try await tree.captureSourceAdmissionBasis(reference) }
        catch { await tree.close(); throw error }
        await tree.close()
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        var document = captured.document
        document.contentRevision = "source-candidate:" + (try encoder.encode(LocalSourceToken(change: record.change, reference: captured.document.reference))).base64EncodedString()
        return CapturedSourceAdmissionBasis(document: document, graph: record.candidate, accepted: nil, sourcePath: captured.sourcePath)
    }

    public func sourceSnapshot(_ reference: WorkspaceReference) async throws -> WorkspaceDocumentSnapshot {
        try requireOpen()
        guard sourceOperationEmission else { throw ArborWireValidationError.invalidValue("Source admission is not enabled") }
        if let latest = try await pendingSourceRecords().last(where: { $0.intent == nil || $0.intent?.basis.reference.identity == reference.identity }), latest.undoOf == nil {
            let view = try await localSourceView(latest, reference: reference)
            sourceViews[view.document.contentRevision] = view
            return view.document
        }
        let captured = try await workingTree.captureSourceAdmissionBasis(reference)
        if let latest = try await pendingSourceRecords().last(where: { $0.intent == nil || $0.intent?.basis.reference.identity == reference.identity }), latest.undoOf == nil {
            let view = try await localSourceView(latest, reference: reference)
            sourceViews[view.document.contentRevision] = view
            return view.document
        }
        guard let accepted = captured.accepted else { throw ArborWireValidationError.invalidValue("Legacy local work has no source admission dependency") }
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        let token = "source-accepted:" + (try encoder.encode(SourceViewToken(base: accepted, reference: captured.document.reference, path: captured.sourcePath))).base64EncodedString()
        var document = captured.document; document.contentRevision = token
        sourceViews[token] = CapturedSourceAdmissionBasis(document: document, graph: captured.graph, accepted: accepted, sourcePath: captured.sourcePath)
        return document
    }

    private func localPredecessor(_ revision: String) throws -> String? {
        if revision.hasPrefix("source-local:") { return String(revision.dropFirst("source-local:".count)) }
        if revision.hasPrefix("source-candidate:"), let data = Data(base64Encoded: String(revision.dropFirst("source-candidate:".count))) {
            return try JSONDecoder().decode(LocalSourceToken.self, from: data).change
        }
        return nil
    }

    private func sourceView(for intent: WorkspaceDocumentIntent) async throws -> CapturedSourceAdmissionBasis {
        let revision = intent.basis.contentRevision
        if let view = sourceViews[revision] { return view }
        let records = try await admissions().retained()
        if let predecessor = try localPredecessor(revision), let parent = records.first(where: { $0.change == predecessor }) {
            var view = try await localSourceView(parent, reference: intent.basis.reference)
            // Preserve the old revision spelling when recovering an older journal.
            var document = view.document; document.contentRevision = revision
            view = CapturedSourceAdmissionBasis(document: document, graph: view.graph, accepted: nil, sourcePath: view.sourcePath)
            return view
        }
        guard revision.hasPrefix("source-accepted:"),
              let data = Data(base64Encoded: String(revision.dropFirst("source-accepted:".count))) else {
            throw ArborWireValidationError.invalidValue("The edit's original tree basis is unavailable; its recovery draft is retained")
        }
        let token = try JSONDecoder().decode(SourceViewToken.self, from: data)
        guard token.reference == intent.basis.reference, token.reference.tree == (await workingTree.treeID()) else {
            throw ArborWireValidationError.invalidValue("Recovered source basis has a different scope")
        }
        let local = try await workingTree.localSnapshot()
        let graph: WireSnapshot
        if local.root == token.base.root { graph = local }
        else if let retained = records.first(where: { $0.graph.root == token.base.root }) { graph = retained.graph }
        else { graph = try await transport.snapshot(tree: token.reference.tree.rawValue, root: token.base.root) }
        guard graph.root == token.base.root else { throw UpdateError.returnedSnapshotMismatch }
        return CapturedSourceAdmissionBasis(document: intent.basis, graph: graph, accepted: token.base, sourcePath: token.path)
    }

    /// The client, not the editor bridge, binds and durably retains the original basis.
    public func admitSourceIntent(_ intent: WorkspaceDocumentIntent) async throws -> WorkspaceDocumentSnapshot {
        try requireOpen()
        guard sourceOperationEmission else { throw ArborWireValidationError.invalidValue("Source admission is not enabled") }
        let previous = admissionTail
        let task = Task {
            await previous?.value
            return try await self.retainSourceIntent(intent)
        }
        admissionTail = Task { _ = try? await task.value }
        let log = Logger(subsystem: "org.arbor.native", category: "SourceAdmission")
        log.notice("retain begin edits=\(intent.patch.edits.count) transactions=\(intent.patch.transactions?.count ?? 0) bytes=\(intent.source.utf8.count)")
        do {
            let result = try await task.value
            log.notice("retain succeeded")
            return result
        } catch {
            log.error("retain failed: \(String(describing: error), privacy: .public)")
            throw error
        }
    }

    private func retainSourceIntent(_ intent: WorkspaceDocumentIntent) async throws -> WorkspaceDocumentSnapshot {
        try requireOpen()
        try intent.validate()
        if let transactions = intent.patch.transactions { return try await retainSourceTransactions(intent, transactions: transactions) }
        let queue = try await admissions()
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        let intentBytes = try encoder.encode(intent)
        let existing = try await queue.retained().last { record in
            guard let intent = record.intent else { return false }; return try encoder.encode(intent) == intentBytes
        }
        let record: SourceAdmissionRecord
        if let existing { record = existing }
        else {
            let view = try await sourceView(for: intent)
            let parent = try localPredecessor(intent.basis.contentRevision)
            if let prepared = preparedSourceIntents[intentBytes] { record = prepared }
            else {
                record = try view.prepare(intent: intent, predecessor: parent)
                preparedSourceIntents[intentBytes] = record
            }
        }
        try await queue.retain(record)
        let local = try await localSourceView(record)
        sourceViews[local.document.contentRevision] = local
        await ensureMachineEntered()
        dispatch(.localHead(root: record.candidate.root, origin: .editor))
        if syncActive { syncAgain = true }
        await workingTree.invalidateDocumentViews()
        return local.document
    }

    private func transactionBasis(_ view: CapturedSourceAdmissionBasis, parent: String?) throws -> SourceAdmissionBasis {
        if let accepted = view.accepted { return .accepted(accepted) }
        guard let parent else { throw ArborWireValidationError.invalidValue("Missing transaction predecessor") }
        return .authored(change: parent)
    }

    private func retainSourceTransactions(_ intent: WorkspaceDocumentIntent,
                                          transactions: [WorkspaceSourceTransaction]) async throws -> WorkspaceDocumentSnapshot {
        let queue = try await admissions()
        var records = try await queue.retained()
        var view = try await sourceView(for: intent)
        var parent = try localPredecessor(intent.basis.contentRevision)
        var added: [SourceAdmissionRecord] = []
        for transaction in transactions {
            let existing = records.filter { $0.editorTransactionID == transaction.id && $0.transaction != nil }
            if !existing.isEmpty {
                guard existing.allSatisfy({ $0.transaction == transaction && $0.editorReference?.identity == intent.basis.reference.identity }) else {
                    throw ArborWireValidationError.invalidValue("Editor transaction identity was reused")
                }
                if let last = existing.last { view = try await localSourceView(last, reference: intent.basis.reference); parent = last.change }
                continue
            }
            var targets: [SourceAdmissionRecord] = []
            var causal = !transaction.inverses.isEmpty
            for id in transaction.inverses {
                let group = records.filter { $0.editorTransactionID == id }
                guard group.allSatisfy({ $0.editorReference?.identity == intent.basis.reference.identity }) else {
                    throw ArborWireValidationError.invalidValue("Undo target belongs to another document")
                }
                if group.isEmpty || group.contains(where: { $0.update.operations == nil && $0.creation == nil && $0.graph.root != $0.candidate.root }) { causal = false }
                targets.append(contentsOf: group.reversed())
            }
            let prepared: [SourceAdmissionRecord]
            if causal {
                prepared = try targets.enumerated().map { index, target in
                    try target.inverse(change: transaction.id + "-" + String(index), transaction: transaction)
                }
            } else {
                // Old editor history or a snapshot-only creation has no named
                // effect to invert. Retain the exact displayed edit honestly.
                if !view.document.source.utf8.elementsEqual(transaction.basisSource.utf8),
                   let parent, records.first(where: { $0.change == parent })?.undoOf != nil {
                    try await queue.retain(added)
                    _ = try await syncOnce()
                    let pending = try await pendingSourceRecords()
                    guard !pending.contains(where: { $0.undoOf != nil }) else {
                        throw ArborWireValidationError.invalidValue("Undo retained; awaiting Canopy reconciliation")
                    }
                    let snapshot = try await sourceSnapshot(intent.basis.reference)
                    let patch = WorkspaceDocumentPatch(baseContentRevision: snapshot.contentRevision, edits: [])
                    view = try await sourceView(for: .init(basis: snapshot, patch: patch, source: snapshot.source))
                }
                guard view.document.source.utf8.elementsEqual(transaction.basisSource.utf8) else {
                    throw ArborWireValidationError.invalidValue("Editor transaction needs Canopy reconciliation before further editing")
                }
                let patch = WorkspaceDocumentPatch(baseContentRevision: view.document.contentRevision, edits: transaction.edits)
                let frame = try WorkspaceDocumentIntent(basis: view.document, patch: patch, source: transaction.source)
                prepared = [try SourceAdmissionRecord(change: transaction.id, tree: intent.basis.reference.tree.rawValue,
                    basis: try transactionBasis(view, parent: parent), graph: view.graph,
                    sourcePath: view.sourcePath, intent: frame, transaction: transaction)]
            }
            records.append(contentsOf: prepared); added.append(contentsOf: prepared)
            if let last = prepared.last { view = try await localSourceView(last, reference: intent.basis.reference); parent = last.change }
        }
        try await queue.retain(added)
        sourceViews[view.document.contentRevision] = view
        await ensureMachineEntered()
        dispatch(.localHead(root: view.graph.root, origin: .editor))
        if syncActive { syncAgain = true }
        await workingTree.invalidateDocumentViews()
        if records.contains(where: { record in record.undoOf != nil && transactions.contains(where: { $0.id == record.transaction?.id }) }) {
            // A historical inverse is not a projection of the current tree.
            // Keep the draft until Canopy has reconciled every member of the group.
            _ = try await syncOnce()
            let pending = Set(try await pendingSourceRecords().map(\.change))
            guard !records.contains(where: { record in pending.contains(record.change) && transactions.contains(where: { $0.id == record.transaction?.id }) }) else {
                throw ArborWireValidationError.invalidValue("Undo retained; awaiting Canopy reconciliation")
            }
            return try await sourceSnapshot(intent.basis.reference)
        }
        return view.document
    }

    private func syncSourcePass() async throws -> WorkspaceSyncPresentation {
        guard transportAvailable else { return try await presentation() }
        let queue = try await admissions()
        let attempt: UpdateAttempt
        do {
            if let existing = control.attempt {
                // An earlier write may have failed before fsync. Reestablish
                // durability before treating the in-memory attempt as sendable.
                try files.write(control)
                attempt = existing
            } else {
                guard let pending = try await pendingSourceRecords().first else { return try await presentation() }
                let prepared = try await queue.request(through: pending.change, accepted: Set(control.sourceAcceptedChanges ?? []))
                attempt = try Self.attempt(tree: pending.tree, base: prepared.base, generation: 0, request: prepared.request)
                try faultInjector.reached(.beforeRequestPersistence)
                control.attempt = attempt
                control.sourceAttemptChange = pending.change
                try files.write(control)
                try faultInjector.reached(.afterRequestPersistence)
                notePersisted(attempt)
            }
            notePersisted(attempt)
            if case .offline = machine.phase { dispatch(.transportAvailable(true)) }
            dispatch(.submitStarted(id: attempt.digest))
            try faultInjector.reached(.duringUpload)
            let publicationLog = Logger(subsystem: "org.arbor.native", category: "SourcePublication")
            let started = Date()
            publicationLog.notice("submit begin base=\(attempt.base.update, privacy: .public) updates=\(attempt.allRequestDigests.count) bytes=\(attempt.body.count)")
            let response: WireUpdateResponse
            do {
                response = try await transport.submit(PreparedWireUpdate(tree: attempt.tree, body: attempt.body, requestDigests: attempt.allRequestDigests))
                publicationLog.notice("submit succeeded seconds=\(Date().timeIntervalSince(started)) results=\(response.results.count)")
            } catch {
                publicationLog.error("submit failed seconds=\(Date().timeIntervalSince(started)): \(String(describing: error), privacy: .public)")
                throw error
            }
            try faultInjector.reached(.afterServerAcceptance)
            guard response.results.map(\.requestDigest) == attempt.allRequestDigests,
                  let change = control.sourceAttemptChange,
                  let record = try await queue.retained().first(where: { $0.change == change }),
                  let final = response.results.last else { throw UpdateError.returnedRequestDigestMismatch }
            let accepted: WireAcceptedUpdate
            switch final.result { case let .accepted(value), let .unchanged(value): accepted = try value.validated() }
            guard accepted.tree == attempt.tree else { throw UpdateError.returnedSnapshotMismatch }
            let request = try JSONDecoder().decode(WireUpdateRequest.self, from: attempt.body)
            for result in response.results {
                let update: WireAcceptedUpdate
                switch result.result { case let .accepted(value), let .unchanged(value): update = try value.validated() }
                guard update.tree == attempt.tree else { throw UpdateError.returnedSnapshotMismatch }
            }
            dispatch(.accepted(id: attempt.digest, result: .init(kind: .accepted, root: accepted.root, update: accepted.id,
                                                                cursor: nil, digests: attempt.allRequestDigests, conflicted: accepted.conflicted)))
            try faultInjector.reached(.duringGraphDownload)
            let projected: WireSnapshot
            if let reconciliation = final.reconciliation {
                projected = try WireTransitionReplay.applying(reconciliation, to: record.candidate, root: accepted.root, mode: .sparseFiles)
            } else {
                guard accepted.root == record.candidate.root else { throw UpdateError.returnedSnapshotMissing }
                projected = record.candidate
            }
            // Receipts prove acceptance, not the current observation boundary.
            // Select the current projection before materializing, so replay never
            // briefly installs an older accepted identity over a newer one.
            let current = try await transport.descriptor(tree: attempt.tree)
            guard current.tree.id == attempt.tree, !current.tree.update.isEmpty else { throw UpdateError.returnedSnapshotMismatch }
            let installation: WireSnapshot
            if current.tree.update == accepted.id {
                guard current.tree.root == accepted.root else { throw UpdateError.returnedSnapshotMismatch }
                installation = projected
            } else {
                installation = try await transport.snapshot(tree: attempt.tree, root: current.tree.root)
                guard installation.root == current.tree.root else { throw UpdateError.returnedSnapshotMismatch }
            }
            try faultInjector.reached(.duringMaterialization)
            try await workingTree.replaceFromSystem(SnapshotBridge.replacement(snapshot: installation, tree: await workingTree.treeID(),
                update: current.tree.update, cursor: current.observedThrough, mode: .sparseFiles))
            try faultInjector.reached(.afterMaterialization)
            try faultInjector.reached(.beforeBaseAdvancement)
            control.sourceAcceptedChanges = Array(Set((control.sourceAcceptedChanges ?? []) + request.updates.map(\.change))).sorted()
            control.attempt = nil; control.sourceAttemptChange = nil
            control.acceptedConflicted = current.tree.conflicted
            control.presentation = .init(state: .current, detail: "Applied the server's current snapshot",
                acceptedRoot: installation.root, localRoot: installation.root)
            control.presentation.acceptedConflicted = current.tree.conflicted
            try files.write(control)
            let queueEmpty = try await queue.compact(settled: Set(control.sourceAcceptedChanges ?? []), releasingTransactions: releasedUndoTransactions)
            if queueEmpty {
                control.sourceAcceptedChanges = []
                try files.write(control)
            } else {
                let retained = Set(try await queue.retained().map(\.change))
                control.sourceAcceptedChanges = (control.sourceAcceptedChanges ?? []).filter { retained.contains($0) }
                try files.write(control)
            }
            dispatch(.applied)
            machine.base = .init(root: installation.root, update: current.tree.update,
                cursor: current.observedThrough, conflicted: current.tree.conflicted)
            await workingTree.invalidateDocumentViews()
            syncAgain = try await hasSourceWork()
            return try await presentation()
        } catch {
            // Unsupported/older responses and uncertain outcomes preserve the exact
            // source attempt. They never become a client-owned merge workspace.
            control.presentation.state = .offline
            control.presentation.detail = String(describing: error)
            try? files.write(control)
            dispatch(.transportFailed(id: control.attempt?.digest))
            throw error
        }
    }

    private func requireOpen() throws {
        if terminal { throw UpdateError.closed }
    }
}

// MARK: Accepted-choice review
extension UpdateCoordinator {
    public func inspectChoices() async throws -> ConflictReviewSnapshot {
        try requireOpen()
        let tree = await workingTree.treeID().rawValue
        let current = try await transport.descriptor(tree: tree)
        var snapshot = ConflictReviewSnapshot(tree: tree, state: current.tree.update, root: current.tree.root, decisions: [])
        guard current.tree.conflicted else { return snapshot }
        var after: String?
        var cursors = Set<String>()
        var identities = Set<String>()
        repeat {
            let page = try await transport.conflicts(tree: tree, state: snapshot.state, root: snapshot.root, after: after)
            try page.validateContext(tree: tree, state: snapshot.state, root: snapshot.root)
            guard case let .array(values) = page.fields["decisions"] else { throw ConflictReviewError.unavailable }
            for value in values {
                let decision = try JSONDecoder().decode(ConflictReviewDecision.self, from: JSONEncoder().encode(value))
                guard identities.insert(decision.id).inserted else { throw ConflictReviewError.unavailable }
                snapshot.decisions.append(decision)
            }
            if case let .string(next) = page.fields["next"] {
                guard cursors.insert(next).inserted else { throw ConflictReviewError.unavailable }
                after = next
            } else { after = nil }
        } while after != nil
        return snapshot
    }

    public func reviewDrafts() throws -> [ConflictReviewDraft] { try files.loadReview().drafts }
    public func reviewSubmissionPending() throws -> Bool { try files.loadReview().attempt != nil }

    public func retainReviewDraft(_ draft: ConflictReviewDraft) async throws {
        guard draft.snapshot.tree.utf8.elementsEqual((await workingTree.treeID().rawValue).utf8) else { throw ConflictReviewError.unavailable }
        var journal = try files.loadReview()
        journal.drafts.removeAll { $0.id == draft.id }
        journal.drafts.append(draft)
        try files.writeReview(journal)
    }

    public func discardReviewDraft(_ id: String) throws {
        var journal = try files.loadReview()
        guard journal.attempt?.draft.id != id else { throw ConflictReviewError.publicationPending }
        journal.drafts.removeAll { $0.id == id }
        try files.writeReview(journal)
    }

    public func reviewContent(_ alternative: ConflictReviewAlternative, decision: String, state: String) async throws -> Data? {
        if let text = alternative.value.text { return Data(text.utf8) }
        guard let hash = alternative.value.file else { return nil }
        let bytes = try await transport.conflictObject(tree: workingTree.treeID().rawValue, state: state, conflict: decision, alternative: alternative.id, hash: hash)
        guard WireObjectCodec.hash(bytes) == hash else { throw UpdateError.returnedSnapshotMismatch }
        return bytes
    }

    public func reviewDirectory(_ alternative: ConflictReviewAlternative, decision: String, state: String) async throws -> [WireDirectoryEntry]? {
        guard let hash = alternative.value.directory else { return nil }
        let bytes = try await transport.conflictObject(tree: workingTree.treeID().rawValue, state: state,
            conflict: decision, alternative: alternative.id, hash: hash)
        guard WireObjectCodec.hash(bytes) == hash,
              case let .directory(entries, _) = try WireObjectCodec.decode(bytes, kind: .directory) else {
            throw UpdateError.returnedSnapshotMismatch
        }
        return entries
    }

    /// Freeze and durably retain one explicit guarded candidate. Normal editor
    /// admissions continue against their captured bases; review never installs its
    /// draft as the live document or invents a merge over pending editor work.
    public func applyReviewDraft(_ draft: ConflictReviewDraft) async throws {
        try requireOpen()
        try await retainReviewDraft(draft)
        guard sourceOperationEmission, !syncActive, control.attempt == nil,
              try files.loadReview().attempt == nil else { throw ConflictReviewError.publicationPending }
        let fresh = try await inspectChoices()
        guard draft.isCurrent(in: fresh) else { throw ConflictReviewError.changed }
        let preview = try await prepareReviewPreview(draft, current: fresh)
        // New editor admissions can arrive during material loading.
        guard !(try await hasSourceWork()), !syncActive, control.attempt == nil,
              try files.loadReview().attempt == nil else { throw ConflictReviewError.publicationPending }
        let update = WireCandidateUpdate(candidate: preview.candidate.root, operations: preview.operations,
            resolves: draft.decisions.map { .init(state: draft.snapshot.state, conflict: $0.id, alternatives: $0.alternatives.map(\.id)) },
            objects: preview.candidate.objects)
        let base = WireUpdateBase(root: fresh.root, update: fresh.state)
        let request = WireUpdateRequest(base: base.update, updates: [update])
        let attempt = try Self.attempt(tree: fresh.tree, base: base, generation: 0, request: request)
        var journal = try files.loadReview()
        journal.attempt = .init(draft: draft, request: attempt)
        try files.writeReview(journal)
        _ = try await synchronize(admission: nil)
    }

    public func previewReviewDraft(_ draft: ConflictReviewDraft) async throws -> ConflictReviewPreview {
        try requireOpen()
        let current = try await inspectChoices()
        guard draft.isCurrent(in: current) else { throw ConflictReviewError.changed }
        return try await prepareReviewPreview(draft, current: current)
    }

    private func prepareReviewPreview(_ draft: ConflictReviewDraft, current: ConflictReviewSnapshot) async throws -> ConflictReviewPreview {
        guard draft.obligations.isEmpty else { throw ConflictReviewProposalError(draft.obligations.joined(separator: "\n")) }
        let base = try await transport.snapshot(tree: current.tree, root: current.root)
        var material: [String: Data] = [:]
        let known = Dictionary(uniqueKeysWithValues: base.objects.map { ($0.hash, $0.bytes) })
        for decision in draft.decisions {
            guard let selection = draft.selection(for: decision.id), let alternative = decision.alternatives.first(where: { $0.id == selection.alternative }) else {
                throw ConflictReviewError.unsupported
            }
            var pending: [(String, WireEntryKind)] = []
            if let file = alternative.value.file { pending.append((file, .file)) }
            if let directory = alternative.value.directory { pending.append((directory, .directory)) }
            var visited = Set<String>()
            while let (hash, kind) = pending.popLast() {
                guard visited.insert(hash).inserted else { continue }
                let bytes: Data
                if let retained = material[hash] ?? known[hash] { bytes = retained }
                else {
                    bytes = try await transport.conflictObject(tree: current.tree, state: draft.snapshot.state,
                        conflict: decision.id, alternative: alternative.id, hash: hash)
                }
                guard WireObjectCodec.hash(bytes) == hash else { throw UpdateError.returnedSnapshotMismatch }
                material[hash] = bytes
                if kind == .directory, case let .directory(entries, _) = try WireObjectCodec.decode(bytes, kind: kind) {
                    for entry in entries { if let hash = entry.hash, let kind = entry.kind { pending.append((hash, kind)) } }
                }
            }
        }
        return try ConflictReviewCompiler.compile(draft, base: base, material: material, allDecisions: current.decisions)
    }

    private func syncReviewAttempt(_ retained: ConflictReviewAttempt) async throws -> WorkspaceSyncPresentation {
        guard transportAvailable else { return try await presentation() }
        let attempt = retained.request
        let request = try JSONDecoder().decode(WireUpdateRequest.self, from: attempt.body)
        guard attempt.tree.utf8.elementsEqual((await workingTree.treeID().rawValue).utf8),
              request.base == attempt.base.update, request.updates.count == 1,
              request.updates[0].candidate == attempt.candidate,
              request.updates[0].resolves == retained.draft.decisions.map({
                  WireResolutionDeclaration(state: retained.draft.snapshot.state, conflict: $0.id, alternatives: $0.alternatives.map(\.id))
              }),
              updateRequestDigests(tree: attempt.tree, base: attempt.base, updates: request.updates) == attempt.allRequestDigests else {
            throw ArborWireValidationError.invalidValue("Retained review request does not match its evidence")
        }
        // Reestablish durability if an earlier atomic write returned an uncertain error.
        try files.writeReview(files.loadReview())
        let response: WireUpdateResponse
        do {
            response = try await transport.submit(.init(tree: attempt.tree, body: attempt.body, requestDigests: attempt.allRequestDigests))
        } catch is WireUpdateConflictError {
            // A definite rejection cannot have applied. Preserve the authored
            // draft, retire only this request, and let ordinary publication run.
            var journal = try files.loadReview(); journal.attempt = nil
            try files.writeReview(journal)
            Task { [weak self] in _ = try? await self?.syncOnce() }
            throw ConflictReviewError.changed
        }
        guard response.results.map(\.requestDigest) == attempt.allRequestDigests else {
            throw UpdateError.returnedRequestDigestMismatch
        }
        for result in response.results {
            let accepted: WireAcceptedUpdate
            switch result.result { case let .accepted(value), let .unchanged(value): accepted = try value.validated() }
            guard accepted.tree == attempt.tree else { throw UpdateError.returnedSnapshotMismatch }
        }
        // Exact retries recover lost responses. Install current accepted state
        // through the same coordinator path used by ordinary synchronization.
        let heads = try await workingTree.heads()
        _ = try await pullCurrentSnapshot(treeID: attempt.tree, priorHeads: heads)
        await workingTree.invalidateDocumentViews()
        var journal = try files.loadReview()
        journal.attempt = nil
        // A later edited draft is never retired by an earlier submission.
        let submittedFingerprint = try retained.draft.fingerprint()
        journal.drafts = try journal.drafts.filter { try $0.fingerprint() != submittedFingerprint }
        try files.writeReview(journal)
        syncAgain = try await hasSourceWork()
        return try await presentation()
    }
}
