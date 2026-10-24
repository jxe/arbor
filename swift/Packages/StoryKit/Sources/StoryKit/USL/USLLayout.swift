import Foundation

// The relational layout of a checked schema, and the checks a row's values
// get against it. A port of `packages/usl/src/layout.ts` and `rows.ts`; the
// rules are at the top of layout.ts and in spec 11 §7.

public enum USLColumnType: String, Sendable, Equatable {
    case text, int, number, bool, date, timestamp, position
}

public struct USLColumnReferences: Sendable, Equatable {
    public var table: String
    public var columns: [USLColumn]
}

public struct USLColumn: Sendable, Equatable {
    public var name: String
    public var type: USLColumnType
    /// Value arrays are stored in one column.
    public var array: Bool
    public var nullable: Bool
    /// For a reference to an enum: the allowed value names.
    public var allowed: [String]?
    /// For a reference to Person: the column holds a profile id.
    public var profile = false
    /// For a folded connection: each item names a row of `table` by its key columns.
    public var references: USLColumnReferences?
}

public struct USLForeignKey: Sendable, Equatable {
    public enum OnDelete: String, Sendable { case cascade, setNull = "set null", restrict }
    public var columns: [String]
    public var table: String
    public var refColumns: [String]
    public var onDelete: OnDelete
}

/// The columns that hold one field of a model's rows.
public struct USLStoredField: Sendable, Equatable {
    public var name: String
    public var columns: [String]
    /// For a reference: the model it names a row of.
    public var target: String?
}

/// One side of a join table: the rows of `model` whose `field` holds the connection.
public struct USLJoinEnd: Sendable, Equatable {
    public var model: String
    public var field: String
    public var columns: [String]
    /// For an `ordered` end: the column that orders `field`'s members.
    public var position: String?
    /// `@fold`: in data files, `field` holds the connection as an array.
    public var fold: Bool
}

public struct USLTable: Sendable, Equatable {
    public var name: String
    /// The model this table stores, or the connection a join table stores (`Game.authors`).
    public var stores: String
    public var columns: [USLColumn]
    public var primaryKey: [String]
    public var uniques: [[String]]
    public var foreignKeys: [USLForeignKey]
    public var indexes: [[String]]
    /// For a model's table: which columns hold each field.
    public var fields: [USLStoredField]
    /// For a join table: its two sides.
    public var ends: [USLJoinEnd]?
    /// `seed` rows, inserted when missing.
    public var seed: [[String: JSONValue]]
}

public enum USLStore: Sendable {
    /// Every n:m connection in a join table.
    case database
    /// `@fold` connections as arrays, as data files store them.
    case files
}

public struct USLLayoutError: Error, Sendable {
    public var message: String
    /// The model or connection (`Model.field`) the problem is in.
    public var location: String?
}

private let valueColumn: [String: USLColumnType] = [
    "Text": .text, "Markdown": .text, "Int": .int, "Number": .number, "Bool": .bool, "Date": .date,
]

private struct LayoutContext {
    var models: [String: USLResolvedModel] = [:]

    func hasTable(_ name: String) -> Bool { name != "Person" && models[name]?.rows != .fixed }
    func tableName(_ model: String) -> String { models[model]?.table ?? model }

    // The columns that identify a row of `model`, as they appear in its own table.
    func keyColumns(_ model: USLResolvedModel, _ seen: [String] = []) throws -> [USLColumn] {
        if seen.contains(model.name) { throw USLLayoutError(message: "\((seen + [model.name]).joined(separator: " → ")) key each other", location: nil) }
        var out: [USLColumn] = []
        for k in model.key {
            if k == "id" {
                out.append(USLColumn(name: "id", type: .text, array: false, nullable: false))
                continue
            }
            let field = model.fields.first { $0.name == k }!
            if let type = valueColumn[field.type] {
                out.append(USLColumn(name: field.column ?? field.name, type: type, array: false, nullable: false))
            } else {
                out += try referenceColumns(field.type, field.column ?? field.name, false, seen + [model.name])
            }
        }
        return out
    }

    // The columns in another table that point at a row of `target`.
    func referenceColumns(_ target: String, _ name: String, _ nullable: Bool, _ seen: [String] = []) throws -> [USLColumn] {
        if target == "Person" { return [USLColumn(name: name, type: .text, array: false, nullable: nullable, profile: true)] }
        let model = models[target]!
        if model.rows == .fixed {
            return [USLColumn(name: name, type: .text, array: false, nullable: nullable, allowed: model.schemaRows.map(\.name))]
        }
        let keys = try keyColumns(model, seen)
        return keys.map { c in
            var column = c
            column.name = keys.count == 1 ? name : "\(name)_\(c.name)"
            column.nullable = nullable
            return column
        }
    }

    func foreignKey(_ target: String, _ columns: [USLColumn], _ onDelete: USLForeignKey.OnDelete) throws -> [USLForeignKey] {
        guard hasTable(target) else { return [] }
        return [USLForeignKey(columns: columns.map(\.name), table: tableName(target), refColumns: try keyColumns(models[target]!).map(\.name), onDelete: onDelete)]
    }

    func timestamps() -> [USLColumn] {
        [USLColumn(name: "created", type: .timestamp, array: false, nullable: false), USLColumn(name: "modified", type: .timestamp, array: false, nullable: false)]
    }

    func joinTable(_ a: USLResolvedEnd, _ b: USLResolvedEnd) throws -> USLTable {
        let nameA = lowerFirst(a.model)
        let nameB = a.model == b.model ? a.field : lowerFirst(b.model)
        let colsA = try referenceColumns(a.model, nameA, false)
        let colsB = try referenceColumns(b.model, nameB, false)
        let positions = [a, b].filter(\.ordered).map { USLColumn(name: "\($0.field)_position", type: .position, array: false, nullable: false) }
        let foreignKeys = try foreignKey(a.model, colsA, .cascade) + foreignKey(b.model, colsB, .cascade)
        return USLTable(
            name: "\(tableName(a.model))_\(a.field)",
            stores: "\(a.model).\(a.field)",
            columns: colsA + colsB + positions + timestamps(),
            primaryKey: (colsA + colsB).map(\.name),
            uniques: [],
            foreignKeys: foreignKeys,
            indexes: [],
            fields: [],
            ends: [
                USLJoinEnd(model: a.model, field: a.field, columns: colsA.map(\.name), position: a.ordered ? "\(a.field)_position" : nil, fold: a.fold),
                USLJoinEnd(model: b.model, field: b.field, columns: colsB.map(\.name), position: b.ordered ? "\(b.field)_position" : nil, fold: b.fold),
            ],
            seed: []
        )
    }
}

public func uslLayout(_ result: USLCheckResult, store: USLStore = .database) throws -> [USLTable] {
    if !result.diagnostics.isEmpty { throw USLLayoutError(message: "The schema has errors; check it first", location: nil) }
    var context = LayoutContext()
    for model in result.models { context.models[model.name] = model }
    let models = context.models
    func hasTable(_ name: String) -> Bool { context.hasTable(name) }
    func tableName(_ model: String) -> String { context.tableName(model) }
    func columnName(_ name: String, _ column: String?) -> String { column ?? name }
    func keyColumns(_ model: USLResolvedModel) throws -> [USLColumn] { try context.keyColumns(model) }
    func referenceColumns(_ target: String, _ name: String, _ nullable: Bool) throws -> [USLColumn] { try context.referenceColumns(target, name, nullable) }
    func foreignKey(_ target: String, _ columns: [USLColumn], _ onDelete: USLForeignKey.OnDelete) throws -> [USLForeignKey] { try context.foreignKey(target, columns, onDelete) }
    func timestamps() -> [USLColumn] { context.timestamps() }
    func joinTable(_ a: USLResolvedEnd, _ b: USLResolvedEnd) throws -> USLTable { try context.joinTable(a, b) }

    var tables = OrderedMap<USLTable>()
    for model in result.models {
        if !hasTable(model.name) { continue }
        let key = try keyColumns(model)
        var table = USLTable(name: tableName(model.name), stores: model.name, columns: key, primaryKey: key.map(\.name), uniques: [], foreignKeys: [], indexes: [], fields: [], ends: nil, seed: [])
        // Key fields that are references need foreign keys too.
        for k in model.key {
            guard let field = model.fields.first(where: { $0.name == k }) else {
                table.fields.append(USLStoredField(name: k, columns: [k], target: nil))
                continue
            }
            if valueColumn[field.type] != nil {
                table.fields.append(USLStoredField(name: k, columns: [columnName(field.name, field.column)], target: nil))
            } else {
                let cols = try referenceColumns(field.type, columnName(field.name, field.column), false)
                table.fields.append(USLStoredField(name: k, columns: cols.map(\.name), target: field.type))
                table.foreignKeys += try foreignKey(field.type, cols, model.ends.isEmpty ? .restrict : .cascade)
            }
        }
        for field in model.fields where !model.key.contains(field.name) {
            if let type = valueColumn[field.type] {
                let name = columnName(field.name, field.column)
                table.columns.append(USLColumn(name: name, type: type, array: field.arity == .many, nullable: field.arity == .optional))
                table.fields.append(USLStoredField(name: field.name, columns: [name], target: nil))
                if field.unique { table.uniques.append([name]) }
            } else if field.origin == .end {
                // A connection model with its own id: its ends are plain required references.
                let cols = try referenceColumns(field.type, columnName(field.name, field.column), false)
                table.columns += cols
                table.fields.append(USLStoredField(name: field.name, columns: cols.map(\.name), target: field.type))
                table.foreignKeys += try foreignKey(field.type, cols, .cascade)
            }
        }
        // Ordered ends of a connection model order its rows within each end's row.
        for end in model.ends where end.ordered {
            table.columns.append(USLColumn(name: "\(end.field)_position", type: .position, array: false, nullable: false))
        }
        table.columns += timestamps()
        if model.rows == .seed {
            var byField: [String: String] = [:]
            for f in model.fields { byField[f.name] = columnName(f.name, f.column) }
            table.seed = model.schemaRows.map { row in
                var values: [String: JSONValue] = ["id": .string(row.name)]
                for (k, v) in row.values { values[byField[k] ?? k] = v.json }
                return values
            }
        }
        tables[model.name] = table
    }

    func insertBeforeTimestamps(_ table: inout USLTable, _ columns: [USLColumn]) {
        table.columns.insert(contentsOf: columns, at: table.columns.count - 2)
    }

    for connection in result.connections {
        let a = connection.a, b = connection.b
        switch connection.storage {
        case .column(let on, let fieldName):
            let holder = on == a.model && fieldName == a.field ? a : b
            let other = holder == a ? b : a
            var table = tables[holder.model]!
            // A connection that is part of the key (`model Tag (list, id)`) already has its columns.
            if models[holder.model]!.key.contains(holder.field) { continue }
            let cols = try referenceColumns(other.model, holder.column ?? holder.field, holder.arity == .optional)
            insertBeforeTimestamps(&table, cols)
            table.fields.append(USLStoredField(name: holder.field, columns: cols.map(\.name), target: other.model))
            if other.ordered {
                insertBeforeTimestamps(&table, [USLColumn(name: "\(other.field)_position", type: .position, array: false, nullable: holder.arity == .optional)])
            }
            if other.arity != .many { table.uniques.append(cols.map(\.name)) }
            table.foreignKeys += try foreignKey(other.model, cols, holder.arity == .optional ? .setNull : .restrict)
            tables[holder.model] = table
        case .array where store == .files && (a.fold || b.fold):
            let holder = a.fold ? a : b
            let other = holder == a ? b : a
            let name = holder.column ?? holder.field
            var table = tables[holder.model]!
            var column: USLColumn
            if hasTable(other.model) {
                let keys = try keyColumns(models[other.model]!)
                let type: USLColumnType = keys.count == 1 ? keys[0].type : .text
                column = USLColumn(name: name, type: type, array: true, nullable: false, references: USLColumnReferences(table: tableName(other.model), columns: keys))
            } else {
                column = try referenceColumns(other.model, name, false)[0]
                column.array = true
            }
            insertBeforeTimestamps(&table, [column])
            table.fields.append(USLStoredField(name: holder.field, columns: [name], target: other.model))
            tables[holder.model] = table
        case .array:
            tables["\(a.model).\(a.field)"] = try joinTable(a, b)
        case .table, .fold:
            break
        }
    }

    for key in tables.keys {
        var table = tables[key]!
        if store == .files {
            // Data files have no indexes. Their rows keep `created` and `modified`
            // when an edit stated its time (spec 10 §4.1), so both are optional.
            table.columns = table.columns.map { c in
                var column = c
                if column.type == .timestamp { column.nullable = true }
                return column
            }
            tables[key] = table
            continue
        }
        let model = models[table.stores]
        var indexes: [[String]] = []
        func leadsKey(_ columns: [String]) -> Bool { columns.enumerated().allSatisfy { i, c in i < table.primaryKey.count && table.primaryKey[i] == c } }
        // References are looked up from the rows they name: foreign keys, and profile ids, whose table isn't here.
        for fk in table.foreignKeys where !leadsKey(fk.columns) { indexes.append(fk.columns) }
        for column in table.columns where column.profile && !column.array && !leadsKey([column.name]) { indexes.append([column.name]) }
        for fields in model?.indexes ?? [] {
            var columns: [String] = []
            for f in fields {
                if f == "created" || f == "modified" {
                    columns.append(f)
                    continue
                }
                guard let stored = table.fields.first(where: { $0.name == f }) else {
                    throw USLLayoutError(message: "`@index` names `\(f)`, which `\(table.name)` doesn't store; index the model that holds it", location: model!.name)
                }
                columns += stored.columns
            }
            indexes.append(columns)
        }
        // An index also serves lookups by its leading columns, so drop one that another starts with.
        func startsWith(_ long: [String], _ short: [String]) -> Bool { short.enumerated().allSatisfy { i, c in i < long.count && long[i] == c } }
        table.indexes = indexes.enumerated().filter { i, columns in
            !indexes.enumerated().contains { j, other in startsWith(other, columns) && (other.count > columns.count || j < i) }
        }.map(\.element)
        tables[key] = table
    }

    for (location, table) in tables.items {
        var seen = Set<String>()
        for c in table.columns {
            if seen.contains(c.name) { throw USLLayoutError(message: "Table `\(table.name)` would have two columns named `\(c.name)`; rename one with @column", location: location) }
            seen.insert(c.name)
        }
    }
    return tables.values
}

// MARK: - Row values (rows.ts)

public struct USLRowDiagnostic: Sendable, Equatable {
    public enum Code: String, Sendable { case badValue = "bad-value", missingValue = "missing-value", extraColumn = "extra-column" }
    public var code: Code
    public var column: String
    public var message: String
}

/// Whether `value` is a valid value for `column`. Null is never valid here; callers decide whether a column may be empty.
public func uslFitsColumn(_ value: JSONValue, _ column: USLColumn, item: Bool = false) -> Bool {
    if column.array && !item {
        guard case .array(let items) = value else { return false }
        return items.allSatisfy { uslFitsColumn($0, column, item: true) }
    }
    if item, let references = column.references {
        // A folded connection's item is the target's key: one value, or an object of its key columns.
        if references.columns.count == 1 {
            var key = references.columns[0]
            key.array = false
            return uslFitsColumn(value, key)
        }
        guard case .object(let record) = value else { return false }
        return references.columns.allSatisfy { k in
            var key = k
            key.array = false
            return uslFitsColumn(record[k.name] ?? .null, key)
        }
    }
    switch column.type {
    case .text:
        guard case .string(let s) = value else { return false }
        return column.allowed.map { $0.contains(s) } ?? true
    case .int:
        guard case .number(let n) = value else { return false }
        return n.isFinite && n == n.rounded() && abs(n) <= 9_007_199_254_740_991
    case .number, .position:
        guard case .number(let n) = value else { return false }
        return n.isFinite
    case .bool:
        guard case .bool = value else { return false }
        return true
    case .date, .timestamp:
        guard case .string(let s) = value else { return false }
        return parsesAsDate(s)
    }
}

func describeColumn(_ column: USLColumn) -> String {
    if let references = column.references { return "a list of \(references.table) keys" }
    if let allowed = column.allowed { return "one of \(allowed.map(jsonString).joined(separator: ", "))" }
    return "\(column.type == .position ? "number" : column.type.rawValue)\(column.array ? "[]" : "")"
}

/// Columns a row may leave out because the store fills them in.
func uslHasDefault(_ column: USLColumn) -> Bool { column.type == .timestamp || column.array }

/// Checks one row (already converted from its file format) against a table.
public func uslValidateRow(_ table: USLTable, _ row: [String: JSONValue]) -> [USLRowDiagnostic] {
    var out: [USLRowDiagnostic] = []
    var columns: [String: USLColumn] = [:]
    for c in table.columns { columns[c.name] = c }
    // Members in a stable order: the table's columns, then the rest by name.
    let names = table.columns.map(\.name).filter { row[$0] != nil } + row.keys.filter { columns[$0] == nil }.sorted { compareText($0, $1) < 0 }
    for name in names {
        let value = row[name]!
        guard let column = columns[name] else {
            out.append(USLRowDiagnostic(code: .extraColumn, column: name, message: "`\(name)` isn't in the schema"))
            continue
        }
        if value.isNull {
            if !column.nullable && !uslHasDefault(column) { out.append(USLRowDiagnostic(code: .missingValue, column: name, message: "`\(name)` is required")) }
        } else if !uslFitsColumn(value, column) {
            out.append(USLRowDiagnostic(code: .badValue, column: name, message: "`\(name)` should be \(describeColumn(column)), not \(value.jsonText)"))
        }
    }
    for column in table.columns where row[column.name] == nil && !column.nullable && !uslHasDefault(column) {
        out.append(USLRowDiagnostic(code: .missingValue, column: column.name, message: "`\(column.name)` is required"))
    }
    return out
}
