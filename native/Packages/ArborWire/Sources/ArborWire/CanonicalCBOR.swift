import Foundation

/// Arbor's canonical CBOR subset: null, booleans, integers, other finite
/// numbers as 64-bit floats, UTF-8 text, byte strings, arrays, and text-keyed
/// maps with byte-ordered keys and minimal lengths. `negative(n)` encodes the
/// integer `-1 - n`, mirroring CBOR major type 1.
indirect enum CanonicalCBORValue: Equatable {
    case null
    case bool(Bool)
    case unsigned(Int)
    case negative(Int)
    case float(Double)
    case bytes(Data)
    case text(String)
    case array([CanonicalCBORValue])
    case map([(String, CanonicalCBORValue)])

    /// Convenience for any Swift integer, choosing the CBOR major type by sign.
    static func integer(_ value: Int) -> CanonicalCBORValue {
        value >= 0 ? .unsigned(value) : .negative(-1 - value)
    }

    static func == (left: CanonicalCBORValue, right: CanonicalCBORValue) -> Bool {
        switch (left, right) {
        case (.null, .null): true
        case let (.bool(a), .bool(b)): a == b
        case let (.unsigned(a), .unsigned(b)): a == b
        case let (.negative(a), .negative(b)): a == b
        case let (.float(a), .float(b)): a.bitPattern == b.bitPattern
        case let (.bytes(a), .bytes(b)): a == b
        case let (.text(a), .text(b)): a == b
        case let (.array(a), .array(b)): a == b
        case let (.map(a), .map(b)):
            a.count == b.count && zip(a, b).allSatisfy { $0.0 == $1.0 && $0.1 == $1.1 }
        default: false
        }
    }
}

enum CanonicalCBOR {
    static func encode(_ value: CanonicalCBORValue) -> Data {
        switch value {
        case .null: Data([0xf6])
        case let .bool(flag): Data([flag ? 0xf5 : 0xf4])
        case let .unsigned(value): head(major: 0, value: value)
        case let .negative(value): head(major: 1, value: value)
        case let .float(value):
            Data([0xfb] + (0..<8).reversed().map { UInt8((value.bitPattern >> UInt64($0 * 8)) & 0xff) })
        case let .bytes(bytes): head(major: 2, value: bytes.count) + bytes
        case let .text(string):
            head(major: 3, value: string.utf8.count) + Data(string.utf8)
        case let .array(values):
            values.reduce(into: head(major: 4, value: values.count)) { $0.append(encode($1)) }
        case let .map(entries):
            entries
                .map { (key: encode(.text($0.0)), value: $0.1) }
                .sorted { compare($0.key, $1.key) < 0 }
                .reduce(into: head(major: 5, value: entries.count)) {
                    $0.append($1.key)
                    $0.append(encode($1.value))
                }
        }
    }

    static func decode(_ data: Data) throws -> CanonicalCBORValue {
        var decoder = Decoder(data: data)
        let value = try decoder.decode(depth: 0)
        guard decoder.offset == data.count else { throw ArborWireValidationError.invalidCBOR("Trailing bytes") }
        guard encode(value) == data else { throw ArborWireValidationError.invalidCBOR("Encoding is not canonical") }
        return value
    }

    private static func head(major: UInt8, value: Int) -> Data {
        precondition(value >= 0)
        let major = major << 5
        if value < 24 { return Data([major | UInt8(value)]) }
        if value <= 0xff { return Data([major | 24, UInt8(value)]) }
        if value <= 0xffff { return Data([major | 25, UInt8(value >> 8), UInt8(value & 0xff)]) }
        if UInt64(value) <= UInt64(UInt32.max) {
            return Data([
                major | 26,
                UInt8((value >> 24) & 0xff),
                UInt8((value >> 16) & 0xff),
                UInt8((value >> 8) & 0xff),
                UInt8(value & 0xff),
            ])
        }
        let number = UInt64(value)
        return Data([major | 27] + (0..<8).reversed().map { UInt8((number >> UInt64($0 * 8)) & 0xff) })
    }

    private static func compare(_ left: Data, _ right: Data) -> Int {
        if left.count != right.count { return left.count < right.count ? -1 : 1 }
        for (a, b) in zip(left, right) where a != b { return a < b ? -1 : 1 }
        return 0
    }

    private struct Decoder {
        let data: Data
        var offset = 0

        mutating func decode(depth: Int) throws -> CanonicalCBORValue {
            guard depth <= 64 else { throw ArborWireValidationError.invalidCBOR("Maximum nesting depth exceeded") }
            let first = try byte()
            switch first {
            case 0xf4: return .bool(false)
            case 0xf5: return .bool(true)
            case 0xf6: return .null
            case 0xfb:
                let bytes = try take(8)
                var bits: UInt64 = 0
                for byte in bytes { bits = bits << 8 | UInt64(byte) }
                let value = Double(bitPattern: bits)
                guard value.isFinite else { throw ArborWireValidationError.invalidCBOR("Non-finite float") }
                return .float(value)
            default: break
            }
            let major = first >> 5
            let additional = first & 31
            guard major <= 5 else {
                throw ArborWireValidationError.invalidCBOR("Unsupported CBOR major type")
            }
            let length = try readLength(additional)
            switch major {
            case 0:
                return .unsigned(length)
            case 1:
                return .negative(length)
            case 2:
                return .bytes(try take(length))
            case 3:
                let bytes = try take(length)
                guard let value = String(data: bytes, encoding: .utf8) else {
                    throw ArborWireValidationError.invalidCBOR("Invalid UTF-8 text")
                }
                return .text(value)
            case 4:
                var values: [CanonicalCBORValue] = []
                values.reserveCapacity(length)
                for _ in 0..<length { values.append(try decode(depth: depth + 1)) }
                return .array(values)
            case 5:
                var values: [(String, CanonicalCBORValue)] = []
                var keys = Set<String>()
                var previousKey: Data?
                for _ in 0..<length {
                    let keyStart = offset
                    guard case let .text(key) = try decode(depth: depth + 1) else {
                        throw ArborWireValidationError.invalidCBOR("Map key is not text")
                    }
                    let encodedKey = data.subdata(in: keyStart..<offset)
                    if let previousKey, CanonicalCBOR.compare(previousKey, encodedKey) >= 0 {
                        throw ArborWireValidationError.invalidCBOR("Map keys are not in canonical order")
                    }
                    guard keys.insert(key).inserted else { throw ArborWireValidationError.invalidCBOR("Duplicate map key") }
                    previousKey = encodedKey
                    values.append((key, try decode(depth: depth + 1)))
                }
                return .map(values)
            default:
                throw ArborWireValidationError.invalidCBOR("Unsupported CBOR value")
            }
        }

        mutating func readLength(_ additional: UInt8) throws -> Int {
            if additional < 24 { return Int(additional) }
            let byteCount: Int
            switch additional {
            case 24: byteCount = 1
            case 25: byteCount = 2
            case 26: byteCount = 4
            case 27: byteCount = 8
            default: throw ArborWireValidationError.invalidCBOR("Indefinite or reserved length")
            }
            let bytes = try take(byteCount)
            var value: UInt64 = 0
            for byte in bytes { value = value << 8 | UInt64(byte) }
            if (byteCount == 1 && value < 24) || (byteCount == 2 && value <= 0xff) ||
                (byteCount == 4 && value <= 0xffff) || (byteCount == 8 && value <= UInt64(UInt32.max)) {
                throw ArborWireValidationError.invalidCBOR("Non-minimal length")
            }
            guard value <= UInt64(Int.max) else { throw ArborWireValidationError.invalidCBOR("Length is too large") }
            return Int(value)
        }

        mutating func byte() throws -> UInt8 {
            guard offset < data.count else { throw ArborWireValidationError.invalidCBOR("Unexpected end of input") }
            defer { offset += 1 }
            return data[offset]
        }

        mutating func take(_ count: Int) throws -> Data {
            guard count >= 0, offset <= data.count - count else {
                throw ArborWireValidationError.invalidCBOR("Length exceeds input")
            }
            defer { offset += count }
            return data.subdata(in: offset..<(offset + count))
        }
    }
}
