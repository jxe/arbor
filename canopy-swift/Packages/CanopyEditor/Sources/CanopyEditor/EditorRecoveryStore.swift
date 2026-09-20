import CanopyAppKit
import CryptoKit
import Darwin
import Foundation

/// Private, device-local evidence independent of the provider and sync queue.
/// Immutable exact-source objects and revision records are never removed by
/// save acknowledgements, incoming updates, or reopening a workspace.
struct EditorRecoveryStore {
    struct Revision: Codable, Sendable {
        var id: String
        var reference: WorkspaceReference
        var timestamp: Date
        var sourceHash: String
        var baseHash: String
        var baseRevision: String
        var summary: String?
        /// Absent in legacy records; never infer move/copy intent from those snapshots.
        var patch: WorkspaceDocumentPatch?
        /// The generations the editor captured since the base, each with its
        /// patch against the previous one's source; recovery replays them as
        /// frames. Absent when the draft was recorded as one step.
        var generations: [Generation]?
    }

    struct Generation: Codable, Sendable {
        var patch: WorkspaceDocumentPatch
        var sourceHash: String
    }

    let directory: URL
    private let objects: URL

    init(root: URL, reference: WorkspaceReference) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let key = Self.hash(try encoder.encode(reference.identity))
        directory = root.appending(path: key, directoryHint: .isDirectory)
        objects = directory.appending(path: "sources", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: objects, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        for url in [root, directory, objects] {
            try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: url.path)
        }
    }

    /// `generations` is the chain the editor captured from `base` to `source`;
    /// a single generation is stored as the record's patch, a longer one as
    /// generations beside a whole-step patch. Nil records one plain step.
    func record(reference: WorkspaceReference, source: String, base: WorkspaceDocumentSnapshot,
                generations: [WorkspaceDocumentGeneration]? = nil) throws -> Revision {
        let chain = (generations?.count ?? 0) > 1 ? generations! : []
        let exactPatch = generations?.count == 1 ? generations![0].patch : ArborMarkdownCodec.patch(from: base.source, to: source, revision: base.contentRevision)
        _ = try WorkspaceDocumentIntent(basis: base, patch: exactPatch, source: source, generations: chain)
        let oldLines = Set(base.source.split(separator: "\n").map(String.init))
        let changedLine = source.split(separator: "\n").first {
            !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !oldLines.contains(String($0))
        }
        let revision = Revision(
            id: UUID().uuidString, reference: reference, timestamp: Date(),
            sourceHash: try store(source), baseHash: try store(base.source), baseRevision: base.contentRevision,
            summary: changedLine.map { String($0.prefix(100)) },
            patch: exactPatch,
            generations: chain.isEmpty ? nil : try chain.map { Generation(patch: $0.patch, sourceHash: try store($0.source)) }
        )
        try write(try JSONEncoder().encode(revision), to: directory.appending(path: revision.id + ".json"))
        return revision
    }

    func intent(_ revision: Revision) throws -> WorkspaceDocumentIntent? {
        guard let patch = revision.patch else { return nil }
        return try WorkspaceDocumentIntent(
            basis: .init(reference: revision.reference, source: base(revision), contentRevision: revision.baseRevision),
            patch: patch, source: source(revision),
            generations: try (revision.generations ?? []).map { .init(patch: $0.patch, source: try source(hash: $0.sourceHash)) })
    }

    func source(_ revision: Revision) throws -> String { try source(hash: revision.sourceHash) }
    func base(_ revision: Revision) throws -> String { try source(hash: revision.baseHash) }

    func revisions() throws -> [Revision] {
        try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "json" }
            .map { try JSONDecoder().decode(Revision.self, from: Data(contentsOf: $0)) }
            .sorted { $0.timestamp == $1.timestamp ? $0.id > $1.id : $0.timestamp > $1.timestamp }
    }

    func isSaved(_ revision: Revision) -> Bool {
        FileManager.default.fileExists(atPath: directory.appending(path: revision.id + ".saved").path)
    }

    func markSaved(_ revision: Revision) throws {
        try write(Data(), to: directory.appending(path: revision.id + ".saved"))
    }

    func log(phase: String, generation: Int, revision: Revision?) throws {
        let event: [String: Any] = [
            "timestamp": Date().timeIntervalSince1970,
            "phase": phase,
            "generation": generation,
            "draft": revision?.id ?? "",
        ]
        var data = try JSONSerialization.data(withJSONObject: event, options: [.sortedKeys])
        data.append(0x0a)
        let url = directory.appending(path: "events.jsonl")
        let descriptor = Darwin.open(url.path, O_WRONLY | O_CREAT | O_APPEND, 0o600)
        guard descriptor >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        defer { try? handle.close() }
        try handle.write(contentsOf: data)
        try handle.synchronize()
    }

    private func store(_ source: String) throws -> String {
        let bytes = Data(source.utf8)
        let hash = Self.hash(bytes)
        let target = objects.appending(path: hash + ".md")
        if !FileManager.default.fileExists(atPath: target.path) { try write(bytes, to: target) }
        return hash
    }

    private func source(hash: String) throws -> String {
        guard hash.count == 64, hash.allSatisfy({ $0.isHexDigit }) else { throw CocoaError(.fileReadCorruptFile) }
        let data = try Data(contentsOf: objects.appending(path: hash + ".md"))
        guard Self.hash(data) == hash, let source = String(data: data, encoding: .utf8) else {
            throw CocoaError(.fileReadCorruptFile)
        }
        return source
    }

    private static func hash(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    private func write(_ data: Data, to target: URL) throws {
        let parent = target.deletingLastPathComponent()
        let temporary = parent.appending(path: ".\(UUID().uuidString).tmp")
        guard FileManager.default.createFile(atPath: temporary.path, contents: nil, attributes: [.posixPermissions: 0o600]) else {
            throw CocoaError(.fileWriteUnknown)
        }
        defer { try? FileManager.default.removeItem(at: temporary) }
        let handle = try FileHandle(forWritingTo: temporary)
        defer { try? handle.close() }
        try handle.write(contentsOf: data)
        try handle.synchronize()
        guard Darwin.rename(temporary.path, target.path) == 0 else {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
        let descriptor = Darwin.open(parent.path, O_RDONLY)
        guard descriptor >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        defer { Darwin.close(descriptor) }
        guard Darwin.fsync(descriptor) == 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
    }
}
