import Quagmire
import Overstory
import StoryKit
import SwiftUI
#if os(macOS)
import AppKit
#endif

@main
struct StoryApplication: App {
    @State private var workspace = StoryWorkspaceState()

    init() {
        StoryLaunchTiming.milestone("app-init")
        ProtocolNetworkLog.install(ProtocolNetworkLog(directory: StorySupportDirectories.networkLogs))
#if os(macOS)
        StoryMenuBar.shared.updates = updates
#endif
    }
#if os(macOS)
    @NSApplicationDelegateAdaptor(StoryApplicationDelegate.self) private var appDelegate
    private let updates = StoryUpdates()
#endif

    var body: some Scene {
        WindowGroup(for: StoryWindowRequest.self) { $request in
#if os(iOS)
            StoryIOSLaunchView(workspace: workspace, windowRequest: request?.id)
                .modifier(StoryHostCompatibilityGate())
#else
            StoryMacLaunchView(workspace: workspace, windowRequest: request?.id)
                .task { appDelegate.workspace = workspace }
#endif
        }
#if os(iOS)
        .commands {
            StoryNavigationCommands()
        }
#endif
    }
}

/// What a new window opens on: a page, or the tree's home. Each request is
/// its own window, even for a page another window already shows.
struct StoryWindowRequest: Codable, Hashable {
    var id = UUID()
    var location: WorkspaceLocation?
    /// On the Mac, the window whose tab group the new window joins as a tab.
    var tabGroupWindow: Int?
    /// Whether a new tab becomes the selected one, or opens behind.
    var selecting = true
}

/// Requested windows' pages, until each new window takes its own. The
/// window's request value names it; a window that appears without one (the
/// value can arrive after the window's first view) takes the newest request
/// made moments ago.
@MainActor
enum StoryWindowRequests {
    private static var pending: [(request: StoryWindowRequest, at: Date)] = []

    static func add(_ request: StoryWindowRequest) {
        pending.removeAll { Date().timeIntervalSince($0.at) > 30 }
        pending.append((request, Date()))
    }

    static func take(_ id: UUID?) -> StoryWindowRequest? {
        let index = id.flatMap { id in pending.firstIndex { $0.request.id == id } }
            ?? pending.indices.last.flatMap { Date().timeIntervalSince(pending[$0].at) < 5 ? $0 : nil }
        guard let index else { return nil }
        return pending.remove(at: index).request
    }
}

#if os(iOS)
/// The hardware-keyboard menus on iPad. The Mac menu bar is `StoryMenuBar`.
private struct StoryNavigationCommands: Commands {
    @FocusedValue(\.storyWindowCommands) private var commands
    @FocusedValue(\.editorCommands) private var editorCommands

    var body: some Commands {
        CommandGroup(after: .newItem) {
            Button("New Page") { commands?.newPage() }
                .keyboardShortcut("n", modifiers: .command)
                .disabled(commands?.canCreatePage != true)
            Divider()
            Button("Open Location…") { commands?.openLocation() }
                .keyboardShortcut("l", modifiers: .command)
                .disabled(commands == nil)
            Divider()
            Button("New Window") { commands?.newWindow() }
                .keyboardShortcut("n", modifiers: [.command, .option])
        }
        CommandGroup(after: .sidebar) {
            Button("Back") { commands?.goBack() }
                .keyboardShortcut("[", modifiers: .command)
                .disabled(commands?.canGoBack != true)
            Button("Forward") { commands?.goForward() }
                .keyboardShortcut("]", modifiers: .command)
                .disabled(commands?.canGoForward != true)
            Button("Go to Parent") { commands?.goParent() }
                .keyboardShortcut(.upArrow, modifiers: .command)
                .disabled(commands?.canGoParent != true)
            Button("Home") { commands?.goHome() }
                .keyboardShortcut("h", modifiers: [.command, .shift])
                .disabled(commands?.canGoHome != true)
        }
        CommandGroup(after: .pasteboard) {
            Button("Find in Page…") { editorCommands?.perform(.findInPage) }
                .keyboardShortcut("f", modifiers: .command)
                .disabled(editorCommands == nil)
        }
    }
}
#endif

#if os(macOS)
@MainActor
final class StoryApplicationDelegate: NSObject, NSApplicationDelegate {
    var workspace: StoryWorkspaceState?
    private var terminationPending = false

    /// AppKit adds dictation and Emoji & Symbols to the Edit menu it finds at launch.
    func applicationWillFinishLaunching(_ notification: Notification) {
        StoryMenuBar.shared.install()
        StoryAppIconSelection.shared.restore()
    }

    /// A placed tree's host older than this Story stops it here (Sharing 004).
    func applicationDidFinishLaunching(_ notification: Notification) {
        Task { @MainActor in
            guard let tooOld = await StoryHostCompatibility.checkPlacedHosts() else { return }
            StoryHostCompatibility.refuseToStart(tooOld)
        }
    }

    func applicationWillUpdate(_ notification: Notification) {
        StoryMenuBar.shared.install()
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let workspace, !terminationPending else { return terminationPending ? .terminateLater : .terminateNow }
        terminationPending = true
        Task { @MainActor in
            await workspace.shutdown()
            sender.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }
}
#endif

// MARK: Hosts older than this Story

/// Each host states its protocol level in `GET /.overstory/health` (locators
/// §5; absent is level 1). Story checks the hosts of its placed trees at
/// launch and refuses to start when one is below `minimumHostProtocol`,
/// rather than talk to it and fail in odd ways: a self-hosted community keeps
/// the overstoryd image it pulled until its owner redeploys (Sharing 004).
enum StoryHostCompatibility {
    /// The lowest host protocol level this Story works with. Raise it, after
    /// raising overstoryd's `HOST_PROTOCOL`, when Story starts depending on
    /// something older hosts lack.
    static let minimumHostProtocol = 1

    struct TooOld: Equatable, Sendable {
        var host: String
        var hostProtocol: Int
    }

    /// The level a health answer states, or nil when it is not a health answer.
    static func hostProtocol(fromHealth data: Data) -> Int? {
        struct Health: Decodable { var status: String?; var `protocol`: Int? }
        guard let health = try? JSONDecoder().decode(Health.self, from: data), health.status != nil else { return nil }
        guard let level = health.protocol, level >= 1 else { return 1 }
        return level
    }

    /// The first of `origins` whose host states a level below the minimum.
    /// A host that doesn't answer (offline, slow, not a host) passes: this
    /// check never keeps Story from starting without a network.
    static func check(origins: [URL], minimum: Int = minimumHostProtocol) async -> TooOld? {
        var seen = Set<String>()
        let unique = origins.compactMap { origin -> URL? in
            guard let scheme = origin.scheme, let host = origin.host() else { return nil }
            let base = "\(scheme)://\(host)\(origin.port.map { ":\($0)" } ?? "")"
            guard seen.insert(base).inserted else { return nil }
            return URL(string: base)
        }
        return await withTaskGroup(of: TooOld?.self) { group in
            for origin in unique {
                group.addTask {
                    var request = URLRequest(url: origin.appending(path: ".overstory/health"))
                    request.timeoutInterval = 5
                    guard let (data, response) = try? await URLSession.shared.data(for: request),
                          (response as? HTTPURLResponse)?.statusCode == 200,
                          let level = hostProtocol(fromHealth: data), level < minimum else { return nil }
                    return TooOld(host: origin.host() ?? origin.absoluteString, hostProtocol: level)
                }
            }
            for await result in group { if let result { group.cancelAll(); return result } }
            return nil
        }
    }

    /// The hosts of the trees placed on this device.
    static func checkPlacedHosts() async -> TooOld? {
        let placements = (try? NativePlacementStore.all()) ?? []
        return await check(origins: placements.map(\.origin))
    }

    static let title = "Story can't start"

    static func message(_ tooOld: TooOld) -> String {
        "\(tooOld.host) runs an older version of overstoryd than this version of Story needs. "
            + "Whoever runs \(tooOld.host) needs to update it: on Railway, redeploy the service to pull the newest image. "
            + "Story will start once the host is updated."
    }

#if os(macOS)
    /// Say why, then quit.
    @MainActor
    static func refuseToStart(_ tooOld: TooOld) {
        let alert = NSAlert()
        alert.alertStyle = .critical
        alert.messageText = title
        alert.informativeText = message(tooOld)
        alert.addButton(withTitle: "Quit Story")
        alert.runModal()
        NSApp.terminate(nil)
    }
#endif
}

#if os(iOS)
/// On the iPhone, which can't quit itself, a host older than this Story
/// covers the app with the reason instead (Sharing 004).
private struct StoryHostCompatibilityGate: ViewModifier {
    @State private var tooOld: StoryHostCompatibility.TooOld?

    func body(content: Content) -> some View {
        Group {
            if let tooOld {
                ContentUnavailableView {
                    Label(StoryHostCompatibility.title, systemImage: "exclamationmark.triangle")
                } description: {
                    Text(StoryHostCompatibility.message(tooOld))
                }
            } else {
                content
            }
        }
        .task { tooOld = await StoryHostCompatibility.checkPlacedHosts() }
    }
}
#endif
