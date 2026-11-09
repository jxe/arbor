import Foundation
import Quagmire

/// An agent task block (Agents 001 phase 6): `> [!agent] merge the
/// duplicates` in Markdown. It opens as a quote of the task's text tagged
/// with `metadataKey`, which Quagmire draws as a callout with a Run button
/// (see `StoryAgentTask.callout`). A paragraph or quote whose text itself
/// starts `[!agent]` (dictation, or typing the marker) is a task too and is
/// written the same way. Story Sync finds the block by its text and removes
/// it when the run succeeds.
public enum StoryAgentTask {
    public static let marker = "[!agent]"
    /// A finished task stays on the page as `> [!agent-done] …`, checked off.
    public static let doneMarker = "[!agent-done]"
    public static let metadataKey = "story.agent-task"
    public static let doneMetadataKey = "story.agent-task.done"

    /// A quote tagged as a task. A tagged block turned into anything else is
    /// no longer a task, though the tag travels with it until the page reopens.
    public static func isMarked(_ block: Block) -> Bool {
        guard case .quote = block.kind else { return false }
        return block.metadata[metadataKey] != nil
    }

    /// Whether a task block is checked off.
    public static func isDone(_ block: Block) -> Bool {
        isMarked(block) && block.metadata[doneMetadataKey] != nil
    }

    /// The task with its done state flipped, keeping its id, text and children.
    public static func toggled(_ block: Block) -> Block? {
        guard isMarked(block) else { return nil }
        var value = block
        value.metadata[doneMetadataKey] = isDone(block) ? nil : "1"
        return value
    }

    /// A parsed quote whose text starts with a marker, as the editor opens
    /// it: the marker gone from the text and the block tagged.
    static func opened(_ kind: BlockKind) -> (kind: BlockKind, metadata: [String: String]) {
        guard case let .quote(text) = kind else { return (kind, [:]) }
        if let task = doneTaskText(of: text) { return (.quote(text: task), [metadataKey: "1", doneMetadataKey: "1"]) }
        guard let task = taskText(of: text) else { return (kind, [:]) }
        return (.quote(text: task), [metadataKey: "1"])
    }

    /// The task's text after the done marker, or nil when `text` does not start with it.
    static func doneTaskText(of text: AttributedString) -> AttributedString? {
        Self.text(after: doneMarker, in: text)
    }

    /// The task's text after the marker, or nil when `text` does not start with it.
    public static func taskText(of text: AttributedString) -> AttributedString? {
        Self.text(after: marker, in: text)
    }

    private static func text(after prefix: String, in text: AttributedString) -> AttributedString? {
        let characters = String(text.characters)
        guard characters.lowercased().hasPrefix(prefix) else { return nil }
        var start = text.characters.index(text.startIndex, offsetBy: prefix.count)
        if start < text.endIndex, text.characters[start] == " " { start = text.characters.index(after: start) }
        return AttributedString(text[start...])
    }

    /// The task's plain text when `block` is an agent task block.
    public static func task(in block: Block) -> String? {
        let text: AttributedString
        switch block.kind {
        case let .quote(value) where isMarked(block): text = value
        case let .quote(value), let .paragraph(value):
            guard let task = taskText(of: value) else { return nil }
            text = task
        default: return nil
        }
        let plain = String(text.characters).trimmingCharacters(in: .whitespacesAndNewlines)
        return plain.isEmpty ? nil : plain
    }

    /// `block` as an agent task, keeping its id, text and children; nil for
    /// a block without text to give.
    public static func turnInto(_ block: Block) -> Block? {
        let text: AttributedString
        switch block.kind {
        case let .paragraph(value), let .bullet(value), let .numbered(value), let .quote(value), let .heading(_, value):
            text = taskText(of: value) ?? value
        case let .todo(value, _): text = value
        default: return nil
        }
        var value = block
        value.kind = .quote(text: text)
        value.metadata[metadataKey] = "1"
        return value
    }

    /// Dictation that starts with "Agent" ("Agent, merge the duplicates")
    /// becomes a task's text, marker first; anything else is unchanged.
    public static func dictated(_ transcript: String) -> String {
        guard let match = transcript.range(of: #"^\s*agent\b[\s,:.;!-]*"#, options: [.regularExpression, .caseInsensitive]) else {
            return transcript
        }
        let rest = transcript[match.upperBound...].trimmingCharacters(in: .whitespaces)
        guard !rest.isEmpty else { return transcript }
        return "\(marker) \(rest.prefix(1).uppercased())\(rest.dropFirst())"
    }

    /// Every task block in `blocks`, depth first, in document order.
    public static func tasks(in blocks: [Block]) -> [(block: BlockID, task: String)] {
        blocks.flatMap { block -> [(block: BlockID, task: String)] in
            (task(in: block).map { [(block.id, $0)] } ?? []) + tasks(in: block.children)
        }
    }
}
