import Foundation

public struct ResolvedLocatorState: Sendable, Equatable {
    public var stableKey: String?
    public var revision: String?
    public var applicationQuery: String?
    public var contentFragment: String?
    /// Input-only candidate. A PageID owner index must prove it unique.
    public var legacyStableKeyCandidate: String?
}

public enum ResolvedLink: Sendable, Equatable {
    case local(path: String, locator: ResolvedLocatorState)
    case arbor(authority: ArborAuthority, path: String, locator: ResolvedLocatorState)
    case system(raw: String)
    case overlay(raw: String)
    case external(href: String)
    case fragment(contentFragment: String, legacyStableKeyCandidate: String)
}

public enum ArborAuthority: Sendable, Equatable {
    case dns(String)
    case treeID(String)
}

private let schemeExpression = try! NSRegularExpression(pattern: "^([a-zA-Z][a-zA-Z0-9+.-]*):")
private let markdownKeyPrefix = "arbor-key="

private func splitOnce(_ value: String, separator: Character) -> (String, String?) {
    guard let index = value.firstIndex(of: separator) else { return (value, nil) }
    return (String(value[..<index]), String(value[value.index(after: index)...]))
}

private func canonicalStableKeyJSON(_ value: String) -> Bool {
    guard
        let data = value.data(using: .utf8),
        let parsed = try? JSONSerialization.jsonObject(with: data),
        let pairs = parsed as? [Any],
        !pairs.isEmpty
    else { return false }
    for entry in pairs {
        guard
            let pair = entry as? [Any], pair.count == 2,
            let property = pair[0] as? String, !property.isEmpty
        else { return false }
        switch pair[1] {
        case is String, is Bool:
            break
        case let number as NSNumber:
            guard number.doubleValue.isFinite else { return false }
        default:
            return false
        }
    }
    guard
        let canonical = try? JSONSerialization.data(withJSONObject: parsed, options: [.withoutEscapingSlashes]),
        let canonicalString = String(data: canonical, encoding: .utf8)
    else { return false }
    return canonicalString == value
}

public func encodeStableKey(_ value: String) -> String? {
    guard canonicalStableKeyJSON(value) else { return nil }
    return Data(value.utf8).base64EncodedString()
        .replacingOccurrences(of: "+", with: "-")
        .replacingOccurrences(of: "/", with: "_")
        .replacingOccurrences(of: "=+$", with: "", options: .regularExpression)
}

public func decodeStableKey(_ value: String) -> String? {
    guard !value.isEmpty, value.range(of: #"^[A-Za-z0-9_-]+$"#, options: .regularExpression) != nil else { return nil }
    let standard = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    let padded = standard + String(repeating: "=", count: (4 - standard.count % 4) % 4)
    guard
        let data = Data(base64Encoded: padded),
        let decoded = String(data: data, encoding: .utf8),
        canonicalStableKeyJSON(decoded),
        encodeStableKey(decoded) == value
    else { return nil }
    return decoded
}

private func locatorState(destination: String, fragment: String?) -> (rawPath: String, locator: ResolvedLocatorState)? {
    let (rawPathWithKey, applicationQuery) = splitOnce(destination, separator: "?")
    let lastSlash = rawPathWithKey.lastIndex(of: "/")
    let keyMarker = rawPathWithKey.range(of: ";arbor-key=", options: .backwards)
    let suffixIsFinalSegment = keyMarker.map { range in
        lastSlash == nil || range.lowerBound > lastSlash!
    } ?? false

    var rawPath = rawPathWithKey
    var pathStableKey: String?
    if let keyMarker, suffixIsFinalSegment {
        let token = String(rawPathWithKey[keyMarker.upperBound...])
        guard !token.contains(";"), let decoded = decodeStableKey(token) else { return nil }
        rawPath = String(rawPathWithKey[..<keyMarker.lowerBound])
        pathStableKey = decoded
    }

    var markdownStableKey: String?
    if let fragment, fragment.hasPrefix(markdownKeyPrefix) {
        guard let decoded = decodeStableKey(String(fragment.dropFirst(markdownKeyPrefix.count))) else { return nil }
        markdownStableKey = decoded
    }
    guard pathStableKey == nil || markdownStableKey == nil else { return nil }
    let ordinaryFragment = markdownStableKey == nil && !(fragment?.isEmpty ?? true) ? fragment : nil
    let stableKey = pathStableKey ?? markdownStableKey
    return (
        rawPath,
        ResolvedLocatorState(
            stableKey: stableKey,
            revision: nil,
            applicationQuery: applicationQuery,
            contentFragment: ordinaryFragment,
            legacyStableKeyCandidate: stableKey == nil ? ordinaryFragment : nil
        )
    )
}

/// Canonical browser/API identity for an already decoded x.md, x/, or x/_index.md path.
private func canonicalDecodedNodePath(_ input: String) -> String? {
    guard !input.contains("\\"), !input.contains("\0") else { return nil }
    let parts = input.split(separator: "/", omittingEmptySubsequences: true).map(String.init)
    guard !parts.contains("."), !parts.contains("..") else { return nil }
    var path = "/" + parts.joined(separator: "/")
    if path == "/_index.md" { return "/" }
    if path.hasSuffix("/_index.md") { path = String(path.dropLast("/_index.md".count)); return path.isEmpty ? "/" : path }
    if path.hasSuffix(".md") { path = String(path.dropLast(3)); return path.isEmpty ? "/" : path }
    return path
}

func canonicalNodePath(_ input: String) -> String {
    canonicalDecodedNodePath(input) ?? input
}

private func resolveTreePath(base baseDocumentPath: String, rawDestination: String) -> String? {
    var stack: [String]
    if rawDestination.hasPrefix("/") {
        stack = []
    } else {
        guard let base = canonicalDecodedNodePath(baseDocumentPath) else { return nil }
        stack = base.split(separator: "/").map(String.init)
    }
    for rawSegment in rawDestination.split(separator: "/", omittingEmptySubsequences: false) {
        if rawSegment.isEmpty { continue }
        guard let segment = String(rawSegment).removingPercentEncoding else { return nil }
        if segment.contains("/") || segment.contains("\\") || segment.contains("\0") { return nil }
        if segment == "." { continue }
        if segment == ".." {
            guard !stack.isEmpty else { return nil }
            stack.removeLast()
        } else {
            stack.append(segment)
        }
    }
    return canonicalDecodedNodePath("/" + stack.joined(separator: "/"))
}

private func parseRevision(_ value: String) -> (value: String, revision: String?)? {
    guard let marker = value.range(of: "@sha256:") else { return (value, nil) }
    let identity = String(value[..<marker.lowerBound])
    let revision = String(value[marker.lowerBound...].dropFirst())
    guard !identity.isEmpty, revision.range(of: #"^sha256:[a-f0-9]{64}$"#, options: .regularExpression) != nil else { return nil }
    return (identity, revision)
}

private func parseArborURL(_ href: String) -> ResolvedLink? {
    let withoutScheme = String(href.dropFirst("arbor://".count))
    let (destination, fragment) = splitOnce(withoutScheme, separator: "#")
    guard let parsed = locatorState(destination: destination, fragment: fragment) else { return nil }
    var parts = parsed.rawPath.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
    guard let authorityPart = parts.first, !authorityPart.isEmpty else { return nil }
    parts.removeFirst()
    let authority: ArborAuthority
    var locator = parsed.locator
    if authorityPart == "tree" {
        guard let treeIdentity = parts.first, let parsedIdentity = parseRevision(treeIdentity) else { return nil }
        authority = .treeID(parsedIdentity.value)
        locator.revision = parsedIdentity.revision
        parts.removeFirst()
    } else {
        authority = .dns(authorityPart)
    }
    guard let path = resolveTreePath(base: "/", rawDestination: parts.joined(separator: "/")) else { return nil }
    return .arbor(authority: authority, path: path, locator: locator)
}

public func resolveLogicalURL(base baseDocumentPath: String, href: String) -> ResolvedLink? {
    let raw = href.trimmingCharacters(in: .whitespacesAndNewlines)
    if raw.isEmpty { return nil }
    if raw.hasPrefix("#") {
        let fragment = String(raw.dropFirst())
        guard !fragment.isEmpty, !fragment.hasPrefix(markdownKeyPrefix) else { return nil }
        return .fragment(contentFragment: fragment, legacyStableKeyCandidate: fragment)
    }

    let range = NSRange(raw.startIndex..., in: raw)
    if let match = schemeExpression.firstMatch(in: raw, range: range),
       let schemeRange = Range(match.range(at: 1), in: raw) {
        switch raw[schemeRange].lowercased() {
        case "arbor":
            return raw.hasPrefix("arbor://") ? parseArborURL(raw) : nil
        case "tree":
            var remainder = String(raw.dropFirst("tree:".count))
            while remainder.hasPrefix("/") { remainder.removeFirst() }
            return parseArborURL("arbor://tree/\(remainder)")
        case "system": return .system(raw: raw)
        case "local": return .overlay(raw: raw)
        default: return .external(href: raw)
        }
    }

    let (destination, fragment) = splitOnce(raw, separator: "#")
    guard
        let parsed = locatorState(destination: destination, fragment: fragment),
        let path = resolveTreePath(base: baseDocumentPath, rawDestination: parsed.rawPath)
    else { return nil }
    return .local(path: path, locator: parsed.locator)
}

func nodeDisplayName(_ nodePath: String) -> String {
    let canonical = canonicalNodePath(nodePath)
    if canonical == "/" { return "/" }
    return String(canonical[canonical.index(after: canonical.lastIndex(of: "/")!)...])
}

public func relativeLogicalReference(from fromInput: String, to toInput: String) -> String {
    let from = canonicalNodePath(fromInput).split(separator: "/").map(String.init)
    let to = canonicalNodePath(toInput).split(separator: "/").map(String.init)
    var shared = 0
    while shared < from.count, shared < to.count, from[shared] == to[shared] { shared += 1 }
    let reference = (Array(repeating: "..", count: from.count - shared) + to.dropFirst(shared)).joined(separator: "/")
    return reference.isEmpty ? nodeDisplayName(toInput) : reference
}

private func querySuffix(_ applicationQuery: String?) -> String {
    applicationQuery.map { "?\($0)" } ?? ""
}

public func buildCanonicalLink(from fromInput: String, toPath: String, stableKey: String? = nil, applicationQuery: String? = nil) -> String? {
    let reference = relativeLogicalReference(from: fromInput, to: toPath)
    guard let stableKey else { return reference + querySuffix(applicationQuery) }
    guard let encoded = encodeStableKey(stableKey) else { return nil }
    return "\(reference)\(querySuffix(applicationQuery))#\(markdownKeyPrefix)\(encoded)"
}

public func buildNetworkLocator(
    rawPath: String,
    stableKey: String? = nil,
    applicationQuery: String? = nil,
    contentFragment: String? = nil
) -> String? {
    var result = rawPath
    if let stableKey {
        guard let encoded = encodeStableKey(stableKey) else { return nil }
        result += ";arbor-key=\(encoded)"
    }
    result += querySuffix(applicationQuery)
    if let contentFragment { result += "#\(contentFragment)" }
    return result
}

/// Rewrite only a local link's readable path, retaining all locator state.
public func rewriteLocalLinkPath(base: String, href: String, newPath: String) -> String? {
    guard case let .local(_, locator) = resolveLogicalURL(base: base, href: href) else { return nil }
    let relativePath = relativeLogicalReference(from: base, to: newPath)
    if locator.stableKey != nil, locator.contentFragment != nil {
        return buildNetworkLocator(
            rawPath: relativePath,
            stableKey: locator.stableKey,
            applicationQuery: locator.applicationQuery,
            contentFragment: locator.contentFragment
        )
    }
    if let stableKey = locator.stableKey {
        return buildCanonicalLink(
            from: base,
            toPath: newPath,
            stableKey: stableKey,
            applicationQuery: locator.applicationQuery
        )
    }
    return buildNetworkLocator(
        rawPath: relativePath,
        applicationQuery: locator.applicationQuery,
        contentFragment: locator.contentFragment
    )
}
