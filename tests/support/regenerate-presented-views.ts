// Recomputes the expected results in
// docs/overstory-spec/conformance/presented-views.json from its inputs, with
// the TypeScript reference (`@ovst/usl` present.ts and logical.ts). Review the diff: the
// Swift port (StoryKit `PresentedView`) is held to the same file.
//
//   bun tests/support/regenerate-presented-views.ts

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyRowEdits, compileUsl, layoutOf, logicalFromRows, presentView, rowsFromLogical, viewEdits, ViewError, type RowsByTable, type ViewIntent, type Person } from "@ovst/usl";

const path = join(import.meta.dir, "../../docs/overstory-spec/conformance/presented-views.json");
const file = JSON.parse(readFileSync(path, "utf8"));
type Fixture = { schema: string; rows: RowsByTable; people: Person[] };
const fixtures = file.fixtures as Record<string, Fixture>;
const compiled = Object.fromEntries(Object.entries(fixtures).map(([name, f]) => [name, compileUsl(f.schema)]));

for (const item of file.presentations) {
  const f = fixtures[item.fixture]!;
  item.expected = presentView(compiled[item.fixture]!, f.rows, { model: item.model, view: item.view, query: item.query, people: f.people });
}
file.intents = file.intents.map((item: Record<string, unknown>) => {
  const { operations: _o, rows: _r, error: _e, ...input } = item;
  const name = input.fixture as string;
  const f = fixtures[name]!;
  try {
    const operations = viewEdits(compiled[name]!, f.rows, { model: input.model as string | undefined, view: input.view as number | undefined, people: f.people }, input.intent as ViewIntent);
    return { ...input, operations, rows: applyRowEdits(compiled[name]!, f.rows, operations) };
  } catch (error) {
    if (!(error instanceof ViewError)) throw error;
    return { ...input, error: true };
  }
});
// Each fixture's rows in the logical form a tree holds (spec 06 §2.2), and
// the data-file rows `rowsFromLogical` makes of them: what Story reads.
file.logical = Object.keys(fixtures).map((name) => {
  const layout = layoutOf(compiled[name]!, { store: "files" });
  const tables = logicalFromRows(compiled[name]!, layout, fixtures[name]!.rows, { now: "2026-01-01T00:00:00.000Z" });
  return { fixture: name, tables, rows: rowsFromLogical(compiled[name]!, layout, tables) };
});
writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
