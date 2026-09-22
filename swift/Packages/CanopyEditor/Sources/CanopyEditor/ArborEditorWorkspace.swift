import CanopyAppKit
import Foundation
import Quagmire

@MainActor
public struct ArborEditorLease {
    public let id: UUID
    public let identity: WorkspaceIdentity
    public let binding: ArborDocumentBinding
}

@MainActor
public final class ArborEditorWorkspace {
    private struct Entry {
        var binding: ArborDocumentBinding
        var workspaceLeases: [UUID: WorkspaceDocumentLease]
    }

    public let provider: any WorkspaceProvider
    private let recoveryRoot: URL?
    private let coordinator: WorkspaceCoordinator
    private var entries: [WorkspaceIdentity: Entry] = [:]

    public init(provider: any WorkspaceProvider, recoveryRoot: URL? = nil) {
        self.recoveryRoot = recoveryRoot
        self.provider = provider
        self.coordinator = WorkspaceCoordinator(provider: provider)
    }

    public func lease(_ reference: WorkspaceReference) async throws -> ArborEditorLease {
        let workspaceLease = try await coordinator.leaseDocument(reference)
        let id = UUID()
        if var entry = entries[workspaceLease.identity] {
            entry.workspaceLeases[id] = workspaceLease
            entries[workspaceLease.identity] = entry
            return ArborEditorLease(id: id, identity: workspaceLease.identity, binding: entry.binding)
        }
        let binding = try await ArborDocumentBinding.open(reference: reference, session: workspaceLease.session, recoveryRoot: recoveryRoot)
        entries[workspaceLease.identity] = Entry(binding: binding, workspaceLeases: [id: workspaceLease])
        return ArborEditorLease(id: id, identity: workspaceLease.identity, binding: binding)
    }

    public func release(_ lease: ArborEditorLease) async {
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
        for entry in entries.values where entry.binding.lastError != nil && entry.binding.conflict == nil {
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

    /// Capture the documents whose readable link paths may become stale before
    /// a page changes location. Stable identity still makes those links work;
    /// this list lets the structural action also repair their authored paths.
    public func linkHealingSources(for action: WorkspaceStructuralAction) async -> [WorkspaceReference] {
        let reference: WorkspaceReference
        switch action {
        case let .rename(candidate, _), let .move(candidate, _): reference = candidate
        default: return []
        }
        var descendants: [WorkspaceReference] = []
        var pending = [reference]
        var visited = Set<WorkspaceIdentity>()
        while let candidate = pending.popLast(), visited.insert(candidate.identity).inserted {
            descendants.append(candidate)
            if let children = try? await provider.children(of: candidate) {
                pending.append(contentsOf: children.map(\.reference))
            }
        }
        var backlinks: [WorkspaceReference] = []
        for descendant in descendants {
            backlinks.append(contentsOf: (try? await provider.backlinks(to: descendant).map(\.reference)) ?? [])
        }
        var seen = Set<WorkspaceIdentity>()
        return (backlinks + descendants).filter { seen.insert($0.identity).inserted }
    }

    /// Best-effort proactive healing after a move or rename. Lazy stable-key
    /// resolution remains the fallback if a concurrent edit wins the race.
    public func healLinks(
        in sources: [WorkspaceReference],
        movedFrom oldPath: String,
        to moved: WorkspaceReference
    ) async {
        for source in sources {
            do {
                var currentSource = source
                if source.path == oldPath || source.path.hasPrefix(oldPath + "/") {
                    currentSource.path = moved.path + source.path.dropFirst(oldPath.count)
                }
                let resolvedSource = try await provider.resolve(currentSource)
                guard resolvedSource.surface.supportsDocumentSession else { continue }
                let session = try await provider.openDocument(resolvedSource.reference)
                do {
                    let snapshot = try await session.snapshot()
                    let base: String
                    switch resolvedSource.surface {
                    case .directory, .directoryDocument, .collection:
                        base = snapshot.reference.path
                    default:
                        base = snapshot.reference.parent?.path ?? snapshot.reference.path
                    }
                    let healed = await healedLinkPaths(
                        in: snapshot.source,
                        base: base,
                        tree: snapshot.reference.tree,
                        movedFrom: oldPath,
                        to: moved
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

    private func healedLinkPaths(
        in source: String,
        base: String,
        tree: TreeID,
        movedFrom oldPath: String,
        to moved: WorkspaceReference
    ) async -> String {
        guard let regex = try? NSRegularExpression(pattern: #"(?<!!)\[[^\]]*\]\(([^)]+)\)"#) else {
            return source
        }
        let matches = regex.matches(in: source, range: NSRange(source.startIndex..., in: source))
        var replacements: [(Range<String.Index>, String)] = []
        for match in matches {
            guard let hrefRange = Range(match.range(at: 1), in: source) else { continue }
            let href = String(source[hrefRange])
            guard let target = resolveNodeTarget(base: base, href: href),
                  target.tree == nil || target.tree == tree.rawValue else { continue }
            let newPath: String?
            if target.path == oldPath || target.path.hasPrefix(oldPath + "/") {
                newPath = moved.path + target.path.dropFirst(oldPath.count)
            } else if let stableKey = target.stableKey ?? target.legacyPageID.map(pageIDStableKey),
                      let resolved = try? await provider.resolve(WorkspaceReference(
                        tree: tree,
                        path: target.path,
                        stableKey: stableKey
                      )) {
                newPath = resolved.reference.path
            } else {
                newPath = nil
            }
            guard let newPath,
                  let replacement = rewriteLocalLinkPath(base: base, href: href, newPath: newPath),
                  replacement != href else { continue }
            replacements.append((hrefRange, replacement))
        }
        var result = source
        for (range, replacement) in replacements.reversed() {
            result.replaceSubrange(range, with: replacement)
        }
        return result
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
                binding.admitCurrentGeneration()
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
