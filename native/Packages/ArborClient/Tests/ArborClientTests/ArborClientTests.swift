import Foundation
import XCTest
@testable import ArborClient

final class ArborClientTests: XCTestCase {
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
        let node = try decode(NodeSnapshot.self, "node.json")
        let mutation = try decode(MutationRequest.self, "mutation.json")
        let receipt = try decode(MutationReceipt.self, "receipt.json")
        let error = try decode(ArborSyncErrorEnvelope.self, "error.json")
        let children = try decode(ChildrenPage.self, "children.json")
        let search = try decode(SearchPage.self, "search.json")
        let backlinks = try decode(BacklinksPage.self, "backlinks.json")
        let recovery = try decode(RecoveryPage.self, "recovery.json")
        let operationRequests = try decode([MutationRequest].self, "operations.json")
        let errors = try decode([ArborSyncErrorEnvelope].self, "errors.json")
        let unknownNode = try decode(NodeSnapshot.self, "node-unknown-field.json")
        let untracked = try decode(NodeSnapshot.self, "node-untracked.json")
        let systemTree = try decode(NodeSnapshot.self, "node-system-tree.json")
        let mergeFixtureData = try Data(contentsOf: canopyFixtures.appending(path: "wire-merge.json"))
        let mergeFixtures = try XCTUnwrap(JSONSerialization.jsonObject(with: mergeFixtureData) as? [String: Any])
        let intentFixtureData = try Data(contentsOf: conformanceFixtures.appending(path: "wire-update-intent.json"))
        let intentFixtures = try XCTUnwrap(JSONSerialization.jsonObject(with: intentFixtureData) as? [String: Any])

        XCTAssertEqual(node.ref, NodeRef(tree: "tr_notes7f3q2ab7c", path: "/notes/today", stableKey: pageIDStableKey("abc123")))
        XCTAssertEqual(node.content?.source, "---\nid: abc123\ntitle: Today\n---\nHello\n")
        XCTAssertEqual(node.ref.tree, "tr_notes7f3q2ab7c")
        XCTAssertEqual(node.enclosingTree?.osPath, "/Users/joe/notes")
        XCTAssertEqual(node.enclosingTree?.canonical?.arborURL, "arbor://notes.example/~joe/notes")
        XCTAssertEqual(node.enclosingTree?.canonical?.httpURL, "https://notes.example/~joe/notes")
        XCTAssertEqual(untracked.ref.tree, "local")
        XCTAssertNil(untracked.enclosingTree)
        XCTAssertEqual(systemTree.ref.tree, "system")
        XCTAssertFalse(systemTree.capabilities.content?.writable ?? true)
        XCTAssertEqual(unknownNode.ref.tree, "tr_notes7f3q2ab7c")
        XCTAssertEqual(mutation.operations.first?.op, "move")
        XCTAssertEqual(receipt.effects.first?.previousPath, "/notes/today")
        XCTAssertEqual(receipt.effects.first?.propertiesRevision, "sha256:properties")
        XCTAssertEqual(error.error, "future-error-code")
        XCTAssertEqual(children.items.first?.ref.path, "/notes/today")
        XCTAssertEqual(search.results.first?.ref.stableKey, pageIDStableKey("abc123"))
        XCTAssertEqual(backlinks.entries.first?.ref.stableKey, pageIDStableKey("week01"))
        XCTAssertEqual(recovery.entries.first?.status, "lost")
        XCTAssertEqual(recovery.entries.last?.kind, "trash")
        XCTAssertEqual(
            operationRequests.flatMap(\.operations).map(\.op),
            ["writeMarkdown", "writeProperties", "writeText", "createMarkdown", "createDirectory", "rename", "move", "copy", "trash", "restore", "restoreRecovery", "ensureDocumentIdentity"]
        )
        XCTAssertEqual(errors.last?.error, "future-error-code")
        XCTAssertEqual(mergeFixtures["version"] as? Int, 2)
        XCTAssertGreaterThanOrEqual((mergeFixtures["markdownCases"] as? [[String: Any]])?.count ?? 0, 10)
        XCTAssertEqual((mergeFixtures["pageMoveCases"] as? [[String: Any]])?.count, 4)
        XCTAssertEqual(
            (intentFixtures["replayCases"] as? [[String: Any]])?.compactMap { $0["name"] as? String },
            ["same-intent-different-object-envelope", "different-candidate-has-different-digest"]
        )
        XCTAssertEqual(unknownNode.ref.stableKey, pageIDStableKey("abc123"))
    }

    func testMultipartMetadataFixturesRemainLanguageNeutralJSON() throws {
        for name in ["asset-metadata.json", "import-metadata.json"] {
            let value = try JSONSerialization.jsonObject(
                with: Data(contentsOf: fixtures.appending(path: name))
            ) as? [String: Any]
            XCTAssertNotNil(value?["mutationID"] as? String)
        }
    }

    func testSharedSSEFixtureDecodes() throws {
        let source = try String(contentsOf: fixtures.appending(path: "events.sse"), encoding: .utf8)
        let dataLine = try XCTUnwrap(source.split(separator: "\n").first(where: { $0.hasPrefix("data:") }))
        let data = Data(dataLine.dropFirst(5).trimmingCharacters(in: .whitespaces).utf8)
        let event = try JSONDecoder().decode(WorkspaceEvent.self, from: data)
        XCTAssertEqual(event.change.origin, "api")
        XCTAssertTrue(event.cursor.hasSuffix(":5"))
    }

    func testMalformedSSEFixtureFailsWorkspaceEventDecoding() throws {
        let source = try String(contentsOf: fixtures.appending(path: "malformed-event.sse"), encoding: .utf8)
        let dataLine = try XCTUnwrap(source.split(separator: "\n").first(where: { $0.hasPrefix("data:") }))
        let data = Data(dataLine.dropFirst(5).trimmingCharacters(in: .whitespaces).utf8)
        XCTAssertThrowsError(try JSONDecoder().decode(WorkspaceEvent.self, from: data))
    }

    private struct URLFixture: Decodable {
        struct Authority: Decodable {
            var dns: String?
            var treeID: String?
        }
        struct Expected: Decodable {
            var kind: String
            var path: String?
            var stableKey: String?
            var revision: String?
            var applicationQuery: String?
            var contentFragment: String?
            var legacyStableKeyCandidate: String?
            var authority: Authority?
            var raw: String?
            var href: String?
        }
        var base: String
        var href: String
        var expected: Expected?
        var rewritePath: String?
        var expectedRewritten: String?
    }

    func testSharedURLResolutionFixturesResolveIdentically() throws {
        let cases = try JSONDecoder().decode(
            [URLFixture].self,
            from: Data(contentsOf: conformanceFixtures.appending(path: "url-resolution.json"))
        )
        XCTAssertGreaterThan(cases.count, 20)
        for fixture in cases {
            let label = "\(fixture.base) + \(fixture.href)"
            let resolved = resolveLogicalURL(base: fixture.base, href: fixture.href)
            guard let expected = fixture.expected else {
                XCTAssertNil(resolved, label)
                continue
            }
            switch resolved {
            case .local(let path, let locator):
                XCTAssertEqual(expected.kind, "local", label)
                XCTAssertEqual(path, expected.path, label)
                assertLocator(locator, equals: expected, label: label)
            case .arbor(let authority, let path, let locator):
                XCTAssertEqual(expected.kind, "arbor", label)
                XCTAssertEqual(path, expected.path, label)
                assertLocator(locator, equals: expected, label: label)
                switch authority {
                case .dns(let dns): XCTAssertEqual(dns, expected.authority?.dns, label)
                case .treeID(let treeID): XCTAssertEqual(treeID, expected.authority?.treeID, label)
                }
            case .system(let raw):
                XCTAssertEqual(expected.kind, "system", label)
                XCTAssertEqual(raw, expected.raw, label)
            case .overlay(let raw):
                XCTAssertEqual(expected.kind, "overlay", label)
                XCTAssertEqual(raw, expected.raw, label)
            case .external(let href):
                XCTAssertEqual(expected.kind, "external", label)
                XCTAssertEqual(href, expected.href, label)
            case .fragment(let contentFragment, let legacyStableKeyCandidate):
                XCTAssertEqual(expected.kind, "fragment", label)
                XCTAssertEqual(contentFragment, expected.contentFragment, label)
                XCTAssertEqual(legacyStableKeyCandidate, expected.legacyStableKeyCandidate, label)
            case nil:
                XCTFail("Expected \(expected.kind) for \(label), resolved nil")
            }
            if let rewritePath = fixture.rewritePath {
                XCTAssertEqual(
                    rewriteLocalLinkPath(base: fixture.base, href: fixture.href, newPath: rewritePath),
                    fixture.expectedRewritten,
                    label
                )
            }
        }
    }

    private func assertLocator(_ locator: ResolvedLocatorState, equals expected: URLFixture.Expected, label: String) {
        XCTAssertEqual(locator.stableKey, expected.stableKey, label)
        XCTAssertEqual(locator.revision, expected.revision, label)
        XCTAssertEqual(locator.applicationQuery, expected.applicationQuery, label)
        XCTAssertEqual(locator.contentFragment, expected.contentFragment, label)
        XCTAssertEqual(locator.legacyStableKeyCandidate, expected.legacyStableKeyCandidate, label)
    }

    func testStableKeyAndLocatorWritersMatchTypeScriptVectors() throws {
        let stableKey = #"[["id","x7f3q2"]]"#
        let encoded = try XCTUnwrap(encodeStableKey(stableKey))
        XCTAssertEqual(encoded, "W1siaWQiLCJ4N2YzcTIiXV0")
        XCTAssertEqual(decodeStableKey(encoded), stableKey)
        XCTAssertNil(decodeStableKey(encoded + "="))
        XCTAssertEqual(
            buildCanonicalLink(
                from: "/projects/atlas",
                toPath: "/projects/roadmap",
                stableKey: stableKey,
                applicationQuery: "view=board&edit"
            ),
            "../roadmap?view=board&edit#arbor-key=\(encoded)"
        )
        XCTAssertEqual(
            buildNetworkLocator(
                rawPath: "../roadmap",
                stableKey: stableKey,
                applicationQuery: "view=board&edit",
                contentFragment: "implementation"
            ),
            "../roadmap;arbor-key=\(encoded)?view=board&edit#implementation"
        )
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

    func testCanonicalNodeDecodersRejectLegacySnapshotFields() throws {
        let fixture = try Data(contentsOf: fixtures.appending(path: "node.json"))
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: fixture) as? [String: Any])
        object["tree"] = "tr_legacy"
        let data = try JSONSerialization.data(withJSONObject: object)
        XCTAssertThrowsError(try JSONDecoder().decode(NodeSnapshot.self, from: data))

        let childrenFixture = try Data(contentsOf: fixtures.appending(path: "children.json"))
        var page = try XCTUnwrap(JSONSerialization.jsonObject(with: childrenFixture) as? [String: Any])
        var items = try XCTUnwrap(page["items"] as? [[String: Any]])
        items[0]["kind"] = "markdown"
        page["items"] = items
        let childrenData = try JSONSerialization.data(withJSONObject: page)
        XCTAssertThrowsError(try JSONDecoder().decode(ChildrenPage.self, from: childrenData))
    }

    func testLiveServerWhenProvided() async throws {
        guard
            let value = ProcessInfo.processInfo.environment["ARBOR_TEST_URL"],
            let url = URL(string: value),
            let tree = ProcessInfo.processInfo.environment["ARBOR_TEST_TREE"]
        else { throw XCTSkip("ARBOR_TEST_URL is not set") }

        let client = ArborSyncRESTClient(
            baseURL: url,
            mutationIDGenerator: { "swift-live-mutation" },
            retryDelay: { _ in }
        )
        let before = try await client.node(.path("/page", tree: tree))
        XCTAssertEqual(before.ref.path, "/page")
        let view = try await client.openNodeView(.path("/", tree: tree))
        let request = try await client.prepareStructuralMutation(
            [WorkspaceOperation(op: "createDirectory", tree: tree, path: "/from-swift")],
            mutationID: "swift-live-mutation"
        )
        let first = try await client.mutate(request)
        let retry = try await client.mutate(request)
        XCTAssertEqual(first, retry)
        let created = try await client.node(.path("/from-swift", tree: tree))
        XCTAssertEqual(created.ref.path, "/from-swift")
        for try await update in view.updates {
            guard case let .event(event) = update, event.change.mutationID == "swift-live-mutation" else {
                continue
            }
            XCTAssertEqual(event.change.ref.path, "/from-swift")
            break
        }
    }

    func testMutationRetriesExactPreparedBodyAfterHTTP500() async throws {
        let receipt = try Data(contentsOf: fixtures.appending(path: "receipt.json"))
        await URLProtocolStub.state.install { _, attempt in
            attempt == 1
                ? (500, Data(#"{"error":"internal-error","message":"lost","retryable":true}"#.utf8))
                : (200, receipt)
        }
        let client = ArborSyncRESTClient(
            baseURL: URL(string: "https://arborsync.test")!,
            session: stubSession(),
            retryDelay: { _ in }
        )
        let request = MutationRequest(
            mutationID: "22222222-2222-2222-2222-222222222222",
            operations: [WorkspaceOperation(op: "createDirectory", tree: "tr_notes", path: "/retry")]
        )
        let result = try await client.mutate(request)
        let snapshot = await URLProtocolStub.state.snapshot()
        XCTAssertEqual(result.mutationID, request.mutationID)
        XCTAssertEqual(snapshot.count, 2)
        XCTAssertEqual(snapshot.bodies[0], snapshot.bodies[1])
    }

    func testMutationConveniencesRejectMixedDurabilityDomains() async throws {
        let client = ArborSyncRESTClient(baseURL: URL(string: "https://arborsync.test")!)
        let content = WorkspaceOperation(
            op: "writeMarkdown",
            ref: .path("/page", tree: "tr_notes"),
            baseContentRevision: "sha256:content",
            source: "Updated\n"
        )
        do {
            _ = try await client.prepareStructuralMutation([
                WorkspaceOperation(op: "createDirectory", path: "/folder"),
                content,
            ])
            XCTFail("Expected a domain error")
        } catch let error as InvalidMutationDomainError {
            XCTAssertTrue(error.message.contains("cannot contain content"))
        }
        let mixed = try decode(MutationRequest.self, "mixed-mutation.json")
        do {
            _ = try await client.mutate(mixed)
            XCTFail("Expected a domain error")
        } catch let error as InvalidMutationDomainError {
            XCTAssertTrue(error.message.contains("exactly one operation"))
        }
    }

    func testWorkspaceOperationEncodesUTF8SourceEditProvenance() throws {
        let operation = WorkspaceOperation(
            op: "writeMarkdown",
            ref: .path("/page", tree: "tr_notes"),
            baseContentRevision: "sha256:base",
            source: "Hello 🌳\n",
            sourceEdits: [ProtocolSourceEdit(
                offset: 6,
                length: 0,
                replacement: "🌳",
                expected: ""
            )]
        )
        let data = try JSONEncoder().encode(operation)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let edits = try XCTUnwrap(json["sourceEdits"] as? [[String: Any]])
        XCTAssertEqual(edits.first?["offset"] as? Int, 6)
        XCTAssertEqual(edits.first?["replacement"] as? String, "🌳")
        XCTAssertEqual(try JSONDecoder().decode(WorkspaceOperation.self, from: data), operation)
    }

    func testMultipartRetriesTheSameEncodedRequest() async throws {
        let receipt = try String(contentsOf: fixtures.appending(path: "receipt.json"), encoding: .utf8)
        let response = Data(#"{"receipt":\#(receipt),"path":"/Assets/example.txt","markdownPath":"../Assets/example.txt"}"#.utf8)
        await URLProtocolStub.state.install { _, attempt in
            attempt == 1
                ? (500, Data(#"{"error":"internal-error","message":"lost","retryable":true}"#.utf8))
                : (200, response)
        }
        let client = ArborSyncRESTClient(
            baseURL: URL(string: "https://arborsync.test")!,
            session: stubSession(),
            retryDelay: { _ in }
        )
        let result = try await client.asset(
            directory: .path("/notes", tree: "tr_notes"),
            filename: "example.txt",
            contentType: "text/plain",
            data: Data("bytes".utf8),
            mutationID: "33333333-3333-3333-3333-333333333333"
        )
        let snapshot = await URLProtocolStub.state.snapshot()
        XCTAssertEqual(result.path, "/Assets/example.txt")
        XCTAssertEqual(snapshot.count, 2)
        XCTAssertEqual(snapshot.bodies[0], snapshot.bodies[1])
    }

    func testFileReadsExactBytesFromExplicitReference() async throws {
        let bytes = Data([0, 1, 2, 255])
        await URLProtocolStub.state.install { request, _ in
            request.url?.path == "/v1/file" ? (200, bytes) : (404, Data())
        }
        let client = ArborSyncRESTClient(
            baseURL: URL(string: "https://arborsync.test")!,
            session: stubSession()
        )

        let result = try await client.file(.init(
            tree: "tr_notes",
            path: "/Assets/photo.png",
            stableKey: pageIDStableKey("pg_image")
        ))
        XCTAssertEqual(result.bytes, bytes)
        let snapshot = await URLProtocolStub.state.snapshot()
        let request = try XCTUnwrap(snapshot.requests.first)
        XCTAssertEqual(request.path, "/v1/file")
        XCTAssertEqual(request.query, "tree=tr_notes&path=/Assets/photo.png&stableKey=%5B%5B%22id%22,%22pg_image%22%5D%5D")
    }

    func testWireClientDecodesAcceptedUpdateAndRetriesExactPreparedBody() async throws {
        let wireSnapshot = try wireSnapshot("root")
        let requestDigest = updateRequestDigest(
            tree: "tr_atlas",
            base: WireUpdateBase(root: wireSnapshot.root, update: "up_atlas1"),
            candidate: wireSnapshot.root
        )
        let response = Data("""
        {"outcome":"current","requestDigest":"\(requestDigest)","update":{"id":"1","tree":"tr_atlas","root":"\(wireSnapshot.root)","previousRoot":null,"kind":"initial","acceptedAt":1787529600000,"subject":null},"observedThrough":"1"}
        """.utf8)
        await URLProtocolStub.state.install { _, attempt in
            attempt == 1
                ? (500, Data(#"{"error":"temporarily-unavailable","message":"retry"}"#.utf8))
                : (200, response)
        }
        let client = ArborWireClient(
            origin: URL(string: "https://canopy.test")!,
            credential: "device-token",
            session: stubSession(),
            retryDelay: { _ in }
        )
        let prepared = try await client.prepareUpdate(
            tree: "tr_atlas",
            base: WireUpdateBase(root: wireSnapshot.root, update: "up_atlas1"),
            snapshot: wireSnapshot
        )
        let result = try await client.submitUpdate(prepared)
        guard case .current(let current) = result else { return XCTFail("Expected current") }
        let snapshot = await URLProtocolStub.state.snapshot()
        XCTAssertEqual(current.id, "1")
        XCTAssertEqual(snapshot.count, 2)
        XCTAssertEqual(snapshot.bodies[0], snapshot.bodies[1])
        XCTAssertEqual(snapshot.requests[0].authorization, "Bearer device-token")
        XCTAssertNil(snapshot.requests[0].idempotencyKey)
        XCTAssertEqual(snapshot.requests[0].path, "/.arbor/trees/tr_atlas/updates")
    }

    func testServerConflictIsTypedCompleteAndNotRetried() async throws {
        let local = try wireSnapshot("local")
        let draft = try wireSnapshot("draft")
        let base = "sha256:" + String(repeating: "0", count: 64)
        let remote = "sha256:" + String(repeating: "1", count: 64)
        let draftObjects = draft.objects.map { "{\"hash\":\"\($0.hash)\",\"bytes\":\"\($0.bytes.base64EncodedString())\"}" }.joined(separator: ",")
        let response = Data("""
        {"error":"conflict","message":"The candidate could not be merged safely","retryable":false,"tree":"tr_atlas","details":{"kind":"server-update","current":{"id":"up_remote","tree":"tr_atlas","root":"\(remote)","previousRoot":"\(base)","kind":"accepted","acceptedAt":1787529600001,"subject":"dev_remote"},"base":"\(base)","candidate":"\(local.root)","draft":{"root":"\(draft.root)","objects":[\(draftObjects)]},"conflicts":[{"path":"/photo.bin","reason":"binary-conflict"}]}}
        """.utf8)
        await URLProtocolStub.state.install { _, _ in (409, response) }
        let client = ArborWireClient(
            origin: URL(string: "https://canopy.test")!,
            credential: "device-token",
            session: stubSession(),
            retryDelay: { _ in }
        )
        let prepared = try await client.prepareUpdate(
            tree: "tr_atlas",
            base: WireUpdateBase(root: base, update: "up_base"),
            snapshot: local
        )
        do {
            _ = try await client.submitUpdate(prepared)
            XCTFail("Expected a typed conflict")
        } catch let error as WireUpdateConflictError {
            XCTAssertEqual(error.conflict.current.id, "up_remote")
            XCTAssertEqual(error.conflict.draft.root, draft.root)
            XCTAssertEqual(error.conflict.conflicts.first?.reason, "binary-conflict")
        }
        let snapshot = await URLProtocolStub.state.snapshot()
        XCTAssertEqual(snapshot.count, 1)
    }

    func testServerPairingClaimDoesNotSendExistingCredential() async throws {
        let deviceID = "dv_aaaaaaaaaaaaaaaaaaaaaaaaaa"
        let digest = "sha256:" + String(repeating: "0", count: 64)
        let response = Data("""
        {"device":{"id":"\(deviceID)","account":"acct_1","label":"iPad","createdAt":1787529600000,"lastUsedAt":null,"revokedAt":null},"confirmationCode":"123456"}
        """.utf8)
        await URLProtocolStub.state.install { _, _ in (201, response) }
        let client = ArborWireClient(
            origin: URL(string: "https://canopy.test")!,
            credential: "old-token",
            session: stubSession()
        )
        let claimed = try await client.claimPairing(
            id: "pair_1",
            secret: "secret",
            device: WirePairingDevice(id: deviceID, label: "iPad", credentialDigest: digest)
        )
        let snapshot = await URLProtocolStub.state.snapshot()
        XCTAssertEqual(claimed.device.id, deviceID)
        XCTAssertEqual(claimed.confirmationCode, "123456")
        XCTAssertNil(snapshot.requests.first?.authorization)
        XCTAssertEqual(snapshot.requests.first?.path, "/.arbor/pairings/pair_1/claim")
    }

    func testWireRefEnvelopeAndTreeScopedObjectRoute() async throws {
        let wireSnapshot = try wireSnapshot("object")
        let root = try XCTUnwrap(wireSnapshot.objects.first { $0.hash == wireSnapshot.root })
        let descriptor = """
        {"tree":{"id":"tr_atlas","kind":"ordinary","access":"write","canonical":{"path":"/~alice/atlas","endpoint":"https://canopy.test","parentTree":null},"root":"\(wireSnapshot.root)","update":"up_1"},"observedThrough":"up_1"}
        """
        await URLProtocolStub.state.install { request, _ in
            switch (request.httpMethod, request.url?.path) {
            case ("GET", "/.arbor/trees/tr_atlas"): (200, Data(descriptor.utf8))
            case ("GET", "/.arbor/trees/tr_atlas/objects/\(wireSnapshot.root)"): (200, root.bytes)
            default: (404, Data(#"{"error":"not-found"}"#.utf8))
            }
        }
        let client = ArborWireClient(
            origin: URL(string: "https://canopy.test")!,
            credential: "device-token",
            session: stubSession()
        )
        let ref = try await client.descriptor(tree: "tr_atlas")
        let object = try await client.object(tree: "tr_atlas", hash: wireSnapshot.root)
        XCTAssertEqual(ref.tree.update, "up_1")
        XCTAssertEqual(ref.observedThrough, "up_1")
        XCTAssertEqual(object, root.bytes)
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

    private func wireSnapshot(_ value: String) throws -> WireSnapshot {
        let file = try WireObjectCodec.object(.file(Data(value.utf8)))
        let root = try WireObjectCodec.object(.directory([.init(name: "value.bin", hash: file.hash)]))
        return WireSnapshot(root: root.hash, objects: [file, root])
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
        bodies.append(request.httpBody ?? Data())
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
