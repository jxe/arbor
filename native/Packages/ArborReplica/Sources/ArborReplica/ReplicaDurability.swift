import Darwin
import Foundation

struct DurableReplicaFiles: Sendable {
    let root: URL
    let materializedDirectory: URL
    let objectsDirectory: URL
    let journalsDirectory: URL
    let indexesDirectory: URL
    let controlDirectory: URL

    var stateURL: URL { materializedDirectory.appending(path: "tree.json") }
    var controlURL: URL { controlDirectory.appending(path: "heads.json") }
    var indexURL: URL { indexesDirectory.appending(path: "search.json") }

    init(root: URL) throws {
        self.root = root
        materializedDirectory = root.appending(path: "materialized", directoryHint: .isDirectory)
        objectsDirectory = root.appending(path: "objects", directoryHint: .isDirectory)
        journalsDirectory = root.appending(path: "journals/pages", directoryHint: .isDirectory)
        indexesDirectory = root.appending(path: "indexes", directoryHint: .isDirectory)
        controlDirectory = root.appending(path: "control", directoryHint: .isDirectory)
        for directory in [root, materializedDirectory, objectsDirectory, journalsDirectory, indexesDirectory, controlDirectory] {
            try createPrivateDirectory(directory)
        }
    }

    func read<T: Decodable>(_ type: T.Type, from url: URL) throws -> T {
        try JSONDecoder().decode(type, from: Data(contentsOf: url))
    }

    func write<T: Encodable>(_ value: T, to url: URL) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        encoder.dateEncodingStrategy = .millisecondsSince1970
        try atomicWrite(try encoder.encode(value), to: url)
    }

    func readDated<T: Decodable>(_ type: T.Type, from url: URL) throws -> T {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .millisecondsSince1970
        return try decoder.decode(type, from: Data(contentsOf: url))
    }

    func writeDated<T: Encodable>(_ value: T, to url: URL) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        encoder.dateEncodingStrategy = .millisecondsSince1970
        try atomicWrite(try encoder.encode(value), to: url)
    }

    func store(objects: [ReplicaStoredObject]) throws {
        for object in objects {
            let url = objectURL(hash: object.hash)
            if FileManager.default.fileExists(atPath: url.path) {
                guard try Data(contentsOf: url) == object.bytes else {
                    throw ReplicaError.corruptState("Immutable object bytes changed for \(object.hash)")
                }
            } else {
                try atomicWrite(object.bytes, to: url)
            }
        }
    }

    func objectURL(hash: String) -> URL {
        objectsDirectory.appending(path: String(hash.dropFirst("sha256:".count)))
    }

    func journalURL(pageKey: String, id: String) throws -> URL {
        let directory = journalsDirectory.appending(path: safeKey(pageKey), directoryHint: .isDirectory)
        try createPrivateDirectory(directory)
        return directory.appending(path: "\(safeKey(id)).json")
    }

    func journalURLs() throws -> [URL] {
        guard FileManager.default.fileExists(atPath: journalsDirectory.path) else { return [] }
        let keys = try FileManager.default.contentsOfDirectory(at: journalsDirectory, includingPropertiesForKeys: nil)
        return try keys.flatMap { directory in
            try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
                .filter { $0.pathExtension == "json" }
        }.sorted { $0.path < $1.path }
    }

    /// Moves the obsolete full-snapshot archive out of the production namespace.
    /// Recursive deletion is deliberately separated so opening a replica never waits on it.
    func prepareLegacyHistoryCleanup() throws -> [URL] {
        let manager = FileManager.default
        let history = root.appending(path: "history", directoryHint: .isDirectory)
        var tombstones = try manager.contentsOfDirectory(
            at: root,
            includingPropertiesForKeys: [.isDirectoryKey, .isSymbolicLinkKey]
        ).filter { Self.isLegacyHistoryTombstoneName($0.lastPathComponent) }

        if manager.fileExists(atPath: history.path) {
            let values = try history.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
            guard values.isDirectory == true, values.isSymbolicLink != true else {
                throw ReplicaError.corruptState("Legacy replica history is not a directory")
            }
            let tombstone = root.appending(
                path: ".obsolete-history-\(UUID().uuidString.lowercased())",
                directoryHint: .isDirectory
            )
            if Darwin.rename(history.path, tombstone.path) != 0 {
                throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
            }
            try syncDirectory(root)
            tombstones.append(tombstone)
        }
        return tombstones
    }

    static func removeLegacyHistoryTombstones(_ tombstones: [URL], from root: URL) {
        let manager = FileManager.default
        let standardizedRoot = root.standardizedFileURL
        for tombstone in tombstones {
            let standardized = tombstone.standardizedFileURL
            guard standardized.deletingLastPathComponent() == standardizedRoot,
                  isLegacyHistoryTombstoneName(standardized.lastPathComponent) else { continue }
            try? manager.removeItem(at: standardized)
        }
    }

    private static func isLegacyHistoryTombstoneName(_ name: String) -> Bool {
        let prefix = ".obsolete-history-"
        guard name.hasPrefix(prefix) else { return false }
        return UUID(uuidString: String(name.dropFirst(prefix.count))) != nil
    }

    func remove(_ url: URL) throws {
        guard FileManager.default.fileExists(atPath: url.path) else { return }
        try FileManager.default.removeItem(at: url)
        try syncDirectory(url.deletingLastPathComponent())
    }

    func removeIndexes() throws {
        if FileManager.default.fileExists(atPath: indexesDirectory.path) {
            try FileManager.default.removeItem(at: indexesDirectory)
        }
        try createPrivateDirectory(indexesDirectory)
        try syncDirectory(root)
    }

    private func atomicWrite(_ data: Data, to destination: URL) throws {
        try createPrivateDirectory(destination.deletingLastPathComponent())
        let temporary = destination.deletingLastPathComponent().appending(path: ".\(UUID().uuidString).tmp")
        guard FileManager.default.createFile(
            atPath: temporary.path,
            contents: nil,
            attributes: [.posixPermissions: 0o600]
        ) else { throw ReplicaError.corruptState("Could not create durable temporary file") }
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
