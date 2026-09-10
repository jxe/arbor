import Foundation
import XCTest
import ArborKit
@testable import ArborSyncClient

final class ArborSyncClientTests: XCTestCase {
    private var referenceFixtures: URL {
        if let path = ProcessInfo.processInfo.environment["ARBOR_REFERENCE_FIXTURES"] {
            return URL(fileURLWithPath: path, isDirectory: true)
        }
        return URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .appending(path: "../../../../../tests/fixtures")
            .standardizedFileURL
    }

    private var fixtures: URL { referenceFixtures.appending(path: "arborsync", directoryHint: .isDirectory) }
    private var canopyFixtures: URL { referenceFixtures.appending(path: "canopy", directoryHint: .isDirectory) }

    private var conformanceFixtures: URL {
        if let path = ProcessInfo.processInfo.environment["ARBOR_PROTOCOL_FIXTURES"] {
            return URL(fileURLWithPath: path, isDirectory: true)
        }
        return URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .appending(path: "../../../../../conformance")
            .standardizedFileURL
    }

    private func decode<T: Decodable>(_ type: T.Type, _ name: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(contentsOf: fixtures.appending(path: name)))
    }

    func testSharedFixturesDecodeWithoutAppDependencies() throws {
        let status = try decode(ArborSyncStatus.self, "status.json")
        let error = try decode(ArborSyncErrorEnvelope.self, "error.json")
        let errors = try decode([ArborSyncErrorEnvelope].self, "errors.json")
        let conflict = try decode(ArborSyncConflictWorkspace.self, "conflict-workspace.json")
        let credential = try decode(TreeCredential.self, "credential.json")
        let cursors = try XCTUnwrap(JSONSerialization.jsonObject(
            with: Data(contentsOf: fixtures.appending(path: "cursors.json"))
        ) as? [String: String])
        let mergeFixtureData = try Data(contentsOf: canopyFixtures.appending(path: "wire-merge.json"))
        let mergeFixtures = try XCTUnwrap(JSONSerialization.jsonObject(with: mergeFixtureData) as? [String: Any])
        let intentFixtureData = try Data(contentsOf: conformanceFixtures.appending(path: "wire-update-intent.json"))
        let intentFixtures = try XCTUnwrap(JSONSerialization.jsonObject(with: intentFixtureData) as? [String: Any])
        // `bootstrap.json` and `bootstrap-pending.json` decode through the client in `LoopbackServicesTests`.

        XCTAssertEqual(status.instanceID, "instance-fixture-01")
        XCTAssertEqual(status.runtimeKind, "cloud")
        XCTAssertEqual(status.deviceID, "dv_fixturedevice23456723456723")
        XCTAssertEqual(error.error, "future-error-code")
        XCTAssertEqual(errors.last?.error, "future-error-code")
        XCTAssertEqual(conflict.items.first?.draft.text, "both\n")
        XCTAssertEqual(conflict.items.first?.offersBoth, true)
        XCTAssertFalse(credential.token.isEmpty)
        XCTAssertEqual(cursors["current"]?.hasSuffix(":5"), true)
        XCTAssertEqual(mergeFixtures["version"] as? Int, 2)
        XCTAssertGreaterThanOrEqual((mergeFixtures["markdownCases"] as? [[String: Any]])?.count ?? 0, 10)
        XCTAssertEqual((mergeFixtures["pageMoveCases"] as? [[String: Any]])?.count, 4)
        XCTAssertEqual(
            (intentFixtures["replayCases"] as? [[String: Any]])?.compactMap { $0["name"] as? String },
            ["same-intent-different-object-envelope", "different-candidate-has-different-digest"]
        )
    }


    func testSharedSSEFixtureDecodes() throws {
        let source = try String(contentsOf: fixtures.appending(path: "events.sse"), encoding: .utf8)
        let dataLine = try XCTUnwrap(source.split(separator: "\n").first(where: { $0.hasPrefix("data:") }))
        let data = Data(dataLine.dropFirst(5).trimmingCharacters(in: .whitespaces).utf8)
        let event = try JSONDecoder().decode(WorkspaceEvent.self, from: data)
        XCTAssertEqual(event.change.origin, "sync")
        XCTAssertEqual(
            event.change.acceptedRequestDigests,
            ["sha256:" + String(repeating: "a", count: 64)]
        )
        XCTAssertTrue(event.cursor.hasSuffix(":5"))
    }

    func testMalformedSSEFixtureFailsWorkspaceEventDecoding() throws {
        let source = try String(contentsOf: fixtures.appending(path: "malformed-event.sse"), encoding: .utf8)
        let dataLine = try XCTUnwrap(source.split(separator: "\n").first(where: { $0.hasPrefix("data:") }))
        let data = Data(dataLine.dropFirst(5).trimmingCharacters(in: .whitespaces).utf8)
        XCTAssertThrowsError(try JSONDecoder().decode(WorkspaceEvent.self, from: data))
    }

    func testNodeRefRequiresAndEncodesExplicitStableKey() throws {
        let encoded = try JSONEncoder().encode(NodeRef.path("/notes", tree: "tr_notes"))
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        XCTAssertTrue(object["stableKey"] is NSNull)
        XCTAssertThrowsError(try JSONDecoder().decode(
            NodeRef.self,
            from: Data(#"{"tree":"tr_notes","path":"/notes"}"#.utf8)
        ))
        XCTAssertThrowsError(try JSONDecoder().decode(
            NodeRef.self,
            from: Data(#"{"tree":"tr_notes","pageID":"pg_notes","pathHint":"/notes","stableKey":null}"#.utf8)
        ))
        XCTAssertThrowsError(try JSONEncoder().encode(NodeRef(
            tree: "tr_notes",
            path: "/notes",
            stableKey: "not canonical"
        )))
    }


    /// The protocol harness (`tests/protocol/conformance.ts`) exports a control-mode
    /// daemon with one placed tree; this exercises the loopback services a
    /// working-tree client uses against it.
    func testLiveControlDaemonWhenProvided() async throws {
        guard
            let value = ProcessInfo.processInfo.environment["ARBOR_TEST_URL"],
            let url = URL(string: value),
            let tree = ProcessInfo.processInfo.environment["ARBOR_TEST_TREE"]
        else { throw XCTSkip("ARBOR_TEST_URL is not set") }

        let client = ArborSyncRESTClient(baseURL: url)
        let status = try await client.status()
        XCTAssertEqual(status.service, "arborsync")
        XCTAssertEqual(status.protocolVersion, "v1")
        let placed = try await client.trees().snapshot.first { $0.id == tree }
        XCTAssertEqual(placed?.placement, "placed")
        let bootstrap = try await client.bootstrap(tree: tree)
        XCTAssertEqual(bootstrap.tree.id, tree)
        XCTAssertEqual(bootstrap.spine.root, bootstrap.accepted.root)
        XCTAssertNil(bootstrap.blocked)
        XCTAssertFalse(bootstrap.files.isEmpty)
        let credential = try await client.credential()
        XCTAssertFalse(credential.isEmpty)
        let root = try await client.object(tree: tree, hash: bootstrap.accepted.root)
        XCTAssertFalse(root.isEmpty)
        let missing = "sha256:" + String(repeating: "0", count: 64)
        do {
            _ = try await client.object(tree: tree, hash: missing)
            XCTFail("Expected a 404 for an unavailable object")
        } catch let error as ArborSyncServerError {
            XCTAssertEqual(error.status, 404)
        }
    }








    func testLocalArborSyncKeepsOnlyPairingBootstrapRoute() async throws {
        let pairing = #"{"id":"pair_1","secret":"one-time-secret","confirmationCode":"123456","expiresAt":1787529660000}"#
        await URLProtocolStub.state.install { request, _ in
            switch (request.httpMethod, request.url?.path) {
            case ("POST", "/v1/bootstrap/pairings"): (201, Data(pairing.utf8))
            default: (404, Data(#"{"error":"not-found"}"#.utf8))
            }
        }
        let client = ArborSyncRESTClient(
            baseURL: URL(string: "http://127.0.0.1:4317")!,
            session: stubSession()
        )

        let offer = try await client.createCommunityPairing()

        XCTAssertEqual(offer.id, "pair_1")
        XCTAssertEqual(offer.confirmationCode, "123456")
        let snapshot = await URLProtocolStub.state.snapshot()
        XCTAssertEqual(snapshot.requests.map(\.method), ["POST"])
        XCTAssertEqual(snapshot.requests.map(\.path), ["/v1/bootstrap/pairings"])
    }

    func testSynchronizeScopesTheLocalFlushToOneAccount() async throws {
        await URLProtocolStub.state.install { request, _ in
            request.url?.path == "/v1/sync"
                ? (200, Data(#"{"synchronized":true}"#.utf8))
                : (404, Data(#"{"error":"not-found"}"#.utf8))
        }
        let client = ArborSyncRESTClient(
            baseURL: URL(string: "http://127.0.0.1:4317")!,
            session: stubSession()
        )

        try await client.synchronize(configurationTree: "tr_accountconfig")

        let snapshot = await URLProtocolStub.state.snapshot()
        let request = try XCTUnwrap(snapshot.requests.first)
        XCTAssertEqual(request.method, "POST")
        XCTAssertEqual(request.path, "/v1/sync")
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: snapshot.bodies[0]) as? [String: Any])
        XCTAssertEqual(body["configurationTree"] as? String, "tr_accountconfig")
    }

    func testRemoteBrowsingResolvesThenUsesExplicitTreeScope() async throws {
        let response = Data(#"{"ref":{"tree":"tr_notes7f3q2ab7c","path":"/notes/today","stableKey":"[[\"id\",\"abc123\"]]"},"enclosingTree":{"id":"tr_notes7f3q2ab7c","kind":"ordinary","access":"read","canonical":{"path":"/~alice/notes","endpoint":"https://example.test","parentTree":null}},"historical":false,"observedThrough":"up_notes"}"#.utf8)
        await URLProtocolStub.state.install { request, _ in
            request.url?.path == "/v1/resolve"
                ? (200, response)
                : (404, Data(#"{"error":"not-found"}"#.utf8))
        }
        let client = ArborSyncRESTClient(
            baseURL: URL(string: "http://127.0.0.1:4317")!,
            session: stubSession()
        )

        let resolved = try await client.resolve("arbor://example.test/~alice/notes/today")

        XCTAssertEqual(resolved.ref.stableKey, pageIDStableKey("abc123"))
        XCTAssertEqual(resolved.ref.tree, "tr_notes7f3q2ab7c")
        let captured = await URLProtocolStub.state.snapshot()
        let request = try XCTUnwrap(captured.requests.first)
        XCTAssertEqual(request.path, "/v1/resolve")
        XCTAssertEqual(request.query, "locator=arbor://example.test/~alice/notes/today")
    }

    private func stubSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [URLProtocolStub.self]
        return URLSession(configuration: configuration)
    }

}

private actor URLProtocolStubState {
    typealias Handler = @Sendable (URLRequest, Int) -> (Int, Data)

    private var handler: Handler?
    private var count = 0
    private var bodies: [Data] = []
    private var requests: [CapturedRequest] = []

    func install(_ handler: @escaping Handler) {
        self.handler = handler
        count = 0
        bodies = []
        requests = []
    }

    func response(for request: URLRequest) -> (Int, Data) {
        count += 1
        bodies.append(requestBody(request))
        requests.append(CapturedRequest(
            path: request.url?.path,
            query: request.url?.query,
            method: request.httpMethod,
            authorization: request.value(forHTTPHeaderField: "Authorization"),
            idempotencyKey: request.value(forHTTPHeaderField: "Idempotency-Key")
        ))
        return handler?(request, count) ?? (500, Data())
    }

    func snapshot() -> (count: Int, bodies: [Data], requests: [CapturedRequest]) {
        (count, bodies, requests)
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

private struct CapturedRequest: Sendable {
    var path: String?
    var query: String?
    var method: String?
    var authorization: String?
    var idempotencyKey: String?
}

private final class URLProtocolStub: URLProtocol, @unchecked Sendable {
    static let state = URLProtocolStubState()

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Task {
            let (status, data) = await Self.state.response(for: request)
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: status,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json", "ETag": "\"sha256:fixture\""]
            )!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        }
    }

    override func stopLoading() {}
}
