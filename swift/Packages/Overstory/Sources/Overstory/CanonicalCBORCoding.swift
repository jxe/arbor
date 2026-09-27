import Foundation

/// How a request or response body travels (tree operations §4.4): JSON, or
/// the canonical CBOR of the same value with byte strings where JSON carries
/// padded base64. The Codable models serve both; only `Data` differs.
public enum ProtocolWireEncoding: Sendable, Equatable {
    case json
    case cbor

    /// The encoding a `Content-Type` names: CBOR for `application/cbor`,
    /// JSON for anything else, and for nothing (a record written before CBOR).
    public init(contentType: String?) {
        let mediaType = contentType?.split(separator: ";").first?.trimmingCharacters(in: .whitespaces).lowercased()
        self = mediaType == "application/cbor" ? .cbor : .json
    }

    /// The media type for `Content-Type` and `Accept`.
    public var mediaType: String { self == .cbor ? "application/cbor" : "application/json" }

    /// What a durable record keeps beside a body: `application/cbor`, or nil
    /// for JSON so that a record written before CBOR still reads as JSON.
    public var storedContentType: String? { self == .cbor ? "application/cbor" : nil }

    /// Encode a model as body bytes. JSON sorts its keys so a retry is
    /// byte-stable; CBOR is canonical, so it always is.
    public func encode<T: Encodable>(_ value: T) throws -> Data {
        switch self {
        case .json:
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.sortedKeys]
            return try encoder.encode(value)
        case .cbor:
            return try CanonicalCBOREncoder().encode(value)
        }
    }

    /// Decode body bytes as a model. CBOR must already be canonical.
    public func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        switch self {
        case .json: try JSONDecoder().decode(type, from: data)
        case .cbor: try CanonicalCBORDecoder().decode(type, from: data)
        }
    }
}

/// Encodes an `Encodable` value as canonical CBOR (§4.1): `Data` is a byte
/// string, integers and integral doubles in the safe 53-bit range are CBOR
/// integers, other finite numbers are 64-bit floats, and map keys are sorted
/// by their encoded bytes. `nil` passed to `encode` is CBOR null; an omitted
/// optional is absent, as in JSON.
public struct CanonicalCBOREncoder: Sendable {
    public init() {}

    public func encode<T: Encodable>(_ value: T) throws -> Data {
        CanonicalCBOR.encode(try CBOREncodingNode.box(value, codingPath: []).materialize())
    }
}

/// Decodes canonical CBOR into a `Decodable` value. The bytes must be one
/// canonical value; a byte string decodes only as `Data` and text never does,
/// so base64 text where bytes belong is refused.
public struct CanonicalCBORDecoder: Sendable {
    public init() {}

    public func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        try CBORValueDecoder.unbox(CanonicalCBOR.decode(Data(data)), as: type, codingPath: [])
    }
}

/// The one reader of a bytes field (tree operations §4.4): a CBOR byte string
/// from the CBOR decoder, or canonical padded base64 text from JSON.
func decodeProtocolBytes<Key: CodingKey>(
    _ values: KeyedDecodingContainer<Key>,
    forKey key: Key,
    from decoder: any Decoder,
    invalid message: String
) throws -> Data {
    if decoder is CBORValueDecoder { return try values.decode(Data.self, forKey: key) }
    let text = try values.decode(String.self, forKey: key)
    guard let bytes = Data(base64Encoded: text), bytes.base64EncodedString() == text else {
        throw ProtocolValidationError.invalidValue(message)
    }
    return bytes
}

private struct CBORCodingKey: CodingKey {
    var stringValue: String
    var intValue: Int?
    init(stringValue: String) { self.stringValue = stringValue; self.intValue = nil }
    init(intValue: Int) { self.stringValue = String(intValue); self.intValue = intValue }
    static let superKey = CBORCodingKey(stringValue: "super")
}

// MARK: Encoding

/// One value under construction: a scalar, a map, or an array. A map keeps
/// its first-insertion order; canonical encoding sorts it.
private final class CBOREncodingNode {
    var scalar: CanonicalCBORValue?
    var entries: [(key: String, node: CBOREncodingNode)]?
    var items: [CBOREncodingNode]?

    init() {}
    init(_ scalar: CanonicalCBORValue) { self.scalar = scalar }

    func materialize() throws -> CanonicalCBORValue {
        if let entries { return .map(try entries.map { ($0.key, try $0.node.materialize()) }) }
        if let items { return .array(try items.map { try $0.materialize() }) }
        // An encoder that asked for nothing encodes an empty map, as JSON's `{}`.
        return scalar ?? .map([])
    }

    func set(_ key: String, _ node: CBOREncodingNode) {
        if entries == nil { entries = [] }
        if let index = entries!.firstIndex(where: { $0.key == key }) { entries![index].node = node }
        else { entries!.append((key, node)) }
    }

    func adopt(_ other: CBOREncodingNode) {
        scalar = other.scalar
        entries = other.entries
        items = other.items
    }

    static func number(_ value: Double, codingPath: [any CodingKey]) throws -> CanonicalCBORValue {
        guard value.isFinite else {
            throw EncodingError.invalidValue(value, .init(codingPath: codingPath, debugDescription: "Non-finite numbers have no canonical CBOR encoding"))
        }
        // As JSON numbers do in JavaScript: an integral value in the safe range is an integer.
        if value.rounded() == value, abs(value) <= 9_007_199_254_740_991 {
            return .integer(Int(value))
        }
        return .float(value)
    }

    static func integer<I: BinaryInteger>(_ value: I, codingPath: [any CodingKey]) throws -> CanonicalCBORValue {
        guard let exact = Int(exactly: value) else {
            throw EncodingError.invalidValue(value, .init(codingPath: codingPath, debugDescription: "Integer exceeds the CBOR subset"))
        }
        return .integer(exact)
    }

    /// Box one value: scalars directly, anything else by its own `encode(to:)`.
    static func box<T: Encodable>(_ value: T, codingPath: [any CodingKey]) throws -> CBOREncodingNode {
        switch value {
        case let data as Data: return CBOREncodingNode(.bytes(data))
        case let string as String: return CBOREncodingNode(.text(string))
        case let flag as Bool: return CBOREncodingNode(.bool(flag))
        case let number as Double: return CBOREncodingNode(try Self.number(number, codingPath: codingPath))
        case let number as Float: return CBOREncodingNode(try Self.number(Double(number), codingPath: codingPath))
        case let number as Int: return CBOREncodingNode(.integer(number))
        case let number as Int8: return CBOREncodingNode(try Self.integer(number, codingPath: codingPath))
        case let number as Int16: return CBOREncodingNode(try Self.integer(number, codingPath: codingPath))
        case let number as Int32: return CBOREncodingNode(try Self.integer(number, codingPath: codingPath))
        case let number as Int64: return CBOREncodingNode(try Self.integer(number, codingPath: codingPath))
        case let number as UInt: return CBOREncodingNode(try Self.integer(number, codingPath: codingPath))
        case let number as UInt8: return CBOREncodingNode(try Self.integer(number, codingPath: codingPath))
        case let number as UInt16: return CBOREncodingNode(try Self.integer(number, codingPath: codingPath))
        case let number as UInt32: return CBOREncodingNode(try Self.integer(number, codingPath: codingPath))
        case let number as UInt64: return CBOREncodingNode(try Self.integer(number, codingPath: codingPath))
        // As JSONEncoder spells a URL: its absolute string.
        case let url as URL: return CBOREncodingNode(.text(url.absoluteString))
        default:
            let node = CBOREncodingNode()
            try value.encode(to: CBORValueEncoder(node: node, codingPath: codingPath))
            return node
        }
    }
}

private final class CBORValueEncoder: Encoder {
    let node: CBOREncodingNode
    let codingPath: [any CodingKey]
    var userInfo: [CodingUserInfoKey: Any] { [:] }

    init(node: CBOREncodingNode, codingPath: [any CodingKey]) {
        self.node = node
        self.codingPath = codingPath
    }

    func container<Key: CodingKey>(keyedBy _: Key.Type) -> KeyedEncodingContainer<Key> {
        // Two keyed containers on one encoder (a model encoding a nested
        // model's fields beside its own) share one map.
        if node.entries == nil { node.entries = [] }
        return KeyedEncodingContainer(CBORKeyedEncodingContainer<Key>(node: node, codingPath: codingPath))
    }

    func unkeyedContainer() -> any UnkeyedEncodingContainer {
        if node.items == nil { node.items = [] }
        return CBORUnkeyedEncodingContainer(node: node, codingPath: codingPath)
    }

    func singleValueContainer() -> any SingleValueEncodingContainer {
        CBORSingleValueEncodingContainer(node: node, codingPath: codingPath)
    }
}

private struct CBORKeyedEncodingContainer<Key: CodingKey>: KeyedEncodingContainerProtocol {
    let node: CBOREncodingNode
    let codingPath: [any CodingKey]

    private func put<T: Encodable>(_ value: T, _ key: Key) throws {
        node.set(key.stringValue, try CBOREncodingNode.box(value, codingPath: codingPath + [key]))
    }

    mutating func encodeNil(forKey key: Key) throws { node.set(key.stringValue, CBOREncodingNode(.null)) }
    mutating func encode(_ value: Bool, forKey key: Key) throws { try put(value, key) }
    mutating func encode(_ value: String, forKey key: Key) throws { try put(value, key) }
    mutating func encode(_ value: Double, forKey key: Key) throws { try put(value, key) }
    mutating func encode(_ value: Float, forKey key: Key) throws { try put(value, key) }
    mutating func encode(_ value: Int, forKey key: Key) throws { try put(value, key) }
    mutating func encode(_ value: Int8, forKey key: Key) throws { try put(value, key) }
    mutating func encode(_ value: Int16, forKey key: Key) throws { try put(value, key) }
    mutating func encode(_ value: Int32, forKey key: Key) throws { try put(value, key) }
    mutating func encode(_ value: Int64, forKey key: Key) throws { try put(value, key) }
    mutating func encode(_ value: UInt, forKey key: Key) throws { try put(value, key) }
    mutating func encode(_ value: UInt8, forKey key: Key) throws { try put(value, key) }
    mutating func encode(_ value: UInt16, forKey key: Key) throws { try put(value, key) }
    mutating func encode(_ value: UInt32, forKey key: Key) throws { try put(value, key) }
    mutating func encode(_ value: UInt64, forKey key: Key) throws { try put(value, key) }
    mutating func encode<T: Encodable>(_ value: T, forKey key: Key) throws { try put(value, key) }

    mutating func nestedContainer<NestedKey: CodingKey>(keyedBy _: NestedKey.Type, forKey key: Key) -> KeyedEncodingContainer<NestedKey> {
        let child = CBOREncodingNode()
        child.entries = []
        node.set(key.stringValue, child)
        return KeyedEncodingContainer(CBORKeyedEncodingContainer<NestedKey>(node: child, codingPath: codingPath + [key]))
    }

    mutating func nestedUnkeyedContainer(forKey key: Key) -> any UnkeyedEncodingContainer {
        let child = CBOREncodingNode()
        child.items = []
        node.set(key.stringValue, child)
        return CBORUnkeyedEncodingContainer(node: child, codingPath: codingPath + [key])
    }

    mutating func superEncoder() -> any Encoder {
        let child = CBOREncodingNode()
        node.set(CBORCodingKey.superKey.stringValue, child)
        return CBORValueEncoder(node: child, codingPath: codingPath + [CBORCodingKey.superKey])
    }

    mutating func superEncoder(forKey key: Key) -> any Encoder {
        let child = CBOREncodingNode()
        node.set(key.stringValue, child)
        return CBORValueEncoder(node: child, codingPath: codingPath + [key])
    }
}

private struct CBORUnkeyedEncodingContainer: UnkeyedEncodingContainer {
    let node: CBOREncodingNode
    let codingPath: [any CodingKey]
    var count: Int { node.items?.count ?? 0 }

    private var nextKey: CBORCodingKey { CBORCodingKey(intValue: count) }

    private func append<T: Encodable>(_ value: T) throws {
        node.items!.append(try CBOREncodingNode.box(value, codingPath: codingPath + [nextKey]))
    }

    mutating func encodeNil() throws { node.items!.append(CBOREncodingNode(.null)) }
    mutating func encode(_ value: Bool) throws { try append(value) }
    mutating func encode(_ value: String) throws { try append(value) }
    mutating func encode(_ value: Double) throws { try append(value) }
    mutating func encode(_ value: Float) throws { try append(value) }
    mutating func encode(_ value: Int) throws { try append(value) }
    mutating func encode(_ value: Int8) throws { try append(value) }
    mutating func encode(_ value: Int16) throws { try append(value) }
    mutating func encode(_ value: Int32) throws { try append(value) }
    mutating func encode(_ value: Int64) throws { try append(value) }
    mutating func encode(_ value: UInt) throws { try append(value) }
    mutating func encode(_ value: UInt8) throws { try append(value) }
    mutating func encode(_ value: UInt16) throws { try append(value) }
    mutating func encode(_ value: UInt32) throws { try append(value) }
    mutating func encode(_ value: UInt64) throws { try append(value) }
    mutating func encode<T: Encodable>(_ value: T) throws { try append(value) }

    mutating func nestedContainer<NestedKey: CodingKey>(keyedBy _: NestedKey.Type) -> KeyedEncodingContainer<NestedKey> {
        let key = nextKey
        let child = CBOREncodingNode()
        child.entries = []
        node.items!.append(child)
        return KeyedEncodingContainer(CBORKeyedEncodingContainer<NestedKey>(node: child, codingPath: codingPath + [key]))
    }

    mutating func nestedUnkeyedContainer() -> any UnkeyedEncodingContainer {
        let key = nextKey
        let child = CBOREncodingNode()
        child.items = []
        node.items!.append(child)
        return CBORUnkeyedEncodingContainer(node: child, codingPath: codingPath + [key])
    }

    mutating func superEncoder() -> any Encoder {
        let key = nextKey
        let child = CBOREncodingNode()
        node.items!.append(child)
        return CBORValueEncoder(node: child, codingPath: codingPath + [key])
    }
}

private struct CBORSingleValueEncodingContainer: SingleValueEncodingContainer {
    let node: CBOREncodingNode
    let codingPath: [any CodingKey]

    private func assign<T: Encodable>(_ value: T) throws {
        node.adopt(try CBOREncodingNode.box(value, codingPath: codingPath))
    }

    mutating func encodeNil() throws { node.adopt(CBOREncodingNode(.null)) }
    mutating func encode(_ value: Bool) throws { try assign(value) }
    mutating func encode(_ value: String) throws { try assign(value) }
    mutating func encode(_ value: Double) throws { try assign(value) }
    mutating func encode(_ value: Float) throws { try assign(value) }
    mutating func encode(_ value: Int) throws { try assign(value) }
    mutating func encode(_ value: Int8) throws { try assign(value) }
    mutating func encode(_ value: Int16) throws { try assign(value) }
    mutating func encode(_ value: Int32) throws { try assign(value) }
    mutating func encode(_ value: Int64) throws { try assign(value) }
    mutating func encode(_ value: UInt) throws { try assign(value) }
    mutating func encode(_ value: UInt8) throws { try assign(value) }
    mutating func encode(_ value: UInt16) throws { try assign(value) }
    mutating func encode(_ value: UInt32) throws { try assign(value) }
    mutating func encode(_ value: UInt64) throws { try assign(value) }
    mutating func encode<T: Encodable>(_ value: T) throws { try assign(value) }
}

// MARK: Decoding

/// Decodes a `Decodable` from one canonical CBOR value. Also the marker
/// `decodeProtocolBytes` checks to read bytes as a byte string.
final class CBORValueDecoder: Decoder {
    let value: CanonicalCBORValue
    let codingPath: [any CodingKey]
    var userInfo: [CodingUserInfoKey: Any] { [:] }

    init(value: CanonicalCBORValue, codingPath: [any CodingKey]) {
        self.value = value
        self.codingPath = codingPath
    }

    func container<Key: CodingKey>(keyedBy _: Key.Type) throws -> KeyedDecodingContainer<Key> {
        guard case let .map(entries) = value else { throw Self.mismatch([String: Any].self, value, codingPath) }
        return KeyedDecodingContainer(CBORKeyedDecodingContainer<Key>(entries: entries, codingPath: codingPath))
    }

    func unkeyedContainer() throws -> any UnkeyedDecodingContainer {
        guard case let .array(items) = value else { throw Self.mismatch([Any].self, value, codingPath) }
        return CBORUnkeyedDecodingContainer(items: items, codingPath: codingPath)
    }

    func singleValueContainer() throws -> any SingleValueDecodingContainer {
        CBORSingleValueDecodingContainer(value: value, codingPath: codingPath)
    }

    static func mismatch(_ type: Any.Type, _ value: CanonicalCBORValue, _ codingPath: [any CodingKey]) -> DecodingError {
        .typeMismatch(type, .init(codingPath: codingPath, debugDescription: "Expected \(type), found CBOR \(describe(value))"))
    }

    private static func describe(_ value: CanonicalCBORValue) -> String {
        switch value {
        case .null: "null"
        case .bool: "boolean"
        case .unsigned, .negative: "integer"
        case .float: "float"
        case .bytes: "byte string"
        case .text: "text"
        case .array: "array"
        case .map: "map"
        }
    }

    private static func integer<I: FixedWidthInteger>(_ value: CanonicalCBORValue, as type: I.Type, codingPath: [any CodingKey]) throws -> I {
        let result: I?
        switch value {
        case let .unsigned(number): result = I(exactly: number)
        case let .negative(number): result = I(exactly: -1 - number)
        default: throw mismatch(type, value, codingPath)
        }
        guard let result else {
            throw DecodingError.dataCorrupted(.init(codingPath: codingPath, debugDescription: "CBOR integer does not fit \(type)"))
        }
        return result
    }

    private static func double(_ value: CanonicalCBORValue, codingPath: [any CodingKey]) throws -> Double {
        switch value {
        case let .unsigned(number): Double(number)
        case let .negative(number): Double(-1 - number)
        case let .float(number): number
        default: throw mismatch(Double.self, value, codingPath)
        }
    }

    /// Unbox one value: scalars directly, anything else by its own `init(from:)`.
    static func unbox<T: Decodable>(_ value: CanonicalCBORValue, as type: T.Type, codingPath: [any CodingKey]) throws -> T {
        if type == Data.self {
            guard case let .bytes(bytes) = value else { throw mismatch(Data.self, value, codingPath) }
            return bytes as! T
        }
        if type == String.self {
            guard case let .text(text) = value else { throw mismatch(String.self, value, codingPath) }
            return text as! T
        }
        if type == Bool.self {
            guard case let .bool(flag) = value else { throw mismatch(Bool.self, value, codingPath) }
            return flag as! T
        }
        if type == Double.self { return try double(value, codingPath: codingPath) as! T }
        if type == Float.self { return Float(try double(value, codingPath: codingPath)) as! T }
        if type == Int.self { return try integer(value, as: Int.self, codingPath: codingPath) as! T }
        if type == Int8.self { return try integer(value, as: Int8.self, codingPath: codingPath) as! T }
        if type == Int16.self { return try integer(value, as: Int16.self, codingPath: codingPath) as! T }
        if type == Int32.self { return try integer(value, as: Int32.self, codingPath: codingPath) as! T }
        if type == Int64.self { return try integer(value, as: Int64.self, codingPath: codingPath) as! T }
        if type == UInt.self { return try integer(value, as: UInt.self, codingPath: codingPath) as! T }
        if type == UInt8.self { return try integer(value, as: UInt8.self, codingPath: codingPath) as! T }
        if type == UInt16.self { return try integer(value, as: UInt16.self, codingPath: codingPath) as! T }
        if type == UInt32.self { return try integer(value, as: UInt32.self, codingPath: codingPath) as! T }
        if type == UInt64.self { return try integer(value, as: UInt64.self, codingPath: codingPath) as! T }
        if type == URL.self {
            guard case let .text(text) = value, let url = URL(string: text) else { throw mismatch(URL.self, value, codingPath) }
            return url as! T
        }
        return try T(from: CBORValueDecoder(value: value, codingPath: codingPath))
    }
}

private struct CBORKeyedDecodingContainer<Key: CodingKey>: KeyedDecodingContainerProtocol {
    let values: [String: CanonicalCBORValue]
    let keys: [String]
    let codingPath: [any CodingKey]

    init(entries: [(String, CanonicalCBORValue)], codingPath: [any CodingKey]) {
        // Canonical CBOR has no duplicate keys, so the dictionary loses nothing.
        values = Dictionary(entries, uniquingKeysWith: { first, _ in first })
        keys = entries.map { $0.0 }
        self.codingPath = codingPath
    }

    var allKeys: [Key] { keys.compactMap { Key(stringValue: $0) } }

    func contains(_ key: Key) -> Bool { values[key.stringValue] != nil }

    private func value(_ key: Key) throws -> CanonicalCBORValue {
        guard let value = values[key.stringValue] else {
            throw DecodingError.keyNotFound(key, .init(codingPath: codingPath, debugDescription: "No value for \(key.stringValue)"))
        }
        return value
    }

    private func take<T: Decodable>(_ type: T.Type, _ key: Key) throws -> T {
        try CBORValueDecoder.unbox(try value(key), as: type, codingPath: codingPath + [key])
    }

    func decodeNil(forKey key: Key) throws -> Bool { try value(key) == .null }
    func decode(_ type: Bool.Type, forKey key: Key) throws -> Bool { try take(type, key) }
    func decode(_ type: String.Type, forKey key: Key) throws -> String { try take(type, key) }
    func decode(_ type: Double.Type, forKey key: Key) throws -> Double { try take(type, key) }
    func decode(_ type: Float.Type, forKey key: Key) throws -> Float { try take(type, key) }
    func decode(_ type: Int.Type, forKey key: Key) throws -> Int { try take(type, key) }
    func decode(_ type: Int8.Type, forKey key: Key) throws -> Int8 { try take(type, key) }
    func decode(_ type: Int16.Type, forKey key: Key) throws -> Int16 { try take(type, key) }
    func decode(_ type: Int32.Type, forKey key: Key) throws -> Int32 { try take(type, key) }
    func decode(_ type: Int64.Type, forKey key: Key) throws -> Int64 { try take(type, key) }
    func decode(_ type: UInt.Type, forKey key: Key) throws -> UInt { try take(type, key) }
    func decode(_ type: UInt8.Type, forKey key: Key) throws -> UInt8 { try take(type, key) }
    func decode(_ type: UInt16.Type, forKey key: Key) throws -> UInt16 { try take(type, key) }
    func decode(_ type: UInt32.Type, forKey key: Key) throws -> UInt32 { try take(type, key) }
    func decode(_ type: UInt64.Type, forKey key: Key) throws -> UInt64 { try take(type, key) }
    func decode<T: Decodable>(_ type: T.Type, forKey key: Key) throws -> T { try take(type, key) }

    func nestedContainer<NestedKey: CodingKey>(keyedBy type: NestedKey.Type, forKey key: Key) throws -> KeyedDecodingContainer<NestedKey> {
        try CBORValueDecoder(value: try value(key), codingPath: codingPath + [key]).container(keyedBy: type)
    }

    func nestedUnkeyedContainer(forKey key: Key) throws -> any UnkeyedDecodingContainer {
        try CBORValueDecoder(value: try value(key), codingPath: codingPath + [key]).unkeyedContainer()
    }

    func superDecoder() throws -> any Decoder {
        CBORValueDecoder(value: values[CBORCodingKey.superKey.stringValue] ?? .null, codingPath: codingPath + [CBORCodingKey.superKey])
    }

    func superDecoder(forKey key: Key) throws -> any Decoder {
        CBORValueDecoder(value: values[key.stringValue] ?? .null, codingPath: codingPath + [key])
    }
}

private struct CBORUnkeyedDecodingContainer: UnkeyedDecodingContainer {
    let items: [CanonicalCBORValue]
    let codingPath: [any CodingKey]
    private(set) var currentIndex = 0

    init(items: [CanonicalCBORValue], codingPath: [any CodingKey]) {
        self.items = items
        self.codingPath = codingPath
    }

    var count: Int? { items.count }
    var isAtEnd: Bool { currentIndex >= items.count }

    private mutating func next() throws -> (value: CanonicalCBORValue, path: [any CodingKey]) {
        guard !isAtEnd else {
            throw DecodingError.valueNotFound(Any.self, .init(codingPath: codingPath, debugDescription: "Unkeyed container is at its end"))
        }
        defer { currentIndex += 1 }
        return (items[currentIndex], codingPath + [CBORCodingKey(intValue: currentIndex)])
    }

    private mutating func take<T: Decodable>(_ type: T.Type) throws -> T {
        let (value, path) = try next()
        return try CBORValueDecoder.unbox(value, as: type, codingPath: path)
    }

    mutating func decodeNil() throws -> Bool {
        guard !isAtEnd, items[currentIndex] == .null else { return false }
        currentIndex += 1
        return true
    }
    mutating func decode(_ type: Bool.Type) throws -> Bool { try take(type) }
    mutating func decode(_ type: String.Type) throws -> String { try take(type) }
    mutating func decode(_ type: Double.Type) throws -> Double { try take(type) }
    mutating func decode(_ type: Float.Type) throws -> Float { try take(type) }
    mutating func decode(_ type: Int.Type) throws -> Int { try take(type) }
    mutating func decode(_ type: Int8.Type) throws -> Int8 { try take(type) }
    mutating func decode(_ type: Int16.Type) throws -> Int16 { try take(type) }
    mutating func decode(_ type: Int32.Type) throws -> Int32 { try take(type) }
    mutating func decode(_ type: Int64.Type) throws -> Int64 { try take(type) }
    mutating func decode(_ type: UInt.Type) throws -> UInt { try take(type) }
    mutating func decode(_ type: UInt8.Type) throws -> UInt8 { try take(type) }
    mutating func decode(_ type: UInt16.Type) throws -> UInt16 { try take(type) }
    mutating func decode(_ type: UInt32.Type) throws -> UInt32 { try take(type) }
    mutating func decode(_ type: UInt64.Type) throws -> UInt64 { try take(type) }
    mutating func decode<T: Decodable>(_ type: T.Type) throws -> T { try take(type) }

    mutating func nestedContainer<NestedKey: CodingKey>(keyedBy type: NestedKey.Type) throws -> KeyedDecodingContainer<NestedKey> {
        let (value, path) = try next()
        return try CBORValueDecoder(value: value, codingPath: path).container(keyedBy: type)
    }

    mutating func nestedUnkeyedContainer() throws -> any UnkeyedDecodingContainer {
        let (value, path) = try next()
        return try CBORValueDecoder(value: value, codingPath: path).unkeyedContainer()
    }

    mutating func superDecoder() throws -> any Decoder {
        let (value, path) = try next()
        return CBORValueDecoder(value: value, codingPath: path)
    }
}

private struct CBORSingleValueDecodingContainer: SingleValueDecodingContainer {
    let value: CanonicalCBORValue
    let codingPath: [any CodingKey]

    private func take<T: Decodable>(_ type: T.Type) throws -> T {
        try CBORValueDecoder.unbox(value, as: type, codingPath: codingPath)
    }

    func decodeNil() -> Bool { value == .null }
    func decode(_ type: Bool.Type) throws -> Bool { try take(type) }
    func decode(_ type: String.Type) throws -> String { try take(type) }
    func decode(_ type: Double.Type) throws -> Double { try take(type) }
    func decode(_ type: Float.Type) throws -> Float { try take(type) }
    func decode(_ type: Int.Type) throws -> Int { try take(type) }
    func decode(_ type: Int8.Type) throws -> Int8 { try take(type) }
    func decode(_ type: Int16.Type) throws -> Int16 { try take(type) }
    func decode(_ type: Int32.Type) throws -> Int32 { try take(type) }
    func decode(_ type: Int64.Type) throws -> Int64 { try take(type) }
    func decode(_ type: UInt.Type) throws -> UInt { try take(type) }
    func decode(_ type: UInt8.Type) throws -> UInt8 { try take(type) }
    func decode(_ type: UInt16.Type) throws -> UInt16 { try take(type) }
    func decode(_ type: UInt32.Type) throws -> UInt32 { try take(type) }
    func decode(_ type: UInt64.Type) throws -> UInt64 { try take(type) }
    func decode<T: Decodable>(_ type: T.Type) throws -> T { try take(type) }
}
