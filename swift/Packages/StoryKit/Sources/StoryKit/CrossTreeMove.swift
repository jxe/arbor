import Foundation

/// Moving a page, with its subpages, from one tree to another (Sharing 003).
///
/// The page at `sourceRoot` in `sourceTree` becomes the page at `destinationRoot`
/// in `destinationTree`, and every node beneath it moves with it. The moved
/// pages keep their shape, so relative links among them still read the same;
/// only links that cross the boundary change:
///
/// - a moved page's link to a page that stays behind becomes an
///   `overstory://<sourceTree>/…` locator, and
/// - a staying page's link to a moved page becomes an
///   `overstory://<destinationTree>/…` locator.
///
/// Keys, application queries and content fragments are kept.
public struct CrossTreePageMove: Sendable, Equatable {
    public var sourceTree: String
    public var sourceRoot: String
    public var destinationTree: String
    public var destinationRoot: String

    public init(sourceTree: String, sourceRoot: String, destinationTree: String, destinationRoot: String) {
        self.sourceTree = sourceTree
        self.sourceRoot = canonicalNodePath(sourceRoot)
        self.destinationTree = destinationTree
        self.destinationRoot = canonicalNodePath(destinationRoot)
    }

    /// The page ID in a moved page's source. The page keeps it in the destination,
    /// where no other page may hold it.
    public static func pageID(in source: String) -> String? {
        InMemoryWorkspaceProvider.frontmatterID(in: source)
    }

    /// Whether the node at `path` in the source tree moves.
    public func moves(_ path: String) -> Bool {
        let path = canonicalNodePath(path)
        return path == sourceRoot || path.hasPrefix(sourceRoot + "/")
    }

    /// Where a moved node, or a file of one (`/A/Plan.md`, `/A/Plan/_index.md`), lands in the
    /// destination tree; nil for a path that does not move.
    public func destinationPath(of path: String) -> String? {
        // Not canonicalized: that would drop a file's `.md` / `_index.md`.
        let path = "/" + path.split(separator: "/").joined(separator: "/")
        if path == sourceRoot || path.hasPrefix(sourceRoot + "/") {
            return destinationRoot + path.dropFirst(sourceRoot.count)
        }
        // The page's own sibling body file, `/A/Plan.md` for `/A/Plan`.
        if path == sourceRoot + ".md" { return destinationRoot + ".md" }
        return nil
    }

    /// A moved page's source, as it is written in the destination: links to
    /// pages that stay behind become `overstory://<sourceTree>/…` locators.
    /// `sourceDirectory` is the directory the page's file is in, in the source tree.
    public func movedSource(_ source: String, sourceDirectory: String) -> String {
        let edits = markdownLinkDestinations(in: source).compactMap { destination -> WorkspaceSourceEdit? in
            guard let (path, locator) = sameTreeTarget(destination.href, sourceDirectory: sourceDirectory, tree: sourceTree),
                  !moves(path),
                  let replacement = Self.locator(tree: sourceTree, path: path, locator) else { return nil }
            return Self.edit(source, destination, replacement)
        }
        return (try? WorkspaceDocumentPatch(baseContentRevision: "", edits: edits).applying(to: source)) ?? source
    }

    /// The paths of the pages and files that stay behind which a moved page links to.
    public func linksLeaving(_ source: String, sourceDirectory: String) -> [String] {
        var seen = Set<String>()
        return markdownLinkDestinations(in: source).compactMap { destination in
            guard let (path, _) = sameTreeTarget(destination.href, sourceDirectory: sourceDirectory, tree: sourceTree),
                  !moves(path), seen.insert(path).inserted else { return nil }
            return path
        }
    }

    /// The edits that point a staying page's links to moved pages at their new tree,
    /// one per rewritten href (UTF-8 offsets, with the href each expects).
    public func retargetingEdits(_ source: String, sourceDirectory: String) -> [WorkspaceSourceEdit] {
        markdownLinkDestinations(in: source).compactMap { destination in
            guard let (path, locator) = sameTreeTarget(destination.href, sourceDirectory: sourceDirectory, tree: sourceTree),
                  let moved = destinationPath(of: path),
                  let replacement = Self.locator(tree: destinationTree, path: moved, locator) else { return nil }
            return Self.edit(source, destination, replacement)
        }
    }

    /// Whether `source` already links to the moved page itself.
    public func linksToRoot(_ source: String, sourceDirectory: String) -> Bool {
        markdownLinkDestinations(in: source).contains { destination in
            guard !destination.image,
                  let (path, _) = sameTreeTarget(destination.href, sourceDirectory: sourceDirectory, tree: sourceTree) else { return false }
            return path == sourceRoot
        }
    }

    /// The link left where the page was: `overstory://<destinationTree>/<destinationRoot>`.
    public var destinationLocator: String? {
        buildOverstoryLocator(tree: destinationTree, path: destinationRoot)
    }

    private func sameTreeTarget(_ href: String, sourceDirectory: String, tree: String) -> (String, ResolvedLocatorState)? {
        switch resolveLogicalURL(sourceDirectory: sourceDirectory, href: href) {
        case let .local(path, locator): return (path, locator)
        case let .overstory(.treeID(other), path, locator) where other == tree: return (path, locator)
        default: return nil
        }
    }

    private static func locator(tree: String, path: String, _ state: ResolvedLocatorState) -> String? {
        guard let suffix = buildNetworkLocator(
            rawPath: canonicalNodePath(path),
            stableKey: state.stableKey,
            applicationQuery: state.applicationQuery,
            contentFragment: state.contentFragment
        ) else { return nil }
        return "overstory://\(tree)\(suffix)"
    }

    private static func edit(_ source: String, _ destination: MarkdownLinkDestination, _ replacement: String) -> WorkspaceSourceEdit? {
        guard replacement != destination.href else { return nil }
        let start = source.utf8.distance(from: source.startIndex, to: destination.range.lowerBound)
        return WorkspaceSourceEdit(utf8Range: start..<(start + destination.href.utf8.count), replacement: replacement, expected: destination.href)
    }
}
