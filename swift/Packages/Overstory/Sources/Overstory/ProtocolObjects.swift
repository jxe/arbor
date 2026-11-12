import CryptoKit
import Foundation

/// A directory's logical collection (collections §1, data model §5): the
/// fingerprint of its `schema.beetle` model layer and the head of its log.
/// The rows live in the tree as that log; files and databases that hold them
/// on a device are projections.
public struct ProtocolCollectionReference: Hashable, Codable, Sendable {
    public var version: Int
    public var modelFingerprint: String
    /// The log's head entry.
    public var log: String

    public init(version: Int = 2, modelFingerprint: String, log: String) {
        self.version = version
        self.modelFingerprint = modelFingerprint
        self.log = log
    }
}

/// One row of a collection (collections §2): its key as `[field, value]`
/// pairs in key order, its other fields, and when accepted changes made and last
/// changed it.
public struct ProtocolLogicalRow: Equatable, Sendable {
    public struct KeyPart: Equatable, Sendable {
        public var field: String
        public var value: ProtocolReadValue

        public init(field: String, value: ProtocolReadValue) {
            self.field = field
            self.value = value
        }
    }

    public var key: [KeyPart]
    public var fields: [String: ProtocolReadValue]
    /// Unix milliseconds in UTC, like a file or page entry's times (collections §2).
    public var created: Int
    public var modified: Int

    public init(key: [KeyPart], fields: [String: ProtocolReadValue], created: Int, modified: Int) {
        self.key = key
        self.fields = fields
        self.created = created
        self.modified = modified
    }
}

/// One row an accepted update changed: its whole new form, or nil when it was removed.
public struct ProtocolRowChange: Equatable, Sendable {
    public var model: String
    public var key: [ProtocolLogicalRow.KeyPart]
    public var row: ProtocolLogicalRow?

    public init(model: String, key: [ProtocolLogicalRow.KeyPart], row: ProtocolLogicalRow?) {
        self.model = model
        self.key = key
        self.row = row
    }
}

/// A `log` object (collections §1): one entry of a collection's log. It names
/// the entry before it and holds either the rows one accepted update changed
/// or a snapshot, a SQLite file of every row; either way it carries the row
/// count and rows hash after it. Story only reads logs the host accepted; it
/// never writes one.
public struct ProtocolLog: Hashable, Sendable {
    public enum Body: Equatable, Sendable {
        case changes([ProtocolRowChange])
        /// The snapshot's file object.
        case snapshot(String)
    }

    /// The entry before this one; nil only for a log's first entry.
    public var previous: String?
    /// The row count after this entry.
    public var rows: Int
    /// The rows hash after this entry.
    public var rowsHash: String
    public var body: Body
    /// The exact bytes this entry was decoded from. A row's Date values read as
    /// text, so re-encoding the decoded form would drop their tags; `encode`
    /// gives these bytes back instead.
    var encoded: Data?

    public init(previous: String?, rows: Int, rowsHash: String, body: Body) {
        self.previous = previous
        self.rows = rows
        self.rowsHash = rowsHash
        self.body = body
    }

    public var snapshot: String? { if case let .snapshot(file) = body { file } else { nil } }
    public var changes: [ProtocolRowChange] { if case let .changes(changes) = body { changes } else { [] } }

    public static func == (a: ProtocolLog, b: ProtocolLog) -> Bool {
        a.previous == b.previous && a.rows == b.rows && a.rowsHash == b.rowsHash && a.body == b.body
    }

    public func hash(into hasher: inout Hasher) {
        hasher.combine(previous)
        hasher.combine(rows)
        hasher.combine(rowsHash)
        hasher.combine(snapshot)
        hasher.combine(changes.count)
    }
}

/// What an object is, which its referrer says: an entry's file, page or
/// directory, or a collection's log entry.
public enum ProtocolObjectKind: String, Codable, Sendable {
    case file, page, directory, log
    /// Content reaches nothing: a file's bytes (a snapshot's SQLite file among them), a page.
    public var isContent: Bool { self == .file || self == .page }
}

/// An entry's object is only ever a file, a page or a directory.
public typealias ProtocolEntryKind = ProtocolObjectKind

public struct ProtocolDirectoryEntry: Hashable, Codable, Sendable {
    public var name: String
    public var file: String?
    /// A Markdown page held as logical state (directory format §3).
    public var page: String?
    public var directory: String?
    public var tree: String?
    /// A file or page entry's times, Unix milliseconds in UTC (data model §6):
    /// when its content first appeared, and when it last changed. Directory
    /// and tree entries carry none.
    public var created: Int?
    public var modified: Int?
    public var hash: String? { file ?? page ?? directory }
    public var kind: ProtocolEntryKind? { file != nil ? .file : page != nil ? .page : directory != nil ? .directory : nil }
    /// Whether this entry holds content, so carries times.
    public var isContent: Bool { file != nil || page != nil }

    public init(name: String, file: String? = nil, directory: String? = nil, tree: String? = nil, page: String? = nil, created: Int? = nil, modified: Int? = nil) {
        self.name = name
        self.file = file
        self.page = page
        self.directory = directory
        self.tree = tree
        self.created = created
        self.modified = modified
    }

    /// The entry for `object` named `name`, stamped against the entry that was
    /// there before (data model §6): the same object keeps both times; changed
    /// content keeps the earlier `created` and is modified `at`; new content is
    /// created and modified `at`. `keep` keeps `previous`'s times whatever the
    /// object (a move or rename). `source`, a file date, is used when no later
    /// than `at`.
    public static func stamped(_ kind: ProtocolEntryKind, name: String, object: String, previous: ProtocolDirectoryEntry?, at: Int, keep: Bool = false, source: Int? = nil) -> ProtocolDirectoryEntry {
        precondition(kind == .file || kind == .page, "only file and page entries carry times")
        var entry = kind == .file ? ProtocolDirectoryEntry(name: name, file: object) : ProtocolDirectoryEntry(name: name, page: object)
        if let previous, previous.isContent, let created = previous.created, let modified = previous.modified,
           keep || previous.hash == object {
            entry.created = created
            entry.modified = modified
            return entry
        }
        let stamp = source.map { min($0, at) } ?? at
        let before = previous?.isContent == true ? previous?.created : nil
        entry.created = before.map { min($0, stamp) } ?? stamp
        entry.modified = stamp
        return entry
    }

    /// This entry without its times: what a comparison of content ignores.
    public var untimed: ProtocolDirectoryEntry {
        var entry = self
        entry.created = nil
        entry.modified = nil
        return entry
    }

    /// The entry for Markdown `bytes` named `name`: in a tree that holds pages
    /// (`pages`), the page they read as, else a file, as directory format §3
    /// reads them. `store` keeps an object's bytes and returns its hash.
    public static func markdown(name: String, bytes: Data, pages: Bool, store: (Data) throws -> String) rethrows -> ProtocolDirectoryEntry {
        if pages, ProtocolPage.isPageName(name), let page = ProtocolPage.parse(bytes), let encoded = try? page.encoded() {
            return ProtocolDirectoryEntry(name: name, page: try store(encoded))
        }
        return ProtocolDirectoryEntry(name: name, file: try store(bytes))
    }

    /// `markdown`, stamped against `previous` at `at` (`stamped`).
    public static func markdown(name: String, bytes: Data, pages: Bool, previous: ProtocolDirectoryEntry?, at: Int, source: Int? = nil, store: (Data) throws -> String) rethrows -> ProtocolDirectoryEntry {
        let entry = try markdown(name: name, bytes: bytes, pages: pages, store: store)
        return stamped(entry.kind!, name: name, object: entry.hash!, previous: previous, at: at, source: source)
    }
}

/// A typed in-memory interpretation. File bytes have no encoded wrapper;
/// directory entries, never payload sniffing, supply the interpretation.
public enum ProtocolObject: Hashable, Sendable {
    case file(Data)
    case page(ProtocolPage)
    case directory([ProtocolDirectoryEntry], collection: ProtocolCollectionReference? = nil)
    case log(ProtocolLog)
}

public enum ProtocolObjectCodec {
    public static func encode(_ object: ProtocolObject) throws -> Data {
        try validate(object)
        switch object {
        case let .file(bytes):
            return bytes
        case let .page(page):
            return try page.encoded()
        case let .directory(entries, collection):
            return directoryBytes(entries, collection: collection)
        case let .log(log):
            return log.encoded ?? CanonicalCBOR.encode(logValue(log))
        }
    }

    /// A directory object's canonical CBOR as given: entries in the order
    /// passed, nothing validated. `encode` validates first; a working tree
    /// that has already ordered its entries encodes with this directly.
    public static func directoryBytes(_ entries: [ProtocolDirectoryEntry], collection: ProtocolCollectionReference? = nil) -> Data {
        var fields: [(String, CanonicalCBORValue)] = [
            ("type", .text("directory")),
            ("entries", .array(entries.map { entry in
                var fields: [(String, CanonicalCBORValue)] = [
                    ("name", .text(entry.name)),
                    entry.file.map { ("file", .text($0)) }
                        ?? entry.page.map { ("page", .text($0)) }
                        ?? entry.directory.map { ("directory", .text($0)) }
                        ?? ("tree", .text(entry.tree!))
                ]
                if let created = entry.created { fields.append(("created", .integer(created))) }
                if let modified = entry.modified { fields.append(("modified", .integer(modified))) }
                return .map(fields)
            }))
        ]
        if let collection { fields.append(("collection", collectionValue(collection))) }
        return CanonicalCBOR.encode(.map(fields))
    }

    /// The objects an object of `kind` reaches directly: a directory's entries
    /// and then its collection's log head; a log entry the entry before it, or,
    /// for a snapshot entry, its file instead (collections §1.1). Files and
    /// pages reach nothing. Every walk of the object graph follows these edges.
    public static func references(_ bytes: Data, kind: ProtocolObjectKind) throws -> [(hash: String, kind: ProtocolObjectKind)] {
        switch kind {
        case .file, .page:
            return []
        case .directory, .log:
            return try decode(bytes, kind: kind).references
        }
    }

    public static func decode(_ bytes: Data, kind: ProtocolObjectKind) throws -> ProtocolObject {
        switch kind {
        case .file: return .file(bytes)
        case .page: return .page(try ProtocolPage.decode(bytes))
        case .log: return .log(try decodeLog(bytes))
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
                let page = item["page"].flatMap { if case let .text(value) = $0 { value } else { nil } }
                let directory = item["directory"].flatMap { if case let .text(value) = $0 { value } else { nil } }
                let tree = item["tree"].flatMap { if case let .text(value) = $0 { value } else { nil } }
                let content = file != nil || page != nil
                guard item.count == (content ? 4 : 2), [file != nil, page != nil, directory != nil, tree != nil].filter({ $0 }).count == 1 else {
                    throw ProtocolValidationError.invalidCBOR("Directory entry target is invalid")
                }
                let created = content ? entryTime(item["created"]) : nil
                let modified = content ? entryTime(item["modified"]) : nil
                if content, created == nil || modified == nil {
                    throw ProtocolValidationError.invalidCBOR("Directory entry times are invalid")
                }
                return ProtocolDirectoryEntry(name: name, file: file, directory: directory, tree: tree, page: page, created: created, modified: modified)
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
        // Hex by table: this runs for every object a save touches, and
        // String(format:) per byte cost more than the hashing itself.
        let digits = Array("0123456789abcdef".utf8)
        var hex = Array("sha256:".utf8)
        hex.reserveCapacity(71)
        for byte in SHA256.hash(data: bytes) {
            hex.append(digits[Int(byte >> 4)])
            hex.append(digits[Int(byte & 0x0f)])
        }
        return String(decoding: hex, as: UTF8.self)
    }

    public static func object(_ object: ProtocolObject) throws -> ProtocolObjectEnvelope {
        let bytes = try encode(object)
        return ProtocolObjectEnvelope(hash: hash(bytes), bytes: bytes)
    }

    private static func collectionValue(_ collection: ProtocolCollectionReference) -> CanonicalCBORValue {
        .map([
            ("version", .unsigned(collection.version)),
            ("modelFingerprint", .text(collection.modelFingerprint)),
            ("log", .text(collection.log)),
        ])
    }

    private static func decodeCollection(_ value: CanonicalCBORValue) throws -> ProtocolCollectionReference {
        guard case let .map(fields) = value else { throw ProtocolValidationError.invalidCBOR("Collection reference is not a map") }
        let item = Dictionary(uniqueKeysWithValues: fields)
        guard item.count == 3,
              case let .unsigned(version)? = item["version"],
              case let .text(modelFingerprint)? = item["modelFingerprint"],
              case let .text(log)? = item["log"] else {
            throw ProtocolValidationError.invalidCBOR("Collection reference fields are invalid")
        }
        return ProtocolCollectionReference(version: version, modelFingerprint: modelFingerprint, log: log)
    }

    private static func logValue(_ log: ProtocolLog) -> CanonicalCBORValue {
        var fields: [(String, CanonicalCBORValue)] = [
            ("type", .text("log")),
            ("previous", log.previous.map { .text($0) } ?? .null),
            ("rows", .unsigned(log.rows)),
            ("rowsHash", .text(log.rowsHash)),
        ]
        switch log.body {
        case let .snapshot(file):
            fields.append(("snapshot", .text(file)))
        case let .changes(changes):
            fields.append(("changes", .array(changes.map { change in
                .map([
                    ("model", .text(change.model)),
                    ("key", keyValue(change.key)),
                    ("row", change.row.map(rowValue) ?? .null),
                ])
            })))
        }
        return .map(fields)
    }

    private static func keyValue(_ key: [ProtocolLogicalRow.KeyPart]) -> CanonicalCBORValue {
        .array(key.map { .array([.text($0.field), cborValue($0.value)]) })
    }

    private static func rowValue(_ row: ProtocolLogicalRow) -> CanonicalCBORValue {
        .map([
            ("key", keyValue(row.key)),
            ("fields", .map(row.fields.map { ($0.key, cborValue($0.value)) })),
            ("created", .integer(row.created)),
            ("modified", .integer(row.modified)),
        ])
    }

    /// A row value as canonical CBOR. A Date read as text stays text: only an
    /// entry decoded from bytes keeps its tags (`ProtocolLog.encoded`).
    private static func cborValue(_ value: ProtocolReadValue) -> CanonicalCBORValue {
        switch value {
        case .null: return .null
        case let .bool(flag): return .bool(flag)
        case let .number(n): return n.rounded() == n && abs(n) <= 9_007_199_254_740_991 ? .integer(Int(n)) : .float(n)
        case let .string(text): return .text(text)
        case let .array(items): return .array(items.map(cborValue))
        case let .object(members): return .map(members.map { ($0.key, cborValue($0.value)) })
        }
    }

    /// A `log` object, decoded strictly (collections §1): exactly its type,
    /// previous, rows, rowsHash and one of changes or snapshot; changes in
    /// model then stable-key order, each row once, each set row's key its own.
    public static func decodeLog(_ bytes: Data) throws -> ProtocolLog {
        guard case let .map(fields) = try CanonicalCBOR.decode(bytes, tags: [0, 1004]) else {
            throw ProtocolValidationError.invalidCBOR("Log object is not a map")
        }
        let item = Dictionary(uniqueKeysWithValues: fields)
        let body = item["changes"] != nil ? "changes" : "snapshot"
        guard Set(item.keys) == ["type", "previous", "rows", "rowsHash", body], case .text("log")? = item["type"],
              case let .unsigned(rows)? = item["rows"], isEntryTime(rows),
              case let .text(rowsHash)? = item["rowsHash"] else {
            throw ProtocolValidationError.invalidCBOR("Log object fields are invalid")
        }
        try validateObjectHash(rowsHash)
        let previous: String?
        switch item["previous"] {
        case .null?: previous = nil
        case let .text(hash)?: try validateObjectHash(hash); previous = hash
        default: throw ProtocolValidationError.invalidCBOR("A log's previous must be a hash or null")
        }
        var log: ProtocolLog
        if body == "snapshot" {
            guard case let .text(file)? = item["snapshot"] else { throw ProtocolValidationError.invalidCBOR("A log's snapshot must be a hash") }
            try validateObjectHash(file)
            log = ProtocolLog(previous: previous, rows: rows, rowsHash: rowsHash, body: .snapshot(file))
        } else {
            guard case let .array(values)? = item["changes"] else { throw ProtocolValidationError.invalidCBOR("A log's changes must be an array") }
            var order: [(model: Data, key: Data)] = []
            let changes = try values.map { value -> ProtocolRowChange in
                guard case let .map(fields) = value, fields.count == 3 else { throw ProtocolValidationError.invalidCBOR("A log change must be a map") }
                let change = Dictionary(uniqueKeysWithValues: fields)
                guard case let .text(model)? = change["model"], isModelName(model), let keyCBOR = change["key"], let rowCBOR = change["row"] else {
                    throw ProtocolValidationError.invalidCBOR("A log change's fields are invalid")
                }
                let key = try decodeKey(keyCBOR)
                let row: ProtocolLogicalRow?
                if case .null = rowCBOR { row = nil } else {
                    guard case let .map(rowFields) = rowCBOR else { throw ProtocolValidationError.invalidCBOR("A log change's row must be a map") }
                    row = try decodeRow(rowFields)
                    guard case let .map(own) = rowCBOR, own.first(where: { $0.0 == "key" })?.1 == keyCBOR else {
                        throw ProtocolValidationError.invalidCBOR("A log change's key must be its row's key")
                    }
                }
                order.append((Data(model.utf8), Data(stableKey(keyCBOR).utf8)))
                return ProtocolRowChange(model: model, key: key, row: row)
            }
            for (a, b) in zip(order, order.dropFirst()) {
                let ascending = a.model == b.model ? a.key.lexicographicallyPrecedes(b.key) : a.model.lexicographicallyPrecedes(b.model)
                guard ascending else { throw ProtocolValidationError.invalidCBOR("A log's changes must be in model, then stable-key order, each row once") }
            }
            log = ProtocolLog(previous: previous, rows: rows, rowsHash: rowsHash, body: .changes(changes))
        }
        log.encoded = bytes
        return log
    }

    /// A row's stable key: the canonical JSON of its key pairs, a tagged Date as its text.
    private static func stableKey(_ value: CanonicalCBORValue) -> String {
        func json(_ value: CanonicalCBORValue) -> Any {
            switch value {
            case .null: return NSNull()
            case let .bool(flag): return flag
            case let .unsigned(n): return n
            case let .negative(n): return -1 - n
            case let .float(n): return n
            case let .text(text): return text
            case let .tagged(_, inner): return json(inner)
            case let .array(items): return items.map(json)
            case let .map(entries): return Dictionary(entries.map { ($0.0, json($0.1)) }, uniquingKeysWith: { a, _ in a })
            case .bytes: return NSNull()
            }
        }
        let data = (try? JSONSerialization.data(withJSONObject: json(value), options: [.sortedKeys, .withoutEscapingSlashes, .fragmentsAllowed])) ?? Data()
        return String(decoding: data, as: UTF8.self)
    }

    private static func decodeKey(_ value: CanonicalCBORValue) throws -> [ProtocolLogicalRow.KeyPart] {
        guard case let .array(pairs) = value, !pairs.isEmpty else { throw ProtocolValidationError.invalidCBOR("A row's key must be a non-empty array") }
        var names = Set<String>()
        return try pairs.map { pair -> ProtocolLogicalRow.KeyPart in
            guard case let .array(part) = pair, part.count == 2, case let .text(field) = part[0], isModelName(field),
                  names.insert(field).inserted, part[1] != .null else {
                throw ProtocolValidationError.invalidCBOR("A row's key must be [field, value] pairs")
            }
            return .init(field: field, value: try readValue(part[1]))
        }
    }

    /// One row, decoded strictly: its key a list of `[field, value]` pairs,
    /// fields a map, and both times Unix milliseconds with created ≤ modified.
    /// Values are JSON values, except that a Date field's value is tagged (tag
    /// 1004 around a date, tag 0 around a UTC date-time) and reads as its text;
    /// anything else is refused.
    private static func decodeRow(_ fields: [(String, CanonicalCBORValue)]) throws -> ProtocolLogicalRow {
        guard Set(fields.map { $0.0 }) == ["key", "fields", "created", "modified"], fields.count == 4 else {
            throw ProtocolValidationError.invalidCBOR("Row fields are invalid")
        }
        let row = Dictionary(uniqueKeysWithValues: fields)
        guard let keyCBOR = row["key"], case let .map(values)? = row["fields"],
              let created = entryTime(row["created"]),
              let modified = entryTime(row["modified"]), created <= modified
        else { throw ProtocolValidationError.invalidCBOR("Row fields are invalid") }
        let key = try decodeKey(keyCBOR)
        var decoded: [String: ProtocolReadValue] = [:]
        for (name, value) in values {
            guard isModelName(name), !key.contains(where: { $0.field == name }), value != .null, value != .array([]) else {
                throw ProtocolValidationError.invalidCBOR("A row field is written only when it has a value")
            }
            decoded[name] = try readValue(value)
        }
        return ProtocolLogicalRow(key: key, fields: decoded, created: created, modified: modified)
    }

    private static func readValue(_ value: CanonicalCBORValue, depth: Int = 0) throws -> ProtocolReadValue {
        guard depth <= 32 else { throw ProtocolValidationError.invalidCBOR("A row value nests too deep") }
        switch value {
        case .null: return .null
        case let .bool(flag): return .bool(flag)
        case let .unsigned(n): return .number(Double(n))
        case let .negative(n): return .number(-1 - Double(n))
        case let .float(n):
            guard n.isFinite else { throw ProtocolValidationError.invalidCBOR("A row value must be finite") }
            return .number(n)
        case let .text(text): return .string(text)
        case let .array(items): return .array(try items.map { try readValue($0, depth: depth + 1) })
        case let .map(entries):
            var object: [String: ProtocolReadValue] = [:]
            for (name, item) in entries { object[name] = try readValue(item, depth: depth + 1) }
            return .object(object)
        case let .tagged(1004, .text(date)):
            guard ProtocolPage.validCanonicalDate(date) else { throw ProtocolValidationError.invalidCBOR("A tagged row date is invalid") }
            return .string(date)
        case let .tagged(0, .text(time)):
            guard ProtocolPage.validCanonicalDateTime(time) else { throw ProtocolValidationError.invalidCBOR("A tagged row date-time is invalid") }
            return .string(time)
        case .bytes, .tagged: throw ProtocolValidationError.invalidCBOR("A row value must be a JSON value")
        }
    }

    /// A model name: an ASCII letter or underscore, then letters, digits and underscores.
    private static func isModelName(_ name: String) -> Bool {
        guard let first = name.unicodeScalars.first, first.isASCII, CharacterSet.letters.contains(first) || first == "_" else { return false }
        return name.unicodeScalars.allSatisfy { $0.isASCII && (CharacterSet.alphanumerics.contains($0) || $0 == "_") }
    }

    /// Whether `value` can be an entry time: Unix milliseconds a JSON number holds exactly.
    public static func isEntryTime(_ value: Int) -> Bool { abs(value) <= 9_007_199_254_740_991 }

    /// An entry time from CBOR: an integer `isEntryTime` accepts, or nil.
    private static func entryTime(_ value: CanonicalCBORValue?) -> Int? {
        switch value {
        case let .unsigned(number)?: return isEntryTime(number) ? number : nil
        case let .negative(number)?: return isEntryTime(-1 - number) ? -1 - number : nil
        default: return nil
        }
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
            guard [entry.file != nil, entry.page != nil, entry.directory != nil, entry.tree != nil].filter({ $0 }).count == 1 else {
                throw ProtocolValidationError.invalidValue("Directory entry must have exactly one target")
            }
            if let hash = entry.hash { try validateObjectHash(hash) }
            if let tree = entry.tree, tree.isEmpty { throw ProtocolValidationError.invalidValue("Nested tree ID is empty") }
            if entry.isContent {
                guard let created = entry.created, let modified = entry.modified,
                      isEntryTime(created), isEntryTime(modified), created <= modified else {
                    throw ProtocolValidationError.invalidValue("A file or page entry carries created ≤ modified, in Unix milliseconds")
                }
            } else if entry.created != nil || entry.modified != nil {
                throw ProtocolValidationError.invalidValue("Only file and page entries carry times")
            }
        }
        if let collection {
            guard collection.version == 2 else { throw ProtocolValidationError.invalidValue("Collection version must be 2") }
            try validateObjectHash(collection.modelFingerprint)
            try validateObjectHash(collection.log)
            guard entries.contains(where: { $0.name == "schema.beetle" && $0.file != nil }) else {
                throw ProtocolValidationError.invalidValue("A collection's schema.beetle must be a file entry")
            }
        }
    }
}

public extension ProtocolObject {
    /// The objects this one reaches directly, as `ProtocolObjectCodec.references` gives them.
    var references: [(hash: String, kind: ProtocolObjectKind)] {
        switch self {
        case .file, .page:
            return []
        case let .directory(entries, collection):
            var references: [(hash: String, kind: ProtocolObjectKind)] = []
            for entry in entries {
                if let hash = entry.hash, let kind = entry.kind { references.append((hash: hash, kind: kind)) }
            }
            if let collection { references.append((hash: collection.log, kind: .log)) }
            return references
        case let .log(log):
            // A snapshot entry reaches its file, not the entries before it (collections §1.1).
            if let file = log.snapshot { return [(hash: file, kind: .file)] }
            return log.previous.map { [(hash: $0, kind: .log)] } ?? []
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

    /// A snapshot bundle: exactly `{ version: 1, objects }`, objects ordered by hash.
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
    /// Objects this process has already hashed and decoded. Bytes equal to
    /// bytes checked before have the same hash and decode the same way, so a
    /// graph that differs from one checked earlier by a page and its folders
    /// costs only those objects: a save on a large tree no longer re-hashes
    /// and re-decodes every object each time it is validated.
    static let verified = VerifiedObjects()
    /// How much of a graph a snapshot must carry.
    ///
    /// - `complete`: every hash reachable from the root has an object.
    /// - `sparseFiles`: the root must be a present directory; a reachable hash
    ///   with no object is allowed and is taken to be a file or page whose bytes are
    ///   resolvable elsewhere; an object that is not reachable is still rejected,
    ///   as is a cycle. Used for daemon bootstraps and locally sparsified bundles.
    /// - `lazyDirectories`: as `sparseFiles`, and a directory below the root may
    ///   be missing too: the lazy node index loads it, checked against its hash,
    ///   the first time a path below it is asked for.
    public enum ValidationMode: Sendable, Equatable {
        case complete
        case sparseFiles
        case lazyDirectories

        /// Whether a reachable object of `kind` may be missing from the graph.
        public func allowsMissing(_ kind: ProtocolObjectKind) -> Bool {
            switch self {
            case .complete: return false
            case .sparseFiles: return kind == .file || kind == .page
            case .lazyDirectories: return kind == .file || kind == .page || kind == .directory
            }
        }
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
            if !verified.holds(envelope.hash, envelope.bytes) {
                let actual = ProtocolObjectCodec.hash(envelope.bytes)
                guard actual == envelope.hash else {
                    throw ProtocolValidationError.objectHashMismatch(expected: envelope.hash, actual: actual)
                }
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
                if hash != snapshot.root && mode.allowsMissing(kind) { visited.insert(hash); return }
                throw ProtocolValidationError.incompleteGraph(hash)
            }
            let object: ProtocolObject
            if let known = verified.object(hash, kind: kind) { object = known }
            else {
                object = try ProtocolObjectCodec.decode(bytes, kind: kind)
                verified.insert(hash, bytes, kind: kind, object: object)
            }
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

public extension ProtocolObjectGraph {
    /// Whether any directory reachable from `root` holds a page entry: a
    /// placement reads Markdown as pages once the root it builds on does
    /// (directory format §3). Directories missing from `objects` hold none.
    static func holdsPages(_ root: String, in objects: [String: ProtocolObject]) -> Bool {
        var seen = Set<String>()
        func visit(_ hash: String) -> Bool {
            guard seen.insert(hash).inserted, case let .directory(entries, _)? = objects[hash] else { return false }
            if entries.contains(where: { $0.page != nil }) { return true }
            return entries.contains { entry in entry.directory.map(visit) ?? false }
        }
        return visit(root)
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

    /// This snapshot with its root file `name` holding `bytes`, stamped at `at` (Unix ms).
    func replacingRootFile(named name: String, with bytes: Data, at: Int) throws -> ProtocolSnapshot {
        let objects = try ProtocolObjectGraph.validate(self)
        guard case let .directory(entries, collection)? = objects[root],
              entries.contains(where: { $0.name == name && $0.hash != nil }) else {
            throw ProtocolValidationError.incompleteGraph(name)
        }
        let file = try ProtocolObjectCodec.object(.file(bytes))
        let nextEntries = entries.map { entry in
            entry.name == name ? ProtocolDirectoryEntry.stamped(.file, name: name, object: file.hash, previous: entry, at: at) : entry
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
        if let collection { visit(collection.log) }
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

/// A bounded memo for `ProtocolObjectGraph.validate`. It never vouches for
/// bytes it has not seen: a lookup matches only identical bytes. It forgets
/// everything when it grows past its bounds.
final class VerifiedObjects: @unchecked Sendable {
    private struct Entry {
        var bytes: Data
        var decoded: [ProtocolObjectKind: ProtocolObject]
    }
    private let lock = NSLock()
    private var entries: [String: Entry] = [:]
    private var size = 0
    private let maxCount = 50_000, maxBytes = 128 * 1024 * 1024

    func holds(_ hash: String, _ bytes: Data) -> Bool {
        lock.withLock { entries[hash].map { $0.bytes == bytes } ?? false }
    }

    /// The decoded object, for bytes `holds` has just matched.
    func object(_ hash: String, kind: ProtocolObjectKind) -> ProtocolObject? {
        lock.withLock { entries[hash]?.decoded[kind] }
    }

    /// Record `bytes`, which the caller has checked against `hash`.
    func insert(_ hash: String, _ bytes: Data, kind: ProtocolObjectKind, object: ProtocolObject) {
        lock.withLock {
            if entries[hash] == nil {
                if entries.count >= maxCount || size + bytes.count > maxBytes { entries.removeAll(); size = 0 }
                entries[hash] = Entry(bytes: bytes, decoded: [:])
                size += bytes.count
            }
            entries[hash]?.decoded[kind] = object
        }
    }
}
