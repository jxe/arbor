import Foundation

// Presented views: a collection's rows arranged by one of its views, and the
// inverse that turns what a person does to that arrangement into row
// operations (spec 10 §4.1). A port of `packages/usl/src/present.ts`, whose
// header states the rules; both run
// `docs/overstory-spec/conformance/presented-views.json`.
//
// Rows are the data-file rows `uslLayout(…, store: .files)` lays out, by table
// name, in creation order. A row is named by its canonical stable key, the
// JSON of its key's column and value pairs: `[["id","g1"]]`.

public typealias USLRow = [String: JSONValue]
public typealias USLRowsByTable = [String: [USLRow]]

public struct PresentedChip: Sendable, Equatable {
    /// The member as stored: a row's key value, a profile id, a fixed row's name, or a listed value.
    public var member: JSONValue
    public var name: String
    public var color: String?

    var json: JSONValue {
        var object: [String: JSONValue] = ["member": member, "name": .string(name)]
        if let color { object["color"] = .string(color) }
        return .object(object)
    }
}

public enum PresentedCell: Sendable, Equatable {
    case text(field: String, type: String, value: JSONValue)
    case markdown(field: String, value: String?, paragraph: String)
    case chips(field: String, chips: [PresentedChip], summary: Bool, label: String?)
    case choice(field: String, value: String?, color: String?, bullet: Bool)

    var json: JSONValue {
        switch self {
        case .text(let field, let type, let value):
            return .object(["kind": .string("text"), "field": .string(field), "type": .string(type), "value": value])
        case .markdown(let field, let value, let paragraph):
            return .object(["kind": .string("markdown"), "field": .string(field), "value": value.map(JSONValue.string) ?? .null, "paragraph": .string(paragraph)])
        case .chips(let field, let chips, let summary, let label):
            var object: [String: JSONValue] = ["kind": .string("chips"), "field": .string(field), "chips": .array(chips.map(\.json))]
            if summary { object["summary"] = .bool(true) }
            if let label { object["label"] = .string(label) }
            return .object(object)
        case .choice(let field, let value, let color, let bullet):
            var object: [String: JSONValue] = ["kind": .string("choice"), "field": .string(field), "value": value.map(JSONValue.string) ?? .null]
            if let color { object["color"] = .string(color) }
            if bullet { object["bullet"] = .bool(true) }
            return .object(object)
        }
    }

    /// The text search looks in.
    var searchText: String {
        switch self {
        case .chips(_, let chips, _, _): chips.map(\.name).joined(separator: " ")
        case .markdown(_, let value, _): value ?? ""
        case .choice(_, let value, _, _): value ?? ""
        case .text(_, _, let value): value.isNull ? "" : scalarText(value)
        }
    }
}

public struct PresentedLine: Sendable, Equatable {
    /// The row's stable key.
    public var row: String
    /// Stable across presentations: the view, the group and the row.
    public var occurrence: String
    /// The `@bullet` choice's color, which colors the line too.
    public var color: String?
    public var cells: [PresentedCell]

    var json: JSONValue {
        var object: [String: JSONValue] = ["row": .string(row), "occurrence": .string(occurrence), "cells": .array(cells.map(\.json))]
        if let color { object["color"] = .string(color) }
        return .object(object)
    }
}

public enum PresentedGroupKind: String, Sendable, Equatable {
    case flat, connection, choice, unassigned
}

public struct PresentedGroup: Sendable, Equatable {
    public enum Remove: String, Sendable { case disconnect, delete }
    /// "" for a flat view, "unassigned", or the JSON of the group's member.
    public var id: String
    public var kind: PresentedGroupKind
    public var heading: String
    public var member: JSONValue?
    public var color: String?
    /// A connection group whose member is a row: that row's table and key.
    public var table: String?
    public var row: String?
    /// The field of `row` its heading edits; nil when the heading is read-only.
    public var headingField: String?
    /// Lines can be reordered: the group's order is stored (`@ordered`).
    public var ordered: Bool
    /// What Delete does to a line here.
    public var remove: Remove
    public var lines: [PresentedLine]

    var json: JSONValue {
        var object: [String: JSONValue] = [
            "id": .string(id), "kind": .string(kind.rawValue), "heading": .string(heading),
            "ordered": .bool(ordered), "remove": .string(remove.rawValue), "lines": .array(lines.map(\.json)),
        ]
        if let member { object["member"] = member }
        if let color { object["color"] = .string(color) }
        if let table { object["table"] = .string(table) }
        if let row { object["row"] = .string(row) }
        if let headingField { object["headingField"] = .string(headingField) }
        return .object(object)
    }
}

public struct PresentedRowCapabilities: Sendable, Equatable {
    public var edit: Bool
    public var delete: Bool
    /// The groups of this view the row is in, so "Delete row" can name them.
    public var groups: [String]
}

public struct PresentedView: Sendable, Equatable {
    public var model: String
    public var table: String
    public var tabs: [String]
    public var tab: Int
    public var group: String?
    public var groups: [PresentedGroup]
    /// For each choice or chips field of the line: what a picker offers.
    public var options: [String: [PresentedChip]]
    public var capabilities: [String: PresentedRowCapabilities]

    /// The presentation as the conformance vectors spell it.
    public var json: JSONValue {
        var object: [String: JSONValue] = [
            "model": .string(model),
            "table": .string(table),
            "tabs": .array(tabs.map { .object(["label": .string($0)]) }),
            "tab": .number(Double(tab)),
            "groups": .array(groups.map(\.json)),
            "options": .object(options.mapValues { JSONValue.array($0.map(\.json)) }),
            "capabilities": .object(capabilities.mapValues {
                JSONValue.object(["edit": .bool($0.edit), "delete": .bool($0.delete), "groups": .array($0.groups.map(JSONValue.string))])
            }),
        ]
        if let group { object["group"] = .string(group) }
        return .object(object)
    }
}

public struct PresentedPerson: Sendable, Equatable {
    public var id: String
    public var name: String
    public init(id: String, name: String) {
        self.id = id
        self.name = name
    }
}

public struct PresentOptions: Sendable {
    /// The model whose rows are the lines: by default the one with `@@views`, else the first with rows.
    public var model: String?
    /// Which view, by index into the views.
    public var view: Int
    /// A page's override of the model's views.
    public var views: [USLResolvedView]?
    /// People's profile ids and display names, in the order a `Person` grouping and picker list them.
    public var people: [PresentedPerson]
    /// Filters lines by their text, choices and related names.
    public var query: String?
    /// Whether a row may be changed (ownership is access policy). Everything is editable by default.
    public var canEdit: (@Sendable (_ table: String, _ row: String) -> Bool)?

    public init(model: String? = nil, view: Int = 0, views: [USLResolvedView]? = nil, people: [PresentedPerson] = [], query: String? = nil, canEdit: (@Sendable (String, String) -> Bool)? = nil) {
        self.model = model
        self.view = view
        self.views = views
        self.people = people
        self.query = query
        self.canEdit = canEdit
    }
}

/// Where a new or moved line goes in an ordered group.
public enum PresentedAnchor: Sendable, Equatable {
    /// Wherever the store puts it: the end.
    case unspecified
    case first
    /// After the line of this row.
    case after(String)

    /// The row to place after, or nil for first (and for unspecified).
    var row: String? {
        switch self {
        case .after(let key): key
        default: nil
        }
    }
}

/// A row operation, as spec 10 §4.1 defines it, without the change-scoped
/// `key` and the `collection` reference, which the publisher adds.
public enum RowEdit: Sendable, Equatable {
    case create(table: String, row: String, values: USLRow, at: String?)
    case delete(table: String, row: String)
    case set(table: String, row: String, field: String, before: JSONValue, value: JSONValue, at: String?)
    case connect(table: String, row: String, field: String, member: JSONValue, at: String?)
    case disconnect(table: String, row: String, field: String, member: JSONValue, at: String?)
    /// `after: nil` places the member first.
    case move(table: String, row: String, field: String, member: JSONValue, after: JSONValue?, at: String?)

    var table: String {
        switch self {
        case .create(let t, _, _, _), .delete(let t, _), .set(let t, _, _, _, _, _), .connect(let t, _, _, _, _), .disconnect(let t, _, _, _, _), .move(let t, _, _, _, _, _): t
        }
    }
    var row: String {
        switch self {
        case .create(_, let r, _, _), .delete(_, let r), .set(_, let r, _, _, _, _), .connect(_, let r, _, _, _), .disconnect(_, let r, _, _, _), .move(_, let r, _, _, _, _): r
        }
    }

    /// The operation as spec 10 §4.1 spells it.
    public var json: JSONValue {
        func object(_ kind: String, _ members: [String: JSONValue], _ at: String?) -> JSONValue {
            var o = members
            o["kind"] = .string(kind)
            o["table"] = .string(table)
            o["row"] = .string(row)
            if let at { o["at"] = .string(at) }
            return .object(o)
        }
        switch self {
        case .create(_, _, let values, let at): return object("rowCreate", ["values": .object(values)], at)
        case .delete: return object("rowDelete", [:], nil)
        case .set(_, _, let field, let before, let value, let at): return object("rowSet", ["field": .string(field), "before": before, "value": value], at)
        case .connect(_, _, let field, let member, let at): return object("rowConnect", ["field": .string(field), "member": member], at)
        case .disconnect(_, _, let field, let member, let at): return object("rowDisconnect", ["field": .string(field), "member": member], at)
        case .move(_, _, let field, let member, let after, let at): return object("rowMove", ["field": .string(field), "member": member, "after": after ?? .null], at)
        }
    }
}

/// What a person does to a presented view. Rows and groups are named as the presentation names them.
public enum ViewIntent: Sendable, Equatable {
    /// Set one field of a row: a value, a single reference, or a whole list.
    case set(row: String, field: String, value: JSONValue)
    case connect(row: String, field: String, member: JSONValue)
    case disconnect(row: String, field: String, member: JSONValue)
    /// A new row, in a group (preset its field, or connect the group's row to it).
    case create(id: String, group: String?, values: USLRow, after: PresentedAnchor)
    /// "Delete row": always deletes, disconnecting it from every row that refers to it.
    case delete(row: String)
    /// The Delete key on a line: disconnects in a connection group, deletes in a flat or choice-grouped view.
    case remove(row: String, group: String)
    /// Within an ordered group: place the row after another line, or first.
    case move(row: String, group: String, after: String?)
    /// Drag to another group.
    case regroup(row: String, from: String, to: String, after: PresentedAnchor)
    /// Edit a connection group's heading: that row's name.
    case rename(group: String, value: String)
}

public struct ViewError: Error, Sendable, Equatable {
    public var message: String
}

// MARK: - Helpers spelled as in TypeScript

func scalarText(_ value: JSONValue) -> String {
    switch value {
    case .string(let s): s
    case .number(let n): jsNumber(n)
    case .bool(let b): b ? "true" : "false"
    default: value.jsonText
    }
}

func sameJSON(_ a: JSONValue?, _ b: JSONValue?) -> Bool { (a ?? .null).jsonText == (b ?? .null).jsonText }

/// A row's canonical stable key, or nil when a key column holds no scalar.
public func uslRowKey(_ table: USLTable, _ row: USLRow) -> String? {
    var pairs: [JSONValue] = []
    for column in table.primaryKey {
        guard let value = row[column], value.isScalar else { return nil }
        pairs.append(.array([.string(column), value]))
    }
    return JSONValue.array(pairs).jsonText
}

/// The first paragraph of Markdown: its first run of non-blank lines, trimmed and joined by spaces.
public func uslFirstParagraph(_ markdown: String) -> String {
    let lines = markdown.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
        .split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
    let blank = { (line: String) in line.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    var start = 0
    while start < lines.count && blank(lines[start]) { start += 1 }
    var end = start
    while end < lines.count && !blank(lines[end]) { end += 1 }
    return lines[start..<end].map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.joined(separator: " ")
}

func rowsByPosition(_ rows: [USLRow], _ position: String) -> [USLRow] {
    rows.enumerated()
        .map { (row: $0.element, index: $0.offset, at: $0.element[position]?.numberValue ?? .infinity) }
        .sorted { $0.at != $1.at ? $0.at < $1.at : $0.index < $1.index }
        .map(\.row)
}

private func compareScalars(_ a: JSONValue, _ b: JSONValue) -> Double {
    if case .number(let x) = a, case .number(let y) = b { return x - y }
    if case .bool(let x) = a, case .bool(let y) = b { return Double((x ? 1 : 0) - (y ? 1 : 0)) }
    return Double(compareText(scalarText(a), scalarText(b)))
}

/// A stable sort by a key: ascending, or descending; items without a key keep their order, last.
private func sortBy<T>(_ items: [T], _ key: (T) -> JSONValue?, descending: Bool) -> [T] {
    items.enumerated().map { (item: $0.element, index: $0.offset, key: key($0.element)) }
        .sorted { x, y in
            guard let kx = x.key, let ky = y.key else {
                if x.key == nil && y.key == nil { return x.index < y.index }
                return x.key != nil
            }
            let d = compareScalars(kx, ky)
            if d != 0 { return descending ? d > 0 : d < 0 }
            return x.index < y.index
        }
        .map(\.item)
}

let uslValueTypeSet: Set<String> = ["Text", "Markdown", "Int", "Number", "Bool", "Date"]

// MARK: - Where a field's members are stored

enum USLFieldAccess {
    /// A value field on the row.
    case value(column: String, many: Bool)
    /// A single reference on the row, with the column ordering the target's list of these rows.
    case column(column: String, target: String, nullable: Bool, key: Bool, position: String?)
    /// References folded into an array on the row.
    case array(column: String, target: String)
    /// The target's rows hold this row's key in an array (the other end is folded).
    case otherArray(table: USLTable, column: String, target: String, ordered: Bool)
    /// The target's rows hold this row's key in a column (the many side of 1:n, or a connection model).
    case otherColumn(table: USLTable, column: String, target: String, nullable: Bool, position: String?)
    /// A join table.
    case join(table: USLTable, mine: USLJoinEnd, theirs: USLJoinEnd, target: String)

    var canDisconnect: Bool {
        switch self {
        case .column(_, _, let nullable, let key, _): nullable && !key
        case .otherColumn(_, _, _, let nullable, _): nullable
        default: true
        }
    }
}

/// A schema and its rows, with what a view needs to read them.
final class USLRowCollection {
    let schema: USLCheckResult
    let models: [String: USLResolvedModel]
    let tables: [USLTable]
    let byModel: [String: USLTable]
    var rows: USLRowsByTable
    let people: [PresentedPerson]

    init(_ schema: USLCheckResult, _ rows: USLRowsByTable, _ people: [PresentedPerson]) throws {
        if !schema.diagnostics.isEmpty { throw ViewError(message: "The schema has errors; check it first") }
        var models: [String: USLResolvedModel] = [:]
        for model in schema.models { models[model.name] = model }
        let tables = try uslLayout(schema, store: .files)
        var byModel: [String: USLTable] = [:]
        for table in tables where table.ends == nil { byModel[table.stores] = table }
        self.schema = schema
        self.models = models
        self.tables = tables
        self.byModel = byModel
        self.rows = rows
        self.people = people
    }

    func model(_ name: String) throws -> USLResolvedModel {
        guard let model = models[name] else { throw ViewError(message: "No model `\(name)`") }
        return model
    }

    func tableOf(_ model: String) -> USLTable? { byModel[model] }

    /// The table a row operation names: a model's table by the model's name, a join table by its own.
    func tableNamed(_ name: String) throws -> USLTable {
        if let table = byModel[name] ?? tables.first(where: { $0.ends != nil && $0.name == name }) { return table }
        throw ViewError(message: "No table `\(name)`")
    }

    /// The name a row operation gives a table.
    func opName(_ table: USLTable) -> String { table.ends != nil ? table.name : table.stores }

    func rowsOf(_ table: USLTable) -> [USLRow] { rows[table.name] ?? [] }

    func isFixed(_ model: String) -> Bool { models[model]?.rows == .fixed }

    /// The value naming a row of `model` in a reference: its one key column's value.
    func memberOf(_ model: String, _ row: USLRow) throws -> JSONValue {
        let table = tableOf(model)!
        if table.primaryKey.count != 1 { throw ViewError(message: "`\(model)` has a key of several columns; a view refers to rows by one") }
        guard let value = row[table.primaryKey[0]], value.isScalar else { throw ViewError(message: "A row of `\(model)` has no key") }
        return value
    }

    func findRow(_ table: USLTable, _ key: String) -> USLRow? {
        rowsOf(table).first { uslRowKey(table, $0) == key }
    }

    /// The row of `model` a reference names.
    func rowByMember(_ model: String, _ member: JSONValue) -> USLRow? {
        guard let table = tableOf(model) else { return nil }
        return rowsOf(table).first { sameJSON($0[table.primaryKey[0]], member) }
    }

    func access(_ model: USLResolvedModel, _ field: USLResolvedField) throws -> USLFieldAccess {
        guard let table = tableOf(model.name) else { throw ViewError(message: "`\(model.name)` has no rows") }
        if let stored = table.fields.first(where: { $0.name == field.name }) {
            guard let target = stored.target else { return .value(column: stored.columns[0], many: field.arity == .many) }
            if stored.columns.count != 1 { throw ViewError(message: "`\(model.name).\(field.name)` refers to a key of several columns") }
            let column = table.columns.first { $0.name == stored.columns[0] }!
            if column.array { return .array(column: column.name, target: target) }
            return .column(column: column.name, target: target, nullable: column.nullable, key: table.primaryKey.contains(column.name), position: positionOn(model, field))
        }
        // The other side of a connection model.
        if let through = models[field.type], through.ends.count >= 2, let end = through.ends.first(where: { $0.model == model.name && $0.field == field.name }) {
            let holder = tableOf(through.name)!
            let column = holder.fields.first { $0.name == end.as }!.columns[0]
            return .otherColumn(table: holder, column: column, target: through.name, nullable: false, position: end.ordered ? "\(end.field)_position" : nil)
        }
        for connection in schema.connections {
            let ends = [connection.a, connection.b]
            guard let mine = ends.first(where: { $0.model == model.name && $0.field == field.name }) else { continue }
            let other = mine == connection.a ? connection.b : connection.a
            if let holder = tableOf(other.model), let held = holder.fields.first(where: { $0.name == other.field }) {
                let column = holder.columns.first { $0.name == held.columns[0] }!
                if column.array { return .otherArray(table: holder, column: column.name, target: other.model, ordered: other.ordered) }
                return .otherColumn(table: holder, column: column.name, target: other.model, nullable: column.nullable, position: mine.ordered ? "\(mine.field)_position" : nil)
            }
            if let join = tables.first(where: { $0.ends?.contains { $0.model == model.name && $0.field == field.name } ?? false }), let joinEnds = join.ends {
                let mineEnd = joinEnds[0].model == model.name && joinEnds[0].field == field.name ? joinEnds[0] : joinEnds[1]
                let theirs = mineEnd == joinEnds[0] ? joinEnds[1] : joinEnds[0]
                return .join(table: join, mine: mineEnd, theirs: theirs, target: other.model)
            }
        }
        throw ViewError(message: "`\(model.name).\(field.name)` isn't stored where a view can reach it")
    }

    /// For a single reference on the row: the column that orders the target's list of these rows.
    private func positionOn(_ model: USLResolvedModel, _ field: USLResolvedField) -> String? {
        if let end = model.ends.first(where: { $0.as == field.name }) { return end.ordered ? "\(end.field)_position" : nil }
        for c in schema.connections {
            guard let mine = [c.a, c.b].first(where: { $0.model == model.name && $0.field == field.name }) else { continue }
            let other = mine == c.a ? c.b : c.a
            return other.ordered ? "\(other.field)_position" : nil
        }
        return nil
    }

    /// The members `row` of `model` holds in `field`, in their order: stored, by `@sort`, or as connected.
    func members(_ model: USLResolvedModel, _ field: USLResolvedField, _ row: USLRow) throws -> [JSONValue] {
        let members = try membersBy(model, try access(model, field), row)
        guard let sort = field.sort else { return members }
        return try sortMembers(field.type, sort, members) { $0 }
    }

    /// Members of `target` by one of its fields (`@sort`): newest first for `created` and `modified`, members without it last.
    func sortMembers<T>(_ target: String, _ sort: String, _ items: [T], _ memberOf: (T) -> JSONValue) throws -> [T] {
        var failure: Error?
        let sorted = sortBy(items, { item in
            do { return try memberSortKey(target, sort, memberOf(item)) } catch {
                failure = error
                return nil
            }
        }, descending: sort == "created" || sort == "modified")
        if let failure { throw failure }
        return sorted
    }

    func memberSortKey(_ target: String, _ sort: String, _ member: JSONValue) throws -> JSONValue? {
        if target == "Person" { return sort == "name" ? .string(chip(target, member).name) : nil }
        let model = models[target]
        if let model, model.rows == .fixed {
            if sort == "name" { return member }
            guard let row = model.schemaRows.first(where: { JSONValue.string($0.name) == member }),
                  let value = row.values.first(where: { $0.key == sort })?.value else { return nil }
            switch value {
            case .string(let v): return .string(v)
            case .number(let v): return .number(v)
            case .bool(let v): return .bool(v)
            case .list: return nil
            }
        }
        guard let model, let row = rowByMember(target, member) else { return nil }
        return try sortKey(self, model, sort, row)
    }

    /// The members `row` of `model` holds through `access`, in their order.
    func membersBy(_ model: USLResolvedModel, _ access: USLFieldAccess, _ row: USLRow) throws -> [JSONValue] {
        switch access {
        case .value(let column, let many):
            if many { return (row[column]?.arrayValue ?? []).filter(\.isScalar) }
            return row[column].map { $0.isScalar ? [$0] : [] } ?? []
        case .column(let column, _, _, _, _):
            return row[column].map { $0.isScalar ? [$0] : [] } ?? []
        case .array(let column, _):
            return (row[column]?.arrayValue ?? []).filter(\.isScalar)
        case .otherArray(let table, let column, let target, _):
            let key = try memberOf(model.name, row)
            return try rowsOf(table)
                .filter { ($0[column]?.arrayValue ?? []).contains { sameJSON($0, key) } }
                .map { try memberOf(target, $0) }
        case .otherColumn(let table, let column, let target, _, let position):
            let key = try memberOf(model.name, row)
            let held = rowsOf(table).filter { sameJSON($0[column], key) }
            return try (position.map { rowsByPosition(held, $0) } ?? held).map { try memberOf(target, $0) }
        case .join(let table, let mine, let theirs, _):
            let key = try memberOf(model.name, row)
            let held = rowsOf(table).filter { sameJSON($0[mine.columns[0]], key) }
            return (mine.position.map { rowsByPosition(held, $0) } ?? held).compactMap { $0[theirs.columns[0]] }.filter(\.isScalar)
        }
    }

    /// The field a row of `model` is called by: `name`, its `@path`, or its first single `Text` field.
    func nameField(_ model: String) -> String? {
        guard let resolved = models[model] else { return nil }
        let single = { (f: USLResolvedField) in f.type == "Text" && f.arity != .many && f.origin == .declared }
        let field = resolved.fields.first { $0.name == "name" && single($0) }
            ?? resolved.fields.first { $0.name == resolved.path }
            ?? resolved.fields.first(where: single)
        return field.map { $0.column ?? $0.name }
    }

    /// A member's chip: its display name and color.
    func chip(_ target: String, _ member: JSONValue) -> PresentedChip {
        if target == "Person" {
            return PresentedChip(member: member, name: people.first { JSONValue.string($0.id) == member }?.name ?? scalarText(member))
        }
        if uslValueTypeSet.contains(target) { return PresentedChip(member: member, name: scalarText(member)) }
        let model = models[target]
        if let model, model.rows == .fixed {
            let row = model.schemaRows.first { JSONValue.string($0.name) == member }
            return PresentedChip(member: member, name: scalarText(member), color: row?.color)
        }
        let row = rowByMember(target, member)
        var name = scalarText(member)
        if let row, let field = nameField(target), case .string(let text)? = row[field] { name = text }
        var color: String?
        if let row, let colorField = model?.fields.first(where: \.color), case .string(let text)? = row[colorField.column ?? colorField.name] { color = text }
        return PresentedChip(member: member, name: name, color: color)
    }

    /// Everything a field can refer to, for a picker and for groups.
    func candidates(_ target: String) throws -> [PresentedChip] {
        if target == "Person" { return people.map { chip("Person", .string($0.id)) } }
        if let model = models[target], model.rows == .fixed { return model.schemaRows.map { chip(target, .string($0.name)) } }
        guard let table = tableOf(target) else { return [] }
        return try rowsOf(table).filter { uslRowKey(table, $0) != nil }.map { chip(target, try memberOf(target, $0)) }
    }
}

// MARK: - Views

/// The model a collection presents: the one with `@@views`, else the first with rows.
public func presentedModel(_ schema: USLCheckResult) throws -> String {
    let data = schema.models.filter { $0.name != "Person" && $0.rows != .fixed }
    guard let model = data.first(where: { !$0.views.isEmpty }) ?? data.first(where: { $0.ends.count < 2 }) ?? data.first else {
        throw ViewError(message: "The schema has no model with rows")
    }
    return model.name
}

/// A model's views: its `@@views`, or the default arrangement. A view without a line shows every field.
public func viewsOf(_ schema: USLCheckResult, model name: String) throws -> [USLResolvedView] {
    guard let model = schema.models.first(where: { $0.name == name }) else { throw ViewError(message: "No model `\(name)`") }
    let line = model.fields.map { USLLineItem(field: $0.name) }
    if !model.views.isEmpty {
        return model.views.map { view in
            var v = view
            if v.line.isEmpty { v.line = line }
            return v
        }
    }
    return [USLResolvedView(label: "All", line: line)]
        + model.fields.filter { !uslValueTypeSet.contains($0.type) }.map { USLResolvedView(label: "By \($0.name)", line: line, group: $0.name) }
}

struct ArrangedGroup {
    var id: String
    var kind: PresentedGroupKind
    var heading: String
    var member: JSONValue?
    var color: String?
    var table: USLTable?
    var row: String?
    var ordered: Bool
    var remove: PresentedGroup.Remove
    var rows: [USLRow]
}

struct ViewArrangement {
    var model: USLResolvedModel
    var table: USLTable
    var views: [USLResolvedView]
    var index: Int
    var view: USLResolvedView
    var field: USLResolvedField?
    var access: USLFieldAccess?
    var groups: [ArrangedGroup]
}

/// cranberries' `groups` and `sortGroups`, over rows.
func arrangeView(_ collection: USLRowCollection, _ options: PresentOptions) throws -> ViewArrangement {
    let model = try collection.model(try options.model ?? presentedModel(collection.schema))
    guard let table = collection.tableOf(model.name) else { throw ViewError(message: "`\(model.name)` has no rows to present") }
    let views = try options.views ?? viewsOf(collection.schema, model: model.name)
    let index = options.view
    guard index >= 0 && index < views.count else { throw ViewError(message: "No view \(index)") }
    let view = views[index]
    let all = collection.rowsOf(table).filter { uslRowKey(table, $0) != nil }
    guard let groupName = view.group else {
        let groups = [ArrangedGroup(id: "", kind: .flat, heading: "", ordered: false, remove: .delete, rows: all)]
        return ViewArrangement(model: model, table: table, views: views, index: index, view: view, groups: try sortGroups(collection, model, view, groups))
    }
    guard let field = model.fields.first(where: { $0.name == groupName }) else { throw ViewError(message: "`\(model.name)` has no field `\(groupName)`") }
    let access = try collection.access(model, field)
    let target = field.type
    let kind: PresentedGroupKind = target == "Person" || (!uslValueTypeSet.contains(target) && !collection.isFixed(target)) ? .connection : .choice
    let members = try all.map { try collection.membersBy(model, access, $0) }

    // The groups: everything the field can refer to, then members nobody listed (people, values).
    var candidates = uslValueTypeSet.contains(target) ? [] : try collection.candidates(target)
    if let sort = field.sort { candidates = try collection.sortMembers(target, sort, candidates) { $0.member } }
    var listed = Set(candidates.map(\.member.jsonText))
    if target == "Person" || uslValueTypeSet.contains(target) {
        for list in members {
            for m in list where !listed.contains(m.jsonText) {
                listed.insert(m.jsonText)
                candidates.append(collection.chip(target, m))
            }
        }
    }
    let ordered: Bool
    switch access {
    case .otherArray(_, _, _, let isOrdered): ordered = isOrdered
    case .join(_, _, let theirs, _): ordered = theirs.position != nil
    case .column(_, _, _, _, let position): ordered = position != nil
    default: ordered = false
    }
    let targetTable = kind == .connection ? collection.tableOf(target) : nil
    let remove: PresentedGroup.Remove = kind == .connection && access.canDisconnect ? .disconnect : .delete
    var groups: [ArrangedGroup] = try candidates.map { c in
        let inGroup = all.indices.filter { members[$0].contains { sameJSON($0, c.member) } }.map { all[$0] }
        var rows = inGroup
        switch access {
        case .otherArray(_, let column, _, _):
            // The list's own order: the group's row holds its members.
            let list = collection.rowByMember(target, c.member)?[column]?.arrayValue ?? []
            rows = try list.flatMap { m in try inGroup.filter { sameJSON(try collection.memberOf(model.name, $0), m) } }
        case .join(let joinTable, let mine, let theirs, _):
            let joined = collection.rowsOf(joinTable).filter { sameJSON($0[theirs.columns[0]], c.member) }
            let sorted = theirs.position.map { rowsByPosition(joined, $0) } ?? joined
            rows = try sorted.flatMap { j in try inGroup.filter { sameJSON(try collection.memberOf(model.name, $0), j[mine.columns[0]]) } }
        case .column(_, _, _, _, let position?):
            rows = rowsByPosition(inGroup, position)
        default:
            break
        }
        let groupRow = targetTable.flatMap { _ in collection.rowByMember(target, c.member) }
        return ArrangedGroup(
            id: c.member.jsonText, kind: kind, heading: c.name, member: c.member, color: c.color,
            table: groupRow == nil ? nil : targetTable, row: groupRow.flatMap { uslRowKey(targetTable!, $0) },
            ordered: ordered, remove: remove, rows: rows
        )
    }
    let unassigned = all.indices.filter { !members[$0].contains { listed.contains($0.jsonText) } }.map { all[$0] }
    if !unassigned.isEmpty {
        groups.append(ArrangedGroup(id: "unassigned", kind: .unassigned, heading: "Unassigned", ordered: false, remove: .delete, rows: unassigned))
    }
    return ViewArrangement(model: model, table: table, views: views, index: index, view: view, field: field, access: access, groups: try sortGroups(collection, model, view, groups))
}

/// Newest first for `created` and `modified`; otherwise ascending. Rows without the field keep their place, last.
private func sortKey(_ collection: USLRowCollection, _ model: USLResolvedModel, _ sort: String, _ row: USLRow) throws -> JSONValue? {
    if sort == "created" || sort == "modified" {
        if case .string(let s)? = row[sort] { return .string(s) }
        return nil
    }
    if sort == "id" { return row["id"].flatMap { $0.isScalar ? $0 : nil } }
    guard let field = model.fields.first(where: { $0.name == sort }) else { return nil }
    let members = try collection.members(model, field, row)
    guard let first = members.first else { return nil }
    return uslValueTypeSet.contains(field.type) ? first : .string(collection.chip(field.type, first).name)
}

/// cranberries' `sortGroups`: lines by the sort field, or, where groups keep their own order, the groups by their rows.
private func sortGroups(_ collection: USLRowCollection, _ model: USLResolvedModel, _ view: USLResolvedView, _ groups: [ArrangedGroup]) throws -> [ArrangedGroup] {
    guard let sort = view.sort else { return groups }
    let descending = sort == "created" || sort == "modified"
    var failure: Error?
    func key(_ owner: USLResolvedModel, _ row: USLRow) -> JSONValue? {
        do { return try sortKey(collection, owner, sort, row) } catch {
            failure = error
            return nil
        }
    }
    let result: [ArrangedGroup]
    if groups.contains(where: \.ordered) {
        result = sortBy(groups, { g in
            guard let table = g.table, let rowKey = g.row, let row = collection.findRow(table, rowKey), let owner = collection.models[table.stores] else { return nil }
            return key(owner, row)
        }, descending: descending)
    } else {
        result = groups.map { g in
            var group = g
            group.rows = sortBy(g.rows, { key(model, $0) }, descending: descending)
            return group
        }
    }
    if let failure { throw failure }
    return result
}

// MARK: - presentView

/// A collection's rows as one of its views presents them.
public func presentView(_ schema: USLCheckResult, rows: USLRowsByTable, options: PresentOptions = PresentOptions()) throws -> PresentedView {
    let collection = try USLRowCollection(schema, rows, options.people)
    let arranged = try arrangeView(collection, options)
    let model = arranged.model, table = arranged.table, view = arranged.view

    let fields: [(item: USLLineItem, field: USLResolvedField)] = try view.line.map { item in
        guard let field = model.fields.first(where: { $0.name == item.field }) else { throw ViewError(message: "`\(model.name)` has no field `\(item.field)`") }
        return (item, field)
    }
    let bulletIndex = fields.firstIndex { $0.item.bullet }

    func cell(_ row: USLRow, _ item: USLLineItem, _ field: USLResolvedField) throws -> PresentedCell {
        let members = try collection.members(model, field, row)
        if uslValueTypeSet.contains(field.type) && field.arity != .many {
            let value = members.first ?? .null
            if field.type == "Markdown" {
                let text = value.stringValue
                return .markdown(field: field.name, value: text, paragraph: text.map(uslFirstParagraph) ?? "")
            }
            return .text(field: field.name, type: field.type, value: value)
        }
        if collection.isFixed(field.type) && field.arity != .many {
            let value = members.first?.stringValue
            let color = value.flatMap { collection.chip(field.type, .string($0)).color }
            return .choice(field: field.name, value: value, color: color, bullet: item.bullet)
        }
        return .chips(field: field.name, chips: members.map { collection.chip(field.type, $0) }, summary: item.summary, label: item.label)
    }

    let words = (options.query ?? "").lowercased().split(whereSeparator: \.isWhitespace).map(String.init)
    func has(_ text: String) -> Bool {
        let lower = text.lowercased()
        return words.allSatisfy { lower.contains($0) }
    }

    var presented: [PresentedGroup] = []
    var capabilities: [String: PresentedRowCapabilities] = [:]
    for group in arranged.groups {
        let keepAll = words.isEmpty || (group.kind != .flat && group.kind != .unassigned && has(group.heading))
        var lines: [PresentedLine] = []
        for row in group.rows {
            let key = uslRowKey(table, row)!
            let cells = try fields.map { try cell(row, $0.item, $0.field) }
            if !keepAll && !has(cells.map(\.searchText).joined(separator: "\n")) { continue }
            var color: String?
            if let bulletIndex, case .choice(_, _, let c, _) = cells[bulletIndex] { color = c }
            let occurrence = JSONValue.array([.string(view.label), .string(group.id), .string(key)]).jsonText
            lines.append(PresentedLine(row: key, occurrence: occurrence, color: color, cells: cells))
        }
        if !words.isEmpty && lines.isEmpty { continue }
        let nameField = group.table.flatMap { collection.nameField($0.stores) }
        let hasRow = group.table != nil && group.row != nil
        presented.append(PresentedGroup(
            id: group.id, kind: group.kind, heading: group.heading, member: group.member, color: group.color,
            table: hasRow ? collection.opName(group.table!) : nil, row: hasRow ? group.row : nil,
            headingField: hasRow ? nameField : nil, ordered: group.ordered, remove: group.remove, lines: lines
        ))
        for line in lines {
            let edit = options.canEdit?(collection.opName(table), line.row) ?? true
            var entry = capabilities[line.row] ?? PresentedRowCapabilities(edit: edit, delete: edit, groups: [])
            if group.kind != .flat { entry.groups.append(group.id) }
            capabilities[line.row] = entry
        }
    }

    var pickers: [String: [PresentedChip]] = [:]
    for (_, field) in fields where !uslValueTypeSet.contains(field.type) {
        pickers[field.name] = try collection.candidates(field.type)
    }

    return PresentedView(
        model: model.name, table: collection.opName(table), tabs: arranged.views.map(\.label), tab: arranged.index,
        group: view.group, groups: presented, options: pickers, capabilities: capabilities
    )
}

// MARK: - Values and rows: cranberries' `checkValue` and `validate`

/// Whether `value` fits a field of `model`, as a row stores it (null for none). References aren't looked up.
public func checkFieldValue(_ schema: USLCheckResult, model: String, field: String, value: JSONValue) -> Bool {
    guard let tables = try? uslLayout(schema, store: .files),
          let table = tables.first(where: { $0.ends == nil && $0.stores == model }),
          let stored = table.fields.first(where: { $0.name == field }),
          let column = table.columns.first(where: { $0.name == stored.columns[0] }) else { return false }
    return fitsValue(column, value)
}

private func fitsValue(_ column: USLColumn, _ value: JSONValue) -> Bool {
    if value.isNull { return column.nullable || column.array }
    if column.array, let items = value.arrayValue, Set(items.map(\.jsonText)).count != items.count { return false }
    return uslFitsColumn(value, column)
}

public struct USLRowsDiagnostic: Sendable, Equatable {
    public var code: String
    public var table: String
    public var row: String?
    public var column: String?
    public var message: String
}

/// Every row against its table: values, keys, distinct members, and references to rows that exist.
public func checkRows(_ schema: USLCheckResult, _ rows: USLRowsByTable) throws -> [USLRowsDiagnostic] {
    let tables = try uslLayout(schema, store: .files)
    var out: [USLRowsDiagnostic] = []
    for table in tables {
        var seen = Set<String>()
        for row in rows[table.name] ?? [] {
            guard let key = uslRowKey(table, row) else {
                out.append(USLRowsDiagnostic(code: "missing-key", table: table.name, message: "A row of \(table.name) has no key"))
                continue
            }
            for d in uslValidateRow(table, row) {
                out.append(USLRowsDiagnostic(code: d.code.rawValue, table: table.name, row: key, column: d.column, message: d.message))
            }
            for column in table.columns where column.array {
                if let items = row[column.name]?.arrayValue, Set(items.map(\.jsonText)).count != items.count {
                    out.append(USLRowsDiagnostic(code: "duplicate-member", table: table.name, row: key, column: column.name, message: "`\(column.name)` lists a member twice"))
                }
            }
            if seen.contains(key) { out.append(USLRowsDiagnostic(code: "duplicate-key", table: table.name, row: key, message: "Two rows of \(table.name) have the key \(key)")) }
            seen.insert(key)
        }
    }
    func present(_ tableName: String, _ values: [JSONValue?]) -> Bool {
        guard let target = tables.first(where: { $0.name == tableName }) else { return false }
        return (rows[tableName] ?? []).contains { r in
            target.primaryKey.enumerated().allSatisfy { i, c in sameJSON(r[c], values[i]) }
        }
    }
    for table in tables {
        for row in rows[table.name] ?? [] {
            guard let key = uslRowKey(table, row) else { continue }
            for column in table.columns {
                guard let ref = column.references, let items = row[column.name]?.arrayValue else { continue }
                for item in items {
                    let values: [JSONValue?] = ref.columns.count == 1 ? [item] : ref.columns.map { c in
                        if case .object(let o) = item { return o[c.name] }
                        return nil
                    }
                    if !present(ref.table, values) {
                        out.append(USLRowsDiagnostic(code: "dangling-reference", table: table.name, row: key, column: column.name, message: "`\(column.name)` names \(item.jsonText), which is no row of \(ref.table)"))
                    }
                }
            }
            for fk in table.foreignKeys {
                let values = fk.columns.map { row[$0] ?? .null }
                if values.allSatisfy(\.isNull) { continue }
                if !present(fk.table, values) {
                    out.append(USLRowsDiagnostic(code: "dangling-reference", table: table.name, row: key, column: fk.columns.joined(separator: ","), message: "\(JSONValue.array(values).jsonText) names no row of \(fk.table)"))
                }
            }
        }
    }
    return out
}

// MARK: - Applying row operations: cranberries' `apply`

private let systemColumns = ["created", "modified"]

/// Rows after row operations, by spec 10 §4.1's rules. Throws on an operation that doesn't apply.
public func applyRowEdits(_ schema: USLCheckResult, _ rows: USLRowsByTable, _ edits: [RowEdit]) throws -> USLRowsByTable {
    let collection = try USLRowCollection(schema, rows, [])
    var out = rows
    for edit in edits {
        let table = try collection.tableNamed(edit.table)
        var list = out[table.name] ?? []
        let index = list.firstIndex { uslRowKey(table, $0) == edit.row }
        func fail(_ message: String) -> ViewError { ViewError(message: "\(edit.json.jsonText): \(message)") }
        func stamp(_ row: inout USLRow, _ at: String?, created: Bool) {
            guard let at else { return }
            if created { row["created"] = .string(at) }
            row["modified"] = .string(at)
        }
        /// The row a member edit changes, after the checks every one of them makes.
        func editable(_ field: String) throws -> (Int, USLRow) {
            guard let index else { throw fail("the row is absent") }
            if table.primaryKey.contains(field) { throw fail("a key field is never set") }
            if systemColumns.contains(field) { throw fail("\(field) is set only by an operation's time") }
            return (index, list[index])
        }
        func membersOf(_ row: USLRow, _ field: String) throws -> [JSONValue] {
            guard let current = row[field], !current.isNull else { return [] }
            guard let members = current.arrayValue else { throw fail("\(field) isn't many-valued") }
            return members
        }
        switch edit {
        case .create(_, let key, let values, let at):
            if index != nil { throw fail("the row already exists") }
            if uslRowKey(table, values) != key { throw fail("its values don't have the row's key") }
            if at != nil && systemColumns.contains(where: { values[$0] != nil }) { throw fail("a timed row's times come from its operation") }
            var row = values
            stamp(&row, at, created: true)
            list.append(row)
        case .delete:
            guard let index else { throw fail("the row is absent") }
            list.remove(at: index)
        case .set(_, _, let field, let before, let value, let at):
            let (i, found) = try editable(field)
            var row = found
            if !sameJSON(row[field], before) { throw fail("\(field) doesn't have the value seen") }
            if sameJSON(before, value) { throw fail("it changes nothing") }
            row[field] = value.isNull ? nil : value
            stamp(&row, at, created: false)
            list[i] = row
        case .connect(_, _, let field, let member, let at):
            let (i, found) = try editable(field)
            var row = found
            let members = try membersOf(row, field)
            if members.contains(where: { sameJSON($0, member) }) { throw fail("the member is already present") }
            row[field] = .array(members + [member])
            stamp(&row, at, created: false)
            list[i] = row
        case .disconnect(_, _, let field, let member, let at):
            let (i, found) = try editable(field)
            var row = found
            var members = try membersOf(row, field)
            guard let at0 = members.firstIndex(where: { sameJSON($0, member) }) else { throw fail("the member is absent") }
            members.remove(at: at0)
            row[field] = members.isEmpty ? nil : .array(members)
            stamp(&row, at, created: false)
            list[i] = row
        case .move(_, _, let field, let member, let anchor, let at):
            let (i, found) = try editable(field)
            var row = found
            let members = try membersOf(row, field)
            guard let from = members.firstIndex(where: { sameJSON($0, member) }) else { throw fail("the member is absent") }
            var rest = members
            rest.remove(at: from)
            var after = -1
            if let anchor {
                guard let found = rest.firstIndex(where: { sameJSON($0, anchor) }) else { throw fail("the anchor member is absent") }
                after = found
            }
            rest.insert(members[from], at: after + 1)
            if rest.indices.allSatisfy({ sameJSON(rest[$0], members[$0]) }) { throw fail("it changes nothing") }
            row[field] = .array(rest)
            stamp(&row, at, created: false)
            list[i] = row
        }
        out[table.name] = list
    }
    return out
}
