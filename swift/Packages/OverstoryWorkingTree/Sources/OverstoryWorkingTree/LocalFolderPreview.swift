import OverstoryWorkspace
import Overstory
import Foundation

/// A read-only working tree built from a placed folder on disk, for showing a
/// tree before its accepted host state has been confirmed.
///
/// The folder's client keeps it at the accepted state in the normal case, so
/// the preview's Markdown matches what the confirmed tree will show. It follows
/// `SnapshotBridge`'s layout rules (`_index.md` and sibling-Markdown directory
/// bodies, logical page paths without `.md`), so references, page IDs and
/// titles are the ones the confirmed tree produces. It applies the folder's
/// ignore rules as a first placement does, with nothing yet tracked, so it
/// never shows content that placement would leave out. It carries no accepted
/// update, so it must never be edited or synchronized; other files are named by
/// a stand-in hash and read as unavailable.
public enum LocalFolderPreview {
    /// The update ID recorded for a preview. It is never sent anywhere.
    public static let update = "local-folder-preview"

    /// Files date their pages: Story Sync writes each with its entry's
    /// `modified` time (data model §6), so the preview's sidebar matches the
    /// confirmed tree's.
    public static func workingTree(tree: TreeID, folder: URL) async throws -> WorkingTree {
        let nodes = try nodes(in: folder)
        let workingTree = try await WorkingTree.inMemory(tree: tree)
        try await workingTree.initializeFromPreview(nodes)
        return workingTree
    }

    static func nodes(in folder: URL) throws -> [WorkingTreeSystemNode] {
        let manager = FileManager.default
        let policy = IgnorePolicy(root: folder)
        var nodes: [WorkingTreeSystemNode] = []
        // A scan dates each entry by its file's modification time, never later
        // than now (data model §6); with no tree before it, every entry is new.
        let now = ProtocolEntryTime.milliseconds(Date())
        func times(_ content: String, _ date: Date?) -> WorkingTreeEntryTimes {
            let stamp = min(date.map(ProtocolEntryTime.milliseconds) ?? now, now)
            return WorkingTreeEntryTimes(content: content, created: stamp, modified: stamp)
        }
        func modified(_ url: URL?) -> Date? { url.flatMap { try? $0.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate } }

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
                    // The temporary names include the spellings from before the Overstory rename (old names, "Kept").
                    return !name.hasPrefix(".") && !IgnorePolicy.isTransactionTemporaryName(name)
                }
                .sorted { $0.lastPathComponent < $1.lastPathComponent }
            var directories: [URL] = []
            var files: [URL] = []
            for url in entries {
                let values = try url.resourceValues(forKeys: Set(keys))
                if values.isSymbolicLink == true { continue }
                let isDirectory = values.isDirectory == true
                let membership = policy.decision(childPath(url.lastPathComponent, parent: path), isDirectory: isDirectory).membership
                guard membership == .included else { continue }
                if isDirectory {
                    directories.append(url)
                } else if values.isRegularFile == true {
                    files.append(url)
                }
            }
            let directoryNames = Set(directories.map(\.lastPathComponent))
            let indexURL = files.first { $0.lastPathComponent == "_index.md" }
            let index = indexURL.flatMap(markdown)
            let source = index ?? siblingMarkdownSource
            // A directory page is dated by its body file, as a leaf page is.
            let bodyURL = index != nil ? indexURL : siblingMarkdownSource != nil
                ? directory.deletingLastPathComponent().appending(path: directory.lastPathComponent + ".md")
                : nil
            let bodyModified = modified(bodyURL)
            let siblingURL = directory.deletingLastPathComponent().appending(path: directory.lastPathComponent + ".md")
            nodes.append(WorkingTreeSystemNode(
                path: path,
                metadata: EntryMetadata(modifiedAt: bodyModified),
                content: .directory(source: source),
                directoryBodyPlacement: index == nil && siblingMarkdownSource != nil ? .siblingMarkdown : nil,
                shadowedSiblingMarkdownSource: index != nil ? siblingMarkdownSource : nil,
                times: source.map { times(WorkingTreeEntryTimes.content(of: $0), bodyModified) },
                shadowedTimes: index != nil ? siblingMarkdownSource.map { times(WorkingTreeEntryTimes.content(of: $0), modified(siblingURL)) } : nil
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
                        metadata: EntryMetadata(modifiedAt: values?.contentModificationDate),
                        content: .markdown(source: source),
                        times: times(WorkingTreeEntryTimes.content(of: source), values?.contentModificationDate)
                    ))
                } else {
                    let standIn = standInHash(for: url, size: values?.fileSize, modified: values?.contentModificationDate)
                    nodes.append(WorkingTreeSystemNode(
                        path: childPath(name, parent: path),
                        content: .file(ref: .hash(
                            standIn,
                            size: values?.fileSize,
                            mediaType: SnapshotBridge.inferredMediaType(for: name)
                        )),
                        times: times(standIn, values?.contentModificationDate)
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
        return ProtocolObjectCodec.hash(Data(key.utf8))
    }
}

extension WorkingTree {
    /// Seeds an empty tree with preview nodes, computing their root locally.
    func initializeFromPreview(_ nodes: [WorkingTreeSystemNode]) throws {
        let staged = WorkingTreeSystemReplacement(root: "", update: LocalFolderPreview.update, nodes: nodes)
        let root = try WorkingTreeProtocolCodec.snapshot(for: try state(from: staged)).root
        try initializeFromSystem(.init(root: root, update: LocalFolderPreview.update, nodes: nodes))
    }
}
