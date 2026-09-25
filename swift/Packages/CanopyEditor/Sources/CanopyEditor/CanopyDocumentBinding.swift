import CanopyAppKit
import Overstory
import Foundation
import Observation
import OSLog
import Quagmire

/// Quagmire plumbing for an `EditorSource`.
///
/// Quagmire owns the block tree, undo grouping and the exact-source ledger.
/// Each committed generation is captured against the previous generation's
/// ledger, so its patch states exactly what the editor did, and is appended
/// through the `EditorSource` to the document session, which retains it in
/// its working tree's change log. The binding keeps the editor tree intact:
/// an acknowledgement of our own bytes advances the ledger without
/// reparsing, keystrokes Quagmire has not committed yet are never replaced,
/// and a live update is re-read through the session under an anchor.
@MainActor
@Observable
public final class CanopyDocumentBinding {
    private static let diagnosticLog = Logger(subsystem: "org.arbor.native", category: "EditorSource")
    private func trace(_ message: String) {
        Self.diagnosticLog.notice("tree=\(self.reference.tree.rawValue, privacy: .public) generation=\(self.generation) \(message, privacy: .public)")
    }

    public let document: Document
    public let editorState: EditorState
    public private(set) var reference: WorkspaceReference
    public private(set) var lastEnqueuedSource: String?
    public private(set) var acceptedTitle: String

    let session: any WorkspaceDocumentSession
    @ObservationIgnored private let source: EditorSource
    /// Ledgers of sources the editor has held, by revision, for mapping source ranges to blocks.
    private var basisLedgers: [String: CanopySourceLedger] = [:]
    /// The ledger each generation produced, until its append is durable.
    private var authoredLedgers: [Int: CanopySourceLedger] = [:]
    private var copySources: [BlockID: BlockID] = [:]
    private(set) var ledger: CanopySourceLedger
    private var updatesTask: Task<Void, Never>?
    private var directoryProjection: (directory: WorkspaceNode, children: [WorkspaceNode])?
    /// Mirrors of the source's state for observation.
    private var saving = false
    private var failure: (any Error)?

    /// Generations captured since the document opened.
    public private(set) var generation = 0
    /// True from the first captured generation until the latest one is durable.
    public var isSaving: Bool { saving }
    /// A failed append; its generations stay in the editor and are retried.
    public var lastError: (any Error)? { failure }

    /// Object hashes of ledger sources, by ledger revision; revisions are opaque.
    @ObservationIgnored private var sourceObjects: [String: String] = [:]

    /// The blocks, in document order, whose source overlaps `range` (UTF-8
    /// bytes) of the source stored as `object`. An empty range names the
    /// block ending at it, or the one it sits in. Nil when this editor holds
    /// no ledger for exactly that source or none of those blocks is still in
    /// the document: callers never guess a location.
    public func blocks(overlapping range: Range<Int>, inSource object: String) -> [BlockID]? {
        let ledgers = [ledger] + basisLedgers.values
        guard let basis = ledgers.first(where: { candidate in
            let hash = sourceObjects[candidate.revision] ?? ProtocolObjectCodec.hash(Data(candidate.source.utf8))
            sourceObjects[candidate.revision] = hash
            return hash == object
        }) else { return nil }
        let records = basis.records.values.filter { !$0.range.isEmpty && document.find($0.block.id) != nil }
        if range.isEmpty {
            // Removed material sat after the block ending at its anchor.
            let before = records.filter { $0.range.upperBound == range.lowerBound }.max { $0.depth < $1.depth }
            let within = records.filter { $0.range.contains(range.lowerBound) }.max { $0.depth < $1.depth }
            return (before ?? within).map { [$0.block.id] }
        }
        // A container and its first child can share a start; parents come first.
        let ordered = records.filter { $0.range.overlaps(range) }
            .sorted { ($0.range.lowerBound, $0.depth) < ($1.range.lowerBound, $1.depth) }
        return ordered.isEmpty ? nil : ordered.map(\.block.id)
    }

    /// Open the document as its session serves it. A working tree serves its
    /// newest unsettled change, so edits that were durable before a restart
    /// reopen exactly as they were left.
    public static func open(reference: WorkspaceReference, session: any WorkspaceDocumentSession) async throws -> CanopyDocumentBinding {
        let snapshot = try await session.snapshot()
        let binding = CanopyDocumentBinding(session: session, snapshot: snapshot)
        binding.trace("opened source=\(EditorSourceID.of(snapshot.source))")
        await binding.observeAuthoritativeUpdates()
        return binding
    }

    private init(session: any WorkspaceDocumentSession, snapshot: WorkspaceDocumentSnapshot) {
        self.reference = snapshot.reference
        self.session = session
        self.source = EditorSource(session: session, basis: snapshot)
        let opened = CanopyMarkdownCodec.open(
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
        self.basisLedgers[snapshot.contentRevision] = opened.ledger
        source.onAcknowledged = { [weak self] snapshot in self?.acknowledge(snapshot) }
        source.onFailure = { [weak self] error in
            self?.trace("append failed: \(String(describing: error))")
            self?.refreshState()
        }
    }

    /// The source Quagmire's current tree serializes to.
    private var mountedSource: String {
        CanopyMarkdownCodec.admission(blocks: document.children, ledger: ledger, copies: copySources).0.source
    }

    private func refreshState() {
        saving = !source.isSettled
        failure = source.failure
    }

    // MARK: Editor commits

    /// Undo is an ordinary edit: the editor keeps its own undo stack and each
    /// generation is captured as a plain patch. Only explicit copies are evidence.
    func captureTransactionEvidence() {
        copySources.merge(document.blockCopiesForCurrentCommit) { _, newest in newest }
    }

    /// Blocks a Move to Document has already moved out of this document's
    /// source. Quagmire removes them from the editor once the host returns;
    /// until then the editor's tree is not a generation to capture, and a
    /// keystroke meanwhile waits in the editor for the next capture.
    private var transferred: Set<BlockID> = []

    private var holdsTransferred: Bool {
        guard !transferred.isEmpty else { return false }
        func contains(_ blocks: [Block]) -> Bool { blocks.contains { transferred.contains($0.id) || contains($0.children) } }
        if contains(document.children) { return true }
        transferred.removeAll()
        return false
    }

    /// Move `roots` (subtrees of this document, in document order) to the end
    /// of `destination` as one change stating both documents. Nil when it
    /// cannot be stated that way (the provider, the source, or diverged local
    /// work), and nothing has changed; the caller falls back.
    public func transferBlocks(_ roots: [Block], into destination: any WorkspaceDocumentSession) async throws -> WorkspaceDocumentTransferResult? {
        await flush()
        if let failure = lastError { throw failure }
        guard source.isSettled, !holdsTransferred, ledger.source.utf8.elementsEqual(source.basis.source.utf8),
              mountedSource.utf8.elementsEqual(source.latestSource.utf8) else { return nil }
        let basis = source.basis
        let target = try await destination.snapshot()
        let opened = CanopyMarkdownCodec.open(source: target.source, revision: target.contentRevision,
                                              identitySeed: String(describing: target.reference.identity))
        // The editor may have moved on while the destination was read.
        guard source.isSettled, basis == source.basis, mountedSource.utf8.elementsEqual(source.latestSource.utf8),
              let planned = CanopyMarkdownCodec.transfer(roots, from: document.children, ledger: ledger, into: opened) else { return nil }
        let transfer = try WorkspaceDocumentTransfer(origin: basis, destination: target, moves: planned.moves, edits: planned.edits,
                                                     originSource: planned.originSource, destinationSource: planned.destinationSource)
        func ids(_ blocks: [Block]) -> [BlockID] { blocks.flatMap { [$0.id] + ids($0.children) } }
        transferred = Set(ids(roots))
        let result: WorkspaceDocumentTransferResult?
        do { result = try await source.session.admit(transfer: transfer) }
        catch { transferred.removeAll(); throw error }
        guard let result else { transferred.removeAll(); return nil }
        var next = planned.originLedger
        next.revision = result.origin.contentRevision
        ledger = next
        basisLedgers[result.origin.contentRevision] = next
        source.adopt(result.origin)
        trace("transferred \(roots.count) blocks to \(target.reference.path)")
        refreshState()
        return result
    }

    /// Adopt the session's current view as the next change's basis when it is
    /// exactly what the editor holds, as a live update with the same bytes
    /// does. A transfer retries on it after publication.
    public func adoptCurrentSnapshot() async {
        await flush()
        guard source.isSettled, lastError == nil, let current = try? await session.snapshot(),
              source.isSettled, current.contentRevision != source.basis.contentRevision,
              current.source.utf8.elementsEqual(ledger.source.utf8),
              mountedSource.utf8.elementsEqual(source.latestSource.utf8) else { return }
        ledger.revision = current.contentRevision
        basisLedgers[current.contentRevision] = ledger
        reference = current.reference
        source.adopt(current)
    }

    /// Capture the editor's current tree as one generation and append it.
    func appendCurrentGeneration() {
        guard !holdsTransferred else { return }
        captureTransactionEvidence()
        // The patch is captured against the previous generation's ledger,
        // exactly as the editor produced it; the change states it in its own
        // frame (docs/overstory-spec/09-client-synchronization.md §4).
        let (captured, nextLedger) = CanopyMarkdownCodec.admission(blocks: document.children, ledger: ledger, copies: copySources)
        ledger = nextLedger
        guard !captured.patch.isEmpty || !captured.source.utf8.elementsEqual(source.latestSource.utf8) else { return }
        generation += 1
        authoredLedgers[generation] = nextLedger
        lastEnqueuedSource = captured.source
        source.append(.init(patch: captured.patch, source: captured.source))
        refreshState()
        trace("captured source=\(EditorSourceID.of(captured.source)) edits=\(captured.patch.edits.count)")
    }

    /// Capture any uncommitted keystroke and wait until every generation is durable.
    public func flush() async {
        // Capture a final keystroke even if the editor's commit callback has
        // not run yet (navigation, backgrounding, or process termination).
        if mountedSource != source.latestSource { appendCurrentGeneration() }
        await source.settle()
        refreshState()
    }

    public func retryLastSave() async {
        guard lastError != nil else { return }
        if mountedSource != source.latestSource { appendCurrentGeneration() }
        source.retry()
        await flush()
    }

    public func snapshot() async throws -> WorkspaceDocumentSnapshot {
        await flush()
        return try await session.snapshot()
    }

    /// Append an exact host-authored source replacement, such as a structured
    /// frontmatter form, through the same durable path as an editor edit.
    public func replaceSource(_ replacement: String) async throws {
        await flush()
        if let error = lastError { throw error }
        let current = source.latestSource
        guard !replacement.utf8.elementsEqual(current.utf8) else { return }
        generation += 1
        // The editor shows the replacement at once, so the keystroke guard sees
        // no uncommitted input and the acknowledgement confirms without reparsing.
        let opened = CanopyMarkdownCodec.open(source: replacement, revision: source.basis.contentRevision,
                                             identitySeed: String(describing: reference.identity))
        let rebased = CanopyMarkdownCodec.rebased(opened, preserving: document.children)
        _ = document.replaceChildrenReconciled(rebased.blocks)
        ledger = rebased.ledger
        authoredLedgers[generation] = rebased.ledger
        lastEnqueuedSource = replacement
        source.append(.init(patch: .init(baseContentRevision: source.basis.contentRevision,
            edits: [.init(utf8Range: 0..<current.utf8.count, replacement: replacement, expected: current)]), source: replacement))
        refreshState()
        await source.settle()
        refreshState()
        if let error = lastError { throw error }
    }

    /// Project the directory's immediate children into the live editor without
    /// adding them to authored Markdown. Moving a projected row materializes
    /// it through Quagmire's ordinary block move transaction.
    public func projectDirectoryChildren(
        _ children: [WorkspaceNode],
        in directory: WorkspaceNode
    ) {
        directoryProjection = (directory, children)
        let projected = CanopyMarkdownCodec.placeDirectoryChildren(
            children,
            in: document.children,
            directory: directory.reference,
            sourceDirectory: directory.sourceDirectory
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

    // MARK: Authoritative replacement

    public func applyAcceptedReplacement(_ snapshot: WorkspaceDocumentSnapshot) async {
        await flush()
        applyAcceptedReplacementNow(snapshot)
        source.adopt(snapshot)
    }

    private func applyAcceptedReplacementNow(_ snapshot: WorkspaceDocumentSnapshot) {
        let opened = CanopyMarkdownCodec.open(
            source: snapshot.source,
            revision: snapshot.contentRevision,
            identitySeed: String(describing: snapshot.reference.identity)
        )
        let rebased = CanopyMarkdownCodec.rebased(opened, preserving: document.children)
        let replacement: [Block]
        if let directoryProjection {
            replacement = CanopyMarkdownCodec.placeDirectoryChildren(
                directoryProjection.children,
                in: rebased.blocks,
                directory: directoryProjection.directory.reference,
                sourceDirectory: directoryProjection.directory.sourceDirectory
            )
        } else {
            replacement = rebased.blocks
        }
        _ = document.replaceChildrenReconciled(replacement)
        reference = snapshot.reference
        ledger = rebased.ledger
        basisLedgers = [snapshot.contentRevision: rebased.ledger]
        acceptedTitle = document.title
        lastEnqueuedSource = nil
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
        let updates: AsyncThrowingStream<WorkspaceDocumentSnapshot, Error>
        do {
            updates = try await session.updates()
        } catch {
            trace("live updates unavailable: \(String(describing: error))")
            return
        }
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
                self?.trace("live updates ended: \(String(describing: error))")
            }
        }
    }

    private func receiveAuthoritativeUpdate(_ snapshot: WorkspaceDocumentSnapshot) async {
        guard snapshot.contentRevision != source.basis.contentRevision else { return }
        // Captured work reads its own writes when its append returns. A live
        // update never replaces it, and never replaces a keystroke Quagmire has
        // not committed yet: neither has reached the change log.
        guard source.isSettled, mountedSource == source.latestSource else { return }
        let anchor = (source.acknowledgements, generation)
        // Read through the session so read-your-writes holds; suspending here
        // is safe because the anchor discards a result an edit overtook.
        let current: WorkspaceDocumentSnapshot
        do {
            current = try await session.snapshot()
        } catch {
            trace("authoritative update not read: \(String(describing: error))")
            return
        }
        guard anchor == (source.acknowledgements, generation), source.isSettled,
              mountedSource == source.latestSource,
              current.contentRevision != source.basis.contentRevision else { return }
        if current.source.utf8.elementsEqual(source.latestSource.utf8) {
            // The same bytes under a new identity: advance without reparsing.
            ledger.revision = current.contentRevision
            basisLedgers[current.contentRevision] = ledger
            reference = current.reference
        } else {
            applyAcceptedReplacementNow(current)
        }
        source.adopt(current)
    }

    // MARK: Acknowledgement

    private func acknowledge(_ confirmed: WorkspaceDocumentSnapshot) {
        reference = confirmed.reference
        if let authored = authoredLedgers.first(where: { $0.value.source.utf8.elementsEqual(confirmed.source.utf8) })?.value {
            var basis = authored
            basis.revision = confirmed.contentRevision
            basisLedgers[confirmed.contentRevision] = basis
        }
        // A keystroke can precede Quagmire's commit callback while an append is
        // suspended. Capture it as a successor before an acknowledgement is
        // allowed to reconcile the editor.
        if mountedSource != source.latestSource { appendCurrentGeneration() }
        if source.isSettled {
            let mounted = CanopyMarkdownCodec.admission(blocks: document.children, ledger: ledger, copies: copySources).0
            if confirmed.source.utf8.elementsEqual(mounted.source.utf8) {
                // Self-confirmation: advance without reparsing or replacing so
                // focus, selection, typing and undo coalescing are undisturbed.
                ledger.source = confirmed.source
                ledger.revision = confirmed.contentRevision
            } else {
                // A session-returned transformation, or a host-authored
                // replacement: genuinely new content the editor must show.
                let opened = CanopyMarkdownCodec.open(
                    source: confirmed.source,
                    revision: confirmed.contentRevision,
                    identitySeed: String(describing: confirmed.reference.identity)
                )
                let rebased = CanopyMarkdownCodec.rebased(opened, preserving: document.children)
                ledger = rebased.ledger
                if rebased.blocks != document.children { _ = document.replaceChildrenReconciled(rebased.blocks) }
            }
            acceptedTitle = document.title
            authoredLedgers.removeAll()
            copySources.removeAll()
            basisLedgers = basisLedgers.filter { $0.key == confirmed.contentRevision }
        }
        refreshState()
    }
}

/// A short digest that names exact source bytes in diagnostics without logging them.
enum EditorSourceID {
    static func of(_ source: String) -> String { String(ProtocolObjectCodec.hash(Data(source.utf8)).suffix(12)) }
}
