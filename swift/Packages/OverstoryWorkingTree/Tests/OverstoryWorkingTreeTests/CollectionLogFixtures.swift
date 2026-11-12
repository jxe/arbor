import OverstoryWorkspace
@testable import Overstory
import Foundation
import SQLite3

/// A games collection held as a log (collections §1), for tests.
enum GamesCollection {
    static let source = """
        main table Game:
          name   Text
          status Status
          tags   Text[]

        Game.status <-> Status.games[]

        enum Status:
          Draft
          Polished
        """
    static let rowsHash = "sha256:" + String(repeating: "3", count: 64)
    static let fingerprint = "sha256:" + String(repeating: "3", count: 64)

    static func game(_ id: String, _ name: String, _ status: String, tags: [String] = [], created: Int = 1_792_832_400_000) -> ProtocolLogicalRow {
        var fields: [String: ProtocolReadValue] = ["name": .string(name), "status": .string(status)]
        if !tags.isEmpty { fields["tags"] = .array(tags.map { .string($0) }) }
        return ProtocolLogicalRow(key: [.init(field: "id", value: .string(id))], fields: fields, created: created, modified: created)
    }

    static func set(_ row: ProtocolLogicalRow) -> ProtocolRowChange { ProtocolRowChange(model: "Game", key: row.key, row: row) }
    static func remove(_ id: String) -> ProtocolRowChange { ProtocolRowChange(model: "Game", key: [.init(field: "id", value: .string(id))], row: nil) }

    /// A log whose first entry sets chess and go: the head and every object the collection reaches.
    static func firstEntryLog() throws -> (head: String, objects: [ProtocolObjectEnvelope]) {
        let head = try ProtocolObjectCodec.object(.log(ProtocolLog(previous: nil, rows: 2, rowsHash: rowsHash, body: .changes([
            set(game("chess", "Chess", "Draft", tags: ["board", "classic"])),
            set(game("go", "Go", "Polished")),
        ]))))
        return (head.hash, [head])
    }

    /// A log that reaches chess and go through a snapshot: a first entry
    /// (not reached), a snapshot of chess and draughts, then an entry that
    /// sets go and removes draughts.
    static func snapshotLog() throws -> (head: String, objects: [ProtocolObjectEnvelope], unreached: ProtocolObjectEnvelope) {
        let first = try ProtocolObjectCodec.object(.log(ProtocolLog(previous: nil, rows: 0, rowsHash: rowsHash, body: .changes([]))))
        let file = try ProtocolObjectCodec.object(.file(try sqliteSnapshot([
            game("chess", "Chess", "Draft", tags: ["classic", "board"]),
            game("draughts", "Draughts", "Polished"),
        ])))
        let snapshot = try ProtocolObjectCodec.object(.log(ProtocolLog(previous: first.hash, rows: 2, rowsHash: rowsHash, body: .snapshot(file.hash))))
        let head = try ProtocolObjectCodec.object(.log(ProtocolLog(previous: snapshot.hash, rows: 2, rowsHash: rowsHash, body: .changes([
            remove("draughts"),
            set(game("go", "Go", "Polished")),
        ]))))
        return (head.hash, [head, snapshot, file], first)
    }

    /// A SQLite file of `games` in the schema's database layout, as a host writes a snapshot.
    static func sqliteSnapshot(_ games: [ProtocolLogicalRow]) throws -> Data {
        let schema = compileCollectionSchema(source)
        let layout = try uslLayout(schema, store: .database)
        let logical = games.map { row in
            USLLogicalRow(key: row.key.map { USLKeyPart(name: $0.field, value: json($0.value)) }, fields: row.fields.mapValues(json),
                          created: ProtocolEntryTime.string(row.created), modified: ProtocolEntryTime.string(row.modified))
        }
        let rows = try uslRowsFromLogical(schema, layout: layout, tables: ["Game": logical])
        var database: OpaquePointer?
        guard sqlite3_open(":memory:", &database) == SQLITE_OK, let database else { throw CocoaError(.fileReadUnknown) }
        defer { sqlite3_close(database) }
        let quote = { (name: String) in "\"\(name.replacingOccurrences(of: "\"", with: "\"\""))\"" }
        for table in layout {
            let columns = table.columns.map(\.name)
            guard sqlite3_exec(database, "create table \(quote(table.name)) (\(columns.map(quote).joined(separator: ", ")))", nil, nil, nil) == SQLITE_OK else {
                throw CocoaError(.fileWriteUnknown)
            }
            for row in rows[table.name] ?? [] {
                var statement: OpaquePointer?
                let sql = "insert into \(quote(table.name)) values (\(columns.map { _ in "?" }.joined(separator: ", ")))"
                guard sqlite3_prepare_v2(database, sql, -1, &statement, nil) == SQLITE_OK else { throw CocoaError(.fileWriteUnknown) }
                defer { sqlite3_finalize(statement) }
                let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
                for (i, column) in table.columns.enumerated() {
                    let index = Int32(i + 1)
                    switch row[column.name] ?? .null {
                    case .null: sqlite3_bind_null(statement, index)
                    case let .bool(flag): sqlite3_bind_int(statement, index, flag ? 1 : 0)
                    case let .number(n): if n.rounded() == n { sqlite3_bind_int64(statement, index, Int64(n)) } else { sqlite3_bind_double(statement, index, n) }
                    case let .string(text): sqlite3_bind_text(statement, index, text, -1, transient)
                    case let value:
                        let text = String(decoding: try JSONEncoder().encode(value), as: UTF8.self)
                        sqlite3_bind_text(statement, index, text, -1, transient)
                    }
                }
                guard sqlite3_step(statement) == SQLITE_DONE else { throw CocoaError(.fileWriteUnknown) }
            }
        }
        var size: sqlite3_int64 = 0
        guard let bytes = sqlite3_serialize(database, "main", &size, 0) else { throw CocoaError(.fileWriteUnknown) }
        defer { sqlite3_free(bytes) }
        return Data(bytes: bytes, count: Int(size))
    }

    private static func json(_ value: ProtocolReadValue) -> JSONValue {
        switch value {
        case .null: .null
        case let .bool(flag): .bool(flag)
        case let .number(n): .number(n)
        case let .string(text): .string(text)
        case let .array(items): .array(items.map(json))
        case let .object(members): .object(members.mapValues(json))
        }
    }
}
