#if os(macOS)
import AppKit
import Quagmire
import SwiftUI
import WebKit
import XCTest
@testable import StoryEditor

@MainActor private final class ComparisonHost: EditorHostDefaults {
    func persistCommit(changes: [DocumentChange], in document: Quagmire.Document) {}
    func flush(_ document: Quagmire.Document) async {}
}

/// Renders the pages `tools/public-page-compare/compare.ts` prepares, in Story's
/// editor and in WebKit, at one width on one Mac. Skipped unless that tool runs it.
@MainActor final class PublicPageComparisonRender: XCTestCase {
    private static let width: CGFloat = 708

    func testRenderComparisonPages() async throws {
        guard let path = ProcessInfo.processInfo.environment["PUBLIC_PAGE_COMPARE_DIR"] else {
            throw XCTSkip("Run by tools/public-page-compare/compare.ts")
        }
        let directory = URL(filePath: path)
        let names = try FileManager.default.contentsOfDirectory(atPath: path)
            .filter { $0.hasSuffix(".md") }.map { String($0.dropLast(3)) }
        for name in names {
            let source = try String(contentsOf: directory.appending(path: "\(name).md"), encoding: .utf8)
            let html = try String(contentsOf: directory.appending(path: "\(name).html"), encoding: .utf8)
            let height = CGFloat(source.utf8.count) * 4 + 800
            for (suffix, appearance) in [("light", NSAppearance.Name.aqua), ("dark", .darkAqua)] {
                try await renderStory(source, height: height, appearance: appearance,
                                      to: directory.appending(path: "\(name)-story-\(suffix).png"))
                try await renderWeb(html, height: height, appearance: appearance,
                                    to: directory.appending(path: "\(name)-web-\(suffix).png"))
            }
        }
    }

    private func renderStory(_ source: String, height: CGFloat, appearance: NSAppearance.Name, to url: URL) async throws {
        let document = Quagmire.Document(id: DocumentID("comparison"), children: StoryMarkdownCodec.parseBlocks(source, identitySeed: "comparison"))
        let callout = EditorCallout(id: "agent-task", title: "Agent Task", systemImage: "sparkles", tint: .purple,
            recognizes: { StoryAgentTask.isMarked($0) }, isDone: { StoryAgentTask.isDone($0) },
            toggle: { StoryAgentTask.toggled($0) }, trailing: { _ in EmptyView() })
        let host = ComparisonHost()
        let hosting = NSHostingView(rootView: EditorView(document: document, state: EditorState(), host: host, readOnly: true)
            .callouts([callout])
            .frame(width: Self.width, height: height)
            .background(appearance == .aqua ? Color.white : Color(red: 25 / 255, green: 25 / 255, blue: 25 / 255)))
        let window = self.window(height: height, appearance: appearance)
        window.contentView = hosting
        window.orderFrontRegardless()
        defer { window.orderOut(nil) }
        try await Task.sleep(for: .seconds(3))
        let bitmap = try XCTUnwrap(hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds))
        hosting.cacheDisplay(in: hosting.bounds, to: bitmap)
        try XCTUnwrap(bitmap.representation(using: .png, properties: [:])).write(to: url)
    }

    private func renderWeb(_ html: String, height: CGFloat, appearance: NSAppearance.Name, to url: URL) async throws {
        let web = WKWebView(frame: NSRect(x: 0, y: 0, width: Self.width, height: height))
        web.appearance = NSAppearance(named: appearance)
        let window = self.window(height: height, appearance: appearance)
        window.contentView = web
        window.orderFrontRegardless()
        defer { window.orderOut(nil) }
        web.loadHTMLString(html, baseURL: URL(string: "https://example.org/"))
        try await Task.sleep(for: .seconds(3))
        let image = try await web.takeSnapshot(configuration: nil)
        let bitmap = try XCTUnwrap(image.tiffRepresentation.flatMap(NSBitmapImageRep.init(data:)))
        try XCTUnwrap(bitmap.representation(using: .png, properties: [:])).write(to: url)
    }

    private func window(height: CGFloat, appearance: NSAppearance.Name) -> NSWindow {
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: Self.width, height: height),
                              styleMask: [.borderless], backing: .buffered, defer: false)
        window.appearance = NSAppearance(named: appearance)
        return window
    }
}
#endif
