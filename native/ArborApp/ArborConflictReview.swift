import ArborKit
import ArborWire
import ArborWorkingTree
import Foundation
import Observation
import SwiftUI
#if os(macOS)
import AppKit
#else
import UIKit
#endif

@MainActor @Observable
final class ArborConflictReviewModel {
    let coordinator: UpdateCoordinator
    private(set) var snapshot: ConflictReviewSnapshot?
    private(set) var drafts: [ConflictReviewDraft] = []
    private(set) var selectedID: String?
    private(set) var draft: ConflictReviewDraft?
    private(set) var preview: ConflictReviewPreview?
    private(set) var previewing = false
    private(set) var contents: [String: Data] = [:]
    private(set) var directories: [String: [WireDirectoryEntry]] = [:]
    private(set) var refreshing = false
    /// True only until the first inspection arrives.
    var loading: Bool { refreshing && snapshot == nil }
    private(set) var applying = false
    private(set) var pending = false
    private(set) var completedID: String?
    var message: String?
    var expanded = false
    private var refreshGeneration = 0
    private var selectionGeneration = 0
    private var saveTask: Task<Void, Never>?
    private var refreshTask: Task<Void, Never>?
    private var failedSave = false
    private(set) var saving = false
    private var saveGeneration = 0

    init(coordinator: UpdateCoordinator) { self.coordinator = coordinator }
    var decisions: [ConflictReviewDecision] { snapshot?.decisions ?? [] }
    var retainedDrafts: [ConflictReviewDraft] { drafts.filter { draft in !decisions.contains { $0.id == draft.id } } }
    var hasEntries: Bool { !decisions.isEmpty || !drafts.isEmpty || pending }
    var selectedDecision: ConflictReviewDecision? { draft?.decisions.first { $0.id == selectedID } ?? draft?.decision }
    var selection: ConflictReviewSelection? { selectedDecision.flatMap { draft?.selection(for: $0.id) } }
    var showingAppliedResult: Bool { completedID != nil && completedID == draft?.id && !drafts.contains { $0.id == completedID } }
    var draftRetentionLabel: String {
        if showingAppliedResult { return "Applied result" }
        if failedSave { return "Proposed result · Draft retention failed" }
        return saving ? "Proposed result · Retaining draft…" : "Proposed result · Draft retained locally"
    }
    var stale: Bool { draft.map { draft in snapshot.map { !draft.isCurrent(in: $0) } ?? true } ?? false }
    var resolvedElsewhere: Bool { !pending && selectedID != completedID && selectedID.map { id in snapshot != nil && !decisions.contains { $0.id == id } } ?? false }
    var canApply: Bool {
        guard let draft, !stale, !applying, !pending, !failedSave, !saving,
              draft.obligations.isEmpty, let preview else { return false }
        return (try? draft.fingerprint()) == preview.fingerprint
    }
    var selectedText: String? {
        guard let selection else { return nil }
        if let source = selection.source { return source }
        return contents[selection.alternative].flatMap { String(data: $0, encoding: .utf8) }
    }

    func previewResult() async {
        guard let value = draft, !stale, !previewing else { return }
        previewing = true; message = nil
        defer { previewing = false }
        do {
            let result = try await coordinator.previewReviewDraft(value)
            guard let current = draft, try current.fingerprint() == result.fingerprint else { return }
            preview = result
        } catch { message = error.localizedDescription }
    }

    func scheduleRefresh() {
        refreshTask?.cancel()
        refreshTask = Task { [weak self] in
            do { try await Task.sleep(for: .milliseconds(250)) } catch { return }
            await self?.refresh()
        }
    }

    /// Re-inspect choices and retained drafts. Values are only published when
    /// they change, and `loading` is only shown before the first result, so a
    /// background refresh never redraws or reflows anything by itself.
    func refresh() async {
        refreshGeneration += 1
        let generation = refreshGeneration
        refreshing = true
        defer { if generation == refreshGeneration { refreshing = false } }
        do {
            await saveTask?.value
            let capturedSaveGeneration = saveGeneration
            var drafts = try await coordinator.reviewDrafts()
            if failedSave, let draft {
                drafts.removeAll { $0.id == draft.id }; drafts.append(draft)
            }
            let pending = try await coordinator.reviewSubmissionPending()
            guard generation == refreshGeneration else { return }
            if (capturedSaveGeneration != saveGeneration || saving || failedSave), let draft {
                drafts.removeAll { $0.id == draft.id }; drafts.append(draft)
            }
            if self.drafts != drafts { self.drafts = drafts }
            if self.pending != pending { self.pending = pending }
            let snapshot = try await coordinator.inspectChoices()
            guard generation == refreshGeneration else { return }
            if self.snapshot != snapshot { self.snapshot = snapshot }
            rebaseOpenDraft(onto: snapshot)
        } catch { if generation == refreshGeneration { message = error.localizedDescription } }
    }

    /// An unrelated accepted update moves the snapshot state without changing
    /// anything the open draft shows; follow it instead of marking it stale.
    private func rebaseOpenDraft(onto snapshot: ConflictReviewSnapshot) {
        guard let current = draft, !current.isCurrent(in: snapshot), !pending,
              let rebased = current.rebased(onto: snapshot) else { return }
        draft = rebased
        save(rebased)
    }

    /// Selects a decision. Its alternatives load before anything is published,
    /// so the panel appears (or switches) once, at its final shape.
    func select(_ decision: ConflictReviewDecision, expand: Bool = true) async {
        guard let snapshot else { return }
        do { try await flushDraft() } catch { message = error.localizedDescription; return }
        let next = drafts.first(where: { $0.decisions.contains { $0.id == decision.id } })
            ?? .init(snapshot: snapshot, decision: decision, alternative: decision.selected)
        await show(next, selecting: decision.id, expand: expand)
    }

    func openRetained(_ value: ConflictReviewDraft) async {
        do { try await flushDraft() } catch { message = error.localizedDescription; return }
        await show(value, selecting: value.id, expand: true)
    }

    private func show(_ next: ConflictReviewDraft, selecting id: String, expand: Bool) async {
        guard let decision = next.decisions.first(where: { $0.id == id }) else { return }
        selectionGeneration += 1
        let generation = selectionGeneration
        let loaded = await fetchContents(of: decision, state: next.snapshot.state)
        guard generation == selectionGeneration else { return }
        selectedID = id; draft = next; completedID = nil; preview = nil
        contents = loaded.contents; directories = loaded.directories; message = loaded.message
        if expand { expanded = true }
    }

    private func loadContents() async {
        selectionGeneration += 1
        let generation = selectionGeneration
        guard let draft, let decision = selectedDecision else { return }
        let loaded = await fetchContents(of: decision, state: draft.snapshot.state)
        guard generation == selectionGeneration else { return }
        contents = loaded.contents; directories = loaded.directories
        if let message = loaded.message { self.message = message }
    }

    private func fetchContents(of decision: ConflictReviewDecision, state: String) async
        -> (contents: [String: Data], directories: [String: [WireDirectoryEntry]], message: String?) {
        var contents: [String: Data] = [:]
        var directories: [String: [WireDirectoryEntry]] = [:]
        var message: String?
        for alternative in decision.alternatives {
            do {
                if let bytes = try await coordinator.reviewContent(alternative, decision: decision.id, state: state) {
                    contents[alternative.id] = bytes
                }
                if alternative.value.directory != nil {
                    directories[alternative.id] = try await coordinator.reviewDirectory(alternative, decision: decision.id, state: state)
                }
            } catch {
                message = "Some alternatives could not be loaded: \(error.localizedDescription)"
            }
        }
        return (contents, directories, message)
    }

    func selectMember(_ id: String) async {
        guard let draft, draft.decisions.contains(where: { $0.id == id }) else { return }
        await show(draft, selecting: id, expand: expanded)
    }
    func choose(_ id: String) {
        guard var value = draft, let decision = selectedDecision else { return }
        do { try value.choose(decision.id, alternative: id) }
        catch { message = error.localizedDescription; return }
        draft = value; save(value)
    }
    private func updateSelection(_ change: (inout ConflictReviewSelection) -> Void) {
        guard var value = draft, let decision = selectedDecision, var choice = selection else { return }
        change(&choice); value.set(choice, for: decision.id)
        draft = value; save(value)
    }
    func compose() {
        guard let text = selectedText else { return }
        updateSelection { $0.source = text }
    }
    func edit(_ source: String) { updateSelection { $0.source = source } }
    func useSelectedVersion() { updateSelection { $0.source = nil } }
    func removeEntry(_ remove: Bool) { updateSelection { $0.remove = remove } }
    func move(to destination: String) { updateSelection { $0.destination = destination.isEmpty ? nil : destination } }
    private func save(_ value: ConflictReviewDraft) {
        preview = nil
        drafts.removeAll { $0.id == value.id }; drafts.append(value)
        saveGeneration += 1
        let generation = saveGeneration
        saving = true
        let previous = saveTask
        saveTask = Task { [weak self, coordinator] in
            await previous?.value
            defer { if self?.saveGeneration == generation { self?.saving = false } }
            do {
                try await coordinator.retainReviewDraft(value)
                self?.failedSave = false
            } catch {
                self?.failedSave = true
                self?.message = "Draft could not be retained: \(error.localizedDescription)"
            }
        }
    }

    func flushDraft() async throws {
        await saveTask?.value
        if failedSave, let draft {
            try await coordinator.retainReviewDraft(draft)
            failedSave = false
        }
    }

    /// Explicitly refresh evidence while preserving the exact composed text.
    func reviewLatest() async {
        guard let snapshot, let old = draft,
              let current = decisions.first(where: { $0.id == old.id }) else { return }
        let alternative = current.alternatives.contains { $0.id == old.alternative } ? old.alternative : current.selected
        var next = ConflictReviewDraft(snapshot: snapshot, decision: current, alternative: alternative, source: old.source)
        guard Set(old.decisions.map(\.id)).isSubset(of: Set(next.decisions.map(\.id))) else {
            message = "This group has changed. Your original draft is retained; copy any composed sources before discarding it and starting a new review."
            return
        }
        for member in next.decisions {
            if let selection = old.selection(for: member.id) {
                // Preserve stale choices as obligations instead of silently discarding composition.
                next.set(selection, for: member.id)
            }
        }
        if !next.decisions.contains(where: { $0.id == selectedID }) { selectedID = next.id }
        draft = next; save(next); message = nil
        await loadContents()
    }
    func discard() async {
        guard let id = draft?.id else { return }
        await saveTask?.value
        do {
            try await coordinator.discardReviewDraft(id)
            drafts.removeAll { $0.id == id }; draft = nil; selectedID = nil; expanded = false; failedSave = false
        } catch { message = error.localizedDescription }
    }
    func apply() async {
        guard canApply, let value = draft else { return }
        applying = true; message = nil
        defer { applying = false }
        await saveTask?.value
        guard !failedSave else { return }
        do {
            try await coordinator.applyReviewDraft(value)
            pending = try await coordinator.reviewSubmissionPending()
            if !pending { completedID = value.id }
            message = pending ? "Waiting to apply. Your draft is retained." : "Choice resolved."
        } catch { message = error.localizedDescription }
        await refresh()
    }
    func retry() async {
        applying = true
        defer { applying = false }
        do { _ = try await coordinator.syncOnce(); message = nil }
        catch { message = error.localizedDescription }
        await refresh()
    }
}

struct ArborChoiceReviewPanel: View {
    /// Every source presentation (comparison, composition, directory listing,
    /// placeholders) shares one height so switching between them never reflows
    /// the page.
    static let sourceHeight: CGFloat = 240
    @Bindable var review: ArborConflictReviewModel
    var previous: () -> Void
    var next: () -> Void
    /// False when a disclosure marker above the panel already collapses it.
    var showsClose = true
    @State private var discardComposition = false
    @State private var discardDraft = false

    private func effectEvidence(_ change: ConflictReviewChange) -> String {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        return (try? String(decoding: encoder.encode(change), as: UTF8.self)) ?? change.path
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Label(review.selectedDecision?.title ?? "Review choices", systemImage: "arrow.triangle.branch")
                    .font(.headline)
                Spacer()
                Button(action: previous) { Image(systemName: "chevron.up") }.accessibilityLabel("Previous choice")
                    .keyboardShortcut(.upArrow, modifiers: [.command, .option])
                Button(action: next) { Image(systemName: "chevron.down") }.accessibilityLabel("Next choice")
                    .keyboardShortcut(.downArrow, modifiers: [.command, .option])
                if showsClose {
                    Button { review.expanded = false } label: { Image(systemName: "xmark") }.accessibilityLabel("Close review")
                }
            }
            if let draft = review.draft, let decision = review.selectedDecision {
                if draft.decisions.count > 1 {
                    Text("Resolve \(draft.decisions.count) dependent choices together").font(.subheadline)
                    Picker("Choice in group", selection: Binding(get: { decision.id }, set: { id in Task { await review.selectMember(id) } })) {
                        ForEach(draft.decisions) { member in
                            Text("\(draft.selection(for: member.id) == nil ? "○" : "✓") \(member.path ?? member.title)").tag(member.id)
                        }
                    }
                }
                Text(decision.scope).font(.caption).foregroundStyle(.secondary)
                if review.resolvedElsewhere {
                    Label("Choice resolved · Your draft retained", systemImage: "doc")
                } else if review.stale && review.completedID != draft.id {
                    Label("This choice has changed. Your draft is retained.", systemImage: "arrow.clockwise")
                    Button("Review latest alternatives") { Task { await review.reviewLatest() } }
                }
                Picker("Alternative", selection: Binding(get: { review.selection?.alternative ?? "" }, set: { review.choose($0) })) {
                    if review.selection == nil { Text("Choose a version…").tag("") }
                    ForEach(Array(decision.alternatives.enumerated()), id: \.element.id) { index, alternative in
                        Text("Version \(index + 1)\(alternative.id == decision.selected ? " · Currently displayed" : "")")
                            .tag(alternative.id)
                    }
                }.disabled(review.pending || review.showingAppliedResult)
                if let selection = review.selection {
                    if decision.path != "/" {
                        Toggle(decision.sourceRange != nil && draft.decisions.allSatisfy({ $0.sourceRange != nil }) ? "Remove this source range" : "Remove this entry in the combined result", isOn: Binding(
                            get: { review.selection?.remove == true }, set: { review.removeEntry($0) }))
                            .disabled(review.pending || review.showingAppliedResult)
                        if selection.remove == true {
                            Text(decision.sourceRange != nil && draft.decisions.allSatisfy({ $0.sourceRange != nil })
                                 ? "The retained versions stay in this draft. Only the indicated source range will be removed."
                                 : "The retained versions stay in this draft, but this entry will be absent from the submitted tree.")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    if selection.source != nil {
                        Text(review.draftRetentionLabel).font(.caption)
                        TextEditor(text: Binding(get: { review.selection?.source ?? "" }, set: { review.edit($0) }))
                            .font(.body.monospaced()).frame(height: ArborChoiceReviewPanel.sourceHeight)
                            .accessibilityLabel("Proposed resolution source")
                            .disabled(review.showingAppliedResult || review.pending)
                        if !review.showingAppliedResult {
                            Button("Use selected version instead…") { discardComposition = true }
                        }
                    } else if let alternative = decision.alternatives.first(where: { $0.id == selection.alternative }) {
                        if let entries = review.directories[alternative.id] {
                            Text("\(entries.count) entries in this directory version").font(.caption)
                            ScrollView {
                                LazyVStack(alignment: .leading, spacing: 8) {
                                    ForEach(entries, id: \.name) { entry in
                                        Label(entry.name, systemImage: entry.directory != nil ? "folder" : entry.tree != nil ? "link" : "doc")
                                    }
                                }.frame(maxWidth: .infinity, alignment: .leading)
                            }.frame(height: ArborChoiceReviewPanel.sourceHeight)
                        } else if alternative.value.absent == true {
                            Label("This version removes the entry.", systemImage: "trash")
                                .frame(maxWidth: .infinity, minHeight: ArborChoiceReviewPanel.sourceHeight)
                        } else if let data = review.contents[alternative.id], let text = String(data: data, encoding: .utf8), alternative.value.file != nil || alternative.value.text != nil {
                            ArborChoiceSourceComparison(
                                current: review.contents[decision.selected].flatMap { String(data: $0, encoding: .utf8) },
                                proposed: text, sameAlternative: selection.alternative == decision.selected)
                            Button("Compose a result") { review.compose() }.disabled(review.showingAppliedResult || review.pending)
                        } else if let data = review.contents[alternative.id] {
                            Text("Binary content · \(data.count.formatted()) bytes")
                                .frame(maxWidth: .infinity, minHeight: ArborChoiceReviewPanel.sourceHeight)
                        } else {
                            Text(alternative.summary).foregroundStyle(.secondary)
                                .frame(maxWidth: .infinity, minHeight: ArborChoiceReviewPanel.sourceHeight)
                        }
                    }
                    if let alternative = decision.alternatives.first(where: { $0.id == selection.alternative }),
                       decision.path != "/", alternative.value.absent != true, selection.remove != true,
                       (decision.sourceRange == nil || draft.decisions.contains(where: { $0.sourceRange == nil })) {
                            TextField("Destination", text: Binding(
                                get: { review.selection?.destination ?? alternative.placement?.path ?? decision.path ?? "" },
                                set: { review.move(to: $0) }))
                                .disabled(review.pending || review.showingAppliedResult)
                            Text("Absolute path within this tree. The parent must exist in the proposed result.")
                                .font(.caption).foregroundStyle(.secondary)
                    }
                }
                ForEach(Array(draft.obligations.enumerated()), id: \.offset) { _, obligation in
                    Label(obligation, systemImage: "circle").font(.callout)
                }
                if let preview = review.preview {
                    Text("Combined result · \(preview.changes.count) changed paths").font(.headline)
                    if preview.changes.isEmpty { Text("Keep the displayed tree and resolve the selected choices.") }
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 6) {
                            ForEach(preview.changes) { change in
                                DisclosureGroup("\(change.summary) \(change.path)") {
                                    Text(effectEvidence(change)).font(.caption.monospaced()).textSelection(.enabled)
                                }.font(.callout)
                            }
                        }.frame(maxWidth: .infinity, alignment: .leading)
                    }.frame(maxHeight: 200)
                }
                if let source = review.selectedText {
                    Button("Copy exact source") {
#if os(macOS)
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(source, forType: .string)
#else
                        UIPasteboard.general.string = source
#endif
                    }
                }
                HStack {
                    Button(review.previewing ? "Preparing preview…" : "Preview combined result") { Task { await review.previewResult() } }
                        .disabled(review.previewing || review.stale || review.pending || !draft.obligations.isEmpty)
                    Button("Apply and resolve") { Task { await review.apply() } }
                        .buttonStyle(.borderedProminent).disabled(!review.canApply)
                    if review.applying { ProgressView().controlSize(.small) }
                    Spacer()
                    if review.showingAppliedResult {
                        Button("Close review") { review.expanded = false }
                    } else {
                        Button("Discard draft…", role: .destructive) { discardDraft = true }.disabled(review.pending)
                    }
                }
            }
            if review.pending {
                Label("Checking whether applied · Draft retained", systemImage: "arrow.triangle.2.circlepath")
                Button("Check again") { Task { await review.retry() } }.disabled(review.applying)
            }
            if let message = review.message { Text(message).font(.callout).textSelection(.enabled) }
        }
        .padding(16)
        .background(.regularMaterial)
        .confirmationDialog("Discard the composed result and use the selected version?", isPresented: $discardComposition) {
            Button("Discard composed result", role: .destructive) { review.useSelectedVersion() }
        }
        .confirmationDialog("Discard this review draft?", isPresented: $discardDraft) {
            Button("Discard draft", role: .destructive) { Task { await review.discard() } }
        }
    }
}

struct ArborChoiceReviewList: View {
    @Bindable var review: ArborConflictReviewModel
    var back: () -> Void
    var open: (ConflictReviewDecision) -> Void
    var openDraft: (ConflictReviewDraft) -> Void

    private var groupedChoices: [(path: String, decisions: [ConflictReviewDecision])] {
        Dictionary(grouping: review.decisions, by: { $0.path ?? "Location unavailable" })
            .map { (path: $0.key, decisions: $0.value.sorted { $0.id < $1.id }) }
            .sorted { $0.path < $1.path }
    }

    /// A page title for a decision path: `/notes/idea.md` → "idea",
    /// `/notes/_index.md` → "notes", `/` → "Tree contents".
    static func pageTitle(_ path: String) -> (title: String, context: String?) {
        var parts = path.split(separator: "/").map(String.init)
        guard let last = parts.last else { return ("Tree contents", nil) }
        if last == "_index.md" { parts.removeLast() }
        else if last.hasSuffix(".md") { parts[parts.count - 1] = String(last.dropLast(3)) }
        guard let title = parts.popLast() else { return ("Tree contents", nil) }
        return (title, parts.isEmpty ? nil : "/" + parts.joined(separator: "/"))
    }

    private var selection: Binding<String?> {
        Binding(get: { review.selectedID }, set: { id in
            guard let id, id != review.selectedID else { return }
            if let decision = review.decisions.first(where: { $0.id == id }) { open(decision) }
            else if let draft = review.retainedDrafts.first(where: { $0.id == id }) { openDraft(draft) }
        })
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Button(action: back) { Image(systemName: "chevron.left") }
                    .buttonStyle(.borderless)
                    .accessibilityLabel("All pages")
                    .help("Back to all pages")
                Text(review.snapshot == nil ? "Choices" : "Choices · \(review.decisions.count)")
                    .font(.headline)
                Spacer()
                if review.refreshing, review.snapshot != nil {
                    ProgressView().controlSize(.small)
                } else {
                    Button { Task { await review.refresh() } } label: { Image(systemName: "arrow.clockwise") }
                        .buttonStyle(.borderless)
                        .accessibilityLabel("Refresh choices")
                        .help("Refresh choices")
                }
            }
            .padding(.horizontal, 12)
            .frame(height: 44)
            Divider()
            List(selection: selection) {
                ForEach(groupedChoices, id: \.path) { group in
                    let page = Self.pageTitle(group.path)
                    Section {
                        ForEach(group.decisions) { decision in
                            VStack(alignment: .leading, spacing: 2) {
                                Text(decision.summary).lineLimit(2)
                                if review.drafts.contains(where: { $0.id == decision.id }) {
                                    Text("Draft retained").font(.caption).foregroundStyle(.secondary)
                                }
                            }
                            .padding(.vertical, 2)
                            .tag(decision.id)
                        }
                    } header: {
                        HStack(spacing: 4) {
                            Text(page.title)
                            if let context = page.context {
                                Text(context).foregroundStyle(.tertiary).lineLimit(1).truncationMode(.head)
                            }
                        }
                    }
                }
                if !review.retainedDrafts.isEmpty {
                    Section("Retained drafts") {
                        ForEach(review.retainedDrafts) { draft in
                            VStack(alignment: .leading, spacing: 2) {
                                Text(draft.decision.title).lineLimit(2)
                                Text(review.snapshot == nil ? "Status unavailable" : "Choice resolved")
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                            .tag(draft.id)
                        }
                    }
                }
            }
            .listStyle(.sidebar)
            .overlay {
                if review.loading {
                    ProgressView()
                } else if let message = review.message, review.snapshot == nil {
                    ContentUnavailableView("Choices unavailable", systemImage: "exclamationmark.triangle", description: Text(message))
                } else if review.snapshot != nil, review.decisions.isEmpty, review.retainedDrafts.isEmpty {
                    ContentUnavailableView("No choices", systemImage: "checkmark.circle",
                        description: Text("Every choice in this tree has been reviewed."))
                }
            }
            if let message = review.message, review.snapshot != nil {
                Divider()
                Text(message).font(.caption).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(12)
            }
        }
    }
}

/// Comparison is a presentation of exact source, never an independently resolvable hunk.
private struct ArborChoiceSourceComparison: View {
    let current: String?
    let proposed: String
    let sameAlternative: Bool
    @State private var showCurrent = false
    @State private var viewportWidth: CGFloat = 0
    var body: some View {
        let displayed = showCurrent && !sameAlternative ? current ?? proposed : proposed
        let comparison = ArborSourceLineComparison(
            displayed: displayed,
            baseline: sameAlternative ? nil : (showCurrent ? proposed : current))
        VStack(alignment: .leading, spacing: 6) {
            // One header row in every mode keeps the comparison's height fixed.
            HStack {
                Text(showCurrent && !sameAlternative ? "Currently displayed" : "Proposed result").font(.caption).bold()
                Spacer()
                if !sameAlternative, current != nil {
                    Text(comparison.status).font(.caption).foregroundStyle(.secondary)
                    Button(showCurrent ? "Show proposed" : "Compare with displayed") { showCurrent.toggle() }
                        .controlSize(.small)
                }
            }
            .frame(height: 22)
            ScrollView([.horizontal, .vertical]) {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(comparison.lines.indices, id: \.self) { index in
                        Text(displayed.isEmpty ? "(Empty file)" : comparison.lines[index].isEmpty ? " " : comparison.lines[index])
                            .font(.body.monospaced())
                            .foregroundStyle(Color.primary)
                            .textSelection(.enabled)
                            .fixedSize(horizontal: true, vertical: true)
                            // Highlight bands span at least the visible width.
                            .frame(minWidth: max(viewportWidth - 16, 0), alignment: .leading)
                            .background(comparison.changedLines.contains(index) ? Color.accentColor.opacity(0.25) : Color.clear)
                    }
                }.padding(8)
            }
            .onGeometryChange(for: CGFloat.self, of: \.size.width) { viewportWidth = $0 }
            .frame(height: ArborChoiceReviewPanel.sourceHeight - 40)
            .background(.background, in: RoundedRectangle(cornerRadius: 8))
        }
    }
}

/// Byte-exact comparisons preserve Unicode spelling and original line endings.
struct ArborSourceLineComparison {
    let lines: [String]
    let changedLines: Set<Int>
    let status: String

    init(displayed: String, baseline: String?) {
        lines = displayed.components(separatedBy: "\n")
        guard let baseline else {
            changedLines = []
            status = "Comparison unavailable"
            return
        }
        guard Data(displayed.utf8) != Data(baseline.utf8) else {
            changedLines = []
            status = "Identical source"
            return
        }
        let other = baseline.components(separatedBy: "\n")
        guard lines.count + other.count <= 4000 else {
            changedLines = []
            status = "Highlighting unavailable for this large comparison"
            return
        }
        let changes = lines.map { Data($0.utf8) }.difference(from: other.map { Data($0.utf8) })
        changedLines = Set(changes.compactMap { change -> Int? in
            if case let .insert(offset, _, _) = change { return offset }
            return nil
        })
        status = changedLines.isEmpty
            ? "Changes appear in the other version"
            : "\(changedLines.count) changed line\(changedLines.count == 1 ? "" : "s") highlighted"
    }
}
