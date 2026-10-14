(comment) @comment
(string) @string
(number) @number

["model" "view" "of"] @keyword

(model name: (identifier) @type)
(field_declaration name: (identifier) @property)
(field_declaration type: (identifier) @type)
(end model: (identifier) @type)
(end field: (identifier) @property)

(attribute "@" @attribute name: (identifier) @attribute)
(model_attribute "@@" @attribute name: (identifier) @attribute)
(rows "@@" @attribute mode: _ @attribute)

(row name: (_) @constant)
(pair key: (_) @property)
(reference (identifier) @variable)
(view path: (path) @string.special)

"<->" @operator
(arity) @operator

["{" "}" "[" "]" "(" ")"] @punctuation.bracket
["," "." ":" "/"] @punctuation.delimiter
