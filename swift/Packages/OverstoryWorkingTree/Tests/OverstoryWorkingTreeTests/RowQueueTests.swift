import StoryKit
import OverstoryObjectStore
@testable import OverstoryWorkingTree
@testable import Overstory
import Foundation
import Testing

/// Answers row requests: offline for the first `offline` calls, then with
/// `answer`, recording every request it was sent.
private actor RowTransport: UpdateTransport {
    let snapshot: ProtocolSnapshot
    let offline: Int
    let answer: @Sendable (PreparedProtocolUpdate) throws -> ProtocolUpdateResponse
    private(set) var requests: [PreparedProtocolUpdate] = []

    init(snapshot: ProtocolSnapshot, offline: Int, answer: @escaping @Sendable (PreparedProtocolUpdate) throws -> ProtocolUpdateResponse) {
        self.snapshot = snapshot; self.offline = offline; self.answer = answer
    }
    func submit(_ prepared: PreparedProtocolUpdate) async throws -> ProtocolUpdateResponse {
        requests.append(prepared)
        if requests.count <= offline { throw URLError(.notConnectedToInternet) }
        return try answer(prepared)
    }
    func descriptor(tree: String) async throws -> ProtocolCurrentTree {
        ProtocolCurrentTree(tree: ProtocolTreeDescriptor(id: tree, kind: "ordinary", root: snapshot.root, access: "write",
            canonical: ProtocolCanonicalDescriptor(path: "/~owner/\(tree)", endpoint: "https://overstory.example"), update: "up_initial"),
            observedThrough: "up_initial")
    }
    func snapshot(tree _: String, root _: String) async throws -> ProtocolSnapshot { snapshot }
}

@Suite("Row queue (Schema language 007)")
struct RowQueueTests {
    static let tree = TreeID(rawValue: "tr_rows")
    static let chess = #"[["id","chess"]]"#

    /// A tree whose `/games` folder is a collection of two games.
    private func gamesTree() throws -> (snapshot: ProtocolSnapshot, games: String) {
        let vectors = fixtureDirectory().appending(path: "protocol-objects.json")
        let fixture = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: vectors)) as? [String: Any])
        let vector = try #require((fixture["objects"] as? [[String: Any]])?.first { $0["name"] as? String == "rows" })
        let rows = ProtocolObjectEnvelope(hash: vector["hash"] as! String, bytes: try #require(Data(base64Encoded: vector["bytesBase64"] as! String)))
        let table = try ProtocolObjectCodec.object(.table(ProtocolTable(rows: 2, chunks: [.init(rows: 2, chunk: rows.hash)])))
        let schema = try ProtocolObjectCodec.object(.file(Data("""
            main model Game {
              name   Text
              status Status
              tags   Text[]
            }
            Game.status <-> Status.games[]
            enum Status { Draft, Polished }
            """.utf8)))
        let games = try ProtocolObjectCodec.object(.directory([.init(name: "schema.usl", file: schema.hash)],
            collection: ProtocolCollectionReference(modelFingerprint: "sha256:" + String(repeating: "3", count: 64),
                                                    tables: [.init(model: "Game", table: table.hash)])))
        let root = try ProtocolObjectCodec.object(.directory([.init(name: "games", directory: games.hash)]))
        return (ProtocolSnapshot(root: root.hash, objects: [root, games, schema, table, rows]), games.hash)
    }

    private func open(_ snapshot: ProtocolSnapshot, at root: URL, transport: RowTransport) async throws -> (UpdateCoordinator, WorkingTreeProvider) {
        let workingTree = try await WorkingTree.open(at: root.appending(path: "tree"), tree: Self.tree)
        try await workingTree.initializeFromSystem(try SnapshotBridge.replacement(snapshot: snapshot, tree: Self.tree, update: "up_initial", cursor: "up_initial"))
        let coordinator = try UpdateCoordinator(workingTree: workingTree, transport: transport, stateRoot: root.appending(path: "state"))
        return (coordinator, WorkingTreeProvider(workingTree: workingTree, coordinator: coordinator))
    }

    private func status(_ provider: WorkingTreeProvider) async throws -> JSONValue? {
        try await provider.collectionRows(WorkspaceReference(tree: Self.tree, path: "/games")).rows["Game"]?.first?["status"]
    }

    private func withRoot(_ body: (URL) async throws -> Void) async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "story-rows-\(UUID().uuidString)", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        try await body(root)
    }

    private func waitUntil(_ condition: @Sendable () async throws -> Bool) async throws {
        for _ in 0..<500 where !(try await condition()) { try await Task.sleep(for: .milliseconds(10)) }
        #expect(try await condition())
    }

    private let edit = RowEdit.set(table: "Game", row: RowQueueTests.chess, field: "status", before: .string("Draft"), value: .string("Polished"), at: "2026-10-25T09:00:00.000Z")

    @Test("A queued edit shows at once, survives being offline and goes to the host as a derived candidate")
    func queuedAndSent() async throws {
        try await withRoot { root in
            let (snapshot, games) = try gamesTree()
            let transport = RowTransport(snapshot: snapshot, offline: 1) { prepared in
                let update = ProtocolAcceptedUpdate(id: "up_rows", tree: Self.tree.rawValue, root: snapshot.root,
                    previous: .init(id: "up_initial", root: snapshot.root), acceptedAt: 1_800_000_000_000)
                return ProtocolUpdateResponse(results: [.init(result: .accepted(update), requestDigest: prepared.requestDigests[0], candidate: snapshot.root)],
                    head: .init(update: "up_rows", root: snapshot.root, conflicted: false, observedThrough: "up_rows"))
            }
            let (coordinator, provider) = try await open(snapshot, at: root, transport: transport)
            #expect(try await status(provider) == .string("Draft"))
            try await provider.appendRowEdits([edit], to: WorkspaceReference(tree: Self.tree, path: "/games"))
            #expect(try await status(provider) == .string("Polished"))

            // Offline first; the retry is the same request.
            try await waitUntil { await transport.requests.count >= 2 }
            let requests = await transport.requests
            #expect(requests[0].body == requests[1].body)
            let request = try ProtocolWireEncoding.cbor.decode(ProtocolAuthoredUpdateRequest.self, from: requests[1].body)
            #expect(request.base == "up_initial")
            let element = try #require(request.updates.first?.intentFields)
            #expect(element["candidate"] == .null)
            let frame = try #require(element["trace"]?.items?.first?.fields)
            #expect(frame["before"] == nil && frame["after"] == nil)
            let operation = try #require(frame["operations"]?.items?.first?.fields)
            #expect(operation["kind"] == .string("set") && operation["model"] == .string("Game") && operation["row"] == .string(Self.chess))
            #expect(operation["collection"]?.fields?["material"]?.fields?["object"] == .string(games))
            #expect(operation["collection"]?.fields?["material"]?.fields?["path"] == .string("/games"))

            // Accepted, but shown until the tree installs the result.
            try await waitUntil { (try? await coordinator.rowQueue().submission?.accepted) != nil }
            #expect(try await status(provider) == .string("Polished"))
            await coordinator.close()
        }
    }

    @Test("Edits the host refuses are dropped and say why")
    func refused() async throws {
        try await withRoot { root in
            let (snapshot, _) = try gamesTree()
            let transport = RowTransport(snapshot: snapshot, offline: 0) { _ in
                throw ProtocolHTTPError(status: 400, code: "invalid-request", message: "Invalid row operation: status does not have the value seen", retryable: false)
            }
            let (coordinator, provider) = try await open(snapshot, at: root, transport: transport)
            try await provider.appendRowEdits([edit], to: WorkspaceReference(tree: Self.tree, path: "/games"))
            try await waitUntil { await coordinator.refusedRowEdits() != nil }
            #expect(try await status(provider) == .string("Draft"))
            #expect(await coordinator.pendingRowEdits(collection: "/games").isEmpty)
            await coordinator.close()
        }
    }
}
