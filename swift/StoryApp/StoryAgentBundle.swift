#if os(macOS)
import CryptoKit
import Foundation
import Overstory

/// What an agent's cloud machine starts from: the `arbor-cloud-v2` bundle that
/// `story agent start` accepts. The Share panel makes the same bundle that
/// `story agent create` does; `packages/cli/src/cloud.ts` owns the
/// format, and this encoding must stay decodable by it.
struct StoryCloudBundlePayload: Codable, Equatable, Sendable {
    struct Placement: Codable, Equatable, Sendable {
        var treeID: String
        var canonicalURL: String
        var relativePath: String
    }

    var version = 2
    var bundleID: String
    var label: String
    var createdAt: String
    var origin: String
    var account: String
    var accountID: String
    var configurationTree: String
    var profileTree: String
    var deviceID: String
    /// The Ed25519 seed of the agent device's key, in unpadded base64url.
    var deviceKeySeed: String
    var placements: [Placement]
}

/// An agent code (accounts §5.5): 16 random bytes in unpadded base64url. The
/// agent device's ID and key are derived from it, so a link to a tree that
/// carries the code is all `story agent start` needs. `packages/protocol`
/// owns the derivation, and `conformance/agent-code.json` pins it.
struct StoryAgentCode: Equatable, Sendable {
    let code: String

    init() {
        code = StoryCloudBundle.base64URL(Data((0..<16).map { _ in UInt8.random(in: .min ... .max) }))
    }

    init?(_ code: String) {
        guard code.range(of: #"^[A-Za-z0-9_-]{22}$"#, options: .regularExpression) != nil else { return nil }
        self.code = code
    }

    private func derive(_ info: String, count: Int) -> Data {
        HKDF<SHA256>.deriveKey(
            inputKeyMaterial: SymmetricKey(data: Data(code.utf8)),
            salt: Data("overstory-agent-v1".utf8),
            info: Data(info.utf8),
            outputByteCount: count
        ).withUnsafeBytes { Data($0) }
    }

    var deviceID: String { "dv_" + Self.base32(derive("device-id", count: 16)) }

    /// Lowercase RFC 4648 base32 without padding, as Overstory IDs are written.
    private static func base32(_ data: Data) -> String {
        let alphabet = Array("abcdefghijklmnopqrstuvwxyz234567")
        var output = "", buffer = 0, bits = 0
        for byte in data {
            buffer = (buffer << 8) | Int(byte)
            bits += 8
            while bits >= 5 {
                bits -= 5
                output.append(alphabet[(buffer >> bits) & 31])
            }
        }
        if bits > 0 { output.append(alphabet[(buffer << (5 - bits)) & 31]) }
        return output
    }

    /// The Ed25519 seed of the device's key, in unpadded base64url.
    var deviceKeySeed: String { StoryCloudBundle.base64URL(derive("device-key", count: 32)) }
    /// The bundle ID local registries file this device under.
    var bundleID: String {
        "cb_" + SHA256.hash(data: Data(deviceID.utf8)).map { String(format: "%02x", $0) }.joined().prefix(32)
    }

    /// `canonicalURL` with the code as its fragment: what `story agent start` takes.
    func link(canonicalURL: String) -> String {
        canonicalURL.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + "#overstory-agent=" + code
    }
}

enum StoryCloudBundle {
    static let prefix = "arbor-cloud-v2"
    static let maximumLength = 32 * 1024

    /// `arbor-cloud-v1.<bundle ID>.<base64url of raw-DEFLATE sorted-key JSON>`.
    static func encode(_ payload: StoryCloudBundlePayload) throws -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        // Apple's `.zlib` is raw DEFLATE (RFC 1951), which Node's `inflateRawSync` reads.
        let compressed = try (encoder.encode(payload) as NSData).compressed(using: .zlib) as Data
        let encoded = "\(prefix).\(payload.bundleID).\(base64URL(compressed))"
        guard encoded.utf8.count <= maximumLength else {
            throw ProtocolValidationError.invalidValue("The agent code is longer than \(maximumLength) characters")
        }
        return encoded
    }

    static func newBundleID() -> String {
        "cb_" + UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
    }

    /// A new Ed25519 seed for the agent's own key device, as the CLI reads it.
    static func newDeviceKeySeed() -> String {
        base64URL(Curve25519.Signing.PrivateKey().rawRepresentation)
    }

    /// The `devices.yaml` key of a seed: its Ed25519 public key.
    static func deviceKey(seed: String) throws -> ProtocolDeviceKey {
        var base64 = seed.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
        guard let bytes = Data(base64Encoded: base64), bytes.count == 32 else {
            throw ProtocolValidationError.invalidValue("The agent's device key seed is malformed")
        }
        return ProtocolDeviceKey(ed25519: try Curve25519.Signing.PrivateKey(rawRepresentation: bytes).publicKey)
    }

    /// The folder a placed tree gets beneath the agent's cloud root: the last
    /// segment of its canonical path, or `tree` when that is not a portable name.
    static func relativePath(canonicalPath: String) -> String {
        let name = canonicalPath.split(separator: "/").last.map(String.init) ?? ""
        let decoded = name.removingPercentEncoding ?? name
        guard !decoded.isEmpty, decoded != ".", decoded != "..",
              !decoded.contains("/"), !decoded.contains("\\") else { return "tree" }
        return decoded
    }

    static func base64URL(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}

/// One entry of the CLI's safe bundle registry: never the device key.
struct StoryCloudBundleRecord: Codable, Equatable, Sendable, Identifiable {
    var bundleID: String
    var label: String
    var createdAt: String
    var origin: String
    var account: String
    var configurationTree: String
    var deviceID: String
    var trees: [String]?
    var revokedAt: String?

    var id: String { bundleID }

    var created: Date? { ISO8601DateFormatter.cloudBundle.date(from: createdAt) }
}

/// The CLI's `bundles.json`, shared so `story agent list` and `revoke`
/// see the bundles the app makes and the app sees the CLI's.
struct StoryCloudBundleRegistry: Sendable {
    let home: URL

    /// `STORY_CLOUD_HOME`, else `~/.story/cloud-sessions`, as `cloudHome()` in the CLI.
    static var standard: StoryCloudBundleRegistry {
        if let override = ProcessInfo.processInfo.environment["STORY_CLOUD_HOME"], !override.isEmpty {
            return StoryCloudBundleRegistry(home: URL(fileURLWithPath: override, isDirectory: true).standardizedFileURL)
        }
        return StoryCloudBundleRegistry(home: FileManager.default.homeDirectoryForCurrentUser
            .appending(path: ".story/cloud-sessions", directoryHint: .isDirectory))
    }

    private var url: URL { home.appending(path: "bundles.json") }

    func load() throws -> [StoryCloudBundleRecord] {
        guard FileManager.default.fileExists(atPath: url.path) else { return [] }
        return try JSONDecoder().decode([StoryCloudBundleRecord].self, from: Data(contentsOf: url))
    }

    func save(_ record: StoryCloudBundleRecord) throws {
        var records = try load().filter { $0.bundleID != record.bundleID }
        records.append(record)
        records.sort { $0.createdAt < $1.createdAt }
        try write(records)
    }

    func markRevoked(bundleID: String, at date: Date) throws {
        var records = try load()
        guard let index = records.firstIndex(where: { $0.bundleID == bundleID }) else {
            throw ProtocolValidationError.invalidValue("Unknown local agent bundle: \(bundleID)")
        }
        records[index].revokedAt = ISO8601DateFormatter.cloudBundle.string(from: date)
        try write(records)
    }

    private func write(_ records: [StoryCloudBundleRecord]) throws {
        let manager = FileManager.default
        try manager.createDirectory(at: home, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try manager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: home.path)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .withoutEscapingSlashes]
        var data = try encoder.encode(records)
        data.append(0x0A)
        let temporary = home.appending(path: "bundles.json.\(UUID().uuidString).tmp")
        guard manager.createFile(atPath: temporary.path, contents: data, attributes: [.posixPermissions: 0o600]) else {
            throw CocoaError(.fileWriteUnknown, userInfo: [NSFilePathErrorKey: temporary.path])
        }
        guard rename(temporary.path, url.path) == 0 else {
            let error = POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
            try? manager.removeItem(at: temporary)
            throw error
        }
    }
}

extension ISO8601DateFormatter {
    /// `Date.toISOString()`'s form, which the CLI writes.
    nonisolated(unsafe) static let cloudBundle: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
}
#endif
