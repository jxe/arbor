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
        var workspaceLeases: [UUID: WorkspaceDocumentLease]
    }

    public let provider: any WorkspaceProvider
    private let coordinator: WorkspaceCoordinator
    private var entries: [WorkspaceIdentity: Entry] = [:]

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
        entries[workspaceLease.identity] = Entry(binding: binding, workspaceLeases: [id: workspaceLease])
        return CanopyEditorLease(id: id, identity: workspaceLease.identity, binding: binding)
    }

    public func release(_ lease: CanopyEditorLease) async {
        guard var entry = entries[lease.identity], let workspaceLease = entry.workspaceLeases.removeValue(forKey: lease.id) else { return }
        if entry.workspaceLeases.isEmpty {
            entry.binding.stopObserving()
            await entry.binding.flush()
            entries.removeValue(forKey: lease.identity)
        } else {
            entries[lease.identity] = entry
        }
        await coordinator.release(workspaceLease)
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
                    let healed = await healedLinks(
                        in: snapshot.source,
                        resolveFrom: source.sourceDirectory,
                        writeFrom: resolvedSource.sourceDirectory,
                        tree: snapshot.reference.tree,
                        relocated: relocated
                    )
                    if healed != snapshot.source {
                        _ = try await session.admit(
                            source: healed,
                            baseContentRevision: snapshot.contentRevision
                        )
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

    /// Look up every same-tree link's current target, then heal the source against those answers.
    private func healedLinks(
        in source: String,
        resolveFrom: String,
        writeFrom: String,
        tree: TreeID,
        relocated: (String) -> String
    ) async -> String {
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
        guard !targets.isEmpty else { return source }
        return healMarkdownLinks(source, resolveFrom: resolveFrom, writeFrom: writeFrom, tree: tree.rawValue) { path, stableKey in
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
            for lease in entry.workspaceLeases.values { await coordinator.release(lease) }
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
