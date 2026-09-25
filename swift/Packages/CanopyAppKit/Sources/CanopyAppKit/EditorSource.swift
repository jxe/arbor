import Foundation

/// An editor as a source of local changes.
///
/// There is no state machine between an editor and its working tree. Each
/// generation the editor commits is appended to the document session, whose
/// working tree retains it durably in its change log; the generation is
/// acknowledged once that append returns. Publication is the update machine's
/// business, not the editor's.
///
/// Appends are serialized. Generations captured while an append is in flight
/// wait and go out together as one change with one frame per generation, each
/// stated against the basis the previous append returned, so nothing is
/// re-derived against an older basis. A failed append keeps its generations
/// in memory and reports the failure; `retry()` or the next generation sends
/// them again with the same basis.
@MainActor
public final class EditorSource {
    public let session: any WorkspaceDocumentSession
    /// The latest durable snapshot: what the next change is authored against.
    public private(set) var basis: WorkspaceDocumentSnapshot
    /// Generations captured since `basis`, each patch relative to its predecessor's source.
    public private(set) var pending: [WorkspaceDocumentGeneration] = []
    /// Generations in the append now on its way to the working tree.
    public private(set) var appending: [WorkspaceDocumentGeneration] = []
    public private(set) var failure: (any Error)?
    /// Durable appends so far; an anchor for work that must not race one.
    public private(set) var acknowledgements = 0
    /// Called after each durable append with the snapshot it returned.
    public var onAcknowledged: ((WorkspaceDocumentSnapshot) -> Void)?
    /// Called when an append fails; its generations are kept for `retry()`.
    public var onFailure: ((any Error) -> Void)?
    private var task: Task<Void, Never>?
    private var waiters: [CheckedContinuation<Void, Never>] = []

    public init(session: any WorkspaceDocumentSession, basis: WorkspaceDocumentSnapshot) {
        self.session = session
        self.basis = basis
    }

    /// No generation waits and no append is in flight.
    public var isSettled: Bool { pending.isEmpty && appending.isEmpty }
    /// The source of the newest captured generation.
    public var latestSource: String { pending.last?.source ?? appending.last?.source ?? basis.source }

    /// Capture one generation; `patch` takes `latestSource` to `generation.source`.
    public func append(_ generation: WorkspaceDocumentGeneration) {
        guard !generation.patch.isEmpty || !generation.source.utf8.elementsEqual(latestSource.utf8) else { return }
        pending.append(generation)
        if failure == nil { next() }
    }

    /// Send generations kept after a failed append again.
    public func retry() {
        failure = nil
        next()
    }

    /// Wait until every captured generation is durable, or an append fails.
    public func settle() async {
        while !(isSettled || (task == nil && failure != nil)) {
            await withCheckedContinuation { waiters.append($0) }
        }
    }

    /// Adopt `snapshot` as the basis of the next change. Only a settled source
    /// adopts: captured work keeps the basis it was authored against.
    public func adopt(_ snapshot: WorkspaceDocumentSnapshot) {
        guard isSettled else { return }
        basis = snapshot
    }

    private func next() {
        guard task == nil, failure == nil, !pending.isEmpty else { return resume() }
        let batch = pending
        pending = []
        appending = batch
        let intent: WorkspaceDocumentIntent
        do { intent = try Self.intent(basis: basis, generations: batch) } catch {
            appending = []
            pending = batch + pending
            failure = error
            return resume()
        }
        // The task keeps the source alive: an append the editor started
        // completes even if the editor is dropped before it returns.
        task = Task { @MainActor in
            do {
                let acknowledged = try await self.session.admit(intent: intent)
                self.basis = acknowledged
                self.appending = []
                self.acknowledgements += 1
                self.task = nil
                self.onAcknowledged?(acknowledged)
            } catch {
                self.pending = self.appending + self.pending
                self.appending = []
                self.failure = error
                self.task = nil
                self.onFailure?(error)
            }
            self.next()
        }
    }

    private func resume() {
        guard task == nil else { return }
        let waiting = waiters
        waiters = []
        for waiter in waiting { waiter.resume() }
    }

    /// One change for `generations` against `basis`. A chain whose patches
    /// replay exactly carries one frame per generation; otherwise the change
    /// states the exact bytes as one replacement.
    static func intent(basis: WorkspaceDocumentSnapshot, generations: [WorkspaceDocumentGeneration]) throws -> WorkspaceDocumentIntent {
        guard let final = generations.last?.source else { throw WorkspaceProviderError.invalidAction("Empty change") }
        var chain: [WorkspaceDocumentGeneration] = []
        var previous = basis.source
        var replays = true
        for generation in generations {
            var patch = generation.patch
            patch.baseContentRevision = basis.contentRevision
            guard let produced = try? patch.applying(to: previous), produced.utf8.elementsEqual(generation.source.utf8) else {
                replays = false
                break
            }
            if !patch.isEmpty { chain.append(.init(patch: patch, source: generation.source)) }
            previous = generation.source
        }
        let whole = WorkspaceDocumentPatch(baseContentRevision: basis.contentRevision, edits: [
            .init(utf8Range: 0..<basis.source.utf8.count, replacement: final, expected: basis.source),
        ])
        guard replays, !chain.isEmpty else {
            return try WorkspaceDocumentIntent(basis: basis, patch: whole, source: final)
        }
        if chain.count == 1 { return try WorkspaceDocumentIntent(basis: basis, patch: chain[0].patch, source: final) }
        // Moves do not compose; such a chain states its bytes as one replacement.
        let composed = chain.contains(where: { $0.patch.moves != nil }) ? nil : (try? WorkspaceSourceEdit.compose(generations: chain.map(\.patch.edits)))
            .map { WorkspaceDocumentPatch(baseContentRevision: basis.contentRevision, edits: $0) }
        let patch = composed.flatMap { (try? $0.applying(to: basis.source))?.utf8.elementsEqual(final.utf8) == true ? $0 : nil } ?? whole
        return try WorkspaceDocumentIntent(basis: basis, patch: patch, source: final, generations: chain)
    }
}
