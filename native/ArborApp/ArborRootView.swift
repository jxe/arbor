import ArborKit
import ArborQuagmire
import ArborSync
import ArborWire
import SwiftUI
import UniformTypeIdentifiers
#if os(iOS)
import VisionKit
#endif

struct ArborRootView: View {
    let workspace: ArborWorkspaceState
    @State private var model: ArborAppModel
    @State private var accountPresented = false
    @State private var presentedSheet: ArborPresentedSheet?
    @State private var searchText = ""
    @State private var workspaceImporterPresented = false
    @State private var assetImporterPresented = false
    @State private var trashConfirmationPresented = false
    @State private var arbordLogs = ""
    @FocusState private var searchFocused: Bool
    @Environment(\.scenePhase) private var scenePhase

    init(workspace: ArborWorkspaceState) {
        self.workspace = workspace
        _model = State(initialValue: ArborAppModel(workspace: workspace))
    }

    var body: some View {
        NavigationSplitView {
            List(sidebarItems) { node in
                Button {
                    Task {
                        searchText = ""
                        await model.navigate(to: node.reference)
                    }
                } label: {
                    VStack(alignment: .leading) {
                        Label(node.title, systemImage: symbol(for: node.surface))
                        if let result = model.searchResults.first(where: { $0.reference == node.reference }),
                           let excerpt = result.excerpt {
                            Text(excerpt).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                        }
                    }
                }
                .buttonStyle(.plain)
            }
            .navigationTitle("Arbor")
            .searchable(text: $searchText, prompt: "Search this tree")
            .focused($searchFocused)
            .onSubmit(of: .search) { Task { await model.search(searchText) } }
            .onChange(of: searchText) { _, value in
                if value.isEmpty { Task { await model.search("") } }
            }
            .overlay {
                if sidebarItems.isEmpty {
                    ContentUnavailableView(searchText.isEmpty ? "No children" : "No results", systemImage: "tree")
                }
            }
        } detail: {
            VStack(spacing: 0) {
                ArborTabStrip(
                    tabs: model.tabItems,
                    selected: model.selectedTabID,
                    title: { tab in tab.current.pathHint == "/" ? "Home" : tab.current.pathHint.split(separator: "/").last.map(String.init) ?? "Arbor" },
                    select: { id in Task { await model.selectTab(id) } },
                    close: { Task { await model.closeSelectedTab() } },
                    create: { Task { await model.newTab() } }
                )
                ArborBreadcrumbs(reference: model.currentReference) { reference in
                    Task { await model.navigate(to: reference) }
                }
                Group {
                    if let node = model.node {
                        if let lease = model.editorLease, let host = model.editorHost {
                            ArborEditorSurface(binding: lease.binding, host: host)
                        } else {
                            WorkspaceSurfaceView(node: node)
                        }
                    } else if let message = model.errorMessage {
                        ContentUnavailableView("Unable to open", systemImage: "exclamationmark.triangle", description: Text(message))
                    } else {
                        ProgressView()
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                if let conflict = model.binding?.conflict {
                    conflictBar(conflict)
                }
                if workspace.syncConflict != nil {
                    syncConflictBar
                }
                ArborStatusBar(
                    provider: workspace.providerDetail,
                    sync: workspace.syncPresentation,
                    binding: model.binding
                )
            }
            .navigationTitle(model.node?.title ?? "Arbor")
            .navigationSubtitle(model.currentReference.pathHint)
            .toolbar {
                ToolbarItemGroup(placement: .navigation) {
                    Button("Back", systemImage: "chevron.left") { Task { await model.goBack() } }
                        .disabled(!model.canGoBack)
                    Button("Forward", systemImage: "chevron.right") { Task { await model.goForward() } }
                        .disabled(!model.canGoForward)
                    Button("Parent", systemImage: "arrow.up") { Task { await model.goParent() } }
                        .disabled(!model.canGoParent)
                    Button("Home", systemImage: "house") { Task { await model.goHome() } }
                    Button("Open Location", systemImage: "location") { presentedSheet = .openLocation }
                }
                ToolbarItemGroup(placement: .primaryAction) {
                    Button {
                        Task { await workspace.syncNow() }
                    } label: {
                        Label(workspace.syncPresentation.state.label, systemImage: workspace.syncPresentation.state.symbol)
                    }
                        .help(workspace.syncPresentation.detail ?? workspace.syncPresentation.state.label)
                    Menu("Actions", systemImage: "ellipsis.circle") {
                        Button("New Document…", systemImage: "doc.badge.plus") { presentedSheet = .createMarkdown }
                        Button("New Folder…", systemImage: "folder.badge.plus") { presentedSheet = .createDirectory }
                        Button("Rename…", systemImage: "pencil") { presentedSheet = .rename }
                            .disabled(model.node?.isWritable != true)
                        Button("Move…", systemImage: "folder") { presentedSheet = .move }
                            .disabled(model.node?.isWritable != true)
                        Button("Copy…", systemImage: "plus.square.on.square") { presentedSheet = .copy }
                            .disabled(model.node == nil)
                        Button("Import Asset…", systemImage: "photo.badge.plus") { assetImporterPresented = true }
                            .disabled(!workspace.capabilities.assets)
                        Divider()
                        Button("Linked From…", systemImage: "link") { presentedSheet = .backlinks }
                        Button("Recover…", systemImage: "clock.arrow.circlepath") {
                            Task { await model.loadHistory(); presentedSheet = .history }
                        }
                            .disabled(model.binding == nil)
                        Button("Source and Properties…", systemImage: "doc.plaintext") {
                            Task { await model.inspectSource(); presentedSheet = .source }
                        }
                            .disabled(model.node == nil)
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
                        Button("Open Local Workspace…", systemImage: "folder") { workspaceImporterPresented = true }
                        Button("Restart arbord", systemImage: "arrow.clockwise") { Task { await workspace.restartArbord() } }
                        Button("arbord Logs…", systemImage: "doc.text.magnifyingglass") {
                            Task { arbordLogs = await workspace.arbordLogs(); presentedSheet = .arbordLogs }
                        }
#endif
                    }
                    Button("Account", systemImage: "person.crop.circle") { accountPresented = true }
                }
            }
        }
        .task(id: workspace.generation) { await model.resetForWorkspace() }
#if os(macOS)
        .task { await workspace.restoreLocalWorkspaceIfAvailable() }
#endif
        .onChange(of: scenePhase) { _, phase in
            if phase != .active { Task { await workspace.flush() } }
        }
        .sheet(isPresented: $accountPresented) {
            NativeAccountPanel { origin, tree in
                try await workspace.place(tree: tree, from: origin)
            }
        }
        .sheet(item: $presentedSheet, content: sheet)
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
        .alert("Arbor", isPresented: errorPresented) {
            Button("OK") { workspace.errorMessage = nil }
        } message: {
            Text(workspace.errorMessage ?? "")
        }
        .focusedSceneValue(\.arborWindowCommands, windowCommands)
    }

    private var sidebarItems: [WorkspaceNode] {
        guard !searchText.isEmpty else { return model.children }
        return model.searchResults.map { result in
            WorkspaceNode(
                reference: result.reference,
                title: result.title,
                surface: .markdown(source: "", contentRevision: "search"),
                provenance: .init(authority: .local, sourceDescription: "Search result"),
                isWritable: false
            )
        }
    }

    private var errorPresented: Binding<Bool> {
        Binding(get: { workspace.errorMessage != nil }, set: { if !$0 { workspace.errorMessage = nil } })
    }

    private var windowCommands: ArborWindowCommands {
        ArborWindowCommands(
            goHome: { Task { await model.goHome() } },
            goBack: { Task { await model.goBack() } },
            newTab: { Task { await model.newTab() } },
            closeTab: { Task { await model.closeSelectedTab() } },
            showSearch: { searchFocused = true },
            showHistory: { Task { await model.loadHistory(); presentedSheet = .history } },
            canGoBack: model.canGoBack,
            canCloseTab: model.tabItems.count > 1,
            hasDocument: model.binding != nil
        )
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

    private func conflictBar(_ conflict: WorkspaceDocumentConflict) -> some View {
        HStack {
            Label("This document changed outside the current edit session.", systemImage: "exclamationmark.triangle")
            Spacer()
            Button("Use Current") { Task { await model.resolveEditorConflict(preferSubmitted: false) } }
            Button("Keep My Edit") { Task { await model.resolveEditorConflict(preferSubmitted: true) } }
                .buttonStyle(.borderedProminent)
        }
        .padding(10)
        .background(.orange.opacity(0.16))
        .accessibilityElement(children: .contain)
        .help("Current revision: \(conflict.current.contentRevision)")
    }

    private var syncConflictBar: some View {
        HStack {
            Label("Synchronization needs a conflict choice.", systemImage: "arrow.triangle.branch")
            Spacer()
            Button("Review…") { presentedSheet = .syncConflict }
                .buttonStyle(.borderedProminent)
        }
        .padding(10)
        .background(.orange.opacity(0.16))
        .accessibilityElement(children: .contain)
    }

    private func symbol(for surface: WorkspaceSurface) -> String {
        switch surface {
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
}

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
