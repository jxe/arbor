import OverstoryWorkspace
import Overstory
import Foundation
import UniformTypeIdentifiers

public enum SnapshotBridge {
    /// Markdown sources by object hash. A projection after a save decodes
    /// only the pages that changed, and unchanged pages keep the same string
    /// storage, which makes later comparisons of them immediate.
    static let decodedSources = DecodedSources()

    final class DecodedSources: @unchecked Sendable {
        private let lock = NSLock()
        private var sources: [String: String] = [:]
        private var size = 0
        private let maxBytes = 64 * 1024 * 1024

        func source(_ hash: String) -> String? { lock.withLock { sources[hash] } }

        func insert(_ hash: String, _ source: String) {
            lock.withLock {
                guard sources[hash] == nil else { return }
                if size + source.utf8.count > maxBytes { sources.removeAll(); size = 0 }
                sources[hash] = source
                size += source.utf8.count
            }
        }
    }

    /// Directory references must be present except in `.lazyDirectories`, where
    /// a missing directory becomes an unloaded node; sparse file references may
    /// omit payloads, except Markdown source which must remain inline.
    public static func replacement(
        snapshot: ProtocolSnapshot,
        tree: TreeID,
        update: String,
        cursor: String? = nil,
        mode: ProtocolObjectGraph.ValidationMode = .complete,
        acceptedAt: Date? = nil
    ) throws -> WorkingTreeSystemReplacement {
        let sparse = mode != .complete
        let lazy = mode == .lazyDirectories
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
            if let known = decodedSources.source(hash) { return known }
            let bytes = try fileBytes(hash)
            guard let decoded = String(data: bytes, encoding: .utf8) else {
                throw ProtocolValidationError.invalidValue("Markdown is not UTF-8")
            }
            decodedSources.insert(hash, decoded)
            return decoded
        }

        /// Whether the directory `hash` arrived with every Markdown body and
        /// collection object a node needs.
        func holdsBodies(_ hash: String) -> Bool {
            guard case let .directory(entries, collection)? = objects[hash] else { return false }
            for entry in entries where entry.directory == nil && entry.tree == nil {
                guard entry.page != nil || entry.name.hasSuffix(".md") else { continue }
                guard let body = entry.hash, objects[body] != nil else { return false }
            }
            if let collection, (try? collectionLog(collection)) == nil { return false }
            return true
        }

        /// The bytes of a collection's log, from its head back to its newest
        /// snapshot entry (or its first), and that snapshot's file when the
        /// snapshot carries it (collections §1.1).
        func collectionLog(_ collection: ProtocolCollectionReference) throws -> [String: Data] {
            var found: [String: Data] = [:]
            var at: String? = collection.log
            while let hash = at, found[hash] == nil {
                guard case let .log(entry)? = objects[hash] else { throw ProtocolValidationError.incompleteGraph(hash) }
                found[hash] = try snapshotBytes(hash)
                if let file = entry.snapshot {
                    if let bytes = bytesByHash[file] { found[file] = bytes }
                    break
                }
                at = entry.previous
            }
            return found
        }

        func appendNode(_ node: WorkingTreeSystemNode) throws {
            guard logicalPaths.insert(node.path).inserted else {
                throw ProtocolValidationError.invalidValue("Duplicate logical path \(node.path)")
            }
            var node = node
            // A node is dated by its content entry's `modified` (data model §6).
            if let modified = node.times?.modified { node.metadata.modifiedAt = Date(timeIntervalSince1970: Double(modified) / 1000) }
            nodes.append(node)
        }

        /// `siblingMarkdownSource` is the directory's `<name>.md` body in its parent, and `siblingEntry` that entry.
        func visitDirectory(_ hash: String, path: String, siblingMarkdownSource: String? = nil, siblingEntry: ProtocolDirectoryEntry? = nil) throws {
            guard case let .directory(entries, collection)? = objects[hash] else {
                throw ProtocolValidationError.incompleteGraph(hash)
            }
            let directoryNames = Set(entries.compactMap { entry -> String? in
                entry.directory == nil ? nil : entry.name
            })
            let siblingBodies = Dictionary(grouping: entries.compactMap { entry -> (stem: String, name: String)? in
                guard let hash = entry.hash, let object = objects[hash] else { return nil }
                switch object { case .file, .page: break; default: return nil }
                // Only `x.md` is a directory's sibling body; `x.mdx` is a plain file (Apps 011).
                guard entry.name.hasSuffix(".md") else { return nil }
                return (String(entry.name.dropLast(3)), entry.name)
            }, by: { $0.stem })
            for (stem, bodies) in siblingBodies where directoryNames.contains(stem) && bodies.count > 1 {
                throw ProtocolValidationError.invalidValue(
                    "Duplicate body representation for \(childPath(stem, parent: path))"
                )
            }

            var indexSource: String?
            let indexEntry = entries.first(where: { $0.name == "_index.md" })
            if let indexHash = indexEntry?.hash {
                indexSource = try markdownSource(indexHash)
            }
            let siblingTimes = siblingMarkdownSource.flatMap { WorkingTreeEntryTimes(siblingEntry, content: WorkingTreeEntryTimes.content(of: $0)) }
            let source = indexSource ?? siblingMarkdownSource
            // A collection's log entries are present in every mode; its snapshot
            // file, a file, may be left for the object sources.
            let collectionObjects = try collection.map(collectionLog) ?? [:]
            try appendNode(WorkingTreeSystemNode(
                path: path,
                content: .directory(source: source),
                collection: collection,
                collectionObjects: collectionObjects,
                directoryBodyPlacement: indexSource == nil && siblingMarkdownSource != nil ? .siblingMarkdown : nil,
                shadowedSiblingMarkdownSource: indexSource != nil ? siblingMarkdownSource : nil,
                times: indexSource.map { WorkingTreeEntryTimes(indexEntry, content: WorkingTreeEntryTimes.content(of: $0)) } ?? siblingTimes,
                shadowedTimes: indexSource != nil ? siblingTimes : nil
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
                    if entry.directory != nil {
                        guard lazy else { throw ProtocolValidationError.incompleteGraph(childHash) }
                        // Not loaded yet; its sibling body belongs to this directory.
                        let sibling = entries.first { $0.name == entry.name + ".md" && $0.hash != nil }
                        let siblingSource = try sibling?.hash.map(markdownSource)
                        try appendNode(WorkingTreeSystemNode(
                            path: destination,
                            content: .directory(source: siblingSource),
                            directoryBodyPlacement: siblingSource != nil ? .siblingMarkdown : nil,
                            unloadedDirectory: childHash,
                            times: siblingSource.flatMap { WorkingTreeEntryTimes(sibling, content: WorkingTreeEntryTimes.content(of: $0)) }
                        ))
                        continue
                    }
                    guard !entry.name.hasSuffix(".md"), entry.page == nil else {
                        throw ProtocolValidationError.incompleteGraph("Markdown \(destination) is not in the sparse snapshot")
                    }
                    try appendNode(WorkingTreeSystemNode(
                        path: destination,
                        content: .file(ref: .hash(
                            childHash,
                            size: nil,
                            mediaType: inferredMediaType(for: entry.name)
                        )),
                        times: WorkingTreeEntryTimes(entry, content: childHash)
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
                    if lazy, !holdsBodies(childHash) {
                        // Present but without every body (a replay that changed it,
                        // a graph cut before its pages were read): held unloaded,
                        // so it loads again, checked, when a path below it is asked for.
                        try appendNode(WorkingTreeSystemNode(
                            path: destination,
                            content: .directory(source: siblingSource),
                            directoryBodyPlacement: siblingSource != nil ? .siblingMarkdown : nil,
                            unloadedDirectory: childHash,
                            times: siblingSource.flatMap { WorkingTreeEntryTimes(siblingEntry, content: WorkingTreeEntryTimes.content(of: $0)) }
                        ))
                        continue
                    }
                    try visitDirectory(childHash, path: destination, siblingMarkdownSource: siblingSource, siblingEntry: siblingEntry)
                case .file, .page:
                    if entry.name.hasSuffix(".md") {
                        let logicalName = String(entry.name.dropLast(3))
                        if directoryNames.contains(logicalName) { continue }
                        let decoded = try markdownSource(childHash)
                        try appendNode(WorkingTreeSystemNode(
                            path: childPath(logicalName, parent: path),
                            content: .markdown(source: decoded),
                            times: WorkingTreeEntryTimes(entry, content: WorkingTreeEntryTimes.content(of: decoded))
                        ))
                    } else {
                        let bytes = try fileBytes(childHash)
                        try appendNode(WorkingTreeSystemNode(path: destination, content: .file(ref: .inline(bytes)),
                                                             times: WorkingTreeEntryTimes(entry, content: ProtocolObjectCodec.hash(bytes))))
                    }
                case .log:
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
