import Foundation
import Testing
@testable import ArborKit

@Suite("Workspace coordination")
struct WorkspaceCoordinatorTests {
    @Test("Range-guarded source patches preserve untouched UTF-8 bytes")
    func sourcePatch() throws {
        let source = "---\r\nid: pg_patch\r\n---\r\n\r\n# Héllo\r\n\r\nKeep exactly.\r\n"
        let needle = Data("Héllo".utf8)
        let bytes = Data(source.utf8)
        let start = try #require(bytes.range(of: needle)?.lowerBound)
        let patch = WorkspaceDocumentPatch(
            baseContentRevision: "rev-1",
            edits: [WorkspaceSourceEdit(
                utf8Range: start..<(start + needle.count),
                replacement: "Hello",
                expected: "Héllo"
            )]
        )
        #expect(try patch.applying(to: source) == source.replacingOccurrences(of: "Héllo", with: "Hello"))
        #expect(throws: WorkspacePatchError.self) {
            try WorkspaceDocumentPatch(
                baseContentRevision: "rev-1",
                edits: [.init(utf8Range: start..<(start + needle.count), replacement: "x", expected: "wrong")]
            ).applying(to: source)
        }
    }

    @Test("Duplicate tabs lease one PageID session")
    func duplicateLeases() async throws {
        let provider = InMemoryWorkspaceProvider.sample()
        let coordinator = WorkspaceCoordinator(provider: provider)
        let first = try await coordinator.leaseDocument(.init(tree: "tr_sample", path: "/welcome", stableKey: markdownStableKey("pg_welcome")))
        let second = try await coordinator.leaseDocument(.init(tree: "tr_sample", path: "/renamed-hint", stableKey: markdownStableKey("pg_welcome")))

        #expect(first.identity == second.identity)
        #expect(ObjectIdentifier(first.session) == ObjectIdentifier(second.session))
        #expect(await coordinator.activeSessionCount() == 1)
        await coordinator.release(first)
        #expect(await coordinator.activeSessionCount() == 1)
        await coordinator.release(second)
        #expect(await coordinator.activeSessionCount() == 0)
        let reopened = try await coordinator.leaseDocument(.init(tree: "tr_sample", path: "/welcome", stableKey: markdownStableKey("pg_welcome")))
        _ = try await reopened.session.admit(source: "# Reopened\n", baseContentRevision: "r1")
        await coordinator.release(reopened)
    }

    @Test("Rename preserves PageID identity")
    func renameByPageID() async throws {
        let provider = InMemoryWorkspaceProvider.sample()
        let original = WorkspaceReference(tree: "tr_sample", path: "/welcome", stableKey: markdownStableKey("pg_welcome"))
        let renamed = try #require(try await provider.perform(.rename(reference: original, name: "hello")))
        #expect(renamed.reference.path == "/hello")
        #expect(renamed.reference.identity == original.identity)
        let resolved = try await provider.resolve(.init(tree: "tr_sample", path: "/stale", stableKey: markdownStableKey("pg_welcome")))
        #expect(resolved.reference.path == "/hello")
    }

    @Test("Non-document nodes cannot open document sessions")
    func rejectsNonDocument() async throws {
        let provider = InMemoryWorkspaceProvider.sample()
        let coordinator = WorkspaceCoordinator(provider: provider)
        await #expect(throws: WorkspaceProviderError.self) {
            _ = try await coordinator.leaseDocument(.init(tree: "tr_sample", path: "/people"))
        }
    }

    @Test("Document admission is synchronous and guarded")
    func admission() async throws {
        let provider = InMemoryWorkspaceProvider.sample()
        let session = try await provider.openDocument(.init(tree: "tr_sample", path: "/welcome", stableKey: markdownStableKey("pg_welcome")))
        let admitted = try await session.admit(source: "# Changed\n", baseContentRevision: "r1")
        #expect(admitted.contentRevision == "r2")
        await #expect(throws: WorkspaceDocumentConflict.self) {
            _ = try await session.admit(source: "# Stale\n", baseContentRevision: "r1")
        }
    }
}

@Suite("Browser tabs", .serialized)
@MainActor
struct BrowserTabControllerTests {
    @Test("Tabs retain independent navigation and presentation")
    func independentTabs() {
        let home = WorkspaceReference(tree: "tr_sample", path: "/")
        let controller = BrowserTabController(home: home)
        let firstID = controller.selectedTabID
        controller.navigate(to: .reference(.init(tree: "tr_sample", path: "/welcome", stableKey: markdownStableKey("pg_welcome"))))
        controller.updatePresentation(.init(selection: "block-a", scrollAnchor: "block-a", inspectorPresented: true))

        let secondID = controller.newTab(at: .reference(.init(tree: "tr_sample", path: "/people")))
        controller.updatePresentation(.init(selection: "row-2"))
        #expect(controller.selectedTab.presentation.selection == "row-2")

        controller.selectTab(firstID)
        #expect(controller.selectedTab.current.path == "/welcome")
        #expect(controller.selectedTab.presentation.selection == "block-a")
        #expect(controller.canGoBack)
        controller.goBack()
        #expect(controller.selectedTab.current == .reference(home))

        controller.selectTab(secondID)
        #expect(controller.selectedTab.current.path == "/people")
    }

    @Test("Command availability reflects navigation only")
    func commandAvailability() {
        let controller = BrowserTabController(home: .init(tree: "tr_sample", path: "/"))
        #expect(!controller.canGoBack)
        #expect(!controller.canGoParent)
        controller.navigate(to: .reference(.init(tree: "tr_sample", path: "/files/arbor.png")))
        #expect(controller.canGoBack)
        #expect(controller.canGoParent)
        controller.goParent()
        #expect(controller.selectedTab.current.path == "/files")
    }

    @Test("A tab exposes its trail as pushed page frames")
    func pushedPageFrames() {
        let home = WorkspaceReference(tree: "tr_sample", path: "/")
        let first = WorkspaceReference(tree: "tr_sample", path: "/first", stableKey: markdownStableKey("pg_first"))
        let second = WorkspaceReference(tree: "tr_sample", path: "/second", stableKey: markdownStableKey("pg_second"))
        let controller = BrowserTabController(home: home)

        controller.navigate(to: .reference(first))
        controller.navigate(to: .reference(second))

        #expect(controller.navigationRoot == .reference(home))
        #expect(controller.navigationPath == [.reference(first), .reference(second)])

        controller.setNavigationPath([.reference(first)])
        #expect(controller.selectedTab.current == .reference(first))
        #expect(controller.navigationPath == [.reference(first)])
        #expect(controller.canGoForward)

        controller.goForward()
        #expect(controller.navigationPath == [.reference(first), .reference(second)])

        controller.goHome(to: .reference(home))
        #expect(controller.selectedTab.current == .reference(home))
        #expect(controller.navigationPath.last == .reference(home))
        #expect(controller.canGoBack)
    }

    @Test("A PageID rename reconciles every trail without adding navigation")
    func reconcileRenamedReference() {
        let home = WorkspaceReference(tree: "tr_sample", path: "/")
        let old = WorkspaceReference(tree: "tr_sample", path: "/old", stableKey: markdownStableKey("pg_stable"))
        let renamed = WorkspaceReference(tree: "tr_sample", path: "/new", stableKey: markdownStableKey("pg_stable"))
        let controller = BrowserTabController(home: home)
        controller.navigate(to: .reference(old))
        controller.navigate(to: .reference(.init(tree: "tr_sample", path: "/other")))
        controller.newTab(at: .reference(old))

        controller.reconcileReference(renamed)

        #expect(controller.selectedTab.current == .reference(renamed))
        controller.selectTab(controller.tabs.first!.id)
        #expect(controller.selectedTab.back.last == .reference(renamed))
        #expect(controller.navigationPath.count == 2)
    }

    @Test("Local locations climb through tree boundaries to filesystem root")
    func localParentReachesFilesystemRoot() {
        let location = WorkspaceLocation.local("/Users/example/tree/page")
        #expect(location.parent == .local("/Users/example/tree"))
        #expect(location.parent?.parent == .local("/Users/example"))
        #expect(WorkspaceLocation.local("/").parent == nil)
    }

    @Test("Tree and remote locations stop at their own roots")
    func scopedParentsStopAtTreeRoot() {
        let treeRoot = WorkspaceLocation.reference(.init(tree: "tr_sample", path: "/"))
        #expect(treeRoot.parent == nil)
        let remoteRoot = WorkspaceLocation.remote(
            locator: "https://example.test/~joe/tree",
            rootLocator: "https://example.test/~joe/tree"
        )
        #expect(remoteRoot.parent == nil)
        let remoteChild = WorkspaceLocation.remote(
            locator: "https://example.test/~joe/tree/page",
            rootLocator: "https://example.test/~joe/tree"
        )
        #expect(remoteChild.parent == remoteRoot)
    }

    @Test("Launch location remains distinct from a computed Home destination")
    func launchAndHomeAreDistinct() {
        let launch = WorkspaceLocation.local("/Users/example/tree/deep")
        let home = WorkspaceLocation.local("/Users/example/tree")
        let controller = BrowserTabController(launchLocation: launch)
        controller.goHome(to: home)
        #expect(controller.launchLocation == launch)
        #expect(controller.selectedTab.current == home)
        #expect(controller.canGoBack)
    }
}

@Suite("Title filename proposals")
struct WorkspaceTitleSlugTests {
    @Test("Text, case, disambiguation, and emoji-only titles are stable")
    func proposals() {
        #expect(WorkspaceTitleSlug.name(for: "Hello, Arbor!") == "Hello-Arbor")
        #expect(WorkspaceTitleSlug.matches(name: "hello-arbor", title: "Hello, Arbor!"))
        #expect(WorkspaceTitleSlug.matches(name: "Hello-Arbor-2", title: "Hello, Arbor!"))
        #expect(!WorkspaceTitleSlug.matches(name: "Hello-Arbor-copy", title: "Hello, Arbor!"))
        #expect(WorkspaceTitleSlug.name(for: "🎉") == "party-popper")
    }
}
