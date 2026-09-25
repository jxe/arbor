import CanopyAppKit
import CanopyWorkingTree
import CanopyEditor
import OverstoryClient
import Overstory
import Quagmire
import QuagmireExtras
import SwiftUI
import CryptoKit
import ImageIO
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

/// How a Canopy account is named in account lists, whether as the Mac
/// daemon's overview reports it or as `CanopyAccountService` lists it.
private protocol CanopyAccountPresentable {
    var configurationTree: String { get }
    var handle: String? { get }
    /// The account's Canopy host, when known.
    var accountHost: String? { get }
}

private extension CanopyAccountPresentable {
    var profileSectionID: String { "profile:\(configurationTree)" }
    var devicesSectionID: String { "devices:\(configurationTree)" }

    var accountDisplayName: String {
        guard let handle, !handle.isEmpty else { return "Canopy account" }
        return "~\(handle)"
    }

    var accountDisplayDetail: String {
        if let host = accountHost, !host.isEmpty { return host }
        let suffix = configurationTree.dropFirst(3).prefix(8)
        return suffix.isEmpty ? "Account settings" : "Account \(suffix.uppercased())"
    }

    var accountDisplayLabel: String { "\(accountDisplayName) · \(accountDisplayDetail)" }
}

#if os(macOS)
extension LocalHostAccountDescriptor: CanopyAccountPresentable {
    fileprivate var accountHost: String? {
        guard let canopy, !canopy.isEmpty else { return nil }
        return URL(string: canopy)?.host() ?? canopy
    }
}
#endif

extension CanopyAccount: CanopyAccountPresentable {
    fileprivate var accountHost: String? { origin?.host() }
}

/// Keep the focused editor-command dependency at the toolbar leaf. Reading it
/// from `CanopyRootView` makes every focus-preference update invalidate the
/// entire navigation hierarchy, which can form an iOS render loop before the
/// launch screen is replaced.
private struct CanopyVoiceRecordingToolbarButton: View {
    let session: VoiceRecordingSession<String>
    let model: CanopyAppModel
    let workspace: CanopyWorkspaceState
    @FocusedValue(\.editorCommands) private var editorCommands

    var body: some View {
        VoiceRecordingButton(session: session) {
            await startCanopyVoiceRecording(session, model: model, workspace: workspace, editorCommands: editorCommands)
        }
    }
}

/// Editing at the moment recording starts takes precedence over the page's
/// ordinary voice destination. Capture both the command bridge and block id
/// now so delayed transcription cannot drift into a different row.
@MainActor
private func startCanopyVoiceRecording(
    _ session: VoiceRecordingSession<String>,
    model: CanopyAppModel,
    workspace: CanopyWorkspaceState,
    editorCommands commands: EditorCommands?
) async {
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

enum CanopySidebarPageOrder: String, CaseIterable, Identifiable {
    case alphabetical
    case recent
    case linkCount
    case trees

    static var pageOrders: [Self] { [.alphabetical, .recent, .linkCount] }

    var id: Self { self }

    var label: String {
        switch self {
        case .alphabetical: "Alphabetical"
        case .recent: "Recent"
        case .linkCount: "Link Count"
        case .trees: "Trees"
        }
    }

    var symbol: String {
        switch self {
        case .alphabetical: "textformat"
        case .recent: "clock"
        case .linkCount: "link"
        case .trees: "tree"
        }
    }
}

struct CanopySidebarPageGroup: Identifiable, Equatable {
    var title: String
    var results: [WorkspaceSearchResult]
    var showsBacklinkCounts = false
    var id: String { title }
}

enum CanopySidebarPages {
    static func sorted(
        _ results: [WorkspaceSearchResult],
        by order: CanopySidebarPageOrder
    ) -> [WorkspaceSearchResult] {
        // Derive each title's sort key once, not once per comparison.
        let keyed = results.map { (result: $0, title: canopySidebarTitleParts($0.title).text) }
        return keyed.sorted { lhs, rhs in
            if order == .recent, lhs.result.modifiedAt != rhs.result.modifiedAt {
                return (lhs.result.modifiedAt ?? .distantPast) > (rhs.result.modifiedAt ?? .distantPast)
            }
            if order == .linkCount, lhs.result.backlinkCount != rhs.result.backlinkCount {
                return lhs.result.backlinkCount > rhs.result.backlinkCount
            }
            let titleOrder = lhs.title.localizedStandardCompare(rhs.title)
            if titleOrder != .orderedSame { return titleOrder == .orderedAscending }
            return lhs.result.reference.path.localizedStandardCompare(rhs.result.reference.path) == .orderedAscending
        }.map { $0.result }
    }

    static func recentGroups(
        _ results: [WorkspaceSearchResult],
        now: Date = .now,
        calendar: Calendar = .current
    ) -> [CanopySidebarPageGroup] {
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
            ("Earlier", { date in date.map { $0 < startOfMonth } ?? false }),
            ("Unknown date", { $0 == nil }),
        ]
        return sections.compactMap { title, includes in
            let matches = ordered.filter { includes($0.modifiedAt) }
            return matches.isEmpty ? nil : CanopySidebarPageGroup(title: title, results: matches)
        }
    }

    /// Pages in exactly the order `CanopyOrderedPageSections` draws them, so
    /// arrow keys move through the list top to bottom.
    static func displayOrder(_ results: [WorkspaceSearchResult], by order: CanopySidebarPageOrder) -> [WorkspaceSearchResult] {
        switch order {
        case .recent: recentGroups(results).flatMap(\.results)
        case .linkCount: linkCountGroups(results).flatMap(\.results)
        case .alphabetical: sorted(results, by: order)
        case .trees: []
        }
    }

    static func linkCountGroups(_ results: [WorkspaceSearchResult]) -> [CanopySidebarPageGroup] {
        let ordered = sorted(results, by: .linkCount)
        let sections: [(String, (Int) -> Bool, Bool)] = [
            ("0 Links", { $0 == 0 }, false),
            ("1 Link", { $0 == 1 }, false),
            ("Multiple Links", { $0 > 1 }, true),
        ]
        return sections.compactMap { title, includes, showsBacklinkCounts in
            let matches = ordered.filter { includes($0.backlinkCount) }
            return matches.isEmpty ? nil : CanopySidebarPageGroup(
                title: title,
                results: matches,
                showsBacklinkCounts: showsBacklinkCounts
            )
        }
    }
}

struct CanopyOrderedPageSections<Row: View>: View {
    let results: [WorkspaceSearchResult]
    let order: CanopySidebarPageOrder
    var alphabeticalSectionTitle: String?
    var topSpacing: CGFloat = 0
    @ViewBuilder let row: (WorkspaceSearchResult, Bool) -> Row

    var body: some View {
        if order == .recent {
            ForEach(Array(CanopySidebarPages.recentGroups(results).enumerated()), id: \.element.id) { index, group in
                Section {
                    ForEach(group.results) { row($0, false) }
                } header: {
                    Text(group.title)
                        .padding(.top, index == 0 ? topSpacing : 0)
                }
            }
        } else if order == .linkCount {
            ForEach(Array(CanopySidebarPages.linkCountGroups(results).enumerated()), id: \.element.id) { index, group in
                Section {
                    ForEach(group.results) { row($0, group.showsBacklinkCounts) }
                } header: {
                    Text(group.title)
                        .padding(.top, index == 0 ? topSpacing : 0)
                }
            }
        } else if let alphabeticalSectionTitle {
            Section {
                ForEach(CanopySidebarPages.sorted(results, by: order)) { row($0, false) }
            } header: {
                Text(alphabeticalSectionTitle)
                    .padding(.top, topSpacing)
            }
        } else {
            ForEach(Array(CanopySidebarPages.sorted(results, by: order).enumerated()), id: \.element.id) { index, result in
                row(result, false)
                    .padding(.top, index == 0 ? topSpacing : 0)
            }
        }
    }
}

enum CanopyPagePickerSelection {
    static func moved<ID: Hashable>(
        _ selection: ID?,
        by delta: Int,
        in values: [ID]
    ) -> ID? {
        guard !values.isEmpty else { return nil }
        let current = selection.flatMap(values.firstIndex)
        let start = delta > 0 ? -1 : values.count
        let next = min(max((current ?? start) + delta, 0), values.count - 1)
        return values[next]
    }
}

#if os(macOS)
@MainActor
private func returnFocusFromMacSearch(to commands: EditorCommands?) {
    // FocusState reconciliation happens asynchronously. Release the AppKit
    // field editor now, then let that reconciliation settle before asking the
    // Quagmire editor to run its page-focus pump.
    NSApp.keyWindow?.makeFirstResponder(nil)
    DispatchQueue.main.async {
        commands?.perform(.escape)
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

/// Sizes the sidebar search's toolbar item to the titlebar over the sidebar:
/// the sidebar's width less the window buttons' reach (none in full screen)
/// and the space AppKit needs to lay out the item without overflowing it. A
/// toolbar item keeps its ideal width, and a width held in SwiftUI state lands
/// a layout pass after the split view resizes, which pushes the item into the
/// overflow menu when the sidebar narrows. So the width is an AppKit constraint
/// on the item's view, updated as the split view resizes.
private struct MacSidebarSearchTitlebarSizer: NSViewRepresentable {
    func makeNSView(context: Context) -> SizerView { SizerView() }
    func updateNSView(_ view: SizerView, context: Context) { view.resize() }

    final class SizerView: NSView {
        private static let toolbarLayoutAllowance: CGFloat = 32
        private static let minimumWidth: CGFloat = 60

        private var observers: [NSObjectProtocol] = []
        private weak var itemView: NSView?
        private var widthConstraint: NSLayoutConstraint?

        override func hitTest(_ point: NSPoint) -> NSView? { nil }

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            observers.forEach(NotificationCenter.default.removeObserver)
            observers = []
            guard let window else { return }
            let center = NotificationCenter.default
            let resizeOnNotification: (Notification) -> Void = { [weak self] _ in
                MainActor.assumeIsolated { self?.resize() }
            }
            if let splitView {
                observers.append(center.addObserver(
                    forName: NSSplitView.didResizeSubviewsNotification,
                    object: splitView, queue: nil, using: resizeOnNotification
                ))
            }
            for name in [
                NSWindow.didEnterFullScreenNotification,
                NSWindow.didExitFullScreenNotification,
                NSWindow.didResizeNotification,
            ] {
                observers.append(center.addObserver(forName: name, object: window, queue: nil, using: resizeOnNotification))
            }
            resize()
            // The toolbar item may not exist until the toolbar's first pass.
            DispatchQueue.main.async { [weak self] in self?.resize() }
        }

        func resize() {
            guard let window, let splitView, let sidebar = splitView.arrangedSubviews.first,
                  let item = searchItem(in: window), let view = item.view else { return }
            // Dragging the sidebar closed collapses it without removing the
            // sidebar's toolbar items, which would leave the search in the
            // overflow menu.
            let collapsed = splitView.isSubviewCollapsed(sidebar) || sidebar.isHidden || sidebar.frame.width < 1
            if item.isHidden != collapsed { item.isHidden = collapsed }
            guard !collapsed else { return }
            let width = max(
                Self.minimumWidth,
                sidebar.frame.width - buttonsInset(in: window) - Self.toolbarLayoutAllowance
            )
            if view !== itemView {
                widthConstraint?.isActive = false
                let constraint = view.widthAnchor.constraint(equalToConstant: width)
                constraint.isActive = true
                itemView = view
                widthConstraint = constraint
            } else if widthConstraint?.constant != width {
                widthConstraint?.constant = width
            }
        }

        private var splitView: NSSplitView? {
            var ancestor = superview
            while let view = ancestor {
                if let split = view as? NSSplitView { return split }
                ancestor = view.superview
            }
            return nil
        }

        /// The toolbar item in the sidebar section whose view holds a text
        /// field: the search.
        private func searchItem(in window: NSWindow) -> NSToolbarItem? {
            for item in window.toolbar?.items ?? [] {
                if item.itemIdentifier.rawValue.hasPrefix("com.apple.SwiftUI.splitViewSeparator") { break }
                if let view = item.view, Self.containsTextField(view) { return item }
            }
            return nil
        }

        private func buttonsInset(in window: NSWindow) -> CGFloat {
            guard !window.styleMask.contains(.fullScreen),
                  let zoom = window.standardWindowButton(.zoomButton), !zoom.isHidden,
                  let superview = zoom.superview else { return 0 }
            return superview.convert(zoom.frame, to: nil).maxX
        }

        private static func containsTextField(_ view: NSView) -> Bool {
            view is NSTextField || view.subviews.contains(where: containsTextField)
        }
    }
}

private struct MacPageOrderPicker: NSViewRepresentable {
    var includesTrees = false
    private var orders: [CanopySidebarPageOrder] { includesTrees ? CanopySidebarPageOrder.allCases : CanopySidebarPageOrder.pageOrders }
    @Binding var selection: CanopySidebarPageOrder

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
        button.toolTip = includesTrees ? "Sidebar view" : "Page order"
        button.setAccessibilityLabel(includesTrees ? "Sidebar view" : "Page order")
        if let cell = button.cell as? NSPopUpButtonCell {
            cell.highlightsBy = []
            cell.arrowPosition = .noArrow
        }
        for order in orders {
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
        if let index = orders.firstIndex(of: selection) {
            button.selectItem(at: index)
        }
        button.contentTintColor = NSColor.secondaryLabelColor.withAlphaComponent(CanopyStyle.mutedToolbarOpacity)
        button.setAccessibilityValue(selection.label)
    }

    @MainActor
    final class Coordinator: NSObject {
        var selection: Binding<CanopySidebarPageOrder>

        init(selection: Binding<CanopySidebarPageOrder>) {
            self.selection = selection
        }

        @objc func selectionChanged(_ sender: NSPopUpButton) {
            guard let rawValue = sender.selectedItem?.representedObject as? String,
                  let order = CanopySidebarPageOrder(rawValue: rawValue) else { return }
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

/// The sidebar's search controls. macOS hosts them as a toolbar item, where
/// SwiftUI focus tracking never sees the field focused, so there the field's
/// AppKit first-responder state drives `isFocused` and a request to focus it.
private struct CanopySidebarSearchControls: View {
    @Binding var query: String
    @Binding var order: CanopySidebarPageOrder
    @Binding var isFocused: Bool
    let handleKeyPress: (KeyPress) -> KeyPress.Result
    @FocusState private var fieldFocused: Bool

    var body: some View {
        CanopyPageSearchControls(
            includesTrees: true,
            query: $query,
            order: $order,
            prompt: order == .trees ? "Search trees" : "Search pages",
            focused: $fieldFocused,
            showsFocus: isFocused,
            handleKeyPress: handleKeyPress,
            escapeReturnsToDocument: true
        )
#if os(macOS)
        .background { MacToolbarSearchFieldFocus(isFocused: $isFocused) }
#else
        .onAppear { fieldFocused = isFocused }
        .onChange(of: fieldFocused) { _, focused in isFocused = focused }
        .onChange(of: isFocused) { _, focused in fieldFocused = focused }
#endif
    }
}

#if os(macOS)
private final class WeakEditorCommands {
    weak var value: EditorCommands?
}

/// Binds `isFocused` to whether the text field beside it is the window's
/// first responder, and makes it or releases it when `isFocused` changes.
private struct MacToolbarSearchFieldFocus: NSViewRepresentable {
    @Binding var isFocused: Bool

    func makeNSView(context: Context) -> FocusView {
        let view = FocusView()
        view.focusChanged = { isFocused = $0 }
        return view
    }

    func updateNSView(_ view: FocusView, context: Context) {
        view.focusChanged = { isFocused = $0 }
        view.request(isFocused)
    }

    final class FocusView: NSView {
        var focusChanged: ((Bool) -> Void)?
        private var observation: NSKeyValueObservation?
        private var fieldIsFocused = false

        override func hitTest(_ point: NSPoint) -> NSView? { nil }

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            observation = window?.observe(\.firstResponder) { [weak self] _, _ in
                MainActor.assumeIsolated { self?.firstResponderChanged() }
            }
            firstResponderChanged()
        }

        func request(_ focused: Bool) {
            guard focused != fieldIsFocused else { return }
            DispatchQueue.main.async { [weak self] in
                guard let self, let window = self.window, let field = self.field else { return }
                if focused, !self.fieldIsFocused {
                    window.makeFirstResponder(field)
                } else if !focused, self.fieldIsFocused {
                    window.makeFirstResponder(nil)
                }
            }
        }

        private func firstResponderChanged() {
            let responder = window?.firstResponder
            let focused = field.map { responder === $0 || (responder != nil && $0.currentEditor() === responder) } ?? false
            guard focused != fieldIsFocused else { return }
            fieldIsFocused = focused
            let focusChanged = focusChanged
            DispatchQueue.main.async { focusChanged?(focused) }
        }

        /// The nearest editable text field around this view: the search field
        /// in the same toolbar item.
        private var field: NSTextField? {
            var ancestor = superview
            while let view = ancestor {
                if let field = Self.firstEditableTextField(in: view) { return field }
                ancestor = view.superview
            }
            return nil
        }

        private static func firstEditableTextField(in view: NSView) -> NSTextField? {
            if let field = view as? NSTextField, field.isEditable { return field }
            for child in view.subviews {
                if let field = firstEditableTextField(in: child) { return field }
            }
            return nil
        }
    }
}
#endif

struct CanopyPageSearchControls: View {
    var includesTrees = false
    @Binding var query: String
    @Binding var order: CanopySidebarPageOrder
    var prompt = "Search pages"
    var focused: FocusState<Bool>.Binding
    /// Overrides `focused` for the focus highlight, where the field's focus
    /// is tracked outside SwiftUI.
    var showsFocus: Bool?
    var handleKeyPress: ((KeyPress) -> KeyPress.Result)?
    var escapeReturnsToDocument = false

    private var isShowingFocus: Bool { showsFocus ?? focused.wrappedValue }
    @FocusedValue(\.editorCommands) private var editorCommands
#if os(macOS)
    /// The editor's commands as last seen. A field in the titlebar sees none
    /// once it takes focus, so Escape returns to the editor they belong to.
    @State private var lastEditorCommands = WeakEditorCommands()
#endif

    var body: some View {
        HStack(spacing: 6) {
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(.secondary)
                TextField(prompt, text: $query)
                    .textFieldStyle(.plain)
                    .focused(focused)
#if os(macOS)
                    .onKeyPress(.escape) {
                        guard escapeReturnsToDocument else { return .ignored }
                        focused.wrappedValue = false
                        returnFocusFromMacSearch(to: editorCommands ?? lastEditorCommands.value)
                        return .handled
                    }
#endif
                    .onKeyPress(keys: [.upArrow, .downArrow, .return]) { press in
                        handleKeyPress?(press) ?? .ignored
                    }
                if !query.isEmpty {
                    Button {
                        query = ""
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
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .fill(Color.primary.opacity(isShowingFocus ? 0.065 : 0.035))
                    .overlay {
                        RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                            .stroke(
                                Color.primary.opacity(isShowingFocus ? 0.18 : 0.075),
                                lineWidth: 0.75
                            )
                    }
            }

#if os(macOS)
            MacPageOrderPicker(includesTrees: includesTrees, selection: $order)
                .frame(width: 32, height: 32)
                .mutedMacToolbarHover()
                .help("\(includesTrees ? "Sidebar view" : "Page order"): \(order.label)")
#else
            Menu {
                ForEach(includesTrees ? CanopySidebarPageOrder.allCases : CanopySidebarPageOrder.pageOrders) { candidate in
                    Button {
                        order = candidate
                    } label: {
                        Label(candidate.label, systemImage: candidate.symbol)
                    }
                }
            } label: {
                Image(systemName: order.symbol)
                    .foregroundStyle(.secondary)
                    .frame(width: 24, height: 24)
            }
            .buttonStyle(.glass)
            .buttonBorderShape(.circle)
            .frame(width: 48, height: 48)
            .contentShape(.circle)
            .tint(.gray)
            .accessibilityLabel(includesTrees ? "Sidebar view" : "Page order")
            .accessibilityValue(order.label)
#endif
        }
#if os(macOS)
        .onChange(of: editorCommands.map(ObjectIdentifier.init), initial: true) {
            if let editorCommands { lastEditorCommands.value = editorCommands }
        }
#endif
    }

    private var cornerRadius: CGFloat {
#if os(macOS)
        7
#else
        10
#endif
    }
}

enum ArborSyncStatus: Equatable {
    case synchronized
    case syncing
    case offline
    case attention

    static func resolve(
        synchronization: WorkspaceSynchronization,
        documentIsSaving: Bool,
        documentNeedsAttention: Bool
    ) -> Self {
        if documentNeedsAttention { return .attention }
        switch synchronization {
        case .current, .autoMerged:
            return documentIsSaving ? .syncing : .synchronized
        case .locallyPending, .requestPending, .uploading, .downloading:
            return .syncing
        case .offline:
            return .offline
        case .conflict, .authenticationFailure, .revoked:
            return .attention
        }
    }

    var accessibilityDescription: String {
        switch self {
        case .synchronized: "Fully synced"
        case .syncing: "Syncing changes"
        case .offline: "Offline; changes will sync when reconnected"
        case .attention: "Synchronization needs attention"
        }
    }

    var label: String {
        switch self {
        case .synchronized: "Fully synced"
        case .syncing: "Syncing"
        case .offline: "Offline"
        case .attention: "Sync needs attention"
        }
    }

    var showsIOSShareAction: Bool {
        self == .synchronized
    }
}

struct CanopyRootView: View {
    let workspace: CanopyWorkspaceState
    let onDisconnect: @MainActor () -> Void
    @State private var model: CanopyAppModel
    @State private var recordingSession: VoiceRecordingSession<String>
    @State private var pinchDictation: EditorPinchDictation
    @State private var peoplePresented = false
    @State private var sidebarTreeSelection: String?
    @State private var sidebarAccounts: [CanopyAccount] = []
    @State private var sidebarAccountError: String?
    @State private var accountFollowUpProfile: String?
    @State private var accountFollowUpSheet: CanopyPresentedSheet?
    @State private var accountPresented = false
    @State private var sharePresented = false
    @State private var presentedSheet: CanopyPresentedSheet?
    @State private var searchPresented = false
    @State private var searchText = ""
    @State private var trashConfirmationPresented = false
    @State private var arborsyncLogs = ""
    @State private var voiceLaunchReady = false
    @AppStorage("pageOrder.sidebar") private var sidebarPageOrder = CanopySidebarPageOrder.alphabetical
    @State private var sidebarSearchText = ""
    @State private var reviewingChoices = false
    @State private var reviewAccessoryReveal: EditorAccessoryReveal?
    @State private var sidebarKeyboardSelection: WorkspaceIdentity?
    @State private var sidebarListSelection: WorkspaceIdentity?
    @State private var pageRenameLocation: WorkspaceLocation?
    @State private var pageRenameDraft = ""
    @State private var sidebarSearchFocused = false
    @FocusState private var pageRenameFocused: Bool
#if os(macOS)
    @State private var columnVisibility: NavigationSplitViewVisibility = .all
    @State private var managementPresented = false
    @State private var profileAfterManagementDismiss: String?
    @State private var sheetAfterManagementDismiss: CanopyPresentedSheet?
#endif
#if os(iOS)
    @State private var sidebarRevealProgress: CGFloat = 0
    @State private var sidebarDrawerWidth: CGFloat = 360
    @State private var placementPresented = false
    @State private var topOverscrollProgress: CGFloat = 0
    @State private var topOverscrollArmed = false
    @State private var sidebarDismissDragSuppressesTap = false
#endif
    @Environment(\.displayScale) private var displayScale
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.scenePhase) private var scenePhase

    init(
        workspace: CanopyWorkspaceState,
        onDisconnect: @escaping @MainActor () -> Void = {},
        model: CanopyAppModel? = nil
    ) {
        self.workspace = workspace
        self.onDisconnect = onDisconnect
        let model = model ?? CanopyAppModel(workspace: workspace)
        let recordingSession = VoiceRecordingSession(
            recoveryStore: PendingVoiceRecordingStore(
                directoryURL: CanopySupportDirectories.pendingVoiceRecordings
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
        .task(id: workspace.providerRevision) {
            await model.reloadForProviderRevision()
        }
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
            // The hosted test app must not restore the user's last placed tree:
            // tests open the disposable tree their harness placed and own that
            // helper's full lifetime.
            let environment = ProcessInfo.processInfo.environment
            if environment["ARBOR_TEST_BUNDLED_HELPER"] != "1" {
                await workspace.restoreLocalWorkspaceIfAvailable()
            } else if let tree = environment["ARBOR_TEST_TREE"], !tree.isEmpty {
                // A hosted smoke run names its disposable placed tree explicitly.
                do {
                    try await workspace.openPlacedTree(tree)
                } catch {
                    workspace.errorMessage = error.localizedDescription
                }
            }
#endif
            voiceLaunchReady = true
            forwardPendingVoiceRecording()
            await workspace.refreshDirectory()
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
                Task { await workspace.refreshDirectory() }
#endif
            } else {
                Task { await workspace.flush() }
            }
        }
        .onChange(of: model.currentLocation) { _, _ in
            if let review = workspace.conflictReview,
               review.selectedDecision?.path.map({ reviewLogicalPath($0) != model.currentReference.path }) == true {
                review.expanded = false
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
#if os(iOS)
        .sheet(isPresented: Binding(
            get: { workspace.conflictReview?.expanded ?? false },
            set: { workspace.conflictReview?.expanded = $0 }
        )) {
            if let review = workspace.conflictReview {
                NavigationStack {
                    ScrollView {
                        CanopyChoiceReviewPanel(review: review,
                            previous: { stepReviewChoice(-1) }, next: { stepReviewChoice(1) })
                    }
                    .navigationTitle("Review choice")
                    .navigationBarTitleDisplayMode(.inline)
                }
                .presentationDetents([.large])
            }
        }
        .sheet(isPresented: $accountPresented, onDismiss: {
            if let profile = accountFollowUpProfile {
                accountFollowUpProfile = nil
                Task {
                    await workspace.refreshDirectory()
                    guard let person = workspace.directory.first(where: { $0.entry.profile == profile }) else {
                        workspace.errorMessage = "This profile is not available in People yet."
                        return
                    }
                    do { try await workspace.openDirectoryProfile(person) }
                    catch { workspace.errorMessage = error.localizedDescription }
                }
            }
            if let next = accountFollowUpSheet {
                accountFollowUpSheet = nil
                presentedSheet = next
            }
        }) {
            IOSAccountPanel(workspace: workspace, syncSections: AnyView(syncStatusPanel.sections), openProfile: { profile in
                accountFollowUpProfile = profile
                accountPresented = false
            }, onDisconnect: onDisconnect)
        }
        .sheet(isPresented: $sharePresented) {
            CanopySharePanel(workspace: workspace, currentNode: model.node)
        }
        .sheet(isPresented: $placementPresented) {
            IOSPlaceTreePanel(workspace: workspace)
        }
#else
        .sheet(isPresented: $managementPresented, onDismiss: finishManagementDismissal) {
            macManagementPanel
        }
#endif
        .sheet(isPresented: $peoplePresented) {
            NavigationStack {
                CanopyDirectoryView(
                    workspace: workspace,
                    openProfile: { person in
                        peoplePresented = false
                        Task { await model.openProfile(tree: person.id) }
                    },
                    editMembers: { tree, prefill in
                        peoplePresented = false
                        Task { await model.openProfile(tree: tree, membersSheet: true, prefill: prefill) }
                    },
                    openGroup: { tree in
                        peoplePresented = false
                        Task { await model.openProfile(tree: tree) }
                    }
                )
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { peoplePresented = false } } }
                .task { await workspace.refreshDirectory() }
            }
#if os(macOS)
            .frame(minWidth: 520, minHeight: 440)
#endif
        }
        .sheet(isPresented: $searchPresented, onDismiss: {
            searchText = ""
        }) {
            CanopySearchPalette(
                query: $searchText,
                search: { await model.fullTextSearch($0) },
                open: { reference in Task { await model.navigate(to: reference) } }
            )
        }
        .sheet(item: $presentedSheet, content: sheet)
        .sheet(item: moveRequestBinding) { request in
            if let host = model.editorHost {
                CanopyMoveDestinationSheet(
                    host: host,
                    request: request,
                    stalePageResults: model.searchResults
                )
            }
        }
        .sheet(item: structuralMoveRequestBinding) { request in
            if let host = model.editorHost {
                CanopyStructuralMoveSheet(
                    host: host,
                    request: request,
                    stalePageResults: model.searchResults
                )
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
        .focusedSceneValue(\.canopyWindowCommands, windowCommands)
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
                .navigationSplitViewColumnWidth(min: 240, ideal: 260, max: 500)
        } detail: {
            switch workspace.launchPhase {
            case let .restoring(name):
                CanopyLaunchOpeningView(name: name)
            case let .empty(message):
                CanopyLaunchEmptyView(
                    message: message,
                    trees: localTreeMenuItems,
                    openTree: jumpToLocalTree,
                    openLocation: { presentedSheet = .openLocation },
                    showAccounts: showAccountsPanel,
                    retry: message == nil ? nil : { Task { await workspace.retryRestore() } }
                )
            case .confirming, .unconfirmed, .ready:
                VStack(spacing: 0) {
                    CanopyLaunchConfirmationBar(phase: workspace.launchPhase) {
                        Task { await workspace.retryRestore() }
                    }
                    // Desktop history belongs to BrowserTabController. Mirroring
                    // it into a NavigationStack inside NavigationSplitView lets
                    // SwiftUI write an empty path during destination resolution,
                    // erasing the page we just pushed.
                    pageFrame(for: model.currentLocation)
                }
            }
        }
        .toolbarBackgroundVisibility(.hidden, for: .windowToolbar)
#endif
    }

#if os(iOS)
    /// Drag thresholds of the sidebar drawer, in points.
    private enum SidebarDrawerGesture {
        /// How near the leading edge a drag must start to open the drawer.
        static let edgeWidth: CGFloat = 22
        /// A drag this far, or projected this far, opens or closes the drawer.
        static let commitDistance: CGFloat = 96
        static let commitProjectedDistance: CGFloat = 170
        static let settleDuration: TimeInterval = 0.28
    }

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
                .modifier(CanopySidebarSurface(showsDivider: true))
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
                guard value.startLocation.x <= SidebarDrawerGesture.edgeWidth,
                      value.translation.width > 0,
                      abs(value.translation.width) > abs(value.translation.height) else { return }
                var transaction = Transaction()
                transaction.animation = nil
                withTransaction(transaction) {
                    sidebarRevealProgress = min(1, value.translation.width / sidebarDrawerWidth)
                }
            }
            .onEnded { value in
                guard value.startLocation.x <= SidebarDrawerGesture.edgeWidth,
                      abs(value.translation.width) > abs(value.translation.height) else {
                    return
                }
                let shouldOpen = value.translation.width > SidebarDrawerGesture.commitDistance
                    || value.predictedEndTranslation.width > SidebarDrawerGesture.commitProjectedDistance
                sidebarSearchFocused = false
                withAnimation(.snappy(duration: SidebarDrawerGesture.settleDuration)) {
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
                let shouldClose = value.translation.width < -SidebarDrawerGesture.commitDistance
                    || value.predictedEndTranslation.width < -SidebarDrawerGesture.commitProjectedDistance
                sidebarSearchFocused = false
                withAnimation(.snappy(duration: SidebarDrawerGesture.settleDuration)) {
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
        withAnimation(.snappy(duration: SidebarDrawerGesture.settleDuration)) {
            sidebarRevealProgress = 0
        }
    }
#endif

    /// The sidebar column. Its search reactions live here, not on
    /// `sidebarPagesHeader`, which macOS hosts as a toolbar item that the
    /// toolbar may rebuild.
    private var sidebarContent: some View {
        sidebarColumn
            .onChange(of: sidebarSearchText) { _, query in
                sidebarKeyboardSelection = nil
                sidebarTreeSelection = nil
                if sidebarPageOrder != .trees { Task { await model.search(query) } }
            }
            .task(id: sidebarPageOrder) {
                sidebarKeyboardSelection = nil
                if sidebarPageOrder == .trees { await refreshSidebarAccounts() }
                else { await model.search(sidebarSearchText) }
            }
    }

    private var sidebarColumn: some View {
#if os(macOS)
        VStack(spacing: 0) {
            sidebarReviewContent
            sidebarFooter
        }
        .modifier(CanopySidebarSurface(showsDivider: true))
        .background { MacSidebarSearchTitlebarSizer() }
        // Toolbar content declared on the sidebar column occupies the
        // toolbar's sidebar section, over the sidebar in the titlebar. The
        // sizer sets the item's width; the controls fill it.
        .toolbar {
            ToolbarItem {
                sidebarPagesHeader
                    .frame(maxWidth: .infinity)
                    // AppKit reserves more room after this item than before it.
                    // Use part of the toolbar layout allowance to center the
                    // visible search controls without increasing the item width.
                    .offset(x: 10)
            }
            .sharedBackgroundVisibility(.hidden)
        }
#else
        VStack(spacing: 0) {
            sidebarPagesHeader
            sidebarReviewContent
            sidebarFooter
        }
        .modifier(CanopySidebarSurface())
#endif
    }

    private struct SidebarTree: Identifiable {
        let id: String
        let title: String
        let account: String
    }

    private var sidebarTrees: [SidebarTree] {
#if os(macOS)
        let overview = workspace.localArborSyncOverview
        let accountLabels = Dictionary(
            (overview?.accounts ?? []).map { ($0.configurationTree, $0.accountDisplayLabel) },
            uniquingKeysWith: { first, _ in first }
        )
        let values = (overview?.trees ?? []).filter { $0.kind != CanopyTreeKind.accountConfiguration && $0.path != nil }.map { tree in
            SidebarTree(id: tree.id, title: tree.canonicalPath ?? tree.name,
                account: tree.configurationTree.flatMap { accountLabels[$0] } ?? "Other Trees")
        }
#else
        let accountLabels = Dictionary(
            sidebarAccounts.map { ($0.configurationTree, $0.accountDisplayLabel) },
            uniquingKeysWith: { first, _ in first }
        )
        let values = workspace.nativePlacements.map { placement in
            SidebarTree(id: placement.tree.id, title: placement.tree.canonicalPath ?? placement.tree.id,
                account: placement.configurationTree.flatMap { accountLabels[$0] } ?? "Other Trees")
        }
#endif
        let query = sidebarSearchText.trimmingCharacters(in: .whitespacesAndNewlines)
        return values.filter { query.isEmpty || $0.title.localizedStandardContains(query) || $0.account.localizedStandardContains(query) }
            .sorted { $0.title.localizedStandardCompare($1.title) == .orderedAscending }
    }

    private var sidebarTreesList: some View {
        ScrollViewReader { proxy in
            let trees = sidebarTrees
            List {
                ForEach(trees) { tree in
                    Button { openSidebarTree(tree.id) } label: {
                        HStack(spacing: 10) {
                            Image(systemName: "tree").font(.system(size: 18)).frame(width: 20)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(tree.title).lineLimit(1)
                                Text(tree.account).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                            }
                            Spacer(minLength: 0)
                            if tree.id == model.currentReference.tree.rawValue {
                                Image(systemName: "checkmark").foregroundStyle(.secondary)
                            }
                        }
                        .foregroundStyle(CanopySidebarPalette.foreground(colorScheme))
                        .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
#if os(iOS)
                    .listRowInsets(EdgeInsets(top: 6, leading: 16, bottom: 6, trailing: 16))
#endif
                    .canopyKeyboardSelectedRow(sidebarTreeSelection == tree.id)
                    .id(tree.id)
                }
                if trees.isEmpty { Text(sidebarSearchText.isEmpty ? "No trees available" : "No matching trees").foregroundStyle(.secondary) }
                if let sidebarAccountError { Text(sidebarAccountError).font(.caption).foregroundStyle(.secondary) }
#if os(macOS)
                Button("Open Tree…", systemImage: "folder.badge.plus") { presentedSheet = .openLocation }
#else
                Button("Add Tree…", systemImage: "folder.badge.plus") {
                    closeIOSSidebar()
                    placementPresented = true
                }
#endif
            }
            .listStyle(.sidebar)
#if os(iOS)
            .contentMargins(.horizontal, 0, for: .scrollContent)
#endif
            .scrollContentBackground(.hidden)
            .onChange(of: sidebarTreeSelection) { _, id in
                if let id { proxy.scrollTo(id) }
            }
        }
    }

    private var sidebarFooter: some View {
        Button(action: showPeoplePanel) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Image(systemName: "person.crop.square")
                    .font(.system(size: 18))
                    .frame(width: 20)
                Text("People")
#if os(macOS)
                    .font(.system(size: 14))
#endif
                Spacer(minLength: 0)
            }
            .foregroundStyle(CanopySidebarPalette.foreground(colorScheme))
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
#if os(iOS)
            .frame(minHeight: 44)
#endif
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .glassEffect(.clear.interactive(), in: .rect)
        .clipShape(.rect)
        // Keep the glass out of the sidebar's one-pixel boundary.
        .padding(.trailing, 1 / displayScale)
        .overlay(alignment: .top) { Divider() }
        .task { await refreshSidebarAccounts() }
    }

    private func refreshSidebarAccounts() async {
#if os(macOS)
        await workspace.refreshLocalArborSyncOverview()
        sidebarAccountError = workspace.localArborSyncOverviewError
#else
        do {
            sidebarAccounts = try await workspace.accountService.accounts()
            sidebarAccountError = nil
        } catch { sidebarAccountError = error.localizedDescription }
#endif
    }

    private func moveTreeSelection(_ delta: Int) {
        sidebarTreeSelection = CanopyPagePickerSelection.moved(sidebarTreeSelection, by: delta, in: sidebarTrees.map(\.id))
    }

    private func openSelectedSidebarTree() {
        if let id = sidebarTreeSelection ?? sidebarTrees.first?.id { openSidebarTree(id) }
    }

    private func openSidebarTree(_ id: String) {
        sidebarSearchFocused = false
#if os(macOS)
        Task {
            do { try await workspace.openPlacedTree(id) }
            catch { workspace.errorMessage = error.localizedDescription }
        }
#else
        guard let placement = workspace.nativePlacements.first(where: { $0.tree.id == id }) else { return }
        closeIOSSidebar()
        Task { await workspace.openNativePlacement(placement) }
#endif
    }

    @ViewBuilder
    private var sidebarReviewContent: some View {
        ZStack {
            VStack(spacing: 0) {
                // With nothing to review the entry lives only in File ▸ Review Choices….
                if let review = workspace.conflictReview, !review.decisions.isEmpty || review.pending {
                    Button(action: showChoiceReview) {
                        HStack {
                            Label("Review choices", systemImage: "arrow.triangle.branch")
                            Spacer()
                            Text("\(review.decisions.count)")
                                .monospacedDigit().foregroundStyle(.secondary)
                        }
                        .padding(.horizontal, 12).padding(.vertical, 10)
                        .contentShape(.rect)
                    }.buttonStyle(.plain)
                    Divider()
                }
                sidebarList
            }
            .opacity(reviewingChoices ? 0 : 1)
            .allowsHitTesting(!reviewingChoices)
            .accessibilityHidden(reviewingChoices)
            if reviewingChoices, let review = workspace.conflictReview {
                CanopyChoiceReviewList(review: review, back: { reviewingChoices = false },
                    open: openReviewChoice, openDraft: { draft in
                        Task { await review.openRetained(draft) }
#if os(iOS)
                        closeIOSSidebar()
#endif
                    })
            }
        }
        .onChange(of: workspace.generation) { _, _ in reviewingChoices = false }
    }

    private func showChoiceReview() {
        guard let review = workspace.conflictReview else { return }
        reviewingChoices = true
#if os(macOS)
        if columnVisibility == .detailOnly { withAnimation { columnVisibility = .all } }
#else
        withAnimation { sidebarRevealProgress = 1 }
#endif
        Task { await review.refresh() }
    }

    private func openReviewChoice(_ decision: ConflictReviewDecision) {
        guard let review = workspace.conflictReview else { return }
#if os(iOS)
        closeIOSSidebar()
#endif
        Task {
            var page: WorkspaceReference?
            if let path = decision.path {
                let reference = WorkspaceReference(tree: workspace.home.tree, path: reviewLogicalPath(path))
                do {
                    _ = try await workspace.provider.resolve(reference)
                    page = reference
                } catch WorkingTreeError.notFound, WorkspaceProviderError.notFound {
                    // Deleted entries still have a review even when no live page exists.
                } catch {
                    workspace.errorMessage = error.localizedDescription
                }
            }
            // Load the choice first, then switch page and selection in the same
            // main-actor turn, so the panel never renders against the wrong
            // page or at an intermediate size.
            await review.select(decision, expand: false)
            guard review.selectedID == decision.id else { return }
            if let page { await model.navigate(to: page) }
            if let binding = model.pagePresentation(for: model.currentLocation)?.editorLease?.binding,
               inlineBlocks(for: decision, in: binding) != nil {
                review.expanded = false
                await review.openInline(decision)
                reviewAccessoryReveal = EditorAccessoryReveal("choice-\(decision.id)")
                return
            }
            review.expanded = true
            reviewAccessoryReveal = EditorAccessoryReveal("accepted-choices")
        }
    }

    private func reviewLogicalPath(_ path: String) -> String {
        if path == "/_index.md" { return "/" }
        if path.hasSuffix("/_index.md") { return String(path.dropLast(10)) }
        if path.hasSuffix(".md") { return String(path.dropLast(3)) }
        if path.hasSuffix(".mdx") { return String(path.dropLast(4)) }
        return path
    }

    private func stepReviewChoice(_ offset: Int) {
        guard let review = workspace.conflictReview else { return }
        let choices = review.decisions.sorted { ($0.path ?? "", $0.id) < ($1.path ?? "", $1.id) }
        guard !choices.isEmpty else { return }
        let current = choices.firstIndex { $0.id == review.selectedID }
        let next = current.map { ($0 + offset + choices.count) % choices.count } ?? (offset > 0 ? 0 : choices.count - 1)
        openReviewChoice(choices[next])
    }

    @ViewBuilder
    private var sidebarList: some View {
        if sidebarPageOrder == .trees {
            sidebarTreesList
        } else {
            sidebarPagesContent
        }
    }

    private var sidebarPagesContent: some View {
        ScrollViewReader { proxy in
            let reviewChoices = reviewChoicesByPage
            sidebarPagesList {
                CanopyOrderedPageSections(
                    results: model.searchResults,
                    order: sidebarPageOrder,
                    alphabeticalSectionTitle: nil,
                    topSpacing: 8
                ) { result, showsBacklinkCount in
                    sidebarSearchRow(
                        result,
                        showsBacklinkCount: showsBacklinkCount,
                        reviewChoice: result.reference.tree == workspace.home.tree
                            ? reviewChoices[result.reference.path]
                            : nil
                    )
                }
            }
            .listStyle(.sidebar)
#if os(iOS)
            .contentMargins(.horizontal, 0, for: .scrollContent)
#endif
            .scrollContentBackground(.hidden)
#if os(macOS)
            .onKeyPress(.return) {
                guard let selection = sidebarListSelection,
                      let result = model.searchResults.first(where: { $0.id == selection })
                else { return .ignored }
                openFromSidebar(.reference(result.reference))
                return .handled
            }
            .onChange(of: model.currentReference.identity, initial: true) { _, identity in
                let visible = model.searchResults.contains { $0.id == identity }
                sidebarListSelection = visible ? identity : nil
            }
#endif
#if os(iOS)
            .contentMargins(.top, 0, for: .scrollContent)
#endif
            .overlay {
                if model.searchResults.isEmpty, workspace.launchPhase.showsTree {
                    ContentUnavailableView.search(text: sidebarSearchText)
                        .allowsHitTesting(false)
                }
            }
            .onChange(of: sidebarKeyboardSelection) { _, selection in
                guard let selection else { return }
                withAnimation { proxy.scrollTo(selection, anchor: .center) }
            }
        }
    }

    /// On macOS the page list is a selectable `List`, so a focused sidebar
    /// supports arrow keys like any native source list; the current page is
    /// its selection.
    @ViewBuilder
    private func sidebarPagesList<Content: View>(@ViewBuilder content: () -> Content) -> some View {
#if os(macOS)
        List(selection: $sidebarListSelection, content: content)
#else
        List(content: content)
#endif
    }

    private var sidebarPagesHeader: some View {
        CanopySidebarSearchControls(
            query: $sidebarSearchText,
            order: $sidebarPageOrder,
            isFocused: $sidebarSearchFocused,
            handleKeyPress: handleSidebarSearchKeyPress
        )
#if os(iOS)
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .modifier(CanopySidebarSurface())
#endif
    }

    /// The first review choice on each page of the open tree, by logical path.
    private var reviewChoicesByPage: [String: ConflictReviewDecision] {
        var choices: [String: ConflictReviewDecision] = [:]
        for decision in workspace.conflictReview?.decisions ?? [] {
            guard let path = decision.path else { continue }
            let page = reviewLogicalPath(path)
            if choices[page] == nil { choices[page] = decision }
        }
        return choices
    }

    private func sidebarSearchRow(
        _ result: WorkspaceSearchResult,
        showsBacklinkCount: Bool,
        reviewChoice choice: ConflictReviewDecision?
    ) -> some View {
        HStack(spacing: 4) {
            CanopySidebarSearchRow(
                result: result,
                showsBacklinkCount: showsBacklinkCount,
                opensThroughListSelection: true,
                acceptsBlockDrop: !isCurrent(.reference(result.reference)),
                movePage: {
                    Task { _ = await model.editorHost?.moveDocument(result.reference) }
                }
            ) {
                openFromSidebar(.reference(result.reference))
            }
            if let choice {
                Button { openReviewChoice(choice) } label: { Image(systemName: "arrow.triangle.branch") }
                    .buttonStyle(.plain).foregroundStyle(.secondary)
                    .accessibilityLabel("Review choices on \(result.title)")
                    .help("Review choices on this page")
            }
        }
#if os(iOS)
        .listRowInsets(EdgeInsets(top: 6, leading: 16, bottom: 6, trailing: 16))
#endif
        .canopyKeyboardSelectedRow(sidebarKeyboardSelection == result.id)
        .tag(result.id)
        .id(result.id)
    }

    private var keyboardNavigableSidebarResults: [WorkspaceSearchResult] {
        CanopySidebarPages.displayOrder(model.searchResults, by: sidebarPageOrder)
    }

    private func handleSidebarSearchKeyPress(_ press: KeyPress) -> KeyPress.Result {
        guard press.phase == .down, sidebarSearchFocused else { return .ignored }
        if sidebarPageOrder == .trees {
            switch press.key {
            case .upArrow: moveTreeSelection(-1)
            case .downArrow: moveTreeSelection(1)
            case .return: openSelectedSidebarTree()
            default: return .ignored
            }
            return .handled
        }
        let results = keyboardNavigableSidebarResults
        guard !results.isEmpty else { return .ignored }
        switch press.key {
        case .upArrow:
            moveSidebarKeyboardSelection(by: -1, in: results)
        case .downArrow:
            moveSidebarKeyboardSelection(by: 1, in: results)
        case .return:
            let result = results.first { $0.id == sidebarKeyboardSelection } ?? results[0]
            openFromSidebar(.reference(result.reference))
        default:
            return .ignored
        }
        return .handled
    }

    private func moveSidebarKeyboardSelection(by delta: Int, in results: [WorkspaceSearchResult]) {
        sidebarKeyboardSelection = CanopyPagePickerSelection.moved(
            sidebarKeyboardSelection,
            by: delta,
            in: results.map(\.id)
        )
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
                pageFilenameHeading(String(leaf), location: location)
            } else {
                Text(path)
            }
        }
        .font(.system(size: 15, weight: .regular))
        .padding(.leading, 8)
        .lineLimit(1)
        .truncationMode(.head)
    }

    @ViewBuilder
    private func pageFilenameHeading(_ filename: String, location: WorkspaceLocation) -> some View {
        if pageRenameLocation == location {
            Text(pageRenameDraft.isEmpty ? "Page name" : pageRenameDraft)
                .font(.system(size: 15, weight: .regular))
                .hidden()
                .overlay(alignment: .leading) {
                    TextField("Page name", text: $pageRenameDraft)
                        .textFieldStyle(.plain)
                        .font(.system(size: 15, weight: .regular))
                        .focused($pageRenameFocused)
                        .onSubmit(commitPageRename)
                        .onExitCommand(perform: cancelPageRename)
                        .onChange(of: pageRenameFocused) { wasFocused, isFocused in
                            if wasFocused && !isFocused { commitPageRename() }
                        }
                }
        } else {
            Text(filename)
                .font(.system(size: 15, weight: .regular))
            if canRenamePage(at: location) {
                Button(action: beginPageRename) {
                    mutedMacToolbarIcon("pencil")
                }
                .buttonStyle(.plain)
                .mutedMacToolbarHover()
                .help("Rename Page")
                .accessibilityLabel("Rename Page")
            }
        }
    }

    private func canRenamePage(at location: WorkspaceLocation) -> Bool {
        location == model.currentLocation
            && canRenameCurrentPage
    }

    private func beginPageRename() {
        guard canRenamePage(at: model.currentLocation),
              let filename = model.currentReference.path.split(separator: "/").last else { return }
        pageRenameDraft = String(filename)
        pageRenameLocation = model.currentLocation
        Task { @MainActor in
            await Task.yield()
            pageRenameFocused = true
        }
    }

    private func commitPageRename() {
        guard pageRenameLocation != nil else { return }
        let name = pageRenameDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        let currentName = model.currentReference.path.split(separator: "/").last.map(String.init) ?? ""
        pageRenameLocation = nil
        pageRenameFocused = false
        guard !name.isEmpty, name != currentName else { return }
        Task { await model.renameCurrentPage(to: name) }
    }

    private func cancelPageRename() {
        pageRenameLocation = nil
        pageRenameFocused = false
    }
#else
    private func beginPageRename() {}
#endif

    private var canRenameCurrentPage: Bool {
#if os(macOS)
        currentPageIsMovable
#else
        false
#endif
    }

    /// A writable page other than the tree root and outside Trash: one that
    /// can be renamed, moved, or trashed.
    private var currentPageIsMovable: Bool {
        model.node?.isWritable == true
            && model.currentReference.path != "/"
            && !currentPageIsInTrash
    }

    private var currentPageIsInTrash: Bool {
        model.currentReference.path.hasPrefix("/Trash/")
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
        return "Canopy preserved an unfinished recording from \(date). It will be transcribed and added to its original page."
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
        sidebarSearchText = ""
        sidebarKeyboardSelection = nil
        sidebarSearchFocused = false
        Task { await model.navigate(to: location) }
    }

    private var moveRequestBinding: Binding<CanopyMoveRequest?> {
        Binding(
            get: { model.editorHost?.moveRequest },
            set: { request in
                if request == nil { model.editorHost?.resolveMoveRequest(with: nil) }
            }
        )
    }

    private var structuralMoveRequestBinding: Binding<CanopyStructuralMoveRequest?> {
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

    private var windowCommands: CanopyWindowCommands {
        CanopyWindowCommands(
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
            focusSidebarSearch: {
#if os(macOS)
                if columnVisibility == .detailOnly {
                    withAnimation { columnVisibility = .all }
                }
#endif
                Task { @MainActor in
                    await Task.yield()
                    sidebarSearchFocused = true
                }
            },
            showSearch: { searchPresented = true },
            recordAudio: { editorCommands in
                Task { await toggleVoiceRecording(editorCommands: editorCommands) }
            },
            recordAudioLabel: voiceRecordingCommandLabel,
            share: { sharePresented = true },
            revealPageInFinder: {
#if os(macOS)
                guard let url = revealablePageURL else { return }
                NSWorkspace.shared.activateFileViewerSelecting([url])
#endif
            },
            localTrees: localTreeMenuItems,
            jumpToLocalTree: jumpToLocalTree,
            showHistory: { Task { await model.loadHistory(); presentedSheet = .history } },
            showSource: { Task { await model.inspectSource(); presentedSheet = .source } },
            showSyncStatus: showStatusPanel,
            reviewChoices: showChoiceReview,
            reviewChoiceCount: workspace.conflictReview.map(\.decisions.count),
            showAccounts: showAccountsPanel,
            showPeople: showPeoplePanel,
            movePage: { Task { _ = await model.editorHost?.moveCurrentDocument() } },
            renamePage: beginPageRename,
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
            canRevealPageInFinder: revealablePageURL != nil,
            canMovePage: currentPageIsMovable && model.binding != nil,
            canRenamePage: canRenameCurrentPage,
            canMovePageToTrash: currentPageIsMovable,
            canRestorePage: model.node?.isWritable == true && currentPageIsInTrash
        )
    }

    private func jumpToLocalTree(_ tree: String) {
#if os(macOS)
        Task {
            do { try await workspace.openPlacedTree(tree) }
            catch { workspace.errorMessage = CanopyWorkspaceState.bootstrapFailureMessage(error, processKind: workspace.arborsyncProcessKind) }
        }
#endif
    }

    private var revealablePageURL: URL? {
#if os(macOS)
        guard let node = model.node else { return nil }
        switch node.surface {
        case .markdown, .directoryDocument:
            guard let url = node.provenance.physicalURL,
                  FileManager.default.fileExists(atPath: url.path) else { return nil }
            return url
        default:
            return nil
        }
#else
        return nil
#endif
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
            await startCanopyVoiceRecording(recordingSession, model: model, workspace: workspace, editorCommands: editorCommands)
        case .recording:
            await recordingSession.stopAndDeliver()
        case .transcribing:
            recordingSession.cancelTranscription()
        }
    }

    private var localTreeMenuItems: [CanopyLocalTreeMenuItem] {
#if os(macOS)
        (workspace.localArborSyncOverview?.trees ?? []).compactMap { tree in
            guard let path = tree.path else { return nil }
            return CanopyLocalTreeMenuItem(
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

    private var toolbarSyncStatus: ArborSyncStatus {
        syncStatus(for: model.binding)
    }

    private func syncStatus(for binding: CanopyDocumentBinding?) -> ArborSyncStatus {
        ArborSyncStatus.resolve(
            synchronization: workspace.syncPresentation.state,
            documentIsSaving: binding?.isSaving == true,
            documentNeedsAttention: binding?.lastError != nil
        )
    }

#if os(macOS)
    private func localTreeTitle(_ tree: LocalArborSyncTreePresentation) -> String {
        guard tree.kind == CanopyTreeKind.accountConfiguration else {
            return tree.canonicalPath ?? tree.name
        }
        let account = workspace.localArborSyncOverview?.accounts.first {
            $0.configurationTree == tree.id
        }
        return "\(account?.accountDisplayName ?? "Canopy account") settings"
    }

    private var macManagementPanel: some View {
        MacArborSyncAccountPanel(
            workspace: workspace,
            syncSections: AnyView(syncStatusPanel.sections),
            openProfile: { tree in
                profileAfterManagementDismiss = tree
                managementPresented = false
            }
        )
        .frame(minWidth: 600, minHeight: 520)
    }

    private func finishManagementDismissal() {
        if let profileTree = profileAfterManagementDismiss {
            profileAfterManagementDismiss = nil
            Task {
                do {
                    if let person = workspace.directory.first(where: { $0.entry.profile == profileTree }) {
                        try await workspace.openDirectoryProfile(person)
                    } else {
                        try await workspace.openPlacedTree(profileTree)
                    }
                }
                catch { workspace.errorMessage = error.localizedDescription }
            }
        } else if let sheet = sheetAfterManagementDismiss {
            sheetAfterManagementDismiss = nil
            presentedSheet = sheet
        }
    }
#endif

    private func showStatusPanel() {
#if os(macOS)
        managementPresented = true
#else
        accountPresented = true
#endif
    }

    private func showAccountsPanel() {
#if os(macOS)
        managementPresented = true
        Task {
            await workspace.refreshLocalArborSyncOverview()
            await workspace.preloadLocalHostDevices()
        }
#else
        accountPresented = true
#endif
    }

    private func showPeoplePanel() {
#if os(iOS)
        closeIOSSidebar()
#endif
        peoplePresented = true
    }

    private var syncStatusPanel: ArborSyncStatusView {
        ArborSyncStatusView(
            provider: workspace.providerDetail,
            sync: workspace.syncPresentation,
            binding: model.binding,
            arborsyncProcessKind: workspace.arborsyncProcessKind,
            retrySave: { Task { await model.retryDocumentSave() } },
            syncNow: { Task { await workspace.syncNow() } },
            discardHeldChanges: { Task { await workspace.discardHeldChanges() } },
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
            },
            showNetworkLog: {
#if os(macOS)
                sheetAfterManagementDismiss = .networkLog
                managementPresented = false
#else
                if accountPresented {
                    accountFollowUpSheet = .networkLog
                    accountPresented = false
                } else {
                    presentedSheet = .networkLog
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
                CanopyTabStrip(
                    tabs: model.tabItems,
                    selected: model.selectedTabID,
                    title: { tab in tab.current.path == "/" ? "Home" : tab.current.path.split(separator: "/").last.map(String.init) ?? "Canopy" },
                    select: { id in Task { await model.selectTab(id) } },
                    close: { Task { await model.closeSelectedTab() } },
                    create: { Task { await model.newTab() } }
                )
            }
            if location == model.currentLocation, !hostsReviewAccessory(location), let review = workspace.conflictReview {
                let choices = review.decisions.filter {
                    $0.path.map { reviewLogicalPath($0) == model.currentReference.path } ?? false
                }
                if review.expanded {
#if os(macOS)
                    // A choice with no editable page here (a deleted entry or a
                    // directory) uses the same panel at the editor's column width.
                    CanopyChoiceReviewPanel(review: review,
                        previous: { stepReviewChoice(-1) }, next: { stepReviewChoice(1) })
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                        .frame(maxWidth: CanopyStyle.editorTheme.layout.maxContentWidth)
                        .frame(maxWidth: .infinity)
                        .padding(.horizontal, 20).padding(.vertical, 12)
                    Divider()
#endif
                } else if !choices.isEmpty {
                    HStack {
                        Button { openReviewChoice(choices[0]) } label: {
                            Label("\(choices.count) unresolved \(choices.count == 1 ? "choice" : "choices")", systemImage: "arrow.triangle.branch")
                        }.buttonStyle(.plain)
                        Spacer()
                        Button("Review in tree", action: showChoiceReview).buttonStyle(.plain)
                    }.font(.callout).padding(.horizontal, 20).padding(.vertical, 10)
                    Divider()
                }
            }
            pageFrameContent(for: location)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
#if os(macOS)
                .simultaneousGesture(TapGesture().onEnded {
                    if pageRenameLocation != nil { pageRenameFocused = false }
                })
#endif
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
        .animation(.easeInOut(duration: 0.2), value: model.binding?.lastError != nil)
#if os(macOS)
        .navigationTitle("")
        .navigationBarBackButtonHidden(true)
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
            if model.canGoBack {
                ToolbarItem(placement: .navigation) {
                    Button {
                        Task { await model.goBack() }
                    } label: {
                        mutedMacToolbarIcon("chevron.left")
                    }
                    .buttonStyle(.plain)
                    .mutedMacToolbarHover()
                    .help("Back")
                    .accessibilityLabel("Back")
                }
                .sharedBackgroundVisibility(.hidden)
            }
            ToolbarItem(placement: .navigation) {
                detailPathHeading(for: location)
            }
            .sharedBackgroundVisibility(.hidden)
#endif
            ToolbarItemGroup(placement: .primaryAction) {
#if os(iOS)
                CanopyEditorUndoButtons()
                if let presentation = model.pagePresentation(for: location),
                   presentation.node.isWritable,
                   presentation.editorLease != nil {
                    CanopyVoiceRecordingToolbarButton(
                        session: recordingSession,
                        model: model,
                        workspace: workspace
                    )
                    .disabled(location != model.currentLocation)
                }
                if toolbarSyncStatus.showsIOSShareAction {
                    Button("Share", systemImage: "square.and.arrow.up") {
                        sharePresented = true
                    }
                } else {
                    Button {
                        showStatusPanel()
                    } label: {
                        ArborSyncToolbarIndicator(status: toolbarSyncStatus)
                            .frame(width: 18, height: 18)
                    }
                    .accessibilityLabel(toolbarSyncStatus.accessibilityDescription)
                }
#else
                HStack(spacing: 4) {
                    if let presentation = model.pagePresentation(for: location),
                       presentation.node.isWritable,
                       presentation.editorLease != nil {
                        CanopyVoiceRecordingToolbarButton(
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
                        CanopySharePanel(workspace: workspace, currentNode: model.node)
                            .onExitCommand { sharePresented = false }
                    }
                    Button {
                        showAccountsPanel()
                    } label: {
                        CanopyProfileSyncToolbarLabel(status: toolbarSyncStatus)
                    }
                    .help("Accounts — \(toolbarSyncStatus.accessibilityDescription)")
                    .accessibilityLabel("Accounts. \(toolbarSyncStatus.accessibilityDescription)")
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
        Color.secondary.opacity(CanopyStyle.mutedToolbarOpacity)
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
                    sidebarPageOrder = .trees
                    withAnimation { sidebarRevealProgress = 1 }
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

    private func hostsReviewAccessory(_ location: WorkspaceLocation) -> Bool {
        guard let presentation = model.pagePresentation(for: location) else { return false }
        if let review = workspace.conflictReview, review.expanded,
           review.selectedDecision?.path.map({ reviewLogicalPath($0) != model.currentReference.path }) == true { return false }
        return presentation.node.surface.supportsDocumentSession && presentation.node.isWritable && presentation.editorLease != nil
    }

    /// The blocks a source-range choice occupies on this page, when the
    /// decision names source this editor holds; nil sends it to the page panel.
    private func inlineBlocks(for decision: ConflictReviewDecision, in binding: CanopyDocumentBinding) -> [BlockID]? {
        guard let range = decision.sourceRange, let object = decision.affected.first?.material.object else { return nil }
        return binding.blocks(overlapping: range, inSource: object)
    }

    private func reviewAccessories(for location: WorkspaceLocation, binding: CanopyDocumentBinding) -> [EditorAccessory] {
        guard location == model.currentLocation, hostsReviewAccessory(location), let review = workspace.conflictReview else { return [] }
        let choices = review.decisions.filter { $0.path.map { reviewLogicalPath($0) == model.currentReference.path } ?? false }
        var accessories: [EditorAccessory] = []
        var placed: Set<String> = []
        for decision in choices {
            guard let blocks = inlineBlocks(for: decision, in: binding), let anchor = blocks.last else { continue }
            placed.insert(decision.id)
            accessories.append(EditorAccessory(
                id: "choice-\(decision.id)", anchor: .block(anchor), accessibilityLabel: "Review this choice",
                isExpanded: Binding(get: { review.inlineID == decision.id }, set: { expanded in
                    if expanded { review.expanded = false; Task { await review.openInline(decision) } }
                    else if review.inlineID == decision.id { review.inlineID = nil }
                }), marker: {
                    Image(systemName: "arrow.triangle.branch")
                        .foregroundStyle(.orange)
                        .help("Changed in two places")
                }, detail: {
                    CanopyInlineChoice(review: review, decision: decision) {
                        review.inlineID = nil
                        Task {
                            await review.select(decision, expand: true)
                            reviewAccessoryReveal = EditorAccessoryReveal("accepted-choices")
                        }
                    }
                }))
        }
        let remaining = choices.filter { !placed.contains($0.id) }
        let panelOpen = review.expanded && review.selectedID.map { id in choices.contains { $0.id == id } } == true
        guard !remaining.isEmpty || panelOpen || (review.showingAppliedResult && review.inlineID == nil) else { return accessories }
        let count = remaining.count
        accessories.insert(EditorAccessory(
            id: "accepted-choices", anchor: .document, accessibilityLabel: "Review alternatives",
            isExpanded: Binding(get: { review.expanded }, set: { expanded in
                if expanded, !choices.contains(where: { $0.id == review.selectedID }), let first = remaining.first ?? choices.first { openReviewChoice(first) }
                else { review.expanded = expanded }
            }), marker: {
                // The marker is the panel's disclosure control, so the panel
                // itself shows no second close button.
                Label {
                    Text(count == 0 ? (choices.isEmpty ? "Choice resolved" : "Review choice")
                         : "\(count) unresolved \(count == 1 ? "choice" : "choices")")
                } icon: {
                    Image(systemName: review.expanded ? "chevron.down" : "chevron.right")
                }
                .font(.callout)
            }, detail: {
#if os(macOS)
                CanopyChoiceReviewPanel(review: review,
                    previous: { stepReviewChoice(-1) }, next: { stepReviewChoice(1) }, showsClose: false)
                    .clipShape(RoundedRectangle(cornerRadius: 10))
#else
                EmptyView()
#endif
            }), at: 0)
        return accessories
    }

    @ViewBuilder
    private func pageFrameContent(for location: WorkspaceLocation) -> some View {
        if let presentation = model.pagePresentation(for: location) {
            let node = presentation.node
            if node.surface.supportsDocumentSession, node.isWritable || presentation.editorLease != nil {
                if let lease = presentation.editorLease, let host = presentation.editorHost {
                    VStack(spacing: 0) {
                        if location == model.currentLocation,
                           node.reference.path == "/",
                           let profile = model.profileDocument(for: node) {
                            CanopyProfileWidget(
                                profile: profile,
                                pageTitle: node.title,
                                isWritable: node.isWritable,
                                workspace: workspace,
                                model: model
                            )
                            Divider()
                        }
                        CanopyEditorSurface(
                            binding: lease.binding,
                            host: host,
                            configuration: CanopyStyle.editorConfiguration,
                            pinchDictation: pinchDictation,
                            topOverscrollAction: editorTopOverscrollAction,
                            accessories: reviewAccessories(for: location, binding: lease.binding),
                            accessoryReveal: location == model.currentLocation ? reviewAccessoryReveal : nil,
                            readOnly: !node.isWritable
                        ) {
                            CanopyDocumentFooter(
                                status: syncStatus(for: lease.binding),
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
    private func sheet(_ sheet: CanopyPresentedSheet) -> some View {
        switch sheet {
        case .source:
            if let node = model.node { CanopySourceInspector(node: node, snapshot: model.sourceSnapshot) }
        case .history:
            CanopyHistoryView(entries: model.history) { revision in
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
        case .networkLog:
            CanopyNetworkLogView()
        default:
            CanopyMutationForm(mode: sheet, submit: submitMutation)
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
            Task { await openLocation(trimmed) }
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

    /// Open Location. On the Mac an `http(s)://` or `arbor://` locator visits
    /// (or opens the placed tree it names); an absolute or `~` path opens the
    /// placed tree containing it and navigates inside; anything else is a path
    /// in the current tree. There is no filesystem browser: a folder that is
    /// not a placed tree cannot be opened here.
    private func openLocation(_ value: String) async {
#if os(macOS)
        if let url = URL(string: value), ["http", "https", "arbor"].contains(url.scheme?.lowercased() ?? "") {
            do { try await workspace.openRemoteLocator(value) }
            catch { workspace.errorMessage = error.localizedDescription }
            return
        }
        if value == "~" || value.hasPrefix("~/") || value.hasPrefix("/") {
            let expanded: String = if value == "~" {
                FileManager.default.homeDirectoryForCurrentUser.path
            } else if value.hasPrefix("~/") {
                FileManager.default.homeDirectoryForCurrentUser.appending(path: String(value.dropFirst(2))).path
            } else {
                value
            }
            let standardized = URL(fileURLWithPath: expanded).standardizedFileURL.path
            if workspace.localArborSyncOverview == nil { await workspace.refreshLocalArborSyncOverview() }
            let placed = (workspace.localArborSyncOverview?.trees ?? [])
                .compactMap { tree -> (LocalArborSyncTreePresentation, String)? in
                    guard let root = tree.path.map({ URL(fileURLWithPath: $0).standardizedFileURL.path }),
                          standardized == root || standardized.hasPrefix(root + "/") else { return nil }
                    return (tree, root)
                }
                .max { $0.1.count < $1.1.count }
            guard let (tree, root) = placed else {
                workspace.errorMessage = "\(standardized) is not inside a placed tree. Place the folder with arbor place first."
                return
            }
            do {
                if workspace.openPlacedTreeID != tree.id { try await workspace.openPlacedTree(tree.id) }
                let inside = standardized == root ? "/" : String(standardized.dropFirst(root.count))
                await model.navigate(to: WorkspaceReference(tree: TreeID(rawValue: tree.id), path: inside))
            } catch {
                workspace.errorMessage = CanopyWorkspaceState.bootstrapFailureMessage(error, processKind: workspace.arborsyncProcessKind)
            }
            return
        }
#endif
        await model.navigate(to: .reference(WorkspaceReference(
            tree: model.currentReference.tree,
            path: value.hasPrefix("/") ? value : "/\(value)"
        )))
    }

    @ViewBuilder
    private var attentionBanner: some View {
        if let proposal = model.titleRenameProposal {
            CanopyAttentionBanner(
                message: "Rename this page to \"\(proposal.proposedName)\" to match its title?",
                systemImage: "pencil",
                primaryLabel: "Rename",
                primaryAction: { Task { await model.acceptTitleRenameProposal() } },
                secondaryLabel: "Not Now",
                secondaryAction: { model.dismissTitleRenameProposal() }
            )
        } else if let diagnostic = CanopySaveDiagnostic.describe(
            model.binding?.lastError,
            processKind: workspace.arborsyncProcessKind
        ) {
            CanopyAttentionBanner(
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
            CanopyAttentionBanner(
                message: message,
                systemImage: "exclamationmark.circle",
                tint: .red,
                primaryLabel: "Dismiss",
                primaryAction: { model.dismissError() }
            )
        } else if let message = workspace.errorMessage {
            CanopyAttentionBanner(
                message: message,
                systemImage: "exclamationmark.circle",
                tint: .red,
                primaryLabel: "Dismiss",
                primaryAction: { workspace.errorMessage = nil }
            )
        }
    }
}

#if os(macOS)
private struct CanopyProfileSyncToolbarLabel: View {
    let status: ArborSyncStatus

    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            Image(systemName: "person.crop.circle")
                .font(.system(size: 14, weight: .regular))
                .foregroundStyle(Color.secondary.opacity(CanopyStyle.mutedToolbarOpacity))
                .frame(width: 32, height: 32)

            badge
                .frame(width: 13, height: 13)
                .background(.bar, in: Circle())
                .offset(x: -2, y: -2)
        }
        .contentShape(.rect)
    }

    @ViewBuilder
    private var badge: some View {
        ArborSyncToolbarIndicator(status: status)
    }
}
#endif

struct ArborSyncToolbarIndicator: View {
    let status: ArborSyncStatus

    @ViewBuilder
    var body: some View {
        switch status {
        case .synchronized:
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(.green)
        case .syncing:
            ProgressView()
                .controlSize(.mini)
                .scaleEffect(0.62)
        case .offline:
            Image(systemName: "wifi.slash")
                .font(.system(size: 8, weight: .semibold))
                .foregroundStyle(.secondary)
        case .attention:
            Image(systemName: "exclamationmark.circle.fill")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(.orange)
        }
    }
}

#if os(iOS)
private struct CanopyEditorUndoButtons: View {
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

private struct CanopySharePanel: View {
    @Environment(\.dismiss) private var dismiss
    let workspace: CanopyWorkspaceState
    let currentNode: WorkspaceNode?
    @State private var presentation: CanopySharePresentation?
    @State private var loading = true
    @State private var busy = false
    @State private var message: String?
    @State private var profileLocator = ""
    @State private var selectedAccountID = ""
    @State private var canonicalURL = ""
    @State private var promotionAccess = CanopyTreeAccess.noAccess
    @State private var permissionEditor = false
    @State private var newGroup: CanopyNewGroupRequest?
    /// The access a group made from this panel receives once it exists.
    @State private var newGroupAccess = CanopyTreeAccess.read
#if os(macOS)
    @State private var agentBundles: [CanopyCloudBundleRecord] = []
    @State private var agentPage = false
    /// Whether the pushed agent page shows a created code, which needs more height.
    @State private var agentPageShowsCode = false
    @State private var revokingAgent: CanopyCloudBundleRecord?
#endif

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
#if os(macOS)
            .navigationDestination(isPresented: $agentPage) {
                if case let .tracked(access) = presentation {
                    CanopyAgentBundlePage(workspace: workspace, access: access, showsCode: $agentPageShowsCode) { record in
                        agentBundles.insert(record, at: 0)
                    }
                }
            }
#endif
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
        .sheet(isPresented: $permissionEditor) {
            if case let .tracked(access) = presentation {
                CanopyResourcePermissionPanel(workspace: workspace, access: access) { updated in
                    presentation = .tracked(updated)
                }
            }
        }
        .sheet(item: $newGroup) { request in
            CanopyNewGroupSheet(workspace: workspace, request: request) { tree in
                guard case let .tracked(access) = presentation else { return }
                Task { await change(access, target: .profile(locator: tree), permission: newGroupAccess) }
            }
        }
#if os(macOS)
        .confirmationDialog(
            "Revoke \(revokingAgent?.label ?? "agent code")?",
            isPresented: Binding(
                get: { revokingAgent != nil },
                set: { if !$0 { revokingAgent = nil } }
            ),
            presenting: revokingAgent
        ) { record in
            Button("Revoke Agent Code", role: .destructive) {
                Task { await revoke(record) }
            }
            Button("Cancel", role: .cancel) {}
        } message: { _ in
            Text("Machines using this code lose access to the account on their next request. Files they already downloaded stay on them.")
        }
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
        if agentPage { return agentPageShowsCode ? 580 : 340 }
        switch presentation {
        case .tracked(let access):
            let people = access.entries.filter { $0.subject != .everyone }.count
            let rows = people + 1
            let agents: CGFloat = 96 + CGFloat(agentBundles.count) * 44
            return min(720, max(300, 190 + CGFloat(rows) * 62 + agents + messageHeight))
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
            CanopyPeoplePicker(
                query: $profileLocator,
                people: workspace.directory,
                workspace: workspace,
                excluding: Set(access.entries.compactMap { entry in if case .profile(let tree) = entry.subject { tree } else { nil } }),
                disabled: busy || !access.canEdit,
                onPick: { person in Task { await addProfiles([person.entry.profile], to: access) } },
                onRawSubmit: { shareInvites(access) },
                onCreateGroup: canCreateGroup && access.canEdit ? { name in
                    newGroupAccess = .read
                    newGroup = CanopyNewGroupRequest(name: name)
                    profileLocator = ""
                } : nil
            )
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
            } else if canCreateGroup, groupableEntries(access).count >= 2 {
                Button("Make these people a group…") {
                    let entries = groupableEntries(access)
                    newGroupAccess = entries.allSatisfy { $0.access == CanopyTreeAccess.write.rawValue } ? .write : .read
                    newGroup = CanopyNewGroupRequest(members: entries.compactMap { entry in
                        if case .profile(let tree) = entry.subject { tree } else { nil }
                    })
                }
#if os(macOS)
                .buttonStyle(.link)
#endif
                .disabled(busy)
            }
        }
        Section {
            ForEach(Array(access.resourceRules.enumerated()), id: \.offset) { _, rule in
                Text(rule.consentDescription).font(.callout).textSelection(.enabled)
            }
            Button("Manage app permissions…") { permissionEditor = true }
                .disabled(busy || !access.canEdit)
        } header: { Text("Scoped and app permissions") }
#if os(macOS)
        Section {
            ForEach(agentBundles) { record in
                agentRow(record, canEdit: access.canEdit)
            }
            Button("Use with an agent…", systemImage: "terminal") { agentPage = true }
                .disabled(busy || !access.canEdit)
        } header: {
            Text("Agents")
        } footer: {
            Text("An agent code lets a coding agent's cloud machine check out this tree with `arbor cloud start`.")
        }
#endif
    }

#if os(macOS)
    private func agentRow(_ record: CanopyCloudBundleRecord, canEdit: Bool) -> some View {
        HStack(spacing: 12) {
            accessIcon(systemName: "terminal", tint: .teal)
            VStack(alignment: .leading, spacing: 2) {
                Text(record.label)
                if let created = record.created {
                    Text("Agent code · created \(created.formatted(date: .abbreviated, time: .shortened))")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 8)
            Button("Revoke", role: .destructive) { revokingAgent = record }
                .disabled(busy || !canEdit)
        }
        .padding(.vertical, 2)
    }

    private func revoke(_ record: CanopyCloudBundleRecord) async {
        busy = true
        defer { busy = false }
        do {
            try await workspace.revokeAgentBundle(record)
            agentBundles.removeAll { $0.bundleID == record.bundleID }
            message = nil
        } catch {
            message = error.localizedDescription
        }
    }
#endif

    private var canCreateGroup: Bool {
#if os(macOS)
        workspace.groupCreationAccount != nil
#else
        false
#endif
    }

    /// People (not groups, not you) listed individually on this tree.
    private func groupableEntries(_ access: NativeTreeAccessPresentation) -> [NativeTreeAccessEntry] {
        access.entries.filter { entry in
            guard case .profile(let tree) = entry.subject, !entry.isCurrentUser else { return false }
            return workspace.directory.first { $0.id == tree }?.entry.kind != "group"
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
                    current: CanopyTreeAccess(rawValue: entry.access),
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
                    current: .noAccess,
                    set: { permission in
                        guard permission != .noAccess else { return }
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

    @ViewBuilder private func accessIcon(for entry: NativeTreeAccessEntry) -> some View {
        switch entry.subject {
        case .everyone:
            accessIcon(systemName: "globe", tint: .blue)
        case let .profile(tree):
            if let person = workspace.directory.first(where: { $0.id == tree }) {
                CanopyAvatarView(person: person, workspace: workspace)
            } else {
                accessIcon(systemName: entry.isCurrentUser ? "person.crop.circle.fill" : "person.2.fill", tint: .indigo)
            }
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

    /// `current` is nil for an access level this app does not recognize.
    private func accessMenu(current: CanopyTreeAccess?, set: @escaping (CanopyTreeAccess) -> Void) -> some View {
        Menu {
            ForEach([CanopyTreeAccess.read, .write], id: \.self) { access in
                Button {
                    set(access)
                } label: {
                    if current == access { Label(access.label, systemImage: "checkmark") }
                    else { Text(access.label) }
                }
            }
            if current != .noAccess {
                Divider()
                Button("Remove access", role: .destructive) { set(.noAccess) }
            }
        } label: {
            HStack(spacing: 5) {
                Text((current ?? .noAccess).label)
                Image(systemName: "chevron.down").font(.caption)
            }
            .foregroundStyle(.secondary)
        }
        .fixedSize()
    }

    @ViewBuilder
    private func promotion(path: String, accounts: [CanopyShareAccount]) -> some View {
        Section("Upgrade this folder") {
            LabeledContent("Folder", value: path)
            Text("The folder stays in place and becomes an Overstory tree with its own identity, history, synchronization, and access controls.")
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
                    Text("Private").tag(CanopyTreeAccess.noAccess)
                    Text("Everyone can view").tag(CanopyTreeAccess.read)
                    Text("Everyone can edit").tag(CanopyTreeAccess.write)
                }
                Button("Make This an Overstory Tree", systemImage: "tree") {
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
        case .profile(let tree): workspace.directory.first(where: { $0.id == tree })?.title ?? entry.displayName ?? "Person or group"
        case .link: "Private link"
        }
    }

    private func detail(for entry: NativeTreeAccessEntry) -> String {
        if entry.isCurrentUser { return "Owner" }
        switch entry.subject {
        case .everyone: return "Anyone who can find this tree"
        case .link: return "Existing access-link grant"
        case .profile(let tree): return workspace.directory.first(where: { $0.id == tree })?.subtitle ?? entry.locator ?? (entry.displayName == nil ? tree : "Person or group")
        }
    }

    private func permissionLabel(_ permission: String) -> String {
        (CanopyTreeAccess(rawValue: permission) ?? .noAccess).label
    }

    private var inviteLocators: [String] {
        CanopyShareInvite.locators(in: profileLocator)
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
#if os(macOS)
            if case let .tracked(access) = value {
                agentBundles = try workspace.agentBundles(tree: access.tree)
            }
#endif
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
        permission: CanopyTreeAccess
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
                    access: .read
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

    private func promote(path: String, account: CanopyShareAccount) async {
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

    private func suggestedCanonical(path: String, account: CanopyShareAccount) -> String {
        let name = URL(fileURLWithPath: path).lastPathComponent
            .lowercased()
            .replacingOccurrences(of: #"[^a-z0-9]+"#, with: "-", options: .regularExpression)
            .trimmingCharacters(in: CharacterSet(charactersIn: "-"))
        guard let handle = account.handle, !handle.isEmpty else { return account.origin + "/" + name }
        return account.origin + "/~" + handle + "/" + name
    }

}

#if os(macOS)
/// Pushed from the Share panel: make an agent code for one tree and show it
/// once, with how to use it. A macOS popover draws no navigation bar or
/// toolbar items, so the page draws its own back button and actions.
private struct CanopyAgentBundlePage: View {
    @Environment(\.dismiss) private var dismiss
    let workspace: CanopyWorkspaceState
    let access: NativeTreeAccessPresentation
    @Binding var showsCode: Bool
    let created: (CanopyCloudBundleRecord) -> Void
    @State private var label = ""
    @State private var bundle: String?
    @State private var relativePath = "tree"
    @State private var busy = false
    @State private var copied = false
    @State private var message: String?

    var body: some View {
        VStack(spacing: 0) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Button { dismiss() } label: {
                    Image(systemName: "chevron.left")
                        .font(.title3.weight(.semibold))
                        .contentShape(.rect)
                }
                .buttonStyle(.borderless)
                .help("Back to Share")
                .accessibilityLabel("Back to Share")
                .disabled(busy)
                Text("Use with an Agent")
                    .font(.title2.bold())
                Spacer(minLength: 0)
            }
            .padding(.horizontal)
            .padding(.vertical, 12)
            Divider()
            Form {
                if let bundle {
                    code(bundle)
                } else {
                    request
                }
                if let message {
                    Section { Text(message).foregroundStyle(.red) }
                }
            }
            Divider()
            HStack {
                Spacer()
                if bundle == nil {
                    Button("Create Agent Code") { Task { await create() } }
                        .buttonStyle(.borderedProminent)
                        .keyboardShortcut(.defaultAction)
                        .disabled(busy || label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                } else {
                    Button("Done") { dismiss() }
                        .keyboardShortcut(.defaultAction)
                }
            }
            .padding(12)
        }
        .navigationBarBackButtonHidden(true)
        // Escape goes back to Share rather than closing the popover.
        .onExitCommand { if !busy { dismiss() } }
        .onAppear {
            if label.isEmpty { label = "Agent for \(treeName)" }
        }
        .onDisappear { showsCode = false }
    }

    private var treeName: String {
        URL(string: access.canonical).map(\.lastPathComponent).flatMap { $0.isEmpty || $0 == "/" ? nil : $0 } ?? "this tree"
    }

    @ViewBuilder private var request: some View {
        Section {
            TextField("Name", text: $label)
                .disabled(busy)
        } footer: {
            Text("The name appears in this panel and in your account's devices, so you can tell agent codes apart and revoke the right one.")
        }
        Section {
            Label {
                Text("The code places only \(treeName) on the agent's machine, but it signs in as a device of your account. Anyone who has it can read and change everything your account can until you revoke it.")
            } icon: {
                Image(systemName: "key.fill").foregroundStyle(.orange)
            }
            if busy { ProgressView("Creating agent code…") }
        }
    }

    @ViewBuilder private func code(_ bundle: String) -> some View {
        Section {
            Label {
                Text("This code is a secret. Keep it in your agent's secret store, never in a repository, prompt, or chat. Canopy shows it only this once.")
            } icon: {
                Image(systemName: "key.fill").foregroundStyle(.orange)
            }
            ScrollView {
                Text(bundle)
                    .font(.caption.monospaced())
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(height: 72)
            HStack {
                Button(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc") { copy(bundle) }
                ShareLink(item: bundle) { Label("Share…", systemImage: "square.and.arrow.up") }
                Spacer()
            }
        } header: {
            Text("Agent code")
        }
        Section {
            Text("On the agent's machine, set `ARBOR_CLOUD_BUNDLE` to the code, then:")
            Text(verbatim: "arbor cloud start --root /workspace")
                .font(.callout.monospaced())
                .textSelection(.enabled)
            Text("The tree appears at `/workspace/\(relativePath)`. When the agent has stopped writing, `arbor cloud finish --root /workspace` syncs its last changes.")
        } header: {
            Text("How to use it")
        } footer: {
            Text("Revoke the code from the Share panel when the agent no longer needs it.")
        }
    }

    private func create() async {
        busy = true
        defer { busy = false }
        do {
            let result = try await workspace.createAgentBundle(tree: access.tree, label: label)
            relativePath = CanopyCloudBundle.relativePath(canonicalPath: URL(string: access.canonical)?.path ?? "")
            bundle = result.bundle
            showsCode = true
            message = nil
            created(result.record)
        } catch {
            message = error.localizedDescription
        }
    }

    private func copy(_ bundle: String) {
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        pasteboard.setString(bundle, forType: .string)
        // Clipboard managers skip items marked concealed (nspasteboard.org).
        pasteboard.setString("", forType: NSPasteboard.PasteboardType("org.nspasteboard.ConcealedType"))
        copied = true
    }
}
#endif

private struct CanopyDevicesHeader: View {
    var title = "Devices"
    var showsAddAccount = true
    let addAccount: () -> Void

    var body: some View {
        HStack {
            Text(title)
            Spacer()
            if showsAddAccount {
                Button(action: addAccount) {
                    Image(systemName: "person.badge.plus")
                        .font(.body)
#if os(iOS)
                        .frame(width: 44, height: 44)
#else
                        .frame(width: 24, height: 24)
#endif
                        .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .accessibilityLabel("Add account")
                .help("Add account…")
            }
        }
        .textCase(nil)
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
    let workspace: CanopyWorkspaceState
    let syncSections: AnyView
    let openProfile: (String) -> Void
    @State private var pairing: CanopyPairingOffer?
    @State private var pairingConfigurationTree: String?
    @State private var changingDeviceID: String?
    @State private var deauthorizationTarget: DeviceDeauthorizationTarget?
    @State private var setupPresented = false
    @State private var identityState: CanopyAccountState?
    @State private var message: String?

    private var account: LocalArborSyncOverview? { workspace.localArborSyncOverview }

    var body: some View {
        NavigationStack {
            Form {
                if let account {
                    ForEach(account.accounts, id: \.profileSectionID) { hostAccount in
                        Section { accountHeader(hostAccount) }
                    }
                }
                if account?.accounts.isEmpty != false, let identity = identityState?.identity {
                    Section {
                        CanopyProfileRow(
                            workspace: workspace,
                            person: workspace.directory.first { $0.entry.profile == identity.profileTree },
                            fallbackTitle: "My profile", fallbackSubtitle: "",
                            accessory: AnyView(identityMenu),
                            open: { openProfile(identity.profileTree) }
                        )
                    }
                }
                syncSections
                if let account {
                    if !account.accounts.isEmpty {
                        ForEach(account.accounts, id: \.devicesSectionID) { hostAccount in
                            Section {
                                if let devices = workspace.localHostDevicesByConfigurationTree[hostAccount.configurationTree] {
                                    ForEach(devices) { device in
                                        hostDeviceRow(
                                            device,
                                            configurationTree: hostAccount.configurationTree,
                                            devices: devices
                                        )
                                    }
                                } else {
                                    ProgressView("Loading devices…")
                                }
                                if pairingConfigurationTree == hostAccount.configurationTree, let pairing {
                                    VStack(spacing: 10) {
                                        PairingQRCode(payload: pairing.payload)
                                            .frame(width: 220, height: 220)
                                        LabeledContent("Confirm on both devices", value: pairing.confirmationCode)
                                            .font(.headline.monospacedDigit())
                                    }
                                    .frame(maxWidth: .infinity)
                                }
                            } header: {
                                CanopyDevicesHeader(
                                    title: account.accounts.count > 1 ? "Devices · \(hostAccount.accountDisplayName)" : "Devices",
                                    showsAddAccount: account.accounts.first?.id == hostAccount.id,
                                    addAccount: { setupPresented = true }
                                )
                            } footer: {
                                Button("Pair another device…") {
                                    Task { await createPairing(configurationTree: hostAccount.configurationTree) }
                                }
                                .buttonStyle(.link)
                                .textCase(nil)
                                .disabled(!hostAccount.credentialAvailable)
                            }
                        }
                    }
                    if account.accounts.isEmpty {
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
                if account?.accounts.isEmpty != false, account?.handle == nil {
                    Section {
                        Text("Connect to a community or pair an existing account.").foregroundStyle(.secondary)
                    } header: {
                        CanopyDevicesHeader(addAccount: { setupPresented = true })
                    }
                }
            }
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
        .sheet(isPresented: $setupPresented, onDismiss: { Task { await refresh() } }) {
            CanopyMacOnboarding(workspace: workspace, addingAccount: true) { setupPresented = false }
        }
        .frame(minWidth: 520, minHeight: 360)
        .formStyle(.grouped)
        .task {
            await Task.yield()
            await refresh()
            await workspace.refreshDirectory()
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

    private func accountHeader(_ account: LocalHostAccountDescriptor) -> some View {
        CanopyProfileRow(
            workspace: workspace,
            person: workspace.directory.first { $0.entry.profile == account.profileTree },
            fallbackTitle: account.accountDisplayName,
            fallbackSubtitle: account.accountDisplayDetail,
            canOpen: account.profileTree != nil,
            accessory: AnyView(identityMenu),
            open: { if let profile = account.profileTree { openProfile(profile) } }
        )
    }

    @ViewBuilder
    private var identityMenu: some View {
        if let identity = identityState?.identity {
            if identity.keyAvailable {
                Menu {
                    Button("Back up identity…") { backupIdentity() }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
                .menuStyle(.borderlessButton)
                .menuIndicator(.hidden)
                .fixedSize()
                .help("Identity options")
            } else {
                Button("Recover identity…") { recoverIdentity() }
            }
        }
    }

    private func backupIdentity() {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = "Arbor Identity.json"
        panel.message = "This backup contains your private identity key. Keep it somewhere secure. Choose a new file."
        guard panel.runModal() == .OK, let url = panel.url else { return }
        Task {
            do {
                try await workspace.ensureArborSync()
                try await workspace.accountService.backupIdentity(to: url)
            } catch { message = error.localizedDescription }
        }
    }

    private func recoverIdentity() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.message = "Choose your Arbor identity backup."
        guard panel.runModal() == .OK, let url = panel.url else { return }
        Task {
            do {
                try await workspace.ensureArborSync()
                try await workspace.accountService.restoreIdentity(backup: Data(contentsOf: url))
                await refresh()
            } catch { message = error.localizedDescription }
        }
    }

    private func refresh() async {
        if workspace.localArborSyncOverview == nil {
            await workspace.restartArborSync()
        }
        await workspace.refreshLocalArborSyncOverview()
        do {
            try await workspace.ensureArborSync()
            identityState = try await workspace.accountService.state()
        } catch { message = error.localizedDescription }
        guard let accounts = workspace.localArborSyncOverview?.accounts else { return }
        for account in accounts {
            do {
                _ = try await workspace.localHostDevices(configurationTree: account.configurationTree)
            } catch {
                message = error.localizedDescription
            }
        }
    }

    private func hostDeviceRow(
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
            _ = try await workspace.setLocalHostDeviceAdministrator(
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

    private func createPairing(configurationTree: String) async {
        do {
            let value = try await workspace.createPairingOffer(configurationTree: configurationTree)
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
            _ = try await workspace.deauthorizeLocalHostDevice(
                configurationTree: target.configurationTree,
                deviceID: target.deviceID
            )
            message = "\(target.label) was deauthorized."
        } catch {
            message = error.localizedDescription
        }
    }
}

private struct PairingQRCode: View {
    let payload: String
    /// The code rendered for `payload`, generated once per payload rather
    /// than on every body evaluation.
    @State private var rendered: (payload: String, image: CGImage?)?

    var body: some View {
        Group {
            if let rendered, rendered.payload == payload {
                if let image = rendered.image {
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
            } else {
                Color.clear.aspectRatio(1, contentMode: .fit)
            }
        }
        .task(id: payload) { rendered = (payload, Self.image(payload)) }
    }

    @MainActor private static let context = CIContext()

    @MainActor private static func image(_ payload: String) -> CGImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(payload.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage else { return nil }
        return context.createCGImage(output, from: output.extent)
    }
}
#endif

#if os(iOS)
struct CanopyIOSLaunchView: View {
    private enum Phase: Equatable {
        case restoring
        case accounts
        case scanning
        case claiming
        case choosing
        case syncing
    }

    let workspace: CanopyWorkspaceState
    var accountAdditionComplete: (() -> Void)?
    @State private var phase: Phase = .restoring
    @State private var ready = false
    @State private var started = false
    @State private var scanError: String?
    @State private var treeError: String?
    @State private var confirmationCode: String?
    @State private var origin: URL?
    @State private var accounts: [CanopyAccount] = []
    @State private var selectedConfigurationTree: String?
    @State private var trees: [ProtocolTreeDescriptor] = []
    @State private var syncingTree: ProtocolTreeDescriptor?

    var body: some View {
        Group {
            if ready, accountAdditionComplete != nil {
                Color.clear
            } else if ready {
                CanopyRootView(workspace: workspace) {
                    resetForPairing()
                }
            } else {
                onboarding
            }
        }
        .task {
            guard !started else { return }
            started = true
            if accountAdditionComplete != nil {
                phase = .scanning
                return
            }
            if await workspace.restoreNativePlacementIfAvailable() {
                ready = true
            } else {
                workspace.errorMessage = nil
                await loadAccounts()
                phase = .accounts
            }
        }
        .onChange(of: ready) { _, ready in
            if ready { accountAdditionComplete?() }
        }
        .safeAreaInset(edge: .top) {
            if let accountAdditionComplete {
                HStack {
                    Text("Add account").font(.headline)
                    Spacer()
                    Button("Done", action: accountAdditionComplete)
                }
                .padding()
                .background(.bar)
            }
        }
    }

    @ViewBuilder
    private var onboarding: some View {
        switch phase {
        case .restoring:
            ProgressView("Opening Canopy…")
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
                Text("Canopy will open it as soon as the local replica is ready.")
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
                Section("Accounts") {
                    ForEach(accounts) { account in
                        Button {
                            select(account)
                        } label: {
                            HStack {
                                VStack(alignment: .leading) {
                                    Text(account.accountDisplayName)
                                    Text(account.accountDisplayDetail)
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
                    Button("Scan Pairing QR Code", systemImage: "qrcode.viewfinder") {
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
            PairingQRScanner(onScanFailure: { scanError = $0 }) { payload in
                guard phase == .scanning else { return }
                phase = .claiming
                Task { await claim(payload) }
            }
            .ignoresSafeArea()
            .safeAreaInset(edge: .top) {
                VStack(spacing: 5) {
                    Text("Scan Canopy on your Mac")
                        .font(.headline)
                    Text("On the Mac, open Accounts and choose Pair another device.")
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
            VStack(spacing: 16) {
                ContentUnavailableView(
                    "QR scanning unavailable",
                    systemImage: "qrcode.viewfinder",
                    description: Text("This iPhone cannot start the camera scanner. Copy the pairing code from Canopy on your Mac and paste it here.")
                )
                Button("Paste Pairing Code", systemImage: "doc.on.clipboard") {
                    guard let raw = UIPasteboard.general.string, !raw.isEmpty else {
                        scanError = "The clipboard has no pairing code."
                        return
                    }
                    phase = .claiming
                    Task { await claim(raw) }
                }
                .buttonStyle(.borderedProminent)
                if let scanError {
                    Text(scanError)
                        .font(.footnote)
                        .foregroundStyle(.red)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal)
                }
            }
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
                                    Text(tree.grantsWrite ? "Ready to sync" : "Read only")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                                Spacer()
                                Image(systemName: "arrow.down.circle")
                            }
                        }
                        .disabled(!tree.grantsWrite)
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
            let label = UIDevice.current.name.isEmpty ? "iPhone" : UIDevice.current.name
            let claim = try await workspace.accountService.claimPairing(Data(raw.utf8), deviceLabel: label)
            selectedConfigurationTree = claim.configurationTree
            confirmationCode = claim.confirmationCode
            scanError = nil
            await loadAccounts()
            phase = .accounts
        } catch {
            scanError = error.localizedDescription
            phase = .scanning
        }
    }

    private func loadAccounts() async {
        do {
            accounts = try await workspace.accountService.accounts()
            scanError = nil
        } catch {
            scanError = error.localizedDescription
        }
    }

    private func select(_ account: CanopyAccount) {
        origin = account.origin
        selectedConfigurationTree = account.configurationTree
        phase = .choosing
        Task { await loadTrees() }
    }

    private func loadTrees() async {
        guard let selectedConfigurationTree,
              let account = accounts.first(where: { $0.configurationTree == selectedConfigurationTree }) else { return }
        treeError = nil
        do {
            trees = try await workspace.accountService.client(for: account).trees().snapshot.sorted {
                ($0.canonicalPath ?? $0.id) < ($1.canonicalPath ?? $1.id)
            }
        } catch {
            treeError = error.localizedDescription
        }
    }

    private func place(_ tree: ProtocolTreeDescriptor) async {
        guard let origin else { return }
        syncingTree = tree
        treeError = nil
        phase = .syncing
        do {
            try await workspace.place(tree: tree, from: origin, configurationTree: selectedConfigurationTree)
            ready = true
        } catch {
            treeError = error.localizedDescription
            phase = .choosing
        }
    }

    private func resetForPairing() {
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

            Text(isArmed ? "Release for Trees" : "Pull for Trees")
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

private struct IOSPlaceTreePanel: View {
    @Environment(\.dismiss) private var dismiss
    let workspace: CanopyWorkspaceState
    @State private var accounts: [CanopyAccount] = []
    @State private var selectedAccount: CanopyAccount?
    @State private var trees: [ProtocolTreeDescriptor] = []
    @State private var loading = true
    @State private var placingTreeID: String?
    @State private var message: String?

    private var unplacedTrees: [ProtocolTreeDescriptor] {
        let placed = Set(workspace.nativePlacements.map(\.tree.id))
        return trees.filter { $0.kind == CanopyTreeKind.ordinary && !placed.contains($0.id) }
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
                                    Text(account.accountDisplayName)
                                    Text(account.accountDisplayDetail)
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
                                        Text(tree.grantsWrite ? "Can edit" : "Can view")
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
            accounts = try await workspace.accountService.accounts()
            if let account = accounts.first {
                selectedAccount = account
                await loadTrees(for: account)
            }
            message = nil
        } catch {
            message = error.localizedDescription
        }
    }

    private func loadTrees(for account: CanopyAccount) async {
        loading = true
        defer { loading = false }
        do {
            trees = try await workspace.accountService.client(for: account).trees().snapshot.sorted {
                ($0.canonicalPath ?? $0.id).localizedCaseInsensitiveCompare($1.canonicalPath ?? $1.id) == .orderedAscending
            }
            message = nil
        } catch {
            trees = []
            message = error.localizedDescription
        }
    }

    private func place(_ tree: ProtocolTreeDescriptor) async {
        guard let account = selectedAccount, let origin = account.origin else { return }
        placingTreeID = tree.id
        defer { placingTreeID = nil }
        do {
            try await workspace.place(
                tree: tree,
                from: origin,
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
    let workspace: CanopyWorkspaceState
    let syncSections: AnyView
    let openProfile: (String) -> Void
    let onDisconnect: @MainActor () -> Void
    @State private var placement: NativePlacementRecord?
    @State private var accounts: [CanopyAccount] = []
    @State private var snapshots: [String: ProtocolAccountDescriptor] = [:]
    @State private var accountErrors: [String: String] = [:]
    @State private var message: String?
    @State private var disconnectConfirmation = false
    @State private var loading = true
    @State private var addingAccount = false

    var body: some View {
        NavigationStack {
            Form {
                ForEach(accounts, id: \.profileSectionID) { account in
                    Section {
                        let profile = snapshots[account.configurationTree]?.profileTree ?? account.profileTree
                        CanopyProfileRow(
                            workspace: workspace,
                            person: workspace.directory.first { $0.entry.profile == profile },
                            fallbackTitle: account.accountDisplayName,
                            fallbackSubtitle: account.accountDisplayDetail,
                            canOpen: profile != nil,
                            open: { if let profile { openProfile(profile) } }
                        )
                    }
                }
                syncSections
                ForEach(accounts, id: \.devicesSectionID) { account in
                    Section {
                        if let device = snapshots[account.configurationTree]?.device {
                            LabeledContent("This device", value: device.label)
                        }
                        if placement?.configurationTree == account.configurationTree {
                            Button("Disconnect and Pair Again…", role: .destructive) {
                                disconnectConfirmation = true
                            }
                        }
                        if let error = accountErrors[account.configurationTree] {
                            Text(error).font(.caption).foregroundStyle(.secondary)
                        }
                    } header: {
                        CanopyDevicesHeader(
                            title: accounts.count > 1 ? "Devices · \(account.accountDisplayName)" : "Devices",
                            showsAddAccount: accounts.first?.id == account.id,
                            addAccount: { addingAccount = true }
                        )
                    }
                }
                if accounts.isEmpty, message == nil {
                    Section {
                        if loading { ProgressView("Loading accounts…") }
                        else { Text("No accounts on this device").foregroundStyle(.secondary) }
                    } header: {
                        CanopyDevicesHeader(addAccount: { addingAccount = true })
                    }
                }
                if let message { Section { Text(message).foregroundStyle(.red) } }
            }
            .navigationTitle("Sync & Accounts")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
        .task { await load(); await workspace.refreshDirectory() }
        .sheet(isPresented: $addingAccount, onDismiss: { Task { await load() } }) {
            CanopyIOSLaunchView(workspace: workspace, accountAdditionComplete: { addingAccount = false })
        }
        .confirmationDialog(
            "Disconnect this iPhone from Overstory?",
            isPresented: $disconnectConfirmation
        ) {
            Button("Disconnect and Pair Again", role: .destructive) {
                Task { await disconnect() }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This removes this account’s credential and local trees from this iPhone. The server trees and their data are not deleted.")
        }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            placement = try await workspace.nativePlacement()
            accounts = try await workspace.accountService.accounts()
            for account in accounts {
                do {
                    snapshots[account.configurationTree] = try await workspace.accountService
                        .client(for: account).account().account
                    accountErrors[account.configurationTree] = nil
                } catch { accountErrors[account.configurationTree] = error.localizedDescription }
            }
            message = nil
        } catch { message = error.localizedDescription }
    }

    private func disconnect() async {
        do {
            guard let configuration = placement?.configurationTree,
                  try await workspace.nativePlacement()?.configurationTree == configuration else {
                message = "The active account changed. Reopen this panel before disconnecting."
                return
            }
            try await workspace.disconnectNativeAccount()
            dismiss()
            onDisconnect()
        } catch { message = error.localizedDescription }
    }
}
#endif

#if os(iOS)
private struct PairingQRScanner: UIViewControllerRepresentable {
    let onScanFailure: @MainActor (String) -> Void
    let onPayload: @MainActor (String) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onScanFailure: onScanFailure, onPayload: onPayload) }

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
        context.coordinator.startScanning(scanner)
        return scanner
    }

    func updateUIViewController(_ scanner: DataScannerViewController, context: Context) {
        if !scanner.isScanning { context.coordinator.startScanning(scanner) }
    }

    static func dismantleUIViewController(_ scanner: DataScannerViewController, coordinator _: Coordinator) {
        scanner.stopScanning()
    }

    @MainActor
    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        let onScanFailure: @MainActor (String) -> Void
        let onPayload: @MainActor (String) -> Void
        private var completed = false
        private var reportedScanFailure = false

        init(
            onScanFailure: @escaping @MainActor (String) -> Void,
            onPayload: @escaping @MainActor (String) -> Void
        ) {
            self.onScanFailure = onScanFailure
            self.onPayload = onPayload
        }

        /// Start the camera scanner, reporting the first failure outside the
        /// view update that attempted it; later retries fail the same way.
        func startScanning(_ scanner: DataScannerViewController) {
            do {
                try scanner.startScanning()
            } catch {
                guard !reportedScanFailure else { return }
                reportedScanFailure = true
                let report = onScanFailure
                let message = error.localizedDescription
                Task { @MainActor in report(message) }
            }
        }

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

private struct CanopyProfileWidget: View {
    let profile: CanopyProfileDocument
    let pageTitle: String
    let isWritable: Bool
    let workspace: CanopyWorkspaceState
    let model: CanopyAppModel
    @State private var presented = false
    @State private var reloadAfterDismiss = false
    @State private var prefill: String?

    var body: some View {
        HStack(spacing: 12) {
            CanopyProfileBannerAvatar(
                profile: profile,
                reference: model.currentReference,
                workspace: workspace
            )
            VStack(alignment: .leading, spacing: 2) {
                Text(bannerTitle)
                    .font(.headline)
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 12)
            if isWritable {
                Button(actionTitle) { presented = true }
                    .buttonStyle(.borderedProminent)
            } else {
                Label("Read only", systemImage: "lock")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal)
        .padding(.vertical, 10)
        .background(.quaternary.opacity(0.35))
        .onAppear(perform: consumePendingAction)
        .onChange(of: workspace.pendingProfileAction) { _, _ in consumePendingAction() }
        .sheet(isPresented: $presented, onDismiss: {
            prefill = nil
            guard reloadAfterDismiss else { return }
            reloadAfterDismiss = false
            Task { await model.load() }
        }) {
            if profile.kind == .group {
                CanopyProfileMembersSheet(
                    profile: profile,
                    workspace: workspace,
                    reservesHostHandle: workspace.isCommunityMembershipTree,
                    canopyOrigin: workspace.directory.first(where: { $0.id == model.currentReference.tree.rawValue && $0.isCommunityProfile })?.origin.absoluteString,
                    prefill: prefill,
                    add: {
                        try await model.addProfileMember(treeID: $0, handle: $1)
                        reloadAfterDismiss = true
                    },
                    invite: {
                        try await model.addProfileInvitation(handle: $0, digest: $1)
                        reloadAfterDismiss = true
                    },
                    remove: {
                        try await model.removeProfileMember(profile: $0)
                        reloadAfterDismiss = true
                    }
                )
            } else {
                CanopyPersonalProfileSheet(
                    profile: profile,
                    save: {
                        try await model.updatePersonalProfile(displayName: $0, description: $1, photo: $2)
                        reloadAfterDismiss = true
                    }
                )
            }
        }
    }

    /// Present the Members sheet People asked this group page for.
    private func consumePendingAction() {
        guard let action = workspace.pendingProfileAction,
              action.tree == model.currentReference.tree.rawValue else { return }
        workspace.pendingProfileAction = nil
        guard profile.kind == .group, isWritable else {
            workspace.errorMessage = "You can view \(bannerTitle), but only an editor can change its members."
            return
        }
        prefill = action.prefill
        presented = true
    }

    private var detail: String {
        if !isWritable { return "You can view this profile, but only an editor can change it." }
        if profile.kind == .person {
            if let description = profile.description, !description.isEmpty { return description }
            return profile.hasPersonalDetails
                ? "Personal profile"
                : "Add a display name, photo, and short description."
        }
        let count = profile.members.count
        let people = count == 1 ? "1 member" : "\(count) members"
        return workspace.isCommunityMembershipTree
            ? "\(people) on this Canopy. Adding a person reserves their handle here."
            : "\(people). Share a tree with this group to share it with all of them."
    }

    private var actionTitle: String {
        guard profile.kind == .group else { return profile.hasPersonalDetails ? "Edit Profile…" : "Fill Out Profile…" }
        return workspace.isCommunityMembershipTree ? "People…" : "Members…"
    }

    private var bannerTitle: String {
        if profile.kind == .person, let name = profile.displayName, !name.isEmpty { return name }
        if profile.kind == .group, !pageTitle.isEmpty { return pageTitle }
        return profile.kind == .group ? "Group profile" : "Personal profile"
    }
}

private struct CanopyProfileBannerAvatar: View {
    let profile: CanopyProfileDocument
    let reference: WorkspaceReference
    let workspace: CanopyWorkspaceState
    @State private var image: Image?

    var body: some View {
        ZStack {
            Circle().fill(Color.accentColor.opacity(0.14))
            if let image {
                image.resizable().scaledToFill()
            } else {
                Image(systemName: profile.kind == .group ? "person.2.fill" : "person.crop.circle.fill")
                    .font(.title2)
                    .foregroundStyle(.tint)
            }
        }
        .frame(width: 46, height: 46)
        .clipShape(Circle())
        .task(id: profile.avatarPath) {
            guard let avatarPath = profile.avatarPath else { image = nil; return }
            let path = "/" + avatarPath
            guard let data = try? await workspace.provider.readFile(.init(tree: reference.tree, path: path)),
                  let thumbnail = CanopyAvatarImage.thumbnail(data, maxPixelSize: 184) else {
                image = nil
                return
            }
            image = Image(decorative: thumbnail, scale: 2)
        }
    }
}

private struct CanopyPersonalProfileSheet: View {
    @Environment(\.dismiss) private var dismiss
    let profile: CanopyProfileDocument
    let save: (String, String, WorkspaceAsset?) async throws -> Void
    @State private var displayName = ""
    @State private var profileDescription = ""
    @State private var busy = false
    @State private var message: String?
    @State private var selectedPhoto: WorkspaceAsset?
    @State private var selectingPhoto = false

    var body: some View {
        NavigationStack {
            Form {
                Section("Your profile") {
                    TextField("Display name", text: $displayName)
                    TextField("Short description", text: $profileDescription, axis: .vertical)
                        .lineLimit(3...8)
                }
                Section("Photo") {
                    HStack(spacing: 12) {
                        CanopySelectedProfilePhoto(asset: selectedPhoto)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(selectedPhoto == nil ? (profile.avatarPath == nil ? "No photo selected" : "Current profile photo") : "New photo selected")
                            Text("The image is resized and stored in this profile tree.")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        Button("Choose Photo…") { selectingPhoto = true }
                            .disabled(busy)
                    }
                }
                if let message { Section { Text(message).foregroundStyle(.red) } }
            }
            .navigationTitle(profile.hasPersonalDetails ? "Edit Profile" : "Fill Out Profile")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { Task { await submit() } }.disabled(busy)
                }
            }
        }
        .frame(minWidth: 420, minHeight: 260)
        .fileImporter(isPresented: $selectingPhoto, allowedContentTypes: [.image]) { result in
            do {
                selectedPhoto = try CanopyProfilePhotoImport.load(from: result.get())
                message = nil
            } catch {
                message = error.localizedDescription
            }
        }
        .onAppear {
            displayName = profile.displayName ?? ""
            profileDescription = profile.description ?? ""
        }
    }

    private func submit() async {
        busy = true
        do {
            try await save(displayName, profileDescription, selectedPhoto)
            busy = false
            dismiss()
        } catch {
            busy = false
            message = error.localizedDescription
        }
    }
}

enum CanopyProfilePhotoImport {
    static func load(from url: URL) throws -> WorkspaceAsset {
        let accessed = url.startAccessingSecurityScopedResource()
        defer { if accessed { url.stopAccessingSecurityScopedResource() } }
        let data = try Data(contentsOf: url, options: .mappedIfSafe)
        return try normalized(data)
    }

    static func normalized(_ data: Data) throws -> WorkspaceAsset {
        guard let image = CanopyAvatarImage.thumbnail(data, maxPixelSize: 1024) else {
            throw ProtocolValidationError.invalidValue("The selected file is not a readable image")
        }
        for quality in [0.86, 0.72, 0.58] {
            let encoded = NSMutableData()
            guard let destination = CGImageDestinationCreateWithData(
                encoded,
                UTType.jpeg.identifier as CFString,
                1,
                nil
            ) else { continue }
            CGImageDestinationAddImage(destination, image, [
                kCGImageDestinationLossyCompressionQuality: quality,
            ] as CFDictionary)
            guard CGImageDestinationFinalize(destination) else { continue }
            let bytes = encoded as Data
            if bytes.count <= AvatarCache.maximumBytes {
                return WorkspaceAsset(name: "profile-photo.jpg", mediaType: "image/jpeg", bytes: bytes)
            }
        }
        throw ProtocolValidationError.invalidValue("The selected photo could not be reduced below \(AvatarCache.maximumSizeDescription)")
    }
}

private struct CanopySelectedProfilePhoto: View {
    let asset: WorkspaceAsset?

    var body: some View {
        Group {
            if let asset, let image = platformImage(asset.bytes) {
                image.resizable().scaledToFill()
            } else {
                Image(systemName: "person.crop.circle")
                    .resizable()
                    .scaledToFit()
                    .foregroundStyle(.secondary)
            }
        }
        .frame(width: 48, height: 48)
        .clipShape(Circle())
    }

    private func platformImage(_ data: Data) -> Image? {
#if os(macOS)
        NSImage(data: data).map { Image(nsImage: $0) }
#else
        UIImage(data: data).map { Image(uiImage: $0) }
#endif
    }
}

/// A group's members, one row each, with removal and the add form. Edits
/// go through the open page's editor, so they undo and sync like any edit.
private struct CanopyProfileMembersSheet: View {
    @Environment(\.dismiss) private var dismiss
    let profile: CanopyProfileDocument
    let workspace: CanopyWorkspaceState
    let reservesHostHandle: Bool
    let canopyOrigin: String?
    let prefill: String?
    let add: (String, String) async throws -> Void
    let invite: (String, String) async throws -> Void
    let remove: (String) async throws -> Void
    @State private var treeID = ""
    @State private var handle = ""
    @State private var inviteByCode = false
    @State private var issuedCode: String?
    @State private var issuedLink: String?
    @State private var query = ""
    @State private var busy = false
    @State private var message: String?
    @State private var removed: Set<String> = []
    @State private var confirmingRemoval: CanopyProfileDocument.Member?

    private var members: [CanopyProfileDocument.Member] {
        profile.members.filter { !removed.contains($0.profile) }
    }

    private var people: [DirectoryPerson] {
        DirectoryMatcher.matches(query: query, in: workspace.directory).filter {
            $0.entry.kind != "group"
                && !profile.memberProfiles.contains("arbor://\($0.entry.profile)/")
        }
    }

    var body: some View {
        NavigationStack {
            List {
                Section(reservesHostHandle ? "People on this Canopy" : "Members") {
                    ForEach(members) { member in
                        memberRow(member)
                    }
                    if members.isEmpty {
                        Text("No members yet.").foregroundStyle(.secondary)
                    }
                }
                Section(reservesHostHandle ? "Add a person" : "Add a member") {
                    if reservesHostHandle {
                        Toggle("Invite with a code", isOn: $inviteByCode)
                    }
                    if !inviteByCode || !reservesHostHandle {
                        TextField("TreeID (tr_…)", text: $treeID)
                    }
                    if reservesHostHandle {
                        HStack(spacing: 4) {
                            Text("~").foregroundStyle(.secondary)
                            TextField("Canopy handle", text: $handle)
                        }
                    }
                    Text(reservesHostHandle
                        ? (inviteByCode
                            ? "The person can claim this handle with the code, without sending you their Profile TreeID. The code is shown once."
                            : "This reserves the handle on this Canopy for the person’s Profile TreeID; it does not copy or relocate their profile.")
                        : "The TreeID is the member’s stable profile identity.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Button(inviteByCode && reservesHostHandle ? "Create Invitation" : reservesHostHandle ? "Add Person" : "Add Member") { Task { await submit() } }
                        .disabled(busy || issuedCode != nil || (!inviteByCode && treeID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                            || (reservesHostHandle
                                && handle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty))
                }
                if let issuedCode {
                    Section("Invitation code") {
                        if let issuedLink {
                            Text(issuedLink).font(.caption.monospaced()).textSelection(.enabled)
                            ShareLink("Share Join Link", item: issuedLink)
                            Button("Copy Join Link") { canopyCopyToPasteboard(issuedLink) }
                        }
                        Text(issuedCode).font(.system(.body, design: .monospaced)).textSelection(.enabled)
                        Text([.current, .autoMerged].contains(workspace.syncPresentation.state)
                            ? "Share this link now. It contains the one-time code and will not be shown here again."
                            : "The invitation is still syncing. Share the link when Sync Status shows Current; it will not be shown here again.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
                Section("Suggestions from People") {
                    ForEach(people) { person in
                        Button { choose(person) } label: {
                            HStack(spacing: 12) {
                                CanopyAvatarView(person: person, workspace: workspace)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(person.title)
                                    Text(person.subtitle).font(.caption).foregroundStyle(.secondary)
                                }
                                Spacer()
                                if treeID == person.entry.profile {
                                    Image(systemName: "checkmark").foregroundStyle(.tint)
                                }
                            }
                            .contentShape(.rect)
                        }
                        .buttonStyle(.plain)
                        .listRowBackground(treeID == person.entry.profile ? Color.accentColor.opacity(0.12) : nil)
                        .disabled(busy)
                    }
                    if people.isEmpty {
                        Text(reservesHostHandle
                            ? "No matching directory suggestions. You can still add the TreeID and handle above."
                            : "No matching directory suggestions. You can still add the TreeID above.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                if let message { Section { Text(message).foregroundStyle(.red) } }
            }
            .searchable(text: $query, prompt: "Search people")
            .navigationTitle(reservesHostHandle ? "People" : "Members")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
            .confirmationDialog(
                "Remove \(confirmingRemoval.map(label) ?? "this person") from this Canopy?",
                isPresented: Binding(get: { confirmingRemoval != nil }, set: { if !$0 { confirmingRemoval = nil } }),
                presenting: confirmingRemoval
            ) { member in
                Button("Remove", role: .destructive) { Task { await removeNow(member) } }
            } message: { _ in
                Text("Removing a person from this community disables that account.")
            }
        }
        .frame(minWidth: 440, minHeight: 420)
        .onAppear {
            inviteByCode = reservesHostHandle && prefill == nil
            guard let prefill, let person = workspace.directory.first(where: { $0.entry.profile == prefill }) else {
                if let prefill { treeID = prefill }
                return
            }
            choose(person)
        }
    }

    private func memberRow(_ member: CanopyProfileDocument.Member) -> some View {
        let person = member.treeID.flatMap { tree in workspace.directory.first { $0.entry.profile == tree } }
        return HStack(spacing: 12) {
            CanopyAvatarView(person: person, workspace: workspace, size: 32)
            VStack(alignment: .leading, spacing: 2) {
                Text(label(member))
                Text(member.handle.map { "~\($0)" } ?? person?.subtitle ?? member.profile)
                    .font(.caption).foregroundStyle(.secondary)
                    .lineLimit(1).truncationMode(.middle)
            }
            Spacer()
            Button(role: .destructive) {
                if reservesHostHandle { confirmingRemoval = member }
                else { Task { await removeNow(member) } }
            } label: {
                Image(systemName: "minus.circle")
            }
            .buttonStyle(.borderless)
            .disabled(busy)
            .help("Remove")
            .accessibilityLabel("Remove \(label(member))")
        }
    }

    private func label(_ member: CanopyProfileDocument.Member) -> String {
        if let tree = member.treeID, let person = workspace.directory.first(where: { $0.entry.profile == tree }) {
            return person.title
        }
        return member.handle.map { "~\($0)" } ?? member.treeID ?? member.profile
    }

    private func choose(_ person: DirectoryPerson) {
        treeID = person.entry.profile
        if reservesHostHandle { handle = person.entry.handle ?? "" }
        message = nil
    }

    private func removeNow(_ member: CanopyProfileDocument.Member) async {
        busy = true
        defer { busy = false }
        do {
            try await remove(member.profile)
            removed.insert(member.profile)
            message = nil
        } catch {
            message = error.localizedDescription
        }
    }

    private func submit() async {
        busy = true
        do {
            if reservesHostHandle && inviteByCode {
                guard let canopyOrigin else {
                    throw ProtocolValidationError.invalidValue("Refresh People to obtain this Canopy’s address before creating an invitation")
                }
                let bytes = Data((0..<16).map { _ in UInt8.random(in: .min ... .max) })
                let code = bytes.base64EncodedString().replacingOccurrences(of: "+", with: "-")
                    .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
                let digest = "sha256:" + SHA256.hash(data: Data(code.utf8)).map { String(format: "%02x", $0) }.joined()
                let account = canopyOrigin.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
                    + "/~" + handle.trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: "~"))
                var link = URLComponents()
                link.scheme = "canopy"
                link.host = "join"
                link.queryItems = [URLQueryItem(name: "account", value: account), URLQueryItem(name: "code", value: code)]
                guard let linkURL = link.url else { throw ProtocolValidationError.invalidValue("This Canopy address cannot form an invitation link") }
                try await invite(handle, digest)
                issuedCode = code
                issuedLink = linkURL.absoluteString
            } else {
                try await add(treeID, handle)
            }
            busy = false
            if issuedCode == nil { dismiss() }
        } catch {
            busy = false
            message = error.localizedDescription
        }
    }
}

private struct CanopyResourcePermissionPanel: View {
    @Environment(\.dismiss) private var dismiss
    let workspace: CanopyWorkspaceState
    let access: NativeTreeAccessPresentation
    let applied: (NativeTreeAccessPresentation) -> Void
    @State private var caller = "me"
    @State private var via = ""
    @State private var scope = "/"
    @State private var operations: Set<ProtocolResourceOperation> = [.read]
    @State private var removing = false
    @State private var review: NativeResourceConsent?
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                if let review {
                    Section("Review permission change") {
                        Text("Account configuration: \(review.configurationTree)")
                        Text("Resource: \(review.tree)")
                        Text("Before: \(review.previous?.consentDescription ?? "No matching rule")")
                        Text("After: \(review.removing ? "Remove this rule" : review.rule.consentDescription)")
                        Text("This grants only authority this account currently holds. Other matching rules may also grant access.")
                            .foregroundStyle(.secondary)
                        Button("Back") { self.review = nil }
                        Button(review.removing ? "Remove permission" : "Grant permission") {
                            Task {
                                busy = true
                                defer { busy = false }
                                do {
                                    applied(try await workspace.applyResourceConsent(review))
                                    dismiss()
                                } catch { self.error = error.localizedDescription }
                            }
                        }.disabled(busy)
                    }
                } else {
                    Section("Existing rules") {
                        ForEach(Array(access.resourceRules.enumerated()), id: \.offset) { _, rule in
                            Button(rule.consentDescription) { select(rule) }
                        }
                    }
                    Section("Permission") {
                        TextField("Caller: me, everyone, or profile TreeID", text: $caller)
                        TextField("Executable TreeID (optional)", text: $via)
                        TextField("Within", text: $scope)
                        ForEach(ProtocolResourceOperation.allCases, id: \.self) { operation in
                            Toggle(operation.rawValue, isOn: Binding(
                                get: { operations.contains(operation) },
                                set: { if $0 { operations.insert(operation) } else { operations.remove(operation) } }
                            ))
                        }
                        Toggle("Remove matching rule", isOn: $removing)
                        Button("Review change") { Task { await prepare() } }.disabled(busy)
                    }
                }
                if let error { Section { Text(error).foregroundStyle(.red) } }
            }
            .navigationTitle("App permissions")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
#if os(macOS)
        .frame(width: 620, height: 620)
        .formStyle(.grouped)
#endif
    }

    private func select(_ rule: ProtocolResourceAccessRule) {
        switch rule.who {
        case .me: caller = "me"
        case .everyone: caller = "everyone"
        case .profile(let tree): caller = tree
        case .link: error = "Use the account configuration to edit access-link rules."; return
        }
        via = rule.via ?? ""; scope = rule.within ?? "/"; operations = Set(rule.allow)
    }

    private func prepare() async {
        busy = true; error = nil
        defer { busy = false }
        do {
            let who: ProtocolResourceWho = caller == "me" ? .me : caller == "everyone" ? .everyone : .profile(caller)
            let rule = try ProtocolResourceAccessRule(who: who, via: via.isEmpty ? nil : via,
                allow: ProtocolResourceOperation.allCases.filter { operations.contains($0) }, within: scope)
            review = try await workspace.prepareResourceConsent(tree: access.tree, rule: rule, removing: removing)
        } catch { self.error = error.localizedDescription }
    }
}
