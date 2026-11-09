import Foundation
import Overstory
import Testing
@testable import OverstoryClient

@Suite("Native profile directory")
struct DirectoryTests {
    private func person(name: String?, handle: String?, origin: String = "https://example.com", sources: [String] = ["community"]) -> DirectoryPerson {
        DirectoryPerson(origin: URL(string: origin)!, entry: ProtocolProfileDirectoryEntry(
            profile: "tr_aaaaaaaaaaaaaaaaaaaaaaaaaa", kind: "person", handle: handle,
            displayName: name, sources: sources
        ))
    }

    @Test("Matcher folds case, accents, and handles")
    func matcher() {
        let value = person(name: "Joséphine Story", handle: "jose")
        #expect(DirectoryMatcher.matches(query: "josephine", in: [value]).count == 1)
        #expect(DirectoryMatcher.matches(query: "~JOSE", in: [value]).count == 1)
        #expect(DirectoryMatcher.matches(query: "missing", in: [value]).isEmpty)
    }

    @Test("Merge keeps the richer card and unions sources")
    func merge() {
        let sparse = person(name: nil, handle: "jose")
        let rich = person(name: "José Story", handle: "jose", origin: "https://other.example", sources: ["access"])
        let merged = DirectoryPerson.merged([sparse, rich])
        #expect(merged.count == 1)
        #expect(merged[0].title == "José Story")
        #expect(merged[0].entry.sources == ["access", "community"])
        #expect(merged[0].initials == "JS")
    }

    @Test("A person's own domain names them and finds them")
    func domain() {
        var value = person(name: "Alice", handle: "alice", origin: "https://garden.example")
        #expect(value.subtitle == "~alice · garden.example")
        value.entry.domain = "notes.alice.example"
        #expect(value.subtitle == "notes.alice.example")
        #expect(DirectoryMatcher.matches(query: "alice.example", in: [value]).count == 1)
    }
}
