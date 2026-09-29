import CanopyAppKit
@testable import CanopyEditor
import Foundation
import Quagmire
import Testing

// Opt-in diagnostic; no timing threshold depends on machine load.
@MainActor @Test(.enabled(if: ProcessInfo.processInfo.environment["CANOPY_MEASURE_MOVES"] == "1"))
func measureMovePipeline() throws {
    for size in [50, 200, 500] {
        let source = (0..<size).map { "Paragraph \($0) with **some text** and a [link](page).\n\n" }.joined()
        let opened = CanopyMarkdownCodec.open(source: source, revision: "r", identitySeed: "timing")
        let document = Document(id: DocumentID("timing"), children: opened.blocks)
        let selected = opened.blocks[0].id
        var ledger = opened.ledger
        var capture = 0.0
        document.didCommitTransaction = { _ in
            let start = CFAbsoluteTimeGetCurrent()
            let (_, next) = CanopyMarkdownCodec.admission(blocks: document.children, ledger: ledger, moved: document.movedBlocksForCurrentCommit)
            capture += CFAbsoluteTimeGetCurrent() - start
            ledger = next
        }
        let start = CFAbsoluteTimeGetCurrent()
        for _ in 0..<20 { document.transaction(name: "Move") { _ = document.slideSiblings([selected], by: 1) } }
        let total = CFAbsoluteTimeGetCurrent() - start
        print("MOVE TIMING blocks=\(size) total_ms=\(total*50) capture_ms=\(capture*50) transaction_ms=\((total-capture)*50)")
    }
}
