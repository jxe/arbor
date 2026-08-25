import Quagmire
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
#if os(iOS)
            ArborIOSLaunchView(workspace: workspace)
#else
            ArborRootView(workspace: workspace)
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
            Button("New Document…") { commands?.newDocument() }
                .disabled(commands == nil)
            Button("New Folder…") { commands?.newFolder() }
                .disabled(commands == nil)
            Divider()
#if os(macOS)
            Button("Open Local Workspace…") { commands?.openLocalWorkspace() }
                .keyboardShortcut("o", modifiers: [.command, .shift])
                .disabled(commands == nil)
#endif
            Button("Open Location…") { commands?.openLocation() }
                .keyboardShortcut("l", modifiers: .command)
                .disabled(commands == nil)
#if os(macOS)
            Button("Pair iPhone…") { commands?.showPairing() }
                .disabled(commands == nil)
#endif
            Divider()
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
            Button("Forward") { commands?.goForward() }
                .keyboardShortcut("]", modifiers: .command)
                .disabled(commands?.canGoForward != true)
            Button("Go to Parent") { commands?.goParent() }
                .keyboardShortcut(.upArrow, modifiers: .command)
                .disabled(commands?.canGoParent != true)
            Button("Home") { commands?.goHome() }
                .keyboardShortcut("h", modifiers: [.command, .shift])
                .disabled(commands == nil)
            Divider()
            Button("Linked From…") { commands?.showBacklinks() }
                .disabled(commands?.hasNode != true)
            Button("Source and Properties…") { commands?.showSource() }
                .keyboardShortcut("i", modifiers: .command)
                .disabled(commands?.hasNode != true)
            Button("Save and Sync…") { commands?.showSyncStatus() }
                .disabled(commands == nil)
        }
#if os(macOS)
        CommandGroup(replacing: .undoRedo) {
            ArborUndoRedoMenuItems()
        }
        CommandGroup(after: .pasteboard) {
            Divider()
            ArborEditorBlockMenuItems()
        }
        CommandMenu("Format") {
            ArborEditorFormatMenuItems()
        }
#endif
    }
}

#if os(macOS)
private struct ArborUndoRedoMenuItems: View {
    @FocusedValue(\.documentUndoController) private var undoController

    var body: some View {
        Button("Undo") { undoController?.undo() }
            .keyboardShortcut("z", modifiers: .command)
            .disabled(undoController == nil)
        Button("Redo") { undoController?.redo() }
            .keyboardShortcut("z", modifiers: [.command, .shift])
            .disabled(undoController == nil)
    }
}

private struct ArborEditorCommandButton: View {
    let title: LocalizedStringKey
    let key: KeyEquivalent
    var modifiers: EventModifiers = .command
    var requires: EditorPredicate?
    let action: EditorAction
    @FocusedValue(\.editorCommands) private var commands

    var body: some View {
        Button(title) { commands?.perform(action) }
            .keyboardShortcut(key, modifiers: modifiers)
            .disabled(isDisabled)
    }

    private var isDisabled: Bool {
        guard let commands else { return true }
        if let requires, !commands.can(requires) { return true }
        return false
    }
}

private struct ArborEditorBlockMenuItems: View {
    var body: some View {
        ArborEditorCommandButton(title: "Turn Selected Block Into…", key: "/", action: .openBlockActionMenu)
        ArborEditorCommandButton(title: "Create Page from Selected Block…", key: "k", action: .toggleLinkOrDocument)
        ArborEditorCommandButton(title: "Insert Block Below", key: .return, action: .newBlockBelow)
        ArborEditorCommandButton(
            title: "Move Selected Blocks…",
            key: "m",
            modifiers: [.command, .shift],
            action: .openMoveTo
        )
        Divider()
        ArborEditorCommandButton(title: "Indent Selected Blocks", key: .tab, modifiers: [], requires: .canIndent, action: .indent)
        ArborEditorCommandButton(title: "Outdent Selected Blocks", key: .tab, modifiers: .shift, requires: .canOutdent, action: .outdent)
        Divider()
        ArborEditorCommandButton(title: "Move Selected Blocks Up", key: .upArrow, modifiers: .option, action: .moveBlockUp)
        ArborEditorCommandButton(title: "Move Selected Blocks Down", key: .downArrow, modifiers: .option, action: .moveBlockDown)
    }
}

private struct ArborEditorFormatMenuItems: View {
    var body: some View {
        ArborEditorCommandButton(title: "Bold", key: "b", action: .toggleInlineMark(.bold))
        ArborEditorCommandButton(title: "Italic", key: "i", action: .toggleInlineMark(.italic))
        ArborEditorCommandButton(title: "Inline Code", key: "e", action: .toggleInlineMark(.code))
        ArborEditorCommandButton(
            title: "Strikethrough",
            key: "s",
            modifiers: [.command, .shift],
            action: .toggleInlineMark(.strikethrough)
        )
    }
}
#endif

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
