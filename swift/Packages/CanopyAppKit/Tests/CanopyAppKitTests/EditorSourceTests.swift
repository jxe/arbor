import Foundation
import Testing
@testable import CanopyAppKit

@MainActor
@Suite("Editor source")
struct EditorSourceTests {
    private let reference = WorkspaceReference(tree: "tr_editor_source", path: "/note")

    private func append(_ text: String, to source: EditorSource) {
        let end = source.latestSource.utf8.count
        source.append(.init(patch: .init(baseContentRevision: "any", edits: [.init(utf8Range: end..<end, replacement: text)]),
                            source: source.latestSource + text))
    }

    @Test("A generation is appended at once; generations captured meanwhile follow as one change with a frame each")
    func batchesWhileAppending() async throws {
        let session = GatedSession(snapshot: .init(reference: reference, source: "Base\n", contentRevision: "r1"))
        let source = EditorSource(session: session, basis: try await session.snapshot())
        await session.hold()
        append("One\n", to: source)
        try await waitUntil { await session.holding }
        append("Two\n", to: source)
        append("Three\n", to: source)
        #expect(!source.isSettled)
        #expect(source.pending.count == 2)
        await session.release()
        await source.settle()
        let intents = await session.intents
        #expect(intents.count == 2)
        #expect(intents[0].generations.isEmpty)
        #expect(intents[0].source == "Base\nOne\n")
        // The batch is stated against the first append's acknowledgement, one frame per generation.
        #expect(intents[1].basis.contentRevision == "r2")
        #expect(intents[1].generations.map(\.source) == ["Base\nOne\nTwo\n", "Base\nOne\nTwo\nThree\n"])
        #expect(intents[1].generations.allSatisfy { $0.patch.baseContentRevision == "r2" })
        #expect(source.basis.source == "Base\nOne\nTwo\nThree\n")
        #expect(source.acknowledgements == 2)
    }

    @Test("A failed append keeps its generations and a retry sends them against the same basis")
    func failureKeepsGenerations() async throws {
        let session = GatedSession(snapshot: .init(reference: reference, source: "Base\n", contentRevision: "r1"))
        let source = EditorSource(session: session, basis: try await session.snapshot())
        var failures = 0
        source.onFailure = { _ in failures += 1 }
        await session.failNext()
        append("One\n", to: source)
        await source.settle()
        #expect(failures == 1)
        #expect(source.failure != nil)
        #expect(source.pending.map(\.source) == ["Base\nOne\n"])
        // Later work waits behind the failure instead of racing past it.
        append("Two\n", to: source)
        #expect(await session.intents.isEmpty)
        source.retry()
        await source.settle()
        #expect(source.failure == nil)
        let intents = await session.intents
        #expect(intents.count == 1)
        #expect(intents[0].basis.contentRevision == "r1")
        #expect(intents[0].generations.count == 2)
        #expect(source.basis.source == "Base\nOne\nTwo\n")
    }

    @Test("A chain that no longer replays becomes one exact replacement")
    func nonReplayingChain() throws {
        let basis = WorkspaceDocumentSnapshot(reference: reference, source: "Base\n", contentRevision: "r1")
        let wrong = WorkspaceDocumentGeneration(patch: .init(baseContentRevision: "r1", edits: [.init(utf8Range: 0..<0, replacement: "X")]),
                                                source: "Not what the patch makes\n")
        let intent = try EditorSource.intent(basis: basis, generations: [wrong])
        #expect(intent.generations.isEmpty)
        #expect(try intent.patch.applying(to: basis.source) == "Not what the patch makes\n")
    }

    @Test("Adoption waits until captured work is durable")
    func adoptionWaitsForSettlement() async throws {
        let session = GatedSession(snapshot: .init(reference: reference, source: "Base\n", contentRevision: "r1"))
        let source = EditorSource(session: session, basis: try await session.snapshot())
        await session.hold()
        append("Mine\n", to: source)
        try await waitUntil { await session.holding }
        source.adopt(.init(reference: reference, source: "Peer\n", contentRevision: "peer"))
        #expect(source.basis.contentRevision == "r1")
        await session.release()
        await source.settle()
        source.adopt(.init(reference: reference, source: "Peer\n", contentRevision: "peer"))
        #expect(source.basis.contentRevision == "peer")
    }

    private func waitUntil(_ condition: () async -> Bool) async throws {
        for _ in 0..<500 where !(await condition()) { try await Task.sleep(for: .milliseconds(2)) }
        #expect(await condition())
    }
}

private struct AppendFailure: Error {}

/// A session that records intents, can hold an append, and can fail the next one.
private actor GatedSession: WorkspaceDocumentSession {
    nonisolated let identity: WorkspaceIdentity
    private var current: WorkspaceDocumentSnapshot
    private(set) var intents: [WorkspaceDocumentIntent] = []
    private var gate: CheckedContinuation<Void, Never>?
    private var holdNext = false
    private var failing = false
    private(set) var holding = false

    init(snapshot: WorkspaceDocumentSnapshot) {
        identity = snapshot.reference.identity
        current = snapshot
    }

    func hold() { holdNext = true }
    func release() { gate?.resume(); gate = nil; holding = false }
    func failNext() { failing = true }

    func snapshot() -> WorkspaceDocumentSnapshot { current }
    func updates() -> AsyncThrowingStream<WorkspaceDocumentSnapshot, Error> { AsyncThrowingStream { _ in } }

    func admit(intent: WorkspaceDocumentIntent) async throws -> WorkspaceDocumentSnapshot {
        if holdNext {
            holdNext = false
            holding = true
            await withCheckedContinuation { gate = $0 }
        }
        if failing { failing = false; throw AppendFailure() }
        try intent.validate()
        guard intent.basis.contentRevision == current.contentRevision else {
            throw WorkspacePatchError.staleRevision(expected: intent.basis.contentRevision, actual: current.contentRevision)
        }
        intents.append(intent)
        current = .init(reference: current.reference, source: intent.source, contentRevision: "r\(intents.count + 1)")
        return current
    }

    func admit(source: String, baseContentRevision: String) throws -> WorkspaceDocumentSnapshot { throw AppendFailure() }
    func admit(patch: WorkspaceDocumentPatch) throws -> WorkspaceDocumentSnapshot { throw AppendFailure() }
    func flush() {}
    func history() -> [WorkspaceHistoryEntry] { [] }
    func recover(revision: String) -> WorkspaceDocumentSnapshot { current }
    func close() {}
}
