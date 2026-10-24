/** Story Sync round trips through a disposable in-process host: a one-row
 * edit to a JSONL collection of ROWS rows, and a one-file Markdown edit
 * beside FILES files. Runs the same on main and the plan 005 branch.
 *   ROWS=5000 EDITS=10 bun tests/performance/collection-sync.ts
 */
import { installAccountHome } from "../helpers/account-home.ts";
import { hostTree, readTreeConfig } from "../helpers/tree-config.ts";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StorySyncDaemon } from "@ovst/story-sync";
import { serveHost } from "@ovst/overstoryd";
import { resolveSnapshot, snapshotDirectory } from "@ovst/fs";
import { HostAccountStore } from "@ovst/protocol";
import { deviceClient, testAccount, testDevice } from "../helpers/devices.ts";

const ROWS = Number(process.env.ROWS ?? 5000), EDITS = Number(process.env.EDITS ?? 10), FILES = Number(process.env.FILES ?? 200);
const token = "collection-sync-bench";
const sandbox = await mkdtemp(join(tmpdir(), "story-collection-bench-"));
const state = join(sandbox, "home"), folder = join(sandbox, "tree");
await Promise.all([state, join(folder, "notes")].map((path) => mkdir(path, { recursive: true })));
const rows = (edit: number) => Array.from({ length: ROWS }, (_, i) => JSON.stringify({ id: `r${String(i).padStart(6, "0")}`, title: i === edit % ROWS ? `Edited ${edit}` : `Row ${i}` }) + "\n").join("");
for (let i = 0; i < FILES; i++) await writeFile(join(folder, "notes", `n${i}.md`), `# Note ${i}\n\n${"Some text. ".repeat(40)}\n`);

const host = await serveHost({ dataRoot: join(sandbox, "host"), accounts: [testAccount("owner", token, { communityWriter: true })],
  publicOrigin: "http://127.0.0.1:0", hostname: "127.0.0.1", port: 0 });
const quiet = console.log; console.log = () => {};
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
const p90 = (values: number[]) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * 0.9))]!;
try {
  const owner = await deviceClient(host.url, token);
  const profile = (await owner.account()).account.profileTree!;
  // The tree starts with the notes; the daemon adds the collection, so each side scans it its own way.
  const snapshot = await snapshotDirectory(folder);
  const tree = await hostTree(owner, await resolveSnapshot(snapshot), { parent: { tree: profile, name: "bench", kind: "person" } });
  const { values } = await readTreeConfig(owner, profile, "person");
  const device = Object.values(values.devices!).find((candidate: any) => candidate.administrator)! as { id: string };
  await installAccountHome(state, owner, device.id, testDevice(token).seed, { [folder]: tree });
  process.env.STORY_HOME = state;
  const daemon = await StorySyncDaemon.openControl({ autoSync: false });
  try {
    await daemon.synchronizeNow();
    await mkdir(join(folder, "items"));
    await writeFile(join(folder, "items", "schema.usl"), "model Item {\n  title Text\n  done  Bool?\n}\n");
    await writeFile(join(folder, "items", "_store.jsonl"), rows(-1));
    let start = performance.now();
    await daemon.synchronizeNow();
    const first = performance.now() - start;
    const rowEdits: number[] = [], noteEdits: number[] = [], idle: number[] = [];
    for (let edit = 0; edit < EDITS; edit++) {
      await writeFile(join(folder, "items", "_store.jsonl"), rows(edit));
      start = performance.now(); await daemon.synchronizeNow(); rowEdits.push(performance.now() - start);
      await writeFile(join(folder, "notes", `n${edit % FILES}.md`), `# Note ${edit}\n\nEdited ${edit}.\n`);
      start = performance.now(); await daemon.synchronizeNow(); noteEdits.push(performance.now() - start);
      start = performance.now(); await daemon.synchronizeNow(); idle.push(performance.now() - start);
    }
    const updates = host.overstoryd.acceptedUpdates(tree).length;
    const r = (n: number) => Math.round(n);
    quiet(JSON.stringify({ label: "collection-sync", rows: ROWS, files: FILES, edits: EDITS, addCollection: r(first),
      rowEdit: { median: r(median(rowEdits)), p90: r(p90(rowEdits)) },
      noteEdit: { median: r(median(noteEdits)), p90: r(p90(noteEdits)) },
      idle: { median: r(median(idle)), p90: r(p90(idle)) }, acceptedUpdates: updates }));
  } finally { await daemon[Symbol.asyncDispose](); }
} finally {
  for (const account of await HostAccountStore.list()) await new HostAccountStore(account.configurationTree).remove();
  host.server.stop(true);
  await host.overstoryd[Symbol.asyncDispose]();
  await rm(sandbox, { recursive: true, force: true });
}
