import ArborKit
import ArborQuagmire
import ArborSync
import SwiftUI

enum ArborPresentedSheet: String, Identifiable {
    case createMarkdown
    case createDirectory
    case rename
    case move
    case copy
    case openLocation
    case source
    case history
    case backlinks
    case arbordLogs
    case syncConflict

    var id: String { rawValue }
}

struct ArborWindowCommands {
    var goHome: () -> Void
    var goBack: () -> Void
    var newTab: () -> Void
    var closeTab: () -> Void
    var showSearch: () -> Void
    var showHistory: () -> Void
    var canGoBack: Bool
    var canCloseTab: Bool
    var hasDocument: Bool
}

private struct ArborWindowCommandsKey: FocusedValueKey {
    typealias Value = ArborWindowCommands
}

extension FocusedValues {
    var arborWindowCommands: ArborWindowCommands? {
        get { self[ArborWindowCommandsKey.self] }
        set { self[ArborWindowCommandsKey.self] = newValue }
    }
}

struct ArborTabStrip: View {
    let tabs: [BrowserTab]
    let selected: UUID
    let title: (BrowserTab) -> String
    let select: (UUID) -> Void
    let close: () -> Void
    let create: () -> Void

    var body: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 4) {
                ForEach(tabs) { tab in
                    Button {
                        select(tab.id)
                    } label: {
                        Text(title(tab))
                            .lineLimit(1)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 6)
                            .background(tab.id == selected ? Color.accentColor.opacity(0.16) : .clear)
                            .clipShape(.rect(cornerRadius: 8))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Tab: \(title(tab))")
                }
                Button("New Tab", systemImage: "plus", action: create)
                    .labelStyle(.iconOnly)
                    .buttonStyle(.borderless)
                Button("Close Tab", systemImage: "xmark", action: close)
                    .labelStyle(.iconOnly)
                    .buttonStyle(.borderless)
                    .disabled(tabs.count == 1)
            }
            .padding(.horizontal, 8)
        }
        .scrollIndicators(.hidden)
        .frame(height: 38)
        .background(.bar)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Tabs")
    }
}

struct ArborBreadcrumbs: View {
    let reference: WorkspaceReference
    let open: (WorkspaceReference) -> Void

    var body: some View {
        HStack(spacing: 4) {
            Button("Home", systemImage: "house") {
                open(WorkspaceReference(tree: reference.tree, path: "/"))
            }
            .labelStyle(.iconOnly)
            ForEach(components.indices, id: \.self) { index in
                Image(systemName: "chevron.right")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                Button(components[index]) {
                    open(WorkspaceReference(
                        tree: reference.tree,
                        path: "/" + components.prefix(index + 1).joined(separator: "/")
                    ))
                }
                .buttonStyle(.plain)
            }
            Spacer()
        }
        .font(.caption)
        .padding(.horizontal, 12)
        .frame(height: 28)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Location: \(reference.pathHint)")
    }

    private var components: [String] { reference.pathHint.split(separator: "/").map(String.init) }
}

struct ArborStatusBar: View {
    let provider: String
    let sync: WorkspaceSyncPresentation
    let binding: ArborDocumentBinding?

    var body: some View {
        HStack(spacing: 10) {
            Text(provider)
            Spacer()
            if let binding {
                if binding.isSaving {
                    Label("Saving", systemImage: "ellipsis.circle")
                } else if binding.conflict != nil {
                    Label("Edit conflict", systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.orange)
                } else if binding.lastError != nil {
                    Label("Save failed", systemImage: "exclamationmark.circle")
                        .foregroundStyle(.red)
                } else {
                    Label("Saved", systemImage: "checkmark")
                }
            }
            Label(sync.state.label, systemImage: sync.state.symbol)
                .help(sync.detail ?? sync.state.label)
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .padding(.horizontal, 12)
        .frame(height: 28)
        .background(.bar)
        .accessibilityElement(children: .combine)
    }
}

struct ArborSourceInspector: View {
    let node: WorkspaceNode
    let snapshot: WorkspaceDocumentSnapshot?

    var body: some View {
        NavigationStack {
            Form {
                Section("Identity") {
                    LabeledContent("Tree", value: node.reference.tree.rawValue)
                    LabeledContent("Path", value: node.reference.pathHint)
                    if let pageID = node.reference.pageID { LabeledContent("PageID", value: pageID.rawValue) }
                }
                Section("Provenance") {
                    LabeledContent("Source", value: node.provenance.sourceDescription)
                    if let revision = node.provenance.contentRevision { LabeledContent("Revision", value: revision) }
                    LabeledContent("Access", value: node.isWritable ? "Writable" : "Read only")
                }
                if let snapshot {
                    Section("Exact source") {
                        Text(snapshot.source)
                            .font(.body.monospaced())
                            .textSelection(.enabled)
                    }
                }
            }
            .navigationTitle("Source and Properties")
        }
        .frame(minWidth: 520, minHeight: 480)
    }
}

struct ArborHistoryView: View {
    let entries: [WorkspaceHistoryEntry]
    let recover: (String) -> Void

    var body: some View {
        NavigationStack {
            List(entries) { entry in
                HStack {
                    VStack(alignment: .leading) {
                        Text(entry.title)
                        Text(entry.timestamp, format: .dateTime)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button("Restore as New Change") { recover(entry.revision) }
                }
            }
            .overlay {
                if entries.isEmpty {
                    ContentUnavailableView("No local recovery history", systemImage: "clock")
                }
            }
            .navigationTitle("Recover")
        }
        .frame(minWidth: 500, minHeight: 420)
    }
}

struct ArborBacklinksView: View {
    let entries: [WorkspaceSearchResult]
    let open: (WorkspaceReference) -> Void

    var body: some View {
        NavigationStack {
            List(entries) { entry in
                Button {
                    open(entry.reference)
                } label: {
                    VStack(alignment: .leading) {
                        Text(entry.title)
                        if let excerpt = entry.excerpt {
                            Text(excerpt).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                        }
                    }
                }
            }
            .overlay {
                if entries.isEmpty { ContentUnavailableView("No backlinks", systemImage: "link") }
            }
            .navigationTitle("Linked From")
        }
        .frame(minWidth: 460, minHeight: 400)
    }
}

struct ArborSyncConflictView: View {
    let conflict: ReplicaConflictPresentation
    let keepLocal: () -> Void

    var body: some View {
        NavigationStack {
            Form {
                Section("Roots") {
                    LabeledContent("Base", value: conflict.base)
                    LabeledContent("Local", value: conflict.local)
                    LabeledContent("Remote", value: conflict.remote)
                    LabeledContent("Authority draft", value: conflict.draft)
                }
                Section("Unsafe overlaps") {
                    ForEach(Array(conflict.reasons.enumerated()), id: \.offset) { _, reason in
                        VStack(alignment: .leading) {
                            Text(reason.path).font(.headline)
                            Text(reason.reason).foregroundStyle(.secondary)
                        }
                    }
                }
                Section {
                    Text("Arbor has kept both the local candidate and the authority's remote/draft evidence. Continuing keeps the local tree as a new intent based on the current remote root.")
                        .foregroundStyle(.secondary)
                    Button("Keep Local and Retry", action: keepLocal)
                        .buttonStyle(.borderedProminent)
                }
            }
            .navigationTitle("Synchronization Conflict")
        }
        .frame(minWidth: 620, minHeight: 480)
    }
}

struct ArborMutationForm: View {
    let mode: ArborPresentedSheet
    let submit: (_ first: String, _ source: String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var first = ""
    @State private var source = ""

    var body: some View {
        NavigationStack {
            Form {
                TextField(prompt, text: $first)
                if mode == .createMarkdown {
                    TextField("Initial Markdown", text: $source, axis: .vertical)
                        .lineLimit(8...20)
                }
            }
            .navigationTitle(title)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(actionTitle) {
                        submit(first, source)
                        dismiss()
                    }
                    .disabled(first.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
        .frame(minWidth: 420, minHeight: mode == .createMarkdown ? 360 : 180)
    }

    private var title: String {
        switch mode {
        case .createMarkdown: "New Document"
        case .createDirectory: "New Folder"
        case .rename: "Rename"
        case .move: "Move"
        case .copy: "Copy"
        case .openLocation: "Open Location"
        default: "Action"
        }
    }

    private var prompt: String {
        switch mode {
        case .move, .copy, .openLocation: "Location path"
        case .rename: "New name"
        default: "Name"
        }
    }

    private var actionTitle: String {
        switch mode {
        case .move: "Move"
        case .copy: "Copy"
        case .openLocation: "Open"
        case .rename: "Rename"
        default: "Create"
        }
    }
}

extension WorkspaceSynchronization {
    var label: String {
        switch self {
        case .offline: "Offline"
        case .locallyPending: "Local changes"
        case .requestPending: "Sync pending"
        case .uploading: "Uploading"
        case .downloading: "Downloading"
        case .current: "Current"
        case .autoMerged: "Merged"
        case .approximatePlacement: "Merged approximately"
        case .conflict: "Conflict"
        case .authenticationFailure: "Sign in required"
        case .revoked: "Device revoked"
        }
    }

    var symbol: String {
        switch self {
        case .offline: "wifi.slash"
        case .locallyPending, .requestPending: "arrow.trianglehead.2.clockwise.rotate.90"
        case .uploading: "arrow.up.circle"
        case .downloading: "arrow.down.circle"
        case .current: "checkmark.icloud"
        case .autoMerged, .approximatePlacement: "arrow.trianglehead.merge"
        case .conflict: "exclamationmark.arrow.trianglehead.2.clockwise.rotate.90"
        case .authenticationFailure: "person.crop.circle.badge.exclamationmark"
        case .revoked: "person.crop.circle.badge.xmark"
        }
    }
}
