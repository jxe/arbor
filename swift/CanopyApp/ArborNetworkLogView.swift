import Overstory
import SwiftUI
#if os(macOS)
import AppKit
#else
import UIKit
#endif

/// Client network log viewer: updates, watch connects/frames/disconnects, and
/// tree reads, newest first, with the server's phase timings when the response
/// carried them. Entries are read from the installed `WireNetworkLog`.
struct ArborNetworkLogView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var entries: [WireNetworkLogEntry] = []
    @State private var kinds: Set<WireNetworkLogEntry.Kind> = Set(WireNetworkLogEntry.Kind.allCases)
    @State private var query = ""
    @State private var expanded: Set<String> = []
    @State private var copied = false

    private var log: WireNetworkLog? { WireNetworkLog.current }

    private var visible: [WireNetworkLogEntry] {
        let needle = query.trimmingCharacters(in: .whitespaces).lowercased()
        return entries.sorted { $0.at > $1.at }.filter { entry in
            guard kinds.contains(entry.kind) else { return false }
            guard !needle.isEmpty else { return true }
            return [entry.name, entry.tree ?? "", entry.error ?? "", entry.cursor ?? "",
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
                                           description: Text(log == nil ? "The network log is not installed." : "Events appear here as Arbor talks to the server."))
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
        .frame(minWidth: 720, minHeight: 480)
        .task { reload() }
    }

    private var filters: some View {
        HStack(spacing: 12) {
            ForEach(WireNetworkLogEntry.Kind.allCases, id: \.self) { kind in
                Toggle(label(kind), isOn: Binding(
                    get: { kinds.contains(kind) },
                    set: { on in if on { kinds.insert(kind) } else { kinds.remove(kind) } }
                ))
                .toggleStyle(.button)
                .controlSize(.small)
            }
            Spacer()
            TextField("Filter", text: $query)
                .textFieldStyle(.roundedBorder)
                .frame(maxWidth: 220)
            Text("\(visible.count)").font(.caption).foregroundStyle(.secondary).monospacedDigit()
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }

    @ViewBuilder
    private func row(_ entry: WireNetworkLogEntry) -> some View {
        let open = expanded.contains(entry.id)
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Text(Self.time.string(from: entry.at)).font(.caption.monospaced()).foregroundStyle(.secondary)
                Text(label(entry.kind))
                    .font(.caption2.weight(.semibold))
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .background(tint(entry).opacity(0.18), in: Capsule())
                    .foregroundStyle(tint(entry))
                Text(entry.name).font(.body.monospaced())
                if let tree = entry.tree { Text(shortTree(tree)).font(.caption.monospaced()).foregroundStyle(.secondary) }
                Spacer()
                if let status = entry.status { Text("\(status)").font(.caption.monospaced()).foregroundStyle(status >= 400 ? .red : .secondary) }
                if let ms = entry.roundTripMs {
                    Text("↺ \(Int(ms.rounded())) ms").font(.caption.monospaced()).foregroundStyle(.blue)
                } else if let ms = entry.durationMs {
                    Text("\(Int(ms.rounded())) ms").font(.caption.monospaced()).foregroundStyle(ms > 1000 ? .orange : .primary)
                }
                if let total = entry.serverTiming?["total"] {
                    Text("server \(Int(total.rounded()))").font(.caption.monospaced()).foregroundStyle(.secondary)
                }
            }
            if let error = entry.error { Text(error).font(.caption).foregroundStyle(.red).lineLimit(open ? nil : 1) }
            if open { details(entry) }
        }
        .contentShape(Rectangle())
        .onTapGesture { if open { expanded.remove(entry.id) } else { expanded.insert(entry.id) } }
        .padding(.vertical, 2)
    }

    @ViewBuilder
    private func details(_ entry: WireNetworkLogEntry) -> some View {
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

    private func label(_ kind: WireNetworkLogEntry.Kind) -> String {
        switch kind {
        case .update: "update"
        case .watchConnect: "connect"
        case .watchFrame: "frame"
        case .watchDisconnect: "disconnect"
        case .read: "read"
        case .note: "note"
        }
    }

    private func tint(_ entry: WireNetworkLogEntry) -> Color {
        if entry.error != nil { return .red }
        switch entry.kind {
        case .update: return .green
        case .watchConnect: return .blue
        case .watchFrame: return .teal
        case .watchDisconnect: return .orange
        case .read: return .gray
        case .note: return .purple
        }
    }

    private func shortTree(_ tree: String) -> String { tree.count > 12 ? String(tree.prefix(12)) + "…" : tree }

    private func reload() { entries = log?.entries() ?? [] }

    private func copyAll() {
        let text = WireNetworkLog.text(Array(visible.reversed()))
#if os(macOS)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
#else
        UIPasteboard.general.string = text
#endif
        copied = true
        Task { try? await Task.sleep(for: .seconds(2)); copied = false }
    }

    private static let time: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm:ss.SSS"
        return formatter
    }()
}
