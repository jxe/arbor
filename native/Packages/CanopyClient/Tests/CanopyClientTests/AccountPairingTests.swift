@testable import CanopyClient
import ArborWire
import Foundation
import Testing

private actor MemoryAccountCredentialStore: AccountCredentialStore {
    var values: [String: String] = [:]
    var pending: [String: PendingPairingClaim] = [:]
    var pendingAccounts: [String: PendingAccountClaim] = [:]
    var accountValues: [String: NativeCanopyAccount] = [:]

    func load(configurationTree: String) -> String? { values[configurationTree] }
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

    func accounts() -> [NativeCanopyAccount] {
        accountValues.values.sorted { $0.configurationTree < $1.configurationTree }
    }
    func saveAccount(_ account: NativeCanopyAccount) { accountValues[account.configurationTree] = account }
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

    @Test("Account configuration access edits preserve every tree and untouched source")
    func accountAccessYAML() throws {
        let source = """
        # Keep this account-level note.
        tr_aaaaaaaaaaaaaaaaaaaaaaaaaa:
          canonical: https://canopy.example/~joe/notes
          access:
            - subject:
                kind: everyone
              access: read

        # Keep the private tree exactly as its owner wrote it.
        tr_bbbbbbbbbbbbbbbbbbbbbbbbbb:
          canonical: 'https://canopy.example/~joe/private'
          access: []
        """
        let changed = try ArborAccountConfigurationYAML.replacingTrees(in: source) { trees in
            trees["tr_aaaaaaaaaaaaaaaaaaaaaaaaaa"]?.access = [
                ArborAccountAccessRule(
                    subject: .profile(tree: "tr_cccccccccccccccccccccccccc"),
                    access: "write"
                )
            ]
        }
        let decoded = try ArborAccountConfigurationYAML.trees(from: changed)

        #expect(decoded.count == 2)
        #expect(decoded["tr_aaaaaaaaaaaaaaaaaaaaaaaaaa"]?.access == [
            ArborAccountAccessRule(
                subject: .profile(tree: "tr_cccccccccccccccccccccccccc"),
                access: "write"
            )
        ])
        #expect(decoded["tr_bbbbbbbbbbbbbbbbbbbbbbbbbb"]?.canonical == "https://canopy.example/~joe/private")
        #expect(changed.contains("""
        # Keep the private tree exactly as its owner wrote it.
        tr_bbbbbbbbbbbbbbbbbbbbbbbbbb:
          canonical: 'https://canopy.example/~joe/private'
          access: []
        """))
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
        let changed = try ArborAccountConfigurationYAML.replacingDevices(in: source) { devices in
            var phone = try #require(devices["dv_phone"])
            phone.administrator = true
            devices["dv_phone"] = phone
        }
        let decoded = try ArborAccountConfigurationYAML.devices(from: changed)

        #expect(decoded["dv_phone"]?.administrator == true)
        #expect(changed.contains("# Current Mac\ndv_mac:\n  label: Joe's Mac\n  administrator: true"))
        #expect(throws: Never.self) {
            try ArborAccountConfigurationYAML.validateAdministratorChange(
                devices: decoded,
                currentDeviceID: "dv_mac",
                targetDeviceID: "dv_phone",
                administrator: false
            )
        }
        #expect(throws: (any Error).self) {
            try ArborAccountConfigurationYAML.validateAdministratorChange(
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
            "dv_mac": ArborAccountDeviceDeclaration(label: "Joe's Mac", administrator: true),
            "dv_phone": ArborAccountDeviceDeclaration(label: "Joe’s iPhone", administrator: nil),
            "dv_tablet": ArborAccountDeviceDeclaration(label: "Joe’s iPad", administrator: nil),
        ]

        #expect(throws: Never.self) {
            try ArborAccountConfigurationYAML.validateDeviceRemoval(
                devices: devices,
                currentDeviceID: "dv_mac",
                targetDeviceID: "dv_phone"
            )
        }
        #expect(throws: (any Error).self) {
            try ArborAccountConfigurationYAML.validateDeviceRemoval(
                devices: devices,
                currentDeviceID: "dv_phone",
                targetDeviceID: "dv_phone"
            )
        }
        #expect(throws: (any Error).self) {
            try ArborAccountConfigurationYAML.validateDeviceRemoval(
                devices: devices,
                currentDeviceID: "dv_phone",
                targetDeviceID: "dv_tablet"
            )
        }
        #expect(throws: (any Error).self) {
            try ArborAccountConfigurationYAML.validateDeviceRemoval(
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
        let changed = try ArborAccountConfigurationYAML.replacingDevices(in: source) {
            $0["dv_phone"] = nil
        }
        #expect(Set(try ArborAccountConfigurationYAML.devices(from: changed).keys) == Set(["dv_mac"]))
        #expect(changed.contains("# Keep this administrator note."))
        #expect(changed.contains("# Remove this whole device block."))
    }

    @Test("Account configuration files are edited on disk atomically and only after validation")
    func accountConfigurationFileEdit() throws {
        let dataHome = FileManager.default.temporaryDirectory
            .appending(path: "ArborAccountFileEdit-\(UUID().uuidString)", directoryHint: .isDirectory)
        defer { try? FileManager.default.removeItem(at: dataHome) }
        let checkout = ArborAccountConfigurationYAML.checkoutURL(dataHome: dataHome, configurationTree: "tr_config")
        #expect(checkout.path.hasSuffix("/accounts/tr_config"))
        try FileManager.default.createDirectory(at: checkout, withIntermediateDirectories: true)
        let source = "# hosted trees\ntr_first:\n  canonical: /~joe/first\n  access: []\n"
        try source.write(to: checkout.appending(path: "trees.yaml"), atomically: true, encoding: .utf8)

        let written = try ArborAccountConfigurationYAML.editFile(named: "trees.yaml", in: checkout) { current in
            try ArborAccountConfigurationYAML.replacingTrees(in: current) { trees in
                trees["tr_second"] = ArborHostedTreeDeclaration(canonical: "/~joe/second", access: [])
            }
        } validate: { next in
            _ = try ArborAccountConfigurationYAML.trees(from: next)
        }
        #expect(written.hasPrefix("# hosted trees\ntr_first:"))
        #expect(try String(contentsOf: checkout.appending(path: "trees.yaml"), encoding: .utf8) == written)
        #expect(try ArborAccountConfigurationYAML.trees(from: written).keys.sorted() == ["tr_first", "tr_second"])

        struct Rejected: Error {}
        #expect(throws: Rejected.self) {
            try ArborAccountConfigurationYAML.editFile(named: "trees.yaml", in: checkout) { _ in "broken: [" } validate: { _ in
                throw Rejected()
            }
        }
        #expect(try String(contentsOf: checkout.appending(path: "trees.yaml"), encoding: .utf8) == written)
        let leftovers = try FileManager.default.contentsOfDirectory(atPath: checkout.path).filter { $0.hasSuffix(".tmp") }
        #expect(leftovers.isEmpty)

        try Data([0xFF, 0xFE, 0x00]).write(to: checkout.appending(path: "devices.yaml"))
        #expect(throws: ArborAccountConfigurationFileError.self) {
            try ArborAccountConfigurationYAML.readFile(named: "devices.yaml", in: checkout)
        }
    }

    @Test("Local placement YAML adds a tree without replacing another placement")
    func localPlacementYAML() throws {
        let source = """
        # Keep this placement note.
        tr_aaaaaaaaaaaaaaaaaaaaaaaaaa:
          '/Users/joe/Notes': tr_bbbbbbbbbbbbbbbbbbbbbbbbbb
        """
        let changed = try ArborLocalPlacementsYAML.adding(
            configurationTree: "tr_aaaaaaaaaaaaaaaaaaaaaaaaaa",
            path: "/Users/joe/Writing",
            tree: "tr_cccccccccccccccccccccccccc",
            to: source
        )
        let decoded = try ArborLocalPlacementsYAML.placements(from: changed)

        #expect(decoded["tr_aaaaaaaaaaaaaaaaaaaaaaaaaa"]?["/Users/joe/Notes"] == "tr_bbbbbbbbbbbbbbbbbbbbbbbbbb")
        #expect(decoded["tr_aaaaaaaaaaaaaaaaaaaaaaaaaa"]?["/Users/joe/Writing"] == "tr_cccccccccccccccccccccccccc")
        #expect(changed.contains("# Keep this placement note."))
        #expect(changed.contains("  '/Users/joe/Notes': tr_bbbbbbbbbbbbbbbbbbbbbbbbbb"))
    }

    @Test("Profile ACL labels prefer handles and protect the current user")
    func profileACLPresentation() throws {
        #expect(ArborAccountConfigurationYAML.profileDisplayName(
            locator: "arbor://community.example/~alice"
        ) == "~alice")
        #expect(ArborAccountConfigurationYAML.profileDisplayName(
            locator: nil,
            handle: "joe"
        ) == "~joe")

        var rejected = false
        do {
            try ArborAccountConfigurationYAML.validateAccessChange(
                subject: .profile(tree: "tr_joe"),
                access: "none",
                currentProfileTree: "tr_joe"
            )
        } catch {
            rejected = true
        }
        #expect(rejected)
        try ArborAccountConfigurationYAML.validateAccessChange(
            subject: .profile(tree: "tr_alice"),
            access: "none",
            currentProfileTree: "tr_joe"
        )

        let entries = ArborAccountConfigurationYAML.presentedAccessEntries(
            rules: [
                ArborAccountAccessRule(subject: .profile(tree: "tr_alice"), access: "read"),
                ArborAccountAccessRule(subject: .everyone, access: "read"),
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
        } catch is WireHTTPError {
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
                        "id": "tr_community", "kind": "ordinary", "access": "read", "root": zero, "update": "up_community",
                        "canonical": ["path": "/", "endpoint": "https://canopy.test/.well-known/arbor"],
                    ],
                    "configuration": [
                        "id": "tr_configexact", "kind": "account-configuration", "access": "write", "root": one, "update": "up_config",
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
