import ArborSyncClient
import ArborKit
import ArborQuagmire
import ArborReplica
import CanopyClient
import ArborWire
import CryptoKit
import Foundation
import Observation
import QuagmireExtras
#if os(iOS)
import Network
#endif

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
    /// Wire format the replica store was placed under; bump when accepted-update
    /// identity, request shapes, or canonical object encoding changes
    /// incompatibly. "3": collection-file directory descriptors and required
    /// transition arrays.
    static let replicaWireFormat = "3"

    private(set) var provider: any WorkspaceProvider
    private(set) var editorWorkspace: ArborEditorWorkspace
    private(set) var home: WorkspaceReference
    private(set) var launchLocation: WorkspaceLocation
    private(set) var generation = 0
    private(set) var capabilities: WorkspaceProviderCapabilities = .readOnly
    private(set) var providerDetail = "No tree open"
    private(set) var syncPresentation = WorkspaceSyncPresentation(
        state: .offline,
        detail: "Open a local tree to start arborsync"
    )
    private(set) var syncConflict: ReplicaConflictPresentation?
    private(set) var arborsyncProcessKind: ArborSyncProcessKind?
    private(set) var latestStructuralReceipt: WorkspaceStructuralReceipt?
    let linkPreviewService: LinkPreviewService
    var errorMessage: String?

    private var syncCoordinator: ReplicaSyncCoordinator?
    private var serverWatchTask: Task<Void, Never>?
#if os(macOS)
    private var supervisor: ArborSyncProcessSupervisor?
    private var arborsyncClient: ArborSyncRESTClient?
    private let bookmarks = SecurityScopedWorkspaceBookmarkStore()
    private var attemptedWorkspaceRestore = false
    private var overviewRefreshTask: Task<Void, Never>?
    private var overviewWatchTask: Task<Void, Never>?
    private(set) var localArborSyncOverview: LocalArborSyncOverview?
    private(set) var localArborSyncOverviewIsRefreshing = false
    private(set) var localArborSyncOverviewError: String?
    private(set) var localCanopyDevicesByConfigurationTree: [String: [LocalArborSyncDevicePresentation]] = [:]
#endif
#if os(iOS)
    private let nativePlacementStore = NativePlacementStore()
    private(set) var nativePlacements: [NativePlacementRecord] = []
    private let nativePathMonitor = NWPathMonitor()
    private let nativePathMonitorQueue = DispatchQueue(label: "org.nxhx.Arbor.canopy-path")
    private var nativeTransportAvailable = false
#endif

    init(provider suppliedProvider: InMemoryWorkspaceProvider? = nil) {
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
                detail: "Local test fixture; no server configured"
            )
        }
#if os(iOS)
        nativePathMonitor.pathUpdateHandler = { [weak self] path in
            let available = path.status == .satisfied
            Task { @MainActor [weak self] in
                await self?.setNativeTransportAvailable(available)
            }
        }
        nativePathMonitor.start(queue: nativePathMonitorQueue)
#endif
    }

    func place(tree: WireTreeDescriptor, from origin: URL, configurationTree: String? = nil, remember: Bool = true) async throws {
        _ = try tree.validated()
        serverWatchTask?.cancel()
        serverWatchTask = nil
        let credentialProvider: any WireCredentialProvider = configurationTree.map {
            AccountStoredCredentialProvider(configurationTree: $0, store: KeychainDeviceCredentialStore())
        } ?? StoredDeviceCredentialProvider(origin: origin, store: KeychainDeviceCredentialStore())
        let client = ArborWireClient(origin: origin, credentialProvider: credentialProvider)
        let transport = ArborWireReplicaTransport(client: client)
        let root = ArborSupportDirectories.root
        let key = tree.id.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? UUID().uuidString
        let replicaRoot = root.appending(path: "Replicas/\(key)", directoryHint: .isDirectory)
        // A replica records the wire format it was placed under. When the format
        // changes (accepted-update ids, cursors, and request shapes are not
        // continuous across such a change), the replica and its sync state cannot
        // resume against the server and are re-placed from a fresh snapshot.
        let formatMarker = replicaRoot.appending(path: "wire-format")
        let placedFormat = (try? String(contentsOf: formatMarker, encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines)
        let syncStateRoot = root.appending(path: "Sync/\(key)", directoryHint: .isDirectory)
        let replica: ArborReplica
        if placedFormat == Self.replicaWireFormat,
           FileManager.default.fileExists(atPath: replicaRoot.appending(path: "materialized/tree.json").path) {
            replica = try await ArborReplica.open(at: replicaRoot, tree: TreeID(rawValue: tree.id))
        } else {
            try? FileManager.default.removeItem(at: replicaRoot)
            try? FileManager.default.removeItem(at: syncStateRoot)
            replica = try await ReplicaPlacementService.place(tree: tree, at: replicaRoot, transport: transport)
            try Self.replicaWireFormat.write(to: formatMarker, atomically: true, encoding: .utf8)
        }
        let initiallyAvailable: Bool
#if os(iOS)
        initiallyAvailable = nativeTransportAvailable
#else
        initiallyAvailable = true
#endif
        let coordinator = try ReplicaSyncCoordinator(
            replica: replica,
            transport: transport,
            stateRoot: syncStateRoot,
            transportAvailable: initiallyAvailable
        )
#if os(macOS)
        if let supervisor { await supervisor.stop(); self.supervisor = nil }
        arborsyncClient = nil
        overviewRefreshTask?.cancel()
        overviewRefreshTask = nil
        overviewWatchTask?.cancel()
        overviewWatchTask = nil
        localArborSyncOverview = nil
#endif
        let nextProvider = ReplicaWorkspaceProvider(replica: replica) { [weak self] admission in
            await coordinator.syncImmediately(admission)
            await self?.refreshSyncPresentation(from: coordinator)
        }
#if os(iOS)
        if remember {
            try await nativePlacementStore.save(NativePlacementRecord(origin: origin, configurationTree: configurationTree, tree: tree))
            nativePlacements = try await nativePlacementStore.loadAll()
        }
#endif
        await switchProvider(
            nextProvider,
            home: WorkspaceReference(tree: TreeID(rawValue: tree.id), path: "/"),
            detail: "Offline replica · \(tree.canonicalPath ?? tree.id)"
        )
        syncCoordinator = coordinator
        syncPresentation = try await coordinator.presentation()
        syncConflict = try await coordinator.conflict()
        startServerWatch(client: client, tree: tree, coordinator: coordinator)
    }

#if os(iOS)
    private func setNativeTransportAvailable(_ available: Bool) async {
        nativeTransportAvailable = available
        guard let syncCoordinator else { return }
        await syncCoordinator.setTransportAvailable(available)
        await refreshSyncPresentation(from: syncCoordinator)
    }

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
        guard let placement = try await nativePlacementStore.load() else { return }
        try await NativeAccountService(origin: placement.origin, configurationTree: placement.configurationTree).forget()
        try await nativePlacementStore.clear(configurationTree: placement.configurationTree)
        nativePlacements = try await nativePlacementStore.loadAll()
        serverWatchTask?.cancel()
        serverWatchTask = nil
        if let syncCoordinator { await syncCoordinator.close() }
        syncCoordinator = nil
        syncConflict = nil
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
            if let client = arborsyncClient {
                for account in localArborSyncOverview?.accounts ?? [] {
                    guard account.credentialAvailable,
                          let origin = account.canopy,
                          await isLocalAccountAdministrator(account, client: client) else { continue }
                    accounts.append(ArborShareAccount(
                        configurationTree: account.configurationTree,
                        origin: origin,
                        handle: account.handle
                    ))
                }
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
              let client = arborsyncClient,
              let overview = localArborSyncOverview,
              let placedTree = overview.trees.first(where: { $0.id == tree }),
              let configurationTree = placedTree.configurationTree else {
            throw ArborWireValidationError.invalidValue("The current tree has no editable account configuration")
        }
        let ref = NodeRef(tree: configurationTree, path: "/trees.yaml", stableKey: nil)
        let file = try await client.file(ref)
        guard let source = String(data: file.bytes, encoding: .utf8) else {
            throw ArborWireValidationError.invalidValue("trees.yaml is not UTF-8")
        }
        let subject: ArborAccountAccessSubject = switch target {
        case .everyone: .everyone
        case .existing(let subject): subject
        case .profile(let locator): .profile(tree: try await resolveLocalProfile(locator, client: client, overview: overview, configurationTree: configurationTree))
        }
        let account = overview.accounts.first { $0.configurationTree == configurationTree }
        try ArborAccountConfigurationYAML.validateAccessChange(
            subject: subject,
            access: access,
            currentProfileTree: account?.profileTree
        )
        let next = try ArborAccountConfigurationYAML.replacingTrees(in: source) { trees in
            guard var declaration = trees[tree] else {
                throw ArborWireValidationError.invalidValue("The current tree is not declared by this account")
            }
            declaration.access.removeAll { $0.subject == subject }
            if access != "none" {
                declaration.access.append(ArborAccountAccessRule(subject: subject, access: access))
            }
            trees[tree] = declaration
        }
        _ = try await client.writeText(ref, baseContentRevision: file.revision, source: next)
        await refreshLocalArborSyncOverview()
        return try await loadLocalTreeAccess(tree: tree)
#endif
    }

    func createShareLink(tree: String, access: String) async throws -> NativeAccessLink {
#if os(iOS)
        guard let placement = nativePlacements.first(where: { $0.tree.id == tree }) else {
            throw ArborWireValidationError.invalidValue("The tree is not placed on this iPhone")
        }
        return try await NativeAccountService(
            origin: placement.origin,
            configurationTree: placement.configurationTree
        ).createAccessLink(tree: tree, access: access)
#else
        var generator = SystemRandomNumberGenerator()
        let bytes = (0..<32).map { _ in UInt8.random(in: .min ... .max, using: &generator) }
        let secret = Data(bytes).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        let digest = "sha256:" + SHA256.hash(data: Data(secret.utf8)).map { String(format: "%02x", $0) }.joined()
        let updated = try await setShareAccess(
            tree: tree,
            target: .existing(.link(digest: digest)),
            access: access
        )
        guard var components = URLComponents(string: updated.canonical) else {
            throw ArborWireValidationError.invalidValue("The tree has no valid canonical URL")
        }
        components.fragment = "arbor-access=\(secret)"
        guard let url = components.url else {
            throw ArborWireValidationError.invalidValue("The access-link URL could not be created")
        }
        return NativeAccessLink(url: url)
#endif
    }

#if os(macOS)
    private func isLocalAccountAdministrator(
        _ account: LocalCanopyAccountDescriptor,
        client: ArborSyncRESTClient
    ) async -> Bool {
        guard let deviceID = account.deviceID,
              let file = try? await client.file(.init(
                tree: account.configurationTree,
                path: "/devices.yaml",
                stableKey: nil
              )),
              let source = String(data: file.bytes, encoding: .utf8) else { return false }
        return (try? ArborAccountConfigurationYAML.isAdministrator(
            deviceID: deviceID,
            devicesSource: source
        )) == true
    }

    func localCanopyDevices(configurationTree: String) async throws -> [LocalArborSyncDevicePresentation] {
        guard let client = arborsyncClient,
              let account = localArborSyncOverview?.accounts.first(where: {
                  $0.configurationTree == configurationTree
              }) else {
            throw ArborSyncSupervisorError.incompatibleService("The Canopy account is unavailable")
        }
        let file = try await client.file(.init(
            tree: configurationTree,
            path: "/devices.yaml",
            stableKey: nil
        ))
        guard let source = String(data: file.bytes, encoding: .utf8) else {
            throw ArborWireValidationError.invalidValue("devices.yaml is not UTF-8")
        }
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
        guard let client = arborsyncClient,
              let account = localArborSyncOverview?.accounts.first(where: {
                  $0.configurationTree == configurationTree
              }) else {
            throw ArborSyncSupervisorError.incompatibleService("The Canopy account is unavailable")
        }
        let ref = NodeRef(tree: configurationTree, path: "/devices.yaml", stableKey: nil)
        let file = try await client.file(ref)
        guard let source = String(data: file.bytes, encoding: .utf8) else {
            throw ArborWireValidationError.invalidValue("devices.yaml is not UTF-8")
        }
        let devices = try ArborAccountConfigurationYAML.devices(from: source)
        try ArborAccountConfigurationYAML.validateAdministratorChange(
            devices: devices,
            currentDeviceID: account.deviceID,
            targetDeviceID: deviceID,
            administrator: administrator
        )
        let next = try ArborAccountConfigurationYAML.replacingDevices(in: source) { devices in
            guard var device = devices[deviceID] else {
                throw ArborWireValidationError.invalidValue("The device is no longer active")
            }
            device.administrator = administrator ? true : nil
            devices[deviceID] = device
        }
        _ = try await client.writeText(ref, baseContentRevision: file.revision, source: next)
        return try await localCanopyDevices(configurationTree: configurationTree)
    }

    func deauthorizeLocalCanopyDevice(
        configurationTree: String,
        deviceID: String
    ) async throws -> [LocalArborSyncDevicePresentation] {
        guard let client = arborsyncClient,
              let account = localArborSyncOverview?.accounts.first(where: {
                  $0.configurationTree == configurationTree
              }) else {
            throw ArborSyncSupervisorError.incompatibleService("The Canopy account is unavailable")
        }
        let ref = NodeRef(tree: configurationTree, path: "/devices.yaml", stableKey: nil)
        let file = try await client.file(ref)
        guard let source = String(data: file.bytes, encoding: .utf8) else {
            throw ArborWireValidationError.invalidValue("devices.yaml is not UTF-8")
        }
        let devices = try ArborAccountConfigurationYAML.devices(from: source)
        try ArborAccountConfigurationYAML.validateDeviceRemoval(
            devices: devices,
            currentDeviceID: account.deviceID,
            targetDeviceID: deviceID
        )
        let next = try ArborAccountConfigurationYAML.replacingDevices(in: source) { devices in
            devices[deviceID] = nil
        }
        _ = try await client.writeText(ref, baseContentRevision: file.revision, source: next)
        return try await localCanopyDevices(configurationTree: configurationTree)
    }

    private func loadLocalTreeAccess(tree: String) async throws -> NativeTreeAccessPresentation {
        if localArborSyncOverview == nil { await refreshLocalArborSyncOverview() }
        guard let client = arborsyncClient,
              let overview = localArborSyncOverview,
              let placedTree = overview.trees.first(where: { $0.id == tree }),
              let configurationTree = placedTree.configurationTree,
              let account = overview.accounts.first(where: { $0.configurationTree == configurationTree }) else {
            throw ArborWireValidationError.invalidValue("The current tree has no editable account configuration")
        }
        let treesRef = NodeRef(tree: configurationTree, path: "/trees.yaml", stableKey: nil)
        let devicesRef = NodeRef(tree: configurationTree, path: "/devices.yaml", stableKey: nil)
        async let treesFileRequest = client.file(treesRef)
        async let devicesFileRequest = client.file(devicesRef)
        let (treesFile, devicesFile) = try await (treesFileRequest, devicesFileRequest)
        guard let treesSource = String(data: treesFile.bytes, encoding: .utf8),
              let devicesSource = String(data: devicesFile.bytes, encoding: .utf8) else {
            throw ArborWireValidationError.invalidValue("Account configuration YAML is not UTF-8")
        }
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
            )
        )
    }

    private func resolveLocalProfile(
        _ input: String,
        client: ArborSyncRESTClient,
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
        guard locator.contains("://") else {
            throw ArborWireValidationError.invalidValue("Enter a person or group Arbor URL, handle, or TreeID")
        }
        return try await client.resolve(locator).ref.tree
    }

    func promoteLocalFolder(
        path: String,
        account: ArborShareAccount,
        canonical: String,
        publicAccess: String
    ) async throws {
        guard let client = arborsyncClient,
              publicAccess == "none" || publicAccess == "read" || publicAccess == "write",
              let canonicalURL = URL(string: canonical),
              let accountOrigin = URL(string: account.origin),
              canonicalURL.scheme == accountOrigin.scheme,
              canonicalURL.host == accountOrigin.host,
              canonicalURL.port == accountOrigin.port,
              canonicalURL.query == nil,
              canonicalURL.fragment == nil else {
            throw ArborWireValidationError.invalidValue("Enter a canonical URL on the selected Canopy")
        }
        let tree = try generateArborID(prefix: "tr")
        let ref = NodeRef(tree: account.configurationTree, path: "/trees.yaml", stableKey: nil)
        let file = try await client.file(ref)
        guard let source = String(data: file.bytes, encoding: .utf8) else {
            throw ArborWireValidationError.invalidValue("trees.yaml is not UTF-8")
        }
        let rules = publicAccess == "none" ? [] : [
            ArborAccountAccessRule(subject: .everyone, access: publicAccess)
        ]
        let next = try ArborAccountConfigurationYAML.replacingTrees(in: source) { trees in
            guard trees[tree] == nil else {
                throw ArborWireValidationError.invalidValue("The new TreeID is already declared")
            }
            trees[tree] = ArborHostedTreeDeclaration(canonical: canonical, access: rules)
        }
        _ = try await client.writeText(ref, baseContentRevision: file.revision, source: next)
        do {
            let placementsURL = ArborSupportDirectories.dataHome.appending(path: "placements.yaml")
            let placementsSource = (try? String(contentsOf: placementsURL, encoding: .utf8)) ?? "{}\n"
            let placements = try ArborLocalPlacementsYAML.adding(
                configurationTree: account.configurationTree,
                path: URL(fileURLWithPath: path).standardizedFileURL.path,
                tree: tree,
                to: placementsSource
            )
            try placements.write(to: placementsURL, atomically: true, encoding: .utf8)
            try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: placementsURL.path)
        } catch {
            if let latest = try? await client.file(ref),
               let latestSource = String(data: latest.bytes, encoding: .utf8),
               let rollback = try? ArborAccountConfigurationYAML.replacingTrees(in: latestSource, with: { $0[tree] = nil }) {
                _ = try? await client.writeText(ref, baseContentRevision: latest.revision, source: rollback)
            }
            throw error
        }
        try await client.synchronize(configurationTree: account.configurationTree)
        await refreshLocalArborSyncOverview()
        generation += 1
    }

    func openLocalWorkspace(_ url: URL, remember: Bool = true) async throws {
        try await editorWorkspace.flushAll()
        await editorWorkspace.closeAll()
        serverWatchTask?.cancel()
        serverWatchTask = nil
        if let supervisor { await supervisor.stop() }
        overviewRefreshTask?.cancel()
        overviewRefreshTask = nil
        overviewWatchTask?.cancel()
        overviewWatchTask = nil
        let usesTestHelper = ProcessInfo.processInfo.environment["ARBOR_TEST_BUNDLED_HELPER"] == "1"
        let launchPolicy: ArborSyncLaunchPolicy = .automatic
        // A signed test helper has an isolated data home and must never impersonate the
        // user's arborsync on its well-known port if the test host exits unexpectedly.
        let preferredPort = usesTestHelper ? 45_190 : 4_317
        let nextSupervisor = ArborSyncProcessSupervisor(launchPolicy: launchPolicy)
        do {
            let runtime = try await nextSupervisor.start(workspace: url, preferredPort: preferredPort)
            supervisor = nextSupervisor
            arborsyncClient = ArborSyncRESTClient(baseURL: runtime.origin)
            arborsyncProcessKind = runtime.attachedToExistingProcess ? .external : .supervised
            syncCoordinator = nil
            syncConflict = nil
            if remember { try await bookmarks.save(url) }
            await switchProvider(
                runtime.provider,
                home: runtime.home,
                launchLocation: runtime.launchLocation,
                detail: runtime.attachedToExistingProcess
                    ? "External Arbor Sync daemon · ~/.arbor"
                    : "Arbor-managed Sync daemon · ~/.arbor"
            )
            syncPresentation = WorkspaceSyncPresentation(
                state: .current,
                detail: "All macOS writes are owned by arborsync"
            )
            prefetchLocalArborSyncOverview()
        } catch {
            await nextSupervisor.stop()
            supervisor = nil
            arborsyncClient = nil
            arborsyncProcessKind = nil
            localArborSyncOverview = nil
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
                errorMessage = "The saved tree could not be reopened, so Arbor opened your home folder instead: \(restoreError.localizedDescription)"
            } catch {
                errorMessage = "Arbor could not start its filesystem provider: \(error.localizedDescription)"
            }
        }
    }

    func restartArborSync() async {
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
            arborsyncClient = ArborSyncRESTClient(baseURL: runtime.origin)
            arborsyncProcessKind = runtime.attachedToExistingProcess ? .external : .supervised
            await switchProvider(
                runtime.provider,
                home: runtime.home,
                launchLocation: runtime.launchLocation,
                detail: runtime.attachedToExistingProcess
                    ? "External Arbor Sync daemon · ~/.arbor"
                    : "Arbor-managed Sync daemon · ~/.arbor"
            )
            syncPresentation = WorkspaceSyncPresentation(state: .current, detail: "Reconnected to arborsync")
            prefetchLocalArborSyncOverview()
        } catch {
            errorMessage = error.localizedDescription
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
        let task = Task { @MainActor [weak self] in
            guard let self else { return }
            self.localArborSyncOverviewIsRefreshing = true
            defer {
                self.localArborSyncOverviewIsRefreshing = false
                self.overviewRefreshTask = nil
            }
            do {
                let overview = try await self.loadLocalArborSyncOverview()
                guard !Task.isCancelled else { return }
                self.localArborSyncOverview = overview
                self.localArborSyncOverviewError = nil
                self.startLocalOverviewWatch(after: overview.observedThrough)
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

    private func loadLocalArborSyncOverview() async throws -> LocalArborSyncOverview {
        guard let client = arborsyncClient else { throw ArborSyncSupervisorError.serviceUnavailable }
        async let credentialRequest = client.node(.path("/credentials", tree: "system"))
        async let treeListRequest = client.trees()
        async let accountsRequest = client.accounts()
        async let visitDirectoryRequest = client.node(.path("/visited", tree: "system"))
        let (credentials, treeList, accounts, visitDirectory) = try await (
            credentialRequest,
            treeListRequest,
            accountsRequest,
            visitDirectoryRequest
        )
        // Legacy singleton compatibility. Plural account presentation comes from /v1/accounts.
        let localConfiguration = try? loadLocalAccountConfiguration()
        let connected = credentials.properties.string("communityAccount") == "connected"
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
                missing: $0.missing == true
            )
        }
        async let visitsRequest = loadLocalArborSyncVisits(
            client: client,
            children: try await client.allChildren(visitDirectory.ref)
        )
        let visits = try await visitsRequest
        return LocalArborSyncOverview(
            origin: accounts.first?.canopy ?? (connected ? localConfiguration?.origin : nil),
            handle: accounts.first?.handle ?? (connected ? localConfiguration?.handle : nil),
            configurationTree: configurationTree,
            credentialAvailable: accounts.contains(where: \.credentialAvailable)
                || (connected && credentials.properties.bool("credentialAvailable") == true),
            accounts: accounts,
            trees: trees,
            visits: visits,
            devices: connected ? localConfiguration?.devices ?? [] : [],
            observedThrough: latestObservationCursor([
                credentials.observedThrough,
                treeList.observedThrough,
                visitDirectory.observedThrough,
            ])
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

    private func latestObservationCursor(_ cursors: [String]) -> String {
        cursors.max { lhs, rhs in
            let left = Int(lhs.split(separator: ":").last ?? "") ?? 0
            let right = Int(rhs.split(separator: ":").last ?? "") ?? 0
            return left < right
        } ?? ""
    }

    private func loadLocalArborSyncVisits(client: ArborSyncRESTClient, children: [NodeSummary]) async throws -> [LocalArborSyncVisitPresentation] {
        let values = try await withThrowingTaskGroup(of: (Int, LocalArborSyncVisitPresentation?).self) { group in
            for (index, child) in children.enumerated() {
                group.addTask {
                    let node = try await client.node(child.ref)
                    let fields = node.properties
                    guard
                          let id = fields.string("id"),
                          let tree = fields.string("tree"),
                          let locator = fields.string("locator") else { return (index, nil) }
                    return (index, LocalArborSyncVisitPresentation(
                        id: id,
                        tree: tree,
                        name: node.name,
                        locator: locator,
                        canonical: fields.string("canonical")
                    ))
                }
            }
            var loaded: [(Int, LocalArborSyncVisitPresentation?)] = []
            for try await value in group { loaded.append(value) }
            return loaded
        }
        return values.sorted { $0.0 < $1.0 }.compactMap(\.1)
    }

    private func startLocalOverviewWatch(after cursor: String) {
        guard overviewWatchTask == nil, let client = arborsyncClient else { return }
        overviewWatchTask = Task { @MainActor [weak self] in
            do {
                let observations = await client.observations(after: cursor)
                for try await event in observations {
                    guard !Task.isCancelled else { return }
                    guard event.tree == "system" || event.tree == self?.localArborSyncOverview?.configurationTree else { continue }
                    try await Task.sleep(for: .milliseconds(150))
                    guard !Task.isCancelled else { return }
                    await self?.refreshLocalArborSyncOverview()
                }
            } catch is CancellationError {
                return
            } catch {
                self?.localArborSyncOverviewError = error.localizedDescription
            }
            self?.overviewWatchTask = nil
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

    func syncNow(reportTransientNetworkErrors: Bool = true) async {
        guard let syncCoordinator else { return }
        do {
            // Manual and lifecycle refreshes must pull a clean replica as well
            // as reconcile a locally pending one. `syncOnce()` alone expresses
            // a local candidate and can leave a clean, stale replica dependent
            // on an indefinitely open watch connection.
            syncPresentation = try await syncCoordinator.recoverWatchGap()
            syncConflict = try await syncCoordinator.conflict()
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
#if os(macOS)
        overviewRefreshTask?.cancel()
        overviewWatchTask?.cancel()
        overviewRefreshTask = nil
        overviewWatchTask = nil
        if let supervisor { await supervisor.stop() }
        arborsyncClient = nil
        arborsyncProcessKind = nil
#endif
    }

    @discardableResult
    func perform(_ action: WorkspaceStructuralAction) async throws -> WorkspaceNode? {
        let result = try await provider.perform(action)
        latestStructuralReceipt = WorkspaceStructuralReceipt(action: action, result: result)
        return result
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
        latestStructuralReceipt = nil
        generation += 1
        errorMessage = nil
    }

    private func startServerWatch(
        client: ArborWireClient,
        tree: WireTreeDescriptor,
        coordinator: ReplicaSyncCoordinator
    ) {
        serverWatchTask = Task { [weak self] in
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
                } catch let error as WireHTTPError where error.code == "resync-required" {
                    do {
                        _ = try await coordinator.recoverWatchGap()
                        lastEventID = try await coordinator.watchCursor()
                        reconnectAttempt = 0
                        await self?.refreshSyncPresentation(from: coordinator)
                    } catch {
                        reconnectAttempt += 1
                    }
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
    private(set) var tabVersion = 0
    private(set) var isLoading = false
    private(set) var titleRenameProposal: TitleRenameProposal?
    private(set) var linkedPageTrashPrompt: LinkedPageTrashPrompt?
    private var retainedPagePresentations: [PagePresentationKey: PagePresentation] = [:]
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
        guard observedWorkspaceGeneration != workspace.generation else {
            if node == nil { await load() }
            return
        }
        observedWorkspaceGeneration = workspace.generation
        editorHost?.resolveMoveRequest(with: nil)
        editorHost?.resolveStructuralMoveRequest(with: nil)
        await releaseAllPagePresentations()
        tabs = BrowserTabController(launchLocation: workspace.launchLocation)
        sidebarLocation = workspace.launchLocation
        tabVersion += 1
        await load()
    }

    func load() async {
        loadRequestID += 1
        let requestID = loadRequestID
        isLoading = true
        linkedPageTrashPrompt = nil
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
                    performStructuralAction: { [weak workspace] action in
                        try await workspace?.perform(action)
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
        retainCurrentPagePresentation()
        tabs.navigate(to: location)
        tabVersion += 1
        await loadOrRestoreCurrentPage()
    }

    func navigate(to reference: WorkspaceReference) async {
        await navigate(to: location(for: reference))
    }

    func goBack() async { retainCurrentPagePresentation(); tabs.goBack(); tabVersion += 1; await loadOrRestoreCurrentPage() }
    func goForward() async { retainCurrentPagePresentation(); tabs.goForward(); tabVersion += 1; await loadOrRestoreCurrentPage() }
    func goParent() async { retainCurrentPagePresentation(); tabs.goParent(); tabVersion += 1; await loadOrRestoreCurrentPage() }
    func goHome() async {
        guard let home = treeHomeLocation else { return }
        retainCurrentPagePresentation()
        tabs.goHome(to: home)
        tabVersion += 1
        await loadOrRestoreCurrentPage()
    }

    func setNavigationPath(_ path: [WorkspaceLocation]) {
        guard path != tabs.navigationPath else { return }
        retainCurrentPagePresentation()
        tabs.setNavigationPath(path)
        tabVersion += 1
        if !restoreCurrentPagePresentation() {
            isLoading = true
            Task {
                await load()
                await pruneRetainedPagePresentations()
            }
        } else {
            Task {
                await loadBacklinks()
                await pruneRetainedPagePresentations()
            }
        }
    }

    func newTab() async {
        retainCurrentPagePresentation()
        tabs.newTab()
        tabVersion += 1
        await loadOrRestoreCurrentPage()
    }

    func openInNewTab(_ location: WorkspaceLocation) async {
        retainCurrentPagePresentation()
        tabs.newTab(at: location)
        tabVersion += 1
        await loadOrRestoreCurrentPage()
    }

    func closeSelectedTab() async {
        let closedTabID = selectedTabID
        retainCurrentPagePresentation()
        tabs.closeTab(selectedTabID)
        tabVersion += 1
        await releaseRetainedPagePresentations(for: closedTabID)
        await loadOrRestoreCurrentPage()
    }

    func selectTab(_ id: UUID) async {
        guard id != selectedTabID else { return }
        retainCurrentPagePresentation()
        tabs.selectTab(id)
        tabVersion += 1
        await loadOrRestoreCurrentPage()
    }

    private func retainCurrentPagePresentation() {
        guard let node else { return }
        editorHost?.resolveMoveRequest(with: nil)
        editorHost?.resolveStructuralMoveRequest(with: nil)
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

    private func loadOrRestoreCurrentPage() async {
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
        presentation.editorHost?.resolveMoveRequest(with: nil)
        presentation.editorHost?.resolveStructuralMoveRequest(with: nil)
        if let lease = presentation.editorLease {
            await workspace.editorWorkspace.release(lease)
        }
    }

    private func releaseAllPagePresentations() async {
        if let editorLease {
            editorHost?.resolveMoveRequest(with: nil)
            editorHost?.resolveStructuralMoveRequest(with: nil)
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
        searchRequestID += 1
        let requestID = searchRequestID
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
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
            let result = try await workspace.perform(action)
            if navigateToResult, let result { await navigate(to: result.reference) }
            else if let receipt = workspace.latestStructuralReceipt { await reconcile(receipt) }
        } catch { errorMessage = error.localizedDescription }
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
        if let result = receipt.result, result.reference.identity == node?.reference.identity {
            node = result
            binding?.reconcileReference(result.reference)
            tabs.reconcileReference(result.reference)
            tabVersion += 1
            switch result.surface {
            case .directory, .directoryDocument, .collection:
                sidebarLocation = result.location
            default:
                sidebarLocation = result.location.parent ?? workspace.launchLocation
            }
        }
        do {
            children = try await workspace.provider.children(of: sidebarLocation)
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
                await navigate(to: homeNode.reference)
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
