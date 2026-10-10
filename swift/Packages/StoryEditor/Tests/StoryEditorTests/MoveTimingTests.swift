import StoryKit
@testable import StoryEditor
import Foundation
import Quagmire
import Testing

// Opt-in diagnostic; no timing threshold depends on machine load.
@MainActor @Test(.enabled(if: ProcessInfo.processInfo.environment["OVERSTORYD_MEASURE_MOVES"] == "1"))
func measureMovePipeline() throws {
    for size in [50, 200, 500] {
        let source = (0..<size).map { "Paragraph \($0) with **some text** and a [link](page).\n\n" }.joined()
        let opened = StoryMarkdownCodec.open(source: source, revision: "r", identitySeed: "timing")
        let document = Document(id: DocumentID("timing"), children: opened.blocks)
        let selected = opened.blocks[0].id
        var ledger = opened.ledger
        var capture = 0.0
        document.didCommitTransaction = { _ in
            let start = CFAbsoluteTimeGetCurrent()
            let (_, next) = StoryMarkdownCodec.admission(blocks: document.children, ledger: ledger, moved: document.movedBlocksForCurrentCommit)
            capture += CFAbsoluteTimeGetCurrent() - start
            ledger = next
        }
        let start = CFAbsoluteTimeGetCurrent()
        for _ in 0..<20 { document.transaction(name: "Move") { _ = document.slideSiblings([selected], by: 1) } }
        let total = CFAbsoluteTimeGetCurrent() - start
        print("MOVE TIMING blocks=\(size) total_ms=\(total*50) capture_ms=\(capture*50) transaction_ms=\((total-capture)*50)")
    }
}

@MainActor @Test(.enabled(if: ProcessInfo.processInfo.environment["OVERSTORYD_MEASURE_MOVES"] == "1"))
func measureCacheReuse() throws {
    let source = (0..<500).map { "Paragraph \($0) with **some text** and a [link](page).\n\n" }.joined()
    let opened = StoryMarkdownCodec.open(source: source, revision: "r", identitySeed: "reuse-timing")
    for reuse in [false, true] {
        var moveTime = 0.0, replacementTime = 0.0
        for index in 0..<20 {
            var blocks = opened.blocks
            blocks[0].kind = .paragraph(text: AttributedString("Edit \(index)"))
            var edited = StoryMarkdownCodec.admission(blocks: blocks, ledger: opened.ledger).1
            if !reuse { edited.parsedKinds = [:] }
            let moved = blocks[0].id
            blocks.swapAt(0, 1)
            var start = CFAbsoluteTimeGetCurrent()
            let result = StoryMarkdownCodec.admission(blocks: blocks, ledger: edited, moved: [moved])
            moveTime += CFAbsoluteTimeGetCurrent() - start
            #expect(result.0.patch.moves?.count == 1)
            let replacement = source + "Incoming paragraph \(index)\n\n"
            start = CFAbsoluteTimeGetCurrent()
            let next = StoryMarkdownCodec.open(source: replacement, revision: "next", identitySeed: "reuse-timing", reusing: reuse ? opened.ledger.parsedKinds : [:])
            replacementTime += CFAbsoluteTimeGetCurrent() - start
            #expect(next.blocks.count == 501)
        }
        print("CACHE TIMING reuse=\(reuse) move_after_edit_ms=\(moveTime*50) replacement_parse_ms=\(replacementTime*50)")
    }
}
