import ArborSyncClient
import CanopyAppKit
import OverstoryObjectStore
import CanopyEditor
import CanopyWorkingTree
import OverstoryClient
import Overstory
import CryptoKit
import Foundation
import Observation
import QuagmireExtras
import Network

struct ArborShareAccount: Identifiable, Hashable, Sendable {
    let configurationTree: String
    let origin: String
    let handle: String?
    var id: String { configurationTree }
}

enum ArborSharePresentation: Hashable, Sendable {
    case tracked(NativeTreeAccessPresentation)
    case promotable(path: String, accounts: [ArborShareAccount])
}

enum ArborShareInvite {
    static func locators(in input: String) -> [String] {
        input
            .split(separator: ",", omittingEmptySubsequences: true)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
    }
}

#if os(macOS)
struct LocalArborSyncTreePresentation: Identifiable, Sendable, Equatable {
    let id: String
    let configurationTree: String?
    let kind: String
    let name: String
    let canonicalPath: String?
    let path: String?
    let placement: String
    let access: String?
    let sync: String?
    let reviewableConflict: Bool
    let missing: Bool
}

struct LocalArborSyncVisitPresentation: Identifiable, Sendable, Equatable {
    let id: String
    let tree: String
    let name: String
    let locator: String
    let canonical: String?
}

struct LocalArborSyncDevicePresentation: Identifiable, Sendable, Equatable {
    let id: String
    let label: String
    let isAdministrator: Bool
    let isCurrent: Bool
}

struct LocalArborSyncOverview: Sendable, Equatable {
    let origin: String?
    let handle: String?
    let configurationTree: String?
    let credentialAvailable: Bool
    let accounts: [LocalCanopyAccountDescriptor]
    let trees: [LocalArborSyncTreePresentation]
    let visits: [LocalArborSyncVisitPresentation]
    let devices: [LocalArborSyncDevicePresentation]
    let observedThrough: String
}

private struct LocalAccountConfigurationPresentation {
    let origin: String?
    let handle: String?
    let administrators: Set<String>
    let currentDevice: String?
    let devices: [LocalArborSyncDevicePresentation]
}

struct LocalArborSyncPairingPresentation: Sendable, Equatable {
    let payload: String
    let confirmationCode: String
}
#endif

struct WorkspaceStructuralReceipt: Identifiable {
    let id = UUID()
    let action: WorkspaceStructuralAction
    let result: WorkspaceNode?
}

@MainActor
@Observable
final class ArborWorkspaceState {
    /// Wire format the working tree was placed under; bump when accepted-update
    /// identity, request shapes, canonical object encoding, or the durable
    /// state layout changes incompatibly. "4": content references (schema 2
    /// state, no inline file bytes), the `WorkingTrees/` layout, and
    /// `update-control.json`.
    static let workingTreeFormat = "5"

    private(set) var provider: any WorkspaceProvider
    private(set) var editorWorkspace: ArborEditorWorkspace
    private(set) var home: WorkspaceReference
    private(set) var launchLocation: WorkspaceLocation
    private(set) var generation = 0
    /// Bumped when the provider is replaced by one presenting the same tree at
    /// the same locations (preview → confirmed working tree): windows reload
    /// their pages in place instead of resetting navigation.
    private(set) var providerRevision = 0
    private(set) var launchPhase: ArborLaunchPhase = .ready
    private(set) var capabilities: WorkspaceProviderCapabilities = .readOnly
    private(set) var providerDetail = "No tree open"
    /// canopyd's canonical `/` tree is its membership profile. Handles in
    /// that profile reserve account locators; ordinary group handles do not.
    private(set) var currentTreeCanonicalPath: String?
    var isCommunityMembershipTree: Bool { currentTreeCanonicalPath == "/" }
    private(set) var syncPresentation = WorkspaceSyncPresentation(
        state: .offline,
        detail: "Open a local tree to start Native synchronization"
    )
    private(set) var arborsyncProcessKind: ArborSyncProcessKind?
    private(set) var latestStructuralReceipt: WorkspaceStructuralReceipt?
    let linkPreviewService: LinkPreviewService
    var errorMessage: String?

    private var syncCoordinator: UpdateCoordinator?
    private(set) var conflictReview: ArborConflictReviewModel?
    private var serverWatchTask: Task<Void, Never>?
#if os(macOS)
    private var supervisor: ArborSyncProcessSupervisor?
    private var arborsyncClient: ArborSyncRESTClient?
    private let visitedTreeStore = VisitedTreeStore()
    private var visitFollowTask: Task<Void, Never>?
    private var initialSyncTask: Task<Void, Never>?
    /// The placed tree open as this app's working tree, if any.
    private(set) var openPlacedTreeID: String?
    /// The root locator of the visit open, if any.
    private(set) var openVisitLocator: String?
    private var attemptedWorkspaceRestore = false
    private var overviewRefreshTask: Task<Void, Never>?
    /// Identifies the refresh `overviewRefreshTask` holds, so a cancelled
    /// refresh finishing late never clears its replacement.
    private var overviewRefreshID = 0
    private var overviewWatchTask: Task<Void, Never>?
    /// A refresh waiting out `overviewEventCoalescing`; events arriving
    /// meanwhile share it.
    private var overviewEventRefreshTask: Task<Void, Never>?
    private static let overviewEventCoalescing: Duration = .milliseconds(150)
    private(set) var localArborSyncOverview: LocalArborSyncOverview?
    private(set) var localArborSyncOverviewIsRefreshing = false
    private(set) var localArborSyncOverviewError: String?
    private(set) var localCanopyDevicesByConfigurationTree: [String: [LocalArborSyncDevicePresentation]] = [:]
#endif
    private var navigationLocators: [TreeID: String] = [:]
    private let directoryStore = DirectoryStore()
    private(set) var directory: [DirectoryPerson] = []
    private(set) var directoryIsRefreshing = false
    private(set) var directoryError: String?
    private var directoryRefreshTask: Task<Void, Never>?
    private let editorRecoveryRoot: URL?
    private let nativePlacementStore = NativePlacementStore()
    private(set) var nativePlacements: [NativePlacementRecord] = []
    private let nativePathMonitor = NWPathMonitor()
    private let nativePathMonitorQueue = DispatchQueue(label: "org.nxhx.Arbor.canopy-path")
    private var nativeTransportAvailable = false

    init(provider suppliedProvider: InMemoryWorkspaceProvider? = nil) {
        self.editorRecoveryRoot = suppliedProvider == nil ? ArborSupportDirectories.root.appending(path: "EditorRecovery") : nil
        self.linkPreviewService = LinkPreviewService(
            cacheDirectory: ArborSupportDirectories.linkPreviews
        )
        let disconnectedHome = WorkspaceReference(tree: "local", path: "/")
        let provider = suppliedProvider ?? InMemoryWorkspaceProvider(nodes: [
            WorkspaceNode(
                reference: disconnectedHome,
                title: "No tree open",
                surface: .directory(summary: "Open a local tree to begin."),
                provenance: .init(authority: .diagnostic, sourceDescription: "No provider connected"),
                isWritable: false
            )
        ])
        self.provider = provider
        self.editorWorkspace = ArborEditorWorkspace(provider: provider, recoveryRoot: editorRecoveryRoot)
        var initialHome = suppliedProvider == nil
            ? disconnectedHome
            : WorkspaceReference(tree: "tr_sample", path: "/")
        var initialPhase = ArborLaunchPhase.ready
#if os(macOS)
        // Know the tree to reopen before the first frame, so launch never
        // shows a stand-in and then jumps.
        if suppliedProvider == nil, ProcessInfo.processInfo.environment["ARBOR_TEST_BUNDLED_HELPER"] != "1" {
            if let record = try? NativePlacementStore.selected() {
                initialHome = WorkspaceReference(tree: TreeID(rawValue: record.tree.id), path: "/")
                initialPhase = .restoring(record.displayName)
            } else {
                initialPhase = .empty(nil)
            }
        }
#endif
        self.home = initialHome
        self.launchLocation = .reference(initialHome)
        self.launchPhase = initialPhase
        self.directory = (try? DirectoryStore.load()) ?? []
        if case let .restoring(name) = initialPhase { self.providerDetail = "Opening \(name)…" }
        if suppliedProvider != nil {
            self.capabilities = .full
            self.providerDetail = "In-memory test fixture"
            self.syncPresentation = WorkspaceSyncPresentation(
                state: .offline,
                detail: "Local test fixture; no server configured"
            )
        }
        nativePathMonitor.pathUpdateHandler = { [weak self] path in
            let available = path.status == .satisfied
            Task { @MainActor [weak self] in
                await self?.setNativeTransportAvailable(available)
            }
        }
        nativePathMonitor.start(queue: nativePathMonitorQueue)
    }

    func place(tree: WireTreeDescriptor, from origin: URL, configurationTree: String? = nil, remember: Bool = true) async throws {
        _ = try tree.validated()
        try await conflictReview?.flushDraft()
        serverWatchTask?.cancel()
        serverWatchTask = nil
        let credentialProvider: any WireCredentialProvider = configurationTree.map {
            AccountStoredCredentialProvider(configurationTree: $0, store: KeychainDeviceCredentialStore())
        } ?? StoredDeviceCredentialProvider(origin: origin, store: KeychainDeviceCredentialStore())
        let client = ArborWireClient(origin: origin, credentialProvider: credentialProvider)
        let transport = ArborWireReplicaTransport(client: client)
        let platform = CanopyObjectStore(client: client, tree: tree.id)
        let root = ArborSupportDirectories.root
        let key = ArborSupportDirectories.workingTreeKey(tree.id)
        let replicaRoot = ArborSupportDirectories.workingTrees.appending(path: key, directoryHint: .isDirectory)
        // A working tree records the wire format it was placed under. When the
        // format changes (accepted-update ids, cursors, and request shapes are
        // not continuous across such a change), the tree and its update state
        // cannot resume against the server and are re-placed from a fresh
        // snapshot.
        let syncStateRoot = root.appending(path: "Sync/\(key)", directoryHint: .isDirectory)
        let workingTree = try await Self.openOrPlaceWorkingTree(
            tree,
            replicaRoot: replicaRoot,
            syncStateRoot: syncStateRoot,
            recoveryNames: (workingTree: "WorkingTree", sync: "Sync"),
            transport: transport,
            platform: platform
        )
        let (coordinator, nextProvider) = try synchronizedProvider(
            workingTree: workingTree,
            transport: transport,
            stateRoot: syncStateRoot,
            sourceObjectStore: workingTree,
            readOnly: tree.access != "write"
        )
        if remember {
            try await nativePlacementStore.save(NativePlacementRecord(origin: origin, configurationTree: configurationTree, tree: tree))
            nativePlacements = try await nativePlacementStore.loadAll()
        }
        await switchProvider(
            nextProvider,
            home: WorkspaceReference(tree: TreeID(rawValue: tree.id), path: "/"),
            detail: "Offline replica · \(tree.canonicalPath ?? tree.id)",
            canonicalPath: tree.canonicalPath
        )
        try await installSyncCoordinator(coordinator, client: client, tree: tree)
    }

    /// Open the durable working tree at `replicaRoot`, or place it afresh from
    /// a snapshot. A working tree records the wire format it was placed under.
    /// When the format changes (accepted-update ids, cursors, and request
    /// shapes are not continuous across such a change), the tree and its update
    /// state cannot resume against the server and are re-placed.
    private static func openOrPlaceWorkingTree(
        _ tree: WireTreeDescriptor,
        replicaRoot: URL,
        syncStateRoot: URL,
        recoveryNames: (workingTree: String, sync: String),
        transport: ArborWireReplicaTransport,
        platform: any ObjectStore
    ) async throws -> WorkingTree {
        let formatMarker = replicaRoot.appending(path: "wire-format")
        let placedFormat = (try? String(contentsOf: formatMarker, encoding: .utf8))?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if placedFormat == workingTreeFormat,
           FileManager.default.fileExists(atPath: replicaRoot.appending(path: "materialized/tree.json").path) {
            return try await WorkingTree.open(at: replicaRoot, tree: TreeID(rawValue: tree.id), platform: platform)
        }
        // Retain old admissions and materialized content for recovery; never
        // replay an old-format journal against reset accepted history.
        let archive = ArborSupportDirectories.root
            .appending(path: "FormatRecovery/\(UUID().uuidString)", directoryHint: .isDirectory)
        for (source, name) in [(replicaRoot, recoveryNames.workingTree), (syncStateRoot, recoveryNames.sync)] {
            if FileManager.default.fileExists(atPath: source.path) {
                try FileManager.default.createDirectory(at: archive, withIntermediateDirectories: true)
                try FileManager.default.moveItem(at: source, to: archive.appending(path: name))
            }
        }
        let workingTree = try await WorkingTreePlacementService.place(
            tree: tree,
            at: replicaRoot,
            transport: transport,
            platform: platform
        )
        try workingTreeFormat.write(to: formatMarker, atomically: true, encoding: .utf8)
        return workingTree
    }

    /// An update coordinator for `workingTree` and the provider that saves
    /// through it, refreshing the sync presentation after each immediate sync.
    private func synchronizedProvider(
        workingTree: WorkingTree,
        transport: ArborWireReplicaTransport,
        stateRoot: URL,
        sourceObjectStore: any ObjectStore,
        readOnly: Bool = false,
        materializedRoot: URL? = nil
    ) throws -> (UpdateCoordinator, WorkingTreeProvider) {
        let coordinator = try UpdateCoordinator(
            workingTree: workingTree,
            transport: transport,
            stateRoot: stateRoot,
            transportAvailable: nativeTransportAvailable,
            sourceOperationEmission: true,
            sourceObjectStore: sourceObjectStore
        )
        let provider = WorkingTreeProvider(
            workingTree: workingTree,
            readOnly: readOnly,
            materializedRoot: materializedRoot,
            sourceCoordinator: coordinator
        ) { [weak self] admission in
            try await coordinator.syncImmediately(admission)
            await self?.refreshSyncPresentation(from: coordinator)
        }
        return (coordinator, provider)
    }

    /// Make `coordinator` the open tree's: its conflict review, sync
    /// presentation, and server watch.
    private func installSyncCoordinator(
        _ coordinator: UpdateCoordinator,
        client: ArborWireClient,
        tree: WireTreeDescriptor
    ) async throws {
        syncCoordinator = coordinator
        conflictReview = ArborConflictReviewModel(coordinator: coordinator)
        Task { [weak self] in await self?.conflictReview?.refresh() }
        syncPresentation = try await coordinator.presentation()
        startServerWatch(client: client, tree: tree, coordinator: coordinator)
    }

    private func setNativeTransportAvailable(_ available: Bool) async {
        nativeTransportAvailable = available
        guard let syncCoordinator else { return }
        await syncCoordinator.setTransportAvailable(available)
        if available { await editorWorkspace.retryFailedSaves() }
        await refreshSyncPresentation(from: syncCoordinator)
    }

#if os(iOS)
    func restoreNativePlacementIfAvailable() async -> Bool {
        do {
            nativePlacements = try await nativePlacementStore.loadAll()
            guard let record = try await nativePlacementStore.load() else { return false }
            try await place(tree: record.tree, from: record.origin, configurationTree: record.configurationTree, remember: false)
            return true
        } catch {
            errorMessage = "The saved iPhone tree could not be reopened: \(error.localizedDescription)"
            return false
        }
    }

    func nativePlacement() async throws -> NativePlacementRecord? {
        try await nativePlacementStore.load()
    }

    func openNativePlacement(_ placement: NativePlacementRecord) async {
        do {
            try await place(
                tree: placement.tree,
                from: placement.origin,
                configurationTree: placement.configurationTree
            )
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func disconnectNativeAccount() async throws {
        try await conflictReview?.flushDraft()
        guard let placement = try await nativePlacementStore.load() else { return }
        try await NativeAccountService(origin: placement.origin, configurationTree: placement.configurationTree).forget()
        try await nativePlacementStore.clear(configurationTree: placement.configurationTree)
        nativePlacements = try await nativePlacementStore.loadAll()
        serverWatchTask?.cancel()
        serverWatchTask = nil
        if let syncCoordinator { await syncCoordinator.close() }
        syncCoordinator = nil
        conflictReview = nil
        await editorWorkspace.closeAll()
    }
#endif

    func sharePresentation(for node: WorkspaceNode) async throws -> ArborSharePresentation {
#if os(iOS)
        if nativePlacements.isEmpty {
            nativePlacements = try await nativePlacementStore.loadAll()
        }
        guard let placement = nativePlacements.first(where: { $0.tree.id == node.reference.tree.rawValue }) else {
            throw ArborWireValidationError.invalidValue("The current tree is not placed on this iPhone")
        }
        let service = NativeAccountService(
            origin: placement.origin,
            configurationTree: placement.configurationTree
        )
        return .tracked(try await service.access(tree: placement.tree.id))
#else
        if node.reference.tree.rawValue == "local" {
            guard let physicalURL = node.provenance.physicalURL else {
                throw ArborWireValidationError.invalidValue("The current folder has no local path")
            }
            let folder: URL = switch node.surface {
            case .directory, .directoryDocument: physicalURL
            default: physicalURL.deletingLastPathComponent()
            }
            if localArborSyncOverview == nil { await refreshLocalArborSyncOverview() }
            var accounts: [ArborShareAccount] = []
            for account in localArborSyncOverview?.accounts ?? [] {
                guard account.credentialAvailable,
                      let origin = account.canopy,
                      isLocalAccountAdministrator(account) else { continue }
                accounts.append(ArborShareAccount(
                    configurationTree: account.configurationTree,
                    origin: origin,
                    handle: account.handle
                ))
            }
            return .promotable(path: folder.standardizedFileURL.path, accounts: accounts)
        }
        return .tracked(try await loadLocalTreeAccess(tree: node.reference.tree.rawValue))
#endif
    }

    func setShareAccess(
        tree: String,
        target: NativeTreeAccessTarget,
        access: String
    ) async throws -> NativeTreeAccessPresentation {
#if os(iOS)
        guard let placement = nativePlacements.first(where: { $0.tree.id == tree }) else {
            throw ArborWireValidationError.invalidValue("The tree is not placed on this iPhone")
        }
        return try await NativeAccountService(
            origin: placement.origin,
            configurationTree: placement.configurationTree
        ).setAccess(tree: tree, target: target, access: access)
#else
        guard access == "none" || access == "read" || access == "write",
              let overview = localArborSyncOverview,
              let placedTree = overview.trees.first(where: { $0.id == tree }),
              let configurationTree = placedTree.configurationTree else {
            throw ArborWireValidationError.invalidValue("The current tree has no editable account configuration")
        }
        let subject: ArborAccountAccessSubject = switch target {
        case .everyone: .everyone
        case .existing(let subject): subject
        case .profile(let locator): .profile(tree: try await resolveLocalProfile(locator, overview: overview, configurationTree: configurationTree))
        }
        let account = overview.accounts.first { $0.configurationTree == configurationTree }
        try ArborAccountConfigurationYAML.validateAccessChange(
            subject: subject,
            access: access,
            currentProfileTree: account?.profileTree
        )
        try await editAccountConfigurationFile(configurationTree, named: "trees.yaml") { source in
            try ArborAccountConfigurationYAML.replacingTrees(in: source) { trees in
                guard var declaration = trees[tree] else {
                    throw ArborWireValidationError.invalidValue("The current tree is not declared by this account")
                }
                declaration.access.removeAll { $0.subject == subject }
                if access != "none" {
                    declaration.access.append(ArborAccountAccessRule(subject: subject, access: access))
                }
                trees[tree] = declaration
            }
        } validate: { next in
            _ = try ArborAccountConfigurationYAML.trees(from: next)
        }
        await refreshLocalArborSyncOverview()
        return try await loadLocalTreeAccess(tree: tree)
#endif
    }

    func prepareResourceConsent(tree: String, rule: WireResourceAccessRule, removing: Bool = false) async throws -> NativeResourceConsent {
#if os(iOS)
        guard let placement = nativePlacements.first(where: { $0.tree.id == tree }) else { throw ResourcePolicyError.invalid }
        return try await NativeAccountService(origin: placement.origin, configurationTree: placement.configurationTree)
            .prepareResourceConsent(tree: tree, rule: rule, removing: removing)
#else
        guard let placed = localArborSyncOverview?.trees.first(where: { $0.id == tree }),
              let configuration = placed.configurationTree else { throw ResourcePolicyError.invalid }
        return try ArborAccountConfigurationYAML.prepareResourceConsent(configurationTree: configuration,
            tree: tree, rule: rule, removing: removing,
            source: readAccountConfigurationFile(configuration, named: "trees.yaml"))
#endif
    }

    func applyResourceConsent(_ review: NativeResourceConsent) async throws -> NativeTreeAccessPresentation {
#if os(iOS)
        guard let placement = nativePlacements.first(where: { $0.tree.id == review.tree }),
              placement.configurationTree == review.configurationTree else { throw ResourcePolicyError.invalid }
        return try await NativeAccountService(origin: placement.origin, configurationTree: placement.configurationTree)
            .applyResourceConsent(review)
#else
        guard let account = localArborSyncOverview?.accounts.first(where: { $0.configurationTree == review.configurationTree }) else { throw ResourcePolicyError.invalid }
        let devices = try readAccountConfigurationFile(review.configurationTree, named: "devices.yaml")
        try await editAccountConfigurationFile(review.configurationTree, named: "trees.yaml") { source in
            try ArborAccountConfigurationYAML.applyingResourceConsent(review, to: source,
                deviceID: account.deviceID, devicesSource: devices)
        }
        await refreshLocalArborSyncOverview()
        return try await loadLocalTreeAccess(tree: review.tree)
#endif
    }

#if os(macOS)
    // MARK: Account configuration on disk
    //
    // The configuration tree is a placed folder at `~/.arbor/accounts/<cfg>/`.
    // The app reads and edits its YAML there, exactly as the CLI does
    // (`editAccountConfigurationFile` in `@arbor/stores`), and the daemon pushes
    // the edit like any other placement. Nothing here goes through a daemon
    // editor route.

    private func accountCheckout(_ configurationTree: String) -> URL {
        ArborAccountConfigurationYAML.checkoutURL(
            dataHome: ArborSupportDirectories.dataHome,
            configurationTree: configurationTree
        )
    }

    private func readAccountConfigurationFile(_ configurationTree: String, named filename: String) throws -> String {
        try ArborAccountConfigurationYAML.readFile(named: filename, in: accountCheckout(configurationTree))
    }

    /// Edit one account-configuration file on disk, then ask the daemon to push
    /// the checkout now. Refused while the daemon reports the configuration
    /// tree in conflict: a disk edit would only pile onto the review.
    private func editAccountConfigurationFile(
        _ configurationTree: String,
        named filename: String,
        change: (String) throws -> String,
        validate: ((String) throws -> Void)? = nil
    ) async throws {
        if localArborSyncOverview?.trees.contains(where: { $0.id == configurationTree && $0.sync == "conflict" }) == true {
            throw ArborWireValidationError.invalidValue(
                "The account configuration has a conflict; review it in Sync Status before changing it"
            )
        }
        try ArborAccountConfigurationYAML.editFile(
            named: filename,
            in: accountCheckout(configurationTree),
            change: change,
            validate: validate
        )
        if let client = arborsyncClient {
            try await client.synchronize(configurationTree: configurationTree)
        }
    }

    private func isLocalAccountAdministrator(_ account: LocalCanopyAccountDescriptor) -> Bool {
        guard let deviceID = account.deviceID,
              let source = try? readAccountConfigurationFile(account.configurationTree, named: "devices.yaml") else {
            return false
        }
        return (try? ArborAccountConfigurationYAML.isAdministrator(
            deviceID: deviceID,
            devicesSource: source
        )) == true
    }

    func localCanopyDevices(configurationTree: String) async throws -> [LocalArborSyncDevicePresentation] {
        guard let account = localArborSyncOverview?.accounts.first(where: {
            $0.configurationTree == configurationTree
        }) else {
            throw ArborSyncSupervisorError.incompatibleService("The Canopy account is unavailable")
        }
        let source = try readAccountConfigurationFile(configurationTree, named: "devices.yaml")
        let devices = try ArborAccountConfigurationYAML.devices(from: source)
            .map { id, device in
                LocalArborSyncDevicePresentation(
                    id: id,
                    label: device.label,
                    isAdministrator: device.administrator == true,
                    isCurrent: id == account.deviceID
                )
            }
            .sorted { lhs, rhs in
                if lhs.isCurrent != rhs.isCurrent { return lhs.isCurrent }
                return lhs.label.localizedCaseInsensitiveCompare(rhs.label) == .orderedAscending
            }
        localCanopyDevicesByConfigurationTree[configurationTree] = devices
        return devices
    }

    func preloadLocalCanopyDevices() async {
        if localArborSyncOverview == nil { await refreshLocalArborSyncOverview() }
        for account in localArborSyncOverview?.accounts ?? [] {
            _ = try? await localCanopyDevices(configurationTree: account.configurationTree)
        }
    }

    func setLocalCanopyDeviceAdministrator(
        configurationTree: String,
        deviceID: String,
        administrator: Bool
    ) async throws -> [LocalArborSyncDevicePresentation] {
        guard let account = localArborSyncOverview?.accounts.first(where: {
            $0.configurationTree == configurationTree
        }) else {
            throw ArborSyncSupervisorError.incompatibleService("The Canopy account is unavailable")
        }
        let source = try readAccountConfigurationFile(configurationTree, named: "devices.yaml")
        let devices = try ArborAccountConfigurationYAML.devices(from: source)
        try ArborAccountConfigurationYAML.validateAdministratorChange(
            devices: devices,
            currentDeviceID: account.deviceID,
            targetDeviceID: deviceID,
            administrator: administrator
        )
        try await editAccountConfigurationFile(configurationTree, named: "devices.yaml") { current in
            try ArborAccountConfigurationYAML.replacingDevices(in: current) { devices in
                guard var device = devices[deviceID] else {
                    throw ArborWireValidationError.invalidValue("The device is no longer active")
                }
                device.administrator = administrator ? true : nil
                devices[deviceID] = device
            }
        } validate: { next in
            _ = try ArborAccountConfigurationYAML.devices(from: next)
        }
        return try await localCanopyDevices(configurationTree: configurationTree)
    }

    func deauthorizeLocalCanopyDevice(
        configurationTree: String,
        deviceID: String
    ) async throws -> [LocalArborSyncDevicePresentation] {
        guard let account = localArborSyncOverview?.accounts.first(where: {
            $0.configurationTree == configurationTree
        }) else {
            throw ArborSyncSupervisorError.incompatibleService("The Canopy account is unavailable")
        }
        let source = try readAccountConfigurationFile(configurationTree, named: "devices.yaml")
        let devices = try ArborAccountConfigurationYAML.devices(from: source)
        try ArborAccountConfigurationYAML.validateDeviceRemoval(
            devices: devices,
            currentDeviceID: account.deviceID,
            targetDeviceID: deviceID
        )
        try await editAccountConfigurationFile(configurationTree, named: "devices.yaml") { current in
            try ArborAccountConfigurationYAML.replacingDevices(in: current) { devices in
                devices[deviceID] = nil
            }
        } validate: { next in
            _ = try ArborAccountConfigurationYAML.devices(from: next)
        }
        return try await localCanopyDevices(configurationTree: configurationTree)
    }

    private func loadLocalTreeAccess(tree: String) async throws -> NativeTreeAccessPresentation {
        if localArborSyncOverview == nil { await refreshLocalArborSyncOverview() }
        guard let overview = localArborSyncOverview,
              let placedTree = overview.trees.first(where: { $0.id == tree }),
              let configurationTree = placedTree.configurationTree,
              let account = overview.accounts.first(where: { $0.configurationTree == configurationTree }) else {
            throw ArborWireValidationError.invalidValue("The current tree has no editable account configuration")
        }
        let treesSource = try readAccountConfigurationFile(configurationTree, named: "trees.yaml")
        let devicesSource = try readAccountConfigurationFile(configurationTree, named: "devices.yaml")
        let trees = try ArborAccountConfigurationYAML.trees(from: treesSource)
        guard let declaration = trees[tree] else {
            throw ArborWireValidationError.invalidValue("The current tree is not declared by this account")
        }
        let profileLocators = Dictionary(uniqueKeysWithValues: overview.trees.compactMap { profile -> (String, String)? in
            guard let path = profile.canonicalPath,
                  let origin = overview.accounts.first(where: { $0.configurationTree == profile.configurationTree })?.canopy else {
                return nil
            }
            return (profile.id, origin + path)
        })
        let entries = ArborAccountConfigurationYAML.presentedAccessEntries(
            rules: declaration.access,
            profileLocators: profileLocators,
            currentProfileTree: account.profileTree,
            currentHandle: account.handle
        )
        return NativeTreeAccessPresentation(
            tree: tree,
            canonical: declaration.canonical,
            entries: entries,
            canEdit: try ArborAccountConfigurationYAML.isAdministrator(
                deviceID: account.deviceID,
                devicesSource: devicesSource
            ),
            resourceRules: (declaration.resourceAccess ?? []).filter { $0.via != nil || ($0.within ?? "/") != "/" || $0.who == .me || !($0.allow == [.read] || $0.allow == [.write]) }
        )
    }

    /// A person or group as a profile TreeID: a bare TreeID, a `~handle` on the
    /// account's own Canopy, or any Arbor locator resolved on the Wire at its
    /// origin with the account credential when the origins match.
    private func resolveLocalProfile(
        _ input: String,
        overview: LocalArborSyncOverview,
        configurationTree: String
    ) async throws -> String {
        let value = input.trimmingCharacters(in: .whitespacesAndNewlines)
        if value.range(of: #"^tr_[a-z2-7]+$"#, options: .regularExpression) != nil { return value }
        let locator: String
        if value.hasPrefix("~"),
           let origin = overview.accounts.first(where: { $0.configurationTree == configurationTree })?.canopy,
           let host = URL(string: origin)?.host {
            locator = "arbor://\(host)/\(value)"
        } else {
            locator = value
        }
        guard let remote = ArborRemoteLocator(locator) else {
            throw ArborWireValidationError.invalidValue("Enter a person or group Arbor URL, handle, or TreeID")
        }
        let client = wireClient(origin: remote.origin, overview: overview)
        return try await client.resolve(path: remote.path).ref.tree
    }

    /// A Wire client at `origin`: with the daemon's credential for an account
    /// at that origin, anonymous otherwise.
    private func wireClient(origin: URL, overview: LocalArborSyncOverview?) -> ArborWireClient {
        if let client = arborsyncClient,
           let account = (overview ?? localArborSyncOverview)?.accounts.first(where: {
               $0.credentialAvailable && $0.canopy.flatMap(URL.init(string:)).map { Self.sameOrigin($0, origin) } == true
           }) {
            return ArborWireClient(
                origin: origin,
                credentialProvider: ArborSyncCredentialProvider(client: client, configurationTree: account.configurationTree)
            )
        }
        return ArborWireClient(origin: origin)
    }

    func promoteLocalFolder(
        path: String,
        account: ArborShareAccount,
        canonical: String,
        publicAccess: String
    ) async throws {
        guard publicAccess == "none" || publicAccess == "read" || publicAccess == "write",
              let canonicalURL = URL(string: canonical),
              let accountOrigin = URL(string: account.origin),
              Self.sameOrigin(canonicalURL, accountOrigin),
              canonicalURL.query == nil,
              canonicalURL.fragment == nil else {
            throw ArborWireValidationError.invalidValue("Enter a canonical URL on the selected Canopy")
        }
        let tree = try generateArborID(prefix: "tr")
        let rules = publicAccess == "none" ? [] : [
            ArborAccountAccessRule(subject: .everyone, access: publicAccess)
        ]
        let folder = URL(fileURLWithPath: path).standardizedFileURL.path
        // The placement first: a declared tree without a placement is only an
        // empty hosted tree, while a placement for an undeclared tree is an
        // error the daemon reports. Both are written on disk; nothing is pushed
        // until the daemon synchronizes.
        let placementsURL = ArborSupportDirectories.dataHome.appending(path: "placements.yaml")
        let placementsSource = (try? String(contentsOf: placementsURL, encoding: .utf8)) ?? "{}\n"
        let placements = try ArborLocalPlacementsYAML.adding(
            configurationTree: account.configurationTree,
            path: folder,
            tree: tree,
            to: placementsSource
        )
        try ArborAccountConfigurationYAML.editFile(
            named: "trees.yaml",
            in: accountCheckout(account.configurationTree)
        ) { source in
            try ArborAccountConfigurationYAML.replacingTrees(in: source) { trees in
                guard trees[tree] == nil else {
                    throw ArborWireValidationError.invalidValue("The new TreeID is already declared")
                }
                trees[tree] = ArborHostedTreeDeclaration(canonical: canonical, access: rules)
            }
        } validate: { next in
            _ = try ArborAccountConfigurationYAML.trees(from: next)
        }
        do {
            try placements.write(to: placementsURL, atomically: true, encoding: .utf8)
        } catch {
            do {
                try ArborAccountConfigurationYAML.editFile(
                    named: "trees.yaml",
                    in: accountCheckout(account.configurationTree)
                ) { latest in
                    try ArborAccountConfigurationYAML.replacingTrees(in: latest) { $0[tree] = nil }
                }
            } catch let rollbackError {
                throw ArborWireValidationError.invalidValue(
                    "\(error.localizedDescription) Removing \(tree) from trees.yaml again also failed: \(rollbackError.localizedDescription)"
                )
            }
            throw error
        }
        do {
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: placementsURL.path)
        } catch {
            // The placement is written; only its permissions could not be narrowed.
            Self.recordDiagnostic("placements-permissions", error)
        }
        guard let client = arborsyncClient else { throw ArborSyncSupervisorError.serviceUnavailable }
        try await client.synchronize(configurationTree: account.configurationTree)
        await refreshLocalArborSyncOverview()
        generation += 1
    }

    // MARK: Control-mode daemon

    /// Connect to the installation's control-mode daemon, launching one when
    /// none is listening, and keep its loopback client.
    @discardableResult
    func ensureArborSync() async throws -> ArborSyncControlRuntime {
        let usesTestHelper = ProcessInfo.processInfo.environment["ARBOR_TEST_BUNDLED_HELPER"] == "1"
        // A signed test helper has an isolated data home and must never impersonate the
        // user's arborsync on its well-known port if the test host exits unexpectedly.
        let preferredPort = usesTestHelper ? 45_190 : 4_317
        let supervisor = self.supervisor ?? ArborSyncProcessSupervisor(launchPolicy: .automatic)
        self.supervisor = supervisor
        do {
            let runtime = try await supervisor.start(preferredPort: preferredPort)
            arborsyncClient = runtime.client
            arborsyncProcessKind = runtime.attachedToExistingProcess ? .external : .supervised
            return runtime
        } catch {
            await supervisor.stop()
            self.supervisor = nil
            arborsyncClient = nil
            arborsyncProcessKind = nil
            localArborSyncOverview = nil
            throw error
        }
    }

    /// Drop the tree that is open: its watch, its coordinator, or its visit follower.
    private func closeOpenTree() async throws {
        try await conflictReview?.flushDraft()
        if let locator = openVisitLocator { navigationLocators[home.tree] = locator }
        serverWatchTask?.cancel()
        serverWatchTask = nil
        visitFollowTask?.cancel()
        visitFollowTask = nil
        initialSyncTask?.cancel()
        initialSyncTask = nil
        if let syncCoordinator { await syncCoordinator.close() }
        syncCoordinator = nil
        conflictReview = nil
        openPlacedTreeID = nil
        openVisitLocator = nil
    }

    // MARK: Placed trees

    /// Open a tree the daemon has placed as this app's own working tree.
    ///
    /// `GET /v1/bootstrap` seeds an in-memory tree from the daemon's recorded
    /// accepted Canopy root: a sparse spine of directories and Markdown, with
    /// every other file a hash the daemon's `/v1/objects` serves on demand.
    /// The folder client has independent pending/conflict state; it neither
    /// seeds nor blocks this client's direct Canopy update coordinator.
    func openPlacedTree(_ treeID: String) async throws {
        try await editorWorkspace.flushAll()
        try await closeOpenTree()
        let runtime = try await ensureArborSync()
        let client = runtime.client
        let bootstrap = try await client.bootstrap(tree: treeID)
        let placed = bootstrap.tree
        guard placed.osPath != nil else {
            throw ArborWireValidationError.invalidValue("\(placed.name) is not placed on this Mac")
        }
        // The account's Canopy is the origin only for a tree without a canonical endpoint.
        var originValue = placed.canonical?.endpoint
        if originValue == nil {
            originValue = try await client.accounts().first { $0.configurationTree == placed.configurationTree }?.canopy
        }
        guard let rawOrigin = originValue, let origin = URL(string: rawOrigin) else {
            throw ArborWireValidationError.invalidValue("\(placed.name) has no Canopy origin")
        }
        let descriptor = try WireTreeDescriptor(
            id: placed.id,
            kind: placed.kind,
            root: bootstrap.accepted.root,
            access: placed.access,
            canonical: placed.canonical,
            update: bootstrap.accepted.update
        ).validated()

        let credentialProvider = ArborSyncCredentialProvider(client: client, configurationTree: placed.configurationTree)
        let wireClient = ArborWireClient(origin: origin, credentialProvider: credentialProvider)
        let transport = ArborWireReplicaTransport(client: wireClient)
        let platform = DaemonObjectStore(client: client, tree: treeID)
        let workingTree = try await WorkingTree.inMemory(tree: TreeID(rawValue: treeID), platform: platform)
        let replacement = try SnapshotBridge.replacement(
            snapshot: bootstrap.spine,
            tree: TreeID(rawValue: treeID),
            update: bootstrap.accepted.update,
            cursor: bootstrap.accepted.cursor,
            mode: .sparseFiles,
            modifiedAtByPath: bootstrap.modifiedAtByPath.mapValues {
                Date(timeIntervalSince1970: $0 / 1_000)
            }
        )
        try await workingTree.initializeFromSystem(replacement)

        let stateRoot = ArborSupportDirectories.workingTrees
            .appending(path: ArborSupportDirectories.workingTreeKey(treeID), directoryHint: .isDirectory)
        let (coordinator, nextProvider) = try synchronizedProvider(
            workingTree: workingTree,
            transport: transport,
            stateRoot: stateRoot,
            sourceObjectStore: platform,
            materializedRoot: placed.osPath.map { URL(filePath: $0, directoryHint: .isDirectory) }
        )
        try await nativePlacementStore.save(NativePlacementRecord(
            origin: origin,
            configurationTree: placed.configurationTree,
            tree: descriptor,
            osPath: placed.osPath
        ))
        nativePlacements = try await nativePlacementStore.loadAll()
        let placeName = placed.canonical?.path ?? placed.name
        let nextHome = WorkspaceReference(tree: TreeID(rawValue: treeID), path: "/")
        await switchProvider(
            nextProvider,
            home: nextHome,
            detail: "Working tree · \(placeName) · \(placed.osPath ?? "")",
            canonicalPath: descriptor.canonicalPath,
            // The confirmed tree replaces its own preview at the same
            // locations: keep every window's navigation and reload in place.
            preservingNavigation: launchPhase.isPreviewing && home == nextHome
        )
        launchPhase = .ready
        openPlacedTreeID = treeID
        try await installSyncCoordinator(coordinator, client: wireClient, tree: descriptor)
        startInitialSync(coordinator)
        prefetchLocalArborSyncOverview()
    }

    /// Reconcile a freshly opened tree once; the server watch alone replays
    /// only what arrives after it connects.
    private func startInitialSync(_ coordinator: UpdateCoordinator) {
        initialSyncTask = Task { [weak self] in
            do {
                _ = try await coordinator.syncOnce()
            } catch is CancellationError {
                return
            } catch {
                Self.recordDiagnostic("initial-sync", error)
            }
            await self?.refreshSyncPresentation(from: coordinator)
        }
    }

    // MARK: Visits

    /// Open a remote tree by locator without a filesystem placement. Writable
    /// trees use an app-owned durable replica; readable trees remain visits.
    func openRemoteLocator(_ locator: String) async throws {
        guard let remote = ArborRemoteLocator(locator) else {
            throw ArborWireValidationError.invalidValue("Enter an http(s):// or arbor:// locator")
        }
        try await editorWorkspace.flushAll()
        try await closeOpenTree()
        if arborsyncClient == nil { _ = try? await ensureArborSync() }
        if localArborSyncOverview == nil, arborsyncClient != nil { await refreshLocalArborSyncOverview() }
        if let placed = localArborSyncOverview?.trees.first(where: { candidate in
            candidate.path != nil && candidate.missing != true
                && candidate.canonicalPath.map { path in
                    remote.path == path || remote.path.hasPrefix(path == "/" ? "/" : path + "/")
                } == true
                && (localArborSyncOverview?.accounts.first { $0.configurationTree == candidate.configurationTree }?.canopy)
                    .flatMap(URL.init(string:)).map { Self.sameOrigin($0, remote.origin) } == true
        }) {
            // The locator names a tree placed on this Mac: open the working tree instead of visiting.
            try await openPlacedTree(placed.id)
            return
        }
        let client = wireClient(origin: remote.origin, overview: localArborSyncOverview)
        let resolution = try await client.resolve(path: remote.path)
        let tree = resolution.enclosingTree
        let treeID = TreeID(rawValue: tree.id)
        let platform: any ObjectStore = if let daemon = arborsyncClient {
            DaemonObjectStore(client: daemon, tree: tree.id, origin: remote.origin)
        } else {
            CanopyObjectStore(client: client, tree: tree.id)
        }
        let rootLocator = tree.canonicalPath.map { remote.locator(path: $0) } ?? remote.rootLocator
        do {
            try await visitedTreeStore.record(VisitedTreeRecord(origin: remote.origin, tree: tree, locator: rootLocator))
        } catch {
            Self.recordDiagnostic("visit-record", error)
        }
        if tree.access == "write" {
            try await openWritableRemoteTree(
                tree: tree,
                locator: rootLocator,
                client: client,
                platform: platform
            )
            return
        }
        let snapshot = try await client.snapshot(tree: tree.id, root: tree.root)
        let workingTree = try await WorkingTree.inMemory(tree: treeID, platform: platform)
        try await workingTree.initializeFromSystem(try ArborVisitSnapshot.replacement(
            snapshot,
            tree: treeID,
            update: tree.update,
            cursor: resolution.observedThrough
        ))
        let provider = WorkingTreeProvider(workingTree: workingTree, readOnly: true)
        await switchProvider(
            provider,
            home: WorkspaceReference(tree: treeID, path: "/"),
            launchLocation: .reference(WorkspaceReference(
                tree: treeID,
                path: resolution.ref.path,
                stableKey: resolution.ref.stableKey
            )),
            detail: "Visiting \(rootLocator) · read-only",
            canonicalPath: tree.canonicalPath
        )
        openVisitLocator = rootLocator
        syncPresentation = WorkspaceSyncPresentation(
            state: .current,
            detail: "Read-only visit; following \(remote.origin.host() ?? remote.origin.absoluteString)",
            acceptedRoot: tree.root,
            localRoot: tree.root
        )
        visitFollowTask = ArborVisitFollower(client: client, tree: tree.id, workingTree: workingTree) { [weak self] in
            await self?.noteVisitChanged(workingTree)
        }.start(after: resolution.observedThrough)
        prefetchLocalArborSyncOverview()
    }

    private func openWritableRemoteTree(
        tree: WireTreeDescriptor,
        locator: String,
        client: ArborWireClient,
        platform: any ObjectStore
    ) async throws {
        let transport = ArborWireReplicaTransport(client: client)
        let key = ArborSupportDirectories.workingTreeKey(tree.id)
        let replicaRoot = ArborSupportDirectories.remoteWorkingTrees
            .appending(path: key, directoryHint: .isDirectory)
        let syncStateRoot = ArborSupportDirectories.remoteSync
            .appending(path: key, directoryHint: .isDirectory)
        let workingTree = try await Self.openOrPlaceWorkingTree(
            tree,
            replicaRoot: replicaRoot,
            syncStateRoot: syncStateRoot,
            recoveryNames: (workingTree: "RemoteWorkingTree", sync: "RemoteSync"),
            transport: transport,
            platform: platform
        )
        let (coordinator, provider) = try synchronizedProvider(
            workingTree: workingTree,
            transport: transport,
            stateRoot: syncStateRoot,
            sourceObjectStore: workingTree
        )
        await switchProvider(
            provider,
            home: WorkspaceReference(tree: TreeID(rawValue: tree.id), path: "/"),
            detail: "Working tree · \(locator)",
            canonicalPath: tree.canonicalPath
        )
        openVisitLocator = locator
        try await installSyncCoordinator(coordinator, client: client, tree: tree)
        startInitialSync(coordinator)
        prefetchLocalArborSyncOverview()
    }

    private func noteVisitChanged(_ workingTree: WorkingTree) async {
        guard openVisitLocator != nil, let heads = try? await workingTree.heads() else { return }
        syncPresentation = WorkspaceSyncPresentation(
            state: .current,
            detail: "Read-only visit; following the server",
            acceptedRoot: heads.acceptedRoot,
            localRoot: heads.materializedRoot,
            remoteAdditions: true
        )
    }

    /// The trees visited before, most recent first.
    func recentVisits() async -> [LocalArborSyncVisitPresentation] {
        ((try? await visitedTreeStore.loadAll()) ?? []).map(Self.visitPresentation)
    }

    private static func visitPresentation(_ visit: VisitedTreeRecord) -> LocalArborSyncVisitPresentation {
        LocalArborSyncVisitPresentation(
            id: visit.tree.id,
            tree: visit.tree.id,
            name: visit.tree.canonicalPath.map { path in
                path.split(separator: "/").last.map(String.init) ?? path
            } ?? visit.tree.id,
            locator: visit.locator,
            canonical: visit.tree.httpURL
        )
    }

    // MARK: Restore and reconnect

    /// Reopen the last placed tree, if any. When its folder is on disk the
    /// tree is shown from it at once, read-only, while the daemon attach,
    /// bootstrap and update coordinator confirm a basis for edits; the
    /// confirmed tree then replaces the preview in place.
    func restoreLocalWorkspaceIfAvailable() async {
        guard !attemptedWorkspaceRestore else { return }
        attemptedWorkspaceRestore = true
        let record: NativePlacementRecord?
        do {
            nativePlacements = try await nativePlacementStore.loadAll()
            record = try await nativePlacementStore.load()
        } catch {
            // An unreadable placement store opens like a fresh installation.
            Self.recordDiagnostic("placement-restore", error)
            nativePlacements = []
            record = nil
        }
        if let record, !launchPhase.isPreviewing, let osPath = record.osPath,
           FileManager.default.fileExists(atPath: osPath) {
            let tree = TreeID(rawValue: record.tree.id)
            if let preview = try? await LocalFolderPreview.workingTree(tree: tree, folder: URL(filePath: osPath)) {
                await switchProvider(
                    WorkingTreeProvider(
                        workingTree: preview,
                        readOnly: true,
                        materializedRoot: URL(filePath: osPath, directoryHint: .isDirectory)
                    ),
                    home: WorkspaceReference(tree: tree, path: "/"),
                    detail: "Connecting · \(record.displayName) · \(osPath)",
                    canonicalPath: record.tree.canonicalPath,
                    recoversEdits: false
                )
                launchPhase = .confirming(record.displayName)
            }
        }
        do {
            if let record {
                if !launchPhase.isPreviewing { launchPhase = .restoring(record.displayName) }
                try await openPlacedTree(record.tree.id)
            } else {
                launchPhase = .empty(nil)
                try await ensureArborSync()
                syncPresentation = WorkspaceSyncPresentation(
                    state: .offline,
                    detail: "Choose a local tree to open"
                )
                prefetchLocalArborSyncOverview()
            }
        } catch {
            let message = Self.bootstrapFailureMessage(error, processKind: arborsyncProcessKind)
            if case let .confirming(name) = launchPhase {
                // Keep showing the folder; it just cannot be edited yet.
                launchPhase = .unconfirmed(name, message)
            } else {
                launchPhase = .empty(message)
            }
            if arborsyncClient != nil { prefetchLocalArborSyncOverview() }
        }
    }

    /// Try the launch restore again after a failure.
    func retryRestore() async {
        attemptedWorkspaceRestore = false
        if case let .unconfirmed(name, _) = launchPhase { launchPhase = .confirming(name) }
        await restoreLocalWorkspaceIfAvailable()
    }

    /// Reconnect to the control-mode daemon and re-open whatever was open.
    func restartArborSync() async {
        do {
            try await editorWorkspace.flushAll()
            let supervisor = self.supervisor ?? ArborSyncProcessSupervisor(launchPolicy: .automatic)
            self.supervisor = supervisor
            overviewRefreshTask?.cancel()
            overviewRefreshTask = nil
            overviewWatchTask?.cancel()
            overviewWatchTask = nil
            overviewEventRefreshTask?.cancel()
            overviewEventRefreshTask = nil
            if arborsyncClient != nil {
                let runtime = try await supervisor.restartControl()
                arborsyncClient = runtime.client
                arborsyncProcessKind = runtime.attachedToExistingProcess ? .external : .supervised
            } else {
                try await ensureArborSync()
            }
            errorMessage = nil
            if let openPlacedTreeID {
                try await openPlacedTree(openPlacedTreeID)
            } else if let openVisitLocator {
                try await openRemoteLocator(openVisitLocator)
            } else {
                syncPresentation = WorkspaceSyncPresentation(state: .offline, detail: "Choose a local tree to open")
                prefetchLocalArborSyncOverview()
            }
        } catch {
            errorMessage = Self.bootstrapFailureMessage(error, processKind: arborsyncProcessKind)
            syncPresentation = WorkspaceSyncPresentation(state: .offline, detail: error.localizedDescription)
        }
    }

    func arborsyncLogs() async -> String {
        await supervisor?.logs() ?? "No arborsync process is connected."
    }

    func refreshLocalArborSyncOverview() async {
        if let overviewRefreshTask {
            await overviewRefreshTask.value
            return
        }
        overviewRefreshID += 1
        let refreshID = overviewRefreshID
        let task = Task { @MainActor [weak self] in
            guard let self else { return }
            self.localArborSyncOverviewIsRefreshing = true
            defer {
                if self.overviewRefreshID == refreshID {
                    self.localArborSyncOverviewIsRefreshing = false
                    self.overviewRefreshTask = nil
                }
            }
            do {
                let overview = try await self.loadLocalArborSyncOverview()
                guard !Task.isCancelled else { return }
                self.localArborSyncOverview = overview
                self.localArborSyncOverviewError = nil
                self.startLocalOverviewWatch(after: overview.observedThrough)
                await self.refreshDirectory()
            } catch is CancellationError {
                return
            } catch {
                self.localArborSyncOverviewError = error.localizedDescription
            }
        }
        overviewRefreshTask = task
        await task.value
    }

    private func prefetchLocalArborSyncOverview() {
        Task { await refreshLocalArborSyncOverview() }
    }

    /// The daemon's view of this installation: `/v1/trees` and `/v1/accounts`
    /// only. Visits are the app's own; the legacy singleton account on disk
    /// still supplies device rows when no plural account exists.
    private func loadLocalArborSyncOverview() async throws -> LocalArborSyncOverview {
        guard let client = arborsyncClient else { throw ArborSyncSupervisorError.serviceUnavailable }
        async let treeListRequest = client.trees()
        async let accountsRequest = client.accounts()
        let (treeList, accounts) = try await (treeListRequest, accountsRequest)
        let localConfiguration = accounts.isEmpty ? try? loadLocalAccountConfiguration() : nil
        let configurationTree = treeList.snapshot.first { $0.kind == "account-configuration" }?.id
        let trees = treeList.snapshot.map {
            LocalArborSyncTreePresentation(
                id: $0.id,
                configurationTree: $0.configurationTree,
                kind: $0.kind,
                name: $0.name,
                canonicalPath: $0.canonical?.path,
                path: $0.osPath,
                placement: $0.placement,
                access: $0.access,
                sync: $0.sync,
                reviewableConflict: $0.reviewableConflict == true,
                missing: $0.missing == true
            )
        }
        let visits = await recentVisits()
        return LocalArborSyncOverview(
            origin: accounts.first?.canopy ?? localConfiguration?.origin,
            handle: accounts.first?.handle ?? localConfiguration?.handle,
            configurationTree: configurationTree,
            credentialAvailable: accounts.contains(where: \.credentialAvailable),
            accounts: accounts,
            trees: trees,
            visits: visits,
            devices: localConfiguration?.devices ?? [],
            observedThrough: treeList.observedThrough
        )
    }

    private func loadLocalAccountConfiguration() throws -> LocalAccountConfigurationPresentation {
        let home = ArborSupportDirectories.dataHome
        let accountSource = try String(contentsOf: home.appending(path: "account.yaml"), encoding: .utf8)
        let administrators = Set(yamlSequence(named: "admins", in: accountSource))
        let currentDeviceURL = home.appending(path: ".state/device.json")
        let currentDeviceState = try? JSONDecoder().decode(
            [String: String].self,
            from: Data(contentsOf: currentDeviceURL)
        )
        let currentDevice = currentDeviceState?["id"]
        let devicesURL = home.appending(path: "devices", directoryHint: .isDirectory)
        let files = try FileManager.default.contentsOfDirectory(
            at: devicesURL,
            includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles]
        )
        let devices = try files.compactMap { url -> LocalArborSyncDevicePresentation? in
            guard url.pathExtension == "yaml" else { return nil }
            let id = url.deletingPathExtension().lastPathComponent
            guard id.hasPrefix("dv_") else { return nil }
            let source = try String(contentsOf: url, encoding: .utf8)
            return LocalArborSyncDevicePresentation(
                id: id,
                label: yamlScalar(named: "label", in: source) ?? id,
                isAdministrator: administrators.contains(id),
                isCurrent: currentDevice == id
            )
        }.sorted { lhs, rhs in
            if lhs.isCurrent != rhs.isCurrent { return lhs.isCurrent }
            return lhs.label.localizedCaseInsensitiveCompare(rhs.label) == .orderedAscending
        }
        return LocalAccountConfigurationPresentation(
            origin: yamlScalar(named: "community", in: accountSource),
            handle: yamlScalar(named: "handle", in: accountSource),
            administrators: administrators,
            currentDevice: currentDevice,
            devices: devices
        )
    }

    private func yamlScalar(named name: String, in source: String) -> String? {
        for rawLine in source.split(separator: "\n", omittingEmptySubsequences: false) {
            let line = rawLine.trimmingCharacters(in: .whitespaces)
            guard line.hasPrefix("\(name):") else { continue }
            return decodeYAMLScalar(String(line.dropFirst(name.count + 1)))
        }
        return nil
    }

    private func yamlSequence(named name: String, in source: String) -> [String] {
        let lines = source.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        guard let start = lines.firstIndex(where: { $0.trimmingCharacters(in: .whitespaces) == "\(name):" }) else {
            return []
        }
        let indentation = lines[start].prefix { $0 == " " }.count
        var values: [String] = []
        for line in lines.dropFirst(start + 1) {
            if line.trimmingCharacters(in: .whitespaces).isEmpty { continue }
            let lineIndentation = line.prefix { $0 == " " }.count
            guard lineIndentation > indentation else { break }
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard trimmed.hasPrefix("-") else { continue }
            if let value = decodeYAMLScalar(String(trimmed.dropFirst())) { values.append(value) }
        }
        return values
    }

    private func decodeYAMLScalar(_ source: String) -> String? {
        let value = source.trimmingCharacters(in: .whitespaces)
        guard !value.isEmpty else { return nil }
        if value.hasPrefix("\"") {
            return try? JSONDecoder().decode(String.self, from: Data(value.utf8))
        }
        if value.hasPrefix("'"), value.hasSuffix("'"), value.count >= 2 {
            return String(value.dropFirst().dropLast()).replacingOccurrences(of: "''", with: "'")
        }
        if let comment = value.range(of: " #") { return String(value[..<comment.lowerBound]) }
        return value
    }

    private func startLocalOverviewWatch(after cursor: String) {
        guard overviewWatchTask == nil, let client = arborsyncClient else { return }
        overviewWatchTask = Task { @MainActor [weak self] in
            do {
                let observations = await client.observations(after: cursor)
                for try await event in observations {
                    guard !Task.isCancelled else { return }
                    guard Self.localOverviewEventRequiresRefresh(
                        tree: event.tree,
                        origin: event.change.origin,
                        configurationTree: self?.localArborSyncOverview?.configurationTree
                    ) else { continue }
                    self?.scheduleLocalOverviewRefresh()
                }
            } catch is CancellationError {
                return
            } catch let error as ArborSyncServerError where error.value.code == "resync-required" {
                // A daemon restart creates a new process-wide event cursor. Reload
                // from its current overview, then let that refresh install a watch
                // beginning at the replacement daemon's cursor.
                self?.overviewWatchTask = nil
                await self?.refreshLocalArborSyncOverview()
                return
            } catch {
                self?.localArborSyncOverviewError = error.localizedDescription
            }
            self?.overviewWatchTask = nil
        }
    }

    private func scheduleLocalOverviewRefresh() {
        guard overviewEventRefreshTask == nil else { return }
        overviewEventRefreshTask = Task { @MainActor [weak self] in
            do { try await Task.sleep(for: Self.overviewEventCoalescing) } catch { return }
            guard let self else { return }
            self.overviewEventRefreshTask = nil
            await self.refreshLocalArborSyncOverview()
        }
    }

    func createLocalArborSyncPairing(configurationTree: String? = nil) async throws -> LocalArborSyncPairingPresentation {
        guard let client = arborsyncClient else { throw ArborSyncSupervisorError.serviceUnavailable }
        if localArborSyncOverview == nil { await refreshLocalArborSyncOverview() }
        guard let overview = localArborSyncOverview else {
            throw ArborSyncSupervisorError.incompatibleService("The account list is unavailable")
        }
        let selected = configurationTree.flatMap { id in overview.accounts.first { $0.configurationTree == id } }
        guard let rawOrigin = selected?.canopy ?? overview.origin,
              let origin = URL(string: rawOrigin) else {
            throw ArborSyncSupervisorError.incompatibleService("The community origin is invalid")
        }
        let rawOffer = try await client.createCommunityPairing(configurationTree: configurationTree)
        let offer = try rawOffer.validated()
        let payload = PairingPayload(
            origin: origin,
            pairing: .init(id: offer.id, secret: offer.secret)
        )
        let data = try JSONEncoder().encode(payload)
        return LocalArborSyncPairingPresentation(
            payload: String(decoding: data, as: UTF8.self),
            confirmationCode: offer.confirmationCode
        )
    }

    func revokeLocalArborSyncDevice(_ id: String) async throws {
        let configuration = try loadLocalAccountConfiguration()
        guard let target = configuration.devices.first(where: { $0.id == id }) else {
            throw ArborSyncSupervisorError.incompatibleService("The device is no longer active")
        }
        let currentIsAdministrator = configuration.currentDevice.map(configuration.administrators.contains) == true
        guard target.isCurrent || currentIsAdministrator else {
            throw ArborSyncSupervisorError.incompatibleService("Only an administrator can revoke another device")
        }
        if target.isAdministrator {
            guard configuration.administrators.count > 1 else {
                throw ArborSyncSupervisorError.incompatibleService("The last administrator cannot be revoked")
            }
            let accountURL = ArborSupportDirectories.dataHome.appending(path: "account.yaml")
            let source = try String(contentsOf: accountURL, encoding: .utf8)
            let lines = source.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
            let filtered = lines.filter { line in
                let trimmed = line.trimmingCharacters(in: .whitespaces)
                guard trimmed.hasPrefix("-") else { return true }
                return decodeYAMLScalar(String(trimmed.dropFirst())) != id
            }
            guard filtered.count == lines.count - 1 else {
                throw ArborSyncSupervisorError.incompatibleService("The administrator entry could not be edited safely")
            }
            try (filtered.joined(separator: "\n")).write(to: accountURL, atomically: true, encoding: .utf8)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: accountURL.path)
        }
        let deviceURL = ArborSupportDirectories.dataHome.appending(path: "devices/\(id).yaml")
        try FileManager.default.removeItem(at: deviceURL)
        try await Task.sleep(for: .milliseconds(250))
        try await refreshLocalArborSyncDevices()
    }

    private func refreshLocalArborSyncDevices() async throws {
        guard let overview = localArborSyncOverview else { return }
        localArborSyncOverview = LocalArborSyncOverview(
            origin: overview.origin,
            handle: overview.handle,
            configurationTree: overview.configurationTree,
            credentialAvailable: overview.credentialAvailable,
            accounts: overview.accounts,
            trees: overview.trees,
            visits: overview.visits,
            devices: try loadLocalAccountConfiguration().devices,
            observedThrough: overview.observedThrough
        )
    }
#endif

    static func bootstrapFailureMessage(_ error: Error, processKind: ArborSyncProcessKind?) -> String {
        guard let diagnostic = ArborSaveDiagnostic.describe(error, processKind: processKind, context: .bootstrap) else {
            return error.localizedDescription
        }
        return "\(diagnostic.bannerMessage) \(diagnostic.recovery)"
    }

    static func localOverviewEventRequiresRefresh(
        tree: String,
        origin: String,
        configurationTree: String?
    ) -> Bool {
        tree == "system" || tree == configurationTree || origin == "sync"
    }

    func refreshDirectory(force: Bool = false) async {
        if let directoryRefreshTask {
            await directoryRefreshTask.value
            return
        }
        let task = Task { @MainActor [weak self] in
            guard let self else { return }
            self.directoryIsRefreshing = true
            defer {
                self.directoryIsRefreshing = false
                self.directoryRefreshTask = nil
            }
            var failures: [String] = []
#if os(macOS)
            let accounts = self.localArborSyncOverview?.accounts ?? []
            var seen = Set<String>()
            for account in accounts where account.credentialAvailable {
                guard let rawOrigin = account.canopy, seen.insert(rawOrigin).inserted,
                      let origin = URL(string: rawOrigin) else { continue }
                do {
                    if !force, let fetched = try await self.directoryStore.fetchedAt(origin: origin),
                       Date().timeIntervalSince(fetched) < 60 { continue }
                    let snapshot = try await self.wireClient(origin: origin, overview: self.localArborSyncOverview).directory()
                    try await self.directoryStore.save(origin: origin, entries: snapshot.snapshot)
                } catch { failures.append("\(origin.host() ?? rawOrigin): \(error.localizedDescription)") }
            }
#else
            var seen = Set<String>()
            for placement in self.nativePlacements {
                let key = "\(placement.origin.absoluteString)|\(placement.configurationTree ?? "")"
                guard seen.insert(key).inserted else { continue }
                do {
                    if !force, let fetched = try await self.directoryStore.fetchedAt(origin: placement.origin),
                       Date().timeIntervalSince(fetched) < 60 { continue }
                    let snapshot = try await NativeAccountService(
                        origin: placement.origin,
                        configurationTree: placement.configurationTree
                    ).directory()
                    try await self.directoryStore.save(origin: placement.origin, entries: snapshot.snapshot)
                } catch { failures.append("\(placement.origin.host() ?? placement.origin.absoluteString): \(error.localizedDescription)") }
            }
#endif
            self.directory = (try? await self.directoryStore.load()) ?? self.directory
            self.directoryError = failures.isEmpty ? nil : failures.joined(separator: "\n")
        }
        directoryRefreshTask = task
        await task.value
    }

    func avatarData(for person: DirectoryPerson) async throws -> Data {
        guard let avatar = person.entry.avatar else {
            throw ArborWireValidationError.invalidValue("Directory entry has no avatar")
        }
#if os(macOS)
        return try await wireClient(origin: person.origin, overview: localArborSyncOverview)
            .object(tree: avatar.tree, hash: avatar.hash)
#else
        let configurationTree = try await connectedConfigurationTree(for: person.origin)
        return try await NativeAccountService(origin: person.origin, configurationTree: configurationTree)
            .object(tree: avatar.tree, hash: avatar.hash)
#endif
    }

    func openDirectoryProfile(_ person: DirectoryPerson) async throws {
#if os(macOS)
        guard let locator = person.entry.locator else {
            throw ArborWireValidationError.invalidValue("Profile is not hosted on this Canopy")
        }
        try await openRemoteLocator(locator)
#else
        let configurationTree = try await connectedConfigurationTree(for: person.origin)
        let service = NativeAccountService(origin: person.origin, configurationTree: configurationTree)
        guard let tree = try await service.trees().snapshot.first(where: { $0.id == person.entry.profile }) else {
            throw ArborWireValidationError.invalidValue("Profile is not hosted on this Canopy")
        }
        try await place(tree: tree, from: person.origin, configurationTree: configurationTree)
#endif
    }

#if os(iOS)
    /// The configuration tree of the account this iPhone holds at `origin`.
    private func connectedConfigurationTree(for origin: URL) async throws -> String {
        let account = try await KeychainDeviceCredentialStore().accounts().first {
            Self.sameOrigin($0.origin, origin)
        }
        guard let account else { throw ArborWireValidationError.invalidValue("No account is connected to this Canopy") }
        return account.configurationTree
    }
#endif

    /// Follow a nested-tree boundary through the same account-aware paths used
    /// by People. Prefer an existing Mac placement, then the hosted profile
    /// locator carried by the directory.
    func openNestedTree(_ tree: TreeID) async throws {
#if os(macOS)
        if localArborSyncOverview?.trees.contains(where: {
            $0.id == tree.rawValue && $0.path != nil && $0.missing != true
        }) == true {
            try await openPlacedTree(tree.rawValue)
            return
        }
        if let locator = navigationLocators[tree] {
            try await openRemoteLocator(locator)
            return
        }
#else
        if let placement = try await nativePlacementStore.loadAll().first(where: { $0.tree.id == tree.rawValue }) {
            try await place(tree: placement.tree, from: placement.origin, configurationTree: placement.configurationTree)
            return
        }
#endif
        guard let person = directory.first(where: {
            $0.entry.profile == tree.rawValue && $0.entry.locator != nil
        }) else {
            throw ArborWireValidationError.invalidValue(
                "The nested tree \(tree.rawValue) is not hosted by a connected Canopy."
            )
        }
        try await openDirectoryProfile(person)
    }

    func syncNow(reportTransientNetworkErrors: Bool = true) async {
        guard let syncCoordinator else { return }
        do {
            // Manual and lifecycle refreshes must pull a clean replica as well
            // as reconcile a locally pending one. `syncOnce()` alone expresses
            // a local candidate and can leave a clean, stale replica dependent
            // on an indefinitely open watch connection.
            syncPresentation = try await syncCoordinator.recoverWatchGap()
        }
        catch {
            syncPresentation = (try? await syncCoordinator.presentation())
                ?? WorkspaceSyncPresentation(state: .offline, detail: String(describing: error))
            if let message = Self.syncErrorMessage(
                for: error,
                reportTransientNetworkErrors: reportTransientNetworkErrors
            ) {
                errorMessage = message
            }
        }
    }

    static func syncErrorMessage(
        for error: Error,
        reportTransientNetworkErrors: Bool
    ) -> String? {
        if !reportTransientNetworkErrors, isTransientNetworkError(error) { return nil }
        return error.localizedDescription
    }

    /// Suspension routinely cancels URLSession work, and the network path can
    /// still be settling when an iOS scene becomes active. These failures are
    /// already represented by `syncPresentation` and retried by the watch/path
    /// machinery; lifecycle catch-up must not also turn them into red banners.
    static func isTransientNetworkError(_ error: Error) -> Bool {
        if error is CancellationError { return true }
        let value = error as NSError
        guard value.domain == NSURLErrorDomain else { return false }
        let code = URLError.Code(rawValue: value.code)
        return switch code {
        case .cancelled,
             .timedOut,
             .cannotFindHost,
             .cannotConnectToHost,
             .networkConnectionLost,
             .dnsLookupFailed,
             .notConnectedToInternet,
             .internationalRoamingOff,
             .callIsActive,
             .dataNotAllowed:
            true
        default:
            false
        }
    }

    private func refreshSyncPresentation(from coordinator: UpdateCoordinator) async {
        guard syncCoordinator === coordinator else { return }
        capabilities = await provider.capabilities()
        let previous = syncPresentation
        syncPresentation = (try? await coordinator.presentation())
            ?? WorkspaceSyncPresentation(state: .offline, detail: "Immediate synchronization failed")
        if previous != syncPresentation {
            var note = WireNetworkLogEntry(kind: .note, name: "presentation")
            note.error = "\(syncPresentation.state) · \(syncPresentation.detail ?? "")"
            WireNetworkLog.current?.record(note)
        }
        // Choices only change with the accepted state, so re-inspect when the
        // accepted root or conflict flag moves (or a review submission is
        // waiting), not on every local save or watch echo.
        let acceptedChanged = previous.acceptedRoot != syncPresentation.acceptedRoot
            || previous.acceptedConflicted != syncPresentation.acceptedConflicted
        if let review = conflictReview,
           syncPresentation.acceptedConflicted == true || review.hasEntries,
           acceptedChanged || review.pending {
            review.scheduleRefresh()
        }
    }

    func flush() async {
        do { try await conflictReview?.flushDraft() }
        catch { errorMessage = "Retaining the review draft did not finish: \(error.localizedDescription)" }
        do { try await editorWorkspace.flushAll() }
        catch { errorMessage = "Retaining edits locally did not finish: \(error.localizedDescription)" }
    }

    func deliverVoiceTranscript(_ transcript: String, to stableKey: String) async throws {
        try await editorWorkspace.appendTranscript(
            transcript,
            to: stableKey,
            in: home.tree
        )
    }

    func shutdown() async {
        await flush()
        await editorWorkspace.closeAll()
        serverWatchTask?.cancel()
        serverWatchTask = nil
        nativePathMonitor.cancel()
#if os(macOS)
        visitFollowTask?.cancel()
        visitFollowTask = nil
        initialSyncTask?.cancel()
        initialSyncTask = nil
        overviewRefreshTask?.cancel()
        overviewWatchTask?.cancel()
        overviewRefreshTask = nil
        overviewWatchTask = nil
        overviewEventRefreshTask?.cancel()
        overviewEventRefreshTask = nil
        if let syncCoordinator { await syncCoordinator.close() }
        syncCoordinator = nil
        conflictReview = nil
        if let supervisor { await supervisor.stop() }
        arborsyncClient = nil
        arborsyncProcessKind = nil
#endif
    }

    @discardableResult
    func perform(_ action: WorkspaceStructuralAction) async throws -> WorkspaceNode? {
        try await performWithReceipt(action).result
    }

    /// Perform `action` and return its own receipt. `latestStructuralReceipt`
    /// announces the receipt to every window, but a later action may already
    /// have replaced it by the time the caller reads it.
    func performWithReceipt(_ action: WorkspaceStructuralAction) async throws -> WorkspaceStructuralReceipt {
        let healingSources = await editorWorkspace.linkHealingSources(for: action)
        let movedFrom: String? = switch action {
        case let .rename(reference, _), let .move(reference, _): reference.path
        default: nil
        }
        let result = try await provider.perform(action)
        let receipt = WorkspaceStructuralReceipt(action: action, result: result)
        latestStructuralReceipt = receipt
        if let result, let movedFrom, !healingSources.isEmpty {
            await editorWorkspace.healLinks(
                in: healingSources,
                movedFrom: movedFrom,
                to: result.reference
            )
        }
        return receipt
    }

    func switchProvider(
        _ nextProvider: any WorkspaceProvider,
        home nextHome: WorkspaceReference,
        launchLocation nextLaunchLocation: WorkspaceLocation? = nil,
        detail: String,
        canonicalPath: String? = nil,
        preservingNavigation: Bool = false,
        recoversEdits: Bool = true
    ) async {
#if os(macOS)
        if let locator = openVisitLocator { navigationLocators[home.tree] = locator }
#endif
        await editorWorkspace.closeAll()
        conflictReview = nil
        provider = nextProvider
        // A read-only preview never keeps editor recovery drafts.
        editorWorkspace = ArborEditorWorkspace(provider: nextProvider, recoveryRoot: recoversEdits ? editorRecoveryRoot : nil)
        home = nextHome
        launchLocation = nextLaunchLocation ?? .reference(nextHome)
        providerDetail = detail
        currentTreeCanonicalPath = canonicalPath
        capabilities = await nextProvider.capabilities()
        latestStructuralReceipt = nil
        if preservingNavigation { providerRevision += 1 } else { generation += 1 }
        errorMessage = nil
    }

    private func startServerWatch(
        client: ArborWireClient,
        tree: WireTreeDescriptor,
        coordinator: UpdateCoordinator
    ) {
        serverWatchTask = CanopyWatchRunner(client: client, tree: tree.id, coordinator: coordinator) { [weak self] in
            await self?.refreshSyncPresentation(from: coordinator)
        }.start()
    }

    static func sameOrigin(_ lhs: URL, _ rhs: URL) -> Bool {
        lhs.scheme?.lowercased() == rhs.scheme?.lowercased()
            && lhs.host()?.lowercased() == rhs.host()?.lowercased()
            && lhs.port == rhs.port
    }

    /// Record a failure that no banner reports as a network-log note, where
    /// sync diagnostics are read.
    static func recordDiagnostic(_ name: String, _ error: Error) {
        var note = WireNetworkLogEntry(kind: .note, name: name)
        note.error = error.localizedDescription
        WireNetworkLog.current?.record(note)
    }
}

@MainActor
@Observable
final class ArborAppModel {
    private static let manuallyNamedPagesDefaultsKey = "Canopy.manuallyNamedPages"

    private struct PagePresentationKey: Hashable {
        let tabID: UUID
        let location: WorkspaceLocation
    }

    struct PagePresentation {
        let node: WorkspaceNode
        let children: [WorkspaceNode]
        let editorLease: ArborEditorLease?
        let editorHost: ArborEditorHost?
        let backlinks: [WorkspaceSearchResult]
    }

    struct TitleRenameProposal: Identifiable, Equatable {
        var reference: WorkspaceReference
        var proposedName: String
        var id: String { "\(reference.identity)|\(proposedName)" }
    }

    struct LinkedPageTrashPrompt: Identifiable {
        let id = UUID()
        let target: WorkspaceReference
        let source: WorkspaceReference
        let title: String
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
    private(set) var isLoading = false
    private(set) var titleRenameProposal: TitleRenameProposal?
    private(set) var linkedPageTrashPrompt: LinkedPageTrashPrompt?
    private var retainedPagePresentations: [PagePresentationKey: PagePresentation] = [:]
    private var observedWorkspaceGeneration: Int
    private var observedProviderRevision: Int
    private var isSwitchingNavigationTree = false
    private let openNavigationTree: @MainActor (TreeID) async throws -> Void
    private var loadRequestID = 0
    private var backlinksRequestID = 0
    private var lastSearchQuery = ""
    /// Every page of `pageIndexTree`, fetched once and filtered per query.
    /// Set `pageIndexIsStale` wherever the tree may have changed; a change in
    /// the sync presentation's roots also marks it stale.
    private var pageIndexTree: TreeID?
    private var pageIndexResults: [WorkspaceSearchResult] = []
    private var pageIndexIsStale = true
    private var pageIndexSyncBasis: [String?] = []
    private var pageIndexRequestID = 0
    private var dismissedTitleRenameProposals = Set<String>()
    private var manuallyNamedPageKeys = Set(
        UserDefaults.standard.stringArray(forKey: manuallyNamedPagesDefaultsKey) ?? []
    )

    init(
        workspace: ArborWorkspaceState,
        openNavigationTree: (@MainActor (TreeID) async throws -> Void)? = nil
    ) {
        self.workspace = workspace
        self.openNavigationTree = openNavigationTree ?? { try await workspace.openNestedTree($0) }
        self.tabs = BrowserTabController(launchLocation: workspace.launchLocation)
        self.sidebarLocation = workspace.launchLocation
        self.observedWorkspaceGeneration = workspace.generation
        self.observedProviderRevision = workspace.providerRevision
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

    private func manualPageNameKey(_ reference: WorkspaceReference) -> String {
        "\(reference.tree.rawValue)|\(reference.stableKey ?? reference.path)"
    }
    var canGoBack: Bool { tabs.canGoBack }
    var canGoForward: Bool { tabs.canGoForward }
    var canGoParent: Bool { tabs.canGoParent }
    var canGoHome: Bool {
        guard let home = treeHomeLocation else { return false }
        return currentLocation != home
    }
    var selectedTabID: UUID { tabs.selectedTabID }
    var tabItems: [BrowserTab] { tabs.tabs }
    var binding: ArborDocumentBinding? { editorLease?.binding }
    var navigationRoot: WorkspaceLocation { tabs.navigationRoot }
    var navigationPath: [WorkspaceLocation] { tabs.navigationPath }

    func pagePresentation(for location: WorkspaceLocation) -> PagePresentation? {
        if !isLoading, let node, node.location == location {
            return PagePresentation(
                node: node,
                children: children,
                editorLease: editorLease,
                editorHost: editorHost,
                backlinks: backlinks
            )
        }
        return retainedPagePresentations[PagePresentationKey(tabID: selectedTabID, location: location)]
    }

    func resetForWorkspace() async {
        // Before a tree is shown (launch is still restoring, or nothing is
        // open) there is no page to load; the window shows the launch view.
        guard workspace.launchPhase.showsTree, !isSwitchingNavigationTree else { return }
        guard observedWorkspaceGeneration != workspace.generation else {
            // A tree-history transition may already be loading its destination.
            // The mounted view's generation task must not supersede that load.
            if node == nil, !isLoading { await load() }
            return
        }
        observedWorkspaceGeneration = workspace.generation
        // A failure against the provider being replaced must not show as
        // "Unable to open" while the new provider's page loads.
        errorMessage = nil
        Self.cancelMoveRequests(of: editorHost)
        await releaseAllPagePresentations()
        tabs = BrowserTabController(launchLocation: workspace.launchLocation)
        sidebarLocation = workspace.launchLocation
        searchResults = []
        lastSearchQuery = ""
        pageIndexTree = nil
        pageIndexResults = []
        await load()
    }

    /// The workspace replaced its provider with one presenting the same tree
    /// at the same locations (a launch preview becoming the confirmed tree).
    /// Tabs and history stay; the current page reloads in place, with its old
    /// presentation on screen until the new one is ready.
    func reloadForProviderRevision() async {
        guard !isSwitchingNavigationTree, observedProviderRevision != workspace.providerRevision else { return }
        observedProviderRevision = workspace.providerRevision
        retainCurrentPagePresentation()
        let key = PagePresentationKey(tabID: selectedTabID, location: currentLocation)
        // Every other retained page holds a binding from the closed provider.
        retainedPagePresentations = retainedPagePresentations.filter { $0.key == key }
        await load()
        if node != nil { retainedPagePresentations.removeValue(forKey: key) }
    }

    func load() async {
        loadRequestID += 1
        let requestID = loadRequestID
        isLoading = true
        linkedPageTrashPrompt = nil
        if let editorLease {
            Self.cancelMoveRequests(of: editorHost)
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
            let loadedChildren = nestedProfileTitles(
                in: try await workspace.provider.children(of: sidebarBase),
                parent: resolved
            )
            guard requestID == loadRequestID, observedWorkspaceGeneration == workspace.generation else { return }
            tabs.replaceCurrent(with: resolved.location)
            node = resolved
            children = loadedChildren
            if searchResults.isEmpty {
                searchResults = loadedChildren.map {
                    WorkspaceSearchResult(reference: $0.reference, title: $0.title)
                }
            }
            sidebarLocation = sidebarBase
            // A launch preview shows pages in the editor too, so confirming the
            // tree changes nothing on screen; the view blocks input meanwhile.
            if resolved.surface.supportsDocumentSession {
                let lease = try await workspace.editorWorkspace.lease(resolved.reference)
                guard requestID == loadRequestID else {
                    await workspace.editorWorkspace.release(lease)
                    return
                }
                if case .directoryDocument = resolved.surface {
                    lease.binding.projectDirectoryChildren(loadedChildren, in: resolved.reference)
                }
                editorLease = lease
                let relativeReferenceBase: WorkspaceReference
                switch resolved.surface {
                case .directoryDocument:
                    relativeReferenceBase = resolved.reference
                default:
                    relativeReferenceBase = resolved.reference.parent ?? resolved.reference
                }
                editorHost = ArborEditorHost(
                    binding: lease.binding,
                    provider: workspace.provider,
                    linkPreviewService: workspace.linkPreviewService,
                    relativeReferenceBase: relativeReferenceBase,
                    open: { [weak self] reference in Task { await self?.navigate(to: reference) } },
                    navigateBack: { [weak self] in Task { await self?.goBack() } },
                    reportError: { [weak self] message in self?.errorMessage = message },
                    performStructuralAction: { [weak self, weak workspace] action in
                        guard let receipt = try await workspace?.performWithReceipt(action) else { return nil }
                        await self?.reconcile(receipt)
                        return receipt.result
                    },
                    offerTrashAfterDeletingLink: { [weak self] target, source in
                        self?.offerToTrashLinkedPage(target, from: source)
                    }
                )
            }
            errorMessage = nil
            titleRenameProposal = nil
            isLoading = false
            Task { await self.loadBacklinks() }
            pageIndexIsStale = true
            Task { await self.search(self.lastSearchQuery) }
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
        await transition(preparing: location) { tabs.navigate(to: location) }
    }

    /// Leave the current page for the one `move` makes current: retain edits
    /// and the page's presentation, reopen the destination's tree when it
    /// names another one, then show the destination.
    private func transition(preparing destination: WorkspaceLocation? = nil, _ move: () -> Void) async {
        await binding?.flush()
        if let destination {
            guard await prepareWorkspace(for: destination) else { return }
        }
        retainCurrentPagePresentation()
        move()
        await loadOrRestoreCurrentPage()
    }

    func navigate(to reference: WorkspaceReference) async {
        await navigate(to: location(for: reference))
    }

    func updatePersonalProfile(
        displayName: String,
        description: String,
        photo: WorkspaceAsset? = nil
    ) async throws {
        guard currentReference.path == "/", let binding else {
            throw ArborWireValidationError.invalidValue("Open the profile home page before editing its details")
        }
        let avatarPath: String?
        if let photo {
            let stored = try await workspace.provider.store(asset: photo, in: currentReference)
            avatarPath = stored.reference.path.drop(while: { $0 == "/" }).description
        } else {
            avatarPath = nil
        }
        let snapshot = try await binding.snapshot()
        let source = try ArborProfileDocument.updatingPerson(
            snapshot.source,
            displayName: displayName,
            description: description,
            avatarPath: avatarPath
        )
        try await binding.replaceSource(source)
    }

    func addProfileMember(treeID: String, handle: String) async throws {
        guard currentReference.path == "/", let binding else {
            throw ArborWireValidationError.invalidValue("Open the group home page before adding a person")
        }
        let snapshot = try await binding.snapshot()
        try await binding.replaceSource(try ArborProfileDocument.addingMember(
            profileTree: treeID,
            handle: workspace.isCommunityMembershipTree ? handle : nil,
            reservesCanopyHandle: workspace.isCommunityMembershipTree,
            to: snapshot.source
        ))
        await workspace.refreshDirectory(force: true)
    }

    /// A mounted profile is authored under a filesystem name, but its stable
    /// person-facing identity is the handle advertised by the directory.
    private func nestedProfileTitles(in nodes: [WorkspaceNode], parent: WorkspaceNode) -> [WorkspaceNode] {
        let source: String? = switch parent.surface {
        case let .markdown(source, _), let .directoryDocument(source, _, _): source
        default: nil
        }
        let group = source.flatMap(ArborProfileDocument.parse)
        return nodes.map { node in
            guard node.reference.path == "/",
                  node.reference.tree != workspace.home.tree else { return node }
            let locator = "arbor://\(node.reference.tree.rawValue)/"
            let authoredHandle = group?.memberHandlesByProfile[locator]
            let person = workspace.directory.first { $0.entry.profile == node.reference.tree.rawValue }
            guard authoredHandle != nil || person != nil else { return node }
            var presented = node
            presented.title = authoredHandle.map { "~\($0)" }
                ?? person?.entry.handle.map { "~\($0)" }
                ?? person!.title
            return presented
        }
    }

    func goBack() async {
        guard let destination = tabs.selectedTab.back.last else { return }
        await transition(preparing: destination) { tabs.goBack() }
    }
    func goForward() async {
        guard let destination = tabs.selectedTab.forward.last else { return }
        await transition(preparing: destination) { tabs.goForward() }
    }
    func goParent() async { await transition { tabs.goParent() } }
    func goHome() async {
        guard let home = treeHomeLocation else { return }
        await returnTo(home)
    }

    /// Pops back to `location` when it is already on the tab's trail, else pushes it.
    func returnTo(_ location: WorkspaceLocation) async {
        await transition { tabs.returnTo(location) }
    }

    func setNavigationPath(_ path: [WorkspaceLocation]) {
        guard !isSwitchingNavigationTree, path != tabs.navigationPath else { return }
        let destination = path.last ?? tabs.navigationRoot
        if case let .reference(reference) = destination, reference.tree != workspace.home.tree {
            Task { await transition(preparing: destination) { tabs.setNavigationPath(path) } }
            return
        }
        retainCurrentPagePresentation()
        tabs.setNavigationPath(path)
        if !restoreCurrentPagePresentation() {
            isLoading = true
            Task {
                await loadOrRestoreCurrentPage()
            }
        } else {
            Task {
                await loadBacklinks()
                await pruneRetainedPagePresentations()
            }
        }
    }

    func newTab() async {
        await transition { tabs.newTab() }
    }

    func openInNewTab(_ location: WorkspaceLocation) async {
        await transition { tabs.newTab(at: location) }
    }

    func closeSelectedTab() async {
        await binding?.flush()
        let closedTabID = selectedTabID
        retainCurrentPagePresentation()
        tabs.closeTab(selectedTabID)
        await releaseRetainedPagePresentations(for: closedTabID)
        await loadOrRestoreCurrentPage()
    }

    func selectTab(_ id: UUID) async {
        guard id != selectedTabID else { return }
        await transition { tabs.selectTab(id) }
    }

    /// Answer any move the editor host is waiting on with no destination.
    private static func cancelMoveRequests(of host: ArborEditorHost?) {
        host?.resolveMoveRequest(with: nil)
        host?.resolveStructuralMoveRequest(with: nil)
    }

    private func retainCurrentPagePresentation() {
        guard let node else { return }
        Self.cancelMoveRequests(of: editorHost)
        let key = PagePresentationKey(tabID: selectedTabID, location: node.location)
        retainedPagePresentations[key] = PagePresentation(
            node: node,
            children: children,
            editorLease: editorLease,
            editorHost: editorHost,
            backlinks: backlinks
        )
        self.node = nil
        children = []
        editorLease = nil
        editorHost = nil
        backlinks = []
    }

    private func restoreCurrentPagePresentation() -> Bool {
        let key = PagePresentationKey(tabID: selectedTabID, location: currentLocation)
        guard let presentation = retainedPagePresentations.removeValue(forKey: key) else {
            return false
        }
        node = presentation.node
        children = presentation.children
        editorLease = presentation.editorLease
        editorHost = presentation.editorHost
        backlinks = presentation.backlinks
        errorMessage = nil
        isLoading = false
        return true
    }

    /// A history entry names a tree as well as a page. Reopen its provider
    /// before resolving it, without letting workspace replacement reset tabs.
    private func prepareWorkspace(for location: WorkspaceLocation) async -> Bool {
        guard !isSwitchingNavigationTree else { return false }
        guard case let .reference(reference) = location,
              reference.tree != workspace.home.tree else { return true }
        isSwitchingNavigationTree = true
        defer { isSwitchingNavigationTree = false }
        do {
            await binding?.flush()
            try await openNavigationTree(reference.tree)
            loadRequestID += 1
            await releaseAllPagePresentations()
            observedWorkspaceGeneration = workspace.generation
            observedProviderRevision = workspace.providerRevision
            searchResults = []
            pageIndexTree = nil
            pageIndexResults = []
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    private func loadOrRestoreCurrentPage() async {
        guard await prepareWorkspace(for: currentLocation) else { return }
        if restoreCurrentPagePresentation() {
            await loadBacklinks()
        } else {
            await load()
        }
        await pruneRetainedPagePresentations()
    }

    private func pruneRetainedPagePresentations() async {
        let retainedKeys = Set(tabs.tabs.flatMap { tab in
            (tab.back + [tab.current] + tab.forward).map {
                PagePresentationKey(tabID: tab.id, location: $0)
            }
        })
        let staleKeys = retainedPagePresentations.keys.filter { !retainedKeys.contains($0) }
        for key in staleKeys {
            guard let presentation = retainedPagePresentations.removeValue(forKey: key) else { continue }
            await release(presentation)
        }
    }

    private func releaseRetainedPagePresentations(for tabID: UUID) async {
        let keys = retainedPagePresentations.keys.filter { $0.tabID == tabID }
        for key in keys {
            guard let presentation = retainedPagePresentations.removeValue(forKey: key) else { continue }
            await release(presentation)
        }
    }

    private func release(_ presentation: PagePresentation) async {
        Self.cancelMoveRequests(of: presentation.editorHost)
        if let lease = presentation.editorLease {
            await workspace.editorWorkspace.release(lease)
        }
    }

    private func releaseAllPagePresentations() async {
        if let editorLease {
            Self.cancelMoveRequests(of: editorHost)
            await workspace.editorWorkspace.release(editorLease)
        }
        for presentation in retainedPagePresentations.values {
            await release(presentation)
        }
        retainedPagePresentations.removeAll()
        node = nil
        children = []
        editorLease = nil
        editorHost = nil
        backlinks = []
    }

    func search(_ query: String) async {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        lastSearchQuery = trimmed
        let tree = currentReference.tree
        let syncBasis = [workspace.syncPresentation.acceptedRoot, workspace.syncPresentation.localRoot]
        if pageIndexTree == tree {
            searchResults = sidebarResults(matching: trimmed, in: pageIndexResults)
            guard pageIndexIsStale || pageIndexSyncBasis != syncBasis else { return }
        } else {
            pageIndexTree = tree
            pageIndexResults = []
            searchResults = []
        }
        pageIndexRequestID += 1
        let requestID = pageIndexRequestID
        pageIndexIsStale = false
        pageIndexSyncBasis = syncBasis
        do {
            let results = try await workspace.provider.search("", in: tree)
            guard requestID == pageIndexRequestID, tree == pageIndexTree, tree == currentReference.tree else { return }
            pageIndexResults = results
            // Queries typed while the index loaded filtered the previous one.
            searchResults = sidebarResults(matching: lastSearchQuery, in: results)
        }
        catch {
            if requestID == pageIndexRequestID { pageIndexIsStale = true }
            errorMessage = error.localizedDescription
        }
    }

    private func sidebarResults(
        matching query: String,
        in results: [WorkspaceSearchResult]
    ) -> [WorkspaceSearchResult] {
        guard !query.isEmpty else { return results }
        return results.filter {
            $0.title.localizedCaseInsensitiveContains(query)
                || $0.reference.path.localizedCaseInsensitiveContains(query)
        }
    }

    func fullTextSearch(_ query: String) async -> [WorkspaceSearchResult] {
        (try? await workspace.provider.search(
            query.trimmingCharacters(in: .whitespacesAndNewlines),
            in: currentReference.tree
        )) ?? []
    }

    func loadBacklinks() async {
        backlinksRequestID += 1
        let requestID = backlinksRequestID
        guard workspace.capabilities.backlinks else { backlinks = []; return }
        let reference = currentReference
        let loaded = (try? await workspace.provider.backlinks(to: reference)) ?? []
        // Navigation may have moved on while the provider answered.
        guard requestID == backlinksRequestID, reference.identity == currentReference.identity else { return }
        backlinks = loaded
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

    func resolveEditorConflict(source: String) async {
        guard let binding else { return }
        do {
            try await binding.resolveConflict(source: source)
            await load()
        } catch is WorkspaceDocumentConflict {
            // The binding retained the live editor and conflict evidence; its
            // banner remains the actionable error presentation.
        } catch { errorMessage = error.localizedDescription }
    }

    func retryDocumentSave() async {
        await binding?.retryLastSave()
    }

    func evaluateTitleRenameProposal() async {
        guard let binding, let node, node.isWritable,
              binding.reference.path != "/",
              !manuallyNamedPageKeys.contains(manualPageNameKey(binding.reference)),
              binding.lastError == nil, binding.conflict == nil else {
            titleRenameProposal = nil
            return
        }
        let title = binding.acceptedTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        let currentName = binding.reference.path.split(separator: "/").last.map(String.init) ?? ""
        guard !title.isEmpty, !WorkspaceTitleSlug.matches(name: currentName, title: title) else {
            titleRenameProposal = nil
            return
        }
        let parent = binding.reference.parent ?? WorkspaceReference(tree: binding.reference.tree, path: "/")
        let siblings = (try? await workspace.provider.children(of: parent)) ?? []
        let occupied = Set(siblings.compactMap { sibling -> String? in
            guard sibling.reference.identity != binding.reference.identity else { return nil }
            return sibling.reference.path.split(separator: "/").last.map(String.init)?.lowercased()
        })
        let stem = WorkspaceTitleSlug.name(for: title)
        var proposed = stem
        var suffix = 2
        while occupied.contains(proposed.lowercased()) {
            proposed = "\(stem)-\(suffix)"
            suffix += 1
        }
        let proposal = TitleRenameProposal(reference: binding.reference, proposedName: proposed)
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
            guard let renamed = try await workspace.perform(.rename(
                reference: binding.reference,
                name: proposal.proposedName
            )) else { return }
            binding.reconcileReference(renamed.reference)
            tabs.reconcileReference(renamed.reference)
            node = renamed
            let renamedLocation = location(for: renamed.reference)
            tabs.replaceCurrent(with: renamedLocation)
            sidebarLocation = renamedLocation.parent ?? workspace.launchLocation
            children = try await workspace.provider.children(of: sidebarLocation)
            pageIndexIsStale = true
            searchResults = searchResults.map { result in
                guard result.reference.identity == renamed.reference.identity else { return result }
                return WorkspaceSearchResult(
                    reference: renamed.reference,
                    title: renamed.title,
                    excerpt: result.excerpt,
                    modifiedAt: result.modifiedAt,
                    backlinkCount: result.backlinkCount
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
            let receipt = try await workspace.performWithReceipt(action)
            if navigateToResult, let result = receipt.result { await navigate(to: result.reference) }
            else { await reconcile(receipt) }
        } catch { errorMessage = error.localizedDescription }
    }

    func renameCurrentPage(to name: String) async {
        let reference = currentReference
        await workspace.flush()
        do {
            let receipt = try await workspace.performWithReceipt(.rename(reference: reference, name: name))
            let renamed = receipt.result
            manuallyNamedPageKeys.insert(manualPageNameKey(reference))
            if let renamed {
                manuallyNamedPageKeys.insert(manualPageNameKey(renamed.reference))
            }
            UserDefaults.standard.set(
                manuallyNamedPageKeys.sorted(),
                forKey: Self.manuallyNamedPagesDefaultsKey
            )
            titleRenameProposal = nil
            await reconcile(receipt)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func offerToTrashLinkedPage(_ target: WorkspaceNode, from source: WorkspaceReference) {
        guard binding?.reference.identity == source.identity,
              target.reference.identity != source.identity else { return }
        linkedPageTrashPrompt = LinkedPageTrashPrompt(
            target: target.reference,
            source: source,
            title: target.title
        )
    }

    func dismissLinkedPageTrashPrompt() {
        linkedPageTrashPrompt = nil
    }

    func trashPromptedLinkedPageIfStillOrphaned() async {
        guard let prompt = linkedPageTrashPrompt else { return }
        linkedPageTrashPrompt = nil
        await workspace.flush()
        do {
            guard binding?.reference.identity == prompt.source.identity,
                  let target = try? await workspace.provider.resolve(prompt.target),
                  target.isWritable, target.surface.supportsDocumentSession,
                  try await workspace.provider.backlinks(to: target.reference).isEmpty else { return }
            await perform(.trash(reference: target.reference), navigateToResult: false)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Applies a structural receipt to the visible workspace chrome without
    /// releasing the open document lease. Navigation remains the one operation
    /// that deliberately tears down and reacquires an editor surface.
    func reconcile(_ receipt: WorkspaceStructuralReceipt) async {
        guard observedWorkspaceGeneration == workspace.generation else { return }
        if let result = receipt.result {
            searchResults = searchResults.map { existing in
                guard existing.reference.identity == result.reference.identity else { return existing }
                return WorkspaceSearchResult(
                    reference: result.reference,
                    title: result.title,
                    excerpt: existing.excerpt,
                    modifiedAt: existing.modifiedAt,
                    backlinkCount: existing.backlinkCount
                )
            }
        }
        if let result = receipt.result, result.reference.identity == node?.reference.identity {
            node = result
            binding?.reconcileReference(result.reference)
            tabs.reconcileReference(result.reference)
            switch result.surface {
            case .directory, .directoryDocument, .collection:
                sidebarLocation = result.location
            default:
                sidebarLocation = result.location.parent ?? workspace.launchLocation
            }
        }
        pageIndexIsStale = true
        do {
            children = try await workspace.provider.children(of: sidebarLocation)
            await search(lastSearchQuery)
        } catch {
            errorMessage = error.localizedDescription
        }
    }


    func startVoiceRecording(
        _ session: VoiceRecordingSession<String>,
        delivery: VoiceTranscriptDelivery<String>? = nil
    ) async {
        guard let node, node.isWritable, let stableKey = binding?.reference.stableKey else {
            session.reportError("Open a writable Arbor page before starting a recording.")
            return
        }
        await session.start(destination: stableKey, delivery: delivery)
    }

    func startPinchVoiceRecording(
        _ session: VoiceRecordingSession<String>,
        onDraft: @escaping @MainActor @Sendable (String) -> Void
    ) async -> Bool {
        guard let node, node.isWritable, binding != nil else { return false }
        return await session.startLiveTranscription(onDraft: onDraft)
    }

    func toggleVoiceRecordingFromShortcut(_ session: VoiceRecordingSession<String>) async {
        switch session.state {
        case .idle:
            do {
                let homeNode = try await workspace.provider.resolve(workspace.home)
                guard homeNode.isWritable,
                      homeNode.surface.supportsDocumentSession,
                      let stableKey = homeNode.reference.stableKey else {
                    session.reportError("The Home node must be a writable Arbor page before starting a Shortcut recording.")
                    return
                }
                await returnTo(location(for: homeNode.reference))
                await session.start(destination: stableKey)
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
            guard workspace.localArborSyncOverview?.trees.contains(where: {
                $0.id == node.reference.tree.rawValue && $0.path != nil
            }) == true else { return nil }
#endif
            return node.provenance.treeRootURL.map { .local($0.path) }
        case .reference:
            guard node.reference.tree.rawValue != "local", node.reference.tree.rawValue != "system" else { return nil }
            // A resolved directory document carries a stable key. Reuse its
            // exact history entry so Home pops the trail rather than pushing
            // an unresolved address for the same root as a new visit.
            if let home = (tabs.selectedTab.back + [currentLocation]).last(where: { location in
                guard case let .reference(reference) = location else { return false }
                return reference.tree == node.reference.tree && reference.path == "/"
            }) { return home }
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
            let path = reference.path == "/"
                ? root.path
                : root.appending(path: reference.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))).path
            return .local(path)
        case let .remote(_, rootLocator):
            guard var components = URLComponents(string: rootLocator) else { return .reference(reference) }
            let rootPath = components.percentEncodedPath.replacingOccurrences(of: "/$", with: "", options: .regularExpression)
            let suffix = reference.path == "/" ? "" : reference.path
            components.percentEncodedPath = rootPath + suffix
            guard let locator = components.url?.absoluteString else { return .reference(reference) }
            return .remote(locator: locator, rootLocator: rootLocator)
        case .reference:
            return .reference(reference)
        }
    }
}

/// What the window shows while a tree is being reopened at launch.
enum ArborLaunchPhase: Equatable {
    /// The tree is known but nothing can be shown yet (no folder on disk).
    case restoring(String)
    /// The placed folder is shown read-only while its accepted state is confirmed.
    case confirming(String)
    /// The folder is shown read-only; confirming failed with this message.
    case unconfirmed(String, String)
    /// A tree is open and editable.
    case ready
    /// No tree to open, or opening failed with this message.
    case empty(String?)

    /// Whether the window shows a tree (possibly a read-only preview of one).
    var showsTree: Bool {
        switch self {
        case .restoring, .empty: false
        default: true
        }
    }

    var isPreviewing: Bool {
        switch self {
        case .confirming, .unconfirmed: true
        default: false
        }
    }
}

extension NativePlacementRecord {
    var displayName: String {
        tree.canonicalPath.flatMap { $0.split(separator: "/").last.map(String.init) }
            ?? osPath.map { URL(filePath: $0).lastPathComponent }
            ?? tree.id
    }
}
