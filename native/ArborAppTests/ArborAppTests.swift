import ArborKit
import ArborWire
import Foundation
import Quagmire
import QuagmireExtras
import Testing
@testable import ArborApp

@MainActor
struct ArborAppTests {
    @Test("Extras state uses Arbor-owned support directories")
    func extrasSupportDirectories() {
        #expect(ArborSupportDirectories.root.lastPathComponent == "Arbor")
        #expect(ArborSupportDirectories.linkPreviews.path.hasSuffix("/Arbor/LinkPreviews"))
        #expect(ArborSupportDirectories.pendingVoiceRecordings.path.hasSuffix(
            "/Arbor/Pending Voice Recordings"
        ))
        #expect(!ArborSupportDirectories.pendingVoiceRecordings.path.contains("Hunch"))
    }

    @Test("Production startup does not expose the in-memory sample tree")
    func productionStartupIsEmpty() async {
        let workspace = ArborWorkspaceState()
        let model = ArborAppModel(workspace: workspace)
        await model.load()

        #expect(model.node?.title == "No workspace open")
        #expect(model.children.isEmpty)
        #expect(workspace.providerDetail == "No workspace open")
    }

    @Test("The iPhone placement survives a native app relaunch")
    func nativePlacementRoundTrip() async throws {
        let root = FileManager.default.temporaryDirectory
            .appending(path: "ArborNativePlacement-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let store = NativePlacementStore(url: root.appending(path: "placement.json"))
        let tree = AuthorityTreeDescriptor(
            id: "tr_native",
            canonicalPath: "/~joe/todos",
            kind: "shared-subtree",
            ref: "sha256:\(String(repeating: "a", count: 64))",
            publicAccess: "none",
            access: "write",
            httpURL: "https://arbor.example/~joe/todos",
            arborURL: "arbor://arbor.example/~joe/todos",
            update: "up_native"
        )
        let record = NativePlacementRecord(
            origin: try #require(URL(string: "https://arbor.example")),
            tree: tree
        )

        try await store.save(record)
        #expect(try await store.load() == record)
        try await store.clear()
        #expect(try await store.load() == nil)
    }

    @Test("The app opens the deterministic Home surface")
    func loadsHome() async {
        let model = ArborAppModel()
        await model.load()
        #expect(model.node?.title == "Home")
        #expect(model.children.map(\.title) == ["Welcome", "Files", "People", "Offline item", "Provider diagnostic"])
    }

    @Test("A document keeps its containing directory visible in the sidebar")
    func documentKeepsContainingDirectorySidebar() async {
        let model = ArborAppModel()
        await model.load()
        await model.navigate(to: .init(tree: "tr_sample", path: "/welcome", pageID: "pg_welcome"))

        #expect(model.node?.title == "Welcome")
        #expect(model.sidebarLocation.pathHint == "/")
        #expect(model.children.map(\.title) == ["Welcome", "Files", "People", "Offline item", "Provider diagnostic"])
    }

    @Test("Opening a page pushes a native page-frame path")
    func openingPushesPageFrame() async {
        let model = ArborAppModel()
        await model.load()
        let home = model.currentReference
        let welcome = WorkspaceReference(tree: "tr_sample", path: "/welcome", pageID: "pg_welcome")

        await model.navigate(to: welcome)

        #expect(model.navigationRoot == .reference(home))
        #expect(model.navigationPath == [.reference(welcome)])
        #expect(!model.isLoading)

        model.setNavigationPath([])
        #expect(model.currentReference == home)
        #expect(model.navigationPath.isEmpty)
    }

    @Test("A directory becomes the sidebar browsing context")
    func directoryBecomesSidebarContext() async {
        let model = ArborAppModel()
        await model.load()
        await model.navigate(to: .init(tree: "tr_sample", path: "/files"))

        #expect(model.sidebarLocation.pathHint == "/files")
        #expect(model.children.map(\.title) == ["arbor.png"])
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
        let workspace = ArborWorkspaceState(provider: .sample())
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
        let workspace = ArborWorkspaceState(provider: .sample())
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

    @Test("Voice delivery appends through the active PageID binding and reaches the provider")
    func activeVoiceDelivery() async throws {
        let workspace = ArborWorkspaceState(provider: .sample())
        let model = ArborAppModel(workspace: workspace)
        await model.load()
        let welcome = WorkspaceReference(
            tree: "tr_sample",
            path: "/welcome",
            pageID: "pg_welcome"
        )
        await model.navigate(to: welcome)

        try await workspace.deliverVoiceTranscript(
            "Captured through Arbor voice.",
            to: "pg_welcome"
        )

        let binding = try #require(model.binding)
        var inserted = false
        binding.document.walk { block, _, _ in
            if String(block.text.characters) == "Captured through Arbor voice." {
                inserted = true
            }
        }
        #expect(inserted)
        let saved = try await workspace.provider.resolve(welcome)
        guard case let .markdown(source, _) = saved.surface else {
            Issue.record("Welcome was no longer a Markdown surface")
            return
        }
        #expect(source.contains("Captured through Arbor voice."))
    }

    @Test("Recovered voice delivery resolves an inactive destination by PageID")
    func recoveredVoiceDelivery() async throws {
        let workspace = ArborWorkspaceState(provider: .sample())
        let welcome = WorkspaceReference(
            tree: "tr_sample",
            path: "/welcome",
            pageID: "pg_welcome"
        )

        try await workspace.deliverVoiceTranscript(
            "Recovered after interruption.",
            to: "pg_welcome"
        )

        let saved = try await workspace.provider.resolve(welcome)
        guard case let .markdown(source, _) = saved.surface else {
            Issue.record("Welcome was no longer a Markdown surface")
            return
        }
        #expect(source.contains("Recovered after interruption."))
    }

#if os(macOS)
    @Test("The signed app can supervise its bundled arbord helper")
    func bundledHelperBoundary() async throws {
        guard ProcessInfo.processInfo.environment["ARBOR_TEST_BUNDLED_HELPER"] == "1" else { return }
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
        #expect(created.title == "Sandboxed helper")
        await workspace.shutdown()
    }
#endif
}
