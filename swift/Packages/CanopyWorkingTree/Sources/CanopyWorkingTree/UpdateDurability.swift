import Overstory
import Darwin
import Foundation
import OSLog

/// `<root>/sync/update-control.json` plus `<root>/sync/objects/<hash>` for head
/// objects too large to carry inline in the control file.
struct UpdateControlFiles: Sendable {
    private static let log = Logger(subsystem: "org.arbor.native", category: "Sync")

    let directory: URL
    let controlURL: URL
    let objectsDirectory: URL
    let sourceAdmissionsURL: URL

    init(root: URL) throws {
        directory = root.appending(path: "sync", directoryHint: .isDirectory)
        controlURL = directory.appending(path: "update-control.json")
        objectsDirectory = directory.appending(path: "objects", directoryHint: .isDirectory)
        sourceAdmissionsURL = directory.appending(path: "source-admissions.json")
        try DurableFile.createPrivateDirectory(directory)
    }

    func lockSourceAdmissions() throws -> Int32 {
        let descriptor = Darwin.open(directory.appending(path: "source-admissions.lock").path, O_RDWR | O_CREAT, 0o600)
        guard descriptor >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        guard flock(descriptor, LOCK_EX) == 0 else {
            Darwin.close(descriptor)
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
        return descriptor
    }

    func unlockSourceAdmissions(_ descriptor: Int32) {
        flock(descriptor, LOCK_UN)
        Darwin.close(descriptor)
    }

    func readSourceAdmissionsData() throws -> Data? {
        guard FileManager.default.fileExists(atPath: sourceAdmissionsURL.path) else { return nil }
        return try Data(contentsOf: sourceAdmissionsURL, options: .mappedIfSafe)
    }

    func writeSourceAdmissions<T: Encodable>(_ value: T) throws {
        try atomicWrite(try sortedKeysJSON(value), to: sourceAdmissionsURL)
        // Persist a newly created sync directory as well as its journal entry.
        try DurableFile.syncDirectory(directory.deletingLastPathComponent())
    }

    func load() throws -> UpdateControl {
        guard FileManager.default.fileExists(atPath: controlURL.path) else { return UpdateControl() }
        let bytes = try Data(contentsOf: controlURL)
        var control = try JSONDecoder().decode(UpdateControl.self, from: bytes)
        guard control.schema <= UpdateControl.currentSchema else {
            throw UpdateError.unsupportedControlSchema(control.schema)
        }
        control.schema = UpdateControl.currentSchema
        return control
    }

    func write(_ control: UpdateControl) throws {
        var value = control
        value.schema = UpdateControl.currentSchema
        try atomicWrite(try sortedKeysJSON(value), to: controlURL)
        // Retain scheduling/persistence evidence after successful requests have
        // cleared the live control. Never put authored source or credentials in
        // this diagnostic stream; editor recovery holds the exact source.
        var event: [String: Any] = [
            "timestamp": Date().timeIntervalSince1970,
            "state": value.presentation.state.rawValue,
            "head": value.head?.root ?? "",
            "generation": value.head?.generation ?? -1,
            "attempt": value.attempt?.digest ?? "",
            "candidate": value.attempt?.candidate ?? "",
            "accepted": value.presentation.acceptedRoot ?? "",
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

    func writeObject(_ envelope: WireObjectEnvelope) throws {
        try DurableFile.createPrivateDirectory(objectsDirectory)
        let destination = objectsDirectory.appending(path: Self.fileName(envelope.hash))
        if FileManager.default.fileExists(atPath: destination.path) { return }
        try atomicWrite(envelope.bytes, to: destination)
    }

    func readObject(_ hash: String) throws -> WireObjectEnvelope {
        let bytes = try Data(contentsOf: objectsDirectory.appending(path: Self.fileName(hash)))
        return WireObjectEnvelope(hash: hash, bytes: bytes)
    }

    /// Drop spilled objects no durable record references. Collection is best
    /// effort: a leftover object only costs space.
    func retainObjects(_ hashes: Set<String>) {
        // The directory exists only once a head has spilled.
        guard FileManager.default.fileExists(atPath: objectsDirectory.path) else { return }
        let names: [String]
        do { names = try FileManager.default.contentsOfDirectory(atPath: objectsDirectory.path) } catch {
            Self.log.error("spilled objects unreadable: \(String(describing: error), privacy: .public)")
            return
        }
        let keep = Set(hashes.map(Self.fileName))
        for name in names where !keep.contains(name) {
            do { try FileManager.default.removeItem(at: objectsDirectory.appending(path: name)) } catch {
                Self.log.error("spilled object not removed: \(String(describing: error), privacy: .public)")
            }
        }
    }

    private static func fileName(_ hash: String) -> String {
        hash.replacingOccurrences(of: ":", with: "-")
    }

    func atomicWrite(_ data: Data, to destination: URL) throws {
        try DurableFile.atomicWrite(data, to: destination)
    }
}
