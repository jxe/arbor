#if os(macOS)
import StoryKit
import OverstoryObjectStore
import Overstory
import OverstoryClient
import Foundation
import Testing
@testable import StoryApp

/// The routes a same-installation working-tree client uses: bootstrap, credential, objects,
/// and the control-mode supervisor that reaches them.
@Suite("Loopback services", .serialized)
struct LoopbackServicesTests {
    private var fixtures: URL {
        if let path = ProcessInfo.processInfo.environment["STORY_REFERENCE_FIXTURES"] {
            return URL(fileURLWithPath: path, isDirectory: true).appending(path: "story-sync")
        }
        return URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .appending(path: "../../tests/fixtures/story-sync")
            .standardizedFileURL
    }

    private func fixture(_ name: String) throws -> Data {
        try Data(contentsOf: fixtures.appending(path: name))
    }

    private func stubbedClient() -> StorySyncRESTClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [LoopbackStub.self]
        return StorySyncRESTClient(
            baseURL: URL(string: "http://127.0.0.1:4317")!,
            session: URLSession(configuration: configuration)
        )
    }

    @Test("Onboarding retains identity and pending claim when no account is connected")
    func onboardingState() async throws {
        let body = Data(#"{"accounts":[],"identity":{"profileTree":"tr_person","publicKey":"public","profilePath":"/profile","keyAvailable":false},"pendingClaim":{"account":"https://community.test/~alice","path":"/profile","canCancel":true},"pendingPairing":{"origin":"https://community.test"}}"#.utf8)
        await LoopbackStub.state.install { _, _ in (200, body, "application/json") }
        let state = try await stubbedClient().onboardingState()
        #expect(state.accounts.isEmpty)
        #expect(state.identity?.keyAvailable == false)
        #expect(state.pendingClaim?.account == "https://community.test/~alice")
        #expect(state.pendingClaim?.canCancel == true)
        #expect(state.pendingPairing?.origin == "https://community.test")
    }

    @Test("Onboarding cancellation and pairing resume use explicit loopback routes")
    func connectionRecoveryRoutes() async throws {
        await LoopbackStub.state.install { _, _ in (200, Data("{}".utf8), "application/json") }
        let client = stubbedClient()
        try await client.cancelPendingClaim()
        try await client.claimPairing()
        let requests = await LoopbackStub.state.requests()
        #expect(requests.map { $0.path } == ["/v1/bootstrap/accounts/cancel", "/v1/bootstrap/pairings/claim"])

    }

    @Test("Identity recovery preserves the daemon's actionable error")
    func recoveryError() async throws {
        let body = Data(#"{"error":"conflict","message":"Existing identity differs","retryable":false}"#.utf8)
        await LoopbackStub.state.install { _, _ in (409, body, "application/json") }
        do {
            try await stubbedClient().restoreIdentity(backup: Data("{}".utf8), path: "/profile", passphrase: nil)
            Issue.record("Expected identity conflict")
        } catch let error as StorySyncServerError {
            #expect(error.value.message == "Existing identity differs")
        }
    }

    // MARK: Bootstrap

    @Test("A clean bootstrap decodes its sparse spine and lists the lazy file")
    func cleanBootstrapDecodes() async throws {
        // The route answers canonical CBOR with the spine as a byte string.
        let body = try fixture("bootstrap.cbor")
        await LoopbackStub.state.install { _, _ in (200, body, "application/cbor") }
        let bootstrap = try await stubbedClient().bootstrap(tree: "tr_notes7f3q2ab7c")

        #expect(bootstrap.tree.id == "tr_notes7f3q2ab7c")
        #expect(bootstrap.tree.osPath == "/Users/joe/notes")
        #expect(bootstrap.accepted.cursor == nil)
        #expect(bootstrap.spine.root == bootstrap.accepted.root)
        #expect(bootstrap.observedThrough == "1f8b3c6d-observed:7")

        // The spine is sparse: the root directory and the Markdown object are present,
        // the binary is referenced by hash only.
        let objects = try ProtocolObjectGraph.validate(bootstrap.spine, mode: .sparseFiles)
        #expect(objects.count == 2)
        guard case let .directory(entries, _)? = objects[bootstrap.spine.root] else {
            Issue.record("root is not a directory"); return
        }
        let names = entries.map(\.name)
        #expect(names == ["_index.md", "photo.bin"])
        let photo = try #require(entries.first { $0.name == "photo.bin" }?.hash)
        #expect(objects[photo] == nil)
        #expect(throws: ProtocolValidationError.self) {
            try ProtocolObjectGraph.validate(bootstrap.spine, mode: .complete)
        }
        let requests = await LoopbackStub.state.requests()
        #expect(requests.map(\.path) == ["/v1/bootstrap"])
        #expect(requests.first?.query == "tree=tr_notes7f3q2ab7c")
        #expect(requests.first?.accept == "application/cbor")
    }

    @Test("A newer client ignores daemon-local state from an older bootstrap response")
    func legacyPendingBootstrapDecodesAcceptedState() async throws {
        let body = try fixture("bootstrap-pending.cbor")
        await LoopbackStub.state.install { _, _ in (200, body, "application/cbor") }
        let bootstrap = try await stubbedClient().bootstrap(tree: "tr_notes7f3q2ab7c")

        #expect(bootstrap.spine.root == bootstrap.accepted.root)
    }

    @Test("A sparse bootstrap classifies omitted files using directory entries")
    func omittedFileAccepted() async throws {
        let body = try fixture("bootstrap.cbor")
        await LoopbackStub.state.install { _, _ in (200, body, "application/cbor") }
        _ = try await stubbedClient().bootstrap(tree: "tr_notes7f3q2ab7c")
    }

    @Test("The retired JSON form is refused and bootstrap errors remain typed")
    func jsonFormIsRefusedAndErrorsRemainTyped() async throws {
        // A daemon from before CBOR answered JSON with a base64 spine; the client no longer reads it.
        let json = try fixture("bootstrap.json")
        await LoopbackStub.state.install { _, _ in (200, json, "application/json") }
        await #expect(throws: (any Error).self) { _ = try await stubbedClient().bootstrap(tree: "tr_notes7f3q2ab7c") }

        let unsynchronized = Data(#"{"error":"conflict","message":"unsynchronized","retryable":false,"details":{"kind":"unsynchronized"}}"#.utf8)
        await LoopbackStub.state.install { _, _ in (409, unsynchronized, "application/json") }
        do {
            _ = try await stubbedClient().bootstrap(tree: "tr_notes7f3q2ab7c")
            Issue.record("expected a 409")
        } catch let error as StorySyncServerError {
            #expect(error.status == 409)
            #expect(error.value.code == "conflict")
        }
    }

    // MARK: Credential

    @Test("The credential fixture decodes and the route scopes by configuration tree")
    func credentialDecodes() async throws {
        let body = try fixture("credential.json")
        #expect(try JSONDecoder().decode(TreeCredential.self, from: body).token == "host-account-token-fixture")
        await LoopbackStub.state.install { _, _ in (200, body, "application/json") }
        let client = stubbedClient()
        #expect(try await client.credential() == "host-account-token-fixture")
        #expect(try await client.credential(configurationTree: "tr_cfg7f3q2ab7cdefg") == "host-account-token-fixture")
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
        let provider = StorySyncCredentialProvider(client: stubbedClient(), configurationTree: "tr_cfg")

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

        // As a ProtocolCredentialProvider it feeds the protocol client's bearer header.
        let wire: any ProtocolCredentialProvider = provider
        #expect(try await wire.credential() == "token-2")
    }

    @Test("A placement host's credential names its origin, and its provider is not the home's")
    func placementCredentialCarriesOrigin() async throws {
        await LoopbackStub.state.install { request, _ in
            let placement = request.url?.query?.contains("origin=") == true
            return (200, Data(#"{"token":"\#(placement ? "orchard" : "garden")-token"}"#.utf8), "application/json")
        }
        let client = stubbedClient()
        #expect(try await client.credential(configurationTree: "tr_cfg", origin: "https://orchard.example") == "orchard-token")
        var requests = await LoopbackStub.state.requests()
        #expect(requests.map(\.path) == ["/v1/credential"])
        #expect(requests[0].query == "configurationTree=tr_cfg&origin=https://orchard.example")
        // An origin names the account whose device key opens the session there.
        await #expect(throws: ProtocolValidationError.self) {
            _ = try await client.credential(origin: "https://orchard.example")
        }

        // Shared providers are per account and host: B's never hands out the home session.
        let home = StorySyncCredentialProvider.shared(client: client, configurationTree: "tr_cfg")
        let orchard = StorySyncCredentialProvider.shared(client: client, configurationTree: "tr_cfg", origin: "https://orchard.example")
        #expect(home !== orchard)
        #expect(StorySyncCredentialProvider.shared(client: client, configurationTree: "tr_cfg", origin: "https://orchard.example") === orchard)
        #expect(orchard.origin == "https://orchard.example")
        #expect(try await orchard.credential() == "orchard-token")
        #expect(try await home.credential() == "garden-token")
        // After a 401 from B the provider asks the daemon again, still for B.
        await orchard.invalidate()
        #expect(try await orchard.credential() == "orchard-token")
        requests = await LoopbackStub.state.requests()
        #expect(requests.map(\.query) == [
            "configurationTree=tr_cfg&origin=https://orchard.example",
            "configurationTree=tr_cfg&origin=https://orchard.example",
            "configurationTree=tr_cfg",
            "configurationTree=tr_cfg&origin=https://orchard.example",
        ])
    }

    @Test("Adding a host posts to the placement route and decodes the connection it recorded")
    func connectPlacementRoute() async throws {
        let body = Data(#"{"placement":{"configurationTree":"tr_cfg","origin":"https://orchard.example","account":"https://orchard.example/~joe","accountID":"ac_joe","handle":"joe","profileTree":"tr_profile","homeHost":"https://garden.example","placementRoot":"tr_root","placed":true}}"#.utf8)
        await LoopbackStub.state.install { _, _ in (200, body, "application/json") }
        let claim = try await stubbedClient().connectPlacement(host: "https://orchard.example")
        #expect(claim.placement.origin == "https://orchard.example")
        #expect(claim.placement.placementRoot == "tr_root")
        #expect(claim.placement.isWellFormed)
        #expect(await LoopbackStub.state.requests().map(\.path) == ["/v1/bootstrap/placements"])

        // A placement host's refusal keeps its code and names the home host.
        let refused = Data(#"{"error":"internal-error","message":"The home host cannot be read","retryable":true,"details":{"homeHost":"https://garden.example"}}"#.utf8)
        await LoopbackStub.state.install { _, _ in (503, refused, "application/json") }
        do {
            _ = try await stubbedClient().connectPlacement(host: "https://orchard.example")
            Issue.record("expected a 503")
        } catch let error as StorySyncServerError {
            #expect(error.status == 503)
            #expect(error.value.details == .object(["homeHost": .string("https://garden.example")]))
        }

        // A daemon from before the route answers 405.
        await LoopbackStub.state.install { _, _ in
            (405, Data(#"{"error":"unsupported-operation","message":"Method not allowed","retryable":false}"#.utf8), "application/json")
        }
        await #expect(throws: StorySyncPlacementUnavailable(host: "https://orchard.example")) {
            _ = try await stubbedClient().connectPlacement(host: "https://orchard.example")
        }
    }

    @Test("A missing credential propagates the daemon's 404 and caches nothing")
    func credentialProviderMissing() async throws {
        await LoopbackStub.state.install { _, _ in
            (404, Data(#"{"error":"not-found","message":"No account credential is available","retryable":false}"#.utf8), "application/json")
        }
        let provider = StorySyncCredentialProvider(client: stubbedClient())
        do {
            _ = try await provider.credential()
            Issue.record("expected not-found")
        } catch let error as StorySyncServerError {
            #expect(error.status == 404)
        }
        #expect(await provider.isCached == false)
    }

    // MARK: Objects

    @Test("The object route returns verified bytes and asks for CBOR")
    func objectRouteVerifies() async throws {
        let bytes = try ProtocolObjectCodec.encode(.file(Data("# Notes\n".utf8)))
        let hash = ProtocolObjectCodec.hash(bytes)
        await LoopbackStub.state.install { _, _ in (200, bytes, "application/cbor") }
        let client = stubbedClient()
        let served = try await client.object(tree: "tr_notes", hash: hash, origin: URL(string: "https://notes.example")!)
        #expect(served == bytes)
        let request = try #require(await LoopbackStub.state.requests().first)
        #expect(request.path == "/v1/objects/\(hash)")
        #expect(request.query == "tree=tr_notes&origin=https://notes.example")
        #expect(request.accept == "application/cbor")

        await #expect(throws: ProtocolValidationError.self) {
            _ = try await client.object(tree: "tr_notes", hash: "sha256:not-a-hash")
        }
    }

    @Test("DaemonObjectStore rejects a hash mismatch and maps 404 to missing")
    func daemonObjectStoreVerifies() async throws {
        let bytes = try ProtocolObjectCodec.encode(.file(Data("# Notes\n".utf8)))
        let hash = ProtocolObjectCodec.hash(bytes)
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
    }

    // MARK: Control-mode supervisor

#if os(macOS)
    @Test("Attach-only control supervisor never launches a helper")
    func attachOnlyControlSupervisor() async throws {
        let supervisor = StorySyncProcessSupervisor(launchPolicy: .attachOnly)
        await #expect(throws: StorySyncSupervisorError.self) {
            _ = try await supervisor.start(preferredPort: 0)
        }
    }

    @Test("Control-mode supervisor launches, attaches without a session, restarts, and stops")
    func controlModeLifecycle() async throws {
        guard let executablePath = ProcessInfo.processInfo.environment["STORY_SYNC_EXECUTABLE"] else { return }
        let dataHome = FileManager.default.temporaryDirectory
            .appending(path: "StoryControlContract-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dataHome, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dataHome) }
        // The helper inherits the environment; an isolated data home keeps the test
        // off the user's ~/.story.
        setenv("STORY_HOME", dataHome.path, 1)
        setenv("STORY_CREDENTIAL_STORE", "file", 1)
        defer {
            unsetenv("STORY_HOME")
            unsetenv("STORY_CREDENTIAL_STORE")
        }

        let supervisor = StorySyncProcessSupervisor()
        let executable = URL(fileURLWithPath: executablePath)
        let first = try await supervisor.start(executable: executable, preferredPort: 45190)
        #expect(first.attachedToExistingProcess == false)
        #expect(first.status.service == "story-sync")
        #expect(first.status.protocolVersion == "v1")
        #expect(try await first.client.trees().snapshot.isEmpty)

        // A second supervisor attaches to the running control daemon without posting a session.
        let attacher = StorySyncProcessSupervisor(launchPolicy: .attachOnly)
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
        let gone = try? await StorySyncRESTClient(baseURL: first.origin).status()
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
#endif
