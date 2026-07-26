import Foundation

/// One resolver for every Markdown link destination form in spec/urls.md,
/// mirroring `@arbor/core` `logical-url.ts` exactly. Both implementations
/// must produce structurally identical results for the shared
/// `url-resolution.json` fixture table.
public enum ResolvedLink: Sendable, Equatable {
    case local(path: String, pageID: String?, fragment: String?)
    case arbor(authority: ArborAuthority, path: String, pageID: String?, fragment: String?)
    case system(raw: String)
    case overlay(raw: String)
    case external(href: String)
    case fragment(pageID: String)
}

public enum ArborAuthority: Sendable, Equatable {
    case dns(String)
    case treeID(String)
}

private let pageIDExpression = try! NSRegularExpression(pattern: "^[a-z0-9]{6}$")
private let schemeExpression = try! NSRegularExpression(pattern: "^([a-zA-Z][a-zA-Z0-9+.-]*):")

private func fragmentPageID(_ fragment: String?) -> String? {
    guard let fragment, !fragment.isEmpty else { return nil }
    let range = NSRange(fragment.startIndex..., in: fragment)
    return pageIDExpression.firstMatch(in: fragment, range: range) != nil ? fragment : nil
}

private func splitFragment(_ href: String) -> (destination: String, fragment: String?) {
    guard let index = href.firstIndex(of: "#") else { return (href, nil) }
    return (String(href[..<index]), String(href[href.index(after: index)...]))
}

/// Canonical browser/API identity for x.md, x/, or x/_index.md — mirrors
/// `canonicalNodePath` without the `.`/`..` rejection (dots are resolved by
/// the caller before canonicalization).
func canonicalNodePath(_ input: String) -> String {
    let parts = input.replacingOccurrences(of: "\\", with: "/").split(separator: "/").map(String.init)
    var path = "/" + parts.joined(separator: "/")
    if path == "/_index.md" { return "/" }
    if path.hasSuffix("/_index.md") { path = String(path.dropLast("/_index.md".count)); return path.isEmpty ? "/" : path }
    if path.hasSuffix(".md") { path = String(path.dropLast(3)); return path.isEmpty ? "/" : path }
    return path
}

private func resolveTreePath(base baseDocumentPath: String, destination: String) -> String? {
    let withoutQuery = destination.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)[0]
    guard let decoded = String(withoutQuery).removingPercentEncoding else { return nil }
    let normalized = decoded.replacingOccurrences(of: "\\", with: "/")
    if normalized.contains("\0") { return nil }

    var stack: [String]
    if normalized.hasPrefix("/") {
        stack = []
    } else {
        stack = canonicalNodePath(baseDocumentPath).split(separator: "/").map(String.init)
    }
    for segment in normalized.split(separator: "/") {
        if segment.isEmpty || segment == "." { continue }
        if segment == ".." {
            if stack.isEmpty { return nil }
            stack.removeLast()
            continue
        }
        stack.append(String(segment))
    }
    if stack.contains(where: { $0 == "." || $0 == ".." }) { return nil }
    return canonicalNodePath("/" + stack.joined(separator: "/"))
}

private func parseArborURL(_ href: String) -> ResolvedLink? {
    let withoutScheme = String(href.dropFirst("arbor://".count))
    let (destination, fragment) = splitFragment(withoutScheme)
    var parts = destination.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
    guard let authorityPart = parts.first, !authorityPart.isEmpty else { return nil }
    parts.removeFirst()
    let authority: ArborAuthority
    if authorityPart == "tree" {
        guard let treeID = parts.first, !treeID.isEmpty else { return nil }
        authority = .treeID(treeID)
        parts.removeFirst()
    } else {
        authority = .dns(authorityPart)
    }
    guard let path = resolveTreePath(base: "/", destination: parts.joined(separator: "/")) else { return nil }
    let cleanFragment = (fragment?.isEmpty ?? true) ? nil : fragment
    return .arbor(authority: authority, path: path, pageID: fragmentPageID(cleanFragment), fragment: cleanFragment)
}

public func resolveLogicalURL(base baseDocumentPath: String, href: String) -> ResolvedLink? {
    let raw = href.trimmingCharacters(in: .whitespacesAndNewlines)
    if raw.isEmpty { return nil }

    if raw.hasPrefix("#") {
        let fragment = String(raw.dropFirst())
        guard let pageID = fragmentPageID(fragment) else { return nil }
        return .fragment(pageID: pageID)
    }

    let range = NSRange(raw.startIndex..., in: raw)
    if let match = schemeExpression.firstMatch(in: raw, range: range),
       let schemeRange = Range(match.range(at: 1), in: raw) {
        let scheme = raw[schemeRange].lowercased()
        switch scheme {
        case "arbor":
            return raw.hasPrefix("arbor://") ? parseArborURL(raw) : nil
        case "tree":
            // Compatibility spelling `tree:tr_…/path`, normalized to the arbor://tree authority.
            var remainder = String(raw.dropFirst("tree:".count))
            while remainder.hasPrefix("/") { remainder.removeFirst() }
            return parseArborURL("arbor://tree/\(remainder)")
        case "system":
            return .system(raw: raw)
        case "local":
            return .overlay(raw: raw)
        default:
            return .external(href: raw)
        }
    }

    let (destination, fragment) = splitFragment(raw)
    guard let path = resolveTreePath(base: baseDocumentPath, destination: destination) else { return nil }
    let cleanFragment = (fragment?.isEmpty ?? true) ? nil : fragment
    return .local(path: path, pageID: fragmentPageID(cleanFragment), fragment: cleanFragment)
}

func nodeDisplayName(_ nodePath: String) -> String {
    let canonical = canonicalNodePath(nodePath)
    if canonical == "/" { return "/" }
    return String(canonical[canonical.index(after: canonical.lastIndex(of: "/")!)...])
}

/// The shortest relative spelling of `to` from the document base `from`,
/// mirroring `relativeLogicalReference`.
public func relativeLogicalReference(from fromInput: String, to toInput: String) -> String {
    let from = canonicalNodePath(fromInput).split(separator: "/").map(String.init)
    let to = canonicalNodePath(toInput).split(separator: "/").map(String.init)
    var shared = 0
    while shared < from.count, shared < to.count, from[shared] == to[shared] { shared += 1 }
    let reference = (Array(repeating: "..", count: from.count - shared) + to.dropFirst(shared)).joined(separator: "/")
    return reference.isEmpty ? nodeDisplayName(toInput) : reference
}

/// The canonical authored spelling of a link from one document to another.
public func buildCanonicalLink(from fromInput: String, toPath: String, pageID: String? = nil) -> String {
    let reference = relativeLogicalReference(from: fromInput, to: toPath)
    if let pageID { return "\(reference)#\(pageID)" }
    return reference
}
