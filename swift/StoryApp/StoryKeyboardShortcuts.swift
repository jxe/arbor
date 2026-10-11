#if os(macOS)
import SwiftUI

/// The Help ▸ Keyboard Shortcuts sheet. The menus already show their own
/// shortcuts, so it covers what they cannot: the two page modes and the keys that
/// act on blocks without a menu item.
struct StoryKeyboardShortcutsView: View {
    @Environment(\.dismiss) private var dismiss

    private struct Shortcut: Identifiable {
        let keys: String
        let effect: String
        var id: String { keys }
    }

    private static let modes: [Shortcut] = [
        .init(keys: "Return", effect: "Edit the selected block, or open the page it links to"),
        .init(keys: "Esc", effect: "Leave the text and select the block"),
        .init(keys: "↑ ↓", effect: "Past the first or last line of a block being edited, move to the next block"),
    ]

    private static let navigation: [Shortcut] = [
        .init(keys: "↑ ↓", effect: "Select the previous or next block"),
        .init(keys: "⇧↑ ⇧↓", effect: "Extend the selection"),
        .init(keys: "→", effect: "Check a to-do, unfold a section, or open a linked page"),
        .init(keys: "←", effect: "Uncheck a to-do, fold a section, or jump to the enclosing heading"),
        .init(keys: "⌥↑ ⌥↓", effect: "Move the selected blocks up or down"),
        .init(keys: "Tab ⇧Tab", effect: "Indent or outdent the selected blocks"),
        .init(keys: "Delete", effect: "Delete the selected blocks"),
        .init(keys: "⌘↩", effect: "Insert a block below"),
        .init(keys: "⌘/", effect: "Block actions, including Turn Into"),
        .init(keys: "⌘K", effect: "Make a page from the selected block"),
        .init(keys: "⇧⌘P", effect: "Move the selected blocks to another page"),
        .init(keys: "⌘X ⌘C ⌘V", effect: "Cut, copy, and paste whole blocks"),
        .init(keys: "⌘B ⌘I ⌘E ⇧⌘S", effect: "Bold, italic, code, or strikethrough across the selected blocks"),
    ]

    private static let pages: [Shortcut] = [
        .init(keys: "⌘P", effect: "Jump to a page by name"),
        .init(keys: "⇧⌘F", effect: "Search the tree's contents"),
        .init(keys: "⌘F", effect: "Find in the page"),
        .init(keys: "⌘[ ⌘]", effect: "Back and forward"),
        .init(keys: "⌘↑", effect: "Go to the parent page"),
        .init(keys: "⇧⌘H", effect: "Home"),
        .init(keys: "⌘N", effect: "New page under this one"),
        .init(keys: "⌘L", effect: "Open a location"),
        .init(keys: "⌘\\", effect: "Show or hide the sidebar"),
    ]

    private static let typing: [Shortcut] = [
        .init(keys: "# ## ###", effect: "Heading"),
        .init(keys: "- or *", effect: "Bullet"),
        .init(keys: "1.", effect: "Numbered item"),
        .init(keys: "[]", effect: "To-do"),
        .init(keys: ">", effect: "Quote"),
        .init(keys: "\"", effect: "Toggle"),
        .init(keys: "--- ↩", effect: "Divider"),
        .init(keys: "``` ↩", effect: "Code block"),
        .init(keys: "@", effect: "Link to a page"),
    ]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Navigation mode and edit mode")
                        .font(.headline)
                    Text("""
                    A page is always in one of two modes. In edit mode one block has a caret and \
                    the keyboard types into it. In navigation mode there is no caret: whole blocks \
                    are selected, and the keyboard moves, restructures, and formats them.
                    """)
                    Text("""
                    Clicking in text starts editing there. Esc returns to navigation mode with \
                    that block selected. Menu commands work in both modes; in edit mode they act \
                    on the block being edited.
                    """)
                    grid(Self.modes)
                }
                .fixedSize(horizontal: false, vertical: true)
                section("In navigation mode", Self.navigation)
                section("Getting around", Self.pages)
                section("At the start of a block, then Space", Self.typing)
            }
            .padding(24)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VStack(spacing: 0) {
                Divider()
                HStack {
                    Spacer()
                    // The cancel action is what lets Esc close the sheet.
                    Button("Done") { dismiss() }
                        .keyboardShortcut(.cancelAction)
                }
                .padding(12)
            }
            .background(.bar)
        }
        .frame(width: 520, height: 640)
    }

    private func section(_ title: String, _ shortcuts: [Shortcut]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(.headline)
            grid(shortcuts)
        }
    }

    private func grid(_ shortcuts: [Shortcut]) -> some View {
        Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 16, verticalSpacing: 6) {
            ForEach(shortcuts) { shortcut in
                GridRow {
                    Text(shortcut.keys)
                        .font(.body.monospaced())
                        .foregroundStyle(.secondary)
                        .gridColumnAlignment(.trailing)
                    Text(shortcut.effect)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }
}
#endif
