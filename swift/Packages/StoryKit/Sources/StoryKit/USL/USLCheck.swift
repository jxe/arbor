import Foundation

// Checks a parsed .usl file against the language's invariants and resolves
// each model's full set of fields: its own, those its connections give it,
// and, for a connection model, the ends that key it. `re` blocks are merged
// into the models they annotate first. A port of `packages/usl/src/check.ts`;
// diagnostics carry the same codes and positions.

public let uslValueTypes = ["Text", "Markdown", "Int", "Number", "Bool", "Date"]
public let uslBuiltinModels = ["Person"]
public let uslImplicitFields = ["id", "created", "modified"]

// Each attribute name belongs to one layer (its sigil) and one level.
private let fieldAttributes: [String: USLSigil] = ["column": .storage, "fold": .storage, "body": .storage, "title": .storage, "color": .presentation]
private let modelAttributes: [String: USLSigil] = ["table": .storage, "index": .storage, "fold": .storage, "views": .presentation]
private let valueAttributes: [String: USLSigil] = ["stored": .storage, "color": .presentation]
private let modifierNames = ["ordered", "unique", "path"]
private let viewOptions = ["label", "line", "group", "sort"]
// Presentation of one item in a view's line: `~bullet` draws an enum value as
// the row's colored bullet, `~summary` shows a many-valued field as a count,
// `~label("lead")` names one of its members, and `~sort(field)` lists a
// connection's members by a field of theirs.
private let lineAttributes = ["bullet", "summary", "label", "sort"]

private func layerName(_ sigil: USLSigil) -> String { sigil == .storage ? "storage" : "presentation" }

func isColor(_ text: String) -> Bool {
    text.range(of: "^#[0-9a-fA-F]{6}$", options: .regularExpression) != nil
}

public struct USLResolvedField: Sendable, Equatable {
    public enum Origin: String, Sendable { case declared, connection, end }
    public var name: String
    /// A value type or a model name.
    public var type: String
    public var arity: USLArity
    /// declared: written in the model. connection: gained from a connection. end: one of this connection model's ends.
    public var origin: Origin
    public var ordered: Bool
    public var unique: Bool
    /// Holds the row's color (`~color`).
    public var color: Bool
    /// The stored column's name when it differs from the field's (`@column("…")`).
    public var column: String?
}

/// One end of a connection: the field `model` gains, and (for a connection model) the field the end gets there.
public struct USLResolvedEnd: Sendable, Equatable {
    public var model: String
    public var field: String
    public var arity: USLArity
    public var ordered: Bool
    /// The field this end gets in its connection model (`as`, or the model's name in lower case).
    public var `as`: String
    public var column: String?
    /// `@fold`: in data files, this end's rows hold the connection as an array.
    public var fold: Bool
}

/// A value written in the schema: a string, number, boolean, or a list of them.
public indirect enum USLRowValue: Sendable, Equatable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case list([USLRowValue])

    var json: JSONValue {
        switch self {
        case .string(let s): .string(s)
        case .number(let n): .number(n)
        case .bool(let b): .bool(b)
        case .list(let items): .array(items.map(\.json))
        }
    }
}

/// Where a connection's data lives.
public enum USLStorage: Sendable, Equatable {
    case column(on: String, field: String)
    case array(on: String, field: String)
    case table
    case fold(into: String)
}

public struct USLSchemaRow: Sendable, Equatable {
    public var name: String
    public var values: [(key: String, value: USLRowValue)]
    /// An enum value's `~color`.
    public var color: String?
    /// An enum value's `@stored` text.
    public var stored: String?

    public static func == (a: USLSchemaRow, b: USLSchemaRow) -> Bool {
        a.name == b.name && a.color == b.color && a.stored == b.stored && a.values.map(\.key) == b.values.map(\.key) && a.values.map(\.value) == b.values.map(\.value)
    }
}

/// One item of a view's line: a field and its presentation.
public struct USLLineItem: Sendable, Equatable {
    public var field: String
    public var bullet: Bool
    public var summary: Bool
    public var label: String?
    /// `~sort(field)`: lists a connection's members by a field of theirs instead of as connected.
    public var sort: String?

    public init(field: String, bullet: Bool = false, summary: Bool = false, label: String? = nil, sort: String? = nil) {
        self.field = field
        self.bullet = bullet
        self.summary = summary
        self.label = label
        self.sort = sort
    }
}

/// A default arrangement from `~views`. A view without a `line` uses the first view's.
public struct USLResolvedView: Sendable, Equatable {
    public var label: String
    public var line: [USLLineItem]
    public var group: String?
    /// `group: field ~sort(name)`: the groups in order of a field of theirs.
    public var groupSort: String?
    public var sort: String?

    public init(label: String, line: [USLLineItem], group: String? = nil, groupSort: String? = nil, sort: String? = nil) {
        self.label = label
        self.line = line
        self.group = group
        self.groupSort = groupSort
        self.sort = sort
    }
}

public struct USLResolvedModel: Sendable, Equatable {
    public enum Rows: String, Sendable { case fixed, seed, data }
    public var name: String
    /// `main model`: its rows are the collection folder's own children.
    public var main: Bool
    /// The stored table's name when it differs from the model's (`@table("…")`).
    public var table: String?
    /// `fixed` rows are an enum's values; `seed` rows are data with defaults; `data` is an ordinary collection.
    public var rows: Rows
    /// The fields that identify a row: its ends for a connection model, the header key, otherwise `id` (or the value's name, for an enum).
    public var key: [String]
    public var fields: [USLResolvedField]
    public var storage: USLStorage?
    /// The field whose value is each row's path segment in an Overstory tree (`path`); otherwise its key is.
    public var path: String?
    /// In Markdown row files, the field written as the body (`@body`, else a `Markdown` field named `content`).
    public var body: String?
    /// In Markdown row files, the field written as the page title (`@title`, else a `Text` field named `title`).
    public var title: String?
    /// A connection model's ends.
    public var ends: [USLResolvedEnd]
    /// An enum's values or `seed` rows.
    public var schemaRows: [USLSchemaRow]
    /// `~views`, in tab order; empty when the model has none.
    public var views: [USLResolvedView]
    /// `@index(...)`, each a list of single-valued fields to look rows up by.
    public var indexes: [[String]]
}

public struct USLResolvedConnection: Sendable, Equatable {
    public var ends: [String]
    public var a: USLResolvedEnd
    public var b: USLResolvedEnd
    public var storage: USLStorage
}

public struct USLCheckResult: Sendable, Equatable {
    public var diagnostics: [USLDiagnostic]
    public var models: [USLResolvedModel]
    public var connections: [USLResolvedConnection]
}

private struct EndInfo {
    var decl: USLEndDecl
    /// The type of the field the end's model gains: the other end's model, or the connection model.
    var target: String
    /// The named model declaring the end, or nil for an unnamed connection.
    var owner: USLModelDecl?
}

func lowerFirst(_ s: String) -> String {
    guard let first = s.first else { return s }
    return first.lowercased() + s.dropFirst()
}

private func identArg(_ attrs: [USLAttribute], _ name: String) -> String? {
    if case .ident(let n, _, _)? = attrs.first(where: { $0.name == name })?.args.first { return n }
    return nil
}

/// The field a connection model gets for one of its ends: `as name`, or the end's model in lower case.
private func keyFieldOf(_ end: USLEndDecl) -> String { end.as?.name ?? lowerFirst(end.model) }

private func hasModifier(_ field: USLFieldDecl, _ name: String) -> Bool { field.modifiers.contains { $0.name == name } }

/// The name in `@column("…")`, when it is among the attributes.
private func columnOf(_ attrs: [USLAttribute]) -> String? {
    if case .string(let value, _)? = attrs.first(where: { $0.name == "column" })?.args.first { return value }
    return nil
}

private func resolvedEnd(_ end: USLEndDecl) -> USLResolvedEnd {
    USLResolvedEnd(
        model: end.model,
        field: end.field,
        arity: end.arity,
        ordered: end.ordered != nil,
        as: keyFieldOf(end),
        column: columnOf(end.attrs),
        fold: end.attrs.contains { $0.name == "fold" }
    )
}

private func rowValue(_ expr: USLExpr) -> USLRowValue {
    switch expr {
    case .string(let v, _): .string(v)
    case .number(let v, _): .number(v)
    case .ident(let name, _, _): name == "true" ? .bool(true) : name == "false" ? .bool(false) : .string(name)
    case .list(let items, _): .list(items.map(rowValue))
    // TypeScript writes an object's syntax as JSON here; nothing reads it.
    case .object(let entries, _): .string("{\(entries.map(\.key).joined(separator: ","))}")
    }
}

private func arityText(_ arity: USLArity) -> String {
    switch arity {
    case .many: "[]"
    case .optional: "?"
    case .one: ""
    }
}

private func isValueType(_ type: String) -> Bool { uslValueTypes.contains(type) }

private typealias Report = (String, USLPosition, String) -> Void

private func hasAttr(_ attrs: [USLAttribute], _ name: String) -> Bool { attrs.contains { $0.name == name } }
private func hasAttr(_ attrs: [USLAttribute], _ name: String, _ sigil: USLSigil) -> Bool { attrs.contains { $0.name == name && $0.sigil == sigil } }

private func endsOf(_ members: [USLMember]) -> [USLEndDecl] {
    var result: [USLEndDecl] = []
    for case .end(let end) in members { result.append(end) }
    return result
}
private func fieldsOf(_ members: [USLMember]) -> [USLFieldDecl] {
    var result: [USLFieldDecl] = []
    for case .field(let field) in members { result.append(field) }
    return result
}
private func rowBlocksOf(_ members: [USLMember]) -> [USLRowsBlock] {
    var result: [USLRowsBlock] = []
    for case .rows(let block) in members { result.append(block) }
    return result
}
private func modelAttributesOf(_ members: [USLMember]) -> [USLModelAttribute] {
    var result: [USLModelAttribute] = []
    for case .modelAttribute(let attribute) in members { result.append(attribute) }
    return result
}

public func checkUSL(_ parsed: USLSchemaFile) -> USLCheckResult {
    // A copy (Swift's values are), so merging `re` blocks never changes the parsed file.
    var file = parsed
    var diagnostics: [USLDiagnostic] = []
    let report: Report = { code, at, message in
        diagnostics.append(USLDiagnostic(code: code, message: message, line: at.line, column: at.column))
    }

    // 1. Model names. The model layer is declared once; `re` adds to it.
    var models = OrderedMap<USLModelDecl>()
    for case .model(let decl) in file.declarations {
        if isValueType(decl.name) || uslBuiltinModels.contains(decl.name) {
            report("reserved-model", decl.at, "`\(decl.name)` is built in and can't be declared")
        } else if models.has(decl.name) {
            report("duplicate-model", decl.at, "Model `\(decl.name)` is declared twice; add to it with `re \(decl.name) { ... }`")
        } else {
            models[decl.name] = decl
        }
    }
    let mains = models.values.compactMap(\.main)
    for extra in mains.dropFirst() { report("main-model", extra, "A schema has at most one `main` model") }
    mergeRe(&file, &models, report)
    let modelExists = { (name: String) in models.has(name) || uslBuiltinModels.contains(name) }
    let rowsOf = { (model: USLModelDecl) -> USLRowsBlock? in rowBlocksOf(model.members).first }
    let isFixed = { (name: String) -> Bool in
        guard let model = models[name] else { return false }
        return rowsOf(model)?.mode == .fixed
    }

    // 2. Connections and their ends. Each Model.field is declared by exactly one end.
    var ends = OrderedMap<EndInfo>()
    let declareEnd = { (decl: USLEndDecl, target: String, owner: USLModelDecl?) in
        if !modelExists(decl.model) {
            report("unknown-model", decl.at, "No model `\(decl.model)` for the end `\(decl.model).\(decl.field)`")
            return
        }
        let key = "\(decl.model).\(decl.field)"
        if let first = ends[key] {
            report("duplicate-end", decl.at, "`\(key)` is already declared by the connection on line \(first.decl.at.line)")
            return
        }
        ends[key] = EndInfo(decl: decl, target: target, owner: owner)
    }

    var unnamed: [(a: USLEndDecl, b: USLEndDecl)] = []
    for case .connection(let decl) in file.declarations {
        var connectionEnds: [USLEndDecl] = []
        for member in decl.members {
            if case .end(let end) = member { connectionEnds.append(end) } else {
                report("connection-member", member.at, "An unnamed connection holds only its two ends; give it a name (`model X { ... }`) to add fields or attributes")
            }
        }
        if connectionEnds.count != 2 {
            report("connection-ends", decl.at, "An unnamed connection has exactly two ends, not \(connectionEnds.count)")
            continue
        }
        let a = connectionEnds[0], b = connectionEnds[1]
        if a.ordered != nil, let second = b.ordered { report("ordered-ends", second, "At most one end of a connection is `ordered`") }
        declareEnd(a, b.model, nil)
        declareEnd(b, a.model, nil)
        if modelExists(a.model) && modelExists(b.model) { unnamed.append((a, b)) }
    }
    for model in models.values {
        for case .end(let end) in model.members { declareEnd(end, model.name, model) }
    }

    // 3. Each model's fields.
    var resolved = OrderedMap<USLResolvedModel>()
    var fieldMaps: [String: OrderedMap<USLResolvedField>] = [:]
    for name in uslBuiltinModels + models.keys {
        let model = models[name]
        var fields = OrderedMap<USLResolvedField>()
        var declared = OrderedMap<USLFieldDecl>()
        let modelEnds: [USLEndDecl] = model.map { endsOf($0.members) } ?? []
        let rows = model.flatMap(rowsOf)

        if let model {
            for case .field(let member) in model.members {
                if uslImplicitFields.contains(member.name) {
                    report("reserved-field", member.at, "`\(member.name)` is implicit on every row and can't be declared")
                    continue
                }
                if declared.has(member.name) {
                    report("duplicate-field", member.at, "Field `\(member.name)` is declared twice in `\(name)`")
                    continue
                }
                declared[member.name] = member
                if !isValueType(member.type) && !modelExists(member.type) {
                    report("unknown-type", member.at, "Unknown type `\(member.type)`")
                    continue
                }
                if isValueType(member.type) {
                    fields[member.name] = USLResolvedField(
                        name: member.name, type: member.type, arity: member.arity, origin: .declared,
                        ordered: hasModifier(member, "ordered"), unique: hasModifier(member, "unique"),
                        color: hasAttr(member.attrs, "color", .presentation), column: columnOf(member.attrs)
                    )
                }
            }
        }

        // A connection model is keyed by its ends and has a field for each.
        for end in modelEnds {
            if !modelExists(end.model) { continue }
            let fieldName = keyFieldOf(end)
            if fields.has(fieldName) || declared.has(fieldName) {
                let hint = end.as != nil ? "" : "; name this side with `as ...`"
                report("duplicate-field", end.at, "`\(name)` already has a field `\(fieldName)`, which this end would key it by\(hint)")
                continue
            }
            fields[fieldName] = USLResolvedField(name: fieldName, type: end.model, arity: .one, origin: .end, ordered: false, unique: false, color: false, column: columnOf(end.attrs))
        }

        // Fields gained from connections.
        for (key, info) in ends.items where info.decl.model == name {
            let field = info.decl.field
            if uslImplicitFields.contains(field) {
                report("reserved-field", info.decl.at, "`\(field)` is implicit on every row and can't be declared")
                continue
            }
            let crossReference = declared[field]
            if fields.has(field) || (crossReference.map { isValueType($0.type) } ?? false) {
                report("duplicate-field", info.decl.at, "`\(key)` clashes with another field `\(field)` of `\(name)`")
                continue
            }
            fields[field] = USLResolvedField(
                name: field, type: info.target, arity: info.decl.arity, origin: .connection,
                ordered: info.decl.ordered != nil, unique: false, color: false, column: columnOf(info.decl.attrs)
            )
        }

        // Model-typed fields inside a model only cross-reference a connection.
        for decl in declared.values {
            if isValueType(decl.type) || !modelExists(decl.type) { continue }
            let written = "\(decl.name) \(decl.type)\(arityText(decl.arity))"
            guard let info = ends["\(name).\(decl.name)"] else {
                report("undeclared-connection", decl.at, "`\(written)` refers to a connection nobody declares; add `\(name).\(decl.name)\(arityText(decl.arity)) <-> \(decl.type).<field>`")
                continue
            }
            let declaredEnd = "\(name).\(decl.name)\(arityText(info.decl.arity))"
            if info.target != decl.type {
                report("cross-reference-mismatch", decl.at, "`\(written)` says \(decl.type), but `\(declaredEnd)` connects to \(info.target)")
            } else if info.decl.arity != decl.arity {
                report("cross-reference-mismatch", decl.at, "`\(written)` disagrees with `\(declaredEnd)` on arity")
            }
            for attr in decl.attrs where !hasAttr(info.decl.attrs, attr.name) {
                report("cross-reference-mismatch", attr.at, "`\(attr.sigil.rawValue)\(attr.name)` belongs on the end `\(declaredEnd)`, where the connection is declared")
            }
            for modifier in decl.modifiers where modifier.name != "ordered" || info.decl.ordered == nil {
                report("cross-reference-mismatch", modifier.at, "`\(modifier.name)` belongs on the end `\(declaredEnd)`, where the connection is declared")
            }
        }

        let key = modelEnds.count >= 2 ? modelEnds.map(keyFieldOf) : rows?.mode == .fixed ? ["name"] : ["id"]
        // Fields written in the model come in the order they're written; the rest follow.
        let ordered = declared.keys.compactMap { fields[$0] } + fields.values.filter { !declared.has($0.name) }
        let schemaRows: [USLSchemaRow] = (rows?.rows ?? []).map { row in
            var color: String?
            var stored: String?
            if case .string(let value, _)? = row.attrs.first(where: { $0.name == "color" && $0.sigil == .presentation })?.args.first { color = value }
            if case .string(let value, _)? = row.attrs.first(where: { $0.name == "stored" && $0.sigil == .storage })?.args.first { stored = value }
            // Object.fromEntries keeps the last of a repeated key, in its first place.
            var values: [(key: String, value: USLRowValue)] = []
            for entry in row.values {
                if let i = values.firstIndex(where: { $0.key == entry.key }) { values[i].value = rowValue(entry.value) } else { values.append((entry.key, rowValue(entry.value))) }
            }
            return USLSchemaRow(name: row.name, values: values, color: color, stored: stored)
        }
        resolved[name] = USLResolvedModel(
            name: name, main: model?.main != nil, table: nil,
            rows: rows.map { $0.mode == .fixed ? USLResolvedModel.Rows.fixed : USLResolvedModel.Rows.seed } ?? USLResolvedModel.Rows.data, key: key,
            fields: ordered, storage: nil, path: nil, body: nil, title: nil, ends: modelEnds.map(resolvedEnd), schemaRows: schemaRows,
            views: model.map(resolvedViews) ?? [], indexes: []
        )
        fieldMaps[name] = fields
    }

    // 4. Field and end modifiers and attributes.
    func checkFieldAttrs(_ attrs: [USLAttribute], _ arity: USLArity, _ type: String?, _ owner: String, end: (decl: USLEndDecl, named: Bool)? = nil) {
        var seen = Set<String>()
        for attr in attrs {
            let spelled = "\(attr.sigil.rawValue)\(attr.name)"
            if seen.contains(spelled) {
                report("duplicate-attribute", attr.at, "`\(spelled)` is set twice")
                continue
            }
            seen.insert(spelled)
            if modifierNames.contains(attr.name) || attr.name == "as" {
                report("attribute-layer", attr.at, "`\(attr.name)` is a keyword of the model: write it before the type (`\(attr.name == "as" ? "Model.field as name" : "field \(attr.name) Type")`)")
                continue
            }
            if attr.name == "bullet" || attr.name == "summary" || attr.name == "label" {
                report("misplaced-attribute", attr.at, "`~\(attr.name)` is presentation; put it on the field in a view's `line`")
                continue
            }
            guard let layer = fieldAttributes[attr.name] else {
                report("unknown-attribute", attr.at, "Unknown attribute `\(spelled)`")
                continue
            }
            if layer != attr.sigil {
                report("attribute-layer", attr.at, "`\(attr.name)` is \(layerName(layer)): write `\(layer.rawValue)\(attr.name)`")
                continue
            }
            if attr.name == "column" {
                var ok = false
                if attr.args.count == 1, case .string(let v, _) = attr.args[0], !v.isEmpty { ok = true }
                if !ok { report("attribute-arguments", attr.at, "`@column` names the stored column: `@column(\"list_id\")`") }
            } else if attr.name == "fold" {
                if end == nil { report("misplaced-attribute", attr.at, "`@fold` goes on a connection end") }
                else if end!.named { report("misplaced-attribute", attr.at, "A connection model folds with `@fold(Model)` as a model item") }
                else if !attr.args.isEmpty { report("attribute-arguments", attr.at, "`@fold` on an end takes no arguments") }
                // Whether the connection can fold is checked with its storage.
            } else if !attr.args.isEmpty {
                report("attribute-arguments", attr.at, "`\(spelled)` on a field takes no arguments")
            } else if end != nil {
                report("misplaced-attribute", attr.at, "`\(spelled)` goes on a value field, not a connection end")
            } else if attr.name == "color" && (type != "Text" || arity == .many) {
                report("color-field-type", attr.at, "`~color` marks a single `Text` field holding each row's color")
            } else if attr.name == "color" && isFixed(owner) {
                report("misplaced-attribute", attr.at, "An enum's colors go on its values; a `~color` field is for models")
            } else if attr.name == "body" && (type != "Markdown" || arity == .many) {
                report("body-field", attr.at, "`@body` marks a single `Markdown` field written as a Markdown row's body")
            } else if attr.name == "title" && (type != "Text" || arity == .many) {
                report("title-field", attr.at, "`@title` marks a single `Text` field written as a Markdown row's title")
            }
        }
    }
    func checkModifiers(_ field: USLFieldDecl, _ owner: String) {
        var seen = Set<String>()
        for modifier in field.modifiers {
            if seen.contains(modifier.name) {
                report("duplicate-attribute", modifier.at, "`\(modifier.name)` is written twice")
                continue
            }
            seen.insert(modifier.name)
            if modifier.name == "ordered" && field.arity != .many {
                report("ordered-single", modifier.at, "`ordered` only applies to a many-valued field (`[]`)")
            } else if modifier.name == "unique" && (!isValueType(field.type) || field.arity == .many) {
                report("unique-value", modifier.at, "`unique` applies to a single value field; a connection's arity already says how many")
            } else if modifier.name == "path" && (field.type != "Text" || field.arity != .one) {
                report("path-field", modifier.at, "`path` marks a required `Text` field whose value names the row in the tree")
            } else if modifier.name == "path" && isFixed(owner) {
                report("path-field", modifier.at, "An enum's values are named by themselves")
            }
        }
    }
    func checkEnd(_ end: USLEndDecl, _ named: Bool) {
        if let ordered = end.ordered, end.arity != .many { report("ordered-single", ordered, "`ordered` only applies to a many end (`[]`)") }
        if let name = end.as, !named { report("misplaced-attribute", name.at, "`as` names a connection model's field for this end; an unnamed connection has no such field") }
    }
    for model in models.values {
        for member in model.members {
            if case .field(let f) = member {
                checkModifiers(f, model.name)
                if isValueType(f.type) { checkFieldAttrs(f.attrs, f.arity, f.type, model.name) }
            }
            if case .end(let e) = member {
                checkEnd(e, true)
                checkFieldAttrs(e.attrs, e.arity, nil, model.name, end: (e, true))
            }
        }
        func marked(_ name: String) -> [USLFieldDecl] {
            fieldsOf(model.members).filter { f in f.attrs.contains { $0.name == name && $0.sigil == fieldAttributes[name] } }
        }
        let colorFields = marked("color")
        if colorFields.count > 1 {
            report("duplicate-color", colorFields[1].at, "Only one field per model can hold the row's color")
        }
        let pathFields = fieldsOf(model.members).filter { hasModifier($0, "path") }
        if pathFields.count > 1 { report("duplicate-path", pathFields[1].at, "Only one field per model can name its rows") }
        if let first = pathFields.first { resolved[model.name]!.path = first.name }
        for (name, fallback, type) in [("body", "content", "Markdown"), ("title", "title", "Text")] {
            let chosenFields = marked(name)
            if chosenFields.count > 1 { report("duplicate-\(name)", chosenFields[1].at, "Only one field per model is its `@\(name)`") }
            let conventional = fieldsOf(model.members).first { $0.name == fallback && $0.type == type && $0.arity != .many }
            if let chosen = chosenFields.first?.name ?? conventional?.name, model.form == .model {
                if name == "body" { resolved[model.name]!.body = chosen } else { resolved[model.name]!.title = chosen }
            }
        }
        let modelEnds = endsOf(model.members)
        let orderedEnds = modelEnds.compactMap(\.ordered)
        if orderedEnds.count > 1 { report("ordered-ends", orderedEnds[1], "At most one end of a connection is `ordered`") }
        if let main = model.main, model.form == .enum || !modelEnds.isEmpty {
            report("main-model", main, model.form == .enum ? "An enum has no rows of its own to be the main model" : "A connection model can't be the main model")
        }
    }
    for case .connection(let decl) in file.declarations {
        for case .end(let e) in decl.members {
            checkEnd(e, false)
            checkFieldAttrs(e.attrs, e.arity, nil, e.model, end: (e, false))
        }
    }

    // A connection's members sort by a field of theirs: `name` for a person or
    // an enum value, otherwise a field, `created` or `modified`.
    func sortable(_ target: String, _ field: String) -> Bool {
        let hasField = fieldMaps[target]?.has(field) ?? false
        return target == "Person" || isFixed(target) ? field == "name" || hasField : uslImplicitFields.contains(field) || hasField
    }

    // 5. Header keys and model attributes.
    for model in models.values {
        let fields = fieldMaps[model.name]!
        var seen = Set<String>()
        let modelEnds = endsOf(model.members)
        let rows = rowBlocksOf(model.members)

        if let key = model.key {
            if model.form == .enum {
                report("id-on-rows", key.at, "An enum's values are identified by their names")
            } else {
                var resolvedKey: [String] = []
                for field in key.fields {
                    if field.name == "id" {
                        resolvedKey.append("id") // the implicit id, unique only alongside the other key fields
                        continue
                    }
                    if let declared = fields[field.name] {
                        if declared.arity != .one { report("id-field", field.at, "`\(field.name)` is part of the key, so it must hold exactly one value") }
                        else { resolvedKey.append(field.name) }
                    } else {
                        report("unknown-field", field.at, "`\(model.name)` has no field `\(field.name)`")
                    }
                }
                resolved[model.name]!.key = resolvedKey
            }
        }
        if rows.count > 1 {
            report("duplicate-attribute", rows[1].at, model.form == .enum ? "An enum has no `seed` block; make it a model" : "A model has at most one `seed` block")
        }

        for attr in modelAttributesOf(model.members) {
            // A model may have several indexes; every other attribute appears once.
            if seen.contains(attr.name) && attr.name != "index" {
                report("duplicate-attribute", attr.at, "`\(attr.sigil.rawValue)\(attr.name)` appears twice")
                continue
            }
            seen.insert(attr.name)
            guard let layer = modelAttributes[attr.name] else {
                report("unknown-attribute", attr.at, "Unknown model attribute `\(attr.sigil.rawValue)\(attr.name)`")
                continue
            }
            if layer != attr.sigil {
                report("attribute-layer", attr.at, "`\(attr.name)` is \(layerName(layer)): write `\(layer.rawValue)\(attr.name)`")
            } else if attr.name == "views" {
                checkViews(attr, model.name, fields, sortable, report)
            } else if attr.name == "index" {
                if attr.args.isEmpty { report("attribute-arguments", attr.at, "`@index` names at least one field") }
                var index: [String] = []
                for arg in attr.args {
                    guard case .ident(let argName, _, _) = arg else {
                        report("attribute-arguments", arg.at, "`@index` takes field names")
                        continue
                    }
                    let field = fields[argName]
                    if field == nil && !uslImplicitFields.contains(argName) { report("unknown-field", arg.at, "`\(model.name)` has no field `\(argName)`") }
                    else if let field, field.arity == .many { report("index-many", arg.at, "`\(argName)` holds many values; an index takes single-valued fields") }
                    else { index.append(argName) }
                }
                if index.count == attr.args.count && !index.isEmpty { resolved[model.name]!.indexes.append(index) }
            } else if attr.name == "table" && modelEnds.isEmpty {
                var value: String?
                if attr.args.count == 1, case .string(let v, _) = attr.args[0], !v.isEmpty { value = v }
                if value == nil {
                    report("attribute-arguments", attr.at, "`@table` names the stored table: `@table(\"lists\")`")
                } else if model.form == .enum {
                    report("stored-on-fixed", attr.at, "`\(model.name)` is an enum and has no table to name")
                } else {
                    resolved[model.name]!.table = value
                }
            } else if attr.name == "fold" || attr.name == "table" {
                if modelEnds.isEmpty {
                    report("storage-on-plain-model", attr.at, "`@\(attr.name)` chooses storage for a connection; `\(model.name)` has no ends")
                } else if attr.name == "fold" {
                    if attr.args.count == 1, case .ident(let target, _, let at) = attr.args[0] {
                        if !modelEnds.contains(where: { $0.model == target }) {
                            report("fold-target", at, "`\(model.name)` can fold only into a model it connects, not `\(target)`")
                        } else if target == "Person" || isFixed(target) {
                            report("stored-on-fixed", at, "`\(target)` has no table to fold into")
                        }
                    } else {
                        report("attribute-arguments", attr.at, "`@fold` on a connection model names one model: `@fold(List)`")
                    }
                }
            }
        }
        if seen.contains("fold") && seen.contains("table") && !modelEnds.isEmpty {
            let second = modelAttributesOf(model.members).first { $0.name == "table" }!
            report("fold-and-table", second.at, "`@fold` and `@table` contradict each other")
        }

        if let block = rows.first { checkRows(model, block, modelEnds, report) }

        if !modelEnds.isEmpty {
            let fold = modelAttributesOf(model.members).first { $0.name == "fold" }
            if case .ident(let into, _, _)? = fold?.args.first {
                resolved[model.name]!.storage = .fold(into: into)
            } else {
                resolved[model.name]!.storage = .table
            }
        }
    }

    // 6. Storage of unnamed connections: never on a model without a table.
    let hasTable = { (name: String) in name != "Person" && !isFixed(name) }
    var connections: [USLResolvedConnection] = []
    for (a, b) in unnamed {
        let label = ["\(a.model).\(a.field)\(arityText(a.arity))", "\(b.model).\(b.field)\(arityText(b.arity))"]
        let nm = a.arity == .many && b.arity == .many
        let candidates = nm ? [a, b] : [a, b].filter { $0.arity != .many }
        let folded = [a, b].filter { hasAttr($0.attrs, "fold") }
        let foldAt = { (e: USLEndDecl) in e.attrs.first { $0.name == "fold" }!.at }
        if !folded.isEmpty && !nm {
            report("fold-end", foldAt(folded[0]), "Only an n:m connection folds; a 1:1 or 1:n is already a column on its single side")
        } else if folded.count > 1 {
            report("fold-end", foldAt(folded[1]), "Fold one end of a connection, not both")
        } else if folded.count == 1 && !hasTable(folded[0].model) {
            report("stored-on-fixed", foldAt(folded[0]), "`\(folded[0].model)` has no table to fold into")
        }
        let on: USLEndDecl? = folded.count == 1 && nm && hasTable(folded[0].model) ? folded[0] : candidates.first { hasTable($0.model) }
        for end in [a, b] {
            guard let column = end.attrs.first(where: { $0.name == "column" }), let on else { continue }
            let isFolded = folded.first.map { $0 == end } ?? false
            if nm && !isFolded {
                report("column-placement", column.at, "An n:m connection is stored in its own table; name its columns in a named connection model, or `@fold` this end")
            } else if !nm && end != on {
                report("column-placement", column.at, "This connection is stored as a column on `\(on.model).\(on.field)`; put `@column` there")
            }
        }
        guard let on else {
            var seenModels: [String] = []
            for e in candidates where !seenModels.contains(e.model) { seenModels.append(e.model) }
            report("stored-on-fixed", a.at, "`\(label[0]) <-> \(label[1])` would be stored on \(seenModels.joined(separator: " or ")), which \(candidates.count > 1 ? "have" : "has") no table (Person and enums don't)")
            continue
        }
        let storage: USLStorage = nm ? .array(on: on.model, field: on.field) : .column(on: on.model, field: on.field)
        connections.append(USLResolvedConnection(ends: label, a: resolvedEnd(a), b: resolvedEnd(b), storage: storage))
    }

    // 7. Top-level views can only be checked for their options.
    for case .view(let decl) in file.declarations {
        for entry in decl.options where !viewOptions.contains(entry.key) || entry.key == "label" {
            report("unknown-view-option", entry.at, "Unknown view option `\(entry.key)`")
        }
    }

    // Names that only clash once stored (two fields given one @column, or a key column and a field).
    var result = USLCheckResult(diagnostics: diagnostics, models: resolved.values, connections: connections)
    if diagnostics.isEmpty {
        for store in [USLStore.database, .files] {
            do {
                _ = try uslLayout(result, store: store)
            } catch let error as USLLayoutError {
                let model = models[String((error.location ?? "").split(separator: ".", omittingEmptySubsequences: false).first ?? "")]
                report("duplicate-column", model?.at ?? USLPosition(line: 1, column: 1), error.message)
                break
            } catch {
                break
            }
        }
    }
    // A stable sort by position, as JavaScript's.
    result.diagnostics = diagnostics.enumerated().sorted {
        ($0.element.line, $0.element.column, $0.offset) < ($1.element.line, $1.element.column, $1.offset)
    }.map(\.element)
    return result
}

/// A model's `~views`, as far as they are well formed; checkViews reports the rest.
private func resolvedViews(_ model: USLModelDecl) -> [USLResolvedView] {
    let attr = modelAttributesOf(model.members).first { $0.name == "views" }
    guard case .list(let list, _)? = attr?.args.first else { return [] }
    func ident(_ e: USLExpr?) -> String? {
        if case .ident(let name, _, _)? = e { return name }
        return nil
    }
    var views: [USLResolvedView] = []
    for view in list {
        guard case .object(let entries, _) = view else { continue }
        func option(_ key: String) -> USLExpr? { entries.first { $0.key == key }?.value }
        var items: [USLLineItem]
        if case .list(let lineItems, _)? = option("line") {
            items = lineItems.compactMap { item in
                guard case .ident(let name, let attrs, _) = item else { return nil }
                var label: String?
                if case .string(let value, _)? = attrs.first(where: { $0.name == "label" && $0.sigil == .presentation })?.args.first { label = value }
                return USLLineItem(
                    field: name, bullet: hasAttr(attrs, "bullet", .presentation), summary: hasAttr(attrs, "summary", .presentation),
                    label: label, sort: identArg(attrs, "sort")
                )
            }
        } else {
            items = views.first?.line ?? []
        }
        var label = ""
        if case .string(let value, _)? = option("label") { label = value }
        var groupSort: String?
        if case .ident(_, let attrs, _)? = option("group") { groupSort = identArg(attrs, "sort") }
        views.append(USLResolvedView(label: label, line: items, group: ident(option("group")), groupSort: groupSort, sort: ident(option("sort"))))
    }
    return views
}

private func checkViews(
    _ attr: USLModelAttribute, _ model: String, _ fields: OrderedMap<USLResolvedField>,
    _ sortable: (String, String) -> Bool, _ report: Report
) {
    /// `~sort(x)` on a view's field: it names a field of the members of a connection.
    func checkSort(_ field: String, _ a: USLAttribute) {
        guard a.args.count == 1, case .ident(let name, _, let at) = a.args[0] else {
            report("attribute-arguments", a.at, "`~sort` names one field of the members: `~sort(name)`")
            return
        }
        guard let resolved = fields[field] else { return }
        if isValueType(resolved.type) {
            report("sort-field", a.at, "`\(field)` holds values, not a connection's members")
        } else if !sortable(resolved.type, name) {
            report("unknown-field", at, "`\(resolved.type)` has no field `\(name)` to sort by")
        }
    }
    guard attr.args.count == 1, case .list(let list, _) = attr.args[0] else {
        report("attribute-arguments", attr.at, "`~views` takes one list of views: `~views([ { label: ... }, ... ])`")
        return
    }
    func fieldRef(_ expr: USLExpr, _ allowImplicit: Bool) {
        guard case .ident(let name, _, _) = expr else {
            report("view-field", expr.at, "Expected a field name")
            return
        }
        let implicit = allowImplicit && (name == "created" || name == "modified")
        if !implicit && !fields.has(name) { report("unknown-field", expr.at, "`\(model)` has no field `\(name)`") }
    }
    var labels = Set<String>()
    for view in list {
        guard case .object(let entries, _) = view else {
            report("attribute-arguments", view.at, "Each view is an object: `{ label: \"...\", ... }`")
            continue
        }
        if let label = entries.first(where: { $0.key == "label" }), case .string(let text, _) = label.value {
            if labels.contains(text) { report("duplicate-view", label.at, "Two views are labelled \"\(text)\"") }
            else { labels.insert(text) }
        } else {
            report("view-label", view.at, "Each view needs a `label` string")
        }
        for entry in entries {
            if !viewOptions.contains(entry.key) {
                report("unknown-view-option", entry.at, "Unknown view option `\(entry.key)`")
            } else if entry.key == "line" {
                guard case .list(let items, _) = entry.value else {
                    report("view-field", entry.value.at, "`line` is a list of fields")
                    continue
                }
                var bullets = 0
                for item in items {
                    fieldRef(item, false)
                    guard case .ident(let itemName, let attrs, _) = item else { continue }
                    for a in attrs {
                        let badArguments: Bool
                        if a.name == "label" {
                            if a.args.count == 1, case .string = a.args[0] { badArguments = false } else { badArguments = true }
                        } else {
                            badArguments = !a.args.isEmpty
                        }
                        if !lineAttributes.contains(a.name) {
                            report("unknown-attribute", a.at, "`\(a.sigil.rawValue)\(a.name)` isn't presentation; a line takes \(lineAttributes.map { "`~\($0)`" }.joined(separator: ", "))")
                        } else if a.sigil != .presentation {
                            report("attribute-layer", a.at, "`\(a.name)` is presentation: write `~\(a.name)`")
                        } else if a.name == "sort" {
                            checkSort(itemName, a)
                        } else if badArguments {
                            report("attribute-arguments", a.at, a.name == "label" ? "`~label` takes one string: `~label(\"lead\")`" : "`~\(a.name)` takes no arguments")
                        } else if a.name == "bullet" {
                            bullets += 1
                            if bullets > 1 { report("duplicate-bullet", a.at, "A line has at most one `~bullet`") }
                        }
                    }
                }
            } else if entry.key == "group" || entry.key == "sort" {
                fieldRef(entry.value, entry.key == "sort")
                guard case .ident(let name, let attrs, _) = entry.value else { continue }
                for a in attrs {
                    if entry.key == "group" && a.name == "sort" && a.sigil != .presentation { report("attribute-layer", a.at, "`sort` is presentation: write `~sort`") }
                    else if entry.key == "group" && a.name == "sort" { checkSort(name, a) }
                    else { report("misplaced-attribute", a.at, entry.key == "group" ? "A `group` takes only `~sort`; other attributes go on the items of a `line`" : "Attributes go on the items of a `line`") }
                }
            }
        }
    }
}

private func checkRows(_ model: USLModelDecl, _ block: USLRowsBlock, _ modelEnds: [USLEndDecl], _ report: Report) {
    if !modelEnds.isEmpty {
        report("rows-with-ends", block.at, "`\(model.name)` is a connection; its rows can't be written in the schema")
    }
    if block.mode == .fixed && block.rows.isEmpty {
        report("empty-enum", model.at, "Enum `\(model.name)` has no values")
    }
    var fields = OrderedMap<USLFieldDecl>()
    for case .field(let f) in model.members where isValueType(f.type) { fields[f.name] = f }
    if block.mode == .seed {
        let name = fields["name"]
        if name == nil || name!.type != "Text" || name!.arity != .one {
            report("seed-needs-name", block.at, "A `seed` model needs a `name Text` field, so people can rename its rows")
        }
    }
    var names = Set<String>()
    for row in block.rows {
        if names.contains(row.name) { report("duplicate-row", row.at, "Row \"\(row.name)\" appears twice") }
        names.insert(row.name)
        for attr in row.attrs {
            var oneString: String?
            if attr.args.count == 1, case .string(let v, _) = attr.args[0] { oneString = v }
            guard let layer = valueAttributes[attr.name] else {
                report("unknown-attribute", attr.at, "Unknown value attribute `\(attr.sigil.rawValue)\(attr.name)`")
                continue
            }
            if layer != attr.sigil {
                report("attribute-layer", attr.at, "`\(attr.name)` is \(layerName(layer)): write `\(layer.rawValue)\(attr.name)`")
            } else if block.mode == .seed {
                report("misplaced-attribute", attr.at, "A `seed` row's \(attr.name == "color" ? "color is data; give it a value for the `~color` field" : "stored text is its id")")
            } else if attr.name == "stored" && (oneString ?? "").isEmpty {
                report("attribute-arguments", attr.at, "`@stored` gives the text a store holds: `@stored(\"pt\")`")
            } else if attr.name == "color" && !(oneString.map(isColor) ?? false) {
                report("bad-color", attr.at, "A value's color is `~color(\"#rrggbb\")`")
            }
        }
        var given = Set<String>()
        for entry in row.values {
            guard let field = fields[entry.key] else {
                report("unknown-field", entry.at, "`\(model.name)` has no value field `\(entry.key)`")
                continue
            }
            if given.contains(entry.key) { report("duplicate-value", entry.at, "`\(entry.key)` is given twice") }
            given.insert(entry.key)
            checkValue(entry, field, report)
        }
        for field in fields.values where field.arity == .one && !given.contains(field.name) {
            report("missing-value", row.at, "Row \"\(row.name)\" needs a value for `\(field.name)`")
        }
    }
}

private func checkValue(_ entry: USLObjectEntry, _ field: USLFieldDecl, _ report: Report) {
    func fits(_ value: USLExpr) -> Bool {
        switch (field.type, value) {
        case ("Text", .string), ("Markdown", .string): return true
        case ("Number", .number): return true
        case ("Int", .number(let n, _)): return n == n.rounded() && abs(n) <= 9_007_199_254_740_991
        case ("Bool", .ident(let name, _, _)): return name == "true" || name == "false"
        case ("Date", .string(let s, _)): return parsesAsDate(s)
        default: return false
        }
    }
    let value = entry.value
    let ok: Bool
    if field.arity == .many {
        if case .list(let items, _) = value { ok = items.allSatisfy(fits) } else { ok = false }
    } else {
        ok = fits(value)
    }
    if !ok { report("bad-value", value.at, "`\(field.name)` holds \(field.type)\(arityText(field.arity))") }
    if hasAttr(field.attrs, "color", .presentation), case .string(let s, _) = value, !isColor(s) {
        report("bad-color", value.at, "A color is \"#rrggbb\"")
    }
}

/// Merges each `re Name { ... }` into the model or enum it names: a mention adds
/// its attributes to that field, end or value, and a model attribute joins the
/// model's own. Nothing in a `re` block declares.
private func mergeRe(_ file: inout USLSchemaFile, _ models: inout OrderedMap<USLModelDecl>, _ report: Report) {
    for case .re(let decl) in file.declarations {
        guard var model = models[decl.name] else {
            report("unknown-model", decl.at, "No model or enum `\(decl.name)` to annotate")
            continue
        }
        for member in decl.members {
            if case .modelAttribute = member {
                model.members.append(member)
                continue
            }
            guard case .mention(let mention) = member else { continue }
            // The value, then the field or end, then a connection end declared outside the model.
            if let m = model.members.firstIndex(where: { if case .rows(let r) = $0 { r.mode == .fixed } else { false } }),
               case .rows(var block) = model.members[m], let r = block.rows.firstIndex(where: { $0.name == mention.name }) {
                block.rows[r].attrs += mention.attrs
                model.members[m] = .rows(block)
                continue
            }
            if let m = model.members.firstIndex(where: {
                switch $0 {
                case .field(let f): f.name == mention.name
                case .end(let e): e.field == mention.name
                default: false
                }
            }) {
                switch model.members[m] {
                case .field(var f):
                    f.attrs += mention.attrs
                    model.members[m] = .field(f)
                case .end(var e):
                    e.attrs += mention.attrs
                    model.members[m] = .end(e)
                default: break
                }
                continue
            }
            if annotateOutsideEnd(&file, &models, model: model.name, field: mention.name, attrs: mention.attrs) { continue }
            report("unknown-field", mention.at, "`\(decl.name)` has no field or value `\(mention.name)`")
        }
        models[decl.name] = model
    }
}

/// Adds attributes to the end `model.field` declared by an unnamed connection or another model.
private func annotateOutsideEnd(_ file: inout USLSchemaFile, _ models: inout OrderedMap<USLModelDecl>, model: String, field: String, attrs: [USLAttribute]) -> Bool {
    func annotate(_ members: inout [USLMember]) -> Bool {
        for (i, member) in members.enumerated() {
            if case .end(var e) = member, e.model == model, e.field == field {
                e.attrs += attrs
                members[i] = .end(e)
                return true
            }
        }
        return false
    }
    for (i, decl) in file.declarations.enumerated() {
        if case .connection(var c) = decl, annotate(&c.members) {
            file.declarations[i] = .connection(c)
            return true
        }
    }
    for name in models.keys where name != model {
        var other = models[name]!
        if annotate(&other.members) {
            models[name] = other
            return true
        }
    }
    return false
}
