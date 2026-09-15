import ArborWire
import Foundation
import CoreFoundation

/// Read-only adaptation of pre-cutover app caches. Never used for network data,
/// working-tree heads, pending requests or rejection records. Those caches were
/// written before Canopy could accept unresolved state, so a missing flag is false.
public enum SavedTreeDescriptorUpgrade {
    public static func placements(_ data: Data) throws -> Data {
        var root = try object(data)
        if root["placements"] != nil {
            try version(root, 2)
            root["placements"] = try records(root["placements"])
        } else {
            root = try record(root)
        }
        return try JSONSerialization.data(withJSONObject: root)
    }

    public static func visits(_ data: Data) throws -> Data {
        var root = try object(data)
        try version(root, 1)
        root["visits"] = try records(root["visits"])
        return try JSONSerialization.data(withJSONObject: root)
    }

    private static func object(_ data: Data) throws -> [String: Any] {
        guard let value = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw ArborWireValidationError.invalidValue("Invalid saved tree collection")
        }
        return value
    }
    private static func version(_ value: [String: Any], _ expected: Int) throws {
        guard let number = value["version"] as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID(), number.intValue == expected,
              number.doubleValue == Double(expected) else {
            throw ArborWireValidationError.invalidValue("Unsupported saved tree record version")
        }
    }
    private static func records(_ value: Any?) throws -> [[String: Any]] {
        guard let values = value as? [[String: Any]] else {
            throw ArborWireValidationError.invalidValue("Invalid saved tree records")
        }
        return try values.map(record)
    }
    private static func record(_ value: [String: Any]) throws -> [String: Any] {
        try version(value, 1)
        var result = value
        guard var tree = result["tree"] as? [String: Any] else {
            throw ArborWireValidationError.invalidValue("Missing saved tree descriptor")
        }
        if tree["conflicted"] == nil { tree["conflicted"] = false }
        _ = try JSONDecoder().decode(WireTreeDescriptor.self, from: JSONSerialization.data(withJSONObject: tree)).validated()
        result["tree"] = tree
        return result
    }
}
