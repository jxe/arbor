import ArborWire
import CryptoKit
import Foundation
import Security

public protocol DeviceCredentialStore: Sendable {
    func load(origin: URL) async throws -> String?
    func save(_ credential: String, origin: URL) async throws
    func forget(origin: URL) async throws
}

public struct PendingPairingClaim: Codable, Equatable, Sendable {
    public enum Stage: String, Codable, Sendable { case prepared, uncertain, claimed }
    public var origin: URL
    public var pairingID: String
    public var pairingSecret: String
    public var deviceID: String
    public var deviceLabel: String
    public var credential: String
    public var credentialDigest: String
    public var stage: Stage
}

public struct NativeCanopyAccount: Codable, Equatable, Sendable, Identifiable {
    public var configurationTree: String
    public var origin: URL
    public var accountID: String
    public var handle: String?
    public var profileTree: String?
    public var deviceID: String
    public var id: String { configurationTree }
}

public protocol AccountCredentialStore: Sendable {
    func load(configurationTree: String) async throws -> String?
    func save(_ credential: String, configurationTree: String) async throws
    func forget(configurationTree: String) async throws
    func loadPending(origin: URL, pairingID: String) async throws -> PendingPairingClaim?
    func savePending(_ claim: PendingPairingClaim) async throws
    func forgetPending(origin: URL, pairingID: String) async throws
    func accounts() async throws -> [NativeCanopyAccount]
    func saveAccount(_ account: NativeCanopyAccount) async throws
    func forgetAccount(configurationTree: String) async throws
}

public actor KeychainDeviceCredentialStore: DeviceCredentialStore, AccountCredentialStore {
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

    public func load(configurationTree: String) throws -> String? {
        try loadValue(account: accountKey(configurationTree))
    }

    public func save(_ credential: String, configurationTree: String) throws {
        guard !credential.isEmpty else { throw ArborWireValidationError.invalidValue("Credential is empty") }
        try saveValue(credential, account: accountKey(configurationTree))
    }

    public func forget(configurationTree: String) throws {
        try forgetValue(account: accountKey(configurationTree))
    }

    public func loadPending(origin: URL, pairingID: String) throws -> PendingPairingClaim? {
        guard let value = try loadValue(account: pendingKey(origin: origin, pairingID: pairingID)) else { return nil }
        return try JSONDecoder().decode(PendingPairingClaim.self, from: Data(value.utf8))
    }

    public func savePending(_ claim: PendingPairingClaim) throws {
        let value = String(decoding: try JSONEncoder().encode(claim), as: UTF8.self)
        try saveValue(value, account: pendingKey(origin: claim.origin, pairingID: claim.pairingID))
    }

    public func forgetPending(origin: URL, pairingID: String) throws {
        try forgetValue(account: pendingKey(origin: origin, pairingID: pairingID))
    }

    public func accounts() throws -> [NativeCanopyAccount] {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service + ".accounts",
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitAll,
        ]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return [] }
        guard status == errSecSuccess else { throw OSStatusError(status) }
        let values = (result as? [Data]) ?? (result as? Data).map { [$0] } ?? []
        return try values.map { try JSONDecoder().decode(NativeCanopyAccount.self, from: $0) }
            .sorted { $0.configurationTree < $1.configurationTree }
    }

    public func saveAccount(_ account: NativeCanopyAccount) throws {
        try saveValue(
            String(decoding: try JSONEncoder().encode(account), as: UTF8.self),
            account: account.configurationTree,
            service: service + ".accounts"
        )
    }

    public func forgetAccount(configurationTree: String) throws {
        try forgetValue(account: configurationTree, service: service + ".accounts")
    }

    private func accountKey(_ configurationTree: String) -> String { "account:\(configurationTree)" }

    private func pendingKey(origin: URL, pairingID: String) -> String {
        let digest = SHA256.hash(data: Data("\(origin.absoluteString)\u{0}\(pairingID)".utf8))
            .map { String(format: "%02x", $0) }.joined()
        return "pending:\(digest)"
    }

    private func loadValue(account: String, service: String? = nil) throws -> String? {
        var query = baseQuery(account: account, service: service)
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

    private func saveValue(_ value: String, account: String, service: String? = nil) throws {
        try forgetValue(account: account, service: service)
        var query = baseQuery(account: account, service: service)
        query[kSecValueData as String] = Data(value.utf8)
        let status = SecItemAdd(query as CFDictionary, nil)
        guard status == errSecSuccess else { throw OSStatusError(status) }
    }

    private func forgetValue(account: String, service: String? = nil) throws {
        let status = SecItemDelete(baseQuery(account: account, service: service) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw OSStatusError(status) }
    }

    private func baseQuery(account: String, service selectedService: String? = nil) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: selectedService ?? service,
            kSecAttrAccount as String: account,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
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

public actor StoredDeviceCredentialProvider: WireCredentialProvider {
    private let origin: URL
    private let store: any DeviceCredentialStore

    public init(origin: URL, store: any DeviceCredentialStore) {
        self.origin = origin
        self.store = store
    }

    public func credential() async throws -> String? { try await store.load(origin: origin) }
}

public actor AccountStoredCredentialProvider: WireCredentialProvider {
    private let configurationTree: String
    private let store: any AccountCredentialStore

    public init(configurationTree: String, store: any AccountCredentialStore) {
        self.configurationTree = configurationTree
        self.store = store
    }

    public func credential() async throws -> String? { try await store.load(configurationTree: configurationTree) }
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
    private let credentials: any AccountCredentialStore
    private let legacyCredentials: (any DeviceCredentialStore)?
    private let session: URLSession
    private let retryDelay: ArborWireClient.RetryDelay
    private var configurationTree: String?

    public init(
        origin: URL,
        configurationTree: String? = nil,
        credentials: any AccountCredentialStore = KeychainDeviceCredentialStore(),
        legacyCredentials: (any DeviceCredentialStore)? = KeychainDeviceCredentialStore(),
        session: URLSession = .shared,
        retryDelay: @escaping ArborWireClient.RetryDelay = { attempt in
            try await Task.sleep(for: .milliseconds(attempt == 1 ? 100 : 500))
        }
    ) {
        self.origin = origin
        self.configurationTree = configurationTree
        self.credentials = credentials
        self.legacyCredentials = legacyCredentials
        self.session = session
        self.retryDelay = retryDelay
    }

    public func claim(_ payload: PairingPayload, label: String) async throws -> WirePairingClaim {
        let payload = try payload.validated()
        guard payload.origin == origin else { throw ArborWireValidationError.invalidValue("Pairing server changed") }
        let cleanLabel = label.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanLabel.isEmpty else { throw ArborWireValidationError.invalidValue("Device label is empty") }
        var pending: PendingPairingClaim
        if let stored = try await credentials.loadPending(origin: origin, pairingID: payload.pairing.id) {
            guard stored.origin == origin, stored.pairingSecret == payload.pairing.secret, stored.deviceLabel == cleanLabel else {
                throw ArborWireValidationError.invalidValue("A different claim is already pending for this pairing")
            }
            pending = stored
        } else {
            let credential = try randomSecret()
            pending = PendingPairingClaim(
                origin: origin,
                pairingID: payload.pairing.id,
                pairingSecret: payload.pairing.secret,
                deviceID: try generatedDeviceID(),
                deviceLabel: cleanLabel,
                credential: credential,
                credentialDigest: "sha256:" + SHA256.hash(data: Data(credential.utf8)).map { String(format: "%02x", $0) }.joined(),
                stage: .prepared
            )
            try await credentials.savePending(pending)
        }
        pending.stage = .uncertain
        try await credentials.savePending(pending)
        let claim = try await ArborWireClient(origin: origin, session: session, retryDelay: retryDelay).claimPairing(
            id: pending.pairingID,
            secret: pending.pairingSecret,
            device: WirePairingDevice(id: pending.deviceID, label: pending.deviceLabel, credentialDigest: pending.credentialDigest)
        )
        pending.stage = .claimed
        try await credentials.savePending(pending)
        let snapshot = try await ArborWireClient(
            origin: origin,
            credential: pending.credential,
            session: session,
            retryDelay: retryDelay
        ).account()
        guard snapshot.account.device?.id == pending.deviceID else {
            throw ArborWireValidationError.invalidValue("Claimed account returned a different device identity")
        }
        guard let endpoint = snapshot.account.community.canonical?.endpoint,
              sameOrigin(URL(string: endpoint), origin) else {
            throw ArborWireValidationError.invalidValue("Claimed account returned a different Canopy origin")
        }
        let configuration = snapshot.account.configuration.id
        guard !configuration.isEmpty else { throw ArborWireValidationError.invalidValue("Claimed account omitted its configuration TreeID") }
        try await credentials.save(pending.credential, configurationTree: configuration)
        guard try await credentials.load(configurationTree: configuration) == pending.credential else {
            throw ArborWireValidationError.invalidValue("Account credential could not be verified after saving")
        }
        let account = NativeCanopyAccount(
            configurationTree: configuration,
            origin: origin,
            accountID: snapshot.account.id,
            handle: snapshot.account.handle,
            profileTree: snapshot.account.profileTree,
            deviceID: pending.deviceID
        )
        try await credentials.saveAccount(account)
        guard try await credentials.accounts().contains(account) else {
            throw ArborWireValidationError.invalidValue("Account metadata could not be verified after saving")
        }
        try await credentials.forgetPending(origin: origin, pairingID: pending.pairingID)
        configurationTree = configuration
        return claim
    }

    public func account() async throws -> WireAccountSnapshot { try await client().account() }
    public func trees() async throws -> WireSnapshotEnvelope<[WireTreeDescriptor]> { try await client().trees() }
    public func configurationID() -> String? { configurationTree }
    public func forget() async throws {
        if let configurationTree {
            try await credentials.forget(configurationTree: configurationTree)
            try await credentials.forgetAccount(configurationTree: configurationTree)
        } else if let legacyCredentials {
            try await legacyCredentials.forget(origin: origin)
        }
    }

    private func client() async throws -> ArborWireClient {
        if let configurationTree {
            return ArborWireClient(
                origin: origin,
                credentialProvider: AccountStoredCredentialProvider(configurationTree: configurationTree, store: credentials),
                session: session,
                retryDelay: retryDelay
            )
        }
        // Legacy singleton compatibility. Remove this branch with the layout migration.
        if let legacyCredentials {
            return ArborWireClient(
                origin: origin,
                credentialProvider: StoredDeviceCredentialProvider(origin: origin, store: legacyCredentials),
                session: session,
                retryDelay: retryDelay
            )
        }
        throw ArborWireValidationError.invalidValue("Account configuration TreeID is required")
    }

    private func randomSecret() throws -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
            throw ArborWireValidationError.invalidValue("Could not generate device credential")
        }
        return Data(bytes).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    private func generatedDeviceID() throws -> String {
        var bytes = [UInt8](repeating: 0, count: 16)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
            throw ArborWireValidationError.invalidValue("Could not generate DeviceID")
        }
        let alphabet = Array("abcdefghijklmnopqrstuvwxyz234567")
        var accumulator = 0
        var bits = 0
        var output = ""
        for byte in bytes {
            accumulator = (accumulator << 8) | Int(byte)
            bits += 8
            while bits >= 5 {
                bits -= 5
                output.append(alphabet[(accumulator >> bits) & 31])
            }
            accumulator &= bits == 0 ? 0 : (1 << bits) - 1
        }
        if bits > 0 { output.append(alphabet[(accumulator << (5 - bits)) & 31]) }
        return "dv_" + output
    }

    private func sameOrigin(_ lhs: URL?, _ rhs: URL) -> Bool {
        guard let lhs,
              let left = URLComponents(url: lhs, resolvingAgainstBaseURL: false),
              let right = URLComponents(url: rhs, resolvingAgainstBaseURL: false) else { return false }
        func port(_ value: URLComponents) -> Int? {
            value.port ?? (value.scheme?.lowercased() == "https" ? 443 : value.scheme?.lowercased() == "http" ? 80 : nil)
        }
        return left.scheme?.lowercased() == right.scheme?.lowercased()
            && left.host?.lowercased() == right.host?.lowercased()
            && port(left) == port(right)
    }
}
