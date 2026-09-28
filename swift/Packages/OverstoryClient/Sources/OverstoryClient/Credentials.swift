import CanopyAppKit
import Overstory
import CryptoKit
import Foundation
import Synchronization
import Security

public struct PendingPairingClaim: Codable, Equatable, Sendable {
    public enum Stage: String, Codable, Sendable { case prepared, uncertain, claimed }
    public var origin: URL
    public var pairingID: String
    public var pairingSecret: String
    public var deviceID: String
    public var deviceLabel: String
    /// The new device's key, as `DeviceKeySecret.stored` spells it.
    public var credential: String
    public var stage: Stage
}

public struct PendingAccountClaim: Codable, Equatable, Sendable {
    public var account: URL
    public var profileTree: String
    public var configurationTree: String
    public var deviceID: String
    public var deviceLabel: String
    /// The claiming device's key, as `DeviceKeySecret.stored` spells it.
    public var credential: String
    public var configuration: ProtocolSnapshot
    public var challenge: ProtocolAccountChallenge
    public var publicKey: String
    public var signature: String
    public var inviteCode: String?
}

public struct NativeHostAccount: Codable, Equatable, Sendable, Identifiable {
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
    func loadPendingAccount(account: URL) async throws -> PendingAccountClaim?
    func savePendingAccount(_ claim: PendingAccountClaim) async throws
    func forgetPendingAccount(account: URL) async throws
    func accounts() async throws -> [NativeHostAccount]
    func saveAccount(_ account: NativeHostAccount) async throws
    func forgetAccount(configurationTree: String) async throws
}

/// Each account's device key and metadata, pending claims, and placement
/// connections, in the Keychain.
public actor KeychainDeviceCredentialStore: AccountCredentialStore, PlacementConnectionStore {
    nonisolated let service: String

    public init(service: String = "org.nxhx.Arbor.device") { self.service = service }

    public func load(configurationTree: String) throws -> String? {
        try loadValue(account: accountKey(configurationTree))
    }

    public func save(_ credential: String, configurationTree: String) throws {
        guard !credential.isEmpty else { throw ProtocolValidationError.invalidValue("Credential is empty") }
        try saveValue(credential, account: accountKey(configurationTree))
        AccountStoredCredentialProvider.discardShared(service: service, configurationTree: configurationTree)
    }

    public func forget(configurationTree: String) throws {
        try forgetValue(account: accountKey(configurationTree))
        AccountStoredCredentialProvider.discardShared(service: service, configurationTree: configurationTree)
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

    public func loadPendingAccount(account: URL) throws -> PendingAccountClaim? {
        guard let value = try loadValue(account: pendingAccountKey(account)) else { return nil }
        return try JSONDecoder().decode(PendingAccountClaim.self, from: Data(value.utf8))
    }

    public func savePendingAccount(_ claim: PendingAccountClaim) throws {
        let value = String(decoding: try JSONEncoder().encode(claim), as: UTF8.self)
        try saveValue(value, account: pendingAccountKey(claim.account))
    }

    public func forgetPendingAccount(account: URL) throws {
        try forgetValue(account: pendingAccountKey(account))
    }

    public func accounts() throws -> [NativeHostAccount] {
        return try values(service: service + ".accounts").map { try JSONDecoder().decode(NativeHostAccount.self, from: $0) }
            .sorted { $0.configurationTree < $1.configurationTree }
    }

    public func saveAccount(_ account: NativeHostAccount) throws {
        try saveValue(
            String(decoding: try JSONEncoder().encode(account), as: UTF8.self),
            account: account.configurationTree,
            service: service + ".accounts"
        )
    }

    public func forgetAccount(configurationTree: String) throws {
        try forgetValue(account: configurationTree, service: service + ".accounts")
    }

    /// Placement connections hold no secret; they live beside the accounts,
    /// one item per `<ConfigurationTreeID>/host-<digest>` as a data home
    /// keys them (accounts §1.3).
    public func placements(configurationTree: String?) throws -> [NativePlacementAccount] {
        return try values(service: service + ".placements").compactMap { try? JSONDecoder().decode(NativePlacementAccount.self, from: $0) }
            .filter { $0.isWellFormed && (configurationTree == nil || $0.configurationTree == configurationTree) }
            .sorted { ($0.configurationTree, $0.origin) < ($1.configurationTree, $1.origin) }
    }

    public func savePlacement(_ placement: NativePlacementAccount) throws {
        guard placement.isWellFormed else { throw ProtocolValidationError.invalidValue("Malformed placement connection") }
        try saveValue(
            String(decoding: try JSONEncoder().encode(placement), as: UTF8.self),
            account: placement.id,
            service: service + ".placements"
        )
    }

    public func forgetPlacement(configurationTree: String, origin: String) throws {
        try forgetValue(account: NativePlacementAccount.key(configurationTree: configurationTree, origin: origin), service: service + ".placements")
        AccountStoredCredentialProvider.discardShared(service: service, configurationTree: configurationTree, origin: origin)
    }

    private func accountKey(_ configurationTree: String) -> String { "account:\(configurationTree)" }

    private func pendingKey(origin: URL, pairingID: String) -> String {
        "pending:\(hexDigest("\(origin.absoluteString)\u{0}\(pairingID)"))"
    }

    private func pendingAccountKey(_ account: URL) -> String {
        "pending-account:\(hexDigest(account.absoluteString))"
    }

    /// Lowercase SHA-256 hex of `text`, without the `sha256:` prefix of an object hash.
    private func hexDigest(_ text: String) -> String {
        String(ProtocolObjectCodec.hash(Data(text.utf8)).dropFirst("sha256:".count))
    }

    /// Every item's data under `service`. The macOS file-based Keychain
    /// refuses `kSecReturnData` with `kSecMatchLimitAll` (errSecParam), so
    /// this lists the items' accounts and reads each one.
    private func values(service: String) throws -> [Data] {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecReturnAttributes as String: true,
            kSecMatchLimit as String: kSecMatchLimitAll,
        ]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return [] }
        guard status == errSecSuccess else { throw OSStatusError(status) }
        let items = (result as? [[String: Any]]) ?? (result as? [String: Any]).map { [$0] } ?? []
        return try items.compactMap { $0[kSecAttrAccount as String] as? String }.compactMap {
            try loadValue(account: $0, service: service).map { Data($0.utf8) }
        }
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
        try store(Data(value.utf8), query: baseQuery(account: account, service: service))
    }

    /// Add the item, or replace an existing item's data in place, so a failed
    /// write never leaves the previous value deleted.
    private func store(_ data: Data, query: [String: Any]) throws {
        var item = query
        item[kSecValueData as String] = data
        var status = SecItemAdd(item as CFDictionary, nil)
        if status == errSecDuplicateItem {
            var match = query
            var attributes: [String: Any] = [kSecValueData as String: data]
            attributes[kSecAttrAccessible as String] = match.removeValue(forKey: kSecAttrAccessible as String)
            status = SecItemUpdate(match as CFDictionary, attributes as CFDictionary)
        }
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
}

public struct OSStatusError: Error, Equatable, Sendable {
    public var status: OSStatus
    public init(_ status: OSStatus) { self.status = status }
}

public struct NativeProfileIdentity: Codable, Equatable, Sendable {
    public var version: Int
    public var profileTree: String
    public var publicKey: String
}

private struct StoredNativeProfileIdentity: Codable {
    var version: Int
    var profileTree: String
    var publicKey: String
    var privateKey: String
}

public actor KeychainProfileIdentityStore {
    private let service: String
    private let account = "primary"

    public init(service: String = "org.nxhx.Arbor.profile") { self.service = service }

    public func identity() throws -> NativeProfileIdentity? {
        guard let stored = try load() else { return nil }
        let verified = try verify(stored)
        return NativeProfileIdentity(version: 1, profileTree: verified.profileTree, publicKey: verified.publicKey)
    }

    /// Explicit migration only. Never log or persist this unencrypted payload.
    public func backupData() throws -> Data {
        guard let stored = try load() else { throw ProtocolValidationError.invalidValue("No native profile identity exists") }
        _ = try verify(stored)
        return try JSONEncoder().encode(stored)
    }

    public func create() throws -> NativeProfileIdentity {
        if let identity = try identity() { return identity }
        let key = Curve25519.Signing.PrivateKey()
        let publicKey = key.publicKey.rawRepresentation.base64URLEncodedString()
        let profileTree = personProfileTreeID(publicKey: key.publicKey.rawRepresentation)
        let stored = StoredNativeProfileIdentity(
            version: 1,
            profileTree: profileTree,
            publicKey: publicKey,
            privateKey: key.rawRepresentation.base64URLEncodedString()
        )
        let data = try JSONEncoder().encode(stored)
        var query = baseQuery()
        query[kSecValueData as String] = data
        let status = SecItemAdd(query as CFDictionary, nil)
        guard status == errSecSuccess else { throw OSStatusError(status) }
        return NativeProfileIdentity(version: 1, profileTree: profileTree, publicKey: publicKey)
    }

    public func sign(_ challenge: ProtocolAccountChallenge) throws -> (identity: NativeProfileIdentity, signature: String) {
        guard let stored = try load() else { throw ProtocolValidationError.invalidValue("No native profile identity exists") }
        let identity = try verify(stored)
        guard challenge.profileTree == identity.profileTree else {
            throw ProtocolValidationError.invalidValue("Account challenge names another profile identity")
        }
        guard let privateData = Data(base64URLEncoded: stored.privateKey) else {
            throw ProtocolValidationError.invalidValue("Stored profile private key is malformed")
        }
        let key = try Curve25519.Signing.PrivateKey(rawRepresentation: privateData)
        let signature = try key.signature(for: accountChallengeSigningBytes(challenge)).base64URLEncodedString()
        return (identity, signature)
    }

    private func verify(_ stored: StoredNativeProfileIdentity) throws -> NativeProfileIdentity {
        guard stored.version == 1,
              let privateData = Data(base64URLEncoded: stored.privateKey),
              let publicData = Data(base64URLEncoded: stored.publicKey) else {
            throw ProtocolValidationError.invalidValue("Stored profile identity is malformed")
        }
        let key = try Curve25519.Signing.PrivateKey(rawRepresentation: privateData)
        guard key.publicKey.rawRepresentation == publicData,
              personProfileTreeID(publicKey: publicData) == stored.profileTree else {
            throw ProtocolValidationError.invalidValue("Stored profile identity does not match its key")
        }
        return NativeProfileIdentity(version: 1, profileTree: stored.profileTree, publicKey: stored.publicKey)
    }

    private func load() throws -> StoredNativeProfileIdentity? {
        var query = baseQuery()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw OSStatusError(status) }
        return try JSONDecoder().decode(StoredNativeProfileIdentity.self, from: data)
    }

    private func baseQuery() -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
    }
}

private func personProfileTreeID(publicKey: Data) -> String {
    var input = Data("arbor-person-profile-v1\0".utf8)
    input.append(publicKey)
    return "tr_" + Data(SHA256.hash(data: input)).lowercaseBase32()
}

private extension Data {
    init?(base64URLEncoded value: String) {
        var base64 = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
        self.init(base64Encoded: base64)
    }

    func base64URLEncodedString() -> String {
        base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }

    func lowercaseBase32() -> String {
        let alphabet = Array("abcdefghijklmnopqrstuvwxyz234567")
        var accumulator = 0
        var bits = 0
        var output = ""
        for byte in self {
            accumulator = (accumulator << 8) | Int(byte)
            bits += 8
            while bits >= 5 {
                bits -= 5
                output.append(alphabet[(accumulator >> bits) & 31])
            }
            accumulator &= bits == 0 ? 0 : (1 << bits) - 1
        }
        if bits > 0 { output.append(alphabet[(accumulator << (5 - bits)) & 31]) }
        return output
    }
}

/// Reads the account's device key from the store once and hands out the
/// sessions it opens, rather than querying the Keychain for every request. A
/// slot that holds anything but a device key gives no credential.
public actor AccountStoredCredentialProvider: ProtocolCredentialProvider {
    /// The keychain accounts' providers, one per account for the process, so
    /// every client of an account shares its device session instead of each
    /// opening its own (a challenge and a session POST per request).
    private static let keychainProviders = Mutex<[String: AccountStoredCredentialProvider]>([:])

    /// The provider for an account: shared when the account lives in the
    /// keychain and requests use the shared URL session, otherwise a new one.
    /// With `origin`, it opens sessions at that placement host instead of the
    /// account's home host, with the same device key (accounts §1.3, §5.4).
    public static func shared(configurationTree: String, origin: String? = nil, store: any AccountCredentialStore, session: URLSession = .shared) -> AccountStoredCredentialProvider {
        guard let keychain = store as? KeychainDeviceCredentialStore, session === URLSession.shared else {
            return AccountStoredCredentialProvider(configurationTree: configurationTree, origin: origin, store: store, session: session)
        }
        let key = keychainKey(service: keychain.service, configurationTree: configurationTree, origin: origin)
        return keychainProviders.withLock { providers in
            if let provider = providers[key] { return provider }
            let provider = AccountStoredCredentialProvider(configurationTree: configurationTree, origin: origin, store: store, session: session)
            providers[key] = provider
            return provider
        }
    }

    /// Drop the shared providers whose keychain entry changed, the account's
    /// and its placements' (they sign with its key); the next client reads it afresh.
    static func discardShared(service: String, configurationTree: String) {
        let home = keychainKey(service: service, configurationTree: configurationTree, origin: nil)
        keychainProviders.withLock { providers in
            for key in Array(providers.keys) where key == home || key.hasPrefix(home + "\u{0}") { providers[key] = nil }
        }
    }

    /// Drop one placement's shared provider.
    static func discardShared(service: String, configurationTree: String, origin: String) {
        _ = keychainProviders.withLock { $0.removeValue(forKey: keychainKey(service: service, configurationTree: configurationTree, origin: origin)) }
    }

    private static func keychainKey(service: String, configurationTree: String, origin: String?) -> String {
        "\(service)\u{0}\(configurationTree)" + (origin.map { "\u{0}\($0)" } ?? "")
    }

    private let configurationTree: String
    /// A placement host to open sessions at; nil for the account's home host.
    private let origin: String?
    private let store: any AccountCredentialStore
    private let session: URLSession
    private var sessions: DeviceSessionCredentialProvider?
    private var generation = 0

    public init(configurationTree: String, origin: String? = nil, store: any AccountCredentialStore, session: URLSession = .shared) {
        self.configurationTree = configurationTree
        self.origin = origin
        self.store = store
        self.session = session
    }

    public func credential() async throws -> String? {
        if let sessions { return try await sessions.credential() }
        let loadedGeneration = generation
        guard let value = try await store.load(configurationTree: configurationTree),
              let key = DeviceKeySecret(stored: value) else { return nil }
        guard let account = try await store.accounts().first(where: { $0.configurationTree == configurationTree }),
              let profileTree = account.profileTree else {
            throw ProtocolValidationError.invalidValue("The account's device key has no profile to sign in to")
        }
        var host = account.origin
        if let origin {
            guard let url = URL(string: origin) else { throw ProtocolValidationError.invalidValue("Malformed placement host") }
            host = url
        }
        let provider = DeviceSessionCredentialProvider(origin: host, profileTree: profileTree, device: account.deviceID, key: key, session: session)
        // A rejection while the store was being read makes this key suspect.
        if generation == loadedGeneration { sessions = provider }
        return try await provider.credential()
    }

    public func invalidate() async {
        await sessions?.invalidate()
        sessions = nil
        generation += 1
    }
}

/// Generate a 128-bit lowercase base32 Arbor identity with the supplied stable prefix
/// (`tr`, `dv`, …); it edits no file and reserves no server state, matching `generateArborID` in `@arbor/core`.
public func generateArborID(prefix: String) throws -> String {
    var bytes = [UInt8](repeating: 0, count: 16)
    guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
        throw ProtocolValidationError.invalidValue("Could not generate identity")
    }
    return prefix + "_" + Data(bytes).lowercaseBase32()
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
            throw ProtocolValidationError.invalidValue("Malformed pairing payload")
        }
        return self
    }
}

public actor NativeAccountService {
    private let origin: URL
    private let credentials: any AccountCredentialStore
    private let placementStore: any PlacementConnectionStore
    private let session: URLSession
    private let retryDelay: ProtocolClient.RetryDelay
    private var configurationTree: String?

    /// `placements` defaults to `credentials` when that store also keeps
    /// placement connections, as the Keychain store does.
    public init(
        origin: URL,
        configurationTree: String? = nil,
        credentials: any AccountCredentialStore = KeychainDeviceCredentialStore(),
        placements: (any PlacementConnectionStore)? = nil,
        session: URLSession = .shared,
        retryDelay: @escaping ProtocolClient.RetryDelay = ProtocolClient.defaultRetryDelay
    ) {
        self.origin = origin
        self.configurationTree = configurationTree
        self.credentials = credentials
        self.placementStore = placements ?? (credentials as? any PlacementConnectionStore) ?? KeychainDeviceCredentialStore()
        self.session = session
        self.retryDelay = retryDelay
    }

    public func claim(_ payload: PairingPayload, label: String) async throws -> ProtocolPairingClaim {
        let payload = try payload.validated()
        guard payload.origin == origin else { throw ProtocolValidationError.invalidValue("Pairing server changed") }
        let cleanLabel = label.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanLabel.isEmpty else { throw ProtocolValidationError.invalidValue("Device label is empty") }
        var pending: PendingPairingClaim
        if let stored = try await credentials.loadPending(origin: origin, pairingID: payload.pairing.id) {
            guard stored.origin == origin, stored.pairingSecret == payload.pairing.secret, stored.deviceLabel == cleanLabel else {
                throw ProtocolValidationError.invalidValue("A different claim is already pending for this pairing")
            }
            pending = stored
        } else {
            // A new device pairs with a key, which waits in the credential field.
            let key = try DeviceKeySecret.generate()
            pending = PendingPairingClaim(
                origin: origin,
                pairingID: payload.pairing.id,
                pairingSecret: payload.pairing.secret,
                deviceID: try generatedDeviceID(),
                deviceLabel: cleanLabel,
                credential: key.stored,
                stage: .prepared
            )
            try await credentials.savePending(pending)
        }
        pending.stage = .uncertain
        try await credentials.savePending(pending)
        let claim = try await ProtocolClient(origin: origin, session: session, retryDelay: retryDelay).claimPairing(
            id: pending.pairingID,
            secret: pending.pairingSecret,
            device: try enrollment(id: pending.deviceID, label: pending.deviceLabel, secret: pending.credential)
        )
        pending.stage = .claimed
        try await credentials.savePending(pending)
        let snapshot = try await ProtocolClient(
            origin: origin,
            credential: try await bearer(secret: pending.credential, profileTree: claim.device.account, device: pending.deviceID),
            session: session,
            retryDelay: retryDelay
        ).account()
        // The device asked for its session as `device.account`, the profile; the account must agree.
        guard snapshot.account.device?.id == pending.deviceID,
              snapshot.account.profileTree == claim.device.account else {
            throw ProtocolValidationError.invalidValue("Claimed account returned a different device identity")
        }
        guard let endpoint = snapshot.account.community.canonical?.endpoint,
              sameOrigin(URL(string: endpoint), origin) else {
            throw ProtocolValidationError.invalidValue("Claimed account returned a different Canopy origin")
        }
        let configuration = snapshot.account.configuration.id
        guard !configuration.isEmpty else { throw ProtocolValidationError.invalidValue("Claimed account omitted its configuration TreeID") }
        try await credentials.save(pending.credential, configurationTree: configuration)
        guard try await credentials.load(configurationTree: configuration) == pending.credential else {
            throw ProtocolValidationError.invalidValue("Account credential could not be verified after saving")
        }
        let account = NativeHostAccount(
            configurationTree: configuration,
            origin: origin,
            accountID: snapshot.account.id,
            handle: snapshot.account.handle,
            profileTree: snapshot.account.profileTree,
            deviceID: pending.deviceID
        )
        try await credentials.saveAccount(account)
        guard try await credentials.accounts().contains(account) else {
            throw ProtocolValidationError.invalidValue("Account metadata could not be verified after saving")
        }
        try await credentials.forgetPending(origin: origin, pairingID: pending.pairingID)
        configurationTree = configuration
        return claim
    }

    public func claimAccount(
        account: URL,
        label: String,
        inviteCode: String? = nil,
        identityStore: KeychainProfileIdentityStore = KeychainProfileIdentityStore()
    ) async throws -> NativeHostAccount {
        guard sameOrigin(account, origin), account.query == nil, account.fragment == nil else {
            throw ProtocolValidationError.invalidValue("Account URL does not belong to this Canopy")
        }
        guard let identity = try await identityStore.identity() else {
            throw ProtocolValidationError.invalidValue("Create a profile identity before claiming an account")
        }
        let cleanLabel = label.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanLabel.isEmpty else { throw ProtocolValidationError.invalidValue("Device label is empty") }
        let wire = ProtocolClient(origin: origin, session: session, retryDelay: retryDelay)
        var pending: PendingAccountClaim
        if let stored = try await credentials.loadPendingAccount(account: account) {
            guard stored.account == account, stored.profileTree == identity.profileTree, stored.deviceLabel == cleanLabel else {
                throw ProtocolValidationError.invalidValue("A different claim is already pending for this account")
            }
            pending = stored
            if let inviteCode, let existing = pending.inviteCode, existing != inviteCode {
                throw ProtocolValidationError.invalidValue("A different invitation code is already pending for this account")
            }
            if pending.inviteCode == nil, let inviteCode {
                pending.inviteCode = inviteCode
                try await credentials.savePendingAccount(pending)
            }
        } else {
            // One host per profile: the account's configuration is the profile's, at its derived TreeID.
            let configurationTree = treeConfigurationID(identity.profileTree)
            let deviceID = try generatedID(prefix: "dv")
            let key = try DeviceKeySecret.generate()
            let configuration = try initialProfileConfiguration(
                profileTree: identity.profileTree,
                configurationTree: configurationTree,
                deviceID: deviceID,
                label: cleanLabel,
                key: try key.publicKey()
            )
            let challenge = try await wire.createAccountChallenge(
                account: account.path.isEmpty || account.path == "/" ? nil : account.absoluteString,
                profileTree: identity.profileTree,
                configurationTree: configurationTree,
                inviteCode: inviteCode
            )
            let signed = try await identityStore.sign(challenge)
            guard let claimedAccount = URL(string: challenge.account), sameOrigin(claimedAccount, origin) else {
                throw ProtocolValidationError.invalidValue("Account challenge named another Canopy")
            }
            pending = PendingAccountClaim(
                account: claimedAccount,
                profileTree: identity.profileTree,
                configurationTree: configurationTree,
                deviceID: deviceID,
                deviceLabel: cleanLabel,
                credential: key.stored,
                configuration: configuration,
                challenge: challenge,
                publicKey: signed.identity.publicKey,
                signature: signed.signature,
                inviteCode: inviteCode
            )
            try await credentials.savePendingAccount(pending)
        }
        let request: (PendingAccountClaim) throws -> ProtocolExistingProfileClaimRequest = { [self] claim in
            ProtocolExistingProfileClaimRequest(
                account: claim.account.absoluteString,
                profileTree: claim.profileTree,
                configurationTree: claim.configurationTree,
                challenge: claim.challenge,
                publicKey: claim.publicKey,
                signature: claim.signature,
                inviteCode: claim.inviteCode,
                device: try enrollment(id: claim.deviceID, label: claim.deviceLabel, secret: claim.credential),
                // The journal keeps the snapshot; the claim sends it as the configuration
                // tree's activation element, named by the device so a replay sends the same one.
                configuration: .activation(claim.configuration, change: claim.deviceID)
            )
        }
        let result: ProtocolAccountClaimResult
        do {
            result = try await wire.joinAccount(try request(pending))
        } catch let error as ProtocolHTTPError
            // canopyd reports an expired challenge only as an invalid request with this message.
            where error.isExpiredChallenge {
            let challenge = try await wire.createAccountChallenge(
                account: pending.account.absoluteString,
                profileTree: pending.profileTree,
                configurationTree: pending.configurationTree,
                inviteCode: pending.inviteCode
            )
            let signed = try await identityStore.sign(challenge)
            pending.challenge = challenge
            pending.publicKey = signed.identity.publicKey
            pending.signature = signed.signature
            try await credentials.savePendingAccount(pending)
            result = try await wire.joinAccount(try request(pending))
        }
        guard result.account.profileTree == identity.profileTree,
              result.account.configuration.id == pending.configurationTree else {
            throw ProtocolValidationError.invalidValue("Claimed account returned different identity")
        }
        try await credentials.save(pending.credential, configurationTree: pending.configurationTree)
        let stored = NativeHostAccount(
            configurationTree: pending.configurationTree,
            origin: origin,
            accountID: result.account.id,
            handle: result.account.handle,
            profileTree: result.account.profileTree,
            deviceID: pending.deviceID
        )
        try await credentials.saveAccount(stored)
        try await credentials.forgetPendingAccount(account: pending.account)
        self.configurationTree = pending.configurationTree
        return stored
    }

    public func account() async throws -> ProtocolAccountSnapshot { try await client().account() }
    public func trees() async throws -> ProtocolRemoteSnapshot<[ProtocolTreeDescriptor]> { try await client().trees() }
    public func directory() async throws -> ProtocolRemoteSnapshot<[ProtocolProfileDirectoryEntry]> { try await client().directory() }
    public func object(tree: String, hash: String) async throws -> Data { try await client().object(tree: tree, hash: hash) }
    public func access(tree: String) async throws -> NativeTreeAccessPresentation {
        try await TreeConfigurationClient(wire: client()).access(tree: tree)
    }

    public func prepareResourceConsent(tree: String, app: String, rule: ProtocolAppAccessRule, removing: Bool = false, group: String? = nil) async throws -> NativeResourceConsent {
        try await TreeConfigurationClient(wire: client()).prepareResourceConsent(tree: tree, app: app, rule: rule, removing: removing, group: group)
    }

    public func applyResourceConsent(_ review: NativeResourceConsent) async throws -> NativeTreeAccessPresentation? {
        try await TreeConfigurationClient(wire: client()).applyResourceConsent(review)
    }

    public func setAccess(tree: String, target: NativeTreeAccessTarget, access: String) async throws -> NativeTreeAccessPresentation {
        try await TreeConfigurationClient(wire: client()).setAccess(tree: tree, target: target, access: access)
    }

    public func configurationID() -> String? { configurationTree }
    /// Remove the account's device key and metadata, and its placement
    /// connections, which sign in with that key.
    public func forget() async throws {
        guard let configurationTree else { return }
        for placement in try await placementStore.placements(configurationTree: configurationTree) {
            try await placementStore.forgetPlacement(configurationTree: configurationTree, origin: placement.origin)
        }
        try await credentials.forget(configurationTree: configurationTree)
        try await credentials.forgetAccount(configurationTree: configurationTree)
    }

    // MARK: Placement accounts (accounts §1.3)

    /// This account's placement connections.
    public func placements() async throws -> [NativePlacementAccount] {
        guard let configurationTree else { return [] }
        return try await placementStore.placements(configurationTree: configurationTree)
    }

    /// A protocol client for a placement host this account is placed on,
    /// signing in there with this device's key.
    public func placementClient(origin placementOrigin: String) async throws -> ProtocolClient {
        guard let configurationTree,
              let placement = try await placementStore.placements(configurationTree: configurationTree).first(where: { $0.origin == placementOrigin }),
              let url = URL(string: placement.origin) else {
            throw ProtocolValidationError.invalidValue("This account is not placed on \(placementOrigin)")
        }
        return ProtocolClient(
            origin: url,
            credentialProvider: AccountStoredCredentialProvider.shared(configurationTree: configurationTree, origin: placement.origin, store: credentials, session: session),
            session: session,
            retryDelay: retryDelay
        )
    }

    /// Remove a placement connection from this device. The account stays at
    /// the placement host; connecting again restores it.
    public func forgetPlacement(origin placementOrigin: String) async throws {
        guard let configurationTree else { return }
        try await placementStore.forgetPlacement(configurationTree: configurationTree, origin: placementOrigin)
    }

    /// Connect this home account to its placement account at another host
    /// (accounts §1.3), mirroring `connectPlacementAccount` in
    /// `@overstory/client`. The host's community created the account by
    /// reserving the profile's locator at its home host; there is no claim.
    /// This device opens a session there with its own home device key, since
    /// the placement host accepts every device the home host lists, so any
    /// device can do it, a paired iPhone included. A host with no such
    /// reservation throws `NativePlacementError.notReserved`, naming what to
    /// reserve; one that cannot check the device now (its home host is
    /// unreachable) throws its own error, naming the home host.
    public func connectPlacement(on host: String) async throws -> NativePlacementResult {
        let target = try placementTarget(host)
        guard let configurationTree,
              let home = try await credentials.accounts().first(where: { $0.configurationTree == configurationTree }),
              let profileTree = home.profileTree,
              let homeHost = originString(home.origin),
              let stored = try await credentials.load(configurationTree: configurationTree),
              let key = DeviceKeySecret(stored: stored) else {
            throw NativePlacementError.noHomeAccount
        }
        guard target.origin != homeHost else { throw NativePlacementError.homeHost(target.origin) }
        guard let targetURL = URL(string: target.origin) else { throw NativePlacementError.invalidHost }
        let token: String
        do {
            token = try await ProtocolClient(origin: targetURL, session: session, retryDelay: retryDelay)
                .openDeviceSession(profileTree: profileTree, device: home.deviceID, key: key).token
        } catch let error as ProtocolHTTPError where error.status < 500 && error.homeHost == nil {
            throw NativePlacementError.notReserved(host: target.origin, account: home.handle.map { "\(homeHost)/~\($0)" } ?? "this profile's URL at \(homeHost)")
        }
        let account = try await ProtocolClient(origin: targetURL, credential: token, session: session, retryDelay: retryDelay)
            .placementAccount().account
        guard account.profileTree == profileTree, account.homeHost == homeHost else {
            throw NativePlacementError.mismatch("The account at \(target.origin) names another profile or home host")
        }
        let placement = NativePlacementAccount(
            configurationTree: configurationTree,
            origin: target.origin,
            account: target.origin + account.placementRoot.path,
            accountID: account.id,
            handle: account.handle,
            profileTree: profileTree,
            homeHost: homeHost,
            placementRoot: account.placementRoot.id
        )
        try await placementStore.savePlacement(placement)
        return NativePlacementResult(placement: placement, account: account)
    }

    private func client() async throws -> ProtocolClient {
        guard let configurationTree else { throw ProtocolValidationError.invalidValue("Account configuration TreeID is required") }
        return ProtocolClient(
            origin: origin,
            credentialProvider: AccountStoredCredentialProvider.shared(configurationTree: configurationTree, store: credentials, session: session),
            session: session,
            retryDelay: retryDelay
        )
    }

    /// The stored device key of a pending claim; anything else cannot enroll.
    private func deviceKey(_ secret: String) throws -> DeviceKeySecret {
        guard let key = DeviceKeySecret(stored: secret) else {
            throw ProtocolValidationError.invalidValue("This pending claim holds no device key; cancel it and claim again")
        }
        return key
    }

    /// How a claiming device enrolls: its public key (accounts §5).
    private func enrollment(id: String, label: String, secret: String) throws -> ProtocolPairingDevice {
        ProtocolPairingDevice(id: id, label: label, key: try deviceKey(secret).publicKey())
    }

    /// The session a pending claim's key opens.
    private func bearer(secret: String, profileTree: String?, device: String) async throws -> String {
        let key = try deviceKey(secret)
        guard let profileTree else { throw ProtocolValidationError.invalidValue("The claimed account names no profile") }
        return try await ProtocolClient(origin: origin, session: session, retryDelay: retryDelay)
            .openDeviceSession(profileTree: profileTree, device: device, key: key).token
    }

    private func generatedDeviceID() throws -> String { try generatedID(prefix: "dv") }

    private func utf8(_ data: Data, name: String) throws -> String {
        guard let source = String(data: data, encoding: .utf8) else {
            throw ProtocolValidationError.invalidValue("\(name) is not UTF-8")
        }
        return source
    }

    private func resolveProfile(_ input: String, using client: ProtocolClient) async throws -> String {
        let value = input.trimmingCharacters(in: .whitespacesAndNewlines)
        if TreeID.isWellFormed(value) { return value }
        let path: String
        if value.hasPrefix("~") {
            path = "/\(value)"
        } else if let url = URL(string: value), url.scheme != nil {
            path = url.path
        } else {
            throw ProtocolValidationError.invalidValue("Enter a person or group Arbor URL, handle, or TreeID")
        }
        return try await client.resolve(path: path).ref.tree
    }

    private func generatedID(prefix: String) throws -> String { try generateArborID(prefix: prefix) }

    private func initialProfileConfiguration(
        profileTree: String,
        configurationTree: String,
        deviceID: String,
        label: String,
        key: ProtocolDeviceKey? = nil
    ) throws -> ProtocolSnapshot {
        let sources = try TreeConfigurationYAML.initialPersonFiles(profileTree: profileTree, deviceID: deviceID, label: label, key: key)
        let files = try sources.mapValues { try ProtocolObjectCodec.object(.file(Data($0.utf8))) }
        let entries = files.keys.sorted().map { ProtocolDirectoryEntry(name: $0, file: files[$0]!.hash) }
        let root = try ProtocolObjectCodec.object(.directory(entries))
        let snapshot = ProtocolSnapshot(root: root.hash, objects: (Array(files.values) + [root]).sorted { $0.hash < $1.hash })
        _ = try ProtocolObjectGraph.validate(snapshot)
        _ = configurationTree // The profile's derived configuration TreeID; bound by the challenge, not repeated in YAML.
        return snapshot
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
