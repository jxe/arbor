import CryptoKit
import Foundation
import Testing
@testable import Overstory

private var deviceKeyVectors: URL {
    let root = ProcessInfo.processInfo.environment["ARBOR_PROTOCOL_FIXTURES"].map { URL(fileURLWithPath: $0, isDirectory: true) }
        ?? URL(fileURLWithPath: #filePath).deletingLastPathComponent().appending(path: "../../../../../docs/overstory-spec/conformance").standardizedFileURL
    return root.appending(path: "device-keys.json")
}

private struct DeviceKeyVectors: Decodable {
    struct Key: Decodable { var name: String; var key: String; var spkiHex: String? }
    struct Keys: Decodable { var valid: [Key]; var invalid: [Key] }
    struct Session: Decodable {
        var name: String
        var key: String
        var challenge: ProtocolDeviceSessionChallenge
        var cborHex: String
        var signature: String
        var tamperedSignature: String
    }
    struct Reset: Decodable {
        var name: String
        var profilePublicKey: String
        var challenge: ProtocolProfileResetChallenge
        var cborHex: String
        var signature: String
    }
    var keys: Keys
    var sessionChallenges: [Session]
    var resetChallenges: [Reset]
}

private func hex(_ data: Data) -> String { data.map { String(format: "%02x", $0) }.joined() }

private func vectors() throws -> DeviceKeyVectors {
    try JSONDecoder().decode(DeviceKeyVectors.self, from: Data(contentsOf: deviceKeyVectors))
}

/// The raw JSON of one list, for invalid cases that do not decode as models.
private func rawCases(_ name: String) throws -> [[String: Any]] {
    let object = try JSONSerialization.jsonObject(with: Data(contentsOf: deviceKeyVectors)) as? [String: Any]
    return try #require(object?[name] as? [[String: Any]])
}

@Suite("Device keys contract")
struct DeviceKeysTests {
    @Test func keyEncodings() throws {
        let fixture = try vectors()
        for vector in fixture.keys.valid {
            let key = try ProtocolDeviceKey(vector.key)
            #expect(key.value == vector.key, "\(vector.name)")
            #expect(hex(key.spki) == vector.spkiHex, "\(vector.name)")
        }
        for vector in fixture.keys.invalid {
            #expect(throws: (any Error).self, "\(vector.name)") { try ProtocolDeviceKey(vector.key) }
        }
    }

    @Test func sessionChallenges() throws {
        for vector in try vectors().sessionChallenges {
            let bytes = try deviceSessionChallengeSigningBytes(vector.challenge)
            #expect(hex(bytes) == vector.cborHex, "\(vector.name)")
            let key = try ProtocolDeviceKey(vector.key)
            #expect(key.verifies(vector.signature, over: bytes), "\(vector.name)")
            #expect(!key.verifies(vector.tamperedSignature, over: bytes), "\(vector.name)")
        }
        for vector in try rawCases("invalidSessionChallenges") {
            let data = try JSONSerialization.data(withJSONObject: vector["challenge"]!)
            #expect(throws: (any Error).self, "\(vector["name"]!)") {
                try JSONDecoder().decode(ProtocolDeviceSessionChallenge.self, from: data).validated()
            }
        }
    }

    @Test func resetChallenges() throws {
        for vector in try vectors().resetChallenges {
            let bytes = try profileResetChallengeSigningBytes(vector.challenge)
            #expect(hex(bytes) == vector.cborHex, "\(vector.name)")
            let profileKey = try ProtocolDeviceKey("ed25519:\(vector.profilePublicKey)")
            #expect(profileKey.verifies(vector.signature, over: bytes))
        }
        for vector in try rawCases("invalidResetChallenges") {
            let data = try JSONSerialization.data(withJSONObject: vector["challenge"]!)
            #expect(throws: (any Error).self, "\(vector["name"]!)") {
                try JSONDecoder().decode(ProtocolProfileResetChallenge.self, from: data).validated()
            }
        }
    }

    @Test func originsAreSpelledAsWebOrigins() throws {
        var challenge = try vectors().sessionChallenges[0].challenge
        for origin in ["http://127.0.0.1:4317", "http://[::1]:4317", "https://canopy.example:8443"] {
            challenge.origin = origin
            #expect(throws: Never.self, "\(origin)") { try challenge.validated() }
        }
        for origin in ["https://canopy.example:443", "http://localhost:80", "HTTPS://canopy.example", "https://Canopy.example", "https://canopy.example/"] {
            challenge.origin = origin
            #expect(throws: (any Error).self, "\(origin)") { try challenge.validated() }
        }
    }

    @Test func keysSignWhatTheyVerify() throws {
        let challenge = try vectors().sessionChallenges[0].challenge
        let bytes = try deviceSessionChallengeSigningBytes(challenge)
        let edPrivate = Curve25519.Signing.PrivateKey()
        let ed = ProtocolDeviceKey(ed25519: edPrivate.publicKey)
        let edSignature = try edPrivate.signature(for: bytes).base64URL
        #expect(ed.verifies(edSignature, over: bytes))
        let ecPrivate = P256.Signing.PrivateKey()
        let ec = ProtocolDeviceKey(p256: ecPrivate.publicKey)
        let reparsed = try ProtocolDeviceKey(ec.value)
        #expect(reparsed == ec)
        let ecSignature = try ecPrivate.signature(for: bytes).rawRepresentation.base64URL
        #expect(ec.verifies(ecSignature, over: bytes))
    }

    @Test func deviceKeySecretsRoundTripAndSignWhatTheirKeyVerifies() throws {
        let challenge = try vectors().sessionChallenges[1].challenge
        let bytes = try deviceSessionChallengeSigningBytes(challenge)
        for secret in [try DeviceKeySecret.generate(), .software(P256.Signing.PrivateKey().rawRepresentation)] {
            #expect(DeviceKeySecret(stored: secret.stored) == secret)
            let key = try secret.publicKey()
            #expect(key.algorithm == .p256)
            #expect(key.verifies(try secret.sign(bytes), over: bytes))
        }
        #expect(DeviceKeySecret(stored: "a-bearer-credential") == nil)
        #expect(DeviceKeySecret(stored: "arbor-device-key:v1:xx:AAAA") == nil)
    }

    @Test func pairingDeviceHoldsExactlyOneBinding() throws {
        let key = ProtocolDeviceKey(p256: P256.Signing.PrivateKey().publicKey)
        #expect(throws: Never.self) { try ProtocolPairingDevice(id: "dv_phone", label: "Phone", key: key).validated() }
        var both = ProtocolPairingDevice(id: "dv_phone", label: "Phone", key: key)
        both.credentialDigest = "sha256:" + String(repeating: "0", count: 64)
        #expect(throws: (any Error).self) { try both.validated() }
        let encoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(ProtocolPairingDevice(id: "dv_phone", label: "Phone", key: key))) as? [String: String]
        #expect(encoded == ["id": "dv_phone", "label": "Phone", "key": key.value])
    }
}

private extension Data {
    var base64URL: String {
        base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
}
