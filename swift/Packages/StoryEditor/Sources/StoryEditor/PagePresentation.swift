import StoryKit
import Foundation
import Quagmire

/// Page presentation (directory format §4.1): what a page shows that its
/// source lacks.
///
/// The editor shows every page through `present`, which adds a title when
/// the body does not begin with an H1, and `subpages`, the children no
/// authored link names as a region after the page: shown, never edited, and
/// never part of its source. `authored` is the inverse of `present`: the
/// blocks an edited page writes. The TypeScript twin is
/// `packages/protocol/src/documents/page-presentation.ts`, and both run
/// `docs/overstory-spec/conformance/page-presentation.json`.
public enum StoryPagePresentation {
    public enum Heading: String, Sendable {
        case title
    }

    /// A node's children to place, and where its rows resolve from.
    public struct Directory {
        public var children: [WorkspaceNode]
        public var reference: WorkspaceReference
        public var sourceDirectory: String

        public init(children: [WorkspaceNode], reference: WorkspaceReference, sourceDirectory: String) {
            self.children = children
            self.reference = reference
            self.sourceDirectory = sourceDirectory
        }
    }

    public static let childrenHeading = "Subpages"
    static let headingMetadataKey = "story.presented-heading"
    /// The text the heading was presented with; any other text is an edit.
    static let textMetadataKey = "story.presented-text"

    /// The title a page presents when its body does not begin with an H1: the
    /// last segment of the node's logical path with each hyphen shown as a
    /// space. The root has no segment and presents no title.
    public static func presentedTitle(path: String) -> String? {
        path.split(separator: "/").last.map { $0.replacingOccurrences(of: "-", with: " ") }
    }

    /// Which presented heading a block is, whether or not it has been edited since.
    public static func heading(_ block: Block) -> Heading? {
        block.metadata[headingMetadataKey].flatMap(Heading.init(rawValue:))
    }

    /// A presented title as it was presented: an H1 with its presented text,
    /// which is not source.
    static func isUntouched(_ block: Block) -> Bool {
        guard heading(block) != nil, case let .heading(.h1, text) = block.kind else { return false }
        return String(text.characters) == block.metadata[textMetadataKey]
    }

    /// Present authored blocks, or a presented tree the reader has edited, as
    /// the page for the node at `path`.
    public static func present(_ blocks: [Block], path: String) -> [Block] {
        var result = authored(blocks)
        guard let title = presentedTitle(path: path), !beginsWithTitle(result) else { return result }
        var used = Set<BlockID>()
        func collect(_ values: [Block]) { for block in values { used.insert(block.id); collect(block.children) } }
        collect(result)
        // The title owns what an authored first H1 would: everything up to the next H1.
        let end = result.firstIndex { if case .heading(.h1, _) = $0.kind { true } else { false } } ?? result.count
        let block = Block(
            id: unusedID("title", in: &used),
            kind: .heading(level: .h1, text: AttributedString(title)),
            children: Array(result[..<end]),
            metadata: [headingMetadataKey: Heading.title.rawValue, textMetadataKey: title])
        result.replaceSubrange(..<end, with: [block])
        return result
    }

    /// The page's Subpages: its children no link in `blocks` names, as a
    /// region after the page. Nil when every child is linked.
    public static func subpages(_ directory: Directory, of blocks: [Block], path: String) -> DocumentRegion? {
        let remainder = StoryMarkdownCodec.placeDirectoryChildren(
            directory.children, in: authored(blocks), directory: directory.reference, sourceDirectory: directory.sourceDirectory
        ).remainder
        guard !remainder.isEmpty else { return nil }
        return DocumentRegion(
            id: StoryMarkdownCodec.digestID("story-subpages:\(path)"),
            title: AttributedString(childrenHeading),
            blocks: remainder)
    }

    /// Whether `block` links one of the directory's own children, so dropped
    /// on the Subpages it is unlinked: the child returns to them.
    public static func linksChild(_ block: Block, of directory: Directory) -> Bool {
        guard case .documentLink = block.kind, block.children.isEmpty else { return false }
        return StoryMarkdownCodec.placeDirectoryChildren(
            directory.children, in: [block], directory: directory.reference, sourceDirectory: directory.sourceDirectory
        ).remainder.count < directory.children.count
    }

    /// The authored blocks of a presented page: the inverse of `present`,
    /// whose result serializes to the page's source.
    ///
    /// A presented title the reader left alone is not source; what stands
    /// under it is written where the title stood. An edited title (new text,
    /// or another kind of block) is written as it reads.
    public static func authored(_ blocks: [Block]) -> [Block] {
        func plain(_ block: Block, children: [Block]) -> Block {
            var value = block
            value.children = children
            value.metadata.removeValue(forKey: headingMetadataKey)
            value.metadata.removeValue(forKey: textMetadataKey)
            return value
        }
        func walk(_ values: [Block]) -> [Block] {
            values.flatMap { block -> [Block] in
                let children = walk(block.children)
                switch heading(block) {
                case nil:
                    var value = block
                    value.children = children
                    return [value]
                case .title:
                    return isUntouched(block) ? children : [plain(block, children: children)]
                }
            }
        }
        return walk(blocks)
    }

    /// A selection as another page receives it: only authored source. An
    /// untouched presented title (named by its mark in `document`) gives way
    /// to what stands under it.
    static func transferable(_ roots: [Block], in document: [Block]) -> [Block] {
        transferable(roots, matching: roots, in: document)
    }

    /// `transferable(originals, in:)` applied to `blocks`, which have the
    /// originals' shape but possibly other identities (copies).
    static func transferable(_ blocks: [Block], matching originals: [Block], in document: [Block]) -> [Block] {
        var untouched = Set<BlockID>()
        func collect(_ values: [Block]) {
            for block in values {
                if isUntouched(block) { untouched.insert(block.id) }
                collect(block.children)
            }
        }
        collect(document)
        func walk(_ values: [Block], _ sources: [Block]) -> [Block] {
            zip(values, sources).flatMap { block, source -> [Block] in
                if untouched.contains(source.id) { return walk(block.children, source.children) }
                var value = block
                value.children = walk(block.children, source.children)
                return [value]
            }
        }
        return walk(blocks, originals)
    }

    /// Where a block appended to the page's authored source stands in a
    /// presented tree: under the presented title when that is all there is.
    static func endOfBody(in blocks: [Block]) -> DropPath {
        if blocks.count == 1, let title = blocks.first, heading(title) == .title, isUntouched(title) {
            return DropPath(parent: title.id, position: title.children.count)
        }
        return DropPath(parent: nil, position: blocks.count)
    }

    /// Whether the body's first block is an H1, which is then the page's authored title.
    static func beginsWithTitle(_ blocks: [Block]) -> Bool {
        if case .heading(.h1, _)? = blocks.first?.kind { true } else { false }
    }

    /// A deterministic identity no block of the tree holds, so presenting the
    /// same tree twice names its headings the same way.
    private static func unusedID(_ name: String, in used: inout Set<BlockID>) -> BlockID {
        var ordinal = 0
        while true {
            let id = StoryMarkdownCodec.digestID("story-presented-\(name):\(ordinal)")
            if used.insert(id).inserted { return id }
            ordinal += 1
        }
    }
}
