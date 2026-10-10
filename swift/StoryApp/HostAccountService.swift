import Foundation
import Overstory
import OverstoryClient

/// One Canopy account this device holds, as either platform's account store
/// reports it.
struct HostAccount: Identifiable, Hashable, Sendable {
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
struct StoryPlacement: Identifiable, Hashable, Sendable {
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

extension StoryPlacement {
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
struct StoryProfileIdentityState: Sendable, Equatable {
    let profileTree: String
    /// False when the identity is recorded but its private key is missing.
    let keyAvailable: Bool
}

/// An account claim begun and not yet finished.
struct PendingHostAccountClaim: Sendable, Equatable {
    /// The account URL being claimed.
    let account: String
    /// False once the claim may already have reached the Canopy; only resuming
    /// it is safe then.
    let canCancel: Bool
}

/// Everything onboarding reads: accounts, identity, and unfinished claims.
struct HostAccountState: Sendable, Equatable {
    var accounts: [HostAccount]
    var identity: StoryProfileIdentityState?
    var pendingClaim: PendingHostAccountClaim?
    /// The origin of a pairing claim begun and not yet finished.
    var pendingPairingOrigin: String?
}

/// The outcome of claiming a pairing offer.
struct StoryPairingClaim: Sendable, Equatable {
    /// The claimed account's configuration TreeID, when the store reports it.
    let configurationTree: String?
    /// The code both devices show, when the store reports it.
    let confirmationCode: String?
}

/// Operations one platform's account store can do and the other cannot.
enum HostAccountCapability: Sendable, Hashable {
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
    /// Connect an account to its placement account at another host from the app (accounts §1.3).
    case connectPlacement
}

enum HostAccountServiceError: Error, LocalizedError, Equatable {
    case unsupported(HostAccountCapability)
    case invalidAccount(String)

    var errorDescription: String? {
        switch self {
        case .unsupported(.restoreIdentity): "This device cannot restore an identity from a backup"
        case .unsupported(.backupIdentity): "This device cannot back up its identity to a file"
        case .unsupported(.cancelPendingClaim): "This device keeps no cancellable account claim"
        case .unsupported(.resumePairing): "Scan the pairing code again to finish pairing"
        case .unsupported(.forget): "This device cannot forget an account here"
        case .unsupported(.connectPlacement): "This device cannot add another host"
        case .invalidAccount(let message): message
        }
    }
}

/// Where this device keeps its Canopy identity and device keys, and
/// the account operations the app performs on them. `StoryWorkspaceState`
/// chooses one implementation per platform (`accountService`):
///
/// - iPhone: `KeychainAccountService`, the app's own keychain stores
///   (`NativeAccountService`, `KeychainDeviceCredentialStore`,
///   `KeychainProfileIdentityStore`).
/// - Mac: `StorySyncAccountService`, the data home through the Story Sync
///   daemon's onboarding routes, so the daemon and the `story` command see the
///   same accounts (Native 011, option 1).
///
/// Operations only one store supports are listed in `capabilities`; the others
/// throw `HostAccountServiceError.unsupported`.
protocol HostAccountService: Sendable {
    var capabilities: Set<HostAccountCapability> { get }

    func state() async throws -> HostAccountState
    func accounts() async throws -> [HostAccount]
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
    func claimPairing(_ payload: Data, deviceLabel: String) async throws -> StoryPairingClaim
    func resumePairing() async throws
    /// Remove the device key this device holds for an account; a nil
    /// configuration tree names no account, and nothing is removed.
    func forget(origin: URL, configurationTree: String?) async throws

    /// The account's placement connections on this device (accounts §1.3).
    func placements(configurationTree: String) async throws -> [StoryPlacement]
    /// Connect the account to its placement account at `host`, a Canopy URL,
    /// which the host's community created by reserving the profile's URL at
    /// its home host; this device signs in there with its own device key.
    func connectPlacement(configurationTree: String, host: String) async throws
    /// Remove a placement connection from this device. The account stays at
    /// its host; adding the host again reconnects.
    func forgetPlacement(_ placement: StoryPlacement) async throws
}

extension HostAccountService {
    func claimAccount(_ account: String, deviceLabel: String) async throws {
        try await claimAccount(account, deviceLabel: deviceLabel, inviteCode: nil)
    }
    func accounts() async throws -> [HostAccount] { try await state().accounts }

    /// A protocol client for `account`'s Canopy with its credential.
    func client(for account: HostAccount) async throws -> ProtocolClient {
        guard let origin = account.origin else {
            throw HostAccountServiceError.invalidAccount("The Canopy account names no Canopy")
        }
        return ProtocolClient(
            origin: origin,
            credentialProvider: try await credentialProvider(configurationTree: account.configurationTree)
        )
    }
}

/// The iPhone's accounts: the app's keychain, exactly as `NativeAccountService`
/// keeps it. Compiles on both platforms; the Mac chooses the data home instead.
struct KeychainAccountService: HostAccountService {
    var capabilities: Set<HostAccountCapability> { [.forget, .connectPlacement] }

    func state() async throws -> HostAccountState {
        let identity = try await KeychainProfileIdentityStore().identity()
        return HostAccountState(
            accounts: try await accounts(),
            identity: identity.map { StoryProfileIdentityState(profileTree: $0.profileTree, keyAvailable: true) },
            // The keychain's claim journals resume by claiming the same
            // account or payload again; none is listed here.
            pendingClaim: nil,
            pendingPairingOrigin: nil
        )
    }

    func accounts() async throws -> [HostAccount] {
        try await KeychainDeviceCredentialStore().accounts().map { HostAccount($0) }
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
        throw HostAccountServiceError.unsupported(.restoreIdentity)
    }

    func backupIdentity(to _: URL, passphrase _: String) async throws {
        throw HostAccountServiceError.unsupported(.backupIdentity)
    }

    func claimAccount(_ account: String, deviceLabel: String, inviteCode: String?) async throws {
        guard let url = URL(string: account.trimmingCharacters(in: .whitespacesAndNewlines)),
              let origin = Self.origin(of: url) else {
            throw HostAccountServiceError.invalidAccount("Enter the account URL on its Canopy")
        }
        _ = try await NativeAccountService(origin: origin).claimAccount(account: url, label: deviceLabel, inviteCode: inviteCode)
    }

    func cancelPendingClaim() async throws {
        throw HostAccountServiceError.unsupported(.cancelPendingClaim)
    }

    func claimPairing(_ payload: Data, deviceLabel: String) async throws -> StoryPairingClaim {
        let payload = try JSONDecoder().decode(PairingPayload.self, from: payload).validated()
        let service = NativeAccountService(origin: payload.origin)
        let claim = try await service.claim(payload, label: deviceLabel)
        return StoryPairingClaim(
            configurationTree: await service.configurationID(),
            confirmationCode: claim.confirmationCode
        )
    }

    func resumePairing() async throws {
        throw HostAccountServiceError.unsupported(.resumePairing)
    }

    func forget(origin: URL, configurationTree: String?) async throws {
        try await NativeAccountService(origin: origin, configurationTree: configurationTree).forget()
    }

    func placements(configurationTree: String) async throws -> [StoryPlacement] {
        try await KeychainDeviceCredentialStore().placements(configurationTree: configurationTree).map { StoryPlacement($0) }
    }

    /// The iPhone's own device key signs in at the host, which accepts it
    /// because the home host lists it.
    func connectPlacement(configurationTree: String, host: String) async throws {
        guard let account = try await KeychainDeviceCredentialStore().accounts().first(where: { $0.configurationTree == configurationTree }) else {
            throw HostAccountServiceError.invalidAccount("This account is not on this device")
        }
        _ = try await NativeAccountService(origin: account.origin, configurationTree: configurationTree)
            .connectPlacement(on: host)
    }

    func forgetPlacement(_ placement: StoryPlacement) async throws {
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

extension HostAccount {
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
