import Foundation

// The inverse of a presented view: intents to row operations (spec 10 §4.1).
// A port of `viewEdits` in `packages/usl/src/present.ts`. Delete in a
// connection group disconnects; in a flat or choice-grouped view it deletes.
// A connection group's heading edits that row's name.

/// The row operations that carry out `intent` on the view `options` presents.
public func viewEdits(_ schema: USLCheckResult, rows: USLRowsByTable, options: PresentOptions = PresentOptions(), intent: ViewIntent, at: String? = nil) throws -> [RowEdit] {
    var unfiltered = options
    unfiltered.query = nil
    let editor = try ViewEditor(schema, rows, unfiltered, at)
    try editor.run(intent)
    // Every edit is a row operation the schema validates before it is published.
    let known = Set(try checkRows(schema, rows).map(diagnosticKey))
    if let added = try checkRows(schema, editor.collection.rows).first(where: { !known.contains(diagnosticKey($0)) }) {
        throw ViewError(message: added.message)
    }
    return editor.edits
}

private func diagnosticKey(_ d: USLRowsDiagnostic) -> String {
    JSONValue.array([.string(d.code), .string(d.table), d.row.map(JSONValue.string) ?? .null, d.column.map(JSONValue.string) ?? .null, .string(d.message)]).jsonText
}

/// Where a connection or a placement puts a line: after the row naming this member, first, or at the end.
private enum Anchor {
    case end
    case first
    case after(JSONValue)
}

private final class ViewEditor {
    let schema: USLCheckResult
    let collection: USLRowCollection
    let arrangement: ViewArrangement
    let at: String?
    var edits: [RowEdit] = []

    var model: USLResolvedModel { arrangement.model }
    var table: USLTable { arrangement.table }
    var opTable: String { collection.opName(table) }

    init(_ schema: USLCheckResult, _ rows: USLRowsByTable, _ options: PresentOptions, _ at: String?) throws {
        let collection = try USLRowCollection(schema, rows, options.people)
        self.schema = schema
        self.collection = collection
        self.arrangement = try arrangeView(collection, options)
        self.at = at
    }

    /// Each edit is computed against the rows the earlier ones leave.
    func emit(_ edit: RowEdit) throws {
        collection.rows = try applyRowEdits(schema, collection.rows, [edit])
        edits.append(edit)
    }

    func lineRow(_ key: String) throws -> USLRow {
        guard let row = collection.findRow(table, key) else { throw ViewError(message: "No row \(key) in \(table.name)") }
        return row
    }

    func fieldNamed(_ name: String) throws -> USLResolvedField {
        guard let field = model.fields.first(where: { $0.name == name }) else { throw ViewError(message: "`\(model.name)` has no field `\(name)`") }
        return field
    }

    func group(_ id: String) throws -> ArrangedGroup {
        guard let found = arrangement.groups.first(where: { $0.id == id }) else { throw ViewError(message: "No group \(id) in the view \"\(arrangement.view.label)\"") }
        return found
    }

    func groupField() throws -> USLResolvedField {
        guard let field = arrangement.field else { throw ViewError(message: "The view \"\(arrangement.view.label)\" isn't grouped") }
        return field
    }

    /// A position in a list ordered by `position` (the row placed leaves it out). Between two rows it is halfway.
    func positionAt(_ peers: [USLRow], _ position: String, _ keyOf: (USLRow) throws -> JSONValue?, _ anchor: Anchor) throws -> Double {
        let sorted = rowsByPosition(peers, position)
        let index: Int
        switch anchor {
        case .end: index = sorted.count
        case .first: index = 0
        case .after(let member):
            guard let found = try sorted.firstIndex(where: { sameJSON(try keyOf($0), member) }) else { throw ViewError(message: "\(member.jsonText) isn't in that group") }
            index = found + 1
        }
        let before = index > 0 ? sorted[index - 1][position]?.numberValue : nil
        let next = index < sorted.count ? sorted[index][position]?.numberValue : nil
        guard let before else { return next.map { $0 - 1 } ?? 0 }
        return next.map { (before + $0) / 2 } ?? before + 1
    }

    /// The member naming a line's row, from its key.
    func anchorOf(_ after: PresentedAnchor) throws -> Anchor {
        switch after {
        case .unspecified: .end
        case .first: .first
        case .after(let key): .after(try collection.memberOf(model.name, try lineRow(key)))
        }
    }

    func valueOrNull(_ row: USLRow, _ field: String) -> JSONValue { row[field] ?? .null }

    /// Connects a line's row to `member`; where positions order the group, places it at `anchor`.
    func connect(_ key: String, _ field: USLResolvedField, _ member: JSONValue, _ anchor: Anchor = .end) throws {
        let access = try collection.access(model, field)
        let row = try lineRow(key)
        if try collection.membersBy(model, access, row).contains(where: { sameJSON($0, member) }) { return }
        switch access {
        case .value(let column, let many):
            if many { try emit(.connect(table: opTable, row: key, field: column, member: member, at: at)) }
            else { try emit(.set(table: opTable, row: key, field: column, before: valueOrNull(row, column), value: member, at: at)) }
        case .array(let column, _):
            try emit(.connect(table: opTable, row: key, field: column, member: member, at: at))
        case .column(let column, _, _, let isKey, let position):
            if isKey { throw ViewError(message: "`\(field.name)` is part of the row's key") }
            try emit(.set(table: opTable, row: key, field: column, before: valueOrNull(row, column), value: member, at: at))
            if let position {
                let peers = collection.rowsOf(table).filter { sameJSON($0[column], member) && uslRowKey(table, $0) != key }
                let value = JSONValue.number(try positionAt(peers, position, { try self.collection.memberOf(self.model.name, $0) }, anchor))
                let current = valueOrNull(try lineRow(key), position)
                if !sameJSON(current, value) { try emit(.set(table: opTable, row: key, field: position, before: current, value: value, at: at)) }
            }
        case .otherArray(let holder, let column, let target, _):
            guard let owner = collection.rowByMember(target, member) else { throw ViewError(message: "No row of `\(target)` is \(member.jsonText)") }
            try emit(.connect(table: collection.opName(holder), row: uslRowKey(holder, owner)!, field: column, member: try collection.memberOf(model.name, row), at: at))
        case .otherColumn(let holder, let column, let target, _, let position):
            guard let other = collection.rowByMember(target, member) else { throw ViewError(message: "No row of `\(target)` is \(member.jsonText)") }
            let otherKey = uslRowKey(holder, other)!
            let name = collection.opName(holder)
            let mine = try collection.memberOf(model.name, row)
            try emit(.set(table: name, row: otherKey, field: column, before: valueOrNull(other, column), value: mine, at: at))
            if let position {
                let peers = collection.rowsOf(holder).filter { sameJSON($0[column], mine) && uslRowKey(holder, $0) != otherKey }
                let value = JSONValue.number(try positionAt(peers, position, { _ in nil }, .end))
                let current = valueOrNull(collection.findRow(holder, otherKey)!, position)
                if !sameJSON(current, value) { try emit(.set(table: name, row: otherKey, field: position, before: current, value: value, at: at)) }
            }
        case .join(let joinTable, let mine, let theirs, _):
            var values: USLRow = [mine.columns[0]: try collection.memberOf(model.name, row), theirs.columns[0]: member]
            let joined = collection.rowsOf(joinTable)
            for end in [mine, theirs] {
                guard let position = end.position else { continue }
                let peers = joined.filter { sameJSON($0[end.columns[0]], values[end.columns[0]]) }
                let placed: Anchor = end == theirs ? anchor : .end
                values[position] = .number(try positionAt(peers, position, { $0[mine.columns[0]] }, placed))
            }
            try emit(.create(table: collection.opName(joinTable), row: uslRowKey(joinTable, values)!, values: values, at: at))
        }
    }

    func disconnect(_ key: String, _ field: USLResolvedField, _ member: JSONValue) throws {
        let access = try collection.access(model, field)
        let row = try lineRow(key)
        if try !collection.membersBy(model, access, row).contains(where: { sameJSON($0, member) }) { return }
        if !access.canDisconnect { throw ViewError(message: "`\(field.name)` needs a value") }
        switch access {
        case .value(let column, let many):
            if many { try emit(.disconnect(table: opTable, row: key, field: column, member: member, at: at)) }
            else { try emit(.set(table: opTable, row: key, field: column, before: valueOrNull(row, column), value: .null, at: at)) }
        case .array(let column, _):
            try emit(.disconnect(table: opTable, row: key, field: column, member: member, at: at))
        case .column(let column, _, _, _, let position):
            try emit(.set(table: opTable, row: key, field: column, before: valueOrNull(row, column), value: .null, at: at))
            if let position, let placed = try lineRow(key)[position] {
                try emit(.set(table: opTable, row: key, field: position, before: placed, value: .null, at: at))
            }
        case .otherArray(let holder, let column, let target, _):
            let owner = collection.rowByMember(target, member)!
            try emit(.disconnect(table: collection.opName(holder), row: uslRowKey(holder, owner)!, field: column, member: try collection.memberOf(model.name, row), at: at))
        case .otherColumn(let holder, let column, let target, _, let position):
            let other = collection.rowByMember(target, member)!
            let otherKey = uslRowKey(holder, other)!
            let name = collection.opName(holder)
            try emit(.set(table: name, row: otherKey, field: column, before: valueOrNull(other, column), value: .null, at: at))
            if let position, let placed = collection.findRow(holder, otherKey)![position] {
                try emit(.set(table: name, row: otherKey, field: position, before: placed, value: .null, at: at))
            }
        case .join(let joinTable, let mine, let theirs, _):
            let self_ = try collection.memberOf(model.name, row)
            if let j = collection.rowsOf(joinTable).first(where: { sameJSON($0[mine.columns[0]], self_) && sameJSON($0[theirs.columns[0]], member) }) {
                try emit(.delete(table: collection.opName(joinTable), row: uslRowKey(joinTable, j)!))
            }
        }
    }

    /// Places `key` after the line `after` (or first) in an ordered group.
    func place(_ key: String, _ target: ArrangedGroup, _ after: String?) throws {
        guard let access = arrangement.access, target.ordered, let groupMember = target.member else {
            throw ViewError(message: "The group \(target.id) keeps no order")
        }
        let member = try collection.memberOf(model.name, try lineRow(key))
        let anchor: JSONValue? = try after.map { try collection.memberOf(model.name, try lineRow($0)) }
        if case .otherArray(let holder, let column, let ownerModel, _) = access {
            let owner = collection.rowByMember(ownerModel, groupMember)!
            let list = owner[column]?.arrayValue ?? []
            let rest = list.filter { !sameJSON($0, member) }
            var index = 0
            if let anchor {
                guard let found = rest.firstIndex(where: { sameJSON($0, anchor) }) else { throw ViewError(message: "\(after ?? "") isn't in the group \(target.id)") }
                index = found + 1
            }
            if list.firstIndex(where: { sameJSON($0, member) }) == index { return }
            try emit(.move(table: collection.opName(holder), row: uslRowKey(holder, owner)!, field: column, member: member, after: anchor, at: at))
            return
        }
        // Positions: a number between the neighbours'.
        let holder: USLTable, position: String, peers: [USLRow], keyOf: (USLRow) throws -> JSONValue?
        switch access {
        case .join(let joinTable, let mine, let theirs, _):
            guard let p = theirs.position else { throw ViewError(message: "The group \(target.id) keeps no order") }
            holder = joinTable
            position = p
            peers = collection.rowsOf(joinTable).filter { sameJSON($0[theirs.columns[0]], groupMember) }
            keyOf = { $0[mine.columns[0]] }
        case .column(let column, _, _, _, let p?):
            holder = table
            position = p
            peers = collection.rowsOf(table).filter { sameJSON($0[column], groupMember) }
            keyOf = { try self.collection.memberOf(self.model.name, $0) }
        default:
            throw ViewError(message: "The group \(target.id) keeps no order")
        }
        let sorted = rowsByPosition(peers, position)
        guard let selfIndex = try sorted.firstIndex(where: { sameJSON(try keyOf($0), member) }) else { throw ViewError(message: "\(key) isn't in the group \(target.id)") }
        let placed = sorted[selfIndex]
        var rest = sorted
        rest.remove(at: selfIndex)
        var index = 0
        if let anchor {
            guard let found = try rest.firstIndex(where: { sameJSON(try keyOf($0), anchor) }) else { throw ViewError(message: "\(after ?? "") isn't in the group \(target.id)") }
            index = found + 1
        }
        if selfIndex == index { return }
        let value = JSONValue.number(try positionAt(rest, position, keyOf, anchor.map(Anchor.after) ?? .first))
        try emit(.set(table: collection.opName(holder), row: uslRowKey(holder, placed)!, field: position, before: valueOrNull(placed, position), value: value, at: at))
    }

    /// cranberries' `apply` for a delete: the row goes, and so does every reference to it.
    func deleteRow(_ key: String) throws {
        let member = try collection.memberOf(model.name, try lineRow(key))
        for other in collection.tables {
            let name = collection.opName(other)
            if let ends = other.ends {
                for end in ends where end.model == model.name {
                    for j in collection.rowsOf(other) where sameJSON(j[end.columns[0]], member) {
                        try emit(.delete(table: name, row: uslRowKey(other, j)!))
                    }
                }
                continue
            }
            for stored in other.fields where stored.target == model.name {
                let column = other.columns.first { $0.name == stored.columns[0] }!
                for r in collection.rowsOf(other) {
                    let rKey = uslRowKey(other, r)!
                    if other.name == table.name && rKey == key { continue }
                    if column.array {
                        if (r[column.name]?.arrayValue ?? []).contains(where: { sameJSON($0, member) }) {
                            try emit(.disconnect(table: name, row: rKey, field: column.name, member: member, at: at))
                        }
                    } else if sameJSON(r[column.name], member) {
                        if other.primaryKey.contains(column.name) {
                            try emit(.delete(table: name, row: rKey))
                        } else if column.nullable {
                            try emit(.set(table: name, row: rKey, field: column.name, before: member, value: .null, at: at))
                            // Its place in the deleted row's list goes too.
                            let holder = collection.models[other.stores]!
                            let access = try collection.access(holder, holder.fields.first { $0.name == stored.name }!)
                            if case .column(_, _, _, _, let position?) = access, let placed = collection.findRow(other, rKey)![position] {
                                try emit(.set(table: name, row: rKey, field: position, before: placed, value: .null, at: at))
                            }
                        } else {
                            throw ViewError(message: "\(name) \(rKey) needs the row \(key) in `\(column.name)`")
                        }
                    }
                }
            }
        }
        try emit(.delete(table: opTable, row: key))
    }

    func run(_ intent: ViewIntent) throws {
        switch intent {
        case .set(let rowKey, let fieldName, let value):
            let field = try fieldNamed(fieldName)
            let access = try collection.access(model, field)
            let row = try lineRow(rowKey)
            if case .value(let column, _) = access {
                if !checkFieldValue(schema, model: model.name, field: field.name, value: value) {
                    throw ViewError(message: "\(value.jsonText) doesn't fit `\(field.name)`")
                }
                let stored: JSONValue = value.arrayValue?.isEmpty == true ? .null : value
                if !sameJSON(row[column], stored) {
                    try emit(.set(table: opTable, row: rowKey, field: column, before: valueOrNull(row, column), value: stored, at: at))
                }
                return
            }
            // A reference: connect what's new, disconnect what's gone.
            let wanted: [JSONValue] = value.isNull ? [] : value.arrayValue ?? [value]
            if !wanted.allSatisfy(\.isScalar) { throw ViewError(message: "`\(field.name)` holds references") }
            if field.arity != .many && wanted.count > 1 { throw ViewError(message: "`\(field.name)` holds one value") }
            let current = try collection.membersBy(model, access, row)
            if field.arity != .many && wanted.count == 1 {
                try connect(rowKey, field, wanted[0])
                return
            }
            for m in current where !wanted.contains(where: { sameJSON($0, m) }) { try disconnect(rowKey, field, m) }
            for m in wanted { try connect(rowKey, field, m) }
        case .connect(let rowKey, let fieldName, let member):
            try connect(rowKey, try fieldNamed(fieldName), member)
        case .disconnect(let rowKey, let fieldName, let member):
            try disconnect(rowKey, try fieldNamed(fieldName), member)
        case .create(let id, let groupID, let given, let after):
            let target = try groupID.map { try group($0) }
            var values = try newRow(model, table, id, given)
            let field = arrangement.field
            let access = arrangement.access
            // Preset the group's field when the new row holds it.
            var preset = false
            if let member = target?.member, field != nil, let access {
                switch access {
                case .value(let column, let many):
                    values[column] = many ? .array([member]) : member
                    preset = true
                case .array(let column, _):
                    values[column] = .array([member])
                    preset = true
                case .column(let column, _, _, _, let position):
                    values[column] = member
                    if let position {
                        let peers = collection.rowsOf(table).filter { sameJSON($0[column], member) }
                        let anchor = target!.ordered ? try anchorOf(after) : .end
                        values[position] = .number(try positionAt(peers, position, { try self.collection.memberOf(self.model.name, $0) }, anchor))
                    }
                    preset = true
                default:
                    break
                }
            }
            guard let key = uslRowKey(table, values) else { throw ViewError(message: "A new row needs its key") }
            if !uslValidateRow(table, values).isEmpty { throw ViewError(message: "The new row doesn't fit `\(model.name)`") }
            try emit(.create(table: opTable, row: key, values: values, at: at))
            // Otherwise connect the group's row to it, and place it in a list.
            if let target, let member = target.member, let field, !preset {
                try connect(key, field, member, target.ordered ? try anchorOf(after) : .end)
            }
            if let target, target.ordered, after != .unspecified, case .otherArray? = access {
                try place(key, target, after.row)
            }
        case .delete(let rowKey):
            try deleteRow(rowKey)
        case .remove(let rowKey, let groupID):
            let g = try group(groupID)
            if g.kind == .connection && g.remove == .disconnect, let member = g.member {
                try disconnect(rowKey, try groupField(), member)
            } else {
                try deleteRow(rowKey)
            }
        case .move(let rowKey, let groupID, let after):
            try place(rowKey, try group(groupID), after)
        case .regroup(let rowKey, let fromID, let toID, let after):
            let from = try group(fromID)
            let to = try group(toID)
            let field = try groupField()
            let afterKey = after.row
            if from.id == to.id {
                if after != .unspecified { try place(rowKey, to, afterKey) }
                return
            }
            let access = arrangement.access!
            // A single value on the row is replaced in one step.
            var replaces = false
            switch access {
            case .column: replaces = true
            case .value(_, let many): replaces = !many
            default: break
            }
            if let member = from.member, !(replaces && to.member != nil) { try disconnect(rowKey, field, member) }
            if let member = to.member { try connect(rowKey, field, member, to.ordered ? try anchorOf(after) : .end) }
            if to.ordered, after != .unspecified, case .otherArray = access { try place(rowKey, to, afterKey) }
        case .rename(let groupID, let value):
            let g = try group(groupID)
            guard let groupTable = g.table, let groupRow = g.row else { throw ViewError(message: "The heading of \(g.id) isn't a row's name") }
            guard let nameField = collection.nameField(groupTable.stores) else { throw ViewError(message: "`\(groupTable.stores)` has no name to edit") }
            let row = collection.findRow(groupTable, groupRow)!
            if !sameJSON(row[nameField], .string(value)) {
                try emit(.set(table: collection.opName(groupTable), row: groupRow, field: nameField, before: valueOrNull(row, nameField), value: .string(value), at: at))
            }
        }
    }
}

/// cranberries' `newEntity`: a new row's values, with each required value it lacks given its type's empty value.
private func newRow(_ model: USLResolvedModel, _ table: USLTable, _ id: String, _ given: USLRow) throws -> USLRow {
    var values: USLRow = [:]
    if table.primaryKey == ["id"] { values["id"] = .string(id) }
    for (name, value) in given {
        guard let field = model.fields.first(where: { $0.name == name }),
              let stored = table.fields.first(where: { $0.name == field.name }), stored.columns.count == 1 else {
            throw ViewError(message: "A new row of `\(model.name)` can't be given `\(name)` directly")
        }
        if !value.isNull { values[stored.columns[0]] = value }
    }
    for column in table.columns {
        if values[column.name] != nil || column.nullable || column.array || column.type == .timestamp || column.type == .position { continue }
        if let allowed = column.allowed { values[column.name] = .string(allowed[0]) }
        else if column.type == .text && !column.profile && !table.foreignKeys.contains(where: { $0.columns.contains(column.name) }) { values[column.name] = .string("") }
        else if column.type == .int || column.type == .number { values[column.name] = .number(0) }
        else if column.type == .bool { values[column.name] = .bool(false) }
    }
    return values
}
