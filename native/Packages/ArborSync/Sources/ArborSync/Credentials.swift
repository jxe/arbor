import ArborWire
import Foundation
import Security

public protocol DeviceCredentialStore: Sendable {
    func load(origin: URL) async throws -> String?
    func save(_ credential: String, origin: URL) async throws
    func forget(origin: URL) async throws
}

public actor KeychainDeviceCredentialStore: DeviceCredentialStore {
    private let service: String

    public init(service: String = "org.nxhx.Arbor.device") { self.service = service }

    public func load(origin: URL) throws -> String? {
        var query = baseQuery(origin: origin)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data, let value = String(data: data, encoding: .utf8) else {
            throw OSStatusError(status)
        }
        return value
    }

    public func save(_ credential: String, origin: URL) throws {
        guard !credential.isEmpty else { throw ArborWireValidationError.invalidValue("Credential is empty") }
        try forget(origin: origin)
        var query = baseQuery(origin: origin)
        query[kSecValueData as String] = Data(credential.utf8)
        let status = SecItemAdd(query as CFDictionary, nil)
        guard status == errSecSuccess else { throw OSStatusError(status) }
    }

    public func forget(origin: URL) throws {
        let status = SecItemDelete(baseQuery(origin: origin) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw OSStatusError(status) }
    }

    private func baseQuery(origin: URL) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: origin.absoluteString,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        ]
    }
}

public struct OSStatusError: Error, Equatable, Sendable {
    public var status: OSStatus
    public init(_ status: OSStatus) { self.status = status }
}

public actor StoredDeviceCredentialProvider: AuthorityCredentialProvider {
    private let origin: URL
    private let store: any DeviceCredentialStore

    public init(origin: URL, store: any DeviceCredentialStore) {
        self.origin = origin
        self.store = store
    }

    public func credential() async throws -> String? { try await store.load(origin: origin) }
}

public struct PairingPayload: Codable, Equatable, Sendable {
    public struct Pairing: Codable, Equatable, Sendable {
        public var id: String
        public var secret: String
        public init(id: String, secret: String) { self.id = id; self.secret = secret }
    }
    public var version: Int
    public var origin: URL
    public var pairing: Pairing

    public init(version: Int = 1, origin: URL, pairing: Pairing) {
        self.version = version
        self.origin = origin
        self.pairing = pairing
    }

    public func validated() throws -> Self {
        guard version == 1, origin.scheme == "https", !pairing.id.isEmpty, !pairing.secret.isEmpty else {
            throw ArborWireValidationError.invalidValue("Malformed pairing payload")
        }
        return self
    }
}

public actor NativeAccountService {
    private let origin: URL
    private let credentials: any DeviceCredentialStore
    private let client: ArborAuthorityClient

    public init(origin: URL, credentials: any DeviceCredentialStore = KeychainDeviceCredentialStore()) {
        self.origin = origin
        self.credentials = credentials
        self.client = ArborAuthorityClient(
            origin: origin,
            credentialProvider: StoredDeviceCredentialProvider(origin: origin, store: credentials)
        )
    }

    public func claim(_ payload: PairingPayload, label: String) async throws -> AuthorityPairingClaim {
        let payload = try payload.validated()
        guard payload.origin == origin else { throw ArborWireValidationError.invalidValue("Pairing authority changed") }
        let claim = try await ArborAuthorityClient(origin: origin).claimPairing(
            id: payload.pairing.id,
            secret: payload.pairing.secret,
            label: label
        )
        try await credentials.save(claim.deviceToken, origin: origin)
        return claim
    }

    public func account() async throws -> AuthorityAccountDescriptor { try await client.account() }
    public func trees() async throws -> [AuthorityTreeDescriptor] { try await client.trees() }
    public func devices() async throws -> [AuthorityDevice] { try await client.devices() }
    public func revoke(device id: String) async throws -> AuthorityDevice { try await client.revokeDevice(id: id) }
    public func forget() async throws { try await credentials.forget(origin: origin) }
}
