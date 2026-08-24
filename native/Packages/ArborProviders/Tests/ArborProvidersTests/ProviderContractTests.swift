import ArborClient
import ArborKit
import ArborReplica
import Foundation
import Testing
@testable import ArborProviders

@Suite("Workspace provider contract", .serialized)
struct ProviderContractTests {
#if os(macOS)
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
            source: "# Supervised\n"
        )))
        let restarted = try await supervisor.restart()
        let reopened = try await restarted.provider.resolve(created.reference)
        #expect(reopened.title == "supervised")
        await supervisor.stop()
    }
#endif

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
        #expect(asset.pathHint.contains("Assets") || asset.pathHint.hasSuffix("contract.txt"))

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
            _ = try await provider.openDocument(asset)
        }
    }
}
