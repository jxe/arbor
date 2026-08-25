import ArborKit
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
    public static func parseBlocks(_ source: String, identitySeed: String = UUID().uuidString) -> [Block] {
        open(source: source, revision: "pasteboard", identitySeed: identitySeed).blocks
    }

    public static func serializeBlocks(_ blocks: [Block], newline: String = "\n") -> String {
        let ledger = ArborSourceLedger(source: "", revision: "standalone", envelope: "", newline: newline, records: [:])
        return admission(blocks: blocks, ledger: ledger).0.source
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

        var parsed: [(block: Block, raw: String)] = []
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
            if first.hasPrefix("```") || first.hasPrefix("~~~") {
                let fence = String(first.prefix(3))
                cursor += 1
                while cursor < lines.count {
                    let closing = lines[cursor].content.hasPrefix(fence)
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
            parsed.append((parseBlock(Array(lines[start..<contentEnd]), id: id), raw))

            // CommonMark gives one blank line to ordinary block separation.
            // Every additional blank line between authored blocks represents
            // one intentional empty Quagmire paragraph, matching Hunch's
            // human-readable Markdown convention.
            if hasFollowingBlock, separatorEnd < blankEnd {
                for blank in lines[separatorEnd..<blankEnd] {
                    let emptyID = stableID(seed: identitySeed, ordinal: ordinal)
                    ordinal += 1
                    parsed.append((.paragraph(text: AttributedString(), id: emptyID), blank.raw))
                }
            }
        }
        if !leading.isEmpty, parsed.isEmpty { envelope += leading }
        else if !leading.isEmpty, let last = parsed.indices.last { parsed[last].raw += leading }

        let blocks = foldHeadings(parsed.map(\.block))
        let rawByID = Dictionary(uniqueKeysWithValues: parsed.map { ($0.block.id, $0.raw) })
        var records: [BlockID: SourceRecord] = [:]
        walk(blocks) { block, depth in
            records[block.id] = SourceRecord(block: block, raw: rawByID[block.id] ?? "", depth: depth)
        }
        return ArborMarkdownOpenedDocument(
            blocks: blocks,
            ledger: ArborSourceLedger(source: source, revision: revision, envelope: envelope, newline: newline, records: records)
        )
    }

    static func admission(blocks: [Block], ledger: ArborSourceLedger) -> (ArborMarkdownAdmission, ArborSourceLedger) {
        var chunks: [String] = [ledger.envelope]
        var emittedTail = String(ledger.envelope.suffix(max(2, ledger.newline.count * 2)))
        var nextRecords: [BlockID: SourceRecord] = [:]
        var emittedAuthoredBlock = false
        let flattened = flattenedBlocks(blocks)
        var remainingNonemptyBlocks = flattened.reduce(into: 0) { count, block in
            if !isEmptyParagraph(block) { count += 1 }
        }
        func append(_ block: Block, depth: Int, listDepth: Int) {
            let emptyParagraph = isEmptyParagraph(block)
            if !emptyParagraph { remainingNonemptyBlocks -= 1 }
            var raw: String
            if let record = ledger.records[block.id], record.block.kind == block.kind, record.depth == depth {
                raw = record.raw
            } else {
                let needsExplicitEmptyMarker = emptyParagraph
                    && (!emittedAuthoredBlock || remainingNonemptyBlocks == 0)
                raw = canonical(
                    block,
                    newline: ledger.newline,
                    indent: listDepth,
                    explicitEmptyMarker: needsExplicitEmptyMarker
                )
                if listDepth == 0,
                   !emittedTail.isEmpty,
                   !emittedTail.hasSuffix(ledger.newline + ledger.newline),
                   !raw.hasPrefix(ledger.newline) {
                    // A byte-preserved final block may end in a single newline.
                    // Keep no-op source exact, but separate a newly appended
                    // non-list block so Markdown does not fold its text into
                    // the preceding paragraph.
                    raw = ledger.newline + raw
                }
            }
            chunks.append(raw)
            emittedTail = String((emittedTail + raw).suffix(max(2, ledger.newline.count * 2)))
            nextRecords[block.id] = SourceRecord(block: block, raw: raw, depth: depth)
            emittedAuthoredBlock = true
            let addsListDepth: Bool
            switch block.kind {
            case .bullet, .numbered, .todo: addsListDepth = true
            default: addsListDepth = false
            }
            for child in block.children {
                append(child, depth: depth + 1, listDepth: listDepth + (addsListDepth ? 1 : 0))
            }
        }
        for block in blocks { append(block, depth: 0, listDepth: 0) }
        let source = chunks.joined()
        let edit = minimalEdit(from: ledger.source, to: source)
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
            value = Block(id: resultID, kind: block.kind, children: block.children.map(reuse))
            sourceIDByResultID[value.id] = block.id
            return value
        }
        var result = opened
        result.blocks = opened.blocks.map(reuse)
        var records: [BlockID: SourceRecord] = [:]
        walk(result.blocks) { block, depth in
            guard let sourceID = sourceIDByResultID[block.id], let record = opened.ledger.records[sourceID] else { return }
            records[block.id] = SourceRecord(block: block, raw: record.raw, depth: depth)
        }
        result.ledger.records = records
        return result
    }

    private struct SourceLine {
        var content: String
        var raw: String
    }

    private static func sourceLines(_ source: String) -> [SourceLine] {
        guard !source.isEmpty else { return [] }
        var result: [SourceLine] = []
        var start = source.startIndex
        while start < source.endIndex {
            let newline = source[start...].firstIndex(of: "\n")
            let end = newline.map { source.index(after: $0) } ?? source.endIndex
            let raw = String(source[start..<end])
            let content = raw.hasSuffix("\r\n") ? String(raw.dropLast(2))
                : raw.hasSuffix("\n") ? String(raw.dropLast()) : raw
            result.append(SourceLine(content: content, raw: raw))
            start = end
        }
        return result
    }

    private static func structuralLine(_ value: String) -> Bool {
        let leadingTrimmed = String(value.drop(while: { $0 == " " || $0 == "\t" }))
        let trimmed = leadingTrimmed.trimmingCharacters(in: .whitespaces)
        return trimmed.hasPrefix("#") || leadingTrimmed.hasPrefix("- ") || leadingTrimmed.hasPrefix("* ")
            || leadingTrimmed.hasPrefix("> ") || trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~")
            || trimmed.hasPrefix("<") || trimmed.hasPrefix("$$") || trimmed.hasPrefix("[^_")
            || leadingTrimmed.range(of: #"^\d+\.\s"#, options: .regularExpression) != nil
            || trimmed == "---" || trimmed == "***" || trimmed == "___"
    }

    private static func parseBlock(_ lines: [SourceLine], id: BlockID) -> Block {
        let first = lines.first?.content ?? ""
        let leadingTrimmed = String(first.drop(while: { $0 == " " || $0 == "\t" }))
        let trimmed = leadingTrimmed.trimmingCharacters(in: .whitespaces)
        if leadingTrimmed == "\u{00A0}" {
            return .paragraph(text: AttributedString(), id: id)
        }
        if let match = trimmed.range(of: #"^#{1,6}\s+"#, options: .regularExpression) {
            let level = trimmed[..<match.upperBound].filter { $0 == "#" }.count
            return .heading(level: level, text: parseInline(String(trimmed[match.upperBound...])), id: id)
        }
        if trimmed.hasPrefix("```" ) || trimmed.hasPrefix("~~~") {
            let language = String(trimmed.dropFirst(3)).trimmingCharacters(in: .whitespaces)
            let body = lines.dropFirst().dropLast().map(\.content).joined(separator: "\n")
            return .code(source: body, language: language.isEmpty ? nil : language, id: id)
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
            return .documentLink(label: AttributedString(pair.label), reference: DocumentReference(pair.target), id: id)
        }
        if let image = wholeImage(trimmed) { return .image(source: image.target, alt: image.label, id: id) }
        if trimmed.hasPrefix("<") || trimmed.hasPrefix("$$") || trimmed.hasPrefix("|") || trimmed.hasPrefix("[^") {
            return .unsupported(payload: lines.map(\.raw).joined(), display: "Raw Markdown", id: id)
        }
        let text = lines.map(\.content).filter { !$0.isEmpty }.joined(separator: "\n")
        return .paragraph(text: parseInline(text), id: id)
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
        explicitEmptyMarker: Bool = false
    ) -> String {
        let prefix = String(repeating: "  ", count: indent)
        let line: String
        switch block.kind {
        case let .paragraph(text):
            if text.characters.isEmpty {
                return explicitEmptyMarker ? prefix + "\u{00A0}" + newline + newline : newline
            }
            line = inline(text)
        case let .heading(level, text): line = String(repeating: "#", count: level.rawValue) + " " + inline(text)
        case let .bullet(text): line = prefix + "- " + inline(text)
        case let .numbered(text): line = prefix + "1. " + inline(text)
        case let .todo(text, done): line = prefix + "- [\(done ? "x" : " ")] " + inline(text)
        case let .quote(text): line = "> " + inline(text)
        case let .code(source, language):
            return "```\(language ?? "")\(newline)\(source)\(newline)```\(newline)\(newline)"
        case .divider: line = "---"
        case let .toggle(title): line = prefix + "- " + inline(title)
        case let .templateButton(label): line = prefix + "- " + label
        case let .documentLink(label, reference): line = "[\(inline(label))](\(reference.rawValue))"
        case let .image(source, alt): line = "![\(alt)](\(source))"
        case let .unsupported(payload, _): return payload
        }
        return line + newline + newline
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

    private static func minimalEdit(from old: String, to new: String) -> WorkspaceSourceEdit? {
        guard old != new else { return nil }
        let oldCharacters = Array(old)
        let newCharacters = Array(new)
        var prefix = 0
        while prefix < oldCharacters.count, prefix < newCharacters.count, oldCharacters[prefix] == newCharacters[prefix] { prefix += 1 }
        var suffix = 0
        while suffix < oldCharacters.count - prefix,
              suffix < newCharacters.count - prefix,
              oldCharacters[oldCharacters.count - suffix - 1] == newCharacters[newCharacters.count - suffix - 1] { suffix += 1 }
        let oldPrefix = String(oldCharacters[..<prefix])
        let oldMiddle = String(oldCharacters[prefix..<(oldCharacters.count - suffix)])
        let newMiddle = String(newCharacters[prefix..<(newCharacters.count - suffix)])
        let start = oldPrefix.utf8.count
        return WorkspaceSourceEdit(
            utf8Range: start..<(start + oldMiddle.utf8.count),
            replacement: newMiddle,
            expected: oldMiddle
        )
    }

    private static func stableID(seed: String, ordinal: Int) -> BlockID {
        let digest = Array(SHA256.hash(data: Data("\(seed):\(ordinal)".utf8)).prefix(16))
        let uuid = UUID(uuid: (
            digest[0], digest[1], digest[2], digest[3], digest[4], digest[5], digest[6], digest[7],
            digest[8], digest[9], digest[10], digest[11], digest[12], digest[13], digest[14], digest[15]
        ))
        return BlockID(uuid)
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
        walk(blocks) { block, _ in result.append(block) }
        return result
    }
}
