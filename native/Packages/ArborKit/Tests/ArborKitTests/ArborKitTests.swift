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
        let first = try await coordinator.leaseDocument(.init(tree: "tr_sample", path: "/welcome", pageID: "pg_welcome"))
        let second = try await coordinator.leaseDocument(.init(tree: "tr_sample", path: "/renamed-hint", pageID: "pg_welcome"))

        #expect(first.identity == second.identity)
        #expect(ObjectIdentifier(first.session) == ObjectIdentifier(second.session))
        #expect(await coordinator.activeSessionCount() == 1)
        await coordinator.release(first)
        #expect(await coordinator.activeSessionCount() == 1)
        await coordinator.release(second)
        #expect(await coordinator.activeSessionCount() == 0)
        let reopened = try await coordinator.leaseDocument(.init(tree: "tr_sample", path: "/welcome", pageID: "pg_welcome"))
        _ = try await reopened.session.admit(source: "# Reopened\n", baseContentRevision: "r1")
        await coordinator.release(reopened)
    }

    @Test("Rename preserves PageID identity")
    func renameByPageID() async throws {
        let provider = InMemoryWorkspaceProvider.sample()
        let original = WorkspaceReference(tree: "tr_sample", path: "/welcome", pageID: "pg_welcome")
        let renamed = try #require(try await provider.perform(.rename(reference: original, name: "hello")))
        #expect(renamed.reference.pathHint == "/hello")
        #expect(renamed.reference.identity == original.identity)
        let resolved = try await provider.resolve(.init(tree: "tr_sample", path: "/stale", pageID: "pg_welcome"))
        #expect(resolved.reference.pathHint == "/hello")
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
        let session = try await provider.openDocument(.init(tree: "tr_sample", path: "/welcome", pageID: "pg_welcome"))
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
        controller.navigate(to: .init(tree: "tr_sample", path: "/welcome", pageID: "pg_welcome"))
        controller.updatePresentation(.init(selection: "block-a", scrollAnchor: "block-a", inspectorPresented: true))

        let secondID = controller.newTab(at: .init(tree: "tr_sample", path: "/people"))
        controller.updatePresentation(.init(selection: "row-2"))
        #expect(controller.selectedTab.presentation.selection == "row-2")

        controller.selectTab(firstID)
        #expect(controller.selectedTab.current.pathHint == "/welcome")
        #expect(controller.selectedTab.presentation.selection == "block-a")
        #expect(controller.canGoBack)
        controller.goBack()
        #expect(controller.selectedTab.current == home)

        controller.selectTab(secondID)
        #expect(controller.selectedTab.current.pathHint == "/people")
    }

    @Test("Command availability reflects navigation only")
    func commandAvailability() {
        let controller = BrowserTabController(home: .init(tree: "tr_sample", path: "/"))
        #expect(!controller.canGoBack)
        #expect(!controller.canGoParent)
        controller.navigate(to: .init(tree: "tr_sample", path: "/files/arbor.png"))
        #expect(controller.canGoBack)
        #expect(controller.canGoParent)
        controller.goParent()
        #expect(controller.selectedTab.current.pathHint == "/files")
    }
}
