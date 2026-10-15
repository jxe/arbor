import Foundation

// The syntax tree of an Ultimate Schema Language (.usl) file, and its
// hand-written lexer and recursive-descent parser. A port of
// `packages/usl/src/ast.ts` and `parse.ts` (spec 11): items in any block are
// separated by newlines or commas, and newlines inside parentheses, lists and
// object literals are ignored.
//
// Columns count Unicode scalars; TypeScript counts UTF-16 code units, so the
// two differ only after a character outside the Basic Multilingual Plane on
// the same line.

public struct USLPosition: Sendable, Equatable {
    public var line: Int
    public var column: Int
    public init(line: Int, column: Int) {
        self.line = line
        self.column = column
    }
}

/// `[]` is many, `?` is at most one, nothing is exactly one.
public enum USLArity: String, Sendable, Equatable {
    case one, optional, many
}

public struct USLAttribute: Sendable, Equatable {
    public var name: String
    public var args: [USLExpr]
    public var at: USLPosition
}

public indirect enum USLExpr: Sendable, Equatable {
    case string(String, at: USLPosition)
    case number(Double, at: USLPosition)
    case ident(String, attrs: [USLAttribute], at: USLPosition)
    case list([USLExpr], at: USLPosition)
    case object([USLObjectEntry], at: USLPosition)

    public var at: USLPosition {
        switch self {
        case .string(_, let at), .number(_, let at), .ident(_, _, let at), .list(_, let at), .object(_, let at): at
        }
    }
}

public struct USLObjectEntry: Sendable, Equatable {
    public var key: String
    public var value: USLExpr
    public var at: USLPosition
}

/// `name Type`: a field of the model.
public struct USLFieldDecl: Sendable, Equatable {
    public var name: String
    public var type: String
    public var arity: USLArity
    public var attrs: [USLAttribute]
    public var at: USLPosition
}

/// `Model.field`: an end of a connection, declaring the field that model gains.
public struct USLEndDecl: Sendable, Equatable {
    public var model: String
    public var field: String
    public var arity: USLArity
    public var attrs: [USLAttribute]
    public var at: USLPosition
}

/// `@@name(args)` on a model.
public struct USLModelAttribute: Sendable, Equatable {
    public var name: String
    public var args: [USLExpr]
    public var at: USLPosition
}

public struct USLRowDecl: Sendable, Equatable {
    public var name: String
    public var values: [USLObjectEntry]
    public var attrs: [USLAttribute]
    public var at: USLPosition
}

/// `@@fixed { ... }` or `@@seed { ... }`.
public struct USLRowsBlock: Sendable, Equatable {
    public enum Mode: String, Sendable { case fixed, seed }
    public var mode: Mode
    public var rows: [USLRowDecl]
    public var at: USLPosition
}

public enum USLMember: Sendable, Equatable {
    case field(USLFieldDecl)
    case end(USLEndDecl)
    case modelAttribute(USLModelAttribute)
    case rows(USLRowsBlock)

    public var at: USLPosition {
        switch self {
        case .field(let f): f.at
        case .end(let e): e.at
        case .modelAttribute(let a): a.at
        case .rows(let r): r.at
        }
    }
}

public struct USLModelDecl: Sendable, Equatable {
    public var name: String
    public var members: [USLMember]
    public var at: USLPosition
}

/// An unnamed connection: `{ A.x, B.y }` or `A.x <-> B.y`.
public struct USLConnectionDecl: Sendable, Equatable {
    public enum Spelling: String, Sendable { case braces, arrow }
    public var spelling: Spelling
    public var members: [USLMember]
    public var at: USLPosition
}

/// `view "Label" of ../Path/Model { options }`: a page presenting a collection kept elsewhere.
public struct USLViewDecl: Sendable, Equatable {
    public var label: String
    public var of: String
    public var options: [USLObjectEntry]
    public var at: USLPosition
}

public enum USLDeclaration: Sendable, Equatable {
    case model(USLModelDecl)
    case connection(USLConnectionDecl)
    case view(USLViewDecl)
}

public struct USLSchemaFile: Sendable, Equatable {
    public var declarations: [USLDeclaration]
}

public struct USLDiagnostic: Sendable, Equatable {
    public var code: String
    public var message: String
    public var line: Int
    public var column: Int
}

/// Bounds on what a schema may ask of a parser, so an untrusted schema can't exhaust a host.
public enum USLLimits {
    public static let sourceBytes = 1_048_576
    public static let tokens = 65_536
    public static let depth = 32
}

struct USLSyntaxError: Error {
    var message: String
    var at: USLPosition
    var code = "syntax"
}

private enum TokenKind { case ident, string, number, punct, newline, eof }

private struct Token {
    var kind: TokenKind
    var text: String
    var stringValue: String?
    var numberValue: Double?
    var start: Int
    var end: Int
    var line: Int
    var column: Int
}

private let punctuation = ["<->", "@@", "{", "}", "(", ")", "[", "]", ",", ".", ":", "?", "@", "/"].map { Array($0.unicodeScalars) }

private func isLetter(_ c: Unicode.Scalar) -> Bool {
    (c >= "A" && c <= "Z") || (c >= "a" && c <= "z") || c == "_"
}
private func isDigit(_ c: Unicode.Scalar) -> Bool { c >= "0" && c <= "9" }

private func lex(_ source: String) throws -> (tokens: [Token], scalars: [Unicode.Scalar]) {
    if source.utf8.count > USLLimits.sourceBytes {
        throw USLSyntaxError(message: "A schema is at most \(USLLimits.sourceBytes) bytes", at: USLPosition(line: 1, column: 1), code: "limit")
    }
    let s = Array(source.unicodeScalars)
    var tokens: [Token] = []
    var i = 0
    var line = 1
    var lineStart = 0
    func text(_ a: Int, _ b: Int) -> String { String(String.UnicodeScalarView(s[a..<b])) }
    func push(_ kind: TokenKind, _ start: Int, _ end: Int, string: String? = nil, number: Double? = nil) {
        tokens.append(Token(kind: kind, text: text(start, end), stringValue: string, numberValue: number, start: start, end: end, line: line, column: start - lineStart + 1))
    }
    func startsWith(_ p: [Unicode.Scalar], _ at: Int) -> Bool {
        at + p.count <= s.count && Array(s[at..<(at + p.count)]) == p
    }
    while i < s.count {
        let c = s[i]
        if c == "\n" {
            push(.newline, i, i + 1)
            i += 1
            line += 1
            lineStart = i
        } else if c == " " || c == "\t" || c == "\r" {
            i += 1
        } else if c == "/" && i + 1 < s.count && s[i + 1] == "/" {
            while i < s.count && s[i] != "\n" { i += 1 }
        } else if isLetter(c) {
            let start = i
            while i < s.count && (isLetter(s[i]) || isDigit(s[i])) { i += 1 }
            push(.ident, start, i)
        } else if isDigit(c) || (c == "-" && i + 1 < s.count && isDigit(s[i + 1])) {
            let start = i
            i += 1
            while i < s.count && (isDigit(s[i]) || s[i] == ".") { i += 1 }
            let literal = text(start, i)
            guard literal.range(of: #"^-?[0-9]+(\.[0-9]+)?$"#, options: .regularExpression) != nil, let value = Double(literal) else {
                throw USLSyntaxError(message: "Malformed number \(jsonString(literal))", at: USLPosition(line: line, column: start - lineStart + 1))
            }
            push(.number, start, i, number: value)
        } else if c == "\"" {
            let start = i
            i += 1
            var value = ""
            while i < s.count && s[i] != "\"" {
                if s[i] == "\n" { break }
                if s[i] == "\\" {
                    if i + 1 < s.count {
                        let next = s[i + 1]
                        value.unicodeScalars.append(next == "n" ? "\n" : next == "t" ? "\t" : next)
                    }
                    i += 2
                } else {
                    value.unicodeScalars.append(s[i])
                    i += 1
                }
            }
            if i >= s.count || s[i] != "\"" {
                throw USLSyntaxError(message: "Unterminated string", at: USLPosition(line: line, column: start - lineStart + 1))
            }
            i += 1
            push(.string, start, i, string: value)
        } else {
            guard let p = punctuation.first(where: { startsWith($0, i) }) else {
                throw USLSyntaxError(message: "Unexpected character \(jsonString(String(c)))", at: USLPosition(line: line, column: i - lineStart + 1))
            }
            push(.punct, i, i + p.count)
            i += p.count
        }
    }
    tokens.append(Token(kind: .eof, text: "", start: i, end: i, line: line, column: i - lineStart + 1))
    if tokens.count > USLLimits.tokens {
        throw USLSyntaxError(message: "A schema has at most \(USLLimits.tokens) tokens", at: USLPosition(line: 1, column: 1), code: "limit")
    }
    return (tokens, s)
}

private func describe(_ token: Token) -> String {
    switch token.kind {
    case .eof: "end of file"
    case .newline: "end of line"
    default: jsonString(token.text)
    }
}

private struct Parser {
    let source: [Unicode.Scalar]
    let tokens: [Token]
    var pos = 0
    var depth = 0

    var token: Token { tokens[pos] }
    func peek(_ offset: Int = 1) -> Token { tokens[min(pos + offset, tokens.count - 1)] }
    func at(_ token: Token) -> USLPosition { USLPosition(line: token.line, column: token.column) }
    var here: USLPosition { at(token) }
    func `is`(_ text: String, _ t: Token? = nil) -> Bool {
        let t = t ?? token
        return (t.kind == .punct || t.kind == .ident) && t.text == text
    }
    func fail(_ expected: String) -> USLSyntaxError {
        USLSyntaxError(message: "Expected \(expected), found \(describe(token))", at: here)
    }
    @discardableResult mutating func next() -> Token {
        let t = token
        if t.kind != .eof { pos += 1 }
        return t
    }
    @discardableResult mutating func expect(_ text: String) throws -> Token {
        if !`is`(text) { throw fail(jsonString(text)) }
        return next()
    }
    mutating func ident(_ what: String) throws -> Token {
        if token.kind != .ident { throw fail(what) }
        return next()
    }
    var atEnd: Bool { token.kind == .eof }
    mutating func skipNewlines() { while token.kind == .newline { next() } }
    /// Skips any run of newlines and commas; true if there was one.
    mutating func separators() -> Bool {
        var any = false
        while token.kind == .newline || `is`(",") {
            next()
            any = true
        }
        return any
    }

    mutating func file() throws -> USLSchemaFile {
        var declarations: [USLDeclaration] = []
        skipNewlines()
        while !atEnd {
            let item = try declaration()
            declarations.append(item)
            if !atEnd && !separators() { throw fail("a new line") }
        }
        return USLSchemaFile(declarations: declarations)
    }

    mutating func declaration() throws -> USLDeclaration {
        let start = here
        if `is`("model") && peek().kind == .ident {
            next()
            let name = next().text
            let members = try block()
            return .model(USLModelDecl(name: name, members: members, at: start))
        }
        if `is`("view") && peek().kind == .string {
            next()
            let label = next().stringValue ?? ""
            try expect("of")
            var path: [Token] = []
            while token.kind != .eof && token.kind != .newline && !`is`("{") { path.append(next()) }
            guard let first = path.first, let last = path.last else { throw fail("a collection path") }
            let of = String(String.UnicodeScalarView(source[first.start..<last.end]))
            try expect("{")
            let options = try entries("}")
            return .view(USLViewDecl(label: label, of: of, options: options, at: start))
        }
        if `is`("{") {
            let members = try block()
            return .connection(USLConnectionDecl(spelling: .braces, members: members, at: start))
        }
        if token.kind == .ident && `is`(".", peek()) {
            let left = try end()
            try expect("<->")
            let right = try end()
            if `is`("<->") { throw fail("one arrow per connection; use a named model for more ends") }
            return .connection(USLConnectionDecl(spelling: .arrow, members: [.end(left), .end(right)], at: start))
        }
        throw fail("`model`, `view`, a connection `{ A.x, B.y }` or `A.x <-> B.y`")
    }

    /// `{ member (sep member)* }`
    mutating func block() throws -> [USLMember] {
        try expect("{")
        var members: [USLMember] = []
        _ = separators()
        while !`is`("}") {
            let item = try member()
            members.append(item)
            if !`is`("}") && !separators() { throw fail("a new line, `,` or `}`") }
        }
        next()
        return members
    }

    mutating func member() throws -> USLMember {
        let start = here
        if `is`("@@") {
            next()
            let name = try ident("a model attribute name").text
            if (name == "fixed" || name == "seed") && `is`("{") {
                return .rows(USLRowsBlock(mode: name == "fixed" ? .fixed : .seed, rows: try rows(), at: start))
            }
            let arguments: [USLExpr] = try (`is`("(") ? args() : [])
            return .modelAttribute(USLModelAttribute(name: name, args: arguments, at: start))
        }
        if token.kind == .ident && `is`(".", peek()) { return .end(try end()) }
        if token.kind == .ident {
            let name = next().text
            let type = try ident("a type for field `\(name)`").text
            let arity = try arityChecked()
            let attributes = try attrs()
            return .field(USLFieldDecl(name: name, type: type, arity: arity, attrs: attributes, at: start))
        }
        throw fail("a field, a connection end `Model.field`, or `@@attribute`")
    }

    mutating func end() throws -> USLEndDecl {
        let start = here
        let model = try ident("a model name").text
        try expect(".")
        let field = try ident("a field name").text
        let arity = try arityChecked()
        let attributes = try attrs()
        return USLEndDecl(model: model, field: field, arity: arity, attrs: attributes, at: start)
    }

    mutating func arityChecked() throws -> USLArity {
        if `is`("?") {
            next()
            return .optional
        }
        if `is`("[") {
            next()
            try expect("]")
            return .many
        }
        return .one
    }

    mutating func attrs() throws -> [USLAttribute] {
        var result: [USLAttribute] = []
        while `is`("@") {
            let start = here
            next()
            let name = try ident("an attribute name").text
            let arguments: [USLExpr] = try (`is`("(") ? args() : [])
            result.append(USLAttribute(name: name, args: arguments, at: start))
        }
        return result
    }

    mutating func rows() throws -> [USLRowDecl] {
        try expect("{")
        var result: [USLRowDecl] = []
        _ = separators()
        while !`is`("}") {
            let start = here
            let name: String
            if token.kind == .ident { name = next().text }
            else if token.kind == .string { name = next().stringValue ?? "" }
            else { throw fail("a row name") }
            var values: [USLObjectEntry] = []
            if `is`("{") {
                next()
                values = try entries("}")
            }
            let attributes = try attrs()
            result.append(USLRowDecl(name: name, values: values, attrs: attributes, at: start))
            if !`is`("}") && !separators() { throw fail("a new line, `,` or `}`") }
        }
        next()
        return result
    }

    mutating func args() throws -> [USLExpr] {
        try expect("(")
        return try items(")")
    }

    /// Expressions up to `close`, separated by commas or newlines.
    mutating func items(_ close: String) throws -> [USLExpr] {
        var result: [USLExpr] = []
        _ = separators()
        while !`is`(close) {
            let value = try expr()
            result.append(value)
            if !`is`(close) && !separators() { throw fail("`,` or `\(close)`") }
        }
        next()
        return result
    }

    /// `key: value` entries up to `close`, separated by commas or newlines.
    mutating func entries(_ close: String) throws -> [USLObjectEntry] {
        var result: [USLObjectEntry] = []
        _ = separators()
        while !`is`(close) {
            let start = here
            let key: String
            if token.kind == .ident { key = next().text }
            else if token.kind == .string { key = next().stringValue ?? "" }
            else { throw fail("a key") }
            try expect(":")
            skipNewlines()
            let value = try expr()
            result.append(USLObjectEntry(key: key, value: value, at: start))
            if !`is`(close) && !separators() { throw fail("`,` or `\(close)`") }
        }
        next()
        return result
    }

    mutating func expr() throws -> USLExpr {
        depth += 1
        defer { depth -= 1 }
        if depth > USLLimits.depth {
            throw USLSyntaxError(message: "Values nest at most \(USLLimits.depth) deep", at: here, code: "limit")
        }
        let t = token
        let start = here
        if t.kind == .string {
            next()
            return .string(t.stringValue ?? "", at: start)
        }
        if t.kind == .number {
            next()
            return .number(t.numberValue ?? 0, at: start)
        }
        if t.kind == .ident {
            next()
            let attributes = try attrs()
            return .ident(t.text, attrs: attributes, at: start)
        }
        if `is`("[") {
            next()
            let list = try items("]")
            return .list(list, at: start)
        }
        if `is`("{") {
            next()
            let object = try entries("}")
            return .object(object, at: start)
        }
        throw fail("a value")
    }
}

public struct USLParseResult: Sendable {
    public var file: USLSchemaFile?
    public var diagnostics: [USLDiagnostic]
}

public func parseUSL(_ source: String) -> USLParseResult {
    do {
        let (tokens, scalars) = try lex(source)
        var parser = Parser(source: scalars, tokens: tokens)
        let file = try parser.file()
        return USLParseResult(file: file, diagnostics: [])
    } catch let error as USLSyntaxError {
        return USLParseResult(file: nil, diagnostics: [USLDiagnostic(code: error.code, message: error.message, line: error.at.line, column: error.at.column)])
    } catch {
        return USLParseResult(file: nil, diagnostics: [USLDiagnostic(code: "syntax", message: "\(error)", line: 1, column: 1)])
    }
}

/// Parses and checks a .usl source. A syntax error stops before checking.
public func compileUSL(_ source: String) -> USLCheckResult {
    let parsed = parseUSL(source)
    guard let file = parsed.file else { return USLCheckResult(diagnostics: parsed.diagnostics, models: [], connections: []) }
    return checkUSL(file)
}
