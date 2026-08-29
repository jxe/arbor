import ArborKit
import ArborQuagmire
import ArborSync
import ArborWire
import Quagmire
import QuagmireExtras
import SwiftUI
import UniformTypeIdentifiers
#if os(macOS)
import AppKit
import CoreImage
import CoreImage.CIFilterBuiltins
#endif
#if os(iOS)
import UIKit
import VisionKit
#endif

/// Keep the focused editor-command dependency at the toolbar leaf. Reading it
/// from `ArborRootView` makes every focus-preference update invalidate the
/// entire navigation hierarchy, which can form an iOS render loop before the
/// launch screen is replaced.
private struct ArborVoiceRecordingToolbarButton: View {
    let session: VoiceRecordingSession<String>
    let model: ArborAppModel
    let workspace: ArborWorkspaceState
    @FocusedValue(\.editorCommands) private var editorCommands

    var body: some View {
        VoiceRecordingButton(session: session) {
            await startRecording()
        }
    }

    /// Editing at the moment recording starts takes precedence over the page's
    /// ordinary voice destination. Capture both the command bridge and block id
    /// now so delayed transcription cannot drift into a different row.
    private func startRecording() async {
        let commands = editorCommands
        let target = commands?.activeEditingBlock()
        var inlineDelivery: VoiceTranscriptDelivery<String>?
        if let target {
            inlineDelivery = { transcript, destination in
                if commands?.insertText(transcript, target) == true { return }
                try await workspace.deliverVoiceTranscript(transcript, to: destination)
            }
        }
        await model.startVoiceRecording(session, delivery: inlineDelivery)
    }
}

struct ArborRootView: View {
    let workspace: ArborWorkspaceState
    let onDisconnect: @MainActor () -> Void
    @State private var model: ArborAppModel
    @State private var recordingSession: VoiceRecordingSession<String>
    @State private var pinchDictation: EditorPinchDictation
    @State private var accountPresented = false
    @State private var pairingPresented = false
    @State private var presentedSheet: ArborPresentedSheet?
    @State private var searchPresented = false
    @State private var searchText = ""
    @State private var workspaceImporterPresented = false
    @State private var trashConfirmationPresented = false
    @State private var arborsyncLogs = ""
    @State private var voiceLaunchReady = false
#if os(iOS)
    @State private var sidebarPresented = false
#endif
    @Environment(\.scenePhase) private var scenePhase

    init(
        workspace: ArborWorkspaceState,
        onDisconnect: @escaping @MainActor () -> Void = {}
    ) {
        self.workspace = workspace
        self.onDisconnect = onDisconnect
        let model = ArborAppModel(workspace: workspace)
        let recordingSession = VoiceRecordingSession(
            recoveryStore: PendingVoiceRecordingStore(
                directoryURL: ArborSupportDirectories.pendingVoiceRecordings
            ),
            loggingSubsystem: "org.nxhx.Arbor",
            recoveryDelivery: { transcript, pageID in
                try await workspace.deliverVoiceTranscript(transcript, to: pageID)
            }
        )
        _model = State(initialValue: model)
        _recordingSession = State(initialValue: recordingSession)
        _pinchDictation = State(initialValue: EditorPinchDictation(
            beginWithDrafts: { [weak model, weak recordingSession] onDraft in
                guard let model, let recordingSession else { return false }
                return await model.startPinchVoiceRecording(
                    recordingSession,
                    onDraft: onDraft
                )
            },
            finish: { [weak recordingSession] in
                guard let recordingSession else { return .failed }
                return switch await recordingSession.stopAndReturnTranscript() {
                case .transcript(let text): EditorPinchDictation.Completion.transcript(text)
                case .noSpeech: EditorPinchDictation.Completion.noSpeech
                case .failed: EditorPinchDictation.Completion.failed
                }
            },
            cancel: { [weak recordingSession] in
                recordingSession?.cancel()
            }
        ))
    }

    var body: some View {
        platformNavigation
        .task(id: workspace.generation) { await model.resetForWorkspace() }
        .task(id: workspace.latestStructuralReceipt?.id) {
            guard let receipt = workspace.latestStructuralReceipt else { return }
            await model.reconcile(receipt)
        }
        .task(id: model.binding?.acceptedTitle) {
            guard model.binding != nil else { return }
            try? await Task.sleep(for: .seconds(2))
            guard !Task.isCancelled else { return }
            await model.evaluateTitleRenameProposal()
        }
        .task {
#if os(macOS)
            // The hosted test app must not restore a real user bookmark: tests open
            // their own temporary workspace and own that helper's full lifetime.
            if ProcessInfo.processInfo.environment["ARBOR_TEST_BUNDLED_HELPER"] != "1" {
                await workspace.restoreLocalWorkspaceIfAvailable()
            }
#endif
            voiceLaunchReady = true
            forwardPendingVoiceRecording()
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active {
                forwardPendingVoiceRecording()
#if os(macOS)
                Task { await workspace.refreshLocalArborSyncOverview() }
#endif
            } else {
                Task { await workspace.flush() }
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: VoiceRecordingLaunchRequest.notificationName)) { _ in
            forwardPendingVoiceRecording()
        }
        .alert("Recording", isPresented: recordingErrorBinding) {
            Button("OK") { recordingSession.errorMessage = nil }
        } message: {
            Text(recordingSession.errorMessage ?? "")
        }
        .alert("Recover Recording?", isPresented: recordingRecoveryBinding) {
            Button("Transcribe and Add") {
                Task { await recordingSession.recoverPendingRecording() }
            }
            Button("Later", role: .cancel) { recordingSession.deferPendingRecovery() }
        } message: {
            Text(recordingRecoveryMessage)
        }
        .sheet(isPresented: $accountPresented) {
#if os(macOS)
            MacArborSyncAccountPanel(workspace: workspace, currentNode: model.node)
#else
            IOSAccountPanel(workspace: workspace, onDisconnect: onDisconnect)
#endif
        }
#if os(macOS)
        .sheet(isPresented: $pairingPresented) {
            MacPairingPanel(workspace: workspace)
        }
#endif
        .sheet(isPresented: $searchPresented, onDismiss: {
            searchText = ""
            Task { await model.search("") }
        }) {
            ArborSearchPalette(
                query: $searchText,
                results: model.searchResults,
                search: { await model.search($0) },
                open: { reference in Task { await model.navigate(to: reference) } }
            )
        }
        .sheet(item: $presentedSheet, content: sheet)
        .sheet(item: moveRequestBinding) { request in
            if let host = model.editorHost {
                ArborMoveDestinationSheet(host: host, request: request)
            }
        }
        .sheet(item: structuralMoveRequestBinding) { request in
            if let host = model.editorHost {
                ArborStructuralMoveSheet(host: host, request: request)
            }
        }
        .confirmationDialog("Move this node to Trash?", isPresented: $trashConfirmationPresented) {
            Button("Move to Trash", role: .destructive) {
                Task { await model.perform(.trash(reference: model.currentReference)) }
            }
            Button("Cancel", role: .cancel) {}
        }
        .confirmationDialog(
            "Move linked page to Trash?",
            isPresented: linkedPageTrashPromptPresented,
            titleVisibility: .visible
        ) {
            if model.linkedPageTrashPrompt != nil {
                Button("Move to Trash", role: .destructive) {
                    Task { await model.trashPromptedLinkedPageIfStillOrphaned() }
                }
            }
            Button("Keep Page", role: .cancel) {
                model.dismissLinkedPageTrashPrompt()
            }
        } message: {
            if let prompt = model.linkedPageTrashPrompt {
                Text("\"\(prompt.title)\" no longer has any links pointing to it.")
            }
        }
#if os(macOS)
        .fileImporter(isPresented: $workspaceImporterPresented, allowedContentTypes: [.folder]) { result in
            if case let .success(url) = result {
                Task {
                    do { try await workspace.openLocalWorkspace(url) }
                    catch { workspace.errorMessage = error.localizedDescription }
                }
            }
        }
#endif
        .focusedSceneValue(\.arborWindowCommands, windowCommands)
    }

    @ViewBuilder
    private var platformNavigation: some View {
#if os(iOS)
        NavigationStack(path: navigationPathBinding) {
            pageFrame(for: model.navigationRoot)
                .navigationDestination(for: WorkspaceLocation.self) { location in
                    pageFrame(for: location)
                }
        }
        .id(model.selectedTabID)
        .sheet(isPresented: $sidebarPresented) {
            NavigationStack {
                sidebarContent
                    .navigationTitle("Pages")
                    .toolbar {
                        ToolbarItem(placement: .confirmationAction) {
                            Button("Done") { sidebarPresented = false }
                        }
                    }
            }
        }
#else
        NavigationSplitView {
            sidebarContent
        } detail: {
            NavigationStack(path: navigationPathBinding) {
                pageFrame(for: model.navigationRoot)
                    .navigationDestination(for: WorkspaceLocation.self) { location in
                        pageFrame(for: location)
                    }
            }
            .id(model.selectedTabID)
        }
#endif
    }

    private var sidebarContent: some View {
        List {
#if os(macOS)
            localTreesSections
#endif
            Button {
                searchPresented = true
            } label: {
                HStack {
                    Label("Search", systemImage: "magnifyingglass")
                    Spacer()
                }
            }
            .buttonStyle(.plain)

            Section {
                if let parent = model.sidebarLocation.parent {
                    Button {
                        openFromSidebar(parent)
                    } label: {
                        Label("Parent directory", systemImage: "arrow.up")
                            .foregroundStyle(.secondary)
                    }
                    .buttonStyle(.plain)
                }
                ForEach(model.children) { node in
                    ArborSidebarRow(
                        node: node,
                        isCurrent: isCurrent(node.location),
                        open: { openFromSidebar(node.location) },
                        openInNewTab: { Task { await model.openInNewTab(node.location) } },
                        trash: { Task { await model.perform(.trash(reference: node.reference), navigateToResult: false) } }
                    )
                }
            } header: {
                Text(model.sidebarLocation.path == "/" ? "Home" : model.sidebarLocation.path)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
        }
        .listStyle(.sidebar)
        .navigationTitle("Arbor")
        .overlay {
            if model.children.isEmpty {
                ContentUnavailableView("No children", systemImage: "tree")
                    .allowsHitTesting(false)
            }
        }
    }

#if os(macOS)
    @ViewBuilder
    private var localTreesSections: some View {
        let overview = workspace.localArborSyncOverview
        let visits = recentUnplacedVisits
        if let placed = overview?.trees.filter({ $0.path != nil }), !placed.isEmpty {
            Section("On This Mac") {
                ForEach(placed) { tree in
                    if let path = tree.path {
                        Button {
                            openFromSidebar(.local(path))
                        } label: {
                            Label(tree.canonicalPath ?? tree.name, systemImage: "externaldrive")
                                .lineLimit(1)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
        if !visits.isEmpty {
            Section("Recently Visited") {
                ForEach(visits) { visit in
                    Button {
                        openFromSidebar(.remote(
                            locator: visit.canonical ?? visit.locator,
                            rootLocator: visit.canonical ?? visit.locator
                        ))
                    } label: {
                        Label(visit.name, systemImage: "network")
                            .lineLimit(1)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    private var recentUnplacedVisits: [LocalArborSyncVisitPresentation] {
        guard let overview = workspace.localArborSyncOverview else { return [] }
        let placedTreeIDs = Set(overview.trees.compactMap { $0.path == nil ? nil : $0.id })
        var seen = Set<String>()
        return overview.visits.filter { visit in
            !placedTreeIDs.contains(visit.tree) && seen.insert(visit.tree).inserted
        }
    }
#endif

    private var recordingErrorBinding: Binding<Bool> {
        Binding(
            get: { recordingSession.errorMessage != nil },
            set: { if !$0 { recordingSession.errorMessage = nil } }
        )
    }

    private var recordingRecoveryBinding: Binding<Bool> {
        Binding(
            get: {
                recordingSession.pendingRecovery != nil
                    && recordingSession.errorMessage == nil
            },
            set: { _ in }
        )
    }

    private var recordingRecoveryMessage: String {
        guard let recording = recordingSession.pendingRecovery else { return "" }
        let date = recording.createdAt.formatted(date: .abbreviated, time: .shortened)
        return "Arbor preserved an unfinished recording from \(date). It will be transcribed and added to its original page."
    }

    private func forwardPendingVoiceRecording() {
        guard voiceLaunchReady else { return }
        guard VoiceRecordingLaunchRequest.consumePendingStart() else { return }
        Task { @MainActor in
            await model.toggleVoiceRecordingFromShortcut(recordingSession)
        }
    }

    private func isCurrent(_ location: WorkspaceLocation) -> Bool {
        location == model.currentLocation
    }

    private func openFromSidebar(_ location: WorkspaceLocation) {
#if os(iOS)
        sidebarPresented = false
#endif
        Task { await model.navigate(to: location) }
    }

    private var moveRequestBinding: Binding<ArborMoveRequest?> {
        Binding(
            get: { model.editorHost?.moveRequest },
            set: { request in
                if request == nil { model.editorHost?.resolveMoveRequest(with: nil) }
            }
        )
    }

    private var structuralMoveRequestBinding: Binding<ArborStructuralMoveRequest?> {
        Binding(
            get: { model.editorHost?.structuralMoveRequest },
            set: { request in
                if request == nil { model.editorHost?.resolveStructuralMoveRequest(with: nil) }
            }
        )
    }

    private var linkedPageTrashPromptPresented: Binding<Bool> {
        Binding(
            get: { model.linkedPageTrashPrompt != nil },
            set: { if !$0 { model.dismissLinkedPageTrashPrompt() } }
        )
    }

    private var windowCommands: ArborWindowCommands {
        ArborWindowCommands(
            goHome: { Task { await model.goHome() } },
            goBack: { Task { await model.goBack() } },
            goForward: { Task { await model.goForward() } },
            goParent: { Task { await model.goParent() } },
            newTab: { Task { await model.newTab() } },
            closeTab: { Task { await model.closeSelectedTab() } },
            newDocument: { presentedSheet = .createMarkdown },
            newFolder: { presentedSheet = .createDirectory },
            openLocation: { presentedSheet = .openLocation },
            openLocalWorkspace: { workspaceImporterPresented = true },
            showHistory: { Task { await model.loadHistory(); presentedSheet = .history } },
            showBacklinks: { presentedSheet = .backlinks },
            showSource: { Task { await model.inspectSource(); presentedSheet = .source } },
            showSyncStatus: { presentedSheet = .syncStatus },
            showPairing: { pairingPresented = true },
            movePageToTrash: { trashConfirmationPresented = true },
            restorePage: {
                Task { await model.perform(.restore(reference: model.currentReference)) }
            },
            reconnectArborSync: {
#if os(macOS)
                Task { await workspace.restartArborSync() }
#endif
            },
            showArborSyncLogs: {
#if os(macOS)
                Task {
                    arborsyncLogs = await workspace.arborsyncLogs()
                    presentedSheet = .arborsyncLogs
                }
#endif
            },
            canGoBack: model.canGoBack,
            canGoForward: model.canGoForward,
            canGoParent: model.canGoParent,
            canGoHome: model.canGoHome,
            canCloseTab: model.tabItems.count > 1,
            hasDocument: model.binding != nil,
            hasNode: model.node != nil,
            canMovePageToTrash: model.node?.isWritable == true
                && model.currentReference.path != "/"
                && !model.currentReference.path.hasPrefix("/Trash/"),
            canRestorePage: model.node?.isWritable == true
                && model.currentReference.path.hasPrefix("/Trash/")
        )
    }

    private var navigationPathBinding: Binding<[WorkspaceLocation]> {
        Binding(
            get: { model.navigationPath },
            set: { model.setNavigationPath($0) }
        )
    }

    @ViewBuilder
    private func pageFrame(for location: WorkspaceLocation) -> some View {
        VStack(spacing: 0) {
            if model.tabItems.count > 1 {
                ArborTabStrip(
                    tabs: model.tabItems,
                    selected: model.selectedTabID,
                    title: { tab in tab.current.path == "/" ? "Home" : tab.current.path.split(separator: "/").last.map(String.init) ?? "Arbor" },
                    select: { id in Task { await model.selectTab(id) } },
                    close: { Task { await model.closeSelectedTab() } },
                    create: { Task { await model.newTab() } }
                )
            }
            pageFrameContent(for: location)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .overlay(alignment: .top) {
            if location == model.currentLocation {
                attentionBanner
                    .padding(.horizontal, 16)
                    .frame(maxWidth: 560)
                    .padding(.top, 8)
            }
        }
        .animation(.easeInOut(duration: 0.2), value: model.binding?.conflict != nil)
        .animation(.easeInOut(duration: 0.2), value: workspace.syncConflict != nil)
        .toolbar {
#if os(iOS)
            ToolbarItem(placement: .topBarLeading) {
                ArborPagesButton { sidebarPresented = true }
            }
#endif
            ToolbarItemGroup(placement: .primaryAction) {
#if os(iOS)
                ArborEditorUndoButtons()
#endif
                if location == model.currentLocation,
                   model.node?.isWritable == true,
                   model.binding != nil {
                    ArborVoiceRecordingToolbarButton(
                        session: recordingSession,
                        model: model,
                        workspace: workspace
                    )
                }
                Button("Account", systemImage: "person.crop.circle") {
                    accountPresented = true
#if os(macOS)
                    Task { await workspace.refreshLocalArborSyncOverview() }
#endif
                }
            }
        }
    }

    @ViewBuilder
    private func pageFrameContent(for location: WorkspaceLocation) -> some View {
        if location != model.currentLocation || model.isLoading {
            ProgressView()
        } else if let node = model.node {
            if node.surface.supportsDocumentSession, node.isWritable {
                if let lease = model.editorLease, let host = model.editorHost {
                    ArborEditorSurface(
                        binding: lease.binding,
                        host: host,
                        configuration: ArborStyle.editorConfiguration,
                        pinchDictation: pinchDictation
                    ) {
                        ArborDocumentFooter(
                            provider: workspace.providerDetail,
                            sync: workspace.syncPresentation,
                            binding: lease.binding,
                            backlinks: model.backlinks,
                            open: { destination in Task { await model.navigate(to: destination) } },
                            showStatus: { presentedSheet = .syncStatus }
                        )
                    }
                } else {
                    ProgressView()
                }
            } else {
                WorkspaceSurfaceView(node: node)
            }
        } else if let message = model.errorMessage {
            ContentUnavailableView("Unable to open", systemImage: "exclamationmark.triangle", description: Text(message))
        } else {
            ProgressView()
        }
    }

    @ViewBuilder
    private func sheet(_ sheet: ArborPresentedSheet) -> some View {
        switch sheet {
        case .source:
            if let node = model.node { ArborSourceInspector(node: node, snapshot: model.sourceSnapshot) }
        case .history:
            ArborHistoryView(entries: model.history) { revision in
                Task {
                    if await model.recover(revision) { presentedSheet = nil }
                }
            }
        case .backlinks:
            ArborBacklinksView(entries: model.backlinks) { reference in
                presentedSheet = nil
                Task { await model.navigate(to: reference) }
            }
        case .arborsyncLogs:
            NavigationStack {
                ScrollView { Text(arborsyncLogs).font(.body.monospaced()).textSelection(.enabled).padding() }
                    .navigationTitle("arborsync Logs")
            }
            .frame(minWidth: 560, minHeight: 420)
        case .syncConflict:
            if let conflict = workspace.syncConflict {
                ArborSyncConflictView(conflict: conflict) {
                    presentedSheet = nil
                    Task { await workspace.resolveSyncConflictKeepingLocal() }
                }
            }
        case .syncStatus:
            ArborSyncStatusView(
                provider: workspace.providerDetail,
                sync: workspace.syncPresentation,
                binding: model.binding,
                arborsyncProcessKind: workspace.arborsyncProcessKind,
                retrySave: { Task { await model.retryDocumentSave() } },
                syncNow: { Task { await workspace.syncNow() } }
            )
        default:
            ArborMutationForm(mode: sheet, submit: submitMutation)
        }
    }

    private func submitMutation(_ value: String, source: String) {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        switch presentedSheet {
        case .createMarkdown:
            Task { await model.perform(.createMarkdown(parent: mutationParent, name: trimmed, source: source.isEmpty ? "# \(trimmed)\n" : source)) }
        case .createDirectory:
            Task { await model.perform(.createDirectory(parent: mutationParent, name: trimmed)) }
        case .openLocation:
            Task { await model.navigate(to: destination(trimmed)) }
        default:
            break
        }
    }

    private var mutationParent: WorkspaceReference {
        guard let node = model.node else { return model.currentReference }
        switch node.surface {
        case .directory, .directoryDocument, .collection: return node.reference
        default: return node.reference.parent ?? workspace.home
        }
    }

    private func destination(_ value: String) -> WorkspaceLocation {
#if os(macOS)
        if let url = URL(string: value), ["http", "https", "arbor"].contains(url.scheme?.lowercased() ?? "") {
            return .remote(locator: url.absoluteString, rootLocator: url.absoluteString)
        }
        let expanded: String
        if value == "~" {
            expanded = FileManager.default.homeDirectoryForCurrentUser.path
        } else if value.hasPrefix("~/") {
            expanded = FileManager.default.homeDirectoryForCurrentUser.appending(path: String(value.dropFirst(2))).path
        } else if value.hasPrefix("/") {
            expanded = value
        } else {
            let base: String = switch model.currentLocation {
            case let .localPath(path):
                switch model.node?.surface {
                case .directory, .directoryDocument, .collection:
                    path
                default:
                    URL(fileURLWithPath: path).deletingLastPathComponent().path
                }
            default: workspace.launchLocation.path
            }
            expanded = URL(fileURLWithPath: base).appending(path: value).path
        }
        return .local(expanded)
#else
        return .reference(WorkspaceReference(
            tree: model.currentReference.tree,
            path: value.hasPrefix("/") ? value : "/\(value)"
        ))
#endif
    }

    @ViewBuilder
    private var attentionBanner: some View {
        if let conflict = model.binding?.conflict {
            ArborAttentionBanner(
                message: "This document changed outside the current edit session.",
                systemImage: "exclamationmark.triangle",
                primaryLabel: "Keep My Edit",
                primaryAction: { Task { await model.resolveEditorConflict(preferSubmitted: true) } },
                secondaryLabel: "Use Current",
                secondaryAction: { Task { await model.resolveEditorConflict(preferSubmitted: false) } }
            )
            .help("Current revision: \(conflict.current.contentRevision)")
        } else if workspace.syncConflict != nil {
            ArborAttentionBanner(
                message: "Synchronization needs a conflict choice.",
                systemImage: "arrow.triangle.branch",
                primaryLabel: "Review…",
                primaryAction: { presentedSheet = .syncConflict }
            )
        } else if let proposal = model.titleRenameProposal {
            ArborAttentionBanner(
                message: "Rename this page to \"\(proposal.proposedName)\" to match its title?",
                systemImage: "pencil",
                primaryLabel: "Rename",
                primaryAction: { Task { await model.acceptTitleRenameProposal() } },
                secondaryLabel: "Not Now",
                secondaryAction: { model.dismissTitleRenameProposal() }
            )
        } else if let diagnostic = ArborSaveDiagnostic.describe(
            model.binding?.lastError,
            processKind: workspace.arborsyncProcessKind
        ) {
            ArborAttentionBanner(
                message: diagnostic.bannerMessage,
                systemImage: "exclamationmark.circle",
                tint: .red,
                primaryLabel: "Retry",
                primaryAction: { Task { await model.retryDocumentSave() } },
                secondaryLabel: "Details…",
                secondaryAction: { presentedSheet = .syncStatus }
            )
            .help(diagnostic.help)
        } else if let message = model.errorMessage {
            ArborAttentionBanner(
                message: message,
                systemImage: "exclamationmark.circle",
                tint: .red,
                primaryLabel: "Dismiss",
                primaryAction: { model.dismissError() }
            )
        } else if let message = workspace.errorMessage {
            ArborAttentionBanner(
                message: message,
                systemImage: "exclamationmark.circle",
                tint: .red,
                primaryLabel: "Dismiss",
                primaryAction: { workspace.errorMessage = nil }
            )
        }
    }
}

#if os(iOS)
private struct ArborPagesButton: View {
    let openPages: () -> Void

    var body: some View {
        Button("Pages", systemImage: "line.3.horizontal") {
            openPages()
        }
    }
}

private struct ArborEditorUndoButtons: View {
    @FocusedValue(\.documentUndoController) private var undoController
    @State private var undoRevision = 0

    var body: some View {
        Group {
            Button("Undo", systemImage: "arrow.uturn.backward") {
                undoController?.undo()
            }
            .disabled(!canUndo)

            if canRedo {
                Button("Redo", systemImage: "arrow.uturn.forward") {
                    undoController?.redo()
                }
            }
        }
        // Keep the focus lookup below the root view: reading a scene-focused value
        // from the view that also owns the editor creates a SwiftUI focus cycle.
        .onReceive(NotificationCenter.default.publisher(for: .NSUndoManagerCheckpoint)) {
            refreshIfCurrentUndoManager($0)
        }
        .onReceive(NotificationCenter.default.publisher(for: .NSUndoManagerDidUndoChange)) {
            refreshIfCurrentUndoManager($0)
        }
        .onReceive(NotificationCenter.default.publisher(for: .NSUndoManagerDidRedoChange)) {
            refreshIfCurrentUndoManager($0)
        }
    }

    private var canUndo: Bool {
        _ = undoRevision
        return undoController?.canUndo == true
    }

    private var canRedo: Bool {
        _ = undoRevision
        // UndoManager.canRedo posts a checkpoint notification. Reading it while
        // handling that notification creates an endless render/notification loop.
        return (undoController?.undoManager.redoCount ?? 0) > 0
    }

    private func refreshIfCurrentUndoManager(_ notification: Notification) {
        guard let manager = notification.object as? UndoManager,
              manager === undoController?.undoManager else { return }
        undoRevision &+= 1
    }
}
#endif

#if os(macOS)
private struct MacArborSyncAccountPanel: View {
    @Environment(\.dismiss) private var dismiss
    let workspace: ArborWorkspaceState
    let currentNode: WorkspaceNode?
    @State private var pairing: LocalArborSyncPairingPresentation?
    @State private var message: String?

    private var account: LocalArborSyncOverview? { workspace.localArborSyncOverview }
    private var currentTreeID: String? {
        guard let currentNode, currentNode.reference.tree.rawValue != "local" else { return nil }
        if case .localPath = currentNode.location {
            return account?.trees.first {
                $0.id == currentNode.reference.tree.rawValue && $0.path != nil
            }?.id
        }
        return currentNode.reference.tree.rawValue
    }
    private var currentTree: LocalArborSyncTreePresentation? {
        guard let currentTreeID else { return nil }
        return account?.trees.first { $0.id == currentTreeID }
    }
    private var ordinaryTrees: [LocalArborSyncTreePresentation] {
        account?.trees.filter { !($0.canonicalPath ?? "").contains("/railway-smoke-") } ?? []
    }
    private var testTrees: [LocalArborSyncTreePresentation] {
        account?.trees.filter { ($0.canonicalPath ?? "").contains("/railway-smoke-") } ?? []
    }
    private var activeDevices: [LocalArborSyncDevicePresentation] { account?.devices ?? [] }

    var body: some View {
        NavigationStack {
            Form {
                if let account {
                    Section("Account") {
                        if let handle = account.handle, let origin = account.origin {
                            LabeledContent("Signed in as", value: "~\(handle)")
                            LabeledContent("Server", value: origin)
                            LabeledContent("Mac credential", value: account.credentialAvailable ? "Connected" : "Missing")
                        } else {
                            LabeledContent("Community", value: "Not connected")
                            Text("Connect this Mac with `arbor connect` to manage server trees, devices, and iPhone pairing.")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    Section("Location") {
                        LabeledContent("Data home", value: "~/.arbor")
                        if let currentTree {
                            treeLabel(currentTree, current: true)
                        } else if let currentTreeID {
                            LabeledContent("Current tree", value: currentTreeID)
                                .font(.caption.monospaced())
                        } else {
                            LabeledContent("Current tree", value: "Ordinary filesystem")
                        }
                    }
                    if !ordinaryTrees.isEmpty || !testTrees.isEmpty {
                        Section {
                            ForEach(ordinaryTrees) { tree in
                                treeLabel(tree, current: tree.id == currentTreeID)
                            }
                            if !testTrees.isEmpty {
                                DisclosureGroup("Test trees (\(testTrees.count))") {
                                    ForEach(testTrees) { tree in
                                        treeLabel(tree, current: false)
                                    }
                                }
                            }
                        } header: {
                            Text("Server trees")
                        } footer: {
                            Text("These are roots the account can access, not folders in the current sidebar.")
                        }
                    }
                    if account.handle != nil {
                        Section {
                            ForEach(activeDevices, id: \.id) { device in
                                HStack {
                                    VStack(alignment: .leading) {
                                        Text(device.label)
                                        Text([
                                            device.isCurrent ? "This Mac" : nil,
                                            device.isAdministrator ? "Administrator" : "Active device",
                                        ].compactMap { $0 }.joined(separator: " · "))
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                    }
                                    Spacer()
                                    Button("Revoke", role: .destructive) {
                                        Task { await revoke(device.id) }
                                    }
                                    .disabled(device.isAdministrator && activeDevices.filter(\.isAdministrator).count == 1)
                                }
                            }
                        } header: {
                            Text("Devices")
                        } footer: {
                            Text("Each active device has its own server credential. Revoking one does not delete any tree data.")
                        }
                        Section("Pair iPhone") {
                            Button("Pair another iPhone…") { Task { await createPairing() } }
                            if let pairing {
                                PairingQRCode(payload: pairing.payload)
                                    .frame(width: 220, height: 220)
                                    .frame(maxWidth: .infinity)
                                LabeledContent("Confirm on both devices", value: pairing.confirmationCode)
                                    .font(.headline.monospacedDigit())
                                Button("Copy pairing code", systemImage: "doc.on.doc") {
                                    NSPasteboard.general.clearContents()
                                    NSPasteboard.general.setString(pairing.payload, forType: .string)
                                }
                            }
                        }
                    }
                } else {
                    if let error = workspace.localArborSyncOverviewError {
                        Section {
                            Text(error).foregroundStyle(.red)
                            Button("Try Again") { Task { await refresh() } }
                        }
                    } else {
                        Section { ProgressView("Loading account…") }
                    }
                }
                if account != nil, let error = workspace.localArborSyncOverviewError {
                    Section {
                        Label("Could not refresh: \(error)", systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.orange)
                        Button("Try Again") { Task { await refresh() } }
                    }
                }
                if let message { Section { Text(message).foregroundStyle(.secondary) } }
            }
            .navigationTitle("Arbor account")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
        .frame(minWidth: 520, minHeight: 520)
        .formStyle(.grouped)
        .task { await refresh() }
    }

    private func treeLabel(_ tree: LocalArborSyncTreePresentation, current: Bool) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 3) {
                Text(tree.canonicalPath ?? tree.name)
                Text([tree.access?.capitalized, tree.sync?.capitalized].compactMap { $0 }.joined(separator: " · "))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            if current {
                Text("Current")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func refresh() async {
        if workspace.localArborSyncOverview == nil {
            await workspace.restartArborSync()
        }
        await workspace.refreshLocalArborSyncOverview()
    }

    private func createPairing() async {
        do { pairing = try await workspace.createLocalArborSyncPairing(); message = nil }
        catch { message = error.localizedDescription }
    }

    private func revoke(_ id: String) async {
        do { try await workspace.revokeLocalArborSyncDevice(id) }
        catch { message = error.localizedDescription }
    }
}

private struct MacPairingPanel: View {
    @Environment(\.dismiss) private var dismiss
    let workspace: ArborWorkspaceState
    @State private var pairing: LocalArborSyncPairingPresentation?
    @State private var message: String?

    var body: some View {
        NavigationStack {
            VStack(spacing: 18) {
                if let pairing {
                    PairingQRCode(payload: pairing.payload)
                        .frame(width: 300, height: 300)
                    Text("Scan with Arbor on your iPhone")
                        .font(.title2.weight(.semibold))
                    LabeledContent("Confirm on both devices", value: pairing.confirmationCode)
                        .font(.headline.monospacedDigit())
                        .frame(maxWidth: 320)
                    Button("Copy pairing code", systemImage: "doc.on.doc") {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(pairing.payload, forType: .string)
                    }
                } else if let message {
                    ContentUnavailableView(
                        "Unable to create pairing",
                        systemImage: "exclamationmark.triangle",
                        description: Text(message)
                    )
                    Button("Try Again") { Task { await createPairing() } }
                } else {
                    ProgressView("Creating one-time pairing…")
                }
            }
            .padding(32)
            .frame(minWidth: 440, minHeight: 520)
            .navigationTitle("Pair iPhone")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .task { await createPairing() }
    }

    private func createPairing() async {
        do {
            pairing = try await workspace.createLocalArborSyncPairing()
            message = nil
        } catch {
            pairing = nil
            message = error.localizedDescription
        }
    }
}

private struct PairingQRCode: View {
    let payload: String

    var body: some View {
        if let image = Self.image(payload) {
            Image(decorative: image, scale: 1)
                .interpolation(.none)
                .resizable()
                .scaledToFit()
                .padding(14)
                .background(.white, in: RoundedRectangle(cornerRadius: 16))
                .accessibilityLabel("One-time iPhone pairing code")
        } else {
            ContentUnavailableView("QR code unavailable", systemImage: "qrcode")
        }
    }

    private static func image(_ payload: String) -> CGImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(payload.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage else { return nil }
        return CIContext().createCGImage(output, from: output.extent)
    }
}
#endif

#if os(iOS)
struct ArborIOSLaunchView: View {
    private enum Phase: Equatable {
        case restoring
        case scanning
        case claiming
        case choosing
        case syncing
    }

    let workspace: ArborWorkspaceState
    @State private var phase: Phase = .restoring
    @State private var ready = false
    @State private var started = false
    @State private var scanError: String?
    @State private var treeError: String?
    @State private var confirmationCode: String?
    @State private var origin: URL?
    @State private var service: NativeAccountService?
    @State private var trees: [WireTreeDescriptor] = []
    @State private var syncingTree: WireTreeDescriptor?

    var body: some View {
        Group {
            if ready {
                ArborRootView(workspace: workspace) {
                    resetForPairing()
                }
            } else {
                onboarding
            }
        }
        .task {
            guard !started else { return }
            started = true
            if await workspace.restoreNativePlacementIfAvailable() {
                ready = true
            } else {
                workspace.errorMessage = nil
                phase = .scanning
            }
        }
    }

    @ViewBuilder
    private var onboarding: some View {
        switch phase {
        case .restoring:
            ProgressView("Opening Arbor…")
        case .scanning:
            scanner
        case .claiming:
            ProgressView("Pairing with your Mac…")
        case .choosing:
            folderChooser
        case .syncing:
            VStack(spacing: 16) {
                ProgressView()
                Text("Syncing \(syncingTree?.canonicalPath ?? "folder")…")
                    .font(.headline)
                Text("Arbor will open it as soon as the local replica is ready.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
            .padding()
        }
    }

    @ViewBuilder
    private var scanner: some View {
        if DataScannerViewController.isSupported, DataScannerViewController.isAvailable {
            PairingQRScanner { payload in
                guard phase == .scanning else { return }
                phase = .claiming
                Task { await claim(payload) }
            }
            .ignoresSafeArea()
            .safeAreaInset(edge: .top) {
                VStack(spacing: 5) {
                    Text("Scan Arbor on your Mac")
                        .font(.headline)
                    Text("On the Mac, choose Pair iPhone.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity)
                .padding()
                .background(.regularMaterial)
            }
            .safeAreaInset(edge: .bottom) {
                if let scanError {
                    Text(scanError)
                        .font(.footnote)
                        .foregroundStyle(.red)
                        .multilineTextAlignment(.center)
                        .padding()
                        .frame(maxWidth: .infinity)
                        .background(.regularMaterial)
                }
            }
        } else {
            ContentUnavailableView(
                "QR scanning unavailable",
                systemImage: "qrcode.viewfinder",
                description: Text("This iPhone cannot start the camera scanner.")
            )
        }
    }

    private var folderChooser: some View {
        NavigationStack {
            List {
                if let confirmationCode {
                    Section("Pairing") {
                        LabeledContent("Confirm on your Mac", value: confirmationCode)
                            .font(.headline.monospacedDigit())
                    }
                }
                Section("Choose a folder") {
                    ForEach(trees, id: \.id) { tree in
                        Button {
                            Task { await place(tree) }
                        } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(tree.canonicalPath ?? tree.id)
                                    Text(tree.access == "write" ? "Ready to sync" : "Read only")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                                Spacer()
                                Image(systemName: "arrow.down.circle")
                            }
                        }
                        .disabled(tree.access != "write")
                    }
                    if trees.isEmpty, treeError == nil {
                        ProgressView("Loading folders…")
                    }
                }
                if let treeError {
                    Section {
                        Text(treeError).foregroundStyle(.red)
                        Button("Try Again") { Task { await loadTrees() } }
                    }
                }
            }
            .navigationTitle("Choose a folder")
        }
    }

    private func claim(_ raw: String) async {
        do {
            let payload = try JSONDecoder().decode(PairingPayload.self, from: Data(raw.utf8)).validated()
            let service = NativeAccountService(origin: payload.origin)
            let label = UIDevice.current.name.isEmpty ? "iPhone" : UIDevice.current.name
            let claim = try await service.claim(payload, label: label)
            self.service = service
            origin = payload.origin
            confirmationCode = claim.confirmationCode
            scanError = nil
            phase = .choosing
            await loadTrees()
        } catch {
            scanError = String(describing: error)
            phase = .scanning
        }
    }

    private func loadTrees() async {
        guard let service else { return }
        treeError = nil
        do {
            trees = try await service.trees().snapshot.sorted {
                ($0.canonicalPath ?? $0.id) < ($1.canonicalPath ?? $1.id)
            }
        } catch {
            treeError = String(describing: error)
        }
    }

    private func place(_ tree: WireTreeDescriptor) async {
        guard let origin else { return }
        syncingTree = tree
        treeError = nil
        phase = .syncing
        do {
            try await workspace.place(tree: tree, from: origin)
            ready = true
        } catch {
            treeError = String(describing: error)
            phase = .choosing
        }
    }

    private func resetForPairing() {
        service = nil
        origin = nil
        confirmationCode = nil
        trees = []
        syncingTree = nil
        treeError = nil
        scanError = nil
        ready = false
        phase = .scanning
    }
}
#endif

#if os(iOS)
private struct IOSAccountPanel: View {
    @Environment(\.dismiss) private var dismiss
    let workspace: ArborWorkspaceState
    let onDisconnect: @MainActor () -> Void
    @State private var placement: NativePlacementRecord?
    @State private var account: WireAccountDescriptor?
    @State private var message: String?
    @State private var disconnectConfirmation = false

    var body: some View {
        NavigationStack {
            Form {
                if let placement {
                    Section("Account") {
                        if let account {
                            LabeledContent("Signed in as", value: "~\(account.handle)")
                        }
                        LabeledContent("Server", value: placement.origin.host() ?? placement.origin.absoluteString)
                        LabeledContent("Folder", value: placement.tree.canonicalPath ?? placement.tree.id)
                        LabeledContent("Access", value: placement.tree.access.capitalized)
                    }
                    Section {
                        Button("Disconnect and Pair Again…", role: .destructive) {
                            disconnectConfirmation = true
                        }
                    } footer: {
                        Text("This removes the credential and local placement from this iPhone. The server tree and its data are not deleted.")
                    }
                } else if message == nil {
                    Section { ProgressView("Loading account…") }
                }
                if let message { Section { Text(message).foregroundStyle(.red) } }
            }
            .navigationTitle("Arbor account")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
        .task { await load() }
        .confirmationDialog(
            "Disconnect this iPhone from Arbor?",
            isPresented: $disconnectConfirmation
        ) {
            Button("Disconnect and Pair Again", role: .destructive) {
                Task { await disconnect() }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Your server tree is not deleted.")
        }
    }

    private func load() async {
        do {
            guard let placement = try await workspace.nativePlacement() else {
                throw ArborWireValidationError.invalidValue("This iPhone has no saved Arbor placement")
            }
            self.placement = placement
            let service = NativeAccountService(origin: placement.origin)
            account = try await service.account().account
            message = nil
        } catch { message = String(describing: error) }
    }

    private func disconnect() async {
        do {
            try await workspace.disconnectNativeAccount()
            dismiss()
            onDisconnect()
        } catch { message = String(describing: error) }
    }
}
#endif

#if os(iOS)
private struct PairingQRScanner: UIViewControllerRepresentable {
    let onPayload: @MainActor (String) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onPayload: onPayload) }

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let scanner = DataScannerViewController(
            recognizedDataTypes: [.barcode(symbologies: [.qr])],
            qualityLevel: .balanced,
            recognizesMultipleItems: false,
            isHighFrameRateTrackingEnabled: false,
            isPinchToZoomEnabled: true,
            isGuidanceEnabled: true,
            isHighlightingEnabled: true
        )
        scanner.delegate = context.coordinator
        try? scanner.startScanning()
        return scanner
    }

    func updateUIViewController(_ scanner: DataScannerViewController, context _: Context) {
        if !scanner.isScanning { try? scanner.startScanning() }
    }

    static func dismantleUIViewController(_ scanner: DataScannerViewController, coordinator _: Coordinator) {
        scanner.stopScanning()
    }

    @MainActor
    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        let onPayload: @MainActor (String) -> Void
        private var completed = false

        init(onPayload: @escaping @MainActor (String) -> Void) { self.onPayload = onPayload }

        func dataScanner(
            _ dataScanner: DataScannerViewController,
            didAdd addedItems: [RecognizedItem],
            allItems _: [RecognizedItem]
        ) {
            guard !completed else { return }
            for item in addedItems {
                guard case let .barcode(barcode) = item,
                      let payload = barcode.payloadStringValue,
                      (try? JSONDecoder().decode(PairingPayload.self, from: Data(payload.utf8)).validated()) != nil else { continue }
                completed = true
                dataScanner.stopScanning()
                onPayload(payload)
                return
            }
        }
    }
}
#endif

private struct WorkspaceSurfaceView: View {
    let node: WorkspaceNode

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                provenance
                switch node.surface {
                case let .markdown(source, _):
                    Text(source).textSelection(.enabled)
                case let .directory(summary):
                    ContentUnavailableView(summary ?? "Directory", systemImage: "folder")
                case let .directoryDocument(source, _, stored):
                    if !stored {
                        Text("Implicit directory document").font(.caption).foregroundStyle(.secondary)
                    }
                    Text(source).textSelection(.enabled)
                case let .file(name, byteCount, mediaType):
                    LabeledContent("File", value: name)
                    if let byteCount {
                        LabeledContent("Size", value: ByteCountFormatter.string(fromByteCount: Int64(byteCount), countStyle: .file))
                    } else {
                        LabeledContent("Size", value: "Not reported by provider")
                    }
                    if let mediaType { LabeledContent("Type", value: mediaType) }
                case let .collection(kind, rowCount):
                    LabeledContent("Collection", value: kind)
                    if let rowCount { LabeledContent("Rows", value: rowCount.formatted()) }
                case let .placeholder(message):
                    ContentUnavailableView("Not available offline", systemImage: "icloud.slash", description: Text(message))
                case let .diagnostic(title, detail):
                    ContentUnavailableView(title, systemImage: "exclamationmark.triangle", description: Text(detail))
                case let .historical(source, revision):
                    Text("Historical revision \(revision)").font(.headline)
                    Text(source).textSelection(.enabled)
                }
            }
            .frame(maxWidth: 720, alignment: .leading)
            .padding()
        }
    }

    private var provenance: some View {
        HStack {
            Text(node.provenance.sourceDescription)
            Spacer()
            if !node.isWritable { Label("Read only", systemImage: "lock") }
        }
        .font(.caption)
        .foregroundStyle(.secondary)
    }
}
