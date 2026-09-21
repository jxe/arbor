import Foundation
import Observation

public struct BrowserTabPresentation: Hashable, Codable, Sendable {
    public var selection: String?
    public var scrollAnchor: String?
    public var inspectorPresented: Bool

    public init(selection: String? = nil, scrollAnchor: String? = nil, inspectorPresented: Bool = false) {
        self.selection = selection
        self.scrollAnchor = scrollAnchor
        self.inspectorPresented = inspectorPresented
    }
}

public struct BrowserTab: Hashable, Codable, Sendable, Identifiable {
    public var id: UUID
    public var current: WorkspaceLocation
    public var back: [WorkspaceLocation]
    public var forward: [WorkspaceLocation]
    public var presentation: BrowserTabPresentation

    public init(id: UUID = UUID(), current: WorkspaceLocation) {
        self.id = id
        self.current = current
        self.back = []
        self.forward = []
        self.presentation = BrowserTabPresentation()
    }
}

@MainActor
@Observable
public final class BrowserTabController {
    public private(set) var tabs: [BrowserTab]
    public private(set) var selectedTabID: UUID
    public private(set) var launchLocation: WorkspaceLocation
    public var sidebarPresented = true

    public init(launchLocation: WorkspaceLocation) {
        let tab = BrowserTab(current: launchLocation)
        self.launchLocation = launchLocation
        self.tabs = [tab]
        self.selectedTabID = tab.id
    }

    public convenience init(home: WorkspaceReference) {
        self.init(launchLocation: .reference(home))
    }

    public var selectedTab: BrowserTab {
        tabs[index(of: selectedTabID)]
    }

    public var canGoBack: Bool { !selectedTab.back.isEmpty }
    public var canGoForward: Bool { !selectedTab.forward.isEmpty }
    public var canGoParent: Bool { selectedTab.current.parent != nil }
    public var navigationRoot: WorkspaceLocation {
        selectedTab.back.first ?? selectedTab.current
    }
    public var navigationPath: [WorkspaceLocation] {
        guard !selectedTab.back.isEmpty else { return [] }
        return Array(selectedTab.back.dropFirst()) + [selectedTab.current]
    }

    @discardableResult
    public func newTab(at location: WorkspaceLocation? = nil) -> UUID {
        let tab = BrowserTab(current: location ?? launchLocation)
        tabs.append(tab)
        selectedTabID = tab.id
        return tab.id
    }

    public func closeTab(_ id: UUID) {
        guard tabs.count > 1, let position = tabs.firstIndex(where: { $0.id == id }) else { return }
        tabs.remove(at: position)
        if selectedTabID == id { selectedTabID = tabs[min(position, tabs.count - 1)].id }
    }

    public func selectTab(_ id: UUID) {
        guard tabs.contains(where: { $0.id == id }) else { return }
        selectedTabID = id
    }

    public func navigate(to location: WorkspaceLocation) {
        mutateSelected { tab in
            guard tab.current != location else { return }
            tab.back.append(tab.current)
            tab.current = location
            tab.forward.removeAll()
        }
    }

    public func goBack() {
        mutateSelected { tab in
            guard let previous = tab.back.popLast() else { return }
            tab.forward.append(tab.current)
            tab.current = previous
        }
    }

    public func goForward() {
        mutateSelected { tab in
            guard let next = tab.forward.popLast() else { return }
            tab.back.append(tab.current)
            tab.current = next
        }
    }

    public func goParent() {
        if let parent = selectedTab.current.parent { navigate(to: parent) }
    }

    public func goHome(to location: WorkspaceLocation) { returnTo(location) }

    /// Pops back to `location` when it is already on this tab's trail, as if
    /// Back were pressed until it was reached; otherwise pushes it.
    public func returnTo(_ location: WorkspaceLocation) {
        mutateSelected { tab in
            guard tab.current != location else { return }
            guard let index = tab.back.lastIndex(of: location) else {
                tab.back.append(tab.current)
                tab.current = location
                tab.forward.removeAll()
                return
            }
            let popped = Array(tab.back[(index + 1)...]) + [tab.current]
            tab.forward.append(contentsOf: popped.reversed())
            tab.back.removeSubrange(index...)
            tab.current = location
        }
    }
    public func replaceCurrent(with location: WorkspaceLocation) {
        mutateSelected { $0.current = location }
    }

    /// Replace stale path hints for one stable identity without adding a
    /// navigation step or disturbing per-tab presentation.
    public func reconcileReference(_ reference: WorkspaceReference) {
        let identity = reference.identity
        let reconcile: (WorkspaceLocation) -> WorkspaceLocation = { location in
            guard case let .reference(current) = location, current.identity == identity else { return location }
            return .reference(reference)
        }
        launchLocation = reconcile(launchLocation)
        for index in tabs.indices {
            tabs[index].current = reconcile(tabs[index].current)
            tabs[index].back = tabs[index].back.map(reconcile)
            tabs[index].forward = tabs[index].forward.map(reconcile)
        }
    }

    /// Reconciles a system NavigationStack pop with this tab's browser history.
    /// Programmatic pushes continue to flow through `navigate(to:)`, while a
    /// native back gesture or toolbar action writes the shorter visible path.
    public func setNavigationPath(_ path: [WorkspaceLocation]) {
        let root = navigationRoot
        let previous = navigationPath
        guard path != previous else { return }
        mutateSelected { tab in
            if path.count < previous.count, Array(previous.prefix(path.count)) == path {
                tab.forward.append(contentsOf: previous.dropFirst(path.count).reversed())
            } else {
                tab.forward.removeAll()
            }
            if let current = path.last {
                tab.current = current
                tab.back = [root] + path.dropLast()
            } else {
                tab.current = root
                tab.back = []
            }
        }
    }

    public func updatePresentation(_ presentation: BrowserTabPresentation) {
        mutateSelected { $0.presentation = presentation }
    }

    private func index(of id: UUID) -> Int {
        tabs.firstIndex(where: { $0.id == id })!
    }

    private func mutateSelected(_ body: (inout BrowserTab) -> Void) {
        body(&tabs[index(of: selectedTabID)])
    }
}
