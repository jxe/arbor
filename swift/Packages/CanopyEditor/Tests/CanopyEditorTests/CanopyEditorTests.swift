import CanopyAppKit
@testable import CanopyEditor
import Overstory
import Foundation
import Quagmire
import QuagmireExtras
import Testing

@Suite("Source-preserving Quagmire codec")
struct CanopyEditorTests {
    private func linkPreviewService() -> LinkPreviewService {
        LinkPreviewService(
            cacheDirectory: FileManager.default.temporaryDirectory
                .appending(path: "CanopyEditorTests-\(UUID().uuidString)")
        )
    }

    @Test("No-op is byte-identical across envelopes, CRLF, marks, and raw Markdown")
    func noOp() throws {
        let source = "---\r\nid: pg_exact\r\ntitle:  A  \r\n---\r\n\r\n# Heading *as authored*\r\n\r\nParagraph with **bold**, [link](other.md), $x^2$, and  two spaces.\r\n\r\n<table><tr><td>raw</td></tr></table>\r\n"
        let opened = CanopyMarkdownCodec.open(source: source, revision: "r1", identitySeed: "pg_exact")
        let (admission, _) = CanopyMarkdownCodec.admission(blocks: opened.blocks, ledger: opened.ledger)
        #expect(admission.source == source)
        #expect(admission.patch.edits.isEmpty)
    }

    @Test("Editing one structured block produces one guarded narrow replacement")
    func narrowEdit() throws {
        let source = "---\nid: pg_edit\n---\n\n# Title\n\nFirst paragraph.\n\nUntouched **raw style**.\n"
        let opened = CanopyMarkdownCodec.open(source: source, revision: "r1", identitySeed: "pg_edit")
        var blocks = opened.blocks
        let paragraph = try #require(blocks.first?.children.first)
        blocks[0].children[0] = paragraph.withText(AttributedString("Changed paragraph."))
        let (admission, _) = CanopyMarkdownCodec.admission(blocks: blocks, ledger: opened.ledger)
        #expect(admission.source.contains("Changed paragraph."))
        #expect(admission.source.contains("Untouched **raw style**."))
        #expect(admission.patch.edits.count == 1)
        #expect(try admission.patch.applying(to: source) == admission.source)
    }

    @Test("Source patches are byte-exact and never split a grapheme cluster")
    func graphemeSafePatch() throws {
        // Adding a combining accent or a skin-tone modifier changes the last
        // shared cluster, so the edit starts at that cluster, not mid-way.
        let accent = CanopyMarkdownCodec.patch(from: "cafe\n", to: "cafe\u{301}\n", revision: "r1")
        #expect(accent.edits.map(\.utf8Range) == [3..<4])
        #expect(accent.edits.map(\.expected) == ["e"])
        #expect(accent.edits.map(\.replacement) == ["e\u{301}"])
        let emoji = CanopyMarkdownCodec.patch(from: "👍 ok 👍\n", to: "👍 ok 👍🏽\n", revision: "r1")
        #expect(emoji.edits.map(\.utf8Range) == [8..<12])
        #expect(try emoji.applying(to: "👍 ok 👍\n") == "👍 ok 👍🏽\n")
        // Canonically equivalent spellings are still different bytes.
        let precomposed = "caf\u{E9}\n", decomposed = "cafe\u{301}\n"
        let respelled = CanopyMarkdownCodec.patch(from: precomposed, to: decomposed, revision: "r1")
        #expect(respelled.edits.count == 1)
        #expect(try respelled.applying(to: precomposed).utf8.elementsEqual(decomposed.utf8))
        #expect(CanopyMarkdownCodec.patch(from: decomposed, to: decomposed, revision: "r1").edits.isEmpty)
    }

    @Test("The leading H1 scan reads the first parsed block's title")
    func leadingH1Text() {
        let sources = [
            "", "\n\n", "# Title\n\nBody\n", "  # *Styled* \\_title\\_\r\nBody\r\n", "#\n", "## Second\n# Title\n",
            "Paragraph\n# Title\n", "---\nid: pg\n---\n\n# Front\n", "---\nunterminated\n# Title\n",
            "\t \n# After blanks\n", "```\n# not a heading\n```\n", "#Hashtag\n", "- # item\n",
        ]
        for source in sources {
            let parsed: String? = CanopyMarkdownCodec.parseBlocks(source).first.flatMap { block in
                guard case let .heading(level, text) = block.kind, level == .h1 else { return nil }
                return String(text.characters)
            }
            #expect(CanopyMarkdownCodec.leadingH1Text(source) == parsed, "\(source.debugDescription)")
        }
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
        let opened = CanopyMarkdownCodec.open(
            source: source,
            revision: "r1",
            identitySeed: "slxoya"
        )
        var editedBlocks = opened.blocks
        editedBlocks[0].children.append(.numbered(text: AttributedString("")))

        let (admission, _) = CanopyMarkdownCodec.admission(
            blocks: editedBlocks,
            ledger: opened.ledger
        )
        let envelope = "---\nid: slxoya\n---"
        #expect(admission.source.components(separatedBy: envelope).count == 2)
        #expect(admission.source.hasSuffix("1. \n\n"))
        #expect(try admission.patch.applying(to: source) == admission.source)

        let confirmed = CanopyMarkdownCodec.open(
            source: admission.source,
            revision: "r2",
            identitySeed: "slxoya"
        )
        let rebased = CanopyMarkdownCodec.rebased(confirmed, preserving: editedBlocks)
        var ids: [BlockID] = []
        func collect(_ blocks: [Block]) {
            for block in blocks {
                ids.append(block.id)
                collect(block.children)
            }
        }
        collect(rebased.blocks)
        #expect(ids.count == Set(ids).count)

        let (noOp, _) = CanopyMarkdownCodec.admission(
            blocks: rebased.blocks,
            ledger: rebased.ledger
        )
        #expect(noOp.source == admission.source)
        #expect(noOp.patch.edits.isEmpty)
    }

    @Test("Empty list items retain their kinds and exact Markdown")
    func emptyListItems() throws {
        let source = "- \n\n1. \n\n- [ ] \n"
        let opened = CanopyMarkdownCodec.open(
            source: source,
            revision: "r1",
            identitySeed: "empty-items"
        )
        #expect(opened.blocks.count == 3)
        if case .bullet = opened.blocks[0].kind {} else { Issue.record("Expected empty bullet") }
        if case .numbered = opened.blocks[1].kind {} else { Issue.record("Expected empty numbered item") }
        if case .todo = opened.blocks[2].kind {} else { Issue.record("Expected empty task") }
        let (admission, _) = CanopyMarkdownCodec.admission(blocks: opened.blocks, ledger: opened.ledger)
        #expect(admission.source == source)
        #expect(admission.patch.edits.isEmpty)
    }

    @Test("Blank paragraph blocks round-trip as extra Markdown blank lines")
    func blankParagraphs() throws {
        let source = "before\n\n\nafter\n"
        let opened = CanopyMarkdownCodec.open(
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
        let (noOp, _) = CanopyMarkdownCodec.admission(blocks: opened.blocks, ledger: opened.ledger)
        #expect(noOp.source == source)
        #expect(noOp.patch.edits.isEmpty)

        let ordinary = CanopyMarkdownCodec.open(
            source: "before\n\nafter\n",
            revision: "r1",
            identitySeed: "insert-blank"
        )
        var edited = ordinary.blocks
        let empty = Block.paragraph(text: AttributedString())
        edited.insert(empty, at: 1)
        let (inserted, _) = CanopyMarkdownCodec.admission(blocks: edited, ledger: ordinary.ledger)
        #expect(inserted.source == "before\n\n\nafter\n")

        let confirmed = CanopyMarkdownCodec.open(
            source: inserted.source,
            revision: "r2",
            identitySeed: "insert-blank"
        )
        let rebased = CanopyMarkdownCodec.rebased(confirmed, preserving: edited)
        #expect(rebased.blocks[1].id == empty.id)
        let (confirmedNoOp, _) = CanopyMarkdownCodec.admission(blocks: rebased.blocks, ledger: rebased.ledger)
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
        let source = CanopyMarkdownCodec.serializeBlocks(blocks)
        #expect(source == "\u{00A0}\n\nmiddle\n\n\u{00A0}\n\n")
        let reopened = CanopyMarkdownCodec.open(source: source, revision: "r1", identitySeed: "edge-blanks")
        #expect(reopened.blocks.count == 3)
        #expect(reopened.blocks.allSatisfy { block in
            if case .paragraph = block.kind { return true }
            return false
        })
        #expect(reopened.blocks[0].text.characters.isEmpty)
        #expect(String(reopened.blocks[1].text.characters) == "middle")
        #expect(reopened.blocks[2].text.characters.isEmpty)
    }

    @Test("Empty headings survive Markdown round trips")
    func emptyHeadingRoundTrip() throws {
        let blocks = (1...6).map { level in
            Block.heading(level: level, text: AttributedString())
        }
        let source = CanopyMarkdownCodec.serializeBlocks(blocks)
        let reopened = CanopyMarkdownCodec.open(
            source: source,
            revision: "r1",
            identitySeed: "empty-headings"
        )

        var reopenedHeadings: [Block] = []
        func collect(_ blocks: [Block]) {
            for block in blocks {
                reopenedHeadings.append(block)
                collect(block.children)
            }
        }
        collect(reopened.blocks)

        #expect(reopenedHeadings.count == 6)
        for (index, block) in reopenedHeadings.enumerated() {
            guard case let .heading(level, text) = block.kind else {
                Issue.record("Expected heading at index \(index)")
                continue
            }
            #expect(level.rawValue == index + 1)
            #expect(text.characters.isEmpty)
        }
    }

    @Test("Rebase reserves later preserved IDs when an earlier parsed kind changes")
    func rebaseReservesPreservedIDs() throws {
        let source = "# Tasks\n\n- First\n\n- Second\n\n- Third\n"
        let opened = CanopyMarkdownCodec.open(
            source: source,
            revision: "r1",
            identitySeed: "insert-before"
        )
        var edited = opened.blocks
        let secondID = try #require(edited[0].children.first { String($0.text.characters) == "Second" }?.id)
        edited[0].children.insert(.toggle(title: "Inserted"), at: 1)
        let (admission, _) = CanopyMarkdownCodec.admission(blocks: edited, ledger: opened.ledger)
        let confirmed = CanopyMarkdownCodec.open(
            source: admission.source,
            revision: "r2",
            identitySeed: "insert-before"
        )
        let rebased = CanopyMarkdownCodec.rebased(confirmed, preserving: edited)
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
        let opened = CanopyMarkdownCodec.open(source: source, revision: "r1", identitySeed: "marks")
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
        let (admission, _) = CanopyMarkdownCodec.admission(blocks: blocks, ledger: opened.ledger)
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
        let opened = CanopyMarkdownCodec.open(source: source, revision: "r", identitySeed: "kinds")
        let (admission, _) = CanopyMarkdownCodec.admission(blocks: opened.blocks, ledger: opened.ledger)
        #expect(admission.source == source)
    }

    @Test("Toggles and indented bodies round-trip without touching source bytes")
    func toggleNoOpRoundTrip() throws {
        let source = "---\r\nid: pg_toggles\r\n---\r\n\r\n▸ **Outer**\r\n  Intro.\r\n  ▸ Inner\r\n    - child\r\n  ## Inside\r\n  body\r\n- list\r\n  ▸ Nested\r\n    ```text\r\n    ▸ literal, not a toggle\r\n    ```\r\n"
        let opened = CanopyMarkdownCodec.open(
            source: source,
            revision: "r1",
            identitySeed: "pg_toggles"
        )
        let outer = try #require(opened.blocks.first)
        guard case .toggle = outer.kind else {
            Issue.record("Expected the outer toggle, got \(outer.kind)")
            return
        }
        #expect(outer.children.contains { if case .toggle = $0.kind { true } else { false } })
        #expect(outer.children.contains { if case .heading(.h2, _) = $0.kind { true } else { false } })
        let list = try #require(opened.blocks.last)
        guard case .bullet = list.kind else {
            Issue.record("Expected the root list item")
            return
        }
        let nested = try #require(list.children.first)
        guard case .toggle = nested.kind else {
            Issue.record("Expected a toggle nested below the list item")
            return
        }
        guard case let .code(code, _) = nested.children.first?.kind else {
            Issue.record("Expected an opaque fenced-code child")
            return
        }
        #expect(code.contains("▸ literal, not a toggle"))

        let (admission, _) = CanopyMarkdownCodec.admission(blocks: opened.blocks, ledger: opened.ledger)
        #expect(admission.source == source)
        #expect(admission.patch.edits.isEmpty)
    }

    @Test("New and edited toggles serialize with the disclosure marker and reopen as toggles")
    func toggleCreateEditAndReopen() throws {
        var title = AttributedString("Details")
        title[title.startIndex..<title.endIndex][InlineAttributes.BoldAttribute.self] = true
        let blocks: [Block] = [
            .toggle(title: title, children: [
                .paragraph(text: AttributedString("Body")),
                .toggle(title: AttributedString("Nested"), children: [
                    .bullet(text: AttributedString("Child")),
                ]),
            ]),
        ]
        let source = CanopyMarkdownCodec.serializeBlocks(blocks)
        #expect(source.hasPrefix("▸ **Details**\n  Body"))
        #expect(source.contains("  ▸ Nested\n    - Child"))
        #expect(!source.hasPrefix("- Details"))

        let opened = CanopyMarkdownCodec.open(source: source, revision: "r1", identitySeed: "created-toggle")
        guard case .toggle = opened.blocks.first?.kind else {
            Issue.record("Created toggle reopened as a different block kind")
            return
        }
        #expect(opened.blocks.first?.children.count == 2)

        var edited = opened.blocks
        edited[0] = edited[0].withText(AttributedString("Changed"))
        let (admission, _) = CanopyMarkdownCodec.admission(blocks: edited, ledger: opened.ledger)
        #expect(admission.patch.edits.count == 1)
        #expect(admission.source.contains("▸ Changed"))
        #expect(admission.source.contains("  Body"))
        #expect(try admission.patch.applying(to: source) == admission.source)

        let confirmed = CanopyMarkdownCodec.open(
            source: admission.source,
            revision: "r2",
            identitySeed: "created-toggle"
        )
        guard case .toggle = confirmed.blocks.first?.kind else {
            Issue.record("Edited toggle did not survive provider acknowledgement")
            return
        }
    }

    @Test("Blank paragraphs inside a toggle remain inside its indented body")
    func toggleBlankParagraph() throws {
        let source = "▸ Notes\n  before\n  \n  \n  after\n"
        let opened = CanopyMarkdownCodec.open(source: source, revision: "r1", identitySeed: "toggle-blank")
        let toggle = try #require(opened.blocks.first)
        guard case .toggle = toggle.kind else {
            Issue.record("Expected toggle")
            return
        }
        #expect(toggle.children.count == 3)
        #expect(toggle.children[1].text.characters.isEmpty)
        let (admission, _) = CanopyMarkdownCodec.admission(blocks: opened.blocks, ledger: opened.ledger)
        #expect(admission.source == source)
    }

    @Test("A linked list item is a bullet rather than a task checkbox")
    func linkedBullet() throws {
        let source = "- [https://example.com](https://example.com) -> destination\n"
        let opened = CanopyMarkdownCodec.open(source: source, revision: "r", identitySeed: "linked-bullet")
        let block = try #require(opened.blocks.first)
        guard case .bullet = block.kind else {
            Issue.record("Expected a bullet, got \(block.kind)")
            return
        }
        #expect(String(block.text.characters) == "https://example.com -> destination")
        #expect(block.text.runs.contains { $0.link?.absoluteString == "https://example.com" })
        let (admission, _) = CanopyMarkdownCodec.admission(blocks: opened.blocks, ledger: opened.ledger)
        #expect(admission.source == source)
    }

    @Test("Full-row link labels preserve inline Markdown semantics")
    func documentLinkInlineLabel() throws {
        let source = "[🗓️ **Calendar**](Calendar.md#h31mlm)\n"
        let block = try #require(CanopyMarkdownCodec.parseBlocks(source).first)
        guard case let .documentLink(label, reference) = block.kind else {
            Issue.record("Expected a document link, got \(block.kind)")
            return
        }
        #expect(String(label.characters) == "🗓️ Calendar")
        #expect(label.runs.contains { $0[InlineAttributes.BoldAttribute.self] == true })
        #expect(reference.rawValue == "Calendar.md#h31mlm")
        #expect(CanopyMarkdownCodec.serializeBlocks([block]).contains("[🗓️ **Calendar**](Calendar.md#h31mlm)"))
    }

    @MainActor
    @Test("Source ranges of a known object map to the blocks they cover, never guessed")
    func sourceRangeBlocks() async throws {
        let source = "---\nid: pg_errands\n---\n\n# Errands\n\nPick up the bike.\n\n- Once here\n  - Run\n\nCall the landlord.\n"
        let reference = WorkspaceReference(tree: "tr_sample", path: "/errands", stableKey: markdownStableKey("pg_errands"))
        let session = RecordingAdmissionSession(snapshot: .init(reference: reference, source: source, contentRevision: "opaque-r1"))
        let binding = try await CanopyDocumentBinding.open(reference: reference, session: session)
        let object = ProtocolObjectCodec.hash(Data(source.utf8))
        func text(_ ids: [BlockID]?) -> [String]? {
            ids?.map { id in binding.document.find(id).map { String($0.text.characters) } ?? "?" }
        }
        let bytes = Array(source.utf8)
        func offset(_ needle: String) -> Int {
            let target = Array(needle.utf8)
            return (0...(bytes.count - target.count)).first { Array(bytes[$0..<($0 + target.count)]) == target }!
        }
        let list = offset("- Once here"), after = offset("Call the")
        #expect(text(binding.blocks(overlapping: list..<after, inSource: object)) == ["Once here", "Run"])
        // A retained deletion sits after the block that ends at its anchor.
        #expect(text(binding.blocks(overlapping: after..<after, inSource: object)) == ["Run"])
        #expect(binding.blocks(overlapping: list..<after, inSource: ProtocolObjectCodec.hash(Data("other".utf8))) == nil)
        // Frontmatter has no block to stand beside.
        #expect(binding.blocks(overlapping: 4..<18, inSource: object) == nil)
    }

    @MainActor
    @Test("Each commit is appended as captured, a burst during an append follows as one change, and flush waits for both")
    func hostPersistence() async throws {
        let provider = InMemoryWorkspaceProvider.sample()
        let reference = WorkspaceReference(tree: "tr_sample", path: "/welcome", stableKey: markdownStableKey("pg_welcome"))
        let session = RecordingAdmissionSession(snapshot: .init(
            reference: reference,
            source: "# Welcome\n\nNative Canopy is ready.\n",
            contentRevision: "r1"
        ))
        let binding = try await CanopyDocumentBinding.open(reference: reference, session: session)
        let host = CanopyEditorHost(
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

        let saved = await session.snapshot()
        #expect(await session.admissionCount() == 2)
        #expect(binding.lastError == nil, Comment(rawValue: String(describing: binding.lastError)))
        #expect(saved.source.contains("Final edit"), Comment(rawValue: saved.source))

        let savedRevision = saved.contentRevision
        host.persistCommit(changes: [], in: document)
        await host.flush(document)
        #expect(binding.lastError == nil, Comment(rawValue: String(reflecting: binding.lastError)))
        #expect((await session.snapshot()).contentRevision == savedRevision)
    }

    @MainActor
    @Test("Host-authored frontmatter replacements use the ordinary durable admission path")
    func hostSourceReplacement() async throws {
        let reference = WorkspaceReference(tree: "tr_profile", path: "/")
        let original = "---\ntype: person\n---\n\n# Profile\n"
        let replacement = "---\ntype: person\ndisplayName: \"Joe\"\n---\n\n# Profile\n"
        let session = RecordingAdmissionSession(snapshot: .init(
            reference: reference,
            source: original,
            contentRevision: "r1"
        ))
        let binding = try await CanopyDocumentBinding.open(reference: reference, session: session)

        try await binding.replaceSource(replacement)

        #expect(await session.snapshot().source == replacement)
        #expect(await session.admissionCount() == 1)
        #expect(binding.lastError == nil)
    }

    @MainActor
    @Test("A captured commit is appended without an explicit flush")
    func debouncedPersistence() async throws {
        let reference = WorkspaceReference(tree: "tr_sample", path: "/welcome", stableKey: markdownStableKey("pg_welcome"))
        let session = RecordingAdmissionSession(snapshot: .init(
            reference: reference,
            source: "# Welcome\n\nNative Canopy is ready.\n",
            contentRevision: "r1"
        ))
        let binding = try await CanopyDocumentBinding.open(reference: reference, session: session)
        let paragraph = try #require(binding.document.children.last)

        binding.document.transaction(name: "edit") {
            _ = binding.document.setText(paragraph.id, AttributedString("Appended edit"))
        }
        binding.appendCurrentGeneration()

        #expect(await session.admissionCount() == 0)
        try await Task.sleep(for: .milliseconds(400))
        #expect(await session.admissionCount() == 1)
        #expect((await session.snapshot()).source.contains("Appended edit"))
        await binding.close()
    }

    @MainActor
    @Test("Autoexpand waits for inactivity and later typing supersedes its save")
    func autoexpandPersistenceCoalescing() async throws {
        let reference = WorkspaceReference(tree: "tr_sample", path: "/welcome", stableKey: markdownStableKey("pg_welcome"))
        let session = RecordingAdmissionSession(snapshot: .init(
            reference: reference,
            source: "# Welcome\n\n\u{00A0}\n\n",
            contentRevision: "r1"
        ))
        let binding = try await CanopyDocumentBinding.open(reference: reference, session: session)
        let host = CanopyEditorHost(
            binding: binding,
            provider: InMemoryWorkspaceProvider.sample(),
            linkPreviewService: linkPreviewService()
        )
        let block = try #require(binding.document.children.last)

        binding.document.transaction(name: "Format Block") {
            binding.document.mutate(block.id) {
                $0.kind = .heading(level: .h1, text: AttributedString())
            }
        }
        host.persistCommit(changes: [], in: binding.document, after: .milliseconds(750))
        try await Task.sleep(for: .milliseconds(300))
        #expect(await session.admissionCount() == 0)

        host.noteEditingActivity(in: binding.document)
        try await Task.sleep(for: .milliseconds(500))
        #expect(await session.admissionCount() == 0)

        binding.document.transaction(name: "Type") {
            _ = binding.document.setText(block.id, AttributedString("Later text"))
        }
        host.persistCommit(changes: [], in: binding.document)
        try await Task.sleep(for: .milliseconds(800))

        #expect(await session.admissionCount() == 1)
        let saved = await session.snapshot()
        #expect(saved.source.contains("# Later text"), Comment(rawValue: saved.source))
        await binding.close()
    }

    @MainActor
    @Test("Autoexpand persists after inactivity when no more text arrives")
    func autoexpandPersistenceAfterInactivity() async throws {
        let reference = WorkspaceReference(tree: "tr_sample", path: "/welcome", stableKey: markdownStableKey("pg_welcome"))
        let session = RecordingAdmissionSession(snapshot: .init(
            reference: reference,
            source: "# Welcome\n\n\u{00A0}\n\n",
            contentRevision: "r1"
        ))
        let binding = try await CanopyDocumentBinding.open(reference: reference, session: session)
        let host = CanopyEditorHost(
            binding: binding,
            provider: InMemoryWorkspaceProvider.sample(),
            linkPreviewService: linkPreviewService()
        )
        let block = try #require(binding.document.children.last)

        binding.document.transaction(name: "Format Block") {
            binding.document.mutate(block.id) {
                $0.kind = .heading(level: .h1, text: AttributedString())
            }
        }
        host.persistCommit(changes: [], in: binding.document, after: .milliseconds(100))
        try await Task.sleep(for: .milliseconds(500))

        #expect(await session.admissionCount() == 1)
        let saved = await session.snapshot()
        let reopened = CanopyMarkdownCodec.open(
            source: saved.source,
            revision: saved.contentRevision,
            identitySeed: "autoexpand-inactivity"
        )
        #expect(reopened.blocks.last?.kind == .heading(level: .h1, text: AttributedString()))
        await binding.close()
    }

    @MainActor
    @Test("Writable page links expose the emoji picker and persist title icons")
    func linkedPageIcon() async throws {
        let provider = InMemoryWorkspaceProvider.sample()
        let currentReference = WorkspaceReference(
            tree: "tr_sample",
            path: "/welcome",
            stableKey: markdownStableKey("pg_welcome")
        )
        let currentSession = try await provider.openDocument(currentReference)
        let binding = try await CanopyDocumentBinding.open(reference: currentReference, session: currentSession)
        let root = WorkspaceReference(tree: "tr_sample", path: "/")
        let target = try #require(try await provider.perform(.createMarkdown(
            parent: root,
            name: "Target",
            source: "# Target\n\nBody **as authored**.\n"
        )))
        let targetReference = CanopyDocumentReferenceCodec.encode(target.reference)
        let host = CanopyEditorHost(
            binding: binding,
            provider: provider,
            linkPreviewService: linkPreviewService()
        )

        #expect(host.lookupDocument(targetReference) == .pending)
        for _ in 0..<20 where host.lookupDocument(targetReference) == .pending {
            await Task.yield()
        }
        #expect(host.lookupDocument(targetReference).can(.setIcon))

        #expect(await host.setDocumentIcon("🚀", for: targetReference))
        #expect(host.lookupDocument(targetReference).title == "🚀 Target")
        #expect(await host.setDocumentIcon("🌳", for: targetReference))
        #expect(host.lookupDocument(targetReference).title == "🌳 Target")

        let savedSession = try await provider.openDocument(target.reference)
        let saved = try await savedSession.snapshot()
        #expect(saved.source == "# 🌳 Target\n\nBody **as authored**.\n")
        await savedSession.close()
        await currentSession.close()
    }

    @MainActor
    @Test("Pasted images persist in order and resolve through provider bytes")
    func imageLifecycle() async throws {
        let provider = InMemoryWorkspaceProvider.sample()
        let reference = WorkspaceReference(tree: "tr_sample", path: "/welcome", stableKey: markdownStableKey("pg_welcome"))
        let session = try await provider.openDocument(reference)
        let binding = try await CanopyDocumentBinding.open(reference: reference, session: session)
        let host = CanopyEditorHost(
            binding: binding,
            provider: provider,
            linkPreviewService: linkPreviewService()
        )
        let first = Data([0, 1, 2])
        let second = Data([3, 4, 5])

        let sources = await host.saveImages([
            PastedImage(data: first, ext: "PNG"),
            PastedImage(data: second, ext: "jpg"),
        ], in: binding.document)

        #expect(sources.count == 2)
        #expect(sources.allSatisfy { $0.hasPrefix("/Assets/pasted-") })
        #expect(await host.imageResource(for: sources[0], in: binding.document) == .data(first))
        #expect(await host.imageResource(for: sources[1], in: binding.document) == .data(second))
        #expect(await host.imageResource(for: "https://example.com/image.png", in: binding.document) == nil)
        await session.close()
    }

    @MainActor
    @Test("Copy and append to another page report failures and leave the destination untouched")
    func copyFailuresAreReported() async throws {
        let provider = InMemoryWorkspaceProvider.sample()
        let destination = WorkspaceReference(tree: "tr_sample", path: "/welcome", stableKey: markdownStableKey("pg_welcome"))
        let destinationSession = try await provider.openDocument(destination)
        let before = try await destinationSession.snapshot()
        let reference = WorkspaceReference(tree: "tr_sample", path: "/origin")
        let session = RecordingAdmissionSession(snapshot: .init(reference: reference, source: "# Origin\n\nMoved text.\n", contentRevision: "r1"))
        // The session names a newer source than the one the editor's blocks were read from.
        await session.setCopyOrigin(.init(path: "/origin", source: "# Origin\n\nChanged elsewhere.\n"))
        let binding = try await CanopyDocumentBinding.open(reference: reference, session: session)
        var errors: [String] = []
        let host = CanopyEditorHost(
            binding: binding,
            provider: provider,
            linkPreviewService: linkPreviewService(),
            reportError: { errors.append($0) }
        )
        let target = CanopyDocumentReferenceCodec.encode(destination)

        let copied = try #require(binding.document.children.last)
        #expect(!(await host.copyToDocument(target, blocks: [copied], from: binding.document)))
        #expect(errors == ["Couldn't copy blocks: this page changed while copying. Try again."])
        #expect(try await destinationSession.snapshot() == before)
        #expect(await session.admissionCount() == 0)

        errors.removeAll()
        let missing = DocumentReference("arbor://tr_sample/page/missing?path=/missing")
        #expect(!(await host.appendToDocument(missing, [.paragraph(text: "copy")])))
        #expect(errors.count == 1)
        #expect(errors.first?.hasPrefix("Couldn't add blocks") == true)
        await destinationSession.close()
        await binding.close()
    }

    @MainActor
    @Test("Move to Document falls back to an exact copy when the provider cannot state one change")
    func moveFallsBackToCopy() async throws {
        let provider = InMemoryWorkspaceProvider.sample()
        let destination = WorkspaceReference(tree: "tr_sample", path: "/welcome", stableKey: markdownStableKey("pg_welcome"))
        let reference = WorkspaceReference(tree: "tr_sample", path: "/origin")
        let session = RecordingAdmissionSession(snapshot: .init(reference: reference, source: "Stays\n\nMoved\n\n", contentRevision: "r1"))
        let binding = try await CanopyDocumentBinding.open(reference: reference, session: session)
        var errors: [String] = []
        let host = CanopyEditorHost(binding: binding, provider: provider, linkPreviewService: linkPreviewService(), reportError: { errors.append($0) })
        let moved = binding.document.children[1]
        #expect(await host.appendToDocument(CanopyDocumentReferenceCodec.encode(destination), [moved]))
        let target = try await provider.openDocument(destination).snapshot().source
        #expect(target.hasSuffix("Moved\n\n"))
        #expect(errors.isEmpty)
        await binding.close()
    }

    @MainActor
    @Test("Page creation links exact titles, recovers retries, and disambiguates filename collisions")
    func pageCreationRecovery() async throws {
        let provider = InMemoryWorkspaceProvider.sample()
        let reference = WorkspaceReference(tree: "tr_sample", path: "/welcome", stableKey: markdownStableKey("pg_welcome"))
        let session = try await provider.openDocument(reference)
        let binding = try await CanopyDocumentBinding.open(reference: reference, session: session)
        var errors: [String] = []
        let host = CanopyEditorHost(
            binding: binding,
            provider: provider,
            linkPreviewService: linkPreviewService(),
            reportError: { errors.append($0) }
        )

        let first = try #require(await host.createDocument(
            title: "Arbor demo",
            requestedReference: nil,
            initialContent: nil
        ))
        let firstReference = try #require(host.workspaceReference(for: first))
        let createdSession = try await provider.openDocument(firstReference)
        let createdSnapshot = try await createdSession.snapshot()
        _ = try await createdSession.admit(
            source: "---\nid: pg_created\n---\n\n" + createdSnapshot.source,
            baseContentRevision: createdSnapshot.contentRevision
        )
        await createdSession.close()
        let retry = try #require(await host.createDocument(
            title: "Arbor demo",
            requestedReference: nil,
            initialContent: nil
        ))
        let existing = try #require(await host.createDocument(
            title: "Welcome",
            requestedReference: nil,
            initialContent: nil
        ))
        let root = WorkspaceReference(tree: "tr_sample", path: "/")
        let nested = try #require(await provider.perform(.createDirectory(parent: root, name: "Nested")))
        let remoteMatch = try #require(await provider.perform(.createMarkdown(
            parent: nested.reference,
            name: "Remote-match",
            source: "# Remote match\n"
        )))
        let remote = try #require(await host.createDocument(
            title: "Remote match",
            requestedReference: nil,
            initialContent: nil
        ))
        _ = try #require(await provider.perform(.createMarkdown(
            parent: reference,
            name: "Collision",
            source: "# Different title\n"
        )))
        let disambiguated = try #require(await host.createDocument(
            title: "Collision",
            requestedReference: nil,
            initialContent: nil
        ))

        #expect(firstReference.path == "/welcome/Arbor-demo")
        #expect(firstReference.stableKey != nil)
        // The created page's link is the relative Markdown link this page stores, unchanged by linkURL.
        #expect(first.rawValue.hasPrefix("welcome/Arbor-demo.md#arbor-key=id:pg_"))
        let authoredLink = try #require(host.linkURL(for: first, in: binding.document))
        #expect(authoredLink.relativeString == first.rawValue)
        #expect(authoredLink.scheme == nil)
        #expect(retry == first, "a retry should recover the page materialized by the first attempt")
        #expect(host.workspaceReference(for: existing)?.path == "/welcome")
        #expect(host.workspaceReference(for: remote)?.path == remoteMatch.reference.path)
        #expect(host.workspaceReference(for: disambiguated)?.path == "/welcome/Collision-2")
        #expect(errors.isEmpty)
        await session.close()
    }

    @MainActor
    @Test("Mention search prioritizes matching page names over body-text matches")
    func mentionSearchUsesPageIdentityFields() async throws {
        let provider = InMemoryWorkspaceProvider.sample()
        let reference = WorkspaceReference(
            tree: "tr_sample",
            path: "/welcome",
            stableKey: markdownStableKey("pg_welcome")
        )
        let session = try await provider.openDocument(reference)
        let binding = try await CanopyDocumentBinding.open(reference: reference, session: session)
        let host = CanopyEditorHost(
            binding: binding,
            provider: provider,
            linkPreviewService: linkPreviewService()
        )
        let root = WorkspaceReference(tree: "tr_sample", path: "/")
        for index in 0..<9 {
            _ = try #require(await provider.perform(.createMarkdown(
                parent: root,
                name: "noise-\(index)",
                source: "# A\(index)\n\nValues appears only in this page body.\n"
            )))
        }
        let target = try #require(await provider.perform(.createMarkdown(
            parent: root,
            name: "Values",
            source: "# Values\n"
        )))

        let suggestions = await host.suggestDocuments("Values", in: binding.document)

        #expect(suggestions.first?.title == "Values")
        let targetKey = try #require(target.reference.stableKey.flatMap(encodeStableKey))
        #expect(suggestions.first?.id == DocumentReference("Values.md#arbor-key=\(targetKey)"))
        #expect(host.linkURL(for: try #require(suggestions.first?.id), in: binding.document)?.relativeString
            == "Values.md#arbor-key=\(targetKey)")
        #expect(suggestions.allSatisfy {
            $0.title.localizedCaseInsensitiveContains("Values")
                || ($0.subtitle?.localizedCaseInsensitiveContains("Values") == true)
        })
        await session.close()
    }

    @MainActor
    @Test("A deleted full-row link only offers to trash a now-unlinked writable page")
    func deletedDocumentLinkTrashDecision() async throws {
        let provider = InMemoryWorkspaceProvider.sample()
        let source = WorkspaceReference(
            tree: "tr_sample",
            path: "/welcome",
            stableKey: markdownStableKey("pg_welcome")
        )
        let session = try await provider.openDocument(source)
        let binding = try await CanopyDocumentBinding.open(reference: source, session: session)
        let host = CanopyEditorHost(
            binding: binding,
            provider: provider,
            linkPreviewService: linkPreviewService()
        )
        let root = WorkspaceReference(tree: "tr_sample", path: "/")
        let target = try #require(await provider.perform(.createMarkdown(
            parent: root,
            name: "Target",
            source: "# Target\n"
        )))

        let orphan = await host.orphanedDocumentAfterDeletingLink(target.reference, from: source)
        #expect(orphan?.reference == target.reference)
        #expect(await host.orphanedDocumentAfterDeletingLink(source, from: source) == nil)

        _ = try #require(await provider.perform(.createMarkdown(
            parent: root,
            name: "Other",
            source: "# Other\n\n[Target](/Target)\n"
        )))
        let stillLinked = await host.orphanedDocumentAfterDeletingLink(target.reference, from: source)
        #expect(stillLinked == nil)

        // The regression: another page holding a *document-link row* — an `arbor://` locator, not a
        // readable path — still links the target, so deleting this page's link must stay silent.
        let rowTarget = try #require(await provider.perform(.createMarkdown(
            parent: root,
            name: "RowTarget",
            source: "# RowTarget\n"
        )))
        #expect(await host.orphanedDocumentAfterDeletingLink(rowTarget.reference, from: source) != nil)
        let row = CanopyDocumentReferenceCodec.encode(rowTarget.reference)
        _ = try #require(await provider.perform(.createMarkdown(
            parent: root,
            name: "RowLinker",
            source: "# RowLinker\n\n[RowTarget](\(row.rawValue))\n"
        )))
        #expect(await host.orphanedDocumentAfterDeletingLink(rowTarget.reference, from: source) == nil)
        await session.close()
    }

    @MainActor
    @Test("An exact self-confirmation does not replace the live editor tree")
    func exactSaveDoesNotReload() async throws {
        let reference = WorkspaceReference(tree: "tr_sample", path: "/blank", stableKey: markdownStableKey("pg_blank"))
        let session = InMemoryDocumentSession(snapshot: .init(
            reference: reference,
            source: "before\n\nafter\n",
            contentRevision: "r1"
        ))
        let binding = try await CanopyDocumentBinding.open(reference: reference, session: session)
        let host = CanopyEditorHost(
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
    @Test("Duplicate tabs share one binding and save chain by PageID")
    func duplicateTabs() async throws {
        let provider = InMemoryWorkspaceProvider.sample()
        let workspace = CanopyEditorWorkspace(provider: provider)
        let first = try await workspace.lease(.init(tree: "tr_sample", path: "/welcome", stableKey: markdownStableKey("pg_welcome")))
        let second = try await workspace.lease(.init(tree: "tr_sample", path: "/stale", stableKey: markdownStableKey("pg_welcome")))
        #expect(first.binding === second.binding)
        await workspace.release(first)
        await workspace.release(second)
    }

    @MainActor
    @Test("Provider-backed transcript delivery updates an active PageID binding")
    func activeTranscriptDelivery() async throws {
        let provider = InMemoryWorkspaceProvider.sample()
        let workspace = CanopyEditorWorkspace(provider: provider)
        let reference = WorkspaceReference(
            tree: "tr_sample",
            path: "/welcome",
            stableKey: markdownStableKey("pg_welcome")
        )
        let lease = try await workspace.lease(reference)

        try await workspace.appendTranscript(
            "Captured through the workspace.",
            to: markdownStableKey("pg_welcome"),
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
        #expect(snapshot.source.trimmingCharacters(in: .whitespacesAndNewlines).hasSuffix(
            "Captured through the workspace."
        ))
        await workspace.release(lease)
    }

    @MainActor
    @Test("Active transcript delivery uses the first microphone heading")
    func activeTranscriptTargetsFirstVoiceHeading() async throws {
        let tree: TreeID = "tr_voice"
        let reference = WorkspaceReference(
            tree: tree,
            path: "/voice",
            stableKey: markdownStableKey("pg_voice")
        )
        let source = "# 🎙 Notes\n\nExisting.\n\n## Nested 🎙️\n\nNested body.\n\n# 🎙️ Later\n\nLater body.\n"
        let node = WorkspaceNode(
            reference: reference,
            title: "Voice",
            surface: .markdown(source: source, contentRevision: "r1"),
            provenance: .init(authority: .local, sourceDescription: "Test", contentRevision: "r1")
        )
        let provider = InMemoryWorkspaceProvider(nodes: [node])
        let workspace = CanopyEditorWorkspace(provider: provider)
        let lease = try await workspace.lease(reference)

        try await workspace.appendTranscript(
            "Captured in the first section.",
            to: markdownStableKey("pg_voice"),
            in: tree
        )

        let first = try #require(lease.binding.document.children.first)
        var firstSectionContainsTranscript = false
        func inspect(_ block: Block) {
            if String(block.text.characters) == "Captured in the first section." {
                firstSectionContainsTranscript = true
            }
            block.children.forEach(inspect)
        }
        inspect(first)
        #expect(firstSectionContainsTranscript)
        let later = try #require(lease.binding.document.children.last)
        #expect(!later.children.contains { String($0.text.characters) == "Captured in the first section." })
        let saved = try await lease.binding.snapshot()
        let transcriptRange = try #require(saved.source.range(of: "Captured in the first section."))
        let laterRange = try #require(saved.source.range(of: "# 🎙️ Later"))
        #expect(transcriptRange.lowerBound < laterRange.lowerBound)
        await workspace.release(lease)
    }

    @MainActor
    @Test("Recovered transcript delivery routes by PageID into a microphone section")
    func recoveredTranscriptTargetsVoiceHeading() async throws {
        let tree: TreeID = "tr_recoveredvoice"
        let reference = WorkspaceReference(
            tree: tree,
            path: "/voice",
            stableKey: markdownStableKey("pg_recovered_voice")
        )
        let node = WorkspaceNode(
            reference: reference,
            title: "Voice",
            surface: .markdown(
                source: "# Inbox\n\nBefore.\n\n## 🎙 Recordings\n\nExisting recording.\n\n# After\n\nAfter body.\n",
                contentRevision: "r1"
            ),
            provenance: .init(authority: .local, sourceDescription: "Test", contentRevision: "r1")
        )
        let provider = InMemoryWorkspaceProvider(nodes: [node])
        let workspace = CanopyEditorWorkspace(provider: provider)

        try await workspace.appendTranscript(
            "Recovered into recordings.",
            to: markdownStableKey("pg_recovered_voice"),
            in: tree
        )

        let saved = try await provider.resolve(reference)
        guard case let .markdown(result, _) = saved.surface else {
            Issue.record("Voice destination was no longer Markdown")
            return
        }
        let transcriptRange = try #require(result.range(of: "Recovered into recordings."))
        let afterRange = try #require(result.range(of: "# After"))
        #expect(transcriptRange.lowerBound < afterRange.lowerBound)
    }

    @MainActor
    @Test("Destination failure leaves the source exact and references retain tree plus PageID scope")
    func safeActions() async throws {
        let provider = InMemoryWorkspaceProvider.sample()
        let session = try await provider.openDocument(.init(tree: "tr_sample", path: "/welcome", stableKey: markdownStableKey("pg_welcome")))
        let binding = try await CanopyDocumentBinding.open(
            reference: .init(tree: "tr_sample", path: "/welcome", stableKey: markdownStableKey("pg_welcome")),
            session: session
        )
        var openedReference: WorkspaceReference?
        let host = CanopyEditorHost(
            binding: binding,
            provider: provider,
            linkPreviewService: linkPreviewService(),
            open: { openedReference = $0 }
        )
        let before = try await session.snapshot()
        let scoped = CanopyDocumentReferenceCodec.encode(before.reference)
        #expect(CanopyDocumentReferenceCodec.decode(scoped) == before.reference)
        let hunchLink = try #require(host.resolveReference(
            from: URL(string: "Reference.md#stdu7s")!,
            in: binding.document
        ))
        #expect(hunchLink.rawValue == "Reference.md#stdu7s")
        #expect(host.workspaceReference(for: hunchLink) == WorkspaceReference(tree: "tr_sample", path: "/Reference"))
        let standaloneHunchLink = DocumentReference("welcome.md#arbor-key=id:pg_welcome")
        host.openDocument(standaloneHunchLink)
        #expect(openedReference?.path == "/welcome")
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
    @Test("Move To combines editor outline targets with writable document destinations")
    func moveDestinations() async throws {
        let tree: TreeID = "tr_move"
        let home = WorkspaceNode(
            reference: .init(tree: tree, path: "/"),
            title: "Home",
            surface: .directoryDocument(source: "# Home\n\n[Destination](/destination)\n", contentRevision: "r1", stored: true),
            provenance: .init(authority: .local, sourceDescription: "Test", contentRevision: "r1")
        )
        let destination = WorkspaceNode(
            reference: .init(tree: tree, path: "/destination", stableKey: markdownStableKey("pg_destination")),
            title: "Destination",
            surface: .markdown(source: "# Destination\n", contentRevision: "r1"),
            provenance: .init(authority: .local, sourceDescription: "Test", contentRevision: "r1")
        )
        let provider = InMemoryWorkspaceProvider(
            nodes: [home, destination],
            children: [home.id: [destination.id]]
        )
        let session = try await provider.openDocument(home.reference)
        let binding = try await CanopyDocumentBinding.open(reference: home.reference, session: session)
        let host = CanopyEditorHost(
            binding: binding,
            provider: provider,
            linkPreviewService: linkPreviewService()
        )

        let documents = await host.moveDocuments(matching: "")
        #expect(documents.map(\.title) == ["Destination"])
        #expect(documents.map(\.backlinkCount) == [1])

        let targetID = BlockID()
        let target = InDocMoveTarget(id: targetID, title: "Section", kind: .heading(level: .h2), depth: 1)
        let requestTask = Task { await host.moveDestination(for: [BlockID()], candidates: [target]) }
        await Task.yield()
        #expect(host.moveRequest?.inDocumentCandidates == [target])
        host.resolveMoveRequest(with: .block(targetID))
        #expect(await requestTask.value == .block(targetID))
    }

    @MainActor
    @Test("Directory children project at the marker and materialize when moved")
    func directoryChildrenProjectAndMaterialize() throws {
        let tree: TreeID = "tr_projected_children"
        let directory = WorkspaceReference(
            tree: tree,
            path: "/parent",
            stableKey: markdownStableKey("pg_parent")
        )
        let child = WorkspaceNode(
            reference: .init(
                tree: tree,
                path: "/parent/child",
                stableKey: markdownStableKey("pg_child")
            ),
            title: "Child",
            surface: .markdown(source: "# Child\n", contentRevision: "r1"),
            provenance: .init(authority: .local, sourceDescription: "Test", contentRevision: "r1")
        )
        let source = "# Parent\n\nBefore\n\n<!-- arbor:children -->\n"
        let opened = CanopyMarkdownCodec.open(
            source: source,
            revision: "r1",
            identitySeed: "projected-children"
        )
        let projected = CanopyMarkdownCodec.placeDirectoryChildren(
            [child],
            in: opened.blocks,
            directory: directory,
            sourceDirectory: "/parent"
        )
        let parent = try #require(projected.first)
        let markerIndex = try #require(parent.children.firstIndex {
            if case let .unsupported(_, display) = $0.kind { return display == "Children" }
            return false
        })
        let generated = try #require(parent.children.indices.contains(markerIndex + 1)
            ? parent.children[markerIndex + 1]
            : nil)

        #expect(CanopyMarkdownCodec.isProjectedChild(generated))
        #expect(CanopyMarkdownCodec.admission(blocks: projected, ledger: opened.ledger).0.source == source)

        let document = Document(id: DocumentID("projected-children"), children: projected)
        let generatedID = generated.id
        let parentID = parent.id
        let prepared = CanopyMarkdownCodec.materializingProjectedChildren([generated])
        document.transaction(name: "Move Child Link") {
            _ = document.replaceSubtree(generatedID, with: prepared)
            _ = document.moveSubtrees([generatedID], to: DropPath(parent: parentID, position: 0))
        }
        let admitted = CanopyMarkdownCodec.admission(blocks: document.children, ledger: opened.ledger).0.source
        #expect(document.find(generatedID).map(CanopyMarkdownCodec.isProjectedChild) == false)
        #expect(admitted.contains("[Child](child.md#arbor-key=id:pg_child)"))
        let linkRange = try #require(admitted.range(of: "[Child]("))
        let markerRange = try #require(admitted.range(of: "<!-- arbor:children -->"))
        #expect(linkRange.lowerBound < markerRange.lowerBound)
    }

    @MainActor
    @Test("A projected nested tree keeps its TreeID in the clickable reference")
    func nestedTreeChildProjection() async throws {
        let parentTree: TreeID = "tr_parent"
        let childReference = WorkspaceReference(tree: "tr_profile", path: "/")
        let directory = WorkspaceReference(tree: parentTree, path: "/")
        let child = WorkspaceNode(
            reference: childReference,
            title: "~joe",
            surface: .directory(summary: "Nested Overstory tree"),
            provenance: .init(authority: .local, sourceDescription: "Test"),
            isWritable: false
        )
        let opened = CanopyMarkdownCodec.open(
            source: "# Community\n\n<!-- arbor:children -->\n",
            revision: "r1",
            identitySeed: "nested-profile"
        )
        let projected = CanopyMarkdownCodec.placeDirectoryChildren(
            [child],
            in: opened.blocks,
            directory: directory,
            sourceDirectory: "/"
        )
        let heading = try #require(projected.first)
        let generated = try #require(heading.children.first(where: CanopyMarkdownCodec.isProjectedChild))
        guard case let .documentLink(label, reference) = generated.kind else {
            Issue.record("Expected a projected document link")
            return
        }
        #expect(String(label.characters) == "~joe")
        #expect(CanopyDocumentReferenceCodec.decode(reference) == childReference)
        #expect(reference.rawValue == "arbor://tr_profile/")

        let provider = InMemoryWorkspaceProvider.sample()
        let currentReference = WorkspaceReference(
            tree: "tr_sample",
            path: "/welcome",
            stableKey: markdownStableKey("pg_welcome")
        )
        let session = try await provider.openDocument(currentReference)
        let binding = try await CanopyDocumentBinding.open(reference: currentReference, session: session)
        var openedReference: WorkspaceReference?
        let host = CanopyEditorHost(
            binding: binding,
            provider: provider,
            linkPreviewService: linkPreviewService(),
            open: { openedReference = $0 }
        )

        let lookup = host.lookupDocument(reference)
        #expect(lookup.title == nil)
        #expect(lookup.capabilities == [.navigate])
        host.openDocument(reference)
        #expect(openedReference == childReference)
    }

    @MainActor
    @Test("Only a linked immediate child receives provider-owned structural Move")
    func linkedChildStructuralMove() async throws {
        let tree: TreeID = "tr_structuralmove"
        let root = WorkspaceNode(
            reference: .init(tree: tree, path: "/"),
            title: "Home",
            surface: .directoryDocument(source: "# Home\n", contentRevision: "r1", stored: true),
            provenance: .init(authority: .local, sourceDescription: "Test", contentRevision: "r1")
        )
        let parent = WorkspaceNode(
            reference: .init(tree: tree, path: "/parent", stableKey: markdownStableKey("pg_parent")),
            title: "Parent",
            surface: .directoryDocument(source: "# Parent\n", contentRevision: "r1", stored: true),
            provenance: root.provenance
        )
        let child = WorkspaceNode(
            reference: .init(tree: tree, path: "/parent/child", stableKey: markdownStableKey("pg_child")),
            title: "Child",
            surface: .markdown(source: "# Child\n", contentRevision: "r1"),
            provenance: root.provenance
        )
        let destination = WorkspaceNode(
            reference: .init(tree: tree, path: "/destination"),
            title: "Destination",
            surface: .directory(summary: nil),
            provenance: root.provenance
        )
        let pageDestination = WorkspaceNode(
            reference: .init(tree: tree, path: "/page-destination", stableKey: markdownStableKey("pg_page_destination")),
            title: "Page Destination",
            surface: .markdown(source: "# Page Destination\n", contentRevision: "r1"),
            provenance: root.provenance
        )
        let provider = InMemoryWorkspaceProvider(
            nodes: [root, parent, child, destination, pageDestination],
            children: [
                root.id: [parent.id, destination.id, pageDestination.id],
                parent.id: [child.id],
            ]
        )
        let session = try await provider.openDocument(parent.reference)
        let binding = try await CanopyDocumentBinding.open(reference: parent.reference, session: session)
        var opened: [WorkspaceReference] = []
        let host = CanopyEditorHost(
            binding: binding,
            provider: provider,
            linkPreviewService: linkPreviewService(),
            sourceDirectory: parent.sourceDirectory,
            open: { opened.append($0) }
        )
        #expect(parent.sourceDirectory == "/parent")
        let generatedChildLink = try #require(host.resolveReference(
            from: URL(string: "child")!,
            in: binding.document
        ))
        #expect(host.workspaceReference(for: generatedChildLink)?.path == "/parent/child")
        let legacyChildLink = try #require(host.resolveReference(
            from: URL(string: "stale-child.md#arbor-key=id:pg_child")!,
            in: binding.document
        ))
        #expect(host.workspaceReference(for: legacyChildLink) == WorkspaceReference(
            tree: tree,
            path: "/parent/stale-child",
            stableKey: markdownStableKey("pg_child")
        ))
        #expect(host.lookupDocument(legacyChildLink) == .pending)
        for _ in 0..<20 where host.lookupDocument(legacyChildLink) == .pending { await Task.yield() }
        #expect(host.lookupDocument(legacyChildLink).title == "Child")
        let relativeSiblingLink = try #require(host.resolveReference(
            from: URL(string: "../destination")!,
            in: binding.document
        ))
        #expect(host.workspaceReference(for: relativeSiblingLink)?.path == "/destination")
        let reference = CanopyDocumentReferenceCodec.encode(.init(
            tree: tree,
            path: "/stale-child-hint",
            stableKey: markdownStableKey("pg_child")
        ))
        let destinations = await host.structuralDestinations(for: child.reference, matching: "")
        #expect(destinations.contains { $0.reference.identity == pageDestination.reference.identity && !$0.isDirectory })

        let move = Task { await host.relocateDocument(reference, from: binding.document) }
        for _ in 0..<20 where host.structuralMoveRequest == nil { await Task.yield() }
        #expect(host.structuralMoveRequest?.reference.identity == child.reference.identity)
        host.resolveStructuralMoveRequest(with: destination.reference)
        #expect(await move.value)

        let resolved = try await provider.resolve(.init(tree: tree, path: "/stale", stableKey: markdownStableKey("pg_child")))
        #expect(resolved.reference.path == "/destination/child")
        #expect(!(await host.relocateDocument(
            CanopyDocumentReferenceCodec.encode(destination.reference),
            from: binding.document
        )))

        let moveCurrent = Task { await host.moveCurrentDocument() }
        for _ in 0..<20 where host.structuralMoveRequest == nil { await Task.yield() }
        host.resolveStructuralMoveRequest(with: pageDestination.reference)
        #expect(await moveCurrent.value)
        #expect(opened.last?.path == "/page-destination/parent")
        await session.close()
    }

    @MainActor
    @Test("Editor host delegates external previews and transcript actions to QuagmireExtras")
    func extrasHostServices() async throws {
        let provider = InMemoryWorkspaceProvider.sample()
        let reference = WorkspaceReference(
            tree: "tr_sample",
            path: "/welcome",
            stableKey: markdownStableKey("pg_welcome")
        )
        let session = try await provider.openDocument(reference)
        let binding = try await CanopyDocumentBinding.open(reference: reference, session: session)
        let url = try #require(URL(string: "https://example.com/article"))
        let cacheDirectory = FileManager.default.temporaryDirectory
            .appending(path: "ArborQuagmireExtras-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: cacheDirectory) }
        let service = LinkPreviewService(cacheDirectory: cacheDirectory) { requested in
            LinkPreview(url: requested, title: "Example article", iconPNG: nil)
        }
        let host = CanopyEditorHost(
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
        let reference = WorkspaceReference(tree: "tr_sample", path: "/welcome", stableKey: markdownStableKey("pg_welcome"))
        let session = try await provider.openDocument(reference)
        let binding = try await CanopyDocumentBinding.open(reference: reference, session: session)
        let originalIDs = binding.document.children.map(\.id)
        let base = try await session.snapshot()
        let confirmed = try await session.admit(source: base.source + "\nAdded externally.\n", baseContentRevision: base.contentRevision)
        await binding.applyAcceptedReplacement(confirmed)
        #expect(binding.document.children.first?.id == originalIDs.first)
        #expect(binding.lastError == nil)

        let reopened = CanopyMarkdownCodec.open(
            source: confirmed.source,
            revision: confirmed.contentRevision,
            identitySeed: "replacement-check"
        )
        let rebased = CanopyMarkdownCodec.rebased(reopened, preserving: binding.document.children)
        let (noOp, _) = CanopyMarkdownCodec.admission(blocks: rebased.blocks, ledger: rebased.ledger)
        #expect(noOp.source == confirmed.source)
        #expect(noOp.patch.edits.isEmpty)
    }

    @MainActor
    @Test("A clean open editor reconciles a live authoritative update in place")
    func liveAuthoritativeUpdate() async throws {
        let reference = WorkspaceReference(tree: "tr_live", path: "/", stableKey: markdownStableKey("pg_live"))
        let initial = WorkspaceDocumentSnapshot(
            reference: reference,
            source: "---\nid: pg_live\n---\n\n# Live\n",
            contentRevision: "r1"
        )
        let session = LiveUpdateSession(snapshot: initial)
        let binding = try await CanopyDocumentBinding.open(reference: reference, session: session)
        let originalHeadingID = binding.document.children.first?.id
        func blockCount() -> Int {
            var count = 0
            binding.document.walk { _, _, _ in count += 1 }
            return count
        }

        await Task.yield()
        await session.publish(source: initial.source + "\nChicken McNuggets?\n", revision: "r2")
        for _ in 0..<100 where blockCount() < 2 {
            try await Task.sleep(for: .milliseconds(10))
        }

        #expect(blockCount() == 2)
        #expect(binding.document.children.first?.id == originalHeadingID)
        #expect(binding.lastError == nil)
        #expect(!binding.isSaving)
        await binding.close()
    }

    @MainActor
    @Test("A live authoritative update cannot replace unadmitted editor text")
    func liveAuthoritativeUpdatePreservesDirtyEditor() async throws {
        let reference = WorkspaceReference(tree: "tr_livedirty", path: "/", stableKey: markdownStableKey("pg_live_dirty"))
        let initial = WorkspaceDocumentSnapshot(
            reference: reference,
            source: "---\nid: pg_live_dirty\n---\n\n# Hi\n\n- Before\n",
            contentRevision: "r1"
        )
        let session = LiveUpdateSession(snapshot: initial)
        let binding = try await CanopyDocumentBinding.open(reference: reference, session: session)
        var bulletID: BlockID?
        binding.document.walk { block, _, _ in
            if case .bullet = block.kind { bulletID = block.id }
        }
        let paragraphID = try #require(bulletID)
        binding.document.transaction(name: "unadmitted local typing") {
            _ = binding.document.setText(paragraphID, AttributedString("Typed locally"))
        }

        await Task.yield()
        await session.publish(source: initial.source.replacingOccurrences(of: "Before", with: "Remote"), revision: "r2")
        try await Task.sleep(for: .milliseconds(50))

        #expect(binding.document.find(paragraphID).map { String($0.text.characters) } == "Typed locally")
        #expect(binding.lastError == nil)
        await binding.close()
    }

    @MainActor
    @Test("An accepted prefix cannot replace a newer admitted editor generation")
    func acceptedPrefixPreservesNewerAdmission() async throws {
        let reference = WorkspaceReference(tree: "tr_liveprefix", path: "/", stableKey: markdownStableKey("pg_live_prefix"))
        let initial = WorkspaceDocumentSnapshot(
            reference: reference,
            source: "---\nid: pg_live_prefix\n---\n\n# Hi\n\n- Before\n",
            contentRevision: "r1"
        )
        let session = InterleavingLiveUpdateSession(snapshot: initial)
        let binding = try await CanopyDocumentBinding.open(reference: reference, session: session)
        var bulletID: BlockID?
        binding.document.walk { block, _, _ in
            if case .bullet = block.kind { bulletID = block.id }
        }
        let paragraphID = try #require(bulletID)

        await session.blockNextSnapshot()
        await session.publish(
            source: initial.source.replacingOccurrences(of: "Before", with: "Accepted prefix"),
            revision: "r-prefix"
        )
        await session.waitUntilSnapshotIsBlocked()

        binding.document.transaction(name: "newer local generation") {
            _ = binding.document.setText(paragraphID, AttributedString("Newest local"))
        }
        binding.appendCurrentGeneration()
        await binding.flush()
        await session.releaseBlockedSnapshot()
        try await Task.sleep(for: .milliseconds(50))

        #expect(binding.document.find(paragraphID).map { String($0.text.characters) } == "Newest local")
        #expect((await session.admittedSnapshot()).source.contains("Newest local"))
        #expect(binding.lastError == nil)
        await binding.close()
    }

    @MainActor
    @Test("A watched authoritative toggle remains a toggle after replacement")
    func liveToggleUpdate() async throws {
        let reference = WorkspaceReference(
            tree: "tr_livetoggle",
            path: "/",
            stableKey: markdownStableKey("pg_live_toggle")
        )
        let initial = WorkspaceDocumentSnapshot(
            reference: reference,
            source: "▸ Details\n  Original body.\n",
            contentRevision: "r1"
        )
        let session = LiveUpdateSession(snapshot: initial)
        let binding = try await CanopyDocumentBinding.open(reference: reference, session: session)
        await Task.yield()
        await session.publish(source: "▸ Updated details\n  Original body.\n", revision: "r2")

        var updated = false
        for _ in 0..<100 where !updated {
            if case let .toggle(title) = binding.document.children.first?.kind {
                updated = String(title.characters) == "Updated details"
            }
            if !updated { try await Task.sleep(for: .milliseconds(10)) }
        }

        #expect(updated)
        #expect(binding.document.children.first?.children.first.map { String($0.text.characters) } == "Original body.")
        #expect(binding.lastError == nil)
        await binding.close()
    }
}

private actor RecordingAdmissionSession: WorkspaceDocumentSession {
    nonisolated let identity: WorkspaceIdentity
    private var current: WorkspaceDocumentSnapshot
    private var admissions = 0
    private var patches: [WorkspaceDocumentPatch] = []

    init(snapshot: WorkspaceDocumentSnapshot) {
        identity = snapshot.reference.identity
        current = snapshot
    }

    func snapshot() -> WorkspaceDocumentSnapshot { current }

    func admit(source: String, baseContentRevision: String) throws -> WorkspaceDocumentSnapshot {
        guard current.contentRevision == baseContentRevision else {
            throw WorkspacePatchError.staleRevision(expected: baseContentRevision, actual: current.contentRevision)
        }
        admissions += 1
        current = WorkspaceDocumentSnapshot(
            reference: current.reference,
            source: source,
            contentRevision: "r\(admissions + 1)"
        )
        return current
    }

    func admit(patch: WorkspaceDocumentPatch) throws -> WorkspaceDocumentSnapshot {
        patches.append(patch)
        guard current.contentRevision == patch.baseContentRevision else {
            throw WorkspacePatchError.staleRevision(expected: patch.baseContentRevision, actual: current.contentRevision)
        }
        return try admit(
            source: patch.applying(to: current.source),
            baseContentRevision: patch.baseContentRevision
        )
    }

    private var intents: [WorkspaceDocumentIntent] = []
    func admit(intent: WorkspaceDocumentIntent) throws -> WorkspaceDocumentSnapshot {
        try intent.validate()
        intents.append(intent)
        return try admit(patch: intent.patch)
    }

    private var copyOrigin: WorkspaceCopyDocument?
    func setCopyOrigin(_ origin: WorkspaceCopyDocument?) { copyOrigin = origin }
    func copyDocument() -> WorkspaceCopyDocument? { copyOrigin }

    func admissionCount() -> Int { admissions }
    func admittedPatches() -> [WorkspaceDocumentPatch] { patches }
    /// Every intent admitted, with the generation chain the editor captured.
    func admittedIntents() -> [WorkspaceDocumentIntent] { intents }
    func flush() {}
    func history() -> [WorkspaceHistoryEntry] { [] }
    func recover(revision: String) -> WorkspaceDocumentSnapshot { current }
    func close() {}
}

private actor LiveUpdateSession: WorkspaceDocumentSession {
    nonisolated let identity: WorkspaceIdentity
    private var current: WorkspaceDocumentSnapshot
    private let stream: AsyncThrowingStream<WorkspaceDocumentSnapshot, Error>
    private let continuation: AsyncThrowingStream<WorkspaceDocumentSnapshot, Error>.Continuation

    init(snapshot: WorkspaceDocumentSnapshot) {
        identity = snapshot.reference.identity
        current = snapshot
        let pair = AsyncThrowingStream<WorkspaceDocumentSnapshot, Error>.makeStream()
        stream = pair.stream
        continuation = pair.continuation
    }

    func snapshot() -> WorkspaceDocumentSnapshot { current }
    func updates() async throws -> AsyncThrowingStream<WorkspaceDocumentSnapshot, Error> { stream }

    func publish(source: String, revision: String) {
        current = WorkspaceDocumentSnapshot(
            reference: current.reference,
            source: source,
            contentRevision: revision
        )
        continuation.yield(current)
    }

    func admit(source: String, baseContentRevision: String) throws -> WorkspaceDocumentSnapshot {
        guard current.contentRevision == baseContentRevision else {
            throw WorkspacePatchError.staleRevision(expected: baseContentRevision, actual: current.contentRevision)
        }
        current = WorkspaceDocumentSnapshot(
            reference: current.reference,
            source: source,
            contentRevision: "r-local"
        )
        return current
    }

    func flush() {}
    func history() -> [WorkspaceHistoryEntry] { [] }
    func recover(revision: String) -> WorkspaceDocumentSnapshot { current }
    func close() { continuation.finish() }
}

private actor InterleavingLiveUpdateSession: WorkspaceDocumentSession {
    nonisolated let identity: WorkspaceIdentity
    private var authoritative: WorkspaceDocumentSnapshot
    private var admitted: WorkspaceDocumentSnapshot
    private var admissionGeneration = 0
    private let stream: AsyncThrowingStream<WorkspaceDocumentSnapshot, Error>
    private let continuation: AsyncThrowingStream<WorkspaceDocumentSnapshot, Error>.Continuation
    private var shouldBlockNextSnapshot = false
    private var snapshotIsBlocked = false
    private var blockedWaiters: [CheckedContinuation<Void, Never>] = []
    private var snapshotRelease: CheckedContinuation<Void, Never>?

    init(snapshot: WorkspaceDocumentSnapshot) {
        identity = snapshot.reference.identity
        authoritative = snapshot
        admitted = snapshot
        let pair = AsyncThrowingStream<WorkspaceDocumentSnapshot, Error>.makeStream()
        stream = pair.stream
        continuation = pair.continuation
    }

    func blockNextSnapshot() { shouldBlockNextSnapshot = true }

    func waitUntilSnapshotIsBlocked() async {
        if snapshotIsBlocked { return }
        await withCheckedContinuation { blockedWaiters.append($0) }
    }

    func releaseBlockedSnapshot() {
        snapshotRelease?.resume()
        snapshotRelease = nil
    }

    func snapshot() async -> WorkspaceDocumentSnapshot {
        let captured = authoritative
        if shouldBlockNextSnapshot {
            shouldBlockNextSnapshot = false
            snapshotIsBlocked = true
            let waiters = blockedWaiters
            blockedWaiters.removeAll()
            waiters.forEach { $0.resume() }
            await withCheckedContinuation { snapshotRelease = $0 }
            snapshotIsBlocked = false
        }
        return captured
    }

    func updates() async throws -> AsyncThrowingStream<WorkspaceDocumentSnapshot, Error> { stream }

    func publish(source: String, revision: String) {
        authoritative = WorkspaceDocumentSnapshot(
            reference: authoritative.reference,
            source: source,
            contentRevision: revision
        )
        continuation.yield(authoritative)
    }

    func admit(source: String, baseContentRevision: String) throws -> WorkspaceDocumentSnapshot {
        guard admitted.contentRevision == baseContentRevision else {
            throw WorkspacePatchError.staleRevision(expected: baseContentRevision, actual: admitted.contentRevision)
        }
        admissionGeneration += 1
        admitted = WorkspaceDocumentSnapshot(
            reference: admitted.reference,
            source: source,
            contentRevision: "r-local-\(admissionGeneration)"
        )
        return admitted
    }

    func admit(patch: WorkspaceDocumentPatch) throws -> WorkspaceDocumentSnapshot {
        guard admitted.contentRevision == patch.baseContentRevision else {
            throw WorkspacePatchError.staleRevision(expected: patch.baseContentRevision, actual: admitted.contentRevision)
        }
        return try admit(
            source: patch.applying(to: admitted.source),
            baseContentRevision: patch.baseContentRevision
        )
    }

    func admittedSnapshot() -> WorkspaceDocumentSnapshot { admitted }
    func flush() {}
    func history() -> [WorkspaceHistoryEntry] { [] }
    func recover(revision: String) -> WorkspaceDocumentSnapshot { admitted }
    func close() { continuation.finish() }
}

@Test("A block reorder moves the exact source of the block that moved")
func reorderedSourceMove() throws {
    let source = "Alpha 🪴\r\n\r\nBeta\r\n\r\nGamma\r\n"
    let opened = CanopyMarkdownCodec.open(source:source,revision:"r",identitySeed:"lineage")
    let blocks = [opened.blocks[1], opened.blocks[0], opened.blocks[2]]
    let admission = CanopyMarkdownCodec.admission(blocks:blocks,ledger:opened.ledger).0
    #expect(admission.source == "Beta\r\n\r\nAlpha 🪴\r\n\r\nGamma\r\n")
    #expect(try admission.patch.applying(to:source) == admission.source)
    #expect(admission.patch.edits.isEmpty)
    let move = try #require(admission.patch.moves?.first)
    #expect(admission.patch.moves?.count == 1)
    let bytes = Data(source.utf8)
    #expect(Set([bytes.subdata(in:move.source), bytes.subdata(in:move.anchor)]) == Set([Data("Alpha 🪴\r\n\r\n".utf8), Data("Beta\r\n\r\n".utf8)]))
}

@Test("Reordering equal-byte blocks still retains distinct source intent")
func equalByteReorderMove() throws {
    let opened = CanopyMarkdownCodec.open(source:"same\n\nsame\n\n",revision:"r",identitySeed:"equal")
    #expect(opened.blocks.count == 2)
    let admission = CanopyMarkdownCodec.admission(blocks:opened.blocks.reversed(),ledger:opened.ledger).0
    // The bytes are unchanged, but one block moved past the other.
    #expect(admission.source == opened.ledger.source)
    #expect(admission.patch.moves?.count == 1)
    #expect(admission.patch.moves?.first.map { $0.source != $0.anchor } == true)
    #expect(try admission.patch.applying(to:opened.ledger.source) == admission.source)
}

@MainActor
@Test("Editor binding retains equal-byte reorder intent in the change it appends")
func boundEqualByteReorder() async throws {
    let reference = WorkspaceReference(tree:"tr_lineage",path:"/note")
    let session = RecordingAdmissionSession(snapshot:.init(reference:reference,source:"same\n\nsame\n\n",contentRevision:"r1"))
    let binding = try await CanopyDocumentBinding.open(reference:reference,session:session)
    binding.document.transaction(name:"reorder") {
        _ = binding.document.replaceChildrenReconciled(Array(binding.document.children.reversed()))
    }
    binding.appendCurrentGeneration()
    await binding.flush()
    let patches = await session.admittedPatches()
    #expect(patches.count == 1)
    #expect(patches.first?.moves?.count == 1)
    #expect(binding.lastError == nil)
    await binding.close()
}

@MainActor
@Test("Explicit duplication keeps its copy spans in the generation that captured it", arguments:[0,2])
func boundSourceCopy(position: Int) async throws {
    let reference = WorkspaceReference(tree:"tr_copy",path:"/note")
    let source = "Café\r\n\r\nsame\r\n\r\n"
    let session = RecordingAdmissionSession(snapshot:.init(reference:reference,source:source,contentRevision:"r1"))
    let binding = try await CanopyDocumentBinding.open(reference:reference,session:session)
    binding.document.didCommitTransaction = { _ in binding.appendCurrentGeneration() }
    let original = binding.document.children[0]
    _ = binding.document.insertCopies(of:[original],at:.init(parent:nil,position:position))
    // A later commit while the copy is being appended must not lose its evidence.
    binding.document.transaction(name:"unrelated append") {
        _ = binding.document.insertSubtree(.paragraph(text:AttributedString("later")),at:.init(parent:nil,position:binding.document.children.count))
    }
    await binding.flush()
    // The copy is appended at once; the later commit follows as the next
    // change, authored on the first one's acknowledgement.
    let intents = await session.admittedIntents()
    #expect(intents.count == 2)
    let first = try #require(intents.first)
    let copy = try #require(first.patch.edits.first { !($0.copies ?? []).isEmpty }?.copies?.first)
    #expect(Data(source.utf8).subdata(in:copy.source) == Data("Café\r\n\r\n".utf8))
    #expect(intents[1].patch.edits.allSatisfy { ($0.copies ?? []).isEmpty })
    #expect(intents[1].basis.source == first.source)
    #expect(binding.lastError == nil)
    await binding.close()
}

@Test("Copying unterminated Markdown keeps distinct blocks and exact copied bytes",arguments:[0,1])
func unterminatedSourceCopy(position:Int) throws {
    let opened = CanopyMarkdownCodec.open(source:"Café",revision:"r",identitySeed:"copy")
    let original = try #require(opened.blocks.first), copy = original.withFreshIDs()
    var blocks = opened.blocks; blocks.insert(copy,at:position)
    let admission = CanopyMarkdownCodec.admission(blocks:blocks,ledger:opened.ledger,copies:[copy.id:original.id]).0
    #expect(CanopyMarkdownCodec.open(source:admission.source,revision:"r",identitySeed:"result").blocks.count == 2)
    #expect(admission.patch.edits.first?.copies?.first?.source == 0..<"Café".utf8.count)
    #expect(try admission.patch.applying(to:"Café") == admission.source)
}

extension CanopyEditorTests {
    @Test("Foreign copies preserve original Markdown spelling and CRLF")
    func foreignCopySourceFidelity() throws {
        let source = "# Origin\r\n\r\n*  Exact café\r\n"
        let origin = CanopyMarkdownCodec.open(source: source, revision: "origin", identitySeed: "origin")
        let block = try #require(origin.blocks.first?.children.first)
        let copied = block.withFreshIDs()
        let destination = CanopyMarkdownCodec.open(source: "# Destination\r\n\r\n", revision: "destination", identitySeed: "destination")
        let record = try #require(origin.ledger.records[block.id])
        let (result, _) = CanopyMarkdownCodec.admission(blocks: destination.blocks + [copied], ledger: destination.ledger,
            foreignCopies: [copied.id: (record, WorkspaceCopyDocument(path: "/origin.md", source: source))])
        #expect(result.source.contains("*  Exact café\r\n"))
        #expect(try result.patch.applying(to: destination.ledger.source) == result.source)
        let spans = result.patch.edits.flatMap { $0.copies ?? [] }
        #expect(spans.count == 1)
        #expect(spans.first?.source == record.range)
        #expect(spans.first?.document?.path == "/origin.md")
    }

    @Test("Page rename healing rewrites authored paths without changing the title")
    @MainActor
    func pageRenameLinkHealing() async throws {
        let tree: TreeID = "tr_healing"
        let root = WorkspaceNode(
            reference: .init(tree: tree, path: "/"),
            title: "Home",
            surface: .directory(summary: nil),
            provenance: .init(authority: .local, sourceDescription: "Test")
        )
        let target = WorkspaceNode(
            reference: .init(tree: tree, path: "/old-name", stableKey: markdownStableKey("pg_target")),
            title: "A Different Title",
            surface: .markdown(source: "# A Different Title\n", contentRevision: "r1"),
            provenance: .init(authority: .local, sourceDescription: "Test", contentRevision: "r1")
        )
        let source = WorkspaceNode(
            reference: .init(tree: tree, path: "/source", stableKey: markdownStableKey("pg_source")),
            title: "Source",
            surface: .markdown(source: "[Target](old-name.md#arbor-key=id:pg_target)\n", contentRevision: "r1"),
            provenance: .init(authority: .local, sourceDescription: "Test", contentRevision: "r1")
        )
        let child = WorkspaceNode(
            reference: .init(tree: tree, path: "/old-name/child", stableKey: markdownStableKey("pg_child")),
            title: "Child",
            surface: .markdown(source: "[Source](../source.md#arbor-key=id:pg_source)\n", contentRevision: "r1"),
            provenance: .init(authority: .local, sourceDescription: "Test", contentRevision: "r1")
        )
        let childBacklink = WorkspaceNode(
            reference: .init(tree: tree, path: "/child-source", stableKey: markdownStableKey("pg_child_source")),
            title: "Child source",
            surface: .markdown(source: "[Child](old-name/child)\n", contentRevision: "r1"),
            provenance: .init(authority: .local, sourceDescription: "Test", contentRevision: "r1")
        )
        let provider = InMemoryWorkspaceProvider(
            nodes: [root, target, source, child, childBacklink],
            children: [root.id: [target.id, source.id, childBacklink.id], target.id: [child.id]]
        )
        let workspace = CanopyEditorWorkspace(provider: provider)
        let action = WorkspaceStructuralAction.rename(reference: target.reference, name: "private-name")
        let healingSources = await workspace.linkHealingSources(for: action)
        let renamed = try #require(try await provider.perform(action))
        await workspace.healLinks(
            in: healingSources,
            movedFrom: target.reference.path,
            to: renamed.reference
        )

        let healed = try await provider.openDocument(source.reference).snapshot()
        #expect(healed.source == "[Target](private-name.md#arbor-key=id:pg_target)\n")
        // A keyless inbound link gains its target's key as its path is rewritten.
        let healedChildBacklink = try await provider.openDocument(childBacklink.reference).snapshot()
        #expect(healedChildBacklink.source == "[Child](private-name/child.md#arbor-key=id:pg_child)\n")
        let movedChild = try await provider.resolve(.init(tree: tree, path: "/private-name/child", stableKey: child.reference.stableKey))
        let healedChild = try await provider.openDocument(movedChild.reference).snapshot()
        #expect(healedChild.source == "[Source](../source.md#arbor-key=id:pg_source)\n")
        #expect(renamed.title == "A Different Title")
        await workspace.closeAll()
    }
}

@Suite("Rearrangements publish as moves of exact source")
struct RearrangementTests {
    /// Rearrange the parsed tree with `change`, admit it, and check the patch
    /// reproduces the new source and that the source reopens as the tree.
    func admit(_ source: String, _ change: (inout [Block]) -> Void) throws -> (source: String, patch: WorkspaceDocumentPatch) {
        let opened = CanopyMarkdownCodec.open(source:source,revision:"r",identitySeed:"moves")
        var blocks = opened.blocks
        change(&blocks)
        let admission = CanopyMarkdownCodec.admission(blocks:blocks,ledger:opened.ledger).0
        #expect(try admission.patch.applying(to:source) == admission.source)
        let reopened = CanopyMarkdownCodec.open(source:admission.source,revision:"r2",identitySeed:"moves")
        #expect(CanopyMarkdownCodec.serializeBlocks(reopened.blocks) == CanopyMarkdownCodec.serializeBlocks(blocks))
        return (admission.source, admission.patch)
    }

    @Test("Indenting an item in place re-indents only its lines")
    func indentInPlace() throws {
        let result = try admit("- one\n- two\n- three\n") { blocks in
            let two = blocks.remove(at:1)
            blocks[0].children.append(two)
        }
        #expect(result.source == "- one\n  - two\n- three\n")
        #expect(result.patch.moves == nil)
        #expect(result.patch.edits.map(\.replacement) == ["  -"])
    }

    @Test("Outdenting a child removes its indentation")
    func outdent() throws {
        let result = try admit("- one\n  - child\n- two\n") { blocks in
            let child = blocks[0].children.removeFirst()
            blocks.insert(child, at:1)
        }
        #expect(result.source == "- one\n- child\n- two\n")
        #expect(result.patch.moves == nil)
        #expect(result.patch.edits.map(\.replacement) == [""])
    }

    @Test("Moving an item under another parent moves it and re-indents it where it lands")
    func moveUnderParent() throws {
        let result = try admit("- one\n- two\n  - child\n- three\n") { blocks in
            let three = blocks.removeLast()
            blocks[0].children.append(three)
        }
        #expect(result.source == "- one\n  - three\n- two\n  - child\n")
        #expect(result.patch.moves?.count == 1)
        #expect(result.patch.edits.map(\.replacement) == ["  -"])
    }

    @Test("A selection of several blocks lands as one chain, in order")
    func multipleBlocks() throws {
        let result = try admit("A\n\nB\n\nC\n\nD\n\n") { blocks in
            blocks = [blocks[2], blocks[3], blocks[0], blocks[1]]
        }
        #expect(result.source == "C\n\nD\n\nA\n\nB\n\n")
        #expect(result.patch.moves?.count == 2)
    }

    @Test("CRLF, multibyte and combining text move byte for byte")
    func exactBytes() throws {
        let result = try admit("Café\r\n\r\n- naïve ☕\r\n- e\u{301}\r\n") { blocks in
            let last = blocks.removeLast()
            blocks.insert(last, at:1)
            blocks[1].children.append(blocks.removeLast())
        }
        #expect(result.source == "Café\r\n\r\n- e\u{301}\r\n  - naïve ☕\r\n")
        #expect(result.patch.moves?.count == 1)
    }

    @Test("Tab indentation falls back to an ordinary edit")
    func tabFallback() throws {
        let tabs = try admit("- one\n\t- child\n- two\n") { blocks in
            let child = blocks[0].children.removeFirst()
            blocks.append(child)
        }
        #expect(tabs.patch.moves == nil)
    }

    @Test("A last block moved up gains the blank line it needs before its new successor")
    func separatedLastBlock() throws {
        let moved = try admit("A\n\nB\n") { blocks in blocks.reverse() }
        #expect(moved.source == "B\n\nA\n\n")
        #expect(moved.patch.moves?.count == 1)
        #expect(moved.patch.edits.map(\.replacement) == ["\n\n"])
        // An ordinary edit that also reorders keeps the blocks apart too.
        let edited = try admit("A\n\nB\n") { blocks in
            blocks.reverse()
            blocks[1].kind = .paragraph(text:AttributedString("A2"))
        }
        #expect(edited.patch.moves == nil)
        #expect(edited.source.hasPrefix("B\n\nA2"))
    }
}

@Suite("Move to Document states one exact transfer")
struct TransferPlanTests {
    func plan(_ origin: String, _ destination: String, moving pick: ([Block]) -> [Block]) throws -> (transfer: WorkspaceDocumentTransfer, planned: CanopyMarkdownCodec.PlannedTransfer)? {
        let a = CanopyMarkdownCodec.open(source:origin,revision:"a1",identitySeed:"origin")
        let b = CanopyMarkdownCodec.open(source:destination,revision:"b1",identitySeed:"destination")
        guard let planned = CanopyMarkdownCodec.transfer(pick(a.blocks), from:a.blocks, ledger:a.ledger, into:b) else { return nil }
        let transfer = try WorkspaceDocumentTransfer(
            origin:.init(reference:.init(tree:"tr_move",path:"/a"),source:origin,contentRevision:"a1"),
            destination:.init(reference:.init(tree:"tr_move",path:"/b"),source:destination,contentRevision:"b1"),
            moves:planned.moves,edits:planned.edits,originSource:planned.originSource,destinationSource:planned.destinationSource)
        return (transfer, planned)
    }

    @Test("A paragraph leaves its page and lands after the destination's last block")
    func paragraph() throws {
        let result = try #require(try plan("One\n\nMoved\n\nThree\n", "Target\n\n") { [$0[1]] })
        #expect(result.planned.originSource == "One\n\nThree\n")
        #expect(result.planned.destinationSource == "Target\n\nMoved\n\n")
        #expect(result.transfer.moves.count == 1)
        #expect(result.transfer.moves[0].anchor.document == .destination)
        #expect(result.transfer.edits.isEmpty)
        #expect(result.planned.originLedger.records.count == 2)
    }

    @Test("Blank lines are added where a block would run into another")
    func separators() throws {
        let result = try #require(try plan("One\n\nLast\n", "Target\n") { [$0[1]] })
        #expect(result.planned.originSource == "One\n\n")
        #expect(result.planned.destinationSource == "Target\n\nLast\n")
        #expect(result.transfer.edits.map(\.document) == [.destination])
    }

    @Test("A nested item lands at the top level, re-indented")
    func nested() throws {
        let result = try #require(try plan("- one\n  - child\n- two\n\nPara\n\n", "Target\n\n") { blocks in [blocks[0].children[0]] })
        #expect(result.planned.destinationSource == "Target\n\n- child\n")
        #expect(result.planned.originSource == "- one\n- two\n\nPara\n\n")
        #expect(result.transfer.moves.count == 1)
        #expect(result.transfer.edits.map(\.edit.replacement) == [""])
    }

    @Test("Blocks apart from each other are not one transfer")
    func separateBlocks() throws {
        #expect(try plan("One\n\nTwo\n\nThree\n\n", "Target\n\n") { [$0[0], $0[2]] } == nil)
        let adjacent = try #require(try plan("One\n\nTwo\n\nThree\n\n", "Target\n\n") { [$0[0], $0[1]] })
        #expect(adjacent.planned.destinationSource == "Target\n\nOne\n\nTwo\n\n")
        #expect(adjacent.transfer.moves.count == 1)
    }

    @Test("An empty destination cannot be a landing place")
    func emptyDestination() throws {
        #expect(try plan("One\n\nTwo\n", "") { [$0[0]] } == nil)
    }
}

@Suite("Same-tree links are relative Markdown links from the body's directory")
struct MarkdownLinkWritingTests {
    private struct DirectoryFixture: Decodable {
        struct Case: Decodable {
            struct Placement: Decodable {
                var path: String
                var body: MarkdownBodyOrigin?
            }
            struct Child: Decodable {
                var name: String
                var path: String
                var body: MarkdownBodyOrigin?
                var stableKey: String?
            }
            var name: String
            var directory: Placement
            var source: String
            var children: [Child]
            var expectedBlockPaths: [String]
            var expectedGeneratedChildren: [String]
        }
        var cases: [Case]
    }

    private static var conformance: URL {
        if let path = ProcessInfo.processInfo.environment["ARBOR_PROTOCOL_FIXTURES"] {
            return URL(fileURLWithPath: path, isDirectory: true)
        }
        return URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .appending(path: "../../../../../docs/overstory-spec/conformance")
            .standardizedFileURL
    }

    private static func node(_ path: String, tree: TreeID = "tr_links", body: MarkdownBodyOrigin?, stableKey: String? = nil, title: String? = nil) -> WorkspaceNode {
        let surface: WorkspaceSurface = body == .index
            ? .directoryDocument(source: "", contentRevision: "r1", stored: true)
            : .markdown(source: "", contentRevision: "r1")
        return WorkspaceNode(
            reference: .init(tree: tree, path: path, stableKey: stableKey),
            title: title ?? String(path.split(separator: "/").last ?? "/"),
            surface: surface,
            provenance: .init(authority: .local, sourceDescription: "Test"),
            markdownBody: body
        )
    }

    private static func documentLinks(_ blocks: [Block]) -> [(reference: DocumentReference, projected: Bool)] {
        blocks.flatMap { block -> [(reference: DocumentReference, projected: Bool)] in
            var links: [(reference: DocumentReference, projected: Bool)] = []
            if case let .documentLink(_, reference) = block.kind {
                links.append((reference, CanopyMarkdownCodec.isProjectedChild(block)))
            }
            return links + documentLinks(block.children)
        }
    }

    @Test("Directory placement matches every shared directory-document vector")
    func directoryDocumentVectors() throws {
        let fixture = try JSONDecoder().decode(
            DirectoryFixture.self,
            from: Data(contentsOf: Self.conformance.appending(path: "directory-documents.json"))
        )
        #expect(!fixture.cases.isEmpty)
        for item in fixture.cases {
            let directory = Self.node(item.directory.path, body: item.directory.body)
            let children = item.children.map { Self.node($0.path, body: $0.body, stableKey: $0.stableKey, title: $0.name) }
            let opened = CanopyMarkdownCodec.open(source: item.source, revision: "r1", identitySeed: item.name)
            let projected = CanopyMarkdownCodec.placeDirectoryChildren(
                children,
                in: opened.blocks,
                directory: directory.reference,
                sourceDirectory: directory.sourceDirectory
            )
            let links = Self.documentLinks(projected)
            let comment = Comment(rawValue: item.name)
            #expect(links.map(\.reference.rawValue) == item.expectedBlockPaths, comment)
            let generated = links.filter(\.projected).compactMap {
                resolveNodeTarget(sourceDirectory: directory.sourceDirectory, href: $0.reference.rawValue)?.path
            }
            #expect(generated.sorted() == item.expectedGeneratedChildren.sorted(), comment)
            #expect(CanopyMarkdownCodec.admission(blocks: projected, ledger: opened.ledger).0.source == item.source, comment)
        }
    }

    @Test("A sibling body's generated rows resolve from its parent; an index body's from itself")
    func siblingAndIndexGeneratedRows() {
        let child = Self.node("/notes/alpha", body: .sibling, stableKey: markdownStableKey("a1"))
        let folder = Self.node("/notes/folder", body: .index, stableKey: markdownStableKey("f1"))
        let crossTree = Self.node("/", tree: "tr_other", body: nil)
        let opened = CanopyMarkdownCodec.open(source: "# Notes\n", revision: "r1", identitySeed: "rows")
        func rows(_ body: MarkdownBodyOrigin) -> [String] {
            let directory = Self.node("/notes", body: body)
            return Self.documentLinks(CanopyMarkdownCodec.placeDirectoryChildren(
                [child, folder, crossTree],
                in: opened.blocks,
                directory: directory.reference,
                sourceDirectory: directory.sourceDirectory
            )).map(\.reference.rawValue)
        }
        #expect(rows(.index) == ["arbor://tr_other/", "alpha.md#arbor-key=id:a1", "folder/_index.md#arbor-key=id:f1"])
        #expect(rows(.sibling) == ["arbor://tr_other/", "notes/alpha.md#arbor-key=id:a1", "notes/folder/_index.md#arbor-key=id:f1"])
    }

    @MainActor
    @Test("Suggestions and converted links are relative in this tree and arbor:// across trees")
    func suggestionsAreRelativeInTree() async throws {
        let tree: TreeID = "tr_mentions"
        let root = Self.node("/", tree: tree, body: .index, title: "Home")
        let page = Self.node("/notes/page", tree: tree, body: .sibling, stableKey: markdownStableKey("p1"), title: "Page")
        let folder = Self.node("/Folder", tree: tree, body: .index, stableKey: markdownStableKey("f1"), title: "Folder")
        let provider = InMemoryWorkspaceProvider(nodes: [root, page, folder], children: [root.id: [folder.id]])
        let session = try await provider.openDocument(page.reference)
        let binding = try await CanopyDocumentBinding.open(reference: page.reference, session: session)
        let host = CanopyEditorHost(
            binding: binding,
            provider: provider,
            linkPreviewService: LinkPreviewService(cacheDirectory: FileManager.default.temporaryDirectory.appending(path: "previews-\(UUID())")),
            sourceDirectory: page.sourceDirectory
        )

        let suggestions = await host.suggestDocuments("Folder", in: binding.document)
        let folderLink = try #require(suggestions.first { $0.title == "Folder" }?.id)
        #expect(folderLink.rawValue == "../Folder/_index.md#arbor-key=id:f1")
        #expect(host.linkURL(for: folderLink, in: binding.document)?.relativeString == folderLink.rawValue)
        #expect(host.workspaceReference(for: folderLink) == folder.reference)

        // A same-tree locator converts to the relative link, naming the body file once it is known.
        let converted = try #require(host.resolveReference(
            from: URL(string: "arbor://tr_mentions/Folder;arbor-key=id:f1")!,
            in: binding.document
        ))
        #expect(converted.rawValue == "../Folder/_index.md#arbor-key=id:f1")

        let other = WorkspaceReference(tree: "tr_elsewhere", path: "/x", stableKey: markdownStableKey("x1"))
        #expect(host.documentReference(for: other, body: .sibling).rawValue == "arbor://tr_elsewhere/x;arbor-key=id:x1")
        let crossTree = try #require(host.resolveReference(
            from: URL(string: "arbor://tr_elsewhere/x;arbor-key=id:x1")!,
            in: binding.document
        ))
        #expect(crossTree.rawValue == "arbor://tr_elsewhere/x;arbor-key=id:x1")
        #expect(host.workspaceReference(for: crossTree) == other)
        await session.close()
    }

    @MainActor
    @Test("A moved page's own keyless outbound link is healed from its new directory")
    func movedDocumentOutboundLinks() async throws {
        let tree: TreeID = "tr_move_heal"
        let root = WorkspaceNode(
            reference: .init(tree: tree, path: "/"),
            title: "Home",
            surface: .directory(summary: nil),
            provenance: .init(authority: .local, sourceDescription: "Test")
        )
        let target = Self.node("/source", tree: tree, body: .sibling, stableKey: markdownStableKey("pg_source"))
        let folder = WorkspaceNode(
            reference: .init(tree: tree, path: "/a"),
            title: "a",
            surface: .directory(summary: nil),
            provenance: root.provenance
        )
        let destination = WorkspaceNode(
            reference: .init(tree: tree, path: "/b/c"),
            title: "c",
            surface: .directory(summary: nil),
            provenance: root.provenance
        )
        let mover = WorkspaceNode(
            reference: .init(tree: tree, path: "/a/mover", stableKey: markdownStableKey("pg_mover")),
            title: "Mover",
            surface: .markdown(source: "[S](../source.md) and [W](https://example.com/x)\n", contentRevision: "r1"),
            provenance: .init(authority: .local, sourceDescription: "Test", contentRevision: "r1")
        )
        let provider = InMemoryWorkspaceProvider(
            nodes: [root, target, folder, destination, mover],
            children: [root.id: [target.id, folder.id, destination.id], folder.id: [mover.id]]
        )
        let workspace = CanopyEditorWorkspace(provider: provider)
        let action = WorkspaceStructuralAction.move(reference: mover.reference, destination: destination.reference)
        let sources = await workspace.linkHealingSources(for: action)
        #expect(sources.first { $0.reference == mover.reference }?.sourceDirectory == "/a")
        let moved = try #require(try await provider.perform(action))
        await workspace.healLinks(in: sources, movedFrom: mover.reference.path, to: moved.reference)

        let healed = try await provider.openDocument(moved.reference).snapshot()
        #expect(healed.source == "[S](../../source.md#arbor-key=id:pg_source) and [W](https://example.com/x)\n")
        await workspace.closeAll()
    }
}
