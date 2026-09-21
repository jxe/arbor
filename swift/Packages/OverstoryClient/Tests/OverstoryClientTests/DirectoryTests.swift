import Foundation
import Overstory
import Testing
@testable import OverstoryClient

@Suite("Native profile directory")
struct DirectoryTests {
    private func person(name: String?, handle: String?, origin: String = "https://example.com", sources: [String] = ["community"]) -> DirectoryPerson {
        DirectoryPerson(origin: URL(string: origin)!, entry: WireProfileDirectoryEntry(
            profile: "tr_aaaaaaaaaaaaaaaaaaaaaaaaaa", kind: "person", handle: handle,
            displayName: name, sources: sources
        ))
    }

    @Test("Matcher folds case, accents, and handles")
    func matcher() {
        let value = person(name: "Joséphine Arbor", handle: "jose")
        #expect(DirectoryMatcher.matches(query: "josephine", in: [value]).count == 1)
        #expect(DirectoryMatcher.matches(query: "~JOSE", in: [value]).count == 1)
        #expect(DirectoryMatcher.matches(query: "missing", in: [value]).isEmpty)
    }

    @Test("Merge keeps the richer card and unions sources")
    func merge() {
        let sparse = person(name: nil, handle: "jose")
        let rich = person(name: "José Arbor", handle: "jose", origin: "https://other.example", sources: ["access"])
        let merged = DirectoryPerson.merged([sparse, rich])
        #expect(merged.count == 1)
        #expect(merged[0].title == "José Arbor")
        #expect(merged[0].entry.sources == ["access", "community"])
        #expect(merged[0].initials == "JA")
    }
}
