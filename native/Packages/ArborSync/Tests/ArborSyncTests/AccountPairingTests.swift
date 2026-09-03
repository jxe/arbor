@testable import ArborSync
import ArborWire
import Foundation
import Testing

private actor MemoryAccountCredentialStore: AccountCredentialStore {
    var values: [String: String] = [:]
    var pending: [String: PendingPairingClaim] = [:]
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

    func accounts() -> [NativeCanopyAccount] {
        accountValues.values.sorted { $0.configurationTree < $1.configurationTree }
    }
    func saveAccount(_ account: NativeCanopyAccount) { accountValues[account.configurationTree] = account }
    func forgetAccount(configurationTree: String) { accountValues[configurationTree] = nil }
}

@Suite("Native account pairing")
struct NativeAccountPairingTests {
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
        #expect(await restarted.configurationID() == "tr_config_exact")

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
        #expect(await store.load(configurationTree: "tr_config_exact") == persisted.credential)
        #expect(await store.accounts().map(\.configurationTree) == ["tr_config_exact"])
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
                    "profileTree": "tr_profile_exact",
                    "profileURL": "https://canopy.test/~joe",
                    "community": [
                        "id": "tr_community", "kind": "ordinary", "access": "read", "root": zero, "update": "up_community",
                        "canonical": ["path": "/", "endpoint": "https://canopy.test/.well-known/arbor"],
                    ],
                    "configuration": [
                        "id": "tr_config_exact", "kind": "account-configuration", "access": "write", "root": one, "update": "up_config",
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
