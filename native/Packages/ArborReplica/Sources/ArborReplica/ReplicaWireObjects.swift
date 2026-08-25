import CryptoKit
import Foundation

enum ReplicaWireValue {
    case bytes(Data)
    case text(String)
    case array([ReplicaWireValue])
    case map([(String, ReplicaWireValue)])
}

enum ReplicaWireCodec {
    static func encode(_ value: ReplicaWireValue) -> Data {
        switch value {
        case let .bytes(bytes): return head(major: 2, count: bytes.count) + bytes
        case let .text(text): return head(major: 3, count: text.utf8.count) + Data(text.utf8)
        case let .array(values): return values.reduce(into: head(major: 4, count: values.count)) { $0.append(encode($1)) }
        case let .map(entries):
            return entries.map { (encode(.text($0.0)), $0.1) }
                .sorted { canonicalCompare($0.0, $1.0) }
                .reduce(into: head(major: 5, count: entries.count)) { result, entry in
                    result.append(entry.0)
                    result.append(encode(entry.1))
                }
        }
    }

    static func file(_ bytes: Data) -> Data {
        encode(.map([("type", .text("file")), ("bytes", .bytes(bytes))]))
    }

    static func directory(_ entries: [(name: String, hash: String?, tree: String?)]) -> Data {
        encode(.map([
            ("type", .text("directory")),
            ("entries", .array(entries.map { entry in
                .map([
                    ("name", .text(entry.name)),
                    entry.hash.map { ("hash", .text($0)) } ?? ("tree", .text(entry.tree!))
                ])
            }))
        ]))
    }

    static func hash(_ bytes: Data) -> String { ReplicaSemantics.sha256(bytes) }

    static func snapshot(for state: ReplicaState) throws -> ReplicaSnapshot {
        let active = state.nodes.filter { $0.path != "/Trash" && !$0.path.hasPrefix("/Trash/") }
        guard active.contains(where: { $0.path == "/" && $0.kind == .directory }) else {
            throw ReplicaError.corruptState("Replica root directory is missing")
        }
        let byPath = Dictionary(uniqueKeysWithValues: active.map { ($0.path, $0) })
        var objects: [String: Data] = [:]

        func store(_ bytes: Data) -> String {
            let hash = hash(bytes)
            objects[hash] = bytes
            return hash
        }

        func buildDirectory(at path: String) throws -> String {
            guard let node = byPath[path], node.kind == .directory else {
                throw ReplicaError.corruptState("Missing directory at \(path)")
            }
            var entries: [(name: String, hash: String?, tree: String?)] = []
            if let source = node.source { entries.append(("_index.md", store(file(Data(source.utf8))), nil)) }
            let children = active.filter { ReplicaSemantics.parent(of: $0.path) == path }
                .sorted { ReplicaSemantics.compareUTF8(ReplicaSemantics.name(of: $0.path), ReplicaSemantics.name(of: $1.path)) }
            for child in children {
                let name = ReplicaSemantics.name(of: child.path)
                switch child.kind {
                case .directory:
                    entries.append((name, try buildDirectory(at: child.path), nil))
                case .markdown:
                    entries.append((name + ".md", store(file(Data((child.source ?? "").utf8))), nil))
                case .file:
                    entries.append((name, store(file(child.bytes ?? Data())), nil))
                case .boundary:
                    guard let tree = child.boundaryTree, !tree.isEmpty else {
                        throw ReplicaError.corruptState("Nested tree boundary is empty")
                    }
                    entries.append((name, nil, tree))
                }
            }
            entries.sort { ReplicaSemantics.compareUTF8($0.name, $1.name) }
            return store(Self.directory(entries))
        }

        let root = try buildDirectory(at: "/")
        return ReplicaSnapshot(
            root: root,
            objects: objects.map { ReplicaStoredObject(hash: $0.key, bytes: $0.value) }.sorted { $0.hash < $1.hash }
        )
    }

    private static func head(major: UInt8, count: Int) -> Data {
        precondition(count >= 0)
        let prefix = major << 5
        if count < 24 { return Data([prefix | UInt8(count)]) }
        if count <= 0xff { return Data([prefix | 24, UInt8(count)]) }
        if count <= 0xffff { return Data([prefix | 25, UInt8((count >> 8) & 0xff), UInt8(count & 0xff)]) }
        if UInt64(count) <= UInt64(UInt32.max) {
            return Data([
                prefix | 26,
                UInt8((count >> 24) & 0xff),
                UInt8((count >> 16) & 0xff),
                UInt8((count >> 8) & 0xff),
                UInt8(count & 0xff),
            ])
        }
        let value = UInt64(count)
        return Data([prefix | 27] + (0..<8).reversed().map { UInt8((value >> UInt64($0 * 8)) & 0xff) })
    }

    private static func canonicalCompare(_ left: Data, _ right: Data) -> Bool {
        left.count == right.count ? left.lexicographicallyPrecedes(right) : left.count < right.count
    }
}
