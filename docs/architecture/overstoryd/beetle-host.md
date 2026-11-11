# The Beetle host

overstoryd runs Beetle views and mutations ([spec 1.5](../../overstory-spec/1.5-beetle.md))
in process, in `src/beetle-host.ts`, for the trees `OVERSTORYD_BEETLE` names
([deployment](../../../packages/overstoryd/deploy/README.md#views-and-mutations)). It
interprets Beetle with [`@ovst/beetle`](../../../packages/beetle/README.md)'s checker and
evaluator; it loads no authored JavaScript, compiler or query engine
(`tests/unit/overstoryd-code-boundary.test.ts`).

## Code

A handle names a tree, a path, a declaration and a code version. The host reads the
handle's file at the tree's accepted head, and every file it uses, from retained objects:
a `.beetle` file's bytes, or a page's view blocks. The code version is SHA-256 over those
files' paths and texts, in path order (Beetle §6); a handle whose version isn't the
head's answers "not active". Checked programs are cached by root and path.

## Rows

Each collection a program binds (a `schema.beetle` it uses) is read from the head's
directory as logical rows (`loadDirectoryCollection`) and laid out as database rows,
cached by the collection directory's hash. There is no materialization on disk: the
rows are the accepted state. People are virtual `Person` rows: their name, handle and
bio come from profile cards the caller may read, and read as null otherwise.

## Views

`/views` streams use the protocol's `liveViewStream`. Each mount is evaluated over the
head's rows; a stream answers again when its tree accepts an update or a profile tree it
read from does, and sends a result only when the output changed. A data view's value is
its JSON; a UI view's is its node tree. The `rows` answer form waits for Story's
evaluator.

## Mutations

A mutation gathers its facts over the head's rows, applies them to a copy, and diffs the
logical rows before and after into row operations, stamped with the mutation's time. It
submits them as one update guarded on the head it read, as its caller; a head that moved
runs it again. Public errors (`unauthorized`, `forbidden`, `missing`, `invalid`,
`conflict`) answer 401, 403, 404, 422 and 409 and write nothing. Receipts are kept in
`<data>/beetle/receipts.sqlite3` by caller and mutation ID: an exact retry is answered
from the receipt, and the same ID with other input is a conflict.
