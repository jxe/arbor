import Overstory
import Darwin
import Foundation
import OSLog

/// `<root>/sync/`: the update control file, its event log, the change log
/// journal, and the change log's objects.
struct UpdateControlFiles: Sendable {
    private static let log = Logger(subsystem: "org.arbor.native", category: "Sync")

    let directory: URL
    let controlURL: URL
    let objectsDirectory: URL
    let changeLogURL: URL
    let changeLogObjectsDirectory: URL

    init(root: URL) throws {
        directory = root.appending(path: "sync", directoryHint: .isDirectory)
        controlURL = directory.appending(path: "update-control.json")
        objectsDirectory = directory.appending(path: "objects", directoryHint: .isDirectory)
        changeLogURL = directory.appending(path: "change-log.json")
        changeLogObjectsDirectory = directory.appending(path: "change-log-objects", directoryHint: .isDirectory)
        try DurableFile.createPrivateDirectory(directory)
    }

    var hasEarlierChangeLog: Bool {
        FileManager.default.fileExists(atPath: directory.appending(path: "source-admissions.json").path)
    }

    /// Move a journal written under its earlier name (`source-admissions.json`
    /// and `source-admission-objects/`, the same schema) to the change log's
    /// names. Objects move first; the journal's presence marks a complete move.
    func adoptEarlierChangeLog() throws {
        let journal = directory.appending(path: "source-admissions.json")
        let objects = directory.appending(path: "source-admission-objects", directoryHint: .isDirectory)
        let manager = FileManager.default
        guard !manager.fileExists(atPath: changeLogURL.path), manager.fileExists(atPath: journal.path) else { return }
        if manager.fileExists(atPath: objects.path), !manager.fileExists(atPath: changeLogObjectsDirectory.path) {
            try manager.moveItem(at: objects, to: changeLogObjectsDirectory)
        }
        try manager.moveItem(at: journal, to: changeLogURL)
        try DurableFile.syncDirectory(directory)
    }

    func lockChangeLog() throws -> Int32 {
        let descriptor = Darwin.open(directory.appending(path: "change-log.lock").path, O_RDWR | O_CREAT, 0o600)
        guard descriptor >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        guard flock(descriptor, LOCK_EX) == 0 else {
            Darwin.close(descriptor)
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
        return descriptor
    }

    func unlockChangeLog(_ descriptor: Int32) {
        flock(descriptor, LOCK_UN)
        Darwin.close(descriptor)
    }

    func readChangeLogData() throws -> Data? {
        guard FileManager.default.fileExists(atPath: changeLogURL.path) else { return nil }
        return try Data(contentsOf: changeLogURL, options: .mappedIfSafe)
    }

    func writeChangeLog<T: Encodable>(_ value: T) throws {
        try atomicWrite(try sortedKeysJSON(value), to: changeLogURL)
        // Persist a newly created sync directory as well as its journal entry.
        try DurableFile.syncDirectory(directory.deletingLastPathComponent())
    }

    func load() throws -> UpdateControl {
        guard FileManager.default.fileExists(atPath: controlURL.path) else { return UpdateControl() }
        let control = try JSONDecoder().decode(UpdateControl.self, from: Data(contentsOf: controlURL))
        // Spilled head objects belonged to the snapshot head schema 4 dropped;
        // decoding refused any control that still named one.
        if FileManager.default.fileExists(atPath: objectsDirectory.path) {
            do { try FileManager.default.removeItem(at: objectsDirectory) } catch {
                Self.log.error("spilled head objects not removed: \(String(describing: error), privacy: .public)")
            }
        }
        return control
    }

    func write(_ control: UpdateControl, phase: String) throws {
        var value = control
        value.schema = UpdateControl.currentSchema
        try atomicWrite(try sortedKeysJSON(value), to: controlURL)
        // Retain scheduling/persistence evidence after successful requests have
        // cleared the live control. Never put authored source or credentials in
        // this diagnostic stream; the change log holds the exact work.
        var event: [String: Any] = [
            "timestamp": Date().timeIntervalSince1970,
            "phase": phase,
            "attempt": value.attempt?.digest ?? "",
            "tip": value.attemptTip ?? "",
            "candidate": value.attempt?.candidate ?? "",
            "held": value.held?.reason.rawValue ?? "",
            "settled": value.settled.count,
        ]
        event["schema"] = value.schema
        var line = try JSONSerialization.data(withJSONObject: event, options: [.sortedKeys])
        line.append(0x0a)
        let descriptor = Darwin.open(directory.appending(path: "events.jsonl").path, O_WRONLY | O_CREAT | O_APPEND, 0o600)
        guard descriptor >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        defer { try? handle.close() }
        try handle.write(contentsOf: line)
        try handle.synchronize()
    }

    func atomicWrite(_ data: Data, to destination: URL) throws {
        try DurableFile.atomicWrite(data, to: destination)
    }
}
