import CanopyAppKit
@testable import CanopyEditor
import Foundation
import Quagmire
import Testing

@MainActor
@Test("Cached move validation preserves exact patches across repeated rearrangements", arguments: [
    "Same\n\nSame\n\nThird\n\nLast\n\n",
    "---\r\ntitle: Test\r\n---\r\n\r\nCafé **bold**\r\n\r\nCafe\u{301} [link](other.md)\r\n\r\nLast\r\n\r\n",
    "# First\n\nText *one*\n\n## Child\n\nChild text\n\n# Second\n\nSecond text\n\n# Third\n\nLast text\n\n",
    "- First **item**\n  - Nested\n- Second\n- Third\n",
    "```swift\nlet n = 1\n```\n\n<table>raw</table>\n\n![image](asset.png)\n\nParagraph\n\n",
    "First\n\n\nSecond\n\nThird\n\nFourth\n"
])
func cachedMoveMatchesFullParse(source: String) throws {
    let opened = CanopyMarkdownCodec.open(source: source, revision: "r", identitySeed: "cache-equivalence")
    let document = Document(id: DocumentID("cache"), children: opened.blocks)
    var movable: [BlockID] = []
    document.walk { block, _, _ in
        if document.canSlideSiblings([block.id], by: 1) { movable.append(block.id) }
    }
    let selected = try #require(movable.first)
    var ledger = opened.ledger
    var captures = 0
    document.didCommitTransaction = { _ in
        var uncached = ledger
        uncached.parsedKinds = [:]
        let cold = CanopyMarkdownCodec.admission(blocks: document.children, ledger: uncached, moved: document.movedBlocksForCurrentCommit)
        let warm = CanopyMarkdownCodec.admission(blocks: document.children, ledger: ledger, moved: document.movedBlocksForCurrentCommit)
        #expect(warm.0.patch == cold.0.patch)
        #expect(warm.0.source.utf8.elementsEqual(cold.0.source.utf8))
        #expect(warm.1.parsedKinds == cold.1.parsedKinds)
        #expect(Set(warm.1.records.keys) == Set(cold.1.records.keys))
        for (id, record) in warm.1.records {
            #expect(record.range == cold.1.records[id]?.range)
            #expect(record.raw.utf8.elementsEqual(cold.1.records[id]!.raw.utf8))
        }
        ledger = warm.1
        captures += 1
    }
    for direction in [1, 1, -1, -1] {
        if document.canSlideSiblings([selected], by: direction) {
            document.transaction(name: "Move") { _ = document.slideSiblings([selected], by: direction) }
        }
    }
    #expect(captures >= 2)
    // A changed leaf must not inherit its previous parse.
    document.transaction(name: "Edit") {
        document.mutate(selected) { $0.kind = .paragraph(text: AttributedString("Changed **literal** text")) }
    }
}
