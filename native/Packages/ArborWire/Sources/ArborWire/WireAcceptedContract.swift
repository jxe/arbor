import Foundation

/// JSON read fields, including unknown extensions, are data rather than mutation semantics.
public indirect enum WireReadValue: Codable, Sendable, Equatable {
    case null, bool(Bool), number(Double), string(String), array([WireReadValue]), object([String: WireReadValue])
    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let b = try? c.decode(Bool.self) { self = .bool(b) }
        else if let s = try? c.decode(String.self) { self = .string(s) }
        else if let n = try? c.decode(Double.self), n.isFinite { self = .number(n) }
        else if let a = try? c.decode([WireReadValue].self) { self = .array(a) }
        else { self = .object(try c.decode([String: WireReadValue].self)) }
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case .bool(let v): try c.encode(v)
        case .number(let v): try c.encode(v)
        case .string(let v): try c.encode(v)
        case .array(let v): try c.encode(v)
        case .object(let v): try c.encode(v)
        }
    }
    var text: String? { if case .string(let s) = self { return s }; return nil }
    var fields: [String: WireReadValue]? { if case .object(let v) = self { return v }; return nil }
    var items: [WireReadValue]? { if case .array(let a) = self { return a }; return nil }
}

public struct WireAcceptedStateContract: Codable, Sendable, Equatable {
    public let fields: [String: WireReadValue]
    public init(from decoder: Decoder) throws {
        fields = try decoder.singleValueContainer().decode([String: WireReadValue].self)
        try AcceptedReadValidation.state(fields)
    }
    public func encode(to encoder: Encoder) throws { var c = encoder.singleValueContainer(); try c.encode(fields) }
    public static func validateChain(tree: String, previous: [String: WireReadValue]?, updates: [Self], head: [String: WireReadValue]) throws {
        var prior = previous
        var seen = Set<Data>()
        if let previous { seen.insert(Data(try AcceptedReadValidation.string(previous["id"]).utf8)) }
        try AcceptedReadValidation.check(!updates.isEmpty)
        for update in updates {
            let u = update.fields
            try AcceptedReadValidation.check(AcceptedReadValidation.equal(u["tree"], .string(tree)))
            let id = Data(try AcceptedReadValidation.string(u["id"]).utf8)
            try AcceptedReadValidation.check(seen.insert(id).inserted)
            if let prior {
                let p = try AcceptedReadValidation.object(u["previous"])
                try AcceptedReadValidation.check(AcceptedReadValidation.equal(p["id"], prior["id"]) && p["root"] == prior["root"])
            } else { try AcceptedReadValidation.check(u["previous"] == .null) }
            prior = ["id": u["id"]!, "root": u["root"]!]
        }
        try AcceptedReadValidation.check(AcceptedReadValidation.equal(prior?["id"], head["id"]) && prior?["root"] == head["root"])
    }
}
public struct WireDecisionPageContract: Codable, Sendable, Equatable {
    public let fields: [String: WireReadValue]
    public init(from decoder: Decoder) throws { fields = try decoder.singleValueContainer().decode([String: WireReadValue].self); try AcceptedReadValidation.inspection(fields) }
    public func encode(to encoder: Encoder) throws { var c = encoder.singleValueContainer(); try c.encode(fields) }
    public func validateContext(tree: String, state: String, root: String) throws {
        for (k,v) in [("tree",tree),("state",state),("root",root)] { try AcceptedReadValidation.check(AcceptedReadValidation.equal(fields[k], .string(v))) }
    }
}
public struct WireSubmissionResponseContract: Codable, Sendable, Equatable {
    public let fields: [String: WireReadValue]
    public init(from decoder: Decoder) throws {
        fields = try decoder.singleValueContainer().decode([String: WireReadValue].self)
        try AcceptedReadValidation.required(fields, ["results","observedThrough"]); try AcceptedReadValidation.token(fields["observedThrough"])
        let results = try AcceptedReadValidation.array(fields["results"]); try AcceptedReadValidation.check(!results.isEmpty)
        for raw in results {
            let r = try AcceptedReadValidation.object(raw); try AcceptedReadValidation.required(r,["outcome","update","requestDigest"])
            try AcceptedReadValidation.check(["unchanged","accepted"].contains(r["outcome"]?.text ?? ""))
            try AcceptedReadValidation.state(AcceptedReadValidation.object(r["update"])); try AcceptedReadValidation.hash(r["requestDigest"])
        }
    }
    public func encode(to encoder: Encoder) throws { var c = encoder.singleValueContainer(); try c.encode(fields) }
}
private enum AcceptedReadValidation {
    typealias Obj = [String: WireReadValue]
    static func check(_ ok: Bool) throws { if !ok { throw ArborWireValidationError.invalidValue("Invalid accepted-state contract") } }
    static func object(_ v: WireReadValue?) throws -> Obj { guard let o=v?.fields else { throw ArborWireValidationError.invalidValue("Expected object") }; return o }
    static func array(_ v: WireReadValue?) throws -> [WireReadValue] { guard let a=v?.items else { throw ArborWireValidationError.invalidValue("Expected array") }; return a }
    static func string(_ v: WireReadValue?) throws -> String { guard let s=v?.text else { throw ArborWireValidationError.invalidValue("Expected string") }; return s }
    static func equal(_ a: WireReadValue?, _ b: WireReadValue?) -> Bool { guard let a=a?.text, let b=b?.text else { return false }; return a.utf8.elementsEqual(b.utf8) }
    static func required(_ v: Obj, _ names: [String]) throws { try check(names.allSatisfy { v[$0] != nil }) }
    static func token(_ v: WireReadValue?) throws { let s=try string(v); try check(!s.isEmpty && s.utf8.count<=1024) }
    static func id(_ v: WireReadValue?) throws { try check(v?.text.map(WireSourceOperation.validID)==true) }
    static func hash(_ v: WireReadValue?) throws {
        let s=try string(v); try check(s.utf8.count==71 && s.hasPrefix("sha256:") && s.dropFirst(7).utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) })
    }
    static func ids(_ v: WireReadValue?, nonempty: Bool=false) throws {
        let a=try array(v); try check(!nonempty || !a.isEmpty); for x in a { try id(x) }; try check(Set(a.map { $0.text! }).count==a.count)
    }
    static func reference(_ v: WireReadValue?, entry: Bool=false) throws {
        guard let v else { try check(false); return }
        let bytes=try JSONEncoder().encode(v)
        try WireAuthoredRequestIntent.validateMaterialReference(JSONDecoder().decode(WireSemanticValue.self,from:bytes),entry:entry)
    }
    static func contributions(_ raw: WireReadValue?) throws {
        let a=try array(raw); var seen=Set<String>()
        for raw in a {
            let c=try object(raw); try required(c,["change","operation"]); try id(c["change"])
            if c["operation"] != .null { try id(c["operation"]) }
            let key=c["change"]!.text!+":"+(c["operation"]!.text ?? ":")
            try check(seen.insert(key).inserted)
        }
    }
    static func page(_ v: Obj, _ field: String) throws -> [WireReadValue] {
        try required(v,["tree","state",field,"next"]); try token(v["tree"]); try token(v["state"])
        let a=try array(v[field]); if v["next"] != .null { try token(v["next"]); try check(!a.isEmpty) }; return a
    }
    static func state(_ v: Obj) throws {
        try required(v,["id","tree","root","previous","acceptedAt","subject","conflicted"])
        try token(v["id"]); try token(v["tree"]); try hash(v["root"])
        guard case .number(let t)=v["acceptedAt"], case .bool=v["conflicted"] else { try check(false); return }
        try check(t>=0 && t<=9_007_199_254_740_991 && t.rounded()==t)
        if v["subject"] != .null { try token(v["subject"]) }
        if v["previous"] != .null { let p=try object(v["previous"]); try required(p,["id","root"]); try token(p["id"]); try hash(p["root"]); try check(!equal(p["id"],v["id"])) }
    }
    static func inspection(_ v: Obj) throws {
        let decisions=try page(v,"decisions"); try required(v,["root","conflicted"]); try hash(v["root"])
        guard case .bool(let conflicted)=v["conflicted"] else { try check(false); return }
        if !conflicted { try check(decisions.isEmpty && v["next"] == .null) }
        var seen=Set<String>()
        for raw in decisions {
            let d=try object(raw); try required(d,["id","kind","affected","selected","alternatives","dependencies","actions"])
            try id(d["id"]); try check(seen.insert(d["id"]!.text!).inserted); try token(d["kind"]); try id(d["selected"])
            let affected=try array(d["affected"]); try check(!affected.isEmpty); for r in affected { try reference(r) }
            try ids(d["dependencies"]); try check(!(d["dependencies"]!.items!.contains(d["id"]!))); try ids(d["actions"])
            let alternatives=try array(d["alternatives"]); try check(alternatives.count>=2); var names=Set<String>()
            for raw in alternatives {
                let a=try object(raw); try required(a,["id","revision","value","contributions"]); try id(a["id"]); try id(a["revision"])
                try check(names.insert(a["id"]!.text!).inserted); try contributions(a["contributions"])
                let value=try object(a["value"]); try check(value.count==1); let kind=value.keys.first!
                switch kind {
                case "text": _=try string(value["text"])
                case "file","directory": try hash(value[kind])
                case "tree": try token(value["tree"])
                case "absent": try check(value["absent"] == .bool(true))
                default: try check(false)
                }
                if let placement=a["placement"] {
                    try check(["file","directory","tree"].contains(kind)); let p=try object(placement); try required(p,["parent","name"]); try reference(p["parent"],entry:true)
                    try reference(.object(["material":.object(["kind":.string("basis"),"path":.string("/"),"object":v["root"]!]),"within":.array([p["name"]!])]))
                }
            }
            try check(names.contains(d["selected"]!.text!))
        }
    }
}
