import Darwin
import Foundation

struct DurableSyncFiles: Sendable {
    let directory: URL
    let controlURL: URL

    init(root: URL) throws {
        directory = root.appending(path: "sync", directoryHint: .isDirectory)
        controlURL = directory.appending(path: "control.json")
        try Self.createPrivateDirectory(directory)
    }

    func load() throws -> DurableSyncControl {
        guard FileManager.default.fileExists(atPath: controlURL.path) else { return DurableSyncControl() }
        return try JSONDecoder().decode(DurableSyncControl.self, from: Data(contentsOf: controlURL))
    }

    func write(_ control: DurableSyncControl) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        try atomicWrite(try encoder.encode(control), to: controlURL)
    }

    private func atomicWrite(_ data: Data, to destination: URL) throws {
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
