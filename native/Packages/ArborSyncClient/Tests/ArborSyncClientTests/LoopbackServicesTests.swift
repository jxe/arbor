import ArborObjectStore
import ArborWire
import Foundation
import Testing
@testable import ArborSyncClient

/// The routes a same-installation working-tree client uses: bootstrap, credential, objects,
/// and the control-mode supervisor that reaches them.
@Suite("Loopback services", .serialized)
struct LoopbackServicesTests {
    private var fixtures: URL {
        if let path = ProcessInfo.processInfo.environment["ARBOR_REFERENCE_FIXTURES"] {
            return URL(fileURLWithPath: path, isDirectory: true).appending(path: "arborsync")
        }
        return URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .appending(path: "../../../../../tests/fixtures/arborsync")
            .standardizedFileURL
    }

    private func fixture(_ name: String) throws -> Data {
        try Data(contentsOf: fixtures.appending(path: name))
    }

    private func stubbedClient() -> ArborSyncRESTClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [LoopbackStub.self]
        return ArborSyncRESTClient(
            baseURL: URL(string: "http://127.0.0.1:4317")!,
            session: URLSession(configuration: configuration)
        )
    }

    // MARK: Bootstrap

    @Test("A clean bootstrap decodes its sparse spine and lists the lazy file")
    func cleanBootstrapDecodes() async throws {
        let body = try fixture("bootstrap.json")
        await LoopbackStub.state.install { _, _ in (200, body, "application/json") }
        let bootstrap = try await stubbedClient().bootstrap(tree: "tr_notes7f3q2ab7c")

        #expect(bootstrap.tree.id == "tr_notes7f3q2ab7c")
        #expect(bootstrap.tree.osPath == "/Users/joe/notes")
        #expect(bootstrap.accepted.cursor == bootstrap.accepted.update)
        #expect(bootstrap.spine.root == bootstrap.accepted.root)
        #expect(bootstrap.pending == nil)
        #expect(bootstrap.blocked == nil)
        #expect(bootstrap.observedThrough == "1f8b3c6d-observed:7")
        #expect(bootstrap.files["/photo.bin"] == TreeBootstrapFile(size: 5, mtime: 1_725_192_000_000))

        // The spine is sparse: the root directory and the Markdown object are present,
        // the binary is referenced by hash only.
        let objects = try WireObjectGraph.validate(bootstrap.spine, mode: .sparseFiles)
        #expect(objects.count == 2)
        guard case let .directory(entries, _)? = objects[bootstrap.spine.root] else {
            Issue.record("root is not a directory"); return
        }
        let names = entries.map(\.name)
        #expect(names == ["_index.md", "photo.bin"])
        let photo = try #require(entries.first { $0.name == "photo.bin" }?.hash)
        #expect(objects[photo] == nil)
        #expect(throws: ArborWireValidationError.self) {
            try WireObjectGraph.validate(bootstrap.spine, mode: .complete)
        }
        let requests = await LoopbackStub.state.requests()
        #expect(requests.map(\.path) == ["/v1/bootstrap"])
        #expect(requests.first?.query == "tree=tr_notes7f3q2ab7c")
    }

    @Test("A pending bootstrap carries the verbatim string with one digest per element")
    func pendingBootstrapDecodes() async throws {
        let body = try fixture("bootstrap-pending.json")
        await LoopbackStub.state.install { _, _ in (200, body, "application/json") }
        let bootstrap = try await stubbedClient().bootstrap(tree: "tr_notes7f3q2ab7c")

        let pending = try #require(bootstrap.pending)
        #expect(pending.base == "upd_0001")
        #expect(pending.updates.count == 1)
        #expect(pending.requestDigests.count == 1)
        #expect(pending.requestDigests[0].hasPrefix("sha256:"))
        #expect(pending.updates[0].candidate == bootstrap.accepted.root)
        #expect(pending.updates[0].ifMatch == "modelHash")
        #expect(pending.updates[0].objects.count == 1)
        #expect(WireObjectCodec.hash(pending.updates[0].objects[0].bytes) == pending.updates[0].objects[0].hash)
        #expect(bootstrap.tree.sync == "syncing")
    }

    @Test("A payload-less entry missing from files fails the bootstrap loudly")
    func unlistedFileRejected() async throws {
        var json = try JSONSerialization.jsonObject(with: try fixture("bootstrap.json")) as! [String: Any]
        json["files"] = [String: Any]()
        let body = try JSONSerialization.data(withJSONObject: json)
        await LoopbackStub.state.install { _, _ in (200, body, "application/json") }
        await #expect(throws: TreeBootstrapError.unlistedFile(
            path: "/photo.bin",
            hash: "sha256:f05fcabf72917dc45b1642301d848414bae19363b1232e4539e8b671347272be"
        )) {
            _ = try await stubbedClient().bootstrap(tree: "tr_notes7f3q2ab7c")
        }
    }

    @Test("Bootstrap blocked and error envelopes surface as typed values")
    func blockedAndErrors() async throws {
        var json = try JSONSerialization.jsonObject(with: try fixture("bootstrap.json")) as! [String: Any]
        json["blocked"] = "editor-pending"
        let body = try JSONSerialization.data(withJSONObject: json)
        await LoopbackStub.state.install { _, _ in (200, body, "application/json") }
        let bootstrap = try await stubbedClient().bootstrap(tree: "tr_notes7f3q2ab7c")
        #expect(bootstrap.blocked == .editorPending)

        let unsynchronized = Data(#"{"error":"conflict","message":"unsynchronized","retryable":false,"details":{"kind":"unsynchronized"}}"#.utf8)
        await LoopbackStub.state.install { _, _ in (409, unsynchronized, "application/json") }
        do {
            _ = try await stubbedClient().bootstrap(tree: "tr_notes7f3q2ab7c")
            Issue.record("expected a 409")
        } catch let error as ArborSyncServerError {
            #expect(error.status == 409)
            #expect(error.value.code == "conflict")
        }
    }

    // MARK: Credential

    @Test("The credential fixture decodes and the route scopes by configuration tree")
    func credentialDecodes() async throws {
        let body = try fixture("credential.json")
        #expect(try JSONDecoder().decode(TreeCredential.self, from: body).token == "canopy-account-token-fixture")
        await LoopbackStub.state.install { _, _ in (200, body, "application/json") }
        let client = stubbedClient()
        #expect(try await client.credential() == "canopy-account-token-fixture")
        #expect(try await client.credential(configurationTree: "tr_cfg7f3q2ab7cdefg") == "canopy-account-token-fixture")
        let requests = await LoopbackStub.state.requests()
        #expect(requests.map(\.path) == ["/v1/credential", "/v1/credential"])
        #expect(requests[0].query == nil)
        #expect(requests[1].query == "configurationTree=tr_cfg7f3q2ab7cdefg")
    }

    @Test("The credential provider fetches once, caches, and refetches after invalidate")
    func credentialProviderCachesAndInvalidates() async throws {
        await LoopbackStub.state.install { _, attempt in
            (200, Data(#"{"token":"token-\#(attempt)"}"#.utf8), "application/json")
        }
        let provider = ArborSyncCredentialProvider(client: stubbedClient(), configurationTree: "tr_cfg")

        #expect(await provider.isCached == false)
        async let first = provider.credential()
        async let second = provider.credential()
        let (a, b) = try await (first, second)
        #expect(a == "token-1")
        #expect(b == "token-1")
        #expect(try await provider.credential() == "token-1")
        #expect(await provider.isCached)
        #expect(await LoopbackStub.state.requests().count == 1)

        await provider.invalidate()
        #expect(await provider.isCached == false)
        #expect(try await provider.credential() == "token-2")
        let requests = await LoopbackStub.state.requests()
        #expect(requests.count == 2)
        #expect(requests.allSatisfy { $0.query == "configurationTree=tr_cfg" })

        // As a WireCredentialProvider it feeds the Wire client's bearer header.
        let wire: any WireCredentialProvider = provider
        #expect(try await wire.credential() == "token-2")
    }

    @Test("A missing credential propagates the daemon's 404 and caches nothing")
    func credentialProviderMissing() async throws {
        await LoopbackStub.state.install { _, _ in
            (404, Data(#"{"error":"not-found","message":"No account credential is available","retryable":false}"#.utf8), "application/json")
        }
        let provider = ArborSyncCredentialProvider(client: stubbedClient())
        do {
            _ = try await provider.credential()
            Issue.record("expected not-found")
        } catch let error as ArborSyncServerError {
            #expect(error.status == 404)
        }
        #expect(await provider.isCached == false)
    }

    // MARK: Objects

    @Test("The object route returns verified bytes and asks for CBOR")
    func objectRouteVerifies() async throws {
        let bytes = try WireObjectCodec.encode(.file(Data("# Notes\n".utf8)))
        let hash = WireObjectCodec.hash(bytes)
        await LoopbackStub.state.install { _, _ in (200, bytes, "application/cbor") }
        let client = stubbedClient()
        let served = try await client.object(tree: "tr_notes", hash: hash, origin: URL(string: "https://notes.example")!)
        #expect(served == bytes)
        let request = try #require(await LoopbackStub.state.requests().first)
        #expect(request.path == "/v1/objects/\(hash)")
        #expect(request.query == "tree=tr_notes&origin=https://notes.example")
        #expect(request.accept == "application/cbor")

        await #expect(throws: ArborWireValidationError.self) {
            _ = try await client.object(tree: "tr_notes", hash: "sha256:not-a-hash")
        }
    }

    @Test("DaemonObjectStore rejects a hash mismatch and maps 404 to missing")
    func daemonObjectStoreVerifies() async throws {
        let bytes = try WireObjectCodec.encode(.file(Data("# Notes\n".utf8)))
        let hash = WireObjectCodec.hash(bytes)
        let other = "sha256:" + String(repeating: "ab", count: 32)
        await LoopbackStub.state.install { request, _ in
            if request.url?.path.hasSuffix(other) == true { return (200, bytes, "application/cbor") }
            if request.url?.path.hasSuffix(hash) == true { return (200, bytes, "application/cbor") }
            return (404, Data(#"{"error":"not-found","message":"missing","retryable":false}"#.utf8), "application/json")
        }
        let store = DaemonObjectStore(client: stubbedClient(), tree: "tr_notes")

        #expect(try await store.bytes(hash) == bytes)
        await #expect(throws: ObjectStoreError.hashMismatch(expected: other, actual: hash)) {
            _ = try await store.bytes(other)
        }
        let absent = "sha256:" + String(repeating: "cd", count: 32)
        await #expect(throws: ObjectStoreError.missing(absent)) {
            _ = try await store.bytes(absent)
        }

        // Layered behind an overlay it is the platform fallback.
        let layered = LayeredObjectStore(overlay: InMemoryObjectOverlay(), platform: store)
        #expect(try await layered.bytes(hash) == bytes)
    }

    // MARK: Control-mode supervisor

#if os(macOS)
    @Test("Attach-only control supervisor never launches a helper")
    func attachOnlyControlSupervisor() async throws {
        let supervisor = ArborSyncProcessSupervisor(launchPolicy: .attachOnly)
        await #expect(throws: ArborSyncSupervisorError.self) {
            _ = try await supervisor.start(preferredPort: 0)
        }
    }

    @Test("Control-mode supervisor launches, attaches without a session, restarts, and stops")
    func controlModeLifecycle() async throws {
        guard let executablePath = ProcessInfo.processInfo.environment["ARBOR_SYNC_EXECUTABLE"] else { return }
        let dataHome = FileManager.default.temporaryDirectory
            .appending(path: "ArborControlContract-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dataHome, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dataHome) }
        // The helper inherits the environment; an isolated data home keeps the test
        // off the user's ~/.arbor.
        setenv("ARBOR_DATA_HOME", dataHome.path, 1)
        setenv("ARBOR_CREDENTIAL_STORE", "file", 1)
        defer {
            unsetenv("ARBOR_DATA_HOME")
            unsetenv("ARBOR_CREDENTIAL_STORE")
        }

        let supervisor = ArborSyncProcessSupervisor()
        let executable = URL(fileURLWithPath: executablePath)
        let first = try await supervisor.start(executable: executable, preferredPort: 45190)
        #expect(first.attachedToExistingProcess == false)
        #expect(first.status.service == "arborsync")
        #expect(first.status.protocolVersion == "v1")
        #expect(try await first.client.trees().snapshot.isEmpty)

        // A second supervisor attaches to the running control daemon without posting a session.
        let attacher = ArborSyncProcessSupervisor(launchPolicy: .attachOnly)
        let attached = try await attacher.start(preferredPort: 45190)
        #expect(attached.attachedToExistingProcess)
        #expect(attached.origin == first.origin)
        #expect(attached.status.instanceID == first.status.instanceID)
        await attacher.stop()

        let restarted = try await supervisor.restartControl()
        #expect(restarted.attachedToExistingProcess == false)
        #expect(restarted.status.instanceID != first.status.instanceID)
        await supervisor.stop()
        _ = try? await Task.sleep(for: .milliseconds(200))
        let gone = try? await ArborSyncRESTClient(baseURL: first.origin).status()
        #expect(gone == nil)
    }
#endif
}

// MARK: - URLProtocol stub

private struct LoopbackRequest: Sendable {
    var path: String?
    var query: String?
    var accept: String?
}

private actor LoopbackStubState {
    typealias Handler = @Sendable (URLRequest, Int) -> (Int, Data, String)

    private var handler: Handler?
    private var count = 0
    private var captured: [LoopbackRequest] = []

    func install(_ handler: @escaping Handler) {
        self.handler = handler
        count = 0
        captured = []
    }

    func response(for request: URLRequest) -> (Int, Data, String) {
        count += 1
        captured.append(LoopbackRequest(
            path: request.url?.path,
            query: request.url?.query?.removingPercentEncoding,
            accept: request.value(forHTTPHeaderField: "Accept")
        ))
        return handler?(request, count) ?? (500, Data(), "application/json")
    }

    func requests() -> [LoopbackRequest] { captured }
}

private final class LoopbackStub: URLProtocol, @unchecked Sendable {
    static let state = LoopbackStubState()

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Task {
            let (status, data, contentType) = await Self.state.response(for: request)
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: status,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": contentType]
            )!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        }
    }

    override func stopLoading() {}
}
