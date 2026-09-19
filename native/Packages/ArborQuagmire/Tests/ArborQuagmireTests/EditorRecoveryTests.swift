import ArborKit
@testable import ArborQuagmire
import Foundation
import Quagmire
import Testing

@MainActor
struct EditorRecoveryTests {
    private func root() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appending(path: "editor-recovery-\(UUID())")
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    private func edit(_ binding: ArborDocumentBinding, _ text: String, commit: Bool = true) {
        binding.document.transaction(name: "Typing") {
            _ = binding.document.setText(binding.document.children[0].id, AttributedString(text))
        }
        if commit { binding.admitCurrentGeneration() }
    }

    @Test("An intent-aware session receives the exact editor basis after its projection advances")
    func staleIntentReachesProvider() async throws {
        let root = try root(); defer { try? FileManager.default.removeItem(at: root) }
        let session = RecoverySession()
        await session.enableIntentRetention()
        let binding = try await ArborDocumentBinding.open(reference: session.reference, session: session,
                                                          debounce: .seconds(3600), recoveryRoot: root)
        edit(binding, "Mine")
        await session.replace("Peer at R2\n")
        await binding.flush()
        let intent = try #require(await session.retainedIntent)
        #expect(intent.basis.source == "Before\n")
        #expect(intent.basis.contentRevision == "initial")
        #expect(intent.source == "Mine\n\n")
        #expect(try intent.patch.applying(to: intent.basis.source) == intent.source)
        #expect(binding.conflict == nil)
        let store = try EditorRecoveryStore(root: root, reference: session.reference)
        let record = try #require(try store.revisions().first)
        #expect(try store.intent(record) == intent)
        await binding.close()
    }

    @Test("Retained-basis recovery retries the original draft after a remote advance without local review")
    func retainedBasisRecovery() async throws {
        let root = try root(); defer { try? FileManager.default.removeItem(at: root) }
        let session = RecoverySession()
        await session.enableIntentRetention()
        var first: ArborDocumentBinding? = try await .open(reference: session.reference, session: session,
                                                           debounce: .seconds(3600), recoveryRoot: root)
        edit(try #require(first), "Retained draft")
        first = nil
        await session.replace("Peer at R2\n")
        let reopened = try await ArborDocumentBinding.open(reference: session.reference, session: session,
                                                            debounce: .seconds(3600), recoveryRoot: root)
        #expect(reopened.conflict == nil)
        await reopened.flush()
        let intent = try #require(await session.retainedIntent)
        #expect(intent.basis.contentRevision == "initial")
        #expect(intent.basis.source == "Before\n")
        #expect(intent.source == "Retained draft\n\n")
        await reopened.close()
    }

    @Test("A retained-basis provider cannot request local review or acknowledge by byte equality", arguments: [false, true])
    func retainedBasisRejectsLegacyConflict(stalePatch: Bool) async throws {
        let root = try root(); defer { try? FileManager.default.removeItem(at: root) }
        let session = RecoverySession()
        await session.enableIntentRetention()
        await session.rejectRetainedAdmission(stalePatch: stalePatch)
        let binding = try await ArborDocumentBinding.open(reference: session.reference, session: session,
            debounce: .seconds(3600), recoveryRoot: root)
        edit(binding, "Mine")
        await session.replace("Mine\n\n")
        await binding.flush()
        #expect(binding.conflict == nil)
        #expect(binding.admissionState.kind == "failed")
        #expect(binding.admissionState.accepted.revision == "initial")
        #expect(binding.lastError != nil)
        let store = try EditorRecoveryStore(root: root, reference: session.reference)
        let retained = try #require(try store.revisions().first)
        #expect(!store.isSaved(retained))
        #expect(try store.intent(retained)?.basis.source == "Before\n")
        await binding.close()
    }

    @Test("Recovery retains exact guarded edits and legacy records remain readable")
    func retainedIntentValidation() throws {
        let root = try root(); defer { try? FileManager.default.removeItem(at: root) }
        let reference = WorkspaceReference(tree: "tr_one", path: "/page")
        let store = try EditorRecoveryStore(root: root, reference: reference)
        var record = try store.record(reference: reference, source: "After 🪴\r\n",
                                      base: .init(reference: reference, source: "Before 🪴\r\n", contentRevision: "r1"))
        let reopened = try EditorRecoveryStore(root: root, reference: reference)
        let recovered = try #require(try reopened.revisions().first)
        #expect(try reopened.intent(recovered)?.basis.source == "Before 🪴\r\n")
        record.patch?.baseContentRevision = "r2"
        #expect(throws: (any Error).self) { try reopened.intent(record) }
        var legacy = try #require(try JSONSerialization.jsonObject(with: JSONEncoder().encode(recovered)) as? [String: Any])
        legacy.removeValue(forKey: "patch")
        let old = try JSONDecoder().decode(EditorRecoveryStore.Revision.self, from: JSONSerialization.data(withJSONObject: legacy))
        #expect(try reopened.intent(old) == nil)
        #expect(try reopened.source(old) == "After 🪴\r\n")
    }

    @Test("The latest offline draft survives process loss before debounce and retries on reopen")
    func draftSurvivesRestart() async throws {
        let root = try root(); defer { try? FileManager.default.removeItem(at: root) }
        let session = RecoverySession()
        var first: ArborDocumentBinding? = try await .open(reference: session.reference, session: session, debounce: .seconds(3600), recoveryRoot: root)
        edit(try #require(first), "Offline draft")
        edit(try #require(first), "Latest offline draft")
        #expect(await session.attempts == 0)
        first = nil // simulate loss without lifecycle flush
        let reopened = try await ArborDocumentBinding.open(reference: session.reference, session: session, recoveryRoot: root)
        #expect(String(reopened.document.children[0].text.characters) == "Latest offline draft")
        await reopened.flush()
        #expect(await session.snapshot().source == "Latest offline draft\n\n")
        #expect(try await reopened.history().count == 2)
        await reopened.close()
    }

    @Test("Continued editing after a failed save retains the newest draft and a changed remote base requires review")
    func failureAndDivergence() async throws {
        let root = try root(); defer { try? FileManager.default.removeItem(at: root) }
        let session = RecoverySession()
        await session.setFailing(true)
        var first: ArborDocumentBinding? = try await .open(reference: session.reference, session: session, recoveryRoot: root)
        edit(try #require(first), "First offline edit")
        await first?.flush()
        #expect(first?.lastError != nil)
        #expect(first?.latestEditIsRetainedInRecovery == true)
        edit(try #require(first), "Hours of offline work")
        #expect(first?.latestEditIsRetainedInRecovery == true)
        first = nil
        await session.setFailing(false)
        await session.replace("Remote change\n")
        let reopened = try await ArborDocumentBinding.open(reference: session.reference, session: session, recoveryRoot: root)
        #expect(String(reopened.document.children[0].text.characters) == "Hours of offline work")
        #expect(reopened.conflict?.submittedSource == "Hours of offline work\n\n")
        #expect(reopened.conflict?.current.source == "Remote change\n")
        #expect(await session.attempts == 1)
        try await reopened.resolveConflict(preferSubmitted: true)
        #expect(await session.snapshot().source == "Hours of offline work\n\n")
        await reopened.close()
    }

    @Test("Acknowledgement preserves local history without replaying old edits over a newer remote version")
    func savedHistory() async throws {
        let root = try root(); defer { try? FileManager.default.removeItem(at: root) }
        let session = RecoverySession()
        let first = try await ArborDocumentBinding.open(reference: session.reference, session: session, recoveryRoot: root)
        edit(first, "Saved edit")
        await first.flush()
        let history = try await first.history()
        #expect(history.count == 1)
        await first.close()
        await session.replace("Later remote edit\n")
        let reopened = try await ArborDocumentBinding.open(reference: session.reference, session: session, recoveryRoot: root)
        #expect(String(reopened.document.children[0].text.characters) == "Later remote edit")
        #expect(reopened.conflict == nil)
        _ = try await reopened.recover(revision: try #require(history.first).revision)
        #expect(await session.snapshot().source == "Saved edit\n\n")
        #expect(try await reopened.history().count >= 2)
        await reopened.close()
    }

    @Test("Flush captures an edit whose commit callback has not fired")
    func uncommittedKeystroke() async throws {
        let root = try root(); defer { try? FileManager.default.removeItem(at: root) }
        let session = RecoverySession()
        let binding = try await ArborDocumentBinding.open(reference: session.reference, session: session, recoveryRoot: root)
        edit(binding, "Last keystroke", commit: false)
        await binding.flush()
        #expect(await session.snapshot().source == "Last keystroke\n\n")
        #expect(try await binding.history().count == 1)
        await binding.close()
    }

    @Test("An acknowledgement cannot overwrite a keystroke waiting for its commit callback")
    func uncommittedSuccessor() async throws {
        let root = try root(); defer { try? FileManager.default.removeItem(at: root) }
        let session = RecoverySession()
        await session.pauseNextAdmission()
        let binding = try await ArborDocumentBinding.open(reference: session.reference, session: session, recoveryRoot: root)
        edit(binding, "First generation")
        let flushing = Task { await binding.flush() }
        for _ in 0..<200 where !(await session.isPaused) { try await Task.sleep(for: .milliseconds(1)) }
        #expect(await session.isPaused)
        edit(binding, "Newer keystroke", commit: false)
        await session.resumeAdmission()
        await flushing.value
        #expect(String(binding.document.children[0].text.characters) == "Newer keystroke")
        #expect(await session.snapshot().source == "Newer keystroke\n\n")
        #expect(try await binding.history().count == 2)
        await binding.close()
    }

    @Test("A coalesced list successor retains exact intermediate formatting")
    func coalescedListSuccessorPreservesExactSource() async throws {
        let root = try root(); defer { try? FileManager.default.removeItem(at: root) }
        let session = RecoverySession(source: "Before\n\nAfter\n")
        await session.pauseNextAdmission()
        let binding = try await ArborDocumentBinding.open(
            reference: session.reference,
            session: session,
            recoveryRoot: root
        )

        let bullet = Block.bullet(text: AttributedString())
        binding.document.transaction(name: "Insert list item") {
            _ = binding.document.insertSubtree(bullet, at: .init(parent: nil, position: 1))
        }
        binding.admitCurrentGeneration()
        let flushing = Task { await binding.flush() }
        for _ in 0..<200 where !(await session.isPaused) {
            try await Task.sleep(for: .milliseconds(1))
        }
        #expect(await session.isPaused)

        binding.document.transaction(name: "Type list item") {
            _ = binding.document.setText(bullet.id, AttributedString("the conflict stuff is buggy / weird"))
        }
        binding.admitCurrentGeneration()
        binding.document.transaction(name: "Continue list") {
            _ = binding.document.insertSubtree(
                .bullet(text: AttributedString()),
                at: .init(parent: bullet.id, position: 0)
            )
        }
        binding.admitCurrentGeneration()
        let expected = try #require(binding.lastEnqueuedSource)
        #expect(expected.contains("- the conflict stuff is buggy / weird\n\n  - \n\n"))
        await session.resumeAdmission()
        await flushing.value

        #expect(binding.lastError == nil)
        #expect(await session.snapshot().source == expected)
        await binding.close()
    }

    @Test("A retained draft keeps its generations and recovery replays them as one chain")
    func recoveredGenerationsReplayAsFrames() async throws {
        let root = try root(); defer { try? FileManager.default.removeItem(at: root) }
        let session = RecoverySession(source: "Before\n\nAfter\n")
        await session.enableIntentRetention()
        await session.rejectRetainedAdmission(stalePatch: true)
        var binding: ArborDocumentBinding? = try await .open(reference: session.reference, session: session, debounce: .seconds(60), recoveryRoot: root)
        let bullet = Block.bullet(text: AttributedString())
        binding?.document.transaction(name: "Insert list item") { _ = binding?.document.insertSubtree(bullet, at: .init(parent: nil, position: 1)) }
        binding?.admitCurrentGeneration()
        binding?.document.transaction(name: "Type list item") { _ = binding?.document.setText(bullet.id, AttributedString("typed")) }
        binding?.admitCurrentGeneration()
        binding?.document.transaction(name: "Continue list") {
            _ = binding?.document.insertSubtree(.bullet(text: AttributedString()), at: .init(parent: bullet.id, position: 0))
        }
        binding?.admitCurrentGeneration()
        binding?.document.transaction(name: "Reorder") {
            if let document = binding?.document { _ = document.replaceChildrenReconciled(Array(document.children.reversed())) }
        }
        binding?.admitCurrentGeneration()
        let expected = try #require(binding?.lastEnqueuedSource)
        await binding?.flush()
        // The provider rejected the chain; the journal retains it as captured.
        #expect(binding?.lastError != nil)
        let store = try EditorRecoveryStore(root: root, reference: session.reference)
        let record = try #require(try store.revisions().first)
        let retained = try #require(try store.intent(record))
        #expect(retained.generations.count == 4)
        #expect(retained.source == expected)
        // The three list edits are plain insertions; the reorder carries lineage
        // against the exact source the third generation produced.
        let lineage = retained.generations.map { $0.patch.edits.contains { !($0.lineage ?? []).isEmpty } }
        #expect(lineage == [false, false, false, true], Comment(rawValue: "\(lineage)"))
        await binding?.close(); binding = nil

        // Reopen against a provider that accepts: the chain is replayed as the
        // machine's generations and admitted as one multi-generation intent.
        let reopened = RecoverySession(source: "Before\n\nAfter\n")
        await reopened.enableIntentRetention()
        let restored = try await ArborDocumentBinding.open(reference: reopened.reference, session: reopened, debounce: .seconds(60), recoveryRoot: root)
        #expect(restored.admissionState.pendingGenerations.count == 4)
        await restored.flush()
        #expect(restored.lastError == nil)
        let admitted = try #require(await reopened.retainedIntent)
        #expect(admitted.generations == retained.generations)
        #expect(admitted.source == expected)
        #expect(await reopened.snapshot().source == expected)
        await restored.close()
    }

    @Test("Recovery is tree scoped, follows stable identity through moves, and verifies exact source bytes")
    func identityAndIntegrity() throws {
        let root = try root(); defer { try? FileManager.default.removeItem(at: root) }
        let reference = WorkspaceReference(tree: "tr_one", path: "/old", stableKey: "md:page")
        let store = try EditorRecoveryStore(root: root, reference: reference)
        let source = "---\r\nid: page\r\n---\r\n- exact  spaces\r\n"
        let record = try store.record(reference: reference, source: source, base: .init(reference: reference, source: "Before", contentRevision: "base"))
        let moved = try EditorRecoveryStore(root: root, reference: .init(tree: "tr_one", path: "/new", stableKey: "md:page"))
        #expect(try moved.source(record) == source)
        let other = try EditorRecoveryStore(root: root, reference: .init(tree: "tr_other", path: "/old", stableKey: "md:page"))
        #expect(try other.revisions().isEmpty)
        try Data("corrupt".utf8).write(to: store.directory.appending(path: "sources/\(record.sourceHash).md"))
        #expect(throws: (any Error).self) { try store.source(record) }
    }

    @Test("A checkpoint write failure remains visible even when the provider accepts the edit")
    func checkpointFailure() async throws {
        let root = try root(); defer { try? FileManager.default.removeItem(at: root) }
        let session = RecoverySession()
        let binding = try await ArborDocumentBinding.open(reference: session.reference, session: session, recoveryRoot: root)
        let store = try EditorRecoveryStore(root: root, reference: session.reference)
        try FileManager.default.removeItem(at: store.directory.appending(path: "sources"))
        edit(binding, "Must report recovery failure")
        await binding.flush()
        #expect(binding.recoveryError != nil)
        #expect(binding.lastError != nil)
        #expect(await session.snapshot().source == "Must report recovery failure\n\n")
        await binding.close()
    }
}

private actor RecoverySession: WorkspaceDocumentSession {
    struct Offline: Error {}
    nonisolated let reference = WorkspaceReference(tree: "tr_recovery", path: "/", stableKey: "md:page")
    nonisolated var identity: WorkspaceIdentity { reference.identity }
    var attempts = 0
    var failing = false
    private var pause = false
    private var continuation: CheckedContinuation<Void, Never>?
    var isPaused: Bool { continuation != nil }
    func pauseNextAdmission() { pause = true }
    func resumeAdmission() { continuation?.resume(); continuation = nil }
    var current: WorkspaceDocumentSnapshot
    init(source: String = "Before\n") {
        current = .init(reference: reference, source: source, contentRevision: "initial")
    }
    private var acceptsIntent = false
    private var rejectRetained: Bool?
    func rejectRetainedAdmission(stalePatch: Bool) { rejectRetained = stalePatch }
    var retainedIntent: WorkspaceDocumentIntent?
    var admissionPolicy: WorkspaceAdmissionPolicy { acceptsIntent ? .retainedBasis : .compareAndSwap }
    func enableIntentRetention() { acceptsIntent = true }
    func admit(intent: WorkspaceDocumentIntent) async throws -> WorkspaceDocumentSnapshot {
        try intent.validate()
        if !acceptsIntent { return try await admit(patch: intent.patch) }
        if let rejectRetained {
            if rejectRetained { throw WorkspacePatchError.staleRevision(expected: intent.basis.contentRevision, actual: current.contentRevision) }
            throw WorkspaceDocumentConflict(base: intent.basis, current: current, submittedSource: intent.source)
        }
        retainedIntent = intent
        attempts += 1
        replace(intent.source)
        return current
    }
    func setFailing(_ value: Bool) { failing = value }
    func replace(_ source: String) { current = .init(reference: reference, source: source, contentRevision: UUID().uuidString) }
    func snapshot() -> WorkspaceDocumentSnapshot { current }
    func admit(source: String, baseContentRevision: String) async throws -> WorkspaceDocumentSnapshot {
        attempts += 1
        if pause {
            pause = false
            await withCheckedContinuation { continuation = $0 }
        }
        if failing { throw Offline() }
        guard current.contentRevision == baseContentRevision else {
            throw WorkspaceDocumentConflict(current: current, submittedSource: source)
        }
        replace(source)
        return current
    }
    func flush() {}
    func history() -> [WorkspaceHistoryEntry] { [] }
    func recover(revision: String) -> WorkspaceDocumentSnapshot { current }
    func close() {}
}
