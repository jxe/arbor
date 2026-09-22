import CanopyAppKit
import Overstory
import Foundation
import UniformTypeIdentifiers

public enum SnapshotBridge {
    /// Directory references must be present in all modes; sparse file references
    /// may omit payloads, except Markdown source which must remain inline.
    public static func replacement(
        snapshot: WireSnapshot,
        tree: TreeID,
        update: String,
        cursor: String? = nil,
        mode: WireObjectGraph.ValidationMode = .complete,
        entryMetadata: [String: EntryMetadata] = [:],
        acceptedAt: Date? = nil
    ) throws -> WorkingTreeSystemReplacement {
        let sparse = mode == .sparseFiles
        let objects = try WireObjectGraph.validate(snapshot, mode: mode)
        var nodes: [WorkingTreeSystemNode] = []
        var logicalPaths = Set<String>()

        func childPath(_ name: String, parent: String) -> String {
            parent == "/" ? "/\(name)" : "\(parent)/\(name)"
        }

        func fileBytes(_ hash: String) throws -> Data {
            guard case let .file(bytes)? = objects[hash] else {
                throw ArborWireValidationError.incompleteGraph(hash)
            }
            return bytes
        }

        func markdownSource(_ hash: String) throws -> String {
            let bytes = try fileBytes(hash)
            guard let decoded = String(data: bytes, encoding: .utf8) else {
                throw ArborWireValidationError.invalidValue("Markdown is not UTF-8")
            }
            return decoded
        }

        func appendNode(_ node: WorkingTreeSystemNode) throws {
            guard logicalPaths.insert(node.path).inserted else {
                throw ArborWireValidationError.invalidValue("Duplicate logical path \(node.path)")
            }
            var node = node
            if let entry = node.bodyEntryPath, let metadata = entryMetadata[entry] { node.metadata = metadata }
            nodes.append(node)
        }

        func visitDirectory(_ hash: String, path: String, siblingMarkdownSource: String? = nil) throws {
            guard case let .directory(entries, childrenSource)? = objects[hash] else {
                throw ArborWireValidationError.incompleteGraph(hash)
            }
            let directoryNames = Set(entries.compactMap { entry -> String? in
                guard let hash = entry.hash, case .directory? = objects[hash] else { return nil }
                return entry.name
            })
            let siblingBodies = Dictionary(grouping: entries.compactMap { entry -> (stem: String, name: String)? in
                guard let hash = entry.hash, case .file? = objects[hash] else { return nil }
                for suffix in [".md", ".mdx"] where entry.name.hasSuffix(suffix) {
                    return (String(entry.name.dropLast(suffix.count)), entry.name)
                }
                return nil
            }, by: { $0.stem })
            for (stem, bodies) in siblingBodies where directoryNames.contains(stem) && bodies.count > 1 {
                throw ArborWireValidationError.invalidValue(
                    "Duplicate body representation for \(childPath(stem, parent: path))"
                )
            }

            var indexSource: String?
            if let index = entries.first(where: { $0.name == "_index.md" }), let indexHash = index.hash {
                indexSource = try markdownSource(indexHash)
            }
            let source = indexSource ?? siblingMarkdownSource
            try appendNode(WorkingTreeSystemNode(
                path: path,
                content: .directory(source: source),
                childrenSource: childrenSource.map {
                    WorkingTreeCollectionFileDescriptor(
                        version: $0.version,
                        type: $0.type,
                        format: $0.format,
                        source: $0.source,
                        schemaSource: $0.schemaSource,
                        schemaFingerprint: $0.schemaFingerprint,
                        childSetHash: $0.childSetHash
                    )
                },
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
                    throw ArborWireValidationError.incompleteGraph(entry.name)
                }
                guard let object = objects[childHash] else {
                    guard sparse else { throw ArborWireValidationError.incompleteGraph(childHash) }
                    guard !entry.name.hasSuffix(".md") else {
                        throw ArborWireValidationError.incompleteGraph("Markdown \(destination) is not in the sparse snapshot")
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
                case let .file(bytes):
                    if entry.name.hasSuffix(".md") {
                        let logicalName = String(entry.name.dropLast(3))
                        if directoryNames.contains(logicalName) { continue }
                        guard let decoded = String(data: bytes, encoding: .utf8) else {
                            throw ArborWireValidationError.invalidValue("Markdown is not UTF-8")
                        }
                        try appendNode(WorkingTreeSystemNode(
                            path: childPath(logicalName, parent: path),
                            content: .markdown(source: decoded)
                        ))
                    } else {
                        try appendNode(WorkingTreeSystemNode(path: destination, content: .file(ref: .inline(bytes))))
                    }
                }
            }
        }

        try visitDirectory(snapshot.root, path: "/")
        return WorkingTreeSystemReplacement(root: snapshot.root, update: update, cursor: cursor, nodes: nodes, acceptedAt: acceptedAt)
    }

    public static func inferredMediaType(for name: String) -> String? {
        let ext = (name as NSString).pathExtension
        guard !ext.isEmpty else { return nil }
        return UTType(filenameExtension: ext)?.preferredMIMEType
    }
}
