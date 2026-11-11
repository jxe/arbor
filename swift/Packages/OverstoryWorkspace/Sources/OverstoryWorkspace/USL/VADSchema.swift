import Foundation

// A collection's `schema.vad` (spec 1.5 §5), read for its tables. VAD's table
// declarations say what USL's did with `:` and indentation in place of braces,
// so the source is rewritten line for line as USL and checked by `compileUSL`:
// line numbers stay where they were. Views, rules, mutations, `use` lines and
// state tables (`my table`, `session table`) are left out, since Story reads
// only the data layer here; field defaults are left out because they are not
// part of it. The TypeScript checker (`packages/vad`) is the reference.

/// The file name of a collection's schema.
public let collectionSchemaFileName = "schema.vad"

/// Checks a collection's `schema.vad` for its data tables.
public func compileCollectionSchema(_ source: String) -> USLCheckResult {
    compileUSL(uslSourceOfVAD(source))
}

private let tableHeader = try! NSRegularExpression(pattern: #"^(main\s+)?table\s+([A-Za-z_][A-Za-z0-9_]*)\s*(\([^)]*\))?\s*:\s*(//.*)?$"#)
private let blockHeader = try! NSRegularExpression(pattern: #"^(enum|re)\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(//.*)?$"#)
private let seedHeader = try! NSRegularExpression(pattern: #"^seed\s*:\s*(//.*)?$"#)
/// A field with a default: its name, modifiers and type, then `= value`.
private let defaulted = try! NSRegularExpression(pattern: #"^([A-Za-z_][A-Za-z0-9_]*(?:\s+(?:ordered|unique|path))*\s+[A-Za-z_][A-Za-z0-9_]*(?:\?|\[\])?)\s*=(?!=)(.*)$"#)
/// Where a default's value ends: the field's first attribute, or a comment.
private let afterDefault = try! NSRegularExpression(pattern: #"\s[@~][A-Za-z_]|//"#)
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
    enum Kind { case table, other }
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
            open.append((0, .other))
        } else if open.last?.kind == .table, let g = groups(seedHeader, trimmed) {
            text = "seed {\(g[0].map { " " + $0 } ?? "")"
            open.append((indent, .other))
        } else if open.last?.kind == .table, open.count == 1, let g = groups(defaulted, trimmed) {
            let rest = g[1]! as NSString
            let end = afterDefault.firstMatch(in: g[1]!, range: NSRange(location: 0, length: rest.length))?.range.location ?? rest.length
            text = g[0]! + rest.substring(from: end)
        }
        out.append(String(repeating: " ", count: indent) + pending + text)
        pending = ""
    }
    close(below: 0)
    if !pending.isEmpty { out.append(String(pending.dropLast(2))) }
    return out.joined(separator: "\n")
}
