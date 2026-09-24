import Foundation
import Testing
@testable import Overstory

@Suite("Target accepted-state contracts")
struct AcceptedContractTests {
    @Test("Shared read and chain vectors")
    func vectors() throws {
        let root=ProcessInfo.processInfo.environment["ARBOR_PROTOCOL_FIXTURES"].map { URL(fileURLWithPath:$0) }
            ?? URL(fileURLWithPath:#filePath).deletingLastPathComponent().appending(path:"../../../../../docs/overstory-spec/conformance").standardizedFileURL
        let file=try #require(JSONSerialization.jsonObject(with:Data(contentsOf:root.appending(path:"protocol-accepted-state.json"))) as? [String:Any])
        for c in try #require(file["cases"] as? [[String:Any]]) {
            var v=try #require(c["value"] as? [String:Any])
            if let count=c["repeatDecisions"] as? Int {
                let first=try #require((v["decisions"] as? [[String:Any]])?.first)
                v["decisions"]=(0..<count).map { i in var d=first; d["id"]="decision_\(i)"; return d }
            }
            let data=try JSONSerialization.data(withJSONObject:v)
            func decode() throws -> Data? {
                switch c["kind"] as? String {
                case "state":return try JSONEncoder().encode(JSONDecoder().decode(ProtocolAcceptedStateContract.self,from:data))
                case "inspection":
                    let page = try JSONDecoder().decode(ProtocolDecisionPageContract.self, from: data)
                    if c["name"] as? String == "text inspection uses material references" {
                        #expect(throws: (any Error).self) {
                            try page.validateContext(tree: "tr_test", state: "state-e\u{301}", root: "sha256:" + String(repeating: "1", count: 64))
                        }
                    }
                    return try JSONEncoder().encode(page)
                case "response":return try JSONEncoder().encode(JSONDecoder().decode(ProtocolSubmissionResponseContract.self,from:data))
                case "chain":
                    let fields=try JSONDecoder().decode([String:ProtocolReadValue].self,from:data)
                    let updates=try JSONDecoder().decode([ProtocolAcceptedStateContract].self,from:JSONEncoder().encode(fields["updates"]))
                    try ProtocolAcceptedStateContract.validateChain(tree:#require(fields["tree"]?.text),previous:fields["previous"]?.fields,updates:updates,head:#require(fields["head"]?.fields));return nil
                default:throw ProtocolValidationError.invalidValue("Unexpected fixture kind")
                }
            }
            if c["valid"] as? Bool == true {
                if let encoded=try decode() {
                    #expect(try JSONDecoder().decode(ProtocolReadValue.self,from:encoded)==JSONDecoder().decode(ProtocolReadValue.self,from:data))
                }
            } else { #expect(throws:(any Error).self,"\(c["name"] ?? "case")") { try decode() } }
        }
    }
    @Test("Complete accepted read transport and confirmed identity bindings")
    func transport() throws {
        let root=ProcessInfo.processInfo.environment["ARBOR_PROTOCOL_FIXTURES"].map { URL(fileURLWithPath:$0) }
            ?? URL(fileURLWithPath:#filePath).deletingLastPathComponent().appending(path:"../../../../../docs/overstory-spec/conformance").standardizedFileURL
        let file=try #require(JSONSerialization.jsonObject(with:Data(contentsOf:root.appending(path:"protocol-accepted-transport.json"))) as? [String:Any])
        for c in try #require(file["cases"] as? [[String:Any]]) {
            let data=try JSONSerialization.data(withJSONObject:#require(c["value"]))
            func decode() throws -> Data {
                if c["kind"] as? String == "watch" {
                    let change=try JSONDecoder().decode(ProtocolAcceptedWatchChangeContract.self,from:data)
                    _ = try JSONDecoder().decode([ProtocolAcceptedTransition].self,from:JSONEncoder().encode(change.fields["transitions"]))
                    let basis=try #require(c["basis"] as? [String:String])
                    try change.validateBasis(tree:#require(file["tree"] as? String),id:#require(basis["id"]),root:#require(basis["root"]))
                    if ["same-root decision followed by content in one batch", "sparse accepted transport", "net catch-up spans same-root accepted decisions"].contains(c["name"] as? String ?? "") {
                        let snapshotData=try JSONSerialization.data(withJSONObject:#require(file["snapshot"]))
                        var snapshot=try JSONDecoder().decode(ProtocolSnapshot.self,from:snapshotData)
                        let transitions=try #require(change.fields["transitions"]?.items)
                        for raw in transitions {
                            let decoded=try JSONDecoder().decode(ProtocolAcceptedTransition.self,from:JSONEncoder().encode(raw))
                            snapshot=try ProtocolTransitionReplay.applying(decoded,to:snapshot)
                        }
                        #expect(snapshot.root==change.fields["descriptor"]?.fields?["root"]?.text)
                        #expect(snapshot.objects.count==2)
                        #expect(snapshot.objects.contains { String(data:$0.bytes,encoding:.utf8)=="A paragraph.\nA second paragraph.\n" })
                    }
                    return try JSONEncoder().encode(change)
                }
                _ = try JSONDecoder().decode(ProtocolUpdateResponse.self,from:data)
                return try JSONEncoder().encode(JSONDecoder().decode(ProtocolSubmissionResponseContract.self,from:data))
            }
            if c["valid"] as? Bool == true {
                #expect(try JSONDecoder().decode(ProtocolReadValue.self,from:decode())==JSONDecoder().decode(ProtocolReadValue.self,from:data))
            } else { #expect(throws:(any Error).self,"\(c["name"] ?? "case")") { try decode() } }
        }
    }
    @Test("Resolution groups have no fixed count limit")
    func largeResolution() throws {
        let alternatives=(0..<1025).map { ProtocolSemanticValue.string("a\($0)") }
        let resolves=(0..<40).map { ProtocolSemanticValue.object(["state":.string("u1"),"conflict":.string("d\($0)"),"alternatives":.array(alternatives)]) }
        let update: [String: ProtocolSemanticValue] = [
            "change": .string("c1"),
            "candidate": .string("sha256:" + String(repeating: "1", count: 64)),
            "trace": .array([]),
            "resolves": .array(resolves)
        ]
        _ = try ProtocolAuthoredRequestIntent(["base": .string("u1"), "updates": .array([.object(update)])])
    }
}
