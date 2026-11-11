// Regenerates docs/overstory-spec/conformance/view-language.json from the examples in
// packages/uvl/examples: each source's diagnostics, view plans and mutation writes.
// Run: bun tests/support/regenerate-view-language.ts
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { viewLanguageVectors } from "./view-language-vectors.ts";

const path = join(import.meta.dir, "../../docs/overstory-spec/conformance/view-language.json");
writeFileSync(path, JSON.stringify(viewLanguageVectors(), null, 2) + "\n");
console.log(`wrote ${path}`);
