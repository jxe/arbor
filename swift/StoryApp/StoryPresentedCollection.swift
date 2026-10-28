import StoryKit
import SwiftUI

/// How a presented view reads, after the games site cranberries draws
/// (supplies-remake): plain tabs and an underlined search field; bold group
/// headings, a person's with their avatar; each line a hanging bullet, the
/// title in the bullet's color, " — " and the rest, with the line's Markdown
/// as a note below that shows its first paragraph until opened.
struct StoryPresentedCollection<Avatar: View>: View {
    let view: PresentedView
    @Binding var tab: Int
    @Binding var query: String
    @Binding var collapsed: Set<String>
    @ViewBuilder let avatar: (PresentedChip, CGFloat) -> Avatar
    /// The one line whose note is open, as cranberries opens one entry at a time.
    @State private var open: String?

    var body: some View {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        // Read-only, a group with no lines has nothing to show or to add to.
        let groups = view.groups.filter { !$0.lines.isEmpty }
        VStack(alignment: .leading, spacing: 0) {
            header
                .padding(.bottom, 24)
            if groups.isEmpty {
                Text(trimmed.isEmpty ? "No \(noun)s yet." : "No \(noun)s match.")
                    .foregroundStyle(.tertiary)
            }
            ForEach(groups, id: \.id) { group in
                groupView(group)
                    .padding(.bottom, 24)
            }
        }
        .font(.system(size: 15))
        .frame(maxWidth: 680, alignment: .leading)
    }

    /// The main model's name as a lower-case noun ("game").
    private var noun: String { view.model.prefix(1).lowercased() + view.model.dropFirst() }

    private var header: some View {
        VStack(alignment: .leading, spacing: 10) {
            if view.tabs.count > 1 {
                HStack(spacing: 18) {
                    ForEach(Array(view.tabs.enumerated()), id: \.offset) { index, label in
                        Button(label) { tab = index }
                            .buttonStyle(.plain)
                            .fontWeight(index == view.tab ? .bold : .regular)
                            .foregroundStyle(index == view.tab ? .primary : .secondary)
                            .accessibilityAddTraits(index == view.tab ? .isSelected : [])
                    }
                }
            }
            VStack(alignment: .leading, spacing: 4) {
                TextField("Search \(noun)s", text: $query)
                    .textFieldStyle(.plain)
                Divider()
            }
        }
    }

    @ViewBuilder
    private func groupView(_ group: PresentedGroup) -> some View {
        let key = "\(view.tab)\u{0}\(group.id)"
        let isCollapsed = collapsed.contains(key)
        VStack(alignment: .leading, spacing: 0) {
            if group.kind != .flat {
                Button {
                    if isCollapsed { collapsed.remove(key) } else { collapsed.insert(key) }
                } label: {
                    StoryCollectionHeading(group: group, collapsed: isCollapsed, person: personGroup(group)) { chip in
                        avatar(chip, 24)
                    }
                }
                .buttonStyle(.plain)
                .padding(.bottom, 2)
            }
            if !isCollapsed {
                VStack(alignment: .leading, spacing: 14) {
                    ForEach(group.lines, id: \.occurrence) { line in
                        StoryCollectionLine(line: line, group: view.group, open: $open, avatar: avatar)
                    }
                }
            }
        }
    }

    /// A group of people: its member as a chip, for the heading's avatar.
    private func personGroup(_ group: PresentedGroup) -> PresentedChip? {
        guard group.person, let member = group.member else { return nil }
        return PresentedChip(member: member, name: group.heading, person: true, placeholder: group.placeholder)
    }
}

/// A group's heading: bold, after the person's avatar for a group of people.
private struct StoryCollectionHeading<Avatar: View>: View {
    let group: PresentedGroup
    let collapsed: Bool
    let person: PresentedChip?
    @ViewBuilder let avatar: (PresentedChip) -> Avatar
    @State private var hovering = false

    var body: some View {
        HStack(spacing: 7) {
            if let person { avatar(person) }
            if let color = group.color.flatMap(Color.init(collectionHex:)) {
                Circle().fill(color).frame(width: 7, height: 7)
            }
            Text(group.heading.isEmpty ? "Untitled" : group.heading)
                .fontWeight(.bold)
                .foregroundStyle(group.placeholder ? .secondary : .primary)
            Image(systemName: collapsed ? "chevron.right" : "chevron.down")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.tertiary)
                .opacity(collapsed || hovering ? 1 : 0)
        }
        .frame(minHeight: 26)
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
        .help(group.placeholder ? "Not in Story yet: a placeholder for someone without a profile" : "")
    }
}

/// One occurrence of a row, as cranberries draws a line.
private struct StoryCollectionLine<Avatar: View>: View {
    let line: PresentedLine
    /// The view's group field, which its headings already show.
    let group: String?
    @Binding var open: String?
    @ViewBuilder let avatar: (PresentedChip, CGFloat) -> Avatar

    var body: some View {
        let tint = line.color.flatMap(Color.init(collectionHex:))
        HStack(alignment: .firstTextBaseline, spacing: 0) {
            // The bullet hangs before the line, so titles align.
            Group {
                if let bullet {
                    Circle().fill(bullet.color.flatMap(Color.init(collectionHex:)) ?? .secondary)
                        .frame(width: 7, height: 7)
                        .help(bullet.value ?? "None")
                } else {
                    Color.clear.frame(width: 7, height: 7)
                }
            }
            .frame(width: 16, alignment: .leading)
            VStack(alignment: .leading, spacing: 3) {
                StoryCollectionFlow(spacing: 0, lineSpacing: 2) {
                    ForEach(Array(inline.enumerated()), id: \.offset) { index, cell in
                        if index == 1 && !isSummary(cell) {
                            Text(" — ").foregroundStyle(.secondary)
                        }
                        cellView(cell, tint: tint)
                            .padding(.trailing, 4)
                    }
                }
                ForEach(Array(notes.enumerated()), id: \.offset) { _, note in
                    StoryCollectionNote(markdown: note, open: open == line.occurrence) {
                        open = open == line.occurrence ? nil : line.occurrence
                    }
                }
            }
        }
        .contextMenu {
            Button("Copy Row Key") { storyCopyToPasteboard(line.row) }
        }
    }

    /// The choice drawn as the bullet.
    private var bullet: (value: String?, color: String?)? {
        for cell in line.cells {
            if case let .choice(_, value, color, true) = cell { return (value, color) }
        }
        return nil
    }

    /// The cells on the line itself: not the bullet, the group's field or Markdown.
    private var inline: [PresentedCell] {
        line.cells.filter { cell in
            switch cell {
            case .choice(_, _, _, true), .markdown: false
            default: cell.field != group
            }
        }
    }

    /// The Markdown cells, as notes below the line.
    private var notes: [String] {
        line.cells.compactMap { if case let .markdown(_, value?, _) = $0, !value.isEmpty { value } else { nil } }
    }

    private func isSummary(_ cell: PresentedCell) -> Bool {
        if case .chips(_, _, true, _) = cell { true } else { false }
    }

    @ViewBuilder
    private func cellView(_ cell: PresentedCell, tint: Color?) -> some View {
        switch cell {
        case let .text(_, _, value, ago):
            let text = ago ? Self.ago(value) : Self.display(value)
            if !text.isEmpty {
                Text(text)
                    .foregroundStyle(tint ?? .primary)
                    .textSelection(.enabled)
            }
        case .markdown:
            EmptyView()
        case let .chips(field, chips, summary, label):
            let noun = label ?? Self.singular(field)
            if summary {
                Text("\(chips.count) \(noun)\(chips.count == 1 ? "" : "s")")
                    .foregroundStyle(.secondary)
            } else if chips.isEmpty {
                Text("No \(noun)").foregroundStyle(.secondary)
            } else {
                ForEach(Array(chips.enumerated()), id: \.offset) { index, chip in
                    StoryCollectionMember(chip: chip, avatar: avatar)
                        .padding(.trailing, index == chips.count - 1 ? 0 : 8)
                }
            }
        case let .choice(_, value, color, _):
            if let value {
                Text(value).foregroundStyle(color.flatMap(Color.init(collectionHex:)) ?? .secondary)
            }
        }
    }

    /// A date as "3 hours ago"; other values as they are.
    private static func ago(_ value: JSONValue) -> String {
        guard let text = value.stringValue,
              let date = (try? Date(text, strategy: .iso8601)) ?? (try? Date(text, strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: true)))
        else { return display(value) }
        return RelativeDateTimeFormatter().localizedString(for: date, relativeTo: .now)
    }

    /// "authors" → "author", for "No author" and counts.
    private static func singular(_ field: String) -> String {
        field.count > 1 && field.hasSuffix("s") ? String(field.dropLast()) : field
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

/// A member of a connection on a line: a person with their avatar, else its name.
private struct StoryCollectionMember<Avatar: View>: View {
    let chip: PresentedChip
    @ViewBuilder let avatar: (PresentedChip, CGFloat) -> Avatar

    var body: some View {
        if chip.person {
            HStack(spacing: 5) {
                avatar(chip, 22)
                Text(chip.name)
                    .fontWeight(.light)
                    .foregroundStyle(.secondary)
            }
            .help(chip.placeholder ? "Not in Story yet: a placeholder for someone without a profile" : "")
        } else {
            Text(chip.name)
                .foregroundStyle(chip.color.flatMap(Color.init(collectionHex:)) ?? .secondary)
        }
    }
}

/// A person with no avatar: initials in a ring; a placeholder's ring is dashed.
struct StoryCollectionInitials: View {
    let chip: PresentedChip
    let size: CGFloat

    var body: some View {
        let initials = chip.name.split(whereSeparator: { !$0.isLetter && !$0.isNumber }).prefix(2).compactMap(\.first).map(String.init).joined().uppercased()
        Text(initials.isEmpty ? "?" : initials)
            .font(.system(size: size * 0.4, weight: .semibold))
            .foregroundStyle(.secondary)
            .frame(width: size, height: size)
            .overlay {
                Circle().strokeBorder(.tertiary, style: StrokeStyle(lineWidth: 1.5, dash: chip.placeholder ? [2.5, 2] : []))
            }
    }
}

/// A line's Markdown: its first paragraph, up to five lines, until opened.
private struct StoryCollectionNote: View {
    let markdown: String
    let open: Bool
    let toggle: () -> Void
    @State private var shownHeight: CGFloat = 0
    @State private var fullHeight: CGFloat = 0

    var body: some View {
        let paragraphs = markdown.components(separatedBy: "\n\n").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
        let long = paragraphs.count > 1 || fullHeight > shownHeight + 1
        VStack(alignment: .leading, spacing: 2) {
            if open {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(Array(paragraphs.enumerated()), id: \.offset) { _, paragraph in Self.text(paragraph) }
                }
            } else {
                Self.text(paragraphs.first ?? "")
                    .lineLimit(5)
                    .fixedSize(horizontal: false, vertical: true)
                    .background {
                        // Whether five lines cut the paragraph short.
                        Self.text(paragraphs.first ?? "").fixedSize(horizontal: false, vertical: true).hidden()
                            .onGeometryChange(for: CGFloat.self, of: \.size.height) { fullHeight = $0 }
                    }
                    .onGeometryChange(for: CGFloat.self, of: \.size.height) { shownHeight = $0 }
            }
            if long || open {
                Button(open ? "Show less" : "Show more", action: toggle)
                    .buttonStyle(.plain)
                    .font(.system(size: 13))
                    .foregroundStyle(.tertiary)
            }
        }
        .font(.system(size: 13.5))
        .foregroundStyle(.secondary)
        .lineSpacing(3)
    }

    private static func text(_ paragraph: String) -> Text {
        Text((try? AttributedString(markdown: paragraph, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
             ?? AttributedString(paragraph))
    }
}

/// Lays its children out in rows, wrapping to the width it is offered.
private struct StoryCollectionFlow: Layout {
    var spacing: CGFloat
    var lineSpacing: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = arrange(width: proposal.width ?? .infinity, subviews)
        return CGSize(width: rows.map(\.width).max() ?? 0, height: rows.last.map { $0.y + $0.height } ?? 0)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        for row in arrange(width: bounds.width, subviews) {
            for item in row.items {
                subviews[item.index].place(
                    at: CGPoint(x: bounds.minX + item.x, y: bounds.minY + row.y + row.baseline - item.baseline),
                    proposal: ProposedViewSize(item.size)
                )
            }
        }
    }

    private struct Row {
        var y: CGFloat
        var width: CGFloat = 0
        var height: CGFloat = 0
        var baseline: CGFloat = 0
        var items: [(index: Int, x: CGFloat, size: CGSize, baseline: CGFloat)] = []
    }

    /// Rows of subviews aligned on their first baselines; a subview wider than the row is offered the row's width.
    private func arrange(width: CGFloat, _ subviews: Subviews) -> [Row] {
        var rows: [Row] = [Row(y: 0)]
        for (index, subview) in subviews.enumerated() {
            var size = subview.sizeThatFits(.unspecified)
            if size.width > width { size = subview.sizeThatFits(ProposedViewSize(width: width, height: nil)) }
            let baseline = subview.dimensions(in: ProposedViewSize(size))[VerticalAlignment.firstTextBaseline]
            if !rows[rows.count - 1].items.isEmpty, rows[rows.count - 1].width + spacing + size.width > width {
                let last = rows[rows.count - 1]
                rows.append(Row(y: last.y + last.height + lineSpacing))
            }
            var row = rows[rows.count - 1]
            let x = row.items.isEmpty ? 0 : row.width + spacing
            row.items.append((index, x, size, baseline))
            row.width = x + size.width
            let above = max(row.baseline, baseline)
            let below = max(row.height - row.baseline, size.height - baseline)
            row.baseline = above
            row.height = above + below
            rows[rows.count - 1] = row
        }
        return rows
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
