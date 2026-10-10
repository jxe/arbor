#if os(macOS)
import Foundation
import Testing
@testable import StoryApp

/// The CLI side of this contract, including a string encoded here, is
/// `tests/unit/cloud-bundle.test.ts`.
struct StoryAgentBundleTests {
    private func payload() -> StoryCloudBundlePayload {
        StoryCloudBundlePayload(
            bundleID: "cb_0123456789abcdefghij",
            label: "Agent for code",
            createdAt: "2026-09-06T12:00:00.000Z",
            origin: "https://garden.example",
            account: "https://garden.example/~joe",
            accountID: "account-1",
            configurationTree: "tr_abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrst",
            profileTree: "tr_bcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrstu",
            deviceID: "dv_abcdefghijklmnopqrstuvwxyz",
            deviceKeySeed: StoryCloudBundle.newDeviceKeySeed(),
            placements: [.init(
                treeID: "tr_cdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrstuv",
                canonicalURL: "https://garden.example/~joe/code",
                relativePath: "code"
            )]
        )
    }

    @Test("An agent code is the CLI's versioned raw-DEFLATE JSON string")
    func encodesCLIBundle() throws {
        let original = payload()
        let encoded = try StoryCloudBundle.encode(original)
        let parts = encoded.split(separator: ".", omittingEmptySubsequences: false)
        #expect(parts.count == 3)
        #expect(parts[0] == "arbor-cloud-v2")
        #expect(parts[1] == "cb_0123456789abcdefghij")
        var base64 = parts[2].replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
        let compressed = try #require(Data(base64Encoded: base64))
        let json = try (compressed as NSData).decompressed(using: .zlib) as Data
        #expect(try JSONDecoder().decode(StoryCloudBundlePayload.self, from: json) == original)
        #expect(!String(decoding: json, as: UTF8.self).contains("\\/"))
    }

    @Test("Device key seeds and their keys match the CLI's forms")
    func deviceKeys() throws {
        #expect(StoryCloudBundle.newDeviceKeySeed().wholeMatch(of: /[A-Za-z0-9_-]{43}/) != nil)
        #expect(StoryCloudBundle.newBundleID().wholeMatch(of: /cb_[0-9a-f]{32}/) != nil)
        // The ed25519 session vector of docs/overstory-spec/conformance/device-keys.json.
        #expect(try StoryCloudBundle.deviceKey(seed: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE").value
            == "ed25519:iojj3XQJ8ZX9UtstPLpdcspnCb8dlBIb83SIAbQPb1w")
        #expect(throws: (any Error).self) { try StoryCloudBundle.deviceKey(seed: "short") }
    }

    @Test("A tree is placed under its canonical name when that is portable")
    func relativePaths() {
        #expect(StoryCloudBundle.relativePath(canonicalPath: "/~joe/project-notes") == "project-notes")
        #expect(StoryCloudBundle.relativePath(canonicalPath: "/~joe/my%20notes") == "my notes")
        #expect(StoryCloudBundle.relativePath(canonicalPath: "/~joe") == "~joe")
        #expect(StoryCloudBundle.relativePath(canonicalPath: "/") == "tree")
        #expect(StoryCloudBundle.relativePath(canonicalPath: "/~joe/a%2Fb") == "tree")
        #expect(StoryCloudBundle.relativePath(canonicalPath: "/~joe/..") == "tree")
    }

    @Test("The shared registry keeps no secret, records revocation, and is owner-only")
    func registry() throws {
        let home = FileManager.default.temporaryDirectory.appending(path: "host-cloud-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: home) }
        let registry = StoryCloudBundleRegistry(home: home)
        #expect(try registry.load().isEmpty)
        let record = StoryCloudBundleRecord(
            bundleID: "cb_0123456789abcdefghij",
            label: "Agent for code",
            createdAt: "2026-09-06T12:00:00.000Z",
            origin: "https://garden.example",
            account: "https://garden.example/~joe",
            configurationTree: payload().configurationTree,
            deviceID: payload().deviceID,
            trees: [payload().placements[0].treeID]
        )
        try registry.save(record)
        let source = try String(contentsOf: home.appending(path: "bundles.json"), encoding: .utf8)
        #expect(!source.contains("deviceKeySeed"))
        #expect(!source.contains("revokedAt"))
        #expect(try registry.load() == [record])
        let attributes = try FileManager.default.attributesOfItem(atPath: home.appending(path: "bundles.json").path)
        #expect((attributes[.posixPermissions] as? Int) == 0o600)

        try registry.markRevoked(bundleID: record.bundleID, at: Date(timeIntervalSince1970: 0))
        #expect(try registry.load().first?.revokedAt == "1970-01-01T00:00:00.000Z")
        #expect(throws: (any Error).self) { try registry.markRevoked(bundleID: "cb_unknownunknownunknown", at: Date()) }
    }
}
#endif
