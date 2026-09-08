import ArborKit
import ArborWire
import Foundation
import Quagmire
import QuagmireExtras
import Testing
@testable import ArborApp

@MainActor
struct ArborAppTests {
    @Test("History names Canopy as its unavailable authority")
    func canopyHistoryUnavailableCopy() {
        #expect(ArborHistoryView.title == "History")
        #expect(ArborHistoryView.unavailableTitle == "Canopy history is not available yet")
        #expect(ArborHistoryView.unavailableExplanation.contains("accepted Canopy versions"))
    }

    @Test("Share invites accept comma-separated handles and profile URLs")
    func shareInviteLocators() {
        #expect(ArborShareInvite.locators(
            in: " ~alice, arbor://community.example/~research,  ,~bob "
        ) == ["~alice", "arbor://community.example/~research", "~bob"])
    }

    @Test("Save diagnostics distinguish an external daemon that is no longer reachable")
    func externalDaemonSaveDiagnostic() throws {
        let diagnostic = try #require(ArborSaveDiagnostic.describe(
            URLError(.cannotConnectToHost),
            processKind: .external
        ))

        #expect(diagnostic.kind == .daemonUnreachable)
        #expect(diagnostic.conditionLabel == "External daemon unreachable")
        #expect(diagnostic.bannerMessage.contains("external Arbor Sync daemon"))
        #expect(diagnostic.explanation.contains("stopped or restarted on a different port"))
        #expect(diagnostic.recovery.contains("same loopback address"))
        #expect(diagnostic.synchronizationOverride == "Unavailable")
    }

    @Test("Save diagnostics distinguish a supervised daemon from an external one")
    func supervisedDaemonSaveDiagnostic() throws {
        let diagnostic = try #require(ArborSaveDiagnostic.describe(
            URLError(.networkConnectionLost),
            processKind: .supervised
        ))

        #expect(diagnostic.kind == .daemonUnreachable)
        #expect(diagnostic.conditionLabel == "Supervised daemon unreachable")
        #expect(diagnostic.explanation.contains("helper launched by this app"))
    }

    @Test("Save diagnostics distinguish timeouts from refused connections")
    func timedOutSaveDiagnostic() throws {
        let diagnostic = try #require(ArborSaveDiagnostic.describe(
            URLError(.timedOut),
            processKind: .external
        ))

        #expect(diagnostic.kind == .daemonTimedOut)
        #expect(diagnostic.conditionLabel == "Local daemon timed out")
        #expect(diagnostic.bannerMessage.contains("did not respond"))
    }

    @Test("Save diagnostics do not mislabel arbitrary provider failures as daemon outages")
    func genericSaveDiagnostic() throws {
        let diagnostic = try #require(ArborSaveDiagnostic.describe(
            CocoaError(.fileWriteNoPermission),
            processKind: .supervised
        ))

        #expect(diagnostic.kind == .providerFailure)
        #expect(diagnostic.conditionLabel == "Provider save failed")
        #expect(diagnostic.synchronizationOverride == nil)
    }

    @Test("Automatic synchronization recognizes transient network failures")
    func automaticSyncTransientNetworkErrors() {
        for error in [
            CancellationError(),
            URLError(.cancelled),
            URLError(.cannotConnectToHost),
            URLError(.networkConnectionLost),
            URLError(.notConnectedToInternet),
        ] as [Error] {
            #expect(ArborWorkspaceState.syncErrorMessage(
                for: error,
                reportTransientNetworkErrors: false
            ) == nil)
            #expect(ArborWorkspaceState.syncErrorMessage(
                for: error,
                reportTransientNetworkErrors: true
            ) != nil)
        }

        #expect(ArborWorkspaceState.syncErrorMessage(
            for: URLError(.badServerResponse),
            reportTransientNetworkErrors: false
        ) != nil)
        #expect(ArborWorkspaceState.syncErrorMessage(
            for: CocoaError(.fileReadCorruptFile),
            reportTransientNetworkErrors: false
        ) != nil)
    }

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

        #expect(model.node?.title == "No tree open")
        #expect(model.children.isEmpty)
        #expect(workspace.providerDetail == "No tree open")
    }

    @Test("The iPhone placements survive a native app relaunch")
    func nativePlacementRoundTrip() async throws {
        let root = FileManager.default.temporaryDirectory
            .appending(path: "ArborNativePlacement-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let store = NativePlacementStore(url: root.appending(path: "placement.json"))
        let tree = WireTreeDescriptor(
            id: "tr_native",
            kind: "ordinary",
            root: "sha256:\(String(repeating: "a", count: 64))",
            access: "write",
            canonical: WireCanonicalDescriptor(
                path: "/~joe/todos",
                endpoint: "https://arbor.example"
            ),
            update: "up_native"
        )
        let record = NativePlacementRecord(
            origin: try #require(URL(string: "https://arbor.example")),
            configurationTree: "tr_accountconfiguration",
            tree: tree
        )

        try await store.save(record)
        #expect(try await store.load() == record)
        let second = NativePlacementRecord(
            origin: try #require(URL(string: "https://arbor.example")),
            configurationTree: "tr_accountconfiguration",
            tree: WireTreeDescriptor(
                id: "tr_second",
                kind: "ordinary",
                root: "sha256:\(String(repeating: "b", count: 64))",
                access: "read",
                canonical: WireCanonicalDescriptor(
                    path: "/~joe/reading",
                    endpoint: "https://arbor.example"
                ),
                update: "up_second"
            )
        )
        try await store.save(second)
        #expect(try await store.load() == second)
        #expect(try await store.loadAll().map(\.tree.id) == ["tr_second", "tr_native"])

        try await store.clear(configurationTree: "tr_accountconfiguration")
        #expect(try await store.loadAll().isEmpty)
        try await store.clear()
        #expect(try await store.load() == nil)
    }

    @Test("A legacy single iPhone placement migrates when another tree is placed")
    func legacyNativePlacementMigration() async throws {
        let root = FileManager.default.temporaryDirectory
            .appending(path: "ArborLegacyNativePlacement-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let url = root.appending(path: "placement.json")
        let legacy = NativePlacementRecord(
            origin: try #require(URL(string: "https://arbor.example")),
            configurationTree: "tr_accountconfiguration",
            tree: WireTreeDescriptor(
                id: "tr_legacy",
                kind: "ordinary",
                root: "sha256:\(String(repeating: "c", count: 64))",
                access: "write",
                canonical: WireCanonicalDescriptor(path: "/~joe/legacy", endpoint: "https://arbor.example"),
                update: "up_legacy"
            )
        )
        try JSONEncoder().encode(legacy).write(to: url)
        let store = NativePlacementStore(url: url)

        #expect(try await store.loadAll() == [legacy])
        try await store.save(legacy)
        #expect(try await store.load() == legacy)
        #expect(try await store.loadAll() == [legacy])
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
        await model.navigate(to: .init(tree: "tr_sample", path: "/welcome", stableKey: markdownStableKey("pg_welcome")))

        #expect(model.node?.title == "Welcome")
        #expect(model.sidebarLocation.path == "/")
        #expect(model.children.map(\.title) == ["Welcome", "Files", "People", "Offline item", "Provider diagnostic"])
    }

#if os(macOS)
    @Test("Sidebar page orders sort searches and group recent pages by calendar period")
    func sidebarPageOrders() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try #require(TimeZone(secondsFromGMT: 0))
        calendar.firstWeekday = 2
        let now = try #require(ISO8601DateFormatter().date(from: "2026-09-09T12:00:00Z"))
        let tree = TreeID(rawValue: "tr_sample")
        let result: (String, String, String) -> WorkspaceSearchResult = { title, path, timestamp in
            WorkspaceSearchResult(
                reference: WorkspaceReference(tree: tree, path: path),
                title: title,
                modifiedAt: ISO8601DateFormatter().date(from: timestamp)
            )
        }
        let results = [
            result("Beta", "/beta", "2026-09-09T11:00:00Z"),
            result("🌲 Alpha", "/alpha", "2026-09-08T11:00:00Z"),
            result("Monthly", "/monthly", "2026-09-02T11:00:00Z"),
            result("Older", "/older", "2026-08-01T11:00:00Z"),
        ]

        #expect(ArborSidebarPages.sorted(results, by: .alphabetical).map(\.title)
            == ["🌲 Alpha", "Beta", "Monthly", "Older"])
        #expect(ArborSidebarPages.sorted(results, by: .recent).map(\.title)
            == ["Beta", "🌲 Alpha", "Monthly", "Older"])
        let groups = ArborSidebarPages.recentGroups(results, now: now, calendar: calendar)
        #expect(groups.map(\.title) == ["Today", "This Week", "This Month", "Earlier"])
        #expect(groups.map { $0.results.map(\.title) }
            == [["Beta"], ["🌲 Alpha"], ["Monthly"], ["Older"]])
    }
#endif

    @Test("Opening a page pushes a native page-frame path")
    func openingPushesPageFrame() async {
        let model = ArborAppModel()
        await model.load()
        let home = model.currentReference
        let welcome = WorkspaceReference(tree: "tr_sample", path: "/welcome", stableKey: markdownStableKey("pg_welcome"))

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

        #expect(model.sidebarLocation.path == "/files")
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
        let welcome = WorkspaceReference(tree: "tr_sample", path: "/welcome", stableKey: markdownStableKey("pg_welcome"))
        await first.navigate(to: welcome)
        await second.navigate(to: welcome)

        #expect(first.binding === second.binding)
        await first.newTab()
        #expect(first.tabItems.count == 2)
        #expect(second.tabItems.count == 1)
    }

    @Test("Structural receipts refresh workspace chrome without replacing the editor lease")
    func structuralReceiptReconciliation() async throws {
        let workspace = ArborWorkspaceState(provider: .sample())
        let model = ArborAppModel(workspace: workspace)
        await model.load()
        await model.navigate(to: .init(
            tree: "tr_sample",
            path: "/welcome",
            stableKey: markdownStableKey("pg_welcome")
        ))
        let lease = try #require(model.editorLease)
        let binding = lease.binding
        let host = try #require(model.editorHost)
        let root = WorkspaceReference(tree: "tr_sample", path: "/")

        await model.perform(
            .createDirectory(parent: root, name: "Receipt Folder"),
            navigateToResult: false
        )

        #expect(model.editorLease?.id == lease.id)
        #expect(model.binding === binding)
        #expect(model.editorHost === host)
        #expect(model.children.contains { $0.reference.path == "/Receipt Folder" })

        _ = try #require(await host.createDocument(
            title: "Receipt Page",
            requestedReference: nil,
            initialContent: nil
        ))
        let receipt = try #require(workspace.latestStructuralReceipt)
        await model.reconcile(receipt)

        #expect(model.editorLease?.id == lease.id)
        #expect(model.binding === binding)
        #expect(model.editorHost === host)
        #expect(model.children.contains { $0.reference.path == "/Receipt-Page" })
    }

    @Test("Linked-page trash confirmation rechecks backlinks and preserves the editor lease")
    func linkedPageTrashConfirmation() async throws {
        let workspace = ArborWorkspaceState(provider: .sample())
        let model = ArborAppModel(workspace: workspace)
        await model.load()
        await model.navigate(to: .init(
            tree: "tr_sample",
            path: "/welcome",
            stableKey: markdownStableKey("pg_welcome")
        ))
        let lease = try #require(model.editorLease)
        let source = try #require(model.binding?.reference)
        let root = WorkspaceReference(tree: "tr_sample", path: "/")
        let orphan = try #require(try await workspace.perform(.createMarkdown(
            parent: root,
            name: "Orphan",
            source: "# Orphan\n"
        )))

        model.offerToTrashLinkedPage(orphan, from: source)
        #expect(model.linkedPageTrashPrompt?.target == orphan.reference)
        await model.trashPromptedLinkedPageIfStillOrphaned()

        #expect(model.linkedPageTrashPrompt == nil)
        #expect(model.editorLease?.id == lease.id)
        #expect(try await workspace.provider.resolve(orphan.reference).reference.path == "/Trash/Orphan")

        let retained = try #require(try await workspace.perform(.createMarkdown(
            parent: root,
            name: "Retained",
            source: "# Retained\n"
        )))
        model.offerToTrashLinkedPage(retained, from: source)
        _ = try #require(try await workspace.perform(.createMarkdown(
            parent: root,
            name: "Other",
            source: "# Other\n\n[Retained](/Retained)\n"
        )))
        await model.trashPromptedLinkedPageIfStillOrphaned()

        #expect(try await workspace.provider.resolve(retained.reference).reference.path == "/Retained")
        #expect(model.editorLease?.id == lease.id)
    }

    @Test("Empty search starts as a page browser")
    func emptySearchListsPages() async throws {
        let workspace = ArborWorkspaceState(provider: .sample())
        let model = ArborAppModel(workspace: workspace)

        await model.search("")

        #expect(model.searchResults.contains { $0.reference.path == "/welcome" })
    }

    @Test("A final editor commit is durable before navigation completes")
    func navigationDrainsEditorTail() async throws {
        let workspace = ArborWorkspaceState(provider: .sample())
        let model = ArborAppModel(workspace: workspace)
        await model.load()
        await model.navigate(to: .init(tree: "tr_sample", path: "/welcome", stableKey: markdownStableKey("pg_welcome")))
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
            stableKey: markdownStableKey("pg_welcome")
        ))
        guard case let .markdown(source, _) = saved.surface else {
            Issue.record("Welcome was no longer a Markdown surface")
            return
        }
        #expect(source.contains("Saved at navigation"))
    }

    @Test("Voice delivery appends through the active stable-key binding and reaches the provider")
    func activeVoiceDelivery() async throws {
        let workspace = ArborWorkspaceState(provider: .sample())
        let model = ArborAppModel(workspace: workspace)
        await model.load()
        let welcome = WorkspaceReference(
            tree: "tr_sample",
            path: "/welcome",
            stableKey: markdownStableKey("pg_welcome")
        )
        await model.navigate(to: welcome)

        try await workspace.deliverVoiceTranscript(
            "Captured through Arbor voice.",
            to: try #require(welcome.stableKey)
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

    @Test("Recovered voice delivery resolves an inactive destination by stable key")
    func recoveredVoiceDelivery() async throws {
        let workspace = ArborWorkspaceState(provider: .sample())
        let welcome = WorkspaceReference(
            tree: "tr_sample",
            path: "/welcome",
            stableKey: markdownStableKey("pg_welcome")
        )

        try await workspace.deliverVoiceTranscript(
            "Recovered after interruption.",
            to: try #require(welcome.stableKey)
        )

        let saved = try await workspace.provider.resolve(welcome)
        guard case let .markdown(source, _) = saved.surface else {
            Issue.record("Welcome was no longer a Markdown surface")
            return
        }
        #expect(source.contains("Recovered after interruption."))
    }

#if os(macOS)
    @Test("The signed app can supervise its bundled arborsync helper")
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
