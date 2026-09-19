import Darwin
import Foundation

/// The iOS working tree's private directory: `materialized/tree.json`,
/// `control/heads.json`, `journals/pages/<key>/<id>.json`, `indexes/search.json`.
/// Object bytes live beside it in `objects/`, owned by a `DirectoryObjectStore`.
public struct DurableWorkingTreeFiles: WorkingTreeStateStore {
    public let root: URL
    let materializedDirectory: URL
    let journalsDirectory: URL
    let indexesDirectory: URL
    let controlDirectory: URL

    var stateURL: URL { materializedDirectory.appending(path: "tree.json") }
    var controlURL: URL { controlDirectory.appending(path: "heads.json") }
    var indexURL: URL { indexesDirectory.appending(path: "search.json") }

    /// Where the tree's `DirectoryObjectStore` overlay lives.
    public var objectsDirectory: URL { root.appending(path: "objects", directoryHint: .isDirectory) }

    public init(root: URL) throws {
        self.root = root
        materializedDirectory = root.appending(path: "materialized", directoryHint: .isDirectory)
        journalsDirectory = root.appending(path: "journals/pages", directoryHint: .isDirectory)
        indexesDirectory = root.appending(path: "indexes", directoryHint: .isDirectory)
        controlDirectory = root.appending(path: "control", directoryHint: .isDirectory)
        for directory in [root, materializedDirectory, journalsDirectory, indexesDirectory, controlDirectory] {
            try createPrivateDirectory(directory)
        }
    }

    public var hasState: Bool { FileManager.default.fileExists(atPath: stateURL.path) }
    public func readState() throws -> Data { try Data(contentsOf: stateURL) }
    public func writeState(_ data: Data) throws { try atomicWrite(data, to: stateURL) }

    public var hasControl: Bool { FileManager.default.fileExists(atPath: controlURL.path) }
    public func readControl() throws -> Data { try Data(contentsOf: controlURL) }
    public func writeControl(_ data: Data) throws { try atomicWrite(data, to: controlURL) }

    public func readIndex() -> Data? {
        guard FileManager.default.fileExists(atPath: indexURL.path) else { return nil }
        return try? Data(contentsOf: indexURL)
    }

    public func writeIndex(_ data: Data) throws { try atomicWrite(data, to: indexURL) }

    public func removeIndexes() throws {
        if FileManager.default.fileExists(atPath: indexesDirectory.path) {
            try FileManager.default.removeItem(at: indexesDirectory)
        }
        try createPrivateDirectory(indexesDirectory)
        try syncDirectory(root)
    }

    public func writeJournal(pageKey: String, id: String, _ data: Data) throws -> String {
        let directory = journalsDirectory.appending(path: safeKey(pageKey), directoryHint: .isDirectory)
        try createPrivateDirectory(directory)
        let url = directory.appending(path: "\(safeKey(id)).json")
        try atomicWrite(data, to: url)
        return url.path
    }

    public func journalRecords() throws -> [WorkingTreeJournalRecord] {
        guard FileManager.default.fileExists(atPath: journalsDirectory.path) else { return [] }
        let keys = try FileManager.default.contentsOfDirectory(at: journalsDirectory, includingPropertiesForKeys: nil)
        let urls = try keys.flatMap { directory in
            try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
                .filter { $0.pathExtension == "json" }
        }.sorted { $0.path < $1.path }
        return try urls.map { WorkingTreeJournalRecord(token: $0.path, data: try Data(contentsOf: $0)) }
    }

    public func removeJournal(token: String) throws {
        try remove(URL(filePath: token))
    }

    private func remove(_ url: URL) throws {
        guard FileManager.default.fileExists(atPath: url.path) else { return }
        try FileManager.default.removeItem(at: url)
        try syncDirectory(url.deletingLastPathComponent())
    }

    private func atomicWrite(_ data: Data, to destination: URL) throws {
        try createPrivateDirectory(destination.deletingLastPathComponent())
        let temporary = destination.deletingLastPathComponent().appending(path: ".\(UUID().uuidString).tmp")
        guard FileManager.default.createFile(
            atPath: temporary.path,
            contents: nil,
            attributes: [.posixPermissions: 0o600]
        ) else { throw WorkingTreeError.corruptState("Could not create durable temporary file") }
        do {
            let handle = try FileHandle(forWritingTo: temporary)
            try handle.write(contentsOf: data)
            try handle.synchronize()
            try handle.close()
            if Darwin.rename(temporary.path, destination.path) != 0 {
                throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
            }
            try syncDirectory(destination.deletingLastPathComponent())
        } catch {
            try? FileManager.default.removeItem(at: temporary)
            throw error
        }
    }

    private func createPrivateDirectory(_ url: URL) throws {
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: url.path)
    }

    private func syncDirectory(_ url: URL) throws {
        let descriptor = Darwin.open(url.path, O_RDONLY)
        guard descriptor >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        defer { Darwin.close(descriptor) }
        guard Darwin.fsync(descriptor) == 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
    }

    private func safeKey(_ value: String) -> String {
        Data(value.utf8).base64EncodedString()
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "=", with: "")
    }
}
