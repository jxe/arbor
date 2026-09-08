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
private let parameterMarker = ";arbor-"
private let revisionPattern = #"^sha256:[a-f0-9]{64}$"#
private let treeIDAuthorityPattern = #"^tr_[a-z2-7]+$"#
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

public func canonicalStableKey(_ pairs: [(String, JSONValue)]) throws -> String {
    guard !pairs.isEmpty else { throw EncodingError.invalidValue(pairs, .init(codingPath: [], debugDescription: "stable key must be nonempty")) }
    let encoder = JSONEncoder()
    var encoded: [String] = []
    for (property, value) in pairs {
        guard !property.isEmpty else {
            throw EncodingError.invalidValue(property, .init(codingPath: [], debugDescription: "stable-key property must be nonempty"))
        }
        switch value {
        case .string, .bool, .number:
            break
        default:
            throw EncodingError.invalidValue(value, .init(codingPath: [], debugDescription: "stable-key value must be a non-null scalar"))
        }
        let propertyJSON = String(decoding: try encoder.encode(property), as: UTF8.self)
        let valueJSON = String(decoding: try encoder.encode(value), as: UTF8.self)
        encoded.append("[\(propertyJSON),\(valueJSON)]")
    }
    let result = "[\(encoded.joined(separator: ","))]"
    guard canonicalStableKeyJSON(result) else {
        throw EncodingError.invalidValue(pairs, .init(codingPath: [], debugDescription: "stable key is not canonical JSON"))
    }
    return result
}

public func pageIDStableKey(_ pageID: String) -> String {
    try! canonicalStableKey([("id", .string(pageID))])
}

public func pageIDFromStableKey(_ stableKey: String?) -> String? {
    guard
        let stableKey,
        canonicalStableKeyJSON(stableKey),
        let data = stableKey.data(using: .utf8),
        let pairs = try? JSONSerialization.jsonObject(with: data) as? [[Any]],
        pairs.count == 1,
        pairs[0].count == 2,
        pairs[0][0] as? String == "id"
    else { return nil }
    return pairs[0][1] as? String
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

/// Split the final raw segment's `;arbor-key=…;arbor-rev=…` parameter block from the path.
/// Parameters appear in that order at most once each; anything else after the first
/// `;arbor-` marker is invalid rather than path data.
private func segmentParameters(_ rawPathWithParameters: String) -> (rawPath: String, stableKey: String?, revision: String?)? {
    let segmentStart = rawPathWithParameters.lastIndex(of: "/").map { rawPathWithParameters.index(after: $0) }
        ?? rawPathWithParameters.startIndex
    guard let marker = rawPathWithParameters[segmentStart...].range(of: parameterMarker) else {
        return (rawPathWithParameters, nil, nil)
    }
    var stableKey: String?
    var revision: String?
    var stage = 0
    let block = rawPathWithParameters[rawPathWithParameters.index(after: marker.lowerBound)...]
    for parameter in block.split(separator: ";", omittingEmptySubsequences: false) {
        let (name, value) = splitOnce(String(parameter), separator: "=")
        guard let value, !value.isEmpty else { return nil }
        if name == "arbor-key", stage == 0 {
            guard let decoded = decodeStableKey(value) else { return nil }
            stableKey = decoded
            stage = 1
        } else if name == "arbor-rev", stage <= 1, value.range(of: revisionPattern, options: .regularExpression) != nil {
            revision = value
            stage = 2
        } else {
            return nil
        }
    }
    return (String(rawPathWithParameters[..<marker.lowerBound]), stableKey, revision)
}

private func locatorState(destination: String, fragment: String?) -> (rawPath: String, locator: ResolvedLocatorState)? {
    let (rawPathWithParameters, applicationQuery) = splitOnce(destination, separator: "?")
    guard let (rawPath, pathStableKey, revision) = segmentParameters(rawPathWithParameters) else { return nil }

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
            revision: revision,
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

private func parseArborURL(_ href: String) -> ResolvedLink? {
    let withoutScheme = String(href.dropFirst("arbor://".count))
    let (destination, fragment) = splitOnce(withoutScheme, separator: "#")
    guard let parsed = locatorState(destination: destination, fragment: fragment) else { return nil }
    var parts = parsed.rawPath.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
    guard let authorityPart = parts.first, !authorityPart.isEmpty else { return nil }
    parts.removeFirst()
    // `_` cannot occur in a DNS label, so a `tr_` authority is a TreeID and nothing else.
    let isTreeID = authorityPart.range(of: treeIDAuthorityPattern, options: .regularExpression) != nil
    if authorityPart.hasPrefix("tr_"), !isTreeID { return nil }
    let authority: ArborAuthority = isTreeID ? .treeID(authorityPart) : .dns(authorityPart)
    guard let path = resolveTreePath(base: "/", rawDestination: parts.joined(separator: "/")) else { return nil }
    return .arbor(authority: authority, path: path, locator: parsed.locator)
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
    revision: String? = nil,
    applicationQuery: String? = nil,
    contentFragment: String? = nil
) -> String? {
    var result = rawPath
    if let stableKey {
        guard let encoded = encodeStableKey(stableKey) else { return nil }
        result += ";arbor-key=\(encoded)"
    }
    if let revision { result += ";arbor-rev=\(revision)" }
    result += querySuffix(applicationQuery)
    if let contentFragment { result += "#\(contentFragment)" }
    return result
}

public func buildArborLocator(tree: String, path: String, stableKey: String? = nil) -> String? {
    guard let locator = buildNetworkLocator(rawPath: canonicalNodePath(path), stableKey: stableKey) else { return nil }
    return "arbor://\(tree)\(locator)"
}

/// A markdown href that names a node, with the tree it names it in.
/// `tree` is nil when the href is relative to the document that contains it.
public struct ResolvedNodeTarget: Sendable, Equatable, Codable {
    public var tree: String?
    public var path: String
    public var stableKey: String?
    public var legacyPageID: String?

    public init(tree: String? = nil, path: String, stableKey: String? = nil, legacyPageID: String? = nil) {
        self.tree = tree
        self.path = path
        self.stableKey = stableKey
        self.legacyPageID = legacyPageID
    }
}

/// Document links were written as `arbor://<tree>/node/<path>?stableKey=<canonical JSON>` before the
/// locator grammar settled. Read that shape back so existing content still resolves; the `?stableKey=`
/// query is the signature, since canonical locators carry `;arbor-key=` instead and never that query.
private func legacyNodeRoute(path: String, locator: ResolvedLocatorState) -> (path: String, stableKey: String)? {
    guard path == "/node" || path.hasPrefix("/node/"),
          locator.stableKey == nil,
          let query = locator.applicationQuery
    else { return nil }
    for parameter in query.split(separator: "&") {
        let (name, rawValue) = splitOnce(String(parameter), separator: "=")
        guard name == "stableKey",
              let decoded = rawValue?.removingPercentEncoding,
              canonicalStableKeyJSON(decoded)
        else { continue }
        let stripped = String(path.dropFirst("/node".count))
        return (stripped.isEmpty ? "/" : canonicalNodePath(stripped), decoded)
    }
    return nil
}

/// Resolve a markdown href to the node it points at, accepting both relative hrefs and `arbor://`
/// locators. Returns nil for anything that does not name a node: external, system and overlay URLs,
/// bare `#fragment` anchors, and `arbor://` URLs on a DNS authority (those name another workspace,
/// not a node this tree can resolve).
public func resolveNodeTarget(base: String, href: String) -> ResolvedNodeTarget? {
    switch resolveLogicalURL(base: base, href: href) {
    case let .local(path, locator):
        return ResolvedNodeTarget(
            path: path,
            stableKey: locator.stableKey,
            legacyPageID: locator.legacyStableKeyCandidate
        )
    case let .arbor(authority, path, locator):
        guard case let .treeID(tree) = authority else { return nil }
        guard let legacy = legacyNodeRoute(path: path, locator: locator) else {
            return ResolvedNodeTarget(
                tree: tree,
                path: path,
                stableKey: locator.stableKey,
                legacyPageID: locator.legacyStableKeyCandidate
            )
        }
        return ResolvedNodeTarget(tree: tree, path: legacy.path, stableKey: legacy.stableKey)
    default:
        return nil
    }
}

/// Rewrite a node link's readable path, retaining all locator state. Handles relative hrefs and
/// `arbor://` locators alike, so a rename does not leave an `arbor://` link naming the old path.
public func rewriteLocalLinkPath(base: String, href: String, newPath: String) -> String? {
    let resolved = resolveLogicalURL(base: base, href: href)
    if case let .arbor(authority, path, locator) = resolved {
        guard case let .treeID(tree) = authority else { return nil }
        let stableKey = legacyNodeRoute(path: path, locator: locator)?.stableKey ?? locator.stableKey
        return buildArborLocator(tree: tree, path: newPath, stableKey: stableKey)
    }
    guard case let .local(_, locator) = resolved else { return nil }
    let relativePath = relativeLogicalReference(from: base, to: newPath)
    if locator.revision != nil || (locator.stableKey != nil && locator.contentFragment != nil) {
        return buildNetworkLocator(
            rawPath: relativePath,
            stableKey: locator.stableKey,
            revision: locator.revision,
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
