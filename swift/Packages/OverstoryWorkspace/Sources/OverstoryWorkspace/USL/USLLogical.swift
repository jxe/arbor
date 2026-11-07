import Foundation

// A collection's rows in their logical form (spec 06 §2.2), as the tree holds
// them, turned into the rows of a layout's tables. A port of the
// logical-to-rows direction of `packages/usl/src/logical.ts` and of
// `rowsFromRecords` in `records.ts`; the rules are at the top of logical.ts.

/// One field of a row's key, with its value.
public struct USLKeyPart: Sendable, Equatable {
    public var name: String
    public var value: JSONValue

    public init(name: String, value: JSONValue) {
        self.name = name
        self.value = value
    }
}

/// A row as the tree holds it: its key, its stored fields and its times.
public struct USLLogicalRow: Sendable, Equatable {
    public var key: [USLKeyPart]
    public var fields: [String: JSONValue]
    public var created: String
    public var modified: String

    public init(key: [USLKeyPart], fields: [String: JSONValue], created: String, modified: String) {
        self.key = key
        self.fields = fields
        self.created = created
        self.modified = modified
    }

    /// The value a reference to this row holds: its one key field's value, or the pairs.
    var keyValue: JSONValue {
        key.count == 1 ? key[0].value : .array(key.map { .array([.string($0.name), $0.value]) })
    }
}

/// Rows by model name, each table in stable-key order.
public typealias USLLogicalTables = [String: [USLLogicalRow]]

private struct LogicalField {
    enum Kind { case value, reference, members }
    var name: String
    var type: String
    var kind: Kind
}

private struct LogicalModel {
    var name: String
    var keyFields: [LogicalField]
    var fields: [LogicalField]
}

/// Where a connection field's data is held, from the model that has the field.
private func holdsHere(_ result: USLCheckResult, _ model: USLResolvedModel, _ field: String) -> Bool {
    func hasRows(_ name: String) -> Bool { name != "Person" && result.models.first { $0.name == name }?.rows != .fixed }
    for c in result.connections {
        let here: USLResolvedEnd, other: USLResolvedEnd
        if c.a.model == model.name && c.a.field == field { here = c.a; other = c.b }
        else if c.b.model == model.name && c.b.field == field { here = c.b; other = c.a }
        else { continue }
        if here.ordered { return true }
        if other.ordered { return false }
        if here.arity == .many && other.arity == .many {
            let first = [c.a, c.b].first { hasRows($0.model) }
            return first == here
        }
        if here.arity == .many { return false }
        if other.arity == .many { return true }
        // 1:1: where the layout puts the column.
        if case let .column(on, f) = c.storage { return on == here.model && f == here.field }
        return false
    }
    // An end of a connection model: its rows hold it, unless the end is ordered.
    for m in result.models {
        if let end = m.ends.first(where: { $0.model == model.name && $0.field == field }) { return end.ordered }
    }
    return false
}

/// The models with data rows and the fields their logical rows hold.
private func logicalModels(_ result: USLCheckResult) -> [LogicalModel] {
    var out: [LogicalModel] = []
    for model in result.models where model.name != "Person" && model.rows != .fixed {
        let keyFields = model.key.map { k -> LogicalField in
            if k == "id" { return LogicalField(name: "id", type: "Text", kind: .value) }
            let f = model.fields.first { $0.name == k }!
            return LogicalField(name: k, type: f.type, kind: uslValueTypes.contains(f.type) ? .value : .reference)
        }
        var fields: [LogicalField] = []
        for f in model.fields where !model.key.contains(f.name) {
            if uslValueTypes.contains(f.type) {
                fields.append(LogicalField(name: f.name, type: f.type, kind: .value))
            } else if f.origin == .end {
                fields.append(LogicalField(name: f.name, type: f.type, kind: .reference))
            } else if holdsHere(result, model, f.name) {
                fields.append(LogicalField(name: f.name, type: f.type, kind: f.arity == .many ? .members : .reference))
            }
        }
        out.append(LogicalModel(name: model.name, keyFields: keyFields, fields: fields))
    }
    return out
}

/// A record being built: a model's fields by name, shared while the n:m ends and positions are filled in.
private final class Record {
    var values: [String: JSONValue] = [:]
}

/// The rows of `layout`'s tables (a `uslLayout` result) that hold `tables`.
/// Every n:m connection gets its arrays on both ends first, so any layout can
/// store it; timestamps go to the `created` and `modified` columns.
public func uslRowsFromLogical(_ result: USLCheckResult, layout: [USLTable], tables: USLLogicalTables) throws -> USLRowsByTable {
    if !result.diagnostics.isEmpty { throw USLLayoutError(message: "The schema has errors; check it first", location: nil) }
    var layoutTables: [String: USLTable] = [:]
    for t in layout where t.ends == nil { layoutTables[t.stores] = t }
    var models: [String: LogicalModel] = [:]
    for m in logicalModels(result) { models[m.name] = m }

    func keyColumns(_ target: String) throws -> [(field: String, column: String)] {
        guard let table = layoutTables[target], let model = result.models.first(where: { $0.name == target }) else { return [("id", "id")] }
        return try model.key.map { k in
            let columns = table.fields.first { $0.name == k }?.columns ?? [k]
            guard columns.count == 1 else {
                throw USLLayoutError(message: "`\(target).\(k)` refers to a key of several fields, which logical collections don't hold yet", location: target)
            }
            return (k, columns[0])
        }
    }
    /// A logical key value as a record's reference.
    func referenceOut(_ target: String, _ value: JSONValue) throws -> JSONValue {
        guard layoutTables[target] != nil else { return value }
        let columns = try keyColumns(target)
        guard columns.count > 1, case let .array(items) = value else { return value }
        var pairs: [String: JSONValue] = [:]
        for item in items {
            if case let .array(pair) = item, pair.count == 2, case let .string(name) = pair[0] { pairs[name] = pair[1] }
        }
        return .object(Dictionary(uniqueKeysWithValues: columns.map { ($0.column, pairs[$0.field] ?? .null) }))
    }

    var records: [String: [Record]] = [:]
    var byKey: [String: [String: Record]] = [:]
    for model in models.values {
        var list: [Record] = []
        var index: [String: Record] = [:]
        for row in tables[model.name] ?? [] {
            let record = Record()
            for part in row.key {
                let f = model.keyFields.first { $0.name == part.name }
                record.values[part.name] = f?.kind == .reference ? try referenceOut(f!.type, part.value) : part.value
            }
            for f in model.fields {
                guard let value = row.fields[f.name] else { continue }
                switch f.kind {
                case .reference: record.values[f.name] = try referenceOut(f.type, value)
                case .members: record.values[f.name] = .array(try (value.arrayValue ?? []).map { try referenceOut(f.type, $0) })
                case .value: record.values[f.name] = value
                }
            }
            record.values["created"] = .string(row.created)
            record.values["modified"] = .string(row.modified)
            list.append(record)
            index[row.keyValue.jsonText] = record
        }
        records[model.name] = list
        byKey[model.name] = index
    }
    // The derived end of each n:m connection, so a layout carrying it there can store it.
    for conn in result.connections where conn.a.arity == .many && conn.b.arity == .many {
        for (end, other) in [(conn.a, conn.b), (conn.b, conn.a)] {
            guard let model = models[end.model], model.fields.contains(where: { $0.name == end.field && $0.kind == .members }),
                  let others = byKey[other.model] else { continue }
            for record in others.values where record.values[other.field] == nil { record.values[other.field] = .array([]) }
            for row in tables[end.model] ?? [] {
                let selfValue = try referenceOut(end.model, row.keyValue)
                for member in row.fields[end.field]?.arrayValue ?? [] {
                    guard let record = others[member.jsonText], case var .array(list)? = record.values[other.field] else { continue }
                    list.append(selfValue)
                    record.values[other.field] = .array(list)
                }
            }
        }
    }
    // An ordered end of a connection model: positions on its rows, from the holder's sequence.
    for conn in result.models {
        for end in conn.ends where end.ordered {
            guard let rows = byKey[conn.name] else { continue }
            for holder in tables[end.model] ?? [] {
                for (i, member) in (holder.fields[end.field]?.arrayValue ?? []).enumerated() {
                    if let record = rows[member.jsonText] { record.values["\(end.field)_position"] = .number(Double(i)) }
                }
            }
        }
    }
    return uslRowsFromRecords(layout, records: records.mapValues { $0.map(\.values) })
}

// MARK: - Records and rows (`records.ts`)

/// Reads a stored key: one column's value, or an object of `keyColumns`.
private func readKey(_ row: USLRow, _ columns: [String], _ keyColumns: [String]) -> JSONValue {
    if columns.count == 1 { return row[columns[0]] ?? .null }
    return .object(Dictionary(uniqueKeysWithValues: zip(keyColumns, columns).map { ($0, row[$1] ?? .null) }))
}

/// Writes a key into `columns` of `row`.
private func writeKey(_ row: inout USLRow, _ columns: [String], _ keyColumns: [String], _ key: JSONValue) {
    if columns.count == 1 { row[columns[0]] = key; return }
    let value: [String: JSONValue]
    if case let .object(members) = key { value = members } else { value = [:] }
    for (i, c) in columns.enumerated() { row[c] = key.isNull ? .null : value[keyColumns[i]] }
}

private struct LayoutTables {
    var byModel: [String: USLTable] = [:]
    var models: [String] = []
    var joins: [USLTable] = []

    init(_ tables: [USLTable]) {
        for t in tables {
            if t.ends != nil { joins.append(t) } else { byModel[t.stores] = t; models.append(t.stores) }
        }
    }
    func keyColumns(_ model: String?) -> [String] {
        guard let model, let key = byModel[model]?.primaryKey, !key.isEmpty else { return ["id"] }
        return key
    }
    func keyColumnsOf(_ field: USLStoredField) -> [String] { field.target.map { keyColumns($0) } ?? field.columns }
    /// Which ends of a join table carry its array on records.
    func carriers(_ join: USLTable) -> [USLJoinEnd] {
        let ends = join.ends!.filter { byModel[$0.model] != nil }
        let folded = ends.filter(\.fold)
        return folded.isEmpty ? ends : folded
    }
}

/// The row of `table` (a model's table) that stores `record`.
private func rowOf(_ t: LayoutTables, _ table: USLTable, _ record: [String: JSONValue]) -> USLRow {
    var row: USLRow = [:]
    var held = Set<String>()
    for field in table.fields {
        held.formUnion(field.columns)
        guard let value = record[field.name] else { continue }
        if field.target != nil, value.arrayValue == nil { writeKey(&row, field.columns, t.keyColumnsOf(field), value) }
        else { row[field.columns[0]] = value }
    }
    for column in table.columns where !held.contains(column.name) {
        if let value = record[column.name] { row[column.name] = value }
    }
    return row
}

/// Rows for every table, from records by model.
public func uslRowsFromRecords(_ tables: [USLTable], records: [String: [[String: JSONValue]]]) -> USLRowsByTable {
    let t = LayoutTables(tables)
    var out: USLRowsByTable = [:]
    for model in t.models {
        let table = t.byModel[model]!
        out[table.name] = (records[model] ?? []).map { rowOf(t, table, $0) }
    }
    for join in t.joins {
        var rows = OrderedMap<USLRow>()
        for end in t.carriers(join) {
            let other = join.ends![0] == end ? join.ends![1] : join.ends![0]
            let table = t.byModel[end.model]!
            for record in records[end.model] ?? [] {
                guard let members = record[end.field]?.arrayValue else { continue }
                let key = readKey(rowOf(t, table, record), table.primaryKey, table.primaryKey)
                for (i, member) in members.enumerated() {
                    var row: USLRow = [:]
                    writeKey(&row, end.columns, t.keyColumns(end.model), key)
                    writeKey(&row, other.columns, t.keyColumns(other.model), member)
                    if let position = end.position { row[position] = .number(Double(i)) }
                    let id = JSONValue.array(join.primaryKey.map { row[$0] ?? .null }).jsonText
                    // A connection's times are its holder's, the latest it can have changed.
                    var merged: USLRow = [:]
                    if case let .string(modified)? = record["modified"] {
                        merged["created"] = .string(modified)
                        merged["modified"] = .string(modified)
                    }
                    for (k, v) in rows[id] ?? [:] { merged[k] = v }
                    for (k, v) in row { merged[k] = v }
                    rows[id] = merged
                }
            }
        }
        out[join.name] = rows.values
    }
    return out
}
