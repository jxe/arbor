import CanopyAppKit
import CanopyEditor
import CanopyWorkingTree
import OverstoryClient
import Quagmire
import SwiftUI

enum ArborPresentedSheet: String, Identifiable {
    case createMarkdown
    case createDirectory
    case openLocation
    case source
    case history
    case arborsyncLogs
    case networkLog
    case syncStatus

    var id: String { rawValue }
}

struct ArborWindowCommands {
    var toggleSidebar: () -> Void
    var sidebarPageOrder: ArborSidebarPageOrder
    var setSidebarPageOrder: (ArborSidebarPageOrder) -> Void
    var goHome: () -> Void
    var goBack: () -> Void
    var goForward: () -> Void
    var goParent: () -> Void
    var newTab: () -> Void
    var closeTab: () -> Void
    var newDocument: () -> Void
    var newFolder: () -> Void
    var openLocation: () -> Void
    var focusSidebarSearch: () -> Void
    var showSearch: () -> Void
    var recordAudio: (EditorCommands?) -> Void
    var recordAudioLabel: String
    var share: () -> Void
    var revealPageInFinder: () -> Void
    var localTrees: [ArborLocalTreeMenuItem]
    var jumpToLocalTree: (String) -> Void
    var showHistory: () -> Void
    var showSource: () -> Void
    var showSyncStatus: () -> Void
    var reviewChoices: () -> Void
    /// Nil while the open tree has no review model (nothing to review).
    var reviewChoiceCount: Int?
    var showAccounts: () -> Void
    var showPeople: () -> Void
    var movePage: () -> Void
    var renamePage: () -> Void
    var movePageToTrash: () -> Void
    var restorePage: () -> Void
    var canGoBack: Bool
    var canGoForward: Bool
    var canGoParent: Bool
    var canGoHome: Bool
    var canCloseTab: Bool
    var hasDocument: Bool
    var hasNode: Bool
    var canRecordAudio: Bool
    var canShare: Bool
    var canRevealPageInFinder: Bool
    var canMovePage: Bool
    var canRenamePage: Bool
    var canMovePageToTrash: Bool
    var canRestorePage: Bool
}

struct ArborLocalTreeMenuItem: Identifiable, Hashable {
    let id: String
    let title: String
    let path: String
    let isCurrent: Bool
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

extension View {
    /// The keyboard-selection highlight for a page row. `listRowBackground` is
    /// a row trait, so this must be applied to the row's outermost view.
    func arborKeyboardSelectedRow(_ selected: Bool) -> some View {
        listRowBackground(selected ? Color.accentColor.opacity(0.12) : Color.clear)
    }
}

// Opaque warm neutrals keep the sidebar and its titlebar search surface identical.
enum ArborSidebarPalette {
    static func background(_ scheme: ColorScheme) -> Color {
        scheme == .dark
            ? Color(red: 0.118, green: 0.114, blue: 0.106)
            : Color(red: 0.973, green: 0.969, blue: 0.961)
    }

    static func foreground(_ scheme: ColorScheme) -> Color {
        scheme == .dark
            ? Color(red: 0.72, green: 0.71, blue: 0.69)
            : Color(red: 0.39, green: 0.38, blue: 0.36)
    }
}

struct ArborSidebarSurface: ViewModifier {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.displayScale) private var displayScale
    var showsDivider = false

    func body(content: Content) -> some View {
        content
            .background(ArborSidebarPalette.background(colorScheme), ignoresSafeAreaEdges: .all)
            .overlay(alignment: .trailing) {
                if showsDivider {
                    Rectangle()
                        .fill(colorScheme == .dark ? Color.black.opacity(0.65) : Color.black.opacity(0.13))
                        .frame(width: 1 / displayScale)
                        .ignoresSafeArea()
                        .allowsHitTesting(false)
                }
            }
    }
}

struct ArborSidebarSearchRow: View {
    @Environment(\.colorScheme) private var colorScheme
    let result: WorkspaceSearchResult
    let showsBacklinkCount: Bool
    var acceptsBlockDrop = true
    var movePage: (() -> Void)?
    let open: () -> Void

    var body: some View {
        let titleParts = arborSidebarTitleParts(result.title)
        let contextPath = arborSidebarContextPath(result.reference.path)

        Button(action: open) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                if let emoji = titleParts.emoji {
                    Text(emoji)
                        .font(.system(size: 18))
                        // Emoji can draw wider than the alignment column. Keep their
                        // intrinsic size without moving the title or widening its gap.
                        .fixedSize()
                        .frame(width: 20)
                } else {
                    Image(systemName: "text.page")
                        .font(.system(size: 18))
                        .frame(width: 20)
                        .foregroundStyle(.secondary)
                }
                VStack(alignment: .leading, spacing: 1) {
                    Text(titleParts.text)
                        .foregroundStyle(ArborSidebarPalette.foreground(colorScheme))
#if os(macOS)
                        .font(.system(size: 14))
#endif
                        .lineLimit(1)
                    if let contextPath {
                        Text(contextPath)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .truncationMode(.head)
                    }
                }
                Spacer(minLength: 4)
                if showsBacklinkCount {
                    Text("\(result.backlinkCount)")
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.tertiary)
                }
            }
            .padding(.vertical, contextPath == nil ? 2.5 : 0)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .arborBlockDropDestination(
            acceptsBlockDrop ? ArborDocumentReferenceCodec.encode(result.reference) : nil
        )
        .contextMenu {
            Button("Open", systemImage: "arrow.right", action: open)
            if let movePage {
                Divider()
                Button("Move Page…", systemImage: "folder", action: movePage)
            }
        }
    }
}

private struct ArborBlockDropDestinationModifier: ViewModifier {
    let reference: DocumentReference?
    @FocusedValue(\.editorCommands) private var editorCommands
    @State private var isTargeted = false

    func body(content: Content) -> some View {
        content
            .background(isTargeted ? Color.accentColor.opacity(0.16) : Color.clear)
            .dropDestination(for: BlockDragPayload.self) { payloads, _ in
                guard let reference, let commands = editorCommands else { return false }
                let ids = payloads.flatMap(\.ids)
                guard !ids.isEmpty else { return false }
                commands.moveDraggedBlocks(ids, reference)
                return true
            } isTargeted: { targeted in
                isTargeted = reference != nil && targeted
            }
    }
}

private extension View {
    func arborBlockDropDestination(_ reference: DocumentReference?) -> some View {
        modifier(ArborBlockDropDestinationModifier(reference: reference))
    }
}

func arborSidebarContextPath(_ path: String) -> String? {
    let components = path.split(separator: "/", omittingEmptySubsequences: true)
    guard !components.isEmpty else { return nil }
    guard components.count > 1 else { return nil }
    return "/" + components.dropLast().joined(separator: "/")
}

private func arborSidebarTitleParts(_ title: String) -> (emoji: String?, text: String) {
    guard let first = title.first, WorkspaceDisplayTitle.isEmoji(first) else {
        return (nil, title)
    }
    let text = title.dropFirst().trimmingCharacters(in: .whitespaces)
    guard !text.isEmpty else { return (nil, title) }
    return (String(first), text)
}

struct ArborSearchPalette: View {
    @Binding var query: String
    let search: @MainActor (String) async -> [WorkspaceSearchResult]
    let open: (WorkspaceReference) -> Void

    @Environment(\.dismiss) private var dismiss
    @FocusState private var searchFocused: Bool
    @State private var results: [WorkspaceSearchResult] = []
    @State private var keyboardSelection: WorkspaceIdentity?
    @State private var isLoading = false

    var body: some View {
        Group {
#if os(iOS)
            NavigationStack {
                resultsList
                    .navigationTitle("Search Contents")
                    .navigationBarTitleDisplayMode(.inline)
                    .searchable(
                        text: $query,
                        placement: .navigationBarDrawer(displayMode: .always),
                        prompt: "Titles and text"
                    )
                    .searchFocused($searchFocused)
                    .onKeyPress(keys: [.upArrow, .downArrow, .return]) { press in
                        handleSearchKeyPress(press)
                    }
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
                        .onKeyPress(keys: [.upArrow, .downArrow, .return]) { press in
                            handleSearchKeyPress(press)
                        }
                        .padding(12)
                    Divider()
                    resultsList
                }
                .navigationTitle("Search Contents")
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
                }
            }
            .frame(minWidth: 480, minHeight: 460)
#endif
        }
        .task { searchFocused = true }
        .task(id: query) {
            let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else {
                results = []
                keyboardSelection = nil
                isLoading = false
                return
            }
            do { try await Task.sleep(for: .milliseconds(140)) }
            catch { return }
            guard !Task.isCancelled else { return }
            isLoading = true
            let loaded = await search(trimmed)
            guard !Task.isCancelled else { return }
            results = loaded
            keyboardSelection = nil
            isLoading = false
        }
    }

    private var resultsList: some View {
        ScrollViewReader { proxy in
            List(results) { result in
                Button { activate(result) } label: {
                    HStack(spacing: 12) {
                        VStack(alignment: .leading, spacing: 3) {
                            HStack(alignment: .firstTextBaseline, spacing: 7) {
                                Text(result.title)
                                    .fontWeight(.medium)
                                    .foregroundStyle(.primary)
                                    .lineLimit(1)
                                if let path = containingPath(for: result.reference) {
                                    Text(path)
                                        .font(.caption)
                                        .foregroundStyle(.tertiary)
                                        .lineLimit(1)
                                        .truncationMode(.head)
                                }
                            }
                            if let excerpt = result.excerpt {
                                Text(excerpt)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(2)
                            }
                        }
                        Spacer(minLength: 0)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .listRowBackground(
                    keyboardSelection == result.id
                        ? Color.accentColor.opacity(0.12)
                        : Color.clear
                )
                .id(result.id)
            }
            .overlay {
                if query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    ContentUnavailableView(
                        "Search this tree",
                        systemImage: "text.magnifyingglass",
                        description: Text("Find words in page titles and body text.")
                    )
                } else if isLoading, results.isEmpty {
                    ProgressView("Searching contents")
                } else if results.isEmpty {
                    ContentUnavailableView.search(text: query)
                }
            }
            .onChange(of: keyboardSelection) { _, selection in
                guard let selection else { return }
                withAnimation { proxy.scrollTo(selection, anchor: .center) }
            }
        }
    }

    private func handleSearchKeyPress(_ press: KeyPress) -> KeyPress.Result {
        guard press.phase == .down, searchFocused, !results.isEmpty else { return .ignored }
        switch press.key {
        case .upArrow:
            keyboardSelection = ArborPagePickerSelection.moved(
                keyboardSelection,
                by: -1,
                in: results.map(\.id)
            )
        case .downArrow:
            keyboardSelection = ArborPagePickerSelection.moved(
                keyboardSelection,
                by: 1,
                in: results.map(\.id)
            )
        case .return:
            activate(results.first { $0.id == keyboardSelection } ?? results[0])
        default:
            return .ignored
        }
        return .handled
    }

    private func activate(_ result: WorkspaceSearchResult) {
        open(result.reference)
        dismiss()
    }

    private func containingPath(for reference: WorkspaceReference) -> String? {
        arborSidebarContextPath(reference.path)
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
    @AppStorage("pageOrder.moveTo") private var order = ArborSidebarPageOrder.alphabetical
    @State private var keyboardSelection: MoveDestination?

    private static let collapsedLimit = 5

    init(
        host: ArborEditorHost,
        request: ArborMoveRequest,
        stalePageResults: [WorkspaceSearchResult] = []
    ) {
        self.host = host
        self.request = request
        let current = host.binding.reference.identity
        let indexed = stalePageResults
            .filter { $0.reference.identity != current }
            .map {
                ArborMoveDocument(
                    reference: ArborDocumentReferenceCodec.encode($0.reference),
                    title: $0.title,
                    subtitle: $0.reference.path,
                    isHome: $0.reference.path == "/",
                    modifiedAt: $0.modifiedAt,
                    backlinkCount: $0.backlinkCount
                )
            }
        let cached = host.staleMoveDocuments(matching: "")
        _documents = State(initialValue: cached.isEmpty ? indexed : cached)
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                ArborPageSearchControls(
                    query: $query,
                    order: $order,
                    prompt: "Search destinations",
                    focused: $searchFocused,
                    handleKeyPress: handleSearchKeyPress
                )
                    .padding(12)
                Divider()
                ScrollViewReader { proxy in
                    List {
                        if !visibleInDocument.isEmpty {
                            Section("On this page") {
                                ForEach(collapsedInDocument) { target in
                                    Button { activate(.block(target.id)) } label: {
                                        moveTargetLabel(target)
                                    }
                                    .buttonStyle(.plain)
                                    .listRowBackground(
                                        keyboardSelection == .block(target.id)
                                            ? Color.accentColor.opacity(0.12)
                                            : Color.clear
                                    )
                                    .id(MoveDestination.block(target.id))
                                }
                                if visibleInDocument.count > Self.collapsedLimit, query.isEmpty {
                                    Button(showAllInDocument ? "Show less" : "Show \(visibleInDocument.count - Self.collapsedLimit) more") {
                                        showAllInDocument.toggle()
                                    }
                                    .font(ArborStyle.shellFont(weight: .medium))
                                }
                            }
                        }
                        documentSections
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
                    .onChange(of: keyboardSelection) { _, selection in
                        guard let selection else { return }
                        withAnimation { proxy.scrollTo(selection, anchor: .center) }
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
        .onChange(of: query) { _, _ in keyboardSelection = nil }
        .onChange(of: order) { _, _ in keyboardSelection = nil }
        .onChange(of: documents) { _, _ in keyboardSelection = nil }
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

    private var documentResults: [WorkspaceSearchResult] {
        documents.compactMap { document in
            guard let reference = ArborDocumentReferenceCodec.decode(document.reference) else { return nil }
            return WorkspaceSearchResult(
                reference: reference,
                title: document.title,
                modifiedAt: document.modifiedAt,
                backlinkCount: document.backlinkCount
            )
        }
    }

    private var orderedDocumentResults: [WorkspaceSearchResult] {
        ArborSidebarPages.displayOrder(documentResults, by: order)
    }

    @ViewBuilder
    private var documentSections: some View {
        ArborOrderedPageSections(
            results: documentResults,
            order: order,
            alphabeticalSectionTitle: "Documents"
        ) { result, showsBacklinkCount in
            documentRow(result, showsBacklinkCount: showsBacklinkCount)
        }
    }

    private func documentRow(
        _ result: WorkspaceSearchResult,
        showsBacklinkCount: Bool
    ) -> some View {
        let reference = ArborDocumentReferenceCodec.encode(result.reference)
        return ArborSidebarSearchRow(
            result: result,
            showsBacklinkCount: showsBacklinkCount,
            acceptsBlockDrop: false
        ) {
            activate(.document(reference))
        }
        .arborKeyboardSelectedRow(keyboardSelection == .document(reference))
        .id(MoveDestination.document(reference))
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

    private var keyboardDestinations: [MoveDestination] {
        collapsedInDocument.map { .block($0.id) }
            + orderedDocumentResults.map { .document(ArborDocumentReferenceCodec.encode($0.reference)) }
    }

    private func handleSearchKeyPress(_ press: KeyPress) -> KeyPress.Result {
        guard press.phase == .down, searchFocused else { return .ignored }
        let destinations = keyboardDestinations
        guard !destinations.isEmpty else { return .ignored }
        switch press.key {
        case .upArrow:
            moveKeyboardSelection(by: -1, in: destinations)
        case .downArrow:
            moveKeyboardSelection(by: 1, in: destinations)
        case .return:
            activate(keyboardSelection ?? destinations[0])
        default:
            return .ignored
        }
        return .handled
    }

    private func moveKeyboardSelection(by delta: Int, in destinations: [MoveDestination]) {
        keyboardSelection = ArborPagePickerSelection.moved(
            keyboardSelection,
            by: delta,
            in: destinations
        )
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
    @State private var destinations: [ArborStructuralDestination] = []
    @State private var isLoading = false
    @AppStorage("pageOrder.movePage") private var order = ArborSidebarPageOrder.alphabetical
    @State private var keyboardSelection: WorkspaceIdentity?

    init(
        host: ArborEditorHost,
        request: ArborStructuralMoveRequest,
        stalePageResults: [WorkspaceSearchResult] = []
    ) {
        self.host = host
        self.request = request
        let cached = host.staleStructuralDestinations(
            for: request.reference,
            matching: ""
        )
        let indexed = stalePageResults.compactMap { result -> ArborStructuralDestination? in
            let path = result.reference.path
            let containsTarget = path == request.reference.path
                || path.hasPrefix(request.reference.path + "/")
            let sameParent = request.reference.parent?.path == path
            guard !containsTarget, !sameParent else { return nil }
            return ArborStructuralDestination(
                reference: result.reference,
                title: result.title,
                isDirectory: false,
                modifiedAt: result.modifiedAt,
                backlinkCount: result.backlinkCount
            )
        }
        _destinations = State(initialValue: cached.isEmpty ? indexed : cached)
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                ArborPageSearchControls(
                    query: $query,
                    order: $order,
                    prompt: "Search pages and folders",
                    focused: $searchFocused,
                    handleKeyPress: handleSearchKeyPress
                )
                    .padding(12)
                Divider()
                ScrollViewReader { proxy in
                    List {
                        destinationSections
                    }
                    .overlay {
                        if isLoading, destinations.isEmpty {
                            ProgressView("Finding destinations")
                        } else if destinations.isEmpty {
                            ContentUnavailableView("No legal destinations", systemImage: "folder.badge.questionmark")
                        }
                    }
                    .onChange(of: keyboardSelection) { _, selection in
                        guard let selection else { return }
                        withAnimation { proxy.scrollTo(selection, anchor: .center) }
                    }
                }
            }
            .navigationTitle("Move Page")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { cancel() }
                }
            }
        }
        .frame(minWidth: 440, minHeight: 420)
        .task { searchFocused = true }
        .task(id: query) {
            if !query.isEmpty {
                do { try await Task.sleep(for: .milliseconds(140)) }
                catch { return }
            }
            guard !Task.isCancelled else { return }
            isLoading = true
            let loaded = await host.structuralDestinations(for: request.reference, matching: query)
            guard !Task.isCancelled else { return }
            destinations = loaded
            isLoading = false
        }
        .onChange(of: query) { _, _ in keyboardSelection = nil }
        .onChange(of: order) { _, _ in keyboardSelection = nil }
        .onChange(of: destinations) { _, _ in keyboardSelection = nil }
        .interactiveDismissDisabled()
    }

    private var destinationResults: [WorkspaceSearchResult] {
        destinations.map { destination in
            WorkspaceSearchResult(
                reference: destination.reference,
                title: destination.title,
                modifiedAt: destination.modifiedAt,
                backlinkCount: destination.backlinkCount
            )
        }
    }

    private var orderedDestinations: [ArborStructuralDestination] {
        let byIdentity = Dictionary(
            destinations.map { ($0.id, $0) },
            uniquingKeysWith: { first, _ in first }
        )
        return ArborSidebarPages.sorted(destinationResults, by: order).compactMap { byIdentity[$0.id] }
    }

    @ViewBuilder
    private var destinationSections: some View {
        ArborOrderedPageSections(
            results: destinationResults,
            order: order,
            alphabeticalSectionTitle: nil
        ) { result, showsBacklinkCount in
            if let destination = destination(with: result.id) {
                destinationRow(destination, showsBacklinkCount: showsBacklinkCount)
            }
        }
    }

    private func destination(with identity: WorkspaceIdentity) -> ArborStructuralDestination? {
        destinations.first { $0.id == identity }
    }

    private func destinationRow(
        _ destination: ArborStructuralDestination,
        showsBacklinkCount: Bool
    ) -> some View {
        Button { activate(destination) } label: {
            HStack(spacing: 10) {
                Image(systemName: destination.reference.path == "/" ? "house" : destination.isDirectory ? "folder" : "doc.text")
                    .foregroundStyle(.secondary)
                    .frame(width: 18)
                VStack(alignment: .leading, spacing: 2) {
                    Text(destination.title)
                        .font(ArborStyle.shellFont(size: 14, weight: .medium))
                    if let contextPath = arborSidebarContextPath(destination.reference.path) {
                        Text(contextPath)
                            .font(ArborStyle.shellFont(size: 11))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                }
                Spacer(minLength: 4)
                if showsBacklinkCount {
                    Text("\(destination.backlinkCount)")
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.tertiary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .listRowBackground(
            keyboardSelection == destination.id ? Color.accentColor.opacity(0.12) : Color.clear
        )
        .id(destination.id)
        .accessibilityHint("Moves the page beneath this destination")
    }

    private func handleSearchKeyPress(_ press: KeyPress) -> KeyPress.Result {
        guard press.phase == .down, searchFocused, !orderedDestinations.isEmpty else { return .ignored }
        switch press.key {
        case .upArrow:
            moveKeyboardSelection(by: -1)
        case .downArrow:
            moveKeyboardSelection(by: 1)
        case .return:
            let destination = orderedDestinations.first { $0.id == keyboardSelection }
                ?? orderedDestinations[0]
            activate(destination)
        default:
            return .ignored
        }
        return .handled
    }

    private func moveKeyboardSelection(by delta: Int) {
        keyboardSelection = ArborPagePickerSelection.moved(
            keyboardSelection,
            by: delta,
            in: orderedDestinations.map(\.id)
        )
    }

    private func activate(_ destination: ArborStructuralDestination) {
        host.resolveStructuralMoveRequest(with: destination.reference)
        dismiss()
    }

    private func cancel() {
        host.resolveStructuralMoveRequest(with: nil)
        dismiss()
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
    let status: ArborSyncStatus
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
                HStack(spacing: 5) {
                    ArborSyncToolbarIndicator(status: status)
                        .frame(width: 13, height: 13)
                        .background(.bar, in: Circle())
                    Text(status.label)
                        .font(.caption.weight(.medium))
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .help(status.accessibilityDescription)
            .accessibilityLabel(status.accessibilityDescription)
            .accessibilityHint("Shows local durability and synchronization details")
        }
        .padding(.top, 24)
        .padding(.bottom, 12)
    }
}

struct ArborSyncStatusView: View {
    let provider: String
    let sync: WorkspaceSyncPresentation
    let binding: ArborDocumentBinding?
    let arborsyncProcessKind: ArborSyncProcessKind?
    let retrySave: () -> Void
    let reviewDocumentConflict: () -> Void
    let syncNow: () -> Void
    let reconnectArborSync: () -> Void
    let showArborSyncLogs: () -> Void
    var showNetworkLog: () -> Void = {}

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form { sections }
            .formStyle(.grouped)
#if os(iOS)
            .navigationTitle("Sync Status")
#endif
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
        }
#if os(macOS)
        .frame(minWidth: 560, minHeight: 430)
#endif
    }

    @ViewBuilder
    var sections: some View {
        Section {
            HStack(alignment: .center, spacing: 14) {
                Image(systemName: overallStatusSymbol)
                    .font(.title2)
                    .foregroundStyle(overallStatusTint)
                    .frame(width: 28)
                VStack(alignment: .leading, spacing: 3) {
                    Text(overallStatusTitle).font(.headline)
                    Text(overallStatusDetail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 16)
                if binding?.conflict != nil {
                    Button("Review Edit Conflict", systemImage: "exclamationmark.triangle", action: reviewDocumentConflict)
                } else if diagnostic != nil {
                    Button("Retry Save", systemImage: "arrow.clockwise", action: retrySave)
                } else {
                    Button("Sync Now", systemImage: "arrow.triangle.2.circlepath", action: syncNow)
                        .disabled(sync.state == .offline)
                }
                Button("Network Log…", systemImage: "waveform.path.ecg", action: showNetworkLog)
                    .help("Timings for updates, watch frames, and reads")
#if os(macOS)
                Menu {
                    Button("Reconnect to arborsync", systemImage: "arrow.clockwise", action: reconnectArborSync)
                    Button("View arborsync Logs…", systemImage: "doc.text.magnifyingglass", action: showArborSyncLogs)
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
                .menuStyle(.borderlessButton)
                .menuIndicator(.hidden)
                .fixedSize()
                .help("Arbor Sync options")
#endif
            }
            .padding(.vertical, 4)
        } footer: {
#if os(macOS)
            VStack(alignment: .leading, spacing: 4) {
                Text(provider)
                if diagnostic?.synchronizationOverride != nil {
                    Text("Last reported: \(sync.state.label). Arbor cannot verify that state while the provider connection is unavailable.")
                } else if let detail = sync.detail {
                    Text(detail)
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
#endif
        }
        if binding?.isSaving == true || binding?.conflict != nil || diagnostic != nil {
            Section("Current document") {
                LabeledContent("Save status", value: saveStatus)
                if binding?.conflict != nil {
                    Text("Your latest edits are still in this editor. Review the conflict to save them and resume synchronization.")
                        .font(.caption)
                        .foregroundStyle(.orange)
                }
                if let diagnostic {
                    Text(diagnostic.editSafetyDetail)
                        .font(.caption)
                        .foregroundStyle(.red)
                    LabeledContent("Cause", value: diagnostic.conditionLabel)
                    Text(diagnostic.explanation)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text(diagnostic.recovery)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text(diagnostic.technicalDetail)
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                }
            }
        }

    }


    var saveStatus: String {
        if binding?.isSaving == true { return "Retaining edit locally" }
        if binding?.conflict != nil { return "Conflict needs a choice" }
        if binding?.lastError != nil {
            if binding?.recoveryError != nil { return "Private recovery failed" }
            return binding?.latestEditIsRetainedInRecovery == true
                ? "Retained in recovery; working tree pending"
                : "Latest edit not retained locally"
        }
        return "Retained locally"
    }

    private var diagnostic: ArborSaveDiagnostic? {
        ArborSaveDiagnostic.describe(
            binding?.lastError,
            processKind: arborsyncProcessKind,
            localRecovery: localRecovery
        )
    }

    private var localRecovery: ArborSaveDiagnostic.LocalRecovery {
        guard let binding else { return .unknown }
        if binding.recoveryError != nil { return .failed }
        return binding.latestEditIsRetainedInRecovery ? .retained : .unavailable
    }

    var overallStatusTitle: String {
        if diagnostic != nil || binding?.conflict != nil { return "A document needs attention" }
        if sync.state != .current { return synchronizationLabel }
        if binding?.isSaving == true { return "Retaining edit locally" }
        return "This Arbor client is up to date"
    }

    private var overallStatusDetail: String {
        if let diagnostic { return diagnostic.bannerMessage }
        if binding?.conflict != nil { return "Resolve the current document conflict to continue." }
        if sync.state != .current { return sync.detail ?? synchronizationDetail }
        return "This client has no unpublished document or working-tree changes."
    }

    private var synchronizationDetail: String {
        switch sync.state {
        case .offline: "This client is offline; its changes will sync when reconnected."
        case .locallyPending: "Local changes are waiting to synchronize."
        case .requestPending: "A synchronization request is queued."
        case .uploading: "Local changes are being uploaded."
        case .downloading: "Remote changes are being downloaded."
        case .current: "This client's working tree is current."
        case .autoMerged: "Recent changes were merged automatically."
        case .conflict: "A synchronization conflict needs a choice."
        case .authenticationFailure: "Reconnect the account to resume synchronization."
        case .revoked: "This device no longer has access."
        }
    }

    private var overallStatusSymbol: String {
        if diagnostic != nil || binding?.conflict != nil {
            return "exclamationmark.triangle"
        }
        if binding?.isSaving == true { return "arrow.trianglehead.2.clockwise.rotate.90" }
        return sync.state == .current ? "checkmark.circle.fill" : sync.state.symbol
    }

    private var overallStatusTint: Color {
        if diagnostic != nil { return .red }
        if binding?.conflict != nil { return .orange }
        return sync.state == .current ? .green : .secondary
    }

    private var synchronizationLabel: String {
        diagnostic?.synchronizationOverride ?? sync.state.label
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

struct ArborSourceInspector: View {
    let node: WorkspaceNode
    let snapshot: WorkspaceDocumentSnapshot?

    var body: some View {
        NavigationStack {
            Form {
                Section("Identity") {
                    LabeledContent("Tree", value: node.reference.tree.rawValue)
                    LabeledContent("Path", value: node.reference.path)
                    if let stableKey = node.reference.stableKey { LabeledContent("Stable key", value: stableKey) }
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
    static let title = "History"
    static let unavailableTitle = "No local editor copies yet"
    static let unavailableExplanation = "Local editor copies are saved on this device before synchronization. Restoring creates a new change and keeps the original copies."

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
                    ContentUnavailableView(Self.unavailableTitle, systemImage: "clock")
                }
            }
            .navigationTitle(Self.title)
            .safeAreaInset(edge: .bottom) {
                Text(Self.unavailableExplanation)
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

private enum ArborConflictReviewChoice: String, CaseIterable, Identifiable {
    case current = "Current"
    case mine = "Mine"
    case both = "Both"
    case edit = "Edit"
    var id: Self { self }
}

private struct ArborConflictReviewContent {
    var base: String?
    var current: String
    var mine: String
    var both: String?
    var editable: Bool
}

private struct ArborConflictReviewControl: View {
    let content: ArborConflictReviewContent
    @Binding var choice: ArborConflictReviewChoice?
    @Binding var editedSource: String

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 76), spacing: 8)], spacing: 8) {
                choiceButton(.current)
                choiceButton(.mine)
                if content.both != nil { choiceButton(.both) }
                if content.editable { choiceButton(.edit) }
            }
            if choice == .edit {
                TextEditor(text: $editedSource)
                    .font(.body.monospaced())
                    .frame(minHeight: 180)
                    .padding(6)
                    .background(.background, in: RoundedRectangle(cornerRadius: 8))
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(.separator))
            } else if let selected = selectedSource {
                source(selected)
            }
            DisclosureGroup("Compare versions") {
                VStack(alignment: .leading, spacing: 12) {
                    version("Current", content.current)
                    version("Mine", content.mine)
                    if let both = content.both { version("Both (server draft)", both) }
                    if let base = content.base { version("Common base", base) }
                }
                .padding(.top, 8)
            }
        }
    }

    @ViewBuilder
    private func choiceButton(_ value: ArborConflictReviewChoice) -> some View {
        if choice == value {
            Button(value.rawValue) { choice = value }
                .buttonStyle(.borderedProminent)
        } else {
            Button(value.rawValue) { choice = value }
                .buttonStyle(.bordered)
        }
    }

    private var selectedSource: String? {
        switch choice {
        case .current: content.current
        case .mine: content.mine
        case .both: content.both
        case .edit, nil: nil
        }
    }

    private func version(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            source(value)
        }
    }

    private func source(_ value: String) -> some View {
        ScrollView([.horizontal, .vertical]) {
            Text(value)
                .font(.body.monospaced())
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxHeight: 180)
        .padding(8)
        .background(.background, in: RoundedRectangle(cornerRadius: 8))
    }
}

struct ArborDocumentConflictView: View {
    let conflict: WorkspaceDocumentConflict
    let resolve: (String) -> Void
    let close: () -> Void
    @State private var mergedSource: String
    @State private var choice: ArborConflictReviewChoice?

    init(
        conflict: WorkspaceDocumentConflict,
        resolve: @escaping (String) -> Void,
        close: @escaping () -> Void
    ) {
        self.conflict = conflict
        self.resolve = resolve
        self.close = close
        let analysis = ArborDocumentConflictAnalysis(conflict)
        _mergedSource = State(initialValue: analysis.automaticMergeSource ?? conflict.submittedSource)
        _choice = State(initialValue: analysis.automaticMergeSource == nil ? .mine : .both)
    }

    var body: some View {
        let analysis = ArborDocumentConflictAnalysis(conflict)
        VStack(spacing: 0) {
            HStack {
                Label("Resolve Document Conflict", systemImage: "exclamationmark.triangle")
                    .font(.headline)
                Spacer()
                Button("Close", systemImage: "xmark", action: close)
                    .labelStyle(.iconOnly)
                    .buttonStyle(.plain)
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 12)
            Divider()
            Form {
                Section("What happened") {
                    Text(analysis.headline).font(.headline)
                    Text(analysis.explanation).foregroundStyle(.secondary)
                    if let context = conflict.context {
                        LabeledContent("Reported by", value: context.kind ?? context.code)
                        if !context.paths.isEmpty {
                            LabeledContent("Conflicting paths", value: context.paths.joined(separator: ", "))
                        }
                        ForEach(Array(context.conflicts.enumerated()), id: \.offset) { _, conflict in
                            VStack(alignment: .leading, spacing: 3) {
                                Text(conflict.path).font(.headline)
                                Text(conflict.reason).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
                Section("Resolution choices") {
                    ArborConflictReviewControl(
                        content: .init(
                            base: conflict.base?.source,
                            current: conflict.current.source,
                            mine: conflict.submittedSource,
                            both: analysis.automaticMergeSource,
                            editable: true
                        ),
                        choice: $choice,
                        editedSource: $mergedSource
                    )
                    Button("Apply Choice") { submitChoice() }
                    .buttonStyle(.borderedProminent)
                }
            }
        }
#if os(macOS)
        .frame(maxWidth: 820, maxHeight: 520)
#else
        .frame(maxHeight: 460)
#endif
        .background(.background)
    }

    private func submitChoice() {
        switch choice {
        case .current: resolve(conflict.current.source)
        case .mine: resolve(conflict.submittedSource)
        case .both: resolve(ArborDocumentConflictAnalysis(conflict).automaticMergeSource ?? conflict.submittedSource)
        case .edit: resolve(mergedSource)
        case nil: break
        }
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
        case .autoMerged: "arrow.trianglehead.merge"
        case .conflict: "exclamationmark.arrow.trianglehead.2.clockwise.rotate.90"
        case .authenticationFailure: "person.crop.circle.badge.exclamationmark"
        case .revoked: "person.crop.circle.badge.xmark"
        }
    }
}

#if os(macOS)
/// Shown while a known tree opens and there is nothing on disk to preview.
/// It stays blank for a moment, so a fast open never flashes a spinner.
struct ArborLaunchOpeningView: View {
    let name: String
    @State private var showsProgress = false

    var body: some View {
        VStack(spacing: 12) {
            if showsProgress {
                ProgressView().controlSize(.small)
                Text("Opening \(name)…").foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .task {
            try? await Task.sleep(for: .milliseconds(250))
            withAnimation(.easeIn(duration: 0.2)) { showsProgress = true }
        }
    }
}

/// Shown when no tree is open: nothing placed yet, or opening failed.
struct ArborLaunchEmptyView: View {
    let message: String?
    let trees: [ArborLocalTreeMenuItem]
    let openTree: (String) -> Void
    let openLocation: () -> Void
    let showAccounts: () -> Void
    let retry: (() -> Void)?

    var body: some View {
        VStack(spacing: 20) {
            ContentUnavailableView {
                Label(message == nil ? "No Tree Open" : "Couldn’t Open Tree",
                      systemImage: message == nil ? "tree" : "exclamationmark.triangle")
            } description: {
                Text(message ?? "Open one of the trees placed on this Mac, or open a location.")
            } actions: {
                HStack {
                    if let retry { Button("Try Again", action: retry).buttonStyle(.borderedProminent) }
                    Button("Open Location…", action: openLocation)
                    Button("Accounts…", action: showAccounts)
                }
            }
            .fixedSize(horizontal: false, vertical: true)
            if !trees.isEmpty {
                VStack(alignment: .leading, spacing: 0) {
                    Text("Trees on this Mac").font(.caption).foregroundStyle(.secondary)
                        .padding(.horizontal, 12).padding(.bottom, 6)
                    ForEach(trees) { tree in
                        Button { openTree(tree.id) } label: {
                            HStack {
                                Image(systemName: "tree").foregroundStyle(.secondary)
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(tree.title)
                                    Text(tree.path).font(.caption).foregroundStyle(.secondary)
                                        .lineLimit(1).truncationMode(.head)
                                }
                                Spacer()
                            }
                            .padding(.horizontal, 12).padding(.vertical, 6)
                            .contentShape(.rect)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .frame(maxWidth: 380)
            }
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// A thin bar above a launch preview: the tree is shown from its folder and
/// becomes editable once its accepted state is confirmed.
struct ArborLaunchConfirmationBar: View {
    let phase: ArborLaunchPhase
    let retry: () -> Void

    var body: some View {
        switch phase {
        case .confirming:
            bar {
                ProgressView().controlSize(.mini)
                Text("Connecting… Editing turns on once this tree is up to date.")
            }
        case let .unconfirmed(_, message):
            bar {
                Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.yellow)
                Text("Read-only: \(message)").lineLimit(2).textSelection(.enabled)
                Spacer(minLength: 8)
                Button("Try Again", action: retry).controlSize(.small)
            }
        default:
            EmptyView()
        }
    }

    private func bar(@ViewBuilder content: () -> some View) -> some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) { content() }
                .font(.callout)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 16).padding(.vertical, 6)
            Divider()
        }
        .transition(.opacity)
    }
}
#endif
