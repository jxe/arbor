#if os(macOS)
import Foundation

public actor SecurityScopedWorkspaceBookmarkStore {
    private let defaults: UserDefaults
    private let key: String
    private let legacyPreferencesURL: URL?

    public init(
        defaults: UserDefaults = .standard,
        key: String = "native-workspace-bookmark-v1",
        legacyPreferencesURL: URL? = nil
    ) {
        self.defaults = defaults
        self.key = key
        self.legacyPreferencesURL = legacyPreferencesURL ?? Self.defaultLegacyPreferencesURL()
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
        let data: Data
        if let current = defaults.data(forKey: key) {
            data = current
        } else if let legacy = legacyBookmarkData() {
            defaults.set(legacy, forKey: key)
            data = legacy
        } else {
            return nil
        }
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

    private func legacyBookmarkData() -> Data? {
        guard let legacyPreferencesURL,
              let plistData = try? Data(contentsOf: legacyPreferencesURL),
              let plist = try? PropertyListSerialization.propertyList(from: plistData, format: nil),
              let values = plist as? [String: Any] else { return nil }
        return values[key] as? Data
    }

    private static func defaultLegacyPreferencesURL() -> URL? {
        guard let bundleID = Bundle.main.bundleIdentifier, !bundleID.isEmpty else { return nil }
        return FileManager.default.homeDirectoryForCurrentUser
            .appending(path: "Library/Containers/\(bundleID)/Data/Library/Preferences/\(bundleID).plist")
    }
}
#endif
