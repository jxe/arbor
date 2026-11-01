import Foundation
import Quagmire

/// An agent task block (Agents 001 phase 6): a quote whose text starts with
/// `[!agent]`, as `> [!agent] merge the duplicates` reads in Markdown. The
/// editor shows it as a quote with a Run accessory; Story Sync finds it in the
/// page by its text and removes it when the run succeeds.
public enum StoryAgentTask {
    public static let marker = "[!agent]"

    /// The task's text after the marker, or nil when `text` is not a task.
    public static func taskText(of text: AttributedString) -> AttributedString? {
        let characters = String(text.characters)
        guard characters.lowercased().hasPrefix(marker) else { return nil }
        var start = text.characters.index(text.startIndex, offsetBy: marker.count)
        if start < text.endIndex, text.characters[start] == " " { start = text.characters.index(after: start) }
        return AttributedString(text[start...])
    }

    /// The task's plain text when `block` is an agent task block.
    public static func task(in block: Block) -> String? {
        guard case let .quote(text) = block.kind, let task = taskText(of: text) else { return nil }
        let plain = String(task.characters).trimmingCharacters(in: .whitespacesAndNewlines)
        return plain.isEmpty ? nil : plain
    }

    /// A new task block holding `text`, as dictation or Turn Into makes one.
    public static func block(_ text: String) -> Block {
        Block(kind: .quote(text: AttributedString("\(marker) \(text)")))
    }

    /// Every task block in `blocks`, depth first, in document order.
    public static func tasks(in blocks: [Block]) -> [(block: BlockID, task: String)] {
        blocks.flatMap { block -> [(block: BlockID, task: String)] in
            (task(in: block).map { [(block.id, $0)] } ?? []) + tasks(in: block.children)
        }
    }
}
