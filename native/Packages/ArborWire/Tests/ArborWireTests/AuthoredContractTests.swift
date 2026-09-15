import Foundation
import Testing
@testable import ArborWire

@Suite("Target authored update contract")
struct AuthoredContractTests {
    @Test("Shared grammar, round trips and canonical request identities")
    func sharedVectors() throws {
        let root = ProcessInfo.processInfo.environment["ARBOR_PROTOCOL_FIXTURES"].map { URL(fileURLWithPath: $0) }
            ?? URL(fileURLWithPath: #filePath).deletingLastPathComponent().appending(path: "../../../../../conformance").standardizedFileURL
        let fixture = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: root.appending(path: "wire-authored-updates.json"))) as? [String: Any])
        let tree = try #require(fixture["tree"] as? String)
        for c in try #require(fixture["cases"] as? [[String: Any]]) {
            let bytes = try JSONSerialization.data(withJSONObject: #require(c["value"]))
            if c["valid"] as? Bool == true {
                let value = try JSONDecoder().decode(WireAuthoredRequestIntent.self, from: bytes)
                #expect(try JSONDecoder().decode(WireAuthoredRequestIntent.self, from: JSONEncoder().encode(value)) == value)
                let expected = try #require(c["identities"] as? [[String: String]])
                let actual = try value.identities(tree: tree)
                #expect(actual.count == expected.count)
                for (a, e) in zip(actual, expected) {
                    #expect(a.digest == e["digest"], "\(c["name"] ?? "case")")
                    #expect(a.bytes.base64EncodedString() == e["canonicalCBORBase64"])
                }
            } else {
                #expect(throws: (any Error).self, "\(c["name"] ?? "case")") { try JSONDecoder().decode(WireAuthoredRequestIntent.self, from: bytes) }
            }
        }
    }
}
