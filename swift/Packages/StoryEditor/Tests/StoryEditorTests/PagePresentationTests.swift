import StoryKit
@testable import StoryEditor
import Foundation
import Quagmire
import Testing

@Suite("Pages present a title and a Children section their source lacks")
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

    private static func present(_ blocks: [Block], _ item: Fixture.Node, _ children: [Fixture.Child]?) -> [Block] {
        let page = node(item.path, body: item.body)
        return StoryPagePresentation.present(blocks, path: item.path, directory: children.map { children in
            .init(children: children.map { node($0.path, body: $0.body, stableKey: $0.stableKey, title: $0.name) },
                  reference: page.reference, sourceDirectory: page.sourceDirectory)
        })
    }

    /// Headings and standalone links in document order, as the fixture lists them.
    private static func outline(_ blocks: [Block]) -> [Fixture.Entry] {
        blocks.flatMap { block -> [Fixture.Entry] in
            var own: [Fixture.Entry] = []
            if let presented = StoryPagePresentation.heading(block) {
                own = [.init(presented: presented.rawValue, text: String(block.text.characters))]
            } else if case let .heading(level, text) = block.kind {
                own = [.init(heading: level.rawValue, text: String(text.characters))]
            } else if case let .documentLink(_, reference) = block.kind {
                own = [.init(link: reference.rawValue, generated: StoryMarkdownCodec.isProjectedChild(block))]
            }
            return own + outline(block.children)
        }
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
            let page = Self.present(opened.blocks, item.node, item.children)
            #expect(Self.outline(page) == item.expectedOutline, comment)
            // Nothing presented is source, and presenting a page again changes nothing.
            #expect(StoryMarkdownCodec.admission(blocks: page, ledger: opened.ledger).0.source == item.source, comment)
            #expect(StoryMarkdownCodec.admission(blocks: page, ledger: opened.ledger).0.patch.isEmpty, comment)
            #expect(Self.present(page, item.node, item.children) == page, comment)
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
            let document = Document(id: DocumentID(item.name), children: Self.present(opened.blocks, item.node, item.children))
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
                } else if let name = edit.reverse {
                    let kind = try #require(StoryPagePresentation.Heading(rawValue: name), comment)
                    let heading = try #require(Self.find(kind, in: document.children), comment)
                    // A bulk move keeps document order, so each row moves on its own.
                    for (position, child) in heading.children.reversed().enumerated() {
                        #expect(document.moveSubtrees([child.id], to: DropPath(parent: heading.id, position: position)), comment)
                    }
                } else if let text = edit.append {
                    let children = try #require(Self.find(.children, in: document.children), comment)
                    _ = document.insertSubtree(.paragraph(text: AttributedString(text)), at: DropPath(parent: children.id, position: children.children.count))
                }
            }
            let (admitted, ledger) = StoryMarkdownCodec.admission(blocks: document.children, ledger: opened.ledger)
            #expect(admitted.source == item.expectedSource, "\(item.name): \(admitted.source.debugDescription)")
            #expect((try? admitted.patch.applying(to: item.source)) == item.expectedSource, comment)
            // Presenting the edited tree turns an edited heading into an
            // authored block and writes nothing more.
            let next = Self.present(document.children, item.node, item.children)
            #expect(StoryMarkdownCodec.admission(blocks: next, ledger: ledger).0.patch.isEmpty, comment)
            #expect(Self.present(next, item.node, item.children) == next, comment)
            // A reader who opens the written source sees the same page.
            let reopened = StoryMarkdownCodec.open(source: admitted.source, revision: "r2", identitySeed: item.name)
            #expect(Self.outline(Self.present(reopened.blocks, item.node, item.children)) == Self.outline(next), comment)
        }
    }

    @Test("The title owns the body up to the next H1, and Children closes every authored section")
    func presentedSections() throws {
        let source = "Intro.\n\n## Method\n\nWalk.\n\n# Part\n\n## Last\n\nBody.\n"
        let opened = StoryMarkdownCodec.open(source: source, revision: "r1", identitySeed: "sections")
        let page = Self.present(opened.blocks, .init(path: "/field-notes", body: .index), [.init(name: "a", path: "/field-notes/a", body: .sibling)])
        #expect(page.count == 3)
        #expect(StoryPagePresentation.heading(page[0]) == .title)
        #expect(String(page[0].text.characters) == "field notes")
        #expect(page[0].children.map(\.id) == Array(opened.blocks.prefix(2)).map(\.id))
        #expect(page[1].id == opened.blocks[2].id)
        // Not nested into the last authored section, as placement alone once did.
        #expect(StoryPagePresentation.heading(page[2]) == .children)
        #expect(page[2].children.count == 1)
        #expect(page[2].children.allSatisfy(StoryMarkdownCodec.isProjectedChild))
        #expect(page[1].children.last?.children.contains(where: StoryMarkdownCodec.isProjectedChild) == false)
    }

    @Test("Content placed above the generated children writes the section with its links")
    func editedSectionWritesItsLinks() throws {
        let opened = StoryMarkdownCodec.open(source: "# Dir\n", revision: "r1", identitySeed: "above")
        var page = Self.present(opened.blocks, .init(path: "/dir", body: .index), [.init(name: "a", path: "/dir/a", body: .sibling)])
        page[1].children.insert(.paragraph(text: AttributedString("Start here.")), at: 0)
        let source = StoryMarkdownCodec.admission(blocks: page, ledger: opened.ledger).0.source
        #expect(source == "# Dir\n\n# Subpages\n\nStart here.\n\n[a](a.md)\n\n", "\(source.debugDescription)")
        // The authored heading holds a child added later, with nothing presented.
        let reopened = StoryMarkdownCodec.open(source: source, revision: "r2", identitySeed: "above")
        let next = Self.present(reopened.blocks, .init(path: "/dir", body: .index),
                                [.init(name: "a", path: "/dir/a", body: .sibling), .init(name: "b", path: "/dir/b", body: .sibling)])
        #expect(next.count == 2)
        #expect(StoryPagePresentation.heading(next[1]) == nil)
        #expect(next[1].children.map(StoryMarkdownCodec.isProjectedChild) == [false, false, true])
        #expect(StoryPagePresentation.isMuted(next[1].children[2]))
        #expect(!StoryPagePresentation.isMuted(next[1]))
    }

    @Test("A legacy children marker is ordinary raw Markdown, and the children stand at the page's end")
    func legacyMarkerIsRawMarkdown() throws {
        let source = "# Children\n\nHey\n\n<!-- overstory:children -->\n"
        let opened = StoryMarkdownCodec.open(source: source, revision: "r1", identitySeed: "legacy-marker")
        let page = Self.present(opened.blocks, .init(path: "/", body: .index), [.init(name: "story", path: "/story", body: .sibling)])
        #expect(page.count == 1)
        #expect(page[0].children.map(StoryMarkdownCodec.isProjectedChild) == [false, false, true])
        if case let .unsupported(_, display) = page[0].children[1].kind { #expect(display == "Raw Markdown") } else { Issue.record("marker is not raw Markdown") }
        #expect(StoryMarkdownCodec.admission(blocks: page, ledger: opened.ledger).0.source == source)
        #expect(Self.present(page, .init(path: "/", body: .index), [.init(name: "story", path: "/story", body: .sibling)]) == page)
    }

    @Test("A selection that includes a presented heading moves only authored source")
    func transferLeavesPresentedHeadings() throws {
        let origin = "Intro\n\n## Last\n\n- two\n"
        let a = StoryMarkdownCodec.open(source: origin, revision: "a1", identitySeed: "origin")
        let page = Self.present(a.blocks, .init(path: "/dir", body: .index), [.init(name: "child", path: "/dir/child", body: .sibling)])
        let b = StoryMarkdownCodec.open(source: "Target\n\n", revision: "b1", identitySeed: "destination")
        // The whole page selected: the presented title, and the Children heading with its generated link.
        let all = try #require(StoryMarkdownCodec.transfer(page, from: page, ledger: a.ledger, into: b))
        #expect(all.destinationSource == "Target\n\nIntro\n\n## Last\n\n- two\n")
        #expect(all.originSource == "")
        // The last section with the Children heading after it.
        let last = try #require(page[0].children.last)
        let section = try #require(StoryMarkdownCodec.transfer([last, page[1]], from: page, ledger: a.ledger, into: b))
        #expect(section.destinationSource == "Target\n\n## Last\n\n- two\n")
        #expect(section.originSource == "Intro\n\n")
        // The Children heading alone carries nothing.
        #expect(StoryPagePresentation.transferable([page[1]], in: page).isEmpty)
        #expect(StoryMarkdownCodec.transfer([page[1]], from: page, ledger: a.ledger, into: b) == nil)
    }

    @MainActor
    @Test("The editor presents, restores and materializes headings without writing presented ones")
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

        // Unlinked children close the page under Children.
        let directory = Self.node("/field-notes", body: .index, stableKey: reference.stableKey)
        binding.projectDirectoryChildren([Self.node("/field-notes/a", body: .sibling)], in: directory)
        #expect(document.children.count == 2)
        let children = try #require(document.children.last)
        #expect(StoryPagePresentation.heading(children) == .children)
        #expect(children.children.allSatisfy(StoryMarkdownCodec.isProjectedChild))

        // Deleting presented headings writes nothing, and presentation restores them.
        document.transaction(name: "Delete headings") {
            _ = document.removeBlockLiftingChildren(title.id)
            _ = document.removeSubtree(children.id)
        }
        binding.appendCurrentGeneration()
        await binding.flush()
        #expect((try await session.snapshot()).source == "Intro.\n")
        // Every commit is followed by presentation, once the commit has returned.
        for _ in 0..<100 where document.children.count < 2 { await Task.yield() }
        #expect(document.children.map(StoryPagePresentation.heading) == [.title, .children])
        #expect(document.children.first?.children.map { String($0.text.characters) } == ["Intro."])

        // Moving the Children heading above the body is undone by presentation.
        let moved = try #require(document.children.last)
        document.transaction(name: "Move Children") { _ = document.moveSubtrees([moved.id], to: .root(at: 0)) }
        binding.appendCurrentGeneration()
        await binding.flush()
        binding.represent()
        #expect((try await session.snapshot()).source == "Intro.\n")
        #expect(document.children.map(StoryPagePresentation.heading) == [.title, .children])

        // Renaming Children writes the section with its link; the title
        // stays presented, and the link stays under the heading.
        let heading = try #require(document.children.last)
        _ = document.setText(heading.id, AttributedString("Pages"))
        binding.appendCurrentGeneration()
        await binding.flush()
        let renamed = (try await session.snapshot()).source
        #expect(renamed == "Intro.\n\n# Pages\n\n[a](a.md)\n\n", "\(renamed.debugDescription)")
        binding.represent()
        #expect(document.children.map(StoryPagePresentation.heading) == [.title, nil])
        #expect(document.children.last?.id == heading.id)
        #expect(document.children.last?.children.last.map(StoryMarkdownCodec.isProjectedChild) == false)

        // Editing the title writes the body's first H1 and names the page.
        _ = document.setText(try #require(document.children.first).id, AttributedString("Field Notes"))
        binding.appendCurrentGeneration()
        await binding.flush()
        binding.represent()
        let finalSource = (try await session.snapshot()).source
        #expect(finalSource == "# Field Notes\n\nIntro.\n\n# Pages\n\n[a](a.md)\n\n", "\(finalSource.debugDescription)")
        #expect(document.children.map(StoryPagePresentation.heading) == [nil, nil])
        #expect(binding.acceptedTitle == "Field Notes")
        #expect(binding.lastError == nil)
        await binding.close()
    }
}
