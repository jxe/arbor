import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { serveCanopy } from "@arbor/canopy";
import { WireClient } from "@arbor/wire";
import { readAccountConfigGraph, snapshotAccountConfig } from "../packages/canopy/src/account-policy.ts";

// Run the old implementation in its own process and checkout so workspace aliases
// cannot accidentally bind the old server to the new Wire implementation.
const oldWorker = `
import { serveCanopy } from "@arbor/canopy";
import { WireClient } from "@arbor/wire";
import { readAccountConfigGraph, snapshotAccountConfig } from "./packages/canopy/src/account-policy.ts";
const server = await serveCanopy({dataRoot:process.env.ARBOR_CUTOVER_ROOT, hostname:"127.0.0.1",port:0,publicOrigin:"http://127.0.0.1:0",accounts:[{handle:"owner",token:"disposable-cutover-token",communityWriter:true}]});
try {
  const client = new WireClient(server.url,"disposable-cutover-token");
  const account = await client.account();
  const tree = account.account.configuration.id;
  const before = await client.descriptor(tree);
  let request;
  if (process.env.ARBOR_CUTOVER_MODE === "seed") {
    const snapshot = await client.snapshot(tree,before.tree.root);
    const graph = readAccountConfigGraph(snapshot,tree);
    const device = graph.account.admins[0];
    graph.devices[device].label = "Before protocol cutover";
    const candidate = snapshotAccountConfig(graph);
    request={base:before.tree.update,updates:[{candidate:candidate.root,ifMatch:"modelHash",objects:[...candidate.objects].map(([hash,bytes])=>({hash,bytes:Buffer.from(bytes).toString("base64")})),deltas:[]}]};
    await client.submitUpdate(tree,before.tree.update,candidate);
  }
  const current = await client.descriptor(tree);
  const snapshot = await client.snapshot(tree,current.tree.root);
  const integrity = await server.canopy.verifyIntegrity();
  console.log(JSON.stringify({tree,current,history:server.canopy.acceptedUpdates(tree),objects:[...snapshot.objects].map(([hash,bytes])=>({hash,bytes:Buffer.from(bytes).toString("base64")})),request,integrity}));
} finally {server.server.stop(true);await server.canopy[Symbol.asyncDispose]();}
`;

async function run(command: string[], cwd: string, env: Record<string, string> = {}): Promise<string> {
  const child = Bun.spawn(command, { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (exit) throw new Error(`${command[0]} failed (${exit}): ${stderr}`);
  return stdout;
}
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function retained(root: string) {
  const db = new Database(join(root, "canopy.sqlite3"), { readonly: true });
  try { return db.query("SELECT * FROM accepted_updates ORDER BY rowid").all(); }
  finally { db.close(); }
}

async function main() {
  const oldCheckout = resolve(Bun.argv[2] ?? "");
  assert(Bun.argv.length === 3, "Usage: bun tools/protocol-cutover-rehearsal.ts <old-checkout>");
  const oldCommit = (await run(["git", "rev-parse", "HEAD"], oldCheckout)).trim();
  assert(oldCommit === "683bb57c53b0881bb230ca9ed0178b9de76eda8e", "Rehearsal expects the reviewed pre-cutover revision 683bb57");
  assert(!(await run(["git", "status", "--porcelain"], oldCheckout)).trim(), "Old checkout must be clean");
  const scratch = await mkdtemp(join(tmpdir(), "arbor-wire-cutover-"));
  const repo = resolve(import.meta.dir, "..");
  try {
    const original = join(scratch, "old");
    const seed = JSON.parse((await run(["bun", "-e", oldWorker], oldCheckout, { ARBOR_CUTOVER_ROOT: original, ARBOR_CUTOVER_MODE: "seed" })).trim());
    assert(seed.request.updates[0].change === undefined, "Seed must exercise the old protocol");
    const history = retained(original);
    const archive = join(scratch, "before.tar");
    await run(["bun", "migrations/tools/backup-canopy.ts", original, archive], repo);
    const results = [];
    for (let pass = 1; pass <= 2; pass++) {
      const restored = join(scratch, `restored-${pass}`);
      await run(["bun", "migrations/tools/restore-canopy.ts", archive, restored], repo);
      assert(JSON.stringify(retained(restored)) === JSON.stringify(history), "Backup/restore changed accepted history");
      const server = await serveCanopy({ dataRoot: restored, hostname: "127.0.0.1", port: 0, publicOrigin: "http://127.0.0.1:0" });
      let newRoot: string;
      try {
        const client = new WireClient(server.url, "disposable-cutover-token");
        const current = await client.descriptor(seed.tree);
        assert(current.tree.root === seed.current.tree.root && current.tree.update === seed.current.tree.update, "Upgrade changed accepted identity");
        const snapshot = await client.snapshot(seed.tree, current.tree.root);
        assert(seed.objects.every((object: { hash: string; bytes: string }) => Buffer.from(snapshot.objects.get(object.hash)!).toString("base64") === object.bytes), "Upgrade changed bytes");
        assert(JSON.stringify(retained(restored)) === JSON.stringify(history), "Opening new server rewrote history");
        const oldResponse = await fetch(`${server.url}/.arbor/trees/${seed.tree}/updates`, { method: "POST", headers: { authorization: "Bearer disposable-cutover-token", "content-type": "application/json" }, body: JSON.stringify(seed.request) });
        assert(oldResponse.status === 400, "Old request was not rejected");
        assert(JSON.stringify(retained(restored)) === JSON.stringify(history), "Rejected old request changed history");
        const graph = readAccountConfigGraph(snapshot, seed.tree);
        graph.devices[graph.account.admins[0]!]!.label = "After protocol cutover";
        const candidate = snapshotAccountConfig(graph);
        const accepted = await client.submitUpdate(seed.tree, current.tree.update, candidate, { change: "rehearsal-new-change" });
        const replay = await client.submitUpdate(seed.tree, current.tree.update, candidate, { change: "rehearsal-new-change" });
        assert(JSON.stringify(accepted) === JSON.stringify(replay), "New exact replay changed its result");
        const after = retained(restored);
        assert(after.length === history.length + 1 && JSON.stringify(after.slice(0, history.length)) === JSON.stringify(history), "New update failed to append to preserved history");
        await server.canopy.verifyIntegrity();
        newRoot = accepted.update.root;
      } finally { server.server.stop(true); await server.canopy[Symbol.asyncDispose](); }
      // Read compatibility supports coordinated binary rollback, not live mixed writers.
      const rollback = JSON.parse((await run(["bun", "-e", oldWorker], oldCheckout, { ARBOR_CUTOVER_ROOT: restored, ARBOR_CUTOVER_MODE: "read" })).trim());
      assert(rollback.current.tree.root === newRoot, "Old binary cannot read newly accepted snapshot history");
      results.push({ pass, preservedAcceptedRows: history.length, appendedRows: 1, oldRequestsRejected: true, newReplayExact: true, oldBinaryReadsNewHistory: true });
    }
    console.log(JSON.stringify({ oldCommit, archiveSHA256: new Bun.CryptoHasher("sha256").update(await readFile(archive)).digest("hex"), results, productionTouched: false }, null, 2));
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
if (import.meta.main) await main();
