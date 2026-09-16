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
        edit(try #require(first), "Hours of offline work")
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
    init() { current = .init(reference: reference, source: "Before\n", contentRevision: "initial") }
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
