import ArborWire
import Foundation

enum ArborSupportDirectories {
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
    /// Per-tree working-tree state: the durable iOS tree, or on the Mac only the
    /// coordinator's `sync/update-control.json` beneath `WorkingTrees/<key>`.
    static let workingTrees = root.appending(path: "WorkingTrees", directoryHint: .isDirectory)

    static func workingTreeKey(_ tree: String) -> String {
        tree.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? UUID().uuidString
    }
}

struct NativePlacementRecord: Codable, Equatable, Sendable {
    var version = 1
    var origin: URL
    var configurationTree: String?
    var tree: WireTreeDescriptor

    init(origin: URL, configurationTree: String? = nil, tree: WireTreeDescriptor) {
        self.origin = origin
        self.configurationTree = configurationTree
        self.tree = tree
    }
}

private struct NativePlacementCollection: Codable {
    var version = 2
    var selectedTree: String?
    var placements: [NativePlacementRecord]
}

actor NativePlacementStore {
    private let url: URL

    init(url: URL = ArborSupportDirectories.nativePlacement) {
        self.url = url
    }

    func load() throws -> NativePlacementRecord? {
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        let collection = try loadCollection()
        return collection.selectedTree.flatMap { selected in
            collection.placements.first { $0.tree.id == selected }
        } ?? collection.placements.first
    }

    func loadAll() throws -> [NativePlacementRecord] {
        guard FileManager.default.fileExists(atPath: url.path) else { return [] }
        return try loadCollection().placements
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
        return try loadCollection()
    }

    private func loadCollection() throws -> NativePlacementCollection {
        let data = try Data(contentsOf: url)
        if let collection = try? JSONDecoder().decode(NativePlacementCollection.self, from: data) {
            guard collection.version == 2 else {
                throw ArborWireValidationError.invalidValue("Unsupported native placement collection")
            }
            try validate(collection.placements)
            return collection
        }
        let record = try JSONDecoder().decode(NativePlacementRecord.self, from: data)
        try validate([record])
        return NativePlacementCollection(selectedTree: record.tree.id, placements: [record])
    }

    private func validate(_ records: [NativePlacementRecord]) throws {
        var trees = Set<String>()
        for record in records {
            guard record.version == 1 else {
                throw ArborWireValidationError.invalidValue("Unsupported native placement")
            }
            _ = try record.tree.validated()
            guard trees.insert(record.tree.id).inserted else {
                throw ArborWireValidationError.invalidValue("Duplicate native tree placement")
            }
        }
    }
}
