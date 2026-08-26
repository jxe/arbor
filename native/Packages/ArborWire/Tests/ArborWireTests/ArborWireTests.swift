import CryptoKit
import Foundation
import Testing
@testable import ArborWire

private var fixtures: URL {
    if let path = ProcessInfo.processInfo.environment["ARBOR_PROTOCOL_FIXTURES"] {
        return URL(fileURLWithPath: path, isDirectory: true)
    }
    return URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()
        .appending(path: "../../../../../conformance")
        .standardizedFileURL
}

@Suite("Canonical wire objects")
struct WireObjectTests {
    @Test("Swift reproduces every shared object byte and hash")
    func sharedVectors() throws {
        let data = try Data(contentsOf: fixtures.appending(path: "wire-objects.json"))
        let fixture = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let vectors = try #require(fixture["objects"] as? [[String: Any]])
        for vector in vectors {
            let model = try #require(vector["model"] as? [String: Any])
            let object: WireObject
            if model["type"] as? String == "file" {
                let base64 = try #require(model["bytesBase64"] as? String)
                object = .file(try #require(Data(base64Encoded: base64)))
            } else {
                let entries = try #require(model["entries"] as? [[String: Any]])
                object = .directory(entries.map {
                    WireDirectoryEntry(name: $0["name"] as! String, hash: $0["hash"] as? String, tree: $0["tree"] as? String)
                })
            }
            let bytes = try WireObjectCodec.encode(object)
            #expect(bytes.base64EncodedString() == vector["canonicalCborBase64"] as? String)
            #expect(WireObjectCodec.hash(bytes) == vector["hash"] as? String)
            #expect(try WireObjectCodec.decode(bytes) == object)
        }
    }

    @Test("Swift rejects every shared invalid object")
    func invalidVectors() throws {
        let data = try Data(contentsOf: fixtures.appending(path: "wire-objects.json"))
        let fixture = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let vectors = try #require(fixture["invalid"] as? [[String: Any]])
        #expect(vectors.count == 4)
        for vector in vectors {
            let base64 = try #require(vector["canonicalCborBase64"] as? String)
            let bytes = try #require(Data(base64Encoded: base64))
            #expect(throws: (any Error).self) { _ = try WireObjectCodec.decode(bytes) }
        }
    }

    @Test("Complete graph validation rejects missing and unreachable objects")
    func graphValidation() throws {
        let file = try WireObjectCodec.object(.file(Data("hello".utf8)))
        let root = try WireObjectCodec.object(.directory([.init(name: "note.md", hash: file.hash)]))
        let valid = WireSnapshot(root: root.hash, objects: [root, file])
        #expect(try WireObjectGraph.validate(valid).count == 2)
        #expect(throws: ArborWireValidationError.self) {
            _ = try WireObjectGraph.validate(.init(root: root.hash, objects: [root]))
        }
        let extra = try WireObjectCodec.object(.file(Data("extra".utf8)))
        #expect(throws: ArborWireValidationError.self) {
            _ = try WireObjectGraph.validate(.init(root: root.hash, objects: [root, file, extra]))
        }
    }
}

@Suite("Update and observation protocol")
struct UpdateProtocolTests {
    @Test("Canonical semantic intent matches the shared RFC 8785 fixture")
    func requestIdentity() throws {
        let data = try Data(contentsOf: fixtures.appending(path: "wire-update-intent.json"))
        let fixture = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let identity = try #require(fixture["identity"] as? [String: Any])
        let base = try #require(identity["base"] as? [String: Any])
        let value = WireUpdateBase(root: base["root"] as! String, update: base["update"] as! String)
        let candidate = identity["candidate"] as! String
        let tree = identity["tree"] as! String
        #expect(canonicalUpdateIntent(tree: tree, base: value, candidate: candidate) == identity["canonicalJSON"] as? String)
        #expect(updateRequestDigest(tree: tree, base: value, candidate: candidate) == identity["digest"] as? String)
    }

    @Test("Swift consumes the shared file-patch and conditional-snapshot fixtures")
    func filePatchFixtures() throws {
        let data = try Data(contentsOf: fixtures.appending(path: "wire-file-patches.json"))
        let fixture = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let valid = try #require(fixture["valid"] as? [String: Any])
        let validData = try JSONSerialization.data(withJSONObject: valid)
        let patch = try JSONDecoder().decode(WireFilePatch.self, from: validData)
        #expect(patch.edits.map(\.offset) == [1, 4])
        #expect(patch.edits.map(\.bytes) == [Data("x".utf8), Data("y".utf8)])

        let base = WireUpdateBase(root: "sha256:" + String(repeating: "0", count: 64), update: "up_base")
        let request = WireUpdateRequest(
            base: base,
            candidate: "sha256:" + String(repeating: "1", count: 64),
            objects: [],
            filePatches: [patch],
            returnSnapshot: .ifResultDiffers
        )
        let encoded = try JSONEncoder().encode(request)
        let json = try #require(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        #expect(json["returnSnapshot"] as? String == "if-result-differs")
        #expect((json["filePatches"] as? [[String: Any]])?.count == 1)

        let invalid = try #require(fixture["invalid"] as? [[String: Any]])
        for vector in invalid {
            let patches = try #require(vector["patches"] as? [[String: Any]])
            let body: [String: Any] = [
                "base": ["root": base.root, "update": base.update],
                "candidate": "sha256:" + String(repeating: "1", count: 64),
                "objects": [],
                "filePatches": patches,
            ]
            let bodyData = try JSONSerialization.data(withJSONObject: body)
            #expect(throws: (any Error).self) {
                _ = try JSONDecoder().decode(WireUpdateRequest.self, from: bodyData)
            }
        }
    }

    @Test("Endpoint result fixture decodes with required accepted-update fields")
    func endpointResult() throws {
        let data = try Data(contentsOf: fixtures.appending(path: "wire-endpoints.json"))
        let fixture = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let cases = try #require(fixture["cases"] as? [[String: Any]])
        let submit = try #require(cases.first { $0["name"] as? String == "submit-current-update" })
        let response = try #require(submit["response"] as? [String: Any])
        let body = try JSONSerialization.data(withJSONObject: try #require(response["body"] as? [String: Any]))
        let result = try JSONDecoder().decode(WireUpdateResult.self, from: body)
        guard case let .current(update) = result else { Issue.record("Expected current result"); return }
        #expect(update.id == "up_atlas1")
    }

    @Test("Byte-level parser handles fragmented LF and CRLF frames")
    func sseFraming() throws {
        var parser = ArborSSEParser()
        let chunks = [
            "id: up_1\r", "\nevent: ref\r\ndata: {\"a\":", "1}\r\n\r", "\n",
            "id: up_2\nevent: ref\ndata: first\ndata: second\n\n"
        ]
        var frames: [ArborSSEFrame] = []
        for chunk in chunks { frames.append(contentsOf: try parser.append(Data(chunk.utf8))) }
        #expect(frames == [
            .init(id: "up_1", event: "ref", data: "{\"a\":1}"),
            .init(id: "up_2", event: "ref", data: "first\nsecond")
        ])
        #expect(try parser.finish().isEmpty)
    }

    @Test("Unterminated and invalid UTF-8 frames fail")
    func malformedSSE() throws {
        var unterminated = ArborSSEParser()
        _ = try unterminated.append(Data("data: value".utf8))
        #expect(throws: ArborWireValidationError.self) { _ = try unterminated.finish() }
        var invalid = ArborSSEParser()
        #expect(throws: ArborWireValidationError.self) { _ = try invalid.append(Data([0x64, 0x61, 0x74, 0x61, 0x3a, 0x20, 0xff, 0x0a, 0x0a])) }
    }

    @Test("Ambiguous transport retries the exact prepared request without a caller key")
    func exactRetry() async throws {
        let file = try WireObjectCodec.object(.file(Data("retry".utf8)))
        let root = try WireObjectCodec.object(.directory([.init(name: "note.md", hash: file.hash)]))
        let snapshot = WireSnapshot(root: root.hash, objects: [file, root])
        let baseHash = "sha256:" + String(repeating: "0", count: 64)
        let requestDigest = updateRequestDigest(
            tree: "tr_retry",
            base: WireUpdateBase(root: baseHash, update: "up_base"),
            candidate: root.hash
        )
        let response = Data("""
        {"outcome":"accepted","requestDigest":"\(requestDigest)","update":{"id":"up_retry","tree":"tr_retry","root":"\(root.hash)","previousRoot":"\(baseHash)","kind":"accepted","acceptedAt":1787529600000,"subject":"dv_retry"},"observedThrough":"up_retry"}
        """.utf8)
        await WireURLProtocolStub.state.install { _, attempt in
            attempt == 1
                ? (500, Data(#"{"error":"server-busy","message":"retry","retryable":true}"#.utf8))
                : (201, response)
        }
        let client = ArborWireClient(
            origin: URL(string: "https://canopy.test")!,
            credential: "device-token",
            session: wireStubSession(),
            retryDelay: { _ in }
        )
        let prepared = try await client.prepareUpdate(
            tree: "tr_retry",
            base: .init(root: baseHash, update: "up_base"),
            snapshot: snapshot
        )
        _ = try await client.submitUpdate(prepared)
        let captured = await WireURLProtocolStub.state.snapshot()
        #expect(captured.count == 2)
        #expect(captured.bodies[0] == captured.bodies[1])
        #expect(captured.idempotencyKeys == [nil, nil])
    }
}

@Suite("Live temporary server", .serialized)
struct LiveWireTests {
    @Test("Account snapshots, scoped objects, and locally credentialed pairing")
    func liveWire() async throws {
        guard let originValue = ProcessInfo.processInfo.environment["ARBOR_WIRE_TEST_URL"],
              let origin = URL(string: originValue),
              let token = ProcessInfo.processInfo.environment["ARBOR_WIRE_TEST_TOKEN"] else {
            return
        }
        let client = ArborWireClient(origin: origin, credential: token, retryDelay: { _ in })
        let account = try await client.account()
        let configuration = account.account.configuration
        #expect(configuration.kind == "account-configuration")
        #expect(configuration.canonical == nil)
        let ref = try await client.ref(tree: configuration.id)
        #expect(ref.snapshot.ref == configuration.ref)
        #expect(!ref.observedThrough.isEmpty)
        let current = try await client.currentSnapshot(tree: configuration.id)
        #expect(current.tree.id == configuration.id)
        #expect(current.snapshot.root == configuration.ref)
        #expect(try await client.snapshot(tree: configuration.id, root: configuration.ref) == current.snapshot.sorted())

        let offer = try await client.createPairing()
        let pairedToken = "swift-paired-device-token"
        let digest = SHA256.hash(data: Data(pairedToken.utf8)).map { String(format: "%02x", $0) }.joined()
        let deviceID = "dv_aaaaaaaaaaaaaaaaaaaaaaaaaa"
        let claim = try await client.claimPairing(
            id: offer.id,
            secret: offer.secret,
            device: WirePairingDevice(
                id: deviceID,
                label: "Swift test device",
                credentialDigest: "sha256:\(digest)"
            )
        )
        #expect(claim.device.id == deviceID)
        let paired = ArborWireClient(origin: origin, credential: pairedToken, retryDelay: { _ in })
        #expect(try await paired.trees().snapshot.contains { $0.id == configuration.id })

        let historyURL = origin.appending(path: ".arbor/trees/\(configuration.id)/updates")
        var request = URLRequest(url: historyURL)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let (_, response) = try await URLSession.shared.data(for: request)
        #expect((response as? HTTPURLResponse)?.statusCode == 405)
        let historicalObject = origin.appending(path: ".arbor/objects/\(configuration.ref)")
        let (_, historicalResponse) = try await URLSession.shared.data(for: URLRequest(url: historicalObject))
        #expect((historicalResponse as? HTTPURLResponse)?.statusCode == 404)
    }

    private func snapshot(fileBytes: Data) throws -> WireSnapshot {
        let file = try WireObjectCodec.object(.file(fileBytes))
        let root = try WireObjectCodec.object(.directory([.init(name: "blob.bin", hash: file.hash)]))
        return WireSnapshot(root: root.hash, objects: [file, root]).sorted()
    }
}

private extension WireSnapshot {
    func sorted() -> WireSnapshot {
        WireSnapshot(root: root, objects: objects.sorted { $0.hash < $1.hash })
    }
}

private func wireStubSession() -> URLSession {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [WireURLProtocolStub.self]
    return URLSession(configuration: configuration)
}

private actor WireURLProtocolStubState {
    typealias Handler = @Sendable (URLRequest, Int) -> (Int, Data)

    private var handler: Handler?
    private var count = 0
    private var bodies: [Data] = []
    private var idempotencyKeys: [String?] = []

    func install(_ handler: @escaping Handler) {
        self.handler = handler
        count = 0
        bodies = []
        idempotencyKeys = []
    }

    func response(for request: URLRequest) -> (Int, Data) {
        count += 1
        bodies.append(request.httpBody ?? Data())
        idempotencyKeys.append(request.value(forHTTPHeaderField: "Idempotency-Key"))
        return handler?(request, count) ?? (500, Data())
    }

    func snapshot() -> (count: Int, bodies: [Data], idempotencyKeys: [String?]) {
        (count, bodies, idempotencyKeys)
    }
}

private final class WireURLProtocolStub: URLProtocol, @unchecked Sendable {
    static let state = WireURLProtocolStubState()

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
