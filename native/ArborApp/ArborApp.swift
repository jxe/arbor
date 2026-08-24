import SwiftUI
#if os(macOS)
import AppKit
#endif

@main
struct ArborApplication: App {
    @State private var workspace = ArborWorkspaceState()
#if os(macOS)
    @NSApplicationDelegateAdaptor(ArborApplicationDelegate.self) private var appDelegate
#endif

    var body: some Scene {
        WindowGroup {
            ArborRootView(workspace: workspace)
#if os(macOS)
                .task { appDelegate.workspace = workspace }
#endif
        }
        .commands {
            ArborNavigationCommands()
        }
    }
}

private struct ArborNavigationCommands: Commands {
    @FocusedValue(\.arborWindowCommands) private var commands

    var body: some Commands {
        CommandGroup(after: .newItem) {
            Button("New Tab") { commands?.newTab() }
                .keyboardShortcut("t", modifiers: .command)
            Button("Close Tab") { commands?.closeTab() }
                .keyboardShortcut("w", modifiers: .command)
                .disabled(commands?.canCloseTab != true)
            Divider()
            Button("Search This Tree…") { commands?.showSearch() }
                .keyboardShortcut("p", modifiers: .command)
            Button("Recover…") { commands?.showHistory() }
                .keyboardShortcut("\\", modifiers: [.command, .shift])
                .disabled(commands?.hasDocument != true)
        }
        CommandGroup(after: .sidebar) {
            Button("Back") { commands?.goBack() }
                .keyboardShortcut("[", modifiers: .command)
                .disabled(commands?.canGoBack != true)
            Button("Home") { commands?.goHome() }
                .keyboardShortcut("h", modifiers: [.command, .shift])
                .disabled(commands == nil)
        }
    }
}

#if os(macOS)
@MainActor
final class ArborApplicationDelegate: NSObject, NSApplicationDelegate {
    var workspace: ArborWorkspaceState?
    private var terminationPending = false

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
