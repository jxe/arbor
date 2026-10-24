import CryptoKit
import Foundation

/// One model's table in a directory's collection (spec 06 §2.1).
public struct ProtocolCollectionTableReference: Hashable, Codable, Sendable {
    public var model: String
    public var table: String

    public init(model: String, table: String) {
        self.model = model
        self.table = table
    }
}

/// A directory's logical collection: the fingerprint of its `schema.usl`
/// model layer and one `table` object per model with data rows, in UTF-8
/// order of model. The rows live in the tree; files and databases that hold
/// them on a device are projections.
public struct ProtocolCollectionReference: Hashable, Codable, Sendable {
    public var version: Int
    public var modelFingerprint: String
    public var tables: [ProtocolCollectionTableReference]

    public init(version: Int = 1, modelFingerprint: String, tables: [ProtocolCollectionTableReference]) {
        self.version = version
        self.modelFingerprint = modelFingerprint
        self.tables = tables
    }
}

/// A `table` object: its rows count and the `rows` chunks that hold them.
public struct ProtocolTable: Hashable, Codable, Sendable {
    public struct Chunk: Hashable, Codable, Sendable {
        public var rows: Int
        public var chunk: String

        public init(rows: Int, chunk: String) {
            self.rows = rows
            self.chunk = chunk
        }
    }

    public var rows: Int
    public var chunks: [Chunk]

    public init(rows: Int, chunks: [Chunk]) {
        self.rows = rows
        self.chunks = chunks
    }
}

/// What an object is, which its referrer says: an entry's file or directory,
/// or a collection's table or rows chunk.
public enum ProtocolObjectKind: String, Codable, Sendable { case file, directory, table, rows }

/// An entry's object is only ever a file or a directory.
public typealias ProtocolEntryKind = ProtocolObjectKind

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
    case directory([ProtocolDirectoryEntry], collection: ProtocolCollectionReference? = nil)
    case table(ProtocolTable)
    /// A `rows` chunk, checked for shape; its rows stay encoded.
    case rows(Data)
}

public enum ProtocolObjectCodec {
    public static func encode(_ object: ProtocolObject) throws -> Data {
        try validate(object)
        switch object {
        case let .file(bytes):
            return bytes
        case let .directory(entries, collection):
            return directoryBytes(entries, collection: collection)
        case let .table(table):
            return CanonicalCBOR.encode(tableValue(table))
        case let .rows(bytes):
            return bytes
        }
    }

    /// A directory object's canonical CBOR as given: entries in the order
    /// passed, nothing validated. `encode` validates first; a working tree
    /// that has already ordered its entries encodes with this directly.
    public static func directoryBytes(_ entries: [ProtocolDirectoryEntry], collection: ProtocolCollectionReference? = nil) -> Data {
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
        if let collection { fields.append(("collection", collectionValue(collection))) }
        return CanonicalCBOR.encode(.map(fields))
    }

    /// The objects an object of `kind` reaches directly: a directory's entries
    /// and then its collection's tables, a table's rows chunks. Files and rows
    /// reach nothing. Every walk of the object graph follows these edges.
    public static func references(_ bytes: Data, kind: ProtocolObjectKind) throws -> [(hash: String, kind: ProtocolObjectKind)] {
        switch kind {
        case .file, .rows:
            return []
        case .directory, .table:
            return try decode(bytes, kind: kind).references
        }
    }

    public static func decode(_ bytes: Data, kind: ProtocolObjectKind) throws -> ProtocolObject {
        switch kind {
        case .file: return .file(bytes)
        case .table: return .table(try decodeTable(bytes))
        case .rows: try checkRows(bytes); return .rows(bytes)
        case .directory: break
        }
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
            guard Set(values.keys).isSubset(of: ["type", "entries", "collection"]),
                  values.count == (values["collection"] == nil ? 2 : 3),
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
            let collection = try values["collection"].map(decodeCollection)
            object = .directory(decoded, collection: collection)
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

    private static func collectionValue(_ collection: ProtocolCollectionReference) -> CanonicalCBORValue {
        .map([
            ("version", .unsigned(collection.version)),
            ("modelFingerprint", .text(collection.modelFingerprint)),
            ("tables", .array(collection.tables.map { .map([("model", .text($0.model)), ("table", .text($0.table))]) })),
        ])
    }

    private static func decodeCollection(_ value: CanonicalCBORValue) throws -> ProtocolCollectionReference {
        guard case let .map(fields) = value else { throw ProtocolValidationError.invalidCBOR("Collection reference is not a map") }
        let item = Dictionary(uniqueKeysWithValues: fields)
        guard item.count == 3,
              case let .unsigned(version)? = item["version"],
              case let .text(modelFingerprint)? = item["modelFingerprint"],
              case let .array(values)? = item["tables"] else {
            throw ProtocolValidationError.invalidCBOR("Collection reference fields are invalid")
        }
        let tables = try values.map { value -> ProtocolCollectionTableReference in
            guard case let .map(fields) = value else { throw ProtocolValidationError.invalidCBOR("Collection table is not a map") }
            let entry = Dictionary(uniqueKeysWithValues: fields)
            guard entry.count == 2, case let .text(model)? = entry["model"], case let .text(table)? = entry["table"] else {
                throw ProtocolValidationError.invalidCBOR("Collection table fields are invalid")
            }
            return ProtocolCollectionTableReference(model: model, table: table)
        }
        return ProtocolCollectionReference(version: version, modelFingerprint: modelFingerprint, tables: tables)
    }

    private static func tableValue(_ table: ProtocolTable) -> CanonicalCBORValue {
        .map([
            ("type", .text("table")),
            ("rows", .unsigned(table.rows)),
            ("chunks", .array(table.chunks.map { .map([("rows", .unsigned($0.rows)), ("chunk", .text($0.chunk))]) })),
        ])
    }

    private static func decodeTable(_ bytes: Data) throws -> ProtocolTable {
        guard case let .map(fields) = try CanonicalCBOR.decode(bytes) else { throw ProtocolValidationError.invalidCBOR("Table object is not a map") }
        let item = Dictionary(uniqueKeysWithValues: fields)
        guard item.count == 3, case .text("table")? = item["type"],
              case let .unsigned(rows)? = item["rows"],
              case let .array(values)? = item["chunks"], !values.isEmpty else {
            throw ProtocolValidationError.invalidCBOR("Table object fields are invalid")
        }
        let chunks = try values.map { value -> ProtocolTable.Chunk in
            guard case let .map(fields) = value else { throw ProtocolValidationError.invalidCBOR("Table chunk is not a map") }
            let entry = Dictionary(uniqueKeysWithValues: fields)
            guard entry.count == 2, case let .unsigned(count)? = entry["rows"], case let .text(chunk)? = entry["chunk"] else {
                throw ProtocolValidationError.invalidCBOR("Table chunk fields are invalid")
            }
            try validateObjectHash(chunk)
            return ProtocolTable.Chunk(rows: count, chunk: chunk)
        }
        guard chunks.reduce(0, { $0 + $1.rows }) == rows else {
            throw ProtocolValidationError.invalidValue("A table's rows must equal the sum of its chunks'")
        }
        return ProtocolTable(rows: rows, chunks: chunks)
    }

    /// A `rows` object's shape: each row has exactly its key, fields, created
    /// and modified. Row order and values are the collection's to check.
    private static func checkRows(_ bytes: Data) throws {
        guard case let .map(fields) = try CanonicalCBOR.decode(bytes) else { throw ProtocolValidationError.invalidCBOR("Rows object is not a map") }
        let item = Dictionary(uniqueKeysWithValues: fields)
        guard item.count == 2, case .text("rows")? = item["type"], case let .array(rows)? = item["rows"] else {
            throw ProtocolValidationError.invalidCBOR("Rows object fields are invalid")
        }
        for row in rows {
            guard case let .map(fields) = row,
                  Set(fields.map { $0.0 }) == ["key", "fields", "created", "modified"], fields.count == 4 else {
                throw ProtocolValidationError.invalidCBOR("Row fields are invalid")
            }
        }
    }

    /// A model name: an ASCII letter or underscore, then letters, digits and underscores.
    private static func isModelName(_ name: String) -> Bool {
        guard let first = name.unicodeScalars.first, first.isASCII, CharacterSet.letters.contains(first) || first == "_" else { return false }
        return name.unicodeScalars.allSatisfy { $0.isASCII && (CharacterSet.alphanumerics.contains($0) || $0 == "_") }
    }

    private static func validate(_ object: ProtocolObject) throws {
        guard case let .directory(entries, collection) = object else { return }
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
        if let collection {
            guard collection.version == 1 else { throw ProtocolValidationError.invalidValue("Collection version must be 1") }
            try validateObjectHash(collection.modelFingerprint)
            var previousModel: Data?
            for table in collection.tables {
                let utf8 = Data(table.model.utf8)
                guard isModelName(table.model), previousModel.map({ $0.lexicographicallyPrecedes(utf8) }) ?? true else {
                    throw ProtocolValidationError.invalidValue("Collection tables must be model names in UTF-8 order, each once")
                }
                previousModel = utf8
                try validateObjectHash(table.table)
            }
            guard entries.contains(where: { $0.name == "schema.usl" && $0.file != nil }) else {
                throw ProtocolValidationError.invalidValue("A collection's schema.usl must be a file entry")
            }
        }
    }
}

public extension ProtocolObject {
    /// The objects this one reaches directly, as `ProtocolObjectCodec.references` gives them.
    var references: [(hash: String, kind: ProtocolObjectKind)] {
        switch self {
        case .file, .rows:
            return []
        case let .directory(entries, collection):
            var references: [(hash: String, kind: ProtocolObjectKind)] = []
            for entry in entries {
                if let hash = entry.hash, let kind = entry.kind { references.append((hash: hash, kind: kind)) }
            }
            for table in collection?.tables ?? [] { references.append((hash: table.table, kind: .table)) }
            return references
        case let .table(table):
            return table.chunks.map { (hash: $0.chunk, kind: ProtocolObjectKind.rows) }
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
        var kinds: [String: ProtocolObjectKind] = [:]
        func visit(_ hash: String, kind: ProtocolObjectKind) throws {
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
            for child in object.references { try visit(child.hash, kind: child.kind) }
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
        guard case let .directory(entries, collection)? = objects[root],
              entries.contains(where: { $0.name == name && $0.hash != nil }) else {
            throw ProtocolValidationError.incompleteGraph(name)
        }
        let file = try ProtocolObjectCodec.object(.file(bytes))
        let nextEntries = entries.map { entry in
            entry.name == name ? ProtocolDirectoryEntry(name: name, file: file.hash) : entry
        }
        let nextRoot = try ProtocolObjectCodec.object(.directory(nextEntries, collection: collection))
        var bytesByHash = Dictionary(self.objects.map { ($0.hash, $0.bytes) }, uniquingKeysWith: { first, _ in first })
        bytesByHash[file.hash] = file.bytes
        bytesByHash[nextRoot.hash] = nextRoot.bytes
        // Every unchanged child was decoded by the validation above; walk those
        // decodings to keep exactly the objects the new root still reaches.
        var reachable: Set<String> = [nextRoot.hash, file.hash]
        func visit(_ hash: String) {
            guard reachable.insert(hash).inserted else { return }
            for child in objects[hash]?.references ?? [] { visit(child.hash) }
        }
        for entry in entries where entry.name != name { if let hash = entry.hash { visit(hash) } }
        for table in collection?.tables ?? [] { visit(table.table) }
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
