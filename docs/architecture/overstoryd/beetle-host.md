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

Views read each collection a program binds (a `schema.beetle` it uses) from the host's
SQLite copy of it, `<data>/beetle/materialized/<tree>/<path>/_store.sqlite3` in the
schema's database layout (`beetle-materialized.ts`). Before a view runs, the copy is caught
up to the head from the collection directory it last held: only tables whose hash changed
are read, and of those only the chunks the two versions don't share
(`changedCollectionRows`), and each changed logical row rewrites just what it owns (its
row, its join rows, the positions of rows it holds in order). A one-row change costs about
one chunk. A copy that is new, unreadable or from another schema is built from the
accepted rows. It is a cache,
written without waiting on the disk. The view reads it through `@ovst/beetle/sqlite`'s
`SQLiteStore`, which asks SQLite only for what the view reaches: a `for` over a table is
narrowed by its conditions, translated to SQL (`sql.ts`: comparisons with null-safe `is`,
`and`/`or`/`not`, membership through relationships and lists, rules inlined, arithmetic,
text joins, `??`, `length`), with its `orderBy` and `limit` when every condition was
translated exactly and the ordering is on the row's own columns. Each condition has a
translation that keeps every row Beetle keeps and one that keeps only rows it keeps; where
they differ (case-folding beyond ASCII, values of mixed types, Person fields from profile
cards) the looser one narrows and the evaluator checks the rows. Keys and relationships are
looked up by their columns. Each read also carries the view's read shape (`shape.ts`, found from
the source): the relationships the view follows from those rows, at any depth, through
drawn views and rules. SQLite answers the rows and everything the shape follows in one
statement, as nested JSON (`json_object`/`json_group_array` subqueries), and the store
keeps each nested part as the answer to the match the evaluator will make for it. Before a
view runs, the evaluator asks for every read it knows from the source and input alone
(`Store.prefetch`): its table-typed inputs' rows, the people rows name when it ranges over
people, each table it ranges over with no condition that narrows it (once, with one shape
for every place it does), and its top-level `for`s narrowed by their inputs. SQLite answers
them all in one statement (`select json_array(…)`, batched past 100 reads). Every Supplies
view takes one statement. A `for` narrowed by one outer row's fields is read inside that
row's JSON as a correlated subquery, with its ordering and limit. Anything else the source
can't predict is read when the evaluator gets to it. The evaluator applies a condition
itself unless the store answered its exact translation; the in-memory store answers the
same and is what the tests compare against.
People are virtual `Person` rows: their name, handle and
bio come from profile cards the caller may read, and read as null otherwise.

## Views

`/views` streams use the protocol's `liveViewStream`. Each mount is evaluated over the
head's rows; a stream answers again when its tree accepts an update or a profile tree it
read from does, and sends a result only when the output changed. A data view's value is
its JSON; a UI view's is its node tree. The `rows` answer form waits for Story's
evaluator.

## Mutations

A mutation gathers its facts over the same SQLite copies at the head and writes into an
`OverlayStore` over them, which leaves the copy as it is. Its row operations come from the
rows it touched (`editedLogical`): each written row's own logical row and the rows a
relationship holds it in (a join row's owner, an ordered connection's holder), each
converted from just its neighborhood, before and after, and stamped with the mutation's
time. No whole collection is read. It
submits them as one update guarded on the head it read, as its caller; a head that moved
runs it again. Public errors (`unauthorized`, `forbidden`, `missing`, `invalid`,
`conflict`) answer 401, 403, 404, 422 and 409 and write nothing. Receipts are kept in
`<data>/beetle/receipts.sqlite3` by caller and mutation ID: an exact retry is answered
from the receipt, and the same ID with other input is a conflict.
