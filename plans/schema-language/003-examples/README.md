# Plan 003 examples

The schemas in `../examples`, rewritten in the syntax plan 003 decides: the
sigils `@` (model), `&` (storage) and `~` (presentation), with the model and
its storage inline and presentation in `re` blocks. Model-level items sit
after a blank line at the end of a block.

They live here, not in `../examples`, because the tests parse `../examples`
with today's USL. When the parser takes the new sigils, these replace those.
