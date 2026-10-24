@testable import StoryEditor
import Foundation
import Quagmire
import Testing

@Suite("Pasteboard HTML")
struct PasteboardHTMLTests {
    private func blocks(_ markdown: String) -> [Block] {
        StoryMarkdownCodec.parseBlocks(markdown)
    }

    private func roundTrip(_ html: String) -> String {
        StoryMarkdownCodec.serializeBlocks(blocks(StoryPasteboardHTML.markdown(fromHTML: html)))
    }

    @Test func togglesCopyAsDetails() throws {
        let html = try #require(StoryPasteboardHTML.html(for: blocks("▸ Plans for **May**\n  Inside\n  ▸ Nested\n    Deep\n\nAfter\n")))
        #expect(html.contains("<details><summary>Plans for <strong>May</strong></summary><p>Inside</p><details><summary>Nested</summary><p>Deep</p></details></details>"))
        #expect(html.hasSuffix("<p>After</p>"))
    }

    @Test func listsGroupAndNest() throws {
        let html = try #require(StoryPasteboardHTML.html(for: blocks("- one\n  - inner\n- two\n- [x] done\n1. first\n")))
        #expect(html.contains("<ul><li>one<ul><li>inner</li></ul></li><li>two</li><li><input type=\"checkbox\" checked disabled> done</li></ul><ol><li>first</li></ol>"))
    }

    @Test func aLoneParagraphCopiesAsTextOnly() {
        #expect(StoryPasteboardHTML.html(for: blocks("Just words\n")) == nil)
    }

    @Test func detailsPasteAsToggles() {
        let html = "<meta charset='utf-8'><details><summary>Title <b>bold</b></summary><p>child</p><details><summary>nested</summary><p>deep &amp; deeper</p></details></details><p>after</p>"
        #expect(roundTrip(html) == "▸ Title **bold**\n  child\n\n  ▸ nested\n    deep & deeper\n\nafter\n\n")
    }

    @Test func notionExportToggleListItemsAreToggles() {
        let html = "<ul class=\"toggle\"><li><details open=\"\"><summary>Toggle</summary><ul><li>bullet</li></ul></details></li></ul>"
        #expect(roundTrip(html) == "▸ Toggle\n  - bullet\n\n")
    }

    @Test func otherStructureSurvives() {
        let html = "<h2>Head</h2><ul><li>a<ul><li>b</li></ul></li><li><input type=\"checkbox\" checked> done</li></ul><blockquote>quoted</blockquote><pre><code class=\"language-swift\">let x = 1 &lt; 2</code></pre><hr><p>- not a list <a href=\"https://example.com\">link</a></p>"
        let markdown = StoryPasteboardHTML.markdown(fromHTML: html)
        #expect(markdown.contains("## Head"))
        #expect(markdown.contains("- a\n\n  - b"))
        #expect(markdown.contains("- [x] done"))
        #expect(markdown.contains("> quoted"))
        #expect(markdown.contains("```swift\nlet x = 1 < 2\n```"))
        #expect(markdown.contains("---"))
        #expect(markdown.contains("\\- not a list [link](https://example.com)"))
    }

    @Test func storyCopiesRoundTripThroughHTML() throws {
        let source = "▸ Toggle\n  child\n\n  - bullet\n\nAfter\n"
        let html = try #require(StoryPasteboardHTML.html(for: blocks(source)))
        #expect(roundTrip(html) == StoryMarkdownCodec.serializeBlocks(blocks(source)))
    }

    @Test func notionBlockRecordsPasteWithToggles() throws {
        func record(_ id: String, _ type: String, _ title: Any, content: [String] = [], extra: [String: Any] = [:]) -> (String, Any) {
            var value: [String: Any] = ["id": id, "type": type, "alive": true, "properties": ["title": title]]
            if !content.isEmpty { value["content"] = content }
            value.merge(extra) { $1 }
            return (id, ["value": value])
        }
        let records = Dictionary(uniqueKeysWithValues: [
            record("t", "toggle", [["Plans "], ["now", [["b"]]]], content: ["b1", "b2"]),
            record("b1", "bulleted_list", [["first"]], content: ["d"]),
            record("d", "to_do", [["done "]], extra: ["properties": ["title": [["done "]], "checked": [["Yes"]]]]),
            record("b2", "text", [["see "], ["site", [["a", "https://example.com"]]]]),
            record("h", "sub_header", [["Heading"]]),
        ])
        let json = try JSONSerialization.data(withJSONObject: [
            "action": "copy",
            "blocks": [
                ["blockId": "t", "blockSubtree": ["__version__": 3, "block": records]],
                ["blockId": "h", "blockSubtree": ["__version__": 3, "block": records]],
            ],
        ])
        let markdown = try #require(StoryNotionPasteboard.markdown(fromBlocksJSON: String(decoding: json, as: UTF8.self)))
        let parsed = StoryMarkdownCodec.parseBlocks(markdown)
        #expect(parsed.first?.isToggle == true)
        #expect(StoryMarkdownCodec.serializeBlocks(parsed) == "▸ Plans **now**\n  - first\n    - [x] done\n\n  see [site](https://example.com)\n\n## Heading\n\n")
    }
}
