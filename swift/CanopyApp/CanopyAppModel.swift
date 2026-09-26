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

struct CanopyShareAccount: Identifiable, Hashable, Sendable {
    let configurationTree: String
    let origin: String
    let handle: String?
    var id: String { configurationTree }
}

enum CanopySharePresentation: Hashable, Sendable {
    case tracked(NativeTreeAccessPresentation)
    case promotable(path: String, accounts: [CanopyShareAccount])
}

/// A tree access level, spelled as account configuration and the protocol spell it.
enum CanopyTreeAccess: String, CaseIterable, Sendable {
    case noAccess = "none"
    case read
    case write

    var label: String {
        switch self {
        case .noAccess: "No access"
        case .read: "Can view"
        case .write: "Can edit"
        }
    }
}

/// Tree kinds the app treats specially.
enum CanopyTreeKind {
    static let ordinary = "ordinary"
    static let treeConfiguration = "tree-configuration"
}

extension ProtocolTreeDescriptor {
    var grantsWrite: Bool { access == CanopyTreeAccess.write.rawValue }
}

enum CanopyShareInvite {
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
    let accounts: [LocalHostAccountDescriptor]
    let trees: [LocalArborSyncTreePresentation]
    let visits: [LocalArborSyncVisitPresentation]
    let observedThrough: String
}
#endif

/// A pairing offer another device claims: the `PairingPayload` JSON its
/// scanner reads, and the code both devices show.
struct CanopyPairingOffer: Sendable, Equatable {
    let payload: String
    let confirmationCode: String
}

/// A Members sheet the People view asks a group page to present once that
/// page is open, optionally with a person ready to add.
struct CanopyProfileAction: Equatable {
    let tree: String
    var prefill: String?
}

struct WorkspaceStructuralReceipt: Identifiable {
    let id = UUID()
    let action: WorkspaceStructuralAction
    let result: WorkspaceNode?
}

@MainActor
@Observable
final class CanopyWorkspaceState {
    /// Protocol format the working tree was placed under; bump when accepted-update
    /// identity, request shapes, canonical object encoding, or the durable
    /// state layout changes incompatibly. "4": content references (schema 2
    /// state, no inline file bytes), the `WorkingTrees/` layout, and
    /// `update-control.json`.
    static let workingTreeFormat = "5"

    private(set) var provider: any WorkspaceProvider
    private(set) var editorWorkspace: CanopyEditorWorkspace
    private(set) var home: WorkspaceReference
    private(set) var launchLocation: WorkspaceLocation
    private(set) var generation = 0
    /// Bumped when the provider is replaced by one presenting the same tree at
    /// the same locations (preview → confirmed working tree): windows reload
    /// their pages in place instead of resetting navigation.
    private(set) var providerRevision = 0
    private(set) var launchPhase: CanopyLaunchPhase = .ready
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
    private(set) var conflictReview: CanopyConflictReviewModel?
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
    private(set) var localHostDevicesByConfigurationTree: [String: [LocalArborSyncDevicePresentation]] = [:]
#endif
    private var navigationLocators: [TreeID: String] = [:]
    private let directoryStore = DirectoryStore()
    private(set) var directory: [DirectoryPerson] = []
    private(set) var directoryIsRefreshing = false
    private(set) var directoryError: String?
    private var directoryRefreshTask: Task<Void, Never>?
    var pendingProfileAction: CanopyProfileAction?
    private let nativePlacementStore = NativePlacementStore()
    private(set) var nativePlacements: [NativePlacementRecord] = []
    private let nativePathMonitor = NWPathMonitor()
    private let nativePathMonitorQueue = DispatchQueue(label: "org.nxhx.Arbor.canopy-path")
    private var nativeTransportAvailable = false
    private let suppliedAccountService: (any CanopyAccountService)?
    /// The accounts `accountService` last listed, for account lookups by
    /// origin that should not read the store each time.
    private(set) var knownAccounts: [CanopyAccount] = []

    /// Where this device keeps its identity and account credentials, chosen
    /// once per platform: the iPhone's keychain, or the Mac's data home
    /// through the daemon (Native 011, option 1).
    var accountService: any CanopyAccountService {
        if let suppliedAccountService { return suppliedAccountService }
#if os(macOS)
        // The connected daemon only: a passive account read never launches
        // one. Onboarding and the account panel connect first.
        return ArborSyncAccountService { [weak self] in
            guard let client = await self?.arborsyncClient else { throw ArborSyncSupervisorError.serviceUnavailable }
            return client
        }
#else
        return KeychainAccountService()
#endif
    }

    init(
        provider suppliedProvider: InMemoryWorkspaceProvider? = nil,
        accountService suppliedAccountService: (any CanopyAccountService)? = nil
    ) {
        self.suppliedAccountService = suppliedAccountService
        self.linkPreviewService = LinkPreviewService(
            cacheDirectory: CanopySupportDirectories.linkPreviews
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
        self.editorWorkspace = CanopyEditorWorkspace(provider: provider)
        var initialHome = suppliedProvider == nil
            ? disconnectedHome
            : WorkspaceReference(tree: "tr_sample", path: "/")
        var initialPhase = CanopyLaunchPhase.ready
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

    func place(tree: ProtocolTreeDescriptor, from origin: URL, configurationTree: String? = nil, remember: Bool = true) async throws {
        _ = try tree.validated()
        try await conflictReview?.flushDraft()
        serverWatchTask?.cancel()
        serverWatchTask = nil
        let credentialProvider: any ProtocolCredentialProvider = configurationTree.map {
            AccountStoredCredentialProvider(configurationTree: $0, store: KeychainDeviceCredentialStore())
        } ?? StoredDeviceCredentialProvider(origin: origin, store: KeychainDeviceCredentialStore())
        let client = ProtocolClient(origin: origin, credentialProvider: credentialProvider)
        let transport = ProtocolReplicaTransport(client: client)
        let platform = HostObjectStore(client: client, tree: tree.id)
        let root = CanopySupportDirectories.root
        let key = CanopySupportDirectories.workingTreeKey(tree.id)
        let replicaRoot = CanopySupportDirectories.workingTrees.appending(path: key, directoryHint: .isDirectory)
        let syncStateRoot = root.appending(path: "Sync/\(key)", directoryHint: .isDirectory)
        let workingTree = try await Self.openOrPlaceWorkingTree(
            tree,
            replicaRoot: replicaRoot,
            syncStateRoot: syncStateRoot,
            recoveryNames: (workingTree: "WorkingTree", sync: "Sync"),
            transport: transport,
            platform: platform
        )
        refreshEntryDates(workingTree, tree: tree.id, client: client)
        let (coordinator, nextProvider) = try synchronizedProvider(
            workingTree: workingTree,
            transport: transport,
            stateRoot: syncStateRoot,
            platformObjectStore: workingTree,
            readOnly: !tree.grantsWrite
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
        _ tree: ProtocolTreeDescriptor,
        replicaRoot: URL,
        syncStateRoot: URL,
        recoveryNames: (workingTree: String, sync: String),
        transport: ProtocolReplicaTransport,
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
        let archive = CanopySupportDirectories.root
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

    /// An update coordinator for `workingTree` and the provider whose writes
    /// are local changes it publishes. The coordinator polls so that a
    /// transport failure is retried while the network is believed available.
    private func synchronizedProvider(
        workingTree: WorkingTree,
        transport: ProtocolReplicaTransport,
        stateRoot: URL,
        platformObjectStore: any ObjectStore,
        readOnly: Bool = false,
        materializedRoot: URL? = nil
    ) throws -> (UpdateCoordinator, WorkingTreeProvider) {
        let coordinator = try UpdateCoordinator(
            workingTree: workingTree,
            transport: transport,
            stateRoot: stateRoot,
            transportAvailable: nativeTransportAvailable,
            platformObjectStore: platformObjectStore,
            pollInterval: .seconds(30)
        )
        let provider = WorkingTreeProvider(
            workingTree: workingTree,
            readOnly: readOnly,
            materializedRoot: materializedRoot,
            coordinator: coordinator
        )
        return (coordinator, provider)
    }

    /// Make `coordinator` the open tree's: its conflict review, sync
    /// presentation, and server watch.
    private func installSyncCoordinator(
        _ coordinator: UpdateCoordinator,
        client: ProtocolClient,
        tree: ProtocolTreeDescriptor
    ) async throws {
        syncCoordinator = coordinator
        conflictReview = CanopyConflictReviewModel(coordinator: coordinator)
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
        try await accountService.forget(origin: placement.origin, configurationTree: placement.configurationTree)
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

    /// Canopy's entry dates for an opened tree, read in the background: they
    /// never delay opening, and a failed read keeps the dates the tree has.
    @discardableResult
    private func refreshEntryDates(_ workingTree: WorkingTree, tree: String, client: ProtocolClient) -> Task<Void, Never> {
        Task.detached {
            guard let metadata = try? await client.entryMetadata(tree: tree) else { return }
            let dates = metadata.entries.compactMapValues { $0.modifiedAt.map { Date(timeIntervalSince1970: $0 / 1_000) } }
            try? await workingTree.applyEntryDates(dates, update: metadata.update)
        }
    }

    func sharePresentation(for node: WorkspaceNode) async throws -> CanopySharePresentation {
#if os(iOS)
        if nativePlacements.isEmpty {
            nativePlacements = try await nativePlacementStore.loadAll()
        }
        guard let placement = nativePlacements.first(where: { $0.tree.id == node.reference.tree.rawValue }) else {
            throw ProtocolValidationError.invalidValue("The current tree is not placed on this iPhone")
        }
        let service = NativeAccountService(
            origin: placement.origin,
            configurationTree: placement.configurationTree
        )
        return .tracked(try await service.access(tree: placement.tree.id))
#else
        if node.reference.tree.rawValue == "local" {
            guard let physicalURL = node.provenance.physicalURL else {
                throw ProtocolValidationError.invalidValue("The current folder has no local path")
            }
            let folder: URL = switch node.surface {
            case .directory, .directoryDocument: physicalURL
            default: physicalURL.deletingLastPathComponent()
            }
            if localArborSyncOverview == nil { await refreshLocalArborSyncOverview() }
            var accounts: [CanopyShareAccount] = []
            for account in localArborSyncOverview?.accounts ?? [] {
                guard account.credentialAvailable,
                      let origin = account.canopy,
                      isLocalAccountAdministrator(account) else { continue }
                accounts.append(CanopyShareAccount(
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
        access: CanopyTreeAccess
    ) async throws -> NativeTreeAccessPresentation {
#if os(iOS)
        guard let placement = nativePlacements.first(where: { $0.tree.id == tree }) else {
            throw ProtocolValidationError.invalidValue("The tree is not placed on this iPhone")
        }
        return try await NativeAccountService(
            origin: placement.origin,
            configurationTree: placement.configurationTree
        ).setAccess(tree: tree, target: target, access: access.rawValue)
#else
        // A tree's rules live in its own configuration, which the host holds;
        // any administrator's device edits it there.
        let result = try await treeConfigurationClient(for: tree).setAccess(tree: tree, target: target, access: access.rawValue)
        await refreshLocalArborSyncOverview()
        return result
#endif
    }

    /// Review an app's access to `tree`: the tree's own rule through the app
    /// where this person administers the tree, otherwise their `apps.yaml`.
    func prepareResourceConsent(tree: String, app: String, rule: ProtocolAppAccessRule, removing: Bool = false) async throws -> NativeResourceConsent {
#if os(iOS)
        guard let placement = nativePlacements.first(where: { $0.tree.id == tree }) else { throw ResourcePolicyError.invalid }
        return try await NativeAccountService(origin: placement.origin, configurationTree: placement.configurationTree)
            .prepareResourceConsent(tree: tree, app: app, rule: rule, removing: removing)
#else
        return try await treeConfigurationClient(for: tree).prepareResourceConsent(tree: tree, app: app, rule: rule, removing: removing)
#endif
    }

    func applyResourceConsent(_ review: NativeResourceConsent) async throws -> NativeTreeAccessPresentation? {
#if os(iOS)
        guard let placement = nativePlacements.first(where: { $0.tree.id == review.tree }) else { throw ResourcePolicyError.invalid }
        return try await NativeAccountService(origin: placement.origin, configurationTree: placement.configurationTree)
            .applyResourceConsent(review)
#else
        let result = try await treeConfigurationClient(for: review.tree).applyResourceConsent(review)
        await refreshLocalArborSyncOverview()
        return result
#endif
    }

#if os(macOS)
    /// The protocol client, with the placing account's credential, that edits
    /// tree configurations for a tree placed on this Mac.
    private func treeConfigurationClient(for tree: String) async throws -> TreeConfigurationClient {
        if localArborSyncOverview == nil { await refreshLocalArborSyncOverview() }
        guard let overview = localArborSyncOverview,
              let placedTree = overview.trees.first(where: { $0.id == tree }),
              let origin = overview.accounts.first(where: { $0.configurationTree == placedTree.configurationTree })?.canopy,
              let originURL = URL(string: origin) else {
            throw ProtocolValidationError.invalidValue("The current tree is not placed through a Canopy account")
        }
        return TreeConfigurationClient(wire: try await accountClient(origin: originURL))
    }
#endif

#if os(macOS)
    // MARK: Account configuration on disk
    //
    // The configuration tree is a placed folder at `~/.arbor/accounts/<cfg>/`.
    // The app reads and edits its YAML there, exactly as the CLI does
    // (`editAccountConfigurationFile` in `@arbor/stores`), and the daemon pushes
    // the edit like any other placement. Nothing here goes through a daemon
    // editor route.

    private func accountCheckout(_ configurationTree: String) -> URL {
        AccountConfigurationYAML.checkoutURL(
            dataHome: CanopySupportDirectories.dataHome,
            configurationTree: configurationTree
        )
    }

    private func readAccountConfigurationFile(_ configurationTree: String, named filename: String) throws -> String {
        try AccountConfigurationYAML.readFile(named: filename, in: accountCheckout(configurationTree))
    }

    /// Edit one file of the account checkout on disk, then ask the daemon to push
    /// the checkout now. Refused while the daemon reports the configuration
    /// tree in conflict: a disk edit would only pile onto the review.
    private func editAccountConfigurationFile(
        _ configurationTree: String,
        named filename: String,
        change: (String) throws -> String,
        validate: ((String) throws -> Void)? = nil
    ) async throws {
        if localArborSyncOverview?.trees.contains(where: { $0.id == configurationTree && $0.sync == "conflict" }) == true {
            throw ProtocolValidationError.invalidValue(
                "The host refused the account configuration's last changes; discard them in Sync Status before changing it"
            )
        }
        try AccountConfigurationYAML.editFile(
            named: filename,
            in: accountCheckout(configurationTree),
            change: change,
            validate: validate
        )
        if let client = arborsyncClient {
            try await client.synchronize(configurationTree: configurationTree)
        }
    }

    private func isLocalAccountAdministrator(_ account: LocalHostAccountDescriptor) -> Bool {
        guard let deviceID = account.deviceID,
              let source = try? readAccountConfigurationFile(account.configurationTree, named: "devices.yaml") else {
            return false
        }
        return (try? AccountConfigurationYAML.isAdministrator(
            deviceID: deviceID,
            devicesSource: source
        )) == true
    }

    func localHostDevices(configurationTree: String) async throws -> [LocalArborSyncDevicePresentation] {
        guard let account = localArborSyncOverview?.accounts.first(where: {
            $0.configurationTree == configurationTree
        }) else {
            throw ArborSyncSupervisorError.incompatibleService("The Canopy account is unavailable")
        }
        let source = try readAccountConfigurationFile(configurationTree, named: "devices.yaml")
        let devices = try AccountConfigurationYAML.devices(from: source)
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
        localHostDevicesByConfigurationTree[configurationTree] = devices
        return devices
    }

    func preloadLocalHostDevices() async {
        if localArborSyncOverview == nil { await refreshLocalArborSyncOverview() }
        for account in localArborSyncOverview?.accounts ?? [] {
            _ = try? await localHostDevices(configurationTree: account.configurationTree)
        }
    }

    func setLocalHostDeviceAdministrator(
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
        let devices = try AccountConfigurationYAML.devices(from: source)
        try AccountConfigurationYAML.validateAdministratorChange(
            devices: devices,
            currentDeviceID: account.deviceID,
            targetDeviceID: deviceID,
            administrator: administrator
        )
        try await editAccountConfigurationFile(configurationTree, named: "devices.yaml") { current in
            try AccountConfigurationYAML.replacingDevices(in: current) { devices in
                guard var device = devices[deviceID] else {
                    throw ProtocolValidationError.invalidValue("The device is no longer active")
                }
                device.administrator = administrator ? true : nil
                devices[deviceID] = device
            }
        } validate: { next in
            _ = try AccountConfigurationYAML.devices(from: next)
        }
        return try await localHostDevices(configurationTree: configurationTree)
    }

    func deauthorizeLocalHostDevice(
        configurationTree: String,
        deviceID: String
    ) async throws -> [LocalArborSyncDevicePresentation] {
        guard let account = localArborSyncOverview?.accounts.first(where: {
            $0.configurationTree == configurationTree
        }) else {
            throw ArborSyncSupervisorError.incompatibleService("The Canopy account is unavailable")
        }
        let source = try readAccountConfigurationFile(configurationTree, named: "devices.yaml")
        let devices = try AccountConfigurationYAML.devices(from: source)
        try AccountConfigurationYAML.validateDeviceRemoval(
            devices: devices,
            currentDeviceID: account.deviceID,
            targetDeviceID: deviceID
        )
        try await editAccountConfigurationFile(configurationTree, named: "devices.yaml") { current in
            try AccountConfigurationYAML.replacingDevices(in: current) { devices in
                devices[deviceID] = nil
            }
        } validate: { next in
            _ = try AccountConfigurationYAML.devices(from: next)
        }
        return try await localHostDevices(configurationTree: configurationTree)
    }

    /// The unrevoked agent bundles this Mac's registry holds that place `tree`.
    func agentBundles(tree: String) throws -> [CanopyCloudBundleRecord] {
        try CanopyCloudBundleRegistry.standard.load()
            .filter { $0.revokedAt == nil && $0.trees?.contains(tree) == true }
            .sorted { $0.createdAt > $1.createdAt }
    }

    /// Make an `arbor cloud start` bundle that places only `tree`, as
    /// `arbor cloud bundle create` does: a new non-administrator device on the
    /// tree's account whose credential exists only in the returned string.
    func createAgentBundle(tree: String, label requestedLabel: String) async throws -> (record: CanopyCloudBundleRecord, bundle: String) {
        let label = requestedLabel.trimmingCharacters(in: .whitespacesAndNewlines)
        guard (1...100).contains(label.count) else {
            throw ProtocolValidationError.invalidValue("Name the agent in 1 to 100 characters")
        }
        if localArborSyncOverview == nil { await refreshLocalArborSyncOverview() }
        guard let overview = localArborSyncOverview,
              let configurationTree = overview.trees.first(where: { $0.id == tree })?.configurationTree,
              let account = overview.accounts.first(where: { $0.configurationTree == configurationTree }),
              account.credentialAvailable,
              let origin = account.canopy.flatMap(URL.init(string:)),
              let scheme = origin.scheme, let host = origin.host(),
              let handle = account.handle, let profileTree = account.profileTree else {
            throw ProtocolValidationError.invalidValue("The current tree has no connected Canopy account on this Mac")
        }
        guard isLocalAccountAdministrator(account) else {
            throw ProtocolValidationError.invalidValue("This Mac needs administrator access to make an agent code")
        }
        guard let arborsync = arborsyncClient else { throw ArborSyncSupervisorError.serviceUnavailable }
        let client = ProtocolClient(
            origin: origin,
            credentialProvider: try await accountService.credentialProvider(configurationTree: configurationTree)
        )
        let descriptor = try await client.descriptor(tree: tree).tree
        guard descriptor.access == "write" else {
            throw ProtocolValidationError.invalidValue("This account cannot edit the tree, so an agent could not either")
        }
        guard let canonicalURL = descriptor.httpURL, let canonicalPath = descriptor.canonicalPath else {
            throw ProtocolValidationError.invalidValue("The tree has no canonical URL to place it by")
        }
        let accountID = try await client.account().account.id
        let bundleID = CanopyCloudBundle.newBundleID()
        let deviceID = try generateArborID(prefix: "dv")
        let credential = CanopyCloudBundle.newCredential()
        let createdAt = ISO8601DateFormatter.cloudBundle.string(from: Date())
        // The CLI accepts only a normalized origin, which the stored spelling need not be.
        let canopy = "\(scheme)://\(host)" + (origin.port.map { ":\($0)" } ?? "")
        let accountURL = canopy + "/~" + handle
        let bundle = try CanopyCloudBundle.encode(CanopyCloudBundlePayload(
            bundleID: bundleID,
            label: label,
            createdAt: createdAt,
            origin: canopy,
            account: accountURL,
            accountID: accountID,
            configurationTree: configurationTree,
            profileTree: profileTree,
            deviceID: deviceID,
            credential: credential,
            placements: [.init(
                treeID: tree,
                canonicalURL: canonicalURL,
                relativePath: CanopyCloudBundle.relativePath(canonicalPath: canonicalPath)
            )]
        ))
        let offer = try await client.createPairing()
        _ = try await ProtocolClient(origin: origin).claimPairing(
            id: offer.id,
            secret: offer.secret,
            device: ProtocolPairingDevice(id: deviceID, label: label, credentialDigest: CanopyCloudBundle.credentialDigest(credential))
        )
        let record = CanopyCloudBundleRecord(
            bundleID: bundleID,
            label: label,
            createdAt: createdAt,
            origin: canopy,
            account: accountURL,
            configurationTree: configurationTree,
            deviceID: deviceID,
            trees: [tree]
        )
        try CanopyCloudBundleRegistry.standard.save(record)
        // Pull the new device into devices.yaml so Account lists it and revocation finds it.
        try? await arborsync.synchronize(configurationTree: configurationTree)
        _ = try? await localHostDevices(configurationTree: configurationTree)
        return (record, bundle)
    }

    /// Remove an agent bundle's device from its account, as `arbor cloud
    /// bundle revoke` does, then record the revocation in the registry.
    func revokeAgentBundle(_ record: CanopyCloudBundleRecord) async throws {
        if let arborsync = arborsyncClient {
            try await arborsync.synchronize(configurationTree: record.configurationTree)
        }
        let devices = try AccountConfigurationYAML.devices(
            from: readAccountConfigurationFile(record.configurationTree, named: "devices.yaml")
        )
        if devices[record.deviceID] != nil {
            _ = try await deauthorizeLocalHostDevice(configurationTree: record.configurationTree, deviceID: record.deviceID)
        }
        try CanopyCloudBundleRegistry.standard.markRevoked(bundleID: record.bundleID, at: Date())
    }

    private func loadLocalTreeAccess(tree: String) async throws -> NativeTreeAccessPresentation {
        try await treeConfigurationClient(for: tree).access(tree: tree)
    }

    /// A person or group as a profile TreeID: a bare TreeID, a `~handle` on the
    /// account's own Canopy, or any Arbor locator resolved on the protocol at its
    /// origin with the account credential when the origins match.
    private func resolveLocalProfile(
        _ input: String,
        overview: LocalArborSyncOverview,
        configurationTree: String
    ) async throws -> String {
        let value = input.trimmingCharacters(in: .whitespacesAndNewlines)
        if TreeID.isWellFormed(value) { return value }
        let locator: String
        if value.hasPrefix("~"),
           let origin = overview.accounts.first(where: { $0.configurationTree == configurationTree })?.canopy,
           let host = URL(string: origin)?.host {
            locator = "arbor://\(host)/\(value)"
        } else {
            locator = value
        }
        guard let remote = ArborRemoteLocator(locator) else {
            throw ProtocolValidationError.invalidValue("Enter a person or group Arbor URL, handle, or TreeID")
        }
        return try await accountClient(origin: remote.origin).resolve(path: remote.path).ref.tree
    }

    func promoteLocalFolder(
        path: String,
        account: CanopyShareAccount,
        canonical: String,
        publicAccess: CanopyTreeAccess
    ) async throws {
        let rules = publicAccess == .noAccess ? [] : [
            AccountAccessRule(subject: .everyone, access: publicAccess.rawValue)
        ]
        _ = try await declareAndPlaceNewTree(
            folder: URL(fileURLWithPath: path).standardizedFileURL.path,
            account: account,
            canonical: canonical,
            rules: rules
        )
    }

    /// The Canopy account a new group is created in: the first one this Mac
    /// administers with a handle to allocate `/~handle/<slug>` under.
    var groupCreationAccount: CanopyShareAccount? {
        for account in localArborSyncOverview?.accounts ?? [] {
            guard account.credentialAvailable, let origin = account.canopy, let handle = account.handle,
                  isLocalAccountAdministrator(account) else { continue }
            return CanopyShareAccount(configurationTree: account.configurationTree, origin: origin, handle: handle)
        }
        return nil
    }

    /// Create a group profile tree at `placement`'s path for `slug`, readable
    /// by everyone on the Canopy (the community `/` profile), and place it on
    /// this Mac. Returns the new group's TreeID.
    func createGroup(
        name: String,
        slug: String,
        placement: CanopyGroupPlacement,
        description: String,
        memberTrees: [String]
    ) async throws -> String {
        if localArborSyncOverview == nil { await refreshLocalArborSyncOverview() }
        guard let account = groupCreationAccount, let handle = account.handle,
              let origin = URL(string: account.origin) else {
            throw ProtocolValidationError.invalidValue("Connect this Mac as an administrator of a Canopy account first")
        }
        guard CanopyGroupSlug.isValid(slug) else {
            throw ProtocolValidationError.invalidValue("Use lowercase letters, numbers, and hyphens for the group address")
        }
        let path = placement.prefix(handle: handle) + slug
        if placement == .canopy, directory.contains(where: { $0.entry.handle == slug }) {
            throw ProtocolValidationError.invalidValue("~\(slug) belongs to a person on this Canopy")
        }
        if localArborSyncOverview?.trees.contains(where: { $0.canonicalPath == path }) == true {
            throw ProtocolValidationError.invalidValue("\(path) is already in use")
        }
        let canonical = origin.appending(path: String(path.dropFirst())).absoluteString
        let source = try CanopyProfileDocument.newGroupSource(displayName: name, description: description, memberTrees: memberTrees)
        let community = try await accountClient(origin: origin).resolve(path: "/").ref.tree
        let folder = CanopySupportDirectories.dataHome.appending(path: "groups/\(slug)", directoryHint: .isDirectory)
        guard !FileManager.default.fileExists(atPath: folder.path) else {
            throw ProtocolValidationError.invalidValue("A group folder named \(slug) already exists on this Mac")
        }
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        do {
            try source.write(to: folder.appending(path: "_index.md"), atomically: true, encoding: .utf8)
            let tree = try await declareAndPlaceNewTree(
                folder: folder.standardizedFileURL.path,
                account: account,
                canonical: canonical,
                rules: [AccountAccessRule(subject: .profile(tree: community), access: CanopyTreeAccess.read.rawValue)]
            )
            await refreshDirectory(force: true)
            return tree
        } catch {
            try? FileManager.default.removeItem(at: folder)
            throw error
        }
    }

    /// Declare a new tree at `canonical` with `rules` and place it at `folder`.
    private func declareAndPlaceNewTree(
        folder: String,
        account: CanopyShareAccount,
        canonical: String,
        rules: [AccountAccessRule]
    ) async throws -> String {
        guard let canonicalURL = URL(string: canonical),
              let accountOrigin = URL(string: account.origin),
              Self.sameOrigin(canonicalURL, accountOrigin),
              canonicalURL.query == nil,
              canonicalURL.fragment == nil else {
            throw ProtocolValidationError.invalidValue("Enter a canonical URL on the selected Canopy")
        }
        let tree = try generateArborID(prefix: "tr")
        let placementsURL = CanopySupportDirectories.dataHome.appending(path: "placements.yaml")
        let placementsSource = (try? String(contentsOf: placementsURL, encoding: .utf8)) ?? "{}\n"
        let placements = try LocalPlacementsYAML.adding(
            configurationTree: account.configurationTree,
            path: folder,
            tree: tree,
            to: placementsSource
        )
        // Declare the tree with its configuration and mount it where its URL
        // says; the daemon activates it with the folder's content once placed.
        let wire = try await accountClient(origin: accountOrigin)
        let segments = canonicalURL.path.split(separator: "/").map(String.init)
        guard let last = segments.last else { throw ProtocolValidationError.invalidValue("The community root cannot be placed again") }
        let parent = try await wire.resolve(path: "/" + segments.dropLast().joined(separator: "/"))
        let within = parent.ref.path == "/" ? "" : String(parent.ref.path.dropFirst())
        try await TreeConfigurationClient(wire: wire).declareAndMount(
            tree: tree,
            rules: try rules.map { try $0.resourceRule() },
            parent: parent.ref.tree,
            name: within.isEmpty ? last : "\(within)/\(last)"
        )
        try placements.write(to: placementsURL, atomically: true, encoding: .utf8)
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
        return tree
    }

    // MARK: Control-mode daemon

    /// arborsync's well-known loopback port, and the isolated one a signed
    /// test helper listens on instead.
    private static let arborSyncPort = 4_317
    private static let testHelperArborSyncPort = 45_190

    /// Connect to the installation's control-mode daemon, launching one when
    /// none is listening, and keep its loopback client.
    @discardableResult
    func ensureArborSync() async throws -> ArborSyncControlRuntime {
        let usesTestHelper = ProcessInfo.processInfo.environment["ARBOR_TEST_BUNDLED_HELPER"] == "1"
        // A signed test helper has an isolated data home and must never impersonate the
        // user's arborsync on its well-known port if the test host exits unexpectedly.
        let preferredPort = usesTestHelper ? Self.testHelperArborSyncPort : Self.arborSyncPort
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
            throw ProtocolValidationError.invalidValue("\(placed.name) is not placed on this Mac")
        }
        // The account's Canopy is the origin only for a tree without a canonical endpoint.
        var originValue = placed.canonical?.endpoint
        if originValue == nil {
            originValue = try await client.accounts().first { $0.configurationTree == placed.configurationTree }?.canopy
        }
        guard let rawOrigin = originValue, let origin = URL(string: rawOrigin) else {
            throw ProtocolValidationError.invalidValue("\(placed.name) has no Canopy origin")
        }
        let descriptor = try ProtocolTreeDescriptor(
            id: placed.id,
            kind: placed.kind,
            root: bootstrap.accepted.root,
            access: placed.access,
            canonical: placed.canonical,
            update: bootstrap.accepted.update
        ).validated()

        let credentialProvider = ArborSyncCredentialProvider(client: client, configurationTree: placed.configurationTree)
        let protocolClient = ProtocolClient(origin: origin, credentialProvider: credentialProvider)
        let transport = ProtocolReplicaTransport(client: protocolClient)
        let platform = DaemonObjectStore(client: client, tree: treeID)
        let workingTree = try await WorkingTree.inMemory(tree: TreeID(rawValue: treeID), platform: platform)
        let replacement = try SnapshotBridge.replacement(
            snapshot: bootstrap.spine,
            tree: TreeID(rawValue: treeID),
            update: bootstrap.accepted.update,
            cursor: bootstrap.accepted.cursor,
            mode: .sparseFiles
        )
        try await workingTree.initializeFromSystem(replacement)
        // This tree is rebuilt on every launch: wait briefly for its dates so
        // the sidebar does not open undated, but never block on the network.
        let dates = refreshEntryDates(workingTree, tree: treeID, client: protocolClient)
        await withTaskGroup(of: Void.self) { group in
            group.addTask { await dates.value }
            group.addTask { try? await Task.sleep(for: .seconds(2)) }
            await group.next()
            group.cancelAll()
        }

        let stateRoot = CanopySupportDirectories.workingTrees
            .appending(path: CanopySupportDirectories.workingTreeKey(treeID), directoryHint: .isDirectory)
        let (coordinator, nextProvider) = try synchronizedProvider(
            workingTree: workingTree,
            transport: transport,
            stateRoot: stateRoot,
            platformObjectStore: platform,
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
        try await installSyncCoordinator(coordinator, client: protocolClient, tree: descriptor)
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
            throw ProtocolValidationError.invalidValue("Enter an http(s):// or arbor:// locator")
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
        let client = try await accountClient(origin: remote.origin)
        let resolution = try await client.resolve(path: remote.path)
        let tree = resolution.enclosingTree
        let treeID = TreeID(rawValue: tree.id)
        let platform: any ObjectStore = if let daemon = arborsyncClient {
            DaemonObjectStore(client: daemon, tree: tree.id, origin: remote.origin)
        } else {
            HostObjectStore(client: client, tree: tree.id)
        }
        let rootLocator = tree.canonicalPath.map { remote.locator(path: $0) } ?? remote.rootLocator
        do {
            try await visitedTreeStore.record(VisitedTreeRecord(origin: remote.origin, tree: tree, locator: rootLocator))
        } catch {
            Self.recordDiagnostic("visit-record", error)
        }
        if tree.grantsWrite {
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
        try await workingTree.initializeFromSystem(try CanopyVisitSnapshot.replacement(
            snapshot,
            tree: treeID,
            update: tree.update,
            cursor: resolution.observedThrough
        ))
        refreshEntryDates(workingTree, tree: tree.id, client: client)
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
        visitFollowTask = CanopyVisitFollower(client: client, tree: tree.id, workingTree: workingTree) { [weak self] in
            await self?.noteVisitChanged(workingTree)
        }.start(after: resolution.observedThrough)
        prefetchLocalArborSyncOverview()
    }

    private func openWritableRemoteTree(
        tree: ProtocolTreeDescriptor,
        locator: String,
        client: ProtocolClient,
        platform: any ObjectStore
    ) async throws {
        let transport = ProtocolReplicaTransport(client: client)
        let key = CanopySupportDirectories.workingTreeKey(tree.id)
        let replicaRoot = CanopySupportDirectories.remoteWorkingTrees
            .appending(path: key, directoryHint: .isDirectory)
        let syncStateRoot = CanopySupportDirectories.remoteSync
            .appending(path: key, directoryHint: .isDirectory)
        let workingTree = try await Self.openOrPlaceWorkingTree(
            tree,
            replicaRoot: replicaRoot,
            syncStateRoot: syncStateRoot,
            recoveryNames: (workingTree: "RemoteWorkingTree", sync: "RemoteSync"),
            transport: transport,
            platform: platform
        )
        refreshEntryDates(workingTree, tree: tree.id, client: client)
        let (coordinator, provider) = try synchronizedProvider(
            workingTree: workingTree,
            transport: transport,
            stateRoot: syncStateRoot,
            platformObjectStore: workingTree
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
        // An unreadable placement list or selection opens like a fresh
        // installation; each is read, and may fail, on its own.
        do {
            nativePlacements = try await nativePlacementStore.loadAll()
        } catch {
            Self.recordDiagnostic("placement-restore", error)
            nativePlacements = []
        }
        let record: NativePlacementRecord?
        do {
            record = try await nativePlacementStore.load()
        } catch {
            Self.recordDiagnostic("placement-restore", error)
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
                    canonicalPath: record.tree.canonicalPath
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
    /// only. Visits are the app's own; each account's devices load separately.
    private func loadLocalArborSyncOverview() async throws -> LocalArborSyncOverview {
        guard let client = arborsyncClient else { throw ArborSyncSupervisorError.serviceUnavailable }
        async let treeListRequest = client.trees()
        async let accountsRequest = client.accounts()
        let (treeList, accounts) = try await (treeListRequest, accountsRequest)
        let configurationTree = treeList.snapshot.first { $0.kind == CanopyTreeKind.treeConfiguration }?.id
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
                missing: $0.missing == true
            )
        }
        let visits = await recentVisits()
        knownAccounts = accounts.map { CanopyAccount($0) }
        return LocalArborSyncOverview(
            origin: accounts.first?.canopy,
            handle: accounts.first?.handle,
            configurationTree: configurationTree,
            credentialAvailable: accounts.contains(where: \.credentialAvailable),
            accounts: accounts,
            trees: trees,
            visits: visits,
            observedThrough: treeList.observedThrough
        )
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
            // A refresh already in flight may have read the overview before
            // these events; joining it would drop them. Let it finish (events
            // meanwhile still share this task), then read afresh.
            while let inFlight = self.overviewRefreshTask {
                await inFlight.value
                guard !Task.isCancelled else { return }
            }
            self.overviewEventRefreshTask = nil
            await self.refreshLocalArborSyncOverview()
        }
    }
#endif

    /// Ask the account's Canopy for a pairing offer, authorized by the
    /// account's credential; both platforms do this directly on the host.
    func createPairingOffer(configurationTree: String) async throws -> CanopyPairingOffer {
        var found = knownAccounts.first { $0.configurationTree == configurationTree }
        if found == nil {
            knownAccounts = try await accountService.accounts()
            found = knownAccounts.first { $0.configurationTree == configurationTree }
        }
        guard let account = found else { throw CanopyAccountServiceError.invalidAccount("The Canopy account is unavailable") }
        guard let origin = account.origin else {
            throw CanopyAccountServiceError.invalidAccount("The community origin is invalid")
        }
        let offer = try await accountService.client(for: account).createPairing()
        let payload = PairingPayload(
            origin: origin,
            pairing: .init(id: offer.id, secret: offer.secret)
        )
        let data = try JSONEncoder().encode(payload)
        return CanopyPairingOffer(
            payload: String(decoding: data, as: UTF8.self),
            confirmationCode: offer.confirmationCode
        )
    }

    /// The account this device holds at `origin` with a credential, reading
    /// the account store again only when the last list has none. An
    /// unreadable store (the Mac's daemon not connected) holds none.
    func connectedAccount(at origin: URL) async -> CanopyAccount? {
        func match(_ accounts: [CanopyAccount]) -> CanopyAccount? {
            accounts.first { $0.credentialAvailable && $0.origin.map { Self.sameOrigin($0, origin) } == true }
        }
        if let account = match(knownAccounts) { return account }
        do {
            knownAccounts = try await accountService.accounts()
        } catch {
            Self.recordDiagnostic("account-list", error)
            return nil
        }
        return match(knownAccounts)
    }

    /// A protocol client at `origin`: with the credential of an account this
    /// device holds there, anonymous otherwise.
    private func accountClient(origin: URL) async throws -> ProtocolClient {
        guard let account = await connectedAccount(at: origin) else { return ProtocolClient(origin: origin) }
        return ProtocolClient(
            origin: origin,
            credentialProvider: try await accountService.credentialProvider(configurationTree: account.configurationTree)
        )
    }

    static func bootstrapFailureMessage(_ error: Error, processKind: ArborSyncProcessKind?) -> String {
        guard let diagnostic = CanopySaveDiagnostic.describe(error, processKind: processKind, context: .bootstrap) else {
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
            let accounts: [CanopyAccount]
            do {
                accounts = try await self.accountService.accounts()
                self.knownAccounts = accounts
            } catch {
                // Without an account list (the Mac's daemon not yet connected)
                // refresh the accounts last listed, as before a list existed.
                accounts = self.knownAccounts
                Self.recordDiagnostic("directory-accounts", error)
            }
            var seen = Set<String>()
            for account in accounts where account.credentialAvailable {
                guard let origin = account.origin, seen.insert(origin.absoluteString).inserted else { continue }
                do {
                    if !force, self.writableTreesByOrigin[origin.absoluteString] != nil,
                       let fetched = try await self.directoryStore.fetchedAt(origin: origin),
                       Date().timeIntervalSince(fetched) < 60 { continue }
                    let client = try await self.accountService.client(for: account)
                    async let directory = client.directory()
                    async let trees = client.trees()
                    try await self.directoryStore.save(origin: origin, entries: directory.snapshot)
                    self.writableTreesByOrigin[origin.absoluteString] = Set(try await trees.snapshot.filter(\.grantsWrite).map(\.id))
                } catch { failures.append("\(origin.host() ?? origin.absoluteString): \(error.localizedDescription)") }
            }
            self.directory = (try? await self.directoryStore.load()) ?? self.directory
            self.directoryError = failures.isEmpty ? nil : failures.joined(separator: "\n")
        }
        directoryRefreshTask = task
        await task.value
    }

    /// Trees each Canopy says this account can edit, by origin: People
    /// offers only groups a member can actually be added to.
    private var writableTreesByOrigin: [String: Set<String>] = [:]

    var writableProfileTrees: Set<String> {
        writableTreesByOrigin.values.reduce(into: Set<String>()) { $0.formUnion($1) }
    }

    func avatarData(for person: DirectoryPerson) async throws -> Data {
        guard let avatar = person.entry.avatar else {
            throw ProtocolValidationError.invalidValue("Directory entry has no avatar")
        }
        return try await accountClient(origin: person.origin).object(tree: avatar.tree, hash: avatar.hash)
    }

    func openDirectoryProfile(_ person: DirectoryPerson) async throws {
#if os(macOS)
        guard let locator = person.entry.locator else {
            throw ProtocolValidationError.invalidValue("Profile is not hosted on this Canopy")
        }
        try await openRemoteLocator(locator)
#else
        guard let account = await connectedAccount(at: person.origin) else {
            throw ProtocolValidationError.invalidValue("No account is connected to this Canopy")
        }
        guard let tree = try await accountService.client(for: account).trees().snapshot.first(where: { $0.id == person.entry.profile }) else {
            throw ProtocolValidationError.invalidValue("Profile is not hosted on this Canopy")
        }
        try await place(tree: tree, from: person.origin, configurationTree: account.configurationTree)
#endif
    }

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
            throw ProtocolValidationError.invalidValue(
                "The nested tree \(tree.rawValue) is not hosted by a connected Canopy."
            )
        }
        try await openDirectoryProfile(person)
    }

    /// Leave `held` by discarding the refused change and the changes made on it.
    func discardHeldChanges() async {
        guard let syncCoordinator else { return }
        do { try await syncCoordinator.discardHeldChanges() } catch { errorMessage = error.localizedDescription }
        await refreshSyncPresentation(from: syncCoordinator)
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
        guard let code = CanopySaveDiagnostic.urlErrorCode(error) else { return false }
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
            var note = ProtocolNetworkLogEntry(kind: .note, name: "presentation")
            note.error = "\(syncPresentation.state) · \(syncPresentation.detail ?? "")"
            ProtocolNetworkLog.current?.record(note)
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
        preservingNavigation: Bool = false
    ) async {
#if os(macOS)
        if let locator = openVisitLocator { navigationLocators[home.tree] = locator }
#endif
        await editorWorkspace.closeAll()
        conflictReview = nil
        provider = nextProvider
        editorWorkspace = CanopyEditorWorkspace(provider: nextProvider)
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
        client: ProtocolClient,
        tree: ProtocolTreeDescriptor,
        coordinator: UpdateCoordinator
    ) {
        serverWatchTask = HostWatchRunner(client: client, tree: tree.id, coordinator: coordinator) { [weak self] in
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
        var note = ProtocolNetworkLogEntry(kind: .note, name: name)
        note.error = error.localizedDescription
        ProtocolNetworkLog.current?.record(note)
    }
}

@MainActor
@Observable
final class CanopyAppModel {
    private static let manuallyNamedPagesDefaultsKey = "Canopy.manuallyNamedPages"

    private struct PagePresentationKey: Hashable {
        let tabID: UUID
        let location: WorkspaceLocation
    }

    struct PagePresentation {
        let node: WorkspaceNode
        let children: [WorkspaceNode]
        let editorLease: CanopyEditorLease?
        let editorHost: CanopyEditorHost?
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

    let workspace: CanopyWorkspaceState
    private(set) var tabs: BrowserTabController
    private(set) var node: WorkspaceNode?
    private(set) var children: [WorkspaceNode] = []
    private(set) var sidebarLocation: WorkspaceLocation
    private(set) var errorMessage: String?
    private(set) var editorLease: CanopyEditorLease?
    private(set) var editorHost: CanopyEditorHost?
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
    /// The last profile parsed, so a home page's body does not re-parse its
    /// Markdown on every render.
    @ObservationIgnored private var parsedProfile: (source: String, document: CanopyProfileDocument?)?
    private var manuallyNamedPageKeys = Set(
        UserDefaults.standard.stringArray(forKey: manuallyNamedPagesDefaultsKey) ?? []
    )

    init(
        workspace: CanopyWorkspaceState,
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
        self.init(workspace: CanopyWorkspaceState(provider: .sample()))
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
    var binding: CanopyDocumentBinding? { editorLease?.binding }
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
                    lease.binding.projectDirectoryChildren(loadedChildren, in: resolved)
                }
                editorLease = lease
                editorHost = CanopyEditorHost(
                    binding: lease.binding,
                    provider: workspace.provider,
                    linkPreviewService: workspace.linkPreviewService,
                    sourceDirectory: resolved.sourceDirectory,
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

    /// Push a profile tree's home page onto this tab's history, so Back
    /// returns to the page it was opened from. With `membersSheet`, the page
    /// presents its Members sheet, ready to add `prefill` when given.
    func openProfile(tree: String, membersSheet: Bool = false, prefill: String? = nil) async {
        if membersSheet { workspace.pendingProfileAction = CanopyProfileAction(tree: tree, prefill: prefill) }
        await navigate(to: WorkspaceReference(tree: TreeID(rawValue: tree), path: "/"))
        if currentReference.tree.rawValue != tree { workspace.pendingProfileAction = nil }
    }

    func updatePersonalProfile(
        displayName: String,
        description: String,
        photo: WorkspaceAsset? = nil
    ) async throws {
        guard currentReference.path == "/", let binding else {
            throw ProtocolValidationError.invalidValue("Open the profile home page before editing its details")
        }
        let avatarPath: String?
        if let photo {
            let stored = try await workspace.provider.store(asset: photo, in: currentReference)
            avatarPath = stored.reference.path.drop(while: { $0 == "/" }).description
        } else {
            avatarPath = nil
        }
        let snapshot = try await binding.snapshot()
        let source = try CanopyProfileDocument.updatingPerson(
            snapshot.source,
            displayName: displayName,
            description: description,
            avatarPath: avatarPath
        )
        try await binding.replaceSource(source)
    }

    func addProfileMember(treeID: String, handle: String) async throws {
        guard currentReference.path == "/", let binding else {
            throw ProtocolValidationError.invalidValue("Open the group home page before adding a person")
        }
        let snapshot = try await binding.snapshot()
        try await binding.replaceSource(try CanopyProfileDocument.addingMember(
            profileTree: treeID,
            handle: workspace.isCommunityMembershipTree ? handle : nil,
            reservesHostHandle: workspace.isCommunityMembershipTree,
            to: snapshot.source
        ))
        await workspace.refreshDirectory(force: true)
    }

    func addProfileInvitation(handle: String, digest: String) async throws {
        guard currentReference.path == "/", let binding, workspace.isCommunityMembershipTree else {
            throw ProtocolValidationError.invalidValue("Open the Canopy community profile before inviting a person")
        }
        let snapshot = try await binding.snapshot()
        try await binding.replaceSource(try CanopyProfileDocument.addingInvitation(
            handle: handle, digest: digest, to: snapshot.source
        ))
        await workspace.syncNow()
        await workspace.refreshDirectory(force: true)
    }

    func removeProfileMember(profile: String) async throws {
        guard currentReference.path == "/", let binding else {
            throw ProtocolValidationError.invalidValue("Open the group home page before removing a member")
        }
        let snapshot = try await binding.snapshot()
        try await binding.replaceSource(try CanopyProfileDocument.removingMember(profile: profile, from: snapshot.source))
        await workspace.refreshDirectory(force: true)
    }

    /// The profile frontmatter of a Markdown node, if it declares one.
    func profileDocument(for node: WorkspaceNode) -> CanopyProfileDocument? {
        let source: String
        switch node.surface {
        case let .markdown(markdown, _), let .directoryDocument(markdown, _, _):
            source = markdown
        default:
            return nil
        }
        if let parsedProfile, parsedProfile.source == source { return parsedProfile.document }
        let document = CanopyProfileDocument.parse(source)
        parsedProfile = (source, document)
        return document
    }

    /// A mounted profile is authored under a filesystem name, but its stable
    /// person-facing identity is the handle advertised by the directory.
    private func nestedProfileTitles(in nodes: [WorkspaceNode], parent: WorkspaceNode) -> [WorkspaceNode] {
        let group = profileDocument(for: parent)
        return nodes.map { node in
            guard node.reference.path == "/",
                  node.reference.tree != workspace.home.tree else { return node }
            let locator = "arbor://\(node.reference.tree.rawValue)/"
            let authoredHandle = group?.memberHandlesByProfile[locator]
            let person = workspace.directory.first { $0.entry.profile == node.reference.tree.rawValue }
            var presented = node
            if let authoredHandle {
                presented.title = "~\(authoredHandle)"
            } else if let person {
                presented.title = person.entry.handle.map { "~\($0)" } ?? person.title
            } else {
                return node
            }
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
    private static func cancelMoveRequests(of host: CanopyEditorHost?) {
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

    /// A session without history (a working tree today) shows the empty state.
    func loadHistory() async {
        guard let binding else { history = []; return }
        history = (try? await binding.history()) ?? []
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

    func retryDocumentSave() async {
        await binding?.retryLastSave()
    }

    func evaluateTitleRenameProposal() async {
        guard let binding, let node, node.isWritable,
              binding.reference.path != "/",
              !manuallyNamedPageKeys.contains(manualPageNameKey(binding.reference)),
              binding.lastError == nil else {
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
        guard binding.lastError == nil else { return }
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
            session.reportError("Open a writable page before starting a recording.")
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
                    session.reportError("The Home node must be a writable page before starting a Shortcut recording.")
                    return
                }
                await returnTo(location(for: homeNode.reference))
                await session.start(destination: stableKey)
            } catch {
                session.reportError("Canopy could not open Home for recording: \(error.localizedDescription)")
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
enum CanopyLaunchPhase: Equatable {
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
