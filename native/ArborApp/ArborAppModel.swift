import ArborKit
import ArborProviders
import ArborQuagmire
import ArborReplica
import ArborSync
import ArborWire
import Foundation
import Observation

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
    var errorMessage: String?

    private var syncCoordinator: ReplicaSyncCoordinator?
#if os(macOS)
    private var supervisor: ArbordProcessSupervisor?
    private let bookmarks = SecurityScopedWorkspaceBookmarkStore()
    private var attemptedWorkspaceRestore = false
#endif

    init(provider: InMemoryWorkspaceProvider = .sample()) {
        self.provider = provider
        self.editorWorkspace = ArborEditorWorkspace(provider: provider)
        self.home = WorkspaceReference(tree: "tr_sample", path: "/")
    }

    func place(tree: AuthorityTreeDescriptor, from origin: URL) async throws {
        let credentialProvider = StoredDeviceCredentialProvider(
            origin: origin,
            store: KeychainDeviceCredentialStore()
        )
        let client = ArborAuthorityClient(origin: origin, credentialProvider: credentialProvider)
        let transport = ArborWireReplicaTransport(client: client)
        let root = try FileManager.default.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        ).appending(path: "Arbor", directoryHint: .isDirectory)
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
#endif
        let nextProvider = ReplicaWorkspaceProvider(replica: replica)
        await switchProvider(
            nextProvider,
            home: WorkspaceReference(tree: TreeID(rawValue: tree.id), path: "/"),
            detail: "Offline replica · \(tree.canonicalPath)"
        )
        syncCoordinator = coordinator
        syncPresentation = try await coordinator.presentation()
        syncConflict = try await coordinator.conflict()
    }

#if os(macOS)
    func openLocalWorkspace(_ url: URL, remember: Bool = true) async throws {
        try await editorWorkspace.flushAll()
        await editorWorkspace.closeAll()
        if let supervisor { await supervisor.stop() }
        let nextSupervisor = ArbordProcessSupervisor()
        do {
            let runtime = try await nextSupervisor.start(workspace: url)
            supervisor = nextSupervisor
            syncCoordinator = nil
            syncConflict = nil
            if remember { try await bookmarks.save(url) }
            await switchProvider(
                runtime.provider,
                home: runtime.home,
                detail: runtime.attachedToExistingProcess ? "Local arbord · attached" : "Local arbord · supervised"
            )
            syncPresentation = WorkspaceSyncPresentation(
                state: .current,
                detail: "All macOS writes are owned by arbord"
            )
        } catch {
            await nextSupervisor.stop()
            supervisor = nil
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
            await switchProvider(runtime.provider, home: runtime.home, detail: "Local arbord · restarted")
            syncPresentation = WorkspaceSyncPresentation(state: .current, detail: "arbord restarted and reconnected")
        } catch {
            errorMessage = error.localizedDescription
            syncPresentation = WorkspaceSyncPresentation(state: .offline, detail: error.localizedDescription)
        }
    }

    func arbordLogs() async -> String {
        await supervisor?.logs() ?? "No supervised arbord process"
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

    func shutdown() async {
        await flush()
        await editorWorkspace.closeAll()
#if os(macOS)
        if let supervisor { await supervisor.stop() }
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
}

@MainActor
@Observable
final class ArborAppModel {
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
    private var observedWorkspaceGeneration: Int
    private var loadRequestID = 0
    private var searchRequestID = 0

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

    func resetForWorkspace() async {
        guard observedWorkspaceGeneration != workspace.generation else {
            if node == nil { await load() }
            return
        }
        observedWorkspaceGeneration = workspace.generation
        editorHost?.resolveMoveRequest(with: nil)
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
        if let editorLease {
            editorHost?.resolveMoveRequest(with: nil)
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
                    open: { [weak self] reference in Task { await self?.navigate(to: reference) } },
                    navigateBack: { [weak self] in Task { await self?.goBack() } }
                )
            }
            errorMessage = nil
            Task { await self.loadBacklinks() }
        } catch {
            guard requestID == loadRequestID else { return }
            node = nil
            children = []
            sidebarReference = currentReference.parent ?? workspace.home
            errorMessage = error.localizedDescription
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

    func recover(_ revision: String) async {
        guard let binding else { return }
        do {
            sourceSnapshot = try await binding.recover(revision: revision)
            await load()
        } catch { errorMessage = error.localizedDescription }
    }

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

    func perform(_ action: WorkspaceStructuralAction, navigateToResult: Bool = true) async {
        await workspace.flush()
        do {
            let result = try await workspace.provider.perform(action)
            if navigateToResult, let result { await navigate(to: result.reference) }
            else { await load() }
        } catch { errorMessage = error.localizedDescription }
    }

    func importAsset(_ asset: WorkspaceAsset) async {
        do {
            _ = try await workspace.provider.store(asset: asset, in: currentReference)
            await load()
        } catch { errorMessage = error.localizedDescription }
    }
}
