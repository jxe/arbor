import StoryKit
@testable import StoryEditor
import Foundation
import Quagmire
import Testing

// Opt-in diagnostic: STORY_MEASURE_OPEN=<path to a page's Markdown> times each
// step of opening that page in the editor. No threshold depends on the machine.
@MainActor @Test(.enabled(if: ProcessInfo.processInfo.environment["STORY_MEASURE_OPEN"] != nil))
func measurePageOpen() throws {
    let path = ProcessInfo.processInfo.environment["STORY_MEASURE_OPEN"]!
    let source = try String(contentsOfFile: path, encoding: .utf8)
    func ms(_ start: CFAbsoluteTime) -> Double { (CFAbsoluteTimeGetCurrent() - start) * 1_000 }
    var lines: [String] = []
    var cachedKinds: [Data: BlockKind] = [:]
    for run in 0..<8 {
        var start = CFAbsoluteTimeGetCurrent()
        let opened = StoryMarkdownCodec.open(source: source, revision: "r\(run)", identitySeed: "timing")
        let codec = ms(start)
        start = CFAbsoluteTimeGetCurrent()
        let reopened = StoryMarkdownCodec.open(source: source, revision: "r\(run)", identitySeed: "timing", reusing: opened.ledger.parsedKinds)
        let codecReusing = ms(start)
        start = CFAbsoluteTimeGetCurrent()
        let presented = StoryPagePresentation.present(opened.blocks, path: "/")
        let present = ms(start)
        start = CFAbsoluteTimeGetCurrent()
        let document = Document(id: DocumentID("timing"), children: presented, fallbackTitle: "Console")
        let documentInit = ms(start)
        start = CFAbsoluteTimeGetCurrent()
        var count = 0
        func walk(_ blocks: [Block]) { for block in blocks { count += 1; _ = block.text; walk(block.children) } }
        walk(document.children)
        let walkTime = ms(start)
        cachedKinds = reopened.ledger.parsedKinds
        lines.append(String(format: "OPEN TIMING run=%d bytes=%d blocks=%d codec_ms=%.1f codec_reusing_parse_ms=%.1f present_ms=%.1f document_ms=%.1f walk_ms=%.1f",
                            run, source.utf8.count, count, codec, codecReusing, present, documentInit, walkTime))
    }
    _ = cachedKinds
    for line in lines { print(line) }
}
