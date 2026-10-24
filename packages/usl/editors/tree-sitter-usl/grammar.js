// Tree-sitter grammar for Ultimate Schema Language (.usl), for editors
// (Zed). The checker in ../../src is the definition of the language; this
// grammar is looser (it doesn't know where attributes are allowed), which is
// enough to highlight and outline a schema. Line feeds separate items, as
// commas do, so that an enum's values on lines of their own stay values.

module.exports = grammar({
  name: "usl",
  extras: ($) => [/[ \t\r]/, $.comment],
  word: ($) => $.identifier,

  rules: {
    source_file: ($) => items($, choice($.model, $.enum, $.re, $.view, $.connection)),

    model: ($) =>
      seq(optional("main"), "model", field("name", $.identifier), optional($.key), $.block),
    key: ($) => seq("(", inner($, $.identifier), ")"),
    enum: ($) => seq("enum", field("name", $.identifier), $.block),
    re: ($) => seq("re", field("name", $.identifier), $.block),
    block: ($) =>
      seq("{", items($, choice($.field_declaration, $.end, $.attribute, $.seed, $.row)), "}"),

    connection: ($) => choice($.block, seq($.end, "<->", $.end)),

    view: ($) => seq("view", field("label", $.string), "of", field("path", $.path), $.object),
    path: ($) => repeat1(choice(".", "/", $.identifier)),

    field_declaration: ($) =>
      seq(
        field("name", $.identifier),
        repeat($.modifier),
        field("type", $.identifier),
        optional($.arity),
        repeat($.attribute),
      ),
    modifier: (_) => choice("ordered", "unique", "path"),
    end: ($) =>
      seq(
        optional("ordered"),
        field("model", $.identifier),
        ".",
        field("field", $.identifier),
        optional($.arity),
        optional(seq("as", field("as", $.identifier))),
        repeat($.attribute),
      ),
    arity: (_) => choice("?", seq("[", "]")),

    // `@` attributes are storage, `~` attributes presentation.
    attribute: ($) =>
      seq(field("sigil", choice("@", "~")), field("name", $.identifier), optional($.arguments)),

    seed: ($) => seq("seed", "{", items($, $.row), "}"),
    // An enum's value, a seed row, or a field or value named again in `re`.
    row: ($) =>
      prec(-1, seq(field("name", choice($.identifier, $.string)), optional($.object), repeat($.attribute))),

    arguments: ($) => seq("(", inner($, $._expression), ")"),
    _expression: ($) => choice($.string, $.number, $.reference, $.list, $.object),
    reference: ($) => seq($.identifier, repeat($.attribute)),
    list: ($) => seq("[", inner($, $._expression), "]"),
    object: ($) => seq("{", inner($, $.pair), "}"),
    pair: ($) => seq(field("key", choice($.identifier, $.string)), ":", field("value", $._expression)),

    _separator: ($) => choice(",", $._newline),
    _newline: (_) => /\n/,

    identifier: (_) => /[A-Za-z_][A-Za-z0-9_]*/,
    string: (_) => /"([^"\\\n]|\\.)*"/,
    number: (_) => /-?\d+(\.\d+)?/,
    comment: (_) => token(seq("//", /.*/)),
  },
});

// Items separated by line feeds or commas, with any number of either between
// and around them.
function items($, rule) {
  return seq(
    repeat($._separator),
    optional(seq(rule, repeat(seq(repeat1($._separator), rule)), repeat($._separator))),
  );
}

// Inside parentheses, lists and objects line feeds are ignored and items are
// separated by commas.
function inner($, rule) {
  const gap = repeat($._newline);
  return seq(gap, optional(seq(rule, gap, repeat(seq(",", gap, rule, gap)), optional(seq(",", gap)))));
}
