import Foundation
import Testing
@testable import CanopyAppKit

@Test("Markdown-derived display titles are plain without mutating source semantics")
func markdownDisplayTitle() {
    #expect(WorkspaceDisplayTitle.derived(
        from: "---\nid: pg_title\n---\n\n# 🗓️ **Calendar**\n",
        fallback: "Calendar"
    ) == "🗓️ Calendar")
    #expect(WorkspaceDisplayTitle.plainText("A [linked](elsewhere.md) title") == "A linked title")
    #expect(WorkspaceDisplayTitle.derived(from: nil, fallback: "literal-**-filename") == "literal-**-filename")
    #expect(WorkspaceDisplayTitle.isEmoji("🌲"))
    #expect(!WorkspaceDisplayTitle.isEmoji("A"))
}

@Suite("Workspace coordination")
struct WorkspaceCoordinatorTests {
    @Test("Rejected source intents retain their reason in localized diagnostics")
    func rejectedIntentLocalizedReason() throws {
        let basis = WorkspaceDocumentSnapshot(reference: .init(tree: "tr_one", path: "/page"), source: "Before", contentRevision: "r1")
        let patch = WorkspaceDocumentPatch(baseContentRevision: "r1", edits: [])
        do {
            _ = try WorkspaceDocumentIntent(basis: basis, patch: patch, source: "After")
            Issue.record("Invalid intent was accepted")
        } catch {
            #expect(error.localizedDescription == "Source intent does not produce its declared candidate")
            #expect((error as NSError).localizedDescription == error.localizedDescription)
        }
    }

    @Test("Source intent validation uses exact UTF-8, not Unicode canonical equivalence")
    func sourceIntentUnicodeFidelity() throws {
        let basis = WorkspaceDocumentSnapshot(reference: .init(tree: "tr_one", path: "/page"), source: "x", contentRevision: "r1")
        let patch = WorkspaceDocumentPatch(baseContentRevision: "r1", edits: [.init(utf8Range: 0..<1, replacement: "\u{e9}")])
        #expect(throws: (any Error).self) {
            try WorkspaceDocumentIntent(basis: basis, patch: patch, source: "e\u{301}")
        }
    }

    @Test("Source intents validate their captured basis and candidate even after decoding")
    func sourceIntent() throws {
        let basis = WorkspaceDocumentSnapshot(reference: .init(tree: "tr_one", path: "/page"),
                                              source: "Before", contentRevision: "r1")
        let patch = WorkspaceDocumentPatch(baseContentRevision: "r1", edits: [
            .init(utf8Range: 0..<6, replacement: "After", expected: "Before")])
        let intent = try WorkspaceDocumentIntent(basis: basis, patch: patch, source: "After")
        #expect(try JSONDecoder().decode(WorkspaceDocumentIntent.self, from: JSONEncoder().encode(intent)) == intent)
        #expect(throws: (any Error).self) {
            try WorkspaceDocumentIntent(basis: basis, patch: patch, source: "Different candidate")
        }
        var json = try #require(try JSONSerialization.jsonObject(with: JSONEncoder().encode(intent)) as? [String: Any])
        json["source"] = "Corrupt candidate"
        #expect(throws: (any Error).self) {
            try JSONDecoder().decode(WorkspaceDocumentIntent.self, from: JSONSerialization.data(withJSONObject: json))
        }
    }

    @Test("Coalesced generations must chain exactly from the basis to the candidate")
    func sourceIntentGenerations() throws {
        let basis = WorkspaceDocumentSnapshot(reference: .init(tree: "tr_one", path: "/page"), source: "Before", contentRevision: "r1")
        let whole = WorkspaceDocumentPatch(baseContentRevision: "r1", edits: [.init(utf8Range: 0..<6, replacement: "After!")])
        let first = WorkspaceDocumentGeneration(patch: .init(baseContentRevision: "r1", edits: [.init(utf8Range: 0..<6, replacement: "After")]), source: "After")
        let second = WorkspaceDocumentGeneration(patch: .init(baseContentRevision: "r1", edits: [.init(utf8Range: 5..<5, replacement: "!")]), source: "After!")
        let intent = try WorkspaceDocumentIntent(basis: basis, patch: whole, source: "After!", generations: [first, second])
        #expect(intent.generations.count == 2)
        let decoded = try JSONDecoder().decode(WorkspaceDocumentIntent.self, from: JSONEncoder().encode(intent))
        #expect(decoded == intent)
        // A single-step intent encodes without the field and decodes as before.
        let single = try WorkspaceDocumentIntent(basis: basis, patch: whole, source: "After!")
        #expect(!String(decoding: try JSONEncoder().encode(single), as: UTF8.self).contains("generations"))
        #expect(try JSONDecoder().decode(WorkspaceDocumentIntent.self, from: JSONEncoder().encode(single)) == single)
        // The chain must end at the candidate, and each link must reproduce the next.
        #expect(throws: (any Error).self) { try WorkspaceDocumentIntent(basis: basis, patch: whole, source: "After!", generations: [first]) }
        #expect(throws: (any Error).self) {
            try WorkspaceDocumentIntent(basis: basis, patch: whole, source: "After!", generations: [first, .init(patch: second.patch, source: "Other")])
        }
        #expect(throws: (any Error).self) { try WorkspaceDocumentIntent(basis: basis, patch: whole, source: "After!", generations: [second, first]) }
    }

    @Test("Plain generations compose by range into one generation over the original")
    func composePlainGenerations() throws {
        func chain(_ source: String, _ generations: [[WorkspaceSourceEdit]]) throws -> [(Range<Int>, String)] {
            var current = source
            for edits in generations { current = try WorkspaceDocumentPatch(baseContentRevision: "r", edits: edits).applying(to: current) }
            let composed = try WorkspaceSourceEdit.compose(generations: generations)
            #expect(try WorkspaceDocumentPatch(baseContentRevision: "r", edits: composed).applying(to: source) == current)
            return composed.map { ($0.utf8Range, $0.replacement) }
        }
        let burst = try chain("Before 🪴\r\n", [[.init(utf8Range: 0..<0, replacement: "A")], [.init(utf8Range: 1..<1, replacement: "B")], [.init(utf8Range: 2..<8, replacement: "After")]])
        #expect(burst.map(\.0) == [0..<6] && burst.map(\.1) == ["ABAfter"])
        let split = try chain("Before plant", [[.init(utf8Range: 0..<6, replacement: "Start")], [.init(utf8Range: 1..<3, replacement: "TA"), .init(utf8Range: 10..<11, replacement: "T!")]])
        #expect(split.map(\.0) == [0..<6, 11..<12] && split.map(\.1) == ["STArt", "T!"])
        #expect(try chain("abc", [[.init(utf8Range: 0..<0, replacement: "X")], [.init(utf8Range: 0..<1, replacement: "")]]).isEmpty)
        let tail = try chain("Before 🪴\r\n", [[.init(utf8Range: 13..<13, replacement: "Z")], [.init(utf8Range: 7..<11, replacement: "")]])
        #expect(tail.map(\.0) == [7..<11, 13..<13] && tail.map(\.1) == ["", "Z"])
        let merged = try chain("ab", [[.init(utf8Range: 1..<1, replacement: "x"), .init(utf8Range: 1..<1, replacement: "y")], [.init(utf8Range: 3..<3, replacement: "z"), .init(utf8Range: 3..<4, replacement: "B")]])
        #expect(merged.map(\.0) == [1..<2] && merged.map(\.1) == ["xyzB"])
        #expect(throws: (any Error).self) { try WorkspaceSourceEdit.compose(generations: [[.init(utf8Range: 2..<3, replacement: ""), .init(utf8Range: 1..<1, replacement: "x")]]) }
        #expect(throws: (any Error).self) {
            try WorkspaceSourceEdit.compose(generations: [[.init(utf8Range: 0..<1, replacement: "a", lineage: [.init(source: 0..<1, replacement: 0..<1)])]])
        }
    }

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
        #expect(renamed.title == "Welcome")
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
        #expect(controller.navigationPath.isEmpty)
        #expect(!controller.canGoBack)
        controller.goForward()
        #expect(controller.selectedTab.current == .reference(first))
        controller.goForward()
        #expect(controller.selectedTab.current == .reference(second))
    }

    @Test("Returning to a page on the trail pops instead of pushing")
    func returnToPopsTrail() {
        let home = WorkspaceReference(tree: "tr_sample", path: "/")
        let pages = ["/a", "/b", "/c"].map { WorkspaceLocation.reference(.init(tree: "tr_sample", path: $0)) }
        let controller = BrowserTabController(home: home)
        pages.forEach(controller.navigate(to:))

        controller.returnTo(pages[0])
        #expect(controller.selectedTab.current == pages[0])
        #expect(controller.navigationPath == [pages[0]])
        #expect(controller.selectedTab.forward == [pages[2], pages[1]])

        controller.returnTo(pages[0])
        #expect(controller.navigationPath == [pages[0]])

        let elsewhere = WorkspaceLocation.reference(.init(tree: "tr_sample", path: "/z"))
        controller.returnTo(elsewhere)
        #expect(controller.navigationPath == [pages[0], elsewhere])
        #expect(!controller.canGoForward)
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
