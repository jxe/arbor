import Overstory
import CryptoKit
import Foundation

/// A placement account's connection (accounts §1.3): the profile's account at
/// a host other than its home. It holds no key: the device signs in there
/// with the DeviceID and key of its home connection, because a placement host
/// accepts every device the home host lists (§5.4). Mirrors
/// `HostPlacementRecord` in `@ovst/protocol`, field for field.
public struct NativePlacementAccount: Codable, Equatable, Hashable, Sendable, Identifiable {
    /// The profile's configuration TreeID; its home connection is the
    /// `NativeHostAccount` with this configuration tree.
    public var configurationTree: String
    /// The placement host's origin.
    public var origin: String
    public var account: String
    public var accountID: String
    /// Optional Canopy-specific presentation hint; never account identity.
    public var handle: String?
    public var profileTree: String
    /// The home host the placement host reads the profile's device keys from.
    public var homeHost: String
    /// The ordinary tree the claim declared at the account's address there.
    public var placementRoot: String
    public var placed: Bool = true

    public init(configurationTree: String, origin: String, account: String, accountID: String, handle: String? = nil,
                profileTree: String, homeHost: String, placementRoot: String) {
        self.configurationTree = configurationTree
        self.origin = origin
        self.account = account
        self.accountID = accountID
        self.handle = handle
        self.profileTree = profileTree
        self.homeHost = homeHost
        self.placementRoot = placementRoot
    }

    /// One connection per profile and placement host.
    public var id: String { Self.key(configurationTree: configurationTree, origin: origin) }

    /// `<ConfigurationTreeID>/host-<digest>`: the path of the connection
    /// below `accounts/` in a data home, and its Keychain account name.
    public static func key(configurationTree: String, origin: String) -> String {
        "\(configurationTree)/\(directoryName(origin: origin))"
    }

    /// `host-` and the first 24 hex digits of SHA-256 of the origin, as
    /// `HostPlacementStore` names a placement connection's directory.
    public static func directoryName(origin: String) -> String {
        "host-" + SHA256.hash(data: Data(origin.utf8)).map { String(format: "%02x", $0) }.joined().prefix(24)
    }

    /// The checks `HostPlacementStore.safe()` makes: an account at the
    /// placement host, a home host that is another origin, and every field.
    public var isWellFormed: Bool {
        guard placed, configurationTree.hasPrefix("tr_"), originString(URL(string: origin)) == origin,
              let accountURL = URL(string: account), originString(accountURL) == origin,
              isHomeHostOrigin(homeHost), homeHost != origin,
              !accountID.isEmpty, !profileTree.isEmpty, !placementRoot.isEmpty else { return false }
        return true
    }
}

/// Where a device keeps its placement connections.
public protocol PlacementConnectionStore: Sendable {
    /// A profile's placement connections, or every profile's.
    func placements(configurationTree: String?) async throws -> [NativePlacementAccount]
    func savePlacement(_ placement: NativePlacementAccount) async throws
    func forgetPlacement(configurationTree: String, origin: String) async throws
}

public enum NativePlacementError: Error, LocalizedError, Equatable, Sendable {
    /// The host URL is not an HTTPS Canopy URL (or plain HTTP on loopback).
    case invalidHost
    /// The profile has no connected home account on this device.
    case noHomeAccount
    /// The host named is the profile's home host.
    case homeHost(String)
    /// The host has no placement account for the profile: its community has
    /// not reserved the profile's locator (`account`, at the home host).
    case notReserved(host: String, account: String)
    /// The placement host answered for another profile, home host or root.
    case mismatch(String)

    public var errorDescription: String? {
        switch self {
        case .invalidHost: "Enter the placement host as an https:// Canopy URL"
        case .noHomeAccount: "This profile has no connected home account on this device; claim or pair one first"
        case let .homeHost(host): "\(host) is this profile's home host; a placement is made at another host"
        case let .notReserved(host, account):
            "\(host) has no account for this profile. Ask its administrators to reserve \(account) as a member; then add the host again."
        case let .mismatch(message): message
        }
    }
}

/// The outcome of connecting a placement account: the connection this device
/// stored and the host's descriptor.
public struct NativePlacementResult: Sendable, Equatable {
    public var placement: NativePlacementAccount
    public var account: ProtocolPlacementAccountDescriptor
}

/// The scheme, host and port of `url`, as `new URL(...).origin` spells them.
func originString(_ url: URL?) -> String? {
    guard let url, let scheme = url.scheme?.lowercased(), let host = url.host()?.lowercased(), !host.isEmpty else { return nil }
    let defaultPort = ["http": 80, "https": 443][scheme]
    let port = url.port.flatMap { $0 == defaultPort ? nil : ":\($0)" } ?? ""
    return "\(scheme)://\(host.contains(":") ? "[\(host)]" : host)\(port)"
}

/// A placement host URL: its origin and, when a path names one, the exact
/// account URL. Mirrors `placementTarget` in `@ovst/client`.
func placementTarget(_ input: String) throws -> (origin: String, account: String?) {
    guard let url = URL(string: input.trimmingCharacters(in: .whitespacesAndNewlines)),
          let origin = originString(url), isHomeHostOrigin(origin),
          url.user == nil, url.password == nil, url.query == nil, url.fragment == nil else {
        throw NativePlacementError.invalidHost
    }
    var path = url.path
    while path.hasSuffix("/") { path.removeLast() }
    return (origin, path.isEmpty ? nil : origin + path)
}

/// The placement connections a data home holds, as the `story` command and
/// Story Sync write them (`HostPlacementStore`):
/// `<data home>/.state/accounts/<ConfigurationTreeID>/placements/host-<digest>/connection.json`.
/// The Mac reads and removes them here; claiming one needs the profile key,
/// which only the data home's own tools hold.
public struct DataHomePlacementStore: Sendable {
    public let dataHome: URL

    public init(dataHome: URL) { self.dataHome = dataHome }

    private var accountsRoot: URL {
        dataHome.appending(path: ".state", directoryHint: .isDirectory).appending(path: "accounts", directoryHint: .isDirectory)
    }

    private func placementsRoot(_ configurationTree: String) -> URL {
        accountsRoot.appending(path: configurationTree, directoryHint: .isDirectory).appending(path: "placements", directoryHint: .isDirectory)
    }

    /// The directory of one connection.
    public func directory(configurationTree: String, origin: String) -> URL {
        placementsRoot(configurationTree).appending(path: NativePlacementAccount.directoryName(origin: origin), directoryHint: .isDirectory)
    }

    /// A profile's placement connections, or every profile's; a record that
    /// fails `HostPlacementStore`'s checks is skipped, as it skips them.
    public func placements(configurationTree: String? = nil) -> [NativePlacementAccount] {
        let fileManager = FileManager.default
        let trees = configurationTree.map { [$0] }
            ?? ((try? fileManager.contentsOfDirectory(atPath: accountsRoot.path)) ?? []).filter { $0.hasPrefix("tr_") }
        var records: [NativePlacementAccount] = []
        for tree in trees {
            let root = placementsRoot(tree)
            for name in (try? fileManager.contentsOfDirectory(atPath: root.path)) ?? [] {
                guard let data = try? Data(contentsOf: root.appending(path: name).appending(path: "connection.json")),
                      let record = try? JSONDecoder().decode(NativePlacementAccount.self, from: data),
                      record.configurationTree == tree, NativePlacementAccount.directoryName(origin: record.origin) == name,
                      record.isWellFormed else { continue }
                records.append(record)
            }
        }
        return records.sorted { ($0.configurationTree, $0.origin) < ($1.configurationTree, $1.origin) }
    }

    /// Remove a connection and its cached session, as `HostPlacementStore.remove()`
    /// does. The account stays claimed at the host; placing it again reconnects.
    public func remove(configurationTree: String, origin: String) throws {
        let directory = directory(configurationTree: configurationTree, origin: origin)
        guard FileManager.default.fileExists(atPath: directory.path) else { return }
        try FileManager.default.removeItem(at: directory)
    }
}
