import CryptoKit
import Foundation

/// Version 2 selects the declarative `schema.cddl`. Version 1 selected the
/// retired executable `schema.ts`; it still decodes so retained objects keep
/// their exact bytes and hashes, but nothing interprets it.
public struct ProtocolCollectionFileDescriptor: Hashable, Codable, Sendable {
    /// The schema file each descriptor version selects.
    public static let schemaSources: [Int: String] = [1: "schema.ts", 2: "schema.cddl"]

    public var version: Int
    public var type: String
    public var format: String
    public var source: String
    public var schemaSource: String
    public var schemaFingerprint: String
    public var childSetHash: String

    public init(
        version: Int = 2,
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

public enum ProtocolEntryKind: String, Codable, Sendable { case file, directory }

public struct ProtocolDirectoryEntry: Hashable, Codable, Sendable {
    public var name: String
    public var file: String?
    public var directory: String?
    public var tree: String?
    public var hash: String? { file ?? directory }
    public var kind: ProtocolEntryKind? { file != nil ? .file : directory != nil ? .directory : nil }

    public init(name: String, file: String? = nil, directory: String? = nil, tree: String? = nil) {
        self.name = name
        self.file = file
        self.directory = directory
        self.tree = tree
    }
}

/// A typed in-memory interpretation. File bytes have no encoded wrapper;
/// directory entries, never payload sniffing, supply the interpretation.
public enum ProtocolObject: Hashable, Sendable {
    case file(Data)
    case directory([ProtocolDirectoryEntry], childrenSource: ProtocolCollectionFileDescriptor? = nil)
}

public enum ProtocolObjectCodec {
    public static func encode(_ object: ProtocolObject) throws -> Data {
        try validate(object)
        let value: CanonicalCBORValue
        switch object {
        case let .file(bytes):
            return bytes
        case let .directory(entries, childrenSource):
            var fields: [(String, CanonicalCBORValue)] = [
                ("type", .text("directory")),
                ("entries", .array(entries.map { entry in
                    .map([
                        ("name", .text(entry.name)),
                        entry.file.map { ("file", .text($0)) }
                            ?? entry.directory.map { ("directory", .text($0)) }
                            ?? ("tree", .text(entry.tree!))
                    ])
                }))
            ]
            if let childrenSource { fields.append(("childrenSource", collectionFileValue(childrenSource))) }
            value = .map(fields)
        }
        return CanonicalCBOR.encode(value)
    }

    public static func decode(_ bytes: Data, kind: ProtocolEntryKind) throws -> ProtocolObject {
        if kind == .file { return .file(bytes) }
        guard case let .map(entries) = try CanonicalCBOR.decode(bytes) else {
            throw ProtocolValidationError.invalidCBOR("Wire object is not a map")
        }
        let values = Dictionary(uniqueKeysWithValues: entries)
        guard case let .text(type)? = values["type"] else {
            throw ProtocolValidationError.invalidCBOR("Wire object fields are invalid")
        }
        let object: ProtocolObject
        switch type {
        case "directory":
            guard Set(values.keys).isSubset(of: ["type", "entries", "childrenSource"]),
                  values.count == (values["childrenSource"] == nil ? 2 : 3),
                  case let .array(encodedEntries)? = values["entries"] else {
                throw ProtocolValidationError.invalidCBOR("Directory object fields are invalid")
            }
            let decoded = try encodedEntries.map { value -> ProtocolDirectoryEntry in
                guard case let .map(fields) = value else { throw ProtocolValidationError.invalidCBOR("Directory entry is not a map") }
                let item = Dictionary(uniqueKeysWithValues: fields)
                guard case let .text(name)? = item["name"] else { throw ProtocolValidationError.invalidCBOR("Directory entry name is missing") }
                let file = item["file"].flatMap { if case let .text(value) = $0 { value } else { nil } }
                let directory = item["directory"].flatMap { if case let .text(value) = $0 { value } else { nil } }
                let tree = item["tree"].flatMap { if case let .text(value) = $0 { value } else { nil } }
                guard item.count == 2, [file != nil, directory != nil, tree != nil].filter({ $0 }).count == 1 else {
                    throw ProtocolValidationError.invalidCBOR("Directory entry target is invalid")
                }
                return ProtocolDirectoryEntry(name: name, file: file, directory: directory, tree: tree)
            }
            let childrenSource = try values["childrenSource"].map(decodeCollectionFile)
            object = .directory(decoded, childrenSource: childrenSource)
        default:
            throw ProtocolValidationError.invalidCBOR("Unknown wire object type")
        }
        // `CanonicalCBOR.decode` accepted only canonical bytes and every field above
        // was matched exactly, so re-encoding `object` would reproduce `bytes`.
        try validate(object)
        return object
    }

    public static func hash(_ bytes: Data) -> String {
        "sha256:" + SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
    }

    public static func object(_ object: ProtocolObject) throws -> ProtocolObjectEnvelope {
        let bytes = try encode(object)
        return ProtocolObjectEnvelope(hash: hash(bytes), bytes: bytes)
    }

    private static func collectionFileValue(_ descriptor: ProtocolCollectionFileDescriptor) -> CanonicalCBORValue {
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

    private static func decodeCollectionFile(_ value: CanonicalCBORValue) throws -> ProtocolCollectionFileDescriptor {
        guard case let .map(fields) = value else {
            throw ProtocolValidationError.invalidCBOR("Collection-file descriptor is not a map")
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
            throw ProtocolValidationError.invalidCBOR("Collection-file descriptor fields are invalid")
        }
        return ProtocolCollectionFileDescriptor(
            version: version,
            type: type,
            format: format,
            source: source,
            schemaSource: schemaSource,
            schemaFingerprint: schemaFingerprint,
            childSetHash: childSetHash
        )
    }

    private static func validate(_ object: ProtocolObject) throws {
        guard case let .directory(entries, childrenSource) = object else { return }
        var previous: Data?
        var names = Set<String>()
        for entry in entries {
            let name = entry.name
            guard !name.isEmpty, name != ".", name != "..",
                  name == name.precomposedStringWithCanonicalMapping,
                  !name.contains("/"), !name.contains("\\"), !name.contains("\0") else {
                throw ProtocolValidationError.invalidValue("Invalid directory entry name")
            }
            guard names.insert(name).inserted else { throw ProtocolValidationError.invalidValue("Duplicate directory entry name") }
            let utf8 = Data(name.utf8)
            if let previous, !previous.lexicographicallyPrecedes(utf8) {
                throw ProtocolValidationError.invalidValue("Directory entries are not sorted by UTF-8 bytes")
            }
            previous = utf8
            guard [entry.file != nil, entry.directory != nil, entry.tree != nil].filter({ $0 }).count == 1 else {
                throw ProtocolValidationError.invalidValue("Directory entry must have exactly one target")
            }
            if let hash = entry.hash { try validateObjectHash(hash) }
            if let tree = entry.tree, tree.isEmpty { throw ProtocolValidationError.invalidValue("Nested tree ID is empty") }
        }
        if let childrenSource {
            guard let schemaSource = ProtocolCollectionFileDescriptor.schemaSources[childrenSource.version],
                  childrenSource.type == "collection-file",
                  ["csv", "json", "jsonl"].contains(childrenSource.format),
                  childrenSource.source == "_store.\(childrenSource.format)",
                  childrenSource.schemaSource == schemaSource else {
                throw ProtocolValidationError.invalidValue("Invalid collection-file descriptor")
            }
            try validateObjectHash(childrenSource.schemaFingerprint)
            try validateObjectHash(childrenSource.childSetHash)
            let entriesByName = Dictionary(uniqueKeysWithValues: entries.map { ($0.name, $0) })
            guard entriesByName[childrenSource.source]?.file != nil,
                  entriesByName[childrenSource.schemaSource]?.file != nil else {
                throw ProtocolValidationError.invalidValue("Collection-file sources must be ordinary file entries")
            }
            let allowed = Set([childrenSource.source, childrenSource.schemaSource, "_index.md"])
            guard entries.allSatisfy({ allowed.contains($0.name) }) else {
                throw ProtocolValidationError.invalidValue("Collection-file directory mixes immediate-child backings")
            }
        }
    }
}

public enum ProtocolSnapshotBundleCodec {
    public static func encode(_ snapshot: ProtocolSnapshot) throws -> Data {
        _ = try ProtocolObjectGraph.validate(snapshot)
        var seen = Set<String>()
        let ordered = try snapshot.objects.map { envelope -> ProtocolObjectEnvelope in
            guard seen.insert(envelope.hash).inserted else {
                throw ProtocolValidationError.invalidValue("Snapshot contains a duplicate object")
            }
            let actual = ProtocolObjectCodec.hash(envelope.bytes)
            guard actual == envelope.hash else {
                throw ProtocolValidationError.objectHashMismatch(expected: envelope.hash, actual: actual)
            }
            return envelope
        }.sorted { $0.hash < $1.hash }
        return CanonicalCBOR.encode(.map([
            ("version", .unsigned(1)),
            ("objects", .array(ordered.map { .bytes($0.bytes) })),
        ]))
    }

    public static func decode(
        _ data: Data,
        root: String,
        mode: ProtocolObjectGraph.ValidationMode = .complete
    ) throws -> ProtocolSnapshot {
        try validateObjectHash(root)
        guard case let .map(fields) = try CanonicalCBOR.decode(data) else {
            throw ProtocolValidationError.invalidCBOR("Snapshot bundle is not a map")
        }
        let values = Dictionary(uniqueKeysWithValues: fields)
        guard values.count == 2,
              case .unsigned(1)? = values["version"],
              case let .array(encodedObjects)? = values["objects"] else {
            throw ProtocolValidationError.invalidCBOR("Snapshot bundle fields are invalid")
        }
        var previous: String?
        var seen = Set<String>()
        let objects = try encodedObjects.map { value -> ProtocolObjectEnvelope in
            guard case let .bytes(bytes) = value else {
                throw ProtocolValidationError.invalidCBOR("Snapshot object is not a byte string")
            }
            let hash = ProtocolObjectCodec.hash(bytes)
            if let previous, hash <= previous {
                throw ProtocolValidationError.invalidValue("Snapshot objects are not ordered by hash")
            }
            previous = hash
            guard seen.insert(hash).inserted else {
                throw ProtocolValidationError.invalidValue("Snapshot contains a duplicate object")
            }
            return ProtocolObjectEnvelope(hash: hash, bytes: bytes)
        }
        let snapshot = ProtocolSnapshot(root: root, objects: objects)
        _ = try ProtocolObjectGraph.validate(snapshot, mode: mode)
        return snapshot
    }
}

public enum ProtocolObjectGraph {
    /// How much of a graph a snapshot must carry.
    ///
    /// - `complete`: every hash reachable from the root has an object.
    /// - `sparseFiles`: the root must be a present directory; a reachable hash
    ///   with no object is allowed and is taken to be a file whose bytes are
    ///   resolvable elsewhere; an object that is not reachable is still rejected,
    ///   as is a cycle. Used for daemon bootstraps and locally sparsified bundles.
    public enum ValidationMode: Sendable, Equatable {
        case complete
        case sparseFiles
    }

    @discardableResult
    public static func validate(
        _ snapshot: ProtocolSnapshot,
        mode: ValidationMode = .complete
    ) throws -> [String: ProtocolObject] {
        try validateObjectHash(snapshot.root)
        var bytesByHash: [String: Data] = [:]
        var objects: [String: ProtocolObject] = [:]
        for envelope in snapshot.objects {
            try validateObjectHash(envelope.hash)
            if let existing = bytesByHash[envelope.hash], existing != envelope.bytes {
                throw ProtocolValidationError.invalidValue("Duplicate hash has different bytes")
            }
            let actual = ProtocolObjectCodec.hash(envelope.bytes)
            guard actual == envelope.hash else {
                throw ProtocolValidationError.objectHashMismatch(expected: envelope.hash, actual: actual)
            }
            bytesByHash[envelope.hash] = envelope.bytes
        }
        var visiting = Set<String>()
        var visited = Set<String>()
        var kinds: [String: ProtocolEntryKind] = [:]
        func visit(_ hash: String, kind: ProtocolEntryKind) throws {
            if let prior = kinds[hash], prior != kind { throw ProtocolValidationError.invalidValue("Object kind conflict") }
            kinds[hash] = kind
            if visiting.contains(hash) { throw ProtocolValidationError.cyclicGraph(hash) }
            if visited.contains(hash) { return }
            guard let bytes = bytesByHash[hash] else {
                if mode == .sparseFiles && kind == .file { visited.insert(hash); return }
                throw ProtocolValidationError.incompleteGraph(hash)
            }
            let object = try ProtocolObjectCodec.decode(bytes, kind: kind)
            objects[hash] = object
            visiting.insert(hash)
            if case let .directory(entries, _) = object {
                for entry in entries {
                    if let child = entry.hash, let kind = entry.kind { try visit(child, kind: kind) }
                }
            }
            visiting.remove(hash)
            visited.insert(hash)
        }
        try visit(snapshot.root, kind: .directory)
        if let unreachable = Set(bytesByHash.keys).subtracting(visited).sorted().first {
            throw ProtocolValidationError.unreachableObject(unreachable)
        }
        return objects
    }
}

public extension ProtocolSnapshot {
    /// The bytes of the root directory's file entry `name`, verified against
    /// their hashes along that path; the rest of the graph is not revisited.
    func rootFile(named name: String) throws -> Data {
        guard case let .directory(entries, _) = try ProtocolObjectCodec.decode(verifiedBytes(root), kind: .directory),
              let hash = entries.first(where: { $0.name == name })?.file else {
            throw ProtocolValidationError.incompleteGraph(name)
        }
        return try verifiedBytes(hash)
    }

    func replacingRootFile(named name: String, with bytes: Data) throws -> ProtocolSnapshot {
        let objects = try ProtocolObjectGraph.validate(self)
        guard case let .directory(entries, childrenSource)? = objects[root],
              entries.contains(where: { $0.name == name && $0.hash != nil }) else {
            throw ProtocolValidationError.incompleteGraph(name)
        }
        let file = try ProtocolObjectCodec.object(.file(bytes))
        let nextEntries = entries.map { entry in
            entry.name == name ? ProtocolDirectoryEntry(name: name, file: file.hash) : entry
        }
        let nextRoot = try ProtocolObjectCodec.object(.directory(nextEntries, childrenSource: childrenSource))
        var bytesByHash = Dictionary(self.objects.map { ($0.hash, $0.bytes) }, uniquingKeysWith: { first, _ in first })
        bytesByHash[file.hash] = file.bytes
        bytesByHash[nextRoot.hash] = nextRoot.bytes
        // Every unchanged child was decoded by the validation above; walk those
        // decodings to keep exactly the objects the new root still reaches.
        var reachable: Set<String> = [nextRoot.hash, file.hash]
        func visit(_ hash: String) {
            guard reachable.insert(hash).inserted else { return }
            if case let .directory(children, _)? = objects[hash] {
                for child in children { if let childHash = child.hash { visit(childHash) } }
            }
        }
        for entry in entries where entry.name != name { if let hash = entry.hash { visit(hash) } }
        return ProtocolSnapshot(
            root: nextRoot.hash,
            objects: reachable.sorted().compactMap { hash in bytesByHash[hash].map { ProtocolObjectEnvelope(hash: hash, bytes: $0) } }
        )
    }

    private func verifiedBytes(_ hash: String) throws -> Data {
        guard let envelope = objects.first(where: { $0.hash == hash }) else {
            throw ProtocolValidationError.incompleteGraph(hash)
        }
        let actual = ProtocolObjectCodec.hash(envelope.bytes)
        guard actual == hash else { throw ProtocolValidationError.objectHashMismatch(expected: hash, actual: actual) }
        return envelope.bytes
    }
}
