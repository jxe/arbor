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
    let root = ProcessInfo.processInfo.environment["STORY_PROTOCOL_FIXTURES"].map { URL(fileURLWithPath: $0, isDirectory: true) }
        ?? URL(fileURLWithPath: #filePath).deletingLastPathComponent().appending(path: "../../../../../docs/overstory-spec/conformance").standardizedFileURL
    return try JSONDecoder().decode(
        AccountChallengeSigningVectors.self,
        from: Data(contentsOf: root.appending(path: "protocol-account-challenges.json"))
    ).signing
}

private func hex(_ data: Data) -> String { data.map { String(format: "%02x", $0) }.joined() }

@Suite("Account challenge signing (accounts §1.2)")
struct AccountChallengeSigningTests {
    @Test("A challenge's signature covers its canonical CBOR")
    func homeSigningBytes() throws {
        let vectors = try signingVectors()
        let home = try #require(vectors.challenges.first { $0.name == "home" })

        let seed = Data(stride(from: 0, to: vectors.seedHex.count, by: 2).map { offset -> UInt8 in
            let start = vectors.seedHex.index(vectors.seedHex.startIndex, offsetBy: offset)
            return UInt8(vectors.seedHex[start..<vectors.seedHex.index(start, offsetBy: 2)], radix: 16)!
        })
        let publicKey = try Curve25519.Signing.PrivateKey(rawRepresentation: seed).publicKey
        let key = ProtocolDeviceKey(ed25519: publicKey)
        #expect(key.value == "ed25519:\(vectors.publicKey)")

        let homeBytes = try accountChallengeSigningBytes(home.challenge)
        #expect(hex(homeBytes) == home.canonicalCBORHex)
        #expect(key.verifies(home.signature, over: homeBytes))

        // A placement's challenge signs its purpose and the profile's home locator too.
        let placement = try #require(vectors.challenges.first { $0.name == "placement" })
        #expect(placement.challenge.purpose == "placement" && placement.challenge.profile != nil)
        let placementBytes = try accountChallengeSigningBytes(placement.challenge)
        #expect(hex(placementBytes) == placement.canonicalCBORHex)
        #expect(key.verifies(placement.signature, over: placementBytes))
    }
}
