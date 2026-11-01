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
}
