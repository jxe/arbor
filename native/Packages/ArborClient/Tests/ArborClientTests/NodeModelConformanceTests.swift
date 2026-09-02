import Foundation
import XCTest
@testable import ArborClient

private struct AnyKey: CodingKey {
    var stringValue: String
    var intValue: Int? { nil }
    init?(stringValue: String) { self.stringValue = stringValue }
    init?(intValue: Int) { return nil }
}

private let forbiddenNodeFields = ["tree", "path", "kind", "pageID", "collection", "document", "children"]

private func rejectLegacyNodeFields(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: AnyKey.self)
    for field in forbiddenNodeFields {
        if container.contains(AnyKey(stringValue: field)!) {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "legacy node field \(field)"))
        }
    }
}

private struct FrozenNodeRef: Decodable, Equatable {
    var tree: String
    var path: String
    var stableKey: String?

    private enum CodingKeys: String, CodingKey { case tree, path, stableKey, pageID, pathHint }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        guard container.contains(.stableKey) else {
            throw DecodingError.keyNotFound(CodingKeys.stableKey, .init(codingPath: decoder.codingPath, debugDescription: "stableKey must be explicit"))
        }
        guard !container.contains(.pageID), !container.contains(.pathHint) else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "legacy PageID ref"))
        }
        tree = try container.decode(String.self, forKey: .tree)
        path = try container.decode(String.self, forKey: .path)
        stableKey = try container.decodeIfPresent(String.self, forKey: .stableKey)
        if let stableKey, encodeStableKey(stableKey) == nil {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "noncanonical stable key"))
        }
    }
}

private struct FrozenIdentityRule: Decodable {
    var properties: [String]

    private enum CodingKeys: String, CodingKey { case properties, scope }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        if container.contains(.scope) {
            throw DecodingError.dataCorruptedError(forKey: .scope, in: container, debugDescription: "identity rule scope was removed")
        }
        properties = try container.decode([String].self, forKey: .properties)
    }
}

private struct FrozenIdentityCase: Decodable {
    var name: String
    var rule: FrozenIdentityRule
    var properties: [String: JSONValue]
    var stableKey: String
}

private struct FrozenPropertiesCapability: Decodable, Equatable {
    var revision: String
    var schema: String?
    var writable: Bool
}

private struct FrozenContentCapability: Decodable, Equatable {
    var revision: String
    var mediaType: String
    var format: String?
    var writable: Bool
}

private struct FrozenChildrenCapability: Decodable, Equatable {
    var revision: String
    var schema: String?
    var representation: JSONValue?
    var total: Int?
    var writable: Bool
}

private struct FrozenExecutableCapability: Decodable, Equatable {
    var version: String
    var state: String
}

private struct FrozenCapabilities: Decodable, Equatable {
    var properties: FrozenPropertiesCapability? = nil
    var content: FrozenContentCapability? = nil
    var children: FrozenChildrenCapability? = nil
    var executable: FrozenExecutableCapability? = nil
}

private struct FrozenNodeContent: Decodable {
    var source: String
    var representation: JSONValue?
}

private struct FrozenNodeSnapshot: Decodable {
    var ref: FrozenNodeRef
    var name: String
    var revision: String
    var properties: [String: JSONValue]
    var capabilities: FrozenCapabilities
    var content: FrozenNodeContent?
    var materialization: String
    var diagnostics: [JSONValue]
    var observedThrough: String

    init(from decoder: Decoder) throws {
        try rejectLegacyNodeFields(from: decoder)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        ref = try container.decode(FrozenNodeRef.self, forKey: .ref)
        name = try container.decode(String.self, forKey: .name)
        revision = try container.decode(String.self, forKey: .revision)
        properties = try container.decode([String: JSONValue].self, forKey: .properties)
        capabilities = try container.decode(FrozenCapabilities.self, forKey: .capabilities)
        content = try container.decodeIfPresent(FrozenNodeContent.self, forKey: .content)
        materialization = try container.decode(String.self, forKey: .materialization)
        diagnostics = try container.decode([JSONValue].self, forKey: .diagnostics)
        observedThrough = try container.decode(String.self, forKey: .observedThrough)
        guard materialization == "available" || materialization == "placeholder" else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "invalid materialization"))
        }
    }

    private enum CodingKeys: String, CodingKey {
        case ref, name, revision, properties, capabilities, content, materialization, diagnostics, observedThrough
    }
}

private struct FrozenNodeSummary: Decodable {
    var ref: FrozenNodeRef
    var name: String
    var revision: String
    var properties: [String: JSONValue]
    var capabilities: FrozenCapabilities
    var materialization: String
    var diagnostics: [JSONValue]

    init(from decoder: Decoder) throws {
        try rejectLegacyNodeFields(from: decoder)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        ref = try container.decode(FrozenNodeRef.self, forKey: .ref)
        name = try container.decode(String.self, forKey: .name)
        revision = try container.decode(String.self, forKey: .revision)
        properties = try container.decode([String: JSONValue].self, forKey: .properties)
        capabilities = try container.decode(FrozenCapabilities.self, forKey: .capabilities)
        materialization = try container.decode(String.self, forKey: .materialization)
        diagnostics = try container.decode([JSONValue].self, forKey: .diagnostics)
    }

    private enum CodingKeys: String, CodingKey {
        case ref, name, revision, properties, capabilities, materialization, diagnostics
    }
}

private struct FrozenChildrenPage: Decodable {
    var parent: FrozenNodeRef
    var items: [FrozenNodeSummary]
    var nextCursor: String?
    var observedThrough: String
}

private struct FrozenRollup: Decodable {
    var version: Int
    var codec: String
    var source: String
    var schemaSource: String
    var schema: String
    var scope: String
    var modelHash: String
}

private struct FrozenNamed<Value: Decodable>: Decodable {
    var name: String
    var value: Value
}

private struct FrozenNodeModelFixture: Decodable {
    var version: String
    var identityRules: [FrozenIdentityCase]
    var invalidIdentityRules: [FrozenNamed<JSONValue>]
    var snapshots: [FrozenNamed<FrozenNodeSnapshot>]
    var childrenPages: [FrozenNamed<FrozenChildrenPage>]
    var rollups: [FrozenRollup]
    var forwardCompatibleSnapshot: FrozenNodeSnapshot
    var invalidSnapshots: [FrozenNamed<JSONValue>]
}

final class NodeModelConformanceTests: XCTestCase {
    private var fixtures: URL {
        if let path = ProcessInfo.processInfo.environment["ARBOR_PROTOCOL_FIXTURES"] {
            return URL(fileURLWithPath: path, isDirectory: true)
        }
        return URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .appending(path: "../../../../../conformance")
            .standardizedFileURL
    }

    func testSwiftDecodesTheFrozenNodeModelIndependently() throws {
        let data = try Data(contentsOf: fixtures.appending(path: "node-model.json"))
        let value = try JSONDecoder().decode(FrozenNodeModelFixture.self, from: data)
        XCTAssertEqual(value.version, "node-model-v1")
        XCTAssertEqual(value.snapshots.map(\.value.ref.path), ["/practices", "/data", "/assets/portrait.png"])
        XCTAssertEqual(value.childrenPages.first?.value.items.count, 2)
        XCTAssertTrue(value.childrenPages.first?.value.items.allSatisfy { $0.ref.stableKey != nil } ?? false)
        XCTAssertEqual(value.rollups.map(\.codec), ["csv", "json", "jsonl"])
        XCTAssertEqual(Set(value.rollups.map(\.modelHash)).count, 1)

        for item in value.identityRules {
            let pairs = try item.rule.properties.map { property in
                (property, try XCTUnwrap(item.properties[property], "missing \(property) in \(item.name)"))
            }
            XCTAssertEqual(try canonicalStableKey(pairs), item.stableKey, item.name)
        }
        for item in value.invalidIdentityRules {
            let data = try JSONEncoder().encode(item.value)
            XCTAssertThrowsError(try JSONDecoder().decode(FrozenIdentityRule.self, from: data), item.name)
        }

        XCTAssertEqual(
            value.forwardCompatibleSnapshot.capabilities,
            FrozenCapabilities(properties: .init(revision: "future:1", schema: nil, writable: false))
        )
    }

    func testSwiftRejectsEveryFrozenLegacyNodeShape() throws {
        let data = try Data(contentsOf: fixtures.appending(path: "node-model.json"))
        let value = try JSONDecoder().decode(FrozenNodeModelFixture.self, from: data)
        XCTAssertEqual(value.invalidSnapshots.map(\.name), [
            "missing-nullable-stable-key",
            "legacy-page-reference",
            "duplicated-location",
            "public-kind-taxonomy",
            "implicit-write-grant",
        ])
        for item in value.invalidSnapshots {
            let encoded = try JSONEncoder().encode(item.value)
            XCTAssertThrowsError(try JSONDecoder().decode(FrozenNodeSnapshot.self, from: encoded), item.name)
        }
    }
}
