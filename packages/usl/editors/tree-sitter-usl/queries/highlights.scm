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

; Fields, where declared, as connection ends, and named in a view's line or
; group, or in @@editableBy.
(field_declaration name: (identifier) @function)
(end field: (identifier) @function)
(reference (identifier) @function)

; Field attributes (@fold) and model attributes (@@views) differ. Themes such
; as Ayu Dark draw @attribute, @label and @type in one blue, so field
; attributes take @string.regex (teal there), and view keys are plain
; @variable, apart from the colored names.
(attribute "@" @string.regex name: (identifier) @string.regex)
(model_attribute "@@" @preproc name: (identifier) @preproc)
(rows "@@" @preproc mode: _ @preproc)

(row name: (_) @constant)
(pair key: (_) @variable)
(view path: (path) @string.special)

"<->" @operator
(arity) @operator

["{" "}" "[" "]" "(" ")"] @punctuation.bracket
["," "." ":" "/"] @punctuation.delimiter
