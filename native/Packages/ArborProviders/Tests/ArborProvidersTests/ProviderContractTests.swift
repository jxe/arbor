import ArborClient
import ArborKit
import ArborReplica
import Foundation
import Testing
@testable import ArborProviders

@Suite("Workspace provider contract", .serialized)
struct ProviderContractTests {
#if os(macOS)
    @Test("Attach-only supervisor never launches a helper")
    func attachOnlySupervisorRequiresUserArbord() async throws {
        let rootURL = FileManager.default.temporaryDirectory
            .appending(path: "ArborAttachOnlyContract-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: rootURL, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: rootURL) }

        let supervisor = ArbordProcessSupervisor(launchPolicy: .attachOnly)
        await #expect(throws: ArbordSupervisorError.self) {
            _ = try await supervisor.start(workspace: rootURL, preferredPort: 0)
        }
    }

    @Test("Supervisor starts, reconnects, and stops a real arbord helper")
    func supervisedArbordLifecycle() async throws {
        guard let executablePath = ProcessInfo.processInfo.environment["ARBOR_EXECUTABLE"] else { return }
        let rootURL = FileManager.default.temporaryDirectory
            .appending(path: "ArborSupervisorContract-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: rootURL, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: rootURL) }

        let supervisor = ArbordProcessSupervisor()
        let first = try await supervisor.start(
            workspace: rootURL,
            executable: URL(fileURLWithPath: executablePath),
            preferredPort: 45170
        )
        let created = try #require(try await first.provider.perform(.createMarkdown(
            parent: first.home,
            name: "supervised",
            source: "# 🌲 Supervised Page\n"
        )))
        let restarted = try await supervisor.restart()
        let reopened = try await restarted.provider.resolve(created.reference)
        #expect(reopened.title == "🌲 Supervised Page")
        await supervisor.stop()
    }
#endif

    @Test("arbord display titles match replica heading semantics")
    func arbordDisplayTitle() {
        #expect(ArbordWorkspaceProvider.displayTitle(
            source: "---\nid: pg_title\n---\n\n# 🌲 Authored Page Title\n\nBody.\n",
            fallback: "authored-page-title"
        ) == "🌲 Authored Page Title")
        #expect(ArbordWorkspaceProvider.displayTitle(
            source: "Body without a title.\n",
            fallback: "filename"
        ) == "filename")
    }

    @Test("In-memory provider")
    func inMemory() async throws {
        let provider = InMemoryWorkspaceProvider.sample()
        try await verify(provider: provider, root: WorkspaceReference(tree: "tr_sample", path: "/"))
    }

    @Test("Offline replica provider")
    func replica() async throws {
        let rootURL = FileManager.default.temporaryDirectory
            .appending(path: "ArborProviderContract-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: rootURL) }
        let tree: TreeID = "tr_provider_contract"
        let replica = try await ArborReplica.open(at: rootURL, tree: tree)
        try await verify(
            provider: ReplicaWorkspaceProvider(replica: replica),
            root: WorkspaceReference(tree: tree, path: "/")
        )
    }

    @Test("Live arbord provider when the protocol harness supplies it")
    func arbord() async throws {
        guard let raw = ProcessInfo.processInfo.environment["ARBOR_TEST_URL"], let origin = URL(string: raw) else {
            return
        }
        let client = ArborClient(baseURL: origin)
        let snapshot = try await client.node(.path("/"))
        let tree = TreeID(rawValue: snapshot.tree ?? snapshot.ref.tree ?? "local")
        try await verify(
            provider: ArbordWorkspaceProvider(client: client),
            root: WorkspaceReference(tree: tree, path: "/")
        )
    }

    @Test("Live arbord resolves an existing path when the protocol harness supplies it")
    func arbordExistingPath() async throws {
        guard let raw = ProcessInfo.processInfo.environment["ARBOR_TEST_URL"],
              let origin = URL(string: raw),
              let path = ProcessInfo.processInfo.environment["ARBOR_TEST_EXISTING_PATH"] else {
            return
        }
        let client = ArborClient(baseURL: origin)
        let snapshot = try await client.node(.path("/"))
        let tree = TreeID(rawValue: snapshot.tree ?? snapshot.ref.tree ?? "local")
        let node = try await ArbordWorkspaceProvider(client: client).resolve(
            WorkspaceReference(tree: tree, path: path)
        )
        #expect(node.reference.pathHint == path)
        #expect(node.surface.supportsDocumentSession)
    }

    @Test("Live arbord document sessions observe a later authoritative revision")
    func arbordDocumentUpdates() async throws {
        guard let raw = ProcessInfo.processInfo.environment["ARBOR_TEST_URL"], let origin = URL(string: raw) else {
            return
        }
        let client = ArborClient(baseURL: origin)
        let rootSnapshot = try await client.node(.path("/"))
        let tree = TreeID(rawValue: rootSnapshot.tree ?? rootSnapshot.ref.tree ?? "local")
        let root = WorkspaceReference(tree: tree, path: "/")
        let provider = ArbordWorkspaceProvider(client: client)
        let suffix = UUID().uuidString.lowercased().prefix(8)
        let node = try #require(try await provider.perform(.createMarkdown(
            parent: root,
            name: "observed-\(suffix)",
            source: "# Observed\n"
        )))
        let observing = try await provider.openDocument(node.reference)
        let initial = try await observing.snapshot()
        let updates = try await observing.updates()
        let next = Task<WorkspaceDocumentSnapshot, Error> {
            for try await update in updates where update.contentRevision != initial.contentRevision {
                return update
            }
            throw CancellationError()
        }
        let writer = try await provider.openDocument(node.reference)
        let source = initial.source + "\nAuthoritative update.\n"
        _ = try await writer.admit(source: source, baseContentRevision: initial.contentRevision)

        let observed = try await withThrowingTaskGroup(of: WorkspaceDocumentSnapshot.self) { group in
            group.addTask { try await next.value }
            group.addTask {
                try await Task.sleep(for: .seconds(2))
                throw CancellationError()
            }
            let value = try await group.next()!
            group.cancelAll()
            return value
        }
        #expect(observed.source == source)
        await writer.close()
        await observing.close()
    }

    private func verify(provider: any WorkspaceProvider, root: WorkspaceReference) async throws {
        let suffix = UUID().uuidString.lowercased().prefix(8)
        let folder = try #require(try await provider.perform(.createDirectory(
            parent: root,
            name: "provider-\(suffix)"
        )))
        let note = try #require(try await provider.perform(.createMarkdown(
            parent: folder.reference,
            name: "note",
            source: "# Provider contract\n\nInitial text.\n"
        )))
        guard case .markdown = note.surface else {
            Issue.record("Provider did not surface created Markdown")
            return
        }

        let session = try await provider.openDocument(note.reference)
        let initial = try await session.snapshot()
        let concurrent = try await provider.openDocument(note.reference)
        let recoverable = try await session.admit(
            source: initial.source.replacingOccurrences(of: "Initial text.", with: "Recoverable prior text."),
            baseContentRevision: initial.contentRevision
        )
        await #expect(throws: WorkspaceDocumentConflict.self) {
            _ = try await concurrent.admit(
                source: initial.source + "Concurrent stale edit.\n",
                baseContentRevision: initial.contentRevision
            )
        }
        await concurrent.close()
        let changed = try await session.admit(
            source: recoverable.source.replacingOccurrences(of: "Recoverable prior text.", with: "Durable contract edit."),
            baseContentRevision: recoverable.contentRevision
        )
        #expect(changed.source.contains("Durable contract edit."))
        try await session.flush()

        let search = try await provider.search("Durable contract", in: root.tree)
        #expect(search.contains { $0.reference.pathHint == note.reference.pathHint })

        let linker = try #require(try await provider.perform(.createMarkdown(
            parent: folder.reference,
            name: "linker",
            source: "# Linker\n\n[Provider contract](\(note.reference.pathHint))\n"
        )))
        _ = linker
        let backlinks = try await provider.backlinks(to: note.reference)
        #expect(backlinks.contains { $0.reference.pathHint.hasSuffix("/linker") })

        let renamed = try #require(try await provider.perform(.rename(reference: note.reference, name: "renamed")))
        #expect(renamed.reference.pathHint.hasSuffix("/renamed"))
        #expect(try await provider.children(of: folder.reference).contains { $0.reference.pathHint == renamed.reference.pathHint })
        if let originalID = note.reference.pageID, let renamedID = renamed.reference.pageID {
            #expect(originalID == renamedID)
        }

        let archive = try #require(try await provider.perform(.createDirectory(parent: folder.reference, name: "archive")))
        let copied = try #require(try await provider.perform(.copy(reference: renamed.reference, destination: archive.reference)))
        #expect(copied.reference.pathHint.contains("/archive/"))
        #expect(try await provider.children(of: archive.reference).contains { $0.reference.pathHint == copied.reference.pathHint })
        if let originalID = renamed.reference.pageID, let copiedID = copied.reference.pageID {
            #expect(originalID != copiedID)
        }

        let asset = try await provider.store(
            asset: WorkspaceAsset(name: "contract.txt", mediaType: "text/plain", bytes: Data("asset".utf8)),
            in: folder.reference
        )
        #expect(asset.reference.pathHint.contains("Assets") || asset.reference.pathHint.hasSuffix("contract.txt"))
        #expect(!asset.markdownSource.isEmpty)
        #expect(try await provider.readFile(asset.reference) == Data("asset".utf8))

        let trashed = try #require(try await provider.perform(.trash(reference: copied.reference)))
        #expect(trashed.reference.pathHint.hasPrefix("/Trash"))
        #expect(try await provider.children(of: archive.reference).allSatisfy { $0.reference.pathHint != copied.reference.pathHint })
        let restored = try #require(try await provider.perform(.restore(reference: trashed.reference)))
        #expect(!restored.reference.pathHint.hasPrefix("/Trash"))
        #expect(try await provider.children(of: archive.reference).contains { $0.reference.pathHint == restored.reference.pathHint })

        let history = try await session.history()
        #expect(!history.isEmpty)
        await session.close()

        await #expect(throws: Error.self) {
            _ = try await provider.openDocument(asset.reference)
        }
    }
}
