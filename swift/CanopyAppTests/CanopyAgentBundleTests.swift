#if os(macOS)
import Foundation
import Testing
@testable import CanopyApp

/// The CLI side of this contract, including a string encoded here, is
/// `tests/unit/cloud-bundle.test.ts`.
struct CanopyAgentBundleTests {
    private func payload() -> CanopyCloudBundlePayload {
        CanopyCloudBundlePayload(
            bundleID: "cb_0123456789abcdefghij",
            label: "Agent for code",
            createdAt: "2026-09-06T12:00:00.000Z",
            origin: "https://garden.example",
            account: "https://garden.example/~joe",
            accountID: "account-1",
            configurationTree: "tr_abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrst",
            profileTree: "tr_bcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrstu",
            deviceID: "dv_abcdefghijklmnopqrstuvwxyz",
            credential: CanopyCloudBundle.newCredential(),
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
        let encoded = try CanopyCloudBundle.encode(original)
        let parts = encoded.split(separator: ".", omittingEmptySubsequences: false)
        #expect(parts.count == 3)
        #expect(parts[0] == "arbor-cloud-v1")
        #expect(parts[1] == "cb_0123456789abcdefghij")
        var base64 = parts[2].replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
        let compressed = try #require(Data(base64Encoded: base64))
        let json = try (compressed as NSData).decompressed(using: .zlib) as Data
        #expect(try JSONDecoder().decode(CanopyCloudBundlePayload.self, from: json) == original)
        #expect(!String(decoding: json, as: UTF8.self).contains("\\/"))
    }

    @Test("Credentials and their digests match the CLI's forms")
    func credentials() {
        #expect(CanopyCloudBundle.newCredential().wholeMatch(of: /arb_[0-9a-f]{64}/) != nil)
        #expect(CanopyCloudBundle.newBundleID().wholeMatch(of: /cb_[0-9a-f]{32}/) != nil)
        #expect(CanopyCloudBundle.credentialDigest("abc")
            == "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    }

    @Test("A tree is placed under its canonical name when that is portable")
    func relativePaths() {
        #expect(CanopyCloudBundle.relativePath(canonicalPath: "/~joe/project-notes") == "project-notes")
        #expect(CanopyCloudBundle.relativePath(canonicalPath: "/~joe/my%20notes") == "my notes")
        #expect(CanopyCloudBundle.relativePath(canonicalPath: "/~joe") == "~joe")
        #expect(CanopyCloudBundle.relativePath(canonicalPath: "/") == "tree")
        #expect(CanopyCloudBundle.relativePath(canonicalPath: "/~joe/a%2Fb") == "tree")
        #expect(CanopyCloudBundle.relativePath(canonicalPath: "/~joe/..") == "tree")
    }

    @Test("The shared registry keeps no secret, records revocation, and is owner-only")
    func registry() throws {
        let home = FileManager.default.temporaryDirectory.appending(path: "canopy-cloud-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: home) }
        let registry = CanopyCloudBundleRegistry(home: home)
        #expect(try registry.load().isEmpty)
        let record = CanopyCloudBundleRecord(
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
        #expect(!source.contains("credential"))
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
