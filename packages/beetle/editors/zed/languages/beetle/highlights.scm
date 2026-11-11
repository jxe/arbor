; Captures are picked from the ones Zed's themes color, as in the USL grammar, so that
; names of different kinds look different even where a theme draws @property and
; @variable as plain text.

(comment) @comment
(string) @string
(escape) @string.escape
(number) @number
(duration) @number
(boolean) @boolean
(null) @constant.builtin

[
  "use" "as" "view" "rule" "mutation" "table" "enum" "re"
  "state" "keep" "on" "every" "if" "for" "where" "let"
  "desc" "asc"
] @keyword
(table kind: _ @keyword)
(modifier) @keyword
(end "ordered" @keyword)
["not" "and" "or" "in" "excludes" "∈" "∉"] @keyword.operator
(error_code) @keyword.exception

; Declarations.
(view name: (identifier) @function)
(rule name: (identifier) @function)
(mutation name: (identifier) @function)
(mutation table: (identifier) @type op: (identifier) @function)
(table name: (identifier) @type)
(enum name: (identifier) @type)
(re name: (identifier) @type)
(key (identifier) @property)
(pick name: (identifier) @function)
(pick as: (identifier) @function)
(use path: (string) @string.special)

; Tables: the built-in value types (and Person) stand apart from tables.
(field_declaration name: (identifier) @property)
(field_declaration
  type: (identifier) @type
  (#not-any-of? @type "Text" "Markdown" "Int" "Number" "Bool" "Date" "Duration" "Person"))
(field_declaration
  type: (identifier) @type.builtin
  (#any-of? @type.builtin "Text" "Markdown" "Int" "Number" "Bool" "Date" "Duration" "Person"))
(end table: (identifier) @type)
(end field: (identifier) @property)
(end as: (identifier) @property)
(value name: (_) @constant)
(schema_attribute sigil: "@" @preproc name: (identifier) @preproc)
(schema_attribute sigil: "~" @string.regex name: (identifier) @string.regex)

; Parameters and their types.
(parameter name: (identifier) @variable.parameter)
(type (identifier) @type.builtin
  (#any-of? @type.builtin "Text" "Markdown" "Int" "Number" "Bool" "Date" "Duration" "Person"))
(type (identifier) @type
  (#not-any-of? @type "Text" "Markdown" "Int" "Number" "Bool" "Date" "Duration" "Person"))
(view_line name: (identifier) @variable)
(view_line event: (identifier) @attribute)
(let_line name: (identifier) @variable)

; Elements: a tag, its attributes, and the language's own attributes apart.
(tag_name) @tag
(attribute
  name: (identifier) @attribute
  (#not-any-of? @attribute "for" "where" "if" "orderBy" "group" "limit" "fallback" "key" "slot"))
(attribute
  name: (identifier) @keyword
  (#any-of? @keyword "for" "where" "if" "orderBy" "group" "limit" "fallback" "key" "slot"))
(text) @text

; Expressions.
(call function: (identifier) @function.builtin
  (#any-of? @function.builtin "count" "exists" "sum" "min" "max" "lower" "upper" "trim" "length" "set"))
(call function: (identifier) @function
  (#not-any-of? @function "count" "exists" "sum" "min" "max" "lower" "upper" "trim" "length" "set"))
(field_expression field: (identifier) @property)
(argument name: (identifier) @variable.parameter)
(pair key: (_) @property)
(data_entry key: (identifier) @property)
; A name in an expression: a built-in, a table or enum value (capitalized), or a name in
; scope. Each pattern names the places a name can stand, so that none overlaps the names
; captured above.
(binary_expression left: (identifier) @variable.builtin
  (#any-of? @variable.builtin "me" "community" "page" "now" "today"))
(binary_expression right: (identifier) @variable.builtin
  (#any-of? @variable.builtin "me" "community" "page" "now" "today"))
(unary_expression (identifier) @variable.builtin
  (#any-of? @variable.builtin "me" "community" "page" "now" "today"))
(interpolation (identifier) @variable.builtin
  (#any-of? @variable.builtin "me" "community" "page" "now" "today"))
(argument . (identifier) @variable.builtin .
  (#any-of? @variable.builtin "me" "community" "page" "now" "today"))
(argument ":" (identifier) @variable.builtin
  (#any-of? @variable.builtin "me" "community" "page" "now" "today"))
(pair value: (identifier) @variable.builtin
  (#any-of? @variable.builtin "me" "community" "page" "now" "today"))
(list (identifier) @variable.builtin
  (#any-of? @variable.builtin "me" "community" "page" "now" "today"))
(field_expression object: (identifier) @variable.builtin
  (#any-of? @variable.builtin "me" "community" "page" "now" "today"))
(view_line (_) "=" (identifier) @variable.builtin
  (#any-of? @variable.builtin "me" "community" "page" "now" "today"))
(let_line "=" (identifier) @variable.builtin
  (#any-of? @variable.builtin "me" "community" "page" "now" "today"))
(set_line "=" (identifier) @variable.builtin
  (#any-of? @variable.builtin "me" "community" "page" "now" "today"))
(field_declaration default: (identifier) @variable.builtin
  (#any-of? @variable.builtin "me" "community" "page" "now" "today"))
(choice_expression (identifier) @variable.builtin
  (#any-of? @variable.builtin "me" "community" "page" "now" "today"))
(parenthesized (identifier) @variable.builtin
  (#any-of? @variable.builtin "me" "community" "page" "now" "today"))
(binary_expression left: (identifier) @type
  (#match? @type "^[A-Z]"))
(binary_expression right: (identifier) @type
  (#match? @type "^[A-Z]"))
(unary_expression (identifier) @type
  (#match? @type "^[A-Z]"))
(interpolation (identifier) @type
  (#match? @type "^[A-Z]"))
(argument . (identifier) @type .
  (#match? @type "^[A-Z]"))
(argument ":" (identifier) @type
  (#match? @type "^[A-Z]"))
(pair value: (identifier) @type
  (#match? @type "^[A-Z]"))
(list (identifier) @type
  (#match? @type "^[A-Z]"))
(field_expression object: (identifier) @type
  (#match? @type "^[A-Z]"))
(view_line (_) "=" (identifier) @type
  (#match? @type "^[A-Z]"))
(let_line "=" (identifier) @type
  (#match? @type "^[A-Z]"))
(set_line "=" (identifier) @type
  (#match? @type "^[A-Z]"))
(field_declaration default: (identifier) @type
  (#match? @type "^[A-Z]"))
(choice_expression (identifier) @type
  (#match? @type "^[A-Z]"))
(parenthesized (identifier) @type
  (#match? @type "^[A-Z]"))

[
  "==" "!=" "<=" ">=" "+" "-" "*" "/" "??" "?" "<->" "=" "→" "->"
] @operator
(binary_expression operator: ["<" ">"] @operator)
(arity) @operator

["{" "}" "[" "]" "(" ")"] @punctuation.bracket
(start_tag ["<" ">"] @punctuation.bracket)
(self_closing_tag ["<" "/>"] @punctuation.bracket)
(end_tag ["</" ">"] @punctuation.bracket)
(interpolation ["{" "}"] @punctuation.special)
["," "." ":"] @punctuation.delimiter
