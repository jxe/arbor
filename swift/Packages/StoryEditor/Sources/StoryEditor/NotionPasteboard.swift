import Foundation

/// Story Markdown for blocks copied out of Notion.
///
/// Notion's plain text and HTML write a toggle as an ordinary bullet. Only
/// its own block records, which Chromium and Electron put on the pasteboard
/// as the web custom type `text/_notion-blocks-v3-production`, say "toggle".
/// The JSON looks like
/// `{"blocks": [{"blockId": id, "blockSubtree": {"block": {id: {"value": record}}}}]}`
/// with each record's `content` listing its children's ids in order.
enum StoryNotionPasteboard {
    static let blocksType = "text/_notion-blocks-v3-production"

    static func markdown(fromBlocksJSON json: String) -> String? {
        guard let data = json.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let roots = object["blocks"] as? [[String: Any]], !roots.isEmpty else { return nil }
        var lines: [String] = []
        for root in roots {
            guard let id = root["blockId"] as? String,
                  let subtree = root["blockSubtree"] as? [String: Any],
                  let records = subtree["block"] as? [String: Any] else { continue }
            var writer = Writer(records: records)
            writer.block(id, indent: 0)
            lines += writer.lines
        }
        return lines.isEmpty ? nil : lines.joined(separator: "\n")
    }

    private struct Writer {
        let records: [String: Any]
        var lines: [String] = []
        /// A malformed subtree must not loop.
        var visited: Set<String> = []

        init(records: [String: Any]) {
            self.records = records
        }

        func record(_ id: String) -> [String: Any]? {
            (records[id] as? [String: Any])?["value"] as? [String: Any]
        }

        mutating func emit(_ line: String, indent: Int) {
            lines.append(String(repeating: "  ", count: indent) + line)
            lines.append("")
        }

        mutating func block(_ id: String, indent: Int) {
            guard !visited.contains(id), let value = record(id) else { return }
            visited.insert(id)
            if let alive = value["alive"] as? Bool, !alive { return }
            let type = value["type"] as? String ?? "text"
            let properties = value["properties"] as? [String: Any] ?? [:]
            let title = Writer.richText(properties["title"])
            let children = value["content"] as? [String] ?? []
            var childIndent = indent

            switch type {
            case "header", "sub_header", "sub_sub_header":
                let level = type == "header" ? 1 : type == "sub_header" ? 2 : 3
                if !title.isEmpty { emit(String(repeating: "#", count: level) + " " + title, indent: indent) }
            case "bulleted_list":
                emit("- " + title, indent: indent)
                childIndent += 1
            case "numbered_list":
                emit("1. " + title, indent: indent)
                childIndent += 1
            case "to_do":
                let checked = Writer.plainText(properties["checked"]) == "Yes"
                emit((checked ? "- [x] " : "- [ ] ") + title, indent: indent)
                childIndent += 1
            case "toggle":
                emit("▸ " + title, indent: indent)
                childIndent += 1
            case "quote", "callout":
                if !title.isEmpty { emit("> " + title, indent: indent) }
            case "code":
                let source = Writer.plainText(properties["title"])
                let language = Writer.plainText(properties["language"]).lowercased()
                let fence = source.contains("```") ? "~~~" : "```"
                let prefix = String(repeating: "  ", count: indent)
                lines.append(prefix + fence + (language == "plain text" ? "" : language))
                lines += source.components(separatedBy: "\n").map { prefix + $0 }
                emit(fence, indent: indent)
            case "divider":
                emit("---", indent: indent)
            case "image":
                let source = Writer.plainText(properties["source"])
                if !source.isEmpty { emit("![\(Writer.plainText(properties["caption"]))](\(source))", indent: indent) }
            case "bookmark", "embed", "video", "file", "pdf", "audio":
                let link = Writer.plainText(properties["link"]).isEmpty
                    ? Writer.plainText(properties["source"]) : Writer.plainText(properties["link"])
                let label = title.isEmpty ? StoryPasteboardHTML.escapeMarkdown(link) : title
                if !link.isEmpty { emit("[\(label)](\(link))", indent: indent) }
            case "table":
                let order = (value["format"] as? [String: Any])?["table_block_column_order"] as? [String] ?? []
                for row in children {
                    visited.insert(row)
                    guard let cells = record(row)?["properties"] as? [String: Any] else { continue }
                    let keys = order.isEmpty ? cells.keys.sorted() : order
                    let text = keys.map { Writer.richText(cells[$0]) }.filter { !$0.isEmpty }
                    if !text.isEmpty { emit(StoryPasteboardHTML.guardStructure(text.joined(separator: " · ")), indent: indent) }
                }
                return
            default:
                // Paragraphs ("text"), subpages and anything newer: their text.
                for line in title.components(separatedBy: "\n") where !line.trimmingCharacters(in: .whitespaces).isEmpty {
                    emit(StoryPasteboardHTML.guardStructure(line.trimmingCharacters(in: .whitespaces)), indent: indent)
                }
            }
            for child in children {
                block(child, indent: childIndent)
            }
        }

        /// Notion rich text is `[[text, [[mark, argument?], ...]?], ...]`.
        static func richText(_ value: Any?) -> String {
            guard let segments = value as? [[Any]] else { return "" }
            var result = ""
            for segment in segments {
                guard var text = segment.first as? String else { continue }
                let marks = (segment.count > 1 ? segment[1] as? [[Any]] : nil) ?? []
                var bold = false, italic = false, strike = false, code = false
                var link: String?
                for mark in marks {
                    switch mark.first as? String {
                    case "b": bold = true
                    case "i": italic = true
                    case "s": strike = true
                    case "c": code = true
                    case "a": link = mark.count > 1 ? mark[1] as? String : nil
                    case "d":
                        // A date mention: its text is a placeholder.
                        if let date = mark.count > 1 ? mark[1] as? [String: Any] : nil,
                           let start = date["start_date"] as? String {
                            text = start
                        }
                    case "p":
                        if let page = mark.count > 1 ? mark[1] as? String : nil {
                            link = "https://www.notion.so/" + page.replacingOccurrences(of: "-", with: "")
                            text = "Notion page"
                        }
                    default: break
                    }
                }
                if text == "‣" { continue }
                var piece = code
                    ? "`\(text.replacingOccurrences(of: "`", with: "\\`"))`"
                    : StoryPasteboardHTML.escapeMarkdown(text)
                if !code, piece.trimmingCharacters(in: .whitespaces).isEmpty {
                    result += piece
                    continue
                }
                if let link, URL(string: link) != nil { piece = "[\(piece)](\(link))" }
                if strike { piece = wrap(piece, "~~") }
                if italic { piece = wrap(piece, "*") }
                if bold { piece = wrap(piece, "**") }
                result += piece
            }
            return result.trimmingCharacters(in: .whitespaces)
        }

        static func plainText(_ value: Any?) -> String {
            guard let segments = value as? [[Any]] else { return "" }
            return segments.compactMap { $0.first as? String }.joined()
        }

        private static func wrap(_ value: String, _ delimiter: String) -> String {
            let leading = value.prefix { $0 == " " }
            let trailing = value.reversed().prefix { $0 == " " }
            let core = value.trimmingCharacters(in: .whitespaces)
            return String(leading) + delimiter + core + delimiter + String(trailing)
        }
    }
}
