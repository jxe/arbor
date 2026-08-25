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

struct LocalArbordVisitPresentation: Identifiable, Sendable, Equatable {
    let id: String
    let tree: String
    let name: String
    let locator: String
    let canonical: String?
    let visitedAt: String?
}

struct LocalArbordOverview: Sendable, Equatable {
    let origin: String?
    let handle: String?
    let credentialAvailable: Bool
    let trees: [LocalArbordTreePresentation]
    let visits: [LocalArbordVisitPresentation]
    let devices: [AuthorityDevice]
    let observedThrough: String
    let refreshedAt: Date
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
    private(set) var launchLocation: WorkspaceLocation
    private(set) var generation = 0
    private(set) var capabilities: WorkspaceProviderCapabilities = .readOnly
    private(set) var providerDetail = "No workspace open"
    private(set) var syncPresentation = WorkspaceSyncPresentation(
        state: .offline,
        detail: "Open a local workspace to start arbord"
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
    private var overviewRefreshTask: Task<Void, Never>?
    private var overviewWatchTask: Task<Void, Never>?
    private(set) var localArbordOverview: LocalArbordOverview?
    private(set) var localArbordOverviewIsRefreshing = false
    private(set) var localArbordOverviewError: String?
#endif
#if os(iOS)
    private let nativePlacementStore = NativePlacementStore()
#endif

    init(provider suppliedProvider: InMemoryWorkspaceProvider? = nil) {
        self.linkPreviewService = LinkPreviewService(
            cacheDirectory: ArborSupportDirectories.linkPreviews
        )
        let disconnectedHome = WorkspaceReference(tree: "local", path: "/")
        let provider = suppliedProvider ?? InMemoryWorkspaceProvider(nodes: [
            WorkspaceNode(
                reference: disconnectedHome,
                title: "No workspace open",
                surface: .directory(summary: "Open a local workspace to begin."),
                provenance: .init(authority: .diagnostic, sourceDescription: "No provider connected"),
                isWritable: false
            )
        ])
        self.provider = provider
        self.editorWorkspace = ArborEditorWorkspace(provider: provider)
        let initialHome = suppliedProvider == nil
            ? disconnectedHome
            : WorkspaceReference(tree: "tr_sample", path: "/")
        self.home = initialHome
        self.launchLocation = .reference(initialHome)
        if suppliedProvider != nil {
            self.capabilities = .full
            self.providerDetail = "In-memory test fixture"
            self.syncPresentation = WorkspaceSyncPresentation(
                state: .offline,
                detail: "Local test fixture; no authority configured"
            )
        }
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
        overviewRefreshTask?.cancel()
        overviewRefreshTask = nil
        overviewWatchTask?.cancel()
        overviewWatchTask = nil
        localArbordOverview = nil
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
        overviewRefreshTask?.cancel()
        overviewRefreshTask = nil
        overviewWatchTask?.cancel()
        overviewWatchTask = nil
        let usesTestHelper = ProcessInfo.processInfo.environment["ARBOR_TEST_BUNDLED_HELPER"] == "1"
        let launchPolicy: ArbordLaunchPolicy = .automatic
        // A signed test helper has an isolated data home and must never impersonate the
        // user's arbord on its well-known port if the test host exits unexpectedly.
        let preferredPort = usesTestHelper ? 45_190 : 4_317
        let nextSupervisor = ArbordProcessSupervisor(launchPolicy: launchPolicy)
        do {
            let runtime = try await nextSupervisor.start(workspace: url, preferredPort: preferredPort)
            supervisor = nextSupervisor
            arbordClient = ArborClient(baseURL: runtime.origin)
            syncCoordinator = nil
            syncConflict = nil
            if remember { try await bookmarks.save(url) }
            await switchProvider(
                runtime.provider,
                home: runtime.home,
                launchLocation: runtime.launchLocation,
                detail: runtime.attachedToExistingProcess ? "User arbord · ~/.arbor" : "Supervised arbord · ~/.arbor"
            )
            syncPresentation = WorkspaceSyncPresentation(
                state: .current,
                detail: "All macOS writes are owned by arbord"
            )
            prefetchLocalArbordOverview()
        } catch {
            await nextSupervisor.stop()
            supervisor = nil
            arbordClient = nil
            localArbordOverview = nil
            throw error
        }
    }

    func restoreLocalWorkspaceIfAvailable() async {
        guard !attemptedWorkspaceRestore else { return }
        attemptedWorkspaceRestore = true
        do {
            let url = try await bookmarks.load() ?? FileManager.default.homeDirectoryForCurrentUser
            try await openLocalWorkspace(url, remember: false)
        } catch {
            let restoreError = error
            do {
                try await openLocalWorkspace(FileManager.default.homeDirectoryForCurrentUser, remember: false)
                errorMessage = "The saved workspace could not be reopened, so Arbor opened your home folder instead: \(restoreError.localizedDescription)"
            } catch {
                errorMessage = "Arbor could not start its filesystem provider: \(error.localizedDescription)"
            }
        }
    }

    func restartArbord() async {
        guard let supervisor else {
            attemptedWorkspaceRestore = false
            errorMessage = nil
            await restoreLocalWorkspaceIfAvailable()
            return
        }
        do {
            try await editorWorkspace.flushAll()
            await editorWorkspace.closeAll()
            let runtime = try await supervisor.restart()
            arbordClient = ArborClient(baseURL: runtime.origin)
            await switchProvider(
                runtime.provider,
                home: runtime.home,
                launchLocation: runtime.launchLocation,
                detail: runtime.attachedToExistingProcess ? "User arbord · ~/.arbor" : "Supervised arbord · ~/.arbor"
            )
            syncPresentation = WorkspaceSyncPresentation(state: .current, detail: "Reconnected to arbord")
            prefetchLocalArbordOverview()
        } catch {
            errorMessage = error.localizedDescription
            syncPresentation = WorkspaceSyncPresentation(state: .offline, detail: error.localizedDescription)
        }
    }

    func arbordLogs() async -> String {
        await supervisor?.logs() ?? "No arbord process is connected."
    }

    func refreshLocalArbordOverview() async {
        if let overviewRefreshTask {
            await overviewRefreshTask.value
            return
        }
        let task = Task { @MainActor [weak self] in
            guard let self else { return }
            self.localArbordOverviewIsRefreshing = true
            defer {
                self.localArbordOverviewIsRefreshing = false
                self.overviewRefreshTask = nil
            }
            do {
                let overview = try await self.loadLocalArbordOverview()
                guard !Task.isCancelled else { return }
                self.localArbordOverview = overview
                self.localArbordOverviewError = nil
                self.startLocalOverviewWatch(after: overview.observedThrough)
            } catch is CancellationError {
                return
            } catch {
                self.localArbordOverviewError = error.localizedDescription
            }
        }
        overviewRefreshTask = task
        await task.value
    }

    private func prefetchLocalArbordOverview() {
        Task { await refreshLocalArbordOverview() }
    }

    private func loadLocalArbordOverview() async throws -> LocalArbordOverview {
        guard let client = arbordClient else { throw ArbordSupervisorError.serviceUnavailable }
        async let communityRequest = client.node(.path("/community", tree: "system"))
        async let treeDirectoryRequest = client.node(.path("/trees", tree: "system"))
        async let visitDirectoryRequest = client.node(.path("/visited", tree: "system"))
        async let devicesRequest = loadLocalArbordDevices(client: client)
        let (community, treeDirectory, visitDirectory, deviceResult) = try await (
            communityRequest,
            treeDirectoryRequest,
            visitDirectoryRequest,
            devicesRequest
        )
        let frontmatter = community.document?.frontmatter
        let connected = frontmatter?.bool("connected") == true
        let devices = connected ? try deviceResult.get() : []
        async let treesRequest = loadLocalArbordTrees(client: client, children: treeDirectory.children ?? [])
        async let visitsRequest = loadLocalArbordVisits(client: client, children: visitDirectory.children ?? [])
        let (trees, visits) = try await (treesRequest, visitsRequest)
        return LocalArbordOverview(
            origin: connected ? frontmatter?.string("origin") : nil,
            handle: connected ? frontmatter?.string("handle") : nil,
            credentialAvailable: connected && frontmatter?.bool("credentialAvailable") == true,
            trees: trees,
            visits: visits,
            devices: devices,
            observedThrough: latestObservationCursor([
                community.observedThrough,
                treeDirectory.observedThrough,
                visitDirectory.observedThrough,
            ]),
            refreshedAt: Date()
        )
    }

    private func loadLocalArbordDevices(client: ArborClient) async -> Result<[AuthorityDevice], Error> {
        do { return .success(try await client.communityDevices()) }
        catch { return .failure(error) }
    }

    private func latestObservationCursor(_ cursors: [String]) -> String {
        cursors.max { lhs, rhs in
            let left = Int(lhs.split(separator: ":").last ?? "") ?? 0
            let right = Int(rhs.split(separator: ":").last ?? "") ?? 0
            return left < right
        } ?? ""
    }

    private func loadLocalArbordTrees(client: ArborClient, children: [TreeChild]) async throws -> [LocalArbordTreePresentation] {
        let values = try await withThrowingTaskGroup(of: (Int, LocalArbordTreePresentation?).self) { group in
            for (index, child) in children.enumerated() {
                group.addTask {
                    let node = try await client.node(.path(child.path, tree: "system"))
                    guard let fields = node.document?.frontmatter, let id = fields.string("id") else { return (index, nil) }
                    return (index, LocalArbordTreePresentation(
                        id: id,
                        name: fields.string("name") ?? node.name,
                        canonicalPath: fields.string("canonicalPath"),
                        path: fields.string("path"),
                        access: fields.string("access"),
                        sync: fields.string("sync")
                    ))
                }
            }
            var loaded: [(Int, LocalArbordTreePresentation?)] = []
            for try await value in group { loaded.append(value) }
            return loaded
        }
        return values.sorted { $0.0 < $1.0 }.compactMap(\.1)
    }

    private func loadLocalArbordVisits(client: ArborClient, children: [TreeChild]) async throws -> [LocalArbordVisitPresentation] {
        let values = try await withThrowingTaskGroup(of: (Int, LocalArbordVisitPresentation?).self) { group in
            for (index, child) in children.enumerated() {
                group.addTask {
                    let node = try await client.node(.path(child.path, tree: "system"))
                    guard let fields = node.document?.frontmatter,
                          let id = fields.string("id"),
                          let tree = fields.string("tree"),
                          let locator = fields.string("locator") else { return (index, nil) }
                    return (index, LocalArbordVisitPresentation(
                        id: id,
                        tree: tree,
                        name: node.name,
                        locator: locator,
                        canonical: fields.string("canonical"),
                        visitedAt: fields.string("visitedAt")
                    ))
                }
            }
            var loaded: [(Int, LocalArbordVisitPresentation?)] = []
            for try await value in group { loaded.append(value) }
            return loaded
        }
        return values.sorted { $0.0 < $1.0 }.compactMap(\.1)
    }

    private func startLocalOverviewWatch(after cursor: String) {
        guard overviewWatchTask == nil, let client = arbordClient else { return }
        overviewWatchTask = Task { @MainActor [weak self] in
            do {
                let observations = await client.observations(after: cursor)
                for try await event in observations {
                    guard !Task.isCancelled else { return }
                    guard event.tree == "system" else { continue }
                    try await Task.sleep(for: .milliseconds(150))
                    guard !Task.isCancelled else { return }
                    await self?.refreshLocalArbordOverview()
                }
            } catch is CancellationError {
                return
            } catch {
                self?.localArbordOverviewError = error.localizedDescription
            }
            self?.overviewWatchTask = nil
        }
    }

    func createLocalArbordPairing() async throws -> LocalArbordPairingPresentation {
        guard let client = arbordClient else { throw ArbordSupervisorError.serviceUnavailable }
        if localArbordOverview == nil { await refreshLocalArbordOverview() }
        guard let overview = localArbordOverview,
              let rawOrigin = overview.origin,
              let origin = URL(string: rawOrigin) else {
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
        let revoked = try await client.revokeCommunityDevice(id)
        if let overview = localArbordOverview {
            localArbordOverview = LocalArbordOverview(
                origin: overview.origin,
                handle: overview.handle,
                credentialAvailable: overview.credentialAvailable,
                trees: overview.trees,
                visits: overview.visits,
                devices: overview.devices.map { $0.id == revoked.id ? revoked : $0 },
                observedThrough: overview.observedThrough,
                refreshedAt: overview.refreshedAt
            )
        }
        try await refreshLocalArbordDevices()
    }

    private func refreshLocalArbordDevices() async throws {
        guard let client = arbordClient, let overview = localArbordOverview else { return }
        localArbordOverview = LocalArbordOverview(
            origin: overview.origin,
            handle: overview.handle,
            credentialAvailable: overview.credentialAvailable,
            trees: overview.trees,
            visits: overview.visits,
            devices: try await client.communityDevices(),
            observedThrough: overview.observedThrough,
            refreshedAt: Date()
        )
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
        overviewRefreshTask?.cancel()
        overviewWatchTask?.cancel()
        overviewRefreshTask = nil
        overviewWatchTask = nil
        if let supervisor { await supervisor.stop() }
        arbordClient = nil
#endif
    }

    private func switchProvider(
        _ nextProvider: any WorkspaceProvider,
        home nextHome: WorkspaceReference,
        launchLocation nextLaunchLocation: WorkspaceLocation? = nil,
        detail: String
    ) async {
        await editorWorkspace.closeAll()
        provider = nextProvider
        editorWorkspace = ArborEditorWorkspace(provider: nextProvider)
        home = nextHome
        launchLocation = nextLaunchLocation ?? .reference(nextHome)
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
    private(set) var sidebarLocation: WorkspaceLocation
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
        self.tabs = BrowserTabController(launchLocation: workspace.launchLocation)
        self.sidebarLocation = workspace.launchLocation
        self.observedWorkspaceGeneration = workspace.generation
    }

    convenience init() {
        self.init(workspace: ArborWorkspaceState(provider: .sample()))
    }

    var currentLocation: WorkspaceLocation { tabs.selectedTab.current }
    var currentReference: WorkspaceReference {
        if let node, node.location == currentLocation { return node.reference }
        switch currentLocation {
        case let .reference(reference): return reference
        case let .localPath(path): return WorkspaceReference(tree: "local", path: path)
        case .remote: return workspace.home
        }
    }
    var canGoBack: Bool { tabs.canGoBack }
    var canGoForward: Bool { tabs.canGoForward }
    var canGoParent: Bool { tabs.canGoParent }
    var canGoHome: Bool { treeHomeLocation != nil }
    var selectedTabID: UUID { tabs.selectedTabID }
    var tabItems: [BrowserTab] { tabs.tabs }
    var binding: ArborDocumentBinding? { editorLease?.binding }
    var navigationRoot: WorkspaceLocation {
        _ = tabVersion
        return tabs.navigationRoot
    }
    var navigationPath: [WorkspaceLocation] {
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
        tabs = BrowserTabController(launchLocation: workspace.launchLocation)
        sidebarLocation = workspace.launchLocation
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
            let requestedLocation = currentLocation
            let resolved = try await workspace.provider.resolve(requestedLocation)
            let sidebarBase: WorkspaceLocation = switch resolved.surface {
            case .directory, .directoryDocument, .collection:
                resolved.location
            default:
                resolved.location.parent ?? workspace.launchLocation
            }
            let loadedChildren = try await workspace.provider.children(of: sidebarBase)
            guard requestID == loadRequestID, observedWorkspaceGeneration == workspace.generation else { return }
            tabs.replaceCurrent(with: resolved.location)
            tabVersion += 1
            node = resolved
            children = loadedChildren
            sidebarLocation = sidebarBase
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
            sidebarLocation = currentLocation.parent ?? workspace.launchLocation
            errorMessage = error.localizedDescription
            isLoading = false
        }
    }

    func navigate(to location: WorkspaceLocation) async {
        tabs.navigate(to: location)
        tabVersion += 1
        await load()
    }

    func navigate(to reference: WorkspaceReference) async {
        await navigate(to: location(for: reference))
    }

    func goBack() async { tabs.goBack(); tabVersion += 1; await load() }
    func goForward() async { tabs.goForward(); tabVersion += 1; await load() }
    func goParent() async { tabs.goParent(); tabVersion += 1; await load() }
    func goHome() async {
        guard let home = treeHomeLocation else { return }
        tabs.goHome(to: home)
        tabVersion += 1
        await load()
    }

    func setNavigationPath(_ path: [WorkspaceLocation]) {
        guard path != tabs.navigationPath else { return }
        tabs.setNavigationPath(path)
        tabVersion += 1
        Task { await load() }
    }

    func newTab() async {
        tabs.newTab()
        tabVersion += 1
        await load()
    }

    func openInNewTab(_ location: WorkspaceLocation) async {
        tabs.newTab(at: location)
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
            let renamedLocation = location(for: renamed.reference)
            tabs.replaceCurrent(with: renamedLocation)
            sidebarLocation = renamedLocation.parent ?? workspace.launchLocation
            children = try await workspace.provider.children(of: sidebarLocation)
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

    private var treeHomeLocation: WorkspaceLocation? {
        guard let node else { return nil }
        switch currentLocation {
        case .localPath:
#if os(macOS)
            guard workspace.localArbordOverview?.trees.contains(where: {
                $0.id == node.reference.tree.rawValue && $0.path != nil
            }) == true else { return nil }
#endif
            return node.provenance.treeRootURL.map { .local($0.path) }
        case .reference:
            guard node.reference.tree.rawValue != "local", node.reference.tree.rawValue != "system" else { return nil }
            return .reference(WorkspaceReference(tree: node.reference.tree, path: "/"))
        case let .remote(_, rootLocator):
            return .remote(locator: rootLocator, rootLocator: rootLocator)
        }
    }

    private func location(for reference: WorkspaceReference) -> WorkspaceLocation {
        guard let node, node.reference.tree == reference.tree else { return .reference(reference) }
        switch currentLocation {
        case .localPath:
            guard let root = node.provenance.treeRootURL else { return .reference(reference) }
            let path = reference.pathHint == "/"
                ? root.path
                : root.appending(path: reference.pathHint.trimmingCharacters(in: CharacterSet(charactersIn: "/"))).path
            return .local(path)
        case let .remote(_, rootLocator):
            guard var components = URLComponents(string: rootLocator) else { return .reference(reference) }
            let rootPath = components.percentEncodedPath.replacingOccurrences(of: "/$", with: "", options: .regularExpression)
            let suffix = reference.pathHint == "/" ? "" : reference.pathHint
            components.percentEncodedPath = rootPath + suffix
            guard let locator = components.url?.absoluteString else { return .reference(reference) }
            return .remote(locator: locator, rootLocator: rootLocator)
        case .reference:
            return .reference(reference)
        }
    }
}
