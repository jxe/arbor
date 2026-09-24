import CanopyAppKit
import Overstory
import Foundation

enum WorkingTreeSemantics {
    private static let pageIDLine = try? NSRegularExpression(pattern: #"(?m)^id:[ \t]*(.*?)[ \t]*\r?$"#)
    private static let pageIDReplacement = try? NSRegularExpression(pattern: #"(?m)^(id:)[ \t]*(.*?)[ \t]*(\r?)$"#)

    static func normalizePath(_ value: String) throws -> String {
        guard value.hasPrefix("/"), !value.contains("\0"), !value.contains("\\") else {
            throw WorkingTreeError.invalidPath(value)
        }
        var parts: [Substring] = []
        for part in value.split(separator: "/", omittingEmptySubsequences: true) {
            guard part != ".", part != ".." else { throw WorkingTreeError.invalidPath(value) }
            parts.append(part)
        }
        return parts.isEmpty ? "/" : "/" + parts.joined(separator: "/")
    }

    static func validateName(_ value: String) throws {
        guard !value.isEmpty, value != ".", value != "..", value != ".arbor", value != "_index.md",
              !value.contains("/"), !value.contains("\\"), !value.contains("\0") else {
            throw WorkingTreeError.invalidName(value)
        }
    }

    static func parent(of path: String) -> String? {
        guard path != "/" else { return nil }
        let parts = path.split(separator: "/")
        return parts.count == 1 ? "/" : "/" + parts.dropLast().joined(separator: "/")
    }

    static func name(of path: String) -> String { path == "/" ? "/" : String(path.split(separator: "/").last!) }

    static func child(_ name: String, of parent: String) -> String {
        parent == "/" ? "/\(name)" : "\(parent)/\(name)"
    }

    static func isDescendant(_ path: String, of parent: String) -> Bool {
        parent == "/" ? path != "/" : path.hasPrefix(parent + "/")
    }

    static func replacingPrefix(_ path: String, from: String, to: String) -> String {
        path == from ? to : to + path.dropFirst(from.count)
    }

    static func compareUTF8(_ left: String, _ right: String) -> Bool {
        left.utf8.lexicographicallyPrecedes(right.utf8)
    }

    static func pageID(in source: String) -> String? {
        let values = pageIDValues(in: source)
        return values.count == 1 ? values[0] : nil
    }

    static func pageIDValues(in source: String) -> [String] {
        guard let bodyStart = frontmatterRange(in: source) else { return [] }
        let frontmatter = String(source[bodyStart])
        guard let regex = pageIDLine else { return [] }
        return regex.matches(in: frontmatter, range: NSRange(frontmatter.startIndex..., in: frontmatter)).compactMap { match in
            guard let range = Range(match.range(at: 1), in: frontmatter) else { return nil }
            var value = String(frontmatter[range]).trimmingCharacters(in: .whitespacesAndNewlines)
            if value.count >= 2, (value.first == "\"" && value.last == "\"") || (value.first == "'" && value.last == "'") {
                value.removeFirst()
                value.removeLast()
            }
            return value.isEmpty ? nil : value
        }
    }

    static func ensuringPageID(in source: String, id: String) -> String {
        if pageID(in: source) != nil { return source }
        let newline = source.contains("\r\n") ? "\r\n" : "\n"
        if source.hasPrefix("---\(newline)"), let closing = source.range(of: "\(newline)---\(newline)", range: source.index(source.startIndex, offsetBy: 4)..<source.endIndex) {
            return source[..<closing.lowerBound] + "\(newline)id: \(id)" + source[closing.lowerBound...]
        }
        return "---\(newline)id: \(id)\(newline)---\(newline)\(newline)\(source)"
    }

    static func replacingPageID(in source: String, with id: String) -> String {
        guard let frontmatter = frontmatterRange(in: source) else { return ensuringPageID(in: source, id: id) }
        guard let regex = pageIDReplacement,
              regex.firstMatch(in: source, range: NSRange(frontmatter, in: source)) != nil else {
            return ensuringPageID(in: source, id: id)
        }
        return regex.stringByReplacingMatches(
            in: source,
            range: NSRange(frontmatter, in: source),
            withTemplate: "$1 \(NSRegularExpression.escapedTemplate(for: id))$3"
        )
    }

    static func title(for node: WorkingTreeNode) -> String {
        WorkspaceDisplayTitle.derived(
            from: node.source,
            fallback: node.path == "/" ? "Home" : name(of: node.path)
        )
    }

    /// `children` are the nodes whose parent is `node`, in any order.
    static func documentRevision(node: WorkingTreeNode, children: [WorkingTreeNode]) -> String {
        switch node.kind {
        case .markdown:
            return WireObjectCodec.hash(Data((node.source ?? "").utf8))
        case .file:
            return node.ref?.objectHash ?? WireObjectCodec.hash(Data())
        case .boundary:
            return WireObjectCodec.hash(Data((node.boundaryTree ?? "").utf8))
        case .directory:
            let descriptors = children
                .filter { !$0.path.hasPrefix("/Trash/") && $0.path != "/Trash" }
                .sorted { compareUTF8($0.path, $1.path) }
                .map { "\($0.pageID ?? "-")\u{001f}\($0.path)\u{001f}\($0.kind.rawValue)" }
                .joined(separator: "\u{001e}")
            var data = Data((node.source ?? "").utf8)
            data.append(0)
            data.append(Data(descriptors.utf8))
            return WireObjectCodec.hash(data)
        }
    }

    /// The directory a node's relative links resolve against. A directory carries its own
    /// `_index.md` body, so its links are written relative to itself; every other node's are
    /// written relative to its parent, matching the editor's `relativeReferenceBase`.
    static func linkBase(for node: WorkingTreeNode) -> String {
        node.kind == .directory ? node.path : (parent(of: node.path) ?? "/")
    }

    static func linkTargets(in source: String, relativeTo directory: String) -> [ResolvedNodeTarget] {
        markdownLinkHrefRanges(in: source).compactMap { resolveNodeTarget(base: directory, href: String(source[$0])) }
    }

    static func isStoreFile(_ node: WorkingTreeNode) -> Bool {
        node.kind == .file && ["_store.csv", "_store.json", "_store.jsonl", "_store.sqlite3", "_store.postgres"].contains(name(of: node.path))
    }

    private static func frontmatterRange(in source: String) -> Range<String.Index>? {
        let newline = source.hasPrefix("---\r\n") ? "\r\n" : "\n"
        guard source.hasPrefix("---\(newline)") else { return nil }
        let start = source.index(source.startIndex, offsetBy: 3 + newline.count)
        guard let closing = source.range(of: "\(newline)---", range: start..<source.endIndex) else { return nil }
        return start..<closing.lowerBound
    }
}
