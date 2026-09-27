import Foundation
import Testing
@testable import Overstory

/// `protocol-cbor-transport.json` through both encodings (tree operations
/// §4.4), as `cbor-transport.test.ts` runs it in TypeScript.
@Suite("CBOR and JSON request bodies")
struct CBORTransportTests {
    private func vectors() throws -> [String: Any] {
        let root = ProcessInfo.processInfo.environment["ARBOR_PROTOCOL_FIXTURES"].map { URL(fileURLWithPath: $0) }
            ?? URL(fileURLWithPath: #filePath).deletingLastPathComponent().appending(path: "../../../../../docs/overstory-spec/conformance").standardizedFileURL
        return try #require(JSONSerialization.jsonObject(with: Data(contentsOf: root.appending(path: "protocol-cbor-transport.json"))) as? [String: Any])
    }

    private func cases(_ name: String) throws -> [[String: Any]] {
        try #require(try vectors()[name] as? [[String: Any]])
    }

    private func json(_ entry: [String: Any]) throws -> Data {
        try JSONSerialization.data(withJSONObject: #require(entry["json"]))
    }

    private func cbor(_ entry: [String: Any]) throws -> Data {
        try #require(Data(base64Encoded: #require(entry["canonicalCBORBase64"] as? String)))
    }

    @Test("Every request vector decodes to one model and one set of digests in both encodings")
    func requests() throws {
        for entry in try cases("requests") {
            let name = Comment(rawValue: entry["name"] as? String ?? "?")
            let fromJSON = try JSONDecoder().decode(ProtocolUpdateRequest.self, from: json(entry))
            let fromCBOR = try CanonicalCBORDecoder().decode(ProtocolUpdateRequest.self, from: cbor(entry))
            #expect(fromCBOR == fromJSON, name)
            #expect(try CanonicalCBOREncoder().encode(fromJSON) == cbor(entry), name)
            #expect(try JSONDecoder().decode(ProtocolUpdateRequest.self, from: JSONEncoder().encode(fromCBOR)) == fromJSON, name)
            // A request's identity is its intent, never its body.
            let tree = try #require(entry["tree"] as? String)
            let expected = try #require(entry["requestDigests"] as? [String])
            #expect(updateRequestDigests(tree: tree, base: fromJSON.base, updates: fromJSON.updates) == expected, name)
            #expect(updateRequestDigests(tree: tree, base: fromCBOR.base, updates: fromCBOR.updates) == expected, name)
        }
    }

    @Test("Every response vector decodes to one model in both encodings")
    func responses() throws {
        for entry in try cases("responses") {
            let name = Comment(rawValue: entry["name"] as? String ?? "?")
            let fromJSON = try JSONDecoder().decode(ProtocolUpdateResponse.self, from: json(entry))
            let fromCBOR = try CanonicalCBORDecoder().decode(ProtocolUpdateResponse.self, from: cbor(entry))
            #expect(fromCBOR == fromJSON, name)
            #expect(try CanonicalCBOREncoder().encode(fromJSON) == cbor(entry), name)
        }
    }

    @Test("A claim carries its configuration as an activation element in both encodings")
    func claims() throws {
        for entry in try cases("claims") {
            let name = Comment(rawValue: entry["name"] as? String ?? "?")
            let fromJSON = try JSONDecoder().decode(ProtocolExistingProfileClaimRequest.self, from: json(entry))
            let fromCBOR = try CanonicalCBORDecoder().decode(ProtocolExistingProfileClaimRequest.self, from: cbor(entry))
            #expect(fromCBOR == fromJSON, name)
            #expect(fromJSON.configuration.trace == nil && fromJSON.configuration.deltas.isEmpty, name)
            #expect(try CanonicalCBOREncoder().encode(fromJSON) == cbor(entry), name)
            // The Swift claim path builds the same element from the journal's snapshot.
            let snapshot = ProtocolSnapshot(root: fromJSON.configuration.candidate, objects: fromJSON.configuration.objects)
            #expect(ProtocolCandidateUpdate.activation(snapshot, change: fromJSON.configuration.change) == fromJSON.configuration, name)
        }
    }

    @Test("Rejected CBOR bodies are refused")
    func rejected() throws {
        for entry in try cases("rejected") {
            let name = Comment(rawValue: entry["name"] as? String ?? "?")
            let bytes = try cbor(entry)
            switch entry["kind"] as? String {
            case "request":
                #expect(throws: (any Error).self, name) { try CanonicalCBORDecoder().decode(ProtocolUpdateRequest.self, from: bytes) }
            case "response":
                #expect(throws: (any Error).self, name) { try CanonicalCBORDecoder().decode(ProtocolUpdateResponse.self, from: bytes) }
            default:
                #expect(throws: (any Error).self, name) { try CanonicalCBORDecoder().decode(ProtocolExistingProfileClaimRequest.self, from: bytes) }
            }
        }
    }

    @Test("A prepared update keeps its encoding and reads back its request")
    func preparedEncoding() async throws {
        let file = try ProtocolObjectCodec.object(.file(Data("encoded".utf8)))
        let root = try ProtocolObjectCodec.object(.directory([.init(name: "note.md", file: file.hash)]))
        let snapshot = ProtocolSnapshot(root: root.hash, objects: [file, root])
        let base = ProtocolUpdateBase(root: "sha256:" + String(repeating: "0", count: 64), update: "up_base")
        let origin = URL(string: "https://canopy.test")!
        let cbor = try await ProtocolClient(origin: origin).prepareUpdate(tree: "tr_encoded", base: base, snapshot: snapshot)
        let json = try await ProtocolClient(origin: origin, encoding: .json).prepareUpdate(tree: "tr_encoded", base: base, snapshot: snapshot)
        #expect(cbor.contentType == "application/cbor" && cbor.encoding == .cbor)
        #expect(json.contentType == nil && json.encoding == .json)
        #expect(cbor.body != json.body)
        // Both carry the same candidate; the digests do not depend on the encoding.
        #expect(try cbor.decodedRequest().updates.map(\.candidate) == json.decodedRequest().updates.map(\.candidate))
        #expect(cbor.requestDigests.count == 1 && json.requestDigests.count == 1)
    }

    @Test("The CBOR codec spells numbers as JavaScript does and bytes only as byte strings")
    func codecScalars() throws {
        struct Sample: Codable, Equatable { var whole: Double; var fraction: Double; var count: Int; var data: Data; var note: String? }
        let sample = Sample(whole: 3, fraction: 1.5, count: -2, data: Data([1, 2]), note: nil)
        let bytes = try CanonicalCBOREncoder().encode(sample)
        // An integral double is a CBOR integer; an omitted optional is absent.
        #expect(bytes == CanonicalCBOR.encode(.map([
            ("whole", .unsigned(3)), ("fraction", .float(1.5)), ("count", .negative(1)), ("data", .bytes(Data([1, 2]))),
        ])))
        #expect(try CanonicalCBORDecoder().decode(Sample.self, from: bytes) == sample)
        // Base64 text where a byte string belongs is refused.
        let text = CanonicalCBOR.encode(.map([("whole", .unsigned(3)), ("fraction", .float(1.5)), ("count", .negative(1)), ("data", .text("AQI="))]))
        #expect(throws: (any Error).self) { try CanonicalCBORDecoder().decode(Sample.self, from: text) }
        // An integral float is not canonical.
        #expect(throws: (any Error).self) { try CanonicalCBOR.decode(Data([0xfb, 0x3f, 0xf0, 0, 0, 0, 0, 0, 0])) }
        #expect(ProtocolWireEncoding(contentType: "application/cbor; charset=binary") == .cbor)
        #expect(ProtocolWireEncoding(contentType: nil) == .json)
    }
}
