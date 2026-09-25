#if os(macOS)
import CryptoKit
import Foundation
import Overstory

/// What an agent's cloud machine starts from: the `arbor-cloud-v1` bundle that
/// `arbor cloud start` accepts. The Share panel makes the same bundle that
/// `arbor cloud bundle create` does; `packages/cli/src/cloud.ts` owns the
/// format, and this encoding must stay decodable by it.
struct CanopyCloudBundlePayload: Codable, Equatable, Sendable {
    struct Placement: Codable, Equatable, Sendable {
        var treeID: String
        var canonicalURL: String
        var relativePath: String
    }

    var version = 1
    var bundleID: String
    var label: String
    var createdAt: String
    var origin: String
    var account: String
    var accountID: String
    var configurationTree: String
    var profileTree: String
    var deviceID: String
    var credential: String
    var placements: [Placement]
}

enum CanopyCloudBundle {
    static let prefix = "arbor-cloud-v1"
    static let maximumLength = 32 * 1024

    /// `arbor-cloud-v1.<bundle ID>.<base64url of raw-DEFLATE sorted-key JSON>`.
    static func encode(_ payload: CanopyCloudBundlePayload) throws -> String {
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

    /// A device credential in the CLI's form, `arb_` and 64 hex digits.
    static func newCredential() -> String {
        "arb_" + hex(SymmetricKey(size: .bits256).withUnsafeBytes { Data($0) })
    }

    /// The digest canopyd stores for a device credential: SHA-256 of its UTF-8.
    static func credentialDigest(_ credential: String) -> String {
        "sha256:" + hex(Data(SHA256.hash(data: Data(credential.utf8))))
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

    private static func base64URL(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    private static func hex(_ data: Data) -> String {
        data.map { String(format: "%02x", $0) }.joined()
    }
}

/// One entry of the CLI's safe bundle registry: never the credential.
struct CanopyCloudBundleRecord: Codable, Equatable, Sendable, Identifiable {
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

/// The CLI's `bundles.json`, shared so `arbor cloud bundle list` and `revoke`
/// see the bundles the app makes and the app sees the CLI's.
struct CanopyCloudBundleRegistry: Sendable {
    let home: URL

    /// `ARBOR_CLOUD_HOME`, else `~/.arbor/cloud-sessions`, as `cloudHome()` in the CLI.
    static var standard: CanopyCloudBundleRegistry {
        if let override = ProcessInfo.processInfo.environment["ARBOR_CLOUD_HOME"], !override.isEmpty {
            return CanopyCloudBundleRegistry(home: URL(fileURLWithPath: override, isDirectory: true).standardizedFileURL)
        }
        return CanopyCloudBundleRegistry(home: FileManager.default.homeDirectoryForCurrentUser
            .appending(path: ".arbor/cloud-sessions", directoryHint: .isDirectory))
    }

    private var url: URL { home.appending(path: "bundles.json") }

    func load() throws -> [CanopyCloudBundleRecord] {
        guard FileManager.default.fileExists(atPath: url.path) else { return [] }
        return try JSONDecoder().decode([CanopyCloudBundleRecord].self, from: Data(contentsOf: url))
    }

    func save(_ record: CanopyCloudBundleRecord) throws {
        var records = try load().filter { $0.bundleID != record.bundleID }
        records.append(record)
        records.sort { $0.createdAt < $1.createdAt }
        try write(records)
    }

    func markRevoked(bundleID: String, at date: Date) throws {
        var records = try load()
        guard let index = records.firstIndex(where: { $0.bundleID == bundleID }) else {
            throw ProtocolValidationError.invalidValue("Unknown local cloud bundle: \(bundleID)")
        }
        records[index].revokedAt = ISO8601DateFormatter.cloudBundle.string(from: date)
        try write(records)
    }

    private func write(_ records: [CanopyCloudBundleRecord]) throws {
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
