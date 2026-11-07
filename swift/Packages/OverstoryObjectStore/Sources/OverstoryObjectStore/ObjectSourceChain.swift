import Overstory
import Foundation

/// The client library's object sources (Clients 003, module 2): stores tried
/// in order (memory, disk cache, placed folder, Story Sync, host). Every
/// answer is checked against its hash, so the order is only about speed: a
/// store that has no object (`missing`) or hands back wrong bytes
/// (`hashMismatch`) is passed over for the next one.
public struct ObjectSourceChain: ObjectStore {
    public let sources: [any ObjectStore]

    public init(_ sources: [any ObjectStore]) {
        self.sources = sources
    }

    public func bytes(_ hash: String) async throws -> Data {
        var mismatch: ObjectStoreError?
        for source in sources {
            do {
                return try verifyObject(try await source.bytes(hash), hash: hash)
            } catch ObjectStoreError.missing {
                continue
            } catch let error as ObjectStoreError {
                guard case .hashMismatch = error else { throw error }
                mismatch = error
                continue
            }
        }
        throw mismatch ?? ObjectStoreError.missing(hash)
    }
}

/// Reads the structure of a tree through an object store: what a client that
/// holds every directory but only some file bodies needs (Clients 003).
public enum SpineFetch {
    /// Every directory reachable from `root` (with its collection's tables and
    /// rows chunks) and every Markdown body (`.md`, file or page entry), read
    /// through `store` with at most `width` reads at once. Other files are
    /// left out: the result validates in `.sparseFiles` mode, and a reader
    /// fetches them on demand through the same store.
    public static func spine(root: String, from store: any ObjectStore, width: Int = 16) async throws -> ProtocolSnapshot {
        var objects: [String: Data] = [:]
        var frontier: [(hash: String, kind: ProtocolObjectKind)] = [(root, .directory)]
        while !frontier.isEmpty {
            var next: [(hash: String, kind: ProtocolObjectKind)] = []
            var index = 0
            while index < frontier.count {
                let batch = Array(frontier[index..<min(index + max(width, 1), frontier.count)])
                index += batch.count
                let read = try await withThrowingTaskGroup(of: (String, ProtocolObjectKind, Data).self) { group in
                    for item in batch {
                        group.addTask { (item.hash, item.kind, try await store.bytes(item.hash)) }
                    }
                    var results: [(String, ProtocolObjectKind, Data)] = []
                    for try await result in group { results.append(result) }
                    return results
                }
                for (hash, kind, bytes) in read {
                    objects[hash] = bytes
                    next.append(contentsOf: try children(of: bytes, kind: kind).filter { objects[$0.hash] == nil })
                }
            }
            // A hash reached twice in one level is read once.
            var seen = Set<String>()
            frontier = next.filter { objects[$0.hash] == nil && seen.insert($0.hash).inserted }
        }
        let snapshot = ProtocolSnapshot(
            root: root,
            objects: objects.map { ProtocolObjectEnvelope(hash: $0.key, bytes: $0.value) }.sorted { $0.hash < $1.hash }
        )
        _ = try ProtocolObjectGraph.validate(snapshot, mode: .sparseFiles)
        return snapshot
    }

    /// What the spine follows from one object: a directory's subdirectories,
    /// Markdown bodies and collection tables; a table's rows chunks.
    private static func children(of bytes: Data, kind: ProtocolObjectKind) throws -> [(hash: String, kind: ProtocolObjectKind)] {
        switch kind {
        case .directory:
            guard case let .directory(entries, collection) = try ProtocolObjectCodec.decode(bytes, kind: .directory) else { return [] }
            var result: [(hash: String, kind: ProtocolObjectKind)] = []
            for entry in entries {
                if let directory = entry.directory {
                    result.append((directory, .directory))
                } else if let hash = entry.file ?? entry.page, entry.name.lowercased().hasSuffix(".md"), let kind = entry.kind {
                    result.append((hash, kind))
                }
            }
            for table in collection?.tables ?? [] { result.append((table.table, .table)) }
            return result
        case .table:
            return try ProtocolObjectCodec.references(bytes, kind: .table)
        case .file, .page, .rows:
            return []
        }
    }
}
