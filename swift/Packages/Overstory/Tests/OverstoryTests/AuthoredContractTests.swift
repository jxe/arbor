import Foundation
import Testing
@testable import Overstory

@Suite("Target authored update contract")
struct AuthoredContractTests {
    @Test("Shared grammar, round trips and canonical request identities")
    func sharedVectors() throws {
        let root = ProcessInfo.processInfo.environment["STORY_PROTOCOL_FIXTURES"].map { URL(fileURLWithPath: $0) }
            ?? URL(fileURLWithPath: #filePath).deletingLastPathComponent().appending(path: "../../../../../docs/overstory-spec/conformance").standardizedFileURL
        let fixture = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: root.appending(path: "protocol-authored-updates.json"))) as? [String: Any])
        let tree = try #require(fixture["tree"] as? String)
        for c in try #require(fixture["cases"] as? [[String: Any]]) {
            let bytes = try JSONSerialization.data(withJSONObject: #require(c["value"]))
            if c["valid"] as? Bool == true {
                let value = try JSONDecoder().decode(ProtocolAuthoredRequestIntent.self, from: bytes)
                #expect(try JSONDecoder().decode(ProtocolAuthoredRequestIntent.self, from: JSONEncoder().encode(value)) == value)
                let expected = try #require(c["identities"] as? [[String: String]])
                let updates = try #require(value.fields["updates"]?.items).map { raw in
                    try ProtocolAuthoredCandidate(intent: #require(raw.fields), payload: .init(objects: [], deltas: []))
                }
                let actual = try ProtocolAuthoredUpdateRequest(base: value.fields["base"]?.text, updates: updates).identities(tree: tree)
                #expect(actual.count == expected.count)
                for (a, e) in zip(actual, expected) {
                    #expect(a.digest == e["digest"], "\(c["name"] ?? "case")")
                    #expect(a.bytes.base64EncodedString() == e["canonicalCBORBase64"])
                }
            } else {
                #expect(throws: (any Error).self, "\(c["name"] ?? "case")") { try JSONDecoder().decode(ProtocolAuthoredRequestIntent.self, from: bytes) }
            }
        }
    }
}

@Suite("Derived row updates")
struct DerivedUpdateTests {
    @Test("A derived row update built in Swift has the shared vector's identity")
    func derivedRowVector() throws {
        let root = ProcessInfo.processInfo.environment["STORY_PROTOCOL_FIXTURES"].map { URL(fileURLWithPath: $0) }
            ?? URL(fileURLWithPath: #filePath).deletingLastPathComponent().appending(path: "../../../../../docs/overstory-spec/conformance").standardizedFileURL
        let fixture = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: root.appending(path: "protocol-authored-updates.json"))) as? [String: Any])
        let tree = try #require(fixture["tree"] as? String)
        let c = try #require((fixture["cases"] as? [[String: Any]])?.first { $0["name"] as? String == "derived row change" })
        let value = try JSONDecoder().decode(ProtocolAuthoredRequestIntent.self, from: JSONSerialization.data(withJSONObject: #require(c["value"])))
        let element = try #require(value.fields["updates"]?.items?.first?.fields)
        let operations = try #require(element["trace"]?.items?.first?.fields?["operations"]?.items).map { try ProtocolSourceOperation(#require($0.fields)) }
        let update = try ProtocolDerivedUpdate(change: #require(element["change"]?.text), frames: [operations])
        let expected = try #require(c["identities"] as? [[String: String]])
        let base = try #require(value.fields["base"]?.text)
        #expect(derivedUpdateRequestDigests(tree: tree, base: base, updates: [update]) == expected.map { $0["digest"]! })
        // A stated decoder refuses it: it names no candidate.
        let body = try JSONEncoder().encode(ProtocolDerivedUpdateRequest(base: "accepted", updates: [update]))
        #expect(throws: (any Error).self) { try JSONDecoder().decode(ProtocolUpdateRequest.self, from: body) }
    }

    @Test("Row operation builders make valid operations")
    func rowBuilders() throws {
        let target = ProtocolRowTarget(path: "/games", object: "sha256:" + String(repeating: "2", count: 64), model: "Game", row: #"[["id","g1"]]"#)
        let at = Date(timeIntervalSince1970: 1_761_380_000.5)
        let set = try ProtocolSourceOperation.rowSet(key: "set", target, field: "title", before: .string("Chess"), value: .string("Chess960"), at: at)
        #expect(set.fields["at"]?.text == "2025-10-25T08:13:20.500Z")
        _ = try ProtocolSourceOperation.rowCreate(key: "create", target, values: ["id": .string("g2"), "title": .string("Go")])
        _ = try ProtocolSourceOperation.rowDelete(key: "delete", target)
        _ = try ProtocolSourceOperation.rowConnect(key: "connect", target, field: "lists", member: .string("l1"))
        _ = try ProtocolSourceOperation.rowMove(key: "move", target, field: "lists", member: .string("l1"), after: .null)
        #expect(throws: (any Error).self) { try ProtocolSourceOperation.rowSet(key: "bad key!", target, field: "title", before: .null, value: .null) }
    }
}
