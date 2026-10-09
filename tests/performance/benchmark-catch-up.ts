/** Returning-device catch-up against deterministic host-fast-forward history.
 * Fresh child processes separate empty-cache and checkpoint-restored runs.
 * All writes go to a fresh temporary cache. ENTRIES=4200 for incident scale.
 * bun tests/performance/benchmark-catch-up.ts
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeLogEntry, LOG_ENTRY_FORMAT, type MergeQuestion } from "@overstory/merge-protocol";
import { hashObject, stableJSONString, type SourceOperation } from "@overstory/protocol";
import { Sidecar } from "../../packages/canopyd-merge/src/sidecar.ts";
import { savedStatesIn } from "../../packages/canopyd-merge/src/saved-states.ts";
import { historyMapDiagnostics, resetHistoryMapDiagnostics } from "../../packages/canopyd-merge/src/retained-state.ts";
import { Fixture } from "../unit/canopyd-merge/fixture.ts";
import { executeExactSourceEdits } from "../support/source-edits.ts";

if (!process.argv.includes("--child")) {
  const cache = await mkdtemp(join(tmpdir(), "merge-catch-up-"));
  try {
    let digest: string | undefined;
    for (const scenario of ["empty", "restart"]) {
      const child = Bun.spawn([process.execPath, import.meta.path, "--child", cache, scenario], { stdout: "pipe", stderr: "inherit" });
      const output = await new Response(child.stdout).text();
      if (await child.exited !== 0) throw Error(`Catch-up benchmark failed: ${scenario}`);
      const result = JSON.parse(output);
      if (digest && digest !== result.answerDigest) throw Error("Restart answer differs");
      digest = result.answerDigest;
      console.log(output.trim());
    }
  } finally { await rm(cache, { recursive: true, force: true }); }
  process.exit(0);
}
const [, , , cache, scenario] = process.argv;
const count = Number(process.env.ENTRIES ?? 256);
const f = new Fixture(), rules = { id: "tree-default", revision: 1 };
let text = "abc\n", root = f.tree({ "a.md": text });
let head = f.put(encodeLogEntry({ format: LOG_ENTRY_FORMAT, tree: "tree", previous: null, root, change: "genesis", trace: null, resolves: [], decisions: [] }));
const entries = [{ head, root, text }];
for (let i = 0; i < count; i++) {
  const next = (i % 2 ? "A" : "a") + text.slice(1);
  const operations: SourceOperation[] = [{ kind: "editSource", key: "edit", source: f.ref("/a.md", text, [0, 1]), text: next[0]! }];
  const executed = await executeExactSourceEdits(root, operations, async (hash) => f.objects.get(hash)!);
  for (const [hash, bytes] of executed.generated) f.objects.set(hash, bytes);
  const trace = [{ before: root, after: executed.root, operations }];
  // Simulate host acceptance without asking the merge worker to stay warm.
  head = f.put(encodeLogEntry({ format: LOG_ENTRY_FORMAT, tree: "tree", previous: head, root: executed.root,
    change: `edit-${i}`, trace, resolves: [], decisions: [], asked: { rules } }));
  root = executed.root; text = next;
  entries.push({ head, root, text });
}
const basis = entries[Math.floor(count / 2)]!;
const operations: SourceOperation[] = [{ kind: "editSource", key: "offline", source: f.ref("/a.md", basis.text, [2, 3]), text: "C" }];
const candidate = await executeExactSourceEdits(basis.root, operations, async (hash) => f.objects.get(hash)!);
for (const [hash, bytes] of candidate.generated) f.objects.set(hash, bytes);
const question: MergeQuestion = { base: basis.head, head, rules,
  candidate: { root: candidate.root, change: "offline", trace: [{ before: basis.root, after: candidate.root, operations }], resolves: [] } };
const sidecar = new Sidecar({ shared: { find: async (hash) => f.objects.get(hash) ?? null, has: async (hash) => f.objects.has(hash) },
  staging: { find: async (hash) => f.objects.get(hash) ?? null, stage: async (values) => { for (const v of values) f.objects.set(v.hash, v.bytes); } },
  saved: savedStatesIn(cache!) });
resetHistoryMapDiagnostics();
const start = performance.now();
let replayed = 0, restored = 0, attempts = 0, answer, saveMs = 0;
for (; attempts < count + 2;) {
  attempts++;
  try { answer = await sidecar.answer(question); }
  catch (error) { if (!String(error).includes("Rebuilding accepted history")) throw error; }
  replayed += sidecar.replayed; restored += sidecar.restored;
  const saving = performance.now(); await sidecar.save(); saveMs += performance.now() - saving;
  if (answer) break;
}
if (!answer) throw Error("Catch-up failed to converge");
const totalMs = performance.now() - start;
const work = { ...historyMapDiagnostics };
const warmStart = performance.now(), warm = await sidecar.answer(question);
if (stableJSONString(warm) !== stableJSONString(answer)) throw Error("Warm answer differs");
console.log(JSON.stringify({ scenario, entries: count + 1, attempts, replayed, restored, totalMs, saveMs, warmMs: performance.now() - warmStart,
  historyWork: work, answerDigest: hashObject(Buffer.from(stableJSONString(answer))), peakRSS: process.resourceUsage().maxRSS }));
