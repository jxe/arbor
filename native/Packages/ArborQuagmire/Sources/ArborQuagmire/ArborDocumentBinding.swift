import ArborKit
import Foundation
import Observation
import Quagmire

@MainActor
@Observable
public final class ArborDocumentBinding {
    public let document: Document
    public let editorState: EditorState
    public private(set) var reference: WorkspaceReference
    public private(set) var lastError: Error?
    public private(set) var conflict: WorkspaceDocumentConflict?
    public private(set) var lastEnqueuedSource: String?
    public private(set) var isSaving = false
    public private(set) var acceptedTitle: String

    let session: any WorkspaceDocumentSession
    private var accepted: WorkspaceDocumentSnapshot
    private var ledger: ArborSourceLedger
    private var tail: Task<Void, Never>?
    private var updatesTask: Task<Void, Never>?
    private(set) var generation = 0

    public static func open(
        reference: WorkspaceReference,
        session: any WorkspaceDocumentSession
    ) async throws -> ArborDocumentBinding {
        let snapshot = try await session.snapshot()
        let binding = ArborDocumentBinding(reference: reference, session: session, snapshot: snapshot)
        await binding.observeAuthoritativeUpdates()
        return binding
    }

    private init(
        reference: WorkspaceReference,
        session: any WorkspaceDocumentSession,
        snapshot: WorkspaceDocumentSnapshot
    ) {
        self.reference = snapshot.reference
        self.session = session
        self.accepted = snapshot
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
    }

    func admitCurrentGeneration() {
        let (admission, nextLedger) = ArborMarkdownCodec.admission(blocks: document.children, ledger: ledger)
        lastEnqueuedSource = admission.source
        isSaving = true
        ledger = nextLedger
        generation += 1
        let admittedGeneration = generation
        let previous = tail
        tail = Task { @MainActor [self] in
            if let previous { await previous.value }
            await self.persist(source: admission.source, generation: admittedGeneration)
        }
    }

    public func flush() async {
        if let tail { await tail.value }
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

    public func resolveConflict(preferSubmitted: Bool) async throws {
        guard let conflict else { return }
        try await resolveConflict(source: preferSubmitted ? conflict.submittedSource : conflict.current.source)
    }

    public func resolveConflict(source: String) async throws {
        guard let conflict else { return }
        if source == conflict.current.source {
            await applyAcceptedReplacement(conflict.current)
        } else {
            // Do not replace the live editor until the chosen resolution is
            // durable. A failed retry must leave both the editor tree and its
            // recoverable conflict evidence intact.
            do {
                let admitted = try await session.admit(
                    source: source,
                    baseContentRevision: conflict.current.contentRevision
                )
                await applyAcceptedReplacement(admitted)
            } catch let updated as WorkspaceDocumentConflict {
                var enriched = updated
                if enriched.base == nil { enriched.base = conflict.current }
                self.conflict = enriched
                lastError = enriched
                throw enriched
            } catch {
                lastError = error
                throw error
            }
        }
    }

    public func applyAcceptedReplacement(_ snapshot: WorkspaceDocumentSnapshot) async {
        await flush()
        applyAcceptedReplacementNow(snapshot)
    }

    private func applyAcceptedReplacementNow(_ snapshot: WorkspaceDocumentSnapshot) {
        let opened = ArborMarkdownCodec.open(
            source: snapshot.source,
            revision: snapshot.contentRevision,
            identitySeed: String(describing: snapshot.reference.identity)
        )
        let rebased = ArborMarkdownCodec.rebased(opened, preserving: document.children)
        _ = document.replaceChildrenReconciled(rebased.blocks)
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
        guard snapshot.contentRevision != accepted.contentRevision else { return }
        await flush()
        guard conflict == nil, lastError == nil, !isSaving else { return }
        // Quagmire can contain a keystroke or newly inserted block before its
        // commit callback has entered the admission queue. An incoming watch
        // transition must not replace that dirty tree: doing so loses text
        // before ArborSync has any durable candidate from which to recover it.
        let currentAdmission = ArborMarkdownCodec.admission(blocks: document.children, ledger: ledger).0
        guard currentAdmission.source == accepted.source else { return }
        let observedGeneration = generation
        let observedAcceptedRevision = accepted.contentRevision
        let observedAcceptedSource = accepted.source
        guard let current = try? await session.snapshot(),
              current.contentRevision != observedAcceptedRevision else { return }
        // Fetching the authoritative snapshot suspends this MainActor task. A
        // later local commit or keystroke may have arrived while it was away.
        // Revalidate immediately before the non-suspending replacement so an
        // accepted prefix can never overwrite a newer editor generation.
        guard generation == observedGeneration,
              accepted.contentRevision == observedAcceptedRevision,
              accepted.source == observedAcceptedSource,
              conflict == nil,
              lastError == nil,
              !isSaving else { return }
        let latestAdmission = ArborMarkdownCodec.admission(blocks: document.children, ledger: ledger).0
        guard latestAdmission.source == observedAcceptedSource else { return }
        applyAcceptedReplacementNow(current)
    }

    private func persist(source: String, generation admittedGeneration: Int) async {
        do {
            let patch = ArborMarkdownCodec.patch(
                from: accepted.source,
                to: source,
                revision: accepted.contentRevision
            )
            // Quagmire may report a follow-up commit after the authored source
            // is already current (for example, after splitting a block). It is
            // saved by definition and must not become an empty provider write.
            guard !patch.edits.isEmpty else {
                conflict = nil
                lastError = nil
                if admittedGeneration == generation { isSaving = false }
                return
            }
            accept(try await session.admit(patch: patch), submittedSource: source, generation: admittedGeneration)
        } catch let value as WorkspaceDocumentConflict {
            if value.current.source == source {
                accept(value.current, submittedSource: source, generation: admittedGeneration)
            } else {
                var enriched = value
                if enriched.base == nil { enriched.base = accepted }
                conflict = enriched
                lastError = enriched
                if admittedGeneration == generation { isSaving = false }
            }
        } catch let value as WorkspacePatchError {
            guard case .staleRevision = value else {
                lastError = value
                if admittedGeneration == generation { isSaving = false }
                return
            }
            do {
                let current = try await session.snapshot()
                if current.source == source {
                    // A durable provider write can win the race with its local
                    // acknowledgement. Exact bytes are an idempotent success.
                    accept(current, submittedSource: source, generation: admittedGeneration)
                } else {
                    let conflict = WorkspaceDocumentConflict(base: accepted, current: current, submittedSource: source)
                    self.conflict = conflict
                    lastError = conflict
                    if admittedGeneration == generation { isSaving = false }
                }
            } catch {
                lastError = error
                if admittedGeneration == generation { isSaving = false }
            }
        } catch {
            lastError = error
            if admittedGeneration == generation { isSaving = false }
        }
    }

    private func accept(
        _ confirmed: WorkspaceDocumentSnapshot,
        submittedSource source: String,
        generation admittedGeneration: Int
    ) {
        accepted = confirmed
        reference = confirmed.reference
        if admittedGeneration == generation {
            if confirmed.source == source {
                // This is the provider acknowledging the exact local tree
                // already mounted in Quagmire. Advance source authority
                // without reparsing/replacing it: a self-confirmation must
                // not disturb focus, selection, typing, or undo coalescing.
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
        if admittedGeneration == generation { isSaving = false }
    }
}
