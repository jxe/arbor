import ArborClient
import ArborKit
import ArborProviders
import ArborQuagmire
import ArborReplica
import ArborSync
import ArborWire
import Foundation
import Observation
import QuagmireExtras

#if os(macOS)
struct LocalArbordTreePresentation: Identifiable, Sendable, Equatable {
    let id: String
    let name: String
    let canonicalPath: String?
    let path: String?
    let access: String?
    let sync: String?
}

struct LocalArbordAccountPresentation: Sendable, Equatable {
    let origin: String
    let handle: String
    let credentialAvailable: Bool
    let trees: [LocalArbordTreePresentation]
    let devices: [AuthorityDevice]
}

struct LocalArbordPairingPresentation: Sendable, Equatable {
    let payload: String
    let confirmationCode: String
}
#endif

@MainActor
@Observable
final class ArborWorkspaceState {
    private(set) var provider: any WorkspaceProvider
    private(set) var editorWorkspace: ArborEditorWorkspace
    private(set) var home: WorkspaceReference
    private(set) var generation = 0
    private(set) var capabilities: WorkspaceProviderCapabilities = .full
    private(set) var providerDetail = "In-memory sample"
    private(set) var syncPresentation = WorkspaceSyncPresentation(
        state: .offline,
        detail: "Local sample workspace; no authority configured"
    )
    private(set) var syncConflict: ReplicaConflictPresentation?
    let linkPreviewService: LinkPreviewService
    var errorMessage: String?

    private var syncCoordinator: ReplicaSyncCoordinator?
    private var authorityWatchTask: Task<Void, Never>?
#if os(macOS)
    private var supervisor: ArbordProcessSupervisor?
    private var arbordClient: ArborClient?
    private let bookmarks = SecurityScopedWorkspaceBookmarkStore()
    private var attemptedWorkspaceRestore = false
#endif
#if os(iOS)
    private let nativePlacementStore = NativePlacementStore()
#endif

    init(provider: InMemoryWorkspaceProvider = .sample()) {
        self.linkPreviewService = LinkPreviewService(
            cacheDirectory: ArborSupportDirectories.linkPreviews
        )
        self.provider = provider
        self.editorWorkspace = ArborEditorWorkspace(provider: provider)
        self.home = WorkspaceReference(tree: "tr_sample", path: "/")
    }

    func place(tree: AuthorityTreeDescriptor, from origin: URL, remember: Bool = true) async throws {
        _ = try tree.validated()
        authorityWatchTask?.cancel()
        authorityWatchTask = nil
        let credentialProvider = StoredDeviceCredentialProvider(
            origin: origin,
            store: KeychainDeviceCredentialStore()
        )
        let client = ArborAuthorityClient(origin: origin, credentialProvider: credentialProvider)
        let transport = ArborWireReplicaTransport(client: client)
        let root = ArborSupportDirectories.root
        let key = tree.id.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? UUID().uuidString
        let replicaRoot = root.appending(path: "Replicas/\(key)", directoryHint: .isDirectory)
        let replica: ArborReplica
        if FileManager.default.fileExists(atPath: replicaRoot.appending(path: "materialized/tree.json").path) {
            replica = try await ArborReplica.open(at: replicaRoot, tree: TreeID(rawValue: tree.id))
        } else {
            replica = try await ReplicaPlacementService.place(tree: tree, at: replicaRoot, transport: transport)
        }
        let coordinator = try ReplicaSyncCoordinator(
            replica: replica,
            transport: transport,
            stateRoot: root.appending(path: "Sync/\(key)", directoryHint: .isDirectory)
        )
#if os(macOS)
        if let supervisor { await supervisor.stop(); self.supervisor = nil }
        arbordClient = nil
#endif
        let nextProvider = ReplicaWorkspaceProvider(replica: replica) { [weak self] admission in
            await coordinator.syncImmediately(admission)
            await self?.refreshSyncPresentation(from: coordinator)
        }
#if os(iOS)
        if remember {
            try await nativePlacementStore.save(NativePlacementRecord(origin: origin, tree: tree))
        }
#endif
        await switchProvider(
            nextProvider,
            home: WorkspaceReference(tree: TreeID(rawValue: tree.id), path: "/"),
            detail: "Offline replica · \(tree.canonicalPath)"
        )
        syncCoordinator = coordinator
        syncPresentation = try await coordinator.presentation()
        syncConflict = try await coordinator.conflict()
        startAuthorityWatch(client: client, tree: tree, coordinator: coordinator)
    }

#if os(iOS)
    func restoreNativePlacementIfAvailable() async -> Bool {
        do {
            guard let record = try await nativePlacementStore.load() else { return false }
            try await place(tree: record.tree, from: record.origin, remember: false)
            return true
        } catch {
            errorMessage = "The saved iPhone workspace could not be reopened: \(error.localizedDescription)"
            return false
        }
    }

    func nativePlacement() async throws -> NativePlacementRecord? {
        try await nativePlacementStore.load()
    }

    func disconnectNativeAccount() async throws {
        guard let placement = try await nativePlacementStore.load() else { return }
        try await NativeAccountService(origin: placement.origin).forget()
        try await nativePlacementStore.clear()
        authorityWatchTask?.cancel()
        authorityWatchTask = nil
        if let syncCoordinator { await syncCoordinator.close() }
        syncCoordinator = nil
        syncConflict = nil
        await editorWorkspace.closeAll()
    }
#endif

#if os(macOS)
    func openLocalWorkspace(_ url: URL, remember: Bool = true) async throws {
        try await editorWorkspace.flushAll()
        await editorWorkspace.closeAll()
        authorityWatchTask?.cancel()
        authorityWatchTask = nil
        if let supervisor { await supervisor.stop() }
        let launchPolicy: ArbordLaunchPolicy = ProcessInfo.processInfo.environment["ARBOR_TEST_SANDBOX_HELPER"] == "1"
            ? .automatic
            : .attachOnly
        let nextSupervisor = ArbordProcessSupervisor(launchPolicy: launchPolicy)
        do {
            let runtime = try await nextSupervisor.start(workspace: url)
            supervisor = nextSupervisor
            arbordClient = ArborClient(baseURL: runtime.origin)
            syncCoordinator = nil
            syncConflict = nil
            if remember { try await bookmarks.save(url) }
            await switchProvider(
                runtime.provider,
                home: runtime.home,
                detail: runtime.attachedToExistingProcess ? "User arbord · ~/.arbor" : "Local arbord · supervised test helper"
            )
            syncPresentation = WorkspaceSyncPresentation(
                state: .current,
                detail: "All macOS writes are owned by arbord"
            )
        } catch {
            await nextSupervisor.stop()
            supervisor = nil
            arbordClient = nil
            throw error
        }
    }

    func restoreLocalWorkspaceIfAvailable() async {
        guard !attemptedWorkspaceRestore else { return }
        attemptedWorkspaceRestore = true
        do {
            guard let url = try await bookmarks.load() else { return }
            try await openLocalWorkspace(url, remember: false)
        } catch {
            errorMessage = "The saved workspace could not be reopened: \(error.localizedDescription)"
        }
    }

    func restartArbord() async {
        guard let supervisor else { return }
        do {
            try await editorWorkspace.flushAll()
            await editorWorkspace.closeAll()
            let runtime = try await supervisor.restart()
            arbordClient = ArborClient(baseURL: runtime.origin)
            await switchProvider(runtime.provider, home: runtime.home, detail: "User arbord · ~/.arbor")
            syncPresentation = WorkspaceSyncPresentation(state: .current, detail: "Reconnected to the user arbord")
        } catch {
            errorMessage = error.localizedDescription
            syncPresentation = WorkspaceSyncPresentation(state: .offline, detail: error.localizedDescription)
        }
    }

    func arbordLogs() async -> String {
        await supervisor?.logs() ?? "This app does not supervise the user arbord. Its output is in the terminal where arbor browse is running."
    }

    func localArbordAccount() async throws -> LocalArbordAccountPresentation {
        guard let client = arbordClient else { throw ArbordSupervisorError.serviceUnavailable }
        let community = try await client.node(.path("/community", tree: "system"))
        guard let frontmatter = community.document?.frontmatter,
              frontmatter.bool("connected") == true,
              let origin = frontmatter.string("origin"),
              let handle = frontmatter.string("handle") else {
            throw ArbordSupervisorError.incompatibleService("The user arbord is not connected to a community")
        }
        let directory = try await client.node(.path("/trees", tree: "system"))
        var trees: [LocalArbordTreePresentation] = []
        for child in directory.children ?? [] {
            let node = try await client.node(.path(child.path, tree: "system"))
            guard let values = node.document?.frontmatter, let id = values.string("id") else { continue }
            trees.append(LocalArbordTreePresentation(
                id: id,
                name: values.string("name") ?? node.name,
                canonicalPath: values.string("canonicalPath"),
                path: values.string("path"),
                access: values.string("access"),
                sync: values.string("sync")
            ))
        }
        return LocalArbordAccountPresentation(
            origin: origin,
            handle: handle,
            credentialAvailable: frontmatter.bool("credentialAvailable") == true,
            trees: trees.sorted { ($0.canonicalPath ?? $0.name) < ($1.canonicalPath ?? $1.name) },
            devices: try await client.communityDevices()
        )
    }

    func createLocalArbordPairing() async throws -> LocalArbordPairingPresentation {
        guard let client = arbordClient else { throw ArbordSupervisorError.serviceUnavailable }
        let account = try await localArbordAccount()
        guard let origin = URL(string: account.origin) else {
            throw ArbordSupervisorError.incompatibleService("The community origin is invalid")
        }
        let rawOffer = try await client.createCommunityPairing()
        let offer = try rawOffer.validated()
        let payload = PairingPayload(
            origin: origin,
            pairing: .init(id: offer.id, secret: offer.secret)
        )
        let data = try JSONEncoder().encode(payload)
        return LocalArbordPairingPresentation(
            payload: String(decoding: data, as: UTF8.self),
            confirmationCode: offer.confirmationCode
        )
    }

    func revokeLocalArbordDevice(_ id: String) async throws {
        guard let client = arbordClient else { throw ArbordSupervisorError.serviceUnavailable }
        _ = try await client.revokeCommunityDevice(id)
    }
#endif

    func syncNow() async {
        guard let syncCoordinator else { return }
        do {
            syncPresentation = try await syncCoordinator.syncOnce()
            syncConflict = try await syncCoordinator.conflict()
        }
        catch {
            syncPresentation = (try? await syncCoordinator.presentation())
                ?? WorkspaceSyncPresentation(state: .offline, detail: String(describing: error))
            errorMessage = error.localizedDescription
        }
    }

    private func refreshSyncPresentation(from coordinator: ReplicaSyncCoordinator) async {
        guard syncCoordinator === coordinator else { return }
        syncPresentation = (try? await coordinator.presentation())
            ?? WorkspaceSyncPresentation(state: .offline, detail: "Immediate synchronization failed")
        syncConflict = try? await coordinator.conflict()
    }

    func resolveSyncConflictKeepingLocal() async {
        guard let syncCoordinator else { return }
        do {
            try await syncCoordinator.resolveConflictKeepingLocal()
            syncConflict = nil
            syncPresentation = try await syncCoordinator.syncOnce()
            syncConflict = try await syncCoordinator.conflict()
        } catch {
            errorMessage = error.localizedDescription
            syncPresentation = (try? await syncCoordinator.presentation())
                ?? WorkspaceSyncPresentation(state: .offline, detail: error.localizedDescription)
        }
    }

    func flush() async {
        do { try await editorWorkspace.flushAll() }
        catch { errorMessage = "Saving did not finish: \(error.localizedDescription)" }
    }

    func deliverVoiceTranscript(_ transcript: String, to pageID: PageID) async throws {
        try await editorWorkspace.appendTranscript(
            transcript,
            to: pageID,
            in: home.tree
        )
    }

    func shutdown() async {
        await flush()
        await editorWorkspace.closeAll()
        authorityWatchTask?.cancel()
        authorityWatchTask = nil
#if os(macOS)
        if let supervisor { await supervisor.stop() }
        arbordClient = nil
#endif
    }

    private func switchProvider(
        _ nextProvider: any WorkspaceProvider,
        home nextHome: WorkspaceReference,
        detail: String
    ) async {
        await editorWorkspace.closeAll()
        provider = nextProvider
        editorWorkspace = ArborEditorWorkspace(provider: nextProvider)
        home = nextHome
        providerDetail = detail
        capabilities = await nextProvider.capabilities()
        generation += 1
        errorMessage = nil
    }

    private func startAuthorityWatch(
        client: ArborAuthorityClient,
        tree: AuthorityTreeDescriptor,
        coordinator: ReplicaSyncCoordinator
    ) {
        authorityWatchTask = Task { [weak self] in
            var lastEventID = try? await coordinator.watchCursor()
            var reconnectAttempt = 0
            while !Task.isCancelled {
                do {
                    let events = try await client.watch(tree: tree.id, lastEventID: lastEventID)
                    reconnectAttempt = 0
                    for try await event in events {
                        try Task.checkCancellation()
                        lastEventID = event.id
                        guard event.tree.id == tree.id else { continue }
                        _ = try await coordinator.observe(event)
                        await self?.refreshSyncPresentation(from: coordinator)
                    }
                } catch is CancellationError {
                    return
                } catch {
                    reconnectAttempt += 1
                }
                do {
                    let delay = min(5_000, 250 * (1 << min(reconnectAttempt, 5)))
                    try await Task.sleep(for: .milliseconds(delay))
                } catch {
                    return
                }
            }
        }
    }
}

#if os(macOS)
private extension Dictionary where Key == String, Value == JSONValue {
    func string(_ key: String) -> String? {
        guard case let .string(value)? = self[key] else { return nil }
        return value
    }

    func bool(_ key: String) -> Bool? {
        guard case let .bool(value)? = self[key] else { return nil }
        return value
    }
}
#endif

@MainActor
@Observable
final class ArborAppModel {
    struct TitleRenameProposal: Identifiable, Equatable {
        var reference: WorkspaceReference
        var title: String
        var proposedName: String
        var id: String { "\(reference.identity)|\(proposedName)" }
    }

    let workspace: ArborWorkspaceState
    private(set) var tabs: BrowserTabController
    private(set) var node: WorkspaceNode?
    private(set) var children: [WorkspaceNode] = []
    private(set) var sidebarReference: WorkspaceReference
    private(set) var errorMessage: String?
    private(set) var editorLease: ArborEditorLease?
    private(set) var editorHost: ArborEditorHost?
    private(set) var searchResults: [WorkspaceSearchResult] = []
    private(set) var backlinks: [WorkspaceSearchResult] = []
    private(set) var history: [WorkspaceHistoryEntry] = []
    private(set) var sourceSnapshot: WorkspaceDocumentSnapshot?
    private(set) var tabVersion = 0
    private(set) var isLoading = false
    private(set) var titleRenameProposal: TitleRenameProposal?
    private var observedWorkspaceGeneration: Int
    private var loadRequestID = 0
    private var searchRequestID = 0
    private var dismissedTitleRenameProposals = Set<String>()

    init(workspace: ArborWorkspaceState) {
        self.workspace = workspace
        self.tabs = BrowserTabController(home: workspace.home)
        self.sidebarReference = workspace.home
        self.observedWorkspaceGeneration = workspace.generation
    }

    convenience init() {
        self.init(workspace: ArborWorkspaceState())
    }

    var currentReference: WorkspaceReference { tabs.selectedTab.current }
    var canGoBack: Bool { tabs.canGoBack }
    var canGoForward: Bool { tabs.canGoForward }
    var canGoParent: Bool { tabs.canGoParent }
    var selectedTabID: UUID { tabs.selectedTabID }
    var tabItems: [BrowserTab] { tabs.tabs }
    var binding: ArborDocumentBinding? { editorLease?.binding }
    var navigationRoot: WorkspaceReference {
        _ = tabVersion
        return tabs.navigationRoot
    }
    var navigationPath: [WorkspaceReference] {
        _ = tabVersion
        return tabs.navigationPath
    }

    func resetForWorkspace() async {
        guard observedWorkspaceGeneration != workspace.generation else {
            if node == nil { await load() }
            return
        }
        observedWorkspaceGeneration = workspace.generation
        editorHost?.resolveMoveRequest(with: nil)
        editorHost?.resolveStructuralMoveRequest(with: nil)
        editorLease = nil
        editorHost = nil
        tabs = BrowserTabController(home: workspace.home)
        sidebarReference = workspace.home
        tabVersion += 1
        await load()
    }

    func load() async {
        loadRequestID += 1
        let requestID = loadRequestID
        isLoading = true
        if let editorLease {
            editorHost?.resolveMoveRequest(with: nil)
            editorHost?.resolveStructuralMoveRequest(with: nil)
            await workspace.editorWorkspace.release(editorLease)
            self.editorLease = nil
            editorHost = nil
        }
        do {
            let resolved = try await workspace.provider.resolve(currentReference)
            let sidebarBase: WorkspaceReference = switch resolved.surface {
            case .directory, .directoryDocument, .collection:
                resolved.reference
            default:
                resolved.reference.parent ?? workspace.home
            }
            let loadedChildren = try await workspace.provider.children(of: sidebarBase)
            guard requestID == loadRequestID, observedWorkspaceGeneration == workspace.generation else { return }
            node = resolved
            children = loadedChildren
            sidebarReference = sidebarBase
            if resolved.surface.supportsDocumentSession, resolved.isWritable {
                let lease = try await workspace.editorWorkspace.lease(resolved.reference)
                guard requestID == loadRequestID else {
                    await workspace.editorWorkspace.release(lease)
                    return
                }
                editorLease = lease
                editorHost = ArborEditorHost(
                    binding: lease.binding,
                    provider: workspace.provider,
                    linkPreviewService: workspace.linkPreviewService,
                    open: { [weak self] reference in Task { await self?.navigate(to: reference) } },
                    navigateBack: { [weak self] in Task { await self?.goBack() } },
                    reportError: { [weak self] message in self?.errorMessage = message }
                )
            }
            errorMessage = nil
            titleRenameProposal = nil
            isLoading = false
            Task { await self.loadBacklinks() }
        } catch {
            guard requestID == loadRequestID else { return }
            node = nil
            children = []
            sidebarReference = currentReference.parent ?? workspace.home
            errorMessage = error.localizedDescription
            isLoading = false
        }
    }

    func navigate(to reference: WorkspaceReference) async {
        tabs.navigate(to: reference)
        tabVersion += 1
        await load()
    }

    func goBack() async { tabs.goBack(); tabVersion += 1; await load() }
    func goForward() async { tabs.goForward(); tabVersion += 1; await load() }
    func goParent() async { tabs.goParent(); tabVersion += 1; await load() }
    func goHome() async { tabs.goHome(); tabVersion += 1; await load() }

    func setNavigationPath(_ path: [WorkspaceReference]) {
        guard path != tabs.navigationPath else { return }
        tabs.setNavigationPath(path)
        tabVersion += 1
        Task { await load() }
    }

    func newTab() async {
        tabs.newTab(at: currentReference)
        tabVersion += 1
        await load()
    }

    func openInNewTab(_ reference: WorkspaceReference) async {
        tabs.newTab(at: reference)
        tabVersion += 1
        await load()
    }

    func closeSelectedTab() async {
        tabs.closeTab(selectedTabID)
        tabVersion += 1
        await load()
    }

    func selectTab(_ id: UUID) async {
        guard id != selectedTabID else { return }
        tabs.selectTab(id)
        tabVersion += 1
        await load()
    }

    func search(_ query: String) async {
        searchRequestID += 1
        let requestID = searchRequestID
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            searchResults = []
            return
        }
        do {
            let results = try await workspace.provider.search(trimmed, in: currentReference.tree)
            guard requestID == searchRequestID else { return }
            searchResults = results
        }
        catch { errorMessage = error.localizedDescription }
    }

    func loadBacklinks() async {
        guard workspace.capabilities.backlinks else { backlinks = []; return }
        do { backlinks = try await workspace.provider.backlinks(to: currentReference) }
        catch { backlinks = [] }
    }

    func loadHistory() async {
        guard let binding else { history = []; return }
        do { history = try await binding.history() }
        catch { errorMessage = error.localizedDescription }
    }

    func inspectSource() async {
        guard let binding else { sourceSnapshot = nil; return }
        do { sourceSnapshot = try await binding.snapshot() }
        catch { errorMessage = error.localizedDescription }
    }

    func recover(_ revision: String) async -> Bool {
        guard let binding else { return false }
        do {
            sourceSnapshot = try await binding.recover(revision: revision)
            await load()
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    func dismissError() { errorMessage = nil }

    func resolveEditorConflict(preferSubmitted: Bool) async {
        guard let binding else { return }
        do {
            try await binding.resolveConflict(preferSubmitted: preferSubmitted)
            await load()
        } catch { errorMessage = error.localizedDescription }
    }

    func retryDocumentSave() async {
        await binding?.retryLastSave()
    }

    func evaluateTitleRenameProposal() async {
        guard let binding, let node, node.isWritable,
              binding.reference.pathHint != "/",
              binding.lastError == nil, binding.conflict == nil else {
            titleRenameProposal = nil
            return
        }
        let title = binding.acceptedTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        let currentName = binding.reference.pathHint.split(separator: "/").last.map(String.init) ?? ""
        guard !title.isEmpty, !WorkspaceTitleSlug.matches(name: currentName, title: title) else {
            titleRenameProposal = nil
            return
        }
        let parent = binding.reference.parent ?? WorkspaceReference(tree: binding.reference.tree, path: "/")
        let siblings = (try? await workspace.provider.children(of: parent)) ?? []
        let occupied = Set(siblings.compactMap { sibling -> String? in
            guard sibling.reference.identity != binding.reference.identity else { return nil }
            return sibling.reference.pathHint.split(separator: "/").last.map(String.init)?.lowercased()
        })
        let stem = WorkspaceTitleSlug.name(for: title)
        var proposed = stem
        var suffix = 2
        while occupied.contains(proposed.lowercased()) {
            proposed = "\(stem)-\(suffix)"
            suffix += 1
        }
        let proposal = TitleRenameProposal(reference: binding.reference, title: title, proposedName: proposed)
        guard !dismissedTitleRenameProposals.contains(proposal.id) else { return }
        titleRenameProposal = proposal
    }

    func dismissTitleRenameProposal() {
        if let proposal = titleRenameProposal { dismissedTitleRenameProposals.insert(proposal.id) }
        titleRenameProposal = nil
    }

    func acceptTitleRenameProposal() async {
        guard let proposal = titleRenameProposal, let binding,
              binding.reference.identity == proposal.reference.identity else { return }
        dismissTitleRenameProposal()
        await binding.flush()
        guard binding.lastError == nil, binding.conflict == nil else { return }
        do {
            guard let renamed = try await workspace.provider.perform(.rename(
                reference: binding.reference,
                name: proposal.proposedName
            )) else { return }
            binding.reconcileReference(renamed.reference)
            tabs.reconcileReference(renamed.reference)
            tabVersion += 1
            node = renamed
            sidebarReference = renamed.reference.parent ?? workspace.home
            children = try await workspace.provider.children(of: sidebarReference)
            searchResults = searchResults.map { result in
                guard result.reference.identity == renamed.reference.identity else { return result }
                return WorkspaceSearchResult(
                    reference: renamed.reference,
                    title: renamed.title,
                    excerpt: result.excerpt
                )
            }
            await loadBacklinks()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func perform(_ action: WorkspaceStructuralAction, navigateToResult: Bool = true) async {
        await workspace.flush()
        do {
            let result = try await workspace.provider.perform(action)
            if navigateToResult, let result { await navigate(to: result.reference) }
            else { await load() }
        } catch { errorMessage = error.localizedDescription }
    }

    func startVoiceRecording(_ session: VoiceRecordingSession<PageID>) async {
        guard let node, node.isWritable, let pageID = binding?.reference.pageID else {
            session.reportError("Open a writable Arbor page before starting a recording.")
            return
        }
        await session.start(destination: pageID)
    }

    func toggleVoiceRecordingFromShortcut(_ session: VoiceRecordingSession<PageID>) async {
        switch session.state {
        case .idle:
            do {
                let homeNode = try await workspace.provider.resolve(workspace.home)
                guard homeNode.isWritable,
                      homeNode.surface.supportsDocumentSession,
                      let pageID = homeNode.reference.pageID else {
                    session.reportError("The Home node must be a writable Arbor page before starting a Shortcut recording.")
                    return
                }
                await navigate(to: homeNode.reference)
                await session.start(destination: pageID)
            } catch {
                session.reportError("Arbor could not open Home for recording: \(error.localizedDescription)")
            }
        case .recording:
            await session.stopAndDeliver()
        case .transcribing:
            session.cancelTranscription()
        }
    }
}
