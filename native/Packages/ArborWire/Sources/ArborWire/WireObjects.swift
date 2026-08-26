import CryptoKit
import Foundation

public struct WireDirectoryEntry: Hashable, Codable, Sendable {
    public var name: String
    public var hash: String?
    public var tree: String?

    public init(name: String, hash: String? = nil, tree: String? = nil) {
        self.name = name
        self.hash = hash
        self.tree = tree
    }
}

public enum WireObject: Hashable, Sendable {
    case file(Data)
    case directory([WireDirectoryEntry])
}

public enum WireObjectCodec {
    public static func encode(_ object: WireObject) throws -> Data {
        try validate(object)
        let value: CanonicalCBORValue
        switch object {
        case let .file(bytes):
            value = .map([("type", .text("file")), ("bytes", .bytes(bytes))])
        case let .directory(entries):
            value = .map([
                ("type", .text("directory")),
                ("entries", .array(entries.map { entry in
                    .map([
                        ("name", .text(entry.name)),
                        entry.hash.map { ("hash", .text($0)) } ?? ("tree", .text(entry.tree!))
                    ])
                }))
            ])
        }
        return CanonicalCBOR.encode(value)
    }

    public static func decode(_ bytes: Data) throws -> WireObject {
        guard case let .map(entries) = try CanonicalCBOR.decode(bytes) else {
            throw ArborWireValidationError.invalidCBOR("Wire object is not a map")
        }
        let values = Dictionary(uniqueKeysWithValues: entries)
        guard values.count == 2, case let .text(type)? = values["type"] else {
            throw ArborWireValidationError.invalidCBOR("Wire object fields are invalid")
        }
        let object: WireObject
        switch type {
        case "file":
            guard Set(values.keys) == ["type", "bytes"], case let .bytes(bytes)? = values["bytes"] else {
                throw ArborWireValidationError.invalidCBOR("File object fields are invalid")
            }
            object = .file(bytes)
        case "directory":
            guard Set(values.keys) == ["type", "entries"], case let .array(encodedEntries)? = values["entries"] else {
                throw ArborWireValidationError.invalidCBOR("Directory object fields are invalid")
            }
            let decoded = try encodedEntries.map { value -> WireDirectoryEntry in
                guard case let .map(fields) = value else { throw ArborWireValidationError.invalidCBOR("Directory entry is not a map") }
                let item = Dictionary(uniqueKeysWithValues: fields)
                guard case let .text(name)? = item["name"] else { throw ArborWireValidationError.invalidCBOR("Directory entry name is missing") }
                let hash = item["hash"].flatMap { if case let .text(value) = $0 { value } else { nil } }
                let tree = item["tree"].flatMap { if case let .text(value) = $0 { value } else { nil } }
                guard item.count == 2, (hash == nil) != (tree == nil) else {
                    throw ArborWireValidationError.invalidCBOR("Directory entry target is invalid")
                }
                return WireDirectoryEntry(name: name, hash: hash, tree: tree)
            }
            object = .directory(decoded)
        default:
            throw ArborWireValidationError.invalidCBOR("Unknown wire object type")
        }
        try validate(object)
        guard try encode(object) == bytes else { throw ArborWireValidationError.invalidCBOR("Wire object does not round-trip exactly") }
        return object
    }

    public static func hash(_ bytes: Data) -> String {
        "sha256:" + SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
    }

    public static func object(_ object: WireObject) throws -> WireObjectEnvelope {
        let bytes = try encode(object)
        return WireObjectEnvelope(hash: hash(bytes), bytes: bytes)
    }

    private static func validate(_ object: WireObject) throws {
        guard case let .directory(entries) = object else { return }
        var previous: Data?
        var names = Set<String>()
        for entry in entries {
            let name = entry.name
            guard !name.isEmpty, name != ".", name != "..",
                  !name.contains("/"), !name.contains("\\"), !name.contains("\0") else {
                throw ArborWireValidationError.invalidValue("Invalid directory entry name")
            }
            guard names.insert(name).inserted else { throw ArborWireValidationError.invalidValue("Duplicate directory entry name") }
            let utf8 = Data(name.utf8)
            if let previous, !previous.lexicographicallyPrecedes(utf8) {
                throw ArborWireValidationError.invalidValue("Directory entries are not sorted by UTF-8 bytes")
            }
            previous = utf8
            guard (entry.hash == nil) != (entry.tree == nil) else {
                throw ArborWireValidationError.invalidValue("Directory entry must have exactly one target")
            }
            if let hash = entry.hash { try validateObjectHash(hash) }
            if let tree = entry.tree, tree.isEmpty { throw ArborWireValidationError.invalidValue("Nested tree ID is empty") }
        }
    }
}

public enum WireObjectGraph {
    @discardableResult
    public static func validate(_ snapshot: WireSnapshot) throws -> [String: WireObject] {
        try validateObjectHash(snapshot.root)
        var bytesByHash: [String: Data] = [:]
        var objects: [String: WireObject] = [:]
        for envelope in snapshot.objects {
            try validateObjectHash(envelope.hash)
            if let existing = bytesByHash[envelope.hash], existing != envelope.bytes {
                throw ArborWireValidationError.invalidValue("Duplicate hash has different bytes")
            }
            let actual = WireObjectCodec.hash(envelope.bytes)
            guard actual == envelope.hash else {
                throw ArborWireValidationError.objectHashMismatch(expected: envelope.hash, actual: actual)
            }
            bytesByHash[envelope.hash] = envelope.bytes
            objects[envelope.hash] = try WireObjectCodec.decode(envelope.bytes)
        }
        guard case .directory? = objects[snapshot.root] else {
            throw ArborWireValidationError.incompleteGraph("Root is missing or is not a directory")
        }
        var visiting = Set<String>()
        var visited = Set<String>()
        func visit(_ hash: String) throws {
            if visiting.contains(hash) { throw ArborWireValidationError.cyclicGraph(hash) }
            if visited.contains(hash) { return }
            guard let object = objects[hash] else { throw ArborWireValidationError.incompleteGraph(hash) }
            visiting.insert(hash)
            if case let .directory(entries) = object {
                for child in entries.compactMap(\.hash) { try visit(child) }
            }
            visiting.remove(hash)
            visited.insert(hash)
        }
        try visit(snapshot.root)
        if let unreachable = Set(objects.keys).subtracting(visited).sorted().first {
            throw ArborWireValidationError.unreachableObject(unreachable)
        }
        return objects
    }
}
