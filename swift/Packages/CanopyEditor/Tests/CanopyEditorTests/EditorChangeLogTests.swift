import CanopyAppKit
import Overstory
@testable import CanopyWorkingTree
@testable import CanopyEditor
import Foundation
import Quagmire
import Testing

/// The editor over a real working tree, change log and runner, without a host:
/// the change log is the only recovery record, and publication never runs.
@MainActor
@Suite("Editor on the change log")
struct EditorChangeLogTests {
    private let tree: TreeID = "tr_editor_log"

    private func placed(_ source: String) async throws -> WorkingTree {
        let file = try ProtocolObjectCodec.object(.file(Data(source.utf8)))
        let root = try ProtocolObjectCodec.object(.directory([.init(name: "note.md", file: file.hash)]))
        let snapshot = ProtocolSnapshot(root: root.hash, objects: [file, root].sorted { $0.hash < $1.hash })
        let workingTree = try await WorkingTree.inMemory(tree: tree)
        try await workingTree.initializeFromSystem(SnapshotBridge.replacement(snapshot: snapshot, tree: tree, update: "up_initial"))
        return workingTree
    }

    private func type(_ text: String, into binding: CanopyDocumentBinding) {
        let paragraph = binding.document.children[binding.document.children.count - 1].id
        binding.document.transaction(name: "Typing") {
            _ = binding.document.setText(paragraph, AttributedString(text))
        }
        binding.appendCurrentGeneration()
    }

    @Test("Every generation is durable in the change log once appended, and a reopened editor shows it")
    func reopenFromChangeLog() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "editor-log-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let workingTree = try await placed("# Note\n\nBefore\n")
        let reference = WorkspaceReference(tree: tree, path: "/note")
        var coordinator = try UpdateCoordinator(workingTree: workingTree, transport: OfflineTransport(), stateRoot: root,
            transportAvailable: false, publicationDelay: .seconds(3600), publicationMaxDelay: .seconds(3600))
        var session = try await WorkingTreeProvider(workingTree: workingTree, coordinator: coordinator).openDocument(reference)
        var binding = try await CanopyDocumentBinding.open(reference: reference, session: session)
        type("First", into: binding)
        type("Second", into: binding)
        await binding.flush()
        #expect(binding.lastError == nil)
        #expect(!binding.isSaving)
        let changes = try await ChangeLog(tree: tree.rawValue, stateRoot: root).retained()
        #expect(changes.count == 2)
        #expect(changes[1].basis == .authored(change: changes[0].change))
        // The accepted tree is untouched; the editor reads its own writes.
        let written = try #require(binding.lastEnqueuedSource)
        #expect(try await workingTree.captureSourceBasis(reference).document.source == "# Note\n\nBefore\n")
        #expect(try await session.snapshot().source == written)

        // Lose the editor and the runner without closing either.
        binding.stopObserving()
        await coordinator.close()
        coordinator = try UpdateCoordinator(workingTree: workingTree, transport: OfflineTransport(), stateRoot: root,
            transportAvailable: false, publicationDelay: .seconds(3600), publicationMaxDelay: .seconds(3600))
        session = try await WorkingTreeProvider(workingTree: workingTree, coordinator: coordinator).openDocument(reference)
        binding = try await CanopyDocumentBinding.open(reference: reference, session: session)
        #expect(try await session.snapshot().source == written)
        #expect(binding.document.children.last.map { String($0.text.characters) } == "Second")
        // Editing continues on the retained chain.
        type("Third", into: binding)
        await binding.flush()
        let continued = try await ChangeLog(tree: tree.rawValue, stateRoot: root).retained()
        #expect(continued.count == 3)
        #expect(continued[2].basis == .authored(change: continued[1].change))
        await binding.close()
        await coordinator.close()
    }

    @Test("A failed append leaves the edit in the editor, reports it, and a retry makes it durable")
    func failedAppendRetries() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "editor-log-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let workingTree = try await placed("# Note\n\nBefore\n")
        let reference = WorkspaceReference(tree: tree, path: "/note")
        let coordinator = try UpdateCoordinator(workingTree: workingTree, transport: OfflineTransport(), stateRoot: root,
            transportAvailable: false, publicationDelay: .seconds(3600), publicationMaxDelay: .seconds(3600))
        let session = try await WorkingTreeProvider(workingTree: workingTree, coordinator: coordinator).openDocument(reference)
        let binding = try await CanopyDocumentBinding.open(reference: reference, session: session)
        let journal = root.appending(path: "sync/change-log.json")
        // A directory at the journal forces the atomic write to fail.
        try FileManager.default.createDirectory(at: journal, withIntermediateDirectories: true)
        type("Kept in the editor", into: binding)
        await binding.flush()
        #expect(binding.lastError != nil)
        #expect(binding.isSaving)
        #expect(binding.document.children.last.map { String($0.text.characters) } == "Kept in the editor")
        try FileManager.default.removeItem(at: journal)
        await binding.retryLastSave()
        #expect(binding.lastError == nil)
        #expect(!binding.isSaving)
        #expect(try await ChangeLog(tree: tree.rawValue, stateRoot: root).retained().count == 1)
        await binding.close()
        await coordinator.close()
    }
}

private struct OfflineTransport: UpdateTransport {
    func submit(_ prepared: PreparedProtocolUpdate) async throws -> ProtocolUpdateResponse { throw URLError(.notConnectedToInternet) }
    func descriptor(tree: String) async throws -> ProtocolCurrentTree { throw URLError(.notConnectedToInternet) }
    func snapshot(tree: String, root: String) async throws -> ProtocolSnapshot { throw URLError(.notConnectedToInternet) }
}
