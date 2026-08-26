import ArborKit
import ArborReplica
import ArborWire
import Foundation

enum SnapshotBridge {
    static func replacement(
        snapshot: WireSnapshot,
        tree: TreeID,
        update: String,
        cursor: String? = nil
    ) throws -> ReplicaSystemReplacement {
        let objects = try WireObjectGraph.validate(snapshot)
        var nodes: [ReplicaSystemNode] = []

        func childPath(_ name: String, parent: String) -> String {
            parent == "/" ? "/\(name)" : "\(parent)/\(name)"
        }

        func fileBytes(_ hash: String) throws -> Data {
            guard case let .file(bytes)? = objects[hash] else {
                throw ArborWireValidationError.incompleteGraph(hash)
            }
            return bytes
        }

        func visitDirectory(_ hash: String, path: String) throws {
            guard case let .directory(entries)? = objects[hash] else {
                throw ArborWireValidationError.incompleteGraph(hash)
            }
            var source: String?
            if let index = entries.first(where: { $0.name == "_index.md" }), let indexHash = index.hash {
                let bytes = try fileBytes(indexHash)
                guard let decoded = String(data: bytes, encoding: .utf8) else {
                    throw ArborWireValidationError.invalidValue("Directory Markdown is not UTF-8")
                }
                source = decoded
            }
            nodes.append(ReplicaSystemNode(path: path, content: .directory(source: source)))

            for entry in entries where entry.name != "_index.md" {
                let destination = childPath(entry.name, parent: path)
                if let nestedTree = entry.tree {
                    nodes.append(ReplicaSystemNode(path: destination, content: .boundary(tree: TreeID(rawValue: nestedTree))))
                    continue
                }
                guard let childHash = entry.hash, let object = objects[childHash] else {
                    throw ArborWireValidationError.incompleteGraph(entry.hash ?? entry.name)
                }
                switch object {
                case .directory:
                    try visitDirectory(childHash, path: destination)
                case let .file(bytes):
                    if entry.name.hasSuffix(".md") {
                        guard let decoded = String(data: bytes, encoding: .utf8) else {
                            throw ArborWireValidationError.invalidValue("Markdown is not UTF-8")
                        }
                        let logicalName = String(entry.name.dropLast(3))
                        nodes.append(ReplicaSystemNode(
                            path: childPath(logicalName, parent: path),
                            content: .markdown(source: decoded)
                        ))
                    } else {
                        nodes.append(ReplicaSystemNode(path: destination, content: .file(bytes: bytes)))
                    }
                }
            }
        }

        try visitDirectory(snapshot.root, path: "/")
        return ReplicaSystemReplacement(root: snapshot.root, update: update, cursor: cursor, nodes: nodes)
    }
}

extension WireSnapshot {
    var replicaSnapshot: ReplicaSnapshot {
        ReplicaSnapshot(root: root, objects: objects.map { ReplicaStoredObject(hash: $0.hash, bytes: $0.bytes) })
    }
}
