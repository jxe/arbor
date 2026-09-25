import CanopyAppKit
import CryptoKit
import Foundation
import Quagmire

public struct CanopyMarkdownAdmission: Sendable {
    public var source: String
    public var patch: WorkspaceDocumentPatch

    public init(source: String, patch: WorkspaceDocumentPatch) {
        self.source = source
        self.patch = patch
    }
}

struct SourceRecord: Sendable {
    var block: Block
    var raw: String
    var depth: Int
    var indent: Int
    var range: Range<Int>
}

struct CanopySourceLedger: Sendable {
    var source: String
    var revision: String
    var envelope: String
    var newline: String
    var records: [BlockID: SourceRecord]
}

public struct CanopyMarkdownOpenedDocument: Sendable {
    public var blocks: [Block]
    var ledger: CanopySourceLedger
}

public enum CanopyMarkdownCodec {
    private static let childrenMarker = "<!-- arbor:children -->"
    static let projectedChildMetadataKey = "arbor.projected-child"

    private struct ParsedBlock {
        var block: Block
        var raw: String
        var indent: Int
    }

    public static func parseBlocks(_ source: String, identitySeed: String = UUID().uuidString) -> [Block] {
        open(source: source, revision: "pasteboard", identitySeed: identitySeed).blocks
    }

    public static func serializeBlocks(_ blocks: [Block], newline: String = "\n") -> String {
        let ledger = CanopySourceLedger(source: "", revision: "standalone", envelope: "", newline: newline, records: [:])
        return admission(blocks: blocks, ledger: ledger).0.source
    }

    /// Insert unmentioned immediate children into the operational document at
    /// the explicit children marker, or at the implicit marker after authored
    /// source. The generated links are ordinary Quagmire blocks carrying
    /// host-owned metadata until a transfer explicitly places them. Rows resolve
    /// from, and generated rows are written from, the directory's source
    /// directory: the directory itself for `_index.md`, its parent for a sibling
    /// `x.md` body.
    static func placeDirectoryChildren(
        _ children: [WorkspaceNode],
        in blocks: [Block],
        directory: WorkspaceReference,
        sourceDirectory: String
    ) -> [Block] {
        let authored = removingProjectedBlocks(from: blocks)
        var mentionedIdentities = Set<WorkspaceIdentity>()
        var mentionedPaths = Set<String>()
        var markerCount = 0

        func pathKey(tree: TreeID, path: String) -> String {
            "\(tree.rawValue)\u{0}\(path)"
        }
        func inspect(_ values: [Block]) {
            for block in values {
                if case let .documentLink(_, reference) = block.kind,
                   let target = resolveNodeTarget(sourceDirectory: sourceDirectory, href: reference.rawValue) {
                    let tree = target.tree.map(TreeID.init(rawValue:)) ?? directory.tree
                    if let stableKey = target.stableKey {
                        mentionedIdentities.insert(.key(tree: tree, stableKey: stableKey))
                    }
                    mentionedPaths.insert(pathKey(tree: tree, path: target.path))
                }
                if isChildrenMarker(block) { markerCount += 1 }
                inspect(block.children)
            }
        }
        inspect(authored)
        guard markerCount <= 1 else { return authored }

        let missing = children
            .filter {
                !mentionedIdentities.contains($0.reference.identity)
                    && !mentionedPaths.contains(pathKey(tree: $0.reference.tree, path: $0.reference.path))
            }
            .sorted { Array($0.reference.path.utf8).lexicographicallyPrecedes(Array($1.reference.path.utf8)) }
        guard !missing.isEmpty else { return authored }

        let generated = missing.map { child -> Block in
            let rawReference = if child.reference.tree != directory.tree {
                CanopyDocumentReferenceCodec.encode(child.reference).rawValue
            } else {
                buildMarkdownLink(from: sourceDirectory, to: child.markdownLinkTarget)
                    ?? relativeFileReference(from: sourceDirectory, toFile: child.reference.path)
            }
            return Block(
                id: projectedChildID(child.reference),
                kind: .documentLink(
                    label: AttributedString(child.title),
                    reference: DocumentReference(rawReference)
                ),
                metadata: [projectedChildMetadataKey: "true"]
            )
        }

        var result = authored
        if !insert(generated, afterChildrenMarkerIn: &result) {
            appendAtImplicitMarker(generated, to: &result)
        }
        return result
    }

    static func patch(from source: String, to result: String, revision: String) -> WorkspaceDocumentPatch {
        WorkspaceDocumentPatch(baseContentRevision: revision, edits: minimalEdit(from: source, to: result).map { [$0] } ?? [])
    }

    public static func open(
        source: String,
        revision: String,
        identitySeed: String
    ) -> CanopyMarkdownOpenedDocument {
        let newline = source.contains("\r\n") ? "\r\n" : "\n"
        let lines = sourceLines(source)
        var cursor = 0
        var envelope = ""
        if lines.first?.content == "---" {
            cursor = 1
            while cursor < lines.count {
                if lines[cursor].content == "---" { cursor += 1; break }
                cursor += 1
            }
            while cursor < lines.count, lines[cursor].content.isEmpty { cursor += 1 }
            envelope = lines[..<cursor].map(\.raw).joined()
        }

        var parsed: [ParsedBlock] = []
        // The frontmatter envelope is stored separately and emitted once by
        // `admission`. Starting the first block's raw source with it as well
        // duplicates the envelope on the first authored edit.
        var leading = ""
        var ordinal = 0
        while cursor < lines.count {
            if isBlankLine(lines[cursor].content) {
                leading += lines[cursor].raw
                cursor += 1
                continue
            }
            let start = cursor
            let first = lines[cursor].content
            let structuralFirst = first.drop(while: { $0 == " " || $0 == "\t" })
            if structuralFirst.hasPrefix("```") || structuralFirst.hasPrefix("~~~") {
                let fence = String(structuralFirst.prefix(3))
                cursor += 1
                while cursor < lines.count {
                    let candidate = lines[cursor].content.drop(while: { $0 == " " || $0 == "\t" })
                    let closing = candidate.hasPrefix(fence)
                    cursor += 1
                    if closing { break }
                }
            } else if structuralLine(first) {
                cursor += 1
            } else {
                cursor += 1
                while cursor < lines.count, !isBlankLine(lines[cursor].content), !structuralLine(lines[cursor].content) {
                    cursor += 1
                }
            }
            let contentEnd = cursor
            while cursor < lines.count, isBlankLine(lines[cursor].content) { cursor += 1 }
            let blankEnd = cursor
            let hasFollowingBlock = blankEnd < lines.count
            let separatorEnd = hasFollowingBlock && contentEnd < blankEnd
                ? contentEnd + 1
                : blankEnd
            let raw = leading + lines[start..<separatorEnd].map(\.raw).joined()
            leading = ""
            let id = stableID(seed: identitySeed, ordinal: ordinal)
            ordinal += 1
            parsed.append(ParsedBlock(
                block: parseBlock(Array(lines[start..<contentEnd]), id: id),
                raw: raw,
                indent: indentationDepth(lines[start].content)
            ))

            // CommonMark gives one blank line to ordinary block separation.
            // Every additional blank line between authored blocks represents
            // one intentional empty Quagmire paragraph, matching Hunch's
            // human-readable Markdown convention.
            if hasFollowingBlock, separatorEnd < blankEnd {
                for blank in lines[separatorEnd..<blankEnd] {
                    let emptyID = stableID(seed: identitySeed, ordinal: ordinal)
                    ordinal += 1
                    parsed.append(ParsedBlock(
                        block: .paragraph(text: AttributedString(), id: emptyID),
                        raw: blank.raw,
                        indent: indentationDepth(blank.content)
                    ))
                }
            }
        }
        if !leading.isEmpty, parsed.isEmpty { envelope += leading }
        else if !leading.isEmpty, let last = parsed.indices.last { parsed[last].raw += leading }

        let blocks = foldHeadingsInScopes(nestIndentedContainers(parsed))
        let rawByID = Dictionary(uniqueKeysWithValues: parsed.map { ($0.block.id, $0.raw) })
        let indentByID = Dictionary(uniqueKeysWithValues: parsed.map { ($0.block.id, $0.indent) })
        var offsets: [BlockID: Range<Int>] = [:]
        var position = envelope.utf8.count
        for item in parsed {
            offsets[item.block.id] = position..<(position + item.raw.utf8.count)
            position += item.raw.utf8.count
        }
        var records: [BlockID: SourceRecord] = [:]
        walk(blocks) { block, depth in
            records[block.id] = SourceRecord(
                block: block,
                raw: rawByID[block.id] ?? "",
                depth: depth,
                indent: indentByID[block.id] ?? 0,
                range: offsets[block.id] ?? 0..<0
            )
        }
        return CanopyMarkdownOpenedDocument(
            blocks: blocks,
            ledger: CanopySourceLedger(source: source, revision: revision, envelope: envelope, newline: newline, records: records)
        )
    }

    static func admission(blocks: [Block], ledger: CanopySourceLedger, copies: [BlockID: BlockID] = [:], foreignCopies: [BlockID: (record: SourceRecord, document: WorkspaceCopyDocument)] = [:]) -> (CanopyMarkdownAdmission, CanopySourceLedger) {
        if copies.isEmpty, foreignCopies.isEmpty, let arranged = arrangement(blocks: blocks, ledger: ledger) { return arranged }
        var chunks: [String] = [ledger.envelope]
        var emittedTail = String(ledger.envelope.suffix(max(2, ledger.newline.count * 2)))
        var nextRecords: [BlockID: SourceRecord] = [:]
        var copiedSpans: [BlockID: (record: SourceRecord, offset: Int)] = [:]
        var position = ledger.envelope.utf8.count
        var emittedAuthoredBlock = false
        let flattened = flattenedBlocks(blocks)
        var remainingNonemptyBlocks = flattened.reduce(into: 0) { count, block in
            if !isEmptyParagraph(block) { count += 1 }
        }
        func copiedRecord(_ id: BlockID) -> SourceRecord? {
            guard ledger.records[id] == nil else { return nil }
            if let foreign = foreignCopies[id] { return foreign.record }
            var current = id, visited = Set<BlockID>()
            while let source = copies[current], visited.insert(current).inserted {
                if let record = ledger.records[source] { return record }
                current = source
            }
            return nil
        }
        // A byte-preserved final block may end in a single newline. Keep no-op
        // source exact, but separate a newly emitted top-level block so
        // Markdown does not fold its text into the preceding paragraph.
        func separator(before raw: String, containerDepth: Int) -> String {
            guard containerDepth == 0, !emittedTail.isEmpty,
                  !emittedTail.hasSuffix(ledger.newline + ledger.newline),
                  !raw.hasPrefix(ledger.newline) else { return "" }
            return emittedTail.hasSuffix(ledger.newline) ? ledger.newline : ledger.newline + ledger.newline
        }
        // The last recorded block has no blank line after it. Emitted before
        // another block it would run into it, so that block is separated.
        let originallyLast = ledger.records.values.max { $0.range.lowerBound < $1.range.lowerBound }?.block.id
        var previousEmitted: BlockID?
        func append(_ block: Block, depth: Int, containerDepth: Int) {
            guard !isProjectedChild(block) else { return }
            let emptyParagraph = isEmptyParagraph(block)
            if !emptyParagraph { remainingNonemptyBlocks -= 1 }
            var raw: String
            var copied: SourceRecord?
            if let record = ledger.records[block.id] ?? copiedRecord(block.id),
               record.block.kind == block.kind,
               (record.depth == depth || foreignCopies[block.id] != nil),
               record.indent == containerDepth {
                raw = record.raw
                if ledger.records[block.id] == nil { copied = record }
                else if containerDepth == 0, previousEmitted != nil, previousEmitted == originallyLast {
                    raw = separator(before: raw, containerDepth: containerDepth) + raw
                }
            } else {
                let needsExplicitEmptyMarker = emptyParagraph
                    && (!emittedAuthoredBlock || remainingNonemptyBlocks == 0)
                raw = canonical(
                    block,
                    newline: ledger.newline,
                    indent: containerDepth,
                    hasChildren: !block.children.isEmpty,
                    explicitEmptyMarker: needsExplicitEmptyMarker
                )
                raw = separator(before: raw, containerDepth: containerDepth) + raw
            }
            if let copied {
                let prefix = separator(before: raw, containerDepth: containerDepth)
                copiedSpans[block.id] = (copied, prefix.utf8.count)
                raw = prefix + raw
                // A copied unterminated block must remain distinct from the
                // following original. Added separators have new source identity.
                if containerDepth == 0, !raw.hasSuffix(ledger.newline + ledger.newline) {
                    raw += raw.hasSuffix(ledger.newline) ? ledger.newline : ledger.newline + ledger.newline
                }
            }
            chunks.append(raw)
            previousEmitted = block.id
            emittedTail = String((emittedTail + raw).suffix(max(2, ledger.newline.count * 2)))
            nextRecords[block.id] = SourceRecord(
                block: block,
                raw: raw,
                depth: depth,
                indent: containerDepth,
                range: position..<(position + raw.utf8.count)
            )
            position += raw.utf8.count
            emittedAuthoredBlock = true
            let addsContainerDepth = isIndentContainer(block)
            for child in block.children {
                append(
                    child,
                    depth: depth + 1,
                    containerDepth: containerDepth + (addsContainerDepth ? 1 : 0)
                )
            }
        }
        for block in blocks { append(block, depth: 0, containerDepth: 0) }
        let source = chunks.joined()
        var edit = minimalEdit(from: ledger.source, to: source)
        // Include the actual destination occurrences even when equal-byte prefix
        // matching would otherwise place the insertion at a different occurrence.
        if nextRecords.keys.contains(where: { copiedRecord($0) != nil }) {
            edit = WorkspaceSourceEdit(utf8Range:0..<ledger.source.utf8.count,replacement:source,expected:ledger.source)
        }
        if edit == nil, nextRecords.contains(where: { id, next in
            guard let old = ledger.records[id] else { return false }
            return old.range != next.range && old.raw.utf8.elementsEqual(next.raw.utf8)
        }) {
            edit = WorkspaceSourceEdit(utf8Range:0..<ledger.source.utf8.count,replacement:source,expected:ledger.source)
        }
        if var value = edit {
            let replacementRange = value.utf8Range.lowerBound..<(value.utf8Range.lowerBound + value.replacement.utf8.count)
            var lineage = nextRecords.compactMap { id, next -> WorkspaceSourceLineage? in
                guard let old = ledger.records[id], old.raw.utf8.elementsEqual(next.raw.utf8) else { return nil }
                let start = max(0, value.utf8Range.lowerBound - old.range.lowerBound, replacementRange.lowerBound - next.range.lowerBound)
                let end = min(old.raw.utf8.count, value.utf8Range.upperBound - old.range.lowerBound, replacementRange.upperBound - next.range.lowerBound)
                guard start < end else { return nil }
                return WorkspaceSourceLineage(source: (old.range.lowerBound + start)..<(old.range.lowerBound + end),
                    replacement: (next.range.lowerBound + start - replacementRange.lowerBound)..<(next.range.lowerBound + end - replacementRange.lowerBound))
            }.sorted { $0.replacement.lowerBound < $1.replacement.lowerBound }
            if value.utf8Range.lowerBound == 0, !ledger.envelope.isEmpty,
               value.utf8Range.upperBound >= ledger.envelope.utf8.count,
               value.replacement.utf8.starts(with: ledger.envelope.utf8) {
                lineage.insert(.init(source:0..<ledger.envelope.utf8.count,replacement:0..<ledger.envelope.utf8.count),at:0)
            }
            if !lineage.isEmpty { value.lineage = lineage }
            let copied = nextRecords.compactMap { id, next -> WorkspaceSourceLineage? in
                guard let captured = copiedSpans[id], !captured.record.raw.isEmpty else { return nil }
                let old = captured.record, prefix = captured.offset
                let lower = next.range.lowerBound + prefix - replacementRange.lowerBound
                guard lower >= 0, lower + old.raw.utf8.count <= value.replacement.utf8.count else { return nil }
                return WorkspaceSourceLineage(source:old.range,replacement:lower..<(lower+old.raw.utf8.count),document:foreignCopies[id]?.document)
            }.sorted { $0.replacement.lowerBound < $1.replacement.lowerBound }
            if !copied.isEmpty { value.copies = copied }
            edit = value
        }
        let patch = WorkspaceDocumentPatch(
            baseContentRevision: ledger.revision,
            edits: edit.map { [$0] } ?? []
        )
        let next = CanopySourceLedger(
            source: source,
            revision: ledger.revision,
            envelope: ledger.envelope,
            newline: ledger.newline,
            records: nextRecords
        )
        return (CanopyMarkdownAdmission(source: source, patch: patch), next)
    }

    /// A generation that only rearranges existing blocks (reorders them or
    /// changes their depth) states itself as moves of their exact source plus
    /// re-indentation of the lines that changed depth, so a peer's edit to a
    /// moved block follows it. Every block keeps its recorded bytes except for
    /// leading spaces; the result must reparse to exactly the editor's tree.
    /// Anything else (new, removed or edited blocks, tabs, an indentation this
    /// cannot shift, a separator the new order would need) returns nil and the
    /// generation is serialized as an ordinary edit.
    private static func arrangement(blocks: [Block], ledger: CanopySourceLedger) -> (CanopyMarkdownAdmission, CanopySourceLedger)? {
        struct Placed { var record: SourceRecord; var depth: Int; var indent: Int; var raw: String; var edits: [WorkspaceSourceEdit] }
        var placed: [Placed] = []
        var seen = Set<BlockID>()
        func place(_ block: Block, depth: Int, indent: Int) -> Bool {
            guard !isProjectedChild(block) else { return true }
            guard let record = ledger.records[block.id], record.block.kind == block.kind, seen.insert(block.id).inserted,
                  let shifted = reindented(record, by: indent - record.indent) else { return false }
            placed.append(Placed(record: record, depth: depth, indent: indent, raw: shifted.raw, edits: shifted.edits))
            let child = indent + (isIndentContainer(block) ? 1 : 0)
            return block.children.allSatisfy { place($0, depth: depth + 1, indent: child) }
        }
        guard blocks.allSatisfy({ place($0, depth: 0, indent: 0) }), seen.count == ledger.records.count, !placed.isEmpty else { return nil }
        let old = placed.map(\.record.range.lowerBound)
        guard old != old.sorted() || placed.contains(where: { $0.indent != $0.record.indent }) else { return nil }
        // Try the exact bytes first. A top-level block recorded without a
        // blank line after it (the last block, or one written tight against
        // its successor) may need one before a different successor.
        if let result = arranged(placed: placed.map { ($0.record, $0.depth, $0.indent, $0.raw, $0.edits) }, blocks: blocks, ledger: ledger) { return result }
        let successors = Dictionary(uniqueKeysWithValues: zip(ledger.records.values.sorted { $0.range.lowerBound < $1.range.lowerBound }.map(\.block.id),
                                                              ledger.records.values.sorted { $0.range.lowerBound < $1.range.lowerBound }.dropFirst().map(\.block.id).map(Optional.some) + [nil]))
        let blank = ledger.newline + ledger.newline
        for index in placed.indices.dropLast() where placed[index].indent == 0 && !placed[index].raw.hasSuffix(blank)
            && successors[placed[index].record.block.id] != .some(placed[index + 1].record.block.id) {
            let end = placed[index].record.range.upperBound, width = ledger.newline.utf8.count
            guard placed[index].raw.hasSuffix(ledger.newline) else { return nil }
            placed[index].raw += ledger.newline
            placed[index].edits.append(.init(utf8Range: (end - width)..<end, replacement: blank,
                                             lineage: [.init(source: (end - width)..<end, replacement: 0..<width)]))
        }
        return arranged(placed: placed.map { ($0.record, $0.depth, $0.indent, $0.raw, $0.edits) }, blocks: blocks, ledger: ledger)
    }

    private static func arranged(placed: [(record: SourceRecord, depth: Int, indent: Int, raw: String, edits: [WorkspaceSourceEdit])],
                                 blocks: [Block], ledger: CanopySourceLedger) -> (CanopyMarkdownAdmission, CanopySourceLedger)? {
        let old = placed.map(\.record.range.lowerBound)
        // Blocks that keep their relative order stay; the rest move.
        let stays = Set(longestIncreasingSubsequence(old).map { placed[$0].record.block.id })
        let envelope = ledger.envelope.utf8.count
        var moves: [WorkspaceSourceMove] = []
        var index = 0
        while index < placed.count {
            guard !stays.contains(placed[index].record.block.id) else { index += 1; continue }
            var end = index
            while end < placed.count, !stays.contains(placed[end].record.block.id) { end += 1 }
            // A run lands after the block before it (or the envelope) and
            // chains forward; a run at the very start lands before the first
            // staying block and chains backward.
            if index > 0 || envelope > 0 {
                var anchor = index > 0 ? placed[index - 1].record.range : 0..<envelope
                for item in placed[index..<end] {
                    moves.append(.init(source: item.record.range, anchor: anchor, side: .after))
                    anchor = item.record.range
                }
            } else {
                var anchor = placed[end].record.range
                for item in placed[index..<end].reversed() {
                    moves.append(.init(source: item.record.range, anchor: anchor, side: .before))
                    anchor = item.record.range
                }
            }
            index = end
        }
        let source = ledger.envelope + placed.map(\.raw).joined()
        let edits = placed.flatMap(\.edits).sorted { $0.utf8Range.lowerBound < $1.utf8Range.lowerBound }
        let patch = WorkspaceDocumentPatch(baseContentRevision: ledger.revision, edits: edits, moves: moves)
        guard (try? patch.applying(to: ledger.source))?.utf8.elementsEqual(source.utf8) == true else { return nil }
        // The bytes must mean the editor's tree: separators and indentation
        // that read differently in the new order are not a rearrangement.
        let reopened = open(source: source, revision: ledger.revision, identitySeed: "arrangement")
        guard sameShape(reopened.blocks, removingProjectedBlocks(from: blocks)) else { return nil }
        var records: [BlockID: SourceRecord] = [:]
        var position = envelope
        for item in placed {
            records[item.record.block.id] = SourceRecord(block: item.record.block, raw: item.raw, depth: item.depth, indent: item.indent,
                                                         range: position..<(position + item.raw.utf8.count))
            position += item.raw.utf8.count
        }
        let next = CanopySourceLedger(source: source, revision: ledger.revision, envelope: ledger.envelope, newline: ledger.newline, records: records)
        return (CanopyMarkdownAdmission(source: source, patch: patch), next)
    }

    /// A record's raw source shifted `levels` indentation levels (two spaces
    /// each) on every non-blank line, with the edits that do it in the
    /// record's source coordinates. Each edit replaces a line's leading
    /// spaces, or, where there are none, the line's first character with its
    /// bytes kept as lineage, so no edit is an insertion at a block's edge.
    private static func reindented(_ record: SourceRecord, by levels: Int) -> (raw: String, edits: [WorkspaceSourceEdit])? {
        guard levels != 0 else { return (record.raw, []) }
        let bytes = Array(record.raw.utf8)
        var raw: [UInt8] = [], edits: [WorkspaceSourceEdit] = []
        var lineStart = 0
        while lineStart <= bytes.count {
            let lineEnd = bytes[lineStart...].firstIndex(of: UInt8(ascii: "\n")) ?? bytes.count
            let line = bytes[lineStart..<lineEnd]
            let spaces = line.prefix { $0 == UInt8(ascii: " ") }.count
            let rest = line.dropFirst(spaces)
            if rest.first == UInt8(ascii: "\t") { return nil }
            if rest.allSatisfy({ $0 == UInt8(ascii: "\r") }) {
                raw += line
            } else {
                let shifted = spaces + 2 * levels
                guard shifted >= 0 else { return nil }
                let indentation = String(repeating: " ", count: shifted), start = record.range.lowerBound + lineStart
                if spaces > 0 {
                    edits.append(.init(utf8Range: start..<(start + spaces), replacement: indentation))
                } else {
                    // The first scalar is kept as lineage so the edit is not an
                    // insertion at the block's edge.
                    guard let scalar = String(decoding: rest, as: UTF8.self).unicodeScalars.first else { return nil }
                    let first = String(scalar), width = first.utf8.count
                    edits.append(.init(utf8Range: start..<(start + width), replacement: indentation + first,
                                       lineage: [.init(source: start..<(start + width), replacement: shifted..<(shifted + width))]))
                }
                raw += Array(indentation.utf8) + rest
            }
            guard lineEnd < bytes.count else { break }
            raw.append(UInt8(ascii: "\n"))
            lineStart = lineEnd + 1
        }
        guard let text = String(bytes: raw, encoding: .utf8) else { return nil }
        return (text, edits)
    }

    /// Indices of one longest strictly increasing subsequence.
    private static func longestIncreasingSubsequence(_ values: [Int]) -> [Int] {
        var tails: [Int] = [], previous = Array(repeating: -1, count: values.count)
        for (index, value) in values.enumerated() {
            var low = 0, high = tails.count
            while low < high { let middle = (low + high) / 2; if values[tails[middle]] < value { low = middle + 1 } else { high = middle } }
            if low > 0 { previous[index] = tails[low - 1] }
            if low == tails.count { tails.append(index) } else { tails[low] = index }
        }
        var result: [Int] = [], cursor = tails.last ?? -1
        while cursor >= 0 { result.append(cursor); cursor = previous[cursor] }
        return result.reversed()
    }

    /// Move to Document as exact source: `roots` (subtrees of the origin, in
    /// document order, whose recorded source is one contiguous span) leave the
    /// origin and land at the end of `destination`, top level there,
    /// re-indented and separated as the destination needs. Nil when that
    /// cannot be stated exactly (a block without its recorded source, blocks
    /// apart from each other, tab indentation, an empty destination, or bytes
    /// that would not reparse to the intended trees).
    struct PlannedTransfer {
        var moves: [WorkspaceDocumentTransfer.Move]
        var edits: [WorkspaceDocumentTransfer.Edit]
        var originSource: String
        var originLedger: CanopySourceLedger
        var destinationSource: String
    }

    static func transfer(_ roots: [Block], from blocks: [Block], ledger: CanopySourceLedger,
                         into destination: CanopyMarkdownOpenedDocument) -> PlannedTransfer? {
        typealias Placed = (record: SourceRecord, raw: String, edits: [WorkspaceSourceEdit])
        var placed: [Placed] = []
        func place(_ block: Block, indent: Int) -> Bool {
            guard !isProjectedChild(block) else { return true }
            guard let record = ledger.records[block.id], record.block.kind == block.kind,
                  let shifted = reindented(record, by: indent - record.indent) else { return false }
            placed.append((record, shifted.raw, shifted.edits))
            let child = indent + (isIndentContainer(block) ? 1 : 0)
            return block.children.allSatisfy { place($0, indent: child) }
        }
        guard !roots.isEmpty, roots.allSatisfy({ place($0, indent: 0) }) else { return nil }
        let target = destination.ledger
        let newline = target.newline, blank = newline + newline, width = newline.utf8.count
        var edits: [WorkspaceDocumentTransfer.Edit] = []
        // The destination's last block, or its envelope, is the landing place;
        // it needs a blank line before what lands after it.
        let last = target.records.values.max { $0.range.lowerBound < $1.range.lowerBound }
        let anchor: Range<Int>
        if let last {
            anchor = last.range
            if !target.source.hasSuffix(blank) {
                guard target.source.hasSuffix(newline), last.range.upperBound == target.source.utf8.count else { return nil }
                let end = last.range.upperBound
                edits.append(.init(document: .destination, edit: .init(utf8Range: (end - width)..<end, replacement: blank,
                    lineage: [.init(source: (end - width)..<end, replacement: 0..<width)])))
            }
        } else if !target.envelope.isEmpty, target.source.utf8.count == target.envelope.utf8.count {
            anchor = 0..<target.envelope.utf8.count
        } else { return nil }
        // A moved block recorded without a blank line after it needs one
        // before a different successor, as a rearrangement does.
        let successors = Dictionary(uniqueKeysWithValues: zip(ledger.records.values.sorted { $0.range.lowerBound < $1.range.lowerBound }.map(\.block.id),
            ledger.records.values.sorted { $0.range.lowerBound < $1.range.lowerBound }.dropFirst().map(\.block.id).map(Optional.some) + [nil]))
        let rootIDs = Set(roots.map(\.id))
        for index in placed.indices.dropLast() {
            let next = placed[index + 1]
            guard rootIDs.contains(next.record.block.id), !placed[index].raw.hasSuffix(blank),
                  successors[placed[index].record.block.id] != .some(next.record.block.id) else { continue }
            guard placed[index].raw.hasSuffix(newline) else { return nil }
            let end = placed[index].record.range.upperBound
            placed[index].raw += newline
            placed[index].edits.append(.init(utf8Range: (end - width)..<end, replacement: blank,
                                             lineage: [.init(source: (end - width)..<end, replacement: 0..<width)]))
        }
        // The moved blocks' recorded source travels as one span.
        var moves: [WorkspaceDocumentTransfer.Move] = []
        var spans: [Range<Int>] = []
        for item in placed {
            if let previous = spans.last, previous.upperBound == item.record.range.lowerBound {
                spans[spans.count - 1] = previous.lowerBound..<item.record.range.upperBound
            } else { spans.append(item.record.range) }
        }
        // Separate spans would chain one move onto material another carried
        // into the destination; canopyd executes that but does not yet
        // reconcile it with a peer's edit, so such a selection is copied.
        guard spans.count == 1 else { return nil }
        for span in spans {
            moves.append(.init(source: span, anchor: .init(document: .destination, range: anchor), side: .after))
        }
        edits += placed.flatMap(\.edits).map { WorkspaceDocumentTransfer.Edit(document: .origin, edit: $0) }
        edits.sort { ($0.document == .origin ? 0 : 1, $0.edit.utf8Range.lowerBound) < ($1.document == .origin ? 0 : 1, $1.edit.utf8Range.lowerBound) }
        // The origin without the moved spans, and its ledger.
        let removed = Set(placed.map(\.record.block.id))
        var originBytes = Data(), records: [BlockID: SourceRecord] = [:], cursor = 0
        let original = Data(ledger.source.utf8)
        for span in spans {
            originBytes.append(original[cursor..<span.lowerBound]); cursor = span.upperBound
        }
        originBytes.append(original[cursor...])
        for (id, record) in ledger.records where !removed.contains(id) {
            let shift = spans.filter { $0.upperBound <= record.range.lowerBound }.reduce(0) { $0 + $1.count }
            var moved = record; moved.range = (record.range.lowerBound - shift)..<(record.range.upperBound - shift)
            records[id] = moved
        }
        guard let originSource = String(data: originBytes, encoding: .utf8) else { return nil }
        let destinationSource = (edits.contains { $0.document == .destination } ? String(target.source.dropLast(newline.count)) + blank : target.source)
            + placed.map(\.raw).joined()
        // Both results must mean the intended trees.
        let remaining = removingSubtrees(removed, from: removingProjectedBlocks(from: blocks))
        guard sameShape(open(source: originSource, revision: "transfer", identitySeed: "origin").blocks, remaining),
              sameShape(open(source: destinationSource, revision: "transfer", identitySeed: "destination").blocks,
                        removingProjectedBlocks(from: destination.blocks) + roots.map(stripped)) else { return nil }
        return PlannedTransfer(moves: moves, edits: edits, originSource: originSource,
            originLedger: CanopySourceLedger(source: originSource, revision: ledger.revision, envelope: ledger.envelope, newline: ledger.newline, records: records),
            destinationSource: destinationSource)
    }

    private static func removingSubtrees(_ ids: Set<BlockID>, from blocks: [Block]) -> [Block] {
        blocks.compactMap { block in
            guard !ids.contains(block.id) else { return nil }
            var value = block
            value.children = removingSubtrees(ids, from: block.children)
            return value
        }
    }

    private static func stripped(_ block: Block) -> Block {
        var value = block
        value.children = removingProjectedBlocks(from: block.children)
        return value
    }

    /// Whether two trees have the same content and nesting, ignoring
    /// identities and host metadata.
    private static func sameShape(_ a: [Block], _ b: [Block]) -> Bool {
        a.count == b.count && zip(a, b).allSatisfy { $0.kind == $1.kind && sameShape($0.children, $1.children) }
    }

    static func rebased(_ opened: CanopyMarkdownOpenedDocument, preserving current: [Block]) -> CanopyMarkdownOpenedDocument {
        var oldBySignature: [String: [Block]] = [:]
        var preservedIDBySourceID: [BlockID: BlockID] = [:]
        var sourceIDByResultID: [BlockID: BlockID] = [:]
        walk(current) { block, _ in oldBySignature[signature(block), default: []].append(block) }

        // Decide every identity reuse before assigning IDs to newly parsed
        // blocks. Parsed IDs are ordinal-derived, so an insertion can otherwise
        // claim an ID that belongs to a later preserved block.
        walk(opened.blocks) { block, _ in
            guard var candidates = oldBySignature[signature(block)], !candidates.isEmpty else { return }
            let chosen = candidates.removeFirst()
            oldBySignature[signature(block)] = candidates
            preservedIDBySourceID[block.id] = chosen.id
        }
        let reservedIDs = Set(preservedIDBySourceID.values)
        var usedIDs: Set<BlockID> = []
        func reuse(_ block: Block) -> Block {
            var value = block
            let resultID: BlockID
            if let preservedID = preservedIDBySourceID[block.id] {
                resultID = preservedID
            } else if reservedIDs.contains(block.id) || usedIDs.contains(block.id) {
                var fresh = BlockID()
                while reservedIDs.contains(fresh) || usedIDs.contains(fresh) { fresh = BlockID() }
                resultID = fresh
            } else {
                resultID = block.id
            }
            usedIDs.insert(resultID)
            value = Block(
                id: resultID,
                kind: block.kind,
                children: block.children.map(reuse),
                metadata: block.metadata
            )
            sourceIDByResultID[value.id] = block.id
            return value
        }
        var result = opened
        result.blocks = opened.blocks.map(reuse)
        var records: [BlockID: SourceRecord] = [:]
        walk(result.blocks) { block, depth in
            guard let sourceID = sourceIDByResultID[block.id], let record = opened.ledger.records[sourceID] else { return }
            records[block.id] = SourceRecord(
                block: block,
                raw: record.raw,
                depth: depth,
                indent: record.indent,
                range: record.range
            )
        }
        result.ledger.records = records
        return result
    }

    private struct SourceLine {
        var content: String
        var raw: String
    }

    private static func sourceLines(_ source: String) -> [SourceLine] {
        var result: [SourceLine] = []
        forEachSourceLine(source) { result.append($0); return true }
        return result
    }

    /// Visits the source's lines in order until `body` returns false.
    private static func forEachSourceLine(_ source: String, _ body: (SourceLine) -> Bool) {
        var raw = ""
        for character in source {
            raw.append(character)
            guard character.unicodeScalars.contains(where: { $0.value == 0x0A }) else { continue }
            var contentScalars = Array(raw.unicodeScalars)
            if contentScalars.last?.value == 0x0A { contentScalars.removeLast() }
            if contentScalars.last?.value == 0x0D { contentScalars.removeLast() }
            let content = String(String.UnicodeScalarView(contentScalars))
            guard body(SourceLine(content: content, raw: raw)) else { return }
            raw = ""
        }
        if !raw.isEmpty {
            _ = body(SourceLine(content: raw, raw: raw))
        }
    }

    /// The text of the first block when it is an H1, exactly as
    /// `parseBlocks(source).first` reads it, without parsing the rest of the
    /// document. A heading is always a single-line block, so the first
    /// nonblank line after the frontmatter envelope decides it.
    static func leadingH1Text(_ source: String) -> String? {
        var index = 0
        var inFrontmatter = false
        var text: String?
        forEachSourceLine(source) { line in
            defer { index += 1 }
            if index == 0, line.content == "---" { inFrontmatter = true; return true }
            if inFrontmatter { inFrontmatter = line.content != "---"; return true }
            if isBlankLine(line.content) { return true }
            if case let .heading(level, heading) = parseBlock([line], id: BlockID()).kind, level == .h1 {
                text = String(heading.characters)
            }
            return false
        }
        return text
    }

    private static func structuralLine(_ value: String) -> Bool {
        let leadingTrimmed = String(value.drop(while: { $0 == " " || $0 == "\t" }))
        let trimmed = leadingTrimmed.trimmingCharacters(in: .whitespaces)
        return trimmed.hasPrefix("#") || leadingTrimmed.hasPrefix("- ") || leadingTrimmed.hasPrefix("* ")
            || leadingTrimmed.hasPrefix("▸ ")
            || leadingTrimmed.hasPrefix("> ") || trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~")
            || trimmed.hasPrefix("<") || trimmed.hasPrefix("$$") || trimmed.hasPrefix("[^_")
            || leadingTrimmed.range(of: #"^\d+\.\s"#, options: .regularExpression) != nil
            || trimmed == "---" || trimmed == "***" || trimmed == "___"
    }

    private static func parseBlock(_ lines: [SourceLine], id: BlockID) -> Block {
        let indentCharacters = lines.first?.content.prefix { $0 == " " || $0 == "\t" }.count ?? 0
        let contents = lines.map { line in
            String(line.content.dropFirst(min(indentCharacters, line.content.prefix { $0 == " " || $0 == "\t" }.count)))
        }
        let first = contents.first ?? ""
        let leadingTrimmed = String(first.drop(while: { $0 == " " || $0 == "\t" }))
        let trimmed = leadingTrimmed.trimmingCharacters(in: .whitespaces)
        if leadingTrimmed == "\u{00A0}" {
            return .paragraph(text: AttributedString(), id: id)
        }
        // CommonMark permits an ATX heading marker to end the line. This is
        // also the exact source emitted for a newly autoexpanded, still-empty
        // heading (`# ` becomes `#` after the trim above). Treating it as a
        // paragraph makes an accepted save visibly turn the heading back into
        // a literal marker when the authoritative snapshot is observed.
        if let match = trimmed.range(of: #"^#{1,6}(?:\s+|$)"#, options: .regularExpression) {
            let level = trimmed[..<match.upperBound].filter { $0 == "#" }.count
            return .heading(level: level, text: parseInline(String(trimmed[match.upperBound...])), id: id)
        }
        if trimmed.hasPrefix("```" ) || trimmed.hasPrefix("~~~") {
            let language = String(trimmed.dropFirst(3)).trimmingCharacters(in: .whitespaces)
            let body = contents.dropFirst().dropLast().joined(separator: "\n")
            return .code(source: body, language: language.isEmpty ? nil : language, id: id)
        }
        if leadingTrimmed.hasPrefix("▸ ") {
            return .toggle(title: parseInline(String(leadingTrimmed.dropFirst(2))), id: id)
        }
        let taskPrefix = String(leadingTrimmed.prefix(6)).lowercased()
        if ["- [ ] ", "- [x] ", "* [ ] ", "* [x] "].contains(taskPrefix) {
            let done = taskPrefix.contains("[x]")
            return .todo(text: parseInline(String(leadingTrimmed.dropFirst(6))), done: done, id: id)
        }
        if leadingTrimmed.hasPrefix("- ") || leadingTrimmed.hasPrefix("* ") {
            return .bullet(text: parseInline(String(leadingTrimmed.dropFirst(2))), id: id)
        }
        if let match = leadingTrimmed.range(of: #"^\d+\.\s"#, options: .regularExpression) {
            return .numbered(text: parseInline(String(leadingTrimmed[match.upperBound...])), id: id)
        }
        if leadingTrimmed.hasPrefix("> ") { return .quote(text: parseInline(String(leadingTrimmed.dropFirst(2))), id: id) }
        if ["---", "***", "___"].contains(trimmed) { return .divider(id: id) }
        if let pair = wholeLink(trimmed) {
            return .documentLink(label: parseInline(pair.label), reference: DocumentReference(pair.target), id: id)
        }
        if let image = wholeImage(trimmed) { return .image(source: image.target, alt: image.label, id: id) }
        if trimmed.hasPrefix("<") || trimmed.hasPrefix("$$") || trimmed.hasPrefix("|") || trimmed.hasPrefix("[^") {
            return .unsupported(
                payload: lines.map(\.raw).joined(),
                display: trimmed == childrenMarker ? "Children" : "Raw Markdown",
                id: id
            )
        }
        let text = contents.filter { !$0.isEmpty }.joined(separator: "\n")
        return .paragraph(text: parseInline(text), id: id)
    }

    private static func indentationDepth(_ value: String) -> Int {
        var columns = 0
        for character in value {
            if character == " " { columns += 1 }
            else if character == "\t" { columns += 2 }
            else { break }
        }
        return columns / 2
    }

    private static func nestIndentedContainers(_ parsed: [ParsedBlock]) -> [Block] {
        guard !parsed.isEmpty else { return [] }
        var cursor = 0

        func parseSiblings(at indent: Int) -> [Block] {
            var result: [Block] = []
            while cursor < parsed.count {
                let item = parsed[cursor]
                if item.indent < indent { break }
                if item.indent > indent {
                    // Indentation only has structural meaning below a list or
                    // toggle container. Preserve malformed/legacy indentation
                    // in document order instead of dropping its blocks.
                    result.append(contentsOf: parseSiblings(at: item.indent))
                    continue
                }

                cursor += 1
                var block = item.block
                if cursor < parsed.count,
                   parsed[cursor].indent > indent,
                   isIndentContainer(block) {
                    block.children = parseSiblings(at: parsed[cursor].indent)
                }
                result.append(block)
            }
            return result
        }

        return parseSiblings(at: parsed[0].indent)
    }

    private static func isIndentContainer(_ block: Block) -> Bool {
        switch block.kind {
        case .bullet, .numbered, .todo, .toggle:
            true
        default:
            false
        }
    }

    private static func foldHeadingsInScopes(_ blocks: [Block]) -> [Block] {
        let nested = blocks.map { block in
            block.children.isEmpty
                ? block
                : Block(id: block.id, kind: block.kind, children: foldHeadingsInScopes(block.children))
        }
        return foldHeadings(nested)
    }

    private static func wholeLink(_ value: String) -> (label: String, target: String)? {
        guard value.hasPrefix("["), let middle = value.range(of: "]("), value.hasSuffix(")") else { return nil }
        return (String(value[value.index(after: value.startIndex)..<middle.lowerBound]), String(value[middle.upperBound..<value.index(before: value.endIndex)]))
    }

    private static func wholeImage(_ value: String) -> (label: String, target: String)? {
        guard value.hasPrefix("!["), let middle = value.range(of: "]("), value.hasSuffix(")") else { return nil }
        return (String(value[value.index(value.startIndex, offsetBy: 2)..<middle.lowerBound]), String(value[middle.upperBound..<value.index(before: value.endIndex)]))
    }

    private static func canonical(
        _ block: Block,
        newline: String,
        indent: Int,
        hasChildren: Bool,
        explicitEmptyMarker: Bool = false
    ) -> String {
        let prefix = String(repeating: "  ", count: indent)
        let line: String
        switch block.kind {
        case let .paragraph(text):
            if text.characters.isEmpty {
                return explicitEmptyMarker ? prefix + "\u{00A0}" + newline + newline : prefix + newline
            }
            line = prefix + inline(text)
        case let .heading(level, text): line = prefix + String(repeating: "#", count: level.rawValue) + " " + inline(text)
        case let .bullet(text): line = prefix + "- " + inline(text)
        case let .numbered(text): line = prefix + "1. " + inline(text)
        case let .todo(text, done): line = prefix + "- [\(done ? "x" : " ")] " + inline(text)
        case let .quote(text): line = prefix + "> " + inline(text)
        case let .code(source, language):
            let body = source
                .components(separatedBy: "\n")
                .map { prefix + $0 }
                .joined(separator: newline)
            return "\(prefix)```\(language ?? "")\(newline)\(body)\(newline)\(prefix)```\(newline)\(newline)"
        case .divider: line = prefix + "---"
        case let .toggle(title): line = prefix + "▸ " + inline(title)
        case let .templateButton(label): line = prefix + "- " + label
        case let .documentLink(label, reference): line = prefix + "[\(inline(label))](\(reference.rawValue))"
        case let .image(source, alt): line = prefix + "![\(alt)](\(source))"
        case let .unsupported(payload, _): return payload
        }
        let compactContainer = hasChildren && isIndentContainer(block)
        return line + newline + (compactContainer ? "" : newline)
    }

    private static func inline(_ value: AttributedString) -> String {
        var result = ""
        for run in value.runs {
            let characters = String(value[run.range].characters)
            var segment: String
            if run[InlineAttributes.CodeAttribute.self] == true {
                segment = "`\(characters.replacingOccurrences(of: "`", with: "\\`"))`"
            } else {
                segment = escapeInline(characters)
            }
            if let link = run.link { segment = "[\(segment)](\(link.absoluteString))" }
            if run[InlineAttributes.StrikethroughAttribute.self] == true { segment = "~~\(segment)~~" }
            if run[InlineAttributes.ItalicAttribute.self] == true { segment = "*\(segment)*" }
            if run[InlineAttributes.BoldAttribute.self] == true { segment = "**\(segment)**" }
            result += segment
        }
        return result
    }

    private static func parseInline(_ source: String) -> AttributedString {
        var result = AttributedString()
        var cursor = source.startIndex

        func closing(_ delimiter: String, after start: String.Index) -> Range<String.Index>? {
            source.range(of: delimiter, range: start..<source.endIndex)
        }

        while cursor < source.endIndex {
            let next = source.index(after: cursor)
            if source[cursor] == "\\", next < source.endIndex {
                result.append(AttributedString(String(source[next])))
                cursor = source.index(after: next)
                continue
            }

            let tail = source[cursor...]
            var delimiter: String?
            var attribute: (inout AttributedString) -> Void = { _ in }
            if tail.hasPrefix("**") || tail.hasPrefix("__") {
                delimiter = tail.hasPrefix("**") ? "**" : "__"
                attribute = { $0[InlineAttributes.BoldAttribute.self] = true }
            } else if tail.hasPrefix("~~") {
                delimiter = "~~"
                attribute = { $0[InlineAttributes.StrikethroughAttribute.self] = true }
            } else if tail.hasPrefix("*") || tail.hasPrefix("_") {
                delimiter = tail.hasPrefix("*") ? "*" : "_"
                attribute = { $0[InlineAttributes.ItalicAttribute.self] = true }
            }
            if let delimiter {
                let contentStart = source.index(cursor, offsetBy: delimiter.count)
                if let close = closing(delimiter, after: contentStart), close.lowerBound > contentStart {
                    var piece = parseInline(String(source[contentStart..<close.lowerBound]))
                    attribute(&piece)
                    result.append(piece)
                    cursor = close.upperBound
                    continue
                }
            }

            if source[cursor] == "`", let close = closing("`", after: next), close.lowerBound > next {
                var piece = AttributedString(String(source[next..<close.lowerBound]).replacingOccurrences(of: "\\`", with: "`"))
                piece[InlineAttributes.CodeAttribute.self] = true
                result.append(piece)
                cursor = close.upperBound
                continue
            }

            if source[cursor] == "[",
               let middle = source.range(of: "](", range: next..<source.endIndex),
               let close = source[middle.upperBound...].firstIndex(of: ")"),
               let url = URL(string: String(source[middle.upperBound..<close])) {
                var piece = parseInline(String(source[next..<middle.lowerBound]))
                piece.link = url
                result.append(piece)
                cursor = source.index(after: close)
                continue
            }

            result.append(AttributedString(String(source[cursor])))
            cursor = next
        }
        return result
    }

    private static func escapeInline(_ value: String) -> String {
        var result = value.replacingOccurrences(of: "\\", with: "\\\\")
        for character in ["*", "_", "~", "`", "[", "]"] {
            result = result.replacingOccurrences(of: character, with: "\\\(character)")
        }
        return result
    }

    /// The single replacement that turns `old` into exactly `new`. The common
    /// prefix and suffix are found on UTF-8 bytes, then each split point backs
    /// up to an offset that is a Character boundary in both strings, so an edit
    /// never divides a grapheme cluster.
    private static func minimalEdit(from old: String, to new: String) -> WorkspaceSourceEdit? {
        let oldBytes = old.utf8, newBytes = new.utf8
        guard !oldBytes.elementsEqual(newBytes) else { return nil }
        let oldCount = oldBytes.count, newCount = newBytes.count
        var prefix = 0
        for (lhs, rhs) in zip(oldBytes, newBytes) {
            guard lhs == rhs else { break }
            prefix += 1
        }
        while !isCharacterBoundary(prefix, in: old) || !isCharacterBoundary(prefix, in: new) { prefix -= 1 }
        let suffixLimit = min(oldCount, newCount) - prefix
        var suffix = 0
        for (lhs, rhs) in zip(oldBytes.reversed(), newBytes.reversed()) {
            guard suffix < suffixLimit, lhs == rhs else { break }
            suffix += 1
        }
        while !isCharacterBoundary(oldCount - suffix, in: old) || !isCharacterBoundary(newCount - suffix, in: new) { suffix -= 1 }
        let oldStart = oldBytes.index(oldBytes.startIndex, offsetBy: prefix)
        let oldEnd = oldBytes.index(oldBytes.startIndex, offsetBy: oldCount - suffix)
        let newStart = newBytes.index(newBytes.startIndex, offsetBy: prefix)
        let newEnd = newBytes.index(newBytes.startIndex, offsetBy: newCount - suffix)
        return WorkspaceSourceEdit(
            utf8Range: prefix..<(oldCount - suffix),
            replacement: String(new[newStart..<newEnd]),
            expected: String(old[oldStart..<oldEnd])
        )
    }

    private static func isCharacterBoundary(_ utf8Offset: Int, in value: String) -> Bool {
        value.utf8.index(value.utf8.startIndex, offsetBy: utf8Offset).samePosition(in: value) != nil
    }

    private static func stableID(seed: String, ordinal: Int) -> BlockID {
        digestID("\(seed):\(ordinal)")
    }

    private static func projectedChildID(_ reference: WorkspaceReference) -> BlockID {
        digestID("arbor-child:\(String(describing: reference.identity))")
    }

    /// A deterministic BlockID from the first 16 bytes of the value's SHA-256.
    private static func digestID(_ value: String) -> BlockID {
        let digest = Array(SHA256.hash(data: Data(value.utf8)).prefix(16))
        return BlockID(UUID(uuid: (
            digest[0], digest[1], digest[2], digest[3], digest[4], digest[5], digest[6], digest[7],
            digest[8], digest[9], digest[10], digest[11], digest[12], digest[13], digest[14], digest[15]
        )))
    }

    private static func isChildrenMarker(_ block: Block) -> Bool {
        guard case let .unsupported(payload, _) = block.kind else { return false }
        return payload.trimmingCharacters(in: .whitespacesAndNewlines) == childrenMarker
    }

    private static func removingProjectedBlocks(from blocks: [Block]) -> [Block] {
        blocks.compactMap { block in
            guard !isProjectedChild(block) else { return nil }
            var value = block
            value.children = removingProjectedBlocks(from: block.children)
            return value
        }
    }

    static func isProjectedChild(_ block: Block) -> Bool {
        block.metadata[projectedChildMetadataKey] == "true"
    }

    static func materializingProjectedChildren(_ blocks: [Block]) -> [Block] {
        func materialize(_ block: Block) -> Block {
            var value = block
            value.metadata.removeValue(forKey: projectedChildMetadataKey)
            value.children = block.children.map(materialize)
            return value
        }
        return blocks.map(materialize)
    }

    private static func insert(_ generated: [Block], afterChildrenMarkerIn blocks: inout [Block]) -> Bool {
        for index in blocks.indices {
            if isChildrenMarker(blocks[index]) {
                blocks.insert(contentsOf: generated, at: index + 1)
                return true
            }
            if insert(generated, afterChildrenMarkerIn: &blocks[index].children) { return true }
        }
        return false
    }

    private static func appendAtImplicitMarker(_ generated: [Block], to blocks: inout [Block]) {
        guard let index = blocks.indices.last,
              case .heading = blocks[index].kind else {
            blocks.append(contentsOf: generated)
            return
        }
        appendAtImplicitMarker(generated, to: &blocks[index].children)
    }

    private static func foldHeadings(_ blocks: [Block]) -> [Block] {
        var roots: [Block] = []
        var stack: [(block: Block, level: HeadingLevel)] = []
        func append(_ block: Block) {
            if stack.isEmpty { roots.append(block) }
            else { stack[stack.count - 1].block.children.append(block) }
        }
        func pop() {
            let value = stack.removeLast().block
            append(value)
        }
        for block in blocks {
            if case let .heading(level, _) = block.kind {
                while let current = stack.last, current.level >= level { pop() }
                stack.append((block, level))
            } else { append(block) }
        }
        while !stack.isEmpty { pop() }
        return roots
    }

    private static func signature(_ block: Block) -> String {
        switch block.kind {
        case let .paragraph(text): "p:\(text.characters)"
        case let .heading(level, text): "h\(level.rawValue):\(text.characters)"
        case let .bullet(text): "b:\(text.characters)"
        case let .numbered(text): "n:\(text.characters)"
        case let .todo(text, done): "t\(done):\(text.characters)"
        case let .quote(text): "q:\(text.characters)"
        case let .code(source, language): "c:\(language ?? ""):\(source)"
        case .divider: "divider"
        case let .toggle(title): "toggle:\(title.characters)"
        case let .templateButton(label): "template:\(label)"
        case let .documentLink(label, reference): "link:\(label.characters):\(reference.rawValue)"
        case let .image(source, alt): "image:\(source):\(alt)"
        case let .unsupported(payload, _): "raw:\(payload)"
        }
    }

    private static func walk(_ blocks: [Block], depth: Int = 0, visit: (Block, Int) -> Void) {
        for block in blocks {
            visit(block, depth)
            walk(block.children, depth: depth + 1, visit: visit)
        }
    }

    private static func isBlankLine(_ value: String) -> Bool {
        value.allSatisfy { $0 == " " || $0 == "\t" || $0 == "\r" }
    }

    private static func isEmptyParagraph(_ block: Block) -> Bool {
        guard case let .paragraph(text) = block.kind else { return false }
        return text.characters.isEmpty
    }

    private static func flattenedBlocks(_ blocks: [Block]) -> [Block] {
        var result: [Block] = []
        walk(blocks) { block, _ in
            if !isProjectedChild(block) { result.append(block) }
        }
        return result
    }
}
