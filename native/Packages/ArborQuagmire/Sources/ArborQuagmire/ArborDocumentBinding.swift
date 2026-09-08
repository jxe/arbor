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
    public private(set) var lastError: Error?
    public private(set) var conflict: WorkspaceDocumentConflict?
    public private(set) var lastEnqueuedSource: String?
    public private(set) var acceptedTitle: String

    let session: any WorkspaceDocumentSession
    private var accepted: WorkspaceDocumentSnapshot
    private var ledger: ArborSourceLedger
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
    private var directoryProjection: (reference: WorkspaceReference, children: [WorkspaceNode])?

    public var generation: Int { machine.generation }
    /// True from the first uncommitted authored generation until Arbor Sync acknowledges the latest one.
    public var isSaving: Bool { !machine.isSettled }
    /// The machine state, for lifecycle callers and tests.
    public var admissionState: DocumentAdmissionMachine.State { machine }

    public static func open(
        reference: WorkspaceReference,
        session: any WorkspaceDocumentSession,
        debounce: Duration = DocumentAdmissionMachine.debounce
    ) async throws -> ArborDocumentBinding {
        let snapshot = try await session.snapshot()
        let binding = ArborDocumentBinding(reference: reference, session: session, snapshot: snapshot, debounce: debounce)
        await binding.observeAuthoritativeUpdates()
        return binding
    }

    private init(
        reference: WorkspaceReference,
        session: any WorkspaceDocumentSession,
        snapshot: WorkspaceDocumentSnapshot,
        debounce: Duration
    ) {
        self.reference = snapshot.reference
        self.session = session
        self.accepted = snapshot
        self.debounce = debounce
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
            accepted: .init(source: snapshot.source, revision: snapshot.contentRevision, admissionBasis: snapshot.admissionBasis),
            transport: snapshot.admissionBasis == nil ? .local : .canopy
        )
        self.snapshots[snapshot.contentRevision] = snapshot
    }

    // MARK: Machine

    private func dispatch(_ event: DocumentAdmissionMachine.Event) {
        let (next, effects) = DocumentAdmissionMachine.reduce(machine, event, debounce: debounce)
        machine = next
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
        case let .admit(generation, source, baseRevision, _):
            let previous = admissionTask
            admissionTask = Task { @MainActor [self] in
                if let previous { await previous.value }
                await self.persist(source: source, generation: generation, baseRevision: baseRevision)
            }
        case let .acknowledge(result):
            acknowledge(result)
        case let .apply(_, revision):
            guard let snapshot = snapshots[revision] else { return }
            applyAcceptedReplacementNow(snapshot)
        case .mergeLocally, .surfaceConflict:
            // Native Arbor never merges a document locally: the conflict is
            // client-owned evidence until the user chooses a resolution.
            conflict = pendingConflict
            lastError = pendingConflict
        case let .surfaceFailure(failure):
            lastError = pendingFailure ?? NSError(domain: "ArborDocumentBinding", code: 1, userInfo: [NSLocalizedDescriptionKey: failure.message])
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

    func admitCurrentGeneration() {
        let (admission, nextLedger) = ArborMarkdownCodec.admission(blocks: document.children, ledger: ledger)
        lastEnqueuedSource = admission.source
        ledger = nextLedger
        conflict = nil
        lastError = nil
        dispatch(.edit(source: admission.source))
    }

    /// Force the latest authored generation through and await local durability.
    public func flush() async {
        dispatch(.flush)
        await settle()
        try? await session.flush()
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
        return try await session.history()
    }

    @discardableResult
    public func recover(revision: String) async throws -> WorkspaceDocumentSnapshot {
        await flush()
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
            snapshots[conflict.current.contentRevision] = conflict.current
            dispatch(.resolveConflict(keepSubmitted: false))
            return
        }
        // The chosen source becomes the latest generation and is resubmitted
        // against the verified current revision. The editor is replaced only
        // when the provider acknowledges it; a failed retry leaves both the
        // editor tree and the recoverable conflict evidence intact.
        lastError = nil
        dispatch(.edit(source: source))
        dispatch(.resolveConflict(keepSubmitted: true))
        await settle()
        if let error = lastError { throw error }
    }

    // MARK: Authoritative replacement

    public func applyAcceptedReplacement(_ snapshot: WorkspaceDocumentSnapshot) async {
        await flush()
        applyAcceptedReplacementNow(snapshot)
        machine.accepted = .init(source: snapshot.source, revision: snapshot.contentRevision, admissionBasis: snapshot.admissionBasis)
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
        conflict = nil
        lastError = nil
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
        let incorporatesWaitingDigest: Bool
        if case let .admittedAwaitingAuthority(digest) = machine.phase {
            incorporatesWaitingDigest = snapshot.acceptedRequestDigests.contains(digest)
        } else {
            incorporatesWaitingDigest = false
        }
        if snapshot.contentRevision == accepted.contentRevision {
            // Same revision: at most this clears the editor's digest fence.
            snapshots[snapshot.contentRevision] = snapshot
            dispatch(.observed(observation: Self.observation(snapshot), anchor: nil))
            return
        }
        // Quagmire can contain a keystroke or newly inserted block before its
        // commit callback has entered the machine. An incoming transition must
        // not replace that dirty tree: the machine has no generation for it yet.
        let currentAdmission = ArborMarkdownCodec.admission(blocks: document.children, ledger: ledger).0
        guard currentAdmission.source == machine.accepted.source else { return }
        let anchor = machine.anchor
        let current: WorkspaceDocumentSnapshot
        if incorporatesWaitingDigest {
            current = snapshot
        } else {
            // Read through the provider so read-your-writes holds; suspending
            // here is safe because the anchor discards a stale result.
            guard let refreshed = try? await session.snapshot() else { return }
            current = refreshed
        }
        snapshots[current.contentRevision] = current
        dispatch(.observed(observation: Self.observation(current), anchor: anchor))
    }

    private static func observation(_ snapshot: WorkspaceDocumentSnapshot) -> DocumentAdmissionMachine.Observation {
        .init(
            source: snapshot.source,
            revision: snapshot.contentRevision,
            admissionBasis: snapshot.admissionBasis,
            acceptedRequestDigests: snapshot.acceptedRequestDigests
        )
    }

    // MARK: Admission transport

    private func persist(source: String, generation: Int, baseRevision: String) async {
        let patch = ArborMarkdownCodec.patch(from: machine.accepted.source, to: source, revision: baseRevision)
        guard !patch.edits.isEmpty else {
            // Quagmire may report a follow-up commit after the authored source
            // is already current. It is saved by definition.
            dispatch(.admitted(generation: generation, result: Self.result(accepted, requestDigest: nil)))
            return
        }
        do {
            let confirmed = try await session.admit(patch: patch)
            snapshots[confirmed.contentRevision] = confirmed
            dispatch(.admitted(generation: generation, result: Self.result(confirmed, requestDigest: confirmed.admissionRequestDigest)))
        } catch let value as WorkspaceDocumentConflict {
            if value.current.source == source {
                snapshots[value.current.contentRevision] = value.current
                dispatch(.admitted(generation: generation, result: Self.result(value.current, requestDigest: value.current.admissionRequestDigest)))
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
            do {
                let current = try await session.snapshot()
                snapshots[current.contentRevision] = current
                if current.source == source {
                    // A durable provider write can win the race with its local
                    // acknowledgement. Exact bytes are an idempotent success.
                    dispatch(.admitted(generation: generation, result: Self.result(current, requestDigest: current.admissionRequestDigest)))
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

    private static func result(_ snapshot: WorkspaceDocumentSnapshot, requestDigest: String?) -> DocumentAdmissionMachine.Result {
        .init(
            source: snapshot.source,
            revision: snapshot.contentRevision,
            admissionBasis: snapshot.admissionBasis,
            requestDigest: requestDigest
        )
    }

    private func acknowledge(_ result: DocumentAdmissionMachine.Result) {
        guard let confirmed = snapshots[result.revision] else { return }
        accepted = confirmed
        reference = confirmed.reference
        // A retained successor means the editor already holds newer content;
        // only source authority advances. Otherwise the acknowledgement
        // describes the tree mounted in Quagmire.
        var newerRetained = false
        if case .submitting = machine.phase { newerRetained = true }
        if !newerRetained {
            let mounted = ArborMarkdownCodec.admission(blocks: document.children, ledger: ledger).0
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
        lastError = nil
        pendingConflict = nil
        pendingFailure = nil
    }
}
