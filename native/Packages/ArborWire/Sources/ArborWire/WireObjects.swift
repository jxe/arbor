import CryptoKit
import Foundation

public struct WireCollectionFileDescriptor: Hashable, Codable, Sendable {
    public var version: Int
    public var type: String
    public var format: String
    public var source: String
    public var schemaSource: String
    public var schemaFingerprint: String
    public var childSetHash: String

    public init(
        version: Int = 1,
        type: String = "collection-file",
        format: String,
        source: String,
        schemaSource: String,
        schemaFingerprint: String,
        childSetHash: String
    ) {
        self.version = version
        self.type = type
        self.format = format
        self.source = source
        self.schemaSource = schemaSource
        self.schemaFingerprint = schemaFingerprint
        self.childSetHash = childSetHash
    }
}

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
    case directory([WireDirectoryEntry], childrenSource: WireCollectionFileDescriptor? = nil)
}

public enum WireObjectCodec {
    public static func encode(_ object: WireObject) throws -> Data {
        try validate(object)
        let value: CanonicalCBORValue
        switch object {
        case let .file(bytes):
            value = .map([("type", .text("file")), ("bytes", .bytes(bytes))])
        case let .directory(entries, childrenSource):
            var fields: [(String, CanonicalCBORValue)] = [
                ("type", .text("directory")),
                ("entries", .array(entries.map { entry in
                    .map([
                        ("name", .text(entry.name)),
                        entry.hash.map { ("hash", .text($0)) }
                            ?? ("tree", .text(entry.tree!))
                    ])
                }))
            ]
            if let childrenSource { fields.append(("childrenSource", collectionFileValue(childrenSource))) }
            value = .map(fields)
        }
        return CanonicalCBOR.encode(value)
    }

    public static func decode(_ bytes: Data) throws -> WireObject {
        guard case let .map(entries) = try CanonicalCBOR.decode(bytes) else {
            throw ArborWireValidationError.invalidCBOR("Wire object is not a map")
        }
        let values = Dictionary(uniqueKeysWithValues: entries)
        guard case let .text(type)? = values["type"] else {
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
            guard Set(values.keys).isSubset(of: ["type", "entries", "childrenSource"]),
                  values.count == (values["childrenSource"] == nil ? 2 : 3),
                  case let .array(encodedEntries)? = values["entries"] else {
                throw ArborWireValidationError.invalidCBOR("Directory object fields are invalid")
            }
            let decoded = try encodedEntries.map { value -> WireDirectoryEntry in
                guard case let .map(fields) = value else { throw ArborWireValidationError.invalidCBOR("Directory entry is not a map") }
                let item = Dictionary(uniqueKeysWithValues: fields)
                guard case let .text(name)? = item["name"] else { throw ArborWireValidationError.invalidCBOR("Directory entry name is missing") }
                let hash = item["hash"].flatMap { if case let .text(value) = $0 { value } else { nil } }
                let tree = item["tree"].flatMap { if case let .text(value) = $0 { value } else { nil } }
                guard item.count == 2, [hash != nil, tree != nil].filter({ $0 }).count == 1 else {
                    throw ArborWireValidationError.invalidCBOR("Directory entry target is invalid")
                }
                return WireDirectoryEntry(name: name, hash: hash, tree: tree)
            }
            let childrenSource = try values["childrenSource"].map(decodeCollectionFile)
            object = .directory(decoded, childrenSource: childrenSource)
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

    private static func collectionFileValue(_ descriptor: WireCollectionFileDescriptor) -> CanonicalCBORValue {
        .map([
            ("version", .unsigned(descriptor.version)),
            ("type", .text(descriptor.type)),
            ("format", .text(descriptor.format)),
            ("source", .text(descriptor.source)),
            ("schemaSource", .text(descriptor.schemaSource)),
            ("schemaFingerprint", .text(descriptor.schemaFingerprint)),
            ("childSetHash", .text(descriptor.childSetHash)),
        ])
    }

    private static func decodeCollectionFile(_ value: CanonicalCBORValue) throws -> WireCollectionFileDescriptor {
        guard case let .map(fields) = value else {
            throw ArborWireValidationError.invalidCBOR("Collection-file descriptor is not a map")
        }
        let item = Dictionary(uniqueKeysWithValues: fields)
        guard item.count == 7,
              case let .unsigned(version)? = item["version"],
              case let .text(type)? = item["type"],
              case let .text(format)? = item["format"],
              case let .text(source)? = item["source"],
              case let .text(schemaSource)? = item["schemaSource"],
              case let .text(schemaFingerprint)? = item["schemaFingerprint"],
              case let .text(childSetHash)? = item["childSetHash"] else {
            throw ArborWireValidationError.invalidCBOR("Collection-file descriptor fields are invalid")
        }
        return WireCollectionFileDescriptor(
            version: version,
            type: type,
            format: format,
            source: source,
            schemaSource: schemaSource,
            schemaFingerprint: schemaFingerprint,
            childSetHash: childSetHash
        )
    }

    private static func validate(_ object: WireObject) throws {
        guard case let .directory(entries, childrenSource) = object else { return }
        var previous: Data?
        var names = Set<String>()
        for entry in entries {
            let name = entry.name
            guard !name.isEmpty, name != ".", name != "..",
                  name == name.precomposedStringWithCanonicalMapping,
                  !name.contains("/"), !name.contains("\\"), !name.contains("\0") else {
                throw ArborWireValidationError.invalidValue("Invalid directory entry name")
            }
            guard names.insert(name).inserted else { throw ArborWireValidationError.invalidValue("Duplicate directory entry name") }
            let utf8 = Data(name.utf8)
            if let previous, !previous.lexicographicallyPrecedes(utf8) {
                throw ArborWireValidationError.invalidValue("Directory entries are not sorted by UTF-8 bytes")
            }
            previous = utf8
            guard [entry.hash != nil, entry.tree != nil].filter({ $0 }).count == 1 else {
                throw ArborWireValidationError.invalidValue("Directory entry must have exactly one target")
            }
            if let hash = entry.hash { try validateObjectHash(hash) }
            if let tree = entry.tree, tree.isEmpty { throw ArborWireValidationError.invalidValue("Nested tree ID is empty") }
        }
        if let childrenSource {
            guard childrenSource.version == 1,
                  childrenSource.type == "collection-file",
                  ["csv", "json", "jsonl"].contains(childrenSource.format),
                  childrenSource.source == "_store.\(childrenSource.format)",
                  childrenSource.schemaSource == "schema.ts" else {
                throw ArborWireValidationError.invalidValue("Invalid collection-file descriptor")
            }
            try validateObjectHash(childrenSource.schemaFingerprint)
            try validateObjectHash(childrenSource.childSetHash)
            let entriesByName = Dictionary(uniqueKeysWithValues: entries.map { ($0.name, $0) })
            guard entriesByName[childrenSource.source]?.hash != nil,
                  entriesByName[childrenSource.schemaSource]?.hash != nil else {
                throw ArborWireValidationError.invalidValue("Collection-file sources must be ordinary file entries")
            }
            let allowed = Set([childrenSource.source, childrenSource.schemaSource, "_index.md"])
            guard entries.allSatisfy({ allowed.contains($0.name) }) else {
                throw ArborWireValidationError.invalidValue("Collection-file directory mixes immediate-child backings")
            }
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
            if case let .directory(entries, _) = object {
                for entry in entries {
                    if let child = entry.hash { try visit(child) }
                }
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
