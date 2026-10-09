import CanopyAppKit
import Foundation
import Quagmire

@MainActor
public struct CanopyEditorLease {
    public let id: UUID
    public let identity: WorkspaceIdentity
    public let binding: CanopyDocumentBinding
}

@MainActor
public final class CanopyEditorWorkspace {
    private struct Entry {
        var binding: CanopyDocumentBinding
        /// Each editor lease's document lease; nil for a lease on an uncreated draft.
        var workspaceLeases: [UUID: WorkspaceDocumentLease?]
        var draft: DraftDocumentSession?
        /// The draft has no page yet: its edits stay in memory and are not retained.
        var awaitsCreation = false
    }

    public let provider: any WorkspaceProvider
    private let coordinator: WorkspaceCoordinator
    private var entries: [WorkspaceIdentity: Entry] = [:]
    private var retentionObservers: [UUID: AsyncStream<CanopyLocalRetention>.Continuation] = [:]

    /// Each window receives retained changes from every editor in this workspace.
    public func localRetentions() -> AsyncStream<CanopyLocalRetention> {
        let id = UUID()
        return AsyncStream { continuation in
            retentionObservers[id] = continuation
            continuation.onTermination = { [weak self] _ in
                Task { @MainActor in self?.retentionObservers.removeValue(forKey: id) }
            }
        }
    }

    public init(provider: any WorkspaceProvider) {
        self.provider = provider
        self.coordinator = WorkspaceCoordinator(provider: provider)
    }

    public func lease(_ reference: WorkspaceReference) async throws -> CanopyEditorLease {
        let workspaceLease = try await coordinator.leaseDocument(reference)
        let id = UUID()
        if var entry = entries[workspaceLease.identity] {
            entry.workspaceLeases[id] = workspaceLease
            entries[workspaceLease.identity] = entry
            return CanopyEditorLease(id: id, identity: workspaceLease.identity, binding: entry.binding)
        }
        let binding = try await CanopyDocumentBinding.open(reference: reference, session: workspaceLease.session)
        observeRetentions(of: binding, identity: workspaceLease.identity)
        entries[workspaceLease.identity] = Entry(binding: binding, workspaceLeases: [id: workspaceLease])
        return CanopyEditorLease(id: id, identity: workspaceLease.identity, binding: binding)
    }

    /// An editor on a new page that exists only in `draft` until
    /// `promoteDraft(_:to:)` hands it the created page.
    public func leaseDraft(_ draft: DraftDocumentSession) async throws -> CanopyEditorLease {
        let identity = draft.identity
        guard entries[identity] == nil else { throw WorkspaceProviderError.invalidAction("This draft is already open") }
        let snapshot = try await draft.snapshot()
        let binding = try await CanopyDocumentBinding.open(reference: snapshot.reference, session: draft)
        binding.document.fallbackTitle = DraftDocumentSession.provisionalName
        observeRetentions(of: binding, identity: identity)
        let id = UUID()
        entries[identity] = Entry(binding: binding, workspaceLeases: [id: nil], draft: draft, awaitsCreation: true)
        return CanopyEditorLease(id: id, identity: identity, binding: binding)
    }

    /// Continue a draft's editor on `created`, the page made from the draft's
    /// source. The binding stays mounted; edits the draft held after the page
    /// was made carry over.
    public func promoteDraft(_ lease: CanopyEditorLease, to created: WorkspaceReference) async throws {
        guard let draft = entries[lease.identity]?.draft, entries[lease.identity]?.awaitsCreation == true else { return }
        let workspaceLease = try await coordinator.leaseDocument(created)
        do {
            guard workspaceLease.identity == lease.identity else {
                throw WorkspaceProviderError.invalidAction("The created page is not this draft")
            }
            try await draft.promote(to: workspaceLease.session)
        } catch {
            await coordinator.release(workspaceLease)
            throw error
        }
        guard var entry = entries[lease.identity] else {
            await coordinator.release(workspaceLease)
            return
        }
        entry.workspaceLeases[lease.id] = workspaceLease
        entry.awaitsCreation = false
        entries[lease.identity] = entry
        await entry.binding.adoptCurrentSnapshot()
    }

    public func isAwaitingCreation(_ lease: CanopyEditorLease) -> Bool {
        entries[lease.identity]?.awaitsCreation == true
    }

    private func observeRetentions(of binding: CanopyDocumentBinding, identity: WorkspaceIdentity) {
        binding.onLocalRetention = { [weak self] change in
            guard let self, self.entries[identity]?.awaitsCreation != true else { return }
            for observer in self.retentionObservers.values { observer.yield(change) }
        }
    }

    public func release(_ lease: CanopyEditorLease) async {
        guard var entry = entries[lease.identity], let workspaceLease = entry.workspaceLeases.removeValue(forKey: lease.id) else { return }
        if entry.workspaceLeases.isEmpty {
            entry.binding.stopObserving()
            await entry.binding.flush()
            entries.removeValue(forKey: lease.identity)
            await entry.draft?.close()
        } else {
            entries[lease.identity] = entry
        }
        if let workspaceLease { await coordinator.release(workspaceLease) }
    }

    public func retryFailedSaves() async {
        for entry in entries.values where entry.binding.lastError != nil {
            await entry.binding.retryLastSave()
        }
    }

    public func flushAll() async throws {
        for entry in entries.values {
            await entry.binding.flush()
            if let error = entry.binding.lastError { throw error }
        }
        try await coordinator.flushAll()
    }

    /// A document whose links may need healing after a move, with the directory its body file was
    /// in before the move, which its relative links were written from.
    public struct LinkHealingSource: Sendable, Equatable {
        public var reference: WorkspaceReference
        public var sourceDirectory: String

        public init(reference: WorkspaceReference, sourceDirectory: String) {
            self.reference = reference
            self.sourceDirectory = sourceDirectory
        }
    }

    /// Capture the documents whose links may become stale before a page changes location: the
    /// moved page and its descendants, whose own relative links move with them, and every page
    /// linking to one of them, whose readable paths go stale. Stable identity still makes those
    /// links work; this list lets the structural action also repair their authored paths.
    public func linkHealingSources(for action: WorkspaceStructuralAction) async -> [LinkHealingSource] {
        let reference: WorkspaceReference
        switch action {
        case let .rename(candidate, _), let .move(candidate, _): reference = candidate
        default: return []
        }
        guard let root = try? await provider.resolve(reference) else { return [] }
        var descendants: [WorkspaceNode] = []
        var pending = [root]
        var visited = Set<WorkspaceIdentity>()
        while let candidate = pending.popLast(), visited.insert(candidate.id).inserted {
            descendants.append(candidate)
            if let children = try? await provider.children(of: candidate.reference) {
                pending.append(contentsOf: children)
            }
        }
        var backlinks: [WorkspaceNode] = []
        for descendant in descendants {
            for result in (try? await provider.backlinks(to: descendant.reference)) ?? [] {
                if let node = try? await provider.resolve(result.reference) { backlinks.append(node) }
            }
        }
        var seen = Set<WorkspaceIdentity>()
        return (backlinks + descendants)
            .filter { seen.insert($0.id).inserted }
            .map { LinkHealingSource(reference: $0.reference, sourceDirectory: $0.sourceDirectory) }
    }

    /// Best-effort proactive healing after a move or rename. Each source's links are re-resolved
    /// from where its body file was and rewritten from where it is now, so a moved page's own
    /// relative links follow it and inbound links name the new path; same-tree `arbor://` links
    /// become relative. Lazy stable-key resolution remains the fallback if a concurrent edit
    /// wins the race.
    public func healLinks(
        in sources: [LinkHealingSource],
        movedFrom oldPath: String,
        to moved: WorkspaceReference
    ) async {
        func relocated(_ path: String) -> String {
            guard path == oldPath || path.hasPrefix(oldPath + "/") else { return path }
            return moved.path + path.dropFirst(oldPath.count)
        }
        for source in sources {
            do {
                var currentSource = source.reference
                currentSource.path = relocated(source.reference.path)
                let resolvedSource = try await provider.resolve(currentSource)
                guard resolvedSource.surface.supportsDocumentSession else { continue }
                let session = try await provider.openDocument(resolvedSource.reference)
                do {
                    let snapshot = try await session.snapshot()
                    // One edit per rewritten href, never the whole page: a whole-source
                    // replacement would overlap every concurrent edit to the page.
                    let edits = await healingEdits(
                        in: snapshot.source,
                        resolveFrom: source.sourceDirectory,
                        writeFrom: resolvedSource.sourceDirectory,
                        tree: snapshot.reference.tree,
                        relocated: relocated
                    )
                    if !edits.isEmpty {
                        _ = try await session.admit(patch: WorkspaceDocumentPatch(
                            baseContentRevision: snapshot.contentRevision,
                            edits: edits
                        ))
                        try await session.flush()
                    }
                } catch {
                    await session.close()
                    continue
                }
                await session.close()
            } catch {
                continue
            }
        }
    }

    private struct LinkKey: Hashable {
        var path: String
        var stableKey: String?
    }

    /// Look up every same-tree link's current target, then the edits that heal the source against those answers.
    private func healingEdits(
        in source: String,
        resolveFrom: String,
        writeFrom: String,
        tree: TreeID,
        relocated: (String) -> String
    ) async -> [WorkspaceSourceEdit] {
        var targets: [LinkKey: MarkdownLinkTarget] = [:]
        var looked = Set<LinkKey>()
        for destination in markdownLinkDestinations(in: source) {
            guard let link = resolveNodeTarget(sourceDirectory: resolveFrom, href: destination.href),
                  link.tree == nil || link.tree == tree.rawValue else { continue }
            let key = LinkKey(path: link.path, stableKey: link.stableKey)
            guard looked.insert(key).inserted,
                  let node = try? await provider.resolve(WorkspaceReference(
                    tree: tree,
                    path: relocated(link.path),
                    stableKey: link.stableKey
                  )),
                  link.stableKey == nil || node.reference.stableKey == link.stableKey
            else { continue }
            targets[key] = node.markdownLinkTarget
        }
        guard !targets.isEmpty else { return [] }
        return markdownLinkHealingEdits(source, resolveFrom: resolveFrom, writeFrom: writeFrom, tree: tree.rawValue) { path, stableKey in
            targets[LinkKey(path: path, stableKey: stableKey)]
        }
    }

    public func appendTranscript(
        _ transcript: String,
        to stableKey: String,
        in tree: TreeID
    ) async throws {
        let block = Block.paragraph(text: AttributedString(transcript))

        if let binding = entries.values.lazy.map(\.binding).first(where: {
            $0.reference.tree == tree && $0.reference.stableKey == stableKey
        }) {
            let priorGeneration = binding.generation
            binding.document.transaction(name: "Insert Transcript") {
                let target = Self.transcriptInsertionPath(in: binding.document)
                _ = binding.document.insertSubtree(
                    block,
                    at: target
                )
            }
            // A mounted EditorView forwards the transaction synchronously.
            // Tests and background recovery can retain a binding without a
            // mounted surface, so admit the same generation here if no host
            // callback observed it.
            if binding.generation == priorGeneration {
                binding.appendCurrentGeneration()
            }
            await binding.flush()
            if let error = binding.lastError { throw error }
            return
        }

        let reference = WorkspaceReference(tree: tree, path: "/", stableKey: stableKey)
        let lease = try await coordinator.leaseDocument(reference)
        do {
            let confirmed = try await admitBlockEdit(in: lease.session) { Self.appendTranscript(block, to: &$0) }
            if let binding = entries.values.lazy.map(\.binding).first(where: {
                $0.reference.tree == tree && $0.reference.stableKey == stableKey
            }) {
                await binding.applyAcceptedReplacement(confirmed)
            }
            await coordinator.release(lease)
        } catch {
            await coordinator.release(lease)
            throw error
        }
    }

    public func closeAll() async {
        for entry in entries.values {
            entry.binding.stopObserving()
            await entry.binding.flush()
            for case let lease? in entry.workspaceLeases.values { await coordinator.release(lease) }
            await entry.draft?.close()
        }
        entries.removeAll()
    }

    private static func transcriptInsertionPath(in document: Document) -> DropPath {
        var target: BlockID?
        document.walk { block, _, _ in
            guard target == nil, isVoiceHeading(block) else { return }
            target = block.id
        }
        guard let target, let heading = document.find(target) else {
            return DropPath(parent: nil, position: document.children.count)
        }
        return DropPath(parent: target, position: heading.children.count)
    }

    private static func appendTranscript(_ transcript: Block, to blocks: inout [Block]) {
        if appendTranscriptToFirstVoiceHeading(transcript, in: &blocks) { return }
        blocks.append(transcript)
    }

    private static func appendTranscriptToFirstVoiceHeading(
        _ transcript: Block,
        in blocks: inout [Block]
    ) -> Bool {
        for index in blocks.indices {
            if isVoiceHeading(blocks[index]) {
                blocks[index].children.append(transcript)
                return true
            }
            if appendTranscriptToFirstVoiceHeading(transcript, in: &blocks[index].children) {
                return true
            }
        }
        return false
    }

    private static func isVoiceHeading(_ block: Block) -> Bool {
        guard case let .heading(_, text) = block.kind else { return false }
        return String(text.characters).unicodeScalars.contains { $0.value == 0x1F399 }
    }
}
