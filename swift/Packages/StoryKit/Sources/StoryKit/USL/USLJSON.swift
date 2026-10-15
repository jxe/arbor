import Foundation

// JSON spelled the way TypeScript's `JSON.stringify` spells it, so stable
// keys, group ids and occurrence ids are byte-identical in both stacks.

/// `JSON.stringify` of a string.
func jsonString(_ value: String) -> String {
    var out = "\""
    for scalar in value.unicodeScalars {
        switch scalar {
        case "\"": out += "\\\""
        case "\\": out += "\\\\"
        case "\u{08}": out += "\\b"
        case "\u{0C}": out += "\\f"
        case "\n": out += "\\n"
        case "\r": out += "\\r"
        case "\t": out += "\\t"
        default:
            if scalar.value < 0x20 {
                out += String(format: "\\u%04x", scalar.value)
            } else {
                out.unicodeScalars.append(scalar)
            }
        }
    }
    return out + "\""
}

/// `String(number)` in JavaScript, for the finite numbers rows hold.
func jsNumber(_ value: Double) -> String {
    if value == 0 { return "0" }
    if value == value.rounded(), abs(value) < 1e18 { return String(Int64(value)) }
    // Swift writes the shortest round-tripping digits too; JavaScript spells
    // the exponent without leading zeros (1e-7, not 1e-07).
    var text = "\(value)"
    if let e = text.firstIndex(where: { $0 == "e" || $0 == "E" }) {
        let mantissa = text[..<e]
        var exponent = String(text[text.index(after: e)...])
        var sign = "+"
        if exponent.hasPrefix("-") { sign = "-"; exponent.removeFirst() } else if exponent.hasPrefix("+") { exponent.removeFirst() }
        while exponent.count > 1 && exponent.hasPrefix("0") { exponent.removeFirst() }
        text = "\(mantissa.hasSuffix(".0") ? String(mantissa.dropLast(2)) : String(mantissa))e\(sign)\(exponent)"
    }
    return text
}

extension JSONValue {
    /// `JSON.stringify` of the value. Object members are written in code-point order of their keys.
    var jsonText: String {
        switch self {
        case .null: return "null"
        case .bool(let b): return b ? "true" : "false"
        case .number(let n): return n.isFinite ? jsNumber(n) : "null"
        case .string(let s): return jsonString(s)
        case .array(let items): return "[\(items.map(\.jsonText).joined(separator: ","))]"
        case .object(let members):
            let keys = members.keys.sorted { compareText($0, $1) < 0 }
            return "{\(keys.map { "\(jsonString($0)):\(members[$0]!.jsonText)" }.joined(separator: ","))}"
        }
    }

    var stringValue: String? {
        switch self { case .string(let s): s; default: nil }
    }
    var numberValue: Double? {
        switch self { case .number(let n): n; default: nil }
    }
    var arrayValue: [JSONValue]? {
        switch self { case .array(let a): a; default: nil }
    }
    var isNull: Bool {
        switch self { case .null: true; default: false }
    }
    /// A string, a finite number or a boolean.
    var isScalar: Bool {
        switch self {
        case .string, .bool: true
        case .number(let n): n.isFinite
        default: false
        }
    }
}

/// Orders strings by Unicode code point, as TypeScript's `compareText` does.
func compareText(_ a: String, _ b: String) -> Int {
    let x = Array(a.unicodeScalars), y = Array(b.unicodeScalars)
    for i in 0..<min(x.count, y.count) where x[i] != y[i] {
        return Int(x[i].value) - Int(y[i].value)
    }
    return x.count - y.count
}

/// A string-keyed map that remembers insertion order, like a JavaScript `Map`.
struct OrderedMap<Value> {
    private(set) var keys: [String] = []
    private var storage: [String: Value] = [:]

    subscript(key: String) -> Value? {
        get { storage[key] }
        set {
            if let newValue {
                if storage[key] == nil { keys.append(key) }
                storage[key] = newValue
            } else if storage.removeValue(forKey: key) != nil {
                keys.removeAll { $0 == key }
            }
        }
    }

    func has(_ key: String) -> Bool { storage[key] != nil }
    var values: [Value] { keys.map { storage[$0]! } }
    var items: [(key: String, value: Value)] { keys.map { ($0, storage[$0]!) } }
}

/// Whether JavaScript's `Date.parse` reads `text` as a date. This accepts the
/// ISO 8601 forms `Date.parse` must read (a date, or a date and time with an
/// optional zone); engines also read other spellings, which this refuses.
func parsesAsDate(_ text: String) -> Bool {
    let pattern = #"^([+-]\d{6}|\d{4})(-(\d{2})(-(\d{2}))?)?(T(\d{2}):(\d{2})(:(\d{2})(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$"#
    guard let regex = try? NSRegularExpression(pattern: pattern),
          let match = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) else { return false }
    func group(_ i: Int) -> Int? {
        guard let range = Range(match.range(at: i), in: text) else { return nil }
        return Int(text[range])
    }
    if let month = group(3), !(1...12).contains(month) { return false }
    if let day = group(5), !(1...31).contains(day) { return false }
    if let hour = group(7), hour > 24 { return false }
    if let minute = group(8), minute > 59 { return false }
    if let second = group(10), second > 59 { return false }
    return true
}
