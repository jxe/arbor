import Overstory
import CryptoKit
import Foundation
import Security
import Synchronization

/// A Story data home's account connections, read the way `HostAccountStore`
/// and `HostPlacementStore` in `@ovst/protocol` read them, so an app running
/// alongside Story Sync opens its own sessions from the data home's device key
/// (Clients 003 step 3) instead of asking Story Sync for one.
///
/// Layout (`<data home>/.state/accounts/<configuration tree>/`):
/// `connection.json` names the home host, profile, device and where the key's
/// Ed25519 seed lives (`file:device-key`, or `<service>/<name>` in the
/// operating-system credential store); `session.json` caches the session the
/// key last opened, shared with Story Sync and the `story` command. A
/// placement host's connection is `placements/host-<sha256(origin)[0..<24]>/`.
public struct DataHomeAccountStore: Sendable {
    public let dataHome: URL

    public init(dataHome: URL) {
        self.dataHome = dataHome
    }

    struct HomeRecord: Decodable {
        var origin: String
        var configurationTree: String
        var profileTree: String
        var deviceID: String
        var credential: String
        var tokenDigest: String
        var deviceKey: String?
        var connected: Bool
    }

    struct PlacementRecord: Decodable {
        var origin: String
        var configurationTree: String
        var profileTree: String
        var placed: Bool
    }

    struct SessionFile: Codable {
        var device: String
        var token: String
        var expiresAt: Int
        var openedAt: Int?
    }

    /// Where a connection's records live, and the key it signs with.
    public struct Connection: Sendable {
        public var origin: URL
        public var profileTree: String
        public var deviceID: String
        public var key: DeviceKeySecret
        /// The `session.json` this connection shares with Story Sync.
        public var sessionFile: URL
    }

    func accountDirectory(_ configurationTree: String) -> URL {
        dataHome.appending(path: ".state/accounts/\(configurationTree)", directoryHint: .isDirectory)
    }

    static func placementDirectoryName(_ origin: String) -> String {
        "host-" + String(SHA256.hash(data: Data(origin.utf8)).map { String(format: "%02x", $0) }.joined().prefix(24))
    }

    /// The home connection of `configurationTree`, when its slot still holds
    /// this device's key; nil otherwise.
    public func home(_ configurationTree: String) throws -> Connection? {
        let directory = accountDirectory(configurationTree)
        guard let data = try? Data(contentsOf: directory.appending(path: "connection.json")),
              let record = try? JSONDecoder().decode(HomeRecord.self, from: data),
              record.configurationTree == configurationTree, record.connected, record.deviceKey != nil,
              let origin = URL(string: record.origin) else { return nil }
        guard let seed = try readSecret(record.credential, directory: directory),
              Self.sha256Hex(seed) == record.tokenDigest,
              let key = DeviceKeySecret(dataHomeSeed: seed) else { return nil }
        return Connection(
            origin: origin,
            profileTree: record.profileTree,
            deviceID: record.deviceID,
            key: key,
            sessionFile: directory.appending(path: "session.json")
        )
    }

    /// The connection at a placement host `origin` (accounts §1.3): its
    /// profile and the home connection's device key. When `origin` is the
    /// home host, the home connection.
    public func connection(_ configurationTree: String, origin: String) throws -> Connection? {
        guard let home = try home(configurationTree) else { return nil }
        if Self.sameOrigin(home.origin.absoluteString, origin) { return home }
        let directory = accountDirectory(configurationTree)
            .appending(path: "placements/\(Self.placementDirectoryName(origin))", directoryHint: .isDirectory)
        guard let data = try? Data(contentsOf: directory.appending(path: "connection.json")),
              let record = try? JSONDecoder().decode(PlacementRecord.self, from: data),
              record.configurationTree == configurationTree, record.origin == origin, record.placed,
              let url = URL(string: record.origin) else { return nil }
        return Connection(
            origin: url,
            profileTree: record.profileTree,
            deviceID: home.deviceID,
            key: home.key,
            sessionFile: directory.appending(path: "session.json")
        )
    }

    private func readSecret(_ reference: String, directory: URL) throws -> String? {
        if reference == "file:device-key" {
            return try? String(contentsOf: directory.appending(path: "device-key"), encoding: .utf8)
        }
        guard let separator = reference.lastIndex(of: "/"),
              separator != reference.startIndex,
              reference.index(after: separator) != reference.endIndex else { return nil }
        let service = String(reference[..<separator])
        let account = String(reference[reference.index(after: separator)...])
        // Story Sync keeps the seed as a generic password (Bun.secrets).
        var item: CFTypeRef?
        let status = SecItemCopyMatching([
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ] as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = item as? Data else {
            throw DataHomeAccountError.keychain(status)
        }
        return String(data: data, encoding: .utf8)
    }

    static func sha256Hex(_ value: String) -> String {
        SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    static func sameOrigin(_ a: String, _ b: String) -> Bool {
        guard let a = URL(string: a), let b = URL(string: b) else { return false }
        return a.scheme?.lowercased() == b.scheme?.lowercased() && a.host()?.lowercased() == b.host()?.lowercased() && a.port == b.port
    }
}

public enum DataHomeAccountError: Error, LocalizedError, Equatable {
    case keychain(OSStatus)
    case noKey(configurationTree: String, origin: String?)

    public var errorDescription: String? {
        switch self {
        case let .keychain(status):
            "Story could not read this Mac's device key from the keychain (\(status))."
        case let .noKey(tree, origin):
            "This Mac holds no device key for \(tree)\(origin.map { " at \($0)" } ?? ""); pair it again."
        }
    }
}

/// Sessions a data home's device key opens, shared with Story Sync through
/// the connection's `session.json`: a usable cached session is reused, and a
/// newly opened one is written back so Story Sync and the CLI reuse it too.
public actor DataHomeCredentialProvider: ProtocolCredentialProvider {
    private static let providers = Mutex<[String: DataHomeCredentialProvider]>([:])

    /// One provider per data home, account and host, so the app's clients
    /// share one session.
    public static func shared(store: DataHomeAccountStore, configurationTree: String, origin: String? = nil) -> DataHomeCredentialProvider {
        let key = [store.dataHome.path, configurationTree, origin ?? ""].joined(separator: "\u{0}")
        return providers.withLock { providers in
            if let provider = providers[key] { return provider }
            let provider = DataHomeCredentialProvider(store: store, configurationTree: configurationTree, origin: origin)
            providers[key] = provider
            return provider
        }
    }

    private let store: DataHomeAccountStore
    private let configurationTree: String
    /// The placement host these sessions are for; nil for the home host.
    nonisolated let origin: String?
    private var cached: DataHomeAccountStore.SessionFile?
    private var opening: Task<DataHomeAccountStore.SessionFile, Error>?

    public init(store: DataHomeAccountStore, configurationTree: String, origin: String? = nil) {
        self.store = store
        self.configurationTree = configurationTree
        self.origin = origin
    }

    public func credential() async throws -> String? {
        if let cached, usable(cached) { return cached.token }
        if let opening { return try await opening.value.token }
        guard let connection = try origin.map({ try store.connection(configurationTree, origin: $0) }) ?? store.home(configurationTree) else {
            throw DataHomeAccountError.noKey(configurationTree: configurationTree, origin: origin)
        }
        if let saved = try? JSONDecoder().decode(DataHomeAccountStore.SessionFile.self, from: Data(contentsOf: connection.sessionFile)),
           saved.device == connection.deviceID, usable(saved) {
            cached = saved
            return saved.token
        }
        let task = Task {
            let openedAt = Int(Date().timeIntervalSince1970 * 1000)
            let session = try await ProtocolClient(origin: connection.origin)
                .openDeviceSession(profileTree: connection.profileTree, device: connection.deviceID, key: connection.key)
            let file = DataHomeAccountStore.SessionFile(device: connection.deviceID, token: session.token, expiresAt: session.expiresAt, openedAt: openedAt)
            let temporary = connection.sessionFile.deletingLastPathComponent().appending(path: "session.json.\(UUID().uuidString).tmp")
            if let data = try? JSONEncoder().encode(file),
               FileManager.default.createFile(atPath: temporary.path, contents: data, attributes: [.posixPermissions: 0o600]) {
                if rename(temporary.path, connection.sessionFile.path) != 0 { try? FileManager.default.removeItem(at: temporary) }
            }
            return file
        }
        opening = task
        defer { opening = nil }
        let file = try await task.value
        cached = file
        return file.token
    }

    /// Forget the session (here and in `session.json`) after the host refused
    /// it, so the next `credential()` opens another.
    public func invalidate() {
        cached = nil
        opening?.cancel()
        opening = nil
        if let connection = try? origin.map({ try store.connection(configurationTree, origin: $0) }) ?? store.home(configurationTree) {
            try? FileManager.default.removeItem(at: connection.sessionFile)
        }
    }

    private func usable(_ session: DataHomeAccountStore.SessionFile) -> Bool {
        // Without `openedAt` the margin is the full five minutes, as `sessionUsable` reads it.
        deviceSessionUsable(expiresAt: session.expiresAt, openedAt: session.openedAt ?? session.expiresAt - 20 * 60 * 1000)
    }
}
