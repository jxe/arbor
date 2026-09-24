import Foundation

/// Lossless semantic values. Operations validate against the closed protocol grammar before use.
public indirect enum ProtocolSemanticValue: Codable, Sendable, Equatable {
    case string(String), integer(Int), array([ProtocolSemanticValue]), object([String: ProtocolSemanticValue]), null

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let value = try? c.decode(String.self) { self = .string(value) }
        else if let value = try? c.decode(Int.self), abs(Double(value)) <= 9_007_199_254_740_991 { self = .integer(value) }
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
        }
    }
}

public struct ProtocolSourceOperation: Codable, Sendable, Equatable {
    public let fields: [String: ProtocolSemanticValue]
    public var key: String { fields["key"]!.text! }
    public var kind: String { fields["kind"]!.text! }

    public init(_ fields: [String: ProtocolSemanticValue]) throws {
        try Self.validate(fields)
        self.fields = fields
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
        _ = try ProtocolAuthoredRequestIntent.validateOperation(.object(fields))
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
