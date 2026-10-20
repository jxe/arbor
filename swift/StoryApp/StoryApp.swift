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
            Button("Recover…") { commands?.showHistory() }
                .keyboardShortcut("\\", modifiers: [.command, .shift])
                .disabled(commands?.hasDocument != true)
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
            Button("Source and Properties…") { commands?.showSource() }
                .keyboardShortcut("i", modifiers: .command)
                .disabled(commands?.hasNode != true)
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
