import Overstory
import Darwin
import Foundation

/// One object per file under a directory, named by the hex digest. This is the
/// iOS working tree's `objects/` directory: it is both the overlay for objects
/// the tree produces and, because iOS keeps every accepted object it has seen,
/// the platform store for accepted bytes.
public struct DirectoryObjectStore: ObjectOverlay {
    public enum RetentionPolicy: Sendable {
        /// The directory is an authoritative content-addressed archive. GC is
        /// owned by a higher-level lifecycle, not by one working-tree head.
        case retainAll
        /// The directory is an overlay whose unreferenced objects are disposable.
        case collectUnreachable
    }

    public let directory: URL
    public let retentionPolicy: RetentionPolicy

    public init(directory: URL, retentionPolicy: RetentionPolicy = .collectUnreachable) throws {
        self.directory = directory
        self.retentionPolicy = retentionPolicy
        try Self.createPrivateDirectory(directory)
    }

    public func objectURL(hash: String) -> URL {
        directory.appending(path: String(hash.dropFirst("sha256:".count)))
    }

    public func bytes(_ hash: String) async throws -> Data {
        guard let bytes = try storedBytes(hash) else { throw ObjectStoreError.missing(hash) }
        return bytes
    }

    public func contains(_ hash: String) -> Bool {
        FileManager.default.fileExists(atPath: objectURL(hash: hash).path)
    }

    public func storedBytes(_ hash: String) throws -> Data? {
        let url = objectURL(hash: hash)
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        return try verifyObject(try Data(contentsOf: url), hash: hash)
    }

    public func store(_ objects: [String: Data]) throws {
        for (hash, bytes) in objects {
            _ = try verifyObject(bytes, hash: hash)
            let url = objectURL(hash: hash)
            if FileManager.default.fileExists(atPath: url.path) {
                let existing = try Data(contentsOf: url)
                guard existing == bytes else {
                    throw ObjectStoreError.hashMismatch(expected: hash, actual: ProtocolObjectCodec.hash(existing))
                }
            } else {
                try atomicWrite(bytes, to: url)
            }
        }
    }

    public func hashes() throws -> Set<String> {
        let names = try FileManager.default.contentsOfDirectory(atPath: directory.path)
        return Set(names.filter { $0.count == 64 && $0.allSatisfy(\.isHexDigit) }.map { "sha256:" + $0 })
    }

    public func retain(reachableFrom roots: Set<String>, files: Set<String>) throws {
        guard retentionPolicy == .collectUnreachable else { return }
        let reachable = try reachableHashes(from: roots).union(files)
        for hash in try hashes() where !reachable.contains(hash) {
            try? FileManager.default.removeItem(at: objectURL(hash: hash))
        }
        try syncDirectory(directory)
    }

    private func atomicWrite(_ data: Data, to destination: URL) throws {
        try Self.createPrivateDirectory(destination.deletingLastPathComponent())
        let temporary = destination.deletingLastPathComponent().appending(path: ".\(UUID().uuidString).tmp")
        guard FileManager.default.createFile(
            atPath: temporary.path,
            contents: nil,
            attributes: [.posixPermissions: 0o600]
        ) else { throw ObjectStoreError.io("Could not create durable temporary file") }
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

    private static func createPrivateDirectory(_ url: URL) throws {
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: url.path)
    }

    private func syncDirectory(_ url: URL) throws {
        let descriptor = Darwin.open(url.path, O_RDONLY)
        guard descriptor >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        defer { Darwin.close(descriptor) }
        guard Darwin.fsync(descriptor) == 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
    }
}
