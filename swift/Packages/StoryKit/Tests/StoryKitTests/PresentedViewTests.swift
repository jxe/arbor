import Foundation
import Testing
@testable import StoryKit

/// docs/overstory-spec/conformance/presented-views.json, which the
/// TypeScript reference (`@ovst/usl` present.ts) also runs.
private let vectorsURL = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent()
    .appending(path: "../../../../../docs/overstory-spec/conformance/presented-views.json")
    .standardizedFileURL

private struct Fixture {
    var schema: USLCheckResult
    var rows: USLRowsByTable
    var people: [PresentedPerson]
}

private struct Vectors {
    var fixtures: [String: Fixture]
    var presentations: [[String: JSONValue]]
    var intents: [[String: JSONValue]]
    var logical: [[String: JSONValue]]
}

private enum VectorError: Error { case malformed(String) }

private func loadVectors() throws -> Vectors {
    let data = try Data(contentsOf: vectorsURL)
    guard case .object(let file) = try JSONDecoder().decode(JSONValue.self, from: data),
          case .object(let fixtures)? = file["fixtures"],
          case .array(let presentations)? = file["presentations"],
          case .array(let intents)? = file["intents"],
          case .array(let logical)? = file["logical"]
    else { throw VectorError.malformed("presented-views.json") }
    var decoded: [String: Fixture] = [:]
    for (name, value) in fixtures {
        guard case .object(let fixture) = value,
              case .string(let source)? = fixture["schema"],
              case .object(let tables)? = fixture["rows"]
        else { throw VectorError.malformed(name) }
        decoded[name] = Fixture(schema: compileUSL(source), rows: try rowsOf(.object(tables)), people: try peopleOf(fixture["people"]))
    }
    return Vectors(
        fixtures: decoded,
        presentations: try presentations.map(objectOf),
        intents: try intents.map(objectOf),
        logical: try logical.map(objectOf)
    )
}

private func objectOf(_ value: JSONValue) throws -> [String: JSONValue] {
    guard case .object(let object) = value else { throw VectorError.malformed("expected an object") }
    return object
}

private func rowsOf(_ value: JSONValue) throws -> USLRowsByTable {
    var rows: USLRowsByTable = [:]
    for (table, list) in try objectOf(value) {
        guard case .array(let items) = list else { throw VectorError.malformed(table) }
        rows[table] = try items.map(objectOf)
    }
    return rows
}

private func peopleOf(_ value: JSONValue?) throws -> [PresentedPerson] {
    guard case .array(let items)? = value else { return [] }
    return try items.map { item in
        let person = try objectOf(item)
        guard case .string(let id)? = person["id"], case .string(let name)? = person["name"] else {
            throw VectorError.malformed("person")
        }
        return PresentedPerson(id: id, name: name)
    }
}

private func string(_ value: JSONValue?) -> String? {
    if case .string(let s)? = value { return s }
    return nil
}

/// `after`: absent is unspecified, null is first, a string is after that row.
private func anchor(_ object: [String: JSONValue]) -> PresentedAnchor {
    switch object["after"] {
    case nil: .unspecified
    case .string(let row)?: .after(row)
    default: .first
    }
}

private func intentOf(_ value: JSONValue) throws -> ViewIntent {
    let o = try objectOf(value)
    let row = string(o["row"]) ?? ""
    switch string(o["kind"]) {
    case "set": return .set(row: row, field: string(o["field"]) ?? "", value: o["value"] ?? .null)
    case "connect": return .connect(row: row, field: string(o["field"]) ?? "", member: o["member"] ?? .null)
    case "disconnect": return .disconnect(row: row, field: string(o["field"]) ?? "", member: o["member"] ?? .null)
    case "create":
        let values = try o["values"].map(objectOf) ?? [:]
        return .create(id: string(o["id"]) ?? "", group: string(o["group"]), values: values, after: anchor(o))
    case "delete": return .delete(row: row)
    case "remove": return .remove(row: row, group: string(o["group"]) ?? "")
    case "move": return .move(row: row, group: string(o["group"]) ?? "", after: string(o["after"]))
    case "regroup": return .regroup(row: row, from: string(o["from"]) ?? "", to: string(o["to"]) ?? "", after: anchor(o))
    case "rename": return .rename(group: string(o["group"]) ?? "", value: string(o["value"]) ?? "")
    default: throw VectorError.malformed("intent \(o["kind"] ?? .null)")
    }
}

/// Logical tables: each row's key as `[name, value]` pairs, its fields and times.
private func logicalTablesOf(_ value: JSONValue?) throws -> USLLogicalTables {
    guard let value else { throw VectorError.malformed("logical tables") }
    var tables: USLLogicalTables = [:]
    for (model, list) in try objectOf(value) {
        guard case .array(let items) = list else { throw VectorError.malformed(model) }
        tables[model] = try items.map { item in
            let row = try objectOf(item)
            guard case .array(let pairs)? = row["key"],
                  case .string(let created)? = row["created"],
                  case .string(let modified)? = row["modified"]
            else { throw VectorError.malformed("\(model) row") }
            let key = try pairs.map { pair -> USLKeyPart in
                guard case .array(let p) = pair, p.count == 2, case .string(let name) = p[0] else {
                    throw VectorError.malformed("\(model) key")
                }
                return USLKeyPart(name: name, value: p[1])
            }
            return USLLogicalRow(key: key, fields: try row["fields"].map(objectOf) ?? [:], created: created, modified: modified)
        }
    }
    return tables
}

private func rowsJSON(_ rows: USLRowsByTable) -> JSONValue {
    .object(rows.mapValues { .array($0.map(JSONValue.object)) })
}

private func view(_ item: [String: JSONValue]) -> Int {
    if case .number(let n)? = item["view"] { return Int(n) }
    return 0
}

@Suite("Presented views")
struct PresentedViewTests {
    @Test("The fixtures check clean and their rows are valid")
    func fixturesCheckClean() throws {
        let vectors = try loadVectors()
        #expect(vectors.fixtures.count >= 3)
        for (name, fixture) in vectors.fixtures {
            #expect(fixture.schema.diagnostics == [], "\(name)")
            #expect(try checkRows(fixture.schema, fixture.rows) == [], "\(name)")
        }
    }

    @Test("Presentations match the shared vectors")
    func presentations() throws {
        let vectors = try loadVectors()
        #expect(!vectors.presentations.isEmpty)
        for item in vectors.presentations {
            let name = string(item["name"]) ?? "?"
            let fixture = try #require(vectors.fixtures[string(item["fixture"]) ?? ""], "\(name)")
            let options = PresentOptions(model: string(item["model"]), view: view(item), people: fixture.people, query: string(item["query"]))
            let presented = try presentView(fixture.schema, rows: fixture.rows, options: options)
            #expect(presented.json == item["expected"], "\(name)")
        }
    }

    @Test("Intents become the shared vectors' row operations")
    func intents() throws {
        let vectors = try loadVectors()
        #expect(!vectors.intents.isEmpty)
        for item in vectors.intents {
            let name = string(item["name"]) ?? "?"
            let fixture = try #require(vectors.fixtures[string(item["fixture"]) ?? ""], "\(name)")
            let options = PresentOptions(model: string(item["model"]), view: view(item), people: fixture.people)
            let intentValue = try #require(item["intent"], "\(name)")
            let intent = try intentOf(intentValue)
            let at = string(try objectOf(intentValue)["at"])
            if item["error"] == .bool(true) {
                #expect(throws: ViewError.self, "\(name)") {
                    try viewEdits(fixture.schema, rows: fixture.rows, options: options, intent: intent, at: at)
                }
                continue
            }
            let edits = try viewEdits(fixture.schema, rows: fixture.rows, options: options, intent: intent, at: at)
            #expect(JSONValue.array(edits.map(\.json)) == item["operations"], "\(name)")
            let after = try applyRowEdits(fixture.schema, fixture.rows, edits)
            #expect(rowsJSON(after) == item["rows"], "\(name)")
            #expect(try checkRows(fixture.schema, after) == [], "\(name)")
            _ = try presentView(fixture.schema, rows: after, options: options)
        }
    }

    @Test("Logical tables become the shared vectors' layout rows")
    func logicalRows() throws {
        let vectors = try loadVectors()
        #expect(!vectors.logical.isEmpty)
        for item in vectors.logical {
            let name = string(item["fixture"]) ?? "?"
            let fixture = try #require(vectors.fixtures[name], "\(name)")
            let layout = try uslLayout(fixture.schema, store: .files)
            let rows = try uslRowsFromLogical(fixture.schema, layout: layout, tables: try logicalTablesOf(item["tables"]))
            #expect(rowsJSON(rows) == item["rows"], "\(name)")
            #expect(try checkRows(fixture.schema, rows) == [], "\(name)")
        }
    }

    @Test("The first paragraph of Markdown")
    func firstParagraph() {
        #expect(uslFirstParagraph("") == "")
        #expect(uslFirstParagraph("\n\n  One\r\ntwo  \n\nThree") == "One two")
        #expect(uslFirstParagraph("# Title\nbody") == "# Title body")
    }

    @Test("Applying row operations refuses what doesn't apply")
    func refusals() throws {
        let vectors = try loadVectors()
        let games = try #require(vectors.fixtures["games"])
        let g1 = #"[["id","g1"]]"#
        #expect(throws: ViewError.self) {
            try applyRowEdits(games.schema, games.rows, [.set(table: "Game", row: g1, field: "name", before: .string("Not it"), value: .string("X"), at: nil)])
        }
        #expect(throws: ViewError.self) {
            try applyRowEdits(games.schema, games.rows, [.delete(table: "Game", row: #"[["id","g9"]]"#)])
        }
    }
}
