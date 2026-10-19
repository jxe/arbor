#if os(macOS)
import AppKit
import Quagmire
import SwiftUI

/// The Mac menu bar: Story, Tree, Page, Edit, Format, View, Go, Window, Help.
///
/// It is built in AppKit because SwiftUI fixes the order of its own menus
/// (File, Edit, View, then every `CommandMenu`) and drops Edit when they are
/// moved. Each window hands its commands over through `StoryMenuBarBridge`,
/// and the items act on the key window's.
@MainActor
final class StoryMenuBar: NSObject, NSMenuItemValidation, NSMenuDelegate {
    static let shared = StoryMenuBar()

    var updates: StoryUpdates?

    private final class WindowEntry {
        var commands: StoryWindowCommands
        weak var editorCommands: EditorCommands?
        weak var undoController: DocumentUndoController?

        init(commands: StoryWindowCommands) { self.commands = commands }
    }

    private final class Item: NSMenuItem {
        var perform: () -> Void = {}
        var isAvailable: () -> Bool = { true }
        /// Brings a title or checkmark up to date before the item is shown.
        var refresh: ((NSMenuItem) -> Void)?
    }

    /// By window number, not by a weak reference to the window: SwiftUI can
    /// update a window's views while the window is deallocating, and forming
    /// a weak reference to it then aborts the app.
    private var entries: [Int: WindowEntry] = [:]
    private let menu = NSMenu(title: "Main Menu")
    private var items: [NSMenuItem] = []
    private let windowMenu = NSMenu(title: "Window")
    private let helpMenu = NSMenu(title: "Help")
    private let servicesMenu = NSMenu(title: "Services")
    private let localTreesMenu = NSMenu(title: "Jump to Local Tree")

    /// SwiftUI rebuilds its own menus into `NSApp.mainMenu`, whatever menu that
    /// is, at launch and again when the last window closes. The application
    /// delegate calls this on every update to put these back.
    func install() {
        if items.isEmpty { items = build() }
        if NSApp.mainMenu !== menu { NSApp.mainMenu = menu }
        guard menu.items != items else { return }
        menu.items = items
        NSApp.servicesMenu = servicesMenu
        NSApp.windowsMenu = windowMenu
        NSApp.helpMenu = helpMenu
    }

    func register(
        _ commands: StoryWindowCommands,
        editorCommands: EditorCommands?,
        undoController: DocumentUndoController?,
        for window: NSWindow
    ) {
        // A window off screen (not yet shown, or being torn down) has no number.
        guard window.windowNumber > 0 else { return }
        let entry = entries[window.windowNumber] ?? WindowEntry(commands: commands)
        entry.commands = commands
        entry.editorCommands = editorCommands
        entry.undoController = undoController
        entries[window.windowNumber] = entry
        // Drop entries of windows that are gone.
        let open = Set(NSApp.windows.map(\.windowNumber))
        entries = entries.filter { open.contains($0.key) }
    }

    func unregister(_ window: NSWindow) {
        entries.removeValue(forKey: window.windowNumber)
    }

    // MARK: - The key window's commands

    /// A sheet or popover is its own key window; its commands are its parent's.
    private var entry: WindowEntry? {
        var window = NSApp.keyWindow ?? NSApp.mainWindow
        while let current = window {
            if let entry = entries[current.windowNumber] { return entry }
            window = current.sheetParent ?? current.parent
        }
        return NSApp.mainWindow.flatMap { entries[$0.windowNumber] }
    }

    private var commands: StoryWindowCommands? { entry?.commands }
    private var editorCommands: EditorCommands? { entry?.editorCommands }

    // MARK: - Menus

    private func build() -> [NSMenuItem] {
        [
            applicationMenu(), treeMenu(), pageMenu(), editMenu(), formatMenu(), viewMenu(), goMenu(),
            fillWindowMenu(), fillHelpMenu(),
        ].map { submenu in
            let item = NSMenuItem(title: submenu.title, action: nil, keyEquivalent: "")
            item.submenu = submenu
            return item
        }
    }

    private func applicationMenu() -> NSMenu {
        let menu = NSMenu(title: "Story")
        menu.addItem(standard("About Story", #selector(NSApplication.orderFrontStandardAboutPanel(_:))))
        if let updates, updates.isAvailable {
            menu.addItem(item("Check for Updates…") { updates.check() })
        }
        menu.addItem(.separator())
        menu.addItem(window("Sync & Accounts…") { $0.showAccounts() })
        menu.addItem(window("People…") { $0.showPeople() })
        let iconItem = NSMenuItem(title: "App Icon", action: nil, keyEquivalent: "")
        let iconMenu = NSMenu(title: "App Icon")
        for icon in StoryAppIcon.allCases {
            let choice = item(icon.title) {
                Task {
                    await StoryAppIconSelection.shared.select(icon)
                    if let error = StoryAppIconSelection.shared.error {
                        let alert = NSAlert()
                        alert.messageText = "Couldn’t Change App Icon"
                        alert.informativeText = error
                        alert.runModal()
                    }
                }
            }
            choice.refresh = { $0.state = StoryAppIconSelection.shared.selected == icon ? .on : .off }
            iconMenu.addItem(choice)
        }
        iconItem.submenu = iconMenu
        menu.addItem(iconItem)
        if StoryCommandLineTool.launcher != nil {
            menu.addItem(item("Install Command Line Tool…") { Task { await StoryCommandLineTool.installAndReport() } })
        }
        menu.addItem(.separator())
        let services = NSMenuItem(title: "Services", action: nil, keyEquivalent: "")
        services.submenu = servicesMenu
        menu.addItem(services)
        menu.addItem(.separator())
        menu.addItem(standard("Hide Story", #selector(NSApplication.hide(_:)), "h"))
        menu.addItem(standard("Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]))
        menu.addItem(standard("Show All", #selector(NSApplication.unhideAllApplications(_:))))
        menu.addItem(.separator())
        menu.addItem(standard("Quit Story", #selector(NSApplication.terminate(_:)), "q"))
        return menu
    }

    private func treeMenu() -> NSMenu {
        let menu = NSMenu(title: "Tree")
        let localTrees = window("Jump to Local Tree", when: { !$0.localTrees.isEmpty }) { _ in }
        localTreesMenu.delegate = self
        localTrees.submenu = localTreesMenu
        menu.addItem(localTrees)
        menu.addItem(window("Open Location…", "l") { $0.openLocation() })
        menu.addItem(.separator())
        menu.addItem(window("Search Contents…", "f", [.command, .shift]) { $0.showSearch() })
        menu.addItem(.separator())
        menu.addItem(window("Sync Status…") { $0.showSyncStatus() })
        let review = window("Review Choices…", when: { $0.reviewChoiceCount != nil }) { $0.reviewChoices() }
        review.refresh = { [unowned self] item in
            let count = self.commands?.reviewChoiceCount ?? 0
            item.title = count > 0 ? "Review Choices (\(count))…" : "Review Choices…"
        }
        menu.addItem(review)
        return menu
    }

    private func pageMenu() -> NSMenu {
        let menu = NSMenu(title: "Page")
        menu.addItem(window("New Page", "n", when: \.canCreatePage) { $0.newPage() })
        menu.addItem(window("Jump to Page…", "p") { $0.focusSidebarSearch() })
        menu.addItem(.separator())
        menu.addItem(window("Rename Page…", when: \.canRenamePage) { $0.renamePage() })
        menu.addItem(window("Move Page…", "p", [.command, .option], when: \.canMovePage) { $0.movePage() })
        menu.addItem(window("Trash Page…", when: \.canMovePageToTrash) { $0.movePageToTrash() })
        menu.addItem(window("Restore Page", when: \.canRestorePage) { $0.restorePage() })
        menu.addItem(.separator())
        menu.addItem(window("Source and Properties…", "i", when: \.hasNode) { $0.showSource() })
        menu.addItem(window("Reveal Page in Finder", when: \.canRevealPageInFinder) { $0.revealPageInFinder() })
        menu.addItem(window("Recover…", "\\", [.command, .shift], when: \.hasDocument) { $0.showHistory() })
        menu.addItem(.separator())
        let record = window("Record Audio", "r", [.command, .option], when: \.canRecordAudio) { [unowned self] in
            $0.recordAudio(self.editorCommands)
        }
        record.refresh = { [unowned self] in $0.title = self.commands?.recordAudioLabel ?? "Record Audio" }
        menu.addItem(record)
        menu.addItem(window("Share…", "s", [.command, .option], when: \.canShare) { $0.share() })
        return menu
    }

    /// AppKit adds AutoFill, dictation, and Emoji & Symbols to the menu titled Edit.
    private func editMenu() -> NSMenu {
        let menu = NSMenu(title: "Edit")
        menu.addItem(item("Undo", "z", when: { [unowned self] in self.entry?.undoController != nil }) { [unowned self] in
            self.entry?.undoController?.undo()
        })
        menu.addItem(item("Redo", "z", [.command, .shift], when: { [unowned self] in self.entry?.undoController != nil }) {
            [unowned self] in self.entry?.undoController?.redo()
        })
        menu.addItem(.separator())
        menu.addItem(standard("Cut", #selector(NSText.cut(_:)), "x"))
        menu.addItem(standard("Copy", #selector(NSText.copy(_:)), "c"))
        menu.addItem(standard("Paste", #selector(NSText.paste(_:)), "v"))
        menu.addItem(standard("Delete", #selector(NSText.delete(_:))))
        menu.addItem(standard("Select All", #selector(NSText.selectAll(_:)), "a"))
        menu.addItem(editor("Find in Page…", "f", .findInPage))
        menu.addItem(.separator())
        menu.addItem(editor("Block Actions…", "/", .openBlockActionMenu))
        menu.addItem(editor("Create Page from Selected Block…", "k", .toggleLinkOrDocument))
        menu.addItem(editor("Insert Block Below", "\r", .newBlockBelow))
        menu.addItem(editor("Move Selected Blocks…", "p", .openMoveTo, [.command, .shift]))
        menu.addItem(.separator())
        menu.addItem(editor("Indent Selected Blocks", "\t", .indent, [], requires: .canIndent))
        menu.addItem(editor("Outdent Selected Blocks", "\t", .outdent, .shift, requires: .canOutdent))
        menu.addItem(.separator())
        menu.addItem(editor("Move Selected Blocks Up", Self.upArrow, .moveBlockUp, .option, requires: .canMoveBlockUp))
        menu.addItem(editor("Move Selected Blocks Down", Self.downArrow, .moveBlockDown, .option, requires: .canMoveBlockDown))
        return menu
    }

    private func formatMenu() -> NSMenu {
        let menu = NSMenu(title: "Format")
        menu.addItem(editor("Bold", "b", .toggleInlineMark(.bold)))
        menu.addItem(editor("Italic", "i", .toggleInlineMark(.italic)))
        menu.addItem(editor("Inline Code", "e", .toggleInlineMark(.code)))
        menu.addItem(editor("Strikethrough", "s", .toggleInlineMark(.strikethrough), [.command, .shift]))
        return menu
    }

    /// AppKit adds the tab bar and full screen items to the menu titled View.
    private func viewMenu() -> NSMenu {
        let menu = NSMenu(title: "View")
        menu.addItem(window("Toggle Sidebar", "\\") { $0.toggleSidebar() })
        let orders: [(String, String, StorySidebarPageOrder)] = [
            ("Alphabetical Pages", "1", .alphabetical),
            ("Recent Pages", "2", .recent),
            ("Pages by Link Count", "3", .linkCount),
            ("Pages by Folder", "4", .folders),
        ]
        for (title, key, order) in orders {
            let item = window(title, key, [.command, .option]) { $0.setSidebarPageOrder(order) }
            item.refresh = { [unowned self] in $0.state = self.commands?.sidebarPageOrder == order ? .on : .off }
            menu.addItem(item)
        }
        menu.addItem(.separator())
        menu.addItem(editor(
            "Fold All Headings", Self.leftArrow, .foldAllHeadings, [.command, .option], requires: .canFoldAllHeadings
        ))
        menu.addItem(editor(
            "Unfold All Headings", Self.rightArrow, .unfoldAllHeadings, [.command, .option], requires: .canUnfoldAllHeadings
        ))
        return menu
    }

    private func goMenu() -> NSMenu {
        let menu = NSMenu(title: "Go")
        menu.addItem(window("Back", "[", when: \.canGoBack) { $0.goBack() })
        menu.addItem(window("Forward", "]", when: \.canGoForward) { $0.goForward() })
        menu.addItem(window("Go to Parent", Self.upArrow, when: \.canGoParent) { $0.goParent() })
        menu.addItem(window("Home", "h", [.command, .shift], when: \.canGoHome) { $0.goHome() })
        return menu
    }

    /// AppKit lists the open windows, and adds its tiling and tab items, in `NSApp.windowsMenu`.
    private func fillWindowMenu() -> NSMenu {
        windowMenu.addItem(window("New Tab", "t") { $0.newTab() })
        windowMenu.addItem(item("New Window", "n", [.command, .option]) { [unowned self] in
            if let commands = self.commands { commands.newWindow() }
        })
        windowMenu.addItem(.separator())
        // Each tab is a window: Command-W closes it, and Shift-Command-W closes
        // every tab of the window, as in Safari.
        let closeTab = item("Close Tab", "w", when: { NSApp.keyWindow != nil }) { NSApp.keyWindow?.performClose(nil) }
        closeTab.refresh = { $0.title = (NSApp.keyWindow?.tabbedWindows?.count ?? 0) > 1 ? "Close Tab" : "Close Window" }
        windowMenu.addItem(closeTab)
        windowMenu.addItem(item("Close Window", "w", [.command, .shift], when: { NSApp.keyWindow != nil }) {
            guard let window = NSApp.keyWindow else { return }
            for tab in window.tabbedWindows ?? [window] { tab.performClose(nil) }
        })
        windowMenu.addItem(.separator())
        windowMenu.addItem(standard("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m"))
        windowMenu.addItem(standard("Zoom", #selector(NSWindow.performZoom(_:))))
        windowMenu.addItem(.separator())
        windowMenu.addItem(standard("Bring All to Front", #selector(NSApplication.arrangeInFront(_:))))
        return windowMenu
    }

    private func fillHelpMenu() -> NSMenu {
        helpMenu.addItem(window("Keyboard Shortcuts", "?") { $0.showKeyboardShortcuts() })
        return helpMenu
    }

    // MARK: - Items

    private static let upArrow = String(UnicodeScalar(NSUpArrowFunctionKey)!)
    private static let downArrow = String(UnicodeScalar(NSDownArrowFunctionKey)!)
    private static let leftArrow = String(UnicodeScalar(NSLeftArrowFunctionKey)!)
    private static let rightArrow = String(UnicodeScalar(NSRightArrowFunctionKey)!)

    /// An item AppKit routes down the responder chain and enables itself.
    private func standard(
        _ title: String, _ action: Selector, _ key: String = "", _ modifiers: NSEvent.ModifierFlags = .command
    ) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
        item.keyEquivalentModifierMask = key.isEmpty ? [] : modifiers
        return item
    }

    private func item(
        _ title: String,
        _ key: String = "",
        _ modifiers: NSEvent.ModifierFlags = .command,
        when isAvailable: @escaping () -> Bool = { true },
        perform: @escaping () -> Void
    ) -> Item {
        let item = Item(title: title, action: #selector(performItem(_:)), keyEquivalent: key)
        item.keyEquivalentModifierMask = key.isEmpty ? [] : modifiers
        item.target = self
        item.isAvailable = isAvailable
        item.perform = perform
        return item
    }

    /// An item that acts on the key window's commands, and is disabled without them.
    private func window(
        _ title: String,
        _ key: String = "",
        _ modifiers: NSEvent.ModifierFlags = .command,
        when isAvailable: @escaping (StoryWindowCommands) -> Bool = { _ in true },
        perform: @escaping (StoryWindowCommands) -> Void
    ) -> Item {
        item(title, key, modifiers, when: { [unowned self] in self.commands.map(isAvailable) ?? false }) { [unowned self] in
            if let commands = self.commands { perform(commands) }
        }
    }

    /// An item that performs an action in the focused editor.
    private func editor(
        _ title: String,
        _ key: String,
        _ action: EditorAction,
        _ modifiers: NSEvent.ModifierFlags = .command,
        requires: EditorPredicate? = nil
    ) -> Item {
        item(title, key, modifiers, when: { [unowned self] in
            guard let editorCommands = self.editorCommands else { return false }
            return requires.map(editorCommands.can) ?? true
        }) { [unowned self] in
            self.editorCommands?.perform(action)
        }
    }

    @objc private func performItem(_ sender: NSMenuItem) {
        (sender as? Item)?.perform()
    }

    func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
        guard let item = menuItem as? Item else { return true }
        item.refresh?(item)
        return item.isAvailable()
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        guard menu === localTreesMenu else { return }
        menu.removeAllItems()
        for tree in commands?.localTrees ?? [] {
            let item = window(tree.title) { $0.jumpToLocalTree(tree.id) }
            item.state = tree.isCurrent ? .on : .off
            menu.addItem(item)
        }
    }
}

/// Hands a window's commands, and the editor focused in it, to the menu bar.
struct StoryMenuBarBridge: View {
    let commands: StoryWindowCommands
    @FocusedValue(\.editorCommands) private var editorCommands
    @FocusedValue(\.documentUndoController) private var undoController

    var body: some View {
        Registration(commands: commands, editorCommands: editorCommands, undoController: undoController)
    }

    private struct Registration: NSViewRepresentable {
        let commands: StoryWindowCommands
        let editorCommands: EditorCommands?
        let undoController: DocumentUndoController?

        func makeNSView(context: Context) -> WindowView { WindowView() }

        func updateNSView(_ view: WindowView, context: Context) {
            view.register = { window in
                StoryMenuBar.shared.register(
                    commands, editorCommands: editorCommands, undoController: undoController, for: window
                )
            }
            view.registerWindow()
        }

        static func dismantleNSView(_ view: WindowView, coordinator: ()) {
            if let window = view.window, !view.windowIsClosing { StoryMenuBar.shared.unregister(window) }
        }
    }

    final class WindowView: NSView {
        var register: ((NSWindow) -> Void)?
        /// Set when the window starts to close. SwiftUI updates the window's
        /// views once more while it is deallocating, and the registry holds
        /// windows weakly: registering one then aborts the app.
        private(set) var windowIsClosing = false
        private var closeObserver: NSObjectProtocol?
        /// A window is registered by its number, which it has once on screen.
        private var keyObserver: NSObjectProtocol?

        override func hitTest(_ point: NSPoint) -> NSView? { nil }

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            for observer in [closeObserver, keyObserver].compactMap({ $0 }) { NotificationCenter.default.removeObserver(observer) }
            closeObserver = nil
            keyObserver = nil
            guard let window else { return }
            keyObserver = NotificationCenter.default.addObserver(
                forName: NSWindow.didBecomeKeyNotification, object: window, queue: .main
            ) { [weak self] _ in
                MainActor.assumeIsolated { self?.registerWindow() }
            }
            closeObserver = NotificationCenter.default.addObserver(
                forName: NSWindow.willCloseNotification, object: window, queue: .main
            ) { [weak self] _ in
                MainActor.assumeIsolated {
                    guard let self else { return }
                    self.windowIsClosing = true
                    if let window = self.window { StoryMenuBar.shared.unregister(window) }
                }
            }
            registerWindow()
        }

        func registerWindow() {
            guard !windowIsClosing, let window else { return }
            register?(window)
        }

        isolated deinit {
            for observer in [closeObserver, keyObserver].compactMap({ $0 }) { NotificationCenter.default.removeObserver(observer) }
        }
    }
}
#endif
