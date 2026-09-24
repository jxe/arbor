import Foundation
import Testing
@testable import Overstory

extension ProtocolAuthoredUpdateRequest {
    /// The request identities as the production submission path computes them.
    func identities(tree: String) throws -> [(bytes: Data, digest: String)] {
        updateRequestIdentities(tree: tree, base: base, updates: try updates.map(ProtocolCandidateUpdate.init))
    }
}

@Suite("Consolidated request transport")
struct AuthoredTransportTests {
    private func fixture(_ name: String) throws -> [String: Any] {
        let root = ProcessInfo.processInfo.environment["ARBOR_PROTOCOL_FIXTURES"].map { URL(fileURLWithPath: $0) }
            ?? URL(fileURLWithPath: #filePath).deletingLastPathComponent().appending(path: "../../../../../docs/overstory-spec/conformance").standardizedFileURL
        return try #require(JSONSerialization.jsonObject(with: Data(contentsOf: root.appending(path: name))) as? [String: Any])
    }
    private func check(_ c: [String: Any], tree: String) throws {
        let data = try JSONSerialization.data(withJSONObject: #require(c["value"]))
        if c["valid"] as? Bool != true {
            #expect(throws: (any Error).self, "\(c["name"] ?? "case")") { try JSONDecoder().decode(ProtocolAuthoredUpdateRequest.self, from: data) }
            return
        }
        let request = try JSONDecoder().decode(ProtocolAuthoredUpdateRequest.self, from: data)
        #expect(try JSONDecoder().decode(ProtocolAuthoredUpdateRequest.self, from: JSONEncoder().encode(request)) == request)
        let expected = try #require(c["identities"] as? [[String: String]])
        let actual = try request.identities(tree: tree)
        #expect(actual.count == expected.count)
        for (a,e) in zip(actual,expected) {
            #expect(a.digest == e["digest"], "\(c["name"] ?? "case")")
            #expect(a.bytes.base64EncodedString() == e["canonicalCBORBase64"])
        }
    }
    @Test("Shared complete request, transport and digest vectors")
    func transportVectors() throws {
        let f = try fixture("protocol-authored-transport.json")
        let tree = try #require(f["tree"] as? String)
        for c in try #require(f["cases"] as? [[String: Any]]) { try check(c,tree:tree) }
    }
    @Test("Transport preserves every semantic grammar rule")
    func semanticVectors() throws {
        let f = try fixture("protocol-authored-updates.json")
        let tree = try #require(f["tree"] as? String)
        for var c in try #require(f["cases"] as? [[String: Any]]) {
            var value = try #require(c["value"] as? [String: Any])
            value["updates"] = try #require(value["updates"] as? [[String: Any]]).map { u in
                var next = u; next["objects"] = [Any](); next["deltas"] = [Any](); return next
            }
            c["value"] = value
            try check(c,tree:tree)
        }
    }
    @Test("Sparse bytes reconstruct exactly and restart preserves appended prefix")
    func transportAndRestart() throws {
        let f = try fixture("protocol-authored-transport.json")
        let tree = try #require(f["tree"] as? String)
        let cases = try #require(f["cases"] as? [[String: Any]])
        func request(_ index: Int) throws -> ProtocolAuthoredUpdateRequest {
            try JSONDecoder().decode(ProtocolAuthoredUpdateRequest.self,from: JSONSerialization.data(withJSONObject: #require(cases[index]["value"])))
        }
        let complete = try request(0), sparse = try request(1)
        let basis = try #require(f["basis"] as? [String: Any])
        let objects = try JSONDecoder().decode([ProtocolObjectEnvelope].self,from:JSONSerialization.data(withJSONObject: #require(basis["objects"])))
        for delta in sparse.updates[0].payload.deltas {
            let base = try #require(objects.first { $0.hash == delta.base })
            let result = try #require(complete.updates[0].payload.objects.first { $0.hash == delta.result })
            #expect(try delta.apply(to: base.bytes) == result.bytes)
        }
        #expect(try complete.identities(tree: tree)[0].digest == sparse.identities(tree: tree)[0].digest)
        let full = try request(5)
        let prefix = try ProtocolAuthoredUpdateRequest(base: full.base,updates: [full.updates[0]])
        let directory = FileManager.default.temporaryDirectory.appending(path: "arbor-authored-request-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory,withIntermediateDirectories:true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let path = directory.appending(path: "pending.json")
        try JSONEncoder().encode(prefix).write(to:path,options:.atomic)
        let restored = try JSONDecoder().decode(ProtocolAuthoredUpdateRequest.self,from:Data(contentsOf:path))
        let appended = try ProtocolAuthoredUpdateRequest(base:restored.base,updates:restored.updates+[full.updates[1]])
        #expect(appended.updates[0] == prefix.updates[0])
        #expect(try appended.identities(tree:tree)[0].digest == prefix.identities(tree:tree)[0].digest)
        try JSONEncoder().encode(appended).write(to:path,options:.atomic)
        #expect(try JSONDecoder().decode(ProtocolAuthoredUpdateRequest.self,from:Data(contentsOf:path)) == full)
    }
}
