# Editor support for .beetle

Syntax highlighting for Beetle files: tables, views, rules and mutations. Zed
reads a tree-sitter grammar and VS Code a TextMate grammar, so there is one of
each, as for USL (`packages/usl/editors`).

- `tree-sitter-beetle/`: the grammar (`grammar.js`) and its queries. After
  changing `grammar.js`, run `npx tree-sitter-cli@0.25.10 generate --abi 14`
  here and commit `src/`; Zed builds the parser from it. The grammar is looser
  than the checker in `../src` (it doesn't track indentation, so a body is the
  lines up to the next declaration): it is for highlighting and the outline,
  not checking.
- `zed/`: a Zed extension. `languages/beetle/*.scm` are copies of
  `tree-sitter-beetle/queries/` (a test checks they match), and
  `extension.toml` names the arbor commit to build the grammar from. To
  install it, run "zed: install dev extension" and pick this folder.
- `vscode/`: a VS Code extension. Besides `.beetle` files it highlights
  ` ```view ` and ` ```beetle ` blocks in Markdown. Copy or link the folder to
  `~/.vscode/extensions/ovst.beetle-0.1.0`, or package it with
  `npx @vscode/vsce package`.
