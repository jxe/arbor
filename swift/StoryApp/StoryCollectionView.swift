import StoryKit
import SwiftUI

/// A logical collection folder, read-only (Schema language 006): its main
/// model's rows arranged by the schema's views, with tabs, groups that
/// collapse and a search field. Editing comes with Schema language 002.
struct StoryCollectionView: View {
    let node: WorkspaceNode
    let workspace: StoryWorkspaceState
    /// Shown when the folder holds no logical collection (a `_store.*` from before 005).
    let kind: String
    let rowCount: Int?

    private enum Load {
        case loading
        case loaded(WorkspaceCollectionRows)
        case notCollection
        case failed(String)
    }

    @State private var load = Load.loading
    @State private var tab = 0
    @State private var query = ""
    /// Collapsed groups by tab and group id; the client's own, never stored in the tree.
    @State private var collapsed: Set<String> = []

    private struct LoadKey: Hashable {
        var node: WorkspaceNode
        var generation: Int
        var providerRevision: Int
    }

    var body: some View {
        content
            .task(id: LoadKey(node: node, generation: workspace.generation, providerRevision: workspace.providerRevision)) {
                await reload()
            }
    }

    @ViewBuilder
    private var content: some View {
        switch load {
        case .loading:
            ProgressView().frame(maxWidth: .infinity)
        case .notCollection:
            LabeledContent("Collection", value: kind)
            if let rowCount { LabeledContent("Rows", value: rowCount.formatted()) }
        case let .failed(message):
            ContentUnavailableView("Can't show this collection", systemImage: "tablecells.badge.ellipsis", description: Text(message))
        case let .loaded(collection):
            presented(collection)
        }
    }

    private func reload() async {
        do {
            load = .loaded(try await workspace.provider.collectionRows(node.reference))
        } catch WorkspaceCollectionError.notCollection {
            load = .notCollection
        } catch {
            load = .failed(error.localizedDescription)
        }
    }

    @ViewBuilder
    private func presented(_ collection: WorkspaceCollectionRows) -> some View {
        let people = workspace.directory.map { PresentedPerson(id: $0.id, name: $0.title) }
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        switch Result(catching: {
            try presentView(collection.schema, rows: collection.rows, options: PresentOptions(
                view: tab, people: people, query: trimmed.isEmpty ? nil : trimmed
            ))
        }) {
        case let .failure(error):
            ContentUnavailableView("Can't show this collection", systemImage: "tablecells.badge.ellipsis",
                                   description: Text((error as? ViewError)?.message ?? error.localizedDescription))
        case let .success(view):
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    if view.tabs.count > 1 {
                        Picker("View", selection: $tab) {
                            ForEach(Array(view.tabs.enumerated()), id: \.offset) { Text($0.element).tag($0.offset) }
                        }
                        .pickerStyle(.segmented)
                        .labelsHidden()
                        .fixedSize()
                    }
                    Spacer()
                    TextField("Search", text: $query)
                        .textFieldStyle(.roundedBorder)
                        .frame(maxWidth: 220)
                }
                let groups = view.groups.filter { !$0.lines.isEmpty || trimmed.isEmpty }
                if groups.allSatisfy(\.lines.isEmpty) {
                    Text(trimmed.isEmpty ? "No rows yet." : "No rows match.")
                        .foregroundStyle(.secondary)
                }
                ForEach(groups, id: \.id) { group in
                    groupView(group, flat: view.groups.count == 1 && group.kind == .flat, tab: view.tab)
                }
            }
        }
    }

    @ViewBuilder
    private func groupView(_ group: PresentedGroup, flat: Bool, tab: Int) -> some View {
        let key = "\(tab)\u{0}\(group.id)"
        let isCollapsed = collapsed.contains(key)
        VStack(alignment: .leading, spacing: 4) {
            if !flat {
                Button {
                    if isCollapsed { collapsed.remove(key) } else { collapsed.insert(key) }
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: isCollapsed ? "chevron.right" : "chevron.down")
                            .font(.caption.weight(.semibold))
                            .frame(width: 12)
                        if let color = group.color.flatMap(Color.init(collectionHex:)) {
                            Circle().fill(color).frame(width: 8, height: 8)
                        }
                        Text(group.heading.isEmpty ? "Untitled" : group.heading)
                            .font(.headline)
                            .foregroundStyle(group.kind == .unassigned ? .secondary : .primary)
                        Text(group.lines.count.formatted())
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
            if !isCollapsed {
                ForEach(group.lines, id: \.occurrence) { line in
                    CollectionLineView(line: line)
                        .padding(.leading, flat ? 0 : 18)
                }
            }
        }
        .padding(.top, flat ? 0 : 6)
    }
}

/// One occurrence of a row: its cells in the view's line order.
private struct CollectionLineView: View {
    let line: PresentedLine

    var body: some View {
        let tint = line.color.flatMap(Color.init(collectionHex:))
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            ForEach(Array(line.cells.enumerated()), id: \.offset) { index, cell in
                cellView(cell, primary: index == firstText)
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 4)
        .padding(.horizontal, 6)
        .background(tint.map { $0.opacity(0.08) } ?? .clear, in: RoundedRectangle(cornerRadius: 6))
        .contextMenu {
            Button("Copy Row Key") { storyCopyToPasteboard(line.row) }
        }
    }

    /// The first plain-text cell reads as the line's title.
    private var firstText: Int? {
        line.cells.firstIndex { if case .text = $0 { true } else { false } }
    }

    @ViewBuilder
    private func cellView(_ cell: PresentedCell, primary: Bool) -> some View {
        switch cell {
        case let .text(_, _, value):
            let text = Self.display(value)
            if !text.isEmpty {
                Text(text)
                    .fontWeight(primary ? .medium : .regular)
                    .foregroundStyle(primary ? .primary : .secondary)
                    .textSelection(.enabled)
            }
        case let .markdown(_, _, paragraph):
            if !paragraph.isEmpty {
                Text((try? AttributedString(markdown: paragraph, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
                     ?? AttributedString(paragraph))
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
        case let .chips(_, chips, summary, label):
            if summary, !chips.isEmpty {
                Text(label.map { "\(chips.count) \($0)" } ?? chips.count.formatted())
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(Array(chips.enumerated()), id: \.offset) { _, chip in
                    CollectionChip(name: chip.name, color: chip.color)
                }
            }
        case let .choice(_, value, color, bullet):
            if bullet {
                Circle()
                    .fill(color.flatMap(Color.init(collectionHex:)) ?? .secondary)
                    .frame(width: 9, height: 9)
                    .help(value ?? "None")
            } else if let value {
                CollectionChip(name: value, color: color)
            }
        }
    }

    private static func display(_ value: JSONValue) -> String {
        switch value {
        case .null: ""
        case .string(let s): s
        case .number(let n): n.rounded() == n && abs(n) < 1e15 ? String(Int64(n)) : String(n)
        case .bool(let b): b ? "✓" : "✗"
        case .array(let items): items.map(display).filter { !$0.isEmpty }.joined(separator: ", ")
        case .object: ""
        }
    }
}

private struct CollectionChip: View {
    let name: String
    let color: String?

    var body: some View {
        let tint = color.flatMap(Color.init(collectionHex:)) ?? .secondary
        Text(name)
            .font(.caption)
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .background(tint.opacity(0.15), in: Capsule())
            .lineLimit(1)
    }
}

private extension Color {
    /// `~color("#27815a")`: six hex digits after `#`.
    init?(collectionHex hex: String) {
        guard hex.hasPrefix("#"), hex.count == 7, let value = UInt32(hex.dropFirst(), radix: 16) else { return nil }
        self.init(
            red: Double((value >> 16) & 0xff) / 255,
            green: Double((value >> 8) & 0xff) / 255,
            blue: Double(value & 0xff) / 255
        )
    }
}
