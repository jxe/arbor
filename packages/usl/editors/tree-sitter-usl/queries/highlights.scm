; Captures are picked from the ones Zed's themes color, so that names of
; different kinds look different even where a theme draws @property and
; @variable as plain text.

(comment) @comment
(string) @string
(number) @number

["model" "view" "of"] @keyword

; Models are types; the built-in value types (and Person) stand apart.
(model name: (identifier) @type)
(field_declaration
  type: (identifier) @type
  (#not-any-of? @type "Text" "Markdown" "Int" "Number" "Bool" "Date" "Person"))
(field_declaration
  type: (identifier) @constant.builtin
  (#any-of? @constant.builtin "Text" "Markdown" "Int" "Number" "Bool" "Date" "Person"))
(end
  model: (identifier) @type
  (#not-eq? @type "Person"))
(end
  model: (identifier) @constant.builtin
  (#eq? @constant.builtin "Person"))

; Fields, where declared and as connection ends.
(field_declaration name: (identifier) @function)
(end field: (identifier) @function)

; Field attributes (@fold) and model attributes (@@views) differ.
(attribute "@" @attribute name: (identifier) @attribute)
(model_attribute "@@" @preproc name: (identifier) @preproc)
(rows "@@" @preproc mode: _ @preproc)

(row name: (_) @constant)
(pair key: (_) @label)
(reference (identifier) @variable.special)
(view path: (path) @string.special)

"<->" @operator
(arity) @operator

["{" "}" "[" "]" "(" ")"] @punctuation.bracket
["," "." ":" "/"] @punctuation.delimiter
