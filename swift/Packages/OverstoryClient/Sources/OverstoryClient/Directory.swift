import Foundation
import Overstory

public struct DirectoryPerson: Identifiable, Hashable, Sendable {
    public var origin: URL
    public var entry: WireProfileDirectoryEntry
    public var id: String { entry.profile }

    public init(origin: URL, entry: WireProfileDirectoryEntry) {
        self.origin = origin
        self.entry = entry
    }

    public var title: String {
        entry.displayName ?? entry.handle.map { "~\($0)" } ?? entry.locator ?? entry.profile
    }

    public var subtitle: String {
        let host = origin.host() ?? origin.absoluteString
        if let handle = entry.handle { return "~\(handle) · \(host)" }
        if let locator = entry.locator { return "\(locator) · \(host)" }
        return host
    }

    public var initials: String {
        let words = title.split(whereSeparator: { $0.isWhitespace || $0 == "-" })
        let selected = words.count > 1 ? [words.first!, words.last!] : Array(words.prefix(1))
        let value = selected.compactMap(\.first).map(String.init).joined().uppercased()
        return value.isEmpty ? "?" : value
    }

    public static func merged(_ people: [DirectoryPerson]) -> [DirectoryPerson] {
        var result: [String: DirectoryPerson] = [:]
        for person in people {
            guard var current = result[person.id] else { result[person.id] = person; continue }
            func richness(_ entry: WireProfileDirectoryEntry) -> Int {
                [entry.displayName, entry.handle, entry.locator, entry.summary, entry.avatar?.path].compactMap { $0 }.count
            }
            let sources = Array(Set(current.entry.sources + person.entry.sources)).sorted()
            if richness(person.entry) > richness(current.entry) { current = person }
            current.entry.sources = sources
            result[person.id] = current
        }
        return result.values.sorted { $0.title.localizedCaseInsensitiveCompare($1.title) == .orderedAscending }
    }
}

public enum DirectoryMatcher {
    private static func folded(_ value: String) -> String {
        value.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)
    }

    public static func matches(query: String, in people: [DirectoryPerson]) -> [DirectoryPerson] {
        let raw = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let needle = folded(raw.hasPrefix("~") ? String(raw.dropFirst()) : raw)
        guard !needle.isEmpty else { return people }
        return people.filter { person in
            [person.entry.displayName, person.entry.handle, person.entry.locator, person.entry.profile]
                .compactMap { $0 }.contains { folded($0).contains(needle) }
        }
    }
}
