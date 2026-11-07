import Foundation
import Overstory
import OverstoryObjectStore
import OverstoryWorkingTree
import OverstoryWorkspace
import Testing
@testable import OverstoryClient

private struct FixedStore: ObjectStore {
    var objects: [String: Data]
    func bytes(_ hash: String) async throws -> Data {
        guard let bytes = objects[hash] else { throw ObjectStoreError.missing(hash) }
        return bytes
    }
}

@Suite("Tree sessions")
struct TreeSessionTests {
    private struct Fixture {
        let markdown: ProtocolObjectEnvelope
        let image: ProtocolObjectEnvelope
        let nested: ProtocolObjectEnvelope
        let root: ProtocolObjectEnvelope
        var complete: ProtocolSnapshot { ProtocolSnapshot(root: root.hash, objects: [root, nested, markdown, image]) }
        var tree: ProtocolTreeDescriptor {
            ProtocolTreeDescriptor(id: "tr_visit", kind: "ordinary", root: root.hash, access: "read", canonical: nil, update: "up_visit")
        }
    }

    private func fixture() throws -> Fixture {
        let markdown = try ProtocolObjectCodec.object(.file(Data("# Note\n".utf8)))
        let image = try ProtocolObjectCodec.object(.file(Data([0x89, 0x50, 0x4E, 0x47])))
        let nested = try ProtocolObjectCodec.object(.directory([
            ProtocolDirectoryEntry(name: "photo.png", file: image.hash),
        ]))
        let root = try ProtocolObjectCodec.object(.directory([
            ProtocolDirectoryEntry(name: "assets", directory: nested.hash),
            ProtocolDirectoryEntry(name: "cover.png", file: image.hash),
            ProtocolDirectoryEntry(name: "note.md", file: markdown.hash),
        ]))
        return Fixture(markdown: markdown, image: image, nested: nested, root: root)
    }

    private func browse(_ f: Fixture, store: FixedStore) async throws -> TreeSession {
        var settings = TreeSessionSettings.browse()
        settings.sources = [.store(store)]
        // The origin is never asked: the opening and the sources hold everything.
        return try await TreeSession.open(
            f.tree,
            client: ProtocolClient(origin: URL(string: "http://127.0.0.1:9")!),
            settings: settings,
            opening: TreeOpening(current: ProtocolCurrentTree(tree: f.tree, observedThrough: "up_visit"))
        )
    }

    private func everything(_ f: Fixture) -> FixedStore {
        FixedStore(objects: Dictionary(uniqueKeysWithValues: f.complete.objects.map { ($0.hash, $0.bytes) }))
    }

    @Test("Browse opens read-only with only the root loaded, and loads a directory on first use")
    func browse() async throws {
        let f = try fixture()
        let session = try await browse(f, store: everything(f))
        #expect(session.coordinator == nil)
        #expect(session.settings.readOnly)
        #expect(session.observedThrough == "up_visit")
        #expect(try await session.workingTree.heads().materializedRoot == f.root.hash)
        #expect(await session.workingTree.hasUnloadedDirectories())
        let note = try await session.provider.resolve(WorkspaceReference(tree: "tr_visit", path: "/note"))
        #expect(note.reference.path == "/note")
        let photo = try await session.provider.resolve(WorkspaceReference(tree: "tr_visit", path: "/assets/photo.png"))
        #expect(photo.reference.path == "/assets/photo.png")
        #expect(!(await session.workingTree.hasUnloadedDirectories()))
        // Loading changes nothing hashed.
        #expect(try await session.workingTree.heads().materializedRoot == f.root.hash)
        #expect(try await session.objects.bytes(f.image.hash) == f.image.bytes)
    }

    @Test("A path read fills the directories down to a page in one request")
    func pathReadFillsPath() async throws {
        let f = try fixture()
        // The sources serve only the root and its bodies; the nested directory
        // can come only from the path read.
        let tree = try await WorkingTree.inMemory(tree: "tr_visit", platform: FixedStore(objects: [
            f.root.hash: f.root.bytes, f.markdown.hash: f.markdown.bytes,
        ]))
        await tree.loadDirectoriesLazily()
        try await tree.initializeFromSystem(SnapshotBridge.replacement(
            snapshot: try await tree.acceptedGraph(root: f.root.hash), tree: "tr_visit", update: "up_visit", mode: .lazyDirectories))
        let nested = f.nested
        await tree.readPaths { root, path in
            #expect(root == f.root.hash)
            #expect(path == "/assets/photo.png")
            return [nested.hash: nested.bytes]
        }
        try await tree.ensureLoaded("/assets/photo.png")
        #expect(!(await tree.hasUnloadedDirectories()))
    }

    @Test("A directory whose bytes do not match its hash never loads")
    func tamperedDirectory() async throws {
        let f = try fixture()
        var store = everything(f)
        store.objects[f.nested.hash] = try ProtocolObjectCodec.object(.directory([])).bytes
        let session = try await browse(f, store: store)
        await #expect(throws: (any Error).self) {
            _ = try await session.provider.resolve(WorkspaceReference(tree: "tr_visit", path: "/assets/photo.png"))
        }
        #expect(await session.workingTree.hasUnloadedDirectories())
    }

    @Test("An edit beside an unloaded directory keeps its accepted hash")
    func editBesideUnloaded() async throws {
        let f = try fixture()
        let tree = try await WorkingTree.inMemory(tree: "tr_visit", platform: everything(f))
        await tree.loadDirectoriesLazily()
        try await tree.initializeFromSystem(SnapshotBridge.replacement(
            snapshot: try await tree.acceptedGraph(root: f.root.hash), tree: "tr_visit", update: "up_visit", mode: .lazyDirectories))
        let provider = WorkingTreeProvider(workingTree: tree)
        _ = try await provider.perform(.createMarkdown(parent: WorkspaceReference(tree: "tr_visit", path: "/"), name: "fresh", source: "# Fresh\n"))
        #expect(await tree.hasUnloadedDirectories())
        let graph = try await tree.localSnapshot()
        let objects = try ProtocolObjectGraph.validate(graph, mode: .lazyDirectories)
        guard case let .directory(entries, _)? = objects[graph.root] else { Issue.record("The root is held"); return }
        #expect(entries.first { $0.name == "assets" }?.directory == f.nested.hash)
        #expect(entries.contains { $0.name == "fresh.md" })
    }

    @Test("Alongside Story Sync keeps a change log and the folder, and reads only its loopback")
    func alongside() throws {
        let folder = URL(filePath: "/tmp/tree", directoryHint: .isDirectory)
        let log = URL(filePath: "/tmp/log", directoryHint: .isDirectory)
        let settings = TreeSessionSettings.alongsideStorySync(
            reads: ProtocolClient(origin: URL(string: "http://127.0.0.1:9")!),
            tree: "tr_visit",
            folder: folder,
            changeLog: log
        )
        #expect(!settings.readOnly)
        #expect(settings.folder == folder)
        #expect(settings.changeLog == log)
        #expect(settings.sources.count == 1)
        if case .host = settings.sources[0] { Issue.record("Alongside Story Sync never reads the host directly") }
        guard case .memory = settings.index else { Issue.record("Alongside Story Sync keeps its index in memory"); return }
    }
}
