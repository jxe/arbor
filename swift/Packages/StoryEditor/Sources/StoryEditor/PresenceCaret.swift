import Foundation
import Overstory
import Quagmire

/// Carets between the editor and presence (spec 12): the editor counts UTF-16
/// units of a block's text, presence counts UTF-8 bytes of the page file.
/// A block's text is a subsequence of its raw Markdown (markers, mark
/// delimiters and escapes are the rest), so the two meet by walking the raw
/// source and matching the text's scalars in order. Exact for plain text;
/// within a mark delimiter or an escape it lands at the nearest text scalar,
/// which is as precise as a caret drawn in rendered text can be.
public enum StoryPresenceCaret {
    /// The UTF-8 offset in `raw` of the point after `utf16Offset` units of `text`.
    public static func rawOffset(text: String, utf16Offset: Int, raw: String) -> Int {
        let target = scalarCount(text, utf16Offset: utf16Offset)
        let wanted = Array(text.unicodeScalars)
        guard !wanted.isEmpty else { return trimmedLength(raw) }
        var matched = 0
        var bytes = 0
        for scalar in raw.unicodeScalars {
            if matched == target {
                // Before the first text scalar, skip the block's marker so the
                // caret sits where its text starts.
                if target > 0 || scalar == wanted[0] { return bytes }
            } else if scalar == wanted[matched] {
                matched += 1
            }
            bytes += String(scalar).utf8.count
        }
        return trimmedLength(raw)
    }

    /// The UTF-16 offset in `text` of the point at UTF-8 offset `rawOffset` of `raw`.
    public static func textOffset(text: String, rawOffset: Int, raw: String) -> Int {
        let wanted = Array(text.unicodeScalars)
        var matched = 0
        var bytes = 0
        for scalar in raw.unicodeScalars {
            guard bytes < rawOffset, matched < wanted.count else { break }
            if scalar == wanted[matched] { matched += 1 }
            bytes += String(scalar).utf8.count
        }
        return wanted.prefix(matched).reduce(0) { $0 + $1.utf16.count }
    }

    private static func scalarCount(_ text: String, utf16Offset: Int) -> Int {
        var units = 0
        var count = 0
        for scalar in text.unicodeScalars {
            if units >= utf16Offset { break }
            units += scalar.utf16.count
            count += 1
        }
        return count
    }

    private static func trimmedLength(_ raw: String) -> Int {
        var end = raw.utf8.count
        for byte in raw.utf8.reversed() {
            guard byte == 10 || byte == 13 else { break }
            end -= 1
        }
        return end
    }
}

/// A caret found in a block: the block and its UTF-16 range, as the editor draws it.
public struct StoryBlockCaret: Equatable, Sendable {
    public var block: BlockID
    public var range: Range<Int>
}

extension StoryDocumentBinding {
    /// The editor's caret or selection as presence carries it: UTF-8 bytes in
    /// the source the editor last captured, and that source's hash. Nil in
    /// navigation mode, or while the edited block has no source yet.
    public func presenceSelection() -> ProtocolPresenceSelection? {
        guard let block = editorState.editingBlock, let range = editorState.textSelection,
              let record = ledger.records[block], let current = document.find(block) else { return nil }
        let text = String(current.text.characters)
        let anchor = record.range.lowerBound + StoryPresenceCaret.rawOffset(text: text, utf16Offset: range.lowerBound, raw: record.raw)
        let head = record.range.lowerBound + StoryPresenceCaret.rawOffset(text: text, utf16Offset: range.upperBound, raw: record.raw)
        return ProtocolPresenceSelection(source: sourceObject(of: ledger), anchor: anchor, head: head)
    }

    /// Where a peer's selection falls in this editor: the block holding its
    /// head, and the selection within that block's text. Nil when this editor
    /// holds no ledger for exactly that source, or the block is gone.
    public func caret(for selection: ProtocolPresenceSelection) -> StoryBlockCaret? {
        let head = selection.head
        guard let blocks = blocks(overlapping: head..<head, inSource: selection.source), let id = blocks.last,
              let record = ledger(forSource: selection.source)?.records[id], let current = document.find(id) else { return nil }
        let text = String(current.text.characters)
        func local(_ offset: Int) -> Int {
            let clamped = min(max(offset, record.range.lowerBound), record.range.upperBound) - record.range.lowerBound
            return StoryPresenceCaret.textOffset(text: text, rawOffset: clamped, raw: record.raw)
        }
        let lower = local(min(selection.anchor, selection.head)), upper = local(max(selection.anchor, selection.head))
        return StoryBlockCaret(block: id, range: lower..<upper)
    }
}
