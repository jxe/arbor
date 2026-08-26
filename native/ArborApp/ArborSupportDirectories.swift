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
}

struct NativePlacementRecord: Codable, Equatable, Sendable {
    var version = 1
    var origin: URL
    var tree: AuthorityTreeDescriptor

    init(origin: URL, tree: AuthorityTreeDescriptor) {
        self.origin = origin
        self.tree = tree
    }
}

actor NativePlacementStore {
    private let url: URL

    init(url: URL = ArborSupportDirectories.nativePlacement) {
        self.url = url
    }

    func load() throws -> NativePlacementRecord? {
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        let record = try JSONDecoder().decode(NativePlacementRecord.self, from: Data(contentsOf: url))
        guard record.version == 1 else { throw ArborWireValidationError.invalidValue("Unsupported native placement") }
        _ = try record.tree.validated()
        return record
    }

    func save(_ record: NativePlacementRecord) throws {
        _ = try record.tree.validated()
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(record).write(to: url, options: .atomic)
    }

    func clear() throws {
        guard FileManager.default.fileExists(atPath: url.path) else { return }
        try FileManager.default.removeItem(at: url)
    }
}
