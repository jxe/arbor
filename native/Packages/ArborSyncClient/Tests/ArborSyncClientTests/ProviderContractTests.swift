import ArborKit
import ArborWorkingTree
import Foundation
import Testing
@testable import ArborSyncClient

@Suite("Workspace provider contract", .serialized)
struct ProviderContractTests {
#if os(macOS)
    @Test("Bookmark restore migrates the former sandbox preferences domain")
    func bookmarkMigrationFromSandboxPreferences() async throws {
        let rootURL = FileManager.default.temporaryDirectory
            .appending(path: "ArborBookmarkMigration-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: rootURL, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: rootURL) }

        let currentDomain = "org.nxhx.ArborTests.BookmarkCurrent.\(UUID().uuidString)"
        let currentDefaults = try #require(UserDefaults(suiteName: currentDomain))
        defer {
            UserDefaults.standard.removePersistentDomain(forName: currentDomain)
        }

        let key = "native-workspace-bookmark-v1"
        let bookmark = try rootURL.bookmarkData(
            options: [.withSecurityScope],
            includingResourceValuesForKeys: [.isDirectoryKey],
            relativeTo: nil
        )
        let legacyURL = rootURL.appending(path: "legacy.plist")
        let plist = try PropertyListSerialization.data(
            fromPropertyList: [key: bookmark],
            format: .binary,
            options: 0
        )
        try plist.write(to: legacyURL)

        let migratedStore = SecurityScopedWorkspaceBookmarkStore(
            defaults: currentDefaults,
            key: key,
            legacyPreferencesURL: legacyURL
        )
        let restored = try #require(try await migratedStore.load())

        #expect(restored.standardizedFileURL == rootURL.standardizedFileURL)
        let reloadedDefaults = try #require(UserDefaults(suiteName: currentDomain))
        #expect(reloadedDefaults.data(forKey: key) == bookmark)
    }
#endif

    @Test("In-memory provider")
    func inMemory() async throws {
        let provider = InMemoryWorkspaceProvider.sample()
        try await verify(provider: provider, root: WorkspaceReference(tree: "tr_sample", path: "/"))
    }

    @Test("Working-tree provider")
    func workingTree() async throws {
        let rootURL = FileManager.default.temporaryDirectory
            .appending(path: "ArborProviderContract-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: rootURL) }
        let tree: TreeID = "tr_providercontract"
        let workingTree = try await WorkingTree.open(at: rootURL, tree: tree)
        try await verify(
            provider: WorkingTreeProvider(workingTree: workingTree),
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
        #expect(search.contains { $0.reference.path == note.reference.path })

        let linker = try #require(try await provider.perform(.createMarkdown(
            parent: folder.reference,
            name: "linker",
            source: "# Linker\n\n[Provider contract](\(note.reference.path))\n"
        )))
        _ = linker
        let backlinks = try await provider.backlinks(to: note.reference)
        #expect(backlinks.contains { $0.reference.path.hasSuffix("/linker") })

        // Document-link rows are written as `arbor://` locators, and a relative href resolves
        // against the linking page's parent. Both must count, or deleting one link to a page
        // reads as though nothing links to it at all.
        let locator = try #require(buildArborLocator(
            tree: root.tree.rawValue,
            path: note.reference.path,
            stableKey: note.reference.stableKey
        ))
        let rowLinker = try #require(try await provider.perform(.createMarkdown(
            parent: folder.reference,
            name: "row-linker",
            source: "# Row Linker\n\n[Provider contract](\(locator))\n"
        )))
        _ = rowLinker
        let siblingHref = try #require(buildCanonicalLink(
            from: folder.reference.path,
            toPath: note.reference.path,
            stableKey: nil
        ))
        let siblingLinker = try #require(try await provider.perform(.createMarkdown(
            parent: folder.reference,
            name: "sibling-linker",
            source: "# Sibling Linker\n\n[Provider contract](\(siblingHref))\n"
        )))
        _ = siblingLinker
        let imageOnly = try #require(try await provider.perform(.createMarkdown(
            parent: folder.reference,
            name: "image-only",
            source: "# Image Only\n\n![Provider contract](\(note.reference.path))\n"
        )))
        _ = imageOnly
        let widened = try await provider.backlinks(to: note.reference)
        #expect(widened.contains { $0.reference.path.hasSuffix("/row-linker") })
        #expect(widened.contains { $0.reference.path.hasSuffix("/sibling-linker") })
        #expect(!widened.contains { $0.reference.path.hasSuffix("/image-only") })
        let linkedSearch = try await provider.search("Durable contract", in: root.tree)
        #expect(linkedSearch.first { $0.reference.path == note.reference.path }?.backlinkCount == 3)

        let renamed = try #require(try await provider.perform(.rename(reference: note.reference, name: "renamed")))
        #expect(renamed.reference.path.hasSuffix("/renamed"))
        #expect(try await provider.children(of: folder.reference).contains { $0.reference.path == renamed.reference.path })
        if let originalID = note.reference.stableKey, let renamedID = renamed.reference.stableKey {
            #expect(originalID == renamedID)
        }

        let archive = try #require(try await provider.perform(.createDirectory(parent: folder.reference, name: "archive")))
        let copied = try #require(try await provider.perform(.copy(reference: renamed.reference, destination: archive.reference)))
        #expect(copied.reference.path.contains("/archive/"))
        #expect(try await provider.children(of: archive.reference).contains { $0.reference.path == copied.reference.path })
        if let originalID = renamed.reference.stableKey, let copiedID = copied.reference.stableKey {
            #expect(originalID != copiedID)
        }

        let asset = try await provider.store(
            asset: WorkspaceAsset(name: "contract.txt", mediaType: "text/plain", bytes: Data("asset".utf8)),
            in: folder.reference
        )
        #expect(asset.reference.path.contains("Assets") || asset.reference.path.hasSuffix("contract.txt"))
        #expect(!asset.markdownSource.isEmpty)
        #expect(try await provider.readFile(asset.reference) == Data("asset".utf8))

        let trashed = try #require(try await provider.perform(.trash(reference: copied.reference)))
        #expect(trashed.reference.path.hasPrefix("/Trash"))
        #expect(try await provider.children(of: archive.reference).allSatisfy { $0.reference.path != copied.reference.path })
        let restored = try #require(try await provider.perform(.restore(reference: trashed.reference)))
        #expect(!restored.reference.path.hasPrefix("/Trash"))
        #expect(try await provider.children(of: archive.reference).contains { $0.reference.path == restored.reference.path })

        await session.close()

        await #expect(throws: Error.self) {
            _ = try await provider.openDocument(asset.reference)
        }
    }
}
