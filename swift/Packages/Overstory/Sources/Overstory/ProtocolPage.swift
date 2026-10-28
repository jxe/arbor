import Foundation
import Yams

/// A page property's value (spec 01 §1.1.2): a YAML 1.2 core-schema value or
/// a timestamp. An integer is any number a safe integer holds; every other
/// number is a float, as canonical CBOR spells them.
public indirect enum PageValue: Hashable, Sendable {
    case null
    case bool(Bool)
    case integer(Int)
    case float(Double)
    case string(String)
    /// A `YYYY-MM-DD` date, CBOR tag 1004.
    case date(String)
    /// An RFC 3339 date-time in UTC, CBOR tag 0.
    case dateTime(String)
    case array([PageValue])
    case map([String: PageValue])

    /// A number as canonical CBOR holds it: a safe integer is an integer.
    public static func number(_ value: Double) -> PageValue {
        if value == value.rounded(), abs(value) <= Double(ProtocolPage.maxSafeInteger) { return .integer(Int(value)) }
        return .float(value)
    }
}

/// A Markdown page held as logical state: its stable `id`, its properties in
/// the order they were added, and its exact body bytes. Each placement writes
/// the frontmatter in its own spelling (directory format §3).
public struct ProtocolPage: Hashable, Sendable {
    public var id: String?
    public var properties: [Property]
    public var body: Data

    public struct Property: Hashable, Sendable {
        public var name: String
        public var value: PageValue

        public init(_ name: String, _ value: PageValue) {
            self.name = name
            self.value = value
        }
    }

    public init(id: String? = nil, properties: [Property] = [], body: Data) {
        self.id = id
        self.properties = properties
        self.body = body
    }

    static let maxSafeInteger = 9_007_199_254_740_991

    public subscript(name: String) -> PageValue? {
        properties.first { $0.name == name }?.value
    }

    /// Whether an entry with this name is a page when its file reads as one.
    public static func isPageName(_ name: String) -> Bool {
        let lower = name.lowercased()
        return lower.hasSuffix(".md") || lower.hasSuffix(".mdx")
    }
}

// MARK: - Objects

public extension ProtocolPage {
    /// The page's canonical CBOR object; its hash is its object and model hash.
    func encoded() throws -> Data {
        try validate()
        return CanonicalCBOR.encode(objectValue)
    }

    static func decode(_ bytes: Data) throws -> ProtocolPage {
        guard case let .map(fields) = try CanonicalCBOR.decode(bytes, tags: [0, 1004]) else {
            throw ProtocolValidationError.invalidCBOR("Page object is not a map")
        }
        let values = Dictionary(uniqueKeysWithValues: fields)
        guard case .text("page")? = values["type"], Set(values.keys).isSubset(of: ["type", "id", "properties", "body"]),
              case let .array(encoded)? = values["properties"], case let .bytes(body)? = values["body"] else {
            throw ProtocolValidationError.invalidCBOR("Page object fields are invalid")
        }
        var id: String?
        if let value = values["id"] {
            guard case let .text(text) = value else { throw ProtocolValidationError.invalidCBOR("A page's id is text") }
            id = text
        }
        let properties = try encoded.map { item -> Property in
            guard case let .array(pair) = item, pair.count == 2, case let .text(name) = pair[0] else {
                throw ProtocolValidationError.invalidCBOR("A page property is a [name, value] pair")
            }
            return Property(name, try pageValue(pair[1], depth: 0))
        }
        let page = ProtocolPage(id: id, properties: properties, body: body)
        try page.validate()
        // The decode accepted only canonical bytes, so re-encoding reproduces them.
        return page
    }

    private var objectValue: CanonicalCBORValue {
        var fields: [(String, CanonicalCBORValue)] = [("type", .text("page"))]
        if let id { fields.append(("id", .text(id))) }
        fields.append(("properties", .array(properties.map { .array([.text($0.name), Self.cborValue($0.value)]) })))
        fields.append(("body", .bytes(body)))
        return .map(fields)
    }

    private func validate() throws {
        if let id, id.isEmpty { throw ProtocolValidationError.invalidValue("A page's id is a nonempty string") }
        var names = Set<String>()
        for property in properties {
            guard !property.name.isEmpty, property.name != "id" else {
                throw ProtocolValidationError.invalidValue("A page property's name is nonempty and not id")
            }
            guard names.insert(property.name).inserted else { throw ProtocolValidationError.invalidValue("Duplicate page property") }
            try Self.validate(property.value, depth: 0)
        }
        guard String(data: body, encoding: .utf8) != nil else { throw ProtocolValidationError.invalidValue("A page's body is UTF-8") }
    }

    private static func validate(_ value: PageValue, depth: Int) throws {
        guard depth <= 64 else { throw ProtocolValidationError.invalidValue("Page value nests too deeply") }
        switch value {
        case .null, .bool, .string: return
        case let .integer(number):
            guard abs(number) <= maxSafeInteger else { throw ProtocolValidationError.invalidValue("Page integer exceeds the safe range") }
        case let .float(number):
            guard number.isFinite else { throw ProtocolValidationError.invalidValue("Page numbers are finite") }
        case let .date(text):
            guard validCanonicalDate(text) else { throw ProtocolValidationError.invalidValue("Invalid page date") }
        case let .dateTime(text):
            guard validCanonicalDateTime(text) else { throw ProtocolValidationError.invalidValue("Invalid page date-time") }
        case let .array(items): for item in items { try validate(item, depth: depth + 1) }
        case let .map(entries): for item in entries.values { try validate(item, depth: depth + 1) }
        }
    }

    private static func cborValue(_ value: PageValue) -> CanonicalCBORValue {
        switch value {
        case .null: .null
        case let .bool(flag): .bool(flag)
        case let .integer(number): .integer(number)
        case let .float(number): number == 0 ? .integer(0) : .float(number)
        case let .string(text): .text(text)
        case let .date(text): .tagged(1004, .text(text))
        case let .dateTime(text): .tagged(0, .text(text))
        case let .array(items): .array(items.map(cborValue))
        case let .map(entries): .map(entries.map { ($0.key, cborValue($0.value)) })
        }
    }

    private static func pageValue(_ value: CanonicalCBORValue, depth: Int) throws -> PageValue {
        guard depth <= 64 else { throw ProtocolValidationError.invalidCBOR("Page value nests too deeply") }
        switch value {
        case .null: return .null
        case let .bool(flag): return .bool(flag)
        case let .unsigned(number): return .integer(number)
        case let .negative(number): return .integer(-1 - number)
        case let .float(number): return .float(number)
        case let .text(text): return .string(text)
        case let .array(items): return .array(try items.map { try pageValue($0, depth: depth + 1) })
        case let .map(entries):
            var map: [String: PageValue] = [:]
            for (name, item) in entries { map[name] = try pageValue(item, depth: depth + 1) }
            return .map(map)
        case let .tagged(1004, .text(text)): return .date(text)
        case let .tagged(0, .text(text)): return .dateTime(text)
        case .tagged, .bytes: throw ProtocolValidationError.invalidCBOR("Invalid page value")
        }
    }
}

// MARK: - Timestamps

extension ProtocolPage {
    private static func match(_ pattern: String, _ text: String) -> [String?]? {
        guard let regex = try? NSRegularExpression(pattern: pattern),
              let result = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) else { return nil }
        return (0..<result.numberOfRanges).map { index in
            Range(result.range(at: index), in: text).map { String(text[$0]) }
        }
    }

    static func validDate(_ year: Int, _ month: Int, _ day: Int) -> Bool {
        guard (1...12).contains(month), day >= 1 else { return false }
        let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)
        let days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
        return day <= days[month - 1]
    }

    static func validCanonicalDate(_ text: String) -> Bool {
        guard let parts = match(#"^(\d{4})-(\d{2})-(\d{2})$"#, text) else { return false }
        return validDate(Int(parts[1]!)!, Int(parts[2]!)!, Int(parts[3]!)!)
    }

    static func validCanonicalDateTime(_ text: String) -> Bool {
        guard let parts = match(#"^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d*[1-9])?Z$"#, text) else { return false }
        return validDate(Int(parts[1]!)!, Int(parts[2]!)!, Int(parts[3]!)!)
            && Int(parts[4]!)! < 24 && Int(parts[5]!)! < 60 && Int(parts[6]!)! < 60
    }

    /// Days since 1970-01-01 of a proleptic Gregorian date.
    private static func days(_ year: Int, _ month: Int, _ day: Int) -> Int {
        let y = month <= 2 ? year - 1 : year
        let era = (y >= 0 ? y : y - 399) / 400
        let yoe = y - era * 400
        let doy = (153 * (month + (month > 2 ? -3 : 9)) + 2) / 5 + day - 1
        let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
        return era * 146_097 + doe - 719_468
    }

    private static func civil(_ days: Int) -> (year: Int, month: Int, day: Int) {
        let z = days + 719_468
        let era = (z >= 0 ? z : z - 146_096) / 146_097
        let doe = z - era * 146_097
        let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100)
        let mp = (5 * doy + 2) / 153
        let day = doy - (153 * mp + 2) / 5 + 1
        let month = mp < 10 ? mp + 3 : mp - 9
        return (yoe + era * 400 + (month <= 2 ? 1 : 0), month, day)
    }

    /// A YAML timestamp as a page value, or nil when the text is no real date
    /// or time (it then reads as a string). A date-time moves to UTC; its
    /// fraction keeps its digits without trailing zeros.
    public static func timestamp(_ text: String) -> PageValue? {
        if let parts = match(#"^(\d{4})-(\d{2})-(\d{2})$"#, text) {
            return validDate(Int(parts[1]!)!, Int(parts[2]!)!, Int(parts[3]!)!) ? .date(text) : nil
        }
        guard let parts = match(#"^(\d{4})-(\d{1,2})-(\d{1,2})(?:[Tt]|[ \t]+)(\d{1,2}):(\d{2}):(\d{2})(\.\d+)?(?:[ \t]*(Z|[-+]\d{1,2}(?::?\d{2})?))?$"#, text) else {
            return nil
        }
        let numbers = parts[1...6].map { Int($0!)! }
        let (year, month, day, hour, minute, second) = (numbers[0], numbers[1], numbers[2], numbers[3], numbers[4], numbers[5])
        guard validDate(year, month, day), hour <= 23, minute <= 59, second <= 59 else { return nil }
        var offset = 0
        if let zone = parts[8], zone != "Z" {
            let sign = zone.hasPrefix("-") ? -1 : 1
            let digits = zone.dropFirst().replacingOccurrences(of: ":", with: "")
            let hours = Int(digits.count <= 2 ? digits : String(digits.dropLast(2)))!
            let minutes = digits.count <= 2 ? 0 : Int(digits.suffix(2))!
            guard hours <= 23, minutes <= 59 else { return nil }
            offset = sign * (hours * 60 + minutes)
        }
        var total = days(year, month, day) * 1440 + hour * 60 + minute - offset
        let dayCount = Int((Double(total) / 1440).rounded(.down))
        total -= dayCount * 1440
        let date = civil(dayCount)
        guard (0...9999).contains(date.year) else { return nil }
        var fraction = parts[7] ?? ""
        while fraction.hasSuffix("0") { fraction.removeLast() }
        if fraction == "." { fraction = "" }
        func pad(_ n: Int, _ width: Int = 2) -> String { String(repeating: "0", count: max(0, width - String(n).count)) + String(n) }
        return .dateTime("\(pad(date.year, 4))-\(pad(date.month))-\(pad(date.day))T\(pad(total / 60)):\(pad(total % 60)):\(pad(second))\(fraction)Z")
    }
}

// MARK: - Reading a file

extension ProtocolPage {
    /// A file's frontmatter: the YAML between an opening `---` line and the
    /// next `---` line, and everything after the closing line.
    public struct FrontmatterSplit: Equatable, Sendable {
        /// The whole block, both fence lines included, or nil when there is none.
        public var block: String?
        public var yaml: String?
        public var body: String
    }

    public static func splitFrontmatter(_ source: String) -> FrontmatterSplit {
        let utf8 = Array(source.utf8)
        func line(from start: Int) -> (text: String, next: Int?) {
            var end = start
            while end < utf8.count, utf8[end] != 0x0a { end += 1 }
            let text = String(decoding: utf8[start..<end], as: UTF8.self)
            return (text, end < utf8.count ? end + 1 : nil)
        }
        let first = line(from: 0)
        guard first.text.trimmingCharacters(in: .whitespacesAndNewlines) == "---", let yamlStart = first.next else {
            return FrontmatterSplit(block: nil, yaml: nil, body: source)
        }
        var start = yamlStart
        while true {
            let current = line(from: start)
            if current.text.trimmingCharacters(in: .whitespacesAndNewlines) == "---" {
                let after = current.next ?? utf8.count
                return FrontmatterSplit(
                    block: String(decoding: utf8[0..<after], as: UTF8.self),
                    yaml: String(decoding: utf8[yamlStart..<start], as: UTF8.self),
                    body: String(decoding: utf8[after...], as: UTF8.self)
                )
            }
            guard let next = current.next else { break }
            start = next
        }
        return FrontmatterSplit(block: nil, yaml: nil, body: source)
    }

    private struct Unreadable: Error {}

    /// YAML 1.2's core schema plus timestamps: the one reading of frontmatter.
    private static let resolver: Resolver = {
        // swiftlint:disable force_try
        try! Resolver.basic
            .appending(.null, #"^(?:~|null|Null|NULL|)$"#)
            .appending(.bool, #"^(?:true|True|TRUE|false|False|FALSE)$"#)
            .appending(.int, #"^(?:[-+]?[0-9]+|0o[0-7]+|0x[0-9a-fA-F]+)$"#)
            .appending(.float, #"^(?:[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))$"#)
            .appending(.timestamp, timestampPattern)
        // swiftlint:enable force_try
    }()

    static let timestampPattern = #"^(?:\d{4}-\d{2}-\d{2}|\d{4}-\d{1,2}-\d{1,2}(?:[Tt]|[ \t]+)\d{1,2}:\d{2}:\d{2}(?:\.\d+)?(?:[ \t]*(?:Z|[-+]\d{1,2}(?::?\d{2})?))?)$"#

    private static func scalarValue(_ scalar: Node.Scalar, tag: Tag.Name) throws -> PageValue {
        let text = scalar.string
        switch tag {
        case .null: return .null
        case .bool: return .bool(text.lowercased() == "true")
        case .int:
            let value: Double?
            if text.hasPrefix("0o") { value = Int(text.dropFirst(2), radix: 8).map(Double.init) }
            else if text.hasPrefix("0x") { value = Int(text.dropFirst(2), radix: 16).map(Double.init) }
            else if let exact = Int(text), abs(exact) <= maxSafeInteger { return .integer(exact) }
            else { value = Double(text) }
            guard let value, value.isFinite else { throw Unreadable() }
            return .number(value)
        case .float:
            guard let value = Double(text), value.isFinite else { throw Unreadable() }
            return .number(value)
        case .timestamp:
            return timestamp(text) ?? .string(text)
        default:
            return .string(text)
        }
    }

    private static func pageValue(_ node: Node, budget: inout Int, depth: Int) throws -> PageValue {
        budget -= 1
        guard budget >= 0, depth <= 64 else { throw Unreadable() }
        switch node {
        case let .scalar(scalar):
            return try scalarValue(scalar, tag: node.tag.name)
        case let .sequence(sequence):
            return .array(try sequence.map { try pageValue($0, budget: &budget, depth: depth + 1) })
        case let .mapping(mapping):
            var map: [String: PageValue] = [:]
            for (key, value) in mapping {
                guard case let .scalar(scalar) = key, key.tag.name == .str else { throw Unreadable() }
                guard map[scalar.string] == nil else { throw Unreadable() }
                map[scalar.string] = try pageValue(value, budget: &budget, depth: depth + 1)
            }
            return .map(map)
        case .alias:
            throw Unreadable()
        }
    }

    /// The frontmatter YAML holds, or nil when it is not a map of string keys YAML 1.2 reads.
    public static func parseFrontmatter(_ yaml: String) -> (id: String?, properties: [Property])? {
        let composed: Node?
        do { composed = try Yams.compose(yaml: yaml, resolver) } catch { return nil }
        guard let root = composed else { return (nil, []) }
        if case .scalar = root, root.tag.name == .null { return (nil, []) }
        guard case let .mapping(mapping) = root else { return nil }
        var budget = 100_000
        var id: String?
        var properties: [Property] = []
        var names = Set<String>()
        do {
            for (key, value) in mapping {
                guard case let .scalar(keyScalar) = key, key.tag.name == .str, !keyScalar.string.isEmpty else { return nil }
                let name = keyScalar.string
                guard names.insert(name).inserted else { return nil }
                if name == "id" {
                    // An id is the key's text: `id: 123456` is the id "123456".
                    guard case let .scalar(scalar) = value, value.tag.name != .null, !scalar.string.isEmpty else { return nil }
                    id = scalar.string
                    continue
                }
                properties.append(Property(name, try pageValue(value, budget: &budget, depth: 0)))
            }
        } catch {
            return nil
        }
        return (id, properties)
    }

    /// The page a `.md` or `.mdx` file holds, or nil when it is not one: its
    /// bytes are not UTF-8, or its frontmatter does not read as YAML 1.2. Such
    /// a file stays a file entry, with the `unparsed-front-matter` diagnostic.
    public static func parse(_ bytes: Data) -> ProtocolPage? {
        guard let source = String(data: bytes, encoding: .utf8) else { return nil }
        let split = splitFrontmatter(source)
        guard let yaml = split.yaml else { return ProtocolPage(body: bytes) }
        guard let frontmatter = parseFrontmatter(yaml) else { return nil }
        return ProtocolPage(id: frontmatter.id, properties: frontmatter.properties, body: Data(split.body.utf8))
    }
}

// MARK: - Writing a file

extension ProtocolPage {
    private static func matches(_ pattern: String, _ text: String) -> Bool { match(pattern, text) != nil }

    /// Whether a string can be written plain and read back as the same string.
    static func plain(_ text: String) -> Bool {
        guard !text.isEmpty, text == text.trimmingCharacters(in: .whitespacesAndNewlines) else { return false }
        if text.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7f || $0.value == 0x85 || $0.value == 0x2028 || $0.value == 0x2029 || $0.value == 0xfeff }) {
            return false
        }
        if let first = text.unicodeScalars.first, "-?:,[]{}#&*!|>'\"%@`.".unicodeScalars.contains(first) { return false }
        if text.contains(": ") || text.contains(" #") || text.hasSuffix(":") { return false }
        for pattern in [
            #"^(?:null|Null|NULL|~)$"#,
            #"^(?:true|True|TRUE|false|False|FALSE)$"#,
            #"^(?:[-+]?[0-9]+|0o[0-7]+|0x[0-9a-fA-F]+)$"#,
            #"^(?:[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?|[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)$"#,
            timestampPattern,
        ] where matches(pattern, text) { return false }
        return true
    }

    /// A double-quoted YAML scalar with JSON's escapes, all of which YAML reads.
    static func quoted(_ text: String) -> String {
        var result = "\""
        for scalar in text.unicodeScalars {
            switch scalar {
            case "\"": result += "\\\""
            case "\\": result += "\\\\"
            case "\u{08}": result += "\\b"
            case "\u{0C}": result += "\\f"
            case "\n": result += "\\n"
            case "\r": result += "\\r"
            case "\t": result += "\\t"
            default:
                if scalar.value < 0x20 { result += String(format: "\\u%04x", scalar.value) }
                else { result.unicodeScalars.append(scalar) }
            }
        }
        return result + "\""
    }

    /// A number as the shortest text that reads back to it, in ECMAScript's
    /// form, with integral values beyond the safe range in exponent form.
    public static func numberText(_ value: Double) -> String {
        if value == 0 { return "0" }
        if value == value.rounded(), abs(value) <= Double(maxSafeInteger) { return String(Int(value)) }
        let negative = value < 0
        let description = "\(abs(value))"
        let parts = description.split(separator: "e", maxSplits: 1)
        let mantissa = String(parts[0])
        let exponent = parts.count > 1 ? Int(parts[1].replacingOccurrences(of: "+", with: ""))! : 0
        let point = mantissa.firstIndex(of: ".").map { mantissa.distance(from: mantissa.startIndex, to: $0) } ?? mantissa.count
        var digits = mantissa.replacingOccurrences(of: ".", with: "")
        var n = point + exponent
        while digits.hasPrefix("0"), digits.count > 1 { digits.removeFirst(); n -= 1 }
        while digits.hasSuffix("0"), digits.count > 1 { digits.removeLast() }
        let k = digits.count
        let integral = value == value.rounded()
        let text: String
        if !integral, k <= n, n <= 21 {
            text = digits + String(repeating: "0", count: n - k)
        } else if !integral, 0 < n, n <= 21 {
            text = String(digits.prefix(n)) + "." + String(digits.dropFirst(n))
        } else if !integral, -6 < n, n <= 0 {
            text = "0." + String(repeating: "0", count: -n) + digits
        } else {
            let e = n - 1
            let rest = digits.dropFirst()
            text = String(digits.prefix(1)) + (rest.isEmpty ? "" : "." + rest) + "e" + (e >= 0 ? "+" : "-") + String(abs(e))
        }
        return (negative ? "-" : "") + text
    }

    private static func scalarText(_ value: PageValue) -> String? {
        switch value {
        case .null: "null"
        case let .bool(flag): flag ? "true" : "false"
        case let .integer(number): String(number)
        case let .float(number): numberText(number)
        case let .string(text): plain(text) ? text : quoted(text)
        case let .date(text), let .dateTime(text): text
        case let .array(items): items.isEmpty ? "[]" : nil
        case let .map(entries): entries.isEmpty ? "{}" : nil
        }
    }

    private static func keyText(_ key: String) -> String { plain(key) ? key : quoted(key) }

    private static func entryLines(_ key: String, _ value: PageValue, indent: String) -> String {
        if let scalar = scalarText(value) { return "\(indent)\(keyText(key)): \(scalar)\n" }
        return "\(indent)\(keyText(key)):\n" + blockLines(value, indent: indent + "  ")
    }

    private static func blockLines(_ value: PageValue, indent: String) -> String {
        switch value {
        case let .array(items):
            return items.map { item in
                if let scalar = scalarText(item) { return "\(indent)- \(scalar)\n" }
                // A nested collection starts on the dash's line.
                let nested = blockLines(item, indent: indent + "  ")
                return "\(indent)- " + String(nested.dropFirst(indent.count + 2))
            }.joined()
        case let .map(entries):
            return entries.keys
                .sorted { Array($0.utf8).lexicographicallyPrecedes(Array($1.utf8)) }
                .map { entryLines($0, entries[$0]!, indent: indent) }
                .joined()
        default:
            return ""
        }
    }

    /// The frontmatter block a page is written with from nothing, or "" when
    /// it has no id and no properties.
    public var canonicalFrontmatter: String {
        guard id != nil || !properties.isEmpty else { return "" }
        var lines = id.map { Self.entryLines("id", .string($0), indent: "") } ?? ""
        for property in properties { lines += Self.entryLines(property.name, property.value, indent: "") }
        return "---\n\(lines)---\n"
    }

    /// The file a page is written as from nothing (directory format §3).
    public var canonicalFile: Data {
        Data(canonicalFrontmatter.utf8) + body
    }

    /// Whether `bytes` read back to exactly this page.
    public func isHeld(by bytes: Data) -> Bool {
        Self.parse(bytes) == self
    }

    /// The file to write for this page where `existing` is: unchanged when it
    /// already reads back to the page, otherwise the canonical file. Story
    /// Sync, which keeps folders on disk, splices changed keys instead.
    public func file(keeping existing: Data?) -> Data {
        if let existing, isHeld(by: existing) { return existing }
        return canonicalFile
    }
}
