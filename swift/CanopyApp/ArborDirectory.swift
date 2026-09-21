import Foundation
import Overstory
import OverstoryClient

private struct DirectoryOriginCache: Codable, Sendable, Equatable {
    var fetchedAt: Date
    var entries: [WireProfileDirectoryEntry]
}

private struct DirectoryCacheDocument: Codable, Sendable, Equatable {
    var version = 1
    var origins: [String: DirectoryOriginCache]
}

actor DirectoryStore {
    private let url: URL

    init(url: URL = ArborSupportDirectories.directory) { self.url = url }

    nonisolated static func load(at url: URL = ArborSupportDirectories.directory) throws -> [DirectoryPerson] {
        guard FileManager.default.fileExists(atPath: url.path) else { return [] }
        let document = try JSONDecoder.directory.decode(DirectoryCacheDocument.self, from: Data(contentsOf: url))
        guard document.version == 1 else { throw ArborWireValidationError.invalidValue("Unsupported directory cache") }
        let people = document.origins.reduce(into: [DirectoryPerson]()) { result, pair in
            guard let origin = URL(string: pair.key) else { return }
            result.append(contentsOf: pair.value.entries.map { DirectoryPerson(origin: origin, entry: $0) })
        }
        return DirectoryPerson.merged(people)
    }

    func load() throws -> [DirectoryPerson] {
        try Self.load(at: url)
    }

    func save(origin: URL, entries: [WireProfileDirectoryEntry], fetchedAt: Date = .now) throws {
        var document = try loadDocument()
        document.origins[origin.absoluteString] = DirectoryOriginCache(fetchedAt: fetchedAt, entries: entries)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder.directory.encode(document).write(to: url, options: .atomic)
    }

    func fetchedAt(origin: URL) throws -> Date? { try loadDocument().origins[origin.absoluteString]?.fetchedAt }

    private func loadDocument() throws -> DirectoryCacheDocument {
        guard FileManager.default.fileExists(atPath: url.path) else { return DirectoryCacheDocument(origins: [:]) }
        let document = try JSONDecoder.directory.decode(DirectoryCacheDocument.self, from: Data(contentsOf: url))
        guard document.version == 1 else { throw ArborWireValidationError.invalidValue("Unsupported directory cache") }
        return document
    }
}

actor AvatarCache {
    static let maximumBytes = 2 * 1024 * 1024
    private let directory: URL

    init(directory: URL = ArborSupportDirectories.avatars) { self.directory = directory }

    nonisolated static func fileName(for hash: String) throws -> String {
        guard hash.range(of: #"^sha256:[a-f0-9]{64}$"#, options: .regularExpression) != nil else {
            throw ArborWireValidationError.invalidHash(hash)
        }
        return String(hash.dropFirst("sha256:".count))
    }

    func data(for avatar: WireDirectoryAvatar, fetch: @Sendable () async throws -> Data) async throws -> Data {
        let url = directory.appending(path: try Self.fileName(for: avatar.hash))
        if let data = try? Data(contentsOf: url), data.count <= Self.maximumBytes { return data }
        let data = try await fetch()
        guard data.count <= Self.maximumBytes else { throw ArborWireValidationError.invalidValue("Avatar is larger than 2 MB") }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try data.write(to: url, options: .atomic)
        return data
    }
}

private extension JSONEncoder {
    static let directory: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }()
}

private extension JSONDecoder {
    static let directory: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }()
}
