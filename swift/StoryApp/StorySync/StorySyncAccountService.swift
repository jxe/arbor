#if os(macOS)
import Foundation
import Overstory
import OverstoryClient

/// The Mac's accounts: the data home, which owns this Mac's identity and
/// account credentials (Native 011, option 1). Every operation is one of the
/// daemon's onboarding routes, so the daemon and the `story` command see the
/// same accounts the app does. The daemon has no route that forgets an
/// account.
struct StorySyncAccountService: HostAccountService {
    /// The connected control-mode daemon; throws when none is connected.
    let connect: @Sendable () async throws -> StorySyncRESTClient

    var capabilities: Set<HostAccountCapability> {
        [.restoreIdentity, .backupIdentity, .cancelPendingClaim, .resumePairing, .connectPlacement]
    }

    func state() async throws -> HostAccountState {
        let envelope = try await connect().onboardingState()
        return HostAccountState(
            accounts: envelope.accounts.map { HostAccount($0) },
            identity: envelope.identity.map {
                StoryProfileIdentityState(profileTree: $0.profileTree, keyAvailable: $0.keyAvailable)
            },
            pendingClaim: envelope.pendingClaim.map {
                PendingHostAccountClaim(account: $0.account, canCancel: $0.canCancel == true)
            },
            pendingPairingOrigin: envelope.pendingPairing?.origin
        )
    }

    func accounts() async throws -> [HostAccount] {
        try await connect().accounts().map { HostAccount($0) }
    }

    func credentialProvider(configurationTree: String) async throws -> any ProtocolCredentialProvider {
        StorySyncCredentialProvider.shared(client: try await connect(), configurationTree: configurationTree)
    }

    /// The daemon's session at a placement host (`GET /v1/credential?origin=`),
    /// opened there with the data home's device key.
    func credentialProvider(configurationTree: String, placementOrigin origin: String) async throws -> any ProtocolCredentialProvider {
        StorySyncCredentialProvider.shared(client: try await connect(), configurationTree: configurationTree, origin: origin)
    }

    func createIdentity() async throws {
        let client = try await connect()
        try await client.createIdentity(path: Self.profilePath(try await client.onboardingState()))
    }

    func restoreIdentity(backup: Data, passphrase: String?) async throws {
        let client = try await connect()
        try await client.restoreIdentity(backup: backup, path: Self.profilePath(try await client.onboardingState()), passphrase: passphrase)
    }

    func backupIdentity(to destination: URL, passphrase: String) async throws {
        try await connect().backupIdentity(destination: destination.path, passphrase: passphrase)
    }

    func claimAccount(_ account: String, deviceLabel _: String, inviteCode: String?) async throws {
        let client = try await connect()
        let envelope = try await client.onboardingState()
        // A resumed claim keeps the profile folder it began with.
        try await client.claimAccount(
            account: account,
            path: envelope.pendingClaim?.path ?? Self.profilePath(envelope),
            inviteCode: inviteCode
        )
    }

    func cancelPendingClaim() async throws {
        try await connect().cancelPendingClaim()
    }

    func claimPairing(_ payload: Data, deviceLabel _: String) async throws -> StoryPairingClaim {
        try await connect().claimPairing(payload: payload)
        // The daemon reports effects only; callers find the new account in
        // the account list.
        return StoryPairingClaim(configurationTree: nil, confirmationCode: nil)
    }

    func resumePairing() async throws {
        try await connect().claimPairing()
    }

    func forget(origin _: URL, configurationTree _: String?) async throws {
        throw HostAccountServiceError.unsupported(.forget)
    }

    /// The data home's placement connections, read from disk as the
    /// `story` command and the daemon write them (`HostPlacementStore`).
    func placements(configurationTree: String) async throws -> [StoryPlacement] {
        DataHomePlacementStore(dataHome: StorySupportDirectories.dataHome)
            .placements(configurationTree: configurationTree)
            .map { StoryPlacement($0) }
    }

    /// The daemon connects with the data home's device key, as `story place`
    /// does on first use (Security 011).
    func connectPlacement(configurationTree _: String, host: String) async throws {
        try await connect().connectPlacement(host: host)
    }

    /// Remove the connection's directory, as `HostPlacementStore.remove()` does.
    func forgetPlacement(_ placement: StoryPlacement) async throws {
        try DataHomePlacementStore(dataHome: StorySupportDirectories.dataHome)
            .remove(configurationTree: placement.configurationTree, origin: placement.origin)
    }

    /// The data home's profile folder: the identity's own, or the app's
    /// default for a new one.
    private static func profilePath(_ envelope: LocalHostAccountsEnvelope) -> String {
        envelope.identity?.profilePath ?? StorySupportDirectories.root.appending(path: "Profile").path
    }
}

extension HostAccount {
    init(_ account: LocalHostAccountDescriptor) {
        self.init(
            configurationTree: account.configurationTree,
            origin: account.host.flatMap(URL.init(string:)),
            handle: account.handle,
            profileTree: account.profileTree,
            deviceID: account.deviceID,
            credentialAvailable: account.credentialAvailable
        )
    }
}
#endif
