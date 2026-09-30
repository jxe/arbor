import CanopyAppKit
import Overstory
import OverstoryObjectStore
import Foundation
import OSLog

/// The runner for `UpdateMachine` over a `WorkingTree`, its `ChangeLog`, and
/// an Overstory transport. The machine decides; the coordinator performs.
///
/// Every source (an editor, a structural action, a review resolution) appends
/// a `LocalChange` to the change log and then tells the machine its tip. The
/// coordinator turns I/O results into events and executes every effect the
/// machine returns, one at a time, in order. It never writes the machine's
/// phase and keeps no flag that decides what happens next; the state it keeps
/// is what an effect needs to be performed: the exact persisted request, the
/// response an `apply` installs, the watch batch a `catchUp` replays.
///
/// Every request body is cut from the change log's records, which carry only
/// the objects their basis does not retain. Resubmission reads envelopes only
/// from the persisted attempt, never from a live object store.
public actor UpdateCoordinator {
    static let syncLog = Logger(subsystem: "org.arbor.native", category: "Sync")
    static let changeLogLog = Logger(subsystem: "org.arbor.native", category: "ChangeLog")
    static let publicationLog = Logger(subsystem: "org.arbor.native", category: "Publication")

    let workingTree: WorkingTree
    let transport: any UpdateTransport
    let platformObjectStore: (any ObjectStore)?
    let files: UpdateControlFiles
    private let faultInjector: any UpdateFaultInjector
    private let options: UpdateMachine.Options
    var control: UpdateControl
    private var machine: UpdateMachine.State
    private var closed = false

    /// Work queued for the effect worker, performed strictly in order.
    private enum Work: Sendable {
        case effect(UpdateMachine.Effect)
        /// Persist an observation cursor the machine advanced without an install.
        case recordCursor(UpdateMachine.AcceptedBase)
    }
    private var queue: [Work] = []
    private var worker: Task<Void, Never>?
    /// Submissions on the network. A submission never blocks the worker: a
    /// hanging attempt must not stop its own ambiguous extension or a catch-up.
    private var submissions: [String: Task<Void, Never>] = [:]
    /// A watch can acknowledge a request before its POST returns. Leave its
    /// apply off the worker until that submission supplies the response (or
    /// fails, in which case apply retrieves the durable receipts).
    private var deferredApply: (digest: String, result: UpdateMachine.AuthorityResult)?
    private var idleWaiters: [CheckedContinuation<Void, Never>] = []
    private var timers: [UpdateMachine.Timer: Task<Void, Never>] = [:]
    private var timerTokens: [UpdateMachine.Timer: UUID] = [:]
    /// Whether the tree's watch stream is open; while it is, a clean tree
    /// skips its freshness poll (the TypeScript coordinator's `setWatching`).
    private var watching = false

    /// The validated response of the persisted attempt, kept for the `apply` it leads to.
    private var submission: (digest: String, response: ProtocolUpdateResponse, current: CurrentHead)?
    /// The latest watch event, kept for the `catchUp` its cursor names.
    private var watchEvent: ProtocolWatchEvent?
    /// The last failure, for presentation.
    private var failure: String?
    private var activeSources = Set<String>()

    public func sourceActivity(id: String, pending: Bool) async {
        guard !closed else { return }
        await ensureEntered()
        let wasActive = !activeSources.isEmpty
        if pending { activeSources.insert(id) } else { activeSources.remove(id) }
        if wasActive != !activeSources.isEmpty { dispatch(.sourceActivity(pending: !activeSources.isEmpty)) }
    }

    // Local-change state, used by UpdateCoordinator+LocalChanges.
    var log: ChangeLog?
    var sourceViews: [String: CapturedSourceBasis] = [:]
    var appendTail: Task<Void, Never>?
    var preparedStructures: [Data: (record: LocalChange, node: WorkspaceNode)] = [:]
    var preparedSourceIntents: [Data: LocalChange] = [:]
    var localView: (key: LocalViewKey, tree: WorkingTree)?
    /// The conflict-review journal as last read or written by this coordinator,
    /// its only writer; nil until first read or after an uncertain write.
    var reviewJournal: ConflictReviewJournal?

    struct CurrentHead: Sendable {
        var update: String
        var root: String
        var conflicted: Bool
        var observedThrough: String
    }

    public init(
        workingTree: WorkingTree,
        transport: any UpdateTransport,
        stateRoot: URL,
        transportAvailable: Bool = true,
        platformObjectStore: (any ObjectStore)? = nil,
        faultInjector: any UpdateFaultInjector = NoUpdateFaults(),
        publicationDelay: Duration = UpdateMachine.publicationDelay,
        publicationMaxDelay: Duration? = UpdateMachine.publicationMaxDelay,
        pollInterval: Duration? = nil
    ) throws {
        self.workingTree = workingTree
        self.transport = transport
        self.platformObjectStore = platformObjectStore
        self.files = try UpdateControlFiles(root: stateRoot)
        self.faultInjector = faultInjector
        self.control = try files.load()
        // An incompatible or altered durable request must remain on disk for recovery.
        if let attempt = control.attempt {
            let request = try attempt.request()
            let retainedControl = control
            guard request.base == attempt.base.update,
                  request.updates.last?.candidate == attempt.candidate,
                  (request.updates.last?.change == retainedControl.attemptTip || retainedControl.publications.contains { $0.update.change == request.updates.last?.change && $0.changes.last == retainedControl.attemptTip }),
                  attempt.digest == attempt.allRequestDigests.last,
                  updateRequestDigests(tree: attempt.tree, base: attempt.base, updates: request.updates) == attempt.allRequestDigests else {
                throw ProtocolValidationError.invalidValue("Durable update intent does not match its digests")
            }
        }
        // Older clients mistook an unrecognized HTTP response (for example a
        // gateway's 404) for a definitive host refusal. Keep the validated
        // request and every later change; recover it through normal resubmission.
        if control.attempt != nil, control.held?.reason == .rejected, control.held?.detail == "http-error" {
            control.held = nil
            try files.write(control, phase: "recover-ambiguous-http")
        }
        self.machine = UpdateMachine.State(transportAvailable: transportAvailable)
        self.options = UpdateMachine.Options(publicationDelay: publicationDelay, publicationMaxDelay: publicationMaxDelay, pollInterval: pollInterval)
    }

    /// The machine state, for status and tests.
    public var syncState: UpdateMachine.State { machine }

    // MARK: Entry

    /// Enter the machine from the working tree's accepted base, then recover a
    /// retained request and the change log's tip through ordinary events.
    func ensureEntered() async {
        guard case .unplaced = machine.phase, !closed else { return }
        guard let heads = try? await workingTree.heads(),
              let root = heads.acceptedRoot,
              let update = heads.acceptedUpdate else { return }
        guard case .unplaced = machine.phase else { return }
        dispatch(.bootstrapInstalled(root: root, update: update, cursor: heads.acceptedCursor, conflicted: control.acceptedConflicted))
        if let attempt = control.attempt {
            dispatch(.recovered(request: preparedRequest(attempt), held: control.held?.reason, detail: control.held?.detail))
        }
        await publishTip()
    }

    /// Encode one request as an immutable attempt: its body carries every
    /// envelope it will ever send, in CBOR (tree operations §4.4).
    static func attempt(tree: String, base: ProtocolUpdateBase, request: ProtocolUpdateRequest) throws -> UpdateAttempt {
        guard let last = request.updates.last else { throw UpdateError.requestEmpty }
        let digests = updateRequestDigests(tree: tree, base: base, updates: request.updates)
        let encoding = ProtocolWireEncoding.cbor
        return UpdateAttempt(
            tree: tree,
            base: base,
            candidate: last.candidate,
            generation: 0,
            body: try encoding.encode(request),
            contentType: encoding.storedContentType,
            requestDigests: digests,
            digest: digests.last!
        )
    }

    private func preparedRequest(_ attempt: UpdateAttempt) -> UpdateMachine.PreparedRequest {
        .init(id: attempt.digest, base: attempt.base.update, candidate: attempt.candidate,
              tip: control.attemptTip ?? "", digests: attempt.allRequestDigests)
    }

    /// Tell the machine the change log's publishable tip: the newest change of
    /// the oldest unsettled authored chain. Retelling a tip it already knows
    /// would only restart its delay.
    func publishTip() async {
        if case .unplaced = machine.phase { return }
        do {
            guard let tip = try await changeLog().nextPublication(accepted: Set(control.settled)) else { return }
            if machine.phase.tip?.change == tip.change { return }
            if machine.phase.tip == nil, machine.phase.request?.tip == tip.change { return }
            let requiresAcceptance = try await changeLog().retained().contains {
                !control.settled.contains($0.change) &&
                ($0.update.trace != nil || !$0.update.resolves.isEmpty || $0.update.ifCurrent != nil)
            }
            dispatch(.localChange(change: tip.change, root: tip.candidate.root, settleIfUnchanged: !requiresAcceptance))
        } catch {
            Self.syncLog.error("change log unreadable: \(String(describing: error), privacy: .public)")
            failure = String(describing: error)
        }
    }

    // MARK: Dispatch

    private func dispatch(_ event: UpdateMachine.Event) {
        let before = machine
        let (next, effects) = UpdateMachine.reduce(machine, event, options: options)
        machine = next
        if case .current = before.phase, case .current = next.phase, let base = next.base,
           base.cursor != before.base?.cursor, base.root == before.base?.root, base.update == before.base?.update {
            queue.append(.recordCursor(base))
        }
        for effect in effects {
            switch effect {
            case let .schedule(timer, delay): schedule(timer, after: delay)
            case .cancelTimers:
                for timer in [UpdateMachine.Timer.trailing, .max] { timers.removeValue(forKey: timer)?.cancel(); timerTokens[timer] = nil }
            default: queue.append(.effect(effect))
            }
        }
        startWorker()
    }

    private func schedule(_ timer: UpdateMachine.Timer, after delay: Duration) {
        timers.removeValue(forKey: timer)?.cancel()
        let token = UUID()
        timerTokens[timer] = token
        timers[timer] = Task { [weak self] in
            do { try await Task.sleep(for: delay) } catch { return }
            await self?.timerFired(timer, delay: delay, token: token)
        }
    }

    private func timerFired(_ timer: UpdateMachine.Timer, delay: Duration, token: UUID) {
        guard timerTokens[timer] == token, !closed else { return }
        timerTokens[timer] = nil
        timers[timer] = nil
        // A clean tree whose watch is open learns of updates from it; the poll
        // is only for a watch that is down (a dead one fails its idle timeout).
        if timer == .poll, watching, case .current = machine.phase {
            schedule(.poll, after: delay)
            return
        }
        switch timer {
        case .trailing: dispatch(.publishDelayElapsed)
        case .max: dispatch(.maxDelayElapsed)
        case .poll: dispatch(.pollElapsed)
        }
    }

    private func startWorker() {
        guard worker == nil else { return }
        guard !queue.isEmpty, !closed else {
            if submissions.isEmpty { resumeIdleWaiters() }
            return
        }
        worker = Task { [weak self] in await self?.drain() }
    }

    private func drain() async {
        while !queue.isEmpty, !closed {
            switch queue.removeFirst() {
            case let .effect(effect): await perform(effect)
            case let .recordCursor(base):
                do { try await workingTree.recordAccepted(root: base.root, update: base.update, cursor: base.cursor) }
                catch { Self.syncLog.error("cursor not recorded: \(String(describing: error), privacy: .public)") }
            }
        }
        worker = nil
        if submissions.isEmpty { resumeIdleWaiters() }
    }

    private func resumeIdleWaiters() {
        let waiters = idleWaiters
        idleWaiters = []
        for waiter in waiters { waiter.resume() }
    }

    /// Wait until every queued effect has been performed and no submission is on the network.
    func settle() async {
        guard worker != nil || !queue.isEmpty || !submissions.isEmpty else { return }
        await withCheckedContinuation { idleWaiters.append($0) }
    }

    // MARK: Effects

    private func perform(_ effect: UpdateMachine.Effect) async {
        switch effect {
        case let .persistRequest(_, tip):
            await persistRequest(tip: tip)
        case let .submit(request):
            guard submissions[request.id] == nil else { return }
            submissions[request.id] = Task { [weak self] in
                await self?.submit(request)
                await self?.submissionFinished(request.id)
            }
        case let .apply(result):
            await apply(result)
        case let .catchUp(cursor):
            await catchUp(cursor: cursor)
        case let .settle(tip):
            await settleLocally(through: tip)
        case let .stop(reason):
            failure = reason
            for timer in timers.values { timer.cancel() }
            timers = [:]
        case .schedule, .cancelTimers:
            break
        }
    }

    private func persistRequest(tip: UpdateMachine.LocalTip) async {
        if let existing = control.attempt {
            // A retained request is resubmitted exactly; it is never re-cut from the log.
            dispatch(.requestPersisted(preparedRequest(existing)))
            return
        }
        do {
            var prepared = try await changeLog().request(through: tip.change, accepted: Set(control.settled))
            prepared.request = try await composePublication(in: prepared.request)
            let attempt = try Self.attempt(tree: await workingTree.treeID().rawValue, base: prepared.base, request: prepared.request)
            try faultInjector.reached(.beforeRequestPersistence)
            control.attempt = attempt
            control.attemptTip = tip.change
            try writeControl()
            try faultInjector.reached(.afterRequestPersistence)
            failure = nil
            dispatch(.requestPersisted(preparedRequest(attempt)))
        } catch {
            fail(error, id: nil)
        }
    }

    private func submissionFinished(_ id: String) {
        submissions[id] = nil
        if let deferred = deferredApply, deferred.digest == id {
            deferredApply = nil
            if !closed, control.attempt?.digest == id,
               case let .acceptedPendingApply(_, request, _) = machine.phase, request?.id == id {
                queue.append(.effect(.apply(deferred.result)))
            }
        }
        startWorker()
    }

    private func submit(_ request: UpdateMachine.PreparedRequest) async {
        guard let attempt = control.attempt, attempt.digest == request.id else { return }
        do {
            // An earlier write may have failed before fsync. Reestablish
            // durability before treating the in-memory attempt as sendable.
            try writeControl()
            dispatch(.submitStarted(id: attempt.digest))
            try faultInjector.reached(.duringUpload)
            let started = Date()
            Self.publicationLog.notice("submit begin base=\(attempt.base.update, privacy: .public) updates=\(attempt.allRequestDigests.count) bytes=\(attempt.body.count)")
            let response = try await transport.submit(attempt.prepared)
            Self.publicationLog.notice("submit succeeded seconds=\(Date().timeIntervalSince(started)) results=\(response.results.count)")
            try faultInjector.reached(.afterServerAcceptance)
            let current = try await validate(response, for: attempt)
            submission = (attempt.digest, response, current)
            failure = nil
            dispatch(.accepted(id: attempt.digest, result: .init(kind: .accepted, root: current.root, update: current.update,
                cursor: current.observedThrough, digests: attempt.allRequestDigests, conflicted: current.conflicted)))
        } catch {
            Self.publicationLog.error("submit failed: \(String(describing: error), privacy: .public)")
            fail(error, id: attempt.digest)
        }
    }

    /// Check that `response` answers `attempt` exactly and select the host's
    /// current head to install, the head the response reports. Receipts prove
    /// acceptance, not the current observation boundary.
    private func validate(_ response: ProtocolUpdateResponse, for attempt: UpdateAttempt) async throws -> CurrentHead {
        guard response.results.map(\.requestDigest) == attempt.allRequestDigests else { throw UpdateError.returnedRequestDigestMismatch }
        for result in response.results {
            let update: ProtocolAcceptedUpdate
            switch result.result { case let .accepted(value), let .unchanged(value): update = try value.validated() }
            guard update.tree == attempt.tree else { throw UpdateError.returnedSnapshotMismatch }
        }
        let head = response.head
        let current = CurrentHead(update: head.update, root: head.root, conflicted: head.conflicted, observedThrough: head.observedThrough)
        guard !current.update.isEmpty else { throw UpdateError.returnedSnapshotMismatch }
        return current
    }

    /// Install an accepted decision for the persisted attempt, settle the
    /// changes it carried, and report the installed state.
    private func apply(_ result: UpdateMachine.AuthorityResult) async {
        guard let attempt = control.attempt else {
            // A previous pass already applied and cleared this attempt.
            dispatch(.applied(installed: nil))
            return
        }
        do {
            var stashed = submission.flatMap { $0.digest == attempt.digest ? $0 : nil }
            if stashed == nil, submissions[attempt.digest] != nil {
                deferredApply = (attempt.digest, result)
                return
            }
            if stashed == nil {
                // Watch evidence or a restart: replaying the exact durable
                // request obtains the host's stored response.
                let response = try await transport.submit(attempt.prepared)
                stashed = (attempt.digest, response, try await validate(response, for: attempt))
            }
            guard let (_, response, current) = stashed, let final = response.results.last else { throw UpdateError.returnedSnapshotMissing }
            let accepted: ProtocolAcceptedUpdate
            switch final.result { case let .accepted(value), let .unchanged(value): accepted = try value.validated() }
            try faultInjector.reached(.duringGraphDownload)
            // The projection of our own candidate, while the log still holds it.
            // A re-seeded tree no longer does and installs the host's state instead.
            var projected: ProtocolSnapshot?
            if let record = try await changeLog().retained().first(where: { $0.change == control.attemptTip }),
               record.candidate.root == attempt.candidate,
               current.update == accepted.id, current.root == accepted.root {
                if let reconciliation = final.reconciliation {
                    // The candidate's spine plus every delta base, fetched through the object store once each.
                    var basis = record.candidate
                    let present = Set(basis.objects.map(\.hash))
                    for hash in Set(reconciliation.deltas.map(\.base)).subtracting(present).sorted() {
                        basis.objects.append(ProtocolObjectEnvelope(hash: hash, bytes: try await workingTree.objectBytes(hash: hash)))
                    }
                    projected = try ProtocolTransitionReplay.applying(reconciliation, to: basis, root: accepted.root, mode: .sparseFiles)
                } else if accepted.root == record.candidate.root {
                    projected = record.candidate
                }
            }
            let installed = try await install(current: current, projection: projected)
            try faultInjector.reached(.beforeBaseAdvancement)
            let request = try attempt.request()
            control.settled = Array(Set(control.settled + localChanges(in: request))).sorted()
            control.attempt = nil
            control.attemptTip = nil
            control.held = nil
            control.acceptedConflicted = current.conflicted
            try writeControl()
            submission = nil
            try await compactLog()
            try retireSubmittedReviews(Set(request.updates.map(\.change)))
            await workingTree.invalidateDocumentViews()
            await publishTip()
            dispatch(.applied(installed: installed))
        } catch {
            fail(error, id: attempt.digest)
        }
    }

    /// Install the host's current state: `projection` when it is exactly that
    /// state, otherwise the sparse graph walked from the current root, or a
    /// snapshot when an object read is unavailable.
    private func install(current: CurrentHead, projection: ProtocolSnapshot?) async throws -> UpdateMachine.AcceptedBase {
        let heads = try await workingTree.heads()
        let installed = UpdateMachine.AcceptedBase(root: current.root, update: current.update, cursor: current.observedThrough, conflicted: current.conflicted)
        if heads.materializedRoot == current.root, heads.acceptedRoot == current.root {
            // Already installed: record only new identity or observation progress.
            if heads.acceptedUpdate != current.update || heads.acceptedCursor != current.observedThrough {
                try await workingTree.recordAccepted(root: current.root, update: current.update, cursor: current.observedThrough)
            }
            return installed
        }
        let tree = await workingTree.treeID().rawValue
        let snapshot: ProtocolSnapshot
        if let projection { snapshot = projection }
        else if let sparse = try? await sparseDirectoryGraph(treeID: tree, root: current.root) { snapshot = sparse }
        else { snapshot = try await transport.snapshot(tree: tree, root: current.root) }
        guard snapshot.root == current.root else { throw UpdateError.returnedSnapshotMismatch }
        try faultInjector.reached(.duringMaterialization)
        try await workingTree.replaceFromSystem(SnapshotBridge.replacement(snapshot: snapshot, tree: await workingTree.treeID(),
            update: current.update, cursor: current.observedThrough, mode: .sparseFiles))
        try faultInjector.reached(.afterMaterialization)
        return installed
    }

    /// Clean catch-up: replay the watch transition the cursor names when it chains
    /// from the installed state, otherwise install the host's current state.
    private func catchUp(cursor: String?) async {
        do {
            let installed: UpdateMachine.AcceptedBase
            if let cursor, let event = watchEvent, event.id == cursor,
               let replayed = try? await applyAcceptedTransitions(event) {
                installed = replayed
            } else {
                let tree = await workingTree.treeID().rawValue
                let descriptor = try await transport.descriptor(tree: tree)
                guard descriptor.tree.id == tree, !descriptor.tree.update.isEmpty else { throw UpdateError.replicaIsNotPlaced }
                installed = try await install(current: .init(update: descriptor.tree.update, root: descriptor.tree.root,
                    conflicted: descriptor.tree.conflicted, observedThrough: descriptor.observedThrough), projection: nil)
            }
            watchEvent = nil
            control.acceptedConflicted = installed.conflicted
            try writeControl()
            failure = nil
            await workingTree.invalidateDocumentViews()
            dispatch(.applied(installed: installed))
        } catch {
            fail(error, id: nil)
        }
    }

    private func applyAcceptedTransitions(_ event: ProtocolWatchEvent) async throws -> UpdateMachine.AcceptedBase {
        let update = try await workingTree.applyAcceptedTransitions(event)
        return .init(root: update.root, update: update.id, cursor: event.id, conflicted: update.conflicted)
    }

    /// The chain through `tip` reproduces the accepted root: settle it without a request.
    private func settleLocally(through tip: UpdateMachine.LocalTip) async {
        do {
            let records = try await changeLog().retained()
            let byChange = Dictionary(uniqueKeysWithValues: records.map { ($0.change, $0) })
            var chain: [String] = [], current: String? = tip.change
            while let change = current, let record = byChange[change], !control.settled.contains(change) {
                chain.append(change)
                if case let .authored(parent) = record.basis { current = parent } else { current = nil }
            }
            control.settled = Array(Set(control.settled + chain)).sorted()
            try writeControl()
            try await compactLog()
            await workingTree.invalidateDocumentViews()
            await publishTip()
        } catch {
            fail(error, id: nil)
        }
    }

    /// Drop settled records no pending change or open editor still needs.
    private func compactLog() async throws {
        let log = try await changeLog()
        if try await log.compact(settled: Set(control.settled), publications: control.publications.map(\.changes)) {
            control.settled = []
        } else {
            let retained = Set(try await log.retained().map(\.change))
            control.settled = control.settled.filter { retained.contains($0) }
        }
        let retained = Set(try await log.retained().map(\.change))
        control.publications.removeAll { Set($0.changes).isDisjoint(with: retained) }
        try writeControl()
    }

    private func localChanges(in request: ProtocolUpdateRequest) -> [String] {
        request.updates.flatMap { update in
            control.publications.first(where: { $0.update.change == update.change })?.changes ?? [update.change]
        }
    }

    /// Freeze each composed publication alongside its exact request before any
    /// transmission. Later requests repeat the same group as an immutable prefix.
    private func composePublication(in request: ProtocolUpdateRequest) async throws -> ProtocolUpdateRequest {
        let records = try await changeLog().retained()
        let byChange = Dictionary(uniqueKeysWithValues: records.map { ($0.change, $0) })
        var children: [String: Int] = [:]
        for record in records {
            if case let .authored(parent) = record.basis { children[parent, default: 0] += 1 }
        }
        // An authored graph can be a hidden candidate rather than the request base.
        let transportBase = records.first { record in
            if case let .accepted(base) = record.basis {
                return base.update == request.base && base.root == record.graph.root
            }
            return false
        }?.graph
        var updates: [ProtocolCandidateUpdate] = [], index = 0
        func compact(_ update: ProtocolCandidateUpdate, change: String) throws -> ProtocolCandidateUpdate {
            // Later elements may start at a graph the host has not retained yet.
            guard updates.isEmpty, let transportBase, let candidate = byChange[change]?.candidate else { return update }
            return try LocalChange.compactTransport(update, basis: transportBase, candidate: candidate)
        }
        let frozen = Set((try control.attempt?.request().updates.map(\.change)) ?? [])
        while index < request.updates.count {
            let current = request.updates[index]
            if let group = control.publications.first(where: { $0.changes.first == current.change }) {
                var shared = 0
                while shared < group.changes.count, index + shared < request.updates.count,
                      request.updates[index + shared].change == group.changes[shared] { shared += 1 }
                if shared != group.changes.count {
                    let remaining = Array(request.updates.dropFirst(index + shared))
                    let branch = remaining.compactMap { byChange[$0.change] }
                    guard branch.count == remaining.count,
                          let continuations = try LocalChange.branchPublications(group, shared: shared, branch: branch, records: byChange) else {
                        throw ProtocolValidationError.invalidValue("Pending branch overlaps an already composed publication; original changes are retained")
                    }
                    var prefix = group.update
                    if group.changes.allSatisfy({ control.settled.contains($0) }) { prefix.objects = []; prefix.deltas = [] }
                    updates.append(prefix)
                    for continuation in continuations {
                        let existing = control.publications.first(where: { $0.changes.first == continuation.changes.first })
                        guard existing == nil || existing == continuation else { throw ProtocolValidationError.invalidValue("Composed continuation identity changed") }
                        if existing == nil { control.publications.append(continuation) }
                        updates.append(existing?.update ?? continuation.update)
                    }
                    break
                }
                var update = group.update
                if group.changes.allSatisfy({ control.settled.contains($0) }) { update.objects = []; update.deltas = [] }
                updates.append(update); index += group.changes.count; continue
            }
            var run: [LocalChange] = [], best: ChangePublication?
            var cursor = index
            while cursor < request.updates.count,
                  let record = byChange[request.updates[cursor].change], record.update.trace != nil,
                  !control.settled.contains(record.change), !frozen.contains(record.change),
                  !control.publications.contains(where: { $0.changes.contains(record.change) }) {
                if let previous = run.last, children[previous.change, default: 0] > 1 { break }
                if let previous = run.last, record.basis != .authored(change: previous.change) { break }
                let boundary = !record.update.resolves.isEmpty || record.update.ifCurrent != nil
                if boundary, !run.isEmpty { break }
                run.append(record)
                if boundary { break }
                cursor += 1
            }
            func mentionsPrior(_ value: ProtocolSemanticValue) -> Bool {
                switch value {
                case let .object(fields):
                    if fields["kind"] == .string("operation"), case let .string(change)? = fields["change"],
                       control.publications.contains(where: { $0.changes.contains(change) }) { return true }
                    return fields.values.contains(where: mentionsPrior)
                case let .array(values): return values.contains(where: mentionsPrior)
                default: return false
                }
            }
            let referencesPrior = run.first?.update.trace?.flatMap(\.operations).contains {
                $0.fields.values.contains(where: mentionsPrior)
            } == true
            if run.count > 1 || (run.first?.update.trace?.count ?? 0) > 1 || referencesPrior {
                best = try LocalChange.publication(run, previous: control.publications)
                if best == nil {
                    var frames = 0, operations = 0, end = 0
                    for record in run {
                        frames += record.update.trace?.count ?? 0
                        operations += (record.update.trace ?? []).reduce(0) { $0 + $1.operations.count }
                        if frames > 64 || operations > 1024 { break }
                        end += 1
                    }
                    if end > 0, end < run.count { best = try LocalChange.publication(Array(run.prefix(end)), previous: control.publications) }
                }
            }
            if var best {
                best.update = try compact(best.update, change: best.changes.last!)
                control.publications.append(best)
                updates.append(best.update); index += best.changes.count
            } else { updates.append(try compact(current, change: current.change)); index += 1 }
        }
        return ProtocolUpdateRequest(base: request.base, updates: updates)
    }

    private var lastAuthenticationRetry: Date?

    /// Classify a failure into the machine's taxonomy.
    private func fail(_ error: any Error, id: String?) {
        failure = (error as? LocalizedError)?.errorDescription ?? String(describing: error)
        if let http = error as? ProtocolHTTPError, http.code == "http-error" || http.retryable {
            // Only a protocol refusal can reject an intent. An intermediary's
            // status is ambiguous, even when it is a 4xx response.
            dispatch(.transportFailed(id: id))
        } else if let http = error as? ProtocolHTTPError, http.status == 401 || http.status == 403 {
            dispatch(.authenticationFailed(reason: http.code))
            // A key device's session expires within the hour. The client has
            // already dropped the rejected token, so one prompt retry carries a
            // fresh one; a second 401 soon after is a real revocation and stays.
            if http.status == 401, lastAuthenticationRetry.map({ Date().timeIntervalSince($0) > 60 }) ?? true {
                lastAuthenticationRetry = Date()
                Task { await self.credentialsRefreshed() }
            }
        } else if let http = error as? ProtocolHTTPError, http.code == "unsupported-operation", let id {
            hold(.unsupported, detail: http.message ?? http.code, id: id)
        } else if error is ProtocolUpdateConflictError, let id {
            hold(.rejected, detail: "the change conflicts with a newer decision", id: id)
        } else if let http = error as? ProtocolHTTPError, (400..<500).contains(http.status), http.status != 408, http.status != 429, let id {
            // Repeating a request the host refused cannot change the answer.
            hold(.rejected, detail: http.message ?? http.code, id: id)
        } else if error is UpdateError || error is ProtocolValidationError {
            dispatch(.validationFailed(reason: String(describing: error)))
        } else {
            dispatch(.transportFailed(id: id))
        }
    }

    private func hold(_ reason: UpdateMachine.HeldReason, detail: String, id: String) {
        control.held = .init(reason: reason, detail: detail)
        do { try writeControl() } catch { Self.syncLog.error("held record not written: \(String(describing: error), privacy: .public)") }
        dispatch(reason == .rejected ? .rejected(id: id, detail: detail) : .unsupported(id: id, detail: detail))
    }

    func writeControl() throws {
        try files.write(control, phase: machine.kind)
    }

    // MARK: Public operations

    /** Explicit synchronization: publish now, retry, or catch up, then wait for the result. */
    @discardableResult
    public func syncOnce() async throws -> WorkspaceSyncPresentation {
        try requireOpen()
        await ensureEntered()
        dispatch(.syncRequested)
        await settle()
        // Explicit sync also drains pending successor and sibling chains.
        for _ in 0..<8 {
            guard case let .locallyPending(_, preparing) = machine.phase, !preparing else { break }
            dispatch(.syncRequested)
            await settle()
        }
        return try await presentation()
    }

    /** Reestablishes a coherent snapshot-then-follow boundary after watch history expires. */
    @discardableResult
    public func recoverWatchGap() async throws -> WorkspaceSyncPresentation {
        try requireOpen()
        await ensureEntered()
        if case .current = machine.phase { dispatch(.watchGap) } else { dispatch(.syncRequested) }
        await settle()
        return try await presentation()
    }

    /** Whether the tree's watch stream is open; while it is, a clean tree skips its freshness poll. */
    public func setWatching(_ open: Bool) {
        watching = open
    }

    /** Feed one watch event to the machine and wait for what it caused. */
    @discardableResult
    public func observe(_ event: ProtocolWatchEvent) async throws -> WorkspaceSyncPresentation {
        try requireOpen()
        await ensureEntered()
        guard event.treeID == (await workingTree.treeID().rawValue) else { return try await presentation() }
        watchEvent = event
        dispatch(.watch(cursor: event.id, root: event.update.root, update: event.update.id,
            digests: event.requestDigest.map { [$0] } ?? [], transitions: true,
            conflicted: event.update.conflicted))
        await settle()
        return try await presentation()
    }

    public func watchCursor() async throws -> String? {
        try requireOpen()
        await ensureEntered()
        if let cursor = machine.base?.cursor { return cursor }
        return try await workingTree.heads().acceptedCursor
    }

    /** Records network-path availability; reconnection resumes from durable state. */
    public func setTransportAvailable(_ available: Bool) async {
        await ensureEntered()
        dispatch(.transportAvailable(available))
        if available { await settle() }
    }

    /** Refreshed credentials resume a request that failed authentication. */
    public func credentialsRefreshed() async {
        await ensureEntered()
        dispatch(.credentialsRefreshed)
        await settle()
    }

    /// Discard a held request and every change authored on it, then catch up.
    /// The discarded changes leave the change log; this is the explicit way
    /// out of `held`.
    public func discardHeldChanges() async throws {
        try requireOpen()
        await ensureEntered()
        guard case let .held(_, _, request, _) = machine.phase, let attempt = control.attempt, attempt.digest == request.id else { return }
        let changes = localChanges(in: try attempt.request())
        try await changeLog().discard(Set(changes).subtracting(control.settled))
        control.attempt = nil
        control.attemptTip = nil
        control.held = nil
        try writeControl()
        submission = nil
        try forgetSubmittedReviews(Set(changes))
        await workingTree.invalidateDocumentViews()
        dispatch(.heldDiscarded)
        await settle()
        await publishTip()
    }

    public func close() {
        closed = true
        deferredApply = nil
        localView = nil
        for timer in timers.values { timer.cancel() }
        timers = [:]
        resumeIdleWaiters()
    }

    func requireOpen() throws {
        if closed { throw UpdateError.closed }
    }

    // MARK: Presentation

    /// What the tree's sync status shows, derived from the machine and the change log.
    public func presentation() async throws -> WorkspaceSyncPresentation {
        try requireOpen()
        let heads = try await workingTree.heads()
        let pending = try await pendingLocalChanges()
        var value: WorkspaceSyncPresentation
        switch machine.phase {
        case .unplaced: value = .init(state: .offline, detail: "Not placed")
        case .current:
            value = .init(state: .current, detail: machine.base?.conflicted == true ? "Accepted state has unresolved conflicts" : "Current at accepted server root")
        case .locallyPending: value = .init(state: .locallyPending)
        case .prepared: value = .init(state: .requestPending)
        case .submitting, .submittingPending: value = .init(state: .uploading)
        case .acceptedPendingApply: value = .init(state: .downloading)
        case .offline(.transport, _, _, _): value = .init(state: .offline, detail: failure)
        case let .offline(.authentication(reason), _, _, _):
            value = .init(state: reason == "device-revoked" ? .revoked : .authenticationFailure, detail: failure ?? reason)
        case let .held(reason, detail, _, _):
            let lead = reason == .unsupported ? "This change needs a newer Canopy" : "Canopy refused this change; it is kept on this device"
            value = .init(state: .conflict, detail: [lead, detail].compactMap { $0 }.joined(separator: ": "))
        case let .terminal(reason): value = .init(state: .offline, detail: "Synchronization stopped: " + reason)
        }
        value.acceptedConflicted = machine.base?.conflicted ?? control.acceptedConflicted
        value.acceptedRoot = machine.base?.root ?? heads.acceptedRoot
        value.localRoot = heads.materializedRoot
        if !pending.isEmpty {
            let local = try await localViewState(pending)
            value.localRoot = local.navigation?.candidate.root ?? heads.materializedRoot
            value.localAdditions = true
            if case .current = machine.phase { value.state = .locallyPending }
            if !local.structural, value.state == .locallyPending || value.state == .requestPending || value.state == .uploading {
                value.detail = UpdateError.awaitingHostReconciliation.localizedDescription
            }
        }
        return value
    }

    // MARK: Graph reads

    /// The spine reachable from `root` (directories and Markdown), assembled
    /// object by object: everything already local is reused and only absent
    /// objects are fetched, so catching up after a restart costs a handful of
    /// small reads rather than a snapshot. Other files stay absent and are
    /// served by hash. Nested trees are separate boundaries and are not entered.
    private func sparseDirectoryGraph(treeID: String, root: String) async throws -> ProtocolSnapshot {
        var objects: [ProtocolObjectEnvelope] = []
        var pending: [(hash: String, kind: ProtocolEntryKind)] = [(root, .directory)], seen = Set<String>()
        while let next = pending.popLast() {
            guard seen.insert(next.hash).inserted else { continue }
            // The working tree reads its overlay, then its platform store, and
            // verifies the bytes. Only an object the store lacks is asked of the
            // host directly; a failed read is not repeated.
            let bytes: Data
            do { bytes = try await workingTree.objectBytes(hash: next.hash) }
            catch ObjectStoreError.missing {
                bytes = try await transport.object(tree: treeID, hash: next.hash)
                guard ProtocolObjectCodec.hash(bytes) == next.hash else { throw UpdateError.returnedSnapshotMismatch }
            }
            objects.append(ProtocolObjectEnvelope(hash: next.hash, bytes: bytes))
            guard next.kind == .directory, case let .directory(entries, _) = try ProtocolObjectCodec.decode(bytes, kind: .directory) else { continue }
            for entry in entries {
                guard let child = entry.hash, let kind = entry.kind else { continue }
                if kind == .directory || entry.name.hasSuffix(".md") || entry.name.hasSuffix(".mdx") { pending.append((child, kind)) }
            }
        }
        let graph = ProtocolSnapshot(root: root, objects: objects.sorted { $0.hash < $1.hash })
        _ = try ProtocolObjectGraph.validate(graph, mode: .sparseFiles)
        return graph
    }
}
