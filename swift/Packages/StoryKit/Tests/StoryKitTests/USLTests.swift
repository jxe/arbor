import Foundation
import Testing
@testable import StoryKit

/// The repository root, from this file (swift/Packages/StoryKit/Tests/StoryKitTests).
private let repositoryRoot = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent()
    .appending(path: "../../../../..")
    .standardizedFileURL

private var conformance: URL {
    ProcessInfo.processInfo.environment["STORY_PROTOCOL_FIXTURES"].map { URL(fileURLWithPath: $0) }
        ?? repositoryRoot.appending(path: "docs/overstory-spec/conformance")
}

private func examples(_ directory: String) throws -> [(name: String, source: String)] {
    let url = repositoryRoot.appending(path: directory)
    return try FileManager.default.contentsOfDirectory(atPath: url.path)
        .filter { $0.hasSuffix(".usl") }
        .sorted()
        .map { ($0, try String(contentsOf: url.appending(path: $0), encoding: .utf8)) }
}

@Suite("Ultimate Schema Language")
struct USLTests {
    @Test("The plan's examples check clean")
    func examplesCheckClean() throws {
        let files = try examples("plans/schema-language/examples")
        #expect(files.count >= 5)
        for file in files {
            #expect(compileUSL(file.source).diagnostics == [], "\(file.name)")
        }
    }

    @Test("Broken examples report exactly the codes they expect")
    func brokenExamples() throws {
        let files = try examples("plans/schema-language/examples/invalid")
        #expect(!files.isEmpty)
        let regex = try NSRegularExpression(pattern: "^// expect: ([a-z-]+)$", options: [.anchorsMatchLines])
        for file in files {
            let range = NSRange(file.source.startIndex..., in: file.source)
            let expected = regex.matches(in: file.source, range: range).map { String(file.source[Range($0.range(at: 1), in: file.source)!]) }.sorted()
            #expect(!expected.isEmpty, "\(file.name)")
            let actual = compileUSL(file.source).diagnostics.map(\.code).sorted()
            #expect(actual == expected, "\(file.name)")
        }
    }

    @Test("Collection schemas lay out the columns and keys the shared vectors give")
    func collectionSchemaVectors() throws {
        let data = try Data(contentsOf: conformance.appending(path: "collection-schemas.json"))
        let fixture = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let schemas = try #require(fixture["schemas"] as? [[String: Any]])
        for schema in schemas {
            let name = schema["name"] as? String ?? ""
            let result = compileUSL(try #require(schema["source"] as? String))
            if let accept = schema["accept"] as? [String: Any] {
                #expect(result.diagnostics == [], "\(name)")
                let tables = try uslLayout(result, store: .files)
                #expect(tables.count == 1, "\(name)")
                #expect(tables.first?.columns.map(\.name) == accept["columns"] as? [String], "\(name)")
                #expect(tables.first?.primaryKey == accept["primaryKey"] as? [String], "\(name)")
            } else if let reject = schema["reject"] as? [String: Any], let code = reject["code"] as? String {
                if code == "collection-tables" {
                    #expect(result.diagnostics == [], "\(name)")
                    #expect(try uslLayout(result, store: .files).count != 1, "\(name)")
                    continue
                }
                let first = try #require(result.diagnostics.first, "\(name)")
                #expect(first.code == code, "\(name)")
                if let line = reject["line"] as? Int { #expect(first.line == line, "\(name)") }
                if let column = reject["column"] as? Int { #expect(first.column == column, "\(name)") }
            }
        }
    }

    @Test("Resolution: a connection model is keyed by its ends; 1:n is a column, n:m a join table")
    func resolution() throws {
        let rating = compileUSL("model Game { name Text }\nmodel Rating { Person.ratings[], Game.ratings[], stars Number }\n")
        #expect(rating.models.first { $0.name == "Rating" }?.key == ["person", "game"])
        let storage = compileUSL("model Episode { title Text }\nmodel Series { title Text }\nSeries.episodes[] <-> Episode.series\nPerson.games[] <-> Game.authors[]\nmodel Game { name Text }\n")
        #expect(storage.connections.map(\.storage) == [.column(on: "Episode", field: "series"), .array(on: "Game", field: "authors")])
        let tables = try uslLayout(storage)
        #expect(tables.map(\.name) == ["Episode", "Series", "Game", "Game_authors"])
    }

    @Test("Limits and syntax errors carry positions")
    func syntaxErrors() {
        let broken = parseUSL("model Book {\n  title Text\n  author ?\n}\n")
        #expect(broken.file == nil)
        #expect(broken.diagnostics.first?.code == "syntax")
        #expect(broken.diagnostics.first?.line == 3)
        let deep = String(repeating: "[", count: 40) + String(repeating: "]", count: 40)
        #expect(parseUSL("model A { @@views(\(deep)) }").diagnostics.first?.code == "limit")
    }
}
