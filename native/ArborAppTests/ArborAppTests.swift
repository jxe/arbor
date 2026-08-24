import ArborKit
import Foundation
import Quagmire
import Testing
@testable import ArborApp

@MainActor
struct ArborAppTests {
    @Test("The app opens the deterministic Home surface")
    func loadsHome() async {
        let model = ArborAppModel()
        await model.load()
        #expect(model.node?.title == "Home")
        #expect(model.children.map(\.title) == ["Welcome", "Files", "People", "Offline item", "Provider diagnostic"])
    }

    @Test("Navigation exposes non-document surfaces without creating a document session")
    func navigatesToCollection() async {
        let model = ArborAppModel()
        await model.load()
        await model.navigate(to: .init(tree: "tr_sample", path: "/people"))
        #expect(model.node?.title == "People")
        #expect(model.node?.isWritable == false)
        #expect(model.canGoBack)
    }

    @Test("Two windows share one PageID binding without sharing tabs")
    func windowsSharePersistenceNotPresentation() async throws {
        let workspace = ArborWorkspaceState()
        let first = ArborAppModel(workspace: workspace)
        let second = ArborAppModel(workspace: workspace)
        await first.load()
        await second.load()
        let welcome = WorkspaceReference(tree: "tr_sample", path: "/welcome", pageID: "pg_welcome")
        await first.navigate(to: welcome)
        await second.navigate(to: welcome)

        #expect(first.binding === second.binding)
        await first.newTab()
        #expect(first.tabItems.count == 2)
        #expect(second.tabItems.count == 1)
    }

    @Test("A final editor commit is durable before navigation completes")
    func navigationDrainsEditorTail() async throws {
        let workspace = ArborWorkspaceState()
        let model = ArborAppModel(workspace: workspace)
        await model.load()
        await model.navigate(to: .init(tree: "tr_sample", path: "/welcome", pageID: "pg_welcome"))
        let binding = try #require(model.binding)
        let host = try #require(model.editorHost)
        var foundParagraph: BlockID?
        binding.document.walk { block, _, _ in
            if foundParagraph == nil, case .paragraph = block.kind { foundParagraph = block.id }
        }
        let paragraph = try #require(foundParagraph)
        binding.document.transaction(name: "last edit") {
            _ = binding.document.setText(paragraph, AttributedString("Saved at navigation"))
        }
        host.persistCommit(changes: [], in: binding.document)

        await model.goHome()

        let saved = try await workspace.provider.resolve(.init(
            tree: "tr_sample",
            path: "/welcome",
            pageID: "pg_welcome"
        ))
        guard case let .markdown(source, _) = saved.surface else {
            Issue.record("Welcome was no longer a Markdown surface")
            return
        }
        #expect(source.contains("Saved at navigation"))
    }

#if os(macOS)
    @Test("The sandboxed app can supervise its inherited arbord helper")
    func sandboxedHelperBoundary() async throws {
        guard ProcessInfo.processInfo.environment["ARBOR_TEST_SANDBOX_HELPER"] == "1" else { return }
        let root = FileManager.default.temporaryDirectory
            .appending(path: "ArborSandboxHelper-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let workspace = ArborWorkspaceState()
        try await workspace.openLocalWorkspace(root, remember: false)
        let created = try #require(try await workspace.provider.perform(.createMarkdown(
            parent: workspace.home,
            name: "sandboxed",
            source: "# Sandboxed helper\n"
        )))
        #expect(created.title == "sandboxed")
        await workspace.shutdown()
    }
#endif
}
