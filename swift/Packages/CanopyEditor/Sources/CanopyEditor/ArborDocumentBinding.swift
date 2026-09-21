import CanopyAppKit
import Overstory
import Foundation
import Observation
import OSLog
import CryptoKit
import Quagmire

/// Editor adapter for the Arbor Sync document admission machine.
///
/// Quagmire owns the block tree, undo grouping, and the exact-source ledger;
/// `DocumentAdmissionMachine` in CanopyAppKit owns every timer, in-flight,
/// successor, flush, observation, failure, and conflict transition; this
/// binding runs the machine's effects against a `WorkspaceDocumentSession`.
@MainActor
@Observable
public final class ArborDocumentBinding {
    private static let diagnosticLog = Logger(subsystem: "org.arbor.native", category: "EditorAdmission")
    private func trace(_ message: String) {
        Self.diagnosticLog.notice("tree=\(self.reference.tree.rawValue, privacy: .public) generation=\(self.machine.generation) phase=\(self.machine.kind, privacy: .public) \(message, privacy: .public)")
    }
    private static func sourceID(_ source: String) -> String {
        SHA256.hash(data: Data(source.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    public let document: Document
    public let editorState: EditorState
    public private(set) var reference: WorkspaceReference
    private var saveError: Error?
    public private(set) var recoveryError: Error?
    public var lastError: Error? { recoveryError ?? saveError }
    private var recoveryStore: EditorRecoveryStore?
    private var recoveryRevision: EditorRecoveryStore.Revision?
    private var recoverySource: String?
    public private(set) var conflict: WorkspaceDocumentConflict?
    public private(set) var lastEnqueuedSource: String?
    public private(set) var acceptedTitle: String

    let session: any WorkspaceDocumentSession
    private var accepted: WorkspaceDocumentSnapshot
    private var basisLedgers: [String: ArborSourceLedger] = [:]
    /// The exact ledger each unacknowledged generation produced, so a confirmed
    /// admission can retain its ledger as the next basis.
    private var authoredLedgers: [Int: ArborSourceLedger] = [:]
    private var copySources: [BlockID: BlockID] = [:]
    private(set) var ledger: ArborSourceLedger
    private var machine: DocumentAdmissionMachine.State
    private var debounceTask: Task<Void, Never>?
    private var admissionTask: Task<Void, Never>?
    private var updatesTask: Task<Void, Never>?
    private var settleWaiters: [CheckedContinuation<Void, Never>] = []
    /// Snapshots the machine may be asked to acknowledge or apply, keyed by content revision.
    private var snapshots: [String: WorkspaceDocumentSnapshot] = [:]
    private var pendingConflict: WorkspaceDocumentConflict?
    private var pendingFailure: Error?
    private let debounce: Duration
    private let admissionPolicy: WorkspaceAdmissionPolicy
    private var directoryProjection: (reference: WorkspaceReference, children: [WorkspaceNode])?

    public var generation: Int { machine.generation }
    /// True only when the private recovery journal contains the exact latest
    /// source handed to the admission machine. A working-tree failure can
    /// therefore be presented without implying that the edit exists only in
    /// memory.
    public var latestEditIsRetainedInRecovery: Bool {
        recoveryError == nil && recoveryRevision != nil && recoverySource == lastEnqueuedSource
    }
    /// True from the first uncommitted authored generation until Arbor Sync acknowledges the latest one.
    public var isSaving: Bool { !machine.isSettled }
    /// The machine state, for lifecycle callers and tests.
    public var admissionState: DocumentAdmissionMachine.State { machine }

    public static func open(
        reference: WorkspaceReference,
        session: any WorkspaceDocumentSession,
        debounce: Duration = DocumentAdmissionMachine.debounce,
        recoveryRoot: URL? = nil
    ) async throws -> ArborDocumentBinding {
        let snapshot = try await session.snapshot()
        let policy = await session.admissionPolicy
        let binding = ArborDocumentBinding(reference: reference, session: session, snapshot: snapshot, debounce: debounce, admissionPolicy: policy)
        if let recoveryRoot {
            // Fail opening rather than offer an editor whose safety journal cannot be read.
            let store = try EditorRecoveryStore(root: recoveryRoot, reference: snapshot.reference)
            binding.recoveryStore = store
            try binding.restoreDraft(from: store, retainsBasis: policy == .retainedBasis)
        }
        binding.trace("opened policy=\(policy) source=\(Self.sourceID(snapshot.source))")
        await binding.observeAuthoritativeUpdates()
        return binding
    }

    private init(
        reference: WorkspaceReference,
        session: any WorkspaceDocumentSession,
        snapshot: WorkspaceDocumentSnapshot,
        debounce: Duration,
        admissionPolicy: WorkspaceAdmissionPolicy
    ) {
        self.reference = snapshot.reference
        self.session = session
        self.accepted = snapshot
        self.debounce = debounce
        self.admissionPolicy = admissionPolicy
        let opened = ArborMarkdownCodec.open(
            source: snapshot.source,
            revision: snapshot.contentRevision,
            identitySeed: String(describing: snapshot.reference.identity)
        )
        self.ledger = opened.ledger
        let document = Document(
            id: DocumentID(String(describing: snapshot.reference.identity)),
            children: opened.blocks,
            fallbackTitle: snapshot.reference.path.split(separator: "/").last.map(String.init)
        )
        self.document = document
        self.acceptedTitle = document.title
        self.editorState = EditorState()
        self.machine = DocumentAdmissionMachine.State(
            accepted: .init(source: snapshot.source, revision: snapshot.contentRevision)
        )
        self.snapshots[snapshot.contentRevision] = snapshot
        self.basisLedgers[snapshot.contentRevision] = opened.ledger
    }

    // MARK: Independent local recovery

    /// The generations the machine holds since `accepted`, as one chain that
    /// reproduces `source` from the accepted bytes; nil when a generation has
    /// no captured patch or the chain no longer starts at the accepted source.
    private func capturedGenerations(ending source: String) -> [WorkspaceDocumentGeneration]? {
        var chain: [WorkspaceDocumentGeneration] = []
        var previous = accepted.source
        for generation in machine.pendingGenerations {
            guard var patch = generation.patch, let produced = try? patch.applying(to: previous),
                  produced.utf8.elementsEqual(generation.source.utf8) else { return nil }
            patch.baseContentRevision = accepted.contentRevision
            if !patch.edits.isEmpty { chain.append(.init(patch: patch, source: generation.source)) }
            previous = generation.source
        }
        guard previous.utf8.elementsEqual(source.utf8) else { return nil }
        return chain
    }

    private func checkpoint(source: String) {
        guard let recoveryStore else { return }
        do {
            // The journal retains the generations as captured, so recovery
            // replays them as frames rather than re-deriving one claim.
            let captured = capturedGenerations(ending: source)
            if let recoveryRevision, try recoveryStore.source(recoveryRevision) == source,
               recoveryRevision.baseRevision == accepted.contentRevision,
               try recoveryStore.base(recoveryRevision) == accepted.source,
               try (captured == nil || recoveryStore.intent(recoveryRevision)?.generations == captured),
               !recoveryStore.isSaved(recoveryRevision) || source == accepted.source { return }
            recoveryRevision = try recoveryStore.record(reference: reference, source: source, base: accepted, generations: captured)
            recoverySource = source
            recoveryError = nil
        } catch { trace("recovery checkpoint failed: \(String(describing: error))"); recoveryError = error }
    }

    private func markRecoverySaved(source: String) {
        guard let recoveryStore, let recoveryRevision else { return }
        do {
            guard try recoveryStore.source(recoveryRevision) == source else { return }
            try recoveryStore.markSaved(recoveryRevision)
            recoveryError = nil
        } catch { recoveryError = error }
    }

    private var recoveredIntent: WorkspaceDocumentIntent?

    private func restoreDraft(from store: EditorRecoveryStore, retainsBasis: Bool) throws {
        guard let record = try store.revisions().first, !store.isSaved(record) else { return }
        // Validate retained patches against their original basis before any recovery action.
        let retainedIntent = try store.intent(record)
        let source = try store.source(record)
        trace("restore draft=\(record.id) source=\(Self.sourceID(source)) bytes=\(source.utf8.count) retainsBasis=\(retainsBasis)")
        recoveryRevision = record
        recoverySource = source
        if !retainsBasis, source == accepted.source {
            try store.markSaved(record)
            return
        }
        let baseSource = try store.base(record)
        let current = accepted
        if retainsBasis {
            recoveredIntent = retainedIntent
            accepted = .init(reference: record.reference, source: baseSource, contentRevision: record.baseRevision)
            machine.accepted = .init(source: baseSource, revision: record.baseRevision)
            snapshots[record.baseRevision] = accepted
        }
        let restored = ArborMarkdownCodec.open(source: source, revision: accepted.contentRevision,
                                               identitySeed: String(describing: reference.identity))
        ledger = restored.ledger
        _ = document.replaceChildrenReconciled(restored.blocks)
        lastEnqueuedSource = source
        // Replay the retained generations so the machine holds the chain the
        // editor captured and the admission states it frame by frame.
        let preserves = { (patch: WorkspaceDocumentPatch) in patch.edits.contains { !($0.lineage ?? []).isEmpty || !($0.copies ?? []).isEmpty } }
        if retainsBasis, let intent = recoveredIntent {
            let generations = intent.generations.isEmpty ? [WorkspaceDocumentGeneration(patch: intent.patch, source: intent.source)] : intent.generations
            for generation in generations {
                dispatch(.edit(source: generation.source, preservesIntent: preserves(generation.patch), patch: generation.patch))
            }
            authoredLedgers[machine.generation] = restored.ledger
        } else {
            dispatch(.edit(source: source, preservesIntent: recoveredIntent.map { preserves($0.patch) } ?? false))
        }
        if retainsBasis, retainedIntent?.patch.edits.contains(where: { !($0.copies ?? []).isEmpty }) == true {
            // Retain recovered operation evidence before a new transaction can
            // coalesce its exact source evidence into a different generation.
            dispatch(.flush)
        }
        if !retainsBasis, baseSource != current.source {
            // A remote edit cannot silently replace a recovered local draft.
            // Reuse the existing conflict review with both exact alternatives.
            debounceTask?.cancel()
            debounceTask = nil
            let value = WorkspaceDocumentConflict(
                base: .init(reference: record.reference, source: baseSource, contentRevision: record.baseRevision),
                current: current, submittedSource: source)
            pendingConflict = value
            conflict = value
            saveError = value
            machine.phase = .conflict(submitted: .init(generation: machine.generation, source: source),
                                      current: Self.observation(current), latest: nil)
        }
    }

    // MARK: Machine

    private func dispatch(_ event: DocumentAdmissionMachine.Event) {
        let (next, effects) = DocumentAdmissionMachine.reduce(machine, event, debounce: debounce, admissionPolicy: admissionPolicy)
        let priorPhase = machine.kind
        machine = next
        trace("transition \(priorPhase) -> \(machine.kind)")
        if machine.kind != priorPhase {
            do { try recoveryStore?.log(phase: machine.kind, generation: machine.generation, revision: recoveryRevision) }
            catch { recoveryError = error }
            // Editor admission phases beside the network events, so a long
            // "saving" indicator can be attributed without the unified log.
            var note = WireNetworkLogEntry(kind: .note, name: "editor-phase", tree: reference.tree.rawValue)
            note.error = "\(priorPhase) → \(machine.kind) generation=\(machine.generation)"
            WireNetworkLog.current?.record(note)
        }
        for effect in effects { run(effect) }
        if machine.isSettled {
            for waiter in settleWaiters { waiter.resume() }
            settleWaiters.removeAll()
        }
    }

    private func run(_ effect: DocumentAdmissionMachine.Effect) {
        switch effect {
        case let .schedule(delay):
            debounceTask?.cancel()
            debounceTask = Task { @MainActor [weak self] in
                do { try await Task.sleep(for: delay) } catch { return }
                guard let self, !Task.isCancelled else { return }
                self.debounceTask = nil
                self.dispatch(.debounceElapsed)
            }
        case .cancelTimer:
            debounceTask?.cancel()
            debounceTask = nil
        case let .admit(generations, baseRevision, baseSource):
            let previous = admissionTask
            admissionTask = Task { @MainActor [self] in
                if let previous { await previous.value }
                await self.persist(generations: generations, baseRevision: baseRevision, baseSource: baseSource)
            }
        case let .acknowledge(result):
            acknowledge(result)
        case let .apply(_, revision):
            guard let snapshot = snapshots[revision] else { return }
            applyAcceptedReplacementNow(snapshot)
        case .mergeLocally:
            // Native Arbor never merges a document locally: the conflict is
            // client-owned evidence until the user chooses a resolution.
            conflict = pendingConflict
            saveError = pendingConflict
        case let .surfaceFailure(failure):
            saveError = pendingFailure ?? NSError(domain: "ArborDocumentBinding", code: 1, userInfo: [NSLocalizedDescriptionKey: failure.message])
        case .stop:
            break
        }
    }

    /// Wait until no request or timer remains.
    private func settle() async {
        while !machine.isSettled {
            await withCheckedContinuation { continuation in settleWaiters.append(continuation) }
        }
    }

    // MARK: Editor commits

    /// Undo is an ordinary edit: the editor keeps its own undo stack and each
    /// generation is admitted as a plain patch. Only explicit copies are evidence.
    func captureTransactionEvidence() {
        copySources.merge(document.blockCopiesForCurrentCommit) { _, newest in newest }
    }

    func admitCurrentGeneration() {
        if basisLedgers[accepted.contentRevision] == nil, ledger.source.utf8.elementsEqual(accepted.source.utf8) {
            var basis = ledger; basis.revision = accepted.contentRevision
            basisLedgers[accepted.contentRevision] = basis
        }
        captureTransactionEvidence()
        let generation = machine.generation + 1
        // The generation's patch is captured against the previous generation's
        // ledger, exactly as the editor produced it; the machine keeps it and the
        // admission states it in its own frame (docs/overstory-spec/09).
        let (admission, nextLedger) = ArborMarkdownCodec.admission(blocks: document.children, ledger: ledger, copies: copySources)
        let preservesIntent = admission.patch.edits.contains { !($0.lineage ?? []).isEmpty || !($0.copies ?? []).isEmpty }
        authoredLedgers[generation] = nextLedger
        lastEnqueuedSource = admission.source
        ledger = nextLedger
        // Editing does not resolve a blocked admission. Keep the warning and
        // update its retained source so Review/Keep My Edit uses the latest
        // generation, rather than the first edit that encountered the conflict.
        if var conflict {
            conflict.submittedSource = admission.source
            self.conflict = conflict
            pendingConflict = conflict
        }
        dispatch(.edit(source: admission.source, preservesIntent: preservesIntent, patch: admission.patch))
        checkpoint(source: admission.source)
    }

    /// Force the latest authored generation through and await local durability.
    public func flush() async {
        // Capture a final keystroke even if the editor's commit callback has
        // not run yet (navigation, backgrounding, or process termination).
        let source = ArborMarkdownCodec.admission(blocks: document.children, ledger: ledger, copies: copySources).0.source
        if source != (lastEnqueuedSource ?? machine.accepted.source) { admitCurrentGeneration() }
        dispatch(.flush)
        await settle()
        do { try await session.flush() } catch { saveError = error }
    }

    public func retryLastSave() async {
        guard lastError != nil, conflict == nil else { return }
        admitCurrentGeneration()
        await flush()
    }

    public func snapshot() async throws -> WorkspaceDocumentSnapshot {
        await flush()
        return try await session.snapshot()
    }

    /// Admit an exact host-authored source replacement, such as a structured
    /// frontmatter form. It follows the same recovery, conflict, and durable
    /// admission path as an edit produced by Quagmire.
    public func replaceSource(_ source: String) async throws {
        await flush()
        if let error = lastError { throw error }
        let current = try await session.snapshot()
        guard !source.utf8.elementsEqual(current.source.utf8) else { return }
        checkpoint(source: source)
        dispatch(.edit(source: source))
        dispatch(.flush)
        await settle()
        do { try await session.flush() } catch { saveError = error }
        if let error = lastError { throw error }
    }

    /// Project the directory's immediate children into the live editor without
    /// adding them to authored Markdown. Moving a projected row materializes
    /// it through Quagmire's ordinary block move transaction.
    public func projectDirectoryChildren(
        _ children: [WorkspaceNode],
        in reference: WorkspaceReference
    ) {
        directoryProjection = (reference, children)
        let projected = ArborMarkdownCodec.placeDirectoryChildren(
            children,
            in: document.children,
            directory: reference
        )
        _ = document.replaceChildrenReconciled(projected)
    }

    /// Reconcile a provider-authored path change for this stable identity
    /// without replacing the live editor tree.
    public func reconcileReference(_ reference: WorkspaceReference) {
        guard reference.identity == self.reference.identity else { return }
        self.reference = reference
        document.fallbackTitle = reference.path.split(separator: "/").last.map(String.init)
    }

    public func history() async throws -> [WorkspaceHistoryEntry] {
        await flush()
        if let recoveryStore {
            return try recoveryStore.revisions().map {
                WorkspaceHistoryEntry(id: "editor-recovery:" + $0.id, revision: "editor-recovery:" + $0.id,
                                      title: $0.summary.map { "Local copy: " + $0 } ?? "Local editor copy", timestamp: $0.timestamp)
            }
        }
        return try await session.history()
    }

    @discardableResult
    public func recover(revision: String) async throws -> WorkspaceDocumentSnapshot {
        await flush()
        if revision.hasPrefix("editor-recovery:"), let recoveryStore,
           let record = try recoveryStore.revisions().first(where: { "editor-recovery:" + $0.id == revision }) {
            let source = try recoveryStore.source(record)
            let current = try await session.snapshot()
            // Preserve the current editor too. Recovery creates an ordinary
            // new edit and never removes the original evidence.
            checkpoint(source: ArborMarkdownCodec.admission(blocks: document.children, ledger: ledger, copies: copySources).0.source)
            let restored = WorkspaceDocumentSnapshot(reference: reference, source: source, contentRevision: current.contentRevision)
            applyAcceptedReplacementNow(restored)
            accepted = current
            machine.accepted = .init(source: current.source, revision: current.contentRevision)
            machine.phase = .clean
            admitCurrentGeneration()
            await flush()
            if let error = lastError { throw error }
            return try await session.snapshot()
        }
        let recovered = try await session.recover(revision: revision)
        await applyAcceptedReplacement(recovered)
        return recovered
    }

    // MARK: Conflicts

    public func resolveConflict(preferSubmitted: Bool) async throws {
        guard let conflict else { return }
        try await resolveConflict(source: preferSubmitted ? conflict.submittedSource : conflict.current.source)
    }

    public func resolveConflict(source: String) async throws {
        guard let conflict else { return }
        if source == conflict.current.source {
            markRecoverySaved(source: conflict.submittedSource)
            snapshots[conflict.current.contentRevision] = conflict.current
            dispatch(.resolveConflict(keepSubmitted: false))
            return
        }
        // The chosen source becomes the latest generation and is resubmitted
        // against the verified current revision. The editor is replaced only
        // when the provider acknowledges it; a failed retry leaves both the
        // editor tree and the recoverable conflict evidence intact.
        saveError = nil
        checkpoint(source: source)
        dispatch(.edit(source: source))
        dispatch(.resolveConflict(keepSubmitted: true))
        await settle()
        if let error = lastError { throw error }
    }

    // MARK: Authoritative replacement

    public func applyAcceptedReplacement(_ snapshot: WorkspaceDocumentSnapshot) async {
        await flush()
        applyAcceptedReplacementNow(snapshot)
        machine.accepted = .init(source: snapshot.source, revision: snapshot.contentRevision)
        machine.phase = .clean
    }

    private func applyAcceptedReplacementNow(_ snapshot: WorkspaceDocumentSnapshot) {
        let opened = ArborMarkdownCodec.open(
            source: snapshot.source,
            revision: snapshot.contentRevision,
            identitySeed: String(describing: snapshot.reference.identity)
        )
        let rebased = ArborMarkdownCodec.rebased(opened, preserving: document.children)
        let replacement: [Block]
        if let directoryProjection {
            replacement = ArborMarkdownCodec.placeDirectoryChildren(
                directoryProjection.children,
                in: rebased.blocks,
                directory: directoryProjection.reference
            )
        } else {
            replacement = rebased.blocks
        }
        _ = document.replaceChildrenReconciled(replacement)
        accepted = snapshot
        reference = snapshot.reference
        ledger = rebased.ledger
        acceptedTitle = document.title
        lastEnqueuedSource = nil
        conflict = nil
        saveError = nil
    }

    public func close() async {
        stopObserving()
        await flush()
        dispatch(.close)
        await session.close()
    }

    func stopObserving() {
        updatesTask?.cancel()
        updatesTask = nil
    }

    private func observeAuthoritativeUpdates() async {
        guard let updates = try? await session.updates() else { return }
        updatesTask = Task { @MainActor [weak self] in
            do {
                for try await snapshot in updates {
                    guard let self else { return }
                    await self.receiveAuthoritativeUpdate(snapshot)
                }
            } catch is CancellationError {
            } catch {
                // Observation reconnect and resync belong to the provider. A
                // failed live view must not turn an otherwise durable editor
                // session into a save failure.
            }
        }
    }

    private func receiveAuthoritativeUpdate(_ snapshot: WorkspaceDocumentSnapshot) async {
        if snapshot.contentRevision == accepted.contentRevision {
            // Same revision: nothing to reconcile.
            snapshots[snapshot.contentRevision] = snapshot
            return
        }
        // Quagmire can contain a keystroke or newly inserted block before its
        // commit callback has entered the machine. An incoming transition must
        // not replace that dirty tree: the machine has no generation for it yet.
        let currentAdmission = ArborMarkdownCodec.admission(blocks: document.children, ledger: ledger, copies: copySources).0
        guard currentAdmission.source == machine.accepted.source else { return }
        let anchor = machine.anchor
        // Read through the provider so read-your-writes holds; suspending
        // here is safe because the anchor discards a stale result.
        guard let current = try? await session.snapshot() else { return }
        snapshots[current.contentRevision] = current
        dispatch(.observed(observation: Self.observation(current), anchor: anchor))
    }

    private static func observation(_ snapshot: WorkspaceDocumentSnapshot) -> DocumentAdmissionMachine.Observation {
        .init(source: snapshot.source, revision: snapshot.contentRevision)
    }

    // MARK: Admission transport

    private func persist(generations: [DocumentAdmissionMachine.Generation], baseRevision: String, baseSource: String) async {
        let generation = generations.last!.generation, source = generations.last!.source
        trace("persist generation=\(generation) generations=\(generations.count) base=\(Self.sourceID(baseSource)) source=\(Self.sourceID(source)) bytes=\(source.utf8.count)")
        // Each generation's patch was captured against its predecessor's
        // ledger, so the chain is stated as it was captured: one frame per
        // generation, nothing re-derived against the oldest basis. A chain that
        // does not start at this base (a conflict resolved onto other bytes, a
        // draft recovered without its capture) is a plain byte edit.
        var chain: [WorkspaceDocumentGeneration] = []
        var previous = baseSource
        for step in generations {
            guard var patch = step.patch, let produced = try? patch.applying(to: previous),
                  produced.utf8.elementsEqual(step.source.utf8) else { chain = []; break }
            patch.baseContentRevision = baseRevision
            if !patch.edits.isEmpty { chain.append(.init(patch: patch, source: step.source)) }
            previous = step.source
        }
        if !previous.utf8.elementsEqual(source.utf8) { chain = [] }
        var patch = ArborMarkdownCodec.patch(from: baseSource, to: source, revision: baseRevision)
        if chain.count == 1 { patch = chain[0].patch; chain = [] }
        trace("captured frames=\(max(chain.count, patch.edits.isEmpty ? 0 : 1)) edits=\(patch.edits.count)")
        let authoredLedger = authoredLedgers[generation] ?? (ledger.source.utf8.elementsEqual(source.utf8) ? ledger : nil)
        guard !patch.edits.isEmpty || !chain.isEmpty else {
            // Quagmire may report a follow-up commit after the authored source
            // is already current. It is saved by definition.
            do { try await session.flush() } catch {
                pendingFailure = error
                dispatch(.admissionFailed(generation: generation, error: .init(message: String(describing: error), retryable: true)))
                return
            }
            finishAdmission(generation: generation, snapshot: accepted)
            return
        }
        do {
            trace("validate edits=\(patch.edits.count) recovered=\(recoveredIntent != nil)")
            let intent = try WorkspaceDocumentIntent(
                basis: .init(reference: reference, source: baseSource, contentRevision: baseRevision),
                patch: patch, source: source, generations: chain)
            trace("provider admit begin")
            let confirmed = try await session.admit(intent: intent)
            trace("provider admit succeeded source=\(Self.sourceID(confirmed.source))")
            snapshots[confirmed.contentRevision] = confirmed
            if var next = authoredLedger, next.source.utf8.elementsEqual(confirmed.source.utf8) {
                next.revision = confirmed.contentRevision
                basisLedgers[confirmed.contentRevision] = next
            }
            authoredLedgers = authoredLedgers.filter { $0.key > generation }
            finishAdmission(generation: generation, snapshot: confirmed)
        } catch let value as WorkspaceDocumentConflict {
            if admissionPolicy == .retainedBasis {
                // A provider violating the retained-basis contract must neither
                // open legacy review nor infer durable admission from equal bytes.
                pendingFailure = value
                dispatch(.admissionConflicted(generation: generation, current: Self.observation(value.current)))
                return
            }
            if value.current.source == source {
                do { try await session.flush() } catch {
                    pendingFailure = error
                    dispatch(.admissionFailed(generation: generation, error: .init(message: String(describing: error), retryable: true)))
                    return
                }
                snapshots[value.current.contentRevision] = value.current
                finishAdmission(generation: generation, snapshot: value.current)
            } else {
                var enriched = value
                if enriched.base == nil { enriched.base = accepted }
                pendingConflict = enriched
                snapshots[value.current.contentRevision] = value.current
                dispatch(.admissionConflicted(generation: generation, current: Self.observation(value.current)))
            }
        } catch let value as WorkspacePatchError {
            guard case .staleRevision = value else {
                pendingFailure = value
                dispatch(.admissionFailed(generation: generation, error: .init(message: String(describing: value), retryable: false)))
                return
            }
            if admissionPolicy == .retainedBasis {
                pendingFailure = value
                dispatch(.admissionConflicted(generation: generation, current: nil))
                return
            }
            do {
                let current = try await session.snapshot()
                snapshots[current.contentRevision] = current
                if current.source == source {
                    try await session.flush()
                    // A durable provider write can win the race with its local
                    // acknowledgement. Exact bytes are an idempotent success.
                    finishAdmission(generation: generation, snapshot: current)
                } else {
                    pendingConflict = WorkspaceDocumentConflict(base: accepted, current: current, submittedSource: source)
                    dispatch(.admissionConflicted(generation: generation, current: Self.observation(current)))
                }
            } catch {
                pendingFailure = error
                dispatch(.admissionFailed(generation: generation, error: .init(message: String(describing: error), retryable: true)))
            }
        } catch {
            trace("provider admission failed: \(String(describing: error))")
            pendingFailure = error
            dispatch(.admissionFailed(generation: generation, error: .init(message: String(describing: error), retryable: true)))
        }
    }

    private func finishAdmission(generation: Int, snapshot: WorkspaceDocumentSnapshot) {
        // A keystroke can precede Quagmire's commit callback while a save is
        // suspended. Register it as a successor before an older acknowledgement
        // is allowed to reconcile the editor.
        let mounted = ArborMarkdownCodec.admission(blocks: document.children, ledger: ledger, copies: copySources).0.source
        if mounted != (lastEnqueuedSource ?? machine.accepted.source) { admitCurrentGeneration() }
        dispatch(.admitted(generation: generation, result: Self.result(snapshot)))
    }

    private static func result(_ snapshot: WorkspaceDocumentSnapshot) -> DocumentAdmissionMachine.Result {
        .init(source: snapshot.source, revision: snapshot.contentRevision)
    }

    private func acknowledge(_ result: DocumentAdmissionMachine.Result) {
        guard let confirmed = snapshots[result.revision] else { return }
        markRecoverySaved(source: confirmed.source)
        accepted = confirmed
        reference = confirmed.reference
        // A retained successor means the editor already holds newer content;
        // only source authority advances. Otherwise the acknowledgement
        // describes the tree mounted in Quagmire.
        var newerRetained = false
        if case .submitting = machine.phase { newerRetained = true }
        if !newerRetained {
            let mounted = ArborMarkdownCodec.admission(blocks: document.children, ledger: ledger, copies: copySources).0
            if confirmed.source == mounted.source {
                // Self-confirmation: advance without reparsing or replacing so
                // focus, selection, typing, and undo coalescing are undisturbed.
                ledger.source = confirmed.source
                ledger.revision = confirmed.contentRevision
            } else {
                // A provider-returned transformation is genuinely new
                // authoritative content and still needs reconciliation.
                let opened = ArborMarkdownCodec.open(
                    source: confirmed.source,
                    revision: confirmed.contentRevision,
                    identitySeed: String(describing: confirmed.reference.identity)
                )
                let rebased = ArborMarkdownCodec.rebased(opened, preserving: document.children)
                ledger = rebased.ledger
                if rebased.blocks != document.children { _ = document.replaceChildrenReconciled(rebased.blocks) }
            }
            acceptedTitle = document.title
        }
        conflict = nil
        saveError = nil
        pendingConflict = nil
        pendingFailure = nil
        if machine.isSettled {
            authoredLedgers.removeAll()
            copySources.removeAll()
            basisLedgers = basisLedgers.filter { $0.key == confirmed.contentRevision }
        }
    }
}
