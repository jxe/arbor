import ArborKit
import ArborQuagmire
import ArborReplica
import ArborSync
import ArborWire
import Foundation
import Observation

@MainActor
@Observable
final class ArborAppModel {
    private(set) var provider: any WorkspaceProvider
    private(set) var tabs: BrowserTabController
    private(set) var editorWorkspace: ArborEditorWorkspace
    private(set) var node: WorkspaceNode?
    private(set) var children: [WorkspaceNode] = []
    private(set) var errorMessage: String?
    private(set) var editorLease: ArborEditorLease?
    private(set) var editorHost: ArborEditorHost?
    private(set) var syncPresentation = WorkspaceSyncPresentation(
        state: .offline,
        detail: "Local sample workspace; no authority configured"
    )
    private var syncCoordinator: ReplicaSyncCoordinator?

    init(provider: InMemoryWorkspaceProvider = .sample()) {
        self.provider = provider
        self.editorWorkspace = ArborEditorWorkspace(provider: provider)
        self.tabs = BrowserTabController(home: WorkspaceReference(tree: "tr_sample", path: "/"))
    }

    var currentReference: WorkspaceReference { tabs.selectedTab.current }
    var canGoBack: Bool { tabs.canGoBack }
    var canGoForward: Bool { tabs.canGoForward }
    var canGoParent: Bool { tabs.canGoParent }

    func load() async {
        do {
            if let editorLease {
                await editorWorkspace.release(editorLease)
                self.editorLease = nil
                editorHost = nil
            }
            node = try await provider.resolve(currentReference)
            children = try await provider.children(of: currentReference)
            if node?.surface.supportsDocumentSession == true, node?.isWritable == true {
                let lease = try await editorWorkspace.lease(currentReference)
                editorLease = lease
                editorHost = ArborEditorHost(
                    binding: lease.binding,
                    provider: provider,
                    open: { [weak self] reference in Task { await self?.navigate(to: reference) } },
                    navigateBack: { [weak self] in Task { await self?.goBack() } }
                )
            }
            errorMessage = nil
        } catch {
            node = nil
            children = []
            errorMessage = String(describing: error)
        }
    }

    func navigate(to reference: WorkspaceReference) async {
        tabs.navigate(to: reference)
        await load()
    }

    func goBack() async { tabs.goBack(); await load() }
    func goForward() async { tabs.goForward(); await load() }
    func goParent() async { tabs.goParent(); await load() }
    func goHome() async { tabs.goHome(); await load() }

    func place(tree: AuthorityTreeDescriptor, from origin: URL) async throws {
        if let editorLease {
            await editorWorkspace.release(editorLease)
            self.editorLease = nil
            editorHost = nil
        }
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
        let nextProvider = ReplicaWorkspaceProvider(replica: replica)
        provider = nextProvider
        editorWorkspace = ArborEditorWorkspace(provider: nextProvider)
        tabs = BrowserTabController(home: WorkspaceReference(tree: TreeID(rawValue: tree.id), path: "/"))
        let coordinator = try ReplicaSyncCoordinator(
            replica: replica,
            transport: transport,
            stateRoot: root.appending(path: "Sync/\(key)", directoryHint: .isDirectory)
        )
        syncCoordinator = coordinator
        syncPresentation = try await coordinator.presentation()
        await load()
    }

    func syncNow() async {
        guard let syncCoordinator else { return }
        do { syncPresentation = try await syncCoordinator.syncOnce() }
        catch { syncPresentation = (try? await syncCoordinator.presentation()) ?? .init(state: .offline, detail: String(describing: error)) }
    }
}
