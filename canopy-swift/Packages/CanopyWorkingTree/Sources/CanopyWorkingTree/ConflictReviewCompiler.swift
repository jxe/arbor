import Overstory
import Foundation

/// Pure graph compilation after authorized material loading. No live document is
/// mutated, and no operation history is guessed from a directory diff.
enum ConflictReviewCompiler {
    static func compile(_ draft: ConflictReviewDraft, base: WireSnapshot, material: [String: Data], allDecisions: [ConflictReviewDecision] = []) throws -> ConflictReviewPreview {
        guard base.root == draft.snapshot.root else { throw ConflictReviewError.changed }
        _ = try WireObjectGraph.validate(base)
        guard draft.obligations.isEmpty else { throw ConflictReviewProposalError(draft.obligations.joined(separator: "\n")) }
        var objects = Dictionary(uniqueKeysWithValues: base.objects.map { ($0.hash, $0.bytes) })
        for (hash, bytes) in material {
            guard WireObjectCodec.hash(bytes) == hash else { throw ConflictReviewError.unavailable }
            objects[hash] = bytes
        }
        var root = base.root
        func store(_ object: WireObject) throws -> String {
            let bytes = try WireObjectCodec.encode(object), hash = WireObjectCodec.hash(bytes)
            objects[hash] = bytes; return hash
        }
        func parts(_ path: String) throws -> [String] {
            let parts = path.dropFirst().split(separator: "/", omittingEmptySubsequences: false).map(String.init)
            guard path.hasPrefix("/"), path != "/", parts.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." && !$0.contains("\\") && !$0.contains("\0") }) else {
                throw ConflictReviewProposalError("Choose a valid absolute destination within this tree.")
            }
            return parts
        }
        func entries(_ hash: String) throws -> ([WireDirectoryEntry], WireCollectionFileDescriptor?) {
            guard let bytes = objects[hash], case let .directory(entries, metadata) = try WireObjectCodec.decode(bytes, kind: .directory) else {
                throw ConflictReviewError.unavailable
            }
            return (entries, metadata)
        }
        func entry(_ path: String, in root: String) throws -> WireDirectoryEntry? {
            if path == "/" { return .init(name: "", directory: root) }
            let names = try parts(path); var cursor = root
            for (i, name) in names.enumerated() {
                let child = try entries(cursor).0.first { $0.name == name }
                if i == names.count - 1 { return child }
                guard let directory = child?.directory else { return nil }; cursor = directory
            }
            return nil
        }
        func rewrite(_ hash: String, names: [String], depth: Int, value: WireDirectoryEntry?) throws -> String {
            var (children, metadata) = try entries(hash)
            let name = names[depth]
            if depth == names.count - 1 {
                children.removeAll { $0.name == name }
                if var value { value.name = name; children.append(value) }
            } else {
                guard let index = children.firstIndex(where: { $0.name == name }), let directory = children[index].directory else {
                    if value == nil { return hash }
                    throw ConflictReviewProposalError("The destination parent for /\(names.joined(separator: "/")) is absent or crosses a tree boundary. Choose another destination or restore its directory.")
                }
                children[index].directory = try rewrite(directory, names: names, depth: depth + 1, value: value)
            }
            children.sort { Array($0.name.utf8).lexicographicallyPrecedes(Array($1.name.utf8)) }
            return try store(.directory(children, childrenSource: metadata))
        }
        struct Assignment { let decision: ConflictReviewDecision; let old: String; let destination: String; let value: WireDirectoryEntry? }
        var assignments: [Assignment] = []
        struct RangeEdit { let decision: ConflictReviewDecision; let range: Range<Int>; let replacement: Data }
        var rangeEdits: [String: [RangeEdit]] = [:]
        var rangeOperations: [WireSourceOperation] = []
        let onlyRanges = draft.decisions.allSatisfy { $0.sourceRange != nil }
        for decision in draft.decisions {
            guard let selection = draft.selection(for: decision.id),
                  let alternative = decision.alternatives.first(where: { $0.id == selection.alternative }),
                  let old = decision.path else { throw ConflictReviewError.unsupported }
            if let range = decision.sourceRange {
                let currentFile = try entry(old, in: base.root)?.file
                guard let projected = decision.affected[0].material.object,
                      (!onlyRanges || currentFile == projected),
                      let bytes = objects[projected], range.upperBound <= bytes.count,
                      String(data: bytes.prefix(range.lowerBound), encoding: .utf8) != nil,
                      String(data: bytes.suffix(bytes.count - range.upperBound), encoding: .utf8) != nil else {
                    throw ConflictReviewProposalError("The source range no longer matches its pinned file.")
                }
                let replacement: Data
                if selection.remove == true { replacement = Data() }
                else if let source = selection.source { replacement = Data(source.utf8) }
                else if let text = alternative.value.text { replacement = Data(text.utf8) }
                else if let file = alternative.value.file, let data = objects[file] { replacement = data }
                else { throw ConflictReviewError.unsupported }
                guard let text = String(data: replacement, encoding: .utf8) else { throw ConflictReviewError.unsupported }
                rangeEdits[old, default: []].append(.init(decision: decision, range: range, replacement: replacement))
                let target = try JSONDecoder().decode(WireSemanticValue.self, from: JSONEncoder().encode(decision.affected[0]))
                let key = "review-\(rangeOperations.count)"
                if selection.source == nil, selection.remove != true {
                    rangeOperations.append(try .init(["key": .string(key + "-copy"), "kind": .string("copySource"),
                        "source": .object(["material": .object(["kind": .string("alternative"), "state": .string(draft.snapshot.state),
                            "conflict": .string(decision.id), "alternative": .string(alternative.id)])]),
                        "at": target, "side": .string("before")]))
                    rangeOperations.append(try .init(["key": .string(key + "-remove"), "kind": .string("editSource"), "source": target, "text": .string("")]))
                } else {
                    rangeOperations.append(try .init(["key": .string(key), "kind": .string("editSource"), "source": target, "text": .string(text)]))
                }
                continue
            }
            guard decision.kind == "entry" || (decision.kind == "directory" && old == "/") else { throw ConflictReviewError.unsupported }
            let destination = selection.destination ?? alternative.placement?.path ?? old
            if old != "/" { _ = try parts(old); _ = try parts(destination) }
            else if destination != "/" { throw ConflictReviewProposalError("The tree root cannot be moved into an entry.") }
            var value: WireDirectoryEntry?
            if selection.remove == true { value = nil }
            else if let source = selection.source {
                guard alternative.value.file != nil || alternative.value.text != nil else {
                    throw ConflictReviewProposalError("Compose text only for a file alternative.")
                }
                value = .init(name: "", file: try store(.file(Data(source.utf8))))
            } else if let file = alternative.value.file { value = .init(name: "", file: file) }
            else if let directory = alternative.value.directory { value = .init(name: "", directory: directory) }
            else if let tree = alternative.value.tree { value = .init(name: "", tree: tree) }
            else if alternative.value.absent != true { throw ConflictReviewError.unsupported }
            if old == "/", value?.directory == nil { throw ConflictReviewProposalError("The tree root must remain a directory.") }
            assignments.append(.init(decision: decision, old: old, destination: destination, value: value))
        }
        for path in rangeEdits.keys.sorted() {
            let edits = rangeEdits[path]!.sorted { $0.range.lowerBound < $1.range.lowerBound }
            for pair in zip(edits, edits.dropFirst()) where pair.0.range.upperBound > pair.1.range.lowerBound || pair.0.range.lowerBound == pair.1.range.lowerBound {
                throw ConflictReviewProposalError("Overlapping source choices must be reviewed through their enclosing structural decision.")
            }
            guard !assignments.contains(where: { $0.old == path }),
                  let first = edits.first, let file = first.decision.affected[0].material.object, var bytes = objects[file],
                  edits.allSatisfy({ $0.decision.affected[0].material.object == file }) else { throw ConflictReviewError.unsupported }
            let selections = edits.compactMap { draft.selection(for: $0.decision.id) }
            let destinations = Set(selections.compactMap(\.destination))
            guard destinations.count <= 1 else { throw ConflictReviewProposalError("Source choices in one file need the same destination.") }
            let destination = destinations.first ?? path
            if onlyRanges && destination != path { throw ConflictReviewProposalError("A source-range choice cannot move its whole file. Resolve the source, then move the page.") }
            for edit in edits.reversed() { bytes.replaceSubrange(edit.range, with: edit.replacement) }
            let removesFile = !onlyRanges && selections.allSatisfy { $0.remove == true }
            if !onlyRanges && selections.contains(where: { $0.remove == true }) && !removesFile {
                throw ConflictReviewProposalError("Choose one consistent disposition for the source choices in this file.")
            }
            assignments.append(.init(decision: first.decision, old: path, destination: destination,
                value: removesFile ? nil : .init(name: "", file: try store(.file(bytes)))))
        }
        let nonabsent = assignments.filter { $0.value != nil }
        guard Set(nonabsent.map(\.destination)).count == nonabsent.count else {
            throw ConflictReviewProposalError("Two chosen entries have the same destination. Choose distinct destinations.")
        }
        if let whole = assignments.first(where: { $0.old == "/" }), let directory = whole.value?.directory { root = directory }
        for path in rangeEdits.keys {
            if let chosen = try entry(path, in: root), chosen.file != rangeEdits[path]?.first?.decision.affected[0].material.object {
                throw ConflictReviewProposalError("The selected parent changes the source around \(path). Review that enclosing source as a whole entry.")
            }
        }
        // Remove every old placement first, allowing swaps without overwrites.
        for assignment in assignments where assignment.old != "/" {
            root = try rewrite(root, names: parts(assignment.old), depth: 0, value: nil)
        }
        // Parents are installed before children. An explicit child choice may
        // replace a value inside its explicitly chosen parent alternative.
        for assignment in assignments.filter({ $0.old != "/" && $0.value != nil }).sorted(by: { ($0.destination.split(separator: "/").count, $0.destination) < ($1.destination.split(separator: "/").count, $1.destination) }) {
            if assignment.destination != assignment.old,
               try entry(assignment.destination, in: base.root) != nil,
               !assignments.contains(where: { $0.old == assignment.destination }) {
                throw ConflictReviewProposalError("\(assignment.destination) already exists. Choose another destination; unrelated entries are never overwritten implicitly.")
            }
            if let directory = assignment.value?.directory {
                for path in rangeEdits.keys where path.hasPrefix(assignment.old + "/") {
                    let relative = String(path.dropFirst(assignment.old.count))
                    if let chosen = try entry(relative, in: directory), chosen.file != rangeEdits[path]?.first?.decision.affected[0].material.object {
                        throw ConflictReviewProposalError("The selected directory changes the source around \(path). Review that enclosing source as a whole entry.")
                    }
                }
            }
            root = try rewrite(root, names: parts(assignment.destination), depth: 0, value: assignment.value)
            if assignment.value?.directory != nil {
                for child in assignments where child.old.hasPrefix(assignment.old + "/") {
                    let carriedPath = assignment.destination + child.old.dropFirst(assignment.old.count)
                    root = try rewrite(root, names: parts(carriedPath), depth: 0, value: nil)
                }
            }
        }
        for decision in allDecisions where !draft.decisions.contains(where: { $0.id == decision.id }) {
            guard let path = decision.path else { throw ConflictReviewError.unsupported }
            if try entry(path, in: base.root) != entry(path, in: root) {
                if onlyRanges, let range = decision.sourceRange, let edits = rangeEdits[path],
                   edits.allSatisfy({ $0.range.upperBound <= range.lowerBound || $0.range.lowerBound >= range.upperBound }),
                   !edits.contains(where: { $0.range.isEmpty && $0.range.lowerBound == range.lowerBound }) { continue }
                throw ConflictReviewProposalError("This result would change an unresolved choice at \(path). Include that choice in the review before applying.")
            }
        }
        // Build a recursively inspectable exact effects list, preserving directory metadata.
        var changes: [ConflictReviewChange] = []
        func compare(_ before: WireDirectoryEntry?, _ after: WireDirectoryEntry?, path: String) throws {
            if before?.file == after?.file && before?.directory == after?.directory && before?.tree == after?.tree { return }
            changes.append(.init(path: path, before: before, after: after,
                beforeMetadata: try before?.directory.flatMap { try entries($0).1 },
                afterMetadata: try after?.directory.flatMap { try entries($0).1 }))
            let left = try before?.directory.map { try entries($0).0 } ?? []
            let right = try after?.directory.map { try entries($0).0 } ?? []
            for name in Set(left.map(\.name) + right.map(\.name)).sorted() {
                try compare(left.first { $0.name == name }, right.first { $0.name == name }, path: (path == "/" ? "" : path) + "/" + name)
            }
        }
        try compare(.init(name: "", directory: base.root), .init(name: "", directory: root), path: "/")
        var reachable = Set<String>()
        func visit(_ hash: String, kind: WireEntryKind) throws {
            guard reachable.insert(hash).inserted else { return }
            guard let bytes = objects[hash] else { throw ConflictReviewError.unavailable }
            if kind == .directory, case let .directory(children, _) = try WireObjectCodec.decode(bytes, kind: kind) {
                for child in children { if let hash = child.hash, let kind = child.kind { try visit(hash, kind: kind) } }
            }
        }
        try visit(root, kind: .directory)
        let candidate = WireSnapshot(root: root, objects: reachable.sorted().map { .init(hash: $0, bytes: objects[$0]!) })
        _ = try WireObjectGraph.validate(candidate)
        return .init(fingerprint: try draft.fingerprint(), changes: changes, candidate: candidate, operations: onlyRanges ? rangeOperations : nil)
    }
}
