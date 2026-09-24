import CanopyAppKit
import Overstory
import Foundation
import Testing
@testable import CanopyWorkingTree

@Suite("Local folder preview")
struct LocalFolderPreviewTests {
    private let files: [String: String] = [
        "_index.md": "---\nid: pg_home\n---\n\n# Home\n",
        "notes/_index.md": "# Notes\n",
        "notes/idea.md": "---\nid: pg_idea\n---\n\n# Idea\n\nSee [[Home]].\n",
        "topic.md": "# Topic body\n",
        "topic/child.md": "# Child\n",
        "image.png": "not really a png",
        ".DS_Store": "ignored",
        ".git/HEAD": "ignored",
    ]

    private func folder() throws -> URL {
        let root = FileManager.default.temporaryDirectory.appending(path: "preview-\(UUID().uuidString)", directoryHint: .isDirectory)
        for (path, contents) in files {
            let url = root.appending(path: path)
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data(contents.utf8).write(to: url)
        }
        return root
    }

    /// The same folder as the complete protocol snapshot its client would accept.
    private func snapshot(of folder: URL) throws -> ProtocolSnapshot {
        var objects: [ProtocolObjectEnvelope] = []
        func walk(_ directory: URL) throws -> String {
            var entries: [ProtocolDirectoryEntry] = []
            for url in try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.isDirectoryKey]) {
                let name = url.lastPathComponent
                guard !name.hasPrefix(".") else { continue }
                if try url.resourceValues(forKeys: [.isDirectoryKey]).isDirectory == true {
                    entries.append(.init(name: name, directory: try walk(url)))
                } else {
                    let object = try ProtocolObjectCodec.object(.file(try Data(contentsOf: url)))
                    objects.append(object)
                    entries.append(.init(name: name, file: object.hash))
                }
            }
            let object = try ProtocolObjectCodec.object(.directory(entries.sorted { $0.name.utf8.lexicographicallyPrecedes($1.name.utf8) }))
            objects.append(object)
            return object.hash
        }
        let root = try walk(folder)
        return ProtocolSnapshot(root: root, objects: objects.sorted { $0.hash < $1.hash })
    }

    @Test("A preview presents the same pages, references and titles as the accepted tree")
    func matchesAcceptedTree() async throws {
        let folder = try folder()
        defer { try? FileManager.default.removeItem(at: folder) }
        let tree = TreeID(rawValue: "tr_preview")
        let preview = WorkingTreeProvider(workingTree: try await LocalFolderPreview.workingTree(tree: tree, folder: folder), readOnly: true)
        let acceptedTree = try await WorkingTree.inMemory(tree: tree)
        try await acceptedTree.initializeFromSystem(SnapshotBridge.replacement(snapshot: try snapshot(of: folder), tree: tree, update: "up_1"))
        let accepted = WorkingTreeProvider(workingTree: acceptedTree, readOnly: true)

        func pages(_ provider: WorkingTreeProvider) async throws -> [String] {
            try await provider.search("", in: tree).map { "\($0.reference.path) \($0.reference.stableKey ?? "-") \($0.title)" }.sorted()
        }
        #expect(try await pages(preview) == pages(accepted))
        #expect(try await pages(preview).contains { $0.hasPrefix("/notes/idea ") })

        for path in ["/", "/notes", "/topic"] {
            let reference = WorkspaceReference(tree: tree, path: path)
            let previewNode = try await preview.resolve(reference)
            let acceptedNode = try await accepted.resolve(reference)
            #expect(previewNode.reference == acceptedNode.reference)
            #expect(previewNode.title == acceptedNode.title)
            #expect(previewNode.surface == acceptedNode.surface)
            #expect(!previewNode.isWritable)
            let previewChildren = try await preview.children(of: reference).map(\.reference.path)
            let acceptedChildren = try await accepted.children(of: reference).map(\.reference.path)
            #expect(previewChildren == acceptedChildren)
        }
    }
}
