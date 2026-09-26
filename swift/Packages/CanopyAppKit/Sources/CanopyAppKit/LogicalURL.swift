import Foundation

public struct ResolvedLocatorState: Sendable, Equatable {
    /// `;arbor-config`: the locator names the configuration of the tree whose root it names.
    public var configuration = false
    public var stableKey: String?
    public var revision: String?
    public var applicationQuery: String?
    public var contentFragment: String?

    public init(stableKey: String? = nil, revision: String? = nil, applicationQuery: String? = nil, contentFragment: String? = nil) {
        self.stableKey = stableKey
        self.revision = revision
        self.applicationQuery = applicationQuery
        self.contentFragment = contentFragment
    }
}

public enum ResolvedLink: Sendable, Equatable {
    case local(path: String, locator: ResolvedLocatorState)
    case arbor(authority: ArborAuthority, path: String, locator: ResolvedLocatorState)
    case system(raw: String)
    case overlay(raw: String)
    case external(href: String)
    case fragment(contentFragment: String)
}

public enum ArborAuthority: Sendable, Equatable {
    case dns(String)
    case treeID(String)
}

private let schemeExpression = try! NSRegularExpression(pattern: "^([a-zA-Z][a-zA-Z0-9+.-]*):")
private let parameterMarker = ";arbor-"
private let revisionPattern = #"^sha256:[a-f0-9]{64}$"#
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

/// Serialize `[field, value]` pairs with the same writer `canonicalStableKeyJSON` re-serializes
/// with, so a key this writes is canonical by construction rather than by a second encoder agreeing.
func stableKeyJSON(_ pairs: [[Any]]) throws -> String {
    String(decoding: try JSONSerialization.data(withJSONObject: pairs, options: [.withoutEscapingSlashes]), as: UTF8.self)
}

public func canonicalStableKey(_ pairs: [(String, JSONValue)]) throws -> String {
    guard !pairs.isEmpty else { throw EncodingError.invalidValue(pairs, .init(codingPath: [], debugDescription: "stable key must be nonempty")) }
    var elements: [[Any]] = []
    for (property, value) in pairs {
        guard !property.isEmpty else {
            throw EncodingError.invalidValue(property, .init(codingPath: [], debugDescription: "stable-key property must be nonempty"))
        }
        switch value {
        case let .string(string): elements.append([property, string])
        case let .bool(bool): elements.append([property, bool])
        case let .number(number) where number.isFinite: elements.append([property, number])
        default:
            throw EncodingError.invalidValue(value, .init(codingPath: [], debugDescription: "stable-key value must be a non-null scalar"))
        }
    }
    let result = try stableKeyJSON(elements)
    guard canonicalStableKeyJSON(result) else {
        throw EncodingError.invalidValue(pairs, .init(codingPath: [], debugDescription: "stable key is not canonical JSON"))
    }
    return result
}

private let unreservedBytes: Set<UInt8> = Set(
    Array(UInt8(ascii: "A")...UInt8(ascii: "Z")) + Array(UInt8(ascii: "a")...UInt8(ascii: "z"))
        + Array(UInt8(ascii: "0")...UInt8(ascii: "9")) + [UInt8(ascii: "-"), UInt8(ascii: "."), UInt8(ascii: "_"), UInt8(ascii: "~")]
)

/// Every UTF-8 byte outside the URI unreserved set as uppercase `%XX`. This is also JavaScript's
/// `encodeURIComponent` with `!'()*` encoded, which is how a link path segment is written.
func percentEncodeUnreserved(_ value: String) -> String {
    var encoded = ""
    for byte in value.utf8 {
        if unreservedBytes.contains(byte) {
            encoded.unicodeScalars.append(Unicode.Scalar(byte))
        } else {
            encoded += String(format: "%%%02X", byte)
        }
    }
    return encoded
}

private func percentDecodeToken(_ value: String) -> String? {
    var index = value.startIndex
    while let percent = value[index...].firstIndex(of: "%") {
        let digits = value[value.index(after: percent)...].prefix(2)
        guard digits.count == 2, digits.allSatisfy({ ("0"..."9").contains($0) || ("A"..."F").contains($0) }) else { return nil }
        index = digits.endIndex
    }
    return value.removingPercentEncoding
}

private func isJSONBoolean(_ value: Any) -> Bool {
    guard let number = value as? NSNumber else { return false }
    return CFGetTypeID(number) == CFBooleanGetTypeID()
}

/// The readable key token carried by `;arbor-key=` and `#arbor-key=`: each pair as `name:value`
/// for a string or `name=literal` for a number or boolean, joined by `,`, with every byte outside
/// the URI unreserved set percent-encoded. `[["id","h31mlm"]]` is `id:h31mlm`.
public func encodeStableKey(_ value: String) -> String? {
    guard
        canonicalStableKeyJSON(value),
        let pairs = (try? JSONSerialization.jsonObject(with: Data(value.utf8))) as? [[Any]]
    else { return nil }
    var parts: [String] = []
    for pair in pairs {
        guard let name = pair[0] as? String else { return nil }
        if !isJSONBoolean(pair[1]), let string = pair[1] as? String {
            parts.append("\(percentEncodeUnreserved(name)):\(percentEncodeUnreserved(string))")
        } else {
            // The same writer as the canonical key JSON, so the literal is its RFC 8785 text.
            guard let literal = try? JSONSerialization.data(withJSONObject: pair[1], options: [.fragmentsAllowed]) else { return nil }
            parts.append("\(percentEncodeUnreserved(name))=\(String(decoding: literal, as: UTF8.self))")
        }
    }
    return parts.joined(separator: ",")
}

/// Decode a key token, accepting only the exact spelling `encodeStableKey` writes.
public func decodeStableKey(_ token: String) -> String? {
    guard !token.isEmpty else { return nil }
    var pairs: [[Any]] = []
    for part in token.split(separator: ",", omittingEmptySubsequences: false) {
        guard let separator = part.firstIndex(where: { $0 == ":" || $0 == "=" }), separator > part.startIndex,
              let name = percentDecodeToken(String(part[..<separator]))
        else { return nil }
        let raw = String(part[part.index(after: separator)...])
        if part[separator] == ":" {
            guard let scalar = percentDecodeToken(raw) else { return nil }
            pairs.append([name, scalar])
            continue
        }
        if raw == "true" || raw == "false" {
            pairs.append([name, raw == "true"])
            continue
        }
        guard
            let literal = try? JSONSerialization.jsonObject(with: Data(raw.utf8), options: [.fragmentsAllowed]),
            let number = literal as? NSNumber, !isJSONBoolean(number), number.doubleValue.isFinite
        else { return nil }
        pairs.append([name, number])
    }
    guard
        let key = try? stableKeyJSON(pairs),
        canonicalStableKeyJSON(key),
        encodeStableKey(key) == token
    else { return nil }
    return key
}

/// Split the final raw segment's `;arbor-key=…;arbor-rev=…` parameter block from the path.
/// Parameters appear in that order at most once each; anything else after the first
/// `;arbor-` marker is invalid rather than path data. `;arbor-config` takes no value
/// and stands alone.
private func segmentParameters(_ rawPathWithParameters: String) -> (rawPath: String, stableKey: String?, revision: String?, configuration: Bool)? {
    let segmentStart = rawPathWithParameters.lastIndex(of: "/").map { rawPathWithParameters.index(after: $0) }
        ?? rawPathWithParameters.startIndex
    guard let marker = rawPathWithParameters[segmentStart...].range(of: parameterMarker) else {
        return (rawPathWithParameters, nil, nil, false)
    }
    if rawPathWithParameters[rawPathWithParameters.index(after: marker.lowerBound)...] == "arbor-config" {
        return (String(rawPathWithParameters[..<marker.lowerBound]), nil, nil, true)
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
    return (String(rawPathWithParameters[..<marker.lowerBound]), stableKey, revision, false)
}

private func locatorState(destination: String, fragment: String?) -> (rawPath: String, locator: ResolvedLocatorState)? {
    let (rawPathWithParameters, applicationQuery) = splitOnce(destination, separator: "?")
    guard let (rawPath, pathStableKey, revision, configuration) = segmentParameters(rawPathWithParameters) else { return nil }
    // A configuration is addressed as a whole: no key, fragment or query goes with it.
    if configuration, fragment != nil || applicationQuery != nil { return nil }

    var markdownStableKey: String?
    if let fragment, fragment.hasPrefix(markdownKeyPrefix) {
        guard let decoded = decodeStableKey(String(fragment.dropFirst(markdownKeyPrefix.count))) else { return nil }
        markdownStableKey = decoded
    }
    guard pathStableKey == nil || markdownStableKey == nil else { return nil }
    let ordinaryFragment = markdownStableKey == nil && !(fragment?.isEmpty ?? true) ? fragment : nil
    var state = ResolvedLocatorState(
        stableKey: pathStableKey ?? markdownStableKey,
        revision: revision,
        applicationQuery: applicationQuery,
        contentFragment: ordinaryFragment
    )
    state.configuration = configuration
    return (rawPath, state)
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

/// Decode each raw path component exactly once and resolve dot segments.
private func resolveTreePath(sourceDirectory: String, rawDestination: String) -> String? {
    var stack: [String]
    if rawDestination.hasPrefix("/") {
        stack = []
    } else {
        guard let base = canonicalDecodedNodePath(sourceDirectory) else { return nil }
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
    let isTreeID = TreeID.isWellFormed(authorityPart)
    if authorityPart.hasPrefix("tr_"), !isTreeID { return nil }
    let authority: ArborAuthority = isTreeID ? .treeID(authorityPart) : .dns(authorityPart)
    guard let path = resolveTreePath(sourceDirectory: "/", rawDestination: parts.joined(separator: "/")) else { return nil }
    // `arbor://<TreeID>;arbor-config` names the tree's root; any other path is invalid.
    if parsed.locator.configuration, isTreeID, path != "/" { return nil }
    return .arbor(authority: authority, path: path, locator: parsed.locator)
}

/// Resolve an href found in a Markdown source. A relative href resolves against `sourceDirectory`,
/// the tree directory holding the source file (see `markdownSourceDirectory`), exactly as an
/// ordinary Markdown reader resolves it. `x.md`, `x/_index.md`, `x/` and `x` all name the node `x`.
public func resolveLogicalURL(sourceDirectory: String, href: String) -> ResolvedLink? {
    let raw = href.trimmingCharacters(in: .whitespacesAndNewlines)
    if raw.isEmpty { return nil }
    if raw.hasPrefix("#") {
        let fragment = String(raw.dropFirst())
        guard !fragment.isEmpty, !fragment.hasPrefix(markdownKeyPrefix) else { return nil }
        return .fragment(contentFragment: fragment)
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
        let path = resolveTreePath(sourceDirectory: sourceDirectory, rawDestination: parsed.rawPath)
    else { return nil }
    return .local(path: path, locator: parsed.locator)
}

/// Where a node's Markdown body lives. A `sibling` body is `x.md` beside the (possibly absent)
/// directory `x/`, which includes every leaf document; an `index` body is `x/_index.md`. `nil` is a
/// node with no stored body.
public enum MarkdownBodyOrigin: String, Codable, Sendable, Hashable {
    case sibling
    case index
}

/// The tree directory holding a node's body file, against which its relative links resolve.
public func markdownSourceDirectory(nodePath: String, body: MarkdownBodyOrigin?) -> String {
    let path = canonicalNodePath(nodePath)
    guard body == .sibling, path != "/" else { return path }
    let parent = String(path[..<path.lastIndex(of: "/")!])
    return parent.isEmpty ? "/" : parent
}

/// The file a Markdown link names for a node: its body file, or its logical path when it has none.
public func markdownLinkFile(nodePath: String, body: MarkdownBodyOrigin?) -> String {
    let path = canonicalNodePath(nodePath)
    switch body {
    case nil: return path
    case .sibling where path != "/": return "\(path).md"
    default: return path == "/" ? "/_index.md" : "\(path)/_index.md"
    }
}

/// A relative reference from a source directory to a tree file or node, one encoded segment at a
/// time. Logical paths are already decoded: `%` is data here.
public func relativeFileReference(from sourceDirectory: String, toFile targetFile: String) -> String {
    let from = canonicalNodePath(sourceDirectory).split(separator: "/").map(String.init)
    let to = targetFile.split(separator: "/").map(String.init)
    var shared = 0
    while shared < from.count, shared < to.count, from[shared] == to[shared] { shared += 1 }
    // A node that is the source directory itself is named from its parent.
    if shared == to.count, shared > 0 { shared -= 1 }
    let segments = Array(repeating: "..", count: from.count - shared) + to.dropFirst(shared).map(percentEncodeUnreserved)
    let reference = segments.joined(separator: "/")
    return reference.isEmpty ? "." : reference
}

private func querySuffix(_ applicationQuery: String?) -> String {
    applicationQuery.map { "?\($0)" } ?? ""
}

/// A node a Markdown link names, with the locator state the link carries.
public struct MarkdownLinkTarget: Sendable, Equatable, Codable {
    public var path: String
    public var body: MarkdownBodyOrigin?
    public var stableKey: String?
    public var revision: String?
    public var applicationQuery: String?
    public var contentFragment: String?

    public init(
        path: String,
        body: MarkdownBodyOrigin?,
        stableKey: String? = nil,
        revision: String? = nil,
        applicationQuery: String? = nil,
        contentFragment: String? = nil
    ) {
        self.path = path
        self.body = body
        self.stableKey = stableKey
        self.revision = revision
        self.applicationQuery = applicationQuery
        self.contentFragment = contentFragment
    }
}

/// The href a Markdown writer emits for a node in the same tree: the target's file relative to the
/// source directory, so any Markdown reader follows it, with the stable key as the `#arbor-key=`
/// fragment. A key together with a content fragment, or a revision, needs the
/// `;arbor-key=`/`;arbor-rev=` segment form. Nil only for a key that is not canonical.
public func buildMarkdownLink(from sourceDirectory: String, to target: MarkdownLinkTarget) -> String? {
    let reference = relativeFileReference(from: sourceDirectory, toFile: markdownLinkFile(nodePath: target.path, body: target.body))
    if target.revision != nil || (target.stableKey != nil && target.contentFragment != nil) {
        return buildNetworkLocator(
            rawPath: reference,
            stableKey: target.stableKey,
            revision: target.revision,
            applicationQuery: target.applicationQuery,
            contentFragment: target.contentFragment
        )
    }
    let query = querySuffix(target.applicationQuery)
    if let stableKey = target.stableKey {
        guard let token = encodeStableKey(stableKey) else { return nil }
        return "\(reference)\(query)#\(markdownKeyPrefix)\(token)"
    }
    return target.contentFragment.map { "\(reference)\(query)#\($0)" } ?? "\(reference)\(query)"
}

/// Attach identity and revision to the final raw path segment for wire and hosted hrefs.
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

    public init(tree: String? = nil, path: String, stableKey: String? = nil) {
        self.tree = tree
        self.path = path
        self.stableKey = stableKey
    }
}

/// Resolve a markdown href to the node it points at, accepting both relative hrefs and `arbor://`
/// locators. Returns nil for anything that does not name a node: external, system and overlay URLs,
/// bare `#fragment` anchors, and `arbor://` URLs on a DNS authority (those name another workspace,
/// not a node this tree can resolve).
public func resolveNodeTarget(sourceDirectory: String, href: String) -> ResolvedNodeTarget? {
    switch resolveLogicalURL(sourceDirectory: sourceDirectory, href: href) {
    case let .local(path, locator):
        return ResolvedNodeTarget(path: path, stableKey: locator.stableKey)
    case let .arbor(.treeID(tree), path, locator):
        return ResolvedNodeTarget(tree: tree, path: path, stableKey: locator.stableKey)
    default:
        return nil
    }
}

/// Rewrite a node link to name `target` (its `path` and `body`), retaining the link's key,
/// revision, query and content fragment. A relative href is rewritten against `sourceDirectory`;
/// an `arbor://` locator stays one.
public func rewriteLocalLinkPath(sourceDirectory: String, href: String, target: MarkdownLinkTarget) -> String? {
    switch resolveLogicalURL(sourceDirectory: sourceDirectory, href: href) {
    case let .arbor(authority, _, locator):
        guard case let .treeID(tree) = authority else { return nil }
        return buildArborLocator(tree: tree, path: target.path, stableKey: locator.stableKey)
    case let .local(_, locator):
        return buildMarkdownLink(from: sourceDirectory, to: MarkdownLinkTarget(
            path: target.path,
            body: target.body,
            stableKey: locator.stableKey,
            revision: locator.revision,
            applicationQuery: locator.applicationQuery,
            contentFragment: locator.contentFragment
        ))
    default:
        return nil
    }
}
