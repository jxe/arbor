import StoryKit
import Overstory
import Foundation
import Observation
import OSLog
import Quagmire

/// A source change acknowledged by local storage, independently of publication.
public struct StoryLocalRetention: Sendable {
    public let reference: WorkspaceReference
    public let title: String
    public let source: String
    public let retainedAt: Date

    public init(reference: WorkspaceReference, title: String, source: String, retainedAt: Date) {
        self.reference = reference
        self.title = title
        self.source = source
        self.retainedAt = retainedAt
    }
}

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
public final class StoryDocumentBinding {
    private static let diagnosticLog = Logger(subsystem: "org.arbor.native", category: "EditorSource")
    private func trace(_ message: String) {
        Self.diagnosticLog.notice("tree=\(self.reference.tree.rawValue, privacy: .public) generation=\(self.generation) \(message, privacy: .public)")
    }

    public let document: Document
    public let editorState: EditorState
    public private(set) var reference: WorkspaceReference
    public private(set) var lastEnqueuedSource: String?
    public private(set) var acceptedTitle: String
    public var onLocalRetention: ((StoryLocalRetention) -> Void)?

    let session: any WorkspaceDocumentSession
    @ObservationIgnored private let source: EditorSource
    /// Ledgers of sources the editor has held, by revision, for mapping source ranges to blocks.
    private var basisLedgers: [String: StorySourceLedger] = [:]
    /// The ledger each generation produced, until its append is durable.
    private var authoredLedgers: [Int: StorySourceLedger] = [:]
    private var copySources: [BlockID: BlockID] = [:]
    private(set) var ledger: StorySourceLedger
    private var updatesTask: Task<Void, Never>?
    private var directoryProjection: (directory: WorkspaceNode, children: [WorkspaceNode])?
    @ObservationIgnored private var presentationTask: Task<Void, Never>?
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
    public static func open(reference: WorkspaceReference, session: any WorkspaceDocumentSession) async throws -> StoryDocumentBinding {
        let snapshot = try await session.snapshot()
        let binding = StoryDocumentBinding(session: session, snapshot: snapshot)
        binding.trace("opened source=\(EditorSourceID.of(snapshot.source))")
        await binding.observeAuthoritativeUpdates()
        return binding
    }

    private init(session: any WorkspaceDocumentSession, snapshot: WorkspaceDocumentSnapshot) {
        self.reference = snapshot.reference
        self.session = session
        self.source = EditorSource(session: session, basis: snapshot)
        let opened = StoryMarkdownCodec.open(
            source: snapshot.source,
            revision: snapshot.contentRevision,
            identitySeed: String(describing: snapshot.reference.identity)
        )
        self.ledger = opened.ledger
        let document = Document(
            id: DocumentID(String(describing: snapshot.reference.identity)),
            children: StoryPagePresentation.present(opened.blocks, path: snapshot.reference.path, directory: nil),
            fallbackTitle: snapshot.reference.path.split(separator: "/").last.map(String.init)
        )
        self.document = document
        self.acceptedTitle = Self.authoredTitle(of: document)
        self.editorState = EditorState()
        self.basisLedgers[snapshot.contentRevision] = opened.ledger
        source.onAcknowledged = { [weak self] snapshot in self?.acknowledge(snapshot) }
        source.onFailure = { [weak self] error in
            self?.trace("append failed: \(String(describing: error))")
            self?.refreshState()
        }
    }

    /// The page's title as its source states it. A presented title names the
    /// node already, so it never proposes a rename.
    private static func authoredTitle(of document: Document) -> String {
        Document.deriveTitle(from: StoryPagePresentation.authored(document.children), fallback: document.fallbackTitle ?? "Untitled")
    }

    // MARK: Presentation

    /// `blocks` (authored, or this editor's edited tree) as the page shows them.
    private func presented(_ blocks: [Block]) -> [Block] {
        StoryPagePresentation.present(blocks, path: reference.path, directory: directoryProjection.map {
            .init(children: $0.children, reference: $0.directory.reference, sourceDirectory: $0.directory.sourceDirectory)
        })
    }

    /// Show the page as its current source presents it. Source is unchanged:
    /// a presented heading that was removed or moved comes back, one that was
    /// edited is from now on an authored block, and one that is no longer
    /// called for (an authored first H1, a marker, every child linked) goes.
    func represent() {
        presentationTask?.cancel()
        presentationTask = nil
        guard !holdsTransferred else { return }
        let next = presented(document.children)
        if next != document.children { _ = document.replaceChildrenReconciled(next) }
    }

    /// Re-present once the editor's commit has returned: the tree is replaced
    /// outside Quagmire's transaction, never from inside its commit callback.
    private func representAfterCommit() {
        guard presentationTask == nil else { return }
        presentationTask = Task { @MainActor [weak self] in
            guard let self, !Task.isCancelled else { return }
            self.presentationTask = nil
            self.represent()
        }
    }

    /// The source Quagmire's current tree serializes to.
    private var mountedSource: String {
        StoryMarkdownCodec.admission(blocks: document.children, ledger: ledger, copies: copySources).0.source
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
    /// work), and nothing has changed; the caller falls back. `relink` names
    /// the two pages' source directories when they differ, so the moved
    /// source's relative links are rewritten to lead where they did.
    public func transferBlocks(_ roots: [Block], into destination: any WorkspaceDocumentSession,
                               relink: (from: String, to: String)? = nil) async throws -> WorkspaceDocumentTransferResult? {
        try await transferBlocks(roots, into: destination, landing: nil, relink: relink)
    }

    /// Where a move lands in a page open in another editor: that page's
    /// authored tree once the blocks are dropped, and the ledger of the source
    /// that editor holds. See `landing(of:at:)`.
    struct TransferLanding {
        var blocks: [Block]
        var ledger: StorySourceLedger
    }

    /// As `transferBlocks(_:into:relink:)`, landing where `landing` places the
    /// roots instead of at the end, when the destination still holds the
    /// source that landing was read from.
    func transferBlocks(_ roots: [Block], into destination: any WorkspaceDocumentSession, landing: TransferLanding?,
                        relink: (from: String, to: String)? = nil) async throws -> WorkspaceDocumentTransferResult? {
        await flush()
        if let failure = lastError { throw failure }
        guard source.isSettled, !holdsTransferred, ledger.source.utf8.elementsEqual(source.basis.source.utf8),
              mountedSource.utf8.elementsEqual(source.latestSource.utf8) else { return nil }
        let basis = source.basis
        let target = try await destination.snapshot()
        let opened = StoryMarkdownCodec.open(source: target.source, revision: target.contentRevision,
                                              identitySeed: String(describing: target.reference.identity))
        // The editor may have moved on while the destination was read.
        guard source.isSettled, basis == source.basis, mountedSource.utf8.elementsEqual(source.latestSource.utf8) else { return nil }
        let planned: StoryMarkdownCodec.PlannedTransfer?
        if let landing {
            guard landing.ledger.source.utf8.elementsEqual(target.source.utf8) else { return nil }
            planned = StoryMarkdownCodec.transfer(roots, from: document.children, ledger: ledger, into: landing.ledger,
                                                  landing: landing.blocks, relink: relink)
        } else {
            planned = StoryMarkdownCodec.transfer(roots, from: document.children, ledger: ledger, into: opened, relink: relink)
        }
        guard let planned else { return nil }
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

    // MARK: Receiving dragged blocks

    /// A page open here is receiving blocks dragged from another editor.
    /// While a transfer into it is in flight its live updates are held; once
    /// the transfer lands, the editor inserts the same blocks itself and the
    /// next capture adopts the transferred source rather than stating them
    /// again. Copies carry their sources' records until they are captured.
    private enum Receipt {
        case pending
        case landed(WorkspaceDocumentSnapshot)
    }
    private var receipt: Receipt?
    private var receivedCopies: [BlockID: (record: SourceRecord, document: WorkspaceCopyDocument)] = [:]

    /// The authored tree this page has once `roots` are inserted at `path`
    /// of the editor's tree, with the ledger of the source it holds now. Nil
    /// while the editor holds work that is not yet durable.
    func landing(of roots: [Block], at path: DropPath) async -> TransferLanding? {
        await flush()
        guard lastError == nil, receipt == nil, source.isSettled, !holdsTransferred,
              ledger.source.utf8.elementsEqual(source.basis.source.utf8),
              mountedSource.utf8.elementsEqual(source.latestSource.utf8) else { return nil }
        func inserting(_ blocks: [Block]) -> [Block]? {
            guard let parent = path.parent else {
                var value = blocks
                value.insert(contentsOf: roots, at: max(0, min(path.position, value.count)))
                return value
            }
            var found = false
            func visit(_ values: [Block]) -> [Block] {
                values.map { block in
                    var value = block
                    if block.id == parent {
                        found = true
                        value.children.insert(contentsOf: roots, at: max(0, min(path.position, value.children.count)))
                    } else if !found {
                        value.children = visit(block.children)
                    }
                    return value
                }
            }
            let result = visit(blocks)
            return found ? result : nil
        }
        guard let presented = inserting(document.children) else { return nil }
        return TransferLanding(blocks: StoryPagePresentation.authored(presented), ledger: ledger)
    }

    /// Hold live updates while a transfer into this page is in flight.
    func expectReceipt() { receipt = .pending }

    /// The transfer landed as `snapshot`, or failed (nil).
    func completeReceipt(_ snapshot: WorkspaceDocumentSnapshot?) {
        receipt = snapshot.map(Receipt.landed)
    }

    /// The editor is about to insert copies of another page's blocks: their
    /// source records, so the capture states them as copies.
    func expectCopies(_ copies: [BlockID: (record: SourceRecord, document: WorkspaceCopyDocument)]) {
        receivedCopies.merge(copies) { _, newest in newest }
    }

    /// Adopt a landed transfer as this editor's basis. When the editor already
    /// shows exactly the landed source (it inserted the moved blocks), nothing
    /// is captured. When it shows that and more, the rest is captured on top.
    /// Otherwise the landed source replaces the editor's tree.
    private func adoptReceipt() -> Bool {
        guard case let .landed(snapshot)? = receipt else { return false }
        receipt = nil
        let opened = StoryMarkdownCodec.open(source: snapshot.source, revision: snapshot.contentRevision,
                                             identitySeed: String(describing: snapshot.reference.identity), reusing: ledger.parsedKinds)
        let rebased = StoryMarkdownCodec.rebased(opened, preserving: document.children)
        var shown = Set<BlockID>()
        func collect(_ blocks: [Block]) { for block in blocks { shown.insert(block.id); collect(block.children) } }
        collect(document.children)
        reference = snapshot.reference
        source.adopt(snapshot)
        guard rebased.ledger.records.keys.allSatisfy(shown.contains) else {
            trace("received transfer replaces the editor tree")
            applyAcceptedReplacementNow(snapshot)
            return true
        }
        ledger = rebased.ledger
        basisLedgers = [snapshot.contentRevision: rebased.ledger]
        acceptedTitle = Self.authoredTitle(of: document)
        trace("adopted received transfer source=\(EditorSourceID.of(snapshot.source))")
        return false
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
        if case .pending? = receipt { return }
        if adoptReceipt() { return }
        // Presented headings cannot be deleted or moved, and an edit can call
        // for one or retire one, so every commit is followed by presentation.
        representAfterCommit()
        captureTransactionEvidence()
        // The patch is captured against the previous generation's ledger,
        // exactly as the editor produced it; the change states it in its own
        // frame (docs/overstory-spec/09-client-synchronization.md §4).
        let shown = receivedCopies.filter { document.find($0.key) != nil }
        let (captured, nextLedger) = StoryMarkdownCodec.admission(blocks: document.children, ledger: ledger, copies: copySources,
                                                                  moved: document.movedBlocksForCurrentCommit, foreignCopies: shown)
        if !shown.isEmpty { receivedCopies = [:] }
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
        if case .landed? = receipt { appendCurrentGeneration() }
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
        let opened = StoryMarkdownCodec.open(source: replacement, revision: source.basis.contentRevision,
                                             identitySeed: String(describing: reference.identity), reusing: ledger.parsedKinds)
        let rebased = StoryMarkdownCodec.rebased(opened, preserving: document.children)
        _ = document.replaceChildrenReconciled(presented(rebased.blocks))
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

    /// Present the directory's immediate children in the live editor without
    /// adding them to authored Markdown. Moving a generated row materializes
    /// it through Quagmire's ordinary block move transaction.
    public func projectDirectoryChildren(
        _ children: [WorkspaceNode],
        in directory: WorkspaceNode
    ) {
        directoryProjection = (directory, children)
        represent()
    }

    /// Reconcile a provider-authored path change for this stable identity
    /// without replacing the live editor tree.
    public func reconcileReference(_ reference: WorkspaceReference) {
        guard reference.identity == self.reference.identity else { return }
        self.reference = reference
        document.fallbackTitle = reference.path.split(separator: "/").last.map(String.init)
        // A presented title names the node.
        represent()
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
        let opened = StoryMarkdownCodec.open(
            source: snapshot.source,
            revision: snapshot.contentRevision,
            identitySeed: String(describing: snapshot.reference.identity),
            reusing: ledger.parsedKinds
        )
        let rebased = StoryMarkdownCodec.rebased(opened, preserving: document.children)
        reference = snapshot.reference
        _ = document.replaceChildrenReconciled(presented(rebased.blocks))
        ledger = rebased.ledger
        basisLedgers = [snapshot.contentRevision: rebased.ledger]
        acceptedTitle = Self.authoredTitle(of: document)
        lastEnqueuedSource = nil
    }

    public func close() async {
        stopObserving()
        await flush()
        await session.close()
    }

    func stopObserving() {
        presentationTask?.cancel()
        presentationTask = nil
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
        // A received transfer is adopted when the editor inserts its blocks.
        guard receipt == nil, snapshot.contentRevision != source.basis.contentRevision else { return }
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
        guard receipt == nil, anchor == (source.acknowledgements, generation), source.isSettled,
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
        let retained = StoryLocalRetention(
            reference: confirmed.reference,
            title: WorkspaceDisplayTitle.derived(from: confirmed.source,
                fallback: confirmed.reference.path == "/" ? "Home" : String(confirmed.reference.path.split(separator: "/").last ?? "")),
            source: confirmed.source,
            retainedAt: Date()
        )
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
            let mounted = StoryMarkdownCodec.admission(blocks: document.children, ledger: ledger, copies: copySources).0
            if confirmed.source.utf8.elementsEqual(mounted.source.utf8) {
                // Self-confirmation: advance without reparsing or replacing so
                // focus, selection, typing and undo coalescing are undisturbed.
                ledger.source = confirmed.source
                ledger.revision = confirmed.contentRevision
            } else {
                // A session-returned transformation, or a host-authored
                // replacement: genuinely new content the editor must show.
                let opened = StoryMarkdownCodec.open(
                    source: confirmed.source,
                    revision: confirmed.contentRevision,
                    identitySeed: String(describing: confirmed.reference.identity),
                    reusing: ledger.parsedKinds
                )
                let rebased = StoryMarkdownCodec.rebased(opened, preserving: document.children)
                ledger = rebased.ledger
                let next = presented(rebased.blocks)
                if next != document.children { _ = document.replaceChildrenReconciled(next) }
            }
            acceptedTitle = Self.authoredTitle(of: document)
            authoredLedgers.removeAll()
            copySources.removeAll()
            basisLedgers = basisLedgers.filter { $0.key == confirmed.contentRevision }
        }
        refreshState()
        onLocalRetention?(retained)
    }
}

/// A short digest that names exact source bytes in diagnostics without logging them.
enum EditorSourceID {
    static func of(_ source: String) -> String { String(ProtocolObjectCodec.hash(Data(source.utf8)).suffix(12)) }
}
