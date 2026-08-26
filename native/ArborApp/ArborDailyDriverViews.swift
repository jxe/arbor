import ArborKit
import ArborQuagmire
import ArborSync
import Quagmire
import SwiftUI

enum ArborPresentedSheet: String, Identifiable {
    case createMarkdown
    case createDirectory
    case openLocation
    case source
    case history
    case backlinks
    case arborsyncLogs
    case syncConflict
    case syncStatus

    var id: String { rawValue }
}

struct ArborWindowCommands {
    var goHome: () -> Void
    var goBack: () -> Void
    var goForward: () -> Void
    var goParent: () -> Void
    var newTab: () -> Void
    var closeTab: () -> Void
    var newDocument: () -> Void
    var newFolder: () -> Void
    var openLocation: () -> Void
    var openLocalWorkspace: () -> Void
    var showHistory: () -> Void
    var showBacklinks: () -> Void
    var showSource: () -> Void
    var showSyncStatus: () -> Void
    var showPairing: () -> Void
    var movePageToTrash: () -> Void
    var restorePage: () -> Void
    var reconnectArborSync: () -> Void
    var showArborSyncLogs: () -> Void
    var canGoBack: Bool
    var canGoForward: Bool
    var canGoParent: Bool
    var canGoHome: Bool
    var canCloseTab: Bool
    var hasDocument: Bool
    var hasNode: Bool
    var canMovePageToTrash: Bool
    var canRestorePage: Bool
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

struct ArborSidebarRow: View {
    let node: WorkspaceNode
    let isCurrent: Bool
    let open: () -> Void
    let openInNewTab: () -> Void
    let trash: () -> Void

    var body: some View {
        Button(action: open) {
            HStack(spacing: 8) {
                Image(systemName: symbol)
                    .frame(width: 16)
                    .foregroundStyle(isCurrent ? Color.accentColor : .secondary)
                Text(node.title)
                    .lineLimit(1)
                Spacer(minLength: 4)
                if case .placeholder = node.surface {
                    Text("offline")
                        .font(.caption2)
                        .foregroundStyle(.orange)
                }
            }
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .fontWeight(isCurrent ? .semibold : .regular)
        .listRowBackground(isCurrent ? Color.accentColor.opacity(0.12) : Color.clear)
        .contextMenu {
            Button("Open", systemImage: "arrow.right", action: open)
            Button("Open in New Tab", systemImage: "plus.square.on.square", action: openInNewTab)
            if node.isWritable {
                Divider()
                Button("Move to Trash", systemImage: "trash", role: .destructive, action: trash)
            }
        }
        .accessibilityLabel(node.title)
        .accessibilityValue(isCurrent ? "Current page" : surfaceLabel)
    }

    private var symbol: String {
        switch node.surface {
        case .markdown: "doc.text"
        case .directory: "folder"
        case .directoryDocument: "folder.badge.gearshape"
        case .file: "doc"
        case .collection: "tablecells"
        case .placeholder: "icloud.slash"
        case .diagnostic: "exclamationmark.triangle"
        case .historical: "clock.arrow.circlepath"
        }
    }

    private var surfaceLabel: String {
        switch node.surface {
        case .markdown: "Document"
        case .directory: "Folder"
        case .directoryDocument: "Folder document"
        case .file: "File"
        case .collection: "Collection"
        case .placeholder: "Offline"
        case .diagnostic: "Diagnostic"
        case .historical: "History"
        }
    }
}

struct ArborSearchPalette: View {
    @Binding var query: String
    let results: [WorkspaceSearchResult]
    let search: @MainActor (String) async -> Void
    let open: (WorkspaceReference) -> Void

    @Environment(\.dismiss) private var dismiss
    @FocusState private var searchFocused: Bool

    var body: some View {
        Group {
#if os(iOS)
            NavigationStack {
                resultsList
                    .navigationTitle("Search")
                    .navigationBarTitleDisplayMode(.inline)
                    .searchable(
                        text: $query,
                        placement: .navigationBarDrawer(displayMode: .always),
                        prompt: "Titles and text"
                    )
                    .searchFocused($searchFocused)
                    .toolbar {
                        ToolbarItem(placement: .confirmationAction) {
                            Button("Done") { dismiss() }
                        }
                    }
            }
            .presentationDetents([.large])
#else
            NavigationStack {
                VStack(spacing: 0) {
                    TextField("Search titles and text", text: $query)
                        .textFieldStyle(.roundedBorder)
                        .focused($searchFocused)
                        .padding(12)
                    Divider()
                    resultsList
                }
                .navigationTitle("Search")
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
                }
            }
            .frame(minWidth: 480, minHeight: 460)
#endif
        }
        .task { searchFocused = true }
        .task(id: query) {
            do { try await Task.sleep(for: .milliseconds(140)) }
            catch { return }
            guard !Task.isCancelled else { return }
            await search(query)
        }
    }

    private var resultsList: some View {
        List(results) { result in
            Button {
                open(result.reference)
                dismiss()
            } label: {
                VStack(alignment: .leading, spacing: 3) {
                    Text(result.title)
                        .fontWeight(.medium)
                        .foregroundStyle(.primary)
                    if let excerpt = result.excerpt {
                        Text(excerpt)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
        }
        .overlay {
            if query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                ContentUnavailableView(
                    "Search this tree",
                    systemImage: "magnifyingglass",
                    description: Text("Titles and visible document text stay local.")
                )
            } else if results.isEmpty {
                ContentUnavailableView.search(text: query)
            }
        }
    }
}

struct ArborMoveDestinationSheet: View {
    let host: ArborEditorHost
    let request: ArborMoveRequest

    @Environment(\.dismiss) private var dismiss
    @FocusState private var searchFocused: Bool
    @State private var query = ""
    @State private var documents: [ArborMoveDocument] = []
    @State private var isLoading = false
    @State private var showAllInDocument = false

    private static let collapsedLimit = 5

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                TextField("Search destinations", text: $query)
                    .textFieldStyle(.roundedBorder)
                    .focused($searchFocused)
                    .submitLabel(.go)
                    .onSubmit(activateFirstResult)
                    .padding(12)
                Divider()
                List {
                    if !visibleInDocument.isEmpty {
                        Section("On this page") {
                            ForEach(collapsedInDocument) { target in
                                Button { activate(.block(target.id)) } label: {
                                    moveTargetLabel(target)
                                }
                                .buttonStyle(.plain)
                            }
                            if visibleInDocument.count > Self.collapsedLimit, query.isEmpty {
                                Button(showAllInDocument ? "Show less" : "Show (visibleInDocument.count - Self.collapsedLimit) more") {
                                    showAllInDocument.toggle()
                                }
                                .font(ArborStyle.shellFont(weight: .medium))
                            }
                        }
                    }
                    Section("Documents") {
                        ForEach(documents) { document in
                            Button { activate(.document(document.reference)) } label: {
                                HStack(spacing: 10) {
                                    Image(systemName: document.isHome ? "house" : "doc.text")
                                        .foregroundStyle(.secondary)
                                        .frame(width: 18)
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(document.title)
                                            .font(ArborStyle.shellFont(size: 14, weight: .medium))
                                            .foregroundStyle(.primary)
                                        Text(document.subtitle)
                                            .font(ArborStyle.shellFont(size: 11))
                                            .foregroundStyle(.secondary)
                                            .lineLimit(1)
                                            .truncationMode(.middle)
                                    }
                                }
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .contentShape(.rect)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
                .overlay {
                    if isLoading, documents.isEmpty {
                        ProgressView("Finding destinations")
                    } else if visibleInDocument.isEmpty, documents.isEmpty {
                        ContentUnavailableView(
                            "No matching destinations",
                            systemImage: "arrow.turn.down.right"
                        )
                    }
                }
            }
            .navigationTitle("Move to")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { cancel() }
                }
            }
        }
        .frame(minWidth: 480, minHeight: 500)
        .task { searchFocused = true }
        .task(id: query) {
            if !query.isEmpty {
                do { try await Task.sleep(for: .milliseconds(140)) }
                catch { return }
            }
            guard !Task.isCancelled else { return }
            isLoading = true
            documents = await host.moveDocuments(matching: query)
            isLoading = false
        }
        .onDisappear {
            if host.moveRequest?.id == request.id { host.resolveMoveRequest(with: nil) }
        }
    }

    private var visibleInDocument: [InDocMoveTarget] {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return request.inDocumentCandidates }
        return request.inDocumentCandidates.filter { $0.title.localizedCaseInsensitiveContains(trimmed) }
    }

    private var collapsedInDocument: [InDocMoveTarget] {
        showAllInDocument || !query.isEmpty
            ? visibleInDocument
            : Array(visibleInDocument.prefix(Self.collapsedLimit))
    }

    private func moveTargetLabel(_ target: InDocMoveTarget) -> some View {
        HStack(spacing: 10) {
            targetGlyph(target.kind)
            Text(target.title)
                .font(ArborStyle.shellFont(size: 14))
                .foregroundStyle(.primary)
                .lineLimit(1)
        }
        .padding(.leading, CGFloat(min(target.depth, 6)) * 16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(.rect)
    }

    @ViewBuilder
    private func targetGlyph(_ kind: InDocMoveTarget.Kind) -> some View {
        switch kind {
        case .heading(let level):
            Text("H\(level.rawValue)")
                .font(ArborStyle.shellFont(size: 10, weight: .semibold))
                .foregroundStyle(.secondary)
                .frame(width: 18)
        case .toggle:
            Image(systemName: "chevron.right.square")
                .foregroundStyle(.secondary)
                .frame(width: 18)
        }
    }

    private func activateFirstResult() {
        if let target = visibleInDocument.first { activate(.block(target.id)) }
        else if let document = documents.first { activate(.document(document.reference)) }
    }

    private func activate(_ destination: MoveDestination) {
        host.resolveMoveRequest(with: destination)
        dismiss()
    }

    private func cancel() {
        host.resolveMoveRequest(with: nil)
        dismiss()
    }
}

struct ArborStructuralMoveSheet: View {
    let host: ArborEditorHost
    let request: ArborStructuralMoveRequest

    @Environment(\.dismiss) private var dismiss
    @FocusState private var searchFocused: Bool
    @State private var query = ""
    @State private var directories: [ArborMoveDirectory] = []
    @State private var isLoading = false

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                TextField("Search folders", text: $query)
                    .textFieldStyle(.roundedBorder)
                    .focused($searchFocused)
                    .padding(12)
                Divider()
                List(directories) { directory in
                    Button {
                        host.resolveStructuralMoveRequest(with: directory.reference)
                        dismiss()
                    } label: {
                        HStack(spacing: 10) {
                            Image(systemName: directory.reference.pathHint == "/" ? "house" : "folder")
                                .foregroundStyle(.secondary)
                                .frame(width: 18)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(directory.title)
                                    .font(ArborStyle.shellFont(size: 14, weight: .medium))
                                Text(directory.reference.pathHint)
                                    .font(ArborStyle.shellFont(size: 11))
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                                    .truncationMode(.middle)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    .accessibilityHint("Moves the linked page into this folder")
                }
                .overlay {
                    if isLoading, directories.isEmpty {
                        ProgressView("Finding folders")
                    } else if directories.isEmpty {
                        ContentUnavailableView("No legal destinations", systemImage: "folder.badge.questionmark")
                    }
                }
            }
            .navigationTitle("Move Linked Page")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        host.resolveStructuralMoveRequest(with: nil)
                        dismiss()
                    }
                }
            }
        }
        .frame(minWidth: 440, minHeight: 420)
        .task(id: query) {
            isLoading = true
            let loaded = await host.moveDirectories(for: request.reference, matching: query)
            guard !Task.isCancelled else { return }
            directories = loaded
            isLoading = false
            searchFocused = true
        }
        .interactiveDismissDisabled()
    }
}

struct ArborAttentionBanner: View {
    let message: String
    let systemImage: String
    var tint: Color = .orange
    var primaryLabel: String?
    var primaryAction: (() -> Void)?
    var secondaryLabel: String?
    var secondaryAction: (() -> Void)?

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: systemImage)
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(tint)
            Text(message)
                .font(.system(size: 13))
                .lineLimit(2)
            Spacer(minLength: 4)
            if let secondaryLabel, let secondaryAction {
                Button(secondaryLabel, action: secondaryAction)
                    .buttonStyle(.borderless)
                    .font(.system(size: 13, weight: .medium))
            }
            if let primaryLabel, let primaryAction {
                Button(primaryLabel, action: primaryAction)
                    .buttonStyle(.borderless)
                    .font(.system(size: 13, weight: .semibold))
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(.regularMaterial, in: .rect(cornerRadius: 8))
        .overlay {
            RoundedRectangle(cornerRadius: 8)
                .stroke(Color.primary.opacity(0.08), lineWidth: 0.5)
        }
        .shadow(color: .black.opacity(0.10), radius: 6, x: 0, y: 2)
        .accessibilityElement(children: .contain)
    }
}

struct ArborDocumentFooter: View {
    let provider: String
    let sync: WorkspaceSyncPresentation
    let binding: ArborDocumentBinding?
    let backlinks: [WorkspaceSearchResult]
    let open: (WorkspaceReference) -> Void
    let showStatus: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            if !backlinks.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Linked from")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .textCase(.uppercase)
                    ForEach(backlinks) { entry in
                        Button {
                            open(entry.reference)
                        } label: {
                            HStack(spacing: 6) {
                                Image(systemName: "doc.text")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                Text(entry.title)
                                    .foregroundStyle(.primary)
                                    .lineLimit(1)
                                Spacer(minLength: 0)
                            }
                            .contentShape(.rect)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }

            Button(action: showStatus) {
                VStack(spacing: 3) {
                    Label(statusTitle, systemImage: statusSymbol)
                        .font(.caption.weight(.medium))
                        .foregroundStyle(statusTint)
                    Text(provider)
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
                .frame(maxWidth: .infinity)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .help(sync.detail ?? statusTitle)
            .accessibilityHint("Shows save and synchronization details")
        }
        .padding(.top, 24)
        .padding(.bottom, 12)
    }

    private var statusTitle: String {
        if binding?.isSaving == true { return "Saving" }
        if binding?.conflict != nil { return "Edit conflict" }
        if binding?.lastError != nil { return "Save failed" }
        return sync.state.label
    }

    private var statusSymbol: String {
        if binding?.isSaving == true { return "ellipsis.circle" }
        if binding?.conflict != nil { return "exclamationmark.triangle" }
        if binding?.lastError != nil { return "exclamationmark.circle" }
        return sync.state.symbol
    }

    private var statusTint: Color {
        if binding?.lastError != nil { return .red }
        if binding?.conflict != nil || sync.state == .conflict { return .orange }
        return .secondary
    }
}

struct ArborSyncStatusView: View {
    let provider: String
    let sync: WorkspaceSyncPresentation
    let binding: ArborDocumentBinding?
    let syncNow: () -> Void

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section("Current document") {
                    LabeledContent("Save status", value: saveStatus)
                    if let error = binding?.lastError {
                        Text("The latest edit remains in this session but has not reached durable provider storage. Retry before closing or navigating away.")
                            .font(.caption)
                            .foregroundStyle(.red)
                        Text(error.localizedDescription)
                            .font(.caption.monospaced())
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                    }
                }
                Section("Workspace") {
                    LabeledContent("Provider", value: provider)
                    LabeledContent("Synchronization", value: sync.state.label)
                    if let detail = sync.detail { Text(detail).foregroundStyle(.secondary) }
                    if sync.localAdditions { Label("Local changes are waiting to synchronize", systemImage: "arrow.up") }
                    if sync.remoteAdditions { Label("Remote changes are waiting to download", systemImage: "arrow.down") }
                    if sync.approximatePlacements > 0 {
                        Label("\(sync.approximatePlacements) change placements need review", systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.orange)
                    }
                }
                Section {
                    Button("Sync Now", systemImage: "arrow.triangle.2.circlepath", action: syncNow)
                        .disabled(sync.state == .offline)
                } footer: {
                    Text("Arbor reports accepted state and pending work here; it does not imply that an interrupted save or unresolved conflict is safe.")
                }
            }
            .formStyle(.grouped)
            .navigationTitle("Save and Sync")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
        }
        .frame(minWidth: 560, minHeight: 430)
    }

    private var saveStatus: String {
        if binding?.isSaving == true { return "Saving" }
        if binding?.conflict != nil { return "Conflict needs a choice" }
        if binding?.lastError != nil { return "Latest edit not saved" }
        return "Saved locally"
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
    @State private var pendingRecovery: WorkspaceHistoryEntry?

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
                    Button("Restore as New Change") { pendingRecovery = entry }
                        .accessibilityLabel("Restore \(entry.title)")
                        .accessibilityHint("Creates a new current revision without erasing later recovery history")
                }
            }
            .overlay {
                if entries.isEmpty {
                    ContentUnavailableView("No local recovery history", systemImage: "clock")
                }
            }
            .navigationTitle("Recover")
            .safeAreaInset(edge: .bottom) {
                Text("Recovery creates a new local change. It does not rewind shared server history.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding()
                    .background(.bar)
            }
            .confirmationDialog(
                "Restore this revision as a new change?",
                isPresented: Binding(
                    get: { pendingRecovery != nil },
                    set: { if !$0 { pendingRecovery = nil } }
                ),
                titleVisibility: .visible
            ) {
                Button("Restore as New Change") {
                    guard let entry = pendingRecovery else { return }
                    pendingRecovery = nil
                    recover(entry.revision)
                }
                Button("Cancel", role: .cancel) { pendingRecovery = nil }
            }
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
                    LabeledContent("Server draft", value: conflict.draft)
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
                    Text("Arbor has kept both the local candidate and the server's remote/draft evidence. Continuing keeps the local tree as a new intent based on the current remote root.")
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
        case .openLocation: "Open Location"
        default: "Action"
        }
    }

    private var prompt: String {
        switch mode {
        case .openLocation: "Location path"
        default: "Name"
        }
    }

    private var actionTitle: String {
        switch mode {
        case .openLocation: "Open"
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
