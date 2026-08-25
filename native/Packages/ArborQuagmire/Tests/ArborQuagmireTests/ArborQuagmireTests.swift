import ArborClient
import ArborKit
import ArborProviders
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

    @Test("First edit after frontmatter keeps one envelope and unique rebased BlockIDs")
    func firstEditAfterFrontmatter() throws {
        let source = """
        ---
        id: slxoya
        ---
        # Write all those profs I tagged re when2meet

        Questions:

        1. Want to come to this event?
        1. What time works?
        """ + "\n"
        let opened = ArborMarkdownCodec.open(
            source: source,
            revision: "r1",
            identitySeed: "slxoya"
        )
        var editedBlocks = opened.blocks
        editedBlocks[0].children.append(.numbered(text: AttributedString("")))

        let (admission, _) = ArborMarkdownCodec.admission(
            blocks: editedBlocks,
            ledger: opened.ledger
        )
        let envelope = "---\nid: slxoya\n---"
        #expect(admission.source.components(separatedBy: envelope).count == 2)
        #expect(admission.source.hasSuffix("1. \n\n"))
        #expect(try admission.patch.applying(to: source) == admission.source)

        let confirmed = ArborMarkdownCodec.open(
            source: admission.source,
            revision: "r2",
            identitySeed: "slxoya"
        )
        let rebased = ArborMarkdownCodec.rebased(confirmed, preserving: editedBlocks)
        var ids: [BlockID] = []
        func collect(_ blocks: [Block]) {
            for block in blocks {
                ids.append(block.id)
                collect(block.children)
            }
        }
        collect(rebased.blocks)
        #expect(ids.count == Set(ids).count)

        let (noOp, _) = ArborMarkdownCodec.admission(
            blocks: rebased.blocks,
            ledger: rebased.ledger
        )
        #expect(noOp.source == admission.source)
        #expect(noOp.patch.edits.isEmpty)
    }

    @Test("Empty list items retain their kinds and exact Markdown")
    func emptyListItems() throws {
        let source = "- \n\n1. \n\n- [ ] \n"
        let opened = ArborMarkdownCodec.open(
            source: source,
            revision: "r1",
            identitySeed: "empty-items"
        )
        #expect(opened.blocks.count == 3)
        if case .bullet = opened.blocks[0].kind {} else { Issue.record("Expected empty bullet") }
        if case .numbered = opened.blocks[1].kind {} else { Issue.record("Expected empty numbered item") }
        if case .todo = opened.blocks[2].kind {} else { Issue.record("Expected empty task") }
        let (admission, _) = ArborMarkdownCodec.admission(blocks: opened.blocks, ledger: opened.ledger)
        #expect(admission.source == source)
        #expect(admission.patch.edits.isEmpty)
    }

    @Test("Blank paragraph blocks round-trip as extra Markdown blank lines")
    func blankParagraphs() throws {
        let source = "before\n\n\nafter\n"
        let opened = ArborMarkdownCodec.open(
            source: source,
            revision: "r1",
            identitySeed: "blank-paragraph"
        )
        #expect(opened.blocks.count == 3)
        if case let .paragraph(text) = opened.blocks[1].kind {
            #expect(text.characters.isEmpty)
        } else {
            Issue.record("Expected an empty paragraph between the authored paragraphs")
        }
        let (noOp, _) = ArborMarkdownCodec.admission(blocks: opened.blocks, ledger: opened.ledger)
        #expect(noOp.source == source)
        #expect(noOp.patch.edits.isEmpty)

        let ordinary = ArborMarkdownCodec.open(
            source: "before\n\nafter\n",
            revision: "r1",
            identitySeed: "insert-blank"
        )
        var edited = ordinary.blocks
        let empty = Block.paragraph(text: AttributedString())
        edited.insert(empty, at: 1)
        let (inserted, _) = ArborMarkdownCodec.admission(blocks: edited, ledger: ordinary.ledger)
        #expect(inserted.source == "before\n\n\nafter\n")

        let confirmed = ArborMarkdownCodec.open(
            source: inserted.source,
            revision: "r2",
            identitySeed: "insert-blank"
        )
        let rebased = ArborMarkdownCodec.rebased(confirmed, preserving: edited)
        #expect(rebased.blocks[1].id == empty.id)
        let (confirmedNoOp, _) = ArborMarkdownCodec.admission(blocks: rebased.blocks, ledger: rebased.ledger)
        #expect(confirmedNoOp.source == inserted.source)
        #expect(confirmedNoOp.patch.edits.isEmpty)
    }

    @Test("Leading and trailing blank paragraphs use an invisible explicit marker")
    func edgeBlankParagraphs() throws {
        let blocks: [Block] = [
            .paragraph(text: AttributedString()),
            .paragraph(text: AttributedString("middle")),
            .paragraph(text: AttributedString()),
        ]
        let source = ArborMarkdownCodec.serializeBlocks(blocks)
        #expect(source == "\u{00A0}\n\nmiddle\n\n\u{00A0}\n\n")
        let reopened = ArborMarkdownCodec.open(source: source, revision: "r1", identitySeed: "edge-blanks")
        #expect(reopened.blocks.count == 3)
        #expect(reopened.blocks.allSatisfy { block in
            if case .paragraph = block.kind { return true }
            return false
        })
        #expect(reopened.blocks[0].text.characters.isEmpty)
        #expect(String(reopened.blocks[1].text.characters) == "middle")
        #expect(reopened.blocks[2].text.characters.isEmpty)
    }

    @Test("Rebase reserves later preserved IDs when an earlier parsed kind changes")
    func rebaseReservesPreservedIDs() throws {
        let source = "# Tasks\n\n- First\n\n- Second\n\n- Third\n"
        let opened = ArborMarkdownCodec.open(
            source: source,
            revision: "r1",
            identitySeed: "insert-before"
        )
        var edited = opened.blocks
        let secondID = try #require(edited[0].children.first { String($0.text.characters) == "Second" }?.id)
        edited[0].children.insert(.toggle(title: "Inserted"), at: 1)
        let (admission, _) = ArborMarkdownCodec.admission(blocks: edited, ledger: opened.ledger)
        let confirmed = ArborMarkdownCodec.open(
            source: admission.source,
            revision: "r2",
            identitySeed: "insert-before"
        )
        let rebased = ArborMarkdownCodec.rebased(confirmed, preserving: edited)
        var ids: [BlockID] = []
        func collect(_ blocks: [Block]) {
            for block in blocks {
                ids.append(block.id)
                collect(block.children)
            }
        }
        collect(rebased.blocks)
        #expect(ids.count == Set(ids).count)
        #expect(rebased.blocks[0].children.first { String($0.text.characters) == "Second" }?.id == secondID)
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

    @Test("A linked list item is a bullet rather than a task checkbox")
    func linkedBullet() throws {
        let source = "- [https://example.com](https://example.com) -> destination\n"
        let opened = ArborMarkdownCodec.open(source: source, revision: "r", identitySeed: "linked-bullet")
        let block = try #require(opened.blocks.first)
        guard case .bullet = block.kind else {
            Issue.record("Expected a bullet, got \(block.kind)")
            return
        }
        #expect(String(block.text.characters) == "https://example.com -> destination")
        #expect(block.text.runs.contains { $0.link?.absoluteString == "https://example.com" })
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

        let savedRevision = saved.contentRevision
        host.persistCommit(changes: [], in: document)
        await host.flush(document)
        #expect(binding.lastError == nil, Comment(rawValue: String(reflecting: binding.lastError)))
        #expect((try await session.snapshot()).contentRevision == savedRevision)
    }

    @MainActor
    @Test("An exact self-confirmation does not replace the live editor tree")
    func exactSaveDoesNotReload() async throws {
        let reference = WorkspaceReference(tree: "tr_sample", path: "/blank", pageID: "pg_blank")
        let session = InMemoryDocumentSession(snapshot: .init(
            reference: reference,
            source: "before\n\nafter\n",
            contentRevision: "r1"
        ))
        let binding = try await ArborDocumentBinding.open(reference: reference, session: session)
        let host = ArborEditorHost(
            binding: binding,
            provider: InMemoryWorkspaceProvider.sample(),
            linkPreviewService: linkPreviewService()
        )
        let empty = Block.paragraph(text: AttributedString())
        binding.document.transaction(name: "Insert blank paragraph") {
            _ = binding.document.insertSubtree(empty, at: .root(at: 1))
        }
        var replacements: [DocumentReplacement] = []
        binding.document.didReplaceChildren = { replacements.append($0) }

        host.persistCommit(changes: [], in: binding.document)
        await host.flush(binding.document)

        #expect(binding.lastError == nil)
        #expect(replacements.isEmpty)
        #expect(binding.document.children[1].id == empty.id)
        #expect((try await session.snapshot()).source == "before\n\n\nafter\n")
    }

    @MainActor
    @Test("An already durable edit resolves a stale acknowledgement as success")
    func staleExactSaveIsIdempotent() async throws {
        let reference = WorkspaceReference(tree: "tr_sample", path: "/welcome", pageID: "pg_welcome")
        let session = AlreadyAppliedStaleSession(snapshot: .init(
            reference: reference,
            source: "# Welcome\n\nBefore.\n",
            contentRevision: "r1"
        ))
        let binding = try await ArborDocumentBinding.open(reference: reference, session: session)
        let host = ArborEditorHost(
            binding: binding,
            provider: InMemoryWorkspaceProvider.sample(),
            linkPreviewService: linkPreviewService()
        )
        let paragraph = try #require(binding.document.children.first?.children.first?.id)
        var replacements: [DocumentReplacement] = []
        binding.document.didReplaceChildren = { replacements.append($0) }
        binding.document.transaction(name: "Edit") {
            _ = binding.document.setText(paragraph, AttributedString("Already durable."))
        }

        host.persistCommit(changes: [], in: binding.document)
        await host.flush(binding.document)

        #expect(binding.lastError == nil, Comment(rawValue: String(reflecting: binding.lastError)))
        #expect(binding.conflict == nil)
        #expect(replacements.isEmpty)
        let saved = try await session.snapshot()
        #expect(saved.contentRevision == "r2")
        #expect(saved.source.contains("Already durable."))
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
        var openedReference: WorkspaceReference?
        let host = ArborEditorHost(
            binding: binding,
            provider: provider,
            linkPreviewService: linkPreviewService(),
            open: { openedReference = $0 }
        )
        let before = try await session.snapshot()
        let scoped = ArborDocumentReferenceCodec.encode(before.reference)
        #expect(ArborDocumentReferenceCodec.decode(scoped) == before.reference)
        let hunchLink = try #require(host.resolveReference(
            from: URL(string: "Reference.md#stdu7s")!,
            in: binding.document
        ))
        #expect(ArborDocumentReferenceCodec.decode(hunchLink)?.pathHint == "/Reference")
        let standaloneHunchLink = DocumentReference("welcome.md#pg_welcome")
        host.openDocument(standaloneHunchLink)
        #expect(openedReference?.pathHint == "/welcome")
        #expect(host.lookupDocument(standaloneHunchLink) == .pending)
        for _ in 0..<20 where host.lookupDocument(standaloneHunchLink) == .pending {
            await Task.yield()
        }
        guard case .present = host.lookupDocument(standaloneHunchLink) else {
            Issue.record("Expected the standalone Hunch link to resolve")
            return
        }
        #expect(!(await host.appendToDocument(DocumentReference("arbor://tr_sample/page/missing?path=/missing"), [.paragraph(text: "copy")])))
        #expect((try await session.snapshot()) == before)
    }

    @MainActor
    @Test("Live editor host resolves an existing raw reference when the protocol harness supplies it")
    func liveRawReference() async throws {
        guard let rawOrigin = ProcessInfo.processInfo.environment["ARBOR_TEST_URL"],
              let origin = URL(string: rawOrigin),
              let rawReference = ProcessInfo.processInfo.environment["ARBOR_TEST_RAW_REFERENCE"] else {
            return
        }
        let client = ArborClient(baseURL: origin)
        let root = try await client.node(.path("/"))
        let reference = WorkspaceReference(
            tree: TreeID(rawValue: root.tree ?? root.ref.tree ?? "local"),
            path: root.path,
            pageID: root.ref.pageID.map(PageID.init(rawValue:))
        )
        let provider = ArbordWorkspaceProvider(client: client)
        let session = try await provider.openDocument(reference)
        let binding = try await ArborDocumentBinding.open(reference: reference, session: session)
        let host = ArborEditorHost(
            binding: binding,
            provider: provider,
            linkPreviewService: linkPreviewService()
        )
        let documentReference = DocumentReference(rawReference)
        #expect(host.lookupDocument(documentReference) == .pending)
        for _ in 0..<100 where host.lookupDocument(documentReference) == .pending {
            try await Task.sleep(for: .milliseconds(10))
        }
        guard case .present = host.lookupDocument(documentReference) else {
            Issue.record("Expected the live raw reference to resolve")
            return
        }
        await session.close()
    }

    @MainActor
    @Test("Live editor preserves blank paragraphs without self-reloading")
    func liveEditThenRedundantCommit() async throws {
        guard let rawOrigin = ProcessInfo.processInfo.environment["ARBOR_TEST_EDIT_URL"],
              let origin = URL(string: rawOrigin) else {
            return
        }
        let client = ArborClient(baseURL: origin)
        let root = try await client.node(.path("/"))
        let reference = WorkspaceReference(
            tree: TreeID(rawValue: root.tree ?? root.ref.tree ?? "local"),
            path: root.path,
            pageID: root.ref.pageID.map(PageID.init(rawValue:))
        )
        let provider = ArbordWorkspaceProvider(client: client)
        let session = try await provider.openDocument(reference)
        let binding = try await ArborDocumentBinding.open(reference: reference, session: session)
        let host = ArborEditorHost(
            binding: binding,
            provider: provider,
            linkPreviewService: linkPreviewService()
        )
        let document = binding.document
        let parentID = try #require(document.children.first?.id)
        func emptyParagraphCount(_ document: Document) -> Int {
            var count = 0
            document.walk { block, _, _ in
                if case let .paragraph(text) = block.kind, text.characters.isEmpty { count += 1 }
            }
            return count
        }
        let originalEmptyParagraphs = emptyParagraphCount(document)
        var replacements: [DocumentReplacement] = []
        document.didReplaceChildren = { replacements.append($0) }

        document.transaction(name: "Insert empty bullet") {
            _ = document.insertSubtree(
                .bullet(text: ""),
                at: DropPath(parent: parentID, position: 1)
            )
        }
        host.persistCommit(changes: [], in: document)
        await host.flush(document)
        #expect(binding.lastError == nil, Comment(rawValue: String(reflecting: binding.lastError)))
        var ids: [BlockID] = []
        document.walk { block, _, _ in ids.append(block.id) }
        #expect(ids.count == Set(ids).count)

        document.transaction(name: "Insert middle blank paragraph") {
            _ = document.insertSubtree(
                .paragraph(text: AttributedString()),
                at: DropPath(parent: parentID, position: 2)
            )
        }
        host.persistCommit(changes: [], in: document)
        await host.flush(document)
        #expect(binding.lastError == nil, Comment(rawValue: String(reflecting: binding.lastError)))
        #expect(replacements.isEmpty)
        #expect(emptyParagraphCount(document) == originalEmptyParagraphs + 1)

        let parent = try #require(document.find(parentID))
        document.transaction(name: "Insert trailing blank paragraph") {
            _ = document.insertSubtree(
                .paragraph(text: AttributedString()),
                at: DropPath(parent: parentID, position: parent.children.count)
            )
        }
        host.persistCommit(changes: [], in: document)
        await host.flush(document)
        #expect(binding.lastError == nil, Comment(rawValue: String(reflecting: binding.lastError)))
        #expect(replacements.isEmpty)
        #expect(emptyParagraphCount(document) == originalEmptyParagraphs + 2)

        host.persistCommit(changes: [], in: document)
        await host.flush(document)
        #expect(binding.lastError == nil, Comment(rawValue: String(reflecting: binding.lastError)))
        let saved = try await session.snapshot()
        #expect(saved.source.contains("\n- \n"))
        #expect(saved.source.contains("\u{00A0}"))
        await session.close()

        let reopenedSession = try await provider.openDocument(reference)
        let reopened = try await ArborDocumentBinding.open(reference: reference, session: reopenedSession)
        #expect(emptyParagraphCount(reopened.document) == originalEmptyParagraphs + 2)
        await reopenedSession.close()
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

private actor AlreadyAppliedStaleSession: WorkspaceDocumentSession {
    nonisolated let identity: WorkspaceIdentity
    private var current: WorkspaceDocumentSnapshot

    init(snapshot: WorkspaceDocumentSnapshot) {
        identity = snapshot.reference.identity
        current = snapshot
    }

    func snapshot() throws -> WorkspaceDocumentSnapshot { current }

    func admit(source: String, baseContentRevision: String) throws -> WorkspaceDocumentSnapshot {
        guard current.contentRevision == baseContentRevision else {
            throw WorkspacePatchError.staleRevision(
                expected: baseContentRevision,
                actual: current.contentRevision
            )
        }
        current = WorkspaceDocumentSnapshot(
            reference: current.reference,
            source: source,
            contentRevision: "r2"
        )
        return current
    }

    func admit(patch: WorkspaceDocumentPatch) throws -> WorkspaceDocumentSnapshot {
        let source = try patch.applying(to: current.source)
        current = WorkspaceDocumentSnapshot(
            reference: current.reference,
            source: source,
            contentRevision: "r2"
        )
        throw WorkspacePatchError.staleRevision(
            expected: patch.baseContentRevision,
            actual: current.contentRevision
        )
    }

    func flush() {}
    func history() -> [WorkspaceHistoryEntry] { [] }
    func recover(revision: String) throws -> WorkspaceDocumentSnapshot { current }
    func close() {}
}
