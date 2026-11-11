import Foundation

/// Lossless semantic values. Operations validate against the closed protocol grammar before use.
public indirect enum ProtocolSemanticValue: Codable, Sendable, Equatable {
    case string(String), integer(Int), array([ProtocolSemanticValue]), object([String: ProtocolSemanticValue]), null
    /// Row values (spec 10 §4.1) also carry booleans and non-integer numbers.
    case bool(Bool), number(Double)

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let value = try? c.decode(String.self) { self = .string(value) }
        else if let value = try? c.decode(Bool.self) { self = .bool(value) }
        else if let value = try? c.decode(Int.self), abs(Double(value)) <= 9_007_199_254_740_991 { self = .integer(value) }
        else if let value = try? c.decode(Double.self), value.isFinite { self = .number(value) }
        else if let value = try? c.decode([ProtocolSemanticValue].self) { self = .array(value) }
        else { self = .object(try c.decode([String: ProtocolSemanticValue].self)) }
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .string(let v): try c.encode(v)
        case .integer(let v): try c.encode(v)
        case .array(let v): try c.encode(v)
        case .object(let v): try c.encode(v)
        case .null: try c.encodeNil()
        case .bool(let v): try c.encode(v)
        case .number(let v): try c.encode(v)
        }
    }
    var text: String? { if case .string(let s) = self { return s }; return nil }
    var number: Int? { if case .integer(let n) = self { return n }; return nil }
    var items: [ProtocolSemanticValue]? { if case .array(let a) = self { return a }; return nil }
    var fields: [String: ProtocolSemanticValue]? { if case .object(let o) = self { return o }; return nil }
    static func text(_ value: ProtocolSemanticValue?) throws -> String {
        guard let text = value?.text else { throw ProtocolValidationError.invalidValue("Expected text") }
        return text
    }
    static func items(_ value: ProtocolSemanticValue?) throws -> [ProtocolSemanticValue] {
        guard let items = value?.items else { throw ProtocolValidationError.invalidValue("Expected array") }
        return items
    }
    static func fields(_ value: ProtocolSemanticValue?) throws -> [String: ProtocolSemanticValue] {
        guard let fields = value?.fields else { throw ProtocolValidationError.invalidValue("Expected semantic object") }
        return fields
    }
    var cbor: CanonicalCBORValue {
        switch self {
        case .string(let v): .text(v)
        case .integer(let v): CanonicalCBORValue.integer(v)
        case .array(let v): .array(v.map(\.cbor))
        case .object(let v): .map(v.map { ($0.key, $0.value.cbor) })
        case .null: .null
        case .bool(let v): .bool(v)
        case .number(let v): .float(v)
        }
    }
}

/// An operation keeps its references in their in-memory form, `{ material:
/// { kind, … }, within?, range? }`; on the wire a reference is told apart by
/// its keys (tree operations §1.2.2): `{ path, object }`, `{ change,
/// operation }` or `{ update, conflict, alternative }`, with `within` and
/// `range` beside them. `wireFields` gives the operation as it travels, and
/// `init(wire:)` reads one. Its own Codable form is the in-memory one, for
/// local records.
public struct ProtocolSourceOperation: Codable, Sendable, Equatable {
    public let fields: [String: ProtocolSemanticValue]
    public var key: String { fields["key"]!.text! }
    public var kind: String { fields["kind"]!.text! }

    public init(_ fields: [String: ProtocolSemanticValue]) throws {
        try Self.validate(fields)
        self.fields = fields
    }
    /// An operation as it travels, its references flat.
    public init(wire: [String: ProtocolSemanticValue]) throws {
        _ = try ProtocolAuthoredRequestIntent.validateOperation(.object(wire))
        self.fields = Self.mapReferences(wire, Self.memoryReference)
    }
    /// This operation as it travels.
    public var wireFields: [String: ProtocolSemanticValue] { Self.mapReferences(fields, Self.wireReference) }

    /// A reference in its wire form; anything else as it is.
    static func wireReference(_ value: ProtocolSemanticValue) -> ProtocolSemanticValue {
        guard var reference = value.fields, let material = reference.removeValue(forKey: "material")?.fields else { return value }
        switch material["kind"]?.text {
        case "basis": reference["path"] = material["path"]; reference["object"] = material["object"]
        case "operation": reference["change"] = material["change"]; reference["operation"] = material["operation"]
        case "alternative": reference["update"] = material["state"]; reference["conflict"] = material["conflict"]; reference["alternative"] = material["alternative"]
        default: return value
        }
        return .object(reference)
    }
    /// A wire reference in its in-memory form; anything else as it is.
    static func memoryReference(_ value: ProtocolSemanticValue) -> ProtocolSemanticValue {
        guard var reference = value.fields, reference["material"] == nil else { return value }
        let material: [String: ProtocolSemanticValue]
        if let path = reference.removeValue(forKey: "path") {
            material = ["kind": .string("basis"), "path": path, "object": reference.removeValue(forKey: "object") ?? .null]
        } else if let change = reference.removeValue(forKey: "change") {
            material = ["kind": .string("operation"), "change": change, "operation": reference.removeValue(forKey: "operation") ?? .null]
        } else if let update = reference.removeValue(forKey: "update") {
            material = ["kind": .string("alternative"), "state": update, "conflict": reference.removeValue(forKey: "conflict") ?? .null,
                        "alternative": reference.removeValue(forKey: "alternative") ?? .null]
        } else { return value }
        reference["material"] = .object(material)
        return .object(reference)
    }
    /// `fields` with each reference an operation names passed through `convert`.
    static func mapReferences(_ fields: [String: ProtocolSemanticValue], _ convert: (ProtocolSemanticValue) -> ProtocolSemanticValue) -> [String: ProtocolSemanticValue] {
        var out = fields
        func map(_ key: String) { if let value = fields[key] { out[key] = convert(value) } }
        func destination() {
            guard var d = fields["destination"]?.fields else { return }
            if let parent = d["parent"] { d["parent"] = convert(parent) }
            out["destination"] = .object(d)
        }
        switch fields["kind"]?.text {
        case "editSource":
            map("source")
            if let lineage = fields["lineage"]?.items {
                out["lineage"] = .array(lineage.map { item in
                    guard var l = item.fields else { return item }
                    if let source = l["source"] { l["source"] = convert(source) }
                    return .object(l)
                })
            }
        case "moveSource", "copySource": map("source"); map("at")
        case "moveEntry", "copyEntry": map("source"); destination()
        case "removeEntry": map("source")
        case "replaceEntry":
            map("source")
            if let value = fields["value"]?.fields, value["file"] == nil, value["page"] == nil, value["directory"] == nil { map("value") }
        case "addEntry": destination()
        default:
            if fields["page"] != nil { map("page") } else if fields["collection"] != nil { map("collection") }
        }
        return out
    }
    public init(from decoder: Decoder) throws {
        try self.init(try decoder.singleValueContainer().decode([String: ProtocolSemanticValue].self))
    }
    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(fields)
    }
    var cbor: CanonicalCBORValue { ProtocolSemanticValue.object(fields).cbor }

    static func validID(_ s: String) -> Bool {
        !s.isEmpty && s.utf8.count <= 128 && s.utf8.allSatisfy { (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || $0 == 45 || $0 == 95 }
    }
    private static func validate(_ fields: [String: ProtocolSemanticValue]) throws {
        _ = try ProtocolAuthoredRequestIntent.validateOperation(.object(mapReferences(fields, wireReference)))
    }
}

struct ProtocolSemanticCodingKey: CodingKey {
    var stringValue: String
    var intValue: Int? { nil }
    init?(stringValue: String) { self.stringValue = stringValue }
    init?(intValue: Int) { return nil }
}
func validateSemanticFields(_ decoder: Decoder, allowed: Set<String>) throws {
    let keys = try decoder.container(keyedBy: ProtocolSemanticCodingKey.self).allKeys.map(\.stringValue)
    guard Set(keys).isSubset(of: allowed) else { throw ProtocolValidationError.invalidValue("Unknown update field") }
}
