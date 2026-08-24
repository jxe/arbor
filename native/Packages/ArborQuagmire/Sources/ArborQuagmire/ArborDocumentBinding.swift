import ArborKit
import Foundation
import Quagmire

@MainActor
public final class ArborDocumentBinding {
    public let document: Document
    public let editorState: EditorState
    public private(set) var reference: WorkspaceReference
    public private(set) var lastError: Error?
    public private(set) var conflict: WorkspaceDocumentConflict?
    public private(set) var lastEnqueuedSource: String?

    let session: any WorkspaceDocumentSession
    private var accepted: WorkspaceDocumentSnapshot
    private var ledger: ArborSourceLedger
    private var tail: Task<Void, Never>?
    private(set) var generation = 0

    public static func open(
        reference: WorkspaceReference,
        session: any WorkspaceDocumentSession
    ) async throws -> ArborDocumentBinding {
        let snapshot = try await session.snapshot()
        return ArborDocumentBinding(reference: reference, session: session, snapshot: snapshot)
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
        self.document = Document(
            id: DocumentID(String(describing: snapshot.reference.identity)),
            children: opened.blocks,
            fallbackTitle: snapshot.reference.pathHint.split(separator: "/").last.map(String.init)
        )
        self.editorState = EditorState()
    }

    func admitCurrentGeneration() {
        let (admission, nextLedger) = ArborMarkdownCodec.admission(blocks: document.children, ledger: ledger)
        lastEnqueuedSource = admission.source
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

    public func applyAcceptedReplacement(_ snapshot: WorkspaceDocumentSnapshot) async {
        await flush()
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
        conflict = nil
        lastError = nil
    }

    public func close() async {
        await flush()
        await session.close()
    }

    private func persist(source: String, generation admittedGeneration: Int) async {
        do {
            let patch = ArborMarkdownCodec.patch(
                from: accepted.source,
                to: source,
                revision: accepted.contentRevision
            )
            let confirmed = try await session.admit(patch: patch)
            accepted = confirmed
            reference = confirmed.reference
            if admittedGeneration == generation {
                let opened = ArborMarkdownCodec.open(
                    source: confirmed.source,
                    revision: confirmed.contentRevision,
                    identitySeed: String(describing: confirmed.reference.identity)
                )
                let rebased = ArborMarkdownCodec.rebased(opened, preserving: document.children)
                ledger = rebased.ledger
                if rebased.blocks != document.children { _ = document.replaceChildrenReconciled(rebased.blocks) }
            }
            conflict = nil
            lastError = nil
        } catch let value as WorkspaceDocumentConflict {
            conflict = value
            lastError = value
        } catch {
            lastError = error
        }
    }
}
