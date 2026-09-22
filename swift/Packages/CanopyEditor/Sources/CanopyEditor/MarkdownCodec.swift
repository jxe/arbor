import CanopyAppKit
import CryptoKit
import Foundation
import Quagmire

public struct ArborMarkdownAdmission: Sendable {
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

struct ArborSourceLedger: Sendable {
    var source: String
    var revision: String
    var envelope: String
    var newline: String
    var records: [BlockID: SourceRecord]
}

public struct ArborMarkdownOpenedDocument: Sendable {
    public var blocks: [Block]
    var ledger: ArborSourceLedger
}

public enum ArborMarkdownCodec {
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
        let ledger = ArborSourceLedger(source: "", revision: "standalone", envelope: "", newline: newline, records: [:])
        return admission(blocks: blocks, ledger: ledger).0.source
    }

    /// Insert unmentioned immediate children into the operational document at
    /// the explicit children marker, or at the implicit marker after authored
    /// source. The generated links are ordinary Quagmire blocks carrying
    /// host-owned metadata until a transfer explicitly places them.
    static func placeDirectoryChildren(
        _ children: [WorkspaceNode],
        in blocks: [Block],
        directory: WorkspaceReference
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
                   let target = resolveNodeTarget(base: directory.path, href: reference.rawValue) {
                    let tree = target.tree.map(TreeID.init(rawValue:)) ?? directory.tree
                    let stableKey = target.stableKey ?? target.legacyPageID.map(markdownStableKey)
                    if let stableKey {
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
                ArborDocumentReferenceCodec.encode(child.reference).rawValue
            } else {
                buildCanonicalLink(
                    from: directory.path,
                    toPath: child.reference.path,
                    stableKey: child.reference.stableKey
                ) ?? child.reference.path
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
    ) -> ArborMarkdownOpenedDocument {
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
        return ArborMarkdownOpenedDocument(
            blocks: blocks,
            ledger: ArborSourceLedger(source: source, revision: revision, envelope: envelope, newline: newline, records: records)
        )
    }

    static func admission(blocks: [Block], ledger: ArborSourceLedger, copies: [BlockID: BlockID] = [:], foreignCopies: [BlockID: (record: SourceRecord, document: WorkspaceCopyDocument)] = [:]) -> (ArborMarkdownAdmission, ArborSourceLedger) {
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
        let next = ArborSourceLedger(
            source: source,
            revision: ledger.revision,
            envelope: ledger.envelope,
            newline: ledger.newline,
            records: nextRecords
        )
        return (ArborMarkdownAdmission(source: source, patch: patch), next)
    }

    static func rebased(_ opened: ArborMarkdownOpenedDocument, preserving current: [Block]) -> ArborMarkdownOpenedDocument {
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
