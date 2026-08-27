import ArborKit
import CryptoKit
import Foundation

enum ReplicaSemantics {
    static func normalizePath(_ value: String) throws -> String {
        guard value.hasPrefix("/"), !value.contains("\0"), !value.contains("\\") else {
            throw ReplicaError.invalidPath(value)
        }
        var parts: [Substring] = []
        for part in value.split(separator: "/", omittingEmptySubsequences: true) {
            guard part != ".", part != ".." else { throw ReplicaError.invalidPath(value) }
            parts.append(part)
        }
        return parts.isEmpty ? "/" : "/" + parts.joined(separator: "/")
    }

    static func validateName(_ value: String) throws {
        guard !value.isEmpty, value != ".", value != "..", value != ".arbor", value != "_index.md",
              !value.contains("/"), !value.contains("\\"), !value.contains("\0") else {
            throw ReplicaError.invalidName(value)
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

    static func sha256(_ data: Data) -> String {
        "sha256:" + SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    static func pageID(in source: String) -> String? {
        let values = pageIDValues(in: source)
        return values.count == 1 ? values[0] : nil
    }

    static func pageIDValues(in source: String) -> [String] {
        guard let bodyStart = frontmatterRange(in: source) else { return [] }
        let frontmatter = String(source[bodyStart])
        let pattern = #"(?m)^id:[ \t]*(.*?)[ \t]*\r?$"#
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return [] }
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
        let pattern = #"(?m)^(id:)[ \t]*(.*?)[ \t]*(\r?)$"#
        guard let regex = try? NSRegularExpression(pattern: pattern),
              regex.firstMatch(in: source, range: NSRange(frontmatter, in: source)) != nil else {
            return ensuringPageID(in: source, id: id)
        }
        return regex.stringByReplacingMatches(
            in: source,
            range: NSRange(frontmatter, in: source),
            withTemplate: "$1 \(NSRegularExpression.escapedTemplate(for: id))$3"
        )
    }

    static func title(for node: ReplicaNodeRecord) -> String {
        if let source = node.source {
            for line in source.split(whereSeparator: \.isNewline) {
                if line.hasPrefix("# ") {
                    let title = line.dropFirst(2).trimmingCharacters(in: .whitespaces)
                    if !title.isEmpty { return title }
                }
            }
        }
        return node.path == "/" ? "Home" : name(of: node.path)
    }

    static func documentRevision(node: ReplicaNodeRecord, state: ReplicaState) -> String {
        switch node.kind {
        case .markdown:
            return sha256(Data((node.source ?? "").utf8))
        case .file:
            return sha256(node.bytes ?? Data())
        case .boundary:
            return sha256(Data((node.boundaryTree ?? "").utf8))
        case .directory:
            let descriptors = state.nodes
                .filter { parent(of: $0.path) == node.path && !$0.path.hasPrefix("/Trash/") && $0.path != "/Trash" }
                .sorted { compareUTF8($0.path, $1.path) }
                .map { "\($0.pageID ?? "-")\u{001f}\($0.path)\u{001f}\($0.kind.rawValue)" }
                .joined(separator: "\u{001e}")
            var data = Data((node.source ?? "").utf8)
            data.append(0)
            data.append(Data(descriptors.utf8))
            return sha256(data)
        }
    }

    static func completeDirectorySource(node: ReplicaNodeRecord, state: ReplicaState) -> String {
        let source = node.source ?? ""
        let children = state.nodes.filter {
            parent(of: $0.path) == node.path && $0.path != "/Trash" && !$0.path.hasPrefix("/Trash/") && !isStoreFile($0)
        }
        let links = standaloneLinks(in: source, relativeTo: node.path)
        let linkedPaths = Set(links.paths)
        let linkedIDs = Set(links.pageIDs)
        let missing = children.filter { child in
            !linkedPaths.contains(child.path) && (child.pageID == nil || !linkedIDs.contains(child.pageID!))
        }.sorted { compareUTF8($0.path, $1.path) }
        guard !missing.isEmpty else { return source }
        let newline = source.contains("\r\n") ? "\r\n" : "\n"
        let separator: String
        if source.isEmpty || source.hasSuffix("\n\n") || source.hasSuffix("\r\n\r\n") { separator = "" }
        else if source.hasSuffix("\n") || source.hasSuffix("\r") { separator = newline }
        else { separator = newline + newline }
        let appended = missing.map { child in
            let label = name(of: child.path).replacingOccurrences(of: "\\", with: "\\\\")
                .replacingOccurrences(of: "[", with: "\\[")
                .replacingOccurrences(of: "]", with: "\\]")
            return "[\(label)](\(relativeReference(from: node.path, to: child.path)))"
        }.joined(separator: newline + newline) + newline
        return source + separator + appended
    }

    static func links(in source: String, relativeTo directory: String) -> [String] {
        let pattern = #"\[[^\]]*\]\(([^)]+)\)"#
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return [] }
        return regex.matches(in: source, range: NSRange(source.startIndex..., in: source)).compactMap { match in
            guard let range = Range(match.range(at: 1), in: source) else { return nil }
            return resolve(reference: String(source[range]), relativeTo: directory).path
        }
    }

    static func isStoreFile(_ node: ReplicaNodeRecord) -> Bool {
        node.kind == .file && ["_store.csv", "_store.json", "_store.jsonl", "_store.sqlite3", "_store.postgres"].contains(name(of: node.path))
    }

    private static func standaloneLinks(in source: String, relativeTo directory: String) -> (paths: [String], pageIDs: [String]) {
        let pattern = #"(?m)^[ \t]*\[[^\]]*\]\(([^)]+)\)[ \t]*\r?$"#
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return ([], []) }
        var paths: [String] = []
        var pageIDs: [String] = []
        for match in regex.matches(in: source, range: NSRange(source.startIndex..., in: source)) {
            guard let range = Range(match.range(at: 1), in: source) else { continue }
            let resolved = resolve(reference: String(source[range]), relativeTo: directory)
            paths.append(resolved.path)
            if let id = resolved.pageID { pageIDs.append(id) }
        }
        return (paths, pageIDs)
    }

    private static func resolve(reference: String, relativeTo directory: String) -> (path: String, pageID: String?) {
        let pieces = reference.split(separator: "#", maxSplits: 1, omittingEmptySubsequences: false)
        let rawPath = String(pieces[0])
        let pageID = pieces.count == 2 && !pieces[1].isEmpty ? String(pieces[1]) : nil
        if rawPath.hasPrefix("/") { return ((try? normalizePath(rawPath)) ?? rawPath, pageID) }
        var parts = directory.split(separator: "/").map(String.init)
        for part in rawPath.split(separator: "/", omittingEmptySubsequences: true) {
            if part == "." { continue }
            if part == ".." { _ = parts.popLast() }
            else { parts.append(String(part)) }
        }
        return (parts.isEmpty ? "/" : "/" + parts.joined(separator: "/"), pageID)
    }

    private static func relativeReference(from directory: String, to target: String) -> String {
        let base = directory.split(separator: "/").map(String.init)
        let destination = target.split(separator: "/").map(String.init)
        var common = 0
        while common < base.count, common < destination.count, base[common] == destination[common] { common += 1 }
        let parts = Array(repeating: "..", count: base.count - common) + destination.dropFirst(common)
        return parts.isEmpty ? "." : parts.joined(separator: "/")
    }

    private static func frontmatterRange(in source: String) -> Range<String.Index>? {
        let newline = source.hasPrefix("---\r\n") ? "\r\n" : "\n"
        guard source.hasPrefix("---\(newline)") else { return nil }
        let start = source.index(source.startIndex, offsetBy: 3 + newline.count)
        guard let closing = source.range(of: "\(newline)---", range: start..<source.endIndex) else { return nil }
        return start..<closing.lowerBound
    }
}
