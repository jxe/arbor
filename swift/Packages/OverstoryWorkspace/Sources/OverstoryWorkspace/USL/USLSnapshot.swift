import Foundation
import SQLite3

// A collection snapshot's database (collections §1): rows in the schema's
// database layout, as a SQLite file's bytes. The tree's host writes one now
// and then; a client loading a log that starts from it reads it back. A port of
// the reading half of `packages/beetle/src/sqlite/snapshot.ts`.

public struct USLSnapshotError: Error, Sendable, Equatable {
    public var message: String

    public init(message: String) { self.message = message }
}

/// The rows a snapshot's SQLite file holds in `layout` (a `uslLayout(_, store: .database)`
/// result): flags as booleans, value arrays parsed from their JSON text.
public func uslSnapshotRows(_ layout: [USLTable], bytes: Data) throws -> USLRowsByTable {
    var database: OpaquePointer?
    guard sqlite3_open_v2(":memory:", &database, SQLITE_OPEN_READWRITE | SQLITE_OPEN_MEMORY, nil) == SQLITE_OK, let database else {
        throw USLSnapshotError(message: "Can't open a database for the snapshot")
    }
    defer { sqlite3_close(database) }
    // SQLite owns and frees the copy (FREEONCLOSE); the file is only read.
    let size = bytes.count
    guard let buffer = sqlite3_malloc64(sqlite3_uint64(max(size, 1))) else { throw USLSnapshotError(message: "Out of memory") }
    bytes.withUnsafeBytes { source in
        if let base = source.baseAddress { buffer.copyMemory(from: base, byteCount: size) }
    }
    let flags = UInt32(SQLITE_DESERIALIZE_FREEONCLOSE | SQLITE_DESERIALIZE_READONLY)
    guard sqlite3_deserialize(database, "main", buffer.assumingMemoryBound(to: UInt8.self), sqlite3_int64(size), sqlite3_int64(size), flags) == SQLITE_OK else {
        throw USLSnapshotError(message: String(cString: sqlite3_errmsg(database)))
    }
    var out: USLRowsByTable = [:]
    for table in layout {
        let sql = "select * from \"\(table.name.replacingOccurrences(of: "\"", with: "\"\""))\""
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(database, sql, -1, &statement, nil) == SQLITE_OK, let statement else {
            throw USLSnapshotError(message: "The snapshot has no table \(table.name): \(String(cString: sqlite3_errmsg(database)))")
        }
        defer { sqlite3_finalize(statement) }
        var names: [String] = []
        for i in 0..<sqlite3_column_count(statement) { names.append(String(cString: sqlite3_column_name(statement, i))) }
        var rows: [USLRow] = []
        while true {
            let step = sqlite3_step(statement)
            if step == SQLITE_DONE { break }
            guard step == SQLITE_ROW else { throw USLSnapshotError(message: String(cString: sqlite3_errmsg(database))) }
            var stored: [String: JSONValue] = [:]
            for (i, name) in names.enumerated() {
                let index = Int32(i)
                switch sqlite3_column_type(statement, index) {
                case SQLITE_INTEGER: stored[name] = .number(Double(sqlite3_column_int64(statement, index)))
                case SQLITE_FLOAT: stored[name] = .number(sqlite3_column_double(statement, index))
                case SQLITE_TEXT: stored[name] = .string(String(cString: sqlite3_column_text(statement, index)))
                case SQLITE_BLOB: throw USLSnapshotError(message: "A snapshot holds a blob in \(table.name).\(name)")
                default: stored[name] = .null
                }
            }
            var row: USLRow = [:]
            for column in table.columns {
                let value = stored[column.name] ?? .null
                if value.isNull { row[column.name] = .null }
                else if column.array, case let .string(text) = value {
                    row[column.name] = (try? JSONDecoder().decode(JSONValue.self, from: Data(text.utf8))) ?? value
                } else if column.type == .bool, case let .number(n) = value { row[column.name] = .bool(n != 0) }
                else { row[column.name] = value }
            }
            rows.append(row)
        }
        out[table.name] = rows
    }
    return out
}
