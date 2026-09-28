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
                case "state":return try JSONEncoder().encode(JSONDecoder().decode(ProtocolAcceptedUpdate.self,from:data))
                case "inspection":
                    let page = try JSONDecoder().decode(ProtocolDecisionPageContract.self, from: data)
                    if c["name"] as? String == "text inspection uses material references" {
                        #expect(throws: (any Error).self) {
                            try page.validateContext(tree: "tr_test", state: "state-e\u{301}", root: "sha256:" + String(repeating: "1", count: 64))
                        }
                    }
                    return try JSONEncoder().encode(page)
                case "response":return try JSONEncoder().encode(JSONDecoder().decode(ProtocolUpdateResponse.self,from:data))
                case "chain":
                    struct Chain: Decodable { var tree: String; var previous: ProtocolAcceptedLink?; var updates: [ProtocolAcceptedUpdate]; var head: ProtocolAcceptedLink }
                    let chain=try JSONDecoder().decode(Chain.self,from:data)
                    try ProtocolAcceptedUpdate.validateChain(tree:chain.tree,previous:chain.previous,updates:chain.updates,head:chain.head);return nil
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
                    // A run of frames, each one transition whose basis is the one before it.
                    let tree=try #require(file["tree"] as? String)
                    let fields=try #require(c["basis"] as? [String:String])
                    var basis=ProtocolAcceptedLink(id:try #require(fields["id"]),root:try #require(fields["root"]))
                    var transitions:[ProtocolAcceptedTransition]=[]
                    for frame in try #require(c["value"] as? [Any]) {
                        let change=try JSONDecoder().decode(ProtocolTreeUpdateFrame.self,from:JSONSerialization.data(withJSONObject:frame))
                            .validated(tree:tree,basis:basis)
                        transitions.append(change.transition)
                        basis=ProtocolAcceptedLink(id:change.transition.update.id,root:change.transition.update.root)
                    }
                    if ["same-root decision followed by content in one batch", "sparse accepted transport", "net catch-up spans same-root accepted decisions"].contains(c["name"] as? String ?? "") {
                        let snapshotData=try JSONSerialization.data(withJSONObject:#require(file["snapshot"]))
                        var snapshot=try JSONDecoder().decode(ProtocolSnapshot.self,from:snapshotData)
                        for transition in transitions {
                            snapshot=try ProtocolTransitionReplay.applying(transition,to:snapshot)
                        }
                        #expect(snapshot.root==basis.root)
                        #expect(snapshot.objects.count==2)
                        #expect(snapshot.objects.contains { String(data:$0.bytes,encoding:.utf8)=="A paragraph.\nA second paragraph.\n" })
                    }
                    // Access, canonical placement and read extensions are compared by the descriptor's own tests.
                    return try JSONEncoder().encode(transitions)
                }
                return try JSONEncoder().encode(JSONDecoder().decode(ProtocolUpdateResponse.self,from:data))
            }
            if c["valid"] as? Bool == true, c["name"] as? String == "unknown read extensions remain data" {
                // Typed models accept unknown read fields without carrying them.
                _ = try decode()
            } else if c["valid"] as? Bool == true {
                var expected=try JSONDecoder().decode(ProtocolReadValue.self,from:data)
                if c["kind"] as? String == "watch", case .array(let frames)=expected {
                    expected = .array(try frames.map { frame in
                        guard case .object(let fields)=frame else { throw ProtocolValidationError.invalidValue("A watch frame is an object") }
                        return try #require(fields["transition"])
                    })
                }
                #expect(try JSONDecoder().decode(ProtocolReadValue.self,from:decode())==expected,"\(c["name"] ?? "case")")
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
