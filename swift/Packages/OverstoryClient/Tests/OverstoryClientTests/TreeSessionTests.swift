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

    @Test("A spine keeps directories and Markdown; other files stay hashes")
    func spine() throws {
        let f = try fixture()
        let spine = try TreeSpine.sparse(f.complete)
        #expect(Set(spine.objects.map(\.hash)) == [f.root.hash, f.nested.hash, f.markdown.hash])
        let objects = try ProtocolObjectGraph.validate(spine, mode: .sparseFiles)
        #expect(objects[f.image.hash] == nil)
        guard case let .directory(rootEntries, _)? = objects[f.root.hash],
              case let .directory(nestedEntries, _)? = objects[f.nested.hash] else {
            Issue.record("A spine keeps both directories")
            return
        }
        #expect(rootEntries.first { $0.name == "cover.png" }?.file == f.image.hash)
        #expect(nestedEntries.first { $0.name == "photo.png" }?.file == f.image.hash)
        let replacement = try SnapshotBridge.replacement(snapshot: spine, tree: "tr_visit", update: "up_visit", cursor: "up_visit", mode: .sparseFiles)
        #expect(replacement.root == f.root.hash)
        #expect(replacement.nodes.map(\.path).sorted() == ["/", "/assets", "/assets/photo.png", "/cover.png", "/note"])
    }

    @Test("Browse opens read-only from what the caller read, and fetches files from its sources")
    func browse() async throws {
        let f = try fixture()
        var settings = TreeSessionSettings.browse()
        settings.sources = [.store(FixedStore(objects: [f.image.hash: f.image.bytes]))]
        // The origin is never asked: the opening and the sources hold everything.
        let session = try await TreeSession.open(
            f.tree,
            client: ProtocolClient(origin: URL(string: "http://127.0.0.1:9")!),
            settings: settings,
            opening: TreeOpening(current: ProtocolCurrentTree(tree: f.tree, observedThrough: "up_visit"), spine: TreeSpine.sparse(f.complete))
        )
        #expect(session.coordinator == nil)
        #expect(session.settings.readOnly)
        #expect(session.observedThrough == "up_visit")
        #expect(try await session.workingTree.heads().materializedRoot == f.root.hash)
        #expect(try await session.objects.bytes(f.image.hash) == f.image.bytes)
        let note = try await session.provider.resolve(WorkspaceReference(tree: "tr_visit", path: "/note"))
        #expect(note.reference.path == "/note")
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
