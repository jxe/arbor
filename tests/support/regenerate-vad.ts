// Regenerates docs/overstory-spec/conformance/vad.json from the examples in
// packages/vad/examples: each file's diagnostics, view plans and mutation writes.
// Run: bun tests/support/regenerate-vad.ts
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { vadVectors } from "./vad-vectors.ts";

const path = join(import.meta.dir, "../../docs/overstory-spec/conformance/vad.json");
writeFileSync(path, JSON.stringify(vadVectors(), null, 2) + "\n");
console.log(`wrote ${path}`);
