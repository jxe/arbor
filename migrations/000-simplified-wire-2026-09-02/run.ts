// Offline, in-place migration of a pre-stamp Canopy data root to the current
// schema. Run against a downloaded copy first, then against the real volume:
//   bun run migrations/000-simplified-wire-2026-09-02/run.ts /path/to/data-root
// Prints a report with tree ids and roots only; never digests or tokens.
import { resolve } from "node:path";
import { migrateCanopy } from "./migrate.ts";

const [target] = process.argv.slice(2);
if (!target) {
  console.error("usage: bun run migrations/000-simplified-wire-2026-09-02/run.ts <canopy-data-root>");
  process.exit(2);
}
const report = await migrateCanopy(resolve(target));
console.log(JSON.stringify(report, null, 2));
