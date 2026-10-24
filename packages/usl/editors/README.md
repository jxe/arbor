# Editor support for .usl

Syntax highlighting for Ultimate Schema Language. Zed reads a tree-sitter
grammar and VS Code a TextMate grammar, so there is one of each.

- `tree-sitter-usl/`: the grammar (`grammar.js`) and its queries. After
  changing `grammar.js`, run `npx tree-sitter-cli generate` here and commit
  `src/`; Zed builds the parser from it. The grammar is looser than the
  checker (it doesn't know where each attribute is allowed): it is for
  highlighting, not checking. It generates with `--abi 14`, which Zed loads.
- `zed/`: a Zed extension. `languages/usl/*.scm` are copies of
  `tree-sitter-usl/queries/` (a test checks they match), and `extension.toml`
  names the arbor commit to build the grammar from. To install it, run
  "zed: install dev extension" and pick this folder.
- `vscode/`: a VS Code extension. Copy or link the folder to
  `~/.vscode/extensions/ovst.usl-0.1.0`, or package it with `npx @vscode/vsce package`.
