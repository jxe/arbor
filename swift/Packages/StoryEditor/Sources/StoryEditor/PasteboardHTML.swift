import Foundation
import Quagmire

/// The HTML Story puts on the pasteboard beside its Markdown, and the reading
/// of another app's HTML when its plain text has lost structure Story keeps.
///
/// Toggles are why this exists. Story writes a toggle as `▸ Title` with its
/// children indented below, which no other app reads; Notion pastes HTML's
/// `<details><summary>` as a toggle, so copy writes that. (Notion's own copies
/// write toggles as bullets in their HTML; `StoryNotionPasteboard` reads its
/// block records instead.)
enum StoryPasteboardHTML {
    // MARK: - Blocks to HTML

    /// HTML for copied blocks, or nil for a lone childless paragraph: pasting
    /// that inside a Story row takes the native rich-text path, which has
    /// nothing to gain from markup and would bring the paragraph's own break.
    static func html(for blocks: [Block]) -> String? {
        if blocks.count == 1, blocks[0].children.isEmpty, case .paragraph = blocks[0].kind {
            return nil
        }
        var out = "<meta charset=\"utf-8\">"
        appendBlocks(blocks, to: &out)
        return out
    }

    private static func appendBlocks(_ blocks: [Block], to out: inout String) {
        var index = 0
        while index < blocks.count {
            let tag = listTag(blocks[index])
            guard let tag else {
                appendBlock(blocks[index], to: &out)
                index += 1
                continue
            }
            // Consecutive items of one kind of list share one list element.
            out += "<\(tag)>"
            while index < blocks.count, listTag(blocks[index]) == tag {
                let block = blocks[index]
                out += "<li>"
                if case let .todo(text, done) = block.kind {
                    out += done ? "<input type=\"checkbox\" checked disabled> " : "<input type=\"checkbox\" disabled> "
                    out += inlineHTML(text)
                } else {
                    out += inlineHTML(block.text)
                }
                appendBlocks(block.children, to: &out)
                out += "</li>"
                index += 1
            }
            out += "</\(tag)>"
        }
    }

    private static func listTag(_ block: Block) -> String? {
        switch block.kind {
        case .bullet, .todo: "ul"
        case .numbered: "ol"
        default: nil
        }
    }

    private static func appendBlock(_ block: Block, to out: inout String) {
        switch block.kind {
        case let .paragraph(text):
            out += text.characters.isEmpty ? "<p><br></p>" : "<p>\(inlineHTML(text))</p>"
        case let .heading(level, text):
            out += "<h\(level.rawValue)>\(inlineHTML(text))</h\(level.rawValue)>"
        case let .quote(text):
            out += "<blockquote>\(inlineHTML(text))</blockquote>"
        case let .code(source, language):
            let attribute = language.map { " class=\"language-\(escape($0))\"" } ?? ""
            out += "<pre><code\(attribute)>\(escape(source))</code></pre>"
        case .divider:
            out += "<hr>"
        case let .toggle(title):
            out += "<details><summary>\(inlineHTML(title))</summary>"
            appendBlocks(block.children, to: &out)
            out += "</details>"
            return
        case let .templateButton(label):
            out += "<p>\(escape(label))</p>"
        case let .documentLink(label, reference):
            out += "<p><a href=\"\(escape(reference.rawValue))\">\(inlineHTML(label))</a></p>"
        case let .image(source, alt):
            out += "<p><img src=\"\(escape(source))\" alt=\"\(escape(alt))\"></p>"
        case let .unsupported(payload, _):
            out += "<p>\(escape(payload.trimmingCharacters(in: .whitespacesAndNewlines)))</p>"
        case .bullet, .numbered, .todo:
            // Lists are written by `appendBlocks`.
            break
        }
        // A heading owns the blocks after it; in HTML they simply follow.
        appendBlocks(block.children, to: &out)
    }

    private static func inlineHTML(_ value: AttributedString) -> String {
        var result = ""
        for run in value.runs {
            var segment = escape(String(value[run.range].characters))
                .replacingOccurrences(of: "\n", with: "<br>")
            if run[InlineAttributes.CodeAttribute.self] == true { segment = "<code>\(segment)</code>" }
            if run[InlineAttributes.StrikethroughAttribute.self] == true { segment = "<s>\(segment)</s>" }
            if run[InlineAttributes.ItalicAttribute.self] == true { segment = "<em>\(segment)</em>" }
            if run[InlineAttributes.BoldAttribute.self] == true { segment = "<strong>\(segment)</strong>" }
            if let link = run.link { segment = "<a href=\"\(escape(link.absoluteString))\">\(segment)</a>" }
            result += segment
        }
        return result
    }

    private static func escape(_ value: String) -> String {
        value
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
            .replacingOccurrences(of: "\"", with: "&quot;")
    }

    // MARK: - HTML to Markdown

    /// Whether `html` holds a toggle, the one structure plain text can't carry.
    static func hasToggle(_ html: String) -> Bool {
        html.range(of: "<details", options: .caseInsensitive) != nil
    }

    /// Story Markdown for another app's HTML. Covers the block structure
    /// pasteboards carry (headings, lists, to-dos, toggles, quotes, code,
    /// rules, images) and the inline marks Story keeps; anything else reads
    /// as its text.
    static func markdown(fromHTML html: String) -> String {
        let root = HTMLTree.parse(html)
        var writer = MarkdownWriter()
        writer.blocks(root.children, indent: 0)
        return writer.lines.joined(separator: "\n")
    }

    /// Keep a paragraph that begins like Markdown structure a paragraph.
    static func guardStructure(_ line: String) -> String {
        let structural = ["#", "- ", "* ", "+ ", "> ", "▸ ", "---", "```", "~~~", "<", "$$", "|"]
        if structural.contains(where: { line.hasPrefix($0) })
            || line.range(of: #"^\d+\.\s"#, options: .regularExpression) != nil {
            return "\\" + line
        }
        return line
    }

    /// Escape text for Story's inline Markdown, as the codec does.
    static func escapeMarkdown(_ value: String) -> String {
        var result = value.replacingOccurrences(of: "\\", with: "\\\\")
        for character in ["*", "_", "~", "`", "[", "]"] {
            result = result.replacingOccurrences(of: character, with: "\\\(character)")
        }
        return result
    }

    private struct MarkdownWriter {
        var lines: [String] = []

        mutating func emit(_ line: String, indent: Int) {
            lines.append(String(repeating: "  ", count: indent) + line)
            lines.append("")
        }

        /// Walk sibling nodes: inline runs between block elements become
        /// paragraphs.
        mutating func blocks(_ nodes: [HTMLNode], indent: Int) {
            var pending: [HTMLNode] = []
            func flush(_ writer: inout MarkdownWriter) {
                let text = MarkdownWriter.inline(pending)
                pending.removeAll()
                for line in text.components(separatedBy: "\n") {
                    let trimmed = line.trimmingCharacters(in: .whitespaces)
                    if !trimmed.isEmpty { writer.emit(StoryPasteboardHTML.guardStructure(trimmed), indent: indent) }
                }
            }
            for node in nodes {
                if node.isBlock {
                    flush(&self)
                    block(node, indent: indent)
                } else {
                    pending.append(node)
                }
            }
            flush(&self)
        }

        mutating func block(_ node: HTMLNode, indent: Int) {
            switch node.name {
            case "h1", "h2", "h3", "h4", "h5", "h6":
                let level = Int(node.name.dropFirst()) ?? 1
                let text = MarkdownWriter.singleLine(MarkdownWriter.inline(node.children))
                if !text.isEmpty { emit(String(repeating: "#", count: level) + " " + text, indent: indent) }
            case "ul", "ol":
                for item in node.children where item.name == "li" {
                    listItem(item, ordered: node.name == "ol", indent: indent)
                }
            case "li":
                listItem(node, ordered: false, indent: indent)
            case "details":
                toggle(node, indent: indent)
            case "blockquote":
                let text = MarkdownWriter.singleLine(MarkdownWriter.inline(node.children))
                if !text.isEmpty { emit("> " + text, indent: indent) }
            case "pre":
                let source = node.text.hasSuffix("\n") ? String(node.text.dropLast()) : node.text
                let language = node.descendant("code")?.attributes["class"]?
                    .split(separator: " ")
                    .first(where: { $0.hasPrefix("language-") })
                    .map { String($0.dropFirst("language-".count)) } ?? ""
                let fence = source.contains("```") ? "~~~" : "```"
                lines.append(String(repeating: "  ", count: indent) + fence + language)
                for line in source.components(separatedBy: "\n") {
                    lines.append(String(repeating: "  ", count: indent) + line)
                }
                emit(fence, indent: indent)
            case "hr":
                emit("---", indent: indent)
            case "img":
                if let source = node.attributes["src"], !source.isEmpty {
                    emit("![\(node.attributes["alt"] ?? "")](\(source))", indent: indent)
                }
            case "tr":
                let cells = node.children.filter { $0.name == "td" || $0.name == "th" }
                    .map { MarkdownWriter.singleLine(MarkdownWriter.inline($0.children)) }
                    .filter { !$0.isEmpty }
                if !cells.isEmpty { emit(StoryPasteboardHTML.guardStructure(cells.joined(separator: " · ")), indent: indent) }
            case "summary":
                blocks(node.children, indent: indent)
            default:
                // p, div, section, table and the like: their content, at this depth.
                blocks(node.children, indent: indent)
            }
        }

        mutating func toggle(_ node: HTMLNode, indent: Int) {
            let summary = node.children.first { $0.name == "summary" }
            let title = MarkdownWriter.singleLine(MarkdownWriter.inline(summary?.children ?? []))
            emit("▸ " + title, indent: indent)
            blocks(node.children.filter { $0 !== summary }, indent: indent + 1)
        }

        mutating func listItem(_ item: HTMLNode, ordered: Bool, indent: Int) {
            let inlineNodes = item.children.prefix { !$0.isBlock }
            let rest = Array(item.children.dropFirst(inlineNodes.count))
            let text = MarkdownWriter.singleLine(MarkdownWriter.inline(Array(inlineNodes)))
            // A list item that only wraps a toggle (as in Notion's HTML
            // export, `<ul class="toggle"><li><details>`) is the toggle.
            if text.isEmpty, let first = rest.first, first.name == "details" {
                toggle(first, indent: indent)
                blocks(Array(rest.dropFirst()), indent: indent)
                return
            }
            let checkbox = inlineNodes.lazy
                .compactMap { $0.name == "input" ? $0 : $0.descendant("input") }
                .first { $0.attributes["type"] == "checkbox" }
            let marker: String
            if let checkbox {
                marker = checkbox.attributes["checked"] != nil ? "- [x] " : "- [ ] "
            } else {
                marker = ordered ? "1. " : "- "
            }
            emit(marker + text, indent: indent)
            blocks(rest, indent: indent + 1)
        }

        static func singleLine(_ text: String) -> String {
            text.components(separatedBy: "\n")
                .map { $0.trimmingCharacters(in: .whitespaces) }
                .filter { !$0.isEmpty }
                .joined(separator: " ")
        }

        /// Story's inline Markdown for a run of nodes. `<br>` comes back as a
        /// newline for the caller to keep or fold.
        static func inline(_ nodes: [HTMLNode]) -> String {
            var result = ""
            for node in nodes { result += inline(node) }
            return result
        }

        private static func inline(_ node: HTMLNode) -> String {
            if node.name == "#text" { return StoryPasteboardHTML.escapeMarkdown(collapse(node.text)) }
            if node.name == "br" { return "\n" }
            if node.name == "input" { return "" }
            if node.name == "code" {
                let code = node.text
                return code.isEmpty ? "" : "`\(code.replacingOccurrences(of: "`", with: "\\`"))`"
            }
            let inner = inline(node.children)
            guard !inner.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return inner }
            var marked = inner
            let style = (node.attributes["style"] ?? "").lowercased().replacingOccurrences(of: " ", with: "")
            let bold = ["b", "strong"].contains(node.name)
                || style.contains("font-weight:bold") || style.contains("font-weight:600")
                || style.contains("font-weight:700") || style.contains("font-weight:800")
            let italic = ["i", "em"].contains(node.name) || style.contains("font-style:italic")
            let strike = ["s", "del", "strike"].contains(node.name) || style.contains("line-through")
            if strike { marked = wrap(marked, "~~") }
            if italic { marked = wrap(marked, "*") }
            if bold { marked = wrap(marked, "**") }
            if node.name == "a", let href = node.attributes["href"], URL(string: href) != nil {
                marked = "[\(marked)](\(href))"
            }
            return marked
        }

        /// Wrap with a delimiter, keeping edge spaces outside it.
        private static func wrap(_ value: String, _ delimiter: String) -> String {
            let leading = value.prefix { $0 == " " }
            let trailing = value.reversed().prefix { $0 == " " }
            let core = value.trimmingCharacters(in: .whitespaces)
            return String(leading) + delimiter + core + delimiter + String(trailing)
        }

        private static func collapse(_ value: String) -> String {
            value.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
        }

    }
}

// MARK: - A forgiving HTML tree

/// Just enough of an HTML parser for pasteboard fragments: tags, attributes,
/// text and entities, with void elements and unclosed `p`/`li` tolerated.
final class HTMLNode {
    let name: String
    var attributes: [String: String]
    var children: [HTMLNode] = []
    /// Text of a `#text` node.
    var value: String

    init(name: String, attributes: [String: String] = [:], value: String = "") {
        self.name = name
        self.attributes = attributes
        self.value = value
    }

    static let blockNames: Set<String> = [
        "address", "article", "aside", "blockquote", "body", "details", "dd", "div", "dl", "dt",
        "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6",
        "header", "hr", "html", "img", "li", "main", "nav", "ol", "p", "pre", "section", "summary",
        "table", "tbody", "td", "tfoot", "th", "thead", "tr", "ul"
    ]

    var isBlock: Bool { HTMLNode.blockNames.contains(name) }

    /// All text below this node, unescaped.
    var text: String {
        if name == "#text" { return value }
        if name == "br" { return "\n" }
        return children.map(\.text).joined()
    }

    func descendant(_ name: String) -> HTMLNode? {
        for child in children {
            if child.name == name { return child }
            if let found = child.descendant(name) { return found }
        }
        return nil
    }
}

enum HTMLTree {
    private static let voidNames: Set<String> = [
        "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "wbr"
    ]
    private static let skippedNames: Set<String> = ["script", "style", "head", "title"]

    static func parse(_ html: String) -> HTMLNode {
        let root = HTMLNode(name: "#root")
        var stack: [HTMLNode] = [root]
        let source = Array(html.unicodeScalars)
        var index = 0
        var text = ""

        func flushText() {
            guard !text.isEmpty else { return }
            stack[stack.count - 1].children.append(HTMLNode(name: "#text", value: decodeEntities(text)))
            text = ""
        }
        func string(_ range: Range<Int>) -> String {
            var result = String.UnicodeScalarView()
            result.append(contentsOf: source[range])
            return String(result)
        }
        func matches(_ needle: String, at start: Int) -> Bool {
            let scalars = Array(needle.unicodeScalars)
            guard start + scalars.count <= source.count else { return false }
            return zip(source[start...], scalars).allSatisfy { a, b in
                a == b || (a.isASCII && b.isASCII && Character(a).lowercased() == Character(b).lowercased())
            }
        }
        func find(_ needle: String, from start: Int) -> Int? {
            var i = start
            while i < source.count {
                if matches(needle, at: i) { return i }
                i += 1
            }
            return nil
        }
        func close(_ name: String) {
            guard let match = stack.lastIndex(where: { $0.name == name }), match > 0 else { return }
            stack.removeSubrange(match...)
        }

        while index < source.count {
            guard source[index] == "<" else {
                text.unicodeScalars.append(source[index])
                index += 1
                continue
            }
            if matches("<!--", at: index) {
                index = (find("-->", from: index + 4).map { $0 + 3 }) ?? source.count
                continue
            }
            guard let end = find(">", from: index) else {
                text.unicodeScalars.append(source[index])
                index += 1
                continue
            }
            let body = string((index + 1)..<end).trimmingCharacters(in: .whitespacesAndNewlines)
            index = end + 1
            if body.hasPrefix("!") || body.hasPrefix("?") { continue }
            flushText()
            if body.hasPrefix("/") {
                close(body.dropFirst().trimmingCharacters(in: .whitespaces).lowercased())
                continue
            }
            let (name, attributes) = tag(body)
            guard !name.isEmpty else { continue }
            if skippedNames.contains(name) {
                index = (find("</\(name)", from: index).flatMap { find(">", from: $0) }.map { $0 + 1 }) ?? source.count
                continue
            }
            // An open paragraph ends at the next block; an open item at the next item.
            if let top = stack.last, top.name == "p", HTMLNode.blockNames.contains(name) { close("p") }
            if name == "li", let item = stack.lastIndex(where: { $0.name == "li" }),
               !stack[item...].contains(where: { $0.name == "ul" || $0.name == "ol" }) {
                stack.removeSubrange(item...)
            }
            let node = HTMLNode(name: name, attributes: attributes)
            stack[stack.count - 1].children.append(node)
            if !voidNames.contains(name), !body.hasSuffix("/") { stack.append(node) }
        }
        flushText()
        return root
    }

    private static func tag(_ body: String) -> (String, [String: String]) {
        var scanner = Substring(body.hasSuffix("/") ? String(body.dropLast()) : body)
        let name = scanner.prefix { !$0.isWhitespace }.lowercased()
        scanner = scanner.dropFirst(name.count)
        var attributes: [String: String] = [:]
        while true {
            scanner = scanner.drop { $0.isWhitespace }
            let key = scanner.prefix { !$0.isWhitespace && $0 != "=" }.lowercased()
            guard !key.isEmpty else { break }
            scanner = scanner.dropFirst(key.count).drop { $0.isWhitespace }
            var value = ""
            if scanner.first == "=" {
                scanner = scanner.dropFirst().drop { $0.isWhitespace }
                if let quote = scanner.first, quote == "\"" || quote == "'" {
                    scanner = scanner.dropFirst()
                    value = String(scanner.prefix { $0 != quote })
                    scanner = scanner.dropFirst(value.count + 1)
                } else {
                    value = String(scanner.prefix { !$0.isWhitespace })
                    scanner = scanner.dropFirst(value.count)
                }
            }
            attributes[key] = decodeEntities(value)
        }
        return (name, attributes)
    }

    private static let namedEntities: [String: String] = [
        "amp": "&", "lt": "<", "gt": ">", "quot": "\"", "apos": "'", "nbsp": " ",
        "mdash": "—", "ndash": "–", "hellip": "…", "lsquo": "‘", "rsquo": "’", "ldquo": "“", "rdquo": "”"
    ]

    static func decodeEntities(_ value: String) -> String {
        guard value.contains("&") else { return value }
        var result = ""
        var rest = Substring(value)
        while let amp = rest.firstIndex(of: "&") {
            result += rest[..<amp]
            let after = rest[rest.index(after: amp)...]
            if let semi = after.prefix(10).firstIndex(of: ";") {
                let entity = String(after[..<semi])
                var decoded: String?
                if entity.hasPrefix("#x") || entity.hasPrefix("#X") {
                    decoded = UInt32(entity.dropFirst(2), radix: 16).flatMap(Unicode.Scalar.init).map { String($0) }
                } else if entity.hasPrefix("#") {
                    decoded = UInt32(entity.dropFirst()).flatMap(Unicode.Scalar.init).map { String($0) }
                } else {
                    decoded = namedEntities[entity]
                }
                if let decoded {
                    result += decoded
                    rest = after[after.index(after: semi)...]
                    continue
                }
            }
            result += "&"
            rest = after
        }
        return result + rest
    }
}
