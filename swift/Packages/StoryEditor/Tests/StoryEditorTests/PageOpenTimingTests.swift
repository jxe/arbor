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
        start = CFAbsoluteTimeGetCurrent()
        let sourceLines = StoryMarkdownCodec.sourceLines(source)
        let linesTime = ms(start)
        // Inline parsing alone, over every line's text: an upper bound on its share of the codec.
        start = CFAbsoluteTimeGetCurrent()
        for line in sourceLines where !line.content.isEmpty { _ = StoryMarkdownCodec.parseInline(line.content) }
        let inline = ms(start)
        lines.append(String(format: "OPEN DETAIL run=%d lines=%d source_lines_ms=%.1f inline_all_lines_ms=%.1f", run, sourceLines.count, linesTime, inline))
        cachedKinds = reopened.ledger.parsedKinds
        lines.append(String(format: "OPEN TIMING run=%d bytes=%d blocks=%d codec_ms=%.1f codec_reusing_parse_ms=%.1f present_ms=%.1f document_ms=%.1f walk_ms=%.1f",
                            run, source.utf8.count, count, codec, codecReusing, present, documentInit, walkTime))
    }
    _ = cachedKinds
    for line in lines { print(line) }
}

#if os(macOS)
import AppKit
import SwiftUI

// Opt-in diagnostic: STORY_MEASURE_EDITOR=<path to a page's Markdown> times
// Quagmire's first layout and first draw of that page's editor in a window,
// the step after the document is ready. Run under Time Profiler to see which
// per-block pass costs the most.
@MainActor @Test(.enabled(if: ProcessInfo.processInfo.environment["STORY_MEASURE_EDITOR"] != nil))
func measureEditorFirstFrame() async throws {
    let path = ProcessInfo.processInfo.environment["STORY_MEASURE_EDITOR"]!
    let source = try String(contentsOfFile: path, encoding: .utf8)
    func ms(_ start: CFAbsoluteTime) -> Double { (CFAbsoluteTimeGetCurrent() - start) * 1_000 }
    let provider = InMemoryWorkspaceProvider.sample()
    let reference = WorkspaceReference(tree: "tr_sample", path: "/welcome", stableKey: markdownStableKey("pg_welcome"))
    var lines: [String] = []
    for run in 0..<8 {
        let session = MeasuredPageSession(snapshot: .init(reference: reference, source: source, contentRevision: "r\(run)"))
        let binding = try await StoryDocumentBinding.open(reference: reference, session: session)
        let host = StoryEditorHost(
            binding: binding,
            provider: provider,
            linkPreviewService: LinkPreviewService(cacheDirectory: FileManager.default.temporaryDirectory
                .appending(path: "MeasureEditor-\(UUID().uuidString)"))
        )
        var start = CFAbsoluteTimeGetCurrent()
        let hosting = NSHostingView(rootView:
            EditorView(document: binding.document, state: binding.editorState, host: host)
                .frame(width: 760, height: 1_000)
        )
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 760, height: 1_000),
                              styleMask: [.titled], backing: .buffered, defer: false)
        window.contentView = hosting
        let make = ms(start)
        start = CFAbsoluteTimeGetCurrent()
        hosting.layoutSubtreeIfNeeded()
        let layout = ms(start)
        start = CFAbsoluteTimeGetCurrent()
        hosting.display()
        let draw = ms(start)
        // A second pass, as the run loop would make once the rows report sizes.
        start = CFAbsoluteTimeGetCurrent()
        hosting.layoutSubtreeIfNeeded()
        hosting.display()
        let settle = ms(start)
        lines.append(String(format: "EDITOR TIMING run=%d blocks=%d make_ms=%.1f layout_ms=%.1f draw_ms=%.1f settle_ms=%.1f",
                            run, binding.document.children.count, make, layout, draw, settle))
        window.contentView = nil
        window.close()
    }
    for line in lines { print(line) }
}

/// A read-only session over one page's source, for the editor benchmark.
private actor MeasuredPageSession: WorkspaceDocumentSession {
    nonisolated let identity: WorkspaceIdentity
    private let current: WorkspaceDocumentSnapshot

    init(snapshot: WorkspaceDocumentSnapshot) {
        identity = snapshot.reference.identity
        current = snapshot
    }

    func snapshot() -> WorkspaceDocumentSnapshot { current }
    func admit(source: String, baseContentRevision: String) -> WorkspaceDocumentSnapshot { current }
    func admit(patch: WorkspaceDocumentPatch) -> WorkspaceDocumentSnapshot { current }
    func flush() {}
    func history() -> [WorkspaceHistoryEntry] { [] }
    func recover(revision: String) -> WorkspaceDocumentSnapshot { current }
    func close() {}
}
#endif
