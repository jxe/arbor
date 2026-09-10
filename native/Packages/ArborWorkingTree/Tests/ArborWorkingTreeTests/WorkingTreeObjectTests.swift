import ArborKit
import ArborObjectStore
import ArborWire
import Foundation
import Testing
@testable import ArborWorkingTree

/// A platform store that counts fetches and serves a fixed set of objects.
private final class CountingObjectStore: ObjectStore, @unchecked Sendable {
    private let lock = NSLock()
    private var objects: [String: Data]
    private(set) var fetches: [String] = []

    init(_ objects: [String: Data]) { self.objects = objects }

    func bytes(_ hash: String) async throws -> Data {
        let found: Data? = lock.withLock {
            fetches.append(hash)
            return objects[hash]
        }
        guard let found else { throw ObjectStoreError.missing(hash) }
        return found
    }

    var fetchCount: Int { lock.withLock { fetches.count } }
}

@Suite("Working tree objects")
struct WorkingTreeObjectTests {
    @Test("A sparse snapshot names the same root as the full-object snapshot", arguments: StoreKind.allCases)
    func sparseRootEqualsFullRoot(kind: StoreKind) async throws {
        try await withTemporaryObjectRoot { root in
            let tree: TreeID = "tr_sparse"
            let payload = Data((0..<4096).map { UInt8($0 % 251) })
            let fileObject = try WireObjectCodec.object(.file(payload))
            let inline = WorkingTreeState(tree: tree.rawValue, nodes: [
                WorkingTreeNode(path: "/", kind: .directory),
                WorkingTreeNode(path: "/note", pageID: "pg_note", kind: .markdown, source: "---\nid: pg_note\n---\n\n# Note\n"),
                WorkingTreeNode(path: "/blob.bin", kind: .file, ref: .inline(payload), mediaType: "application/octet-stream"),
            ])
            var byHash = inline
            byHash.nodes[2].ref = .hash(fileObject.hash, size: payload.count, mediaType: "application/octet-stream")
            let full = try WorkingTreeWireCodec.snapshot(for: inline)
            let sparse = try WorkingTreeWireCodec.snapshot(for: byHash)
            #expect(full.root == sparse.root)
            #expect(full.hashes == sparse.hashes)
            #expect(full.sparseHashes.isEmpty)
            #expect(sparse.sparseHashes == [fileObject.hash])
            #expect(sparse.inlineObjects.count == full.inlineObjects.count - 1)

            // A working tree that imports the file lands on the same root and
            // then holds the file by hash.
            let workingTree = try await openWorkingTree(kind, at: root, tree: tree)
            _ = try await workingTree.createMarkdown(parent: .init(tree: tree, path: "/"), name: "note", source: "---\nid: pg_note\n---\n\n# Note\n")
            let imported = try await workingTree.importFile(name: "blob.bin", bytes: payload, mediaType: "application/octet-stream", parent: .init(tree: tree, path: "/"))
            #expect(imported.ref == .inline(payload))
            let stored = try await workingTree.resolve(.init(tree: tree, path: "/blob.bin"))
            #expect(stored.ref == .hash(fileObject.hash, size: payload.count, mediaType: "application/octet-stream"))
            #expect(try await workingTree.currentSnapshot().root == full.root)
            #expect(try await workingTree.currentSnapshot().sparseHashes == [fileObject.hash])
            #expect(try await workingTree.objectBytes(hash: fileObject.hash) == fileObject.bytes)
            #expect(try await workingTree.completeSnapshot().objects.allSatisfy { WireObjectCodec.hash($0.bytes) == $0.hash })
        }
    }

    @Test("Overlay GC keeps what the accepted and materialized roots reach and drops the rest", arguments: StoreKind.allCases)
    func overlayRetention(kind: StoreKind) async throws {
        try await withTemporaryObjectRoot { root in
            let tree: TreeID = "tr_gc"
            let overlay: any ObjectOverlay = kind == .durable
                ? try DirectoryObjectStore(directory: root.appending(path: "objects"))
                : InMemoryObjectOverlay()
            let store: any WorkingTreeStateStore = kind == .durable
                ? try DurableWorkingTreeFiles(root: root)
                : InMemoryWorkingTreeStore()
            let workingTree = try await WorkingTree.open(store: store, overlay: overlay, tree: tree)
            let home = WorkspaceReference(tree: tree, path: "/")

            // Accepted state: one file and one note. Then local edits: the note
            // is rewritten (its old object becomes garbage), a second file is
            // imported and trashed (restorable, so its object must survive), and
            // a third is imported.
            let first = try await workingTree.importFile(name: "one.bin", bytes: Data([1, 1, 1]), mediaType: nil, parent: home)
            let note = try await workingTree.createMarkdown(parent: home, name: "note", source: "# Note\n")
            let noteReference = WorkspaceReference(tree: tree, path: note.path, stableKey: note.pageID.map(markdownStableKey))
            let oldNoteObject = WorkingTreeWireCodec.hash(WorkingTreeWireCodec.file(Data((note.source ?? "").utf8)))
            let acceptedRoot = try await workingTree.currentSnapshot().root
            try await workingTree.recordAccepted(root: acceptedRoot, update: "up_one")
            let firstHash = try #require(try await workingTree.resolve(.init(tree: tree, path: first.path)).ref?.objectHash)

            let noteSnapshot = try await workingTree.documentSnapshot(noteReference)
            _ = try await workingTree.writeDocument(noteReference, source: noteSnapshot.source + "More.\n", baseRevision: noteSnapshot.contentRevision)
            _ = try await workingTree.importFile(name: "two.bin", bytes: Data([2, 2, 2]), mediaType: nil, parent: home)
            let two = try #require(try await workingTree.resolve(.init(tree: tree, path: "/two.bin")).ref?.objectHash)
            _ = try await workingTree.trash(.init(tree: tree, path: "/two.bin"))
            let intermediateRoot = try await workingTree.currentSnapshot().root
            _ = try await workingTree.importFile(name: "three.bin", bytes: Data([3, 3, 3]), mediaType: nil, parent: home)
            let three = try #require(try await workingTree.resolve(.init(tree: tree, path: "/three.bin")).ref?.objectHash)
            let materializedRoot = try await workingTree.currentSnapshot().root

            // Nothing has been accepted since; local transactions never collect.
            let before = try overlay.hashes()
            #expect(before.isSuperset(of: [firstHash, oldNoteObject, two, three, acceptedRoot, intermediateRoot, materializedRoot]))

            // Accepting the materialized root drops the intermediate root and the
            // superseded note object; it keeps everything both roots reach and the
            // trashed file, which only a restore can reach.
            try await workingTree.recordAccepted(root: materializedRoot, update: "up_three")
            let after = try overlay.hashes()
            #expect(after.isSuperset(of: [firstHash, two, three, materializedRoot]))
            #expect(!after.contains(intermediateRoot))
            #expect(!after.contains(oldNoteObject))
            #expect(!after.contains(acceptedRoot))
            #expect(try await workingTree.diagnostics().isEmpty)
            _ = try await workingTree.restore(.init(tree: tree, path: "/Trash/two.bin"))
            #expect(try await workingTree.fileBytes(.init(tree: tree, path: "/two.bin")) == Data([2, 2, 2]))

            // While an older root is still the accepted base, what it reaches stays.
            let fourPayload = Data([4, 4, 4])
            _ = try await workingTree.importFile(name: "four.bin", bytes: fourPayload, mediaType: nil, parent: home)
            let withFour = try await workingTree.currentSnapshot().root
            try await workingTree.recordAccepted(root: withFour, update: "up_four")
            let fourHash = ContentRef.inline(fourPayload).objectHash
            #expect(try overlay.hashes().contains(fourHash))
            #expect(try overlay.hashes().contains(withFour))
        }
    }

    @Test("File bytes held by hash are fetched once through the platform store", arguments: StoreKind.allCases)
    func fileBytesFetchOnce(kind: StoreKind) async throws {
        try await withTemporaryObjectRoot { root in
            let tree: TreeID = "tr_fetch"
            let payload = Data("remote image bytes".utf8)
            let fileObject = try WireObjectCodec.object(.file(payload))
            let platform = CountingObjectStore([fileObject.hash: fileObject.bytes])
            let workingTree = try await openWorkingTree(kind, at: root, tree: tree, platform: platform)
            let initial = try await workingTree.currentSnapshot()
            try await workingTree.recordAccepted(root: initial.root, update: "up_initial")

            let replacementState = WorkingTreeState(tree: tree.rawValue, nodes: [
                WorkingTreeNode(path: "/", kind: .directory),
                WorkingTreeNode(path: "/image.png", kind: .file, ref: .hash(fileObject.hash, size: payload.count, mediaType: "image/png")),
                WorkingTreeNode(path: "/missing.png", kind: .file, ref: .hash("sha256:" + String(repeating: "a", count: 64), size: 7, mediaType: "image/png")),
            ])
            let expected = try WorkingTreeWireCodec.snapshot(for: replacementState)
            try await workingTree.replaceFromSystem(WorkingTreeSystemReplacement(
                root: expected.root,
                update: "up_sparse",
                nodes: [
                    WorkingTreeSystemNode(path: "/", content: .directory()),
                    WorkingTreeSystemNode(path: "/image.png", content: .file(ref: .hash(fileObject.hash, size: payload.count, mediaType: "image/png"))),
                    WorkingTreeSystemNode(path: "/missing.png", content: .file(ref: .hash("sha256:" + String(repeating: "a", count: 64), size: 7, mediaType: "image/png"))),
                ]
            ))
            #expect(platform.fetchCount == 0)
            let provider = WorkingTreeProvider(workingTree: workingTree)
            let image = WorkspaceReference(tree: tree, path: "/image.png")
            let node = try await provider.resolve(image)
            #expect(node.surface == .file(name: "image.png", byteCount: payload.count, mediaType: "image/png"))
            #expect(node.materialization == .available)
            #expect(platform.fetchCount == 0)

            #expect(try await provider.readFile(image) == payload)
            #expect(platform.fetchCount == 1)
            #expect(try await provider.readFile(image) == payload)
            #expect(platform.fetchCount == 2, "the overlay is never filled from the platform")
            #expect(try await workingTree.diagnostics().isEmpty, "a platform-served reference is not corruption")

            // A miss is a materialization state, reported only after the read.
            let missing = WorkspaceReference(tree: tree, path: "/missing.png")
            #expect(try await provider.resolve(missing).materialization == .available)
            await #expect(throws: ObjectStoreError.missing("sha256:" + String(repeating: "a", count: 64))) {
                _ = try await provider.readFile(missing)
            }
            #expect(try await provider.resolve(missing).materialization == .placeholder)
            #expect(try await workingTree.diagnostics().isEmpty)
        }
    }

    @Test("Schema 1 state is refused rather than decoded leniently")
    func schemaOneIsRefused() async throws {
        try await withTemporaryObjectRoot { root in
            let tree: TreeID = "tr_schema"
            _ = try await WorkingTree.open(at: root, tree: tree)
            let stateURL = root.appending(path: "materialized/tree.json")
            var json = try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: stateURL)) as? [String: Any])
            json["schema"] = 1
            try JSONSerialization.data(withJSONObject: json).write(to: stateURL)
            await #expect(throws: WorkingTreeError.self) {
                _ = try await WorkingTree.open(at: root, tree: tree)
            }
        }
    }
}

private func withTemporaryObjectRoot(_ operation: (URL) async throws -> Void) async throws {
    let root = FileManager.default.temporaryDirectory.appending(path: "arbor-objects-\(UUID().uuidString)", directoryHint: .isDirectory)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    try await operation(root)
}
