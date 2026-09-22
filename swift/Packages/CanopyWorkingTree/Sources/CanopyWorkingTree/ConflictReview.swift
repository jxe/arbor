import Overstory
import Foundation

/// A pinned inspection. Presentation must never infer a decision from projected bytes.
public struct ConflictReviewSnapshot: Codable, Equatable, Sendable {
    public let tree: String
    public let state: String
    public let root: String
    public var decisions: [ConflictReviewDecision]

    public init(tree: String, state: String, root: String, decisions: [ConflictReviewDecision]) {
        self.tree = tree; self.state = state; self.root = root; self.decisions = decisions
    }
}

public struct ConflictReviewMaterial: Codable, Equatable, Sendable {
    public struct Material: Codable, Equatable, Sendable {
        public let kind: String
        public let path: String?
        public let object: String?
    }
    public let material: Material
    public let within: [String]?
    public let range: [Int]?
    public var path: String? {
        guard material.kind == "basis", let path = material.path else { return nil }
        return ([path == "/" ? "" : path] + (within ?? [])).joined(separator: "/") .nonemptyRoot
    }
}

public struct ConflictReviewAlternative: Codable, Equatable, Identifiable, Sendable {
    public struct Value: Codable, Equatable, Sendable {
        public let text: String?
        public let file: String?
        public let directory: String?
        public let tree: String?
        public let absent: Bool?
    }
    public struct Placement: Codable, Equatable, Sendable {
        public let parent: ConflictReviewMaterial
        public let name: String
        public var path: String? {
            parent.path.map { ($0 == "/" ? "" : $0) + "/" + name }
        }
    }
    public let id: String
    public let revision: String
    public let value: Value
    public let placement: Placement?
    public var summary: String {
        if value.absent == true { return "Deleted" }
        if value.directory != nil { return "Directory version" }
        if value.tree != nil { return "Linked tree" }
        return "Content version"
    }
}

public struct ConflictReviewDecision: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let kind: String
    public let affected: [ConflictReviewMaterial]
    public let selected: String
    public let alternatives: [ConflictReviewAlternative]
    public let dependencies: [String]
    public let actions: [String]
    public var path: String? {
        alternatives.first(where: { $0.id == selected })?.placement?.path
            ?? alternatives.compactMap { $0.placement?.path }.first
            ?? affected.first?.path
    }
    public var title: String {
        guard let path, path != "/" else { return "Tree contents" }
        let name = path.split(separator: "/").last.map(String.init) ?? path
        return name == "_index.md" ? "Page contents" : name
    }
    public var summary: String {
        if alternatives.contains(where: { $0.value.absent == true }) { return "Deleted versus changed" }
        if Set(alternatives.compactMap { $0.placement?.path }).count > 1 { return "Different locations" }
        return "\(alternatives.count) alternatives"
    }
    public var sourceRange: Range<Int>? {
        guard kind == "content", affected.count == 1, let range = affected[0].range,
              range.count == 2, range[0] >= 0, range[1] >= range[0],
              affected[0].material.kind == "basis", affected[0].material.object != nil,
              affected[0].path != nil else { return nil }
        return range[0]..<range[1]
    }
    public var scope: String {
        if let range = sourceRange { return "Resolves source bytes \(range.lowerBound)–\(range.upperBound) in \(path ?? "this page"); surrounding source stays intact" }
        if path == "/" { return "Resolves a choice affecting the whole tree" }
        if alternatives.contains(where: { $0.value.directory != nil }) { return "Resolves this directory choice" }
        return "Resolves this whole-page choice"
    }
    /// Whether this decision can be resolved without other declarations.
    /// Group compilation separately checks every structural and material obligation.
    public var supportsIndependentResolution: Bool {
        if sourceRange != nil { return dependencies.isEmpty && actions.contains("resolveConflict") }
        return dependencies.isEmpty && actions.contains("resolveConflict") &&
        affected.allSatisfy { $0.range == nil } &&
        (kind == "entry" && Set(alternatives.compactMap { $0.placement?.path }).count == 1 &&
         alternatives.allSatisfy { $0.value.file != nil || $0.value.absent == true })
    }
}

public struct ConflictReviewSelection: Codable, Equatable, Sendable {
    public var alternative: String
    public var source: String?
    public var destination: String?
    public var remove: Bool?
    public init(alternative: String, source: String? = nil, destination: String? = nil, remove: Bool? = nil) {
        self.alternative = alternative; self.source = source; self.destination = destination; self.remove = remove
    }
}

extension ConflictReviewSnapshot {
    /// A dependency component is reviewed together, including reverse edges.
    public func group(containing id: String) -> [ConflictReviewDecision] {
        var included: Set<String> = [id]
        var changed = true
        while changed {
            let before = included
            for decision in decisions where included.contains(decision.id) || !included.isDisjoint(with: decision.dependencies) {
                included.insert(decision.id); included.formUnion(decision.dependencies)
            }
            changed = before != included
        }
        return decisions.filter { included.contains($0.id) }.sorted { $0.id < $1.id }
    }
}

public struct ConflictReviewDraft: Codable, Equatable, Identifiable, Sendable {
    public var id: String { decision.id }
    public let snapshot: ConflictReviewSnapshot
    public let decision: ConflictReviewDecision
    public var alternative: String
    public var source: String?
    /// Optional for journals created by the first whole-file implementation.
    public var selections: [String: ConflictReviewSelection]?
    public var destination: String?
    public var remove: Bool?
    public var decisions: [ConflictReviewDecision] {
        [decision] + snapshot.decisions.filter { $0.id != decision.id }
    }
    public init(snapshot: ConflictReviewSnapshot, decision: ConflictReviewDecision, alternative: String, source: String? = nil) {
        self.snapshot = .init(tree: snapshot.tree, state: snapshot.state, root: snapshot.root, decisions: snapshot.group(containing: decision.id))
        self.decision = decision; self.alternative = alternative; self.source = source
    }
    public func selection(for id: String) -> ConflictReviewSelection? {
        id == self.id ? .init(alternative: alternative, source: source, destination: destination, remove: remove) : selections?[id]
    }
    public mutating func choose(_ id: String, alternative: String) throws {
        guard let decision = decisions.first(where: { $0.id == id }), decision.alternatives.contains(where: { $0.id == alternative }) else {
            throw ConflictReviewError.unsupported
        }
        var selection = selection(for: id) ?? .init(alternative: alternative)
        selection.alternative = alternative; set(selection, for: id)
    }
    public mutating func set(_ selection: ConflictReviewSelection, for id: String) {
        if id == self.id { alternative = selection.alternative; source = selection.source; destination = selection.destination; remove = selection.remove }
        else { if selections == nil { selections = [:] }; selections?[id] = selection }
    }
    public var obligations: [String] {
        var issues: [String] = []
        if Set(selections?.keys.map { $0 } ?? []).subtracting(decisions.map(\.id)).isEmpty == false {
            issues.append("The draft contains a choice outside its pinned group.")
        }
        for decision in decisions {
            guard let selection = selection(for: decision.id), decision.alternatives.contains(where: { $0.id == selection.alternative }) else {
                issues.append("Choose a version for \(decision.title)."); continue
            }
            if !decision.actions.contains("resolveConflict") || (decision.sourceRange == nil && decision.affected.contains(where: { $0.range != nil })) {
                issues.append("The scope of \(decision.title) is not supported by this reviewer.")
            }
            for dependency in decision.dependencies where !decisions.contains(where: { $0.id == dependency }) {
                issues.append("Load the dependent choice before resolving \(decision.title).")
            }
        }
        return issues
    }
    public func fingerprint() throws -> String {
        WireObjectCodec.hash(try sortedKeysJSON(self))
    }
    /// The same draft pinned to `current`, when the accepted state moved but
    /// the draft's group and every decision in it (alternatives, hashes,
    /// placements) are unchanged, so the reviewed evidence is identical. Nil
    /// when anything the reviewer saw differs; that still needs an explicit
    /// "Review latest".
    public func rebased(onto current: ConflictReviewSnapshot) -> ConflictReviewDraft? {
        guard snapshot.tree.utf8.elementsEqual(current.tree.utf8),
              Set(current.group(containing: id).map(\.id)) == Set(decisions.map(\.id)),
              decisions.allSatisfy({ decision in current.decisions.first(where: { $0.id == decision.id }) == decision })
        else { return nil }
        var next = ConflictReviewDraft(snapshot: current, decision: decision, alternative: alternative, source: source)
        next.selections = selections; next.destination = destination; next.remove = remove
        return next
    }
    public func isCurrent(in current: ConflictReviewSnapshot) -> Bool {
        snapshot.tree.utf8.elementsEqual(current.tree.utf8) && snapshot.state.utf8.elementsEqual(current.state.utf8) &&
        Set(current.group(containing: id).map(\.id)) == Set(decisions.map(\.id)) &&
        decisions.allSatisfy { decision in current.decisions.first(where: { $0.id == decision.id }) == decision }
    }
}

public struct ConflictReviewChange: Codable, Equatable, Sendable, Identifiable {
    public var id: String { path }
    public let path: String
    public let before: WireDirectoryEntry?
    public let after: WireDirectoryEntry?
    public let beforeMetadata: WireCollectionFileDescriptor?
    public let afterMetadata: WireCollectionFileDescriptor?
    public var summary: String { before == nil ? "Add" : after == nil ? "Remove" : "Change" }
}
public struct ConflictReviewPreview: Sendable {
    public let fingerprint: String
    public let changes: [ConflictReviewChange]
    public let candidate: WireSnapshot
    public var operations: [WireSourceOperation]? = nil
}
public struct ConflictReviewProposalError: LocalizedError {
    public let message: String
    public var errorDescription: String? { message }
    public init(_ message: String) { self.message = message }
}

public enum ConflictReviewError: LocalizedError {
    case unavailable, changed, unsupported, publicationPending
    public var errorDescription: String? {
        switch self {
        case .unavailable: "Conflict review is unavailable for this tree."
        case .changed: "This choice has changed. Your draft is retained. Refresh and review the alternatives before applying."
        case .unsupported: "This choice can be inspected, but this version of Arbor cannot safely resolve its scope yet."
        case .publicationPending: "Local changes are still publishing. Your draft is retained; apply after publication finishes."
        }
    }
}

struct ConflictReviewJournal: Codable {
    var schema = 2
    var drafts: [ConflictReviewDraft] = []
    var attempt: ConflictReviewAttempt?
}
struct ConflictReviewAttempt: Codable {
    let draft: ConflictReviewDraft
    let request: UpdateAttempt
}

extension UpdateControlFiles {
    func loadReview() throws -> ConflictReviewJournal {
        let url = directory.appending(path: "conflict-review.json")
        guard FileManager.default.fileExists(atPath: url.path) else { return .init() }
        let journal = try JSONDecoder().decode(ConflictReviewJournal.self, from: Data(contentsOf: url))
        guard (1...2).contains(journal.schema) else { throw ConflictReviewError.unavailable }
        return journal
    }
    func writeReview(_ journal: ConflictReviewJournal) throws {
        var next = journal; next.schema = 2
        try atomicWrite(sortedKeysJSON(next), to: directory.appending(path: "conflict-review.json"))
    }
}

private extension String {
    var nonemptyRoot: String { isEmpty ? "/" : self }
}
