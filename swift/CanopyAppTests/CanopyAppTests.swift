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
#if os(macOS)
    @Test("The first sidebar Control-click targets the pointer row without requiring selection")
    func sidebarControlClickTargetsUnselectedRow() throws {
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 320, height: 120),
                              styleMask: [], backing: .buffered, defer: false)
        let content = try #require(window.contentView)
        let row = NSTableRowView(frame: NSRect(x: 0, y: 20, width: 320, height: 40))
        content.addSubview(row)
        let menuView = CanopySidebarControlClickMenu.MenuView(frame: NSRect(x: 16, y: 0, width: 288, height: 40))
        var opened = 0
        var moved = 0
        menuView.open = { opened += 1 }
        menuView.movePage = { moved += 1 }
        row.addSubview(menuView)
        defer { menuView.stopMonitoring() }

        func click(_ point: NSPoint, flags: NSEvent.ModifierFlags = .control,
                   type: NSEvent.EventType = .leftMouseDown) throws -> NSEvent {
            try #require(NSEvent.mouseEvent(with: type, location: point, modifierFlags: flags,
                timestamp: 0, windowNumber: window.windowNumber, context: nil,
                eventNumber: 1, clickCount: 1, pressure: 1))
        }
        #expect(!row.isSelected)
        #expect(menuView.handles(try click(NSPoint(x: 4, y: 30)))) // row inset
        #expect(menuView.handles(try click(NSPoint(x: 150, y: 30))))
        #expect(!menuView.handles(try click(NSPoint(x: 150, y: 80))))
        #expect(!menuView.handles(try click(NSPoint(x: 150, y: 30), flags: [])))
        #expect(!menuView.handles(try click(NSPoint(x: 150, y: 30), type: .rightMouseDown)))
        #expect(opened == 0 && moved == 0)
        #expect(!row.isSelected)
        let menu = menuView.makeMenu()
        #expect(menu.items.map(\.title) == ["Open", "", "Move Page…"])
        menu.performActionForItem(at: 0)
        menu.performActionForItem(at: 2)
        #expect(opened == 1 && moved == 1)
        row.isHidden = true
        #expect(!menuView.handles(try click(NSPoint(x: 150, y: 30))))
        CanopySidebarControlClickMenu.dismantleNSView(menuView, coordinator: ())
        row.isHidden = false
        #expect(!menuView.handles(try click(NSPoint(x: 150, y: 30))))
    }
#endif

    @Test("Profile frontmatter edits preserve the Markdown body")
    func profileFrontmatterEdits() throws {
        let personSource = "---\r\nid: pg_me\r\ntype: person\r\navatar: images/me.png\r\n---\r\n\r\n# Hello\r\n"
        let updated = try CanopyProfileDocument.updatingPerson(
            personSource,
            displayName: "Joe Arbor",
            description: "Building gardens."
        )
        #expect(updated.contains("displayName: \"Joe Arbor\"\r\n"))
        #expect(updated.contains("description: \"Building gardens.\"\r\n"))
        #expect(updated.hasSuffix("---\r\n\r\n# Hello\r\n"))
        #expect(CanopyProfileDocument.parse(updated)?.displayName == "Joe Arbor")

        let withoutDescription = try CanopyProfileDocument.updatingPerson(
            updated,
            displayName: "Joe Arbor",
            description: "",
            avatarPath: "a1b2-profile-photo.jpg"
        )
        #expect(!withoutDescription.contains("description:"))
        #expect(withoutDescription.contains("avatar: \"a1b2-profile-photo.jpg\"\r\n"))
        #expect(CanopyProfileDocument.parse(withoutDescription)?.avatarPath == "a1b2-profile-photo.jpg")

        let groupSource = "---\ntype: group\nmembers:\n  - profile: \"arbor://tr_existing/\"\n---\n\n# Garden\n"
        let withMember = try CanopyProfileDocument.addingMember(
            profileTree: "tr_new",
            handle: nil,
            to: groupSource
        )
        #expect(withMember.contains("  - profile: \"arbor://tr_new/\"\n"))
        #expect(!withMember.contains("handle:"))
        #expect(withMember.hasSuffix("---\n\n# Garden\n"))
        #expect(throws: (any Error).self) {
            try CanopyProfileDocument.addingMember(profileTree: "tr_new", handle: nil, to: withMember)
        }
        let personTree = "tr_" + String(repeating: "a", count: 52)
        let direct = try CanopyProfileDocument.addingMember(
            profileTree: " \(personTree) ",
            handle: "~direct-person",
            reservesHostHandle: true,
            to: groupSource
        )
        #expect(direct.contains("  - profile: \"arbor://\(personTree)/\"\n    handle: \"direct-person\"\n"))
        #expect(CanopyProfileDocument.parse(direct)?.memberHandlesByProfile["arbor://\(personTree)/"] == "direct-person")
        let invitation = try CanopyProfileDocument.addingInvitation(
            handle: "~invited-person",
            digest: "sha256:" + String(repeating: "a", count: 64),
            to: groupSource
        )
        #expect(invitation.contains("  - handle: \"invited-person\"\n    inviteDigest: \"sha256:"))
        let pending = try #require(CanopyProfileDocument.parse(invitation))
        #expect(pending.memberHandles.contains("invited-person"))
        #expect(pending.members.contains { $0.handle == "invited-person" && $0.treeID == nil })
        #expect(throws: (any Error).self) {
            try CanopyProfileDocument.addingInvitation(handle: "invited-person", digest: "sha256:" + String(repeating: "b", count: 64), to: invitation)
        }
        let removedInvitation = try CanopyProfileDocument.removingMember(profile: "invite:sha256:" + String(repeating: "a", count: 64), from: invitation)
        #expect(!removedInvitation.contains("inviteDigest"))
        #expect(throws: (any Error).self) {
            try CanopyProfileDocument.addingMember(
                profileTree: "tr_" + String(repeating: "b", count: 52),
                handle: "direct-person",
                reservesHostHandle: true,
                to: direct
            )
        }
        #expect(throws: (any Error).self) {
            try CanopyProfileDocument.addingMember(profileTree: "not-a-tree", handle: nil, to: groupSource)
        }
        // A profile on another host is a member by its URL there, spelled canonically.
        let remote = try CanopyProfileDocument.addingMember(profileTree: "arbor://Garden.example/~alice/", handle: nil, to: groupSource)
        #expect(remote.contains("  - profile: \"https://garden.example/~alice\"\n"))
        #expect(CanopyProfileDocument.parse(remote)?.memberProfiles.contains("https://garden.example/~alice") == true)
        #expect(throws: (any Error).self) {
            try CanopyProfileDocument.addingMember(profileTree: "https://garden.example/~alice", handle: nil, to: remote)
        }
        // In the community it reserves a handle, by default the name it has at its home host.
        let placed = try CanopyProfileDocument.addingMember(profileTree: "https://garden.example/~alice", handle: nil, reservesHostHandle: true, to: groupSource)
        #expect(placed.contains("  - profile: \"https://garden.example/~alice\"\n    handle: \"alice\"\n"))
        let renamed = try CanopyProfileDocument.addingMember(profileTree: "https://garden.example/~alice", handle: "ali", reservesHostHandle: true, to: groupSource)
        #expect(renamed.contains("    handle: \"ali\"\n"))
        #expect(throws: (any Error).self) {
            try CanopyProfileDocument.addingMember(profileTree: "http://garden.example/~alice", handle: nil, to: groupSource)
        }
        #expect(throws: (any Error).self) {
            try CanopyProfileDocument.addingMember(
                profileTree: personTree,
                handle: "Not Valid",
                reservesHostHandle: true,
                to: groupSource
            )
        }
        #expect(throws: (any Error).self) {
            try CanopyProfileDocument.addingMember(
                profileTree: "tr_valid2",
                handle: "valid",
                reservesHostHandle: true,
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
        let members = try #require(CanopyProfileDocument.parse(source)).members
        #expect(members.map(\.profile) == ["arbor://tr_alice/", "arbor://tr_bob/", "arbor://garden.example/~carol"])
        #expect(members.map(\.handle) == ["alice", nil, nil])
        #expect(members.map(\.treeID) == ["tr_alice", "tr_bob", nil])

        let withoutAlice = try CanopyProfileDocument.removingMember(profile: "arbor://tr_alice/", from: source)
        #expect(!withoutAlice.contains("alice"))
        #expect(withoutAlice.contains("# founders first\nmembers:\n  -\n    profile: \"arbor://tr_bob/\"\n"))
        #expect(withoutAlice.hasSuffix("displayName: Garden\n---\n\n# Garden\n"))

        let withoutBob = try CanopyProfileDocument.removingMember(profile: "arbor://tr_bob/", from: withoutAlice)
        let empty = try CanopyProfileDocument.removingMember(profile: "arbor://garden.example/~carol", from: withoutBob)
        #expect(empty.contains("members: []\ndisplayName: Garden\n"))
        #expect(CanopyProfileDocument.parse(empty)?.members.isEmpty == true)
        let readded = try CanopyProfileDocument.addingMember(profileTree: "tr_dave", handle: nil, to: empty)
        #expect(CanopyProfileDocument.parse(readded)?.members.map(\.treeID) == ["tr_dave"])
        #expect(throws: (any Error).self) {
            try CanopyProfileDocument.removingMember(profile: "arbor://tr_alice/", from: withoutAlice)
        }
    }

    @Test("A new group's root declares its name, description, and members")
    func newGroupSource() throws {
        let source = try CanopyProfileDocument.newGroupSource(
            displayName: " Garden Club ",
            description: "Neighbors who grow things.",
            memberTrees: ["tr_alice", "tr_bob", "tr_alice"]
        )
        let profile = try #require(CanopyProfileDocument.parse(source))
        #expect(profile.kind == .group)
        #expect(profile.displayName == "Garden Club")
        #expect(profile.description == "Neighbors who grow things.")
        #expect(profile.members.map(\.treeID) == ["tr_alice", "tr_bob"])
        #expect(source.hasSuffix("---\n\n# Garden Club\n"))
        let empty = try CanopyProfileDocument.newGroupSource(displayName: "Solo", description: "", memberTrees: [])
        #expect(empty.contains("members: []\n"))
        #expect(!empty.contains("description:"))
        #expect(throws: (any Error).self) {
            try CanopyProfileDocument.newGroupSource(displayName: "  ", description: "", memberTrees: [])
        }
        #expect(CanopyGroupSlug.make(from: "Café Club — 2026!") == "cafe-club-2026")
        #expect(CanopyGroupSlug.make(from: "!!!").isEmpty)
        #expect(CanopyGroupSlug.isValid("cafe-club-2026"))
        #expect(!CanopyGroupSlug.isValid("-cafe"))
    }

    @Test("Profile photos are normalized to a directory-compatible asset")
    func profilePhotoNormalization() throws {
        let png = try #require(Data(base64Encoded:
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
        ))
        let asset = try CanopyProfilePhotoImport.normalized(png)
        #expect(asset.name == "profile-photo.jpg")
        #expect(asset.mediaType == "image/jpeg")
        #expect(!asset.bytes.isEmpty)
        #expect(asset.bytes.count <= AvatarCache.maximumBytes)
    }

    @Test("Source comparison highlights exact changed lines in either direction")
    func sourceComparisonLines() {
        let proposed = CanopySourceLineComparison(displayed: "same\nnew\n", baseline: "same\nold\n")
        #expect(proposed.changedLines == [1])
        #expect(proposed.lines.joined(separator: "\n") == "same\nnew\n")
        #expect(CanopySourceLineComparison(displayed: "same\nold\n", baseline: "same\nnew\n").changedLines == [1])
        #expect(CanopySourceLineComparison(displayed: "é", baseline: "e\u{301}").changedLines == [0])
        #expect(CanopySourceLineComparison(displayed: "a\r\n", baseline: "a\n").changedLines == [0])
        #expect(CanopySourceLineComparison(displayed: "same", baseline: "same\nremoved").status == "Changes appear in the other version")
        #expect(CanopySourceLineComparison(displayed: "", baseline: "").status == "Identical source")
        let large = CanopySourceLineComparison(displayed: String(repeating: "a\n", count: 4000), baseline: "b")
        #expect(large.changedLines.isEmpty)
        #expect(large.status == "Highlighting unavailable for this large comparison")
    }

    @Test("A whole-tree conflict lists only the lines one version alone added that current lacks")
    func conflictMissingLines() {
        let kept = "# Flight\n- Kevin\n\n- IFS\n"
        let setAside = "# Flight\n▸ Tweets\n  - The Prestige?\n\n- IFS\n- Lunch\n"
        let current = "# Flight\n- Kevin\n  - IFS\n"
        // Re-indented and blank lines count as present; lines both versions held don't count.
        #expect(CanopyChoiceVersionCards.missingLines(in: setAside, others: [kept], current: current)
            == ["▸ Tweets", "  - The Prestige?", "- Lunch"])
        #expect(CanopyChoiceVersionCards.missingLines(in: kept, others: [setAside], current: current).isEmpty)
        #expect(CanopyChoiceVersionCards.missingLines(in: nil, others: [kept], current: current).isEmpty)
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
        #expect(status.overallStatusTitle == "Canopy is up to date")
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
        let binding = try await CanopyDocumentBinding.open(reference: session.reference, session: session)
        let host = CanopyEditorHost(
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
        #expect(CanopyHistoryView.title == "History")
        #expect(CanopyHistoryView.unavailableTitle == "No history yet")
        #expect(CanopyHistoryView.unavailableExplanation.contains("change log"))
    }

    @Test("Share invites accept comma-separated handles and profile URLs")
    func shareInviteLocators() {
        #expect(CanopyShareInvite.locators(
            in: " ~alice, arbor://community.example/~research,  ,~bob "
        ) == ["~alice", "arbor://community.example/~research", "~bob"])
    }

    @Test("Bootstrap diagnostics distinguish an external daemon that is no longer reachable")
    func externalDaemonSaveDiagnostic() throws {
        let diagnostic = try #require(CanopySaveDiagnostic.describe(
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
        let diagnostic = try #require(CanopySaveDiagnostic.describe(
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
        let diagnostic = try #require(CanopySaveDiagnostic.describe(
            URLError(.timedOut),
            processKind: .external,
            context: .bootstrap
        ))

        #expect(diagnostic.kind == .daemonTimedOut)
        #expect(diagnostic.conditionLabel == "Local daemon timed out")
        #expect(diagnostic.bannerMessage.contains("did not respond"))
    }

#if os(macOS)
    @Test("A placement host's refused credential reads as a refusal naming the home host")
    func placementCredentialRefusal() {
        func refusal(_ status: Int, retryable: Bool) -> ProtocolHTTPError {
            ArborSyncServerError(status: status, value: ArborSyncErrorValue(
                code: status == 409 ? "unauthenticated" : "internal-error", message: "refused", retryable: retryable,
                tree: nil, path: nil, details: .object(["homeHost": .string("https://garden.example")])
            )).credentialRefusal
        }
        let unreachable = refusal(503, retryable: true)
        #expect(unreachable.status == 503 && unreachable.retryable)
        #expect(unreachable.localizedDescription.contains("can't reach the account's home host, garden.example"))
        let unlisted = refusal(409, retryable: false)
        #expect(unlisted.status == 401 && unlisted.homeHost == "https://garden.example")
    }

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
        let diagnostic = try #require(CanopySaveDiagnostic.describe(
            error,
            processKind: .external,
            context: .bootstrap
        ))

        #expect(diagnostic.bannerMessage.contains("unavailable cloud placeholders"))
        #expect(CanopyWorkspaceState.bootstrapFailureMessage(error, processKind: .external)
            .contains("unavailable cloud placeholders"))
    }
#endif

    @Test("Local document retention never classifies a connection failure as a daemon outage")
    func saveDiagnosticsNeverBlameTheDaemon() throws {
        for error: Error in [URLError(.cannotConnectToHost), URLError(.timedOut), CocoaError(.fileWriteNoPermission)] {
            let diagnostic = try #require(CanopySaveDiagnostic.describe(error, processKind: .supervised))
            #expect(diagnostic.kind == .providerFailure)
            #expect(diagnostic.synchronizationOverride == nil)
            #expect(!diagnostic.bannerMessage.contains("daemon"))
        }
    }

    @Test("Durability diagnostics do not mislabel arbitrary provider failures as daemon outages")
    func genericSaveDiagnostic() throws {
        let diagnostic = try #require(CanopySaveDiagnostic.describe(
            CocoaError(.fileWriteNoPermission),
            processKind: .supervised
        ))

        #expect(diagnostic.kind == .providerFailure)
        #expect(diagnostic.conditionLabel == "Change log append failed")
        #expect(diagnostic.synchronizationOverride == nil)
    }

    @Test("An append failure says the edit is only in the editor and names the change log")
    func appendFailureDiagnostic() throws {
        let diagnostic = try #require(CanopySaveDiagnostic.describe(
            WorkspaceProviderError.invalidAction("Captured editor intent changed"),
            processKind: .supervised
        ))

        #expect(diagnostic.conditionLabel == "Change log append failed")
        #expect(diagnostic.editSafetyDetail.contains("only in this editor session"))
        #expect(diagnostic.technicalDetail == "Captured editor intent changed")
        #expect(diagnostic.explanation.contains("placed tree file"))
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
            #expect(CanopyWorkspaceState.syncErrorMessage(
                for: error,
                reportTransientNetworkErrors: false
            ) == nil)
            #expect(CanopyWorkspaceState.syncErrorMessage(
                for: error,
                reportTransientNetworkErrors: true
            ) != nil)
        }

        #expect(CanopyWorkspaceState.syncErrorMessage(
            for: URLError(.badServerResponse),
            reportTransientNetworkErrors: false
        ) != nil)
        #expect(CanopyWorkspaceState.syncErrorMessage(
            for: CocoaError(.fileReadCorruptFile),
            reportTransientNetworkErrors: false
        ) != nil)
    }

    @Test("Local overview refreshes for synchronized ordinary trees")
    func localOverviewSyncEvents() {
        let configurationTree = "tr_account"
        #expect(CanopyWorkspaceState.localOverviewEventRequiresRefresh(
            tree: "system",
            origin: "external",
            configurationTree: configurationTree
        ))
        #expect(CanopyWorkspaceState.localOverviewEventRequiresRefresh(
            tree: configurationTree,
            origin: "api",
            configurationTree: configurationTree
        ))
        #expect(CanopyWorkspaceState.localOverviewEventRequiresRefresh(
            tree: "tr_document",
            origin: "sync",
            configurationTree: configurationTree
        ))
        #expect(!CanopyWorkspaceState.localOverviewEventRequiresRefresh(
            tree: "tr_document",
            origin: "api",
            configurationTree: configurationTree
        ))
    }

    @Test("Extras state uses Arbor-owned support directories")
    func extrasSupportDirectories() {
        #expect(CanopySupportDirectories.root.lastPathComponent == "Arbor")
        #expect(CanopySupportDirectories.linkPreviews.path.hasSuffix("/Arbor/LinkPreviews"))
        #expect(CanopySupportDirectories.pendingVoiceRecordings.path.hasSuffix(
            "/Arbor/Pending Voice Recordings"
        ))
        #expect(!CanopySupportDirectories.pendingVoiceRecordings.path.contains("Hunch"))
    }

    @Test("Directory cache round-trips and avatar hashes cannot escape the cache")
    func directoryCache() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString, directoryHint: .isDirectory)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = DirectoryStore(url: root.appending(path: "Directory.json"))
        let entry = ProtocolProfileDirectoryEntry(
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
        let workspace = CanopyWorkspaceState()
        let model = CanopyAppModel(workspace: workspace)
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
        let tree = ProtocolTreeDescriptor(
            id: "tr_native",
            kind: "ordinary",
            root: "sha256:\(String(repeating: "a", count: 64))",
            access: "write",
            canonical: ProtocolCanonicalDescriptor(
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
        var sameTreeFromAnotherHost = placed
        sameTreeFromAnotherHost.origin = try #require(URL(string: "https://another.example"))
        try await store.save(sameTreeFromAnotherHost)
        #expect(try await store.loadAll().count == 1)
        #expect(try await store.loadAll().first?.origin == sameTreeFromAnotherHost.origin)
        let second = NativePlacementRecord(
            origin: try #require(URL(string: "https://arbor.example")),
            configurationTree: "tr_accountconfiguration",
            tree: ProtocolTreeDescriptor(
                id: "tr_second",
                kind: "ordinary",
                root: "sha256:\(String(repeating: "b", count: 64))",
                access: "read",
                canonical: ProtocolCanonicalDescriptor(
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
        func descriptor(_ id: String, path: String) -> ProtocolTreeDescriptor {
            ProtocolTreeDescriptor(
                id: id,
                kind: "ordinary",
                root: "sha256:\(String(repeating: "d", count: 64))",
                access: "read",
                canonical: ProtocolCanonicalDescriptor(path: path, endpoint: "https://arbor.example"),
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
        let configuration = try #require(ArborRemoteLocator("https://arbor.example/~joe/todos;arbor-config"))
        #expect(configuration.configuration && configuration.path == "/~joe/todos")
        #expect(ArborRemoteLocator("arbor://arbor.example/;arbor-config").map { $0.configuration && $0.path == "/" } == true)
        // A percent-encoded `;` is a filename, not the parameter.
        let literal = try #require(ArborRemoteLocator("https://arbor.example/~joe/todos%3Barbor-config"))
        #expect(!literal.configuration && literal.path == "/~joe/todos;arbor-config")
        #expect(ArborRemoteLocator("file:///Users/joe") == nil)
        #expect(ArborRemoteLocator("~joe") == nil)
    }

    @Test("A visit sparsifies a complete snapshot to directories and Markdown")
    func visitSnapshotSparsification() throws {
        let markdown = try ProtocolObjectCodec.object(.file(Data("# Note\n".utf8)))
        let image = try ProtocolObjectCodec.object(.file(Data([0x89, 0x50, 0x4E, 0x47])))
        let nestedDirectory = try ProtocolObjectCodec.object(.directory([
            ProtocolDirectoryEntry(name: "photo.png", file: image.hash),
        ]))
        let root = try ProtocolObjectCodec.object(.directory([
            ProtocolDirectoryEntry(name: "assets", directory: nestedDirectory.hash),
            ProtocolDirectoryEntry(name: "cover.png", file: image.hash),
            ProtocolDirectoryEntry(name: "note.md", file: markdown.hash),
        ]))
        let complete = ProtocolSnapshot(root: root.hash, objects: [root, nestedDirectory, markdown, image])
        let sparse = try CanopyVisitSnapshot.sparsified(complete)
        #expect(Set(sparse.spine.objects.map(\.hash)) == [root.hash, nestedDirectory.hash, markdown.hash])
        let objects = try ProtocolObjectGraph.validate(sparse.spine, mode: .sparseFiles)
        #expect(objects[image.hash] == nil)
        guard case let .directory(rootEntries, _)? = objects[root.hash],
              case let .directory(nestedEntries, _)? = objects[nestedDirectory.hash] else {
            Issue.record("Sparse snapshot must retain both directories")
            return
        }
        #expect(rootEntries.first { $0.name == "cover.png" }?.file == image.hash)
        #expect(nestedEntries.first { $0.name == "photo.png" }?.file == image.hash)
        let replacement = try CanopyVisitSnapshot.replacement(complete, tree: "tr_visit", update: "up_visit", cursor: "up_visit")
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
            tree: ProtocolTreeDescriptor(
                id: "tr_legacy",
                kind: "ordinary",
                root: "sha256:\(String(repeating: "c", count: 64))",
                access: "write",
                canonical: ProtocolCanonicalDescriptor(path: "/~joe/legacy", endpoint: "https://arbor.example"),
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

    @Test("Placement records this build cannot read are dropped, not fatal")
    func unreadableNativePlacementsAreDropped() async throws {
        let root = FileManager.default.temporaryDirectory
            .appending(path: "ArborStaleNativePlacement-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let url = root.appending(path: "placement.json")
        let hash = "sha256:\(String(repeating: "c", count: 64))"
        let good: [String: Any] = [
            "version": 1, "origin": "https://arbor.example", "configurationTree": "tr_config",
            "tree": ["id": "tr_todos", "kind": "ordinary", "root": hash, "access": "write", "update": "5094", "conflicted": false,
                     "canonical": ["path": "/~joe/todos", "endpoint": "https://arbor.example"]],
            "osPath": "/tmp/todos",
        ]
        // A placed account configuration from before tree configurations.
        let stale: [String: Any] = [
            "version": 1, "origin": "https://arbor.example", "configurationTree": "tr_config",
            "tree": ["id": "tr_config", "kind": "account-configuration", "root": hash, "access": "write", "update": "5093", "conflicted": false],
        ]
        try JSONSerialization.data(withJSONObject: ["version": 2, "selectedTree": "tr_config", "placements": [stale, good]]).write(to: url)
        let store = NativePlacementStore(url: url)

        #expect(try await store.loadAll().map(\.tree.id) == ["tr_todos"])
        #expect(try await store.load()?.tree.id == "tr_todos")
        let record = try #require(try await store.load())
        try await store.save(record)
        #expect(try await store.loadAll() == [record])
    }

    @Test("The app opens the deterministic Home surface")
    func loadsHome() async {
        let model = CanopyAppModel()
        await model.load()
        #expect(model.node?.title == "Home")
        #expect(model.children.map(\.title) == ["Welcome", "Files", "People", "Offline item", "Provider diagnostic"])
        #expect(!model.canGoHome)
    }

    @Test("A document keeps its containing directory visible in the sidebar")
    func documentKeepsContainingDirectorySidebar() async {
        let model = CanopyAppModel()
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

        #expect(CanopySidebarPages.sorted(results, by: .alphabetical).map(\.title)
            == ["🌲 Alpha", "Beta", "Monthly", "Older"])
        #expect(CanopySidebarPages.sorted(results, by: .recent).map(\.title)
            == ["Beta", "🌲 Alpha", "Monthly", "Older"])
        #expect(CanopySidebarPages.sorted(results, by: .linkCount).map(\.title)
            == ["Older", "Monthly", "🌲 Alpha", "Beta"])
        let groups = CanopySidebarPages.recentGroups(results, now: now, calendar: calendar)
        #expect(groups.map(\.title) == ["Just now", "Yesterday", "In the last month", "Earlier"])
        #expect(groups.map { $0.results.map(\.title) }
            == [["Beta"], ["🌲 Alpha"], ["Monthly"], ["Older"]])
        let unknown = WorkspaceSearchResult(reference: WorkspaceReference(tree: tree, path: "/unknown"), title: "Unknown")
        let datedGroups = CanopySidebarPages.recentGroups(results + [unknown], now: now, calendar: calendar)
        #expect(datedGroups.last?.title == "Unknown date")
        #expect(datedGroups.last?.results == [unknown])
        #expect(datedGroups.first { $0.title == "Earlier" }?.results.map(\.title) == ["Older"])
        let linkGroups = CanopySidebarPages.linkCountGroups(results)
        #expect(linkGroups.map(\.title) == ["0 Links", "1 Link", "Multiple Links"])
        #expect(linkGroups.map { $0.results.map(\.title) }
            == [["Beta"], ["🌲 Alpha"], ["Older", "Monthly"]])
        #expect(linkGroups.map(\.showsBacklinkCounts) == [false, false, true])
        // Arrow keys walk pages in the order the sidebar draws them.
        #expect(CanopySidebarPages.displayOrder(results, by: .linkCount).map(\.title)
            == ["Beta", "🌲 Alpha", "Older", "Monthly"])
        #expect(CanopySidebarPages.displayOrder(results, by: .alphabetical) == CanopySidebarPages.sorted(results, by: .alphabetical))
        #expect(canopySidebarContextPath("/arbor-demo") == nil)
        #expect(canopySidebarContextPath("/March-Out-My-Work/arbor-demo")
            == "/March-Out-My-Work")
    }
    @Test("Recent groups use exclusive rolling boundaries across midnight and month changes")
    func recentGroupBoundaries() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try #require(TimeZone(secondsFromGMT: 0))
        let formatter = ISO8601DateFormatter()
        let now = try #require(formatter.date(from: "2026-03-02T00:30:00Z"))
        let timestamps = [
            "2026-03-02T00:31:00Z", // Clock skew stays in Just now.
            "2026-03-01T23:30:00Z", // Exactly one hour ago, across midnight.
            "2026-03-01T23:29:59Z",
            "2026-03-01T00:00:00Z",
            "2026-02-28T23:59:59Z",
            "2026-02-23T00:30:00Z", // Exactly seven days ago.
            "2026-02-23T00:29:59Z",
            "2026-02-02T00:30:00Z", // Exactly one calendar month ago.
            "2026-02-02T00:29:59Z",
        ]
        let results = try timestamps.enumerated().map { index, timestamp in
            WorkspaceSearchResult(
                reference: WorkspaceReference(tree: "tr_sample", path: "/page-\(index)"),
                title: String(index),
                modifiedAt: try #require(formatter.date(from: timestamp))
            )
        }
        let groups = CanopySidebarPages.recentGroups(results.reversed(), now: now, calendar: calendar)
        #expect(groups.map(\.title) == ["Just now", "Yesterday", "In the last week", "In the last month", "Earlier"])
        #expect(groups.map { $0.results.map(\.title) } == [["0", "1"], ["2", "3"], ["4", "5"], ["6", "7"], ["8"]])
        #expect(groups.flatMap(\.results).count == results.count)

        let noon = try #require(formatter.date(from: "2026-03-02T12:00:00Z"))
        let laterGroups = CanopySidebarPages.recentGroups(results, now: noon, calendar: calendar)
        #expect(laterGroups.first?.title == "Today")
        #expect(laterGroups.first?.results.map(\.title) == ["0"])
        #expect(CanopySidebarPages.recentGroups([], now: now, calendar: calendar).isEmpty)
    }

    @Test("Opening a page pushes a native page-frame path")
    func openingPushesPageFrame() async {
        let model = CanopyAppModel()
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
        let workspace = CanopyWorkspaceState(provider: provider)
        let model = CanopyAppModel(workspace: workspace)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 900, height: 700),
                              styleMask: [.titled, .resizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentViewController = NSHostingController(rootView: CanopyRootView(workspace: workspace, model: model))
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
        let model = CanopyAppModel()
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
        let workspace = CanopyWorkspaceState(provider: first)
        var treeUnavailable = false
        let model = CanopyAppModel(workspace: workspace, openNavigationTree: { tree in
            if treeUnavailable { throw ProtocolValidationError.invalidValue("Unavailable tree") }
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
        window.contentViewController = NSHostingController(rootView: CanopyRootView(workspace: workspace, model: model))
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
        let workspace = CanopyWorkspaceState(provider: .sample())
        let model = CanopyAppModel(workspace: workspace, openNavigationTree: { _ in
            throw ProtocolValidationError.invalidValue("Unavailable tree")
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
        let model = CanopyAppModel(workspace: CanopyWorkspaceState(provider: provider))
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
        let model = CanopyAppModel()
        await model.load()
        await model.navigate(to: .init(tree: "tr_sample", path: "/files"))

        #expect(model.sidebarLocation.path == "/files")
        #expect(model.children.map(\.title) == ["arbor.png"])
    }

    @Test("Navigation exposes non-document surfaces without creating a document session")
    func navigatesToCollection() async {
        let model = CanopyAppModel()
        await model.load()
        await model.navigate(to: .init(tree: "tr_sample", path: "/people"))
        #expect(model.node?.title == "People")
        #expect(model.node?.isWritable == false)
        #expect(model.canGoBack)
    }

    @Test("Two windows share one PageID binding without sharing tabs")
    func windowsSharePersistenceNotPresentation() async throws {
        let workspace = CanopyWorkspaceState(provider: .sample())
        let first = CanopyAppModel(workspace: workspace)
        let second = CanopyAppModel(workspace: workspace)
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
        let workspace = CanopyWorkspaceState(provider: .sample())
        let model = CanopyAppModel(workspace: workspace)
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

    @Test("Child projections refresh after structural changes and returning to a retained page")
    func childProjectionsRefreshWithoutReplacingEditor() async throws {
        let root = WorkspaceNode(
            reference: WorkspaceReference(tree: "tr_sample", path: "/"),
            title: "Home",
            surface: .directoryDocument(source: "# Home\n", contentRevision: "r1", stored: true),
            provenance: .init(authority: .local, sourceDescription: "Test")
        )
        let workspace = CanopyWorkspaceState(provider: InMemoryWorkspaceProvider(nodes: [root]))
        let model = CanopyAppModel(workspace: workspace)
        await model.load()
        let binding = try #require(model.binding)
        let leaseID = try #require(model.editorLease).id
        let heading = try #require(binding.document.children.first)
        binding.document.transaction(name: "Type") {
            _ = binding.document.setText(heading.id, AttributedString("Local title"))
        }
        func links(_ blocks: [Block]) -> [String] {
            blocks.flatMap { block in
                let own: [String]
                if case let .documentLink(label, _) = block.kind {
                    own = [String(label.characters)]
                } else { own = [] }
                return own + links(block.children)
            }
        }

        await model.perform(.createMarkdown(parent: root.reference, name: "First", source: "# First\n"), navigateToResult: false)
        #expect(model.binding === binding)
        #expect(model.editorLease?.id == leaseID)
        #expect(links(binding.document.children) == ["First"])
        #expect(binding.document.title == "Local title")
        let first = try #require(model.children.first)
        await model.navigate(to: first.reference)
        await model.perform(.createMarkdown(parent: root.reference, name: "Second", source: "# Second\n"), navigateToResult: false)
        await model.goBack()
        #expect(model.binding === binding)
        #expect(model.editorLease?.id == leaseID)
        #expect(links(binding.document.children) == ["First", "Second"])
        #expect(binding.document.title == "Local title")

        await model.perform(.trash(reference: first.reference), navigateToResult: false)
        #expect(links(binding.document.children) == ["Second"])
        let snapshot = try await binding.snapshot()
        #expect(snapshot.source.contains("Local title"))
        #expect(!snapshot.source.contains("Second"))
    }

    @Test("Moving the open page reconciles browser history before reopening it")
    func movingOpenPageDoesNotLeaveAStaleBackEntry() async throws {
        let workspace = CanopyWorkspaceState(provider: .sample())
        let model = CanopyAppModel(workspace: workspace)
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

    @Test("New Page writes nothing until its title is set, then keeps its editor on the created page")
    func newPageCreatedFromTitle() async throws {
        let workspace = CanopyWorkspaceState(provider: .sample())
        let model = CanopyAppModel(workspace: workspace)
        await model.load()
        let welcome = WorkspaceReference(tree: "tr_sample", path: "/welcome", stableKey: markdownStableKey("pg_welcome"))
        await model.navigate(to: welcome)
        let before = try await workspace.provider.children(of: welcome)

        await model.newDraftPage()
        #expect(model.isShowingDraft)
        #expect(model.errorMessage == nil)
        let lease = try #require(model.editorLease)
        let binding = lease.binding
        let heading = try #require(binding.document.children.first)
        await model.createDraftPageIfTitled()
        #expect(model.isShowingDraft)
        #expect(try await workspace.provider.children(of: welcome) == before)

        binding.document.transaction(name: "Type") { _ = binding.document.setText(heading.id, AttributedString("Draft Plans")) }
        await binding.flush()
        #expect(try await workspace.provider.children(of: welcome) == before)

        await model.createDraftPageIfTitled()
        #expect(model.errorMessage == nil)
        #expect(!model.isShowingDraft)
        #expect(model.editorLease?.id == lease.id)
        #expect(model.binding === binding)
        #expect(binding.reference.path == "/welcome/Draft-Plans")
        #expect(model.currentReference.path == "/welcome/Draft-Plans")
        #expect(model.children.contains { $0.reference.path == "/welcome/Draft-Plans" })

        binding.document.transaction(name: "Type") { _ = binding.document.setText(heading.id, AttributedString("Draft Plans for June")) }
        await binding.flush()
        let created = try await workspace.provider.resolve(binding.reference)
        guard case let .markdown(source, _) = created.surface else {
            Issue.record("The created page is \(created.surface)")
            return
        }
        #expect(source.contains("# Draft Plans for June"))

        await model.goBack()
        #expect(model.currentReference.identity == welcome.identity)
        await model.goForward()
        #expect(model.errorMessage == nil)
        #expect(model.currentReference.path == "/welcome/Draft-Plans")
    }

    @Test("An untitled new page is discarded with its history entry once it is released")
    func untitledNewPageDiscarded() async throws {
        let workspace = CanopyWorkspaceState(provider: .sample())
        let model = CanopyAppModel(workspace: workspace)
        await model.load()
        let welcome = WorkspaceReference(tree: "tr_sample", path: "/welcome", stableKey: markdownStableKey("pg_welcome"))
        await model.navigate(to: welcome)
        let root = WorkspaceReference(tree: "tr_sample", path: "/")
        let before = try await workspace.provider.children(of: welcome)

        await model.newDraftPage()
        let draftLocation = model.currentLocation
        #expect(model.isShowingDraft)
        await model.goBack()
        #expect(!model.isShowingDraft)
        await model.goForward()
        #expect(model.isShowingDraft)
        #expect(model.errorMessage == nil)

        await model.goBack()
        await model.navigate(to: root)
        #expect(!model.tabs.selectedTab.back.contains(draftLocation))
        #expect(!model.tabs.selectedTab.forward.contains(draftLocation))
        #expect(try await workspace.provider.children(of: welcome) == before)
        #expect(model.errorMessage == nil)
    }

    @Test("Linked-page trash confirmation rechecks backlinks and preserves the editor lease")
    func linkedPageTrashConfirmation() async throws {
        let workspace = CanopyWorkspaceState(provider: .sample())
        let model = CanopyAppModel(workspace: workspace)
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
            parent: source,
            name: "Orphan",
            source: "# Orphan\n"
        )))

        model.offerToTrashLinkedPage(orphan, from: source)
        #expect(model.linkedPageTrashPrompt?.target == orphan.reference)
        await model.trashPromptedLinkedPageIfStillOrphaned()

        #expect(model.linkedPageTrashPrompt == nil)
        #expect(model.editorLease?.id == lease.id)
        // Trashing preserves the original parent path beneath /Trash.
        let trashedOrphan = try await workspace.provider.resolve(orphan.reference)
        #expect(trashedOrphan.reference.path == "/Trash/welcome/Orphan")

        let retained = try #require(try await workspace.perform(.createMarkdown(
            parent: source,
            name: "Retained",
            source: "# Retained\n"
        )))
        model.offerToTrashLinkedPage(retained, from: source)
        _ = try #require(try await workspace.perform(.createMarkdown(
            parent: root,
            name: "Other",
            source: "# Other\n\n[Retained](/welcome/Retained)\n"
        )))
        await model.trashPromptedLinkedPageIfStillOrphaned()

        #expect(try await workspace.provider.resolve(retained.reference).reference.path == "/welcome/Retained")
        #expect(model.editorLease?.id == lease.id)

        let elsewhere = try #require(try await workspace.perform(.createMarkdown(
            parent: root, name: "Elsewhere", source: "# Elsewhere\n"
        )))
        // Even a stale offer cannot trash a page still implicitly linked by another parent.
        model.offerToTrashLinkedPage(elsewhere, from: source)
        await model.trashPromptedLinkedPageIfStillOrphaned()
        #expect(try await workspace.provider.resolve(elsewhere.reference).reference.path == "/Elsewhere")
    }

    @Test("Empty search starts as a page browser")
    func emptySearchListsPages() async throws {
        let workspace = CanopyWorkspaceState(provider: .sample())
        let model = CanopyAppModel(workspace: workspace)

        await model.search("")

        #expect(model.searchResults.contains { $0.reference.path == "/welcome" })
    }

    @Test("Retained editor changes update Recent and filtered titles without searching the provider")
    func editorRetentionUpdatesSidebar() async throws {
        let provider = SidebarCountingProvider()
        let workspace = CanopyWorkspaceState(provider: .sample())
        await workspace.switchProvider(provider, home: .init(tree: "tr_sample", path: "/"), detail: "counting")
        let model = CanopyAppModel(workspace: workspace)
        await model.navigate(to: .init(tree: "tr_sample", path: "/welcome", stableKey: markdownStableKey("pg_welcome")))
        await model.search("Updated")
        let binding = try #require(model.binding)
        let host = try #require(model.editorHost)
        let heading = try #require(binding.document.children.first)
        let count = await provider.searchCount
        for title in ["Updated once", "Updated twice"] {
            binding.document.transaction(name: "Rename heading") {
                _ = binding.document.setText(heading.id, AttributedString(title))
            }
            host.persistCommit(changes: [], in: binding.document)
            await binding.flush()
            for _ in 0..<200 where model.searchResults.first?.title != title {
                try await Task.sleep(for: .milliseconds(1))
            }
            let row = try #require(model.searchResults.first)
            #expect(row.title == title)
            #expect(row.reference.identity == binding.reference.identity)
            #expect(CanopySidebarPages.recentGroups(model.searchResults).first?.title == "Just now")
            #expect(await provider.searchCount == count)
        }
        // A full refresh may still return the pre-edit index.
        await model.load()
        await model.search("Updated")
        #expect(model.searchResults.first?.title == "Updated twice")

        await workspace.switchProvider(InMemoryWorkspaceProvider.sample(),
            home: .init(tree: "tr_sample", path: "/"), detail: "replacement")
        await model.resetForWorkspace()
        await model.search("Updated")
        #expect(model.searchResults.isEmpty)
    }

    @Test("Sidebar retention survives stale indexes, follows stable identities, and retires when caught up")
    func sidebarRetentionReconciliation() throws {
        let reference = WorkspaceReference(tree: "tr_sidebar", path: "/old", stableKey: markdownStableKey("pg_note"))
        let now = Date()
        let change = CanopyLocalRetention(reference: reference, title: "Edited", source: "# Edited\n", retainedAt: now)
        var pending = CanopySidebarRetentions()
        pending.retain(change)
        let stale = WorkspaceSearchResult(reference: reference, title: "Old", excerpt: "# Old\n", modifiedAt: now.addingTimeInterval(-86_400))
        let patched = try #require(pending.applying(to: [stale], providerRefresh: true).first)
        #expect(patched.title == "Edited")
        #expect(patched.modifiedAt == now)
        var moved = stale
        moved.reference.path = "/renamed"
        pending.relocate(from: reference, to: moved.reference)
        #expect(pending.applying(to: [moved], providerRefresh: true).first?.reference.path == "/renamed")
        var otherTree = stale
        otherTree.reference.tree = "tr_other"
        #expect(pending.applying(to: [otherTree]) == [otherTree])
        #expect(pending.applying(to: [], providerRefresh: true).isEmpty)

        var caughtUp = patched
        caughtUp.modifiedAt = now.addingTimeInterval(1)
        #expect(pending.applying(to: [caughtUp], providerRefresh: true) == [caughtUp])
        var later = caughtUp
        later.title = "Remote edit"
        later.excerpt = "# Remote edit\n"
        #expect(pending.applying(to: [later], providerRefresh: true) == [later])

        pending.retain(change)
        #expect(pending.applying(to: [later], providerRefresh: true) == [later])

        pending.retain(change)
        pending.remove(moved.reference)
        #expect(pending.applying(to: [stale], providerRefresh: true) == [stale])
    }

    @Test("Full-text search does not replace the sidebar page results")
    func fullTextSearchIsIndependentFromSidebar() async throws {
        let workspace = CanopyWorkspaceState(provider: .sample())
        let model = CanopyAppModel(workspace: workspace)
        await model.search("")
        let sidebarIdentities = model.searchResults.map(\.id)

        let matches = await model.fullTextSearch("Native Canopy is ready")

        #expect(matches.contains { $0.reference.path == "/welcome" })
        #expect(model.searchResults.map(\.id) == sidebarIdentities)

        await model.search("Native Canopy is ready")
        #expect(!model.searchResults.contains { $0.reference.path == "/welcome" })
    }

    @Test("A final editor commit is durable before navigation completes")
    func navigationDrainsEditorTail() async throws {
        let workspace = CanopyWorkspaceState(provider: .sample())
        let model = CanopyAppModel(workspace: workspace)
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
        let workspace = CanopyWorkspaceState(provider: .sample())
        let model = CanopyAppModel(workspace: workspace)
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
        let workspace = CanopyWorkspaceState(provider: .sample())
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

    @Test("Account lookups by origin read the platform account service once and reuse its list")
    func accountLookupsUseTheAccountService() async throws {
        let service = RecordingAccountService(accounts: [
            CanopyAccount(
                configurationTree: "tr_cfg_a", origin: URL(string: "https://a.example"),
                handle: "a", profileTree: nil, deviceID: "dv_a", credentialAvailable: true
            ),
            CanopyAccount(
                configurationTree: "tr_cfg_b", origin: URL(string: "https://b.example"),
                handle: nil, profileTree: nil, deviceID: nil, credentialAvailable: false
            ),
        ])
        let workspace = CanopyWorkspaceState(provider: .sample(), accountService: service)
        let a = try #require(URL(string: "https://A.example/~a"))
        #expect(await workspace.connectedAccount(at: a)?.configurationTree == "tr_cfg_a")
        #expect(await service.listings == 1)
        // An account without its credential is not connected; the list is read again.
        #expect(await workspace.connectedAccount(at: try #require(URL(string: "https://b.example"))) == nil)
        #expect(await service.listings == 2)
        // A known account is found without reading the store.
        #expect(await workspace.connectedAccount(at: a)?.configurationTree == "tr_cfg_a")
        #expect(await service.listings == 2)
        #expect(workspace.knownAccounts.map(\.configurationTree) == ["tr_cfg_a", "tr_cfg_b"])
    }

    @Test("The iPhone account store reports what it cannot do instead of pretending")
    func keychainAccountServiceCapabilities() async throws {
        let service = KeychainAccountService()
        #expect(service.capabilities == [.forget, .connectPlacement])
        await #expect(throws: CanopyAccountServiceError.unsupported(.restoreIdentity)) {
            try await service.restoreIdentity(backup: Data(), passphrase: nil)
        }
        await #expect(throws: CanopyAccountServiceError.unsupported(.backupIdentity)) {
            try await service.backupIdentity(to: URL(fileURLWithPath: "/dev/null"), passphrase: "a passphrase")
        }
        await #expect(throws: CanopyAccountServiceError.unsupported(.resumePairing)) {
            try await service.resumePairing()
        }
    }

    @Test("A placement connection is presented by its host and keyed as the data home keys it")
    func placementPresentation() {
        let placement = CanopyPlacement(NativePlacementAccount(
            configurationTree: "tr_config", origin: "https://place.example", account: "https://place.example/~joe",
            accountID: "tr_profile", handle: "joe", profileTree: "tr_profile",
            homeHost: "https://home.example", placementRoot: "tr_root"
        ))
        #expect(placement.hostName == "place.example")
        #expect(placement.homeHostName == "home.example")
        #expect(CanopyPlacement.hostName("http://127.0.0.1:47102") == "127.0.0.1:47102")
        #expect(placement.handle == "joe")
        #expect(placement.id == "tr_config/" + NativePlacementAccount.directoryName(origin: "https://place.example"))
        #expect(CanopyAccountServiceError.unsupported(.connectPlacement).errorDescription?.contains("another host") == true)
    }

    @Test("A placement host's refusals name the home host")
    func placementErrorsNameHomeHost() {
        let refused = ProtocolHTTPError(status: 403, code: "permission-denied", message: "Pairing is the home host's", retryable: false, homeHost: "https://home.example")
        #expect(refused.localizedDescription.contains("home.example"))
        let stale = ProtocolHTTPError(status: 503, code: "internal-error", message: "home unreachable", retryable: true, homeHost: "https://home.example")
        #expect(stale.localizedDescription.contains("home.example"))
        #expect(NativePlacementError.notReserved(host: "https://place.example", account: "https://home.example/~joe").localizedDescription.contains("reserve https://home.example/~joe"))
#if os(macOS)
        #expect(ArborSyncPlacementUnavailable(host: "https://place.example").localizedDescription.contains("arbor place"))
#endif
    }

    private static let orchard = CanopyPlacement(NativePlacementAccount(
        configurationTree: "tr_config", origin: "https://orchard.example", account: "https://orchard.example/~joe",
        accountID: "tr_profile", handle: "joe", profileTree: "tr_profile",
        homeHost: "https://garden.example", placementRoot: "tr_root"
    ))

    @Test("A new tree on a placement account is declared on that host, below its placement root")
    func newTreeDestinationOnPlacementHost() throws {
        let destination = CanopyShareAccount(placement: Self.orchard)
        #expect(destination.id == Self.orchard.id)
        #expect(destination.id != "tr_config")
        #expect(destination.destinationLabel == "~joe · orchard.example")
        #expect(destination.accountURL == "https://orchard.example/~joe")

        let research = try destination.newTreeDestination(canonical: "https://orchard.example/~joe/research")
        #expect(research.origin == URL(string: "https://orchard.example"))
        #expect(research.host == "https://orchard.example")
        #expect(research.segments == ["~joe", "research"])
        #expect(research.placementRoot == nil)

        // The placement root's own URL activates the root the claim declared.
        let root = try destination.newTreeDestination(canonical: "https://orchard.example/~joe/")
        #expect(root.placementRoot == "tr_root")
        #expect(root.host == "https://orchard.example")

        // Nowhere else on that host, and never on another host.
        #expect(throws: ProtocolValidationError.self) { try destination.newTreeDestination(canonical: "https://orchard.example/~ann/notes") }
        #expect(throws: ProtocolValidationError.self) { try destination.newTreeDestination(canonical: "https://orchard.example/~joey") }
        #expect(throws: ProtocolValidationError.self) { try destination.newTreeDestination(canonical: "https://garden.example/~joe/research") }
    }

    @Test("A new tree at the home host names no placement host")
    func newTreeDestinationAtHome() throws {
        let home = CanopyShareAccount(configurationTree: "tr_config", origin: "https://garden.example", handle: "joe")
        #expect(home.id == "tr_config")
        #expect(home.destinationLabel == "~joe · garden.example")
        #expect(home.accountURL == "https://garden.example/~joe")
        let notes = try home.newTreeDestination(canonical: "https://garden.example/~joe/notes")
        #expect(notes.host == nil)
        #expect(notes.placementRoot == nil)
        #expect(notes.segments == ["~joe", "notes"])
        #expect(throws: ProtocolValidationError.self) { try home.newTreeDestination(canonical: "https://orchard.example/~joe/notes") }
        #expect(throws: ProtocolValidationError.self) { try home.newTreeDestination(canonical: "https://garden.example/") }
        #expect(throws: ProtocolValidationError.self) { try home.newTreeDestination(canonical: "https://garden.example/~joe/notes?x=1") }
    }

    @Test("A tree's session is its placement host's when its canonical endpoint is not the home host")
    func placementOriginForTreeSessions() {
        #expect(CanopyWorkspaceState.placementOrigin(endpoint: "https://orchard.example", home: "https://garden.example") == "https://orchard.example")
        #expect(CanopyWorkspaceState.placementOrigin(endpoint: "https://Garden.example", home: "https://garden.example") == nil)
        #expect(CanopyWorkspaceState.placementOrigin(endpoint: "http://127.0.0.1:4001", home: "http://127.0.0.1:4000") == "http://127.0.0.1:4001")
        #expect(CanopyWorkspaceState.placementOrigin(endpoint: nil, home: "https://garden.example") == nil)
        #expect(CanopyWorkspaceState.placementOrigin(endpoint: "https://orchard.example", home: nil) == nil)
    }

    @Test("A host with no home account is reached through the placement connection there")
    func connectedPlacementByOrigin() async throws {
        let service = RecordingAccountService(accounts: [
            CanopyAccount(
                configurationTree: "tr_config", origin: URL(string: "https://garden.example"),
                handle: "joe", profileTree: "tr_profile", deviceID: "dv_mac", credentialAvailable: true
            ),
        ], placements: [Self.orchard])
        let workspace = CanopyWorkspaceState(provider: .sample(), accountService: service)
        let placement = await workspace.connectedPlacement(at: try #require(URL(string: "https://orchard.example/~joe/research")))
        #expect(placement == Self.orchard)
        // The home host is the home account's, never a placement's.
        #expect(await workspace.connectedPlacement(at: try #require(URL(string: "https://garden.example"))) == nil)
        #expect(await workspace.connectedPlacement(at: try #require(URL(string: "https://elsewhere.example"))) == nil)
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
        let workspace = CanopyWorkspaceState()
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

/// An account store that serves a fixed list and counts how often it is read.
private actor RecordingAccountService: CanopyAccountService {
    private let fixed: [CanopyAccount]
    private let fixedPlacements: [CanopyPlacement]
    private(set) var listings = 0

    init(accounts: [CanopyAccount], placements: [CanopyPlacement] = []) {
        fixed = accounts
        fixedPlacements = placements
    }

    nonisolated var capabilities: Set<CanopyAccountCapability> { [] }
    func state() -> CanopyAccountState {
        CanopyAccountState(accounts: fixed, identity: nil, pendingClaim: nil, pendingPairingOrigin: nil)
    }
    func accounts() -> [CanopyAccount] {
        listings += 1
        return fixed
    }
    func credentialProvider(configurationTree: String) throws -> any ProtocolCredentialProvider {
        throw CanopyAccountServiceError.invalidAccount("No credential in the test store")
    }
    func credentialProvider(configurationTree _: String, placementOrigin _: String) throws -> any ProtocolCredentialProvider {
        throw CanopyAccountServiceError.invalidAccount("No placement credential in the test store")
    }
    func createIdentity() {}
    func restoreIdentity(backup _: Data, passphrase _: String?) throws { throw CanopyAccountServiceError.unsupported(.restoreIdentity) }
    func backupIdentity(to _: URL, passphrase _: String) throws { throw CanopyAccountServiceError.unsupported(.backupIdentity) }
    func claimAccount(_: String, deviceLabel _: String, inviteCode _: String?) {}
    func cancelPendingClaim() throws { throw CanopyAccountServiceError.unsupported(.cancelPendingClaim) }
    func claimPairing(_: Data, deviceLabel _: String) -> CanopyPairingClaim {
        CanopyPairingClaim(configurationTree: nil, confirmationCode: nil)
    }
    func resumePairing() throws { throw CanopyAccountServiceError.unsupported(.resumePairing) }
    func forget(origin _: URL, configurationTree _: String?) throws { throw CanopyAccountServiceError.unsupported(.forget) }
    func placements(configurationTree: String) -> [CanopyPlacement] {
        fixedPlacements.filter { $0.configurationTree == configurationTree }
    }
    func connectPlacement(configurationTree _: String, host _: String) throws {
        throw CanopyAccountServiceError.unsupported(.connectPlacement)
    }
    func forgetPlacement(_: CanopyPlacement) {}
}

/// Its search snapshot deliberately lags writes through the document session.
private actor SidebarCountingProvider: WorkspaceProvider {
    private let base = InMemoryWorkspaceProvider.sample()
    private var initialResults: [WorkspaceSearchResult]?
    private(set) var searchCount = 0

    func resolve(_ reference: WorkspaceReference) async throws -> WorkspaceNode { try await base.resolve(reference) }
    func children(of reference: WorkspaceReference) async throws -> [WorkspaceNode] { try await base.children(of: reference) }
    func search(_ query: String, in tree: TreeID) async throws -> [WorkspaceSearchResult] {
        searchCount += 1
        if initialResults == nil { initialResults = try await base.search("", in: tree) }
        return initialResults ?? []
    }
    func backlinks(to reference: WorkspaceReference) async throws -> [WorkspaceSearchResult] { try await base.backlinks(to: reference) }
    func perform(_ action: WorkspaceStructuralAction) async throws -> WorkspaceNode? { try await base.perform(action) }
    func store(asset: WorkspaceAsset, in parent: WorkspaceReference) async throws -> WorkspaceStoredAsset { try await base.store(asset: asset, in: parent) }
    func readFile(_ reference: WorkspaceReference) async throws -> Data { try await base.readFile(reference) }
    func openDocument(_ reference: WorkspaceReference) async throws -> any WorkspaceDocumentSession { try await base.openDocument(reference) }
}
