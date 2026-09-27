import CanopyAppKit
@testable import CanopyWorkingTree
@testable import Overstory
import Foundation
import Testing

/// Executes `tests/fixtures/update-runner.json` against the Swift runner: a
/// real `UpdateCoordinator`, change log and working tree over a scripted host.
@Suite("Update runner vectors")
struct RunnerVectorTests {
    struct Fixture: Decodable {
        struct Scenario: Decodable {
            let name: String
            let document: String
            let responses: [String]?
            let steps: [Step]
        }
        struct Step: Decodable {
            let append: String?
            let sync: Bool?
            let transport: Bool?
            let restart: Bool?
            let restartWithJSONAttempt: Bool?
            let discardHeld: Bool?
            let expect: Expectation?
        }
        struct Expectation: Decodable {
            let phase: String?
            let requests: Int?
            let lastElements: Int?
            let repeatsPrefix: Bool?
            let sameBody: Bool?
            let sameDigests: Bool?
            let lastEncoding: String?
            let pending: Int?
            let document: String?
        }
        let scenarios: [Scenario]
    }

    static let tree: TreeID = "tr_runner_vectors"

    @Test("Every runner vector performs the same effects and leaves the same durable state")
    func runnerVectors() async throws {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appending(path: "../../../../../tests/fixtures/update-runner.json")
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
        #expect(!fixture.scenarios.isEmpty)
        for scenario in fixture.scenarios { try await run(scenario) }
    }

    private func run(_ scenario: Fixture.Scenario) async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "runner-vector-\(UUID().uuidString)", directoryHint: .isDirectory)
        defer { try? FileManager.default.removeItem(at: root) }
        let initial = try Self.snapshot(markdown: scenario.document)
        let host = VectorHost(tree: Self.tree.rawValue, initial: initial, script: scenario.responses ?? [])
        let workingTree = try await WorkingTree.inMemory(tree: Self.tree)
        try await workingTree.initializeFromSystem(SnapshotBridge.replacement(snapshot: initial, tree: Self.tree, update: "up_initial", cursor: "up_initial"))
        func open() throws -> UpdateCoordinator {
            try UpdateCoordinator(workingTree: workingTree, transport: host, stateRoot: root,
                                  publicationDelay: .seconds(3600), publicationMaxDelay: .seconds(3600))
        }
        var coordinator = try open()
        func session() async throws -> any WorkspaceDocumentSession {
            try await WorkingTreeProvider(workingTree: workingTree, coordinator: coordinator)
                .openDocument(.init(tree: Self.tree, path: "/note"))
        }
        for (index, step) in scenario.steps.enumerated() {
            let label = Comment(rawValue: "\(scenario.name) / step \(index + 1)")
            if let text = step.append {
                let document = try await session()
                let current = try await document.snapshot()
                let end = current.source.utf8.count
                _ = try await document.admit(patch: .init(baseContentRevision: current.contentRevision,
                    edits: [.init(utf8Range: end..<end, replacement: text)]))
                await document.close()
            }
            if step.sync == true { _ = try await coordinator.syncOnce() }
            if let available = step.transport { await coordinator.setTransportAvailable(available) }
            if step.restart == true {
                await coordinator.close()
                coordinator = try open()
            }
            if step.restartWithJSONAttempt == true {
                await coordinator.close()
                try Self.rewriteAttemptAsJSON(stateRoot: root)
                coordinator = try open()
            }
            if step.discardHeld == true { try await coordinator.discardHeldChanges() }
            guard let expect = step.expect else { continue }
            if let phase = expect.phase {
                // A fresh runner enters the machine on its first operation.
                _ = try await coordinator.watchCursor()
                #expect(await coordinator.syncState.kind == phase, label)
            }
            let requests = await host.requests
            if let count = expect.requests { #expect(requests.count == count, label) }
            if let elements = expect.lastElements {
                let last = try #require(requests.last).decodedRequest()
                #expect(last.updates.count == elements, label)
            }
            if expect.repeatsPrefix == true, requests.count >= 2 {
                let previous = requests[requests.count - 2].requestDigests, last = requests[requests.count - 1].requestDigests
                #expect(last.starts(with: previous) && last.count > previous.count, label)
            }
            if expect.sameBody == true, requests.count >= 2 {
                #expect(requests[requests.count - 2].body == requests[requests.count - 1].body, label)
            }
            if expect.sameDigests == true, requests.count >= 2 {
                #expect(requests[requests.count - 2].requestDigests == requests[requests.count - 1].requestDigests, label)
            }
            if let encoding = expect.lastEncoding {
                #expect(try #require(requests.last).encoding == (encoding == "cbor" ? .cbor : .json), label)
            }
            if let pending = expect.pending { #expect(try await coordinator.pendingLocalChanges().count == pending, label) }
            if let document = expect.document {
                let reader = try await session()
                #expect(try await reader.snapshot().source == document, label)
                await reader.close()
            }
        }
        await coordinator.close()
        await workingTree.close()
    }

    /// Rewrite the persisted attempt as a client wrote it before bodies could
    /// be CBOR: the request's sorted-key JSON, with no content type.
    static func rewriteAttemptAsJSON(stateRoot: URL) throws {
        let url = stateRoot.appending(path: "sync/update-control.json")
        var control = try JSONDecoder().decode(UpdateControl.self, from: Data(contentsOf: url))
        guard var attempt = control.attempt else { throw UpdateError.requestEmpty }
        attempt.body = try sortedKeysJSON(try attempt.request())
        attempt.contentType = nil
        control.attempt = attempt
        try sortedKeysJSON(control).write(to: url)
    }

    static func snapshot(markdown: String) throws -> ProtocolSnapshot {
        let file = try ProtocolObjectCodec.object(.file(Data(markdown.utf8)))
        let root = try ProtocolObjectCodec.object(.directory([.init(name: "note.md", file: file.hash)]))
        return ProtocolSnapshot(root: root.hash, objects: [file, root].sorted { $0.hash < $1.hash })
    }
}

/// A scripted host: accepts every element as submitted and keeps its receipts
/// so an exact retry returns them, or refuses, fails, or loses the response.
private actor VectorHost: UpdateTransport {
    let tree: String
    private var script: [String]
    private(set) var requests: [PreparedProtocolUpdate] = []
    private var current: ProtocolSnapshot
    private var currentUpdate = "up_initial"
    private var snapshots: [String: ProtocolSnapshot]
    private var receipts: [String: ProtocolUpdateElementResult] = [:]
    private var accepted = 0

    init(tree: String, initial: ProtocolSnapshot, script: [String]) {
        self.tree = tree
        self.current = initial
        self.snapshots = [initial.root: initial]
        self.script = script
    }

    func submit(_ prepared: PreparedProtocolUpdate) async throws -> ProtocolUpdateResponse {
        requests.append(prepared)
        let action = script.isEmpty ? "accept" : script.removeFirst()
        // The host reads a body in the encoding its prepared content type names.
        let request = try prepared.decodedRequest()
        switch action {
        case "fail":
            throw URLError(.networkConnectionLost)
        case "reject":
            let head = ProtocolAcceptedUpdate(id: currentUpdate, tree: tree, root: current.root, previous: nil, acceptedAt: 1_800_000_000_000)
            throw ProtocolUpdateConflictError(conflict: ProtocolUpdateConflict(message: "refused", current: head, conflicts: []))
        case "unsupported":
            throw ProtocolHTTPError(status: 422, code: "unsupported-operation", message: "moveSource", retryable: false)
        default:
            break
        }
        var results: [ProtocolUpdateElementResult] = []
        var known = snapshots[current.root] ?? current
        for (index, element) in request.updates.enumerated() {
            let digest = prepared.requestDigests[index]
            let candidate = try snapshots[element.candidate] ?? complete(element, retained: known)
            snapshots[candidate.root] = candidate
            known = candidate
            if let receipt = receipts[digest] { results.append(receipt); continue }
            accepted += 1
            let update = ProtocolAcceptedUpdate(id: "up_\(accepted)", tree: tree, root: candidate.root,
                previous: .init(id: currentUpdate, root: current.root), acceptedAt: 1_800_000_000_000)
            let result = ProtocolUpdateElementResult(result: .accepted(update), requestDigest: digest)
            receipts[digest] = result
            results.append(result)
            current = candidate
            currentUpdate = update.id
        }
        if action == "acceptThenFail" { throw URLError(.networkConnectionLost) }
        return ProtocolUpdateResponse(results: results, observedThrough: currentUpdate)
    }

    func descriptor(tree: String) async throws -> ProtocolCurrentTree {
        ProtocolCurrentTree(tree: ProtocolTreeDescriptor(id: tree, kind: "ordinary", root: current.root, access: "write",
            canonical: nil, update: currentUpdate), observedThrough: currentUpdate)
    }

    func snapshot(tree _: String, root: String) async throws -> ProtocolSnapshot {
        guard let snapshot = snapshots[root] else { throw UpdateError.returnedSnapshotMissing }
        return snapshot
    }

    private func complete(_ element: ProtocolCandidateUpdate, retained: ProtocolSnapshot) throws -> ProtocolSnapshot {
        var envelopes = Dictionary(uniqueKeysWithValues: retained.objects.map { ($0.hash, $0) })
        for object in element.objects { envelopes[object.hash] = object }
        for delta in element.deltas {
            guard let base = envelopes[delta.base] else { throw UpdateError.returnedSnapshotMissing }
            envelopes[delta.result] = ProtocolObjectEnvelope(hash: delta.result, bytes: try delta.apply(to: base.bytes))
        }
        var pending = [(element.candidate, ProtocolEntryKind.directory)], seen = Set<String>(), objects: [ProtocolObjectEnvelope] = []
        while let (hash, kind) = pending.popLast() {
            guard seen.insert(hash).inserted else { continue }
            guard let envelope = envelopes[hash] else { throw UpdateError.returnedSnapshotMissing }
            objects.append(envelope)
            if case let .directory(entries, _) = try ProtocolObjectCodec.decode(envelope.bytes, kind: kind) {
                for entry in entries { if let hash = entry.hash, let kind = entry.kind { pending.append((hash, kind)) } }
            }
        }
        return ProtocolSnapshot(root: element.candidate, objects: objects.sorted { $0.hash < $1.hash })
    }
}
