import Overstory
import StoryKit
import SwiftUI

/// Presence in the window (Agents 001 phase 4): who else is in this tree, as
/// initials in the toolbar and beside the block holding their caret. An agent
/// shows its person's initials with a sparkle, and its status in a bubble.
struct StoryPresenceBadge: View {
    let peer: ProtocolPresencePeer

    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            Text(Self.initials(for: peer))
                .font(.system(size: 9, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: 18, height: 18)
                .background(Circle().fill(Self.color(for: peer)))
            if peer.agent != nil {
                Image(systemName: "sparkle")
                    .font(.system(size: 7, weight: .bold))
                    .foregroundStyle(Self.color(for: peer))
                    .padding(1.5)
                    .background(Circle().fill(.background))
                    .offset(x: 4, y: 4)
            }
        }
        .help(Self.label(for: peer))
    }

    /// "Ana" or "Claude (Ana)".
    static func label(for peer: ProtocolPresencePeer) -> String {
        let person = peer.name ?? "Someone"
        guard let agent = peer.agent else { return person }
        return "\(agent.label) (\(person))"
    }

    static func initials(for peer: ProtocolPresencePeer) -> String {
        let words = (peer.name ?? "?").split(whereSeparator: \.isWhitespace)
        let letters = words.prefix(2).compactMap(\.first).map { String($0).uppercased() }
        return letters.isEmpty ? "?" : letters.joined()
    }

    /// One steady hue per person, so an agent shares its person's color.
    static func color(for peer: ProtocolPresencePeer) -> Color {
        let hash = peer.profile.unicodeScalars.reduce(UInt32(2166136261)) { ($0 ^ $1.value) &* 16777619 }
        return Color(hue: Double(hash % 360) / 360, saturation: 0.55, brightness: 0.8)
    }
}

/// An agent's status line, shown open under the block it is working on.
struct StoryPresenceStatus: View {
    let peer: ProtocolPresencePeer
    let status: String

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "sparkle").foregroundStyle(StoryPresenceBadge.color(for: peer))
            Text(peer.agent?.label ?? "Agent").fontWeight(.semibold)
            Text(status).foregroundStyle(.secondary).lineLimit(2)
        }
        .font(.callout)
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(RoundedRectangle(cornerRadius: 10).fill(StoryPresenceBadge.color(for: peer).opacity(0.12)))
        .accessibilityElement(children: .combine)
    }
}

/// The toolbar's presence: initials of everyone on this page, a count of
/// those elsewhere in the tree, and the "Show me to others" switch.
struct StoryPresenceHeader: View {
    let workspace: StoryWorkspaceState
    let reference: WorkspaceReference

    var body: some View {
        let here = workspace.presencePeers(on: reference)
        let everyone = workspace.presenceRoster.peers.values.sorted { ($0.name ?? "", $0.id) < ($1.name ?? "", $1.id) }
        if !everyone.isEmpty || !workspace.showsMeToOthers {
            Menu {
                if everyone.isEmpty { Text("No one else is here") }
                ForEach(everyone) { peer in
                    let page = peer.page.map { $0.path.split(separator: "/").last.map(String.init) ?? "Home" } ?? "No page"
                    Text("\(StoryPresenceBadge.label(for: peer)): \(page)\(peer.agent?.status.map { " (\($0))" } ?? "")")
                }
                Divider()
                Toggle("Show Me to Others", isOn: Binding(
                    get: { workspace.showsMeToOthers },
                    set: { workspace.showsMeToOthers = $0 }))
            } label: {
                HStack(spacing: -4) {
                    ForEach(here.prefix(4)) { StoryPresenceBadge(peer: $0) }
                    if here.isEmpty {
                        Image(systemName: workspace.showsMeToOthers ? "person.2" : "eye.slash")
                    }
                    if everyone.count > here.count {
                        Text("+\(everyone.count - here.count)").font(.caption2).foregroundStyle(.secondary).padding(.leading, 6)
                    }
                }
            }
            .menuIndicator(.hidden)
            .help("Who's here")
            .accessibilityLabel("Who's here")
        }
    }
}
