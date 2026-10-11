import Quagmire
import Overstory
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
        WindowGroup {
#if os(iOS)
            StoryIOSLaunchView(workspace: workspace)
#else
            StoryMacLaunchView(workspace: workspace)
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
            Button("New Tab") { commands?.newTab() }
                .keyboardShortcut("t", modifiers: .command)
            Button("Close Tab") { commands?.closeTab() }
                .keyboardShortcut("w", modifiers: .command)
                .disabled(commands?.canCloseTab != true)
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
