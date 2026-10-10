import Foundation
import Testing
@testable import Overstory

@Suite("Resource authority contract")
struct ResourcePolicyTests {
    @Test func sharedVectors() throws {
        let root = ProcessInfo.processInfo.environment["STORY_PROTOCOL_FIXTURES"].map { URL(fileURLWithPath: $0) }
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
            let response: [String: Any] = ["policy": [redacted], "locators": [:] as [String: String]]
            let bytes = try JSONSerialization.data(withJSONObject: response)
            let projection = try #require(JSONDecoder().decode(ProtocolTreeAccess.self, from: bytes).policy.first)
            #expect(try sameJSON(JSONEncoder().encode(projection), redacted), "\(vector["name"]!)")
            let rule = try JSONDecoder().decode(ProtocolResourceAccessRule.self, from: JSONSerialization.data(withJSONObject: vector["rule"]!))
            switch (rule.who, projection.who) {
            case (.link, .link): break
            case let (.profile(id), .profile(safeID)): #expect(id == safeID)
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
        // A locator's canonical spelling and origin, exactly as the reference implementation gives them.
        for vector in fixture["locators"] ?? [] {
            let input = try #require(vector["input"] as? String)
            let parsed = try #require(ProfileLocator(input), "\(input)")
            #expect(parsed.locator == vector["locator"] as? String, "\(input)")
            #expect(parsed.origin == vector["origin"] as? String, "\(input)")
        }
        for vector in fixture["validFiles"] ?? [] {
            #expect(throws: Never.self, "\(vector["name"]!)") { try validateFile(vector) }
        }
        for vector in fixture["invalidFiles"] ?? [] {
            #expect(throws: (any Error).self, "\(vector["name"]!)") { try validateFile(vector) }
        }
    }

    @Test func aProfileAnotherHostHoldsIsNamedByItsLocator() throws {
        // Decoding spells a locator canonically, which is its merge key.
        let decoded = try JSONDecoder().decode(ProtocolResourceWho.self, from: Data(#"{"profile":"overstory://club.example/~club/"}"#.utf8))
        #expect(decoded == .profile("https://club.example/~club"))
        #expect(decoded.profileLocator?.origin == "https://club.example")
        #expect(ProtocolResourceWho.profile("tr_club").profileLocator == nil)
        let read = try ProtocolResourceAccessRule(who: decoded, allow: [.read])
        #expect(read.sameMergeKey(as: try ProtocolResourceAccessRule(who: .profile("https://club.example/~club"), allow: [.write])))
        #expect(!read.sameMergeKey(as: try ProtocolResourceAccessRule(who: .profile("tr_club"), allow: [.write])))
        // A rule is built only from a subject in its canonical spelling.
        #expect(throws: (any Error).self) { try ProtocolResourceAccessRule(who: .profile("overstory://club.example/~club"), allow: [.read]) }
        #expect(throws: (any Error).self) { try ProtocolResourceAccessRule(who: .profile("http://club.example/~club"), allow: [.read]) }
        #expect(throws: (any Error).self) { try ProtocolAppAccessRule(resource: "tr_notes", who: .profile("https://club.example/"), allow: [.read]) }
    }

    // Rename 002: `arbor://` is read as `overstory://` and never written. The cases are the
    // ones the TypeScript parser runs, in `tests/fixtures/legacy-names/aliases.json`.
    @Test func theOldSchemeNamesTheSameProfile() throws {
        let fixture = try #require(JSONSerialization.jsonObject(with: legacyAliases()) as? [String: Any])
        let cases = try #require(fixture["profileLocators"] as? [[String: String]])
        #expect(!cases.isEmpty)
        for item in cases {
            let input = try #require(item["input"])
            let parsed = try #require(ProfileLocator(input), "\(input)")
            #expect(parsed.locator == item["locator"], "\(input)")
            #expect(parsed.origin == item["origin"], "\(input)")
            let decoded = try JSONDecoder().decode(ProtocolResourceWho.self, from: JSONSerialization.data(withJSONObject: ["profile": input]))
            #expect(decoded == .profile(parsed.locator))
            #expect(String(decoding: try JSONEncoder().encode(decoded), as: UTF8.self).contains("arbor") == false)
        }
        #expect(ProfileLocator("arbor://tr_club/") == nil)
    }

    @Test func aJoinLinkNamesTheAccountItInvitesTo() throws {
        let joined = try #require(ProfileLocator("overstory://club.example/~alice;overstory-invite=Ab3-_.~9"))
        #expect(joined.locator == "https://club.example/~alice")
        #expect(joined == ProfileLocator("https://club.example/~alice"))
        // The secret is dropped only from an `overstory://` join link.
        #expect(ProfileLocator("https://club.example/~alice;overstory-invite=abc")?.locator == "https://club.example/~alice;overstory-invite=abc")
    }
}

@Suite("Tree configuration contract")
struct TreeConfigurationTests {
    @Test func derivedConfigurationTreeIDs() throws {
        let root = ProcessInfo.processInfo.environment["STORY_PROTOCOL_FIXTURES"].map { URL(fileURLWithPath: $0) }
            ?? URL(fileURLWithPath: #filePath).deletingLastPathComponent().appending(path: "../../../../../docs/overstory-spec/conformance").standardizedFileURL
        let data = try Data(contentsOf: root.appending(path: "tree-configuration.json"))
        let fixture = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let derivation = try #require(fixture["derivation"] as? [[String: String]])
        for vector in derivation {
            #expect(treeConfigurationID(vector["tree"]!) == vector["configuration"]!)
        }
    }

    // Rename 002: `;arbor-config` is read as `;overstory-config` and never written.
    @Test func bothConfigurationSpellingsAreRead() throws {
        #expect(treeConfigurationParameter == "overstory-config")
        let fixture = try #require(JSONSerialization.jsonObject(with: legacyAliases()) as? [String: Any])
        let cases = try #require(fixture["treeReferences"] as? [[String: Any]])
        #expect(!cases.isEmpty)
        for item in cases {
            let value = try #require(item["value"] as? String)
            let parsed = parseTreeReference(value)
            if item["invalid"] as? Bool == true {
                #expect(parsed == nil, "\(value)")
            } else {
                #expect(parsed?.tree == item["tree"] as? String, "\(value)")
                #expect(parsed?.configuration == item["configuration"] as? Bool, "\(value)")
            }
        }
        let new = try #require(parseTreeReference("tr_abc;overstory-config"))
        #expect(new.tree == "tr_abc" && new.configuration)
        let plain = try #require(parseTreeReference("tr_abc"))
        #expect(plain.tree == "tr_abc" && !plain.configuration)
        #expect(parseTreeReference("notes;overstory-config") == nil)
        let split = splittingTreeConfigurationParameter("https://host.example/~joe/todos;arbor-config")
        #expect(split.reference == "https://host.example/~joe/todos" && split.configuration)
        #expect(splittingTreeConfigurationParameter("/~joe/todos").configuration == false)
    }
}

/// Rename 002: the old-spelling cases shared with TypeScript. Delete with the aliases.
private func legacyAliases() throws -> Data {
    let root = ProcessInfo.processInfo.environment["STORY_REFERENCE_FIXTURES"].map { URL(fileURLWithPath: $0, isDirectory: true) }
        ?? URL(fileURLWithPath: #filePath).deletingLastPathComponent().appending(path: "../../../../../tests/fixtures").standardizedFileURL
    return try Data(contentsOf: root.appending(path: "legacy-names/aliases.json"))
}
