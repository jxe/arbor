import Foundation

/// Lossless semantic values. Operations validate against the closed Wire grammar before use.
public indirect enum WireSemanticValue: Codable, Sendable, Equatable {
    case string(String), integer(Int), array([WireSemanticValue]), object([String: WireSemanticValue]), null

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let value = try? c.decode(String.self) { self = .string(value) }
        else if let value = try? c.decode(Int.self), abs(Double(value)) <= 9_007_199_254_740_991 { self = .integer(value) }
        else if let value = try? c.decode([WireSemanticValue].self) { self = .array(value) }
        else { self = .object(try c.decode([String: WireSemanticValue].self)) }
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
    var items: [WireSemanticValue]? { if case .array(let a) = self { return a }; return nil }
    var fields: [String: WireSemanticValue]? { if case .object(let o) = self { return o }; return nil }
    var cbor: CanonicalCBORValue {
        switch self {
        case .string(let v): .text(v)
        case .integer(let v): v >= 0 ? .unsigned(v) : .negative(v)
        case .array(let v): .array(v.map(\.cbor))
        case .object(let v): .map(v.map { ($0.key, $0.value.cbor) })
        case .null: .null
        }
    }
}

public struct WireSourceOperation: Codable, Sendable, Equatable {
    public let fields: [String: WireSemanticValue]
    public var key: String { fields["key"]!.text! }
    public var kind: String { fields["kind"]!.text! }

    public init(_ fields: [String: WireSemanticValue]) throws {
        try Self.validate(fields)
        self.fields = fields
    }
    public init(from decoder: Decoder) throws {
        try self.init(try decoder.singleValueContainer().decode([String: WireSemanticValue].self))
    }
    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(fields)
    }
    var cbor: CanonicalCBORValue { WireSemanticValue.object(fields).cbor }

    static func validID(_ s: String) -> Bool {
        !s.isEmpty && s.utf8.count <= 128 && s.utf8.allSatisfy { (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || $0 == 45 || $0 == 95 }
    }
    private static func require(_ condition: Bool) throws {
        guard condition else { throw ArborWireValidationError.invalidValue("Invalid semantic operation") }
    }
    private static func id(_ v: WireSemanticValue?) throws { try require(v?.text.map(validID) == true) }
    private static func keys(_ v: [String: WireSemanticValue], _ required: [String], _ optional: [String] = []) throws {
        try require(Set(required).isSubset(of: Set(v.keys)) && Set(v.keys).isSubset(of: Set(required + optional)))
    }
    private static func path(_ v: WireSemanticValue?) throws {
        guard let s = v?.text else { try require(false); return }
        try require(s.hasPrefix("/") && s != "/" && !s.contains("\\") && !s.contains("\0") && s.precomposedStringWithCanonicalMapping.utf8.elementsEqual(s.utf8))
        try require(s.dropFirst().split(separator: "/", omittingEmptySubsequences: false).allSatisfy { !$0.isEmpty && $0 != "." && $0 != ".." })
    }
    private static func range(_ v: [String: WireSemanticValue]) throws {
        guard let start = v["start"]?.number, let end = v["end"]?.number else { try require(false); return }
        try require(start >= 0 && end >= start && end <= 9_007_199_254_740_991)
    }
    @discardableResult private static func source(_ value: WireSemanticValue?) throws -> String {
        guard let v = value?.fields, let kind = v["kind"]?.text else { try require(false); return "" }
        switch kind {
        case "source":
            try keys(v, ["kind", "path", "object", "start", "end"]); try path(v["path"]); try range(v)
            let hash = v["object"]?.text ?? ""
            try require(hash.hasPrefix("sha256:") && hash.utf8.count == 71 && hash.dropFirst(7).utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) })
        case "entry": try keys(v, ["kind", "path"]); try path(v["path"])
        case "output":
            try keys(v, ["kind", "change", "operation", "output", "start", "end"]); try range(v)
            for key in ["change", "operation", "output"] { try id(v[key]) }
        case "alternative":
            try keys(v, ["kind", "state", "conflict", "alternative", "start", "end"]); try range(v)
            try require(v["state"]?.text?.isEmpty == false)
            for key in ["conflict", "alternative"] { try id(v[key]) }
        default: try require(false)
        }
        return kind
    }
    private static func validate(_ v: [String: WireSemanticValue]) throws {
        let fields = [
            "editSource": ["source", "text", "output"], "moveSource": ["source", "at", "side"], "copySource": ["source", "at", "side", "output"],
            "moveEntry": ["source", "destination"], "copyEntry": ["source", "destination", "output"], "removeEntry": ["source"],
            "editAlternative": ["source", "text", "output"], "resolveConflict": ["state", "conflict", "alternatives", "text", "output"], "undoOperation": ["target"]
        ]
        guard let kind = v["kind"]?.text, let required = fields[kind] else { try require(false); return }
        try keys(v, ["key", "kind"] + required, ["editSource", "editAlternative"].contains(kind) ? ["lineage"] : [])
        try id(v["key"])
        if let s = v["source"] {
            let k = try source(s)
            if kind.hasSuffix("Entry") { try require(k == "entry") }
            if kind == "editAlternative" { try require(k == "alternative") }
            if ["editSource", "moveSource", "copySource"].contains(kind) { try require(["source", "output"].contains(k)) }
        }
        if let at = v["at"] { try require(["source", "output"].contains(try source(at))) }
        if let side = v["side"] { try require(side.text == "before" || side.text == "after") }
        if let destination = v["destination"] { try path(destination) }
        for key in ["output", "conflict"] { if let value = v[key] { try id(value) } }
        if let state = v["state"] { try require(state.text?.isEmpty == false) }
        if let text = v["text"] { try require(text.text != nil && text.text!.utf8.count <= 1024 * 1024) }
        if let target = v["target"] { guard let t = target.fields else { try require(false); return }; try keys(t, ["change", "operation"]); try id(t["change"]); try id(t["operation"]) }
        if let alternatives = v["alternatives"] {
            guard let a = alternatives.items else { try require(false); return }
            try require(!a.isEmpty && a.count <= 1024)
            for value in a { try id(value) }
            try require(Set(a.compactMap(\.text)).count == a.count)
        }
        if let lineage = v["lineage"] {
            guard let segments = lineage.items else { try require(false); return }
            try require(segments.count <= 1024)
            var boundaries: Set<Int> = [0]
            var offset = 0
            for scalar in v["text"]!.text!.unicodeScalars {
                offset += String(scalar).utf8.count
                boundaries.insert(offset)
            }
            var end = 0
            for segment in segments {
                guard let s = segment.fields else { try require(false); return }
                try keys(s, ["source", "start", "end"]); try range(s)
                try require(try source(s["source"]) != "entry")
                let sourceRange = s["source"]!.fields!
                try require(s["start"]!.number! >= end && boundaries.contains(s["start"]!.number!) && boundaries.contains(s["end"]!.number!))
                try require(sourceRange["end"]!.number! - sourceRange["start"]!.number! == s["end"]!.number! - s["start"]!.number!)
                end = s["end"]!.number!
            }
        }
    }
}

struct WireSemanticCodingKey: CodingKey {
    var stringValue: String
    var intValue: Int? { nil }
    init?(stringValue: String) { self.stringValue = stringValue }
    init?(intValue: Int) { return nil }
}
func validateSemanticFields(_ decoder: Decoder, allowed: Set<String>) throws {
    let keys = try decoder.container(keyedBy: WireSemanticCodingKey.self).allKeys.map(\.stringValue)
    guard Set(keys).isSubset(of: allowed) else { throw ArborWireValidationError.invalidValue("Unknown update field") }
}
