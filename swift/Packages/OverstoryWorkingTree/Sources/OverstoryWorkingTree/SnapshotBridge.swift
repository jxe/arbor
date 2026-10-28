import StoryKit
import Overstory
import Foundation
import UniformTypeIdentifiers

public enum SnapshotBridge {
    /// Directory references must be present in all modes; sparse file references
    /// may omit payloads, except Markdown source which must remain inline.
    public static func replacement(
        snapshot: ProtocolSnapshot,
        tree: TreeID,
        update: String,
        cursor: String? = nil,
        mode: ProtocolObjectGraph.ValidationMode = .complete,
        entryMetadata: [String: EntryMetadata] = [:],
        acceptedAt: Date? = nil
    ) throws -> WorkingTreeSystemReplacement {
        let sparse = mode == .sparseFiles
        let objects = try ProtocolObjectGraph.validate(snapshot, mode: mode)
        let bytesByHash = Dictionary(snapshot.objects.map { ($0.hash, $0.bytes) }, uniquingKeysWith: { first, _ in first })
        var nodes: [WorkingTreeSystemNode] = []
        var logicalPaths = Set<String>()

        func childPath(_ name: String, parent: String) -> String {
            parent == "/" ? "/\(name)" : "\(parent)/\(name)"
        }

        /// A file's bytes, or the file a page is written as from nothing; the
        /// working tree keeps a local spelling that reads as the same page.
        func fileBytes(_ hash: String) throws -> Data {
            switch objects[hash] {
            case let .file(bytes)?: return bytes
            case let .page(page)?: return page.canonicalFile
            default: throw ProtocolValidationError.incompleteGraph(hash)
            }
        }

        func snapshotBytes(_ hash: String) throws -> Data {
            guard let bytes = bytesByHash[hash] else { throw ProtocolValidationError.incompleteGraph(hash) }
            return bytes
        }

        func markdownSource(_ hash: String) throws -> String {
            let bytes = try fileBytes(hash)
            guard let decoded = String(data: bytes, encoding: .utf8) else {
                throw ProtocolValidationError.invalidValue("Markdown is not UTF-8")
            }
            return decoded
        }

        func appendNode(_ node: WorkingTreeSystemNode) throws {
            guard logicalPaths.insert(node.path).inserted else {
                throw ProtocolValidationError.invalidValue("Duplicate logical path \(node.path)")
            }
            var node = node
            if let entry = node.bodyEntryPath, let metadata = entryMetadata[entry] { node.metadata = metadata }
            nodes.append(node)
        }

        func visitDirectory(_ hash: String, path: String, siblingMarkdownSource: String? = nil) throws {
            guard case let .directory(entries, collection)? = objects[hash] else {
                throw ProtocolValidationError.incompleteGraph(hash)
            }
            let directoryNames = Set(entries.compactMap { entry -> String? in
                guard let hash = entry.hash, case .directory? = objects[hash] else { return nil }
                return entry.name
            })
            let siblingBodies = Dictionary(grouping: entries.compactMap { entry -> (stem: String, name: String)? in
                guard let hash = entry.hash, let object = objects[hash] else { return nil }
                switch object { case .file, .page: break; default: return nil }
                for suffix in [".md", ".mdx"] where entry.name.hasSuffix(suffix) {
                    return (String(entry.name.dropLast(suffix.count)), entry.name)
                }
                return nil
            }, by: { $0.stem })
            for (stem, bodies) in siblingBodies where directoryNames.contains(stem) && bodies.count > 1 {
                throw ProtocolValidationError.invalidValue(
                    "Duplicate body representation for \(childPath(stem, parent: path))"
                )
            }

            var indexSource: String?
            if let index = entries.first(where: { $0.name == "_index.md" }), let indexHash = index.hash {
                indexSource = try markdownSource(indexHash)
            }
            let source = indexSource ?? siblingMarkdownSource
            // A collection's tables and rows are present in every mode.
            var collectionObjects: [String: Data] = [:]
            for table in collection?.tables ?? [] {
                guard case let .table(object)? = objects[table.table] else { throw ProtocolValidationError.incompleteGraph(table.table) }
                collectionObjects[table.table] = try snapshotBytes(table.table)
                for chunk in object.chunks { collectionObjects[chunk.chunk] = try snapshotBytes(chunk.chunk) }
            }
            try appendNode(WorkingTreeSystemNode(
                path: path,
                content: .directory(source: source),
                collection: collection,
                collectionObjects: collectionObjects,
                directoryBodyPlacement: indexSource == nil && siblingMarkdownSource != nil ? .siblingMarkdown : nil,
                shadowedSiblingMarkdownSource: indexSource != nil ? siblingMarkdownSource : nil
            ))

            for entry in entries where entry.name != "_index.md" {
                let destination = childPath(entry.name, parent: path)
                if let nestedTree = entry.tree {
                    try appendNode(WorkingTreeSystemNode(path: destination, content: .boundary(tree: TreeID(rawValue: nestedTree))))
                    continue
                }
                guard let childHash = entry.hash else {
                    throw ProtocolValidationError.incompleteGraph(entry.name)
                }
                guard let object = objects[childHash] else {
                    guard sparse else { throw ProtocolValidationError.incompleteGraph(childHash) }
                    guard !entry.name.hasSuffix(".md"), entry.page == nil else {
                        throw ProtocolValidationError.incompleteGraph("Markdown \(destination) is not in the sparse snapshot")
                    }
                    try appendNode(WorkingTreeSystemNode(
                        path: destination,
                        content: .file(ref: .hash(
                            childHash,
                            size: nil,
                            mediaType: inferredMediaType(for: entry.name)
                        ))
                    ))
                    continue
                }
                switch object {
                case .directory:
                    let siblingEntry = entries.first { candidate in
                        candidate.name == entry.name + ".md" && candidate.hash != nil
                    }
                    let siblingSource: String?
                    if let siblingHash = siblingEntry?.hash {
                        siblingSource = try markdownSource(siblingHash)
                    } else {
                        siblingSource = nil
                    }
                    try visitDirectory(childHash, path: destination, siblingMarkdownSource: siblingSource)
                case .file, .page:
                    let bytes = try fileBytes(childHash)
                    if entry.name.hasSuffix(".md") {
                        let logicalName = String(entry.name.dropLast(3))
                        if directoryNames.contains(logicalName) { continue }
                        guard let decoded = String(data: bytes, encoding: .utf8) else {
                            throw ProtocolValidationError.invalidValue("Markdown is not UTF-8")
                        }
                        try appendNode(WorkingTreeSystemNode(
                            path: childPath(logicalName, parent: path),
                            content: .markdown(source: decoded)
                        ))
                    } else {
                        try appendNode(WorkingTreeSystemNode(path: destination, content: .file(ref: .inline(bytes))))
                    }
                case .table, .rows:
                    throw ProtocolValidationError.invalidValue("A directory entry names a collection object")
                }
            }
        }

        try visitDirectory(snapshot.root, path: "/")
        return WorkingTreeSystemReplacement(root: snapshot.root, update: update, cursor: cursor, nodes: nodes, acceptedAt: acceptedAt,
                                            pages: ProtocolObjectGraph.holdsPages(snapshot.root, in: objects))
    }

    public static func inferredMediaType(for name: String) -> String? {
        let ext = (name as NSString).pathExtension
        guard !ext.isEmpty else { return nil }
        return UTType(filenameExtension: ext)?.preferredMIMEType
    }
}
