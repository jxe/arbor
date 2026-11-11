// Tree-sitter grammar for Beetle (.beetle), for editors (Zed). The parser and checker in
// ../../src are the definition of the language; this grammar is looser, which is enough to
// highlight and outline a file. Indentation isn't tracked: a declaration's body is the
// lines after its header up to the next declaration, and a mutation's `if` and `for` lines
// are lines like any other. Line feeds end table members and body lines; inside brackets,
// braces, parentheses and tags they are ignored.

const PREC = {
  choice: 1,
  coalesce: 2,
  or: 3,
  and: 4,
  membership: 5,
  comparison: 6,
  additive: 7,
  multiplicative: 8,
  unary: 9,
  call: 10,
  field: 11,
};

const ERROR_CODES = ["unauthorized", "forbidden", "missing", "invalid", "conflict"];

module.exports = grammar({
  name: "beetle",
  extras: ($) => [/[ \t\r]/, $.comment],
  word: ($) => $.identifier,
  conflicts: ($) => [
    [$.record, $.data_record],
    [$.data_entry, $.pair],
  ],

  rules: {
    // Each line of a body ends with a line feed, so a file ends with one too.
    source_file: ($) => repeat(choice($._declaration, $._newline)),

    _declaration: ($) =>
      choice($.use, $.view, $.rule, $.mutation, $.table, $.enum, $.re, $.connection, $.element),

    // ------------------------------------------------------------ use

    use: ($) => seq("use", field("path", $.string), optional($.picks)),
    picks: ($) => seq("(", inner($, $.pick), ")"),
    pick: ($) => seq(field("name", choice($.identifier, "view")), optional(seq("as", field("as", $.identifier)))),

    // ------------------------------------------------------------ views

    view: ($) =>
      prec.right(seq(
        "view",
        optional(field("name", $.identifier)),
        $.parameters,
        choice(seq(":", repeat(choice($._newline, seq(choice($.view_line, $.element), $._newline)))), $.data_record),
      )),
    parameters: ($) => seq("(", inner($, $.parameter), ")"),
    parameter: ($) => seq(field("name", $.identifier), optional(field("type", $.type))),
    type: ($) => seq($.identifier, optional($.arity)),
    arity: (_) => choice("?", seq("[", "]")),

    view_line: ($) =>
      choice(
        seq(choice("state", "keep"), field("name", $.identifier), "=", $._expression),
        seq("on", field("event", $.identifier), optional($.string), $.arrow, $._expression),
        seq("every", $.duration, $.arrow, $._expression),
      ),
    arrow: (_) => choice("→", "->"),

    // A data view's braces: entries separated by commas or line feeds.
    data_record: ($) => seq("{", optional(entries($, $.data_entry)), "}"),
    data_entry: ($) =>
      choice(
        seq(field("key", $.identifier), ":", choice($._expression, seq($.data_record, repeat($.attribute)))),
        seq(field("key", $.identifier), optional($.data_record)),
      ),

    // ------------------------------------------------------------ elements

    element: ($) =>
      choice(
        seq($.start_tag, repeat($._child), $.end_tag),
        $.self_closing_tag,
      ),
    start_tag: ($) => seq("<", field("name", $.tag_name), repeat(choice($.attribute, $._newline)), ">"),
    self_closing_tag: ($) => seq("<", field("name", $.tag_name), repeat(choice($.attribute, $._newline)), "/>"),
    end_tag: ($) => seq("</", field("name", $.tag_name), ">"),
    tag_name: (_) => token.immediate(/[A-Za-z_][A-Za-z0-9_]*/),
    attribute: ($) =>
      seq(field("name", $.identifier), optional(seq("=", field("value", choice($.string, $.interpolation))))),
    _child: ($) => choice($.element, $.interpolation, $.text, $._newline),
    text: (_) => token(prec(-1, /[^<>{}\n]+/)),

    // `{…}` in attributes, text and strings: expressions separated by commas, each maybe
    // followed by `desc` or `asc` (in `orderBy`).
    interpolation: ($) => seq("{", inner($, seq($._expression, optional(choice("desc", "asc")))), "}"),

    // ------------------------------------------------------------ rules and mutations

    rule: ($) => prec.right(seq("rule", field("name", $.identifier), $.parameters, ":", repeat(choice($._newline, seq($._expression, $._newline))))),

    mutation: ($) =>
      prec.right(seq(
        "mutation",
        field("name", $.identifier),
        $.parameters,
        optional(seq("for", field("table", $.identifier), ".", field("op", $.identifier))),
        ":",
        repeat(choice($._newline, seq($._mutation_line, $._newline))),
      )),
    _mutation_line: ($) => choice($.if_line, $.for_line, $.error_line, $.let_line, $.set_line, $._expression),
    if_line: ($) => seq("if", $._expression, ":"),
    for_line: ($) => seq("for", sep1($, $._expression), optional(seq("where", sep1($, $._expression))), ":"),
    error_line: ($) => seq(field("code", $.error_code), optional($.string)),
    error_code: (_) => choice(...ERROR_CODES),
    let_line: ($) => seq("let", field("name", $.identifier), "=", $._expression),
    set_line: ($) => prec(-1, seq($._expression, "=", $._expression)),

    // ------------------------------------------------------------ tables

    table: ($) =>
      prec.right(seq(
        optional(field("kind", choice("main", "my", "session"))),
        "table",
        field("name", $.identifier),
        optional($.key),
        ":",
        repeat(choice($._newline, seq($._member, $._newline))),
      )),
    key: ($) => seq("(", inner($, $.identifier), ")"),
    enum: ($) => prec.right(seq("enum", field("name", $.identifier), ":", repeat(choice($._newline, seq($._member, $._newline))))),
    re: ($) => prec.right(seq("re", field("name", $.identifier), ":", repeat(choice($._newline, seq($._member, $._newline))))),
    _member: ($) => choice($.field_declaration, $.end, $.schema_attribute, $.value, $.connection),

    field_declaration: ($) =>
      prec.right(seq(
        field("name", $.identifier),
        repeat($.modifier),
        field("type", $.identifier),
        optional($.arity),
        optional(seq("=", field("default", $._expression))),
        repeat($.schema_attribute),
      )),
    modifier: (_) => choice("ordered", "unique", "path"),
    end: ($) =>
      prec.right(seq(
        optional("ordered"),
        field("table", $.identifier),
        ".",
        field("field", $.identifier),
        optional($.arity),
        optional(seq("as", field("as", $.identifier))),
        repeat($.schema_attribute),
      )),
    connection: ($) => seq($.end, "<->", $.end),
    // An enum's value, or a field or value named again in `re`.
    value: ($) => prec.right(-1, seq(field("name", choice($.identifier, $.string)), optional($.record), repeat($.schema_attribute))),

    // `@` attributes are storage, `~` attributes presentation.
    schema_attribute: ($) =>
      prec.right(seq(field("sigil", choice("@", "~")), field("name", $.identifier), optional($.arguments))),

    // ------------------------------------------------------------ expressions

    _expression: ($) =>
      choice(
        $.identifier,
        $.number,
        $.duration,
        $.string,
        $.boolean,
        $.null,
        $.list,
        $.record,
        $.call,
        $.field_expression,
        $.unary_expression,
        $.binary_expression,
        $.choice_expression,
        $.parenthesized,
        $.element,
        $.annotated,
      ),
    // `name ~attr`, inside a `~views` argument.
    annotated: ($) => prec.left(PREC.field, seq($._expression, $.schema_attribute)),
    boolean: (_) => choice("true", "false"),
    null: (_) => "null",
    parenthesized: ($) => seq("(", gap($), $._expression, gap($), ")"),
    list: ($) => seq("[", inner($, $._expression), "]"),
    record: ($) => seq("{", inner($, $.pair), "}"),
    pair: ($) => seq(field("key", choice($.identifier, $.string)), ":", field("value", $._expression)),
    call: ($) => prec(PREC.call, seq(field("function", $.identifier), $.arguments)),
    arguments: ($) => seq("(", inner($, $.argument), ")"),
    argument: ($) =>
      choice(
        seq(field("name", $.identifier), ":", $._expression),
        prec.right(seq($._expression, optional(seq("where", sep1($, $._expression))))),
      ),
    field_expression: ($) => prec(PREC.field, seq(field("object", $._expression), ".", field("field", $.identifier))),
    unary_expression: ($) => prec(PREC.unary, seq(field("operator", choice("not", "-")), $._expression)),
    binary_expression: ($) =>
      choice(
        ...[
          [PREC.coalesce, "??"],
          [PREC.or, "or"],
          [PREC.and, "and"],
          [PREC.membership, choice("in", "excludes", "∈", "∉")],
          [PREC.comparison, choice("==", "!=", "<", "<=", ">", ">=")],
          [PREC.additive, choice("+", "-")],
          [PREC.multiplicative, choice("*", "/")],
        ].map(([p, op]) => prec.left(p, seq(field("left", $._expression), field("operator", op), field("right", $._expression)))),
      ),
    choice_expression: ($) => prec.right(PREC.choice, seq($._expression, "?", $._expression, ":", $._expression)),

    string: ($) => seq('"', repeat(choice($.string_content, $.escape, $.interpolation)), token.immediate('"')),
    string_content: (_) => token.immediate(/[^"{\\\n]+/),
    escape: (_) => token.immediate(/\\./),

    _newline: (_) => /\n/,
    identifier: (_) => /[A-Za-z_][A-Za-z0-9_]*/,
    duration: (_) => token(prec(1, /\d+(ms|s|m|h|d)/)),
    number: (_) => /\d+(\.\d+)?/,
    comment: (_) => token(prec(1, seq("//", /.*/))),
  },
});

// Line feeds, ignored inside brackets.
function gap($) {
  return repeat($._newline);
}

// Items separated by commas on one line.
function sep1($, rule) {
  return seq(rule, repeat(seq(",", rule)));
}

// Inside brackets: items separated by commas, line feeds ignored.
function inner($, rule) {
  const g = gap($);
  return seq(g, optional(seq(rule, g, repeat(seq(",", g, rule, g)), optional(seq(",", g)))));
}

// A data record's entries: separated by commas or line feeds.
function entries($, rule) {
  const separator = choice(",", $._newline);
  return seq(repeat(separator), rule, repeat(seq(repeat1(separator), rule)), repeat(separator));
}
