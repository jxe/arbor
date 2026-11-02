import StoryKit
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
        // `.arbor`, the reserved segment's spelling from before the Overstory
        // rename, stays refused alongside `.overstory` (old names, "Kept").
        guard !value.isEmpty, value != ".", value != "..", value != ".overstory", value != ".arbor", value != "_index.md",
              !value.contains("/"), !value.contains("\\"), !value.contains("\0") else {
            throw WorkingTreeError.invalidName(value)
        }
    }

    // A normalized path (leading "/", no empty segment, no trailing "/")
    // splits at its last "/" without splitting every segment; anything else
    // takes the segment-by-segment reading.
    private static func isNormalized(_ path: String) -> Bool {
        path.hasPrefix("/") && !path.hasSuffix("/") && !path.contains("//")
    }

    static func parent(of path: String) -> String? {
        guard path != "/" else { return nil }
        guard isNormalized(path), let slash = path.utf8.lastIndex(of: UInt8(ascii: "/")) else {
            let parts = path.split(separator: "/")
            return parts.count <= 1 ? "/" : "/" + parts.dropLast().joined(separator: "/")
        }
        return slash == path.utf8.startIndex ? "/" : String(path[..<slash])
    }

    static func name(of path: String) -> String {
        guard path != "/" else { return "/" }
        guard isNormalized(path), let slash = path.utf8.lastIndex(of: UInt8(ascii: "/")) else {
            return String(path.split(separator: "/").last!)
        }
        return String(path[path.utf8.index(after: slash)...])
    }

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
        // Every node's ID is read on each projection and check; front matter
        // is short and rarely changes, so its answer is remembered.
        if let known = pageIDMemo.withLock({ $0[frontmatter] }) { return known }
        let values = pageIDValues(frontmatter: frontmatter)
        pageIDMemo.withLock { memo in
            if memo.count >= 20_000 { memo.removeAll() }
            memo[frontmatter] = values
        }
        return values
    }

    private static let pageIDMemo = LockedValue<[String: [String]]>([:])

    private static func pageIDValues(frontmatter: String) -> [String] {
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
            return ProtocolObjectCodec.hash(Data((node.source ?? "").utf8))
        case .file:
            return node.ref?.objectHash ?? ProtocolObjectCodec.hash(Data())
        case .boundary:
            return ProtocolObjectCodec.hash(Data((node.boundaryTree ?? "").utf8))
        case .directory:
            let descriptors = children
                .filter { !$0.path.hasPrefix("/Trash/") && $0.path != "/Trash" }
                .sorted { compareUTF8($0.path, $1.path) }
                .map { "\($0.pageID ?? "-")\u{001f}\($0.path)\u{001f}\($0.kind.rawValue)" }
                .joined(separator: "\u{001e}")
            var data = Data((node.source ?? "").utf8)
            data.append(0)
            data.append(Data(descriptors.utf8))
            return ProtocolObjectCodec.hash(data)
        }
    }

    /// The directory holding a node's body file, which its relative links resolve against: the
    /// parent for a Markdown leaf or a directory's sibling `x.md`, the directory itself for its
    /// `_index.md` (or a directory with no body yet).
    static func sourceDirectory(for node: WorkingTreeNode) -> String {
        markdownSourceDirectory(nodePath: node.path, body: node.markdownBody)
    }

    static func linkTargets(in source: String, sourceDirectory: String) -> [ResolvedNodeTarget] {
        markdownLinkDestinations(in: source).compactMap { destination in
            destination.image ? nil : resolveNodeTarget(sourceDirectory: sourceDirectory, href: destination.href)
        }
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

/// A value behind a lock, for small process-wide memos.
final class LockedValue<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Value
    init(_ value: Value) { self.value = value }
    func withLock<Result>(_ body: (inout Value) -> Result) -> Result {
        lock.lock()
        defer { lock.unlock() }
        return body(&value)
    }
}
