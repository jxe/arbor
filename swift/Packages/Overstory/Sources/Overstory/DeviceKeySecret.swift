import CryptoKit
import Foundation

/// This device's private key for one account (accounts §5), as it is kept in
/// the credential slot a digest device's bearer credential uses. A Secure
/// Enclave key is stored as its opaque `dataRepresentation`, which only this
/// device's enclave can use; a software key, where no enclave is available
/// (the simulator), as its raw scalar.
public enum DeviceKeySecret: Sendable, Equatable {
    case secureEnclave(Data)
    case software(Data)

    static let prefix = "arbor-device-key:v1:"

    /// A new P-256 key, in the Secure Enclave when this device has one.
    public static func generate() throws -> DeviceKeySecret {
        if SecureEnclave.isAvailable {
            return .secureEnclave(try SecureEnclave.P256.Signing.PrivateKey().dataRepresentation)
        }
        return .software(P256.Signing.PrivateKey().rawRepresentation)
    }

    /// A stored slot value, or nil when the slot holds a bearer credential.
    public init?(stored: String) {
        guard stored.hasPrefix(Self.prefix) else { return nil }
        let rest = stored.dropFirst(Self.prefix.count)
        let parts = rest.split(separator: ":", maxSplits: 1)
        guard parts.count == 2, let data = decodeBase64URL(String(parts[1])) else { return nil }
        switch parts[0] {
        case "se": self = .secureEnclave(data)
        case "sw": self = .software(data)
        default: return nil
        }
    }

    public var stored: String {
        switch self {
        case let .secureEnclave(data): Self.prefix + "se:" + encodeBase64URL(data)
        case let .software(data): Self.prefix + "sw:" + encodeBase64URL(data)
        }
    }

    public func publicKey() throws -> ProtocolDeviceKey {
        switch self {
        case let .secureEnclave(data): ProtocolDeviceKey(p256: try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: data).publicKey)
        case let .software(data): ProtocolDeviceKey(p256: try P256.Signing.PrivateKey(rawRepresentation: data).publicKey)
        }
    }

    /// An ECDSA P-256 signature over SHA-256 of `message`: `r || s`, unpadded base64url.
    public func sign(_ message: Data) throws -> String {
        let signature = switch self {
        case let .secureEnclave(data): try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: data).signature(for: message)
        case let .software(data): try P256.Signing.PrivateKey(rawRepresentation: data).signature(for: message)
        }
        return encodeBase64URL(signature.rawRepresentation)
    }
}

extension ProtocolClient {
    /// Open a session at this client's host for `device` of `profileTree`:
    /// the challenge must name exactly them (the client checks its origin),
    /// and the key signs its canonical bytes.
    public func openDeviceSession(profileTree: String, device: String, key: DeviceKeySecret) async throws -> ProtocolDeviceSession {
        let challenge = try await createDeviceSessionChallenge(profileTree: profileTree, device: device)
        guard challenge.profileTree == profileTree, challenge.device == device else {
            throw ProtocolValidationError.invalidValue("The host's session challenge names another profile or device")
        }
        let session = try await openDeviceSession(challenge: challenge, signature: try key.sign(deviceSessionChallengeSigningBytes(challenge)))
        guard session.device == device, !session.token.isEmpty else {
            throw ProtocolValidationError.invalidValue("The host opened a session for another device")
        }
        return session
    }
}

/// Hands out sessions a device key opens, reusing one until five minutes
/// before it expires. `load` reads the key; nil means the account has none.
public actor DeviceSessionCredentialProvider: ProtocolCredentialProvider {
    private let origin: URL
    private let profileTree: String
    private let device: String
    private let key: DeviceKeySecret
    private let session: URLSession
    private var cached: ProtocolDeviceSession?
    private var opening: Task<ProtocolDeviceSession, Error>?

    public init(origin: URL, profileTree: String, device: String, key: DeviceKeySecret, session: URLSession = .shared) {
        self.origin = origin
        self.profileTree = profileTree
        self.device = device
        self.key = key
        self.session = session
    }

    public func credential() async throws -> String? {
        let margin = 5 * 60 * 1000
        if let cached, cached.expiresAt - margin > Int(Date().timeIntervalSince1970 * 1000) { return cached.token }
        if let opening { return try await opening.value.token }
        let (origin, profileTree, device, key, session) = (origin, profileTree, device, key, session)
        let task = Task { try await ProtocolClient(origin: origin, session: session).openDeviceSession(profileTree: profileTree, device: device, key: key) }
        opening = task
        defer { opening = nil }
        let opened = try await task.value
        cached = opened
        return opened.token
    }

    public func invalidate() {
        cached = nil
        opening?.cancel()
        opening = nil
    }
}
