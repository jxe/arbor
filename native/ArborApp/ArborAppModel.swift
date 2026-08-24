import ArborKit
import Foundation
import Observation

@MainActor
@Observable
final class ArborAppModel {
    let provider: InMemoryWorkspaceProvider
    let tabs: BrowserTabController
    private(set) var node: WorkspaceNode?
    private(set) var children: [WorkspaceNode] = []
    private(set) var errorMessage: String?

    init(provider: InMemoryWorkspaceProvider = .sample()) {
        self.provider = provider
        self.tabs = BrowserTabController(home: WorkspaceReference(tree: "tr_sample", path: "/"))
    }

    var currentReference: WorkspaceReference { tabs.selectedTab.current }
    var canGoBack: Bool { tabs.canGoBack }
    var canGoForward: Bool { tabs.canGoForward }
    var canGoParent: Bool { tabs.canGoParent }

    func load() async {
        do {
            node = try await provider.resolve(currentReference)
            children = try await provider.children(of: currentReference)
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
}
