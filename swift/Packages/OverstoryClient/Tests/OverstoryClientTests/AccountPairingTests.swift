@testable import OverstoryClient
import Overstory
import Foundation
import Testing

private actor MemoryAccountCredentialStore: AccountCredentialStore {
    var values: [String: String] = [:]
    var pending: [String: PendingPairingClaim] = [:]
    var pendingAccounts: [String: PendingAccountClaim] = [:]
    var accountValues: [String: NativeHostAccount] = [:]
    var loads = 0

    func load(configurationTree: String) -> String? {
        loads += 1
        return values[configurationTree]
    }
    func save(_ credential: String, configurationTree: String) { values[configurationTree] = credential }
    func forget(configurationTree: String) { values[configurationTree] = nil }

    func loadPending(origin: URL, pairingID: String) -> PendingPairingClaim? {
        pending["\(origin.absoluteString)|\(pairingID)"]
    }
    func savePending(_ claim: PendingPairingClaim) {
        pending["\(claim.origin.absoluteString)|\(claim.pairingID)"] = claim
    }
    func forgetPending(origin: URL, pairingID: String) {
        pending["\(origin.absoluteString)|\(pairingID)"] = nil
    }
    func loadPendingAccount(account: URL) -> PendingAccountClaim? { pendingAccounts[account.absoluteString] }
    func savePendingAccount(_ claim: PendingAccountClaim) { pendingAccounts[claim.account.absoluteString] = claim }
    func forgetPendingAccount(account: URL) { pendingAccounts[account.absoluteString] = nil }

    func accounts() -> [NativeHostAccount] {
        accountValues.values.sorted { $0.configurationTree < $1.configurationTree }
    }
    func saveAccount(_ account: NativeHostAccount) { accountValues[account.configurationTree] = account }
    func forgetAccount(configurationTree: String) { accountValues[configurationTree] = nil }
}

@Suite("Native account pairing")
struct NativeAccountPairingTests {
    @Test("Pairing payload is versioned and server scoped")
    func pairingPayload() throws {
        let payload = PairingPayload(
            origin: URL(string: "https://arbor.example")!,
            pairing: .init(id: "pa_test", secret: "secret")
        )
        #expect(try payload.validated() == payload)
    }

    @Test("Sharing edits to access.yaml keep administrators and scoped rules; mount edits keep untouched source")
    func treeConfigurationYAML() throws {
        let source = """
        - who:
            profile: tr_aaaaaaaaaaaaaaaaaaaaaaaaaa
          allow: [admin]
        - who: everyone
          allow: [read]
        - who: everyone
          app: tr_supplies
          allow: [create-child]
          within: /inbox
        """
        let changed = try TreeConfigurationYAML.replacingAccess(in: source) { declaration in
            declaration.access = [AccountAccessRule(subject: .profile(tree: "tr_cccccccccccccccccccccccccc"), access: "write")]
        }
        let rules = try TreeConfigurationYAML.access(from: changed)
        #expect(rules.first == (try ProtocolResourceAccessRule(who: .profile("tr_aaaaaaaaaaaaaaaaaaaaaaaaaa"), allow: [.admin])))
        #expect(rules.contains(try ProtocolResourceAccessRule(who: .profile("tr_cccccccccccccccccccccccccc"), allow: [.write])))
        #expect(rules.contains { $0.app == "tr_supplies" && $0.allow == [.createChild] && $0.within == "/inbox" })
        #expect(!rules.contains(try ProtocolResourceAccessRule(who: .everyone, allow: [.read])))
        #expect(try TreeConfigurationYAML.replacingAccess(in: source) { _ in } == source)
        #expect(throws: (any Error).self) {
            try TreeConfigurationYAML.replacingAccess(in: source) { declaration in
                declaration.resourceAccess = []; declaration.access = []
            }
        }

        let mounts = "# Keep this note.\nnotes: tr_aaaaaaaaaaaaaaaaaaaaaaaaaa\nprivate: tr_bbbbbbbbbbbbbbbbbbbbbbbbbb\n"
        let moved = try TreeConfigurationYAML.replacingMounts(in: mounts) { mounts in
            mounts["private"] = nil
            mounts["archive/private"] = "tr_bbbbbbbbbbbbbbbbbbbbbbbbbb"
        }
        #expect(moved.hasPrefix("# Keep this note.\nnotes: tr_aaaaaaaaaaaaaaaaaaaaaaaaaa\n"))
        #expect(try TreeConfigurationYAML.mounts(from: moved) == [
            "notes": "tr_aaaaaaaaaaaaaaaaaaaaaaaaaa", "archive/private": "tr_bbbbbbbbbbbbbbbbbbbbbbbbbb",
        ])
        for invalid in ["/notes: tr_aaaa\n", "notes/: tr_aaaa\n", "a/../b: tr_aaaa\n", "a: tr_aaaa\nb: tr_aaaa\n", "a: notatree\n"] {
            #expect(throws: (any Error).self) { try TreeConfigurationYAML.mounts(from: invalid) }
        }
    }

    @Test("A person's first configuration has one administrator device and a readable profile")
    func initialPersonConfiguration() throws {
        let files = try TreeConfigurationYAML.initialPersonFiles(profileTree: "tr_joe", deviceID: "dv_mac", label: "Mac")
        #expect(files.keys.sorted() == ["access.yaml", "apps.yaml", "devices.yaml", "mounts.yaml"])
        let access = try TreeConfigurationYAML.access(from: files["access.yaml"]!)
        #expect(access == [
            try ProtocolResourceAccessRule(who: .profile("tr_joe"), allow: [.admin]),
            try ProtocolResourceAccessRule(who: .everyone, allow: [.read]),
        ])
        #expect(try AccountConfigurationYAML.isAdministrator(deviceID: "dv_mac", devicesSource: files["devices.yaml"]!))
        #expect(treeConfigurationID("tr_joe").hasPrefix("tr_"))
        #expect(treeConfigurationID("tr_joe").count == 55)
    }

    @Test("Device administrator edits preserve other device source")
    func deviceAdministratorYAML() throws {
        let source = """
        # Current Mac
        dv_mac:
          label: Joe's Mac
          administrator: true

        # Preserve this note and quoting.
        dv_phone:
          label: 'Joe’s iPhone'
        """
        let changed = try AccountConfigurationYAML.replacingDevices(in: source) { devices in
            var phone = try #require(devices["dv_phone"])
            phone.administrator = true
            devices["dv_phone"] = phone
        }
        let decoded = try AccountConfigurationYAML.devices(from: changed)

        #expect(decoded["dv_phone"]?.administrator == true)
        #expect(changed.contains("# Current Mac\ndv_mac:\n  label: Joe's Mac\n  administrator: true"))
        #expect(throws: Never.self) {
            try AccountConfigurationYAML.validateAdministratorChange(
                devices: decoded,
                currentDeviceID: "dv_mac",
                targetDeviceID: "dv_phone",
                administrator: false
            )
        }
        #expect(throws: (any Error).self) {
            try AccountConfigurationYAML.validateAdministratorChange(
                devices: decoded,
                currentDeviceID: "dv_mac",
                targetDeviceID: "dv_mac",
                administrator: false
            )
        }
    }

    @Test("Device removal requires an administrator and preserves another administrator")
    func deviceRemovalValidation() throws {
        let devices = [
            "dv_mac": AccountDeviceDeclaration(label: "Joe's Mac", administrator: true),
            "dv_phone": AccountDeviceDeclaration(label: "Joe’s iPhone", administrator: nil),
            "dv_tablet": AccountDeviceDeclaration(label: "Joe’s iPad", administrator: nil),
        ]

        #expect(throws: Never.self) {
            try AccountConfigurationYAML.validateDeviceRemoval(
                devices: devices,
                currentDeviceID: "dv_mac",
                targetDeviceID: "dv_phone"
            )
        }
        #expect(throws: (any Error).self) {
            try AccountConfigurationYAML.validateDeviceRemoval(
                devices: devices,
                currentDeviceID: "dv_phone",
                targetDeviceID: "dv_phone"
            )
        }
        #expect(throws: (any Error).self) {
            try AccountConfigurationYAML.validateDeviceRemoval(
                devices: devices,
                currentDeviceID: "dv_phone",
                targetDeviceID: "dv_tablet"
            )
        }
        #expect(throws: (any Error).self) {
            try AccountConfigurationYAML.validateDeviceRemoval(
                devices: devices,
                currentDeviceID: "dv_mac",
                targetDeviceID: "dv_mac"
            )
        }

        let source = """
        # Keep this administrator note.
        dv_mac:
          label: Joe's Mac
          administrator: true

        # Remove this whole device block.
        dv_phone:
          label: 'Joe’s iPhone'
        """
        let changed = try AccountConfigurationYAML.replacingDevices(in: source) {
            $0["dv_phone"] = nil
        }
        #expect(Set(try AccountConfigurationYAML.devices(from: changed).keys) == Set(["dv_mac"]))
        #expect(changed.contains("# Keep this administrator note."))
        #expect(changed.contains("# Remove this whole device block."))
    }

    @Test("Account configuration files are edited on disk atomically and only after validation")
    func accountConfigurationFileEdit() throws {
        let dataHome = FileManager.default.temporaryDirectory
            .appending(path: "ArborAccountFileEdit-\(UUID().uuidString)", directoryHint: .isDirectory)
        defer { try? FileManager.default.removeItem(at: dataHome) }
        let checkout = AccountConfigurationYAML.checkoutURL(dataHome: dataHome, configurationTree: "tr_config")
        #expect(checkout.path.hasSuffix("/accounts/tr_config"))
        try FileManager.default.createDirectory(at: checkout, withIntermediateDirectories: true)
        let source = "# mounted trees\nfirst: tr_first\n"
        try source.write(to: checkout.appending(path: "mounts.yaml"), atomically: true, encoding: .utf8)

        let written = try AccountConfigurationYAML.editFile(named: "mounts.yaml", in: checkout) { current in
            try TreeConfigurationYAML.replacingMounts(in: current) { mounts in
                mounts["second"] = "tr_second"
            }
        } validate: { next in
            _ = try TreeConfigurationYAML.mounts(from: next)
        }
        #expect(written.hasPrefix("# mounted trees\nfirst: tr_first"))
        #expect(try String(contentsOf: checkout.appending(path: "mounts.yaml"), encoding: .utf8) == written)
        #expect(try TreeConfigurationYAML.mounts(from: written).keys.sorted() == ["first", "second"])

        struct Rejected: Error {}
        #expect(throws: Rejected.self) {
            try AccountConfigurationYAML.editFile(named: "mounts.yaml", in: checkout) { _ in "broken: [" } validate: { _ in
                throw Rejected()
            }
        }
        #expect(try String(contentsOf: checkout.appending(path: "mounts.yaml"), encoding: .utf8) == written)
        let leftovers = try FileManager.default.contentsOfDirectory(atPath: checkout.path).filter { $0.hasSuffix(".tmp") }
        #expect(leftovers.isEmpty)

        try Data([0xFF, 0xFE, 0x00]).write(to: checkout.appending(path: "devices.yaml"))
        #expect(throws: AccountConfigurationFileError.self) {
            try AccountConfigurationYAML.readFile(named: "devices.yaml", in: checkout)
        }
    }

    @Test("Local placement YAML adds a tree without replacing another placement")
    func localPlacementYAML() throws {
        let source = """
        # Keep this placement note.
        tr_aaaaaaaaaaaaaaaaaaaaaaaaaa:
          '/Users/joe/Notes': tr_bbbbbbbbbbbbbbbbbbbbbbbbbb
        """
        let changed = try LocalPlacementsYAML.adding(
            configurationTree: "tr_aaaaaaaaaaaaaaaaaaaaaaaaaa",
            path: "/Users/joe/Writing",
            tree: "tr_cccccccccccccccccccccccccc",
            to: source
        )
        let decoded = try LocalPlacementsYAML.placements(from: changed)

        #expect(decoded["tr_aaaaaaaaaaaaaaaaaaaaaaaaaa"]?["/Users/joe/Notes"] == "tr_bbbbbbbbbbbbbbbbbbbbbbbbbb")
        #expect(decoded["tr_aaaaaaaaaaaaaaaaaaaaaaaaaa"]?["/Users/joe/Writing"] == "tr_cccccccccccccccccccccccccc")
        #expect(changed.contains("# Keep this placement note."))
        #expect(changed.contains("  '/Users/joe/Notes': tr_bbbbbbbbbbbbbbbbbbbbbbbbbb"))
    }

    @Test("Profile ACL labels prefer handles and protect the current user")
    func profileACLPresentation() throws {
        #expect(AccountConfigurationYAML.profileDisplayName(
            locator: "arbor://community.example/~alice"
        ) == "~alice")
        #expect(AccountConfigurationYAML.profileDisplayName(
            locator: nil,
            handle: "joe"
        ) == "~joe")

        var rejected = false
        do {
            try AccountConfigurationYAML.validateAccessChange(
                subject: .profile(tree: "tr_joe"),
                access: "none",
                currentProfileTree: "tr_joe"
            )
        } catch {
            rejected = true
        }
        #expect(rejected)
        try AccountConfigurationYAML.validateAccessChange(
            subject: .profile(tree: "tr_alice"),
            access: "none",
            currentProfileTree: "tr_joe"
        )

        let entries = AccountConfigurationYAML.presentedAccessEntries(
            rules: [
                AccountAccessRule(subject: .profile(tree: "tr_alice"), access: "read"),
                AccountAccessRule(subject: .everyone, access: "read"),
            ],
            profileLocators: ["tr_alice": "arbor://community.example/~alice"],
            currentProfileTree: "tr_joe",
            currentHandle: "joe"
        )
        #expect(entries.map(\.id) == ["profile:tr_joe", "profile:tr_alice", "everyone"])
        #expect(entries[0].displayName == "~joe")
        #expect(entries[0].access == "write")
        #expect(entries[0].isCurrentUser)
        #expect(entries[1].displayName == "~alice")
    }

    @Test("A failed account discovery retries the exact durable pairing claim")
    func exactClaimRetry() async throws {
        await PairingURLProtocol.state.reset()
        let origin = URL(string: "https://canopy.test")!
        let payload = PairingPayload(origin: origin, pairing: .init(id: "pa_exact", secret: "pairing-secret"))
        let store = MemoryAccountCredentialStore()
        let session = pairingSession()

        let first = NativeAccountService(
            origin: origin,
            credentials: store,
            legacyCredentials: nil,
            session: session,
            retryDelay: { _ in }
        )
        var firstFailed = false
        do {
            _ = try await first.claim(payload, label: " Joe's iPhone ")
        } catch is ProtocolHTTPError {
            firstFailed = true
        }
        #expect(firstFailed)

        let persisted = try #require(await store.loadPending(origin: origin, pairingID: "pa_exact"))
        #expect(persisted.stage == .claimed)
        #expect(persisted.deviceLabel == "Joe's iPhone")

        // Model a process restart: only protected storage and the scanned payload survive.
        let restarted = NativeAccountService(
            origin: origin,
            credentials: store,
            legacyCredentials: nil,
            session: session,
            retryDelay: { _ in }
        )
        let claim = try await restarted.claim(payload, label: "Joe's iPhone")
        #expect(claim.device.id == persisted.deviceID)
        #expect(await restarted.configurationID() == "tr_configexact")

        let captured = await PairingURLProtocol.state.snapshot()
        let claimRequests = captured.filter { $0.path.hasSuffix("/claim") }
        #expect(claimRequests.count == 2)
        #expect(claimRequests[0].body == claimRequests[1].body)
        #expect(claimRequests.allSatisfy { $0.authorization == nil })
        let accountRequests = captured.filter { $0.path == "/.arbor/account" }
        #expect(accountRequests.count == 2)
        #expect(accountRequests[0].authorization == accountRequests[1].authorization)
        #expect(accountRequests[1].authorization?.hasPrefix("Bearer ") == true)

        #expect(await store.loadPending(origin: origin, pairingID: "pa_exact") == nil)
        #expect(await store.load(configurationTree: "tr_configexact") == persisted.credential)
        #expect(await store.accounts().map(\.configurationTree) == ["tr_configexact"])
    }

    private func pairingSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [PairingURLProtocol.self]
        return URLSession(configuration: configuration)
    }
}

private struct PairingCapturedRequest: Sendable {
    var path: String
    var authorization: String?
    var body: Data
}

private actor PairingURLProtocolState {
    private var requests: [PairingCapturedRequest] = []
    private var accountReads = 0
    private var device: [String: AnySendableValue] = [:]

    func reset() {
        requests = []
        accountReads = 0
        device = [:]
    }

    func response(for request: URLRequest) -> (Int, Data) {
        let body = requestBody(request)
        let path = request.url?.path ?? ""
        requests.append(.init(
            path: path,
            authorization: request.value(forHTTPHeaderField: "Authorization"),
            body: body
        ))
        if path.hasSuffix("/claim") {
            guard let json = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
                  let incoming = json["device"] as? [String: Any],
                  let id = incoming["id"] as? String,
                  let label = incoming["label"] as? String else {
                return (400, Data(#"{"error":"bad-request","message":"bad claim","retryable":false}"#.utf8))
            }
            device = ["id": .string(id), "label": .string(label)]
            return (200, jsonData([
                "device": ["id": id, "account": "ac_exact", "label": label, "createdAt": 1_788_000_000_000],
                "confirmationCode": "123456",
            ]))
        }
        if path == "/.arbor/account" {
            accountReads += 1
            if accountReads == 1 {
                return (500, Data(#"{"error":"server-busy","message":"lost after claim","retryable":true}"#.utf8))
            }
            guard case let .string(id) = device["id"], case let .string(label) = device["label"] else {
                return (500, Data(#"{"error":"missing-device","message":"missing","retryable":false}"#.utf8))
            }
            let zero = "sha256:" + String(repeating: "0", count: 64)
            let one = "sha256:" + String(repeating: "1", count: 64)
            return (200, jsonData([
                "account": [
                    "id": "ac_exact",
                    "handle": "joe",
                    "profileTree": "tr_profileexact",
                    "profileURL": "https://canopy.test/~joe",
                    "community": [
                        "id": "tr_community", "kind": "ordinary", "access": "read", "root": zero, "update": "up_community", "conflicted": false,
                        "canonical": ["path": "/", "endpoint": "https://canopy.test/.well-known/arbor"],
                    ],
                    "configuration": [
                        "id": "tr_configexact", "kind": "tree-configuration", "access": "write", "root": one, "update": "up_config", "conflicted": false,
                    ],
                    "writableProfiles": [],
                    "device": ["id": id, "label": label],
                ],
                "observedThrough": "up_config",
            ]))
        }
        return (404, Data(#"{"error":"not-found","message":"missing","retryable":false}"#.utf8))
    }

    func snapshot() -> [PairingCapturedRequest] { requests }

    private func jsonData(_ value: Any) -> Data {
        (try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])) ?? Data()
    }

    private func requestBody(_ request: URLRequest) -> Data {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return Data() }
        stream.open()
        defer { stream.close() }
        var result = Data()
        var buffer = [UInt8](repeating: 0, count: 4_096)
        while stream.hasBytesAvailable {
            let read = stream.read(&buffer, maxLength: buffer.count)
            if read <= 0 { break }
            result.append(buffer, count: read)
        }
        return result
    }
}

private enum AnySendableValue: Sendable {
    case string(String)
}

private final class PairingURLProtocol: URLProtocol, @unchecked Sendable {
    static let state = PairingURLProtocolState()

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Task {
            let (status, data) = await Self.state.response(for: request)
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: status,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json"]
            )!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        }
    }

    override func stopLoading() {}
}

@Test("Stored accounts move to the derived configuration TreeID once, keeping their credential")
func rekeyStoredAccountsMovesCredential() async throws {
    let store = MemoryAccountCredentialStore()
    let origin = URL(string: "https://arbor.example")!
    await store.saveAccount(NativeHostAccount(configurationTree: "tr_oldconfig", origin: origin, accountID: "ac_old",
        handle: "joe", profileTree: "tr_joe", deviceID: "dv_phone"))
    await store.save("secret", configurationTree: "tr_oldconfig")
    await store.saveAccount(NativeHostAccount(configurationTree: "tr_orphan", origin: origin, accountID: "ac_orphan",
        handle: nil, profileTree: nil, deviceID: "dv_phone"))
    await store.save("orphan", configurationTree: "tr_orphan")
    let derived = treeConfigurationID("tr_joe")
    #expect(try await rekeyStoredAccounts(in: store) == ["tr_oldconfig": derived])
    #expect(await store.load(configurationTree: derived) == "secret")
    #expect(await store.load(configurationTree: "tr_oldconfig") == nil)
    let accounts = await store.accounts()
    #expect(accounts.map(\.configurationTree).sorted() == [derived, "tr_orphan"].sorted())
    #expect(accounts.first { $0.configurationTree == derived }?.accountID == "tr_joe")
    #expect(accounts.first { $0.configurationTree == derived }?.deviceID == "dv_phone")
    #expect(await store.load(configurationTree: "tr_orphan") == "orphan")
    #expect(try await rekeyStoredAccounts(in: store).isEmpty)
}

@Test("App consent reviews replace one exact key and reject stale or non-admin application")
func appConsentReview() throws {
    let source = """
    # Keep this note.
    tr_supplies:
      - resource: tr_notes
        allow: [read]
    tr_other:
      - resource: tr_notes
        allow: [read]
    """
    let rule = try ProtocolAppAccessRule(resource: "tr_notes", who: .me, allow: [.read, .createChild])
    let review = try AccountConfigurationYAML.prepareAppConsent(profile: "tr_joe", group: false, app: "tr_supplies", rule: rule, source: source)
    #expect(review.previous?.allow == [.read])
    #expect(review.configurationTree == treeConfigurationID("tr_joe"))
    #expect(!review.lendsWrite)
    #expect(review.rule.consentDescription(app: "tr_supplies").contains("Me through app tr_supplies"))
    #expect(try TreeConfigurationYAML.apps(from: review.after)["tr_other"] == [try ProtocolAppAccessRule(resource: "tr_notes", who: .me, allow: [.read])])
    #expect(review.after.contains("# Keep this note."))
    let devices = "dv_admin:\n  label: Mac\n  administrator: true\ndv_phone:\n  label: Phone\n"
    #expect(try AccountConfigurationYAML.applyingResourceConsent(review, to: source, deviceID: "dv_admin", devicesSource: devices) == review.after)
    #expect(throws: (any Error).self) {
        try AccountConfigurationYAML.applyingResourceConsent(review, to: source + "\n", deviceID: "dv_admin", devicesSource: devices)
    }
    #expect(throws: (any Error).self) {
        try AccountConfigurationYAML.applyingResourceConsent(review, to: source, deviceID: "dv_phone", devicesSource: devices)
    }
    let removal = try AccountConfigurationYAML.prepareAppConsent(profile: "tr_joe", group: false, app: "tr_supplies", rule: rule, removing: true, source: review.after)
    #expect(try TreeConfigurationYAML.apps(from: removal.after)["tr_supplies"] == nil)
    #expect(try TreeConfigurationYAML.apps(from: removal.after)["tr_other"] == [try ProtocolAppAccessRule(resource: "tr_notes", who: .me, allow: [.read])])
    let again = try AccountConfigurationYAML.prepareAppConsent(profile: "tr_joe", group: false, app: "tr_supplies",
        rule: ProtocolAppAccessRule(resource: "tr_notes", who: .me, allow: [.read]), source: review.after)
    #expect(try TreeConfigurationYAML.apps(from: again.after)["tr_supplies"] == [try ProtocolAppAccessRule(resource: "tr_notes", who: .me, allow: [.read])])
    // A person's apps.yaml never says `members`; a group's never says `me`.
    #expect(throws: (any Error).self) {
        try AccountConfigurationYAML.prepareAppConsent(profile: "tr_joe", group: false, app: "tr_supplies",
            rule: ProtocolAppAccessRule(resource: "tr_notes", who: .members, allow: [.read]), source: source)
    }
    let lent = try AccountConfigurationYAML.prepareAppConsent(profile: "tr_joe", group: false, app: "tr_supplies",
        rule: ProtocolAppAccessRule(resource: "tr_notes", who: .everyone, allow: [.write]), source: source)
    #expect(lent.lendsWrite)
    #expect(lent.after.contains("who: everyone"))
}

@Test("A tree's own app rule is written to its access.yaml beside its administrators")
func treeAppConsent() throws {
    let source = "- who:\n    profile: tr_joe\n  allow: [admin]\n"
    let rule = try ProtocolAppAccessRule(resource: "tr_notes", who: .everyone, allow: [.createChild], within: "/inbox")
    let review = try AccountConfigurationYAML.prepareTreeAppConsent(tree: "tr_notes", app: "tr_supplies", rule: rule, source: source)
    #expect(review.target == .treeAccess(tree: "tr_notes"))
    #expect(review.configurationTree == treeConfigurationID("tr_notes"))
    let rules = try TreeConfigurationYAML.access(from: review.after)
    #expect(rules.first?.isAdministrator == true)
    #expect(rules.contains(try ProtocolResourceAccessRule(who: .everyone, app: "tr_supplies", allow: [.createChild], within: "/inbox")))
    #expect(throws: (any Error).self) {
        try AccountConfigurationYAML.prepareTreeAppConsent(tree: "tr_notes", app: "tr_supplies",
            rule: ProtocolAppAccessRule(resource: "tr_other", who: .everyone, allow: [.read]), source: source)
    }
    let link = try ProtocolResourceAccessRule(who: .link("sha256:" + String(repeating: "a", count: 64)), allow: [.read])
    #expect(!link.consentDescription.contains("sha256:"))
}

@Test("access.yaml accepts resource rules only, with an administrator, and no ambiguous source")
func ambiguousAccessSources() throws {
    for source in [
        "- who: everyone\n  allow: [read]\n",
        "- subject:\n    kind: everyone\n  access: read\n",
        "- who:\n    profile: tr_joe\n  allow: [admin]\n  allow: [read]\n",
        "- &rule\n  who:\n    profile: tr_joe\n  allow: [admin]\n- *rule\n",
        "- who:\n    profile: tr_joe\n  allow: [admin]\n  unexpected: true\n",
        "- who:\n    profile: tr_joe\n  allow: [admin]\n- who: everyone\n  allow: [read]\n- who: everyone\n  within: /\n  allow: [write]\n",
        "- who: me\n  allow: [read]\n- who:\n    profile: tr_joe\n  allow: [admin]\n",
        "- who:\n    profile: tr_joe\n  app: tr_supplies\n  allow: [admin]\n",
        "- who: everyone\n  via: tr_supplies\n  allow: [read]\n- who:\n    profile: tr_joe\n  allow: [admin]\n",
    ] {
        #expect(throws: (any Error).self) { try TreeConfigurationYAML.access(from: source) }
    }
}

@Test("Ordinary sharing adds read without erasing an existing granular rule or duplicating its key")
func sharingOverGranularPermission() throws {
    let original = try ProtocolResourceAccessRule(who: .everyone, allow: [.createChild])
    var declaration = HostedTreeDeclaration(canonical: "https://example.test/~joe/notes", resourceAccess: [original])
    declaration.access.append(AccountAccessRule(subject: .everyone, access: "read"))
    let complete = try declaration.completeResourceAccess()
    #expect(complete.count == 1)
    #expect(complete[0].allow == [.read, .createChild])
}

@Test("Keychain saves replace an existing credential in place")
func keychainSavesReplaceInPlace() async throws {
    let store = KeychainDeviceCredentialStore(service: "org.nxhx.Arbor.test.\(UUID().uuidString)")
    let origin = URL(string: "https://canopy.test")!
    try await store.save("first", configurationTree: "tr_config")
    try await store.save("second", configurationTree: "tr_config")
    #expect(try await store.load(configurationTree: "tr_config") == "second")
    try await store.save("first", origin: origin)
    try await store.save("second", origin: origin)
    #expect(try await store.load(origin: origin) == "second")
    try await store.forget(configurationTree: "tr_config")
    try await store.forget(origin: origin)
    #expect(try await store.load(configurationTree: "tr_config") == nil)
}

@Test("The account credential provider reads the store once until the credential is rejected")
func accountCredentialProviderCaches() async throws {
    let store = MemoryAccountCredentialStore()
    await store.save("first", configurationTree: "tr_config")
    let provider = AccountStoredCredentialProvider(configurationTree: "tr_config", store: store)
    #expect(try await provider.credential() == "first")
    #expect(try await provider.credential() == "first")
    #expect(await store.loads == 1)
    await store.save("second", configurationTree: "tr_config")
    await provider.invalidate()
    #expect(try await provider.credential() == "second")
    #expect(await store.loads == 2)
}
