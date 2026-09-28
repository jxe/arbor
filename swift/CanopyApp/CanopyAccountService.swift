import Foundation
import Overstory
import OverstoryClient

/// One Canopy account this device holds, as either platform's account store
/// reports it.
struct CanopyAccount: Identifiable, Hashable, Sendable {
    let configurationTree: String
    /// The account's Canopy origin, when known. The Mac data home can hold an
    /// account whose connection record names no Canopy.
    let origin: URL?
    let handle: String?
    let profileTree: String?
    let deviceID: String?
    /// Whether the account's device credential is present. An iPhone account
    /// always has one; a data-home account can outlive its platform-store entry.
    let credentialAvailable: Bool
    var id: String { configurationTree }
}

/// A placement account connected on this device (accounts §1.3): the
/// profile's account at a host other than its home, which this device signs
/// in to with its home account's device key.
struct CanopyPlacement: Identifiable, Hashable, Sendable {
    /// The home account's configuration TreeID.
    let configurationTree: String
    /// The placement host's origin.
    let origin: String
    /// The placement account's URL there.
    let account: String
    let handle: String?
    /// The home host whose device list the placement host trusts.
    let homeHost: String
    /// The tree the claim declared at the account's address there.
    let placementRoot: String
    var id: String { NativePlacementAccount.key(configurationTree: configurationTree, origin: origin) }

    /// The placement host's name, as a person reads it.
    var hostName: String { Self.hostName(origin) }
    var homeHostName: String { Self.hostName(homeHost) }

    /// An origin's host, with its port when it names one, so two hosts on
    /// one machine stay apart.
    static func hostName(_ origin: String) -> String {
        guard let url = URL(string: origin), let host = url.host() else { return origin }
        return url.port.map { "\(host):\($0)" } ?? host
    }
}

extension CanopyPlacement {
    init(_ placement: NativePlacementAccount) {
        self.init(
            configurationTree: placement.configurationTree,
            origin: placement.origin,
            account: placement.account,
            handle: placement.handle,
            homeHost: placement.homeHost,
            placementRoot: placement.placementRoot
        )
    }
}

/// This device's profile identity: the key that signs account claims.
struct CanopyProfileIdentityState: Sendable, Equatable {
    let profileTree: String
    /// False when the identity is recorded but its private key is missing.
    let keyAvailable: Bool
}

/// An account claim begun and not yet finished.
struct CanopyPendingAccountClaim: Sendable, Equatable {
    /// The account URL being claimed.
    let account: String
    /// False once the claim may already have reached the Canopy; only resuming
    /// it is safe then.
    let canCancel: Bool
}

/// Everything onboarding reads: accounts, identity, and unfinished claims.
struct CanopyAccountState: Sendable, Equatable {
    var accounts: [CanopyAccount]
    var identity: CanopyProfileIdentityState?
    var pendingClaim: CanopyPendingAccountClaim?
    /// The origin of a pairing claim begun and not yet finished.
    var pendingPairingOrigin: String?
}

/// The outcome of claiming a pairing offer.
struct CanopyPairingClaim: Sendable, Equatable {
    /// The claimed account's configuration TreeID, when the store reports it.
    let configurationTree: String?
    /// The code both devices show, when the store reports it.
    let confirmationCode: String?
}

/// Operations one platform's account store can do and the other cannot.
enum CanopyAccountCapability: Sendable, Hashable {
    /// Restore the profile identity from a backup file.
    case restoreIdentity
    /// Write the profile identity to a backup file.
    case backupIdentity
    /// Abandon an account claim that has not reached the Canopy.
    case cancelPendingClaim
    /// Finish a pairing claim without its payload.
    case resumePairing
    /// Remove an account's credential from this device.
    case forget
    /// Place an account on another host from the app (accounts §1.3).
    case placeAccount
}

enum CanopyAccountServiceError: Error, LocalizedError, Equatable {
    case unsupported(CanopyAccountCapability)
    case invalidAccount(String)

    var errorDescription: String? {
        switch self {
        case .unsupported(.restoreIdentity): "This device cannot restore an identity from a backup"
        case .unsupported(.backupIdentity): "This device cannot back up its identity to a file"
        case .unsupported(.cancelPendingClaim): "This device keeps no cancellable account claim"
        case .unsupported(.resumePairing): "Scan the pairing code again to finish pairing"
        case .unsupported(.forget): "This device cannot forget an account here"
        case .unsupported(.placeAccount): "This device cannot place an account on another host"
        case .invalidAccount(let message): message
        }
    }
}

/// Where this device keeps its Canopy identity and device keys, and
/// the account operations the app performs on them. `CanopyWorkspaceState`
/// chooses one implementation per platform (`accountService`):
///
/// - iPhone: `KeychainAccountService`, the app's own keychain stores
///   (`NativeAccountService`, `KeychainDeviceCredentialStore`,
///   `KeychainProfileIdentityStore`).
/// - Mac: `ArborSyncAccountService`, the data home through the Arbor Sync
///   daemon's onboarding routes, so the daemon and the `arbor` command see the
///   same accounts (Native 011, option 1).
///
/// Operations only one store supports are listed in `capabilities`; the others
/// throw `CanopyAccountServiceError.unsupported`.
protocol CanopyAccountService: Sendable {
    var capabilities: Set<CanopyAccountCapability> { get }

    func state() async throws -> CanopyAccountState
    func accounts() async throws -> [CanopyAccount]
    /// The sessions this device's key opens for requests to the account's Canopy.
    func credentialProvider(configurationTree: String) async throws -> any ProtocolCredentialProvider
    /// The sessions the same device key opens at `origin`, one of the
    /// account's placement hosts (accounts §1.3, §5.4). Never the home
    /// session: a placement host has its own.
    func credentialProvider(configurationTree: String, placementOrigin origin: String) async throws -> any ProtocolCredentialProvider

    func createIdentity() async throws
    /// A version-2 backup is encrypted and needs its passphrase.
    func restoreIdentity(backup: Data, passphrase: String?) async throws
    func backupIdentity(to destination: URL, passphrase: String) async throws

    /// Claim `account` (an account URL on a Canopy) with this device's profile
    /// identity, resuming a pending claim for it. The data home names its own
    /// device and ignores `deviceLabel`.
    func claimAccount(_ account: String, deviceLabel: String, inviteCode: String?) async throws
    func cancelPendingClaim() async throws
    /// Claim a pairing offer (a `PairingPayload` as JSON). The data home names
    /// its own device and ignores `deviceLabel`.
    func claimPairing(_ payload: Data, deviceLabel: String) async throws -> CanopyPairingClaim
    func resumePairing() async throws
    /// Remove the device key this device holds for an account; a nil
    /// configuration tree names no account, and nothing is removed.
    func forget(origin: URL, configurationTree: String?) async throws

    /// The account's placement connections on this device (accounts §1.3).
    func placements(configurationTree: String) async throws -> [CanopyPlacement]
    /// Place the account on `host`, a Canopy URL: claim a placement account
    /// there with the profile key, or, on a device without it, connect to
    /// one claimed from another device.
    func placeAccount(configurationTree: String, host: String, inviteCode: String?) async throws
    /// Remove a placement connection from this device. The account stays
    /// claimed at its host; placing it again reconnects.
    func forgetPlacement(_ placement: CanopyPlacement) async throws
}

extension CanopyAccountService {
    func claimAccount(_ account: String, deviceLabel: String) async throws {
        try await claimAccount(account, deviceLabel: deviceLabel, inviteCode: nil)
    }
    func accounts() async throws -> [CanopyAccount] { try await state().accounts }

    /// A protocol client for `account`'s Canopy with its credential.
    func client(for account: CanopyAccount) async throws -> ProtocolClient {
        guard let origin = account.origin else {
            throw CanopyAccountServiceError.invalidAccount("The Canopy account names no Canopy")
        }
        return ProtocolClient(
            origin: origin,
            credentialProvider: try await credentialProvider(configurationTree: account.configurationTree)
        )
    }
}

/// The iPhone's accounts: the app's keychain, exactly as `NativeAccountService`
/// keeps it. Compiles on both platforms; the Mac chooses the data home instead.
struct KeychainAccountService: CanopyAccountService {
    var capabilities: Set<CanopyAccountCapability> { [.forget, .placeAccount] }

    func state() async throws -> CanopyAccountState {
        let identity = try await KeychainProfileIdentityStore().identity()
        return CanopyAccountState(
            accounts: try await accounts(),
            identity: identity.map { CanopyProfileIdentityState(profileTree: $0.profileTree, keyAvailable: true) },
            // The keychain's claim journals resume by claiming the same
            // account or payload again; none is listed here.
            pendingClaim: nil,
            pendingPairingOrigin: nil
        )
    }

    func accounts() async throws -> [CanopyAccount] {
        try await KeychainDeviceCredentialStore().accounts().map { CanopyAccount($0) }
    }

    func credentialProvider(configurationTree: String) async throws -> any ProtocolCredentialProvider {
        AccountStoredCredentialProvider.shared(configurationTree: configurationTree, store: KeychainDeviceCredentialStore())
    }

    func credentialProvider(configurationTree: String, placementOrigin origin: String) async throws -> any ProtocolCredentialProvider {
        AccountStoredCredentialProvider.shared(configurationTree: configurationTree, origin: origin, store: KeychainDeviceCredentialStore())
    }

    func createIdentity() async throws {
        _ = try await KeychainProfileIdentityStore().create()
    }

    func restoreIdentity(backup _: Data, passphrase _: String?) async throws {
        throw CanopyAccountServiceError.unsupported(.restoreIdentity)
    }

    func backupIdentity(to _: URL, passphrase _: String) async throws {
        throw CanopyAccountServiceError.unsupported(.backupIdentity)
    }

    func claimAccount(_ account: String, deviceLabel: String, inviteCode: String?) async throws {
        guard let url = URL(string: account.trimmingCharacters(in: .whitespacesAndNewlines)),
              let origin = Self.origin(of: url) else {
            throw CanopyAccountServiceError.invalidAccount("Enter the account URL on its Canopy")
        }
        _ = try await NativeAccountService(origin: origin).claimAccount(account: url, label: deviceLabel, inviteCode: inviteCode)
    }

    func cancelPendingClaim() async throws {
        throw CanopyAccountServiceError.unsupported(.cancelPendingClaim)
    }

    func claimPairing(_ payload: Data, deviceLabel: String) async throws -> CanopyPairingClaim {
        let payload = try JSONDecoder().decode(PairingPayload.self, from: payload).validated()
        let service = NativeAccountService(origin: payload.origin)
        let claim = try await service.claim(payload, label: deviceLabel)
        return CanopyPairingClaim(
            configurationTree: await service.configurationID(),
            confirmationCode: claim.confirmationCode
        )
    }

    func resumePairing() async throws {
        throw CanopyAccountServiceError.unsupported(.resumePairing)
    }

    func forget(origin: URL, configurationTree: String?) async throws {
        try await NativeAccountService(origin: origin, configurationTree: configurationTree).forget()
    }

    func placements(configurationTree: String) async throws -> [CanopyPlacement] {
        try await KeychainDeviceCredentialStore().placements(configurationTree: configurationTree).map { CanopyPlacement($0) }
    }

    /// The profile key claims where this iPhone holds it; otherwise the
    /// iPhone's own device key connects to a placement claimed from the Mac,
    /// which the placement host accepts because the home host lists it.
    func placeAccount(configurationTree: String, host: String, inviteCode: String?) async throws {
        guard let account = try await KeychainDeviceCredentialStore().accounts().first(where: { $0.configurationTree == configurationTree }) else {
            throw CanopyAccountServiceError.invalidAccount("This account is not on this device")
        }
        _ = try await NativeAccountService(origin: account.origin, configurationTree: configurationTree)
            .placeAccount(on: host, inviteCode: inviteCode)
    }

    func forgetPlacement(_ placement: CanopyPlacement) async throws {
        try await KeychainDeviceCredentialStore().forgetPlacement(configurationTree: placement.configurationTree, origin: placement.origin)
    }

    private static func origin(of url: URL) -> URL? {
        guard let scheme = url.scheme, let host = url.host() else { return nil }
        var components = URLComponents()
        components.scheme = scheme
        components.host = host
        components.port = url.port
        return components.url
    }
}

extension CanopyAccount {
    init(_ account: NativeHostAccount) {
        self.init(
            configurationTree: account.configurationTree,
            origin: account.origin,
            handle: account.handle,
            profileTree: account.profileTree,
            deviceID: account.deviceID,
            credentialAvailable: true
        )
    }
}
