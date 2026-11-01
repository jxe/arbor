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

    private var runs: [StoryAgentRun] {
#if os(macOS)
        workspace.agentRuns.values.filter { $0.tree == reference.tree.rawValue }.sorted { $0.id < $1.id }
#else
        []
#endif
    }

    var body: some View {
#if os(macOS)
        if workspace.storySyncIsOutdated { StoryOutdatedSyncWarning(workspace: workspace) }
#endif
        let here = workspace.presencePeers(on: reference)
        let everyone = workspace.presenceRoster.peers.values.sorted { ($0.name ?? "", $0.id) < ($1.name ?? "", $1.id) }
        if !everyone.isEmpty || !workspace.showsMeToOthers || !runs.isEmpty {
            Menu {
                if everyone.isEmpty { Text("No one else is here") }
                ForEach(everyone) { peer in
                    let page = peer.page.map { $0.path.split(separator: "/").last.map(String.init) ?? "Home" } ?? "No page"
                    Text("\(StoryPresenceBadge.label(for: peer)): \(page)\(peer.agent?.status.map { " (\($0))" } ?? "")")
                }
#if os(macOS)
                // A finished run took its task block with it; its result and Undo stay here.
                if !runs.isEmpty {
                    Divider()
                    Section("Agent Runs") {
                        ForEach(runs) { run in
                            Menu("\(run.task): \(run.result ?? run.state.rawValue)") {
                                if run.undoable { Button("Undo Run") { Task { await workspace.undoAgentRun(run) } } }
                                if run.isActive { Button("Stop") { Task { await workspace.stopAgentRun(run) } } }
                                Button("Dismiss") { workspace.dismissAgentRun(run) }
                            }
                        }
                    }
                }
#endif
                Divider()
                Toggle("Show Me to Others", isOn: Binding(
                    get: { workspace.showsMeToOthers },
                    set: { workspace.showsMeToOthers = $0 }))
            } label: {
                HStack(spacing: -4) {
                    ForEach(here.prefix(4)) { StoryPresenceBadge(peer: $0) }
                    if here.isEmpty {
                        Image(systemName: !runs.isEmpty ? "sparkles" : workspace.showsMeToOthers ? "person.2" : "eye.slash")
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

/// The control at the end of an agent task callout (Agents 001 phase 6):
/// Run on the Mac, then a spinner with Stop, then Undo Run or Run Again. The
/// result and Undo also stay in the toolbar's presence menu, since a
/// finished run removes its block. On iPhone and iPad the task waits for a Mac.
struct StoryAgentTaskControl: View {
    let workspace: StoryWorkspaceState
    let reference: WorkspaceReference
    let task: String

    var body: some View {
#if os(macOS)
        let run = workspace.agentRun(task: task, on: reference)
        HStack(spacing: 6) {
            switch run?.state {
            case .queued?, .running?:
                ProgressView().controlSize(.small)
                Button("Stop") { if let run { Task { await workspace.stopAgentRun(run) } } }
            case .failed?, .stopped?:
                Image(systemName: "exclamationmark.circle").foregroundStyle(.red)
                    .help(run?.result ?? "The run did not finish")
                Button("Run Again") { Task { await workspace.runAgentTask(task, on: reference) } }
            case .finished?:
                if let run, run.undoable { Button("Undo Run") { Task { await workspace.undoAgentRun(run) } } }
            case .undone?, nil:
                if let error = workspace.agentRunError(task: task, on: reference) {
                    Image(systemName: "exclamationmark.circle").foregroundStyle(.red)
                    Text(error).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                }
                Button {
                    Task { await workspace.runAgentTask(task, on: reference) }
                } label: {
                    Image(systemName: "play.fill")
                }
                .buttonBorderShape(.circle)
                .help("Run this task with Claude Code in this tree's folder")
                .accessibilityLabel("Run with Claude")
            }
        }
        .controlSize(.small)
        .buttonStyle(.bordered)
#else
        Image(systemName: "desktopcomputer")
            .foregroundStyle(.secondary)
            .help("Run this task from Story on your Mac")
            .accessibilityLabel("Run this task from Story on your Mac")
#endif
    }
}
