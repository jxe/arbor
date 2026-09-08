import ArborClient
import ArborKit
import ArborQuagmire
import ArborSync
import ArborWire
import Quagmire
import QuagmireExtras
import SwiftUI
#if os(macOS)
import AppKit
import CoreImage
import CoreImage.CIFilterBuiltins
#endif
#if os(iOS)
import UIKit
import VisionKit
#endif

private extension LocalCanopyAccountDescriptor {
    var arborDisplayName: String {
        guard let handle, !handle.isEmpty else { return "Canopy account" }
        return "~\(handle)"
    }

    var arborDisplayDetail: String {
        if let canopy, !canopy.isEmpty {
            return URL(string: canopy)?.host() ?? canopy
        }
        let suffix = configurationTree.dropFirst(3).prefix(8)
        return suffix.isEmpty ? "Account settings" : "Account \(suffix.uppercased())"
    }
}

private extension NativeCanopyAccount {
    var arborDisplayName: String {
        guard let handle, !handle.isEmpty else { return "Canopy account" }
        return "~\(handle)"
    }

    var arborDisplayDetail: String {
        if let host = origin.host(), !host.isEmpty { return host }
        let suffix = configurationTree.dropFirst(3).prefix(8)
        return suffix.isEmpty ? "Account settings" : "Account \(suffix.uppercased())"
    }
}

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

#if os(macOS)
private enum MacManagementTab: Hashable {
    case accounts
    case status
}
#endif

enum ArborSidebarPageOrder: String, CaseIterable, Identifiable {
    case alphabetical
    case recent
    case linkCount

    var id: Self { self }

    var label: String {
        switch self {
        case .alphabetical: "Alphabetical"
        case .recent: "Recent"
        case .linkCount: "Link Count"
        }
    }

    var symbol: String {
        switch self {
        case .alphabetical: "textformat"
        case .recent: "clock"
        case .linkCount: "link"
        }
    }
}

struct ArborSidebarPageGroup: Identifiable, Equatable {
    var title: String
    var results: [WorkspaceSearchResult]
    var showsBacklinkCounts = false
    var id: String { title }
}

enum ArborSidebarPages {
    static func sorted(
        _ results: [WorkspaceSearchResult],
        by order: ArborSidebarPageOrder
    ) -> [WorkspaceSearchResult] {
        results.sorted { lhs, rhs in
            if order == .recent, lhs.modifiedAt != rhs.modifiedAt {
                return (lhs.modifiedAt ?? .distantPast) > (rhs.modifiedAt ?? .distantPast)
            }
            if order == .linkCount, lhs.backlinkCount != rhs.backlinkCount {
                return lhs.backlinkCount > rhs.backlinkCount
            }
            let titleOrder = alphabeticalTitle(lhs.title).localizedStandardCompare(alphabeticalTitle(rhs.title))
            if titleOrder != .orderedSame { return titleOrder == .orderedAscending }
            return lhs.reference.path.localizedStandardCompare(rhs.reference.path) == .orderedAscending
        }
    }

    private static func alphabeticalTitle(_ title: String) -> String {
        guard let first = title.first, WorkspaceDisplayTitle.isEmoji(first) else { return title }
        let remainder = title.dropFirst().trimmingCharacters(in: .whitespaces)
        return remainder.isEmpty ? title : remainder
    }

    static func recentGroups(
        _ results: [WorkspaceSearchResult],
        now: Date = .now,
        calendar: Calendar = .current
    ) -> [ArborSidebarPageGroup] {
        let startOfToday = calendar.startOfDay(for: now)
        let startOfWeek = calendar.dateInterval(of: .weekOfYear, for: now)?.start ?? startOfToday
        let startOfMonth = calendar.dateInterval(of: .month, for: now)?.start ?? startOfWeek
        let ordered = sorted(results, by: .recent)
        let sections: [(String, (Date?) -> Bool)] = [
            ("Today", { ($0 ?? .distantPast) >= startOfToday }),
            ("This Week", { date in
                guard let date else { return false }
                return date >= startOfWeek && date < startOfToday
            }),
            ("This Month", { date in
                guard let date else { return false }
                return date >= startOfMonth && date < startOfWeek
            }),
            ("Earlier", { date in date == nil || date! < startOfMonth }),
        ]
        return sections.compactMap { title, includes in
            let matches = ordered.filter { includes($0.modifiedAt) }
            return matches.isEmpty ? nil : ArborSidebarPageGroup(title: title, results: matches)
        }
    }

    static func linkCountGroups(_ results: [WorkspaceSearchResult]) -> [ArborSidebarPageGroup] {
        let ordered = sorted(results, by: .linkCount)
        let sections: [(String, (Int) -> Bool, Bool)] = [
            ("0 Links", { $0 == 0 }, false),
            ("1 Link", { $0 == 1 }, false),
            ("Multiple Links", { $0 > 1 }, true),
        ]
        return sections.compactMap { title, includes, showsBacklinkCounts in
            let matches = ordered.filter { includes($0.backlinkCount) }
            return matches.isEmpty ? nil : ArborSidebarPageGroup(
                title: title,
                results: matches,
                showsBacklinkCounts: showsBacklinkCounts
            )
        }
    }
}

#if os(macOS)
private struct MacSidebarTitlebarAccessory: NSViewRepresentable {
    let width: CGFloat
    let isVisible: Bool
    @Binding var installed: Bool
    let content: AnyView

    init<Content: View>(
        width: CGFloat,
        isVisible: Bool,
        installed: Binding<Bool>,
        @ViewBuilder content: () -> Content
    ) {
        self.width = width
        self.isVisible = isVisible
        _installed = installed
        self.content = AnyView(content())
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(installed: $installed, isVisible: isVisible)
    }

    func makeNSView(context: Context) -> MacWindowReaderView {
        let view = MacWindowReaderView()
        view.windowChanged = { window in
            context.coordinator.attach(to: window)
        }
        return view
    }

    func updateNSView(_ view: MacWindowReaderView, context: Context) {
        context.coordinator.update(content: content, width: width, isVisible: isVisible)
        context.coordinator.attach(to: view.window)
    }

    static func dismantleNSView(_ view: MacWindowReaderView, coordinator: Coordinator) {
        coordinator.detach()
    }

    @MainActor
    final class Coordinator {
        private let installed: Binding<Bool>
        private let controller = NSTitlebarAccessoryViewController()
        private let hostingView = NSHostingView(rootView: AnyView(EmptyView()))
        private lazy var widthConstraint = hostingView.widthAnchor.constraint(equalToConstant: sidebarWidth)
        private weak var window: NSWindow?
        private var sidebarWidth: CGFloat = 240
        private var isVisible: Bool

        init(installed: Binding<Bool>, isVisible: Bool) {
            self.installed = installed
            self.isVisible = isVisible
            controller.layoutAttribute = .left
            hostingView.wantsLayer = true
            hostingView.layer?.masksToBounds = true
            controller.view = hostingView
            widthConstraint.isActive = true
        }

        func update(content: AnyView, width: CGFloat, isVisible: Bool) {
            hostingView.rootView = content
            sidebarWidth = max(0, width)
            self.isVisible = isVisible
            guard isVisible else {
                detach()
                return
            }
            fitToSidebar()
        }

        func attach(to nextWindow: NSWindow?) {
            guard isVisible else {
                detach()
                return
            }
            guard let nextWindow else { return }
            guard window !== nextWindow else {
                fitToSidebar()
                return
            }
            detach()
            window = nextWindow
            controller.view.frame = NSRect(x: 0, y: 0, width: sidebarWidth, height: 52)
            nextWindow.addTitlebarAccessoryViewController(controller)
            fitToSidebar()
            DispatchQueue.main.async { [weak self] in
                self?.fitToSidebar()
                self?.setInstalled(true)
            }
        }

        func detach() {
            if let window,
               let index = window.titlebarAccessoryViewControllers.firstIndex(where: { $0 === controller }) {
                window.removeTitlebarAccessoryViewController(at: index)
            }
            window = nil
            setInstalled(false)
        }

        private func fitToSidebar() {
            guard window != nil else {
                setAccessoryWidth(sidebarWidth)
                return
            }
            let accessoryLeadingEdge = max(0, hostingView.convert(.zero, to: nil).x)
            setAccessoryWidth(max(0, sidebarWidth - accessoryLeadingEdge))
        }

        private func setAccessoryWidth(_ width: CGFloat) {
            widthConstraint.constant = width
            controller.view.frame.size.width = width
        }

        private func setInstalled(_ value: Bool) {
            guard installed.wrappedValue != value else { return }
            DispatchQueue.main.async { [installed] in
                installed.wrappedValue = value
            }
        }
    }
}

@MainActor
private final class MacWindowReaderView: NSView {
    var windowChanged: ((NSWindow?) -> Void)?

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        windowChanged?(window)
    }
}

private struct MutedMacToolbarHoverModifier: ViewModifier {
    @State private var isHovered = false

    func body(content: Content) -> some View {
        content
            .contentShape(.rect)
            .background {
                RoundedRectangle(cornerRadius: 6)
                    .fill(Color.primary.opacity(isHovered ? 0.08 : 0))
            }
            .onHover { hovering in
                withAnimation(.easeOut(duration: 0.1)) {
                    isHovered = hovering
                }
            }
    }
}

private extension View {
    func mutedMacToolbarHover() -> some View {
        modifier(MutedMacToolbarHoverModifier())
    }
}

private struct MacPageOrderPicker: NSViewRepresentable {
    @Binding var selection: ArborSidebarPageOrder

    func makeCoordinator() -> Coordinator {
        Coordinator(selection: $selection)
    }

    func makeNSView(context: Context) -> PageOrderPopUpButton {
        let button = PageOrderPopUpButton(frame: .zero, pullsDown: false)
        button.isBordered = false
        button.imagePosition = .imageOnly
        button.imageScaling = .scaleProportionallyDown
        button.target = context.coordinator
        button.action = #selector(Coordinator.selectionChanged(_:))
        button.toolTip = "Page order"
        button.setAccessibilityLabel("Page order")
        if let cell = button.cell as? NSPopUpButtonCell {
            cell.highlightsBy = []
            cell.arrowPosition = .noArrow
        }
        for order in ArborSidebarPageOrder.allCases {
            button.addItem(withTitle: order.label)
            let item = button.lastItem
            item?.representedObject = order.rawValue
            item?.image = NSImage(systemSymbolName: order.symbol, accessibilityDescription: order.label)
            item?.image?.isTemplate = true
        }
        return button
    }

    func updateNSView(_ button: PageOrderPopUpButton, context: Context) {
        context.coordinator.selection = $selection
        if let index = ArborSidebarPageOrder.allCases.firstIndex(of: selection) {
            button.selectItem(at: index)
        }
        button.contentTintColor = NSColor.secondaryLabelColor.withAlphaComponent(0.78)
        button.setAccessibilityValue(selection.label)
    }

    @MainActor
    final class Coordinator: NSObject {
        var selection: Binding<ArborSidebarPageOrder>

        init(selection: Binding<ArborSidebarPageOrder>) {
            self.selection = selection
        }

        @objc func selectionChanged(_ sender: NSPopUpButton) {
            guard let rawValue = sender.selectedItem?.representedObject as? String,
                  let order = ArborSidebarPageOrder(rawValue: rawValue) else { return }
            selection.wrappedValue = order
        }
    }
}

@MainActor
private final class PageOrderPopUpButton: NSPopUpButton {
    override var intrinsicContentSize: NSSize {
        NSSize(width: 32, height: 32)
    }
}
#endif

struct ArborRootView: View {
    let workspace: ArborWorkspaceState
    let onDisconnect: @MainActor () -> Void
    @State private var model: ArborAppModel
    @State private var recordingSession: VoiceRecordingSession<String>
    @State private var pinchDictation: EditorPinchDictation
    @State private var accountPresented = false
    @State private var sharePresented = false
    @State private var presentedSheet: ArborPresentedSheet?
    @State private var searchPresented = false
    @State private var searchText = ""
    @State private var trashConfirmationPresented = false
    @State private var arborsyncLogs = ""
    @State private var documentConflictExpanded = false
    @State private var voiceLaunchReady = false
    @State private var sidebarPageOrder = ArborSidebarPageOrder.alphabetical
    @State private var sidebarSearchText = ""
    @FocusState private var sidebarSearchFocused: Bool
#if os(macOS)
    @State private var sidebarTitlebarAccessoryInstalled = false
    @State private var columnVisibility: NavigationSplitViewVisibility = .all
    @State private var managementPresented = false
    @State private var managementTab = MacManagementTab.status
    @State private var profileAfterManagementDismiss: WorkspaceReference?
    @State private var sheetAfterManagementDismiss: ArborPresentedSheet?
#endif
#if os(iOS)
    @State private var sidebarRevealProgress: CGFloat = 0
    @State private var sidebarDrawerWidth: CGFloat = 360
    @State private var placementPresented = false
    @State private var treeAccountSwitcherPresented = false
    @State private var topOverscrollProgress: CGFloat = 0
    @State private var topOverscrollArmed = false
    @State private var sidebarDismissDragSuppressesTap = false
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
        .task(id: workspace.generation) {
            await model.resetForWorkspace()
#if os(iOS)
            // A restored replica is useful immediately while offline, but once
            // its editor is observing changes, establish current Canopy state
            // instead of relying only on replay from a long-lived watch.
            await workspace.syncNow(reportTransientNetworkErrors: false)
#endif
        }
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
#else
                // iOS may suspend an apparently open streaming request while
                // backgrounded. Foregrounding is therefore also a deterministic
                // snapshot-then-follow catch-up boundary.
                Task { await workspace.syncNow(reportTransientNetworkErrors: false) }
#endif
            } else {
                Task { await workspace.flush() }
            }
        }
        .onChange(of: model.currentLocation) { _, _ in
            documentConflictExpanded = false
        }
        .onChange(of: model.binding?.conflict) { _, conflict in
            if conflict == nil { documentConflictExpanded = false }
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
#if os(iOS)
        .sheet(isPresented: $accountPresented) {
            IOSAccountPanel(workspace: workspace, onDisconnect: onDisconnect)
        }
        .sheet(isPresented: $sharePresented) {
            ArborSharePanel(workspace: workspace, currentNode: model.node)
        }
        .sheet(isPresented: $placementPresented) {
            IOSPlaceTreePanel(workspace: workspace)
        }
        .sheet(isPresented: $treeAccountSwitcherPresented) {
            IOSTreeAccountSwitcher(
                workspace: workspace,
                currentTreeID: model.currentReference.tree.rawValue,
                openAccounts: {
                    treeAccountSwitcherPresented = false
                    accountPresented = true
                },
                placeTree: {
                    treeAccountSwitcherPresented = false
                    placementPresented = true
                }
            )
        }
#else
        .sheet(isPresented: $managementPresented, onDismiss: finishManagementDismissal) {
            macManagementPanel
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
        .overlay(alignment: .leading) {
            if model.navigationPath.isEmpty {
                Color.clear
                    .frame(width: 22)
                    .frame(maxHeight: .infinity)
                    .contentShape(.rect)
                    .gesture(openSidebarEdgeGesture)
            }
        }
        .overlay {
            iosSidebarDrawer
        }
#else
        NavigationSplitView(columnVisibility: $columnVisibility) {
            sidebarContent
                .toolbar(removing: .sidebarToggle)
                .navigationSplitViewColumnWidth(min: 180, ideal: 260, max: 500)
        } detail: {
            NavigationStack(path: navigationPathBinding) {
                pageFrame(for: model.navigationRoot)
                    .navigationDestination(for: WorkspaceLocation.self) { location in
                        pageFrame(for: location)
                    }
            }
            .id(model.selectedTabID)
        }
        .toolbarBackgroundVisibility(.hidden, for: .windowToolbar)
#endif
    }

#if os(iOS)
    private var iosSidebarDrawer: some View {
        GeometryReader { geometry in
            let drawerWidth = min(430, max(280, geometry.size.width - 28))
            ZStack(alignment: .leading) {
                Color.black.opacity(0.22 * sidebarRevealProgress)
                    .ignoresSafeArea()
                    .contentShape(.rect)
                    .onTapGesture { closeIOSSidebar() }

                VStack(spacing: 0) {
                    sidebarContent
                }
                .frame(width: drawerWidth)
                .frame(maxHeight: .infinity)
                .background {
                    Rectangle()
                        .fill(.regularMaterial)
                        .ignoresSafeArea()
                }
                .overlay(alignment: .trailing) { Divider() }
                .offset(x: -drawerWidth * (1 - sidebarRevealProgress))
                .simultaneousGesture(closeSidebarDragGesture)
            }
            .allowsHitTesting(sidebarRevealProgress > 0)
            .onAppear { sidebarDrawerWidth = drawerWidth }
            .onChange(of: drawerWidth) { _, width in sidebarDrawerWidth = width }
        }
    }

    private var openSidebarEdgeGesture: some Gesture {
        DragGesture(minimumDistance: 18, coordinateSpace: .global)
            .onChanged { value in
                guard value.startLocation.x <= 22,
                      value.translation.width > 0,
                      abs(value.translation.width) > abs(value.translation.height) else { return }
                var transaction = Transaction()
                transaction.animation = nil
                withTransaction(transaction) {
                    sidebarRevealProgress = min(1, value.translation.width / sidebarDrawerWidth)
                }
            }
            .onEnded { value in
                guard value.startLocation.x <= 22,
                      abs(value.translation.width) > abs(value.translation.height) else {
                    return
                }
                let shouldOpen = value.translation.width > 96
                    || value.predictedEndTranslation.width > 170
                sidebarSearchFocused = false
                withAnimation(.snappy(duration: 0.28)) {
                    sidebarRevealProgress = shouldOpen ? 1 : 0
                }
            }
    }

    private var closeSidebarDragGesture: some Gesture {
        DragGesture(minimumDistance: 18)
            .onChanged { value in
                guard value.translation.width < 0,
                      abs(value.translation.width) > abs(value.translation.height) else { return }
                sidebarDismissDragSuppressesTap = true
                var transaction = Transaction()
                transaction.animation = nil
                withTransaction(transaction) {
                    sidebarRevealProgress = max(0, 1 + value.translation.width / sidebarDrawerWidth)
                }
            }
            .onEnded { value in
                let shouldClose = value.translation.width < -96
                    || value.predictedEndTranslation.width < -170
                sidebarSearchFocused = false
                withAnimation(.snappy(duration: 0.28)) {
                    sidebarRevealProgress = shouldClose ? 0 : 1
                }
                Task { @MainActor in
                    try? await Task.sleep(for: .milliseconds(180))
                    sidebarDismissDragSuppressesTap = false
                }
            }
    }

    private func closeIOSSidebar() {
        sidebarSearchFocused = false
        withAnimation(.snappy(duration: 0.28)) {
            sidebarRevealProgress = 0
        }
    }
#endif

    private var sidebarContent: some View {
#if os(macOS)
        VStack(spacing: 0) {
            if !sidebarTitlebarAccessoryInstalled {
                sidebarPagesHeader
            }
            sidebarList
        }
        .background {
            GeometryReader { geometry in
                MacSidebarTitlebarAccessory(
                    width: geometry.size.width,
                    isVisible: columnVisibility != .detailOnly,
                    installed: $sidebarTitlebarAccessoryInstalled
                ) {
                    sidebarPagesHeader
                }
                .frame(width: 0, height: 0)
            }
        }
#else
        VStack(spacing: 0) {
            sidebarPagesHeader
            sidebarList
        }
#endif
    }

    private var sidebarList: some View {
        List {
            if sidebarPageOrder == .recent {
                recentSidebarRows
            } else if sidebarPageOrder == .linkCount {
                linkCountSidebarRows
            } else {
                Section {
                    if !sidebarSearchText.isEmpty {
                        searchSidebarRows
                    } else {
                        sidebarChildRows
                    }
                }
            }
        }
        .listStyle(.sidebar)
#if os(iOS)
        .contentMargins(.top, 0, for: .scrollContent)
#endif
        .overlay {
            if sidebarPageOrder == .alphabetical
                && sidebarSearchText.isEmpty
                && model.children.isEmpty {
                ContentUnavailableView("No children", systemImage: "tree")
                    .allowsHitTesting(false)
            } else if (sidebarPageOrder != .alphabetical || !sidebarSearchText.isEmpty)
                && model.searchResults.isEmpty {
                ContentUnavailableView.search(text: sidebarSearchText)
                    .allowsHitTesting(false)
            }
        }
    }

    private var sidebarPagesHeader: some View {
        HStack(spacing: 6) {
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(.secondary)
                TextField("Search pages", text: $sidebarSearchText)
                    .textFieldStyle(.plain)
                    .focused($sidebarSearchFocused)
                if !sidebarSearchText.isEmpty {
                    Button {
                        sidebarSearchText = ""
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(.tertiary)
                    }
                    .buttonStyle(.plain)
                    .help("Clear Search")
                    .accessibilityLabel("Clear Search")
                }
            }
            .padding(.horizontal, 8)
#if os(macOS)
            .frame(height: 28)
#else
            .frame(height: 40)
#endif
            .background {
                RoundedRectangle(cornerRadius: sidebarSearchCornerRadius, style: .continuous)
                    .fill(Color.primary.opacity(sidebarSearchFocused ? 0.065 : 0.035))
                    .overlay {
                        RoundedRectangle(cornerRadius: sidebarSearchCornerRadius, style: .continuous)
                            .stroke(
                                Color.primary.opacity(sidebarSearchFocused ? 0.18 : 0.075),
                                lineWidth: 0.75
                            )
                    }
            }

#if os(macOS)
            MacPageOrderPicker(selection: $sidebarPageOrder)
                .frame(width: 32, height: 32)
                .mutedMacToolbarHover()
                .help("Page order: \(sidebarPageOrder.label)")
#else
            Menu {
                ForEach(ArborSidebarPageOrder.allCases) { order in
                    Button {
                        selectSidebarPageOrder(order)
                    } label: {
                        Label(order.label, systemImage: order.symbol)
                    }
                }
            } label: {
                Image(systemName: sidebarPageOrder.symbol)
                    .foregroundStyle(.secondary)
                    .frame(width: 24, height: 24)
            }
            .buttonStyle(.glass)
            .buttonBorderShape(.circle)
            .frame(width: 48, height: 48)
            .contentShape(.circle)
            .tint(.gray)
            .accessibilityLabel("Page order")
            .accessibilityValue(sidebarPageOrder.label)

#endif
        }
#if os(macOS)
        .padding(.leading, 8)
        .padding(.trailing, 8)
        .frame(height: 52)
#else
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
#endif
        .onChange(of: sidebarSearchText) { _, query in
            Task { await model.search(query) }
        }
        .task(id: sidebarPageOrder) {
            guard sidebarPageOrder != .alphabetical || !sidebarSearchText.isEmpty else { return }
            await model.search(sidebarSearchText)
        }
    }

    private var sidebarSearchCornerRadius: CGFloat {
#if os(macOS)
        7
#else
        10
#endif
    }

    private func selectSidebarPageOrder(_ order: ArborSidebarPageOrder) {
        sidebarPageOrder = order
        guard order != .alphabetical || !sidebarSearchText.isEmpty else { return }
        Task { await model.search(sidebarSearchText) }
    }

    @ViewBuilder
    private var searchSidebarRows: some View {
        ForEach(ArborSidebarPages.sorted(model.searchResults, by: .alphabetical)) { result in
            sidebarSearchRow(result, showsBacklinkCount: false)
        }
    }

    @ViewBuilder
    private var recentSidebarRows: some View {
        ForEach(ArborSidebarPages.recentGroups(model.searchResults)) { group in
            Section {
                ForEach(group.results) { result in
                    sidebarSearchRow(result, showsBacklinkCount: false)
                }
            } header: {
                Text(group.title)
                    .padding(.top, group.title == "Today" ? 12 : 6)
            }
        }
    }

    @ViewBuilder
    private var linkCountSidebarRows: some View {
        ForEach(ArborSidebarPages.linkCountGroups(model.searchResults)) { group in
            Section {
                ForEach(group.results) { result in
                    sidebarSearchRow(result, showsBacklinkCount: group.showsBacklinkCounts)
                }
            } header: {
                Text(group.title)
                    .padding(.top, group.title == "0 Links" ? 12 : 6)
            }
        }
    }

    private func sidebarSearchRow(
        _ result: WorkspaceSearchResult,
        showsBacklinkCount: Bool
    ) -> some View {
        ArborSidebarSearchRow(result: result, showsBacklinkCount: showsBacklinkCount) {
            openFromSidebar(.reference(result.reference))
        }
    }

    @ViewBuilder
    private var sidebarChildRows: some View {
        ForEach(model.children) { node in
            ArborSidebarRow(
                node: node,
                isCurrent: isCurrent(node.location),
                open: { openFromSidebar(node.location) },
                openInNewTab: { Task { await model.openInNewTab(node.location) } },
                trash: { Task { await model.perform(.trash(reference: node.reference), navigateToResult: false) } }
            )
        }
    }

#if os(macOS)
    @ViewBuilder
    private func detailPathHeading(for location: WorkspaceLocation) -> some View {
        let path = location.path
        let components = path.split(separator: "/")
        HStack(spacing: 5) {
            if let parent = location.parent, let leaf = components.last {
                Button {
                    openFromSidebar(parent)
                } label: {
                    Text(components.count == 1
                        ? "/"
                        : "/" + components.dropLast().joined(separator: "/"))
                        .fontWeight(.light)
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
                .help("Go to Parent")
                if components.count > 1 {
                    Text("/")
                        .foregroundStyle(.secondary)
                }
                Text(String(leaf))
            } else {
                Text(path)
            }
        }
        .font(.system(size: 15, weight: .regular))
        .padding(.leading, 8)
        .lineLimit(1)
        .truncationMode(.head)
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
        guard !sidebarDismissDragSuppressesTap else { return }
        closeIOSSidebar()
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
            toggleSidebar: {
#if os(macOS)
                withAnimation {
                    columnVisibility = columnVisibility == .detailOnly ? .all : .detailOnly
                }
#endif
            },
            sidebarPageOrder: sidebarPageOrder,
            setSidebarPageOrder: { order in
                sidebarPageOrder = order
#if os(macOS)
                if columnVisibility == .detailOnly {
                    withAnimation { columnVisibility = .all }
                }
#endif
            },
            goHome: { Task { await model.goHome() } },
            goBack: { Task { await model.goBack() } },
            goForward: { Task { await model.goForward() } },
            goParent: { Task { await model.goParent() } },
            newTab: { Task { await model.newTab() } },
            closeTab: { Task { await model.closeSelectedTab() } },
            newDocument: { presentedSheet = .createMarkdown },
            newFolder: { presentedSheet = .createDirectory },
            openLocation: { presentedSheet = .openLocation },
            showSearch: { searchPresented = true },
            recordAudio: { editorCommands in
                Task { await toggleVoiceRecording(editorCommands: editorCommands) }
            },
            recordAudioLabel: voiceRecordingCommandLabel,
            share: { sharePresented = true },
            localTrees: localTreeMenuItems,
            jumpToLocalTree: { path in
                Task { await model.navigate(to: .local(path)) }
            },
            showHistory: { Task { await model.loadHistory(); presentedSheet = .history } },
            showSource: { Task { await model.inspectSource(); presentedSheet = .source } },
            showSyncStatus: showStatusPanel,
            showAccounts: showAccountsPanel,
            movePage: { Task { _ = await model.editorHost?.moveCurrentDocument() } },
            movePageToTrash: { trashConfirmationPresented = true },
            restorePage: {
                Task { await model.perform(.restore(reference: model.currentReference)) }
            },
            canGoBack: model.canGoBack,
            canGoForward: model.canGoForward,
            canGoParent: model.canGoParent,
            canGoHome: model.canGoHome,
            canCloseTab: model.tabItems.count > 1,
            hasDocument: model.binding != nil,
            hasNode: model.node != nil,
            canRecordAudio: recordingSession.state != .idle || (
                model.node?.isWritable == true && model.binding != nil
            ),
            canShare: model.node != nil,
            canMovePage: model.node?.isWritable == true
                && model.binding != nil
                && model.currentReference.path != "/"
                && !model.currentReference.path.hasPrefix("/Trash/"),
            canMovePageToTrash: model.node?.isWritable == true
                && model.currentReference.path != "/"
                && !model.currentReference.path.hasPrefix("/Trash/"),
            canRestorePage: model.node?.isWritable == true
                && model.currentReference.path.hasPrefix("/Trash/")
        )
    }

    private var voiceRecordingCommandLabel: String {
        switch recordingSession.state {
        case .idle: recordingSession.isTransitioning ? "Starting Recording" : "Record Audio"
        case .recording: "Stop Recording"
        case .transcribing: "Cancel Transcription"
        }
    }

    private func toggleVoiceRecording(editorCommands: EditorCommands?) async {
        switch recordingSession.state {
        case .idle:
            let target = editorCommands?.activeEditingBlock()
            var inlineDelivery: VoiceTranscriptDelivery<String>?
            if let target {
                inlineDelivery = { transcript, destination in
                    if editorCommands?.insertText(transcript, target) == true { return }
                    try await workspace.deliverVoiceTranscript(transcript, to: destination)
                }
            }
            await model.startVoiceRecording(recordingSession, delivery: inlineDelivery)
        case .recording:
            await recordingSession.stopAndDeliver()
        case .transcribing:
            recordingSession.cancelTranscription()
        }
    }

    private var localTreeMenuItems: [ArborLocalTreeMenuItem] {
#if os(macOS)
        (workspace.localArborSyncOverview?.trees ?? []).compactMap { tree in
            guard let path = tree.path else { return nil }
            return ArborLocalTreeMenuItem(
                id: tree.id,
                title: localTreeTitle(tree),
                path: path,
                isCurrent: tree.id == model.currentReference.tree.rawValue
            )
        }
#else
        []
#endif
    }

    private var syncTreeStatuses: [ArborTreeSyncStatus] {
#if os(macOS)
        let overview = workspace.localArborSyncOverview
        return (overview?.trees ?? []).map { tree in
            let account = overview?.accounts.first {
                $0.configurationTree == tree.configurationTree || $0.configurationTree == tree.id
            }
            let title: String
            if tree.id == account?.profileTree {
                title = "Profile"
            } else if tree.kind == "account-configuration" {
                title = "\(account?.arborDisplayName ?? "Canopy account") settings"
            } else {
                title = tree.canonicalPath ?? tree.name
            }
            let location = tree.kind == "account-configuration"
                ? "Account settings"
                : tree.path ?? tree.canonicalPath ?? tree.id
            let detail = [account?.arborDisplayName, location, tree.access?.capitalized]
                .compactMap { $0 }
                .joined(separator: " · ")
            return ArborTreeSyncStatus(
                id: tree.id,
                title: title,
                detail: detail,
                condition: localTreeCondition(tree)
            )
        }
#else
        return []
#endif
    }

#if os(macOS)
    private func localTreeTitle(_ tree: LocalArborSyncTreePresentation) -> String {
        guard tree.kind == "account-configuration" else {
            return tree.canonicalPath ?? tree.name
        }
        let account = workspace.localArborSyncOverview?.accounts.first {
            $0.configurationTree == tree.id
        }
        return "\(account?.arborDisplayName ?? "Canopy account") settings"
    }

    private func localTreeCondition(_ tree: LocalArborSyncTreePresentation) -> String {
        if tree.missing { return "Missing" }
        switch tree.sync {
        case "conflict": return "Conflict"
        case "error": return "Error"
        case "offline": return "Offline"
        case "syncing": return "Syncing"
        default:
            if tree.placement == "remote" || tree.path == nil { return "Not placed" }
            return "Up to date"
        }
    }

    private var macManagementPanel: some View {
        VStack(spacing: 0) {
            Picker("View", selection: $managementTab) {
                Text("Accounts").tag(MacManagementTab.accounts)
                Text("Sync Status").tag(MacManagementTab.status)
            }
            .labelsHidden()
            .pickerStyle(.segmented)
            .frame(width: 240)
            .padding(.vertical, 10)

            Divider()

            switch managementTab {
            case .accounts:
                MacArborSyncAccountPanel(
                    workspace: workspace,
                    openProfile: { tree in
                        profileAfterManagementDismiss = WorkspaceReference(
                            tree: TreeID(rawValue: tree),
                            path: "/"
                        )
                        managementPresented = false
                    }
                )
            case .status:
                syncStatusPanel
            }
        }
        .frame(minWidth: 600, minHeight: 520)
    }

    private func finishManagementDismissal() {
        if let profile = profileAfterManagementDismiss {
            profileAfterManagementDismiss = nil
            Task { await model.navigate(to: profile) }
        } else if let sheet = sheetAfterManagementDismiss {
            sheetAfterManagementDismiss = nil
            presentedSheet = sheet
        }
    }
#endif

    private func showStatusPanel() {
#if os(macOS)
        managementTab = .status
        managementPresented = true
        Task {
            await workspace.refreshLocalArborSyncOverview()
            await workspace.preloadLocalCanopyDevices()
        }
#else
        presentedSheet = .syncStatus
#endif
    }

    private func showAccountsPanel() {
#if os(macOS)
        managementTab = .accounts
        managementPresented = true
        Task {
            await workspace.refreshLocalArborSyncOverview()
            await workspace.preloadLocalCanopyDevices()
        }
#else
        accountPresented = true
#endif
    }

    private var syncStatusPanel: some View {
        ArborSyncStatusView(
            provider: workspace.providerDetail,
            sync: workspace.syncPresentation,
            binding: model.binding,
            arborsyncProcessKind: workspace.arborsyncProcessKind,
            treeStatuses: syncTreeStatuses,
            retrySave: { Task { await model.retryDocumentSave() } },
            syncNow: { Task { await workspace.syncNow() } },
            reconnectArborSync: {
#if os(macOS)
                Task { await workspace.restartArborSync() }
#endif
            },
            showArborSyncLogs: {
#if os(macOS)
                Task { @MainActor in
                    arborsyncLogs = await workspace.arborsyncLogs()
                    sheetAfterManagementDismiss = .arborsyncLogs
                    managementPresented = false
                }
#endif
            }
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
                ZStack(alignment: .top) {
                    attentionBanner
                        .padding(.horizontal, 16)
                        .frame(maxWidth: 560)
                        .padding(.top, 8)
#if os(iOS)
                    if topOverscrollProgress > 0.02 {
                        IOSTopOverscrollIndicator(
                            progress: topOverscrollProgress,
                            isArmed: topOverscrollArmed
                        )
                        .offset(y: 4 + elasticOverscrollIndicatorTravel)
                        .opacity(min(1, topOverscrollProgress * 2.6))
                        .transition(.scale(scale: 0.85).combined(with: .opacity))
                    }
#endif
                }
            }
        }
        .animation(.easeInOut(duration: 0.2), value: model.binding?.conflict != nil)
        .animation(.easeInOut(duration: 0.2), value: workspace.syncConflict != nil)
#if os(macOS)
        .navigationTitle("")
#endif
        .toolbar {
#if os(macOS)
            ToolbarItem(placement: .navigation) {
                Button {
                    withAnimation {
                        columnVisibility = columnVisibility == .detailOnly ? .all : .detailOnly
                    }
                } label: {
                    Image(systemName: columnVisibility == .detailOnly
                        ? "chevron.right.2"
                        : "chevron.left.2")
                        .font(.system(size: 11, weight: .regular))
                        .foregroundStyle(mutedMacToolbarForeground)
                        .frame(width: 32, height: 32)
                        .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .mutedMacToolbarHover()
                .help(columnVisibility == .detailOnly ? "Show Sidebar" : "Hide Sidebar")
                .accessibilityLabel(columnVisibility == .detailOnly ? "Show Sidebar" : "Hide Sidebar")
            }
            .sharedBackgroundVisibility(.hidden)
            ToolbarItem(placement: .navigation) {
                detailPathHeading(for: location)
            }
            .sharedBackgroundVisibility(.hidden)
#endif
            ToolbarItemGroup(placement: .primaryAction) {
#if os(iOS)
                ArborEditorUndoButtons()
                if let presentation = model.pagePresentation(for: location),
                   presentation.node.isWritable,
                   presentation.editorLease != nil {
                    ArborVoiceRecordingToolbarButton(
                        session: recordingSession,
                        model: model,
                        workspace: workspace
                    )
                    .disabled(location != model.currentLocation)
                }
                Button("Share", systemImage: "square.and.arrow.up") {
                    sharePresented = true
                }
#else
                HStack(spacing: 4) {
                    if let presentation = model.pagePresentation(for: location),
                       presentation.node.isWritable,
                       presentation.editorLease != nil {
                        ArborVoiceRecordingToolbarButton(
                            session: recordingSession,
                            model: model,
                            workspace: workspace
                        )
                        .disabled(location != model.currentLocation)
                        .frame(width: 32, height: 32)
                        .mutedMacToolbarHover()
                    }
                    Button {
                        sharePresented = true
                    } label: {
                        mutedMacToolbarIcon("square.and.arrow.up")
                            .offset(y: -0.5)
                    }
                    .help("Share")
                    .accessibilityLabel("Share")
                    .frame(width: 32, height: 32)
                    .mutedMacToolbarHover()
                    .popover(isPresented: $sharePresented, arrowEdge: .top) {
                        ArborSharePanel(workspace: workspace, currentNode: model.node)
                            .onExitCommand { sharePresented = false }
                    }
                    Button {
                        showAccountsPanel()
                    } label: {
                        mutedMacToolbarIcon("person.crop.circle")
                    }
                    .help("Accounts")
                    .accessibilityLabel("Accounts")
                    .frame(width: 32, height: 32)
                    .mutedMacToolbarHover()
                }
                .buttonStyle(.plain)
                .foregroundStyle(mutedMacToolbarForeground)
                .fixedSize(horizontal: true, vertical: true)
#endif
            }
#if os(macOS)
            .sharedBackgroundVisibility(.hidden)
#endif
        }
    }

#if os(macOS)
    private var mutedMacToolbarForeground: Color {
        Color.secondary.opacity(0.78)
    }

    private func mutedMacToolbarIcon(_ name: String) -> some View {
        Image(systemName: name)
            .font(.system(size: 14, weight: .regular))
            .foregroundStyle(mutedMacToolbarForeground)
            .frame(width: 32, height: 32)
            .contentShape(.rect)
    }
#endif

    private var editorTopOverscrollAction: EditorTopOverscrollAction? {
#if os(iOS)
        EditorTopOverscrollAction(
            threshold: 112,
            onProgress: { progress, isArmed in
                if isArmed && !topOverscrollArmed {
                    UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                }
                topOverscrollProgress = progress
                topOverscrollArmed = isArmed
            },
            onRelease: { committed in
                topOverscrollProgress = 0
                topOverscrollArmed = false
                if committed {
                    treeAccountSwitcherPresented = true
                }
            }
        )
#else
        nil
#endif
    }

#if os(iOS)
    private var elasticOverscrollIndicatorTravel: CGFloat {
        CGFloat(34 * (1 - exp(-2.4 * Double(topOverscrollProgress))))
    }
#endif

    @ViewBuilder
    private func pageFrameContent(for location: WorkspaceLocation) -> some View {
        if let presentation = model.pagePresentation(for: location) {
            let node = presentation.node
            if node.surface.supportsDocumentSession, node.isWritable {
                if let lease = presentation.editorLease, let host = presentation.editorHost {
                    VStack(spacing: 0) {
                        if location == model.currentLocation,
                           documentConflictExpanded,
                           let conflict = lease.binding.conflict {
                            ArborDocumentConflictView(
                                conflict: conflict,
                                resolve: { source in
                                    Task { await model.resolveEditorConflict(source: source) }
                                },
                                close: { documentConflictExpanded = false }
                            )
                            .id(conflict)
                            Divider()
                        }
                        ArborEditorSurface(
                            binding: lease.binding,
                            host: host,
                            configuration: ArborStyle.editorConfiguration,
                            pinchDictation: pinchDictation,
                            topOverscrollAction: editorTopOverscrollAction
                        ) {
                            ArborDocumentFooter(
                                provider: workspace.providerDetail,
                                sync: workspace.syncPresentation,
                                binding: lease.binding,
                                backlinks: presentation.backlinks,
                                open: { destination in Task { await model.navigate(to: destination) } },
                                showStatus: showStatusPanel
                            )
                        }
                    }
                } else {
                    ProgressView()
                }
            } else {
                WorkspaceSurfaceView(node: node)
            }
        } else if location == model.currentLocation, let message = model.errorMessage {
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
            syncStatusPanel
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
        case .markdown, .directory, .directoryDocument, .collection: return node.reference
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
            let analysis = ArborDocumentConflictAnalysis(conflict)
            ArborAttentionBanner(
                message: analysis.headline,
                systemImage: "exclamationmark.triangle",
                primaryLabel: documentConflictExpanded ? "Hide" : "Review…",
                primaryAction: { documentConflictExpanded.toggle() },
                secondaryLabel: analysis.automaticMergeSource == nil ? nil : "Merge",
                secondaryAction: analysis.automaticMergeSource.map { source in
                    { Task { await model.resolveEditorConflict(source: source) } }
                }
            )
            .help("\(analysis.explanation) Current revision: \(conflict.current.contentRevision)")
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
                secondaryAction: showStatusPanel
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

private struct ArborSharePanel: View {
    @Environment(\.dismiss) private var dismiss
    let workspace: ArborWorkspaceState
    let currentNode: WorkspaceNode?
    @State private var presentation: ArborSharePresentation?
    @State private var loading = true
    @State private var busy = false
    @State private var message: String?
    @State private var profileLocator = ""
    @State private var selectedAccountID = ""
    @State private var canonicalURL = ""
    @State private var promotionAccess = "none"

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                HStack(alignment: .firstTextBaseline, spacing: 16) {
                    Text("Share")
                        .font(.title2.bold())
                    Spacer(minLength: 12)
                    if let displayedCanonical {
                        Text(displayedCanonical)
                            .font(.callout)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                            .textSelection(.enabled)
                    }
                }
                .padding(.horizontal)
                .padding(.vertical, 12)
                Divider()
                Form {
                    if let presentation {
                        switch presentation {
                        case .tracked(let access):
                            trackedTree(access)
                        case .promotable(let path, let accounts):
                            promotion(path: path, accounts: accounts)
                        }
                    } else if loading {
                        Section { ProgressView("Loading sharing…") }
                    }
                    if let message {
                        Section { Text(message).foregroundStyle(.red) }
                    }
                }
            }
#if os(iOS)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
#endif
        }
#if os(macOS)
        .frame(width: 520, height: fittedMacHeight)
        .formStyle(.grouped)
#endif
        .task { await load() }
        .onChange(of: selectedAccountID) { _, id in
            guard case let .promotable(path, accounts) = presentation,
                  let account = accounts.first(where: { $0.id == id }) else { return }
            canonicalURL = suggestedCanonical(path: path, account: account)
        }
    }

    private var displayedCanonical: String? {
        guard case let .tracked(access) = presentation else { return nil }
        return access.canonical
    }

#if os(macOS)
    private var fittedMacHeight: CGFloat {
        let messageHeight: CGFloat = message == nil ? 0 : 52
        switch presentation {
        case .tracked(let access):
            let people = access.entries.filter { $0.subject != .everyone }.count
            let rows = people + 1
            return min(640, max(300, 190 + CGFloat(rows) * 62 + messageHeight))
        case .promotable(_, let accounts):
            return accounts.isEmpty ? 300 + messageHeight : 430 + messageHeight
        case nil:
            return 190 + messageHeight
        }
    }
#endif

    @ViewBuilder
    private func trackedTree(_ access: NativeTreeAccessPresentation) -> some View {
        Section {
            HStack(spacing: 10) {
                TextField(
                    "Add people or groups",
                    text: $profileLocator,
                    prompt: Text("~handle or Arbor profile URL")
                )
                .textFieldStyle(.roundedBorder)
#if os(iOS)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
#endif
                .onSubmit { shareInvites(access) }
                .disabled(busy || !access.canEdit)
                Button("Share") { shareInvites(access) }
                    .buttonStyle(.borderedProminent)
                    .disabled(busy || !access.canEdit || inviteLocators.isEmpty)
            }
        } footer: {
            if !access.canEdit {
#if os(iOS)
                Text("This iPhone needs administrator access to share. On a Mac, open Account and make this device an administrator.")
#else
                Text("This Mac needs administrator access to share.")
#endif
            }
        }
        Section {
            ForEach(access.entries.filter { $0.subject != .everyone }) { entry in
                accessRow(entry, in: access)
            }
            if let everyone = access.entries.first(where: { $0.subject == .everyone }) {
                accessRow(everyone, in: access)
            } else {
                everyoneRow(in: access)
            }
        } header: {
            Text("Who has access")
        } footer: {
            if !access.canEdit {
                Text("Only an administrator for this Canopy account can change access.")
            }
        }
    }

    private func accessRow(
        _ entry: NativeTreeAccessEntry,
        in access: NativeTreeAccessPresentation
    ) -> some View {
        HStack(spacing: 12) {
            accessIcon(for: entry)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 4) {
                    Text(label(for: entry))
                    if entry.isCurrentUser {
                        Text("(You)").foregroundStyle(.secondary)
                    }
                }
                Text(detail(for: entry))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            if entry.isCurrentUser {
                HStack(spacing: 5) {
                    Text("Full access")
                    Image(systemName: "lock.fill").font(.caption)
                }
                .foregroundStyle(.secondary)
                .help("Your access cannot be removed")
            } else if access.canEdit {
                accessMenu(
                    current: entry.access,
                    set: { permission in
                        Task { await change(access, target: .existing(entry.subject), permission: permission) }
                    }
                )
                .disabled(busy)
            } else {
                Text(permissionLabel(entry.access)).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
    }

    private func everyoneRow(in access: NativeTreeAccessPresentation) -> some View {
        HStack(spacing: 12) {
            accessIcon(systemName: "globe", tint: .blue)
            VStack(alignment: .leading, spacing: 2) {
                Text("Everyone")
                Text("Anyone who can find this tree")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            if access.canEdit {
                accessMenu(
                    current: "none",
                    set: { permission in
                        guard permission != "none" else { return }
                        Task { await change(access, target: .everyone, permission: permission) }
                    }
                )
                .disabled(busy)
            } else {
                Text("No access").foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
    }

    private func accessIcon(for entry: NativeTreeAccessEntry) -> some View {
        switch entry.subject {
        case .everyone:
            accessIcon(systemName: "globe", tint: .blue)
        case .profile:
            accessIcon(systemName: entry.isCurrentUser ? "person.crop.circle.fill" : "person.2.fill", tint: .indigo)
        case .link:
            accessIcon(systemName: "link", tint: .orange)
        }
    }

    private func accessIcon(systemName: String, tint: Color) -> some View {
        Image(systemName: systemName)
            .foregroundStyle(tint)
            .frame(width: 38, height: 38)
            .background(tint.opacity(0.12), in: Circle())
    }

    private func accessMenu(current: String, set: @escaping (String) -> Void) -> some View {
        Menu {
            Button {
                set("read")
            } label: {
                if current == "read" { Label("Can view", systemImage: "checkmark") }
                else { Text("Can view") }
            }
            Button {
                set("write")
            } label: {
                if current == "write" { Label("Can edit", systemImage: "checkmark") }
                else { Text("Can edit") }
            }
            if current != "none" {
                Divider()
                Button("Remove access", role: .destructive) { set("none") }
            }
        } label: {
            HStack(spacing: 5) {
                Text(permissionLabel(current))
                Image(systemName: "chevron.down").font(.caption)
            }
            .foregroundStyle(.secondary)
        }
        .fixedSize()
    }

    @ViewBuilder
    private func promotion(path: String, accounts: [ArborShareAccount]) -> some View {
        Section("Upgrade this folder") {
            LabeledContent("Folder", value: path)
            Text("The folder stays in place and gains its own Arbor identity, history, synchronization, and access controls.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        if accounts.isEmpty {
            Section {
                ContentUnavailableView(
                    "No connected Canopy account",
                    systemImage: "person.crop.circle.badge.exclamationmark",
                    description: Text("Connect an administrator account before upgrading this folder.")
                )
            }
        } else {
            Section("Destination") {
                Picker("Account", selection: $selectedAccountID) {
                    ForEach(accounts) { account in
                        Text(account.handle.map { "~\($0) · \(URL(string: account.origin)?.host ?? account.origin)" }
                            ?? account.origin)
                            .tag(account.id)
                    }
                }
                TextField("Canonical URL", text: $canonicalURL)
                Picker("Initial access", selection: $promotionAccess) {
                    Text("Private").tag("none")
                    Text("Everyone can view").tag("read")
                    Text("Everyone can edit").tag("write")
                }
                Button("Make This an Arbor Tree", systemImage: "tree") {
                    guard let account = accounts.first(where: { $0.id == selectedAccountID }) else { return }
                    Task { await promote(path: path, account: account) }
                }
                .disabled(busy || selectedAccountID.isEmpty || canonicalURL.isEmpty)
            }
        }
    }

    private func label(for entry: NativeTreeAccessEntry) -> String {
        switch entry.subject {
        case .everyone: "Everyone"
        case .profile: entry.displayName ?? "Person or group"
        case .link: "Private link"
        }
    }

    private func detail(for entry: NativeTreeAccessEntry) -> String {
        if entry.isCurrentUser { return "Owner" }
        switch entry.subject {
        case .everyone: return "Anyone who can find this tree"
        case .link: return "Existing access-link grant"
        case .profile(let tree): return entry.locator ?? (entry.displayName == nil ? tree : "Person or group")
        }
    }

    private func permissionLabel(_ permission: String) -> String {
        switch permission {
        case "read": "Can view"
        case "write": "Can edit"
        default: "No access"
        }
    }

    private var inviteLocators: [String] {
        ArborShareInvite.locators(in: profileLocator)
    }

    private func shareInvites(_ current: NativeTreeAccessPresentation) {
        let locators = inviteLocators
        guard !locators.isEmpty else { return }
        Task { await addProfiles(locators, to: current) }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        guard let currentNode else {
            message = "There is no current folder to share."
            return
        }
        do {
            let value = try await workspace.sharePresentation(for: currentNode)
            presentation = value
            message = nil
            if case let .promotable(path, accounts) = value, let first = accounts.first {
                selectedAccountID = first.id
                canonicalURL = suggestedCanonical(path: path, account: first)
            }
        } catch {
            message = error.localizedDescription
        }
    }

    private func change(
        _ current: NativeTreeAccessPresentation,
        target: NativeTreeAccessTarget,
        permission: String
    ) async {
        busy = true
        defer { busy = false }
        do {
            presentation = .tracked(try await workspace.setShareAccess(
                tree: current.tree,
                target: target,
                access: permission
            ))
            message = nil
        } catch {
            message = error.localizedDescription
        }
    }

    private func addProfiles(_ locators: [String], to current: NativeTreeAccessPresentation) async {
        busy = true
        defer { busy = false }
        var latest = current
        do {
            for locator in locators {
                latest = try await workspace.setShareAccess(
                    tree: latest.tree,
                    target: .profile(locator: locator),
                    access: "read"
                )
            }
            presentation = .tracked(latest)
            profileLocator = ""
            message = nil
        } catch {
            presentation = .tracked(latest)
            message = error.localizedDescription
        }
    }

    private func promote(path: String, account: ArborShareAccount) async {
#if os(macOS)
        busy = true
        defer { busy = false }
        do {
            try await workspace.promoteLocalFolder(
                path: path,
                account: account,
                canonical: canonicalURL,
                publicAccess: promotionAccess
            )
            dismiss()
        } catch {
            message = error.localizedDescription
        }
#endif
    }

    private func suggestedCanonical(path: String, account: ArborShareAccount) -> String {
        let name = URL(fileURLWithPath: path).lastPathComponent
            .lowercased()
            .replacingOccurrences(of: #"[^a-z0-9]+"#, with: "-", options: .regularExpression)
            .trimmingCharacters(in: CharacterSet(charactersIn: "-"))
        guard let handle = account.handle, !handle.isEmpty else { return account.origin + "/" + name }
        return account.origin + "/~" + handle + "/" + name
    }

}

#if os(macOS)
private struct DeviceDeauthorizationTarget: Identifiable {
    let configurationTree: String
    let deviceID: String
    let label: String
    var id: String { "\(configurationTree):\(deviceID)" }
}

private struct MacArborSyncAccountPanel: View {
    @Environment(\.dismiss) private var dismiss
    let workspace: ArborWorkspaceState
    let openProfile: (String) -> Void
    @State private var pairing: LocalArborSyncPairingPresentation?
    @State private var pairingConfigurationTree: String?
    @State private var changingDeviceID: String?
    @State private var deauthorizationTarget: DeviceDeauthorizationTarget?
    @State private var message: String?

    private var account: LocalArborSyncOverview? { workspace.localArborSyncOverview }
    private var activeDevices: [LocalArborSyncDevicePresentation] { account?.devices ?? [] }

    var body: some View {
        NavigationStack {
            Form {
                if let account {
                    if !account.accounts.isEmpty {
                        ForEach(account.accounts) { canopyAccount in
                            Section {
                                if let devices = workspace.localCanopyDevicesByConfigurationTree[canopyAccount.configurationTree] {
                                    ForEach(devices) { device in
                                        canopyDeviceRow(
                                            device,
                                            configurationTree: canopyAccount.configurationTree,
                                            devices: devices
                                        )
                                    }
                                } else {
                                    ProgressView("Loading devices…")
                                }
                                if pairingConfigurationTree == canopyAccount.configurationTree, let pairing {
                                    VStack(spacing: 10) {
                                        PairingQRCode(payload: pairing.payload)
                                            .frame(width: 220, height: 220)
                                        LabeledContent("Confirm on both devices", value: pairing.confirmationCode)
                                            .font(.headline.monospacedDigit())
                                    }
                                    .frame(maxWidth: .infinity)
                                }
                            } header: {
                                accountHeader(canopyAccount)
                            } footer: {
                                Button("Pair another device…") {
                                    Task { await createPairing(configurationTree: canopyAccount.configurationTree) }
                                }
                                .buttonStyle(.link)
                                .textCase(nil)
                                .disabled(!canopyAccount.credentialAvailable)
                            }
                        }
                    }
                    if account.accounts.isEmpty, account.handle != nil {
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
                            VStack(alignment: .leading, spacing: 8) {
                                Text("Each active device has its own server credential. Revoking one does not delete any tree data.")
                                Button("Pair another device…") { Task { await createPairing(configurationTree: nil) } }
                                    .buttonStyle(.link)
                                    .textCase(nil)
                            }
                        }
                    } else if account.accounts.isEmpty {
                        ContentUnavailableView(
                            "No Canopy account",
                            systemImage: "person.crop.circle.badge.questionmark",
                            description: Text("Claim or pair an account to manage its devices.")
                        )
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
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
        .frame(minWidth: 520, minHeight: 360)
        .formStyle(.grouped)
        .task {
            await Task.yield()
            await refresh()
        }
        .confirmationDialog(
            "Deauthorize \(deauthorizationTarget?.label ?? "device")?",
            isPresented: Binding(
                get: { deauthorizationTarget != nil },
                set: { if !$0 { deauthorizationTarget = nil } }
            ),
            presenting: deauthorizationTarget
        ) { target in
            Button("Deauthorize Device", role: .destructive) {
                Task { await deauthorize(target) }
            }
            Button("Cancel", role: .cancel) {}
        } message: { target in
            Text("\(target.label) will lose access to this account.")
        }
    }

    @ViewBuilder
    private func accountHeader(_ account: LocalCanopyAccountDescriptor) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(account.arborDisplayName)
                        .font(.headline)
                        .foregroundStyle(.primary)
                    Text(account.arborDisplayDetail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                if let profileTree = account.profileTree {
                    Button("Open profile") { openProfile(profileTree) }
                        .buttonStyle(.link)
                        .textCase(nil)
                }
            }
            Text("Devices")
                .font(.headline)
                .foregroundStyle(.primary)
                .padding(.top, 14)
        }
        .padding(.bottom, 3)
    }

    private func refresh() async {
        if workspace.localArborSyncOverview == nil {
            await workspace.restartArborSync()
        }
        await workspace.refreshLocalArborSyncOverview()
        guard let accounts = workspace.localArborSyncOverview?.accounts else { return }
        for account in accounts {
            do {
                _ = try await workspace.localCanopyDevices(configurationTree: account.configurationTree)
            } catch {
                message = error.localizedDescription
            }
        }
    }

    private func canopyDeviceRow(
        _ device: LocalArborSyncDevicePresentation,
        configurationTree: String,
        devices: [LocalArborSyncDevicePresentation]
    ) -> some View {
        let currentIsAdministrator = devices.first(where: \.isCurrent)?.isAdministrator == true
        let isLastAdministrator = device.isAdministrator
            && devices.filter(\.isAdministrator).count == 1
        return HStack {
            Text(device.label)
            Spacer(minLength: 12)
            HStack(spacing: 5) {
                if device.isCurrent {
                    statusTag("This Mac")
                } else if !device.isAdministrator {
                    statusTag("Active")
                }
                if device.isAdministrator {
                    statusTag("Administrator", emphasis: true)
                }
            }
            Menu {
                if !device.isCurrent, currentIsAdministrator {
                    Button(device.isAdministrator ? "Remove Administrator" : "Make Administrator") {
                        Task {
                            await changeAdministrator(
                                configurationTree: configurationTree,
                                device: device,
                                administrator: !device.isAdministrator
                            )
                        }
                    }
                    .disabled(changingDeviceID != nil || isLastAdministrator)
                    Divider()
                }
                Button("Deauthorize Device", role: .destructive) {
                    deauthorizationTarget = DeviceDeauthorizationTarget(
                        configurationTree: configurationTree,
                        deviceID: device.id,
                        label: device.label
                    )
                }
                .disabled(changingDeviceID != nil || isLastAdministrator || !currentIsAdministrator)
            } label: {
                Image(systemName: "ellipsis")
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .fixedSize()
        }
    }

    private func statusTag(_ title: String, emphasis: Bool = false) -> some View {
        Text(title)
            .font(.caption2.weight(.medium))
            .foregroundStyle(emphasis ? Color.accentColor : Color.secondary)
            .padding(.horizontal, 7)
            .padding(.vertical, 3)
            .background(
                (emphasis ? Color.accentColor : Color.secondary)
                    .opacity(0.1),
                in: Capsule()
            )
    }

    private func changeAdministrator(
        configurationTree: String,
        device: LocalArborSyncDevicePresentation,
        administrator: Bool
    ) async {
        changingDeviceID = device.id
        defer { changingDeviceID = nil }
        do {
            _ = try await workspace.setLocalCanopyDeviceAdministrator(
                configurationTree: configurationTree,
                deviceID: device.id,
                administrator: administrator
            )
            message = administrator
                ? "\(device.label) can now manage sharing."
                : "\(device.label) is no longer an administrator."
        } catch {
            message = error.localizedDescription
        }
    }

    private func createPairing(configurationTree: String?) async {
        do {
            let value = try await workspace.createLocalArborSyncPairing(configurationTree: configurationTree)
            pairing = value
            pairingConfigurationTree = configurationTree
            message = nil
        }
        catch { message = error.localizedDescription }
    }

    private func deauthorize(_ target: DeviceDeauthorizationTarget) async {
        changingDeviceID = target.deviceID
        defer {
            changingDeviceID = nil
            deauthorizationTarget = nil
        }
        do {
            _ = try await workspace.deauthorizeLocalCanopyDevice(
                configurationTree: target.configurationTree,
                deviceID: target.deviceID
            )
            message = "\(target.label) was deauthorized."
        } catch {
            message = error.localizedDescription
        }
    }

    private func revoke(_ id: String) async {
        do { try await workspace.revokeLocalArborSyncDevice(id) }
        catch { message = error.localizedDescription }
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
        case accounts
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
    @State private var accounts: [NativeCanopyAccount] = []
    @State private var identity: NativeProfileIdentity?
    @State private var accountURL = ""
    @State private var selectedConfigurationTree: String?
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
                await loadAccounts()
                phase = .accounts
            }
        }
    }

    @ViewBuilder
    private var onboarding: some View {
        switch phase {
        case .restoring:
            ProgressView("Opening Arbor…")
        case .accounts:
            accountList
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

    private var accountList: some View {
        NavigationStack {
            List {
                if let confirmationCode {
                    Section("Account added") {
                        LabeledContent("Confirm on your Mac", value: confirmationCode)
                            .font(.headline.monospacedDigit())
                    }
                }
                Section("Your identity") {
                    if let identity {
                        LabeledContent("Profile TreeID") {
                            Text(identity.profileTree)
                                .font(.caption.monospaced())
                                .textSelection(.enabled)
                        }
                        Button("Copy Profile TreeID", systemImage: "doc.on.doc") {
                            UIPasteboard.general.string = identity.profileTree
                        }
                        Text("Send this public ID to the Canopy administrator before claiming your account.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        TextField("https://canopy.example/~you", text: $accountURL)
                            .textInputAutocapitalization(.never)
                            .keyboardType(.URL)
                            .autocorrectionDisabled()
                        Button("Claim Account", systemImage: "person.badge.key") {
                            Task { await claimAccount() }
                        }
                        .disabled(accountURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    } else {
                        Text("Pair this iPhone from Arbor on a Mac to add an account.")
                            .foregroundStyle(.secondary)
                    }
                }
                Section("Accounts") {
                    ForEach(accounts) { account in
                        Button {
                            select(account)
                        } label: {
                            HStack {
                                VStack(alignment: .leading) {
                                    Text(account.arborDisplayName)
                                    Text(account.arborDisplayDetail)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                                Spacer()
                                Image(systemName: "folder.badge.plus")
                            }
                        }
                    }
                    if accounts.isEmpty {
                        Text("No Canopy accounts on this device yet.")
                            .foregroundStyle(.secondary)
                    }
                }
                Section {
                    Button("Add Account", systemImage: "qrcode.viewfinder") {
                        confirmationCode = nil
                        scanError = nil
                        phase = .scanning
                    }
                }
                if let scanError { Section { Text(scanError).foregroundStyle(.red) } }
            }
            .navigationTitle("Accounts")
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
            selectedConfigurationTree = await service.configurationID()
            confirmationCode = claim.confirmationCode
            scanError = nil
            await loadAccounts()
            phase = .accounts
        } catch {
            scanError = String(describing: error)
            phase = .scanning
        }
    }

    private func loadAccounts() async {
        do {
            identity = try await KeychainProfileIdentityStore().identity()
            accounts = try await KeychainDeviceCredentialStore().accounts()
            scanError = nil
        } catch {
            scanError = String(describing: error)
        }
    }

    private func claimAccount() async {
        let value = accountURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let account = URL(string: value),
              var components = URLComponents(url: account, resolvingAgainstBaseURL: false) else {
            scanError = "Enter a complete Canopy account URL."
            return
        }
        components.path = ""
        components.query = nil
        components.fragment = nil
        guard let origin = components.url else {
            scanError = "Enter a complete Canopy account URL."
            return
        }
        phase = .claiming
        do {
            let service = NativeAccountService(origin: origin)
            let label = UIDevice.current.name.isEmpty ? "iPhone" : UIDevice.current.name
            _ = try await service.claimAccount(account: account, label: label)
            self.service = service
            self.origin = origin
            selectedConfigurationTree = await service.configurationID()
            accountURL = ""
            scanError = nil
            await loadAccounts()
            phase = .accounts
        } catch {
            scanError = String(describing: error)
            phase = .accounts
        }
    }

    private func select(_ account: NativeCanopyAccount) {
        origin = account.origin
        selectedConfigurationTree = account.configurationTree
        service = NativeAccountService(origin: account.origin, configurationTree: account.configurationTree)
        phase = .choosing
        Task { await loadTrees() }
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
            try await workspace.place(tree: tree, from: origin, configurationTree: selectedConfigurationTree)
            ready = true
        } catch {
            treeError = String(describing: error)
            phase = .choosing
        }
    }

    private func resetForPairing() {
        service = nil
        origin = nil
        selectedConfigurationTree = nil
        confirmationCode = nil
        trees = []
        syncingTree = nil
        treeError = nil
        scanError = nil
        ready = false
        Task { await loadAccounts() }
        phase = .accounts
    }
}
#endif

#if os(iOS)
private struct IOSTopOverscrollIndicator: View {
    let progress: CGFloat
    let isArmed: Bool

    var body: some View {
        HStack(spacing: 9) {
            ZStack {
                Circle()
                    .stroke(.secondary.opacity(0.22), lineWidth: 2)
                Circle()
                    .trim(from: 0, to: min(1, progress))
                    .stroke(isArmed ? Color.accentColor : .secondary, style: StrokeStyle(lineWidth: 2, lineCap: .round))
                    .rotationEffect(.degrees(-90))
                Image(systemName: isArmed ? "checkmark" : "arrow.down")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(isArmed ? Color.accentColor : .secondary)
            }
            .frame(width: 24, height: 24)

            Text(isArmed ? "Release for Trees & Accounts" : "Pull for Trees & Accounts")
                .font(.subheadline.weight(.medium))
                .foregroundStyle(isArmed ? .primary : .secondary)
        }
        .padding(.horizontal, 13)
        .padding(.vertical, 8)
        .background(.regularMaterial, in: Capsule())
        .shadow(color: .black.opacity(0.12), radius: 8, y: 3)
        .allowsHitTesting(false)
        .accessibilityElement(children: .combine)
    }
}

private struct IOSTreeAccountGroup: Identifiable {
    let account: NativeCanopyAccount?
    let placements: [NativePlacementRecord]
    let fallbackID: String

    var id: String { account?.id ?? fallbackID }
    var title: String { account?.arborDisplayName ?? "Other Trees" }
    var detail: String? { account?.arborDisplayDetail }
}

private struct IOSTreeAccountSwitcher: View {
    @Environment(\.dismiss) private var dismiss
    let workspace: ArborWorkspaceState
    let currentTreeID: String
    let openAccounts: @MainActor () -> Void
    let placeTree: @MainActor () -> Void
    @State private var accounts: [NativeCanopyAccount] = []
    @State private var message: String?

    private var groups: [IOSTreeAccountGroup] {
        var output = accounts.map { account in
            IOSTreeAccountGroup(
                account: account,
                placements: sortedPlacements.filter { $0.configurationTree == account.configurationTree },
                fallbackID: account.configurationTree
            )
        }
        let knownIDs = Set(accounts.map(\.configurationTree))
        let unmatched = sortedPlacements.filter { placement in
            guard let configurationTree = placement.configurationTree else { return true }
            return !knownIDs.contains(configurationTree)
        }
        if !unmatched.isEmpty {
            output.append(IOSTreeAccountGroup(
                account: nil,
                placements: unmatched,
                fallbackID: "unmatched"
            ))
        }
        return output.filter { !$0.placements.isEmpty }
    }

    private var sortedPlacements: [NativePlacementRecord] {
        workspace.nativePlacements.sorted {
            ($0.tree.canonicalPath ?? $0.tree.id).localizedStandardCompare(
                $1.tree.canonicalPath ?? $1.tree.id
            ) == .orderedAscending
        }
    }

    var body: some View {
        NavigationStack {
            List {
                ForEach(groups) { group in
                    Section {
                        ForEach(group.placements, id: \.tree.id) { placement in
                            Button {
                                dismiss()
                                Task { await workspace.openNativePlacement(placement) }
                            } label: {
                                HStack {
                                    Label(
                                        placement.tree.canonicalPath ?? placement.tree.id,
                                        systemImage: placement.tree.id == currentTreeID ? "folder.fill" : "folder"
                                    )
                                    .lineLimit(1)
                                    Spacer()
                                    if placement.tree.id == currentTreeID {
                                        Image(systemName: "checkmark")
                                            .foregroundStyle(.secondary)
                                    }
                                }
                                .contentShape(.rect)
                            }
                            .buttonStyle(.plain)
                        }
                    } header: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(group.title)
                            if let detail = group.detail {
                                Text(detail)
                                    .font(.caption)
                                    .textCase(nil)
                            }
                        }
                    }
                }

                Section {
                    Button("Place Another Tree", systemImage: "folder.badge.plus") {
                        dismissThen(placeTree)
                    }
                    Button("Accounts", systemImage: "person.crop.circle") {
                        dismissThen(openAccounts)
                    }
                }

                if groups.isEmpty, message == nil {
                    Section {
                        ContentUnavailableView(
                            "No Trees on This iPhone",
                            systemImage: "tree",
                            description: Text("Place a tree to make it available here.")
                        )
                    }
                }
                if let message {
                    Section { Text(message).foregroundStyle(.red) }
                }
            }
            .navigationTitle("Trees & Accounts")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .task { await loadAccounts() }
    }

    private func loadAccounts() async {
        do {
            accounts = try await KeychainDeviceCredentialStore().accounts()
            message = nil
        } catch {
            message = error.localizedDescription
        }
    }

    private func dismissThen(_ action: @escaping @MainActor () -> Void) {
        dismiss()
        Task { @MainActor in
            await Task.yield()
            action()
        }
    }
}

private struct IOSPlaceTreePanel: View {
    @Environment(\.dismiss) private var dismiss
    let workspace: ArborWorkspaceState
    @State private var accounts: [NativeCanopyAccount] = []
    @State private var selectedAccount: NativeCanopyAccount?
    @State private var trees: [WireTreeDescriptor] = []
    @State private var loading = true
    @State private var placingTreeID: String?
    @State private var message: String?

    private var unplacedTrees: [WireTreeDescriptor] {
        let placed = Set(workspace.nativePlacements.map(\.tree.id))
        return trees.filter { $0.kind == "ordinary" && !placed.contains($0.id) }
    }

    var body: some View {
        NavigationStack {
            List {
                Section("Canopy account") {
                    ForEach(accounts) { account in
                        Button {
                            selectedAccount = account
                            Task { await loadTrees(for: account) }
                        } label: {
                            HStack {
                                VStack(alignment: .leading) {
                                    Text(account.arborDisplayName)
                                    Text(account.arborDisplayDetail)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                                Spacer()
                                if selectedAccount?.id == account.id {
                                    Image(systemName: "checkmark")
                                }
                            }
                        }
                    }
                    if accounts.isEmpty, !loading {
                        Text("Add a Canopy account from Accounts before placing another tree.")
                            .foregroundStyle(.secondary)
                    }
                }
                if selectedAccount != nil {
                    Section("Available trees") {
                        ForEach(unplacedTrees, id: \.id) { tree in
                            Button {
                                Task { await place(tree) }
                            } label: {
                                HStack {
                                    VStack(alignment: .leading, spacing: 3) {
                                        Text(tree.canonicalPath ?? tree.id)
                                        Text(tree.access == "write" ? "Can edit" : "Can view")
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                    }
                                    Spacer()
                                    if placingTreeID == tree.id {
                                        ProgressView()
                                    } else {
                                        Image(systemName: "arrow.down.circle")
                                    }
                                }
                            }
                            .disabled(placingTreeID != nil)
                        }
                        if unplacedTrees.isEmpty, !loading {
                            Text("Every available tree from this account is already on this iPhone.")
                                .foregroundStyle(.secondary)
                        }
                    }
                }
                if loading { Section { ProgressView("Loading…") } }
                if let message { Section { Text(message).foregroundStyle(.red) } }
            }
            .navigationTitle("Place a Tree")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
        .task { await loadAccounts() }
    }

    private func loadAccounts() async {
        loading = true
        defer { loading = false }
        do {
            accounts = try await KeychainDeviceCredentialStore().accounts()
            if let account = accounts.first {
                selectedAccount = account
                await loadTrees(for: account)
            }
            message = nil
        } catch {
            message = error.localizedDescription
        }
    }

    private func loadTrees(for account: NativeCanopyAccount) async {
        loading = true
        defer { loading = false }
        do {
            trees = try await NativeAccountService(
                origin: account.origin,
                configurationTree: account.configurationTree
            ).trees().snapshot.sorted {
                ($0.canonicalPath ?? $0.id).localizedCaseInsensitiveCompare($1.canonicalPath ?? $1.id) == .orderedAscending
            }
            message = nil
        } catch {
            trees = []
            message = error.localizedDescription
        }
    }

    private func place(_ tree: WireTreeDescriptor) async {
        guard let account = selectedAccount else { return }
        placingTreeID = tree.id
        defer { placingTreeID = nil }
        do {
            try await workspace.place(
                tree: tree,
                from: account.origin,
                configurationTree: account.configurationTree
            )
            dismiss()
        } catch {
            message = error.localizedDescription
        }
    }
}

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
                            if let handle = account.handle {
                                LabeledContent("Signed in as", value: "~\(handle)")
                            }
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
            let service = NativeAccountService(
                origin: placement.origin,
                configurationTree: placement.configurationTree
            )
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
