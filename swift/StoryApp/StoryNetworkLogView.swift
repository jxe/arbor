import Overstory
import SwiftUI
#if os(macOS)
import AppKit
#else
import UIKit
#endif

/// Client network log viewer: updates, watch connects/frames/disconnects, and
/// tree reads, newest first, with the server's phase timings when the response
/// carried them. Entries are read from the installed `ProtocolNetworkLog`.
struct StoryNetworkLogView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var entries: [ProtocolNetworkLogEntry] = []
    @State private var kinds: Set<ProtocolNetworkLogEntry.Kind> = Set(ProtocolNetworkLogEntry.Kind.allCases)
    @State private var query = ""
    @State private var expanded: Set<String> = []
    @State private var copied = false

    private var log: ProtocolNetworkLog? { ProtocolNetworkLog.current }

    private var visible: [ProtocolNetworkLogEntry] {
        let needle = query.trimmingCharacters(in: .whitespaces).lowercased()
        return entries.sorted { $0.at > $1.at }.filter { entry in
            guard kinds.contains(entry.kind) else { return false }
            guard !needle.isEmpty else { return true }
            return [entry.name, entry.tree ?? "", entry.error ?? "", entry.detail ?? "", entry.cursor ?? "",
                    (entry.updateIDs ?? []).joined(separator: " "), (entry.requestDigests ?? []).joined(separator: " ")]
                .joined(separator: " ").lowercased().contains(needle)
        }
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                filters
                Divider()
                if visible.isEmpty {
                    ContentUnavailableView("No network events", systemImage: "waveform.path.ecg",
                                           description: Text(log == nil ? "The network log is not installed." : "Events appear here as Story talks to the server."))
                } else {
                    List(visible) { entry in
                        row(entry)
                    }
                    .listStyle(.plain)
                }
            }
            .navigationTitle("Network Log")
            .toolbar {
                ToolbarItemGroup(placement: .automatic) {
                    Button(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc") { copyAll() }
                        .help("Copy the visible entries as text")
#if os(macOS)
                    Button("Reveal File", systemImage: "folder") {
                        if let url = log?.fileURL { NSWorkspace.shared.activateFileViewerSelecting([url]) }
                    }
                    .help("Show today's log file in Finder")
#endif
                    Button("Refresh", systemImage: "arrow.clockwise") { reload() }
                    Button("Clear", systemImage: "trash", role: .destructive) { log?.clear(); reload() }
                }
                ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
            }
        }
#if os(macOS)
        .frame(minWidth: 720, minHeight: 480)
#endif
        .task { reload() }
    }

    private var filters: some View {
        HStack(spacing: 12) {
            // The kinds scroll on a narrow screen rather than widening the view.
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 12) {
                    ForEach(ProtocolNetworkLogEntry.Kind.allCases, id: \.self) { kind in
                        Toggle(label(kind), isOn: Binding(
                            get: { kinds.contains(kind) },
                            set: { on in if on { kinds.insert(kind) } else { kinds.remove(kind) } }
                        ))
                        .toggleStyle(.button)
                        .controlSize(.small)
                    }
                }
            }
            TextField("Filter", text: $query)
                .textFieldStyle(.roundedBorder)
                .frame(maxWidth: 220)
            Text("\(visible.count)").font(.caption).foregroundStyle(.secondary).monospacedDigit()
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }

    @ViewBuilder
    private func row(_ entry: ProtocolNetworkLogEntry) -> some View {
        let open = expanded.contains(entry.id)
        VStack(alignment: .leading, spacing: 4) {
            // One line on the Mac; the phone puts the tree and timings on a second.
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) {
                    heading(entry)
                    if let tree = entry.tree { Text(shortTree(tree)).font(.caption.monospaced()).foregroundStyle(.secondary) }
                    Spacer()
                    metrics(entry)
                }
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 8) { heading(entry) }
                    HStack(spacing: 8) {
                        if let tree = entry.tree { Text(shortTree(tree)).font(.caption.monospaced()).foregroundStyle(.secondary) }
                        Spacer()
                        metrics(entry)
                    }
                }
            }
            if let failure = failure(entry) {
                Label(failure, systemImage: "exclamationmark.triangle.fill")
                    .font(.caption).foregroundStyle(.red).lineLimit(open ? nil : 1)
            } else if let remark = remark(entry) {
                Text(remark).font(.caption).foregroundStyle(.secondary).lineLimit(open ? nil : 1)
            }
            if open { details(entry) }
        }
        .contentShape(Rectangle())
        .onTapGesture { if open { expanded.remove(entry.id) } else { expanded.insert(entry.id) } }
        .padding(.vertical, 2)
    }

    @ViewBuilder
    private func heading(_ entry: ProtocolNetworkLogEntry) -> some View {
        Text(Self.time.string(from: entry.at)).font(.caption.monospaced()).foregroundStyle(.secondary)
        // A fixed-width badge keeps the names in one column.
        Text(label(entry.kind))
            .font(.caption2.weight(.semibold))
            .padding(.vertical, 2)
            .frame(width: Self.badgeWidth)
            .background(tint(entry).opacity(0.15), in: Capsule())
            .foregroundStyle(tint(entry))
        Text(entry.name).font(.callout.monospaced())
    }

    @ViewBuilder
    private func metrics(_ entry: ProtocolNetworkLogEntry) -> some View {
        // Fixed, right-aligned columns so the numbers line up from row to row;
        // a plain success status is left out as noise.
        HStack(spacing: 10) {
            Group {
                if let status = entry.status, !(200..<300).contains(status) {
                    Text("\(status)").foregroundStyle(statusTint(status))
                } else {
                    Text("")
                }
            }
            .frame(width: 32, alignment: .trailing)
            Group {
                if let ms = entry.roundTripMs {
                    Text("↺ \(Int(ms.rounded())) ms").foregroundStyle(.blue)
                } else if let ms = entry.durationMs {
                    Text("\(Int(ms.rounded())) ms").foregroundStyle(ms > 1000 ? .orange : .primary)
                } else {
                    Text("")
                }
            }
            .frame(width: 76, alignment: .trailing)
            Group {
                if let total = entry.serverTiming?["total"] {
                    Text("server \(Int(total.rounded()))")
                } else {
                    Text("")
                }
            }
            .foregroundStyle(.secondary)
            .frame(width: 76, alignment: .trailing)
        }
        .font(.caption.monospaced())
    }

    @ViewBuilder
    private func details(_ entry: ProtocolNetworkLogEntry) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            if let tree = entry.tree { detail("tree", tree) }
            if let ids = entry.updateIDs, !ids.isEmpty { detail("updates", ids.joined(separator: ", ")) }
            if let root = entry.root { detail("root", root) }
            if let cursor = entry.cursor { detail("cursor", cursor) }
            if let digests = entry.requestDigests, !digests.isEmpty { detail("digests", digests.joined(separator: "\n")) }
            if let attempt = entry.attempt, attempt > 1 { detail("attempt", "\(attempt)") }
            if let out = entry.bytesOut { detail("bytes out", "\(out)") }
            if let bytesIn = entry.bytesIn { detail(entry.kind == .watchDisconnect ? "frames" : "bytes in", "\(bytesIn)") }
            if let ms = entry.afterResponseMs { detail("after response", "\(Int(ms.rounded())) ms") }
            if let timing = entry.serverTiming, !timing.isEmpty {
                detail("server phases", Self.phaseText(timing))
            }
        }
        .font(.caption.monospaced())
        .textSelection(.enabled)
        .padding(.leading, 4)
    }

    private static func phaseText(_ timing: [String: Double]) -> String {
        var ordered: [(String, Double)] = []
        if let total = timing["total"] { ordered.append(("total", total)) }
        let rest = timing.filter { $0.key != "total" }.sorted { $0.value > $1.value }
        for (key, value) in rest { ordered.append((key, value)) }
        return ordered.map { "\($0.0) \(Int($0.1.rounded()))" }.joined(separator: "  ")
    }

    private func detail(_ name: String, _ value: String) -> some View {
        HStack(alignment: .top, spacing: 6) {
            Text(name).foregroundStyle(.secondary).frame(width: 96, alignment: .trailing)
            Text(value)
        }
    }

    private func label(_ kind: ProtocolNetworkLogEntry.Kind) -> String {
        switch kind {
        case .update: "update"
        case .watchConnect: "connect"
        case .watchFrame: "frame"
        case .watchDisconnect: "disconnect"
        case .read: "read"
        case .note: "note"
        }
    }

    /// The entry's failure, if it has one. Red is kept for these alone: a
    /// cancelled request is the app moving on, not a failure, and older
    /// presentation notes kept the sync state in `error`.
    private func failure(_ entry: ProtocolNetworkLogEntry) -> String? {
        guard let error = entry.error, !Self.isCancellation(error),
              !(entry.kind == .note && entry.name == "presentation") else { return nil }
        return error
    }

    /// What the entry says when nothing failed.
    private func remark(_ entry: ProtocolNetworkLogEntry) -> String? {
        entry.detail ?? (failure(entry) == nil ? entry.error : nil)
    }

    private static func isCancellation(_ error: String) -> Bool {
        error == "cancelled" || error.hasPrefix("URLError -999:")
    }

    /// A 409 is the protocol's conflict answer, which sync resolves; other
    /// 4xx and 5xx answers are failures.
    private func statusTint(_ status: Int) -> Color {
        status == 409 ? .orange : status >= 400 ? .red : .secondary
    }

    private func tint(_ entry: ProtocolNetworkLogEntry) -> Color {
        if failure(entry) != nil { return .red }
        if let status = entry.status, status >= 400 { return statusTint(status) }
        switch entry.kind {
        case .update: return .green
        case .watchConnect: return .blue
        case .watchFrame: return .teal
        case .watchDisconnect: return .indigo
        case .read: return .gray
        case .note: return .purple
        }
    }

    private static let badgeWidth: CGFloat = 72

    private func shortTree(_ tree: String) -> String { tree.count > 12 ? String(tree.prefix(12)) + "…" : tree }

    private func reload() { entries = log?.entries() ?? [] }

    private func copyAll() {
        storyCopyToPasteboard(ProtocolNetworkLog.text(Array(visible.reversed())))
        copied = true
        Task { try? await Task.sleep(for: .seconds(2)); copied = false }
    }

    private static let time: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm:ss.SSS"
        return formatter
    }()
}

/// Replace the general pasteboard's contents with `text`.
@MainActor
func storyCopyToPasteboard(_ text: String) {
#if os(macOS)
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(text, forType: .string)
#else
    UIPasteboard.general.string = text
#endif
}

#if os(macOS)
/// Put a link on the general pasteboard: the URL as text for plain pastes,
/// and titled for apps that read a link's name (Safari, Notes, Mail).
@MainActor
func storyCopyLink(_ url: URL, title: String) {
    let escaped = title
        .replacingOccurrences(of: "&", with: "&amp;")
        .replacingOccurrences(of: "<", with: "&lt;")
        .replacingOccurrences(of: ">", with: "&gt;")
    let href = url.absoluteString.replacingOccurrences(of: "\"", with: "%22")
    let pasteboard = NSPasteboard.general
    pasteboard.clearContents()
    pasteboard.setString(url.absoluteString, forType: .string)
    pasteboard.setString(url.absoluteString, forType: .URL)
    pasteboard.setString(title, forType: NSPasteboard.PasteboardType("public.url-name"))
    pasteboard.setString("<a href=\"\(href)\">\(escaped)</a>", forType: .html)
}
#endif
