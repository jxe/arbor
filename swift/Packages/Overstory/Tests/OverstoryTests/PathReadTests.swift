import Foundation
import Testing
@testable import Overstory

private var conformance: URL {
    if let path = ProcessInfo.processInfo.environment["STORY_PROTOCOL_FIXTURES"] {
        return URL(fileURLWithPath: path, isDirectory: true)
    }
    return URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()
        .appending(path: "../../../../../docs/overstory-spec/conformance")
        .standardizedFileURL
}

private struct PathReadFixture: Decodable {
    struct Object: Decodable { var hash: String; var base64: String }
    struct Valid: Decodable { var name: String; var path: String; var objects: [String]; var bundleBase64: String }
    struct Invalid: Decodable { var name: String; var path: String; var bundleBase64: String; var error: String }
    var root: String
    var objects: [Object]
    var valid: [Valid]
    var invalid: [Invalid]
}

/// Clients 003: the path read walk is the same in both languages
/// (`protocol-path-reads.json`, tree operations §1.2.4).
@Suite("Path reads")
struct PathReadTests {
    private func fixture() throws -> PathReadFixture {
        try JSONDecoder().decode(PathReadFixture.self, from: Data(contentsOf: conformance.appending(path: "protocol-path-reads.json")))
    }

    @Test("Swift walks every shared case to the same objects and bundle")
    func validCases() async throws {
        let fixture = try fixture()
        let objects = Dictionary(uniqueKeysWithValues: fixture.objects.map { ($0.hash, Data(base64Encoded: $0.base64)!) })
        for vector in fixture.valid {
            let read = try await ProtocolPathRead.objects(root: fixture.root, path: vector.path) { objects[$0] }
            #expect(read.keys.sorted() == vector.objects, "\(vector.name)")
            let bundle = try #require(Data(base64Encoded: vector.bundleBase64))
            let decoded = try await ProtocolPathRead.decode(bundle, root: fixture.root, path: vector.path)
            #expect(decoded.keys.sorted() == vector.objects, "\(vector.name)")
        }
    }

    @Test("Swift rejects every shared invalid bundle")
    func invalidCases() async throws {
        let fixture = try fixture()
        for vector in fixture.invalid {
            let bundle = try #require(Data(base64Encoded: vector.bundleBase64))
            await #expect(throws: (any Error).self, "\(vector.name)") {
                _ = try await ProtocolPathRead.decode(bundle, root: fixture.root, path: vector.path)
            }
        }
    }

    @Test("URL suffixes encode each segment once and refuse escapes")
    func urls() throws {
        #expect(try ProtocolPathRead.urlSuffix("/Trips/Café au lait") == "/Trips/Caf%C3%A9%20au%20lait")
        #expect(try ProtocolPathRead.urlSuffix("/") == "")
        #expect(throws: (any Error).self) { try ProtocolPathRead.urlSuffix("/a/../b") }
        #expect(try ProtocolPathRead.components("/Trips/_index.md") == ["Trips"])
        #expect(try ProtocolPathRead.components("/Trips/Paris.md") == ["Trips", "Paris"])
    }
}
