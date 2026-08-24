import ArborKit
import ArborQuagmire
import ArborSync
import ArborWire
import SwiftUI
#if os(iOS)
import VisionKit
#endif

struct ArborRootView: View {
    @State private var model = ArborAppModel()
    @State private var accountPresented = false

    var body: some View {
        NavigationSplitView {
            List(model.children) { node in
                Button {
                    Task { await model.navigate(to: node.reference) }
                } label: {
                    Label(node.title, systemImage: symbol(for: node.surface))
                }
                .buttonStyle(.plain)
            }
            .navigationTitle("Arbor")
            .overlay {
                if model.children.isEmpty {
                    ContentUnavailableView("No children", systemImage: "tree")
                }
            }
        } detail: {
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
            .navigationTitle(model.node?.title ?? "Arbor")
            .toolbar {
                ToolbarItemGroup(placement: .navigation) {
                    Button("Back", systemImage: "chevron.left") { Task { await model.goBack() } }
                        .disabled(!model.canGoBack)
                    Button("Forward", systemImage: "chevron.right") { Task { await model.goForward() } }
                        .disabled(!model.canGoForward)
                    Button("Parent", systemImage: "arrow.up") { Task { await model.goParent() } }
                        .disabled(!model.canGoParent)
                    Button("Home", systemImage: "house") { Task { await model.goHome() } }
                }
                ToolbarItemGroup(placement: .primaryAction) {
                    Button {
                        Task { await model.syncNow() }
                    } label: {
                        Label(model.syncPresentation.state.label, systemImage: model.syncPresentation.state.symbol)
                    }
                        .help(model.syncPresentation.detail ?? model.syncPresentation.state.label)
                    Button("Account", systemImage: "person.crop.circle") { accountPresented = true }
                }
            }
        }
        .task { await model.load() }
        .sheet(isPresented: $accountPresented) {
            NativeAccountPanel { origin, tree in
                try await model.place(tree: tree, from: origin)
            }
        }
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

private extension WorkspaceSynchronization {
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
                    LabeledContent("Size", value: ByteCountFormatter.string(fromByteCount: Int64(byteCount), countStyle: .file))
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
