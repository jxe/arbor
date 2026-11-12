/** What one Beetle mutation costs on the host, end to end: the Supplies example placed in
 * a disposable in-process host, and EDITS `createList` and `toggleListReaction` calls.
 *   EDITS=20 bun tests/performance/beetle-mutation-cost.ts
 */
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CollectionProjections } from "@ovst/story-sync/state";
import { serveHost } from "@ovst/overstoryd";
import { resolveSnapshot, snapshotDirectory } from "@ovst/fs";
import type { MutationCallRequest, ObjectHash } from "@ovst/protocol";
import { hostTree } from "../helpers/tree-config.ts";
import { deviceClient, deviceSession, testAccount } from "../helpers/devices.ts";

const EDITS = Number(process.env.EDITS ?? 20);
const token = "beetle-mutation-bench";
const EXAMPLES = join(import.meta.dir, "../../packages/beetle/examples/supplies");
const sandbox = await mkdtemp(join(tmpdir(), "story-beetle-mutation-bench-"));
const folder = join(sandbox, "tree");
await mkdir(join(folder, "supplies", "data"), { recursive: true });
for (const name of ["List.beetle", "Home.beetle", "Feeds.beetle", "mutations.beetle", "parts"]) await cp(join(EXAMPLES, name), join(folder, "supplies", name), { recursive: true });
for (const name of ["schema.beetle", "_store.sqlite3"]) await cp(join(EXAMPLES, "data", name), join(folder, "supplies", "data", name));
let minutes = 0;
const host = await serveHost({
  dataRoot: join(sandbox, "host"), accounts: [testAccount("owner", token, { communityWriter: true })],
  publicOrigin: "http://127.0.0.1:0", hostname: "127.0.0.1", port: 0,
  beetle: { trees: "all", now: () => new Date(Date.UTC(2026, 10, 11, 12, minutes++, 0)) },
});
const quiet = console.log; console.log = () => {};
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
const p90 = (values: number[]) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * 0.9))]!;
try {
  const owner = await deviceClient(host.url, token);
  const me = (await owner.account()).account.profileTree!;
  const stores = new CollectionProjections();
  const tree = await hostTree(owner, await resolveSnapshot(await snapshotDirectory(folder, new Map(), [], (root, names) => stores.read(root, names))),
    { parent: { tree: me, name: "bench", kind: "person" } });
  const session = await deviceSession(host.url, token);
  const mutate = async (name: string, input: unknown) => {
    const head = host.overstoryd.currentUpdate(tree)!;
    const { version } = await host.beetle!.check(head.root as ObjectHash, "/supplies/mutations.beetle");
    const request: MutationCallRequest = { handle: { tree, path: "/supplies/mutations.beetle", name, version }, mutationID: crypto.randomUUID(), input };
    const started = performance.now();
    const response = await fetch(`${host.url}/.overstory/trees/${tree}/mutate`, {
      method: "POST", headers: { authorization: `Bearer ${session}`, "content-type": "application/json" }, body: JSON.stringify(request),
    });
    const body = await response.json() as any;
    if (response.status !== 200) throw new Error(`${name}: ${response.status} ${JSON.stringify(body)}`);
    return { ms: performance.now() - started, body };
  };
  const create: number[] = [], toggle: number[] = [];
  let list = "";
  for (let i = 0; i < EDITS; i++) {
    const made = await mutate("createList", { name: `Bench ${i}`, visibility: "Public" });
    create.push(made.ms);
    list = JSON.parse(made.body.rows[0].key);
    toggle.push((await mutate("toggleListReaction", { l: list })).ms);
  }
  quiet(JSON.stringify({ label: "beetle-mutation", edits: EDITS,
    createList: { median: Math.round(median(create)), p90: Math.round(p90(create)) },
    toggleListReaction: { median: Math.round(median(toggle)), p90: Math.round(p90(toggle)) } }));
} finally {
  console.log = quiet;
  host.server.stop(true);
  await host.overstoryd[Symbol.asyncDispose]();
  await rm(sandbox, { recursive: true, force: true });
}
