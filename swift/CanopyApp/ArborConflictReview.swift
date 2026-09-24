import CanopyAppKit
import Overstory
import CanopyWorkingTree
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
            await discardSettledDrafts()
        } catch { if generation == refreshGeneration { message = error.localizedDescription } }
    }

    /// A draft whose choice was resolved (here or elsewhere) and that holds no
    /// composed source has nothing left to keep; drop it so it no longer
    /// lingers as a "retained draft". Drafts with composed text stay until
    /// discarded explicitly.
    private func discardSettledDrafts() async {
        guard snapshot != nil, !pending, !saving else { return }
        for settled in retainedDrafts where settled.id != draft?.id || !expanded {
            let composed = settled.decisions.contains { settled.selection(for: $0.id)?.source != nil }
            guard !composed else { continue }
            do {
                try await coordinator.discardReviewDraft(settled.id)
                drafts.removeAll { $0.id == settled.id }
            } catch { continue }
        }
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
        let loaded = await fetchContents(of: decision)
        guard generation == selectionGeneration else { return }
        selectedID = id; draft = next; completedID = nil; preview = nil
        contents = loaded.contents; directories = loaded.directories; message = loaded.message
        if expand { expanded = true }
    }

    private func loadContents() async {
        selectionGeneration += 1
        let generation = selectionGeneration
        guard let decision = selectedDecision else { return }
        let loaded = await fetchContents(of: decision)
        guard generation == selectionGeneration else { return }
        contents = loaded.contents; directories = loaded.directories
        if let message = loaded.message { self.message = message }
    }

    private func fetchContents(of decision: ConflictReviewDecision) async
        -> (contents: [String: Data], directories: [String: [WireDirectoryEntry]], message: String?) {
        var contents: [String: Data] = [:]
        var directories: [String: [WireDirectoryEntry]] = [:]
        var message: String?
        for alternative in decision.alternatives {
            do {
                if let bytes = try await coordinator.reviewContent(alternative) {
                    contents[alternative.id] = bytes
                }
                if alternative.value.directory != nil {
                    directories[alternative.id] = try await coordinator.reviewDirectory(alternative)
                }
            } catch {
                message = "Some alternatives could not be loaded: \(error.localizedDescription)"
            }
        }
        return (contents, directories, message)
    }

    /// The decision whose inline card is open beside its paragraph.
    var inlineID: String?

    func openInline(_ decision: ConflictReviewDecision) async {
        inlineID = decision.id
        if selectedID != decision.id { await select(decision, expand: false) }
    }

    /// Resolve the selected decision with `alternative` in one step. Dependent
    /// members nobody chose keep what they show now. The preview still runs and
    /// guards the submission, exactly as when the person asks for it.
    func keep(_ alternative: String) async {
        guard var value = draft, let decision = selectedDecision,
              decision.alternatives.contains(where: { $0.id == alternative }) else { return }
        // Keeping a version keeps it exactly: no composed text, move or removal.
        value.set(.init(alternative: alternative), for: decision.id)
        do {
            for member in value.decisions where value.selection(for: member.id) == nil {
                try value.choose(member.id, alternative: member.selected)
            }
        } catch { message = error.localizedDescription; return }
        draft = value; save(value)
        await previewAndApply()
    }

    /// Submit the draft as it stands (a composed, moved or removed result),
    /// previewing first so the fingerprint guard still holds.
    func previewAndApply() async {
        do { try await flushDraft() } catch { message = error.localizedDescription; return }
        await previewResult()
        await apply()
    }

    enum Content {
        case text(String), removed, emptyFile, directory([WireDirectoryEntry]), binary(Int), loading, unavailable(String)
    }

    /// An empty source range is a removal; an empty whole file is still a file.
    func content(of alternative: ConflictReviewAlternative, in decision: ConflictReviewDecision) -> Content {
        if alternative.value.absent == true { return .removed }
        if let entries = directories[alternative.id] { return .directory(entries) }
        guard let data = contents[alternative.id] else {
            return message == nil ? .loading : .unavailable(alternative.summary)
        }
        guard let text = String(data: data, encoding: .utf8) else { return .binary(data.count) }
        // A range reduced to its separating whitespace removed the content.
        if decision.sourceRange != nil, text.allSatisfy(\.isWhitespace) { return .removed }
        if text.isEmpty { return .emptyFile }
        return .text(text)
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
    @Bindable var review: ArborConflictReviewModel
    var previous: () -> Void
    var next: () -> Void
    /// False when a disclosure marker above the panel already collapses it.
    var showsClose = true
    @State private var discardComposition = false
    @State private var discardDraft = false
    @State private var showsOptions = false

    private static let evidenceEncoder: JSONEncoder = {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        return encoder
    }()

    private func effectEvidence(_ change: ConflictReviewChange) -> String {
        (try? String(decoding: Self.evidenceEncoder.encode(change), as: UTF8.self)) ?? change.path
    }

    private var busy: Bool { review.applying || review.previewing || review.pending || review.stale || review.showingAppliedResult }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header
            if let draft = review.draft, let decision = review.selectedDecision {
                if draft.decisions.count > 1 { linkedChoices(draft, decision) }
                if review.resolvedElsewhere {
                    Label("Resolved elsewhere · your draft is kept", systemImage: "doc")
                } else if review.stale && review.completedID != draft.id {
                    Label("This choice changed since you opened it. Your draft is kept.", systemImage: "arrow.clockwise")
                    Button("Review latest versions") { Task { await review.reviewLatest() } }
                }
                if review.selection?.source != nil {
                    composition
                } else {
                    ArborChoiceVersionCards(review: review, decision: decision, busy: busy)
                }
                adjustments(draft, decision)
                options(draft, decision)
                if let preview = review.preview, review.showingAppliedResult || review.message != nil {
                    DisclosureGroup("Result · \(preview.changes.count) changed \(preview.changes.count == 1 ? "path" : "paths")") {
                        ForEach(preview.changes) { change in
                            DisclosureGroup("\(change.summary) \(change.path)") {
                                Text(effectEvidence(change)).font(.caption.monospaced()).textSelection(.enabled)
                            }.font(.callout)
                        }
                    }.font(.callout)
                }
                HStack {
                    if review.applying || review.previewing { ProgressView().controlSize(.small) }
                    if review.showingAppliedResult { Label("Resolved", systemImage: "checkmark.circle") }
                    Spacer()
                    if review.showingAppliedResult { Button("Close") { review.expanded = false } }
                }
            }
            if review.pending {
                Label("Checking whether it applied · your draft is kept", systemImage: "arrow.triangle.2.circlepath")
                Button("Check again") { Task { await review.retry() } }.disabled(review.applying)
            }
            if let message = review.message { Text(message).font(.callout).textSelection(.enabled) }
        }
        .padding(16)
        .background(.regularMaterial)
        .confirmationDialog("Discard the edited version?", isPresented: $discardComposition) {
            Button("Discard edited version", role: .destructive) { review.useSelectedVersion() }
        }
        .confirmationDialog("Discard this review draft?", isPresented: $discardDraft) {
            Button("Discard draft", role: .destructive) { Task { await review.discard() } }
        }
    }

    private var header: some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 2) {
                Label(review.selectedDecision?.title ?? "Review choices", systemImage: "arrow.triangle.branch")
                    .font(.headline)
                if let decision = review.selectedDecision {
                    Text("\(decision.summary) · \(decision.scope)").font(.caption).foregroundStyle(.secondary)
                }
            }
            Spacer()
            Button(action: previous) { Image(systemName: "chevron.up") }.accessibilityLabel("Previous choice")
                .keyboardShortcut(.upArrow, modifiers: [.command, .option])
            Button(action: next) { Image(systemName: "chevron.down") }.accessibilityLabel("Next choice")
                .keyboardShortcut(.downArrow, modifiers: [.command, .option])
            if showsClose {
                Button { review.expanded = false } label: { Image(systemName: "xmark") }.accessibilityLabel("Close review")
            }
        }
    }

    private func linkedChoices(_ draft: ConflictReviewDraft, _ decision: ConflictReviewDecision) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Picker("Linked choice", selection: Binding(get: { decision.id }, set: { id in Task { await review.selectMember(id) } })) {
                ForEach(Array(draft.decisions.enumerated()), id: \.element.id) { index, member in
                    Text("\(index + 1). \(member.title) · \(member.summary)").tag(member.id)
                }
            }
            Text("These \(draft.decisions.count) choices depend on each other and resolve together. Any you leave alone keep what they show now.")
                .font(.caption).foregroundStyle(.secondary)
        }
    }

    private var composition: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(review.draftRetentionLabel).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            TextEditor(text: Binding(get: { review.selection?.source ?? "" }, set: { review.edit($0) }))
                .font(.body.monospaced()).frame(height: 240)
                .accessibilityLabel("Edited version")
                .disabled(busy)
            HStack {
                Button("Apply edited version") { Task { await review.previewAndApply() } }
                    .buttonStyle(.borderedProminent).disabled(busy || !(review.draft?.obligations.isEmpty ?? false))
                Button("Use a version instead…") { discardComposition = true }.disabled(busy)
            }
        }
    }

    /// Removal and moves are rare, deliberate and consequential; they stay
    /// folded away and, once set, say plainly what applying will do.
    @ViewBuilder private func adjustments(_ draft: ConflictReviewDraft, _ decision: ConflictReviewDecision) -> some View {
        if let selection = review.selection, selection.source == nil, selection.remove == true || selection.destination != nil {
            VStack(alignment: .leading, spacing: 6) {
                if selection.remove == true {
                    Label(removesRange(draft, decision) ? "Applying removes this part of the page."
                          : "Applying deletes \(decision.path ?? decision.title).", systemImage: "trash")
                }
                if let destination = selection.destination {
                    Label("Applying moves it to \(destination).", systemImage: "arrow.right")
                }
                Button("Apply") { Task { await review.previewAndApply() } }
                    .buttonStyle(.borderedProminent).disabled(busy || !draft.obligations.isEmpty)
            }
        }
    }

    private func removesRange(_ draft: ConflictReviewDraft, _ decision: ConflictReviewDecision) -> Bool {
        // In a group that also holds whole-file choices, removal applies to the file.
        decision.sourceRange != nil && draft.decisions.allSatisfy { $0.sourceRange != nil }
    }

    private func options(_ draft: ConflictReviewDraft, _ decision: ConflictReviewDecision) -> some View {
        DisclosureGroup("More options", isExpanded: $showsOptions) {
            VStack(alignment: .leading, spacing: 10) {
                if review.selection?.source == nil, review.selectedText != nil {
                    Button("Edit a combined version…") { review.compose() }.disabled(busy)
                }
                if decision.path != "/", review.selection != nil {
                    Toggle(removesRange(draft, decision) ? "Remove this part of the page" : "Delete \(decision.path ?? "this entry")",
                           isOn: Binding(get: { review.selection?.remove == true }, set: { review.removeEntry($0) }))
                        .disabled(busy)
                }
                if let selection = review.selection,
                   let alternative = decision.alternatives.first(where: { $0.id == selection.alternative }),
                   decision.path != "/", alternative.value.absent != true, selection.remove != true,
                   (decision.sourceRange == nil || draft.decisions.contains(where: { $0.sourceRange == nil })) {
                    TextField("Location", text: Binding(
                        get: { review.selection?.destination ?? alternative.placement?.path ?? decision.path ?? "" },
                        set: { review.move(to: $0) }))
                        .disabled(busy)
                    Text("Change to move it: an absolute path whose folder exists.").font(.caption).foregroundStyle(.secondary)
                }
                if let source = review.selectedText {
                    Button("Copy the selected version's source") { arborCopyToPasteboard(source) }
                }
                ForEach(Array(draft.obligations.enumerated()), id: \.offset) { _, obligation in
                    Label(obligation, systemImage: "circle").font(.caption)
                }
                if !review.showingAppliedResult {
                    Button("Discard draft…", role: .destructive) { discardDraft = true }.disabled(review.pending)
                }
            }
            .padding(.top, 6)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .font(.callout)
    }
}

/// Every version of one decision side by side (stacked when narrow), each
/// with its own Keep. Shared by the page panel and the inline card.
struct ArborChoiceVersionCards: View {
    @Bindable var review: ArborConflictReviewModel
    let decision: ConflictReviewDecision
    let busy: Bool

    private func label(_ alternative: ConflictReviewAlternative, _ index: Int) -> String {
        if alternative.id == decision.selected { return "Showing now" }
        return decision.alternatives.count == 2 ? "Other version" : "Version \(index + 1)"
    }

    var body: some View {
        let contents = decision.alternatives.map { review.content(of: $0, in: decision) }
        let texts = contents.map { content -> String? in if case let .text(text) = content { text } else { nil } }
        let listings = contents.map { content -> [WireDirectoryEntry]? in if case let .directory(entries) = content { entries } else { nil } }
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .top, spacing: 10) { cards(contents, texts, listings) }
            VStack(alignment: .leading, spacing: 10) { cards(contents, texts, listings) }
        }
    }

    @ViewBuilder private func cards(_ contents: [ArborConflictReviewModel.Content], _ texts: [String?],
                                    _ listings: [[WireDirectoryEntry]?]) -> some View {
        ForEach(Array(decision.alternatives.enumerated()), id: \.element.id) { index, alternative in
            ArborChoiceVersionCard(
                title: label(alternative, index), content: contents[index],
                baseline: texts.enumerated().first { $0.offset != index && $0.element != nil }?.element ?? nil,
                baselineEntries: listings.enumerated().first { $0.offset != index && $0.element != nil }?.element ?? nil,
                keepTitle: {
                    if case .removed = contents[index] { return decision.sourceRange != nil ? "Keep removed" : "Keep deleted" }
                    return "Keep this"
                }(),
                busy: busy
            ) { Task { await review.keep(alternative.id) } }
        }
    }
}

struct ArborChoiceVersionCard: View {
    let title: String
    let content: ArborConflictReviewModel.Content
    let baseline: String?
    var baselineEntries: [WireDirectoryEntry]? = nil
    let keepTitle: String
    let busy: Bool
    let keep: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            body(for: content)
            Button(keepTitle, action: keep).disabled(busy).controlSize(.small)
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .background(.background, in: RoundedRectangle(cornerRadius: 8))
    }

    @ViewBuilder private func body(for content: ArborConflictReviewModel.Content) -> some View {
        switch content {
        case let .text(source):
            let comparison = ArborSourceLineComparison(displayed: source, baseline: baseline)
            let lines = Self.trimmed(comparison.lines)
            let rows = VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(lines.enumerated()), id: \.offset) { index, line in
                    Text(line.isEmpty ? " " : line)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(comparison.changedLines.contains(index) ? Color.orange.opacity(0.18) : .clear)
                }
            }
            if lines.count > 12 { ScrollView { rows }.frame(maxHeight: 260) } else { rows }
        case .removed:
            placeholder("Removed")
        case .emptyFile:
            placeholder("Empty file")
        case let .directory(entries):
            // A folder (often the whole tree) is mostly the same in every
            // version; show what this version has differently.
            let differences = Self.differences(entries, from: baselineEntries)
            VStack(alignment: .leading, spacing: 4) {
                if baselineEntries != nil, differences.isEmpty {
                    Text("Same entries as the other version").font(.caption).foregroundStyle(.secondary)
                } else if baselineEntries != nil {
                    ForEach(differences.prefix(12), id: \.name) { difference in
                        Label { Text(difference.name) + Text(" · \(difference.state)").foregroundStyle(.secondary) }
                            icon: { Image(systemName: difference.symbol) }
                    }
                    if differences.count > 12 { Text("and \(differences.count - 12) more").font(.caption).foregroundStyle(.secondary) }
                } else {
                    Text("\(entries.count) \(entries.count == 1 ? "item" : "items")").font(.caption).foregroundStyle(.secondary)
                    ForEach(entries.prefix(12), id: \.name) { entry in
                        Label(entry.name, systemImage: entry.directory != nil ? "folder" : entry.tree != nil ? "link" : "doc")
                    }
                    if entries.count > 12 { Text("and \(entries.count - 12) more").font(.caption).foregroundStyle(.secondary) }
                }
            }
        case let .binary(size):
            placeholder("Binary file · \(ByteCountFormatter.string(fromByteCount: Int64(size), countStyle: .file))")
        case .loading:
            ProgressView().controlSize(.small).frame(maxWidth: .infinity, minHeight: 28)
        case let .unavailable(summary):
            placeholder(summary)
        }
    }

    struct Difference { let name: String; let state: String; let symbol: String }

    /// Entries of `entries` that the other version lacks or holds differently,
    /// then the other version's entries this one lacks.
    static func differences(_ entries: [WireDirectoryEntry], from other: [WireDirectoryEntry]?) -> [Difference] {
        guard let other else { return [] }
        let theirs = Dictionary(other.map { ($0.name, $0) }, uniquingKeysWith: { first, _ in first })
        let ours = Set(entries.map(\.name))
        func symbol(_ entry: WireDirectoryEntry) -> String { entry.directory != nil ? "folder" : entry.tree != nil ? "link" : "doc" }
        func kind(_ entry: WireDirectoryEntry) -> String { entry.directory != nil ? "folder" : entry.tree != nil ? "linked tree" : "file" }
        var result: [Difference] = []
        for entry in entries {
            guard let match = theirs[entry.name] else { result.append(.init(name: entry.name, state: "only here", symbol: symbol(entry))); continue }
            if kind(match) != kind(entry) { result.append(.init(name: entry.name, state: "a \(kind(entry)) here", symbol: symbol(entry))) }
            else if match != entry { result.append(.init(name: entry.name, state: "changed", symbol: symbol(entry))) }
        }
        for entry in other where !ours.contains(entry.name) {
            result.append(.init(name: entry.name, state: "deleted here", symbol: "trash"))
        }
        return result
    }

    private func placeholder(_ text: String) -> some View {
        Text(text).italic().foregroundStyle(.secondary).frame(maxWidth: .infinity, minHeight: 28, alignment: .leading)
    }

    /// Sources usually end in a separating blank line; it carries no meaning here.
    static func trimmed(_ lines: [String]) -> [String] {
        var lines = lines
        while lines.count > 1, lines.last?.isEmpty == true { lines.removeLast() }
        return lines
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

/// Byte-exact comparisons preserve Unicode spelling and original line endings.
struct ArborSourceLineComparison {
    /// Combined line count beyond which a line diff is not attempted.
    static let highlightedLineLimit = 4000
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
        guard lines.count + other.count <= Self.highlightedLineLimit else {
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

/// One source-range choice, shown beside the paragraph it concerns. Each
/// alternative is a card with its own Keep button; lines that differ from the
/// other alternative are tinted. Everything else stays in the full panel.
struct ArborInlineChoice: View {
    @Bindable var review: ArborConflictReviewModel
    let decision: ConflictReviewDecision
    var moreOptions: () -> Void

    private var loaded: Bool { review.selectedID == decision.id && review.draft != nil }

    private func text(_ alternative: ConflictReviewAlternative) -> String? {
        review.contents[alternative.id].flatMap { String(data: $0, encoding: .utf8) }
    }

    private var headline: String {
        guard loaded else { return "Changed in two places" }
        let selected = decision.alternatives.first { $0.id == decision.selected }
        let removedHere = selected.flatMap(text)?.isEmpty == true
        let removedElsewhere = decision.alternatives.contains { $0.id != decision.selected && text($0)?.isEmpty == true }
        if removedHere { return "Removed here · another edit kept it" }
        if removedElsewhere { return "Another edit removed this" }
        return "Changed in two places"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label(headline, systemImage: "arrow.triangle.branch")
                .font(.callout.weight(.semibold))
            if review.showingAppliedResult && review.completedID == decision.id {
                Label("Resolved", systemImage: "checkmark.circle").foregroundStyle(.secondary)
            } else if !loaded {
                ProgressView().controlSize(.small).frame(maxWidth: .infinity, minHeight: 60)
            } else {
                ArborChoiceVersionCards(review: review, decision: decision,
                    busy: review.applying || review.previewing || review.pending || review.stale)
                if review.stale {
                    Label("This choice changed. Review the latest versions.", systemImage: "arrow.clockwise").font(.caption)
                }
                HStack {
                    if review.applying || review.previewing { ProgressView().controlSize(.small) }
                    if let message = review.message { Text(message).font(.caption).foregroundStyle(.secondary).lineLimit(2) }
                    Spacer()
                    #if os(macOS)
                    Button("More options…", action: moreOptions).buttonStyle(.link).font(.caption)
                    #else
                    Button("More options…", action: moreOptions).buttonStyle(.borderless).font(.caption)
                    #endif
                }
            }
        }
        .padding(12)
        .background(.orange.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(.orange.opacity(0.35)))
        .task(id: decision.id) { await review.openInline(decision) }
    }
}
