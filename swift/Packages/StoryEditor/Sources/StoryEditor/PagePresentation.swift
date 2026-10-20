import StoryKit
import Foundation
import Quagmire

/// Page presentation (directory format §4.1): what a page shows that its
/// source lacks.
///
/// The editor shows every page through `present`, never through directory
/// placement alone. It adds a title when the body does not begin with an H1,
/// and, for a node with children whose document has no explicit marker, a
/// closing Children section holding the children no authored link names. With
/// an explicit marker those children stand at the marker and no heading is
/// added. `authored` is the inverse: the blocks an edited page writes. The
/// TypeScript twin is `packages/protocol/src/documents/page-presentation.ts`,
/// and both run `docs/overstory-spec/conformance/page-presentation.json`.
public enum StoryPagePresentation {
    public enum Heading: String, Sendable {
        case title, children
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

    public static let childrenHeading = "Children"
    static let headingMetadataKey = "story.presented-heading"
    /// The text the heading was presented with; any other text is an edit.
    static let textMetadataKey = "story.presented-text"
    /// On the parent of an explicit children marker the page does not show:
    /// the marker's source, written back before the generated children.
    static let markerMetadataKey = "story.children-marker"
    /// The hidden marker's block ID, so it is written back as the same block.
    static let markerIDMetadataKey = "story.children-marker-id"

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

    /// A presented heading as it was presented: an H1 with its presented text.
    /// A title in this state is not source. A Children heading in this state
    /// is not source either unless authored content stands under it.
    static func isUntouched(_ block: Block) -> Bool {
        guard heading(block) != nil, case let .heading(.h1, text) = block.kind else { return false }
        return String(text.characters) == block.metadata[textMetadataKey]
    }

    /// Present authored blocks, or a presented tree the reader has edited, as
    /// the page for the node at `path`.
    public static func present(_ blocks: [Block], path: String, directory: Directory?) -> [Block] {
        var result = authored(blocks)
        var remainder: [Block] = []
        if let directory {
            let placement = StoryMarkdownCodec.placeDirectoryChildren(
                directory.children, in: result, directory: directory.reference, sourceDirectory: directory.sourceDirectory)
            result = placement.blocks
            remainder = placement.remainder
        }
        var used = Set<BlockID>()
        func collect(_ values: [Block]) { for block in values { used.insert(block.id); collect(block.children) } }
        collect(result)
        collect(remainder)

        if let title = presentedTitle(path: path), !beginsWithTitle(result) {
            // The title owns what an authored first H1 would: everything up to the next H1.
            let end = result.firstIndex { if case .heading(.h1, _) = $0.kind { true } else { false } } ?? result.count
            let block = Block(
                id: unusedID("title", in: &used),
                kind: .heading(level: .h1, text: AttributedString(title)),
                children: Array(result[..<end]),
                metadata: [headingMetadataKey: Heading.title.rawValue, textMetadataKey: title])
            result.replaceSubrange(..<end, with: [block])
        }
        if !remainder.isEmpty {
            // An H1 closes every authored section above it.
            result.append(Block(
                id: unusedID("children", in: &used),
                kind: .heading(level: .h1, text: AttributedString(childrenHeading)),
                children: remainder,
                metadata: [headingMetadataKey: Heading.children.rawValue, textMetadataKey: childrenHeading]))
        }
        return hidingChildrenMarker(result)
    }

    /// An explicit children marker is source, not something to read. Where the
    /// generated children stand right after it, it leaves the presented tree,
    /// and its parent keeps it for `authored` to write back before them. A
    /// marker no generated child follows stays shown, so it keeps its place.
    private static func hidingChildrenMarker(_ blocks: [Block]) -> [Block] {
        blocks.map { block in
            var value = block
            if let index = value.children.firstIndex(where: StoryMarkdownCodec.isChildrenMarker),
               value.children.indices.contains(index + 1),
               StoryMarkdownCodec.isProjectedChild(value.children[index + 1]),
               case let .unsupported(payload, _) = value.children[index].kind {
                value.metadata[markerMetadataKey] = payload
                value.metadata[markerIDMetadataKey] = value.children[index].id.value.uuidString
                value.children.remove(at: index)
            }
            value.children = hidingChildrenMarker(value.children)
            return value
        }
    }

    /// The authored blocks of a presented page: the inverse of `present`,
    /// whose result serializes to the page's source.
    ///
    /// A presented heading the reader left alone is not source; what stands
    /// under a title is written where the title stood. An edited title (new
    /// text, or another kind of block) is written as it reads. A renamed
    /// Children heading, or one with authored content under it, is written
    /// with its text and an explicit marker where its generated children
    /// were shown, so they stay under the now-authored heading. Generated
    /// child links are never written.
    public static func authored(_ blocks: [Block]) -> [Block] {
        var used: Set<BlockID>?
        func usedIDs() -> Set<BlockID> {
            if let used { return used }
            var ids = Set<BlockID>()
            func collect(_ values: [Block]) { for block in values { ids.insert(block.id); collect(block.children) } }
            collect(blocks)
            used = ids
            return ids
        }
        func plain(_ block: Block, children: [Block]) -> Block {
            var value = block
            value.children = children
            value.metadata.removeValue(forKey: headingMetadataKey)
            value.metadata.removeValue(forKey: textMetadataKey)
            value.metadata.removeValue(forKey: markerMetadataKey)
            value.metadata.removeValue(forKey: markerIDMetadataKey)
            return value
        }
        /// A block's authored children, with a hidden marker written back
        /// where its generated children begin.
        func authoredChildren(_ block: Block) -> [Block] {
            guard let payload = block.metadata[markerMetadataKey] else { return walk(block.children) }
            var ids = usedIDs()
            let id = block.metadata[markerIDMetadataKey].flatMap(UUID.init(uuidString:)).map { BlockID($0) }
                .flatMap { ids.contains($0) ? nil : $0 }
            let marker = Block(
                id: id ?? unusedID("children-marker", in: &ids),
                kind: .unsupported(payload: payload, display: childrenHeading))
            let generated = block.children.firstIndex(where: StoryMarkdownCodec.isProjectedChild) ?? block.children.count
            return walk(Array(block.children[..<generated])) + [marker] + walk(Array(block.children[generated...]))
        }
        func walk(_ values: [Block]) -> [Block] {
            values.flatMap { block -> [Block] in
                if StoryMarkdownCodec.isProjectedChild(block) { return [] }
                let children = authoredChildren(block)
                switch heading(block) {
                case nil:
                    var value = block
                    value.children = children
                    value.metadata.removeValue(forKey: markerMetadataKey)
                    value.metadata.removeValue(forKey: markerIDMetadataKey)
                    return [value]
                case .title:
                    return isUntouched(block) ? children : [plain(block, children: children)]
                case .children:
                    if isUntouched(block), children.isEmpty { return [] }
                    var ids = usedIDs()
                    let marker = Block(
                        id: unusedID("children-marker", in: &ids),
                        kind: .unsupported(payload: StoryMarkdownCodec.childrenMarker + "\n", display: childrenHeading))
                    let generated = block.children.firstIndex(where: StoryMarkdownCodec.isProjectedChild) ?? 0
                    let before = walk(Array(block.children[..<generated]))
                    return [plain(block, children: before + [marker] + walk(Array(block.children[generated...])))]
                }
            }
        }
        return walk(blocks)
    }

    /// A selection as another page receives it: only authored source. An
    /// untouched presented heading (named by its mark in `document`) gives
    /// way to what stands under it, and generated child links stay behind.
    static func transferable(_ roots: [Block], in document: [Block]) -> [Block] {
        var untouched = Set<BlockID>(), generated = Set<BlockID>()
        func collect(_ values: [Block], underChildren: Bool) {
            for block in values {
                if isUntouched(block) { untouched.insert(block.id) }
                if underChildren, StoryMarkdownCodec.isProjectedChild(block) { generated.insert(block.id) }
                collect(block.children, underChildren: heading(block) == .children)
            }
        }
        collect(document, underChildren: false)
        func walk(_ values: [Block]) -> [Block] {
            values.flatMap { block -> [Block] in
                if generated.contains(block.id) { return [] }
                if untouched.contains(block.id) { return walk(block.children) }
                var value = block
                value.children = walk(block.children)
                value.metadata.removeValue(forKey: markerMetadataKey)
                value.metadata.removeValue(forKey: markerIDMetadataKey)
                return [value]
            }
        }
        return walk(roots)
    }

    /// `transferable(originals, in:)` applied to `blocks`, which have the
    /// originals' shape but possibly other identities (copies).
    static func transferable(_ blocks: [Block], matching originals: [Block], in document: [Block]) -> [Block] {
        var untouched = Set<BlockID>(), generated = Set<BlockID>()
        func collect(_ values: [Block], underChildren: Bool) {
            for block in values {
                if isUntouched(block) { untouched.insert(block.id) }
                if underChildren, StoryMarkdownCodec.isProjectedChild(block) { generated.insert(block.id) }
                collect(block.children, underChildren: heading(block) == .children)
            }
        }
        collect(document, underChildren: false)
        func walk(_ values: [Block], _ sources: [Block]) -> [Block] {
            zip(values, sources).flatMap { block, source -> [Block] in
                if generated.contains(source.id) { return [] }
                if untouched.contains(source.id) { return walk(block.children, source.children) }
                var value = block
                value.children = walk(block.children, source.children)
                value.metadata.removeValue(forKey: markerMetadataKey)
                value.metadata.removeValue(forKey: markerIDMetadataKey)
                return [value]
            }
        }
        return walk(blocks, originals)
    }

    /// Where a block appended to the page's authored source stands in a
    /// presented tree: before the presented Children heading, and under the
    /// presented title when that is all that precedes it.
    static func endOfBody(in blocks: [Block]) -> DropPath {
        var roots = blocks[...]
        if let last = roots.last, heading(last) == .children, isUntouched(last) { roots = roots.dropLast() }
        if roots.count == 1, let title = roots.first, heading(title) == .title, isUntouched(title) {
            return DropPath(parent: title.id, position: title.children.count)
        }
        return DropPath(parent: nil, position: roots.count)
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
