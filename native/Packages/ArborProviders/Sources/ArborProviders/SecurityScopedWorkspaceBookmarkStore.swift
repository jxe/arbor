#if os(macOS)
import Foundation

public actor SecurityScopedWorkspaceBookmarkStore {
    private let defaults: UserDefaults
    private let key: String

    public init(defaults: UserDefaults = .standard, key: String = "native-workspace-bookmark-v1") {
        self.defaults = defaults
        self.key = key
    }

    public func save(_ url: URL) throws {
        let accessing = url.startAccessingSecurityScopedResource()
        defer { if accessing { url.stopAccessingSecurityScopedResource() } }
        let data = try url.bookmarkData(
            options: [.withSecurityScope],
            includingResourceValuesForKeys: [.isDirectoryKey],
            relativeTo: nil
        )
        defaults.set(data, forKey: key)
    }

    public func load() throws -> URL? {
        guard let data = defaults.data(forKey: key) else { return nil }
        var stale = false
        let url = try URL(
            resolvingBookmarkData: data,
            options: [.withSecurityScope, .withoutUI],
            relativeTo: nil,
            bookmarkDataIsStale: &stale
        )
        if stale { try save(url) }
        return url
    }

    public func forget() {
        defaults.removeObject(forKey: key)
    }
}
#endif
