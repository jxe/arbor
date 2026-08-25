import ArborKit
@testable import ArborQuagmire
import Foundation
import Quagmire
import QuagmireExtras
import Testing

@Suite("Source-preserving Quagmire codec")
struct ArborQuagmireTests {
    private func linkPreviewService() -> LinkPreviewService {
        LinkPreviewService(
            cacheDirectory: FileManager.default.temporaryDirectory
                .appending(path: "ArborQuagmireTests-\(UUID().uuidString)")
        )
    }
    @Test("No-op is byte-identical across envelopes, CRLF, marks, and raw Markdown")
    func noOp() throws {
        let source = "---\r\nid: pg_exact\r\ntitle:  A  \r\n---\r\n\r\n# Heading *as authored*\r\n\r\nParagraph with **bold**, [link](other.md), $x^2$, and  two spaces.\r\n\r\n<table><tr><td>raw</td></tr></table>\r\n"
        let opened = ArborMarkdownCodec.open(source: source, revision: "r1", identitySeed: "pg_exact")
        let (admission, _) = ArborMarkdownCodec.admission(blocks: opened.blocks, ledger: opened.ledger)
        #expect(admission.source == source)
        #expect(admission.patch.edits.isEmpty)
    }

    @Test("Editing one structured block produces one guarded narrow replacement")
    func narrowEdit() throws {
        let source = "---\nid: pg_edit\n---\n\n# Title\n\nFirst paragraph.\n\nUntouched **raw style**.\n"
        let opened = ArborMarkdownCodec.open(source: source, revision: "r1", identitySeed: "pg_edit")
        var blocks = opened.blocks
        let paragraph = try #require(blocks.first?.children.first)
        blocks[0].children[0] = paragraph.withText(AttributedString("Changed paragraph."))
        let (admission, _) = ArborMarkdownCodec.admission(blocks: blocks, ledger: opened.ledger)
        #expect(admission.source.contains("Changed paragraph."))
        #expect(admission.source.contains("Untouched **raw style**."))
        #expect(admission.patch.edits.count == 1)
        #expect(try admission.patch.applying(to: source) == admission.source)
    }

    @Test("Edited blocks preserve Quagmire inline marks and links semantically")
    func editedInlineMarks() throws {
        let source = "Text **bold** *italic* `code` ~~gone~~ and [link](https://example.com).\n"
        let opened = ArborMarkdownCodec.open(source: source, revision: "r1", identitySeed: "marks")
        var blocks = opened.blocks
        var text = try #require(blocks.first?.text)
        #expect(String(text.characters) == "Text bold italic code gone and link.")
        #expect(text.runs.contains { $0[InlineAttributes.BoldAttribute.self] == true })
        #expect(text.runs.contains { $0[InlineAttributes.ItalicAttribute.self] == true })
        #expect(text.runs.contains { $0[InlineAttributes.CodeAttribute.self] == true })
        #expect(text.runs.contains { $0[InlineAttributes.StrikethroughAttribute.self] == true })
        #expect(text.runs.contains { $0.link?.absoluteString == "https://example.com" })

        text.append(AttributedString(" Edited."))
        blocks[0] = blocks[0].withText(text)
        let (admission, _) = ArborMarkdownCodec.admission(blocks: blocks, ledger: opened.ledger)
        #expect(admission.source.contains("**bold**"))
        #expect(admission.source.contains("*italic*"))
        #expect(admission.source.contains("`code`"))
        #expect(admission.source.contains("~~gone~~"))
        #expect(admission.source.contains("[link](https://example.com)"))
        #expect(try admission.patch.applying(to: source) == admission.source)
    }

    @Test("H1 through H6, code, lists, quote, divider, reference, image, and raw blocks survive")
    func blockKinds() {
        let source = "# H1\n\n## H2\n\n### H3\n\n#### H4\n\n##### H5\n\n###### H6\n\n- bullet\n\n1. number\n\n- [x] done\n\n> quote\n\n---\n\n```swift\nlet x = 1\n```\n\n[Page](page.md)\n\n![Alt](Assets/a.png)\n\n<div>raw</div>\n"
        let opened = ArborMarkdownCodec.open(source: source, revision: "r", identitySeed: "kinds")
        let (admission, _) = ArborMarkdownCodec.admission(blocks: opened.blocks, ledger: opened.ledger)
        #expect(admission.source == source)
    }

    @MainActor
    @Test("Synchronous commits enqueue ordered patch admissions and flush awaits the final generation")
    func hostPersistence() async throws {
        let provider = InMemoryWorkspaceProvider.sample()
        let reference = WorkspaceReference(tree: "tr_sample", path: "/welcome", pageID: "pg_welcome")
        let session = InMemoryDocumentSession(snapshot: .init(
            reference: reference,
            source: "# Welcome\n\nNative Arbor is ready.\n",
            contentRevision: "r1"
        ))
        let binding = try await ArborDocumentBinding.open(reference: reference, session: session)
        let host = ArborEditorHost(
            binding: binding,
            provider: provider,
            linkPreviewService: linkPreviewService()
        )
        let document = binding.document
        var textIDs: [BlockID] = []
        document.walk { block, _, _ in
            if case .paragraph = block.kind { textIDs.append(block.id) }
        }
        let paragraph = try #require(textIDs.first)
        document.transaction(name: "first") { _ = document.setText(paragraph, AttributedString("First edit")) }
        host.persistCommit(changes: [], in: document)
        #expect(binding.generation == 1)
        document.transaction(name: "second") { _ = document.setText(paragraph, AttributedString("Final edit")) }
        #expect(document.find(paragraph).map { String($0.text.characters) } == "Final edit")
        host.persistCommit(changes: [], in: document)
        #expect(binding.generation == 2)
        #expect(binding.lastEnqueuedSource?.contains("Final edit") == true, Comment(rawValue: binding.lastEnqueuedSource ?? "nil"))
        await host.flush(document)

        let saved = try await session.snapshot()
        #expect(binding.lastError == nil, Comment(rawValue: String(describing: binding.lastError)))
        #expect(saved.source.contains("Final edit"), Comment(rawValue: saved.source))
    }

    @MainActor
    @Test("Duplicate tabs share one binding and save chain by PageID")
    func duplicateTabs() async throws {
        let provider = InMemoryWorkspaceProvider.sample()
        let workspace = ArborEditorWorkspace(provider: provider)
        let first = try await workspace.lease(.init(tree: "tr_sample", path: "/welcome", pageID: "pg_welcome"))
        let second = try await workspace.lease(.init(tree: "tr_sample", path: "/stale", pageID: "pg_welcome"))
        #expect(first.binding === second.binding)
        await workspace.release(first)
        await workspace.release(second)
    }

    @MainActor
    @Test("Provider-backed transcript delivery updates an active PageID binding")
    func activeTranscriptDelivery() async throws {
        let provider = InMemoryWorkspaceProvider.sample()
        let workspace = ArborEditorWorkspace(provider: provider)
        let reference = WorkspaceReference(
            tree: "tr_sample",
            path: "/welcome",
            pageID: "pg_welcome"
        )
        let lease = try await workspace.lease(reference)

        try await workspace.appendTranscript(
            "Captured through the workspace.",
            to: "pg_welcome",
            in: "tr_sample"
        )

        var texts: [String] = []
        lease.binding.document.walk { block, _, _ in
            texts.append(String(block.text.characters))
        }
        let snapshot = try await lease.binding.snapshot()
        #expect(
            texts.contains("Captured through the workspace."),
            Comment(rawValue: "texts=\(texts) source=\(snapshot.source)")
        )
        #expect(snapshot.source.contains(
            "Captured through the workspace."
        ))
        await workspace.release(lease)
    }

    @MainActor
    @Test("Destination failure leaves the source exact and references retain tree plus PageID scope")
    func safeActions() async throws {
        let provider = InMemoryWorkspaceProvider.sample()
        let session = try await provider.openDocument(.init(tree: "tr_sample", path: "/welcome", pageID: "pg_welcome"))
        let binding = try await ArborDocumentBinding.open(
            reference: .init(tree: "tr_sample", path: "/welcome", pageID: "pg_welcome"),
            session: session
        )
        let host = ArborEditorHost(
            binding: binding,
            provider: provider,
            linkPreviewService: linkPreviewService()
        )
        let before = try await session.snapshot()
        let scoped = ArborDocumentReferenceCodec.encode(before.reference)
        #expect(ArborDocumentReferenceCodec.decode(scoped) == before.reference)
        #expect(!(await host.appendToDocument(DocumentReference("arbor://tr_sample/page/missing?path=/missing"), [.paragraph(text: "copy")])))
        #expect((try await session.snapshot()) == before)
    }

    @MainActor
    @Test("Move To combines editor outline targets with writable document destinations")
    func moveDestinations() async throws {
        let tree: TreeID = "tr_move"
        let home = WorkspaceNode(
            reference: .init(tree: tree, path: "/"),
            title: "Home",
            surface: .directoryDocument(source: "# Home\n", contentRevision: "r1", stored: true),
            provenance: .init(authority: .local, sourceDescription: "Test", contentRevision: "r1")
        )
        let destination = WorkspaceNode(
            reference: .init(tree: tree, path: "/destination", pageID: "pg_destination"),
            title: "Destination",
            surface: .markdown(source: "# Destination\n", contentRevision: "r1"),
            provenance: .init(authority: .local, sourceDescription: "Test", contentRevision: "r1")
        )
        let provider = InMemoryWorkspaceProvider(
            nodes: [home, destination],
            children: [home.id: [destination.id]]
        )
        let session = try await provider.openDocument(home.reference)
        let binding = try await ArborDocumentBinding.open(reference: home.reference, session: session)
        let host = ArborEditorHost(
            binding: binding,
            provider: provider,
            linkPreviewService: linkPreviewService()
        )

        let documents = await host.moveDocuments(matching: "")
        #expect(documents.map(\.title) == ["Destination"])

        let targetID = BlockID()
        let target = InDocMoveTarget(id: targetID, title: "Section", kind: .heading(level: .h2), depth: 1)
        let requestTask = Task { await host.moveDestination(for: [BlockID()], candidates: [target]) }
        await Task.yield()
        #expect(host.moveRequest?.inDocumentCandidates == [target])
        host.resolveMoveRequest(with: .block(targetID))
        #expect(await requestTask.value == .block(targetID))
    }

    @MainActor
    @Test("Editor host delegates external previews and transcript actions to QuagmireExtras")
    func extrasHostServices() async throws {
        let provider = InMemoryWorkspaceProvider.sample()
        let reference = WorkspaceReference(
            tree: "tr_sample",
            path: "/welcome",
            pageID: "pg_welcome"
        )
        let session = try await provider.openDocument(reference)
        let binding = try await ArborDocumentBinding.open(reference: reference, session: session)
        let url = try #require(URL(string: "https://example.com/article"))
        let cacheDirectory = FileManager.default.temporaryDirectory
            .appending(path: "ArborQuagmireExtras-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: cacheDirectory) }
        let service = LinkPreviewService(cacheDirectory: cacheDirectory) { requested in
            LinkPreview(url: requested, title: "Example article", iconPNG: nil)
        }
        let host = ArborEditorHost(
            binding: binding,
            provider: provider,
            linkPreviewService: service
        )

        let preview = await host.linkPreview(for: url)
        #expect(preview?.url == url)
        #expect(preview?.title == "Example article")
        #expect(host.blockActions(in: binding.document).map(\.id)
            == TranscriptPolishingActions.actions().map(\.id))
        await session.close()
    }

    @MainActor
    @Test("Clean accepted replacement keeps matching BlockIDs and emits no authored commit")
    func acceptedReplacement() async throws {
        let provider = InMemoryWorkspaceProvider.sample()
        let reference = WorkspaceReference(tree: "tr_sample", path: "/welcome", pageID: "pg_welcome")
        let session = try await provider.openDocument(reference)
        let binding = try await ArborDocumentBinding.open(reference: reference, session: session)
        let originalIDs = binding.document.children.map(\.id)
        let base = try await session.snapshot()
        let confirmed = try await session.admit(source: base.source + "\nAdded externally.\n", baseContentRevision: base.contentRevision)
        await binding.applyAcceptedReplacement(confirmed)
        #expect(binding.document.children.first?.id == originalIDs.first)
        #expect(binding.lastError == nil)

        let reopened = ArborMarkdownCodec.open(
            source: confirmed.source,
            revision: confirmed.contentRevision,
            identitySeed: "replacement-check"
        )
        let rebased = ArborMarkdownCodec.rebased(reopened, preserving: binding.document.children)
        let (noOp, _) = ArborMarkdownCodec.admission(blocks: rebased.blocks, ledger: rebased.ledger)
        #expect(noOp.source == confirmed.source)
        #expect(noOp.patch.edits.isEmpty)
    }
}
