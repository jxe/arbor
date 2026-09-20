import CanopyAppKit
import Overstory
import CryptoKit
import Foundation

/// A read-only working tree built from a placed folder on disk, for showing a
/// tree before its accepted Canopy state has been confirmed.
///
/// The folder's client keeps it at the accepted state in the normal case, so
/// the preview's Markdown matches what the confirmed tree will show. It follows
/// `SnapshotBridge`'s layout rules (`_index.md` and sibling-Markdown directory
/// bodies, logical page paths without `.md`), so references, page IDs and
/// titles are the ones the confirmed tree produces. It carries no accepted
/// update, so it must never be edited or synchronized; other files are named by
/// a stand-in hash and read as unavailable.
public enum LocalFolderPreview {
    /// The update ID recorded for a preview. It is never sent anywhere.
    public static let update = "local-folder-preview"

    public static func workingTree(tree: TreeID, folder: URL) async throws -> WorkingTree {
        let nodes = try nodes(in: folder)
        let workingTree = try await WorkingTree.inMemory(tree: tree)
        try await workingTree.initializeFromPreview(nodes)
        return workingTree
    }

    /// Directory names the folder client never places in a tree.
    static let ignoredDirectories: Set<String> = [".git", "node_modules", ".arbor", "Trash", ".build", "DerivedData"]

    static func nodes(in folder: URL) throws -> [WorkingTreeSystemNode] {
        let manager = FileManager.default
        var nodes: [WorkingTreeSystemNode] = []

        func childPath(_ name: String, parent: String) -> String {
            parent == "/" ? "/\(name)" : "\(parent)/\(name)"
        }
        func markdown(_ url: URL) -> String? {
            (try? Data(contentsOf: url)).flatMap { String(data: $0, encoding: .utf8) }
        }
        func visit(_ directory: URL, path: String, siblingMarkdownSource: String?) throws {
            let keys: [URLResourceKey] = [.isDirectoryKey, .isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey, .contentModificationDateKey]
            let entries = try manager.contentsOfDirectory(at: directory, includingPropertiesForKeys: keys)
                .filter { url in
                    let name = url.lastPathComponent
                    return !name.hasPrefix(".") && !name.contains(".arbor-txn-") && !name.contains(".arbor-write-")
                }
                .sorted { $0.lastPathComponent < $1.lastPathComponent }
            var directories: [URL] = []
            var files: [URL] = []
            for url in entries {
                let values = try url.resourceValues(forKeys: Set(keys))
                if values.isSymbolicLink == true { continue }
                if values.isDirectory == true {
                    if !ignoredDirectories.contains(url.lastPathComponent) { directories.append(url) }
                } else if values.isRegularFile == true {
                    files.append(url)
                }
            }
            let directoryNames = Set(directories.map(\.lastPathComponent))
            let index = files.first { $0.lastPathComponent == "_index.md" }.flatMap(markdown)
            let source = index ?? siblingMarkdownSource
            nodes.append(WorkingTreeSystemNode(
                path: path,
                modifiedAt: nil,
                content: .directory(source: source),
                directoryBodyPlacement: index == nil && siblingMarkdownSource != nil ? .siblingMarkdown : nil,
                shadowedSiblingMarkdownSource: index != nil ? siblingMarkdownSource : nil
            ))
            for url in files where url.lastPathComponent != "_index.md" {
                let name = url.lastPathComponent
                let values = try? url.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey])
                if name.hasSuffix(".md") {
                    let logicalName = String(name.dropLast(3))
                    if directoryNames.contains(logicalName) { continue }
                    guard let source = markdown(url) else { continue }
                    nodes.append(WorkingTreeSystemNode(
                        path: childPath(logicalName, parent: path),
                        modifiedAt: values?.contentModificationDate,
                        content: .markdown(source: source)
                    ))
                } else {
                    nodes.append(WorkingTreeSystemNode(
                        path: childPath(name, parent: path),
                        content: .file(ref: .hash(
                            standInHash(for: url, size: values?.fileSize, modified: values?.contentModificationDate),
                            size: values?.fileSize,
                            mediaType: SnapshotBridge.inferredMediaType(for: name)
                        ))
                    ))
                }
            }
            for url in directories {
                let sibling = files.first { $0.lastPathComponent == url.lastPathComponent + ".md" }.flatMap(markdown)
                try visit(url, path: childPath(url.lastPathComponent, parent: path), siblingMarkdownSource: sibling)
            }
        }
        try visit(folder, path: "/", siblingMarkdownSource: nil)
        return nodes
    }

    /// A well-formed hash that names no object, so a read reports the file as
    /// unavailable instead of hashing every non-Markdown file at launch.
    static func standInHash(for url: URL, size: Int?, modified: Date?) -> String {
        let key = "preview\u{0}\(url.path)\u{0}\(size ?? -1)\u{0}\(modified?.timeIntervalSince1970 ?? 0)"
        return "sha256:" + SHA256.hash(data: Data(key.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}

extension WorkingTree {
    /// Seeds an empty tree with preview nodes, computing their root locally.
    func initializeFromPreview(_ nodes: [WorkingTreeSystemNode]) throws {
        let staged = WorkingTreeSystemReplacement(root: "", update: LocalFolderPreview.update, nodes: nodes)
        let root = try WorkingTreeWireCodec.snapshot(for: try state(from: staged)).root
        try initializeFromSystem(.init(root: root, update: LocalFolderPreview.update, nodes: nodes))
    }
}
