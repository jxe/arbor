import Overstory
import OverstoryClient
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
        color(profile: peer.profile)
    }

    static func color(profile: String) -> Color {
        let hash = profile.unicodeScalars.reduce(UInt32(2166136261)) { ($0 ^ $1.value) &* 16777619 }
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

/// The toolbar's presence and account button: your avatar, your agents beside
/// it as sparkles, then everyone else on this page and a count of those
/// elsewhere in the tree. Each person carries a badge for what they're on, Mac
/// or iPhone; sync shows only when it isn't finished, as the badge on your
/// avatar. Its menu lists who's here, the sync state and Sync & Accounts…;
/// Show Me to Others is in Settings. The Mac always shows it, just before the
/// microphone; the iPhone only while someone else is on the page.
struct StoryPresenceAccountMenu: View {
    let workspace: StoryWorkspaceState
    let reference: WorkspaceReference
    let status: StorySyncStatus
    let openAccounts: () -> Void

    var body: some View {
        let me = workspace.directory.first { workspace.isOwnProfile($0.id) }
        let here = workspace.presencePeers(on: reference)
        let hereIDs = Set(here.map(\.id))
        let mine = here.filter { $0.agent != nil && workspace.isOwnProfile($0.profile) }
        let others = here.filter { !($0.agent != nil && workspace.isOwnProfile($0.profile)) }
        let shown = Array(mine.prefix(2)) + Array(others.prefix(3))
        let elsewhere = workspace.presenceRoster.peers.values
            .filter { !hereIDs.contains($0.id) }
            .sorted { ($0.name ?? "", $0.id) < ($1.name ?? "", $1.id) }
        Menu {
            if here.isEmpty && elsewhere.isEmpty { Text("No one else is here") }
            if !here.isEmpty {
                Section("On This Page") {
                    ForEach(here) { Text(Self.line(for: $0, page: nil)) }
                }
            }
            if !elsewhere.isEmpty {
                Section("Elsewhere") {
                    ForEach(elsewhere) { peer in
                        Text(Self.line(for: peer, page: peer.page.map { $0.path.split(separator: "/").last.map(String.init) ?? "Home" } ?? "No page"))
                    }
                }
            }
            if !workspace.showsMeToOthers {
                Text("You're hidden from others (Settings)")
            }
            Divider()
            Text(status.label)
            Button("Sync & Accounts…", action: openAccounts)
        } label: {
            HStack(spacing: -4) {
                StoryToolbarAvatar(
                    person: me,
                    workspace: workspace,
                    fallbackName: me?.title,
                    tint: me.map { StoryPresenceBadge.color(profile: $0.id) } ?? .accentColor)
                    .opacity(workspace.showsMeToOthers ? 1 : 0.45)
                    .overlay(alignment: .bottomTrailing) {
                        if status != .synchronized {
                            StorySyncToolbarIndicator(status: status)
                                .frame(width: 11, height: 11)
                                .background(.bar, in: Circle())
                                .offset(x: 3, y: 3)
                        } else {
                            StoryPresenceDeviceBadge(device: StoryWorkspaceState.presenceDevice)
                        }
                    }
                    .zIndex(1)
                // Each sits over the next, so no neighbor covers its badge.
                ForEach(Array(shown.enumerated()), id: \.element.id) { index, peer in
                    mark(for: peer).zIndex(Double(-index))
                }
                if !elsewhere.isEmpty {
                    Text("+\(elsewhere.count)")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .padding(.leading, 8)
                }
            }
            .contentShape(.rect)
        }
        .menuIndicator(.hidden)
        .fixedSize()
        .help("Who's here and accounts — \(status.accessibilityDescription)")
        .accessibilityLabel("Who's here and accounts. \(status.accessibilityDescription)")
    }

    @ViewBuilder
    private func mark(for peer: ProtocolPresencePeer) -> some View {
        if peer.agent != nil {
            StoryToolbarAgentMark(peer: peer)
        } else {
            StoryToolbarAvatar(
                person: workspace.directory.first { $0.id == peer.profile },
                workspace: workspace,
                fallbackName: peer.name,
                tint: StoryPresenceBadge.color(for: peer))
                .overlay(alignment: .bottomTrailing) {
                    StoryPresenceDeviceBadge(device: peer.device)
                }
        }
    }

    private static func line(for peer: ProtocolPresencePeer, page: String?) -> String {
        let status = peer.agent?.status.map { " (\($0))" } ?? ""
        guard let page else { return StoryPresenceBadge.label(for: peer) + status }
        return "\(StoryPresenceBadge.label(for: peer)): \(page)\(status)"
    }
}

/// What a person's entry is on, at the corner of their avatar. An agent needs
/// none: its sparkle already says so.
struct StoryPresenceDeviceBadge: View {
    let device: String?

    var body: some View {
        if let symbol {
            Image(systemName: symbol)
                .font(.system(size: 6.5, weight: .semibold))
                .foregroundStyle(.primary)
                .frame(width: 10, height: 10)
                .background(.bar, in: Circle())
                .offset(x: 2, y: 2)
                .accessibilityHidden(true)
        }
    }

    private var symbol: String? {
        switch device {
        case "mac": "laptopcomputer"
        case "ios": "iphone"
        default: nil
        }
    }
}

/// A person in the toolbar: their profile photo, or initials on their color.
struct StoryToolbarAvatar: View {
    let person: DirectoryPerson?
    let workspace: StoryWorkspaceState
    let fallbackName: String?
    var tint: Color = .accentColor
    var size: CGFloat = 24
    @State private var image: Image?

    var body: some View {
        ZStack {
            Circle().fill(tint)
            if let image {
                image.resizable().scaledToFill()
            } else if let initials {
                Text(initials)
                    .font(.system(size: size * 0.42, weight: .semibold))
                    .foregroundStyle(.white)
            } else {
                Image(systemName: "person.fill")
                    .font(.system(size: size * 0.5))
                    .foregroundStyle(.white)
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
        .overlay(Circle().strokeBorder(.background, lineWidth: 1.5))
        .task(id: person?.entry.avatar?.hash) {
            guard let person, let avatar = person.entry.avatar else { image = nil; return }
            guard let data = try? await AvatarCache().data(for: avatar, fetch: {
                try await workspace.avatarData(for: person)
            }), let thumbnail = StoryAvatarImage.thumbnail(data, maxPixelSize: 96) else { return }
            image = Image(decorative: thumbnail, scale: 2)
        }
    }

    private var initials: String? {
        if let person { return person.initials }
        let words = (fallbackName ?? "").split(whereSeparator: \.isWhitespace)
        let letters = words.prefix(2).compactMap(\.first).map { String($0).uppercased() }
        return letters.isEmpty ? nil : letters.joined()
    }
}

/// An agent in the toolbar: a sparkle in its person's color, lighter than a
/// person, so it reads as working for someone rather than as someone.
struct StoryToolbarAgentMark: View {
    let peer: ProtocolPresencePeer
    var size: CGFloat = 24

    var body: some View {
        let color = StoryPresenceBadge.color(for: peer)
        Image(systemName: "sparkle")
            .font(.system(size: size * 0.5, weight: .semibold))
            .foregroundStyle(color)
            .frame(width: size, height: size)
            .background(Circle().fill(color.opacity(0.18)).background(Circle().fill(.background)))
            .overlay(Circle().strokeBorder(color.opacity(0.6), lineWidth: 1))
            .help(StoryPresenceBadge.label(for: peer) + (peer.agent?.status.map { ": \($0)" } ?? ""))
    }
}

#if os(macOS)
/// Story Sync answered 405 to the agent routes: it runs older code than this
/// app, which a rebuild doesn't restart. Restarting it is the person's click.
struct StoryOutdatedSyncWarning: View {
    let workspace: StoryWorkspaceState
    @State private var showing = false
    @State private var restarting = false

    var body: some View {
        Button { showing = true } label: {
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
        }
        .help("Story Sync is out of date")
        .accessibilityLabel("Story Sync is out of date")
        .popover(isPresented: $showing) {
            VStack(alignment: .leading, spacing: 10) {
                Text("Story Sync is out of date").font(.headline)
                Text("It is still running code from before this build of Story, so agent tasks can't run. Restarting it doesn't close your pages.")
                    .fixedSize(horizontal: false, vertical: true)
                HStack {
                    Spacer()
                    if restarting { ProgressView().controlSize(.small) }
                    Button("Restart Story Sync") {
                        restarting = true
                        Task {
                            await workspace.restartStorySync(restartingService: true)
                            restarting = false
                            if !workspace.storySyncIsOutdated { showing = false }
                        }
                    }
                    .keyboardShortcut(.defaultAction)
                    .disabled(restarting)
                }
            }
            .padding()
            .frame(width: 300)
        }
    }
}
#endif

/// The line under an agent task's text: the finished run's result on a done
/// task, or why the last Run didn't start.
struct StoryAgentTaskDetail: View {
    let workspace: StoryWorkspaceState
    let reference: WorkspaceReference
    let task: String
    let done: Bool

    var body: some View {
#if os(macOS)
        let run = workspace.agentRun(task: task, on: reference)
        if done, let run, run.state == .finished, let result = run.result {
            Text(result).font(.caption).foregroundStyle(.secondary).lineLimit(2).help(result)
        } else if !done, let error = workspace.agentRunError(task: task, on: reference) {
            Label(error, systemImage: "exclamationmark.circle").font(.caption).foregroundStyle(.secondary).lineLimit(2)
        }
#endif
    }
}

/// The control at the end of an agent task callout (Agents 001 phase 6):
/// Run on the Mac, then a spinner with Stop, then Run Again on failure. A
/// finished run checks its task off; the done task shows the run's result and
/// Undo Run while the run can be undone. On iPhone and iPad the task waits for a Mac.
struct StoryAgentTaskControl: View {
    let workspace: StoryWorkspaceState
    let reference: WorkspaceReference
    let task: String
    var done = false

    var body: some View {
#if os(macOS)
        let run = workspace.agentRun(task: task, on: reference)
        HStack(spacing: 6) {
            if done {
                // The result is the callout's detail line, under the text (`StoryAgentTaskDetail`).
                if let run, run.state == .finished, run.undoable {
                    Button("Undo Run") { Task { await workspace.undoAgentRun(run) } }
                }
            } else {
                switch run?.state {
                case .queued?, .running?:
                    ProgressView().controlSize(.small)
                    Button("Stop") { if let run { Task { await workspace.stopAgentRun(run) } } }
                case .failed?, .stopped?:
                    Image(systemName: "exclamationmark.circle").foregroundStyle(.red)
                        .help(run?.result ?? "The run did not finish")
                    Button("Run Again") { Task { await workspace.runAgentTask(task, on: reference) } }
                case .finished?, .undone?, nil:
                    Button {
                        Task { await workspace.runAgentTask(task, on: reference) }
                    } label: {
                        Image(systemName: "play.fill")
                    }
                    .controlSize(.regular)
                    .buttonBorderShape(.circle)
                    .help("Run this task with Claude Code in this tree's folder")
                    .accessibilityLabel("Run with Claude")
                }
            }
        }
        .controlSize(.small)
        .buttonStyle(.bordered)
#else
        if !done {
            Image(systemName: "desktopcomputer")
                .foregroundStyle(.secondary)
                .help("Run this task from Story on your Mac")
                .accessibilityLabel("Run this task from Story on your Mac")
        }
#endif
    }
}
