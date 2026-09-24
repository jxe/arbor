import Foundation
import Testing
@testable import Overstory

@Suite("Resource authority contract")
struct ResourcePolicyTests {
    @Test func sharedVectors() throws {
        let root = ProcessInfo.processInfo.environment["ARBOR_PROTOCOL_FIXTURES"].map { URL(fileURLWithPath: $0) }
            ?? URL(fileURLWithPath: #filePath).deletingLastPathComponent().appending(path: "../../../../../docs/overstory-spec/conformance").standardizedFileURL
        let data = try Data(contentsOf: root.appending(path: "resource-policy.json"))
        let fixture = try #require(JSONSerialization.jsonObject(with: data) as? [String: [[String: Any]]])
        for vector in fixture["valid"] ?? [] {
            let bytes = try JSONSerialization.data(withJSONObject: vector["rule"]!)
            let rule = try JSONDecoder().decode(ProtocolResourceAccessRule.self, from: bytes)
            let roundtrip = try JSONDecoder().decode(ProtocolResourceAccessRule.self, from: JSONEncoder().encode(rule))
            #expect(rule == roundtrip)
        }
        for vector in fixture["safe"] ?? [] {
            let rule = try #require(vector["redacted"] as? [String: Any])
            let response: [String: Any] = ["snapshot": [], "policy": [rule], "observedThrough": "cursor"]
            let bytes = try JSONSerialization.data(withJSONObject: response)
            let projection = try JSONDecoder().decode(ProtocolTreeAccessSnapshot.self, from: bytes)
            #expect(projection.policy?.first?.who == .link)
            #expect(projection.policy?.first?.via == "tr_supplies")
        }
        for vector in fixture["invalid"] ?? [] {
            let bytes = try JSONSerialization.data(withJSONObject: vector["rule"]!)
            #expect(throws: (any Error).self) { try JSONDecoder().decode(ProtocolResourceAccessRule.self, from: bytes) }
        }
    }
}
