#if os(macOS)
import Foundation
import Overstory

/// The Mac's accounts: the data home, which owns this Mac's identity and
/// account credentials (Native 011, option 1). Every operation is one of the
/// daemon's onboarding routes, so the daemon and the `arbor` command see the
/// same accounts the app does. The daemon has no route that forgets an
/// account.
struct ArborSyncAccountService: CanopyAccountService {
    /// The connected control-mode daemon; throws when none is connected.
    let connect: @Sendable () async throws -> ArborSyncRESTClient

    var capabilities: Set<CanopyAccountCapability> {
        [.restoreIdentity, .backupIdentity, .cancelPendingClaim, .resumePairing]
    }

    func state() async throws -> CanopyAccountState {
        let envelope = try await connect().onboardingState()
        return CanopyAccountState(
            accounts: envelope.accounts.map { CanopyAccount($0) },
            identity: envelope.identity.map {
                CanopyProfileIdentityState(profileTree: $0.profileTree, keyAvailable: $0.keyAvailable)
            },
            pendingClaim: envelope.pendingClaim.map {
                CanopyPendingAccountClaim(account: $0.account, canCancel: $0.canCancel == true)
            },
            pendingPairingOrigin: envelope.pendingPairing?.origin
        )
    }

    func accounts() async throws -> [CanopyAccount] {
        try await connect().accounts().map { CanopyAccount($0) }
    }

    func credentialProvider(configurationTree: String) async throws -> any ProtocolCredentialProvider {
        ArborSyncCredentialProvider(client: try await connect(), configurationTree: configurationTree)
    }

    func createIdentity() async throws {
        let client = try await connect()
        try await client.createIdentity(path: Self.profilePath(try await client.onboardingState()))
    }

    func restoreIdentity(backup: Data) async throws {
        let client = try await connect()
        try await client.restoreIdentity(backup: backup, path: Self.profilePath(try await client.onboardingState()))
    }

    func backupIdentity(to destination: URL) async throws {
        try await connect().backupIdentity(destination: destination.path)
    }

    func claimAccount(_ account: String, deviceLabel _: String) async throws {
        let client = try await connect()
        let envelope = try await client.onboardingState()
        // A resumed claim keeps the profile folder it began with.
        try await client.claimAccount(
            account: account,
            path: envelope.pendingClaim?.path ?? Self.profilePath(envelope)
        )
    }

    func cancelPendingClaim() async throws {
        try await connect().cancelPendingClaim()
    }

    func claimPairing(_ payload: Data, deviceLabel _: String) async throws -> CanopyPairingClaim {
        try await connect().claimPairing(payload: payload)
        // The daemon reports effects only; callers find the new account in
        // the account list.
        return CanopyPairingClaim(configurationTree: nil, confirmationCode: nil)
    }

    func resumePairing() async throws {
        try await connect().claimPairing()
    }

    func forget(origin _: URL, configurationTree _: String?) async throws {
        throw CanopyAccountServiceError.unsupported(.forget)
    }

    /// The data home's profile folder: the identity's own, or the app's
    /// default for a new one.
    private static func profilePath(_ envelope: LocalHostAccountsEnvelope) -> String {
        envelope.identity?.profilePath ?? CanopySupportDirectories.root.appending(path: "Profile").path
    }
}

extension CanopyAccount {
    init(_ account: LocalHostAccountDescriptor) {
        self.init(
            configurationTree: account.configurationTree,
            origin: account.canopy.flatMap(URL.init(string:)),
            handle: account.handle,
            profileTree: account.profileTree,
            deviceID: account.deviceID,
            credentialAvailable: account.credentialAvailable
        )
    }
}
#endif
