import Foundation
import XCTest
@testable import ArborClient

final class ArborClientTests: XCTestCase {
    private var fixtures: URL {
        if let path = ProcessInfo.processInfo.environment["ARBOR_PROTOCOL_FIXTURES"] {
            return URL(fileURLWithPath: path, isDirectory: true)
        }
        return URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .appending(path: "../../../../../spec/fixtures")
            .standardizedFileURL
    }

    private func decode<T: Decodable>(_ type: T.Type, _ name: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(contentsOf: fixtures.appending(path: name)))
    }

    func testSharedFixturesDecodeWithoutAppDependencies() throws {
        let node = try decode(NodeSnapshot.self, "node.json")
        let mutation = try decode(MutationRequest.self, "mutation.json")
        let receipt = try decode(MutationReceipt.self, "receipt.json")
        let error = try decode(ArbordErrorEnvelope.self, "error.json")
        let children = try decode(ChildrenPage.self, "children.json")
        let search = try decode(SearchPage.self, "search.json")
        let backlinks = try decode(BacklinksPage.self, "backlinks.json")
        let collection = try decode(CollectionPage.self, "collection.json")
        let recovery = try decode(RecoveryPage.self, "recovery.json")
        let operationRequests = try decode([MutationRequest].self, "operations.json")
        let errors = try decode([ArbordErrorEnvelope].self, "errors.json")
        let unknownNode = try decode(NodeSnapshot.self, "node-unknown-field.json")
        let untracked = try decode(NodeSnapshot.self, "node-untracked.json")
        let systemTree = try decode(NodeSnapshot.self, "node-system-tree.json")

        XCTAssertEqual(node.ref, ResolvedNodeRef(path: "/notes/today", pageID: "abc123", tree: "tr_notes7f3q2ab7c"))
        XCTAssertEqual(node.document?.source, "---\nid: abc123\ntitle: Today\n---\nHello\n")
        XCTAssertEqual(node.tree, "tr_notes7f3q2ab7c")
        XCTAssertEqual(node.enclosingTree?.osPath, "/Users/joe/notes")
        XCTAssertEqual(node.enclosingTree?.accessEntries?.first?.locator, "arbor://notes.example/~alice")
        XCTAssertEqual(untracked.tree, "local")
        XCTAssertNil(untracked.enclosingTree)
        XCTAssertEqual(systemTree.tree, "system")
        XCTAssertFalse(systemTree.writable)
        XCTAssertNil(unknownNode.tree)
        XCTAssertEqual(mutation.operations.first?.op, "move")
        XCTAssertEqual(receipt.effects.first?.previousPath, "/notes/today")
        XCTAssertEqual(error.error.code, "future-error-code")
        XCTAssertEqual(children.items.first?.path, "/notes/today")
        XCTAssertEqual(search.results.first?.pageID, "abc123")
        XCTAssertEqual(backlinks.entries.first?.ref.pageID, "week01")
        XCTAssertEqual(collection.rows.first?.key, "one")
        XCTAssertEqual(recovery.entries.first?.status, "lost")
        XCTAssertEqual(recovery.entries.last?.kind, "trash")
        XCTAssertEqual(
            operationRequests.flatMap(\.operations).map(\.op),
            ["writeMarkdown", "createMarkdown", "createDirectory", "rename", "move", "move", "copy", "trash", "restore", "restoreRecovery", "ensureDocumentIdentity", "connectCommunity", "promoteTree", "placeTree", "setTreeAccess", "claimProfile", "disconnectCommunity", "createGroupProfile", "removeTreePlacement"]
        )
        XCTAssertEqual(errors.last?.error.code, "future-error-code")
        XCTAssertEqual(unknownNode.ref.pageID, "abc123")
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
        XCTAssertEqual(event.origin, "api")
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
            var pageID: String?
            var fragment: String?
            var authority: Authority?
            var raw: String?
            var href: String?
        }
        var base: String
        var href: String
        var expected: Expected?
    }

    func testSharedURLResolutionFixturesResolveIdentically() throws {
        let cases = try JSONDecoder().decode(
            [URLFixture].self,
            from: Data(contentsOf: fixtures.appending(path: "url-resolution.json"))
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
            case .local(let path, let pageID, let fragment):
                XCTAssertEqual(expected.kind, "local", label)
                XCTAssertEqual(path, expected.path, label)
                XCTAssertEqual(pageID, expected.pageID, label)
                XCTAssertEqual(fragment, expected.fragment, label)
            case .arbor(let authority, let path, let pageID, let fragment):
                XCTAssertEqual(expected.kind, "arbor", label)
                XCTAssertEqual(path, expected.path, label)
                XCTAssertEqual(pageID, expected.pageID, label)
                XCTAssertEqual(fragment, expected.fragment, label)
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
            case .fragment(let pageID):
                XCTAssertEqual(expected.kind, "fragment", label)
                XCTAssertEqual(pageID, expected.pageID, label)
            case nil:
                XCTFail("Expected \(expected.kind) for \(label), resolved nil")
            }
        }
    }

    func testLiveServerWhenProvided() async throws {
        guard
            let value = ProcessInfo.processInfo.environment["ARBOR_TEST_URL"],
            let url = URL(string: value)
        else { throw XCTSkip("ARBOR_TEST_URL is not set") }

        let client = ArborClient(
            baseURL: url,
            mutationIDGenerator: { "swift-live-mutation" },
            retryDelay: { _ in }
        )
        let before = try await client.node(.path("/page"))
        XCTAssertEqual(before.path, "/page")
        let view = try await client.openNodeView(.path("/"))
        let request = try await client.prepareStructuralMutation(
            [WorkspaceOperation(op: "createDirectory", path: "/from-swift")],
            mutationID: "swift-live-mutation"
        )
        let first = try await client.mutate(request)
        let retry = try await client.mutate(request)
        XCTAssertEqual(first, retry)
        let created = try await client.node(.path("/from-swift"))
        XCTAssertEqual(created.path, "/from-swift")
        for try await update in view.updates {
            guard case let .event(event) = update, event.mutationID == "swift-live-mutation" else {
                continue
            }
            XCTAssertEqual(event.path, "/from-swift")
            break
        }
    }

    func testMutationRetriesExactPreparedBodyAfterHTTP500() async throws {
        let receipt = try Data(contentsOf: fixtures.appending(path: "receipt.json"))
        await URLProtocolStub.state.install { _, attempt in
            attempt == 1
                ? (500, Data(#"{"error":{"code":"internal-error","message":"lost","retryable":true}}"#.utf8))
                : (200, receipt)
        }
        let client = ArborClient(
            baseURL: URL(string: "https://arbord.test")!,
            session: stubSession(),
            retryDelay: { _ in }
        )
        let request = MutationRequest(
            mutationID: "22222222-2222-2222-2222-222222222222",
            operations: [WorkspaceOperation(op: "createDirectory", path: "/retry")]
        )
        let result = try await client.mutate(request)
        let snapshot = await URLProtocolStub.state.snapshot()
        XCTAssertEqual(result.mutationID, request.mutationID)
        XCTAssertEqual(snapshot.count, 2)
        XCTAssertEqual(snapshot.bodies[0], snapshot.bodies[1])
    }

    func testMutationConveniencesRejectMixedDurabilityDomains() async throws {
        let client = ArborClient(baseURL: URL(string: "https://arbord.test")!)
        let content = WorkspaceOperation(
            op: "writeMarkdown",
            ref: .path("/page"),
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

    func testMultipartRetriesTheSameEncodedRequest() async throws {
        let receipt = try String(contentsOf: fixtures.appending(path: "receipt.json"), encoding: .utf8)
        let response = Data(#"{"receipt":\#(receipt),"path":"/Assets/example.txt","markdownPath":"../Assets/example.txt"}"#.utf8)
        await URLProtocolStub.state.install { _, attempt in
            attempt == 1
                ? (500, Data(#"{"error":{"code":"internal-error","message":"lost","retryable":true}}"#.utf8))
                : (200, response)
        }
        let client = ArborClient(
            baseURL: URL(string: "https://arbord.test")!,
            session: stubSession(),
            retryDelay: { _ in }
        )
        let result = try await client.asset(
            directory: .path("/notes"),
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

    func install(_ handler: @escaping Handler) {
        self.handler = handler
        count = 0
        bodies = []
    }

    func response(for request: URLRequest) -> (Int, Data) {
        count += 1
        bodies.append(request.httpBody ?? Data())
        return handler?(request, count) ?? (500, Data())
    }

    func snapshot() -> (count: Int, bodies: [Data]) {
        (count, bodies)
    }
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
                headerFields: ["Content-Type": "application/json"]
            )!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        }
    }

    override func stopLoading() {}
}
