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
        // A rule encodes back to exactly the object it was decoded from.
        func sameJSON(_ encoded: Data, _ original: Any) throws -> Bool {
            let canonical = { (value: Any) in try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) }
            return try canonical(JSONSerialization.jsonObject(with: encoded)) == canonical(original)
        }
        for vector in fixture["valid"] ?? [] {
            let bytes = try JSONSerialization.data(withJSONObject: vector["rule"]!)
            let rule = try JSONDecoder().decode(ProtocolResourceAccessRule.self, from: bytes)
            let roundtrip = try JSONDecoder().decode(ProtocolResourceAccessRule.self, from: JSONEncoder().encode(rule))
            #expect(rule == roundtrip)
            #expect(try sameJSON(JSONEncoder().encode(rule), vector["rule"]!), "\(vector["name"]!)")
        }
        for vector in fixture["safe"] ?? [] {
            let redacted = try #require(vector["redacted"] as? [String: Any])
            let response: [String: Any] = ["snapshot": [], "policy": [redacted], "observedThrough": "cursor"]
            let bytes = try JSONSerialization.data(withJSONObject: response)
            let projection = try #require(JSONDecoder().decode(ProtocolTreeAccessSnapshot.self, from: bytes).policy?.first)
            #expect(try sameJSON(JSONEncoder().encode(projection), redacted), "\(vector["name"]!)")
            let rule = try JSONDecoder().decode(ProtocolResourceAccessRule.self, from: JSONSerialization.data(withJSONObject: vector["rule"]!))
            switch (rule.who, projection.who) {
            case (.link, .link): break
            case let (.profile(id, host), .profile(safeID, safeHost)): #expect(id == safeID && host == safeHost)
            default: Issue.record("\(vector["name"]!): the projection names another subject")
            }
        }
        for vector in fixture["invalid"] ?? [] {
            let bytes = try JSONSerialization.data(withJSONObject: vector["rule"]!)
            #expect(throws: (any Error).self, "\(vector["name"]!)") { try JSONDecoder().decode(ProtocolResourceAccessRule.self, from: bytes) }
        }
        func validateFile(_ vector: [String: Any]) throws {
            if let access = vector["access"] {
                try ProtocolResourceAccessRule.validateFile(JSONDecoder().decode([ProtocolResourceAccessRule].self, from: JSONSerialization.data(withJSONObject: access)))
            } else {
                try ProtocolAppAccessRule.validateFile(JSONDecoder().decode([String: [ProtocolAppAccessRule]].self, from: JSONSerialization.data(withJSONObject: vector["apps"]!)))
            }
        }
        for vector in fixture["validFiles"] ?? [] {
            #expect(throws: Never.self, "\(vector["name"]!)") { try validateFile(vector) }
        }
        for vector in fixture["invalidFiles"] ?? [] {
            #expect(throws: (any Error).self, "\(vector["name"]!)") { try validateFile(vector) }
        }
    }

    @Test func homeHostIsWhereToLookNotWho() throws {
        let remote = ProtocolResourceWho.profile("tr_club", homeHost: "https://club.example")
        // `==` compares the subject as written; the merge key compares the TreeID.
        #expect(remote != .profile("tr_club"))
        #expect(remote.mergeSubject == .profile("tr_club"))
        #expect(remote.homeHost == "https://club.example")
        let read = try ProtocolResourceAccessRule(who: remote, allow: [.read])
        #expect(read.sameMergeKey(as: try ProtocolResourceAccessRule(who: .profile("tr_club"), allow: [.write])))
        #expect(!read.sameMergeKey(as: try ProtocolResourceAccessRule(who: .profile("tr_club"), allow: [.write], within: "/notes")))
        // An edit that respells the subject by TreeID keeps the file's host.
        #expect(ProtocolResourceWho.profile("tr_club").adoptingHomeHost(from: [.everyone, remote]) == remote)
        #expect(ProtocolResourceWho.profile("tr_alice").adoptingHomeHost(from: [remote]) == .profile("tr_alice"))
        #expect(throws: (any Error).self) { try ProtocolResourceAccessRule(who: .profile("tr_club", homeHost: "http://club.example"), allow: [.read]) }
        #expect(throws: (any Error).self) { try ProtocolAppAccessRule(resource: "tr_notes", who: .profile("tr_club", homeHost: "https://club.example/"), allow: [.read]) }
    }
}

@Suite("Tree configuration contract")
struct TreeConfigurationTests {
    @Test func derivedConfigurationTreeIDs() throws {
        let root = ProcessInfo.processInfo.environment["ARBOR_PROTOCOL_FIXTURES"].map { URL(fileURLWithPath: $0) }
            ?? URL(fileURLWithPath: #filePath).deletingLastPathComponent().appending(path: "../../../../../docs/overstory-spec/conformance").standardizedFileURL
        let data = try Data(contentsOf: root.appending(path: "tree-configuration.json"))
        let fixture = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let derivation = try #require(fixture["derivation"] as? [[String: String]])
        for vector in derivation {
            #expect(treeConfigurationID(vector["tree"]!) == vector["configuration"]!)
        }
    }
}
