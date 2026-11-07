#if os(macOS)
import StoryKit
import OverstoryObjectStore
import Overstory
import OverstoryClient
import Foundation
import Testing
@testable import StoryApp

/// The routes a same-installation working-tree client uses: the standard reads, credential,
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

    // MARK: Standard reads (Clients 003)

    /// A placed tree as Story Sync serves it: its listing, the current-tree
    /// read, and objects, all through the standard routes.
    private func installPlacedTree(root: ProtocolObjectEnvelope, objects: [ProtocolObjectEnvelope], current: Int = 200) async {
        let listing = Data(#"{"snapshot":[{"id":"tr_notes7f3q2ab7c","configurationTree":"tr_cfg","kind":"ordinary","access":"write","canonical":{"path":"/~joe/notes","endpoint":"https://notes.example","parentTree":null},"name":"notes","osPath":"/Users/joe/notes","placement":"placed"}],"observedThrough":"c:1"}"#.utf8)
        let descriptor = Data("""
        {"tree":{"id":"tr_notes7f3q2ab7c","kind":"ordinary","access":"write","root":"\(root.hash)","update":"up_1","conflicted":false,"canonical":{"path":"/~joe/notes","endpoint":"https://notes.example","parentTree":null}},"observedThrough":"host-cursor-7"}
        """.utf8)
        let unsynchronized = Data(#"{"error":"conflict","message":"unsynchronized","retryable":false,"details":{"kind":"unsynchronized"}}"#.utf8)
        let byHash = Dictionary(uniqueKeysWithValues: objects.map { ($0.hash, $0.bytes) })
        await LoopbackStub.state.install { request, _ in
            let path = request.url?.path ?? ""
            if path == "/v1/trees" { return (200, listing, "application/json") }
            if path == "/.overstory/trees/tr_notes7f3q2ab7c" {
                return current == 200 ? (200, descriptor, "application/json") : (current, unsynchronized, "application/json")
            }
            if let hash = path.split(separator: "/").last.map(String.init), let bytes = byHash[hash] {
                return (200, bytes, "application/octet-stream")
            }
            return (404, Data(#"{"error":"not-found","message":"missing","retryable":false}"#.utf8), "application/json")
        }
    }

    @Test("Opening a placed tree reads its base and spine through the standard routes")
    func placedTreeOpeningUsesStandardReads() async throws {
        let index = try ProtocolObjectCodec.object(.file(Data("# Notes\n".utf8)))
        let photo = try ProtocolObjectCodec.object(.file(Data([1, 2, 3])))
        let root = try ProtocolObjectCodec.object(.directory([
            .init(name: "_index.md", file: index.hash),
            .init(name: "photo.bin", file: photo.hash),
        ]))
        await installPlacedTree(root: root, objects: [root, index, photo])
        let opening = try await StoryWorkspaceState.readPlacedTree("tr_notes7f3q2ab7c", client: stubbedClient())

        #expect(opening.placed.osPath == "/Users/joe/notes")
        #expect(opening.current.tree.root == root.hash)
        #expect(opening.current.observedThrough == "host-cursor-7")
        // The spine holds the directory and the Markdown, not the photo.
        #expect(Set(opening.spine.objects.map(\.hash)) == [root.hash, index.hash])
        let paths = await LoopbackStub.state.requests().map(\.path)
        #expect(paths.contains("/.overstory/trees/tr_notes7f3q2ab7c"))
        #expect(paths.contains("/.overstory/trees/tr_notes7f3q2ab7c/objects/\(root.hash)"))
        #expect(!paths.contains("/.overstory/trees/tr_notes7f3q2ab7c/objects/\(photo.hash)"))
        #expect(!paths.contains("/v1/bootstrap"))
    }

    @Test("A placed tree without an accepted base yet keeps the daemon's typed 409")
    func unsynchronizedPlacedTree() async throws {
        let root = try ProtocolObjectCodec.object(.directory([]))
        await installPlacedTree(root: root, objects: [root], current: 409)
        do {
            _ = try await StoryWorkspaceState.readPlacedTree("tr_notes7f3q2ab7c", client: stubbedClient())
            Issue.record("expected a 409")
        } catch let error as ProtocolHTTPError {
            #expect(error.status == 409)
        }
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

    // MARK: Objects

    @Test("Placed-tree objects come verified from the standard route; 404 is missing")
    func placedTreeObjectsVerify() async throws {
        let bytes = try ProtocolObjectCodec.encode(.file(Data("# Notes\n".utf8)))
        let hash = ProtocolObjectCodec.hash(bytes)
        let other = "sha256:" + String(repeating: "ab", count: 32)
        await LoopbackStub.state.install { request, _ in
            if request.url?.path.hasSuffix(other) == true { return (200, bytes, "application/octet-stream") }
            if request.url?.path.hasSuffix(hash) == true { return (200, bytes, "application/octet-stream") }
            return (404, Data(#"{"error":"not-found","message":"missing","retryable":false}"#.utf8), "application/json")
        }
        let store = StoryWorkspaceState.placedTreeObjects("tr_notes", reads: stubbedClient().reads())

        #expect(try await store.bytes(hash) == bytes)
        let request = try #require(await LoopbackStub.state.requests().first)
        #expect(request.path == "/.overstory/trees/tr_notes/objects/\(hash)")
        await #expect(throws: (any Error).self) { _ = try await store.bytes(other) }
        let absent = "sha256:" + String(repeating: "cd", count: 32)
        await #expect(throws: ObjectStoreError.missing(absent)) {
            _ = try await store.bytes(absent)
        }
    }

    // MARK: Control-mode supervisor

#if os(macOS)
    @Test("A helper from another app build is stale; one without a build stamp is left alone")
    func staleHelperStamp() {
        #expect(StorySyncProcessSupervisor.isStaleHelper(running: "0.1.0+3", bundled: "0.1.0+4"))
        #expect(!StorySyncProcessSupervisor.isStaleHelper(running: "0.1.0+4", bundled: "0.1.0+4"))
        #expect(!StorySyncProcessSupervisor.isStaleHelper(running: "0.1.0", bundled: "0.1.0+4"))
        #expect(!StorySyncProcessSupervisor.isStaleHelper(running: "0.1.0+3", bundled: nil))
    }

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
