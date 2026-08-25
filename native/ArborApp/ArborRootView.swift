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

struct ArborRootView: View {
    let workspace: ArborWorkspaceState
    @State private var model: ArborAppModel
    @State private var recordingSession: VoiceRecordingSession<PageID>
    @State private var accountPresented = false
    @State private var pairingPresented = false
    @State private var presentedSheet: ArborPresentedSheet?
    @State private var searchPresented = false
    @State private var searchText = ""
    @State private var workspaceImporterPresented = false
    @State private var assetImporterPresented = false
    @State private var trashConfirmationPresented = false
    @State private var arbordLogs = ""
    @State private var voiceLaunchReady = false
#if os(iOS)
    @State private var sidebarPresented = false
#endif
    @Environment(\.scenePhase) private var scenePhase

    init(workspace: ArborWorkspaceState) {
        self.workspace = workspace
        _model = State(initialValue: ArborAppModel(workspace: workspace))
        _recordingSession = State(initialValue: VoiceRecordingSession(
            recoveryStore: PendingVoiceRecordingStore(
                directoryURL: ArborSupportDirectories.pendingVoiceRecordings
            ),
            loggingSubsystem: "org.nxhx.Arbor",
            recoveryDelivery: { transcript, pageID in
                try await workspace.deliverVoiceTranscript(transcript, to: pageID)
            }
        ))
    }

    var body: some View {
        platformNavigation
        .task(id: workspace.generation) { await model.resetForWorkspace() }
        .task {
#if os(macOS)
            await workspace.restoreLocalWorkspaceIfAvailable()
#endif
            voiceLaunchReady = true
            forwardPendingVoiceRecording()
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active {
                forwardPendingVoiceRecording()
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
            MacArbordAccountPanel(workspace: workspace)
#else
            NativeAccountPanel { origin, tree in
                try await workspace.place(tree: tree, from: origin)
            }
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
        .confirmationDialog("Move this node to Trash?", isPresented: $trashConfirmationPresented) {
            Button("Move to Trash", role: .destructive) {
                Task { await model.perform(.trash(reference: model.currentReference)) }
            }
            Button("Cancel", role: .cancel) {}
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
        .fileImporter(isPresented: $assetImporterPresented, allowedContentTypes: [.data, .image]) { result in
            if case let .success(url) = result {
                Task {
                    let accessing = url.startAccessingSecurityScopedResource()
                    defer { if accessing { url.stopAccessingSecurityScopedResource() } }
                    do {
                        let bytes = try Data(contentsOf: url)
                        let type = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType
                        await model.importAsset(WorkspaceAsset(name: url.lastPathComponent, mediaType: type, bytes: bytes))
                    } catch { workspace.errorMessage = error.localizedDescription }
                }
            }
        }
        .focusedSceneValue(\.arborWindowCommands, windowCommands)
    }

    @ViewBuilder
    private var platformNavigation: some View {
#if os(iOS)
        NavigationStack(path: navigationPathBinding) {
            pageFrame(for: model.navigationRoot)
                .navigationDestination(for: WorkspaceReference.self) { reference in
                    pageFrame(for: reference)
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
                    .navigationDestination(for: WorkspaceReference.self) { reference in
                        pageFrame(for: reference)
                    }
            }
            .id(model.selectedTabID)
        }
#endif
    }

    private var sidebarContent: some View {
        List {
            Button {
                searchPresented = true
            } label: {
                HStack {
                    Label("Search", systemImage: "magnifyingglass")
                    Spacer()
#if os(macOS)
                    Text("⌘P")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
#endif
                }
            }
            .buttonStyle(.plain)

            Section {
                if let parent = model.sidebarReference.parent {
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
                        isCurrent: isCurrent(node.reference),
                        open: { openFromSidebar(node.reference) },
                        openInNewTab: { Task { await model.openInNewTab(node.reference) } },
                        trash: { Task { await model.perform(.trash(reference: node.reference), navigateToResult: false) } }
                    )
                }
            } header: {
                Text(model.sidebarReference.pathHint == "/" ? "Home" : model.sidebarReference.pathHint)
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

    private func isCurrent(_ reference: WorkspaceReference) -> Bool {
        reference.tree == model.currentReference.tree && reference.pathHint == model.currentReference.pathHint
    }

    private func openFromSidebar(_ reference: WorkspaceReference) {
#if os(iOS)
        sidebarPresented = false
#endif
        Task { await model.navigate(to: reference) }
    }

    private var moveRequestBinding: Binding<ArborMoveRequest?> {
        Binding(
            get: { model.editorHost?.moveRequest },
            set: { request in
                if request == nil { model.editorHost?.resolveMoveRequest(with: nil) }
            }
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
            showSearch: { searchPresented = true },
            showHistory: { Task { await model.loadHistory(); presentedSheet = .history } },
            showBacklinks: { presentedSheet = .backlinks },
            showSource: { Task { await model.inspectSource(); presentedSheet = .source } },
            showSyncStatus: { presentedSheet = .syncStatus },
            showPairing: { pairingPresented = true },
            canGoBack: model.canGoBack,
            canGoForward: model.canGoForward,
            canGoParent: model.canGoParent,
            canCloseTab: model.tabItems.count > 1,
            hasDocument: model.binding != nil,
            hasNode: model.node != nil
        )
    }

    private var navigationPathBinding: Binding<[WorkspaceReference]> {
        Binding(
            get: { model.navigationPath },
            set: { model.setNavigationPath($0) }
        )
    }

    @ViewBuilder
    private func pageFrame(for reference: WorkspaceReference) -> some View {
        VStack(spacing: 0) {
            if model.tabItems.count > 1 {
                ArborTabStrip(
                    tabs: model.tabItems,
                    selected: model.selectedTabID,
                    title: { tab in tab.current.pathHint == "/" ? "Home" : tab.current.pathHint.split(separator: "/").last.map(String.init) ?? "Arbor" },
                    select: { id in Task { await model.selectTab(id) } },
                    close: { Task { await model.closeSelectedTab() } },
                    create: { Task { await model.newTab() } }
                )
            }
            pageFrameContent(for: reference)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .overlay(alignment: .top) {
            if reference == model.currentReference {
                attentionBanner
                    .padding(.horizontal, 16)
                    .frame(maxWidth: 560)
                    .padding(.top, 8)
            }
        }
        .animation(.easeInOut(duration: 0.2), value: model.binding?.conflict != nil)
        .animation(.easeInOut(duration: 0.2), value: workspace.syncConflict != nil)
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
#if os(iOS)
                Button("Pages", systemImage: "line.3.horizontal") { sidebarPresented = true }
#endif
                if reference == model.currentReference,
                   model.node?.isWritable == true,
                   model.binding != nil {
                    VoiceRecordingButton(session: recordingSession) {
                        await model.startVoiceRecording(recordingSession)
                    }
                }
                Button("Search", systemImage: "magnifyingglass") { searchPresented = true }
                Menu("Actions", systemImage: "ellipsis.circle") {
                    Button("Rename…", systemImage: "pencil") { presentedSheet = .rename }
                        .disabled(model.node?.isWritable != true)
                    Button("Move…", systemImage: "folder") { presentedSheet = .move }
                        .disabled(model.node?.isWritable != true)
                    Button("Copy…", systemImage: "plus.square.on.square") { presentedSheet = .copy }
                        .disabled(model.node == nil)
                    Button("Import Asset…", systemImage: "photo.badge.plus") { assetImporterPresented = true }
                        .disabled(!workspace.capabilities.assets)
                    Divider()
                    if model.currentReference.pathHint.hasPrefix("/Trash/") {
                        Button("Restore", systemImage: "arrow.uturn.backward") {
                            Task { await model.perform(.restore(reference: model.currentReference)) }
                        }
                    } else {
                        Button("Move to Trash", systemImage: "trash", role: .destructive) {
                            trashConfirmationPresented = true
                        }
                        .disabled(model.node?.isWritable != true || model.currentReference.pathHint == "/")
                    }
#if os(macOS)
                    Divider()
                    Button("Reconnect to arbord", systemImage: "arrow.clockwise") { Task { await workspace.restartArbord() } }
                    Button("arbord Logs…", systemImage: "doc.text.magnifyingglass") {
                        Task { arbordLogs = await workspace.arbordLogs(); presentedSheet = .arbordLogs }
                    }
#endif
                }
#if os(macOS)
                Button("Pair iPhone", systemImage: "qrcode") { pairingPresented = true }
#endif
                Button("Account", systemImage: "person.crop.circle") { accountPresented = true }
            }
        }
    }

    @ViewBuilder
    private func pageFrameContent(for reference: WorkspaceReference) -> some View {
        if reference != model.currentReference || model.isLoading {
            ProgressView()
        } else if let node = model.node {
            if node.surface.supportsDocumentSession, node.isWritable {
                if let lease = model.editorLease, let host = model.editorHost {
                    ArborEditorSurface(
                        binding: lease.binding,
                        host: host,
                        configuration: ArborStyle.editorConfiguration
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
                    .modifier(ArborEditorToolbarModifier())
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
            ArborHistoryView(entries: model.history) { revision in Task { await model.recover(revision) } }
        case .backlinks:
            ArborBacklinksView(entries: model.backlinks) { reference in
                presentedSheet = nil
                Task { await model.navigate(to: reference) }
            }
        case .arbordLogs:
            NavigationStack {
                ScrollView { Text(arbordLogs).font(.body.monospaced()).textSelection(.enabled).padding() }
                    .navigationTitle("arbord Logs")
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
        case .rename:
            Task { await model.perform(.rename(reference: model.currentReference, name: trimmed)) }
        case .move:
            Task { await model.perform(.move(reference: model.currentReference, destination: destination(trimmed))) }
        case .copy:
            Task { await model.perform(.copy(reference: model.currentReference, destination: destination(trimmed))) }
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

    private func destination(_ path: String) -> WorkspaceReference {
        WorkspaceReference(
            tree: model.currentReference.tree,
            path: path.hasPrefix("/") ? path : "/\(path)"
        )
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
        } else if model.binding?.lastError != nil {
            ArborAttentionBanner(
                message: "Arbor could not save the latest document edit.",
                systemImage: "exclamationmark.circle",
                tint: .red,
                primaryLabel: "Retry",
                primaryAction: { Task { await model.retryDocumentSave() } },
                secondaryLabel: "Details…",
                secondaryAction: { presentedSheet = .syncStatus }
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

private struct ArborEditorToolbarModifier: ViewModifier {
    @FocusedValue(\.documentUndoController) private var undoController

    func body(content: Content) -> some View {
        content
#if os(iOS)
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button("Undo", systemImage: "arrow.uturn.backward") { undoController?.undo() }
                        .disabled(undoController?.canUndo != true)
                }
                if undoController?.canRedo == true {
                    ToolbarItem(placement: .primaryAction) {
                        Button("Redo", systemImage: "arrow.uturn.forward") { undoController?.redo() }
                    }
                }
            }
#endif
    }
}

#if os(macOS)
private struct MacArbordAccountPanel: View {
    @Environment(\.dismiss) private var dismiss
    let workspace: ArborWorkspaceState
    @State private var account: LocalArbordAccountPresentation?
    @State private var pairing: LocalArbordPairingPresentation?
    @State private var message: String?

    var body: some View {
        NavigationStack {
            Form {
                if let account {
                    Section("Account") {
                        LabeledContent("Signed in as", value: "~\(account.handle)")
                        LabeledContent("Authority", value: account.origin)
                        LabeledContent("Credential", value: account.credentialAvailable ? "Available" : "Unavailable")
                    }
                    Section("Trees") {
                        ForEach(account.trees) { tree in
                            VStack(alignment: .leading, spacing: 3) {
                                Text(tree.canonicalPath ?? tree.name)
                                Text([tree.access, tree.sync].compactMap { $0 }.joined(separator: " · "))
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                    Section("Devices") {
                        ForEach(account.devices, id: \.id) { device in
                            HStack {
                                VStack(alignment: .leading) {
                                    Text(device.label)
                                    Text(device.revokedAt == nil ? "Active" : "Revoked")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                                Spacer()
                                if device.revokedAt == nil {
                                    Button("Revoke", role: .destructive) {
                                        Task { await revoke(device.id) }
                                    }
                                }
                            }
                        }
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
                } else {
                    Section { ProgressView("Loading ~/.arbor…") }
                }
                if let message { Section { Text(message).foregroundStyle(.secondary) } }
            }
            .navigationTitle("Arbor account")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
        .frame(minWidth: 520, minHeight: 520)
        .task { await refresh() }
    }

    private func refresh() async {
        do { account = try await workspace.localArbordAccount(); message = nil }
        catch { message = error.localizedDescription }
    }

    private func createPairing() async {
        do { pairing = try await workspace.createLocalArbordPairing(); message = nil }
        catch { message = error.localizedDescription }
    }

    private func revoke(_ id: String) async {
        do { try await workspace.revokeLocalArbordDevice(id); await refresh() }
        catch { message = error.localizedDescription }
    }
}

private struct MacPairingPanel: View {
    @Environment(\.dismiss) private var dismiss
    let workspace: ArborWorkspaceState
    @State private var pairing: LocalArbordPairingPresentation?
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
            pairing = try await workspace.createLocalArbordPairing()
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
    @State private var trees: [AuthorityTreeDescriptor] = []
    @State private var syncingTree: AuthorityTreeDescriptor?

    var body: some View {
        Group {
            if ready {
                ArborRootView(workspace: workspace)
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
                                    Text(tree.canonicalPath)
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
            trees = try await service.trees().sorted { $0.canonicalPath < $1.canonicalPath }
        } catch {
            treeError = String(describing: error)
        }
    }

    private func place(_ tree: AuthorityTreeDescriptor) async {
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
}
#endif

private struct NativeAccountPanel: View {
    @Environment(\.dismiss) private var dismiss
    @State private var origin = ""
    @State private var pairingJSON = ""
    @State private var label = "Arbor device"
    @State private var confirmationCode: String?
    @State private var devices: [AuthorityDevice] = []
    @State private var trees: [AuthorityTreeDescriptor] = []
    @State private var message: String?
    @State private var service: NativeAccountService?
    @State private var serviceOrigin: URL?
#if os(iOS)
    @State private var scannerPresented = false
#endif
    let onPlace: @MainActor (URL, AuthorityTreeDescriptor) async throws -> Void

    var body: some View {
        NavigationStack {
            Form {
                Section("Authority") {
                    TextField("https://arbor.example", text: $origin)
                        .textContentType(.URL)
                        .autocorrectionDisabled()
                    Button("Load devices") { Task { await loadDevices() } }
                }
                Section("Pair this device") {
                    TextField("Device label", text: $label)
#if os(iOS)
                    Button("Scan pairing QR", systemImage: "qrcode.viewfinder") {
                        if DataScannerViewController.isSupported, DataScannerViewController.isAvailable {
                            scannerPresented = true
                        } else {
                            message = "QR scanning is unavailable on this device. Paste the pairing payload instead."
                        }
                    }
#endif
                    TextField("Versioned pairing QR payload", text: $pairingJSON, axis: .vertical)
                        .lineLimit(3...8)
                    Button("Claim pairing") { Task { await claim() } }
                    if let confirmationCode {
                        LabeledContent("Confirm on both devices", value: confirmationCode)
                            .font(.headline.monospacedDigit())
                    }
                }
                Section {
                    Button("Forget credential on this device", role: .destructive) { Task { await forget() } }
                }
                if !devices.isEmpty {
                    Section("Devices") {
                        ForEach(devices, id: \.id) { device in
                            HStack {
                                VStack(alignment: .leading) {
                                    Text(device.label)
                                    Text(device.revokedAt == nil ? "Active" : "Revoked").font(.caption)
                                }
                                Spacer()
                                if device.revokedAt == nil {
                                    Button("Revoke", role: .destructive) { Task { await revoke(device.id) } }
                                }
                            }
                        }
                    }
                }
                if !trees.isEmpty {
                    Section("Trees") {
                        ForEach(trees, id: \.id) { tree in
                            Button {
                                Task { await place(tree) }
                            } label: {
                                HStack {
                                    VStack(alignment: .leading) {
                                        Text(tree.canonicalPath)
                                        Text(tree.id).font(.caption.monospaced()).foregroundStyle(.secondary)
                                    }
                                    Spacer()
                                    Image(systemName: "arrow.down.to.line")
                                }
                            }
                            .disabled(tree.access != "write")
                        }
                    }
                }
                if let message { Section { Text(message).foregroundStyle(.secondary) } }
            }
            .navigationTitle("Arbor account")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
        .frame(minWidth: 420, minHeight: 420)
#if os(iOS)
        .sheet(isPresented: $scannerPresented) {
            NavigationStack {
                PairingQRScanner { payload in
                    pairingJSON = payload
                    scannerPresented = false
                }
                .ignoresSafeArea()
                .navigationTitle("Scan pairing QR")
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") { scannerPresented = false }
                    }
                }
            }
        }
#endif
    }

    private func configuredService() throws -> NativeAccountService {
        guard let url = URL(string: origin), url.scheme == "https" || url.host == "127.0.0.1" else {
            throw ArborWireValidationError.invalidValue("Enter a valid authority URL")
        }
        if let service, serviceOrigin == url { return service }
        let value = NativeAccountService(origin: url)
        service = value
        serviceOrigin = url
        return value
    }

    private func claim() async {
        do {
            let payload = try JSONDecoder().decode(PairingPayload.self, from: Data(pairingJSON.utf8))
            if origin.isEmpty { origin = payload.origin.absoluteString }
            let result = try await configuredService().claim(payload, label: label)
            confirmationCode = result.confirmationCode
            message = "Distinct device credential stored in Keychain. Confirm the code before continuing."
            await loadDevices()
        } catch { message = String(describing: error) }
    }

    private func loadDevices() async {
        do {
            let configured = try configuredService()
            async let loadedDevices = configured.devices()
            async let loadedTrees = configured.trees()
            (devices, trees) = try await (loadedDevices, loadedTrees)
            message = devices.isEmpty ? "No devices" : nil
        } catch { message = String(describing: error) }
    }

    private func revoke(_ id: String) async {
        do { _ = try await configuredService().revoke(device: id); await loadDevices() }
        catch { message = String(describing: error) }
    }

    private func forget() async {
        do {
            try await configuredService().forget()
            devices = []
            confirmationCode = nil
            message = "This device's local authority credential was removed. Authored and replicated content was not changed."
        } catch { message = String(describing: error) }
    }

    private func place(_ tree: AuthorityTreeDescriptor) async {
        do {
            guard let configuredOrigin = serviceOrigin else {
                throw ArborWireValidationError.invalidValue("Configure the authority before placing a tree")
            }
            try await onPlace(configuredOrigin, tree)
            message = "Placed \(tree.canonicalPath) in private replica storage."
        } catch { message = String(describing: error) }
    }
}

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
