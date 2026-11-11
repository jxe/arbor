// Regenerates docs/overstory-spec/conformance/beetle.json from the examples in
// packages/beetle/examples: each file's diagnostics, view plans and mutation writes.
// Run: bun tests/support/regenerate-beetle.ts
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { beetleVectors } from "./beetle-vectors.ts";

const path = join(import.meta.dir, "../../docs/overstory-spec/conformance/beetle.json");
writeFileSync(path, JSON.stringify(beetleVectors(), null, 2) + "\n");
console.log(`wrote ${path}`);
