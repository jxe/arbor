import StoryKit
@testable import StoryEditor
import Foundation
import Quagmire
import Testing

@Suite("Pages present a title and Subpages their source lacks")
struct PagePresentationTests {
    private struct Fixture: Decodable {
        struct Node: Decodable {
            var path: String
            var body: MarkdownBodyOrigin?
        }
        struct Child: Decodable {
            var name: String
            var path: String
            var body: MarkdownBodyOrigin?
            var stableKey: String?
        }
        struct Entry: Decodable, Equatable {
            var presented: String?
            var heading: Int?
            var text: String?
            var link: String?
            var generated: Bool?
        }
        struct Case: Decodable {
            var name: String
            var node: Node
            var source: String
            var children: [Child]?
            var expectedOutline: [Entry]
        }
        struct Edit: Decodable {
            var retitle: String?
            var retype: String?
            var text: String?
            var level: Int?
            var append: String?
            var reverse: String?
        }
        struct EditCase: Decodable {
            var name: String
            var node: Node
            var source: String
            var children: [Child]?
            var edit: Edit?
            var expectedSource: String
        }
        var cases: [Case]
        var edits: [EditCase]
    }

    private static func fixture() throws -> Fixture {
        let directory = ProcessInfo.processInfo.environment["STORY_PROTOCOL_FIXTURES"].map { URL(fileURLWithPath: $0, isDirectory: true) }
            ?? URL(fileURLWithPath: #filePath).deletingLastPathComponent()
                .appending(path: "../../../../../docs/overstory-spec/conformance").standardizedFileURL
        return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: directory.appending(path: "page-presentation.json")))
    }

    private static func node(_ path: String, body: MarkdownBodyOrigin?, stableKey: String? = nil, title: String? = nil) -> WorkspaceNode {
        WorkspaceNode(
            reference: .init(tree: "tr_pages", path: path, stableKey: stableKey),
            title: title ?? String(path.split(separator: "/").last ?? "/"),
            surface: body == .index ? .directoryDocument(source: "", contentRevision: "r1", stored: true) : .markdown(source: "", contentRevision: "r1"),
            provenance: .init(authority: .local, sourceDescription: "Test"),
            markdownBody: body
        )
    }

    private static func present(_ blocks: [Block], _ item: Fixture.Node) -> [Block] {
        StoryPagePresentation.present(blocks, path: item.path)
    }

    private static func directory(_ item: Fixture.Node, _ children: [Fixture.Child]) -> StoryPagePresentation.Directory {
        let page = node(item.path, body: item.body)
        return .init(children: children.map { node($0.path, body: $0.body, stableKey: $0.stableKey, title: $0.name) },
                     reference: page.reference, sourceDirectory: page.sourceDirectory)
    }

    private static func subpages(_ page: [Block], _ item: Fixture.Node, _ children: [Fixture.Child]?) -> DocumentRegion? {
        children.flatMap { StoryPagePresentation.subpages(directory(item, $0), of: page, path: item.path) }
    }

    /// Headings and standalone links in the order shown, as the fixture lists
    /// them: the page, then its Subpages.
    private static func outline(_ blocks: [Block], subpages: DocumentRegion? = nil) -> [Fixture.Entry] {
        func entries(_ blocks: [Block], generated: Bool) -> [Fixture.Entry] {
            blocks.flatMap { block -> [Fixture.Entry] in
                var own: [Fixture.Entry] = []
                if let presented = StoryPagePresentation.heading(block) {
                    own = [.init(presented: presented.rawValue, text: String(block.text.characters))]
                } else if case let .heading(level, text) = block.kind {
                    own = [.init(heading: level.rawValue, text: String(text.characters))]
                } else if case let .documentLink(_, reference) = block.kind {
                    own = [.init(link: reference.rawValue, generated: generated)]
                }
                return own + entries(block.children, generated: generated)
            }
        }
        let region = subpages.map { [Fixture.Entry(presented: "children", text: String($0.title.characters))] + entries($0.blocks, generated: true) }
        return entries(blocks, generated: false) + (region ?? [])
    }

    private static func find(_ heading: StoryPagePresentation.Heading, in blocks: [Block]) -> Block? {
        for block in blocks {
            if StoryPagePresentation.heading(block) == heading { return block }
            if let found = find(heading, in: block.children) { return found }
        }
        return nil
    }

    @Test("Presentation matches every shared page-presentation vector")
    func presentationVectors() throws {
        let fixture = try Self.fixture()
        #expect(!fixture.cases.isEmpty)
        for item in fixture.cases {
            let comment = Comment(rawValue: item.name)
            let opened = StoryMarkdownCodec.open(source: item.source, revision: "r1", identitySeed: item.name)
            let page = Self.present(opened.blocks, item.node)
            #expect(Self.outline(page, subpages: Self.subpages(page, item.node, item.children)) == item.expectedOutline, comment)
            // Nothing presented is source, and presenting a page again changes nothing.
            #expect(StoryMarkdownCodec.admission(blocks: page, ledger: opened.ledger).0.source == item.source, comment)
            #expect(StoryMarkdownCodec.admission(blocks: page, ledger: opened.ledger).0.patch.isEmpty, comment)
            #expect(Self.present(page, item.node) == page, comment)
            #expect(StoryPagePresentation.authored(page) == opened.blocks, comment)
        }
    }

    @MainActor
    @Test("An edited page writes what every shared edit vector expects")
    func editVectors() throws {
        let fixture = try Self.fixture()
        #expect(!fixture.edits.isEmpty)
        for item in fixture.edits {
            let comment = Comment(rawValue: item.name)
            let opened = StoryMarkdownCodec.open(source: item.source, revision: "r1", identitySeed: item.name)
            let document = Document(id: DocumentID(item.name), children: Self.present(opened.blocks, item.node))
            if let edit = item.edit {
                if let name = edit.retitle, let text = edit.text {
                    let kind = try #require(StoryPagePresentation.Heading(rawValue: name), comment)
                    let heading = try #require(Self.find(kind, in: document.children), comment)
                    _ = document.setText(heading.id, AttributedString(text))
                } else if let name = edit.retype, let rawLevel = edit.level {
                    let kind = try #require(StoryPagePresentation.Heading(rawValue: name), comment)
                    let level = try #require(HeadingLevel(rawValue: rawLevel), comment)
                    let heading = try #require(Self.find(kind, in: document.children), comment)
                    _ = document.mutate(heading.id) { $0.kind = .heading(level: level, text: $0.text) }
                    document.enforceHeadingContainment()
                }
            }
            let (admitted, ledger) = StoryMarkdownCodec.admission(blocks: document.children, ledger: opened.ledger)
            #expect(admitted.source == item.expectedSource, "\(item.name): \(admitted.source.debugDescription)")
            #expect((try? admitted.patch.applying(to: item.source)) == item.expectedSource, comment)
            // Presenting the edited tree turns an edited heading into an
            // authored block and writes nothing more.
            let next = Self.present(document.children, item.node)
            #expect(StoryMarkdownCodec.admission(blocks: next, ledger: ledger).0.patch.isEmpty, comment)
            #expect(Self.present(next, item.node) == next, comment)
            // A reader who opens the written source sees the same page.
            let reopened = StoryMarkdownCodec.open(source: admitted.source, revision: "r2", identitySeed: item.name)
            #expect(Self.outline(Self.present(reopened.blocks, item.node)) == Self.outline(next), comment)
        }
    }

    @Test("The title owns the body up to the next H1, and the Subpages follow the page")
    func presentedSections() throws {
        let source = "Intro.\n\n## Method\n\nWalk.\n\n# Part\n\n## Last\n\nBody.\n"
        let opened = StoryMarkdownCodec.open(source: source, revision: "r1", identitySeed: "sections")
        let node = Fixture.Node(path: "/field-notes", body: .index)
        let page = Self.present(opened.blocks, node)
        #expect(page.count == 2)
        #expect(StoryPagePresentation.heading(page[0]) == .title)
        #expect(String(page[0].text.characters) == "field notes")
        #expect(page[0].children.map(\.id) == Array(opened.blocks.prefix(2)).map(\.id))
        #expect(page[1].id == opened.blocks[2].id)
        let subpages = try #require(Self.subpages(page, node, [.init(name: "a", path: "/field-notes/a", body: .sibling)]))
        #expect(String(subpages.title.characters) == "Subpages")
        #expect(subpages.blocks.map(\.kind) == [.documentLink(label: AttributedString("a"), reference: DocumentReference("a.md"))])
        // A page whose children are all linked has no Subpages.
        let linked = StoryMarkdownCodec.open(source: "[a](a.md)\n", revision: "r1", identitySeed: "linked")
        #expect(Self.subpages(Self.present(linked.blocks, node), node, [.init(name: "a", path: "/field-notes/a", body: .sibling)]) == nil)
    }

    @Test("Only a lone link to one of the page's own children is unlinked onto its Subpages")
    func unlinkingOntoSubpages() throws {
        let node = Fixture.Node(path: "/dir", body: .index)
        let directory = Self.directory(node, [.init(name: "a", path: "/dir/a", body: .sibling)])
        let child = Block.documentLink(label: AttributedString("a"), reference: DocumentReference("a.md"))
        let other = Block.documentLink(label: AttributedString("b"), reference: DocumentReference("../b.md"))
        #expect(StoryPagePresentation.linksChild(child, of: directory))
        #expect(!StoryPagePresentation.linksChild(other, of: directory))
        #expect(!StoryPagePresentation.linksChild(.paragraph(text: AttributedString("a")), of: directory))
        var nested = child
        nested.children = [.paragraph(text: AttributedString("note"))]
        #expect(!StoryPagePresentation.linksChild(nested, of: directory))
    }

    @Test("A legacy children marker is ordinary raw Markdown")
    func legacyMarkerIsRawMarkdown() throws {
        let source = "# Children\n\nHey\n\n<!-- overstory:children -->\n"
        let opened = StoryMarkdownCodec.open(source: source, revision: "r1", identitySeed: "legacy-marker")
        let page = Self.present(opened.blocks, .init(path: "/", body: .index))
        #expect(page.count == 1)
        if case let .unsupported(_, display) = page[0].children[1].kind { #expect(display == "Raw Markdown") } else { Issue.record("marker is not raw Markdown") }
        #expect(StoryMarkdownCodec.admission(blocks: page, ledger: opened.ledger).0.source == source)
        #expect(Self.subpages(page, .init(path: "/", body: .index), [.init(name: "story", path: "/story", body: .sibling)])?.blocks.count == 1)
    }

    @Test("A selection that includes the presented title moves only authored source")
    func transferLeavesPresentedHeadings() throws {
        let origin = "Intro\n\n## Last\n\n- two\n"
        let a = StoryMarkdownCodec.open(source: origin, revision: "a1", identitySeed: "origin")
        let page = Self.present(a.blocks, .init(path: "/dir", body: .index))
        let b = StoryMarkdownCodec.open(source: "Target\n\n", revision: "b1", identitySeed: "destination")
        // The whole page selected, presented title included.
        let all = try #require(StoryMarkdownCodec.transfer(page, from: page, ledger: a.ledger, into: b))
        #expect(all.destinationSource == "Target\n\nIntro\n\n## Last\n\n- two\n")
        #expect(all.originSource == "")
        // The last section alone.
        let last = try #require(page[0].children.last)
        let section = try #require(StoryMarkdownCodec.transfer([last], from: page, ledger: a.ledger, into: b))
        #expect(section.destinationSource == "Target\n\n## Last\n\n- two\n")
        #expect(section.originSource == "Intro\n\n")
    }

    @MainActor
    @Test("The editor presents its title and Subpages, restores them, and writes neither")
    func bindingPresentation() async throws {
        let reference = WorkspaceReference(tree: "tr_pages", path: "/field-notes", stableKey: markdownStableKey("pg_notes"))
        let session = InMemoryDocumentSession(snapshot: .init(reference: reference, source: "Intro.\n", contentRevision: "r1"))
        let binding = try await StoryDocumentBinding.open(reference: reference, session: session)
        let document = binding.document

        // A page without a leading H1 opens with its name; the name proposes no rename.
        let title = try #require(document.children.first)
        #expect(StoryPagePresentation.heading(title) == .title)
        #expect(String(title.text.characters) == "field notes")
        #expect(binding.acceptedTitle == "field-notes")

        // Unlinked children are the page's Subpages, after it and not in it.
        let directory = Self.node("/field-notes", body: .index, stableKey: reference.stableKey)
        binding.projectDirectoryChildren([Self.node("/field-notes/a", body: .sibling)], in: directory)
        #expect(document.children.count == 1)
        let subpages = try #require(document.regions.first)
        #expect(String(subpages.title.characters) == "Subpages")
        let row = try #require(subpages.blocks.first)

        // Deleting the presented title writes nothing, and presentation restores it.
        document.transaction(name: "Delete title") { _ = document.removeBlockLiftingChildren(title.id) }
        binding.appendCurrentGeneration()
        await binding.flush()
        #expect((try await session.snapshot()).source == "Intro.\n")
        // Every commit is followed by presentation, once the commit has returned.
        for _ in 0..<100 where StoryPagePresentation.heading(document.children[0]) == nil { await Task.yield() }
        #expect(document.children.map(StoryPagePresentation.heading) == [.title])
        #expect(document.children.first?.children.map { String($0.text.characters) } == ["Intro."])

        // Dragging the row into the page writes its link and empties the Subpages.
        _ = document.insertCopies(of: [row], at: DropPath(parent: title.id, position: 1))
        binding.appendCurrentGeneration()
        await binding.flush()
        binding.represent()
        #expect((try await session.snapshot()).source == "Intro.\n\n[a](a.md)\n\n")
        #expect(document.regions.isEmpty)

        // A link to the child is taken back by the Subpages; another is not.
        let link = try #require(document.children.first?.children.last)
        #expect(binding.unlinksSubpages([link]))
        #expect(!binding.unlinksSubpages([.paragraph(text: AttributedString("Intro."))]))
        document.transaction(name: "Unlink") { _ = document.removeSubtree(link.id) }
        binding.appendCurrentGeneration()
        await binding.flush()
        binding.represent()
        #expect((try await session.snapshot()).source == "Intro.\n")
        #expect(document.regions.first?.blocks.count == 1)

        // Editing the title writes the body's first H1 and names the page.
        _ = document.setText(try #require(document.children.first).id, AttributedString("Field Notes"))
        binding.appendCurrentGeneration()
        await binding.flush()
        binding.represent()
        let finalSource = (try await session.snapshot()).source
        #expect(finalSource == "# Field Notes\n\nIntro.\n", "\(finalSource.debugDescription)")
        #expect(document.children.map(StoryPagePresentation.heading) == [nil])
        #expect(binding.acceptedTitle == "Field Notes")
        #expect(binding.lastError == nil)
        await binding.close()
    }
}
