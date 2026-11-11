import Foundation

// A collection's `schema.vad` (spec 1.5 §5), read for its tables. VAD's table
// declarations say what USL's did with `:` and indentation in place of braces,
// so the source is rewritten line for line as USL and checked by `compileUSL`:
// line numbers stay where they were. Views, rules, mutations, `use` lines and
// state tables (`my table`, `session table`) are left out, since Story reads
// only the data layer here. A field default is not part of it either; a seed
// row may still leave a defaulted field out, as VAD lets it.
// A field's own `@index` is the table's `@index(field)`. In a `re` block only
// the table's own presentation (`~views`) is kept; a field's presentation
// belongs to views. The TypeScript checker (`packages/vad`) is the reference.

/// The file name of a collection's schema.
public let collectionSchemaFileName = "schema.vad"

/// Checks a collection's `schema.vad` for its data tables. A seed row may
/// leave out a field the table gives a default.
public func compileCollectionSchema(_ source: String) -> USLCheckResult {
    var defaulted = Set<String>()
    var result = compileUSL(convertVAD(source, defaulted: &defaulted))
    result.diagnostics.removeAll { diagnostic in
        diagnostic.code == "missing-value" && defaulted.contains { diagnostic.message.hasSuffix("needs a value for `\($0)`") }
    }
    return result
}

private let tableHeader = try! NSRegularExpression(pattern: #"^(main\s+)?table\s+([A-Za-z_][A-Za-z0-9_]*)\s*(\([^)]*\))?\s*:\s*(//.*)?$"#)
private let blockHeader = try! NSRegularExpression(pattern: #"^(enum|re)\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(//.*)?$"#)
private let seedHeader = try! NSRegularExpression(pattern: #"^seed\s*:\s*(//.*)?$"#)
/// A field with a default: its name, modifiers and type, then `= value`.
private let defaulted = try! NSRegularExpression(pattern: #"^([A-Za-z_][A-Za-z0-9_]*(?:\s+(?:ordered|unique|path))*\s+[A-Za-z_][A-Za-z0-9_]*(?:\?|\[\])?)\s*=(?!=)(.*)$"#)
/// Where a default's value ends: the field's first attribute, or a comment.
private let afterDefault = try! NSRegularExpression(pattern: #"\s[@~][A-Za-z_]|//"#)
/// A field line's own `@index`, not the table-level `@index(...)`.
private let fieldIndex = try! NSRegularExpression(pattern: #"\s@index\b(?!\s*\()"#)
/// A field line: a name, then its modifiers or type.
private let fieldLine = try! NSRegularExpression(pattern: #"^([A-Za-z_][A-Za-z0-9_]*)\s+[A-Za-z_~@]"#)
/// Top-level declarations that hold no data tables.
private let skipped = try! NSRegularExpression(pattern: #"^(?:view|rule|mutation|use|my\s+table|session\s+table)\b|^\}"#)

private func groups(_ regex: NSRegularExpression, _ text: String) -> [String?]? {
    let ns = text as NSString
    guard let match = regex.firstMatch(in: text, range: NSRange(location: 0, length: ns.length)) else { return nil }
    return (1..<match.numberOfRanges).map { i in
        let range = match.range(at: i)
        return range.location == NSNotFound ? nil : ns.substring(with: range)
    }
}

/// The USL that says what a schema.vad's data tables say, one line for each of its lines.
public func uslSourceOfVAD(_ source: String) -> String {
    var defaulted = Set<String>()
    return convertVAD(source, defaulted: &defaulted)
}

/// `uslSourceOfVAD`, noting the fields that had defaults.
private func convertVAD(_ source: String, defaulted defaultedFields: inout Set<String>) -> String {
    enum Kind { case table, presentation, other }
    var out: [String] = []
    /// Open blocks: the indent of their header line, and what they are.
    var open: [(indent: Int, kind: Kind)] = []
    var skipping = false
    var pending = ""

    func close(below indent: Int) {
        while let last = open.last, last.indent >= indent {
            pending += "}, "
            open.removeLast()
        }
    }

    for line in source.components(separatedBy: "\n") {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        let indent = line.prefix(while: { $0 == " " || $0 == "\t" }).count
        if trimmed.isEmpty || trimmed.hasPrefix("//") {
            out.append(line)
            continue
        }
        if indent == 0 {
            close(below: 0)
            skipping = skipped.firstMatch(in: trimmed, range: NSRange(location: 0, length: (trimmed as NSString).length)) != nil
        }
        if skipping {
            out.append(pending)
            pending = ""
            continue
        }
        close(below: indent)
        var text = trimmed
        if indent == 0, let g = groups(tableHeader, trimmed) {
            text = "\(g[0] == nil ? "" : "main ")model \(g[1]!) \(g[2] ?? "") {\(g[3].map { " " + $0 } ?? "")"
            open.append((0, .table))
        } else if indent == 0, let g = groups(blockHeader, trimmed) {
            text = "\(g[0]!) \(g[1]!) {\(g[2].map { " " + $0 } ?? "")"
            open.append((0, g[0] == "re" ? .presentation : .other))
        } else if open.count == 1, open.last?.kind == .presentation, !trimmed.hasPrefix("~") {
            // A field's presentation in a `re` block belongs to views.
            text = ""
        } else if open.last?.kind == .table, let g = groups(seedHeader, trimmed) {
            text = "seed {\(g[0].map { " " + $0 } ?? "")"
            open.append((indent, .other))
        } else if open.last?.kind == .table, open.count == 1, let g = groups(defaulted, trimmed) {
            let rest = g[1]! as NSString
            let end = afterDefault.firstMatch(in: g[1]!, range: NSRange(location: 0, length: rest.length))?.range.location ?? rest.length
            text = g[0]! + rest.substring(from: end)
            if let name = groups(fieldLine, g[0]! + " x")?[0] { defaultedFields.insert(name) }
        }
        if open.last?.kind == .table, open.count == 1, let g = groups(fieldLine, text),
           fieldIndex.firstMatch(in: text, range: NSRange(location: 0, length: (text as NSString).length)) != nil {
            // The field's own index is the table's index on it, on the same line.
            text = fieldIndex.stringByReplacingMatches(in: text, range: NSRange(location: 0, length: (text as NSString).length), withTemplate: "")
                + ", @index(\(g[0]!))"
        }
        out.append(String(repeating: " ", count: indent) + pending + text)
        pending = ""
    }
    close(below: 0)
    if !pending.isEmpty {
        // The last blocks close on the last line that holds code, before any comment.
        let closing = String(pending.dropLast(2))
        if let index = out.lastIndex(where: { line in
            let code = line.trimmingCharacters(in: .whitespaces)
            return !code.isEmpty && !code.hasPrefix("//")
        }) {
            let line = out[index]
            // Right after the code, so an error at the end of the line stays where VAD reports it.
            let end = line.range(of: "//")?.lowerBound ?? line.endIndex
            let code = line[..<end].replacingOccurrences(of: #"\s+$"#, with: "", options: .regularExpression)
            out[index] = code + closing + (end < line.endIndex ? " " + line[end...] : "")
        } else {
            out.append(closing)
        }
    }
    return out.joined(separator: "\n")
}
