import Foundation

/// A new page that exists only in memory until it is given a title.
///
/// The draft carries its PageID from the start, so its identity is the stable
/// key the created page will have: an editor bound to the draft keeps its
/// binding when the page is created, and only the reference's path changes.
/// Until `promote(to:)` every change stays here and nothing reaches a working
/// tree; closing an unpromoted draft discards it. After promotion every call
/// goes to the created page's session.
public actor DraftDocumentSession: WorkspaceDocumentSession {
    public nonisolated let identity: WorkspaceIdentity
    public nonisolated let parent: WorkspaceReference
    public nonisolated let pageID: String
    private var current: WorkspaceDocumentSnapshot
    private var revision = 0
    private var isClosed = false
    /// The created page's session, and the draft snapshot it took over.
    private var target: (any WorkspaceDocumentSession)?
    private var promotion: Task<WorkspaceDocumentSnapshot, Error>?
    private var promotedDraft: WorkspaceDocumentSnapshot?
    private var observers: [UUID: AsyncThrowingStream<WorkspaceDocumentSnapshot, Error>.Continuation] = [:]
    private var relay: Task<Void, Never>?

    /// The title a draft shows until its H1 has one.
    public static let provisionalName = "Untitled"

    public init(parent: WorkspaceReference, pageID: String = "pg_\(UUID().uuidString.lowercased())") {
        self.parent = parent
        self.pageID = pageID
        // A provisional path no page can have, so the draft's location never
        // names an existing page; creation gives it its real path.
        let name = ".draft-\(pageID)"
        let path = parent.path == "/" ? "/\(name)" : "\(parent.path)/\(name)"
        let reference = WorkspaceReference(tree: parent.tree, path: path, stableKey: markdownStableKey(pageID))
        self.identity = reference.identity
        self.current = WorkspaceDocumentSnapshot(
            reference: reference,
            source: "---\nid: \(pageID)\n---\n\n# \n",
            contentRevision: "draft-0"
        )
    }

    /// The page's leading H1 once it has text; a draft without one is not created.
    public static func title(in source: String) -> String? {
        var inFrontmatter = false
        for (index, line) in source.split(separator: "\n", omittingEmptySubsequences: false).enumerated() {
            if index == 0, line == "---" { inFrontmatter = true; continue }
            if inFrontmatter { inFrontmatter = line != "---"; continue }
            if line.allSatisfy(\.isWhitespace) { continue }
            guard line.hasPrefix("# ") else { return nil }
            let title = WorkspaceDisplayTitle.derived(from: String(line), fallback: "")
            return title.isEmpty ? nil : title
        }
        return nil
    }

    public var isPromoted: Bool { target != nil }

    public func snapshot() async throws -> WorkspaceDocumentSnapshot {
        if let (session, _) = try await promoted() { return try await session.snapshot() }
        return current
    }

    public func updates() async throws -> AsyncThrowingStream<WorkspaceDocumentSnapshot, Error> {
        if let (session, _) = try await promoted() { return try await session.updates() }
        let id = UUID()
        return AsyncThrowingStream { continuation in
            observers[id] = continuation
            continuation.onTermination = { [weak self] _ in
                Task { await self?.removeObserver(id) }
            }
        }
    }

    private func removeObserver(_ id: UUID) { observers.removeValue(forKey: id) }

    public func admit(source: String, baseContentRevision: String) async throws -> WorkspaceDocumentSnapshot {
        if let (session, basis) = try await promoted() {
            let base = baseContentRevision == promotedDraft?.contentRevision ? basis.contentRevision : baseContentRevision
            return try await session.admit(source: source, baseContentRevision: base)
        }
        guard !isClosed else { throw WorkspaceProviderError.invalidAction("Document session is closed") }
        guard baseContentRevision == current.contentRevision else {
            throw WorkspaceDocumentConflict(current: current, submittedSource: source)
        }
        revision += 1
        current.source = source
        current.contentRevision = "draft-\(revision)"
        return current
    }

    public func admit(patch: WorkspaceDocumentPatch) async throws -> WorkspaceDocumentSnapshot {
        if let (session, _) = try await promoted(), patch.baseContentRevision != promotedDraft?.contentRevision {
            return try await session.admit(patch: patch)
        }
        let basis = promotedDraft ?? current
        guard patch.baseContentRevision == basis.contentRevision else {
            throw WorkspacePatchError.staleRevision(expected: patch.baseContentRevision, actual: basis.contentRevision)
        }
        return try await admit(source: patch.applying(to: basis.source), baseContentRevision: basis.contentRevision)
    }

    public func admit(intent: WorkspaceDocumentIntent) async throws -> WorkspaceDocumentSnapshot {
        try intent.validate()
        guard intent.basis.reference.identity == identity else {
            throw WorkspaceProviderError.invalidAction("Source intent belongs to another document")
        }
        if let (session, _) = try await promoted(), intent.basis.contentRevision != promotedDraft?.contentRevision {
            return try await session.admit(intent: intent)
        }
        // A change stated against the draft: the created page holds exactly
        // the draft's source, so the change replaces it there by its bytes.
        return try await admit(source: intent.source, baseContentRevision: intent.basis.contentRevision)
    }

    public func flush() async throws {
        if let (session, _) = try await promoted() { try await session.flush() }
    }

    public func createForEditor(parent: WorkspaceReference, name: String, source: String, transaction: String) async throws -> WorkspaceNode? {
        guard let (session, _) = try await promoted() else { return nil }
        return try await session.createForEditor(parent: parent, name: name, source: source, transaction: transaction)
    }

    public func copyDocument() async throws -> WorkspaceCopyDocument? {
        guard let (session, _) = try await promoted() else { return nil }
        return try await session.copyDocument()
    }

    public func admit(transfer: WorkspaceDocumentTransfer) async throws -> WorkspaceDocumentTransferResult? {
        guard let (session, _) = try await promoted() else { return nil }
        return try await session.admit(transfer: transfer)
    }

    public func publishPending() async {
        if let session = target { await session.publishPending() }
    }

    public func sourceActivity(pending: Bool) async {
        if let session = target { await session.sourceActivity(pending: pending) }
    }

    public func history() async throws -> [WorkspaceHistoryEntry] {
        guard let (session, _) = try await promoted() else { return [] }
        return try await session.history()
    }

    public func recover(revision: String) async throws -> WorkspaceDocumentSnapshot {
        guard let (session, _) = try await promoted() else {
            throw WorkspaceProviderError.invalidAction("A new page has no history until it is created")
        }
        return try await session.recover(revision: revision)
    }

    public func close() async {
        isClosed = true
        relay?.cancel()
        for observer in observers.values { observer.finish() }
        observers.removeAll()
    }

    /// Hand the draft to `session`, the created page's, which must hold this
    /// page. Changes the draft admitted after the page was created from it
    /// are carried over, so the created page holds the draft's latest source.
    /// Returns the created page's snapshot.
    @discardableResult
    public func promote(to session: any WorkspaceDocumentSession) async throws -> WorkspaceDocumentSnapshot {
        guard await session.identity == identity else {
            throw WorkspaceProviderError.invalidAction("The created page is not this draft")
        }
        if let promotion { return try await promotion.value }
        guard !isClosed else { throw WorkspaceProviderError.invalidAction("Document session is closed") }
        let draft = current
        let promotion = Task<WorkspaceDocumentSnapshot, Error> {
            let created = try await session.snapshot()
            guard !created.source.utf8.elementsEqual(draft.source.utf8) else { return created }
            return try await session.admit(source: draft.source, baseContentRevision: created.contentRevision)
        }
        self.promotion = promotion
        target = session
        promotedDraft = draft
        do {
            let created = try await promotion.value
            relayUpdates(from: session)
            return created
        } catch {
            self.promotion = nil
            target = nil
            promotedDraft = nil
            throw error
        }
    }

    /// The created page's session and the snapshot promotion left it at,
    /// once the draft has one; a call during promotion waits for it.
    private func promoted() async throws -> (any WorkspaceDocumentSession, WorkspaceDocumentSnapshot)? {
        guard let target, let promotion else { return nil }
        return (target, try await promotion.value)
    }

    /// An editor observing the draft keeps observing the created page.
    private func relayUpdates(from session: any WorkspaceDocumentSession) {
        guard !observers.isEmpty else { return }
        relay = Task { [weak self] in
            do {
                for try await snapshot in try await session.updates() {
                    await self?.yield(snapshot)
                }
                await self?.finishObservers(nil)
            } catch {
                await self?.finishObservers(error)
            }
        }
    }

    private func yield(_ snapshot: WorkspaceDocumentSnapshot) {
        for observer in observers.values { observer.yield(snapshot) }
    }

    private func finishObservers(_ error: (any Error)?) {
        for observer in observers.values { observer.finish(throwing: error) }
        observers.removeAll()
    }
}
