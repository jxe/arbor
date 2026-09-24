import CanopyAppKit
import Overstory
import Foundation

// MARK: Accepted-choice review
/// Inspecting accepted choices and publishing a resolution. A resolution is an
/// ordinary local change carrying `resolves`: it is appended to the change log
/// and published by the machine like any other change. Drafts stay in the
/// review journal until the change that submitted them settles.
extension UpdateCoordinator {
    public func inspectChoices() async throws -> ConflictReviewSnapshot {
        try requireOpen()
        let tree = await workingTree.treeID().rawValue
        let current = try await transport.descriptor(tree: tree)
        var snapshot = ConflictReviewSnapshot(tree: tree, state: current.tree.update, root: current.tree.root, decisions: [])
        guard current.tree.conflicted else { return snapshot }
        var after: String?
        var cursors = Set<String>()
        var identities = Set<String>()
        repeat {
            let page = try await transport.conflicts(tree: tree, state: snapshot.state, root: snapshot.root, after: after)
            try page.validateContext(tree: tree, state: snapshot.state, root: snapshot.root)
            guard case let .array(values) = page.fields["decisions"] else { throw ConflictReviewError.unavailable }
            for value in values {
                let decision = try JSONDecoder().decode(ConflictReviewDecision.self, from: JSONEncoder().encode(value))
                guard identities.insert(decision.id).inserted else { throw ConflictReviewError.unavailable }
                snapshot.decisions.append(decision)
            }
            if case let .string(next) = page.fields["next"] {
                guard cursors.insert(next).inserted else { throw ConflictReviewError.unavailable }
                after = next
            } else { after = nil }
        } while after != nil
        return snapshot
    }

    private func loadReview() throws -> ConflictReviewJournal {
        if let reviewJournal { return reviewJournal }
        let journal = try files.loadReview()
        reviewJournal = journal
        return journal
    }

    private func writeReview(_ journal: ConflictReviewJournal) throws {
        reviewJournal = nil
        try files.writeReview(journal)
        reviewJournal = journal
    }

    public func reviewDrafts() throws -> [ConflictReviewDraft] { try loadReview().drafts }

    /// Whether a submitted resolution is still unsettled in the change log.
    public func reviewSubmissionPending() async throws -> Bool {
        let submitted = try loadReview().submitted
        guard !submitted.isEmpty else { return false }
        return try await pendingLocalChanges().contains { submitted[$0.change] != nil }
    }

    public func retainReviewDraft(_ draft: ConflictReviewDraft) async throws {
        guard draft.snapshot.tree.utf8.elementsEqual((await workingTree.treeID().rawValue).utf8) else { throw ConflictReviewError.unavailable }
        var journal = try loadReview()
        journal.drafts.removeAll { $0.id == draft.id }
        journal.drafts.append(draft)
        try writeReview(journal)
    }

    public func discardReviewDraft(_ id: String) async throws {
        var journal = try loadReview()
        if let draft = journal.drafts.first(where: { $0.id == id }) {
            let fingerprint = try draft.fingerprint()
            let pending = Set(try await pendingLocalChanges().map(\.change))
            guard !journal.submitted.contains(where: { $0.value == fingerprint && pending.contains($0.key) }) else {
                throw ConflictReviewError.publicationPending
            }
        }
        journal.drafts.removeAll { $0.id == id }
        try writeReview(journal)
    }

    public func reviewContent(_ alternative: ConflictReviewAlternative) async throws -> Data? {
        if let text = alternative.value.text { return Data(text.utf8) }
        guard let hash = alternative.value.file else { return nil }
        let bytes = try await transport.object(tree: workingTree.treeID().rawValue, hash: hash)
        guard ProtocolObjectCodec.hash(bytes) == hash else { throw UpdateError.returnedSnapshotMismatch }
        return bytes
    }

    public func reviewDirectory(_ alternative: ConflictReviewAlternative) async throws -> [ProtocolDirectoryEntry]? {
        guard let hash = alternative.value.directory else { return nil }
        let bytes = try await transport.object(tree: workingTree.treeID().rawValue, hash: hash)
        guard ProtocolObjectCodec.hash(bytes) == hash,
              case let .directory(entries, _) = try ProtocolObjectCodec.decode(bytes, kind: .directory) else {
            throw UpdateError.returnedSnapshotMismatch
        }
        return entries
    }

    /// Append one explicit guarded resolution as a local change. Editor changes
    /// continue against their captured bases; review never installs its draft
    /// as the live document or invents a merge over pending editor work.
    public func applyReviewDraft(_ draft: ConflictReviewDraft) async throws {
        try requireOpen()
        try await retainReviewDraft(draft)
        guard !(try await hasLocalChanges()), control.attempt == nil else { throw ConflictReviewError.publicationPending }
        let fresh = try await inspectChoices()
        guard draft.isCurrent(in: fresh) else { throw ConflictReviewError.changed }
        // The resolution's basis is the installed accepted spine; catch up first if the host moved.
        if try await workingTree.heads().acceptedRoot != fresh.root { _ = try await syncOnce() }
        let accepted = try await workingTree.captureAcceptedGraph()
        guard accepted.graph.root == fresh.root, accepted.base.update == fresh.state else { throw ConflictReviewError.changed }
        let (base, preview) = try await prepareReviewPreview(draft, current: fresh)
        // New editor changes can arrive while material loads.
        guard !(try await hasLocalChanges()), control.attempt == nil else { throw ConflictReviewError.publicationPending }
        let known = Set(base.objects.map(\.hash))
        let candidate = try Self.spine(of: preview.candidate, keeping: Set(preview.candidate.objects.map(\.hash)).subtracting(known))
        let basis = Set(accepted.graph.objects.map(\.hash))
        let change = UUID().uuidString
        let chosen = preview.operations ?? []
        let update = ProtocolCandidateUpdate(candidate: candidate.root, change: change,
            trace: chosen.isEmpty ? nil : [ProtocolTraceFrame(before: fresh.root, after: candidate.root, operations: chosen)],
            resolves: draft.decisions.map { .init(state: draft.snapshot.state, conflict: $0.id, alternatives: $0.alternatives.map(\.id)) },
            objects: candidate.objects.filter { !basis.contains($0.hash) })
        let record = try LocalChange(change: change, tree: fresh.tree, basis: .accepted(accepted.base), graph: accepted.graph,
            candidate: candidate, update: update, sourcePath: nil, document: nil, entryTransfer: nil, entryActions: nil,
            creation: nil, localTrash: nil)
        var journal = try loadReview()
        journal.submitted[change] = try draft.fingerprint()
        try writeReview(journal)
        try await changeLog().retain(record)
        await publishTip()
        _ = try await syncOnce()
        if case let .held(_, _, request, _) = syncState.phase, request.tip == change {
            // A stale guard: the draft is kept, so the refused resolution itself carries nothing to keep.
            try await discardHeldChanges()
            throw ConflictReviewError.changed
        }
    }

    public func previewReviewDraft(_ draft: ConflictReviewDraft) async throws -> ConflictReviewPreview {
        try requireOpen()
        let current = try await inspectChoices()
        guard draft.isCurrent(in: current) else { throw ConflictReviewError.changed }
        return try await prepareReviewPreview(draft, current: current).preview
    }

    private func prepareReviewPreview(_ draft: ConflictReviewDraft, current: ConflictReviewSnapshot) async throws -> (base: ProtocolSnapshot, preview: ConflictReviewPreview) {
        guard draft.obligations.isEmpty else { throw ConflictReviewProposalError(draft.obligations.joined(separator: "\n")) }
        let base = try await transport.snapshot(tree: current.tree, root: current.root)
        var material: [String: Data] = [:]
        let known = Dictionary(uniqueKeysWithValues: base.objects.map { ($0.hash, $0.bytes) })
        for decision in draft.decisions {
            guard let selection = draft.selection(for: decision.id), let alternative = decision.alternatives.first(where: { $0.id == selection.alternative }) else {
                throw ConflictReviewError.unsupported
            }
            var pending: [(String, ProtocolEntryKind)] = []
            if let file = alternative.value.file { pending.append((file, .file)) }
            if let directory = alternative.value.directory { pending.append((directory, .directory)) }
            var visited = Set<String>()
            while let (hash, kind) = pending.popLast() {
                guard visited.insert(hash).inserted else { continue }
                let bytes: Data
                if let retained = material[hash] ?? known[hash] { bytes = retained }
                else {
                    bytes = try await transport.object(tree: current.tree, hash: hash)
                }
                guard ProtocolObjectCodec.hash(bytes) == hash else { throw UpdateError.returnedSnapshotMismatch }
                material[hash] = bytes
                if kind == .directory, case let .directory(entries, _) = try ProtocolObjectCodec.decode(bytes, kind: kind) {
                    for entry in entries { if let hash = entry.hash, let kind = entry.kind { pending.append((hash, kind)) } }
                }
            }
        }
        return (base, try ConflictReviewCompiler.compile(draft, base: base, material: material, allDecisions: current.decisions))
    }

    /// The directories and Markdown of `snapshot`, plus the `keeping` objects
    /// it introduces: the sparse form every change-log record carries.
    static func spine(of snapshot: ProtocolSnapshot, keeping extra: Set<String>) throws -> ProtocolSnapshot {
        let objects = Dictionary(uniqueKeysWithValues: snapshot.objects.map { ($0.hash, $0) })
        var kept: [ProtocolObjectEnvelope] = [], pending = [snapshot.root], seen = Set<String>()
        while let hash = pending.popLast() {
            guard seen.insert(hash).inserted, let object = objects[hash] else { continue }
            kept.append(object)
            guard case let .directory(entries, _) = try ProtocolObjectCodec.decode(object.bytes, kind: .directory) else { continue }
            for entry in entries {
                if let directory = entry.directory { pending.append(directory); continue }
                guard let file = entry.hash, seen.insert(file).inserted, let object = objects[file] else { continue }
                if entry.name.hasSuffix(".md") || entry.name.hasSuffix(".mdx") || extra.contains(file) { kept.append(object) }
            }
        }
        let spine = ProtocolSnapshot(root: snapshot.root, objects: kept.sorted { $0.hash < $1.hash })
        _ = try ProtocolObjectGraph.validate(spine, mode: .sparseFiles)
        return spine
    }

    /// Drafts whose resolution settled are done; a later edited draft is never
    /// retired by an earlier submission.
    func retireSubmittedReviews(_ settled: Set<String>) throws {
        var journal = try loadReview()
        let done = journal.submitted.filter { settled.contains($0.key) }
        guard !done.isEmpty else { return }
        let fingerprints = Set(done.values)
        journal.drafts = try journal.drafts.filter { !fingerprints.contains(try $0.fingerprint()) }
        for change in done.keys { journal.submitted[change] = nil }
        try writeReview(journal)
    }

    /// Discarded resolutions keep their drafts.
    func forgetSubmittedReviews(_ discarded: Set<String>) throws {
        var journal = try loadReview()
        guard journal.submitted.keys.contains(where: discarded.contains) else { return }
        for change in discarded { journal.submitted[change] = nil }
        try writeReview(journal)
    }
}
