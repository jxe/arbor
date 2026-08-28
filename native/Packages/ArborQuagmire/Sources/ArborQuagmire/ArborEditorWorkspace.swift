import ArborKit
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
    private let coordinator: WorkspaceCoordinator
    private var entries: [WorkspaceIdentity: Entry] = [:]

    public init(provider: any WorkspaceProvider) {
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
        let binding = try await ArborDocumentBinding.open(reference: reference, session: workspaceLease.session)
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

    public func flushAll() async throws {
        for entry in entries.values { await entry.binding.flush() }
        try await coordinator.flushAll()
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
            let snapshot = try await lease.session.snapshot()
            let opened = ArborMarkdownCodec.open(
                source: snapshot.source,
                revision: snapshot.contentRevision,
                identitySeed: String(describing: snapshot.reference.identity)
            )
            var blocks = opened.blocks
            Self.appendTranscript(block, to: &blocks)
            let (admission, _) = ArborMarkdownCodec.admission(blocks: blocks, ledger: opened.ledger)
            let confirmed = try await lease.session.admit(patch: admission.patch)
            try await lease.session.flush()
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
