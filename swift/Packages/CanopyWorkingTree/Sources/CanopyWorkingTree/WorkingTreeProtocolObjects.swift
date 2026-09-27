import Overstory
import Foundation

/// The working tree's state as protocol objects. Encoding is `ProtocolObjectCodec`'s.
enum WorkingTreeProtocolCodec {
    static func snapshot(for state: WorkingTreeState) throws -> WorkingTreeSnapshot {
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
                entries.append(ProtocolDirectoryEntry(name: "_index.md", file: store(Data(source.utf8))))
            }
            let children = (childrenByParent[path] ?? [])
                .sorted { WorkingTreeSemantics.compareUTF8(WorkingTreeSemantics.name(of: $0.path), WorkingTreeSemantics.name(of: $1.path)) }
            for child in children {
                let name = WorkingTreeSemantics.name(of: child.path)
                switch child.kind {
                case .directory:
                    entries.append(ProtocolDirectoryEntry(name: name, directory: try buildDirectory(at: child.path)))
                    if child.directoryBodyPlacement == .siblingMarkdown, let source = child.source {
                        entries.append(ProtocolDirectoryEntry(name: name + ".md", file: store(Data(source.utf8))))
                    } else if let shadowed = child.shadowedSiblingMarkdownSource {
                        entries.append(ProtocolDirectoryEntry(name: name + ".md", file: store(Data(shadowed.utf8))))
                    }
                case .markdown:
                    entries.append(ProtocolDirectoryEntry(name: name + ".md", file: store(Data((child.source ?? "").utf8))))
                case .file:
                    entries.append(ProtocolDirectoryEntry(name: name, file: reference(child.ref)))
                case .boundary:
                    guard let tree = child.boundaryTree, !tree.isEmpty else {
                        throw WorkingTreeError.corruptState("Nested tree boundary is empty")
                    }
                    entries.append(ProtocolDirectoryEntry(name: name, tree: tree))
                }
            }
            entries.sort { WorkingTreeSemantics.compareUTF8($0.name, $1.name) }
            return store(ProtocolObjectCodec.directoryBytes(entries, childrenSource: node.childrenSource))
        }

        let root = try buildDirectory(at: "/")
        return WorkingTreeSnapshot(
            root: root,
            objects: objects.map { WorkingTreeStoredObject(hash: $0.key, bytes: $0.value) }.sorted { $0.hash < $1.hash }
        )
    }
}
