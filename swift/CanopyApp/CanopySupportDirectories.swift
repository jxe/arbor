import Overstory
import OverstoryClient
import Foundation

enum CanopySupportDirectories {
#if os(macOS)
    static let dataHome: URL = {
        if let override = ProcessInfo.processInfo.environment["ARBOR_DATA_HOME"], !override.isEmpty {
            return URL(fileURLWithPath: override, isDirectory: true).standardizedFileURL
        }
        return FileManager.default.homeDirectoryForCurrentUser
            .appending(path: ".arbor", directoryHint: .isDirectory)
    }()
#endif

    static let root: URL = {
#if os(macOS)
        // A redirected data home (tests, the conflict lab) keeps app state
        // beside it, so it never touches the real Application Support.
        if let override = ProcessInfo.processInfo.environment["ARBOR_DATA_HOME"], !override.isEmpty {
            return dataHome.appending(path: "Application Support/Arbor", directoryHint: .isDirectory)
        }
#endif
        let fileManager = FileManager.default
        let base = (try? fileManager.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )) ?? fileManager.urls(for: .documentDirectory, in: .userDomainMask).first
            ?? fileManager.temporaryDirectory
        return base.appending(path: "Arbor", directoryHint: .isDirectory)
    }()

    static let linkPreviews = root.appending(path: "LinkPreviews", directoryHint: .isDirectory)
    static let pendingVoiceRecordings = root.appending(
        path: "Pending Voice Recordings",
        directoryHint: .isDirectory
    )
    static let nativePlacement = root.appending(path: "Native Placement.json")
    /// App-side visit history (macOS): the trees opened by locator without placing them.
    static let visitedTrees = root.appending(path: "Visits.json")
    static let directory = root.appending(path: "Directory.json")
    static let avatars = root.appending(path: "Avatars", directoryHint: .isDirectory)
    /// Per-tree working-tree state: the durable iOS tree, or on the Mac only the
    /// coordinator's `sync/update-control.json` beneath `WorkingTrees/<key>`.
    static let workingTrees = root.appending(path: "WorkingTrees", directoryHint: .isDirectory)
    /// Durable app-owned replicas for writable remote trees opened without a
    /// filesystem placement on macOS.
    static let remoteWorkingTrees = root.appending(path: "RemoteWorkingTrees", directoryHint: .isDirectory)
    static let remoteSync = root.appending(path: "RemoteSync", directoryHint: .isDirectory)
    /// Client network log: one JSON Lines file per day, readable in Sync Status.
    static let networkLogs = root.appending(path: "Logs", directoryHint: .isDirectory)

    static func workingTreeKey(_ tree: String) -> String {
        tree.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? UUID().uuidString
    }
}

struct NativePlacementRecord: Codable, Equatable, Sendable {
    var version = 1
    var origin: URL
    var configurationTree: String?
    var tree: ProtocolTreeDescriptor
    /// The folder the daemon keeps this tree in on this Mac, as of the last
    /// open. Launch previews it read-only while the tree is confirmed.
    var osPath: String?

    init(origin: URL, configurationTree: String? = nil, tree: ProtocolTreeDescriptor, osPath: String? = nil) {
        self.origin = origin
        self.configurationTree = configurationTree
        self.tree = tree
        self.osPath = osPath
    }
}

private struct NativePlacementCollection: Codable {
    var version = 2
    var selectedTree: String?
    var placements: [NativePlacementRecord]
}

actor NativePlacementStore {
    private let url: URL

    init(url: URL = CanopySupportDirectories.nativePlacement) {
        self.url = url
    }

    func load() throws -> NativePlacementRecord? { try Self.selected(at: url) }

    /// The selected placement, read synchronously so launch knows its tree
    /// before the first frame.
    nonisolated static func selected(at url: URL = CanopySupportDirectories.nativePlacement) throws -> NativePlacementRecord? {
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        let collection = try loadCollection(at: url)
        return collection.selectedTree.flatMap { selected in
            collection.placements.first { $0.tree.id == selected }
        } ?? collection.placements.first
    }

    func loadAll() throws -> [NativePlacementRecord] {
        guard FileManager.default.fileExists(atPath: url.path) else { return [] }
        return try Self.loadCollection(at: url).placements
    }

    func save(_ record: NativePlacementRecord) throws {
        _ = try record.tree.validated()
        var collection = try loadCollectionIfPresent() ?? NativePlacementCollection(placements: [])
        collection.placements.removeAll { $0.tree.id == record.tree.id }
        collection.placements.append(record)
        collection.placements.sort {
            ($0.tree.canonicalPath ?? $0.tree.id).localizedCaseInsensitiveCompare(
                $1.tree.canonicalPath ?? $1.tree.id
            ) == .orderedAscending
        }
        collection.selectedTree = record.tree.id
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(collection).write(to: url, options: .atomic)
    }

    func clear(configurationTree: String?) throws {
        guard var collection = try loadCollectionIfPresent() else { return }
        collection.placements.removeAll { $0.configurationTree == configurationTree }
        if collection.placements.isEmpty {
            try clear()
            return
        }
        if !collection.placements.contains(where: { $0.tree.id == collection.selectedTree }) {
            collection.selectedTree = collection.placements.first?.tree.id
        }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(collection).write(to: url, options: .atomic)
    }

    func clear() throws {
        guard FileManager.default.fileExists(atPath: url.path) else { return }
        try FileManager.default.removeItem(at: url)
    }

    private func loadCollectionIfPresent() throws -> NativePlacementCollection? {
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        return try Self.loadCollection(at: url)
    }

    private nonisolated static func loadCollection(at url: URL) throws -> NativePlacementCollection {
        let data = try Data(contentsOf: url)
        // A file with a `placements` key is the collection layout; anything
        // else is the original single-record file. Decode errors are reported
        // for the layout the file actually has, never for the other one.
        let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        if let placements = object?["placements"] {
            guard object?["version"] as? Int == 2, let entries = placements as? [Any] else {
                throw ProtocolValidationError.invalidValue("Unsupported native placement collection")
            }
            // The collection only remembers what the daemon already knows, so a
            // record this build can no longer read (a retired tree kind, a
            // configuration an earlier protocol named) is dropped, never fatal.
            let records = usable(entries.compactMap { entry in
                (try? JSONSerialization.data(withJSONObject: entry))
                    .flatMap { try? JSONDecoder().decode(NativePlacementRecord.self, from: $0) }
            })
            let selected = (object?["selectedTree"] as? String).flatMap { tree in records.contains { $0.tree.id == tree } ? tree : nil }
            return NativePlacementCollection(selectedTree: selected, placements: records)
        }
        guard let record = usable([try JSONDecoder().decode(NativePlacementRecord.self, from: data)]).first else {
            return NativePlacementCollection(placements: [])
        }
        return NativePlacementCollection(selectedTree: record.tree.id, placements: [record])
    }

    /// Records this build can use: a known version and a valid descriptor, the first per tree.
    private nonisolated static func usable(_ records: [NativePlacementRecord]) -> [NativePlacementRecord] {
        var trees = Set<String>()
        return records.filter { record in
            record.version == 1 && (try? record.tree.validated()) != nil && trees.insert(record.tree.id).inserted
        }
    }
}
