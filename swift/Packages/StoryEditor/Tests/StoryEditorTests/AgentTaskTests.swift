@testable import StoryEditor
import Foundation
import Quagmire
import Testing

@Suite("Agent task blocks read and write as > [!agent] quotes")
struct AgentTaskTests {
    @Test("a task quote opens as a task and is written back with its marker unescaped")
    func roundTrip() {
        let blocks = StoryMarkdownCodec.parseBlocks("> [!agent] merge the duplicates\n")
        #expect(blocks.count == 1)
        #expect(blocks.first.flatMap(StoryAgentTask.task(in:)) == "merge the duplicates")
        #expect(blocks.first.map(StoryAgentTask.isMarked) == true)
        // The editor shows the task's text without the marker.
        #expect(blocks.first?.kind == .quote(text: AttributedString("merge the duplicates")))
        var edited = blocks
        edited[0].kind = .quote(text: AttributedString("merge the *duplicates* now"))
        #expect(StoryMarkdownCodec.serializeBlocks(edited).trimmingCharacters(in: .newlines) == "> [!agent] merge the \\*duplicates\\* now")
        #expect(StoryAgentTask.task(in: Block.quote(text: AttributedString("an ordinary quote"))) == nil)
        #expect(StoryMarkdownCodec.serializeBlocks(StoryMarkdownCodec.parseBlocks("> an ordinary quote\n")).trimmingCharacters(in: .newlines) == "> an ordinary quote")
    }

    @Test("Turn Into makes a task of a block's text, and the task's source changes")
    func turnInto() throws {
        let source = "- sort this list\n"
        let opened = StoryMarkdownCodec.open(source: source, revision: "r1", identitySeed: "pg_task")
        let task = try #require(StoryAgentTask.turnInto(opened.blocks[0]))
        #expect(StoryAgentTask.task(in: task) == "sort this list")
        let (admission, _) = StoryMarkdownCodec.admission(blocks: [task], ledger: opened.ledger)
        #expect(admission.source.trimmingCharacters(in: .newlines) == "> [!agent] sort this list")
    }

    @Test("a dictated task is a paragraph that is written as a task quote")
    func dictated() {
        #expect(StoryAgentTask.dictated("Agent, merge the duplicates") == "[!agent] Merge the duplicates")
        #expect(StoryAgentTask.dictated("agent: sort this list") == "[!agent] Sort this list")
        #expect(StoryAgentTask.dictated("Agents of change") == "Agents of change")
        #expect(StoryAgentTask.dictated("agent") == "agent")
        let paragraph = Block.paragraph(text: AttributedString(StoryAgentTask.dictated("Agent, sort this list")))
        #expect(StoryAgentTask.task(in: paragraph) == "Sort this list")
        #expect(StoryMarkdownCodec.serializeBlocks([paragraph]).trimmingCharacters(in: .newlines) == "> [!agent] Sort this list")
    }

    @Test("a line break in a task, quote or paragraph is a hard break, and reads back as one block")
    func lineBreaks() {
        let task = StoryMarkdownCodec.parseBlocks("> [!agent] merge the duplicates\\\n> and sort by aisle\n")
        #expect(task.count == 1)
        #expect(task.first.flatMap(StoryAgentTask.task(in:)) == "merge the duplicates\nand sort by aisle")
        #expect(StoryMarkdownCodec.serializeBlocks(task).trimmingCharacters(in: .newlines)
            == "> [!agent] merge the duplicates\\\n> and sort by aisle")

        let quote = Block.quote(text: AttributedString("first\n\nthird"))
        let written = StoryMarkdownCodec.serializeBlocks([quote])
        #expect(written.trimmingCharacters(in: .newlines) == "> first\\\n> \\\n> third")
        #expect(StoryMarkdownCodec.parseBlocks(written).map(\.kind) == [quote.kind])

        let paragraph = Block.paragraph(text: AttributedString("one\ntwo"))
        let prose = StoryMarkdownCodec.serializeBlocks([paragraph])
        #expect(prose.trimmingCharacters(in: .newlines) == "one\\\ntwo")
        #expect(StoryMarkdownCodec.parseBlocks(prose).map(\.kind) == [paragraph.kind])
    }

    @Test("consecutive > lines without a hard break stay separate quotes, byte for byte")
    func separateQuotesUnchanged() {
        let source = "> a\n> b\n"
        let opened = StoryMarkdownCodec.open(source: source, revision: "r1", identitySeed: "pg_quotes")
        #expect(opened.blocks.count == 2)
        let (admission, _) = StoryMarkdownCodec.admission(blocks: opened.blocks, ledger: opened.ledger)
        #expect(admission.source == source)
        #expect(StoryMarkdownCodec.serializeBlocks(StoryMarkdownCodec.parseBlocks(source)) == StoryMarkdownCodec.serializeBlocks(opened.blocks))
    }

    @Test("a done task reads and writes as > [!agent-done], byte for byte, and toggles back to a task")
    func doneTask() throws {
        let source = "> [!agent-done] merge the duplicates\\\n> and sort by aisle\n"
        let opened = StoryMarkdownCodec.open(source: source, revision: "r1", identitySeed: "pg_done")
        let block = try #require(opened.blocks.first)
        #expect(StoryAgentTask.isMarked(block))
        #expect(StoryAgentTask.isDone(block))
        #expect(StoryAgentTask.task(in: block) == "merge the duplicates\nand sort by aisle")
        let (admission, _) = StoryMarkdownCodec.admission(blocks: opened.blocks, ledger: opened.ledger)
        #expect(admission.source == source)

        let reopened = try #require(StoryAgentTask.toggled(block))
        #expect(reopened.id == block.id)
        #expect(!StoryAgentTask.isDone(reopened))
        let (undone, _) = StoryMarkdownCodec.admission(blocks: [reopened], ledger: opened.ledger)
        #expect(undone.source.trimmingCharacters(in: .newlines) == "> [!agent] merge the duplicates\\\n> and sort by aisle")
        #expect(StoryAgentTask.toggled(Block.quote(text: AttributedString("a quote"))) == nil)
    }
}

