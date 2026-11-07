import Foundation
import Overstory
import Testing
@testable import OverstoryClient

/// The data home layout `HostAccountStore` in `@ovst/protocol` writes, read
/// from Swift. The seed, public key and digest are TypeScript's for the same
/// seed (`deviceKeyFromSeed`, `sha256`).
@Suite("Data home accounts")
struct DataHomeAccountTests {
    static let seed = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc"
    static let publicKey = "ed25519:6kpsY-KcUgq-9VB7Ey7F-ZVHdq6-vnuSQh7qaRRG0iw"
    static let digest = "dc4bf80c77473d130fa0de86ba4018fe98bb214005e6a5891d12ba91446f9e81"
    static let configurationTree = "tr_cfgaaaaaaaaaaaaaaaaaaaaaa"

    private func dataHome(session: [String: Any]? = nil, placement: String? = nil) throws -> URL {
        let home = FileManager.default.temporaryDirectory.appending(path: "DataHomeAccounts-\(UUID().uuidString)", directoryHint: .isDirectory)
        let account = home.appending(path: ".state/accounts/\(Self.configurationTree)", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: account, withIntermediateDirectories: true)
        let record: [String: Any] = [
            "account": "https://garden.example/~joe", "accountID": "ac_joe", "origin": "https://garden.example",
            "configurationTree": Self.configurationTree, "profileTree": "tr_profile", "deviceID": "dv_mac",
            "credential": "file:device-key", "tokenDigest": Self.digest, "deviceKey": Self.publicKey, "connected": true,
        ]
        try JSONSerialization.data(withJSONObject: record).write(to: account.appending(path: "connection.json"))
        try Self.seed.write(to: account.appending(path: "device-key"), atomically: true, encoding: .utf8)
        if let session {
            try JSONSerialization.data(withJSONObject: session).write(to: account.appending(path: "session.json"))
        }
        if let placement {
            let directory = account.appending(path: "placements/\(DataHomeAccountStore.placementDirectoryName(placement))", directoryHint: .isDirectory)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let record: [String: Any] = [
                "configurationTree": Self.configurationTree, "origin": placement, "account": "\(placement)/~joe",
                "accountID": "ac_orchard", "profileTree": "tr_profile", "homeHost": "https://garden.example",
                "placementRoot": "tr_root", "placed": true,
            ]
            try JSONSerialization.data(withJSONObject: record).write(to: directory.appending(path: "connection.json"))
        }
        return home
    }

    @Test("The home connection's seed is the same Ed25519 key TypeScript derives")
    func home() throws {
        let home = try dataHome()
        defer { try? FileManager.default.removeItem(at: home) }
        let connection = try #require(try DataHomeAccountStore(dataHome: home).home(Self.configurationTree))
        #expect(connection.origin.absoluteString == "https://garden.example")
        #expect(connection.deviceID == "dv_mac")
        #expect(try connection.key.publicKey() == ProtocolDeviceKey(Self.publicKey))
        #expect(try DataHomeAccountStore(dataHome: home).home("tr_cfgbbbbbbbbbbbbbbbbbbbbbbb") == nil)
    }

    @Test("A placement host uses its own connection and the home key; the home origin is the home")
    func placement() throws {
        let home = try dataHome(placement: "https://orchard.example")
        defer { try? FileManager.default.removeItem(at: home) }
        let store = DataHomeAccountStore(dataHome: home)
        let orchard = try #require(try store.connection(Self.configurationTree, origin: "https://orchard.example"))
        #expect(orchard.origin.absoluteString == "https://orchard.example")
        #expect(orchard.sessionFile.deletingLastPathComponent().lastPathComponent.hasPrefix("host-"))
        #expect(orchard.key == (try store.home(Self.configurationTree))?.key)
        #expect(try store.connection(Self.configurationTree, origin: "https://garden.example")?.sessionFile.lastPathComponent == "session.json")
        #expect(try store.connection(Self.configurationTree, origin: "https://elsewhere.example") == nil)
    }

    @Test("A usable session Story Sync cached is reused without asking the host")
    func cachedSession() async throws {
        let now = Int(Date().timeIntervalSince1970 * 1000)
        let home = try dataHome(session: ["device": "dv_mac", "token": "ars_cached", "expiresAt": now + 3_600_000, "openedAt": now])
        defer { try? FileManager.default.removeItem(at: home) }
        let provider = DataHomeCredentialProvider(store: DataHomeAccountStore(dataHome: home), configurationTree: Self.configurationTree)
        #expect(try await provider.credential() == "ars_cached")
    }

    @Test("A digest that does not match the slot means no key")
    func mismatchedDigest() throws {
        let home = try dataHome()
        defer { try? FileManager.default.removeItem(at: home) }
        try "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".write(
            to: home.appending(path: ".state/accounts/\(Self.configurationTree)/device-key"), atomically: true, encoding: .utf8)
        #expect(try DataHomeAccountStore(dataHome: home).home(Self.configurationTree) == nil)
    }
}
