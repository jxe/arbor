// Tree-sitter grammar for Ultimate Schema Language (.usl), for editors
// (Zed). The checker in ../../src is the definition of the language; this
// grammar is looser (line feeds are whitespace), which is enough to highlight
// and outline a schema.

const list = (rule) => repeat(seq(rule, optional(",")));

module.exports = grammar({
  name: "usl",
  extras: ($) => [/\s/, $.comment],
  word: ($) => $.identifier,

  rules: {
    source_file: ($) => list(choice($.model, $.view, $.connection)),

    model: ($) => seq("model", field("name", $.identifier), $.block),
    block: ($) => seq("{", list(choice($.field_declaration, $.end, $.model_attribute, $.rows)), "}"),

    connection: ($) => choice($.block, seq($.end, "<->", $.end)),

    view: ($) => seq("view", field("label", $.string), "of", field("path", $.path), $.object),
    path: ($) => repeat1(choice(".", "/", $.identifier)),

    field_declaration: ($) =>
      seq(field("name", $.identifier), field("type", $.identifier), optional($.arity), repeat($.attribute)),
    end: ($) =>
      seq(field("model", $.identifier), ".", field("field", $.identifier), optional($.arity), repeat($.attribute)),
    arity: (_) => choice("?", seq("[", "]")),

    attribute: ($) => seq("@", field("name", $.identifier), optional($.arguments)),
    model_attribute: ($) => seq("@@", field("name", $.identifier), optional($.arguments)),

    rows: ($) => seq("@@", field("mode", choice("fixed", "seed")), "{", list($.row), "}"),
    row: ($) => seq(field("name", choice($.identifier, $.string)), optional($.object), repeat($.attribute)),

    arguments: ($) => seq("(", list($._expression), ")"),
    _expression: ($) => choice($.string, $.number, $.reference, $.list, $.object),
    reference: ($) => seq($.identifier, repeat($.attribute)),
    list: ($) => seq("[", list($._expression), "]"),
    object: ($) => seq("{", list($.pair), "}"),
    pair: ($) => seq(field("key", choice($.identifier, $.string)), ":", field("value", $._expression)),

    identifier: (_) => /[A-Za-z_][A-Za-z0-9_]*/,
    string: (_) => /"([^"\\\n]|\\.)*"/,
    number: (_) => /-?\d+(\.\d+)?/,
    comment: (_) => token(seq("//", /.*/)),
  },
});
