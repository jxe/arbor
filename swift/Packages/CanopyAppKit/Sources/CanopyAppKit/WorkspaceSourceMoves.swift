import Foundation

/// Relocation of non-empty source bytes beside `anchor`: bytes that stay where
/// they are, or the whole source of an earlier move in the same generation.
/// Offsets are UTF-8 bytes of the source the generation's edits address; an
/// edit inside a moved span edits that material where it lands. The same rule
/// runs as `arrangeSources` in `@overstory/protocol`, which canopyd's fast path
/// executes; `docs/overstory-spec/conformance/source-moves.json` holds the
/// shared vectors.
public struct WorkspaceSourceMove: Hashable, Codable, Sendable {
    public enum Side: String, Hashable, Codable, Sendable { case before, after }
    public var source: Range<Int>
    public var anchor: Range<Int>
    public var side: Side

    public init(source: Range<Int>, anchor: Range<Int>, side: Side) {
        self.source = source; self.anchor = anchor; self.side = side
    }
}

/// Exact execution of moves and replacements stated over one set of basis
/// files. Keys name files (a path, or any label for a single source).
public enum WorkspaceSourceArrangement {
    public struct Span: Hashable, Sendable {
        public var file: String
        public var range: Range<Int>
        public init(file: String, range: Range<Int>) { self.file = file; self.range = range }
    }
    public struct Move: Hashable, Sendable {
        public var source: Span
        public var anchor: Span
        public var side: WorkspaceSourceMove.Side
        public init(source: Span, anchor: Span, side: WorkspaceSourceMove.Side) { self.source = source; self.anchor = anchor; self.side = side }
    }
    public struct Replacement: Hashable, Sendable {
        public var span: Span
        public var text: Data
        public init(span: Span, text: Data) { self.span = span; self.text = text }
    }
    public enum Failure: Error, Equatable, Sendable {
        /// The arrangement is malformed.
        case invalid(String)
        /// Well formed, but basis coordinates alone do not decide its order.
        case unsupported(String)
    }

    private enum Slot: Hashable { case stationary(String, Int), before(Int), after(Int) }

    /// Apply `moves` in order, then `edits` (ascending and disjoint per file),
    /// returning every file the arrangement touches.
    public static func apply(files: [String: Data], moves: [Move], edits: [Replacement]) throws -> [String: Data] {
        func check(_ span: Span, _ what: String) throws {
            guard let bytes = files[span.file] else { throw Failure.invalid("\(what) is not a source") }
            guard span.range.lowerBound >= 0, span.range.upperBound <= bytes.count else { throw Failure.invalid("\(what) range outside source") }
            for offset in [span.range.lowerBound, span.range.upperBound] where offset < bytes.count && bytes[bytes.startIndex + offset] & 0xc0 == 0x80 {
                throw Failure.invalid("\(what) range splits a UTF-8 scalar")
            }
        }
        func overlaps(_ a: Span, _ b: Span) -> Bool { a.file == b.file && a.range.lowerBound < b.range.upperBound && b.range.lowerBound < a.range.upperBound }
        var slots: [Slot: Int] = [:]
        for (index, move) in moves.enumerated() {
            try check(move.source, "move source"); try check(move.anchor, "move anchor")
            guard !move.source.range.isEmpty else { throw Failure.invalid("move source is empty") }
            guard !move.anchor.range.isEmpty else { throw Failure.invalid("move anchor is empty") }
            if moves[..<index].contains(where: { overlaps($0.source, move.source) }) { throw Failure.invalid("moves overlap") }
            let slot: Slot
            if let chained = moves[..<index].firstIndex(where: { $0.source == move.anchor }) {
                slot = move.side == .before ? .before(chained) : .after(chained)
            } else {
                if overlaps(move.anchor, move.source) { throw Failure.invalid("move destination is inside its source") }
                if moves.contains(where: { overlaps($0.source, move.anchor) }) { throw Failure.unsupported("anchor is moved material other than an earlier move's whole source") }
                slot = .stationary(move.anchor.file, move.side == .before ? move.anchor.range.lowerBound : move.anchor.range.upperBound)
            }
            guard slots[slot] == nil else { throw Failure.unsupported("two moves land at one place") }
            slots[slot] = index
        }
        var inside: [Int: [Replacement]] = [:], stationary: [String: [Replacement]] = [:], priorEnd: [String: Int] = [:]
        for edit in edits {
            try check(edit.span, "edit")
            guard edit.span.range.lowerBound >= priorEnd[edit.span.file, default: 0] else { throw Failure.invalid("edits overlap or are out of order") }
            priorEnd[edit.span.file] = edit.span.range.upperBound
            let empty = edit.span.range.isEmpty, at = edit.span.range.lowerBound
            if let owner = moves.firstIndex(where: { $0.source.file == edit.span.file && $0.source.range.lowerBound <= edit.span.range.lowerBound && edit.span.range.upperBound <= $0.source.range.upperBound }) {
                if empty, at == moves[owner].source.range.lowerBound || at == moves[owner].source.range.upperBound { throw Failure.unsupported("insertion at a moved span's edge") }
                inside[owner, default: []].append(edit)
                continue
            }
            for move in moves {
                if overlaps(edit.span, move.source) { throw Failure.unsupported("edit crosses a moved span") }
                if empty, edit.span.file == move.source.file, at == move.source.range.lowerBound || at == move.source.range.upperBound { throw Failure.unsupported("insertion at a moved span's edge") }
            }
            for case let .stationary(file, position) in slots.keys where file == edit.span.file {
                if empty ? at == position : edit.span.range.lowerBound < position && position < edit.span.range.upperBound { throw Failure.unsupported("edit at a move's landing place") }
            }
            stationary[edit.span.file, default: []].append(edit)
        }
        var rendered = Set<Int>()
        func slot(_ key: Slot, into out: inout Data) throws { if let index = slots[key] { try payload(index, into: &out) } }
        func payload(_ index: Int, into out: inout Data) throws {
            guard rendered.insert(index).inserted else { throw Failure.invalid("move rendered twice") }
            try slot(.before(index), into: &out)
            let move = moves[index], bytes = files[move.source.file]!
            var cursor = move.source.range.lowerBound
            for edit in inside[index] ?? [] {
                out.append(bytes[(bytes.startIndex + cursor)..<(bytes.startIndex + edit.span.range.lowerBound)]); out.append(edit.text)
                cursor = edit.span.range.upperBound
            }
            out.append(bytes[(bytes.startIndex + cursor)..<(bytes.startIndex + move.source.range.upperBound)])
            try slot(.after(index), into: &out)
        }
        let touched = Set(moves.flatMap { [$0.source.file, $0.anchor.file] } + edits.map(\.span.file))
        var result: [String: Data] = [:]
        for file in touched.sorted() {
            let bytes = files[file]!
            let cuts = moves.map(\.source).filter { $0.file == file }.map(\.range).sorted { $0.lowerBound < $1.lowerBound }
            let replaced = stationary[file] ?? []
            let landings = slots.keys.compactMap { key -> Int? in if case let .stationary(f, p) = key, f == file { p } else { nil } }.sorted()
            var out = Data(), cursor = 0, cut = 0, edit = 0, landing = 0
            while true {
                let next = min(cut < cuts.count ? cuts[cut].lowerBound : .max, edit < replaced.count ? replaced[edit].span.range.lowerBound : .max,
                               landing < landings.count ? landings[landing] : .max, bytes.count)
                out.append(bytes[(bytes.startIndex + cursor)..<(bytes.startIndex + next)])
                cursor = next
                if landing < landings.count, landings[landing] == cursor { try slot(.stationary(file, cursor), into: &out); landing += 1; continue }
                if cut < cuts.count, cuts[cut].lowerBound == cursor { cursor = cuts[cut].upperBound; cut += 1; continue }
                if edit < replaced.count, replaced[edit].span.range.lowerBound == cursor { out.append(replaced[edit].text); cursor = replaced[edit].span.range.upperBound; edit += 1; continue }
                break
            }
            guard landing == landings.count else { throw Failure.invalid("move landing place is outside its source") }
            result[file] = out
        }
        guard rendered.count == moves.count else { throw Failure.invalid("a move does not land in any source") }
        return result
    }
}

/// One change that moves exact source from one document into another in the
/// same tree: Move to Document. Every range is stated in the basis of the
/// document it names; a move's source is always in the origin, and its
/// anchor is destination material or the whole source of an earlier move.
/// Edits inside moved material edit it where it lands.
public struct WorkspaceDocumentTransfer: Hashable, Codable, Sendable {
    public enum Document: String, Hashable, Codable, Sendable { case origin, destination }
    public struct Span: Hashable, Codable, Sendable {
        public var document: Document
        public var range: Range<Int>
        public init(document: Document, range: Range<Int>) { self.document = document; self.range = range }
    }
    public struct Move: Hashable, Codable, Sendable {
        public var source: Range<Int>
        public var anchor: Span
        public var side: WorkspaceSourceMove.Side
        public init(source: Range<Int>, anchor: Span, side: WorkspaceSourceMove.Side) { self.source = source; self.anchor = anchor; self.side = side }
    }
    public struct Edit: Hashable, Codable, Sendable {
        public var document: Document
        public var edit: WorkspaceSourceEdit
        public init(document: Document, edit: WorkspaceSourceEdit) { self.document = document; self.edit = edit }
    }

    public let origin: WorkspaceDocumentSnapshot
    public let destination: WorkspaceDocumentSnapshot
    public let moves: [Move]
    public let edits: [Edit]
    public let originSource: String
    public let destinationSource: String

    public init(origin: WorkspaceDocumentSnapshot, destination: WorkspaceDocumentSnapshot, moves: [Move], edits: [Edit],
                originSource: String, destinationSource: String) throws {
        self.origin = origin; self.destination = destination; self.moves = moves; self.edits = edits
        self.originSource = originSource; self.destinationSource = destinationSource
        try validate()
    }

    public init(from decoder: any Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        try self.init(origin: values.decode(WorkspaceDocumentSnapshot.self, forKey: .origin),
                      destination: values.decode(WorkspaceDocumentSnapshot.self, forKey: .destination),
                      moves: values.decode([Move].self, forKey: .moves), edits: values.decode([Edit].self, forKey: .edits),
                      originSource: values.decode(String.self, forKey: .originSource),
                      destinationSource: values.decode(String.self, forKey: .destinationSource))
    }

    /// Both documents are in one tree, distinct, and the moves and edits
    /// produce exactly the declared sources.
    public func validate() throws {
        guard origin.reference.tree == destination.reference.tree, origin.reference.identity != destination.reference.identity else {
            throw WorkspaceProviderError.invalidAction("A transfer moves between two documents of one tree")
        }
        guard !moves.isEmpty, edits.allSatisfy({ ($0.edit.copies ?? []).isEmpty && ($0.edit.lineage ?? []).allSatisfy { $0.document == nil } }) else {
            throw WorkspaceProviderError.invalidAction("A transfer states moves and ordinary edits only")
        }
        let file = { (document: Document) in document.rawValue }
        let arranged: [String: Data]
        do {
            arranged = try WorkspaceSourceArrangement.apply(
                files: [file(.origin): Data(origin.source.utf8), file(.destination): Data(destination.source.utf8)],
                moves: moves.map { .init(source: .init(file: file(.origin), range: $0.source), anchor: .init(file: file($0.anchor.document), range: $0.anchor.range), side: $0.side) },
                edits: edits.map { .init(span: .init(file: file($0.document), range: $0.edit.utf8Range), text: Data($0.edit.replacement.utf8)) })
        } catch let failure as WorkspaceSourceArrangement.Failure {
            throw WorkspacePatchError.invalidMoves(failure)
        }
        guard arranged[file(.origin)] == Data(originSource.utf8), arranged[file(.destination)] == Data(destinationSource.utf8) else {
            throw WorkspaceProviderError.invalidAction("Transfer does not produce its declared sources")
        }
        // Each document's edits keep their own checks (order, guards, lineage).
        for document in [Document.origin, .destination] {
            let basis = document == .origin ? origin : destination
            _ = try WorkspaceDocumentPatch(baseContentRevision: basis.contentRevision, edits: edits.filter { $0.document == document }.map(\.edit)).applying(to: basis.source)
        }
    }
}

public struct WorkspaceDocumentTransferResult: Sendable {
    public var origin: WorkspaceDocumentSnapshot
    public var destination: WorkspaceDocumentSnapshot
    public init(origin: WorkspaceDocumentSnapshot, destination: WorkspaceDocumentSnapshot) { self.origin = origin; self.destination = destination }
}

public enum WorkspaceTransferError: Error, Equatable, Sendable {
    /// The two documents' retained local work sits on different chains, so no
    /// one tree holds both as the editor read them.
    case basesDiverged
}
