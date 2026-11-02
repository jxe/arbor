import Overstory
import Foundation

/// The working tree's state as protocol objects. Encoding is `ProtocolObjectCodec`'s.
enum WorkingTreeProtocolCodec {
    /// With `memo`, a Markdown entry or directory that is the same as in the
    /// last snapshot built with it is not encoded or hashed again. Sources
    /// that have not changed are usually the same string storage, so the
    /// comparison is immediate.
    static func snapshot(for state: WorkingTreeState, memo: WorkingTreeSnapshotMemo? = nil) throws -> WorkingTreeSnapshot {
        let active = state.nodes.filter { $0.path != "/Trash" && !$0.path.hasPrefix("/Trash/") }
        guard active.contains(where: { $0.path == "/" && $0.kind == .directory }) else {
            throw WorkingTreeError.corruptState("Replica root directory is missing")
        }
        let paths = active.map(\.path)
        guard Set(paths).count == paths.count else {
            throw WorkingTreeError.corruptState("Duplicate logical path")
        }
        let byPath = Dictionary(uniqueKeysWithValues: active.map { ($0.path, $0) })
        var childrenByParent: [String: [WorkingTreeNode]] = [:]
        for node in active {
            if let parent = WorkingTreeSemantics.parent(of: node.path) { childrenByParent[parent, default: []].append(node) }
        }
        var objects: [String: Data?] = [:]

        func store(_ bytes: Data) -> String {
            let hash = ProtocolObjectCodec.hash(bytes)
            objects[hash] = bytes
            return hash
        }

        /// Markdown is a page entry once the tree holds pages (directory format §3).
        let pages = state.pages == true
        func markdown(_ name: String, _ bytes: Data) -> ProtocolDirectoryEntry {
            ProtocolDirectoryEntry.markdown(name: name, bytes: bytes, pages: pages, store: store)
        }
        var markdownMemo: [String: WorkingTreeSnapshotMemo.Markdown] = [:]
        var directoryMemo: [String: WorkingTreeSnapshotMemo.Directory] = [:]
        let previous = memo?.load()
        /// The entry for Markdown `source` named `name` in the directory at `parent`.
        func markdown(_ name: String, source: String, in parent: String) -> ProtocolDirectoryEntry {
            guard memo != nil else { return markdown(name, Data(source.utf8)) }
            let key = WorkingTreeSemantics.child(name, of: parent)
            if let known = previous?.markdown[key], known.pages == pages, known.source == source {
                objects[known.hash] = known.bytes
                markdownMemo[key] = known
                return known.entry
            }
            var stored: (hash: String, bytes: Data)?
            let entry = ProtocolDirectoryEntry.markdown(name: name, bytes: Data(source.utf8), pages: pages) { bytes in
                let hash = store(bytes)
                stored = (hash, bytes)
                return hash
            }
            if let stored { markdownMemo[key] = .init(source: source, pages: pages, entry: entry, hash: stored.hash, bytes: stored.bytes) }
            return entry
        }

        func reference(_ ref: ContentRef?) -> String {
            switch ref {
            case let .inline(bytes)?: return store(bytes)
            case let .hash(hash, _, _)?:
                if objects[hash] == nil { objects[hash] = .some(nil) }
                return hash
            case nil: return store(Data())
            }
        }

        func buildDirectory(at path: String) throws -> String {
            guard let node = byPath[path], node.kind == .directory else {
                throw WorkingTreeError.corruptState("Missing directory at \(path)")
            }
            if path == "/", node.directoryBodyPlacement != nil || node.shadowedSiblingMarkdownSource != nil {
                throw WorkingTreeError.corruptState("Replica root body must use _index.md")
            }
            if node.directoryBodyPlacement == .siblingMarkdown {
                guard node.source != nil, node.shadowedSiblingMarkdownSource == nil else {
                    throw WorkingTreeError.corruptState("Malformed sibling Markdown directory body")
                }
            } else if node.shadowedSiblingMarkdownSource != nil, node.source == nil {
                throw WorkingTreeError.corruptState("Shadowed sibling Markdown has no _index.md body")
            }
            var entries: [ProtocolDirectoryEntry] = []
            if let source = node.source, node.directoryBodyPlacement != .siblingMarkdown {
                entries.append(markdown("_index.md", source: source, in: path))
            }
            let children = (childrenByParent[path] ?? [])
                .sorted { WorkingTreeSemantics.compareUTF8(WorkingTreeSemantics.name(of: $0.path), WorkingTreeSemantics.name(of: $1.path)) }
            for child in children {
                let name = WorkingTreeSemantics.name(of: child.path)
                switch child.kind {
                case .directory:
                    entries.append(ProtocolDirectoryEntry(name: name, directory: try buildDirectory(at: child.path)))
                    if child.directoryBodyPlacement == .siblingMarkdown, let source = child.source {
                        entries.append(markdown(name + ".md", source: source, in: path))
                    } else if let shadowed = child.shadowedSiblingMarkdownSource {
                        entries.append(markdown(name + ".md", source: shadowed, in: path))
                    }
                case .markdown:
                    entries.append(markdown(name + ".md", source: child.source ?? "", in: path))
                case .file:
                    if case let .inline(bytes)? = child.ref, ProtocolPage.isPageName(name) {
                        entries.append(markdown(name, bytes))
                    } else {
                        entries.append(ProtocolDirectoryEntry(name: name, file: reference(child.ref)))
                    }
                case .boundary:
                    guard let tree = child.boundaryTree, !tree.isEmpty else {
                        throw WorkingTreeError.corruptState("Nested tree boundary is empty")
                    }
                    entries.append(ProtocolDirectoryEntry(name: name, tree: tree))
                }
            }
            entries.sort { WorkingTreeSemantics.compareUTF8($0.name, $1.name) }
            for hash in node.collectionObjects ?? [] where objects[hash] == nil { objects[hash] = .some(nil) }
            guard memo != nil else { return store(ProtocolObjectCodec.directoryBytes(entries, collection: node.collection)) }
            if let known = previous?.directories[path], known.collection == node.collection, known.entries == entries {
                objects[known.hash] = known.bytes
                directoryMemo[path] = known
                return known.hash
            }
            let bytes = ProtocolObjectCodec.directoryBytes(entries, collection: node.collection)
            let hash = store(bytes)
            directoryMemo[path] = .init(entries: entries, collection: node.collection, hash: hash, bytes: bytes)
            return hash
        }

        let root = try buildDirectory(at: "/")
        // Only what this snapshot holds is kept, so removed pages are forgotten.
        memo?.store(.init(markdown: markdownMemo, directories: directoryMemo))
        return WorkingTreeSnapshot(
            root: root,
            objects: objects.map { WorkingTreeStoredObject(hash: $0.key, bytes: $0.value) }.sorted { $0.hash < $1.hash }
        )
    }
}

/// What `WorkingTreeProtocolCodec.snapshot(for:memo:)` built last time, by
/// path. One per working tree.
final class WorkingTreeSnapshotMemo: @unchecked Sendable {
    struct Markdown {
        var source: String
        var pages: Bool
        var entry: ProtocolDirectoryEntry
        var hash: String
        var bytes: Data
    }
    struct Directory {
        var entries: [ProtocolDirectoryEntry]
        var collection: ProtocolCollectionReference?
        var hash: String
        var bytes: Data
    }
    struct Contents {
        var markdown: [String: Markdown] = [:]
        var directories: [String: Directory] = [:]
    }
    private let lock = NSLock()
    private var contents = Contents()

    func load() -> Contents { lock.withLock { contents } }
    func store(_ next: Contents) { lock.withLock { contents = next } }
}
