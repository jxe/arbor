import CanopyAppKit
import CanopyEditor
import Overstory
import OverstoryClient
import Foundation
import Quagmire
import QuagmireExtras
import Testing
import SwiftUI
#if os(macOS)
import AppKit
#endif
@testable import CanopyApp

@MainActor
struct CanopyAppTests {
    @Test("Profile frontmatter edits preserve the Markdown body")
    func profileFrontmatterEdits() throws {
        let personSource = "---\r\nid: pg_me\r\ntype: person\r\navatar: images/me.png\r\n---\r\n\r\n# Hello\r\n"
        let updated = try ArborProfileDocument.updatingPerson(
            personSource,
            displayName: "Joe Arbor",
            description: "Building gardens."
        )
        #expect(updated.contains("displayName: \"Joe Arbor\"\r\n"))
        #expect(updated.contains("description: \"Building gardens.\"\r\n"))
        #expect(updated.hasSuffix("---\r\n\r\n# Hello\r\n"))
        #expect(ArborProfileDocument.parse(updated)?.displayName == "Joe Arbor")

        let withoutDescription = try ArborProfileDocument.updatingPerson(
            updated,
            displayName: "Joe Arbor",
            description: "",
            avatarPath: "a1b2-profile-photo.jpg"
        )
        #expect(!withoutDescription.contains("description:"))
        #expect(withoutDescription.contains("avatar: \"a1b2-profile-photo.jpg\"\r\n"))
        #expect(ArborProfileDocument.parse(withoutDescription)?.avatarPath == "a1b2-profile-photo.jpg")

        let groupSource = "---\ntype: group\nmembers:\n  - profile: \"arbor://tr_existing/\"\n---\n\n# Garden\n"
        let withMember = try ArborProfileDocument.addingMember(
            profileTree: "tr_new",
            handle: nil,
            to: groupSource
        )
        #expect(withMember.contains("  - profile: \"arbor://tr_new/\"\n"))
        #expect(!withMember.contains("handle:"))
        #expect(withMember.hasSuffix("---\n\n# Garden\n"))
        #expect(throws: (any Error).self) {
            try ArborProfileDocument.addingMember(profileTree: "tr_new", handle: nil, to: withMember)
        }
        let personTree = "tr_" + String(repeating: "a", count: 52)
        let direct = try ArborProfileDocument.addingMember(
            profileTree: " \(personTree) ",
            handle: "~direct-person",
            reservesCanopyHandle: true,
            to: groupSource
        )
        #expect(direct.contains("  - profile: \"arbor://\(personTree)/\"\n    handle: \"direct-person\"\n"))
        #expect(ArborProfileDocument.parse(direct)?.memberHandlesByProfile["arbor://\(personTree)/"] == "direct-person")
        #expect(throws: (any Error).self) {
            try ArborProfileDocument.addingMember(
                profileTree: "tr_" + String(repeating: "b", count: 52),
                handle: "direct-person",
                reservesCanopyHandle: true,
                to: direct
            )
        }
        #expect(throws: (any Error).self) {
            try ArborProfileDocument.addingMember(profileTree: "not-a-tree", handle: nil, to: groupSource)
        }
        #expect(throws: (any Error).self) {
            try ArborProfileDocument.addingMember(
                profileTree: personTree,
                handle: "Not Valid",
                reservesCanopyHandle: true,
                to: groupSource
            )
        }
        #expect(throws: (any Error).self) {
            try ArborProfileDocument.addingMember(
                profileTree: "tr_valid2",
                handle: "valid",
                reservesCanopyHandle: true,
                to: groupSource
            )
        }
    }

    @Test("Group members list in authored order and remove one entry at a time")
    func groupMemberRemoval() throws {
        let source = """
        ---
        type: group
        # founders first
        members:
          - profile: "arbor://tr_alice/"
            handle: "alice"
          -
            profile: "arbor://tr_bob/"
          - arbor://garden.example/~carol
        displayName: Garden
        ---

        # Garden

        """
        let members = try #require(ArborProfileDocument.parse(source)).members
        #expect(members.map(\.profile) == ["arbor://tr_alice/", "arbor://tr_bob/", "arbor://garden.example/~carol"])
        #expect(members.map(\.handle) == ["alice", nil, nil])
        #expect(members.map(\.treeID) == ["tr_alice", "tr_bob", nil])

        let withoutAlice = try ArborProfileDocument.removingMember(profile: "arbor://tr_alice/", from: source)
        #expect(!withoutAlice.contains("alice"))
        #expect(withoutAlice.contains("# founders first\nmembers:\n  -\n    profile: \"arbor://tr_bob/\"\n"))
        #expect(withoutAlice.hasSuffix("displayName: Garden\n---\n\n# Garden\n"))

        let withoutBob = try ArborProfileDocument.removingMember(profile: "arbor://tr_bob/", from: withoutAlice)
        let empty = try ArborProfileDocument.removingMember(profile: "arbor://garden.example/~carol", from: withoutBob)
        #expect(empty.contains("members: []\ndisplayName: Garden\n"))
        #expect(ArborProfileDocument.parse(empty)?.members.isEmpty == true)
        let readded = try ArborProfileDocument.addingMember(profileTree: "tr_dave", handle: nil, to: empty)
        #expect(ArborProfileDocument.parse(readded)?.members.map(\.treeID) == ["tr_dave"])
        #expect(throws: (any Error).self) {
            try ArborProfileDocument.removingMember(profile: "arbor://tr_alice/", from: withoutAlice)
        }
    }

    @Test("A new group's root declares its name, description, and members")
    func newGroupSource() throws {
        let source = try ArborProfileDocument.newGroupSource(
            displayName: " Garden Club ",
            description: "Neighbors who grow things.",
            memberTrees: ["tr_alice", "tr_bob", "tr_alice"]
        )
        let profile = try #require(ArborProfileDocument.parse(source))
        #expect(profile.kind == .group)
        #expect(profile.displayName == "Garden Club")
        #expect(profile.description == "Neighbors who grow things.")
        #expect(profile.members.map(\.treeID) == ["tr_alice", "tr_bob"])
        #expect(source.hasSuffix("---\n\n# Garden Club\n"))
        let empty = try ArborProfileDocument.newGroupSource(displayName: "Solo", description: "", memberTrees: [])
        #expect(empty.contains("members: []\n"))
        #expect(!empty.contains("description:"))
        #expect(throws: (any Error).self) {
            try ArborProfileDocument.newGroupSource(displayName: "  ", description: "", memberTrees: [])
        }
        #expect(ArborGroupSlug.make(from: "Café Club — 2026!") == "cafe-club-2026")
        #expect(ArborGroupSlug.make(from: "!!!").isEmpty)
        #expect(ArborGroupSlug.isValid("cafe-club-2026"))
        #expect(!ArborGroupSlug.isValid("-cafe"))
    }

    @Test("Profile photos are normalized to a directory-compatible asset")
    func profilePhotoNormalization() throws {
        let png = try #require(Data(base64Encoded:
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
        ))
        let asset = try ArborProfilePhotoImport.normalized(png)
        #expect(asset.name == "profile-photo.jpg")
        #expect(asset.mediaType == "image/jpeg")
        #expect(!asset.bytes.isEmpty)
        #expect(asset.bytes.count <= AvatarCache.maximumBytes)
    }

    @Test("Source comparison highlights exact changed lines in either direction")
    func sourceComparisonLines() {
        let proposed = ArborSourceLineComparison(displayed: "same\nnew\n", baseline: "same\nold\n")
        #expect(proposed.changedLines == [1])
        #expect(proposed.lines.joined(separator: "\n") == "same\nnew\n")
        #expect(ArborSourceLineComparison(displayed: "same\nold\n", baseline: "same\nnew\n").changedLines == [1])
        #expect(ArborSourceLineComparison(displayed: "é", baseline: "e\u{301}").changedLines == [0])
        #expect(ArborSourceLineComparison(displayed: "a\r\n", baseline: "a\n").changedLines == [0])
        #expect(ArborSourceLineComparison(displayed: "same", baseline: "same\nremoved").status == "Changes appear in the other version")
        #expect(ArborSourceLineComparison(displayed: "", baseline: "").status == "Identical source")
        let large = ArborSourceLineComparison(displayed: String(repeating: "a\n", count: 4000), baseline: "b")
        #expect(large.changedLines.isEmpty)
        #expect(large.status == "Highlighting unavailable for this large comparison")
    }

    @Test("Profile toolbar summarizes synchronization into four visible states")
    func profileToolbarSyncStatus() {
        for synchronization in [WorkspaceSynchronization.current, .autoMerged] {
            #expect(ArborSyncStatus.resolve(
                synchronization: synchronization,
                documentIsSaving: false,
                documentNeedsAttention: false
            ) == .synchronized)
        }
        for synchronization in [WorkspaceSynchronization.locallyPending, .requestPending, .uploading, .downloading] {
            #expect(ArborSyncStatus.resolve(
                synchronization: synchronization,
                documentIsSaving: false,
                documentNeedsAttention: false
            ) == .syncing)
        }
        #expect(ArborSyncStatus.resolve(
            synchronization: .offline,
            documentIsSaving: false,
            documentNeedsAttention: false
        ) == .offline)
        for synchronization in [
            WorkspaceSynchronization.conflict,
            .authenticationFailure,
            .revoked,
        ] {
            #expect(ArborSyncStatus.resolve(
                synchronization: synchronization,
                documentIsSaving: false,
                documentNeedsAttention: false
            ) == .attention)
        }
    }

    @Test("Sync Status reports only this Native client's working tree")
    func nativeSyncStatusCopy() {
        let status = ArborSyncStatusView(
            provider: "Native working tree",
            sync: .init(state: .current),
            binding: nil,
            arborsyncProcessKind: nil,
            retrySave: {}, syncNow: {},
            reconnectArborSync: {}, showArborSyncLogs: {}
        )
        #expect(status.overallStatusTitle == "This Arbor client is up to date")
    }

    @Test("Profile toolbar never reports fully synced over pending or failed local retention")
    func profileToolbarSyncStatusPrecedence() {
        #expect(ArborSyncStatus.resolve(
            synchronization: .current,
            documentIsSaving: true,
            documentNeedsAttention: false
        ) == .syncing)
        #expect(ArborSyncStatus.resolve(
            synchronization: .offline,
            documentIsSaving: false,
            documentNeedsAttention: true
        ) == .attention)
    }

    @Test("iOS keeps Share for a healthy tree and replaces it with actionable sync states")
    func iosToolbarSyncStatus() {
        #expect(ArborSyncStatus.synchronized.showsIOSShareAction)
        #expect(!ArborSyncStatus.syncing.showsIOSShareAction)
        #expect(!ArborSyncStatus.offline.showsIOSShareAction)
        #expect(!ArborSyncStatus.attention.showsIOSShareAction)
    }

    @Test("A current tree cannot hide a document edit that could not be retained")
    func syncStatusRetainsDocumentFailure() async throws {
        let session = StatusConflictSession()
        let binding = try await ArborDocumentBinding.open(reference: session.reference, session: session)
        let host = ArborEditorHost(
            binding: binding,
            provider: InMemoryWorkspaceProvider.sample(),
            linkPreviewService: LinkPreviewService(cacheDirectory: FileManager.default.temporaryDirectory.appending(path: UUID().uuidString))
        )
        for text in ["First edit", "Latest edit"] {
            binding.document.transaction(name: "Edit") {
                _ = binding.document.setText(binding.document.children[0].id, AttributedString(text))
            }
            host.persistCommit(changes: [], in: binding.document)
            await binding.flush()
        }
        let status = ArborSyncStatusView(
            provider: "Test", sync: .init(state: .current), binding: binding,
            arborsyncProcessKind: nil,
            retrySave: {}, syncNow: {},
            reconnectArborSync: {}, showArborSyncLogs: {}
        )
        #expect(status.overallStatusTitle == "A document needs attention")
        #expect(status.saveStatus == "Latest edit not retained locally")
        #expect(binding.lastError != nil)
        await binding.close()
    }
    @Test("History explains that edits wait in the change log")
    func historyCopy() {
        #expect(ArborHistoryView.title == "History")
        #expect(ArborHistoryView.unavailableTitle == "No history yet")
        #expect(ArborHistoryView.unavailableExplanation.contains("change log"))
    }

    @Test("Share invites accept comma-separated handles and profile URLs")
    func shareInviteLocators() {
        #expect(ArborShareInvite.locators(
            in: " ~alice, arbor://community.example/~research,  ,~bob "
        ) == ["~alice", "arbor://community.example/~research", "~bob"])
    }

    @Test("Bootstrap diagnostics distinguish an external daemon that is no longer reachable")
    func externalDaemonSaveDiagnostic() throws {
        let diagnostic = try #require(ArborSaveDiagnostic.describe(
            URLError(.cannotConnectToHost),
            processKind: .external,
            context: .bootstrap
        ))

        #expect(diagnostic.kind == .daemonUnreachable)
        #expect(diagnostic.conditionLabel == "External daemon unreachable")
        #expect(diagnostic.bannerMessage.contains("external Arbor Sync daemon"))
        #expect(diagnostic.explanation.contains("stopped or restarted on a different port"))
        #expect(diagnostic.recovery.contains("same loopback address"))
        #expect(diagnostic.synchronizationOverride == "Unavailable")
    }

    @Test("Bootstrap diagnostics distinguish a supervised daemon from an external one")
    func supervisedDaemonSaveDiagnostic() throws {
        let diagnostic = try #require(ArborSaveDiagnostic.describe(
            URLError(.networkConnectionLost),
            processKind: .supervised,
            context: .bootstrap
        ))

        #expect(diagnostic.kind == .daemonUnreachable)
        #expect(diagnostic.conditionLabel == "Supervised daemon unreachable")
        #expect(diagnostic.explanation.contains("helper launched by this app"))
    }

    @Test("Bootstrap diagnostics distinguish timeouts from refused connections")
    func timedOutSaveDiagnostic() throws {
        let diagnostic = try #require(ArborSaveDiagnostic.describe(
            URLError(.timedOut),
            processKind: .external,
            context: .bootstrap
        ))

        #expect(diagnostic.kind == .daemonTimedOut)
        #expect(diagnostic.conditionLabel == "Local daemon timed out")
        #expect(diagnostic.bannerMessage.contains("did not respond"))
    }

#if os(macOS)
    @Test("Bootstrap rejection banner includes the daemon's explanation")
    func rejectedBootstrapShowsServerExplanation() throws {
        let error = ArborSyncServerError(
            status: 500,
            value: ArborSyncErrorValue(
                code: "internal-error",
                message: "Some files are unavailable cloud placeholders.",
                retryable: true,
                tree: nil,
                path: nil,
                details: nil
            )
        )
        let diagnostic = try #require(ArborSaveDiagnostic.describe(
            error,
            processKind: .external,
            context: .bootstrap
        ))

        #expect(diagnostic.bannerMessage.contains("unavailable cloud placeholders"))
        #expect(ArborWorkspaceState.bootstrapFailureMessage(error, processKind: .external)
            .contains("unavailable cloud placeholders"))
    }
#endif

    @Test("Local document retention never classifies a connection failure as a daemon outage")
    func saveDiagnosticsNeverBlameTheDaemon() throws {
        for error: Error in [URLError(.cannotConnectToHost), URLError(.timedOut), CocoaError(.fileWriteNoPermission)] {
            let diagnostic = try #require(ArborSaveDiagnostic.describe(error, processKind: .supervised))
            #expect(diagnostic.kind == .providerFailure)
            #expect(diagnostic.synchronizationOverride == nil)
            #expect(!diagnostic.bannerMessage.contains("daemon"))
        }
    }

    @Test("Durability diagnostics do not mislabel arbitrary provider failures as daemon outages")
    func genericSaveDiagnostic() throws {
        let diagnostic = try #require(ArborSaveDiagnostic.describe(
            CocoaError(.fileWriteNoPermission),
            processKind: .supervised
        ))

        #expect(diagnostic.kind == .providerFailure)
        #expect(diagnostic.conditionLabel == "Change log append failed")
        #expect(diagnostic.synchronizationOverride == nil)
    }

    @Test("An append failure says the edit is only in the editor and names the change log")
    func appendFailureDiagnostic() throws {
        let diagnostic = try #require(ArborSaveDiagnostic.describe(
            WorkspaceProviderError.invalidAction("Captured editor intent changed"),
            processKind: .supervised
        ))

        #expect(diagnostic.conditionLabel == "Change log append failed")
        #expect(diagnostic.editSafetyDetail.contains("only in this editor session"))
        #expect(diagnostic.technicalDetail == "Captured editor intent changed")
        #expect(diagnostic.explanation.contains("placed Arbor file"))
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

    @Test("Local overview refreshes for synchronized ordinary trees")
    func localOverviewSyncEvents() {
        let configurationTree = "tr_account"
        #expect(ArborWorkspaceState.localOverviewEventRequiresRefresh(
            tree: "system",
            origin: "external",
            configurationTree: configurationTree
        ))
        #expect(ArborWorkspaceState.localOverviewEventRequiresRefresh(
            tree: configurationTree,
            origin: "api",
            configurationTree: configurationTree
        ))
        #expect(ArborWorkspaceState.localOverviewEventRequiresRefresh(
            tree: "tr_document",
            origin: "sync",
            configurationTree: configurationTree
        ))
        #expect(!ArborWorkspaceState.localOverviewEventRequiresRefresh(
            tree: "tr_document",
            origin: "api",
            configurationTree: configurationTree
        ))
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

    @Test("Directory cache round-trips and avatar hashes cannot escape the cache")
    func directoryCache() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString, directoryHint: .isDirectory)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = DirectoryStore(url: root.appending(path: "Directory.json"))
        let entry = WireProfileDirectoryEntry(
            profile: "tr_aaaaaaaaaaaaaaaaaaaaaaaaaa",
            kind: "person",
            displayName: "Alice Arbor",
            sources: ["community"]
        )
        try await store.save(origin: URL(string: "https://community.example")!, entries: [entry])
        #expect(try await store.load().map(\.title) == ["Alice Arbor"])
        #expect(try AvatarCache.fileName(for: "sha256:" + String(repeating: "a", count: 64)) == String(repeating: "a", count: 64))
        #expect(throws: (any Error).self) { try AvatarCache.fileName(for: "../avatar") }
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
        #expect(try NativePlacementStore.selected(at: root.appending(path: "placement.json")) == record)
        var placed = record
        placed.osPath = "/Users/example/todos"
        try await store.save(placed)
        #expect(try NativePlacementStore.selected(at: root.appending(path: "placement.json"))?.osPath == "/Users/example/todos")
        #expect(placed.displayName == "todos")
        var sameTreeFromAnotherCanopy = placed
        sameTreeFromAnotherCanopy.origin = try #require(URL(string: "https://another.example"))
        try await store.save(sameTreeFromAnotherCanopy)
        #expect(try await store.loadAll().count == 1)
        #expect(try await store.loadAll().first?.origin == sameTreeFromAnotherCanopy.origin)
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

#if os(macOS)
    @Test("Visits are remembered most recent first, once per tree, and bounded")
    func visitedTreeStoreRoundTrip() async throws {
        let root = FileManager.default.temporaryDirectory
            .appending(path: "ArborVisits-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let store = VisitedTreeStore(url: root.appending(path: "Visits.json"))
        let origin = try #require(URL(string: "https://arbor.example"))
        func descriptor(_ id: String, path: String) -> WireTreeDescriptor {
            WireTreeDescriptor(
                id: id,
                kind: "ordinary",
                root: "sha256:\(String(repeating: "d", count: 64))",
                access: "read",
                canonical: WireCanonicalDescriptor(path: path, endpoint: "https://arbor.example"),
                update: "up_\(id)"
            )
        }
        #expect(try await store.loadAll().isEmpty)
        try await store.record(VisitedTreeRecord(origin: origin, tree: descriptor("tr_one", path: "/~a/one"), locator: "https://arbor.example/~a/one"))
        try await store.record(VisitedTreeRecord(origin: origin, tree: descriptor("tr_two", path: "/~a/two"), locator: "https://arbor.example/~a/two"))
        try await store.record(VisitedTreeRecord(origin: origin, tree: descriptor("tr_one", path: "/~a/one"), locator: "https://arbor.example/~a/one"))
        #expect(try await store.loadAll().map(\.tree.id) == ["tr_one", "tr_two"])
        for index in 0..<(VisitedTreeStore.limit + 5) {
            try await store.record(VisitedTreeRecord(origin: origin, tree: descriptor("tr_bulk\(index)", path: "/~a/b\(index)"), locator: "https://arbor.example/~a/b\(index)"))
        }
        #expect(try await store.loadAll().count == VisitedTreeStore.limit)
        try await store.forget(tree: "tr_bulk54")
        #expect(try await store.loadAll().first?.tree.id == "tr_bulk53")
        try await store.clear()
        #expect(try await store.loadAll().isEmpty)
    }

    @Test("Remote locators resolve to a Canopy origin and a canonical path")
    func remoteLocatorParsing() throws {
        let arbor = try #require(ArborRemoteLocator("arbor://community.example/~joe/notes"))
        #expect(arbor.origin.absoluteString == "https://community.example")
        #expect(arbor.path == "/~joe/notes")
        #expect(arbor.rootLocator == "https://community.example/")
        #expect(arbor.locator(path: "/~joe/notes") == "https://community.example/~joe/notes")
        let http = try #require(ArborRemoteLocator("http://127.0.0.1:4400/~joe/a%20b?x=1#frag"))
        #expect(http.origin.absoluteString == "http://127.0.0.1:4400")
        #expect(http.path == "/~joe/a b")
        #expect(http.locator(path: "/~joe/a b") == "http://127.0.0.1:4400/~joe/a%20b")
        #expect(ArborRemoteLocator("https://arbor.example")?.path == "/")
        #expect(ArborRemoteLocator("file:///Users/joe") == nil)
        #expect(ArborRemoteLocator("~joe") == nil)
    }

    @Test("A visit sparsifies a complete snapshot to directories and Markdown")
    func visitSnapshotSparsification() throws {
        let markdown = try WireObjectCodec.object(.file(Data("# Note\n".utf8)))
        let image = try WireObjectCodec.object(.file(Data([0x89, 0x50, 0x4E, 0x47])))
        let nestedDirectory = try WireObjectCodec.object(.directory([
            WireDirectoryEntry(name: "photo.png", file: image.hash),
        ]))
        let root = try WireObjectCodec.object(.directory([
            WireDirectoryEntry(name: "assets", directory: nestedDirectory.hash),
            WireDirectoryEntry(name: "cover.png", file: image.hash),
            WireDirectoryEntry(name: "note.md", file: markdown.hash),
        ]))
        let complete = WireSnapshot(root: root.hash, objects: [root, nestedDirectory, markdown, image])
        let sparse = try ArborVisitSnapshot.sparsified(complete)
        #expect(Set(sparse.spine.objects.map(\.hash)) == [root.hash, nestedDirectory.hash, markdown.hash])
        let objects = try WireObjectGraph.validate(sparse.spine, mode: .sparseFiles)
        #expect(objects[image.hash] == nil)
        guard case let .directory(rootEntries, _)? = objects[root.hash],
              case let .directory(nestedEntries, _)? = objects[nestedDirectory.hash] else {
            Issue.record("Sparse snapshot must retain both directories")
            return
        }
        #expect(rootEntries.first { $0.name == "cover.png" }?.file == image.hash)
        #expect(nestedEntries.first { $0.name == "photo.png" }?.file == image.hash)
        let replacement = try ArborVisitSnapshot.replacement(complete, tree: "tr_visit", update: "up_visit", cursor: "up_visit")
        #expect(replacement.root == root.hash)
        #expect(replacement.nodes.map(\.path).sorted() == ["/", "/assets", "/assets/photo.png", "/cover.png", "/note"])
    }
#endif

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
        #expect(!model.canGoHome)
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

    @Test("Sidebar page orders sort and group searches")
    func sidebarPageOrders() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try #require(TimeZone(secondsFromGMT: 0))
        calendar.firstWeekday = 2
        let now = try #require(ISO8601DateFormatter().date(from: "2026-09-09T12:00:00Z"))
        let tree = TreeID(rawValue: "tr_sample")
        let result: (String, String, String, Int) -> WorkspaceSearchResult = { title, path, timestamp, backlinks in
            WorkspaceSearchResult(
                reference: WorkspaceReference(tree: tree, path: path),
                title: title,
                modifiedAt: ISO8601DateFormatter().date(from: timestamp),
                backlinkCount: backlinks
            )
        }
        let results = [
            result("Beta", "/beta", "2026-09-09T11:00:00Z", 0),
            result("🌲 Alpha", "/alpha", "2026-09-08T11:00:00Z", 1),
            result("Monthly", "/monthly", "2026-09-02T11:00:00Z", 2),
            result("Older", "/older", "2026-08-01T11:00:00Z", 4),
        ]

        #expect(ArborSidebarPages.sorted(results, by: .alphabetical).map(\.title)
            == ["🌲 Alpha", "Beta", "Monthly", "Older"])
        #expect(ArborSidebarPages.sorted(results, by: .recent).map(\.title)
            == ["Beta", "🌲 Alpha", "Monthly", "Older"])
        #expect(ArborSidebarPages.sorted(results, by: .linkCount).map(\.title)
            == ["Older", "Monthly", "🌲 Alpha", "Beta"])
        let groups = ArborSidebarPages.recentGroups(results, now: now, calendar: calendar)
        #expect(groups.map(\.title) == ["Today", "This Week", "This Month", "Earlier"])
        #expect(groups.map { $0.results.map(\.title) }
            == [["Beta"], ["🌲 Alpha"], ["Monthly"], ["Older"]])
        let unknown = WorkspaceSearchResult(reference: WorkspaceReference(tree: tree, path: "/unknown"), title: "Unknown")
        let datedGroups = ArborSidebarPages.recentGroups(results + [unknown], now: now, calendar: calendar)
        #expect(datedGroups.last?.title == "Unknown date")
        #expect(datedGroups.last?.results == [unknown])
        #expect(datedGroups.first { $0.title == "Earlier" }?.results.map(\.title) == ["Older"])
        let linkGroups = ArborSidebarPages.linkCountGroups(results)
        #expect(linkGroups.map(\.title) == ["0 Links", "1 Link", "Multiple Links"])
        #expect(linkGroups.map { $0.results.map(\.title) }
            == [["Beta"], ["🌲 Alpha"], ["Older", "Monthly"]])
        #expect(linkGroups.map(\.showsBacklinkCounts) == [false, false, true])
        // Arrow keys walk pages in the order the sidebar draws them.
        #expect(ArborSidebarPages.displayOrder(results, by: .linkCount).map(\.title)
            == ["Beta", "🌲 Alpha", "Older", "Monthly"])
        #expect(ArborSidebarPages.displayOrder(results, by: .alphabetical) == ArborSidebarPages.sorted(results, by: .alphabetical))
        #expect(arborSidebarContextPath("/arbor-demo") == nil)
        #expect(arborSidebarContextPath("/March-Out-My-Work/arbor-demo")
            == "/March-Out-My-Work")
    }
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
        #expect(model.pagePresentation(for: .reference(home))?.editorLease == nil)
        #expect(model.pagePresentation(for: .reference(welcome))?.editorLease != nil)

        model.setNavigationPath([])
        #expect(model.currentReference == home)
        #expect(model.navigationPath.isEmpty)
        #expect(model.pagePresentation(for: .reference(home))?.editorLease == nil)
        #expect(model.pagePresentation(for: .reference(welcome))?.editorLease != nil)
    }

#if os(macOS)
    @Test("Mounted window preserves link history through destination resolution")
    func mountedLinkHistory() async throws {
        let home = WorkspaceReference(tree: "tr_sample", path: "/", stableKey: markdownStableKey("pg_console"))
        let picture = WorkspaceReference(tree: "tr_sample", path: "/Picture-of-Life", stableKey: markdownStableKey("pg_picture"))
        let provider = InMemoryWorkspaceProvider(nodes: [
            WorkspaceNode(reference: home, title: "Console", surface: .directoryDocument(source: "# Console\n\n[Picture of Life](Picture-of-Life)\n", contentRevision: "1", stored: true), provenance: .init(authority: .local, sourceDescription: "Test")),
            WorkspaceNode(reference: picture, title: "Picture of Life", surface: .directoryDocument(source: "# Picture of Life\n", contentRevision: "1", stored: true), provenance: .init(authority: .local, sourceDescription: "Test"))
        ])
        let workspace = ArborWorkspaceState(provider: provider)
        let model = ArborAppModel(workspace: workspace)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 900, height: 700),
                              styleMask: [.titled, .resizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentViewController = NSHostingController(rootView: ArborRootView(workspace: workspace, model: model))
        window.orderFront(nil)
        defer { window.close() }
        try await Task.sleep(for: .milliseconds(400))
        let previous = model.currentLocation
        let host = try #require(model.editorHost)
        host.openDocument(DocumentReference("arbor://tr_sample/Picture-of-Life"))
        try await Task.sleep(for: .milliseconds(500))
        #expect(model.currentReference == picture)
        #expect(model.canGoBack)
        #expect(model.tabs.selectedTab.back.last == previous)
        await model.goBack()
        try await Task.sleep(for: .milliseconds(400))
        #expect(model.currentLocation == previous)
        #expect(model.editorHost === host)
        #expect(model.canGoForward)
        await model.goForward()
        try await Task.sleep(for: .milliseconds(400))
        #expect(model.currentReference == picture)
        #expect(model.tabs.selectedTab.back.last == previous)
        await model.goBack()
        try await Task.sleep(for: .milliseconds(400))
        #expect(model.currentLocation == previous)
        #expect(model.editorHost === host)
    }
#endif

    @Test("Editor links push history and Back restores the previous editor")
    func editorLinkPushesHistory() async throws {
        let model = ArborAppModel()
        await model.load()
        await model.navigate(to: WorkspaceReference(tree: "tr_sample", path: "/welcome", stableKey: markdownStableKey("pg_welcome")))
        let previous = model.currentLocation
        let host = try #require(model.editorHost)
        host.openDocument(DocumentReference("arbor://tr_sample/"))
        for _ in 0..<200 where model.currentLocation == previous {
            try await Task.sleep(for: .milliseconds(1))
        }
        #expect(model.currentReference.path == "/")
        #expect(model.tabs.selectedTab.back.last == previous)
        await model.goBack()
        #expect(model.currentLocation == previous)
        #expect(model.editorHost === host)
    }

    @Test("Tree navigation preserves exact destinations and Back, Forward, and native pops")
    func crossTreeHistory() async throws {
        let first = InMemoryWorkspaceProvider.sample()
        let otherHome = WorkspaceReference(tree: "tr_other", path: "/")
        let otherPage = WorkspaceReference(tree: "tr_other", path: "/linked-page")
        let second = InMemoryWorkspaceProvider(nodes: [
            WorkspaceNode(reference: otherHome, title: "Other", surface: .directory(summary: ""), provenance: .init(authority: .diagnostic, sourceDescription: "Test")),
            WorkspaceNode(reference: otherPage, title: "Linked", surface: .markdown(source: "# Linked\n", contentRevision: "1"), provenance: .init(authority: .diagnostic, sourceDescription: "Test"))
        ])
        let workspace = ArborWorkspaceState(provider: first)
        var treeUnavailable = false
        let model = ArborAppModel(workspace: workspace, openNavigationTree: { tree in
            if treeUnavailable { throw ArborWireValidationError.invalidValue("Unavailable tree") }
            await workspace.switchProvider(
                tree == otherHome.tree ? second : first,
                home: tree == otherHome.tree ? otherHome : WorkspaceReference(tree: "tr_sample", path: "/"),
                detail: "Navigation test"
            )
        })
#if os(macOS)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 900, height: 700),
                              styleMask: [.titled, .resizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentViewController = NSHostingController(rootView: ArborRootView(workspace: workspace, model: model))
        window.orderFront(nil)
        defer { window.close() }
        try await Task.sleep(for: .milliseconds(400))
#endif
        await model.load()
        await model.navigate(to: WorkspaceReference(tree: "tr_sample", path: "/welcome", stableKey: markdownStableKey("pg_welcome")))
        let previous = model.currentLocation
        let tabID = model.selectedTabID
        await model.navigate(to: otherPage)
        await model.resetForWorkspace()
        try await Task.sleep(for: .milliseconds(400))
        #expect(model.selectedTabID == tabID)
        #expect(model.currentReference == otherPage)
        #expect(model.tabs.selectedTab.back.last == previous)
        #expect(model.binding != nil)
        treeUnavailable = true
        let beforeFailedBack = model.tabs.selectedTab
        let host = model.editorHost
        await model.goBack()
        #expect(model.tabs.selectedTab == beforeFailedBack)
        #expect(model.editorHost === host)
        treeUnavailable = false
        await model.goBack()
        #expect(model.currentLocation == previous)
        #expect(workspace.home.tree.rawValue == "tr_sample")
        #expect(model.binding != nil)
        await model.goForward()
        #expect(model.currentReference == otherPage)
        #expect(workspace.home.tree == otherHome.tree)
        model.setNavigationPath(Array(model.navigationPath.dropLast()))
        for _ in 0..<200 where model.currentLocation != previous || model.isLoading {
            try await Task.sleep(for: .milliseconds(1))
        }
        #expect(model.currentLocation == previous)
        #expect(workspace.home.tree.rawValue == "tr_sample")
        #expect(model.errorMessage == nil)
    }

    @Test("A failed tree open leaves the current editor and history intact")
    func failedTreeNavigation() async throws {
        let workspace = ArborWorkspaceState(provider: .sample())
        let model = ArborAppModel(workspace: workspace, openNavigationTree: { _ in
            throw ArborWireValidationError.invalidValue("Unavailable tree")
        })
        await model.load()
        await model.navigate(to: WorkspaceReference(tree: "tr_sample", path: "/welcome", stableKey: markdownStableKey("pg_welcome")))
        let previous = model.currentLocation
        let host = try #require(model.editorHost)
        let history = model.tabs.selectedTab
        await model.navigate(to: WorkspaceReference(tree: "tr_unavailable", path: "/page"))
        #expect(model.currentLocation == previous)
        #expect(model.tabs.selectedTab == history)
        #expect(model.editorHost === host)
        #expect(model.errorMessage != nil)
    }

    @Test("Home pops back to the tree root instead of pushing it again", arguments: [false, true])
    func homePopsTrail(stableHome: Bool) async {
        let root = WorkspaceReference(tree: "tr_sample", path: "/",
                                      stableKey: stableHome ? markdownStableKey("pg_home") : nil)
        let first = WorkspaceReference(tree: "tr_sample", path: "/first", stableKey: markdownStableKey("pg_first"))
        let second = WorkspaceReference(tree: "tr_sample", path: "/second", stableKey: markdownStableKey("pg_second"))
        let provider = InMemoryWorkspaceProvider(nodes: [root, first, second].map { reference in
            WorkspaceNode(reference: reference, title: reference.path,
                          surface: .directoryDocument(source: "# Page\n", contentRevision: "1", stored: true),
                          provenance: .init(authority: .local, sourceDescription: "Test"))
        })
        let model = ArborAppModel(workspace: ArborWorkspaceState(provider: provider))
        await model.load()
        let home = model.currentLocation
        let homeHost = model.editorHost
        #expect(!model.canGoHome)
        await model.navigate(to: first)
        await model.navigate(to: second)
        #expect(model.navigationPath.count == 2)
        #expect(model.canGoHome)

        await model.goHome()

        #expect(model.currentLocation == home)
        #expect(model.navigationPath.isEmpty)
        #expect(!model.canGoBack)
        #expect(!model.canGoHome)
        #expect(model.canGoForward)
        #expect(model.editorHost === homeHost)
        await model.goForward()
        #expect(model.currentReference == first)
        await model.goForward()
        #expect(model.currentReference == second)
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
            requestedReference: DocumentReference("Receipt-Page"),
            initialContent: nil
        ))
        let receipt = try #require(workspace.latestStructuralReceipt)
        await model.reconcile(receipt)

        #expect(model.editorLease?.id == lease.id)
        #expect(model.binding === binding)
        #expect(model.editorHost === host)
        #expect(model.children.contains { $0.reference.path == "/Receipt-Page" })
    }

    @Test("Moving the open page reconciles browser history before reopening it")
    func movingOpenPageDoesNotLeaveAStaleBackEntry() async throws {
        let workspace = ArborWorkspaceState(provider: .sample())
        let model = ArborAppModel(workspace: workspace)
        await model.load()
        let original = try #require(try await workspace.perform(.createMarkdown(
            parent: WorkspaceReference(tree: "tr_sample", path: "/"),
            name: "movable-page",
            source: "# Movable page\n"
        ))).reference
        await model.navigate(to: original)
        await model.search("")
        let host = try #require(model.editorHost)

        let move = Task { await host.moveCurrentDocument() }
        for _ in 0..<200 where host.structuralMoveRequest == nil {
            try await Task.sleep(for: .milliseconds(1))
        }
        _ = try #require(host.structuralMoveRequest)
        host.resolveStructuralMoveRequest(with: WorkspaceReference(tree: "tr_sample", path: "/files"))
        #expect(await move.value)

        #expect(model.currentReference.identity == original.identity)
        #expect(model.currentReference.path == "/files/movable-page")
        #expect(model.searchResults.contains {
            $0.reference.identity == original.identity && $0.reference.path == "/files/movable-page"
        })
        #expect(!model.searchResults.contains { $0.reference == original })
        #expect(!model.tabs.selectedTab.back.contains(.reference(original)))

        await model.goBack()
        #expect(model.errorMessage == nil)
        #expect(model.currentReference.path != original.path)
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

    @Test("Full-text search does not replace the sidebar page results")
    func fullTextSearchIsIndependentFromSidebar() async throws {
        let workspace = ArborWorkspaceState(provider: .sample())
        let model = ArborAppModel(workspace: workspace)
        await model.search("")
        let sidebarIdentities = model.searchResults.map(\.id)

        let matches = await model.fullTextSearch("Native Arbor is ready")

        #expect(matches.contains { $0.reference.path == "/welcome" })
        #expect(model.searchResults.map(\.id) == sidebarIdentities)

        await model.search("Native Arbor is ready")
        #expect(!model.searchResults.contains { $0.reference.path == "/welcome" })
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
    /// Hosted smoke: `swift/scripts/hosted-smoke.ts` starts a local Canopy,
    /// claims an account into the test data home, places a disposable folder,
    /// and runs this suite with `ARBOR_TEST_TREE` naming that tree. The signed
    /// app supervises its bundled control-mode helper on the test port, opens
    /// the tree through `/v1/bootstrap`, edits its own working tree, and the
    /// edit reaches the folder through Canopy and the daemon.
    @Test("The signed app opens a placed tree through its bundled control daemon and edits it")
    func hostedPlacedTreeSmoke() async throws {
        let environment = ProcessInfo.processInfo.environment
        guard environment["ARBOR_TEST_BUNDLED_HELPER"] == "1",
              let tree = environment["ARBOR_TEST_TREE"], !tree.isEmpty else { return }
        let workspace = ArborWorkspaceState()
        try await workspace.openPlacedTree(tree)
        #expect(workspace.openPlacedTreeID == tree)
        // A Canopy working tree keeps history on Canopy, not device-locally.
        #expect(workspace.capabilities == .init(structuralActions: true, assets: true, localHistory: false))
        let created = try #require(try await workspace.provider.perform(.createMarkdown(
            parent: workspace.home,
            name: "hosted-smoke",
            source: "# Hosted smoke\n"
        )))
        #expect(created.title == "Hosted smoke")
        await workspace.syncNow()
        await workspace.refreshLocalArborSyncOverview()
        let folder = try #require(workspace.localArborSyncOverview?.trees.first { $0.id == tree }?.path)
        let file = URL(fileURLWithPath: folder).appending(path: "hosted-smoke.md")
        var landed = false
        for _ in 0..<100 where !landed {
            if let source = try? String(contentsOf: file, encoding: .utf8), source.contains("# Hosted smoke") {
                landed = true
            } else {
                try await Task.sleep(for: .milliseconds(200))
            }
        }
        #expect(landed, "the app's edit did not reach \(file.path) through Canopy and the daemon")
        await workspace.shutdown()
    }
#endif
}

private actor StatusConflictSession: WorkspaceDocumentSession {
    nonisolated let reference = WorkspaceReference(tree: "tr_status", path: "/")
    nonisolated var identity: WorkspaceIdentity { reference.identity }
    func snapshot() -> WorkspaceDocumentSnapshot {
        .init(reference: reference, source: "Before\n", contentRevision: "r1")
    }
    func admit(source: String, baseContentRevision: String) throws -> WorkspaceDocumentSnapshot {
        throw WorkspaceDocumentConflict(
            current: .init(reference: reference, source: "Remote\n", contentRevision: "r2"),
            submittedSource: source
        )
    }
    func flush() {}
    func history() -> [WorkspaceHistoryEntry] { [] }
    func recover(revision: String) -> WorkspaceDocumentSnapshot { snapshot() }
    func close() {}
}
