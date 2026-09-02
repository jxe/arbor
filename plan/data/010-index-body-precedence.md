# Data 010: `_index.md` takes precedence over a sibling body

## Status

- **Priority:** P1
- **Effort:** S
- **State:** PLANNED — the spec is written ([directory format §2](../../spec/02-directory-format.md#2-mapping-files-and-directories-to-nodes)); the code still blocks on `duplicate-body-representation`.
- **Depends on:** nothing.

## Target result

When `x/_index.md` and a sibling `x.md`, `x.mdx`, or `x.tsx` both exist, the node's content
is `_index.md`, the sibling is not part of the model, and the implementation reports a
non-blocking `shadowed-body` diagnostic naming the sibling. The node remains readable and
editable. Two sibling bodies with no `_index.md` still report `duplicate-body-representation`
and block.

## Code

- `packages/fs/src/workspace-fs.ts`: body resolution prefers `_index.md`; the duplicate check
  applies only among siblings.
- `packages/wire-projection/src/projection.ts`: the same precedence when encoding a tree, and
  when decoding a wire directory that carries both.
- `packages/arborsync/src/fs-errors.ts` and `server.ts`: add `shadowed-body` to the diagnostic
  vocabulary; it is a warning, not an error.
- Canopy's public HTML/Markdown projection: render `_index.md`, never the shadowed sibling.
- `conformance/directory-documents.json`: cases for `_index.md` alone, sibling alone, both
  (content from `_index.md`, diagnostic present), and two siblings (blocked).
- Tests in `tests/unit` for the filesystem provider and the projection.
