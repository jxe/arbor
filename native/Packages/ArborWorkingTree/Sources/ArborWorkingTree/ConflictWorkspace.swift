import ArborWire
import Foundation

enum ConflictWorkspaceGraph {
    enum Target: Equatable {
        case object(String)
        case boundary(String)
        case missing
    }

    static func target(at path: String, in snapshot: WireSnapshot) throws -> Target {
        let objects = try WireObjectGraph.validate(snapshot)
        let components = try pathComponents(path)
        if components.isEmpty { return .object(snapshot.root) }
        var hash = snapshot.root
        for (index, component) in components.enumerated() {
            guard case let .directory(entries, _)? = objects[hash],
                  let entry = entries.first(where: { $0.name == component }) else { return .missing }
            if index == components.count - 1 {
                if let tree = entry.tree { return .boundary(tree) }
                return entry.hash.map(Target.object) ?? .missing
            }
            guard let next = entry.hash, case .directory? = objects[next] else { return .missing }
            hash = next
        }
        return .missing
    }

    static func content(at path: String, in snapshot: WireSnapshot) throws -> ReplicaConflictContent {
        let objects = try WireObjectGraph.validate(snapshot)
        switch try target(at: path, in: snapshot) {
        case .missing:
            return .missing
        case let .boundary(tree):
            return .boundary(tree: tree)
        case let .object(hash):
            guard let object = objects[hash] else { throw ReplicaSyncError.conflictSnapshotMissing }
            switch object {
            case let .file(bytes):
                if let text = String(data: bytes, encoding: .utf8) { return .text(text) }
                return .binary(bytes)
            case let .directory(entries, _):
                return .directory(entries.map(\.name))
            }
        }
    }

    static func replacing(
        path: String,
        in destination: WireSnapshot,
        with source: WireSnapshot
    ) throws -> WireSnapshot {
        let sourceObjects = try WireObjectGraph.validate(source)
        let sourceTarget = try target(at: path, in: source)
        return try replacing(path: path, in: destination, with: sourceTarget, sourceObjects: sourceObjects)
    }

    static func replacingText(path: String, in destination: WireSnapshot, with text: String) throws -> WireSnapshot {
        _ = try WireObjectGraph.validate(destination)
        let file = try WireObjectCodec.object(.file(Data(text.utf8)))
        return try replacing(path: path, in: destination, with: .object(file.hash), sourceObjects: [file.hash: .file(Data(text.utf8))])
    }

    private static func replacing(
        path: String,
        in destination: WireSnapshot,
        with replacement: Target,
        sourceObjects: [String: WireObject]
    ) throws -> WireSnapshot {
        let components = try pathComponents(path)
        guard !components.isEmpty else {
            guard case let .object(root) = replacement else { throw ReplicaSyncError.conflictPathOverlap }
            return try snapshot(root: root, objects: sourceObjects)
        }
        let destinationObjects = try WireObjectGraph.validate(destination)
        var objects = destinationObjects
        for (hash, object) in sourceObjects { objects[hash] = object }

        func rewrite(_ directoryHash: String, depth: Int) throws -> String {
            guard case let .directory(entries, childrenSource)? = objects[directoryHash] else {
                throw ReplicaSyncError.conflictSnapshotMissing
            }
            let name = components[depth]
            var nextEntries = entries
            if depth == components.count - 1 {
                nextEntries.removeAll { $0.name == name }
                switch replacement {
                case .missing:
                    break
                case let .object(hash):
                    nextEntries.append(WireDirectoryEntry(name: name, hash: hash))
                case let .boundary(tree):
                    nextEntries.append(WireDirectoryEntry(name: name, tree: tree))
                }
            } else {
                guard let index = nextEntries.firstIndex(where: { $0.name == name }),
                      let child = nextEntries[index].hash else {
                    throw ReplicaSyncError.conflictSnapshotMissing
                }
                nextEntries[index] = WireDirectoryEntry(name: name, hash: try rewrite(child, depth: depth + 1))
            }
            nextEntries.sort { utf8Less($0.name, $1.name) }
            let directory = try WireObjectCodec.object(.directory(nextEntries, childrenSource: childrenSource))
            objects[directory.hash] = .directory(nextEntries, childrenSource: childrenSource)
            return directory.hash
        }

        let root = try rewrite(destination.root, depth: 0)
        return try snapshot(root: root, objects: objects)
    }

    private static func snapshot(root: String, objects: [String: WireObject]) throws -> WireSnapshot {
        var reachable = Set<String>()
        func visit(_ hash: String) throws {
            guard reachable.insert(hash).inserted else { return }
            guard let object = objects[hash] else { throw ReplicaSyncError.conflictSnapshotMissing }
            if case let .directory(entries, _) = object {
                for entry in entries { if let child = entry.hash { try visit(child) } }
            }
        }
        try visit(root)
        let envelopes = try reachable.sorted().map { hash -> WireObjectEnvelope in
            guard let object = objects[hash] else { throw ReplicaSyncError.conflictSnapshotMissing }
            let envelope = try WireObjectCodec.object(object)
            guard envelope.hash == hash else { throw ReplicaSyncError.conflictSnapshotMissing }
            return envelope
        }
        let result = WireSnapshot(root: root, objects: envelopes)
        _ = try WireObjectGraph.validate(result)
        return result
    }

    private static func pathComponents(_ path: String) throws -> [String] {
        guard path.first == "/" else { throw ReplicaSyncError.conflictSnapshotMissing }
        if path == "/" { return [] }
        let components = path.dropFirst().split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        guard components.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }) else {
            throw ReplicaSyncError.conflictSnapshotMissing
        }
        return components
    }

    private static func utf8Less(_ lhs: String, _ rhs: String) -> Bool {
        lhs.utf8.lexicographicallyPrecedes(rhs.utf8)
    }
}
