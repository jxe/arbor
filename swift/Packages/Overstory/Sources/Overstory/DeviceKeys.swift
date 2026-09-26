import CryptoKit
import Foundation

/// A key device's public key as `devices.yaml` spells it (accounts §3): an
/// algorithm tag and the raw public key in unpadded base64url. `ed25519` keys
/// are 32 bytes; `p256` keys are 33-byte compressed SEC1 points, which sign
/// with ECDSA over SHA-256 as the 64-byte concatenation of `r` and `s`.
public struct ProtocolDeviceKey: Sendable, Equatable {
    public enum Algorithm: String, Sendable {
        case ed25519
        case p256
    }

    public var algorithm: Algorithm
    public var publicKey: Data

    private static let spkiPrefixes: [Algorithm: [UInt8]] = [
        .ed25519: [0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00],
        .p256: [
            0x30, 0x39, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08,
            0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x22, 0x00,
        ],
    ]

    /// Parse a `key` value; throws unless it is canonical.
    public init(_ value: String) throws {
        let parts = value.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
        guard parts.count == 2,
              let algorithm = Algorithm(rawValue: String(parts[0])),
              let bytes = decodeBase64URL(String(parts[1])),
              bytes.count == (algorithm == .ed25519 ? 32 : 33),
              algorithm == .ed25519 || bytes.first == 0x02 || bytes.first == 0x03 else {
            throw ProtocolValidationError.invalidValue("Malformed device key: \(value)")
        }
        self.algorithm = algorithm
        self.publicKey = bytes
    }

    public init(ed25519 key: Curve25519.Signing.PublicKey) {
        algorithm = .ed25519
        publicKey = key.rawRepresentation
    }

    public init(p256 key: P256.Signing.PublicKey) {
        algorithm = .p256
        publicKey = key.compressedRepresentation
    }

    /// The `devices.yaml` spelling.
    public var value: String { "\(algorithm.rawValue):\(encodeBase64URL(publicKey))" }

    /// The DER SubjectPublicKeyInfo, as canopyd loads it.
    public var spki: Data { Data(Self.spkiPrefixes[algorithm]!) + publicKey }

    /// Whether `signature` (64 bytes, unpadded base64url) signs `message`.
    public func verifies(_ signature: String, over message: Data) -> Bool {
        guard let bytes = decodeBase64URL(signature), bytes.count == 64 else { return false }
        switch algorithm {
        case .ed25519:
            guard let key = try? Curve25519.Signing.PublicKey(rawRepresentation: publicKey) else { return false }
            return key.isValidSignature(bytes, for: message)
        case .p256:
            guard let key = try? P256.Signing.PublicKey(compressedRepresentation: publicKey),
                  let parsed = try? P256.Signing.ECDSASignature(rawRepresentation: bytes) else { return false }
            return key.isValidSignature(parsed, for: message)
        }
    }
}

/// What a key device signs to open a session at `origin` (accounts §5.1).
public struct ProtocolDeviceSessionChallenge: Codable, Sendable, Equatable {
    public var version: Int
    public var purpose: String
    public var id: String
    public var origin: String
    public var profileTree: String
    public var device: String
    public var nonce: String
    public var issuedAt: Int
    public var expiresAt: Int

    public func validated() throws -> Self {
        guard version == 1, purpose == "device-session",
              id.range(of: #"^ax_[a-z2-7]{26}$"#, options: .regularExpression) != nil,
              isCanonicalOrigin(origin),
              profileTree.range(of: #"^tr_[a-z2-7]+$"#, options: .regularExpression) != nil,
              device.range(of: #"^dv_[a-z2-7]+$"#, options: .regularExpression) != nil,
              nonce.range(of: #"^[A-Za-z0-9_-]{43}$"#, options: .regularExpression) != nil,
              issuedAt >= 0, expiresAt > issuedAt else {
            throw ProtocolValidationError.invalidValue("Malformed device session challenge")
        }
        return self
    }
}

/// Exact canonical bytes a key device signs to open a session.
public func deviceSessionChallengeSigningBytes(_ challenge: ProtocolDeviceSessionChallenge) throws -> Data {
    let value = try challenge.validated()
    return CanonicalCBOR.encode(.map([
        ("version", .unsigned(value.version)),
        ("purpose", .text(value.purpose)),
        ("id", .text(value.id)),
        ("origin", .text(value.origin)),
        ("profileTree", .text(value.profileTree)),
        ("device", .text(value.device)),
        ("nonce", .text(value.nonce)),
        ("issuedAt", .unsigned(value.issuedAt)),
        ("expiresAt", .unsigned(value.expiresAt)),
    ]))
}

/// A session a key device opened; `token` is a bearer credential for one host.
public struct ProtocolDeviceSession: Codable, Sendable, Equatable {
    public var token: String
    public var device: String
    public var expiresAt: Int
}

/// The new administrator device a profile-key reset installs.
public struct ProtocolProfileResetDevice: Codable, Sendable, Equatable {
    public var id: String
    public var label: String
    public var key: String

    public init(id: String, label: String, key: String) {
        self.id = id
        self.label = label
        self.key = key
    }

    public func validated() throws -> Self {
        let trimmed = label.trimmingCharacters(in: .whitespacesAndNewlines)
        guard id.range(of: #"^dv_[a-z2-7]{26}$"#, options: .regularExpression) != nil,
              !trimmed.isEmpty, label.utf16.count <= 100,
              (try? ProtocolDeviceKey(key)) != nil else {
            throw ProtocolValidationError.invalidValue("A reset names a new device with a generated DeviceID, a label and a key")
        }
        return self
    }
}

/// What the profile key signs to reset its devices at `origin` (accounts §5.3).
public struct ProtocolProfileResetChallenge: Codable, Sendable, Equatable {
    public var version: Int
    public var purpose: String
    public var id: String
    public var origin: String
    public var profileTree: String
    public var device: ProtocolProfileResetDevice
    public var nonce: String
    public var issuedAt: Int
    public var expiresAt: Int

    public func validated() throws -> Self {
        guard version == 1, purpose == "profile-reset",
              id.range(of: #"^ax_[a-z2-7]{26}$"#, options: .regularExpression) != nil,
              isCanonicalOrigin(origin),
              profileTree.range(of: #"^tr_[a-z2-7]{52}$"#, options: .regularExpression) != nil,
              nonce.range(of: #"^[A-Za-z0-9_-]{43}$"#, options: .regularExpression) != nil,
              issuedAt >= 0, expiresAt > issuedAt else {
            throw ProtocolValidationError.invalidValue("Malformed profile reset challenge")
        }
        _ = try device.validated()
        return self
    }
}

/// Exact canonical bytes the profile key signs to request a reset.
public func profileResetChallengeSigningBytes(_ challenge: ProtocolProfileResetChallenge) throws -> Data {
    let value = try challenge.validated()
    return CanonicalCBOR.encode(.map([
        ("version", .unsigned(value.version)),
        ("purpose", .text(value.purpose)),
        ("id", .text(value.id)),
        ("origin", .text(value.origin)),
        ("profileTree", .text(value.profileTree)),
        ("device", .map([
            ("id", .text(value.device.id)),
            ("label", .text(value.device.label)),
            ("key", .text(value.device.key)),
        ])),
        ("nonce", .text(value.nonce)),
        ("issuedAt", .unsigned(value.issuedAt)),
        ("expiresAt", .unsigned(value.expiresAt)),
    ]))
}

/// A pending reset, as the home host reports it to the profile's devices.
public struct ProtocolPendingProfileReset: Codable, Sendable, Equatable {
    public struct Device: Codable, Sendable, Equatable {
        public var id: String
        public var label: String
    }

    public var profileTree: String
    public var device: Device
    public var requestedAt: Int
    public var effectiveAt: Int
}

private func isCanonicalOrigin(_ value: String) -> Bool {
    guard let url = URL(string: value), let scheme = url.scheme, let host = url.host(), url.path.isEmpty,
          url.query == nil, url.fragment == nil, url.user == nil else { return false }
    let port = url.port.map { ":\($0)" } ?? ""
    return value == "\(scheme.lowercased())://\(host.lowercased())\(port)"
}

func decodeBase64URL(_ value: String) -> Data? {
    guard value.range(of: #"^[A-Za-z0-9_-]*$"#, options: .regularExpression) != nil else { return nil }
    var base64 = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
    guard let data = Data(base64Encoded: base64), encodeBase64URL(data) == value else { return nil }
    return data
}

func encodeBase64URL(_ data: Data) -> String {
    data.base64EncodedString()
        .replacingOccurrences(of: "+", with: "-")
        .replacingOccurrences(of: "/", with: "_")
        .replacingOccurrences(of: "=", with: "")
}
