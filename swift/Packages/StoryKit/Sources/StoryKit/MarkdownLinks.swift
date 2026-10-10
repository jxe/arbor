import Foundation

/// An inline link or image destination in a Markdown source.
public struct MarkdownLinkDestination: Sendable, Equatable {
    public var href: String
    /// The range of `href` within the source.
    public var range: Range<String.Index>
    public var image: Bool
}

private let destinationExpression = try! NSRegularExpression(pattern: #"(!?)\[[^\]]*\]\(([^)]+)\)"#)

/// Every inline link and image destination in a Markdown source, in order.
public func markdownLinkDestinations(in source: String) -> [MarkdownLinkDestination] {
    destinationExpression.matches(in: source, range: NSRange(source.startIndex..., in: source)).compactMap { match in
        guard let range = Range(match.range(at: 2), in: source) else { return nil }
        return MarkdownLinkDestination(href: String(source[range]), range: range, image: match.range(at: 1).length > 0)
    }
}

/// Rewrite every same-tree link in a Markdown source whose target is known to exactly what a writer
/// at `writeFrom` emits for it now, adding the target's key when the link had none, and change
/// nothing but those hrefs. Used when a source moves or changes body form (its links' base moves)
/// and when a target moves (its readable path goes stale).
///
/// - Parameters:
///   - resolveFrom: the directory the source file was in when its links were written.
///   - writeFrom: the directory the source file is in now.
///   - tree: the source's tree; its `overstory://<tree>/…` links are same-tree links and become relative.
///   - target: the node a link names now, looked up by its stable key first and then by its
///     resolved path, with that node's own key; nil leaves the link as written.
public func healMarkdownLinks(
    _ source: String,
    resolveFrom: String,
    writeFrom: String,
    tree: String?,
    target: (_ path: String, _ stableKey: String?) -> MarkdownLinkTarget?
) -> String {
    let edits = markdownLinkHealingEdits(source, resolveFrom: resolveFrom, writeFrom: writeFrom, tree: tree, target: target)
    return (try? WorkspaceDocumentPatch(baseContentRevision: "", edits: edits).applying(to: source)) ?? source
}

/// The edits `healMarkdownLinks` makes, one per rewritten href in source order, each replacing only
/// that href (UTF-8 offsets, with the href it expects). A writer admits these rather than the whole
/// healed source, so a concurrent edit elsewhere in the page does not overlap the healing.
public func markdownLinkHealingEdits(
    _ source: String,
    resolveFrom: String,
    writeFrom: String,
    tree: String?,
    target: (_ path: String, _ stableKey: String?) -> MarkdownLinkTarget?
) -> [WorkspaceSourceEdit] {
    markdownLinkDestinations(in: source).compactMap { destination in
        guard
            let replacement = healedHref(destination.href, resolveFrom: resolveFrom, writeFrom: writeFrom, tree: tree, target: target),
            replacement != destination.href
        else { return nil }
        let start = source.utf8.distance(from: source.startIndex, to: destination.range.lowerBound)
        return WorkspaceSourceEdit(utf8Range: start..<(start + destination.href.utf8.count), replacement: replacement, expected: destination.href)
    }
}

private func healedHref(
    _ href: String,
    resolveFrom: String,
    writeFrom: String,
    tree: String?,
    target: (_ path: String, _ stableKey: String?) -> MarkdownLinkTarget?
) -> String? {
    let path: String
    let locator: ResolvedLocatorState
    switch resolveLogicalURL(sourceDirectory: resolveFrom, href: href) {
    case let .overstory(.treeID(treeID), resolvedPath, resolvedLocator) where treeID == tree:
        (path, locator) = (resolvedPath, resolvedLocator)
    case let .local(resolvedPath, resolvedLocator):
        (path, locator) = (resolvedPath, resolvedLocator)
    default:
        return nil
    }
    guard let node = target(path, locator.stableKey) else { return nil }
    return buildMarkdownLink(from: writeFrom, to: MarkdownLinkTarget(
        path: node.path,
        body: node.body,
        stableKey: locator.stableKey ?? node.stableKey,
        revision: locator.revision,
        applicationQuery: locator.applicationQuery,
        contentFragment: locator.contentFragment
    ))
}
