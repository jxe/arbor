import ArborKit
@testable import ArborQuagmire
import Foundation
import Quagmire
import Testing

@MainActor
struct DocumentConflictContinuationTests {
    @Test("Continued typing retains the conflict and Keep My Edit saves the latest generation")
    func continuedConflict() async throws {
        let session = BlockedAdmissionSession(firstAttempt: .conflict)
        let binding = try await ArborDocumentBinding.open(reference: session.reference, session: session)
        edit(binding, "First local edit")
        await binding.flush()
        let original = try #require(binding.conflict)

        edit(binding, "Latest local edit")
        await binding.flush()
        let conflict = try #require(binding.conflict)
        #expect(conflict.base == original.base)
        #expect(conflict.current == original.current)
        #expect(conflict.submittedSource == "Latest local edit\n\n")
        #expect(binding.lastError != nil)
        #expect(binding.admissionState.kind == "conflict")
        #expect(await session.attempts == 1)

        try await binding.resolveConflict(preferSubmitted: true)
        #expect(await session.snapshot().source == "Latest local edit\n\n")
        #expect(await session.attempts == 2)
        #expect(binding.admissionState.kind == "clean")
        #expect(binding.conflict == nil)
        #expect(binding.lastError == nil)
        edit(binding, "Next ordinary edit")
        await binding.flush()
        #expect(await session.snapshot().source == "Next ordinary edit\n\n")
        await binding.close()
    }

    @Test("Continued typing retains a save failure and Retry saves the latest generation")
    func continuedFailure() async throws {
        let session = BlockedAdmissionSession(firstAttempt: .failure)
        let binding = try await ArborDocumentBinding.open(reference: session.reference, session: session)
        edit(binding, "First local edit")
        await binding.flush()
        #expect(binding.lastError is BlockedAdmissionSession.Failure)
        edit(binding, "Latest local edit")
        #expect(binding.lastError is BlockedAdmissionSession.Failure)
        #expect(binding.admissionState.kind == "failed")
        #expect(await session.attempts == 1)
        await binding.retryLastSave()
        #expect(await session.snapshot().source == "Latest local edit\n\n")
        #expect(binding.lastError == nil)
        #expect(binding.admissionState.kind == "clean")
        await binding.close()
    }

    private func edit(_ binding: ArborDocumentBinding, _ text: String) {
        let id = binding.document.children[0].id
        binding.document.transaction(name: "Edit") {
            _ = binding.document.setText(id, AttributedString(text))
        }
        binding.admitCurrentGeneration()
    }
}

private actor BlockedAdmissionSession: WorkspaceDocumentSession {
    enum FirstAttempt { case conflict, failure }
    struct Failure: Error {}
    nonisolated let reference = WorkspaceReference(tree: "tr_conflict", path: "/")
    nonisolated var identity: WorkspaceIdentity { reference.identity }
    let firstAttempt: FirstAttempt
    var attempts = 0
    var current: WorkspaceDocumentSnapshot

    init(firstAttempt: FirstAttempt) {
        self.firstAttempt = firstAttempt
        current = .init(reference: reference, source: "Before\n", contentRevision: "r1")
    }
    func snapshot() -> WorkspaceDocumentSnapshot { current }
    func admit(source: String, baseContentRevision: String) throws -> WorkspaceDocumentSnapshot {
        attempts += 1
        if attempts == 1 {
            switch firstAttempt {
            case .failure: throw Failure()
            case .conflict:
                let base = current
                current = .init(reference: reference, source: "Remote\n", contentRevision: "r2")
                throw WorkspaceDocumentConflict(base: base, current: current, submittedSource: source)
            }
        }
        guard baseContentRevision == current.contentRevision else {
            throw WorkspaceDocumentConflict(current: current, submittedSource: source)
        }
        current = .init(reference: reference, source: source, contentRevision: "r-local-\(attempts)")
        return current
    }
    func flush() {}
    func history() -> [WorkspaceHistoryEntry] { [] }
    func recover(revision: String) -> WorkspaceDocumentSnapshot { current }
    func close() {}
}
