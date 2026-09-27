import CryptoKit
import Foundation
import Testing
@testable import Overstory

private struct AccountChallengeSigningVectors: Decodable {
    struct Signed: Decodable {
        var name: String
        var challenge: ProtocolAccountChallenge
        var canonicalCBORHex: String
        var signature: String
    }
    struct Signing: Decodable {
        var seedHex: String
        var publicKey: String
        var challenges: [Signed]
    }
    var signing: Signing
}

private func signingVectors() throws -> AccountChallengeSigningVectors.Signing {
    let root = ProcessInfo.processInfo.environment["ARBOR_PROTOCOL_FIXTURES"].map { URL(fileURLWithPath: $0, isDirectory: true) }
        ?? URL(fileURLWithPath: #filePath).deletingLastPathComponent().appending(path: "../../../../../docs/overstory-spec/conformance").standardizedFileURL
    return try JSONDecoder().decode(
        AccountChallengeSigningVectors.self,
        from: Data(contentsOf: root.appending(path: "protocol-account-challenges.json"))
    ).signing
}

private func hex(_ data: Data) -> String { data.map { String(format: "%02x", $0) }.joined() }

@Suite("Account challenge signing (accounts §1.2, §1.3)")
struct AccountChallengeSigningTests {
    @Test("A home and a placement challenge sign different bytes, and neither signature stands in for the other")
    func homeAndPlacementSigningBytes() throws {
        let vectors = try signingVectors()
        let home = try #require(vectors.challenges.first { $0.name == "home" })
        let placement = try #require(vectors.challenges.first { $0.name == "placement" })
        var stripped = placement.challenge
        stripped.homeHost = nil
        #expect(stripped == home.challenge)
        #expect(placement.challenge.homeHost == "https://home.example")

        let seed = Data(stride(from: 0, to: vectors.seedHex.count, by: 2).map { offset -> UInt8 in
            let start = vectors.seedHex.index(vectors.seedHex.startIndex, offsetBy: offset)
            return UInt8(vectors.seedHex[start..<vectors.seedHex.index(start, offsetBy: 2)], radix: 16)!
        })
        let publicKey = try Curve25519.Signing.PrivateKey(rawRepresentation: seed).publicKey
        let key = ProtocolDeviceKey(ed25519: publicKey)
        #expect(key.value == "ed25519:\(vectors.publicKey)")

        let homeBytes = try accountChallengeSigningBytes(home.challenge)
        let placementBytes = try accountChallengeSigningBytes(placement.challenge)
        #expect(hex(homeBytes) == home.canonicalCBORHex)
        #expect(hex(placementBytes) == placement.canonicalCBORHex)
        #expect(homeBytes != placementBytes)
        #expect(key.verifies(home.signature, over: homeBytes))
        #expect(key.verifies(placement.signature, over: placementBytes))
        #expect(!key.verifies(home.signature, over: placementBytes))
        #expect(!key.verifies(placement.signature, over: homeBytes))
    }

    @Test("A challenge's home host is an HTTPS origin other than the challenging host")
    func homeHostValidation() throws {
        let placement = try #require(try signingVectors().challenges.first { $0.name == "placement" }).challenge
        _ = try placement.validated()
        for invalid in [placement.origin, "http://home.example", "https://home.example/", "https://home.example/path", "home.example"] {
            var challenge = placement
            challenge.homeHost = invalid
            #expect(throws: ProtocolValidationError.self, "\(invalid)") { try challenge.validated() }
        }
        for local in ["http://127.0.0.1:4318", "http://localhost:4318"] {
            var challenge = placement
            challenge.homeHost = local
            #expect(throws: Never.self, "\(local)") { try challenge.validated() }
        }
    }
}
