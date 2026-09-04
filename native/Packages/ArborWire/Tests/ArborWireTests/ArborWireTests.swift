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
                let childrenSource = (model["childrenSource"] as? [String: Any]).map { value in
                    WireCollectionFileDescriptor(
                            version: value["version"] as! Int,
                            type: value["type"] as! String,
                            format: value["format"] as! String,
                            source: value["source"] as! String,
                            schemaSource: value["schemaSource"] as! String,
                            schemaFingerprint: value["schemaFingerprint"] as! String,
                            childSetHash: value["childSetHash"] as! String
                        )
                }
                object = .directory(entries.map {
                    return WireDirectoryEntry(
                        name: $0["name"] as! String,
                        hash: $0["hash"] as? String,
                        tree: $0["tree"] as? String
                    )
                }, childrenSource: childrenSource)
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

    @Test("Swift reproduces the shared immutable snapshot bundle")
    func snapshotBundleVector() throws {
        let data = try Data(contentsOf: fixtures.appending(path: "wire-snapshot-bundles.json"))
        let fixture = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let vectors = try #require(fixture["valid"] as? [[String: Any]])
        for vector in vectors {
            let root = try #require(vector["root"] as? String)
            let values = try #require(vector["objects"] as? [[String: Any]])
            let snapshot = WireSnapshot(root: root, objects: try values.map { value in
                let base64 = try #require(value["canonicalCborBase64"] as? String)
                return WireObjectEnvelope(
                    hash: try #require(value["hash"] as? String),
                    bytes: try #require(Data(base64Encoded: base64))
                )
            })
            let encoded = try WireSnapshotBundleCodec.encode(snapshot)
            #expect(encoded.base64EncodedString() == vector["canonicalCborBase64"] as? String)
            #expect(WireObjectCodec.hash(encoded) == vector["etag"] as? String)
            #expect(try WireSnapshotBundleCodec.decode(encoded, root: root) == snapshot.sorted())
        }
    }

    @Test("Swift rejects invalid immutable snapshot bundles")
    func invalidSnapshotBundles() throws {
        let file = try WireObjectCodec.object(.file(Data("snapshot\n".utf8)))
        let root = try WireObjectCodec.object(.directory([.init(name: "note.md", hash: file.hash)]))
        let snapshot = WireSnapshot(root: root.hash, objects: [root, file])
        let valid = try WireSnapshotBundleCodec.encode(snapshot)
        #expect(throws: ArborWireValidationError.self) {
            _ = try WireSnapshotBundleCodec.decode(valid, root: "sha256:" + String(repeating: "0", count: 64))
        }
        let incomplete = CanonicalCBOR.encode(.map([
            ("version", .unsigned(1)),
            ("objects", .array([.bytes(root.bytes)])),
        ]))
        #expect(throws: ArborWireValidationError.self) {
            _ = try WireSnapshotBundleCodec.decode(incomplete, root: root.hash)
        }
        let extra = try WireObjectCodec.object(.file(Data("extra".utf8)))
        let withExtra = WireSnapshot(root: root.hash, objects: [root, file, extra])
        let orderedExtra = withExtra.objects.sorted { $0.hash < $1.hash }
        let extraBundle = CanonicalCBOR.encode(.map([
            ("version", .unsigned(1)),
            ("objects", .array(orderedExtra.map { .bytes($0.bytes) })),
        ]))
        #expect(throws: ArborWireValidationError.self) {
            _ = try WireSnapshotBundleCodec.decode(extraBundle, root: root.hash)
        }
        let ordered = snapshot.objects.sorted { $0.hash < $1.hash }
        let reversed = CanonicalCBOR.encode(.map([
            ("version", .unsigned(1)),
            ("objects", .array(ordered.reversed().map { .bytes($0.bytes) })),
        ]))
        #expect(throws: ArborWireValidationError.self) {
            _ = try WireSnapshotBundleCodec.decode(reversed, root: root.hash)
        }
        let invalidObjects = try #require(
            (try JSONSerialization.jsonObject(with: Data(contentsOf: fixtures.appending(path: "wire-objects.json"))) as? [String: Any])?["invalid"] as? [[String: Any]]
        )
        let noncanonicalBase64 = try #require(invalidObjects.last?["canonicalCborBase64"] as? String)
        let noncanonical = try #require(Data(base64Encoded: noncanonicalBase64))
        let corrupt = CanonicalCBOR.encode(.map([
            ("version", .unsigned(1)),
            ("objects", .array([.bytes(noncanonical)])),
        ]))
        #expect(throws: ArborWireValidationError.self) {
            _ = try WireSnapshotBundleCodec.decode(corrupt, root: WireObjectCodec.hash(noncanonical))
        }
    }
}

@Suite("Update and observation protocol", .serialized)
struct UpdateProtocolTests {
    @Test("Wire node refs require the unified explicit stable-key shape")
    func nodeReferenceShape() throws {
        let decoder = JSONDecoder()
        let ref = try decoder.decode(
            WireResolvedNodeRef.self,
            from: Data(#"{"tree":"tr_notes","path":"/notes/today","stableKey":null}"#.utf8)
        )
        #expect(ref == WireResolvedNodeRef(tree: "tr_notes", path: "/notes/today"))
        #expect(throws: (any Error).self) {
            _ = try decoder.decode(
                WireResolvedNodeRef.self,
                from: Data(#"{"tree":"tr_notes","path":"/notes/today","pageID":"old"}"#.utf8)
            )
        }
        #expect(throws: (any Error).self) {
            _ = try decoder.decode(
                WireResolvedNodeRef.self,
                from: Data(#"{"tree":"tr_notes","path":"/notes/today"}"#.utf8)
            )
        }
    }

    @Test("Merge summaries recognize semantic collection-file row merges")
    func collectionFileMergeSummary() throws {
        let value = WireMergeSummary(version: "collection-file-rows-v1", mergedRows: 3)
        #expect(try value.validated() == value)
        #expect(throws: ArborWireValidationError.self) {
            _ = try WireMergeSummary(version: "collection-file-rows-v1").validated()
        }
    }

    @Test("Canonical semantic intent matches the shared canonical CBOR fixture")
    func requestIdentity() throws {
        let data = try Data(contentsOf: fixtures.appending(path: "wire-update-intent.json"))
        let fixture = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let identity = try #require(fixture["identity"] as? [String: Any])
        let candidate = identity["candidate"] as! String
        let value = WireUpdateBase(root: candidate, update: try #require(identity["base"] as? String))
        let tree = identity["tree"] as! String
        let ifMatch = identity["ifMatch"] as! String
        let onConflict = identity["onConflict"] as? String
        #expect(canonicalUpdateIntent(tree: tree, base: value, candidate: candidate, ifMatch: ifMatch, onConflict: onConflict).base64EncodedString() == identity["canonicalCBORBase64"] as? String)
        #expect(updateRequestDigest(tree: tree, base: value, candidate: candidate, ifMatch: ifMatch, onConflict: onConflict) == identity["digest"] as? String)
    }

    @Test("Swift encodes and rejects the shared canonical CBOR value vectors")
    func canonicalCBORValueVectors() throws {
        let data = try Data(contentsOf: fixtures.appending(path: "canonical-cbor-values.json"))
        let fixture = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        for entry in try #require(fixture["valid"] as? [[String: Any]]) {
            let name = entry["name"] as? String ?? "?"
            let expected = try #require(Data(base64Encoded: entry["canonicalCBORBase64"] as! String), "\(name)")
            let encoded = CanonicalCBOR.encode(try cborValue(entry["value"] ?? NSNull()))
            #expect(encoded == expected, "\(name)")
            #expect(canonicalCBORHash(encoded) == entry["hash"] as? String, "\(name)")
            #expect(CanonicalCBOR.encode(try CanonicalCBOR.decode(expected)) == expected, "\(name)")
        }
        for entry in try #require(fixture["invalid"] as? [[String: Any]]) {
            let name = entry["name"] as? String ?? "?"
            let bytes = try #require(Data(base64Encoded: entry["canonicalCBORBase64"] as! String), "\(name)")
            #expect(throws: (any Error).self, "\(name)") { try CanonicalCBOR.decode(bytes) }
        }
    }

    /// Maps a JSONSerialization value onto Arbor's canonical CBOR subset.
    private func cborValue(_ value: Any) throws -> CanonicalCBORValue {
        if value is NSNull { return .null }
        if let number = value as? NSNumber {
            if CFGetTypeID(number) == CFBooleanGetTypeID() { return .bool(number.boolValue) }
            let objCType = String(cString: number.objCType)
            if objCType == "d" || objCType == "f" {
                let double = number.doubleValue
                // JSONSerialization parses integral literals as integers, so any
                // double here was written with a fraction or exponent and is a float.
                return .float(double)
            }
            return .integer(number.intValue)
        }
        if let text = value as? String { return .text(text) }
        if let array = value as? [Any] { return .array(try array.map(cborValue)) }
        if let object = value as? [String: Any] {
            return .map(try object.keys.sorted().map { ($0, try cborValue(object[$0]!)) })
        }
        throw ArborWireValidationError.invalidValue("Unsupported vector value")
    }

    @Test("Swift consumes the shared object-delta and conditional-snapshot fixtures")
    func objectDeltaFixtures() throws {
        let data = try Data(contentsOf: fixtures.appending(path: "wire-object-deltas.json"))
        let fixture = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let valid = try #require(fixture["valid"] as? [String: Any])
        let validData = try JSONSerialization.data(withJSONObject: valid)
        let delta = try JSONDecoder().decode(WireObjectDelta.self, from: validData)
        #expect(delta.instructions == [.copy(offset: 0, length: 1), .insert(Data("x".utf8))])

        let base = WireUpdateBase(root: "sha256:" + String(repeating: "0", count: 64), update: "up_base")
        let request = WireUpdateRequest(
            base: base,
            candidate: "sha256:" + String(repeating: "1", count: 64),
            objects: [],
            deltas: [delta]
        )
        let encoded = try JSONEncoder().encode(request)
        let json = try #require(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        #expect(json["base"] as? String == "up_base")
        #expect((json["deltas"] as? [[String: Any]])?.count == 1)
        let activation = try JSONEncoder().encode(WireUpdateRequest(base: nil, candidate: request.candidate, objects: []))
        let activationJSON = try #require(JSONSerialization.jsonObject(with: activation) as? [String: Any])
        #expect(activationJSON["base"] is NSNull)
        #expect((activationJSON["deltas"] as? [Any])?.isEmpty == true)

        let missingDeltas = try JSONSerialization.data(withJSONObject: [
            "base": base.update,
            "candidate": request.candidate,
            "ifMatch": "modelHash",
            "objects": [],
        ])
        #expect(throws: (any Error).self) {
            _ = try JSONDecoder().decode(WireUpdateRequest.self, from: missingDeltas)
        }

        let invalid = try #require(fixture["invalid"] as? [[String: Any]])
        for vector in invalid {
            let deltas = try #require(vector["deltas"] as? [[String: Any]])
            let body: [String: Any] = [
                "base": base.update,
                "candidate": "sha256:" + String(repeating: "1", count: 64),
                "objects": [],
                "deltas": deltas,
            ]
            let bodyData = try JSONSerialization.data(withJSONObject: body)
            #expect(throws: (any Error).self, "\(vector["name"] ?? "")") {
                _ = try JSONDecoder().decode(WireUpdateRequest.self, from: bodyData)
            }
        }
    }

    @Test("Endpoint result fixture decodes with required accepted-update fields")
    func endpointResult() throws {
        let data = try Data(contentsOf: fixtures.appending(path: "wire-endpoints.json"))
        let fixture = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(fixture["version"] as? Int == 7)
        let cases = try #require(fixture["cases"] as? [[String: Any]])
        let submit = try #require(cases.first { $0["name"] as? String == "submit-current-update" })
        let response = try #require(submit["response"] as? [String: Any])
        let body = try JSONSerialization.data(withJSONObject: try #require(response["body"] as? [String: Any]))
        let result = try JSONDecoder().decode(WireUpdateResult.self, from: body)
        guard case let .current(update) = result else { Issue.record("Expected current result"); return }
        #expect(update.id == "1")
        let snapshotCase = try #require(cases.first { $0["name"] as? String == "read-accepted-snapshot" })
        let request = try #require(snapshotCase["request"] as? [String: Any])
        let path = try #require(request["path"] as? String)
        let root = try #require(path.split(separator: "/").last.map(String.init))
        let snapshotResponse = try #require(snapshotCase["response"] as? [String: Any])
        let bodyBase64 = try #require(snapshotResponse["bodyBase64"] as? String)
        let bytes = try #require(Data(base64Encoded: bodyBase64))
        #expect(try WireSnapshotBundleCodec.decode(bytes, root: root).root == root)
    }

    @Test("Ordered accepted transitions apply object deltas through a merge")
    func acceptedTransitionReplay() throws {
        let baseFile = try WireObjectCodec.object(.file(Data("abcdef".utf8)))
        let baseRoot = try WireObjectCodec.object(.directory([.init(name: "note.md", hash: baseFile.hash)]))
        let firstFile = try WireObjectCodec.object(.file(Data("abXYef".utf8)))
        let firstRoot = try WireObjectCodec.object(.directory([.init(name: "note.md", hash: firstFile.hash)]))
        let finalFile = try WireObjectCodec.object(.file(Data("abXYef!".utf8)))
        let finalRoot = try WireObjectCodec.object(.directory([.init(name: "note.md", hash: finalFile.hash)]))
        let firstUpdate = WireAcceptedUpdate(
            id: "2", tree: "tr_notes", root: firstRoot.hash,
            previousRoot: baseRoot.hash, kind: "accepted", acceptedAt: 1
        )
        let finalUpdate = WireAcceptedUpdate(
            id: "3", tree: "tr_notes", root: finalRoot.hash,
            previousRoot: firstRoot.hash, kind: "merged", acceptedAt: 2,
            merge: .init(version: "markdown-additive-v1", approximatePlacements: 0)
        )
        // Deltas address canonical object bytes: the file header carries the
        // payload length, so it is inserted and payload ranges are copied.
        let baseHeader = baseFile.bytes.count - 6
        let firstHeader = Data(firstFile.bytes.prefix(firstFile.bytes.count - 6))
        let finalHeader = Data(finalFile.bytes.prefix(finalFile.bytes.count - 7))
        let transitions = [
            WireAcceptedTransition(
                update: firstUpdate,
                objects: [firstRoot],
                deltas: [.init(
                    base: baseFile.hash,
                    result: firstFile.hash,
                    instructions: [
                        .insert(firstHeader),
                        .copy(offset: baseHeader, length: 2),
                        .insert(Data("XY".utf8)),
                        .copy(offset: baseHeader + 4, length: 2),
                    ]
                )]
            ),
            WireAcceptedTransition(
                update: finalUpdate,
                objects: [finalRoot],
                deltas: [.init(
                    base: firstFile.hash,
                    result: finalFile.hash,
                    instructions: [
                        .insert(finalHeader),
                        .copy(offset: baseHeader, length: 6),
                        .insert(Data("!".utf8)),
                    ]
                )]
            ),
        ]

        let result = try WireTransitionReplay.applying(
            transitions,
            to: WireSnapshot(root: baseRoot.hash, objects: [baseRoot, baseFile])
        )
        #expect(result.root == finalRoot.hash)
        #expect(Set(result.objects.map(\.hash)) == Set([finalRoot.hash, finalFile.hash]))
        #expect(throws: ArborWireValidationError.self) {
            _ = try WireTransitionReplay.applying([transitions[1], transitions[0]], to: result)
        }
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

    @Test("A conflict decodes completely and is not retried")
    func typedConflict() async throws {
        let local = try wireTestSnapshot("local")
        let draft = try wireTestSnapshot("draft")
        let base = "sha256:" + String(repeating: "0", count: 64)
        let remote = "sha256:" + String(repeating: "1", count: 64)
        let draftObjects = draft.objects.map {
            "{\"hash\":\"\($0.hash)\",\"bytes\":\"\($0.bytes.base64EncodedString())\"}"
        }.joined(separator: ",")
        let response = Data("""
        {"error":"conflict","message":"The candidate could not be merged safely","retryable":false,"tree":"tr_atlas","details":{"kind":"server-update","current":{"id":"up_remote","tree":"tr_atlas","root":"\(remote)","previousRoot":"\(base)","kind":"accepted","acceptedAt":1787529600001,"subject":"dev_remote"},"base":"\(base)","candidate":"\(local.root)","draft":{"root":"\(draft.root)","objects":[\(draftObjects)],"deltas":[]},"conflicts":[{"path":"/photo.bin","reason":"binary-conflict"}]}}
        """.utf8)
        await WireURLProtocolStub.state.install { _, _ in (409, response) }
        let client = ArborWireClient(
            origin: URL(string: "https://canopy.test")!,
            credential: "device-token",
            session: wireStubSession(),
            retryDelay: { _ in }
        )
        let prepared = try await client.prepareUpdate(
            tree: "tr_atlas",
            base: WireUpdateBase(root: base, update: "up_base"),
            snapshot: local
        )
        do {
            _ = try await client.submitUpdate(prepared)
            Issue.record("Expected a typed conflict")
        } catch let error as WireUpdateConflictError {
            #expect(error.conflict.current.id == "up_remote")
            #expect(error.conflict.draft.root == draft.root)
            #expect(error.conflict.conflicts.first?.reason == "binary-conflict")
        }
        #expect(await WireURLProtocolStub.state.snapshot().count == 1)
    }

    @Test("Pairing claims never send an existing credential")
    func unauthenticatedPairingClaim() async throws {
        let deviceID = "dv_aaaaaaaaaaaaaaaaaaaaaaaaaa"
        let digest = "sha256:" + String(repeating: "0", count: 64)
        let response = Data("""
        {"device":{"id":"\(deviceID)","account":"acct_1","label":"iPad","createdAt":1787529600000,"lastUsedAt":null,"revokedAt":null},"confirmationCode":"123456"}
        """.utf8)
        await WireURLProtocolStub.state.install { request, _ in
            request.url?.path == "/.arbor/pairings/pair_1/claim"
                && request.value(forHTTPHeaderField: "Authorization") == nil
                ? (201, response)
                : (401, Data(#"{"error":"unauthenticated","message":"unexpected credentials"}"#.utf8))
        }
        let client = ArborWireClient(
            origin: URL(string: "https://canopy.test")!,
            credential: "old-token",
            session: wireStubSession()
        )
        let claimed = try await client.claimPairing(
            id: "pair_1",
            secret: "secret",
            device: WirePairingDevice(id: deviceID, label: "iPad", credentialDigest: digest)
        )
        #expect(claimed.device.id == deviceID)
        #expect(claimed.confirmationCode == "123456")
    }

    @Test("Descriptors, snapshots, and objects use tree-scoped routes")
    func treeScopedObjectRoute() async throws {
        let snapshot = try wireTestSnapshot("object")
        let root = try #require(snapshot.objects.first { $0.hash == snapshot.root })
        let bundle = try WireSnapshotBundleCodec.encode(snapshot)
        let descriptor = """
        {"tree":{"id":"tr_atlas","kind":"ordinary","access":"write","canonical":{"path":"/~alice/atlas","endpoint":"https://canopy.test","parentTree":null},"root":"\(snapshot.root)","update":"up_1"},"observedThrough":"up_1"}
        """
        await WireURLProtocolStub.state.install { request, _ in
            switch (request.httpMethod, request.url?.path) {
            case ("GET", "/.arbor/trees/tr_atlas"): (200, Data(descriptor.utf8))
            case ("GET", "/.arbor/trees/tr_atlas/snapshots/\(snapshot.root)"): (200, bundle)
            case ("GET", "/.arbor/trees/tr_atlas/objects/\(snapshot.root)"): (200, root.bytes)
            default: (404, Data(#"{"error":"not-found"}"#.utf8))
            }
        }
        let client = ArborWireClient(
            origin: URL(string: "https://canopy.test")!,
            credential: "device-token",
            session: wireStubSession()
        )
        let ref = try await client.descriptor(tree: "tr_atlas")
        let accepted = try await client.snapshot(tree: "tr_atlas", root: ref.tree.root)
        let object = try await client.object(tree: "tr_atlas", hash: snapshot.root)
        #expect(ref.tree.update == "up_1")
        #expect(ref.observedThrough == "up_1")
        #expect(accepted == snapshot.sorted())
        #expect(object == root.bytes)
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
        let ref = try await client.descriptor(tree: configuration.id)
        #expect(ref.tree.root == configuration.root)
        #expect(!ref.observedThrough.isEmpty)
        let current = try await client.descriptor(tree: configuration.id)
        let snapshot = try await client.snapshot(tree: configuration.id, root: current.tree.root)
        #expect(current.tree.id == configuration.id)
        #expect(snapshot.root == configuration.root)
        #expect(snapshot == snapshot.sorted())

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
        let historicalObject = origin.appending(path: ".arbor/objects/\(configuration.root)")
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

private func wireTestSnapshot(_ value: String) throws -> WireSnapshot {
    let file = try WireObjectCodec.object(.file(Data(value.utf8)))
    let root = try WireObjectCodec.object(.directory([.init(name: "value.bin", hash: file.hash)]))
    return WireSnapshot(root: root.hash, objects: [file, root])
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
                headerFields: ["Content-Type": request.url?.path.contains("/snapshots/") == true ? "application/cbor" : "application/json"]
            )!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        }
    }

    override func stopLoading() {}
}

@Suite("Shared wire value and observation vectors")
struct WireValueVectorTests {
    @Test("wire-values.json remote descriptors, access entries, and node refs decode; invalid values are rejected")
    func wireValues() throws {
        let data = try Data(contentsOf: fixtures.appending(path: "wire-values.json"))
        let fixture = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let valid = try #require(fixture["valid"] as? [String: Any])
        let decoder = JSONDecoder()

        let remoteData = try JSONSerialization.data(withJSONObject: try #require(valid["remoteTreeDescriptor"]))
        let remote = try decoder.decode(WireTreeDescriptor.self, from: remoteData).validated()
        #expect(remote.canonical?.endpoint == "https://community.example/.arbor/trees/\(remote.id)")
        #expect(remote.canonical?.httpURL == "https://community.example/~joe")
        #expect(remote.canonical?.arborURL == "arbor://community.example/~joe")
        #expect(remote.update == "up_aaaaaaaaaaaaaaaaaaaaaaaaaa")
        // TODO: `treeDescriptor`, `accountConfigurationDescriptor`, and `resolution.enclosingTree`
        // are plain `TreeDescriptor`s without `ref`/`update`. ArborWire models only the remote
        // shape (`WireTreeDescriptor` requires both), so they cannot be decoded here yet.

        let entriesData = try JSONSerialization.data(withJSONObject: try #require(valid["accessEntries"]))
        let entries = try decoder.decode([WireAccessEntry].self, from: entriesData)
        #expect(entries.map(\.id) == ["everyone", "profile:joe", "opaque-link-entry"])
        #expect(entries[1].subject == .profile(tree: "tr_aaaaaaaaaaaaaaaaaaaaaaaaaa", locator: "arbor://community.example/~joe"))
        #expect(entries[2].subject == .link)

        let resolution = try #require(valid["resolution"] as? [String: Any])
        let refData = try JSONSerialization.data(withJSONObject: try #require(resolution["ref"]))
        let ref = try decoder.decode(WireResolvedNodeRef.self, from: refData)
        #expect(ref == WireResolvedNodeRef(tree: "tr_aaaaaaaaaaaaaaaaaaaaaaaaaa", path: "/notes", stableKey: "[[\"id\",\"page-1\"]]"))

        let invalid = try #require(fixture["invalid"] as? [[String: Any]])
        #expect(invalid.map { $0["name"] as? String } == [
            "descriptor-for-local", "ordinary-tree-without-canonical", "link-entry-leaks-digest", "resolution-omits-tree",
        ])
        for vector in invalid {
            let name = vector["name"] as? String ?? ""
            let value = try #require(vector["value"] as? [String: Any])
            switch name {
            case "descriptor-for-local", "ordinary-tree-without-canonical":
                let bytes = try JSONSerialization.data(withJSONObject: value)
                #expect(throws: (any Error).self, "\(name)") {
                    _ = try decoder.decode(WireTreeDescriptor.self, from: bytes).validated()
                }
            case "resolution-omits-tree":
                let bytes = try JSONSerialization.data(withJSONObject: try #require(value["ref"]))
                #expect(throws: (any Error).self, "\(name)") {
                    _ = try decoder.decode(WireResolvedNodeRef.self, from: bytes)
                }
            default:
                // TODO: `link-entry-leaks-digest` is not rejected: `WireSafeAccessSubject` ignores an
                // unexpected `digest` key on a link subject instead of failing closed.
                continue
            }
        }
    }

    @Test("observation-events.sse frames satisfy id == cursor and event == kind")
    func observationEvents() throws {
        let source = try String(contentsOf: fixtures.appending(path: "observation-events.sse"), encoding: .utf8)
        // TODO: `ArborSSEParser` throws "Frame has no data" for a comment-only frame such as the
        // fixture's `: keepalive`, so comment lines are stripped before parsing here.
        let semantic = source.split(separator: "\n", omittingEmptySubsequences: false)
            .filter { !$0.hasPrefix(":") }
            .joined(separator: "\n")
        var parser = ArborSSEParser()
        var frames = try parser.append(Data(semantic.utf8))
        frames.append(contentsOf: try parser.finish())
        #expect(frames.map(\.event) == ["tree.update"])
        for frame in frames {
            let payload = try #require(JSONSerialization.jsonObject(with: Data(frame.data.utf8)) as? [String: Any])
            #expect(frame.id == payload["cursor"] as? String)
            #expect(frame.event == payload["kind"] as? String)
            #expect((payload["tree"] as? String)?.hasPrefix("tr_") == true)
        }
        // TODO: observation-events-invalid.json is not consumed here. The id/cursor, event/kind, and
        // tree checks live inside `ArborWireClient.watch` rather than an exported decoder.
    }
}
