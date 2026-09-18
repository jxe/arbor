import ArborKit
import Foundation
import Observation
import Quagmire

/// Editor adapter for the Arbor Sync document admission machine.
///
/// Quagmire owns the block tree, undo grouping, and the exact-source ledger;
/// `DocumentAdmissionMachine` in ArborKit owns every timer, in-flight,
/// successor, flush, observation, failure, and conflict transition; this
/// binding runs the machine's effects against a `WorkspaceDocumentSession`.
@MainActor
@Observable
public final class ArborDocumentBinding {
    public let document: Document
    public let editorState: EditorState
    public private(set) var reference: WorkspaceReference
    private var saveError: Error?
    public private(set) var recoveryError: Error?
    public var lastError: Error? { recoveryError ?? saveError }
    private var recoveryStore: EditorRecoveryStore?
    private var recoveryRevision: EditorRecoveryStore.Revision?
    public private(set) var conflict: WorkspaceDocumentConflict?
    public private(set) var lastEnqueuedSource: String?
    public private(set) var acceptedTitle: String

    let session: any WorkspaceDocumentSession
    private var accepted: WorkspaceDocumentSnapshot
    private var basisLedgers: [String: ArborSourceLedger] = [:]
    private var authoredBlocks: [Int: [Block]] = [:]
    private var copySources: [BlockID: BlockID] = [:]
    private var authoredCopies: [Int: [BlockID: BlockID]] = [:]
    private var transactionLedger: ArborSourceLedger?
    private var pendingTransactions: [WorkspaceSourceTransaction] = []
    private var authoredTransactions: [Int: [WorkspaceSourceTransaction]] = [:]
    private var admittedTransactionIDs: Set<String> = []
    private var releasedTransactionIDs = Set<String>()
    private var retriedUndoRevision: String?
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

    private func checkpoint(source: String) {
        guard let recoveryStore else { return }
        do {
            var captured: WorkspaceDocumentPatch?
            if let basis = basisLedgers[accepted.contentRevision] {
                let admission = ArborMarkdownCodec.admission(blocks: document.children, ledger: basis, copies: copySources).0
                if admission.source.utf8.elementsEqual(source.utf8) {
                    captured = admission.patch
                    if !pendingTransactions.isEmpty { captured?.transactions = pendingTransactions }
                }
            }
            if let recoveryRevision, try recoveryStore.source(recoveryRevision) == source,
               recoveryRevision.baseRevision == accepted.contentRevision,
               try recoveryStore.base(recoveryRevision) == accepted.source,
               try (captured == nil || recoveryStore.intent(recoveryRevision)?.patch == captured),
               !recoveryStore.isSaved(recoveryRevision) || source == accepted.source { return }
            recoveryRevision = try recoveryStore.record(reference: reference, source: source, base: accepted, patch: captured)
            recoveryError = nil
        } catch { recoveryError = error }
    }

    private func markRecoverySaved(source: String) {
        guard let recoveryStore, let recoveryRevision else { return }
        do {
            guard try recoveryStore.source(recoveryRevision) == source else { return }
            if let transactions = try recoveryStore.intent(recoveryRevision)?.patch.transactions,
               !transactions.allSatisfy({ admittedTransactionIDs.contains($0.id) }) { return }
            try recoveryStore.markSaved(recoveryRevision)
            recoveryError = nil
        } catch { recoveryError = error }
    }

    private var recoveredIntent: WorkspaceDocumentIntent?
    private var recoveredLedger: ArborSourceLedger?

    private func restoreDraft(from store: EditorRecoveryStore, retainsBasis: Bool) throws {
        guard let record = try store.revisions().first, !store.isSaved(record) else { return }
        // Validate retained patches against their original basis before any recovery action.
        let retainedIntent = try store.intent(record)
        let source = try store.source(record)
        recoveryRevision = record
        if !retainsBasis, source == accepted.source {
            try store.markSaved(record)
            return
        }
        let baseSource = try store.base(record)
        let current = accepted
        if retainsBasis {
            recoveredIntent = retainedIntent
            pendingTransactions = retainedIntent?.patch.transactions ?? []
            accepted = .init(reference: record.reference, source: baseSource, contentRevision: record.baseRevision)
            machine.accepted = .init(source: baseSource, revision: record.baseRevision)
            snapshots[record.baseRevision] = accepted
        }
        let restored = ArborMarkdownCodec.open(source: source, revision: accepted.contentRevision,
                                               identitySeed: String(describing: reference.identity))
        ledger = restored.ledger
        if retainsBasis { recoveredLedger = restored.ledger }
        _ = document.replaceChildrenReconciled(restored.blocks)
        lastEnqueuedSource = source
        dispatch(.edit(source: source, preservesIntent: !(recoveredIntent?.patch.transactions ?? []).isEmpty || (recoveredIntent?.patch.edits.contains { !($0.lineage ?? []).isEmpty || !($0.copies ?? []).isEmpty } ?? false)))
        if retainsBasis, !(retainedIntent?.patch.transactions ?? []).isEmpty || retainedIntent?.patch.edits.contains(where: { !($0.copies ?? []).isEmpty }) == true {
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
        if machine.kind != priorPhase {
            do { try recoveryStore?.log(phase: machine.kind, generation: machine.generation, revision: recoveryRevision) }
            catch { recoveryError = error }
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
        case let .admit(generation, source, baseRevision, baseSource):
            let previous = admissionTask
            admissionTask = Task { @MainActor [self] in
                if let previous { await previous.value }
                await self.persist(source: source, generation: generation, baseRevision: baseRevision, baseSource: baseSource)
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

    func captureTransactionEvidence() {
        copySources.merge(document.blockCopiesForCurrentCommit) { _, newest in newest }
        guard admissionPolicy == .retainedBasis, let evidence = document.transactionForCurrentCommit else { return }
        let id = evidence.id.uuidString
        guard !admittedTransactionIDs.contains(id), !pendingTransactions.contains(where: { $0.id == id }) else { return }
        let basis = transactionLedger ?? ledger
        let (admission, next) = ArborMarkdownCodec.admission(blocks: document.children, ledger: basis, copies: document.blockCopiesForCurrentCommit)
        pendingTransactions.append(.init(id: id, basisSource: basis.source, source: admission.source,
            edits: admission.patch.edits, inverses: evidence.inverses.map(\.uuidString)))
        transactionLedger = next
    }

    func admitCurrentGeneration() {
        if basisLedgers[accepted.contentRevision] == nil, ledger.source.utf8.elementsEqual(accepted.source.utf8) {
            var basis = ledger; basis.revision = accepted.contentRevision
            basisLedgers[accepted.contentRevision] = basis
        }
        captureTransactionEvidence()
        authoredTransactions[machine.generation + 1] = pendingTransactions
        authoredCopies[machine.generation + 1] = copySources
        authoredBlocks[machine.generation + 1] = document.children
        let (admission, nextLedger) = ArborMarkdownCodec.admission(blocks: document.children, ledger: ledger, copies: copySources)
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
        checkpoint(source: admission.source)
        dispatch(.edit(source: admission.source, preservesIntent: !pendingTransactions.isEmpty || admission.patch.edits.contains { !($0.lineage ?? []).isEmpty || !($0.copies ?? []).isEmpty }))
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

    private func collectUndoHistory(closing: Bool = false) async {
        // A failed recovery checkpoint must keep all targets. Pending inverses
        // and authored predecessors are additionally pinned by the queue itself.
        guard recoveryError == nil else { return }
        var live = closing ? Set<String>() : Set(document.retainedUndoTransactionIDs.map(\.uuidString))
        for frame in pendingTransactions + authoredTransactions.values.flatMap({ $0 }) {
            live.insert(frame.id); live.formUnion(frame.inverses)
        }
        let expired = admittedTransactionIDs.subtracting(live).subtracting(releasedTransactionIDs)
        guard !expired.isEmpty else { return }
        do {
            try await session.releaseUndoTransactions(expired)
            releasedTransactionIDs.formUnion(expired)
        } catch { /* Collection is optional; a failed attempt leaves durable work intact. */ }
    }

    public func close() async {
        stopObserving()
        await flush()
        await collectUndoHistory(closing: true)
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
        if case let .failed(_, error, _) = machine.phase, error.retryable,
           pendingTransactions.contains(where: { !$0.inverses.isEmpty }),
           snapshot.contentRevision != accepted.contentRevision,
           snapshot.contentRevision != retriedUndoRevision {
            // Publication can finish after an offline undo returned its waiting
            // state. Retry the retained identities once per new observation.
            retriedUndoRevision = snapshot.contentRevision
            dispatch(.retry)
            return
        }
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

    private func persist(source: String, generation: Int, baseRevision: String, baseSource: String) async {
        var patch: WorkspaceDocumentPatch
        var authoredLedger: ArborSourceLedger?
        if let basis = basisLedgers[baseRevision], basis.source.utf8.elementsEqual(baseSource.utf8),
           let blocks = authoredBlocks[generation] {
            let (captured, next) = ArborMarkdownCodec.admission(blocks: blocks, ledger: basis, copies: authoredCopies[generation] ?? [:])
            guard captured.source.utf8.elementsEqual(source.utf8) else {
                pendingFailure = WorkspaceProviderError.invalidAction("Captured editor intent changed")
                dispatch(.admissionFailed(generation: generation, error: .init(message: "Captured editor intent changed", retryable: false)))
                return
            }
            patch = captured.patch; authoredLedger = next
        } else if let intent = recoveredIntent, intent.basis.contentRevision == baseRevision,
           intent.basis.source.utf8.elementsEqual(baseSource.utf8), intent.source.utf8.elementsEqual(source.utf8) {
            patch = intent.patch; authoredLedger = recoveredLedger
        } else {
            patch = ArborMarkdownCodec.patch(from: baseSource, to: source, revision: baseRevision)
        }
        let transactions = (authoredTransactions[generation] ?? patch.transactions ?? []).filter { !admittedTransactionIDs.contains($0.id) }
        if !transactions.isEmpty { patch.transactions = transactions }
        guard !patch.edits.isEmpty || !transactions.isEmpty else {
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
            let intent = try WorkspaceDocumentIntent(
                basis: .init(reference: reference, source: baseSource, contentRevision: baseRevision),
                patch: patch, source: source)
            let confirmed = try await session.admit(intent: intent)
            snapshots[confirmed.contentRevision] = confirmed
            if var next = authoredLedger, next.source.utf8.elementsEqual(confirmed.source.utf8) {
                next.revision = confirmed.contentRevision
                basisLedgers[confirmed.contentRevision] = next
            }
            admittedTransactionIDs.formUnion(transactions.map(\.id))
            // A reconciled projection may differ from the admitted draft. Its
            // receipt still settles these exact transaction identities.
            if !transactions.isEmpty { markRecoverySaved(source: source) }
            pendingTransactions.removeAll { admittedTransactionIDs.contains($0.id) }
            authoredTransactions = authoredTransactions.filter { $0.key > generation }
            authoredBlocks = authoredBlocks.filter { $0.key > generation }
            authoredCopies = authoredCopies.filter { $0.key > generation }
            finishAdmission(generation: generation, snapshot: confirmed)
            await collectUndoHistory()
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
            authoredBlocks.removeAll()
            authoredCopies.removeAll()
            authoredTransactions.removeAll()
            transactionLedger = nil
            copySources.removeAll()
            basisLedgers = basisLedgers.filter { $0.key == confirmed.contentRevision }
        }
    }
}
