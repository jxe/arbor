import Foundation

/// Target semantic contract, fixture-tested independently of the deployed HTTP codec.
/// Objects and deltas retain their existing transport codecs and are not semantic fields.
public struct WireAuthoredRequestIntent: Codable, Sendable, Equatable {
    public let fields: [String: WireSemanticValue]
    public init(_ fields: [String: WireSemanticValue]) throws {
        try Self.validate(fields)
        self.fields = fields
    }
    public init(from decoder: Decoder) throws {
        try self.init(try decoder.singleValueContainer().decode([String: WireSemanticValue].self))
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        try c.encode(fields)
    }
    public func identities(tree: String) throws -> [(bytes: Data, digest: String)] {
        try Self.token(.string(tree))
        var base = fields["base"]!.cbor
        return fields["updates"]!.items!.map { raw in
            let u = raw.fields!
            let bytes = CanonicalCBOR.encode(.map([
                ("domain", .text("arbor-update")), ("tree", .text(tree)), ("base", base),
                ("change", u["change"]!.cbor), ("candidate", u["candidate"]!.cbor),
                ("operations", u["operations"]!.cbor), ("resolves", u["resolves"]!.cbor),
                ("ifCurrent", u["ifCurrent"]?.cbor ?? .null)
            ]))
            let digest = WireObjectCodec.hash(bytes)
            base = .map([("requestDigest", .text(digest)), ("candidate", u["candidate"]!.cbor)])
            return (bytes, digest)
        }
    }
    static func validateMaterialReference(_ value: WireSemanticValue, entry: Bool = false) throws {
        try reference(value, entry: entry)
    }
    private typealias Obj = [String: WireSemanticValue]
    private static func check(_ condition: Bool) throws {
        if !condition { throw ArborWireValidationError.invalidValue("Invalid authored update contract") }
    }
    private static func object(_ value: WireSemanticValue?) throws -> Obj {
        guard let o = value?.fields else { throw ArborWireValidationError.invalidValue("Expected semantic object") }; return o
    }
    private static func keys(_ v: Obj, _ required: [String], _ optional: [String] = []) throws {
        try check(Set(required).isSubset(of: Set(v.keys)) && Set(v.keys).isSubset(of: Set(required + optional)))
    }
    @discardableResult private static func text(_ v: WireSemanticValue?, _ limit: Int) throws -> String {
        guard let s = v?.text else { throw ArborWireValidationError.invalidValue("Expected text") }
        try check(s.utf8.count <= limit); return s
    }
    private static func token(_ v: WireSemanticValue?) throws { let s = try text(v, 1024); try check(!s.isEmpty) }
    private static func id(_ v: WireSemanticValue?) throws { try check(v?.text.map(WireSourceOperation.validID) == true) }
    private static func hash(_ v: WireSemanticValue?) throws {
        let s = try text(v, 71)
        try check(s.utf8.count == 71 && s.hasPrefix("sha256:") && s.dropFirst(7).utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) })
    }
    private static func component(_ v: WireSemanticValue?) throws {
        let s = try text(v, 4096)
        try check(!s.isEmpty && s != "." && s != ".." && !s.contains("/") && !s.contains("\\") && !s.contains("\0") && s.precomposedStringWithCanonicalMapping.utf8.elementsEqual(s.utf8))
    }
    private static func path(_ v: WireSemanticValue?) throws {
        let s = try text(v, 4096); try check(s.hasPrefix("/"))
        if s != "/" { for c in s.dropFirst().split(separator: "/", omittingEmptySubsequences: false) { try component(.string(String(c))) } }
    }
    private static func range(_ v: WireSemanticValue?) throws -> (Int, Int) {
        guard let a = v?.items, a.count == 2, let start = a[0].number, let end = a[1].number else { throw ArborWireValidationError.invalidValue("Expected range") }
        try check(start >= 0 && end >= start && end <= 9_007_199_254_740_991); return (start, end)
    }
    @discardableResult private static func reference(_ raw: WireSemanticValue?, entry: Bool = false) throws -> Obj {
        let v = try object(raw); try keys(v, ["material"], ["within", "range"]); let m = try object(v["material"])
        switch m["kind"]?.text {
        case "basis": try keys(m, ["kind", "path", "object"]); try path(m["path"]); try hash(m["object"])
        case "operation": try keys(m, ["kind", "change", "operation"]); try id(m["change"]); try id(m["operation"])
        case "alternative": try keys(m, ["kind", "state", "conflict", "alternative"]); try token(m["state"]); try id(m["conflict"]); try id(m["alternative"])
        default: try check(false)
        }
        if let within = v["within"] {
            guard let a = within.items else { throw ArborWireValidationError.invalidValue("Expected descendant components") }
            try check(!a.isEmpty && a.count <= 256)
            for c in a { try component(c) }
            try check(a.map { $0.text! }.joined(separator: "/").utf8.count <= 4096)
        }
        if v["range"] != nil { try check(!entry); _ = try range(v["range"]) }
        return v
    }
    private static func operation(_ raw: WireSemanticValue) throws -> String {
        let v = try object(raw); try id(v["key"])
        switch v["kind"]?.text {
        case "editSource":
            try keys(v, ["key", "kind", "source", "text"], ["lineage"]); try reference(v["source"])
            let s = try text(v["text"], 1_048_576)
            if let lineage = v["lineage"] {
                guard let a = lineage.items else { throw ArborWireValidationError.invalidValue("Expected lineage") }
                try check(a.count <= 1024)
                var boundaries: Set<Int> = [0]; var offset = 0; var end = 0
                for scalar in s.unicodeScalars { offset += String(scalar).utf8.count; boundaries.insert(offset) }
                for raw in a {
                    let l = try object(raw); try keys(l, ["source", "range"])
                    let source = try reference(l["source"]); let (start, next) = try range(l["range"])
                    try check(start >= end && boundaries.contains(start) && boundaries.contains(next))
                    if let selected = source["range"] { let (a, b) = try range(selected); try check(b - a == next - start) }
                    end = next
                }
            }
        case "moveSource", "copySource":
            try keys(v, ["key", "kind", "source", "at", "side"]); try reference(v["source"]); try reference(v["at"])
            try check(v["side"]?.text == "before" || v["side"]?.text == "after")
        case "moveEntry", "copyEntry":
            try keys(v, ["key", "kind", "source", "destination"]); try reference(v["source"], entry: true)
            let d = try object(v["destination"]); try keys(d, ["parent", "name"]); try reference(d["parent"], entry: true); try component(d["name"])
        case "removeEntry": try keys(v, ["key", "kind", "source"]); try reference(v["source"], entry: true)
        case "replaceEntry":
            try keys(v, ["key", "kind", "source", "value"]); try reference(v["source"], entry: true); let value = try object(v["value"])
            if value["file"] != nil { try keys(value, ["file"]); try hash(value["file"]) }
            else if value["directory"] != nil { try keys(value, ["directory"]); try hash(value["directory"]) }
            else { try reference(.object(value), entry: true) }
        case "undoOperation":
            try keys(v, ["key", "kind", "target"]); let t = try object(v["target"]); try keys(t, ["change", "operation"]); try id(t["change"]); try id(t["operation"])
        default: try check(false)
        }
        return v["key"]!.text!
    }
    private static func validate(_ v: Obj) throws {
        try keys(v, ["base", "updates"])
        if v["base"] != .null { try token(v["base"]) }
        guard let updates = v["updates"]?.items else { throw ArborWireValidationError.invalidValue("Expected updates") }
        try check(!updates.isEmpty); var changes = Set<String>()
        for raw in updates {
            let u = try object(raw)
            try validateCandidate(u)
            try check(changes.insert(u["change"]!.text!).inserted)
        }
        if v["base"] == .null { let first = updates[0].fields!; try check(first["ifCurrent"] == nil && first["resolves"]!.items!.isEmpty) }
    }
    /// Shared by semantic fixtures and complete transport candidates.
    static func validateCandidate(_ u: [String: WireSemanticValue]) throws {
        try keys(u, ["change", "candidate", "operations", "resolves"], ["ifCurrent"])
        try id(u["change"]); try hash(u["candidate"])
        if u["ifCurrent"] != nil { try token(u["ifCurrent"]) }
        guard let resolves = u["resolves"]?.items else { throw ArborWireValidationError.invalidValue("Expected resolves") }
        var decisions = Set<String>()
        for raw in resolves {
            let r = try object(raw); try keys(r, ["state", "conflict", "alternatives"]); try token(r["state"]); try id(r["conflict"])
            try check(decisions.insert(r["conflict"]!.text!).inserted)
            guard let a = r["alternatives"]?.items else { throw ArborWireValidationError.invalidValue("Expected alternatives") }
            try check(!a.isEmpty); for v in a { try id(v) }
            try check(Set(a.map { $0.text! }).count == a.count)
        }
        if u["operations"] != .null {
            guard let ops = u["operations"]?.items else { throw ArborWireValidationError.invalidValue("Expected operations") }
            try check(ops.count <= 1024 && (!ops.isEmpty || !resolves.isEmpty))
            let ids = try ops.map(operation); try check(Set(ids).count == ids.count)
        }
    }
}
