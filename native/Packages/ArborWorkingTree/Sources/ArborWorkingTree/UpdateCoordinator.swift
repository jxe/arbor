import ArborKit
import ArborWire
import Foundation

/// Effect runner for `UpdateMachine` over a `WorkingTree` and a Wire
/// transport. The working tree holds the node index; `UpdateControl` retains
/// the durable head with its objects, the exact request (with its envelopes),
/// the conflict, the next base, and any hold; the machine owns scheduling:
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

    public init(
        workingTree: WorkingTree,
        transport: any UpdateTransport,
        stateRoot: URL,
        transportAvailable: Bool = true,
        faultInjector: any UpdateFaultInjector = NoUpdateFaults(),
        publicationDelay: Duration = UpdateMachine.publicationDelay,
        publicationMaxDelay: Duration = UpdateMachine.publicationMaxDelay
    ) throws {
        self.workingTree = workingTree
        self.transport = transport
        self.files = try UpdateControlFiles(root: stateRoot)
        self.faultInjector = faultInjector
        self.control = try files.load()
        self.transportAvailable = transportAvailable
        self.machine = UpdateMachine.State(transportAvailable: transportAvailable)
        self.machineOptions = UpdateMachine.Options(publicationDelay: publicationDelay, publicationMaxDelay: publicationMaxDelay)
    }

    /// The machine state, for status and tests.
    public var syncState: UpdateMachine.State { machine }

    // MARK: Machine

    /// Enter the machine from the replica's accepted base and map the retained
    /// durable control onto its phase: a retained attempt is `prepared` (it is
    /// resubmitted exactly), a retained conflict is `conflict`, and unsent
    /// replica generations are one local head.
    private func ensureMachineEntered() async {
        guard case .unplaced = machine.phase else { return }
        guard let heads = try? await workingTree.heads(),
              let root = control.nextBase?.root ?? heads.acceptedRoot,
              let update = control.nextBase?.update ?? heads.acceptedUpdate else { return }
        dispatch(.bootstrapInstalled(root: root, update: update, cursor: heads.acceptedCursor))
        if let conflict = control.conflict {
            machine.phase = .conflict(
                request: UpdateMachine.PreparedRequest(
                    id: "conflict",
                    base: conflict.response.base,
                    candidate: conflict.localRootAtConflict,
                    digests: []
                ),
                conflict: UpdateMachine.ConflictEvidence(
                    current: .init(root: conflict.response.current.root, update: conflict.response.current.id),
                    draft: conflict.response.draft.root,
                    localRoot: conflict.localRootAtConflict,
                    failedIndex: conflict.response.details.failedIndex
                ),
                head: nil
            )
        } else if let attempt = control.attempt {
            machine.phase = .prepared(request: Self.preparedRequest(attempt), head: nil)
        } else if let head = control.head, let attempt = try? recoverAttempt(from: head, tree: await workingTree.treeID().rawValue) {
            // The process stopped between the durable head and its publication:
            // the head's own objects make it a self-contained one-element request.
            machine.phase = .prepared(request: Self.preparedRequest(attempt), head: nil)
        } else if heads.pendingRoot != nil {
            dispatch(.localHead(root: heads.materializedRoot, origin: .editor))
        }
    }

    /// Turn a durable head into the exact attempt it would have become.
    private func recoverAttempt(from head: UpdateHead, tree: String) throws -> UpdateAttempt {
        var objects = head.objects
        for hash in head.spilledObjects ?? [] { objects.append(try files.readObject(hash)) }
        let request = WireUpdateRequest(base: head.base, candidate: head.root, objects: objects)
        let attempt = try Self.attempt(tree: tree, base: head.base, generation: head.generation, request: request, adoptedCount: nil)
        control.attempt = attempt
        control.head = nil
        control.presentation = WorkspaceSyncPresentation(
            state: .requestPending,
            detail: "Recovered the durable head as one request",
            acceptedRoot: head.base.root,
            localRoot: head.root,
            localAdditions: head.root != head.base.root
        )
        try files.write(control)
        files.retainObjects([])
        return attempt
    }

    /// Encode one request as an immutable attempt: its body carries every envelope it will ever send.
    private static func attempt(
        tree: String,
        base: WireUpdateBase,
        generation: Int,
        request: WireUpdateRequest,
        adoptedCount: Int?
    ) throws -> UpdateAttempt {
        guard let last = request.updates.last else { throw UpdateError.adoptedRequestEmpty }
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
            digest: digests.last!,
            adoptedCount: adoptedCount
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
        case .submit, .apply, .catchUp, .surfaceConflict, .stop:
            // Submission, materialization, and catch-up are performed inline by
            // the pass that dispatched the event; they report back with
            // `applied`, `conflicted`, or a failure.
            break
        case .persistConflictResolution:
            // The coordinator persists the reviewed candidate synchronously
            // from its public resolution API before starting another pass.
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
        value.acceptedRoot = control.nextBase?.root ?? heads.acceptedRoot
        value.localRoot = heads.materializedRoot
        if control.conflict != nil { value.state = .conflict }
        else if let hold = control.hold { value.state = .conflict; value.detail = hold.reason }
        else if control.attempt != nil { value.state = .requestPending }
        else if heads.pendingRoot != nil { value.state = .locallyPending }
        return value
    }

    /// The current hold, if any. A `foreignConflict` hold means an adopted
    /// element conflicted: route the user to the authoring tree's review (the
    /// daemon's Sync Status), never to this client's conflict sheet.
    public var submissionHold: UpdateHold? { control.hold }

    /// Pause or resume submission. While held, heads and attempts stay durable
    /// and `presentation` reports `conflict` with `reason`; nothing is sent.
    /// Passing `nil` lifts the hold; call `syncOnce` afterwards to publish.
    public func setSubmissionHold(_ reason: String?) throws {
        try requireOpen()
        control.hold = reason.map { UpdateHold(reason: $0, foreignConflict: false) }
        try files.write(control)
    }

    /// Adopt another working tree's persisted request verbatim as this
    /// client's first in-flight attempt (the dirty-daemon bootstrap). The
    /// caller supplies the elements and every object envelope they need;
    /// digests are recomputed here and must equal `requestDigests`, which
    /// proves the adopted elements are the same intent the author persisted
    /// (digests exclude envelopes, so the adopter may re-pack objects). A later
    /// admission is the retained successor; offline, it is appended once.
    public func adoptInFlight(
        base: WireUpdateBase,
        updates: [WireCandidateUpdate],
        requestDigests: [String],
        objects: [WireObjectEnvelope]
    ) async throws {
        try requireOpen()
        guard control.attempt == nil, control.conflict == nil else { throw UpdateError.adoptionBlocked }
        guard !updates.isEmpty else { throw UpdateError.adoptedRequestEmpty }
        let treeID = (await workingTree.treeID()).rawValue
        var elements = updates
        var carried = Set(elements.flatMap { $0.objects.map(\.hash) })
        for envelope in objects where carried.insert(envelope.hash).inserted {
            elements[0].objects.append(envelope)
        }
        let request = WireUpdateRequest(base: base.update, updates: elements)
        let heads = try await workingTree.heads()
        let attempt = try Self.attempt(tree: treeID, base: base, generation: heads.generation, request: request, adoptedCount: elements.count)
        guard attempt.allRequestDigests == requestDigests else { throw UpdateError.adoptedRequestDigestMismatch }
        control.attempt = attempt
        control.head = nil
        control.presentation = WorkspaceSyncPresentation(
            state: .requestPending,
            detail: "Adopted \(elements.count) durable root intent\(elements.count == 1 ? "" : "s") from the folder",
            acceptedRoot: base.root,
            localRoot: attempt.candidate,
            localAdditions: attempt.candidate != base.root
        )
        try files.write(control)
        files.retainObjects([])
        if case .unplaced = machine.phase {
            await ensureMachineEntered()
        } else {
            notePersisted(attempt)
        }
    }

    public func conflict() throws -> UpdateConflictPresentation? {
        try requireOpen()
        guard let stored = control.conflict else { return nil }
        return UpdateConflictPresentation(
            base: stored.response.base,
            local: stored.localRootAtConflict,
            remote: stored.response.current.root,
            draft: stored.response.draft.root,
            reasons: stored.response.conflicts
        )
    }

    /// Reconstruct the four complete, authoritative graphs needed by the
    /// conflict sheet and expose the actual value at each reported path.
    /// Material is cached with the durable conflict so review remains possible
    /// after a restart or a later loss of connectivity.
    public func conflictWorkspace() async throws -> UpdateConflictWorkspace? {
        try requireOpen()
        guard var stored = control.conflict else { return nil }
        let material: DurableConflictMaterial
        if let retained = stored.material {
            material = retained
        } else {
            guard let attempt = stored.attempt else { throw UpdateError.conflictSnapshotMissing }
            let request = try JSONDecoder().decode(WireUpdateRequest.self, from: attempt.body)
            let index = stored.response.details.failedIndex
            guard request.updates.indices.contains(index) else { throw UpdateError.conflictSnapshotMissing }
            let failed = request.updates[index]
            guard failed.candidate == stored.response.candidate else { throw UpdateError.conflictSnapshotMissing }
            let tree = attempt.tree
            let baseRoot = stored.response.base
            let currentRoot = stored.response.current.root
            async let baseValue = transport.snapshot(tree: tree, root: baseRoot)
            async let currentValue = transport.snapshot(tree: tree, root: currentRoot)
            let (base, current) = try await (baseValue, currentValue)
            guard base.root == baseRoot, current.root == currentRoot else {
                throw UpdateError.conflictSnapshotMissing
            }
            let mine = try WireTransitionReplay.applying(
                WireTransitionPayload(objects: failed.objects, deltas: failed.deltas),
                to: base,
                root: failed.candidate
            )
            let draft = try WireTransitionReplay.applying(
                stored.response.draft.payload,
                to: mine,
                root: stored.response.draft.root
            )
            material = DurableConflictMaterial(base: base, current: current, mine: mine, draft: draft)
            stored.material = material
            control.conflict = stored
            try files.write(control)
        }
        let grouped = Dictionary(grouping: stored.response.conflicts, by: \.path)
        let items = try grouped.keys.sorted { $0.utf8.lexicographicallyPrecedes($1.utf8) }.map { path in
            let base = try ConflictWorkspaceGraph.content(at: path, in: material.base)
            let current = try ConflictWorkspaceGraph.content(at: path, in: material.current)
            let mine = try ConflictWorkspaceGraph.content(at: path, in: material.mine)
            let draft = try ConflictWorkspaceGraph.content(at: path, in: material.draft)
            return UpdateConflictItem(
                path: path,
                reasons: grouped[path, default: []].map(\.reason),
                base: base,
                current: current,
                mine: mine,
                draft: draft,
                offersBoth: draft != current && draft != mine
            )
        }
        let request = try stored.attempt.map { try JSONDecoder().decode(WireUpdateRequest.self, from: $0.body) }
        let suffix = max(0, (request?.updates.count ?? 1) - stored.response.details.failedIndex - 1)
        return UpdateConflictWorkspace(
            identity: stored.attempt?.digest ?? stored.response.candidate,
            items: items,
            unattemptedCount: suffix
        )
    }

    /// Assemble one reviewed failed-element candidate from the server draft,
    /// replacing only the explicitly chosen conflict paths. This deliberately
    /// does not infer a new merge: `both` selects Canopy's own draft value.
    public func resolveConflict(_ resolutions: [String: UpdateConflictResolution]) async throws {
        try requireOpen()
        guard let stored = control.conflict, let attempt = stored.attempt else { throw UpdateError.noConflict }
        guard let workspace = try await conflictWorkspace(),
              workspace.identity == attempt.digest,
              let retained = control.conflict,
              retained.attempt?.digest == attempt.digest,
              let material = retained.material else { throw UpdateError.noConflict }
        guard workspace.unattemptedCount == 0 else { throw UpdateError.conflictSequenceRequiresReview }
        let paths = workspace.items.map(\.path)
        guard Set(resolutions.keys) == Set(paths) else { throw UpdateError.conflictResolutionIncomplete }
        for lhs in paths {
            for rhs in paths where lhs != rhs {
                let prefix = lhs == "/" ? "/" : lhs + "/"
                if rhs.hasPrefix(prefix) { throw UpdateError.conflictPathOverlap }
            }
        }
        var candidate = material.draft
        for item in workspace.items {
            guard let resolution = resolutions[item.path] else { throw UpdateError.conflictResolutionIncomplete }
            switch resolution {
            case .current:
                candidate = try ConflictWorkspaceGraph.replacing(path: item.path, in: candidate, with: material.current)
            case .mine:
                candidate = try ConflictWorkspaceGraph.replacing(path: item.path, in: candidate, with: material.mine)
            case .both:
                guard item.offersBoth else { throw UpdateError.conflictResolutionIncomplete }
                // The draft is already the destination and therefore already
                // carries Canopy's explicit combined value for this path.
                break
            case let .edit(source):
                guard item.draft.editableText != nil || item.mine.editableText != nil || item.current.editableText != nil else {
                    throw UpdateError.conflictContentIsNotEditable
                }
                candidate = try ConflictWorkspaceGraph.replacingText(path: item.path, in: candidate, with: source)
            }
        }
        _ = try WireObjectGraph.validate(candidate)
        let descriptor = try await transport.descriptor(tree: attempt.tree).validated(expectedTree: attempt.tree)
        guard descriptor.tree.root == retained.response.current.root,
              descriptor.tree.update == retained.response.current.id else { throw UpdateError.localWorkAdvanced }
        let heads = try await workingTree.heads()
        guard heads.materializedRoot == retained.localRootAtConflict else { throw UpdateError.localWorkAdvanced }

        dispatch(.resolveConflict(.draft))
        do {
            let replacement = try SnapshotBridge.replacement(
                snapshot: candidate,
                tree: await workingTree.treeID(),
                update: descriptor.tree.update,
                cursor: descriptor.observedThrough
            )
            try await workingTree.replacePendingFromSystem(
                replacement,
                acceptedRoot: descriptor.tree.root,
                acceptedUpdate: descriptor.tree.update,
                acceptedCursor: descriptor.observedThrough
            )
            control.nextBase = WireUpdateBase(root: descriptor.tree.root, update: descriptor.tree.update)
            control.conflict = nil
            control.presentation = WorkspaceSyncPresentation(
                state: .locallyPending,
                detail: "Reviewed conflict choices are durable as a new root intent",
                acceptedRoot: descriptor.tree.root,
                localRoot: candidate.root,
                localAdditions: candidate.root != descriptor.tree.root,
                remoteAdditions: true
            )
            try files.write(control)
        } catch {
            dispatch(.conflictResolutionFailed)
            throw error
        }
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
        if control.attempt != nil || heads.pendingRoot != nil || control.nextBase != nil {
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
        if event.id == heads.acceptedCursor { return try await presentation() }
        if let requestDigest = event.requestDigest,
           control.attempt?.allRequestDigests.contains(requestDigest) == true {
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
        priorHeads heads: WorkingTreeHeads
    ) async throws -> WorkspaceSyncPresentation {
        guard let final = event.transitions.last,
              final.update.id == event.tree.update,
              final.update.root == event.tree.root else {
            throw ArborWireValidationError.invalidValue("Watch transition batch does not match its descriptor")
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
                filesByHash: try await workingTree.sparseFileMetadataByHash()
            )
            try await workingTree.replaceFromSystem(replacement)
        }
        control.head = nil
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

    private func currentHead() -> UpdateMachine.LocalHead {
        if case let .locallyPending(head, _) = machine.phase { return head }
        return UpdateMachine.LocalHead(root: latestAdmission?.candidateRoot ?? "", origin: .editor)
    }

    /**
     * Nonblocking handoff for one just-durable patch admission. The admission is
     * already durable in WorkingTree; the machine coalesces it with any other
     * unsent generation behind one trailing publication delay, retains it as the
     * single successor of a request in flight, and leaves it in the replica
     * while the transport is unavailable so reconnection appends the latest
     * head once to any ambiguous prefix.
     */
    public func syncImmediately(_ admission: WorkingTreePatchAdmission) async {
        latestAdmission = admission
        await ensureMachineEntered()
        // The head is durable with its objects before the machine learns of it
        // (rule 1): a process that stops before the publication delay recovers
        // it as one request instead of losing the edit.
        if control.conflict == nil { try? await persistHead(root: admission.candidateRoot) }
        dispatch(.localHead(root: admission.candidateRoot, origin: .editor))
    }

    private func persistHead(root: String) async throws {
        let heads = try await workingTree.heads()
        guard heads.materializedRoot == root, heads.pendingRoot != nil else { return }
        let base = try currentBase(heads: heads)
        var envelopes = try await candidateObjects(base: base.root).objects
        guard control.head?.root != root || control.head?.base != base else { return }
        var spilled: [String] = []
        if envelopes.reduce(0, { $0 + $1.bytes.count }) > UpdateHead.inlineByteCap {
            for envelope in envelopes.sorted(by: { $0.bytes.count > $1.bytes.count }) {
                try files.writeObject(envelope)
                spilled.append(envelope.hash)
            }
            envelopes.removeAll { spilled.contains($0.hash) }
        }
        control.head = UpdateHead(
            base: base,
            root: root,
            generation: heads.generation,
            objects: envelopes,
            spilledObjects: spilled.isEmpty ? nil : spilled
        )
        try files.write(control)
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
        if syncActive, control.attempt != nil {
            do {
                let attempt = try await extendAttemptToCurrent()
                _ = try await submit(attempt)
            } catch {
                // The durable prefix and latest replica head remain retryable.
            }
            return
        }
        let heads = try? await workingTree.heads()
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
                if heads.pendingRoot == nil || control.conflict != nil { syncAgain = false }
                else { syncAgain = true }
            }
        } while syncAgain
        return result
    }

    private func syncPass(
        admission: WorkingTreePatchAdmission?,
        extendExistingAttempt: Bool = false
    ) async throws -> WorkspaceSyncPresentation {
        guard control.conflict == nil, control.hold == nil else { return try await presentation() }
        if control.attempt == nil, control.nextBase == nil, try await workingTree.heads().pendingRoot == nil {
            // A head equal to the accepted base needs no request (rule 11).
            return try await presentation()
        }
        let attempt: UpdateAttempt
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
            return try await recordConflict(try error.conflict.validated(), attempt: attempt, retained: attempt)
        } catch let error as WireHTTPError where error.status == 401 || error.status == 403 {
            control.presentation.state = error.code == "device-revoked" ? .revoked : .authenticationFailure
            control.presentation.detail = error.message ?? error.code
            try files.write(control)
            dispatch(.authenticationFailed(reason: error.code))
            return control.presentation
        } catch {
            if error is UpdateError || error is ArborWireValidationError {
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

    /// Persist a conflict response. An element inside an adopted prefix is
    /// owned by the working tree that authored it: hold and defer to its
    /// review flow instead of opening this client's sheet (rule 8). Otherwise
    /// the conflict is retained with the exact attempt for review here.
    private func recordConflict(
        _ validated: WireUpdateConflict,
        attempt: UpdateAttempt,
        retained: UpdateAttempt
    ) async throws -> WorkspaceSyncPresentation {
        if validated.details.failedIndex < retained.adoptedElementCount {
            control.hold = UpdateHold(
                reason: "The folder's change conflicts; review it in Sync Status.",
                foreignConflict: true
            )
            control.presentation = WorkspaceSyncPresentation(
                state: .conflict,
                detail: control.hold?.reason,
                acceptedRoot: validated.current.root,
                localRoot: retained.candidate,
                localAdditions: true,
                remoteAdditions: true
            )
            try files.write(control)
            noteConflict(validated, attempt: attempt)
            return control.presentation
        }
        control.conflict = UpdateConflictRecord(
            response: validated,
            localRootAtConflict: retained.candidate,
            attempt: retained
        )
        control.attempt = nil
        control.presentation = WorkspaceSyncPresentation(
            state: .conflict,
            detail: validated.conflicts.map { "\($0.path): \($0.reason)" }.joined(separator: ", "),
            acceptedRoot: validated.current.root,
            localRoot: retained.candidate,
            localAdditions: true,
            remoteAdditions: true
        )
        try files.write(control)
        noteConflict(validated, attempt: attempt)
        // The conflict response arrived over a live transport, so retain its
        // review material now when possible. Failure leaves the exact durable
        // conflict intact and the sheet can retry later.
        _ = try? await conflictWorkspace()
        return control.presentation
    }

    private func noteConflict(_ validated: WireUpdateConflict, attempt: UpdateAttempt) {
        dispatch(.conflicted(
            id: attempt.digest,
            conflict: UpdateMachine.ConflictEvidence(
                current: .init(root: validated.current.root, update: validated.current.id),
                draft: validated.draft.root,
                localRoot: attempt.candidate,
                failedIndex: validated.details.failedIndex
            )
        ))
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
        } catch let error as WireUpdateConflictError {
            guard control.attempt?.allRequestDigests.starts(with: attempt.allRequestDigests) == true else {
                return try await presentation()
            }
            return try await recordConflict(try error.conflict.validated(), attempt: attempt, retained: control.attempt ?? attempt)
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
        guard let conflict = control.conflict else { throw UpdateError.noConflict }
        if let attempt = conflict.attempt,
           let request = try? JSONDecoder().decode(WireUpdateRequest.self, from: attempt.body),
           request.updates.count > conflict.response.details.failedIndex + 1 {
            throw UpdateError.conflictSequenceRequiresReview
        }
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
        let attempt = try Self.attempt(tree: treeID, base: base, generation: heads.generation, request: request, adoptedCount: nil)
        try faultInjector.reached(.beforeRequestPersistence)
        control.attempt = attempt
        control.head = nil
        control.presentation = WorkspaceSyncPresentation(
            state: .requestPending,
            acceptedRoot: base.root,
            localRoot: candidate.root,
            localAdditions: candidate.root != base.root
        )
        try files.write(control)
        files.retainObjects([])
        try faultInjector.reached(.afterRequestPersistence)
        notePersisted(attempt)
        return attempt
    }

    /// Record the persisted request in the machine, entering `locally-pending` first if the pass started it.
    private func notePersisted(_ attempt: UpdateAttempt) {
        switch machine.phase {
        case .current, .prepared, .submitting, .submittingPending, .acceptedPendingApply, .conflict:
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
            request: request,
            adoptedCount: existing.adoptedCount
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

    private func apply(_ response: WireUpdateResponse, for attempt: UpdateAttempt) async throws {
        guard response.results.map(\.requestDigest) == attempt.allRequestDigests,
              let final = response.results.last else {
            throw UpdateError.returnedRequestDigestMismatch
        }
        guard control.attempt?.digest == attempt.digest else { return }
        let accepted: WireAcceptedUpdate
        let merge: WireMergeSummary?
        let outcome: UpdateMachine.AuthorityResult.Kind
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
                setAppliedPresentation(accepted: accepted, merge: merge)
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
                setAppliedPresentation(accepted: accepted, merge: merge)
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
            try await workingTree.recordAccepted(root: accepted.root, update: accepted.id, cursor: accepted.id)
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
                cursor: accepted.id,
                filesByHash: try await workingTree.sparseFileMetadataByHash()
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
        setAppliedPresentation(accepted: accepted, merge: merge)
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
            guard case let .directory(entries, _) = try WireObjectCodec.decode(bytes) else { continue }
            // An entry's kind is unknown until its object is seen; peek the
            // overlay-held prefix rather than fetching a file to learn it is one.
            for entry in entries {
                guard let hash = entry.hash else { continue }
                let kind = try? await workingTree.objectKind(hash: hash)
                pending.append((hash, kind == .directory))
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
        if terminal { throw UpdateError.closed }
    }
}
