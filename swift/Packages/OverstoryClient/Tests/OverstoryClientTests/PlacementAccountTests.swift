@testable import OverstoryClient
import Overstory
import Foundation
import Testing

private actor PlacementTestCredentialStore: AccountCredentialStore, PlacementConnectionStore {
    var values: [String: String] = [:]
    var accountValues: [String: NativeHostAccount] = [:]
    var placementValues: [String: NativePlacementAccount] = [:]

    func load(configurationTree: String) -> String? { values[configurationTree] }
    func save(_ credential: String, configurationTree: String) { values[configurationTree] = credential }
    func forget(configurationTree: String) { values[configurationTree] = nil }
    func loadPending(origin _: URL, pairingID _: String) -> PendingPairingClaim? { nil }
    func savePending(_: PendingPairingClaim) {}
    func forgetPending(origin _: URL, pairingID _: String) {}
    func loadPendingAccount(account _: URL) -> PendingAccountClaim? { nil }
    func savePendingAccount(_: PendingAccountClaim) {}
    func forgetPendingAccount(account _: URL) {}
    func accounts() -> [NativeHostAccount] { accountValues.values.sorted { $0.configurationTree < $1.configurationTree } }
    func saveAccount(_ account: NativeHostAccount) { accountValues[account.configurationTree] = account }
    func forgetAccount(configurationTree: String) { accountValues[configurationTree] = nil }

    func placements(configurationTree: String?) -> [NativePlacementAccount] {
        placementValues.values.filter { configurationTree == nil || $0.configurationTree == configurationTree }.sorted { $0.origin < $1.origin }
    }
    func savePlacement(_ placement: NativePlacementAccount) { placementValues[placement.id] = placement }
    func forgetPlacement(configurationTree: String, origin: String) {
        placementValues[NativePlacementAccount.key(configurationTree: configurationTree, origin: origin)] = nil
    }
}

private struct PlacementCapturedRequest: Sendable {
    var method: String
    var url: String
    var authorization: String?
    var body: Data
}

/// A placement host at https://place.test for a profile whose home is
/// https://home.test: it claims with the profile key's proof and opens
/// sessions for the home host's devices.
private actor PlacementHostState {
    private(set) var requests: [PlacementCapturedRequest] = []
    var claimed = false
    var homeUnreachable = false
    /// Refuse sessions with a 403 naming the home host, as a placement host
    /// does for a route that is the home host's.
    var homeRefuses = false
    var profileTree = ""

    func reset(profileTree: String) {
        requests = []
        claimed = false
        homeUnreachable = false
        homeRefuses = false
        self.profileTree = profileTree
    }

    func setClaimed(_ value: Bool) { claimed = value }
    func setHomeUnreachable(_ value: Bool) { homeUnreachable = value }
    func setHomeRefuses(_ value: Bool) { homeRefuses = value }

    private var account: [String: Any] {
        let zero = "sha256:" + String(repeating: "0", count: 64)
        return [
            "id": profileTree, "handle": "joe", "profileTree": profileTree, "profileURL": NSNull(),
            "community": [
                "id": "tr_placecommunity", "kind": "ordinary", "access": "read", "root": zero, "update": "up_community", "conflicted": false,
                "canonical": ["path": "/", "endpoint": "https://place.test"],
            ],
            "writableProfiles": [] as [Any],
            "homeHost": "https://home.test",
            "placementRoot": ["id": "tr_placementroot", "path": "/~joe", "tree": NSNull()],
        ]
    }

    func response(for request: URLRequest) -> (Int, Data) {
        let body = requestBody(request)
        let method = request.httpMethod ?? "GET"
        let url = request.url?.absoluteString ?? ""
        requests.append(.init(method: method, url: url, authorization: request.value(forHTTPHeaderField: "Authorization"), body: body))
        let fields = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] ?? [:]
        switch (method, url) {
        case ("POST", "https://place.test/.arbor/account-challenges"):
            return (201, jsonData([
                "version": 1, "id": "ax_aaaaaaaaaaaaaaaaaaaaaaaaaa", "origin": "https://place.test", "account": "https://place.test/~joe",
                "profileTree": fields["profileTree"] ?? "", "configurationTree": fields["configurationTree"] ?? "",
                "nonce": String(repeating: "A", count: 43), "issuedAt": 1, "expiresAt": 300_001,
                "homeHost": fields["homeHost"] ?? NSNull(),
            ]))
        case ("PUT", "https://place.test/.arbor/accounts"):
            if claimed { return (409, Data(#"{"error":"already-claimed","message":"Profile already claimed","retryable":false}"#.utf8)) }
            guard fields["device"] == nil, fields["configuration"] == nil,
                  let challengeData = try? JSONSerialization.data(withJSONObject: fields["challenge"] ?? [:]),
                  let challenge = try? JSONDecoder().decode(ProtocolAccountChallenge.self, from: challengeData),
                  let publicKey = fields["publicKey"] as? String, let signature = fields["signature"] as? String,
                  let key = try? ProtocolDeviceKey("ed25519:\(publicKey)"),
                  let bytes = try? accountChallengeSigningBytes(challenge),
                  key.verifies(signature, over: bytes) else {
                return (400, Data(#"{"error":"invalid-request","message":"bad placement claim","retryable":false}"#.utf8))
            }
            claimed = true
            return (201, jsonData(["account": account]))
        case ("POST", "https://place.test/.arbor/device-sessions/challenges"):
            guard claimed else { return (404, Data(#"{"error":"not-found","message":"No such account","retryable":false}"#.utf8)) }
            if homeUnreachable {
                return (503, Data(#"{"error":"internal-error","message":"home unreachable","retryable":true,"details":{"homeHost":"https://home.test"}}"#.utf8))
            }
            if homeRefuses {
                return (403, Data(#"{"error":"permission-denied","message":"ask the home host","retryable":false,"details":{"homeHost":"https://home.test"}}"#.utf8))
            }
            return (201, jsonData([
                "version": 1, "purpose": "device-session", "id": "ax_bbbbbbbbbbbbbbbbbbbbbbbbbb", "origin": "https://place.test",
                "profileTree": fields["profileTree"] ?? "", "device": fields["device"] ?? "", "nonce": String(repeating: "B", count: 43),
                "issuedAt": 1_788_000_000_000, "expiresAt": 1_788_000_120_000,
            ]))
        case ("POST", "https://place.test/.arbor/device-sessions"):
            let device = ((fields["challenge"] as? [String: Any])?["device"] as? String) ?? ""
            return (201, jsonData(["token": "ars_place", "device": device, "expiresAt": Int(Date().timeIntervalSince1970 * 1000) + 3_600_000]))
        case ("GET", "https://place.test/.arbor/account"):
            guard request.value(forHTTPHeaderField: "Authorization") == "Bearer ars_place" else {
                return (401, Data(#"{"error":"unauthenticated","message":"Authentication required","retryable":false}"#.utf8))
            }
            return (200, jsonData(["account": account, "observedThrough": "up_1"]))
        default:
            return (404, Data(#"{"error":"not-found","message":"missing","retryable":false}"#.utf8))
        }
    }

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

private final class PlacementHostProtocol: URLProtocol, @unchecked Sendable {
    static let state = PlacementHostState()

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

@Suite("Placement accounts", .serialized)
struct PlacementAccountTests {
    private let home = URL(string: "https://home.test")!

    private func session() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [PlacementHostProtocol.self]
        return URLSession(configuration: configuration)
    }

    /// A connected home account at https://home.test for `profileTree`, with a device key.
    private func homeAccount(profileTree: String, in store: PlacementTestCredentialStore) async throws -> String {
        let configurationTree = treeConfigurationID(profileTree)
        await store.save(try DeviceKeySecret.generate().stored, configurationTree: configurationTree)
        await store.saveAccount(NativeHostAccount(
            configurationTree: configurationTree, origin: home, accountID: profileTree,
            handle: "joe", profileTree: profileTree, deviceID: "dv_phone"
        ))
        return configurationTree
    }

    @Test("A device holding the profile key claims a placement, signing the home host, and connects with its device key")
    func claimWithProfileKey() async throws {
        let identityStore = KeychainProfileIdentityStore(service: "org.nxhx.Arbor.test.profile.\(UUID().uuidString)")
        let identity = try await identityStore.create()
        await PlacementHostProtocol.state.reset(profileTree: identity.profileTree)
        let store = PlacementTestCredentialStore()
        let configurationTree = try await homeAccount(profileTree: identity.profileTree, in: store)
        let service = NativeAccountService(origin: home, configurationTree: configurationTree, credentials: store, session: session(), retryDelay: { _ in })

        let placed = try await service.placeAccount(on: "https://place.test", identityStore: identityStore)
        #expect(placed.claimed)
        #expect(placed.placement == NativePlacementAccount(
            configurationTree: configurationTree, origin: "https://place.test", account: "https://place.test/~joe",
            accountID: identity.profileTree, handle: "joe", profileTree: identity.profileTree,
            homeHost: "https://home.test", placementRoot: "tr_placementroot"
        ))
        #expect(try await service.placements() == [placed.placement])

        let requests = await PlacementHostProtocol.state.requests
        let challengeRequest = try #require(requests.first { $0.url.hasSuffix("/.arbor/account-challenges") })
        let asked = try #require(try JSONSerialization.jsonObject(with: challengeRequest.body) as? [String: Any])
        #expect(asked["homeHost"] as? String == "https://home.test")
        #expect(asked["configurationTree"] as? String == configurationTree)
        let claim = try #require(requests.first { $0.method == "PUT" })
        let claimFields = try #require(try JSONSerialization.jsonObject(with: claim.body) as? [String: Any])
        #expect(Set(claimFields.keys) == ["account", "profileTree", "configurationTree", "challenge", "publicKey", "signature"])
        #expect(requests.allSatisfy { !$0.url.hasPrefix("https://home.test") })
        // The connection's reads carry the session its home device key opened there.
        #expect(requests.last { $0.url.hasSuffix("/.arbor/account") }?.authorization == "Bearer ars_place")
        let sessionChallenge = try #require(requests.first { $0.url.hasSuffix("/device-sessions/challenges") })
        #expect((try JSONSerialization.jsonObject(with: sessionChallenge.body) as? [String: Any])?["device"] as? String == "dv_phone")

        // Placing it again reconnects instead of claiming twice.
        let again = try await service.placeAccount(on: "https://place.test/", identityStore: identityStore)
        #expect(!again.claimed)
        #expect(again.placement == placed.placement)
        #expect(await PlacementHostProtocol.state.requests.filter { $0.method == "PUT" }.count == 1)

        let client = try await service.placementClient(origin: "https://place.test")
        #expect(try await client.placementAccount().account.placementRoot.path == "/~joe")

        try await service.forgetPlacement(origin: "https://place.test")
        #expect(try await service.placements().isEmpty)
    }

    @Test("A device without the profile key connects to a placement claimed elsewhere, and says why when there is none")
    func connectWithoutProfileKey() async throws {
        let profileTree = "tr_2pnrfg7hncrmqbeojpqt7qzhcf67ofz3vlqse6aw46sr3kxlvsiq"
        await PlacementHostProtocol.state.reset(profileTree: profileTree)
        let store = PlacementTestCredentialStore()
        let configurationTree = try await homeAccount(profileTree: profileTree, in: store)
        let identityStore = KeychainProfileIdentityStore(service: "org.nxhx.Arbor.test.profile.\(UUID().uuidString)")
        let service = NativeAccountService(origin: home, configurationTree: configurationTree, credentials: store, session: session(), retryDelay: { _ in })

        await #expect(throws: NativePlacementError.profileKeyUnavailable(host: "https://place.test")) {
            _ = try await service.placeAccount(on: "https://place.test", identityStore: identityStore)
        }
        #expect(try await service.placements().isEmpty)

        // Claimed from the Mac: the iPhone's own device key is listed at home, so the placement host accepts it.
        await PlacementHostProtocol.state.setClaimed(true)
        let connected = try await service.placeAccount(on: "https://place.test", identityStore: identityStore)
        #expect(!connected.claimed)
        #expect(connected.placement.account == "https://place.test/~joe")
        #expect(connected.placement.homeHost == "https://home.test")
        let requests = await PlacementHostProtocol.state.requests
        #expect(!requests.contains { $0.url.hasSuffix("/.arbor/account-challenges") || $0.method == "PUT" })

        // Forgetting the home account forgets the placements that sign in with its key.
        try await service.forget()
        #expect(await store.placements(configurationTree: nil).isEmpty)
    }

    @Test("A placement host that cannot reach the home host is reported by name")
    func homeHostUnavailable() async throws {
        let profileTree = "tr_2pnrfg7hncrmqbeojpqt7qzhcf67ofz3vlqse6aw46sr3kxlvsiq"
        await PlacementHostProtocol.state.reset(profileTree: profileTree)
        await PlacementHostProtocol.state.setClaimed(true)
        await PlacementHostProtocol.state.setHomeUnreachable(true)
        let store = PlacementTestCredentialStore()
        let configurationTree = try await homeAccount(profileTree: profileTree, in: store)
        let service = NativeAccountService(origin: home, configurationTree: configurationTree, credentials: store, session: session(), retryDelay: { _ in })
        do {
            _ = try await service.placeAccount(
                on: "https://place.test",
                identityStore: KeychainProfileIdentityStore(service: "org.nxhx.Arbor.test.profile.\(UUID().uuidString)")
            )
            Issue.record("A stale placement host opens no session")
        } catch let error as ProtocolHTTPError {
            #expect(error.status == 503)
            #expect(error.homeHost == "https://home.test")
            #expect(error.localizedDescription.contains("home.test"))
        }
    }

    @Test("Reconnecting reports a refusal that names the home host instead of claiming again")
    func adoptReportsHomeHostRefusal() async throws {
        let identityStore = KeychainProfileIdentityStore(service: "org.nxhx.Arbor.test.profile.\(UUID().uuidString)")
        let identity = try await identityStore.create()
        await PlacementHostProtocol.state.reset(profileTree: identity.profileTree)
        let store = PlacementTestCredentialStore()
        let configurationTree = try await homeAccount(profileTree: identity.profileTree, in: store)
        let service = NativeAccountService(origin: home, configurationTree: configurationTree, credentials: store, session: session(), retryDelay: { _ in })
        _ = try await service.placeAccount(on: "https://place.test", identityStore: identityStore)

        // A 4xx without `details.homeHost` would mean "no account here"; this one names the home host.
        await PlacementHostProtocol.state.setHomeRefuses(true)
        do {
            _ = try await service.placeAccount(on: "https://place.test", identityStore: identityStore)
            Issue.record("A refusal naming the home host is reported")
        } catch let error as ProtocolHTTPError {
            #expect(error.status == 403)
            #expect(error.homeHost == "https://home.test")
        }
        #expect(await PlacementHostProtocol.state.requests.filter { $0.method == "PUT" }.count == 1)
        #expect(await PlacementHostProtocol.state.requests.filter { $0.url.hasSuffix("/.arbor/account-challenges") }.count == 1)
    }

    @Test("Placement targets are HTTPS Canopy URLs other than the home host")
    func placementTargets() async throws {
        #expect(try placementTarget("https://place.test").origin == "https://place.test")
        #expect(try placementTarget("https://Place.Test:443/~joe/").account == "https://place.test/~joe")
        #expect(try placementTarget("http://127.0.0.1:4318").origin == "http://127.0.0.1:4318")
        for invalid in ["http://place.test", "place.test", "https://user@place.test", "https://place.test/?q=1", "ftp://place.test"] {
            #expect(throws: NativePlacementError.invalidHost, "\(invalid)") { _ = try placementTarget(invalid) }
        }
        let store = PlacementTestCredentialStore()
        let configurationTree = try await homeAccount(profileTree: "tr_2pnrfg7hncrmqbeojpqt7qzhcf67ofz3vlqse6aw46sr3kxlvsiq", in: store)
        let service = NativeAccountService(origin: home, configurationTree: configurationTree, credentials: store, session: session())
        await #expect(throws: NativePlacementError.homeHost("https://home.test")) {
            _ = try await service.placeAccount(on: "https://home.test/~joe")
        }
        let unconnected = NativeAccountService(origin: home, credentials: store, session: session())
        await #expect(throws: NativePlacementError.noHomeAccount) {
            _ = try await unconnected.placeAccount(on: "https://place.test")
        }
    }

    @Test("Connections are keyed as a data home keys them, and read from one")
    func connectionKeys() throws {
        // `HostPlacementStore`'s directory names: host-<sha256(origin)[0:24]>.
        #expect(NativePlacementAccount.directoryName(origin: "https://place.test") == "host-dfe99d38f7932adc13be32e7")
        #expect(NativePlacementAccount.directoryName(origin: "http://127.0.0.1:4318") == "host-7cffd9399162b658b2df48c9")
        #expect(NativePlacementAccount.key(configurationTree: "tr_config", origin: "https://place.test") == "tr_config/host-dfe99d38f7932adc13be32e7")

        let dataHome = FileManager.default.temporaryDirectory.appending(path: "ArborPlacements-\(UUID().uuidString)", directoryHint: .isDirectory)
        defer { try? FileManager.default.removeItem(at: dataHome) }
        let store = DataHomePlacementStore(dataHome: dataHome)
        let directory = store.directory(configurationTree: "tr_config", origin: "https://place.test")
        #expect(directory.path.hasSuffix("/.state/accounts/tr_config/placements/host-dfe99d38f7932adc13be32e7"))
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        // Exactly what `HostPlacementStore.set` writes.
        let record = """
        {
          "account": "https://place.test/~joe",
          "accountID": "tr_profile",
          "handle": "joe",
          "profileTree": "tr_profile",
          "homeHost": "https://home.test",
          "placementRoot": "tr_placementroot",
          "configurationTree": "tr_config",
          "origin": "https://place.test",
          "placed": true
        }
        """
        try Data(record.utf8).write(to: directory.appending(path: "connection.json"))
        // A record under another host's directory name is not this host's.
        let misplaced = store.directory(configurationTree: "tr_config", origin: "https://elsewhere.test")
        try FileManager.default.createDirectory(at: misplaced, withIntermediateDirectories: true)
        try Data(record.utf8).write(to: misplaced.appending(path: "connection.json"))

        let placements = store.placements()
        #expect(placements.map(\.origin) == ["https://place.test"])
        #expect(placements.first?.homeHost == "https://home.test")
        #expect(store.placements(configurationTree: "tr_other").isEmpty)
        try store.remove(configurationTree: "tr_config", origin: "https://place.test")
        #expect(!FileManager.default.fileExists(atPath: directory.path))
        #expect(store.placements().isEmpty)
    }

    @Test("The Keychain keeps placement connections per profile and host")
    func keychainPlacements() async throws {
        let store = KeychainDeviceCredentialStore(service: "org.nxhx.Arbor.test.\(UUID().uuidString)")
        let placement = NativePlacementAccount(
            configurationTree: "tr_config", origin: "https://place.test", account: "https://place.test/~joe",
            accountID: "tr_profile", profileTree: "tr_profile", homeHost: "https://home.test", placementRoot: "tr_root"
        )
        var other = placement
        other.origin = "https://other.test"
        other.account = "https://other.test/~joe"
        try await store.savePlacement(placement)
        try await store.savePlacement(other)
        try await store.savePlacement(placement)
        #expect(try await store.placements(configurationTree: "tr_config").map(\.origin) == ["https://other.test", "https://place.test"])
        #expect(try await store.placements(configurationTree: "tr_else").isEmpty)
        try await store.forgetPlacement(configurationTree: "tr_config", origin: "https://other.test")
        #expect(try await store.placements(configurationTree: nil) == [placement])
        var homeAsPlacement = placement
        homeAsPlacement.homeHost = placement.origin
        await #expect(throws: ProtocolValidationError.self) { try await store.savePlacement(homeAsPlacement) }
    }
}
