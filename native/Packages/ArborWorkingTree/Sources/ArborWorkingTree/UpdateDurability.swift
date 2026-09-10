import ArborWire
import Darwin
import Foundation

/// `<root>/sync/update-control.json` plus `<root>/sync/objects/<hash>` for head
/// objects too large to carry inline in the control file.
struct UpdateControlFiles: Sendable {
    let directory: URL
    let controlURL: URL
    let objectsDirectory: URL

    init(root: URL) throws {
        directory = root.appending(path: "sync", directoryHint: .isDirectory)
        controlURL = directory.appending(path: "update-control.json")
        objectsDirectory = directory.appending(path: "objects", directoryHint: .isDirectory)
        try Self.createPrivateDirectory(directory)
    }

    func load() throws -> UpdateControl {
        guard FileManager.default.fileExists(atPath: controlURL.path) else { return UpdateControl() }
        var control = try JSONDecoder().decode(UpdateControl.self, from: Data(contentsOf: controlURL))
        guard control.schema <= UpdateControl.currentSchema else {
            throw UpdateError.unsupportedControlSchema(control.schema)
        }
        control.schema = UpdateControl.currentSchema
        return control
    }

    func write(_ control: UpdateControl) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        var value = control
        value.schema = UpdateControl.currentSchema
        try atomicWrite(try encoder.encode(value), to: controlURL)
    }

    func writeObject(_ envelope: WireObjectEnvelope) throws {
        try Self.createPrivateDirectory(objectsDirectory)
        let destination = objectsDirectory.appending(path: Self.fileName(envelope.hash))
        if FileManager.default.fileExists(atPath: destination.path) { return }
        try atomicWrite(envelope.bytes, to: destination, in: objectsDirectory)
    }

    func readObject(_ hash: String) throws -> WireObjectEnvelope {
        let bytes = try Data(contentsOf: objectsDirectory.appending(path: Self.fileName(hash)))
        return WireObjectEnvelope(hash: hash, bytes: bytes)
    }

    /// Drop spilled objects no durable record references.
    func retainObjects(_ hashes: Set<String>) {
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: objectsDirectory.path) else { return }
        let keep = Set(hashes.map(Self.fileName))
        for name in names where !keep.contains(name) {
            try? FileManager.default.removeItem(at: objectsDirectory.appending(path: name))
        }
    }

    private static func fileName(_ hash: String) -> String {
        hash.replacingOccurrences(of: ":", with: "-")
    }

    private func atomicWrite(_ data: Data, to destination: URL) throws {
        try atomicWrite(data, to: destination, in: directory)
    }

    private func atomicWrite(_ data: Data, to destination: URL, in directory: URL) throws {
        let temporary = directory.appending(path: ".\(UUID().uuidString).tmp")
        guard FileManager.default.createFile(atPath: temporary.path, contents: nil, attributes: [.posixPermissions: 0o600]) else {
            throw CocoaError(.fileWriteUnknown)
        }
        do {
            let handle = try FileHandle(forWritingTo: temporary)
            try handle.write(contentsOf: data)
            try handle.synchronize()
            try handle.close()
            if Darwin.rename(temporary.path, destination.path) != 0 {
                throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
            }
            let descriptor = Darwin.open(directory.path, O_RDONLY)
            guard descriptor >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
            defer { Darwin.close(descriptor) }
            guard Darwin.fsync(descriptor) == 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        } catch {
            try? FileManager.default.removeItem(at: temporary)
            throw error
        }
    }

    private static func createPrivateDirectory(_ url: URL) throws {
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: url.path)
    }
}
