import StoryKit
@testable import StoryEditor
import Foundation
import Quagmire
import QuagmireExtras
import Testing

/// Blocks dragged from a page in one window to a page open in another: the
/// destination's host is asked first, then each editor applies its half, as
/// Quagmire's drop does.
@MainActor
@Suite("Drops between windows", .serialized)
struct WindowDropTests {
    struct Pair {
        var origin: StoryDocumentBinding
        var destination: StoryDocumentBinding
        var originHost: StoryEditorHost
        var destinationHost: StoryEditorHost
        var originSession: TransferPairSession
        var destinationSession: TransferPairSession
        var errors: ErrorLog
        /// Documents hold their undo managers weakly.
        var undoManagers: [UndoManager]
    }

    final class ErrorLog { var messages: [String] = [] }

    private func pair(origin: String, destination: String, originDirectory: String = "/", destinationDirectory: String = "/") async throws -> Pair {
        let originSession = TransferPairSession(.init(reference: .init(tree: "tr_drop", path: "/origin"), source: origin, contentRevision: "o1"))
        let destinationSession = TransferPairSession(.init(reference: .init(tree: "tr_drop", path: "/destination"), source: destination, contentRevision: "d1"))
        await originSession.setPeer(destinationSession)
        let a = try await StoryDocumentBinding.open(reference: .init(tree: "tr_drop", path: "/origin"), session: originSession)
        let b = try await StoryDocumentBinding.open(reference: .init(tree: "tr_drop", path: "/destination"), session: destinationSession)
        var undoManagers: [UndoManager] = []
        for binding in [a, b] {
            let undo = UndoManager(); undo.groupsByEvent = false
            undoManagers.append(undo)
            binding.document.undoManager = undo
            binding.document.didCommitTransaction = { _ in binding.appendCurrentGeneration() }
        }
        let errors = ErrorLog()
        let previews = LinkPreviewService(cacheDirectory: FileManager.default.temporaryDirectory.appending(path: "WindowDropTests-\(UUID())"))
        let provider = InMemoryWorkspaceProvider.sample()
        let originHost = StoryEditorHost(binding: a, provider: provider, linkPreviewService: previews, sourceDirectory: originDirectory,
                                         reportError: { errors.messages.append($0) })
        let destinationHost = StoryEditorHost(binding: b, provider: provider, linkPreviewService: previews, sourceDirectory: destinationDirectory,
                                              reportError: { errors.messages.append($0) })
        return Pair(origin: a, destination: b, originHost: originHost, destinationHost: destinationHost,
                    originSession: originSession, destinationSession: destinationSession, errors: errors, undoManagers: undoManagers)
    }

    /// What Quagmire does with the host's answer.
    private func drop(_ pair: Pair, _ originals: [Block], at path: DropPath, copy: Bool = false) async -> [Block]? {
        let landing = copy ? originals.map { $0.withFreshIDs() } : originals
        let transfer = EditorBlockTransfer(blocks: landing, originals: originals, source: pair.origin.document,
                                           sourceHost: pair.originHost, isCopy: copy)
        guard let received = await pair.destinationHost.receiveBlocks(transfer, at: path, in: pair.destination.document) else { return nil }
        // A live update of the landed transfer may arrive before the editor inserts.
        try? await Task.sleep(for: .milliseconds(30))
        pair.destination.document.transaction(name: "Move Blocks") {
            _ = pair.destination.document.insertSubtrees(received, at: path)
        }
        if !copy {
            pair.origin.document.transaction(name: "Move Blocks") {
                for block in originals { pair.origin.document.removeSubtree(block.id) }
            }
        }
        return received
    }

    @Test("A move lands where it was dropped as one transfer, and each window undoes its half")
    func move() async throws {
        let pair = try await pair(origin: "One\n\nMoved\n\nThree\n", destination: "Top\n\nBottom\n")
        let moved = pair.origin.document.body[1]

        // The destination presents a title holding its body; the drop lands under it.
        let title = pair.destination.document.children[0].id
        let received = try #require(await drop(pair, [moved], at: DropPath(parent: title, position: 1)))

        #expect(received.map(\.id) == [moved.id])
        await pair.origin.flush(); await pair.destination.flush()
        #expect(pair.errors.messages.isEmpty)
        #expect(try await pair.originSession.snapshot().source == "One\n\nThree\n")
        #expect(try await pair.destinationSession.snapshot().source == "Top\n\nMoved\n\nBottom\n")
        #expect(await pair.originSession.transferCount() == 1)
        let originPatches = await pair.originSession.patchCount(), destinationPatches = await pair.destinationSession.patchCount()
        #expect(originPatches == 0 && destinationPatches == 0, "neither editor states the moved blocks again")
        #expect(pair.destination.document.body.map { String($0.text.characters) } == ["Top", "Moved", "Bottom"])

        // Typing in the landed block continues from the transferred source.
        pair.destination.document.transaction(name: "Typing") {
            _ = pair.destination.document.setText(pair.destination.document.body[1].id, AttributedString("Moved, then edited"))
        }
        await pair.destination.flush()
        #expect(pair.destination.lastError == nil)
        #expect(try await pair.destinationSession.snapshot().source == "Top\n\nMoved, then edited\n\nBottom\n")

        pair.destination.document.undoManager?.undo()
        pair.destination.document.undoManager?.undo()
        await pair.destination.flush()
        #expect(try await pair.destinationSession.snapshot().source == "Top\n\nBottom\n")
        pair.origin.document.undoManager?.undo()
        await pair.origin.flush()
        #expect(pair.origin.lastError == nil)
        #expect(try await pair.originSession.snapshot().source == "One\n\nMoved\n\nThree\n")
    }

    @Test("A move into a section of a titled page re-indents nothing and rewrites links for the destination")
    func moveIntoSection() async throws {
        let pair = try await pair(origin: "Intro\n\n- [Plan](Plans/2026.md)\n", destination: "# Dest\n\n## A\n\nx\n\n## B\n\ny\n",
                                  originDirectory: "/Social", destinationDirectory: "/")
        let moved = pair.origin.document.body[1]
        // The destination's title holds its sections; drop into section B, first.
        let title = pair.destination.document.children[0]
        let sectionB = title.children[1]

        _ = try #require(await drop(pair, [moved], at: DropPath(parent: sectionB.id, position: 0)))

        await pair.origin.flush(); await pair.destination.flush()
        #expect(pair.errors.messages.isEmpty)
        #expect(try await pair.destinationSession.snapshot().source == "# Dest\n\n## A\n\nx\n\n## B\n\n- [Plan](Social/Plans/2026.md)\n\ny\n")
        #expect(try await pair.originSession.snapshot().source == "Intro\n\n")
        #expect(await pair.destinationSession.patchCount() == 0)
    }

    @Test("A copy lands where it was dropped and states its source as provenance")
    func copy() async throws {
        let pair = try await pair(origin: "One\n\nCopied\n\nThree\n", destination: "Top\n\nBottom\n")
        let copied = pair.origin.document.body[1]

        let received = try #require(await drop(pair, [copied], at: DropPath(parent: pair.destination.document.children[0].id, position: 2), copy: true))

        #expect(received[0].id != copied.id)
        await pair.destination.flush()
        #expect(try await pair.destinationSession.snapshot().source.hasPrefix("Top\n\nBottom\n\nCopied\n"))
        #expect(try await pair.originSession.snapshot().source == "One\n\nCopied\n\nThree\n")
        let patches = await pair.destinationSession.admittedPatches()
        #expect(patches.count == 1)
        #expect(patches.first?.edits.contains { ($0.copies ?? []).contains { $0.document?.path == "/origin" } } == true)
    }

    @Test("A drop the pages' sources cannot state as one change leaves both pages as they were")
    func refused() async throws {
        let pair = try await pair(origin: "One\n\nMoved\n\nThree\n", destination: "Top\n\nBottom\n")
        await pair.originSession.refuseTransfers()
        let moved = pair.origin.document.body[1]

        #expect(await drop(pair, [moved], at: DropPath(parent: pair.destination.document.children[0].id, position: 1)) == nil)

        #expect(pair.errors.messages.count == 1)
        #expect(try await pair.originSession.snapshot().source == "One\n\nMoved\n\nThree\n")
        #expect(try await pair.destinationSession.snapshot().source == "Top\n\nBottom\n")
        // The destination captures ordinary edits again.
        pair.destination.document.transaction(name: "Typing") {
            _ = pair.destination.document.setText(pair.destination.document.body[0].id, AttributedString("Top, edited"))
        }
        await pair.destination.flush()
        #expect(try await pair.destinationSession.snapshot().source == "Top, edited\n\nBottom\n")
    }

    @Test("Blocks from another tree land as new text through each editor")
    func otherTree() async throws {
        let pair = try await pair(origin: "One\n\nMoved\n", destination: "Top\n")
        let other = TransferPairSession(.init(reference: .init(tree: "tr_other", path: "/x"), source: "Elsewhere\n", contentRevision: "x1"))
        let foreign = try await StoryDocumentBinding.open(reference: .init(tree: "tr_other", path: "/x"), session: other)
        let foreignHost = StoryEditorHost(binding: foreign, provider: InMemoryWorkspaceProvider.sample(),
                                          linkPreviewService: LinkPreviewService(cacheDirectory: FileManager.default.temporaryDirectory.appending(path: "WindowDropTests-\(UUID())")))
        let block = foreign.document.body[0]
        let transfer = EditorBlockTransfer(blocks: [block], originals: [block], source: foreign.document, sourceHost: foreignHost, isCopy: false)
        let received = await pair.destinationHost.receiveBlocks(transfer, at: DropPath(parent: nil, position: 1), in: pair.destination.document)
        #expect(received?.map(\.id) == [block.id])
        #expect(await other.transferCount() == 0)
    }
}

/// Two pages of one tree whose sessions admit a transfer between them.
actor TransferPairSession: WorkspaceDocumentSession {
    nonisolated let identity: WorkspaceIdentity
    private var current: WorkspaceDocumentSnapshot
    private var patches: [WorkspaceDocumentPatch] = []
    private var transfers = 0
    private var revision = 1
    private var refuses = false
    private weak var peer: TransferPairSession?
    private let stream: AsyncThrowingStream<WorkspaceDocumentSnapshot, Error>
    private let continuation: AsyncThrowingStream<WorkspaceDocumentSnapshot, Error>.Continuation

    init(_ snapshot: WorkspaceDocumentSnapshot) {
        identity = snapshot.reference.identity
        current = snapshot
        (stream, continuation) = AsyncThrowingStream<WorkspaceDocumentSnapshot, Error>.makeStream()
    }

    func setPeer(_ peer: TransferPairSession) { self.peer = peer }
    func refuseTransfers() { refuses = true }
    func transferCount() -> Int { transfers }
    func patchCount() -> Int { patches.count }
    func admittedPatches() -> [WorkspaceDocumentPatch] { patches }

    func snapshot() -> WorkspaceDocumentSnapshot { current }
    func updates() -> AsyncThrowingStream<WorkspaceDocumentSnapshot, Error> { stream }

    private func advance(to source: String) -> WorkspaceDocumentSnapshot {
        revision += 1
        current = WorkspaceDocumentSnapshot(reference: current.reference, source: source,
                                            contentRevision: "\(current.reference.path)#\(revision)")
        return current
    }

    func admit(source: String, baseContentRevision: String) throws -> WorkspaceDocumentSnapshot {
        guard current.contentRevision == baseContentRevision else {
            throw WorkspacePatchError.staleRevision(expected: baseContentRevision, actual: current.contentRevision)
        }
        return advance(to: source)
    }

    func admit(patch: WorkspaceDocumentPatch) throws -> WorkspaceDocumentSnapshot {
        patches.append(patch)
        return try admit(source: patch.applying(to: current.source), baseContentRevision: patch.baseContentRevision)
    }

    func copyDocument() -> WorkspaceCopyDocument? { WorkspaceCopyDocument(path: current.reference.path, source: current.source) }

    func admit(transfer: WorkspaceDocumentTransfer) async throws -> WorkspaceDocumentTransferResult? {
        guard !refuses, let peer else { return nil }
        guard transfer.origin.contentRevision == current.contentRevision else {
            throw WorkspacePatchError.staleRevision(expected: transfer.origin.contentRevision, actual: current.contentRevision)
        }
        transfers += 1
        let origin = advance(to: transfer.originSource)
        let destination = try await peer.land(transfer)
        return WorkspaceDocumentTransferResult(origin: origin, destination: destination)
    }

    /// The destination half of a transfer, announced as a live update.
    func land(_ transfer: WorkspaceDocumentTransfer) throws -> WorkspaceDocumentSnapshot {
        guard transfer.destination.contentRevision == current.contentRevision else {
            throw WorkspacePatchError.staleRevision(expected: transfer.destination.contentRevision, actual: current.contentRevision)
        }
        let landed = advance(to: transfer.destinationSource)
        continuation.yield(landed)
        return landed
    }

    func flush() {}
    func history() -> [WorkspaceHistoryEntry] { [] }
    func recover(revision _: String) -> WorkspaceDocumentSnapshot { current }
    func close() {}
}
