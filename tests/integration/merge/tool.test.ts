import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ObjectStore } from "@arbor/object-store";
import { merge, type MergeRequest } from "@arbor/merge";
import { encodeWireDirectory, hashObject, type TreeSnapshot } from "@arbor/wire";
import { ProjectionProviderHost } from "@arbor/stores";
import { resolveSnapshot, snapshotDirectory } from "@arbor/fs";
import { MergeTool } from "../../../packages/canopy/src/merge-tool.ts";
import { mergeWireTrees } from "../../../packages/merge/src/merge.ts";
import { snapshotAccountConfigV2 } from "../../../packages/merge/src/account-v2.ts";
import { snapshotAccountConfig } from "../../../packages/merge/src/account.ts";
import fixtures from "../../fixtures/canopy/wire-merge.json";

let directory: string, store: ObjectStore, tool: MergeTool;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "arbor-merge-tool-")); store = new ObjectStore(join(directory, "objects")); tool = new MergeTool(directory); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
const encoded = (s: string) => new TextEncoder().encode(s);
function snapshot(source: string, name = "note.md"): TreeSnapshot {
  const bytes = encoded(source), file = hashObject(bytes);
  const rootBytes = encodeWireDirectory({ type: "directory", entries: [{ name, file }] });
  const root = hashObject(rootBytes);
  return { root, objects: new Map([[file, bytes], [root, rootBytes]]) };
}
async function prepare(base: TreeSnapshot, current: TreeSnapshot, incoming: TreeSnapshot, id = "tree-default") {
  await store.store([...base.objects, ...current.objects].map(([hash, bytes]) => ({ hash, bytes })));
  const request: MergeRequest = { kind: "tree", base: { object: base.root }, current: { object: current.root }, incoming: { object: incoming.root }, rules: { id, revision: 1 } };
  return { request, inputs: incoming.objects };
}

test.each(fixtures.markdownCases)("subprocess preserves exact legacy rule output: $name", async fixture => {
  const base = snapshot(fixture.base), current = snapshot(fixture.remote), incoming = snapshot(fixture.candidate);
  const { request, inputs } = await prepare(base, current, incoming);
  const expected = await mergeWireTrees(base.root, incoming.root, current.root, hash => store.load(hash, inputs));
  const result = await tool.evaluate(request, inputs);
  expect(result.response.result.object).toBe(expected.root);
  expect(result.objects).toEqual(expected.objects);
  expect(result.response.decisions.filter(d => d.kind === "conflict" && d.scope === "entry").map(({ path, reason }) => ({ path, reason }))).toEqual(expected.conflicts);
  expect(result.response.evidence.summary).toEqual(expected.summary);
  expect(await readdir(join(directory, "merge-jobs"))).toEqual([]);
  for (const [hash] of result.objects) if (!base.objects.has(hash) && !current.objects.has(hash)) expect(await store.find(hash)).toBeNull();
});

test.each(["plain-text-disjoint", "markdown-prose-disjoint"])("source rule %s receives exact authored operations and object references", async id => {
  const inputs = new Map<string, Uint8Array>();
  const ref = (s: string) => { const bytes = encoded(s), object = hashObject(bytes); inputs.set(object, bytes); return { object }; };
  const base = ref("alpha beta"), current = ref("Alpha beta"), incoming = ref("alpha Beta"), proposal = ref("Alpha Beta");
  const changes = [{ change: "change", operations: [{ key: "edit", kind: "editSource" as const,
    source: { material: { kind: "basis" as const, path: "/note.md", object: base.object }, range: [6, 7] as [number, number] }, text: "B" }] }];
  const request: MergeRequest = { kind: "source", tree: "tree", path: "/note.md", base, current,
    incoming: { ...incoming, contributions: [{ change: "change", operation: "edit" }], changes }, proposal, rules: { id, revision: 1 } };
  const { response } = await tool.evaluate(request, inputs);
  expect(response.decisions[0]).toMatchObject({ kind: "source", outcome: "resolved" });
  const compare = await merge(request, { read: async hash => inputs.get(hash)!, store: async () => {} });
  expect(response).toEqual(compare);
  if (id === "markdown-prose-disjoint") {
    request.proposal = ref("# Alpha Beta");
    expect((await tool.evaluate(request, inputs)).response.decisions[0]).toMatchObject({ outcome: "inapplicable" });
  }
});

test("account configuration v1 and v2 rules run outside Canopy without authorization code", async () => {
  const profile = "tr_aaaaaaaaaaaaaaaaaaaaaaaaaa", admin = "dv_aaaaaaaaaaaaaaaaaaaaaaaaaa", phone = "dv_bbbbbbbbbbbbbbbbbbbbbbbbbb";
  const v2 = { account: { canopy: "https://canopy.example", profile }, trees: {}, devices: {
    [admin]: { id: admin, label: "Mac", administrator: true }, [phone]: { id: phone, label: "Phone", administrator: false },
  } };
  const v1 = { account: { version: 1 as const, community: "https://canopy.example", profile: { tree: profile, handle: "joe" }, admins: [admin] },
    trees: { version: 1 as const, trees: { [profile]: { canonicalPath: "/~joe", access: [] } } }, devices: {
      [admin]: { version: 1 as const, id: admin, label: "Mac", placements: {} }, [phone]: { version: 1 as const, id: phone, label: "Phone", placements: {} },
    } };
  for (const [id, make] of [
    ["account-config-v1", (a: string, b: string) => snapshotAccountConfig({ ...v1, devices: { [admin]: { ...v1.devices[admin]!, label: a }, [phone]: { ...v1.devices[phone]!, label: b } } })],
    ["account-config-v2", (a: string, b: string) => snapshotAccountConfigV2({ ...v2, devices: { [admin]: { ...v2.devices[admin]!, label: a }, [phone]: { ...v2.devices[phone]!, label: b } } })],
  ] as const) {
    const base = make("Mac", "Phone"), current = make("Desktop", "Phone"), incoming = make("Mac", "Mobile");
    const { request, inputs } = await prepare(base, current, incoming, id);
    const { response } = await tool.evaluate(request, inputs);
    expect(response.result.object).toBe(make("Desktop", "Mobile").root);
    expect(response.decisions).toEqual([]);
    expect(response.evidence.summary).toMatchObject({ version: id });
  }
});

async function collection(rows: unknown[]): Promise<TreeSnapshot> {
  const root = await mkdtemp(join(directory, "collection-"));
  const host = new ProjectionProviderHost();
  try {
    await writeFile(join(root, "schema.ts"), 'import { z } from "zod"; export const schema = z.object({ id: z.string(), title: z.string() }); export const primaryKey = ["id"];');
    await writeFile(join(root, "_store.json"), JSON.stringify(rows) + "\n");
    return await resolveSnapshot(await snapshotDirectory(root, new Map(), [], (path, name) => host.collectionFileDescriptor(path, name)));
  } finally { await host[Symbol.asyncDispose](); }
}
test("collection row rules retain exact output and unresolved scope through the process", async () => {
  const base = await collection([{ id: "a", title: "A" }]);
  const current = await collection([{ id: "a", title: "A" }, { id: "b", title: "B" }]);
  for (const rows of [[{ id: "a", title: "changed" }], [{ id: "b", title: "different B" }]]) {
    const incoming = await collection(rows), { request, inputs } = await prepare(base, current, incoming);
    const expected = await mergeWireTrees(base.root, incoming.root, current.root, hash => store.load(hash, inputs));
    const evaluated = await tool.evaluate(request, inputs);
    const actual = await tool.tree(base.root, incoming.root, current.root, inputs);
    expect(actual.root).toBe(expected.root);
    expect(actual.conflicts).toEqual(expected.conflicts);
    expect(actual.unresolvedDirectories ?? []).toEqual(expected.unresolvedDirectories ?? []);
    expect(actual.summary).toEqual(expected.summary);
    expect(evaluated.objects).toEqual(expected.objects);
  }
});

test("concurrent jobs share immutable inputs without publishing either output", async () => {
  const base = snapshot("before\nafter\n"), current = snapshot("before\npeer\nafter\n"), incoming = snapshot("before\nafter\nnew\n");
  const { request, inputs } = await prepare(base, current, incoming);
  const results = await Promise.all(Array.from({ length: 4 }, () => tool.evaluate(request, inputs)));
  expect(new Set(results.map(r => r.response.result.object)).size).toBe(1);
  expect(await store.find(results[0]!.response.result.object)).toBeNull();
  expect(await readdir(join(directory, "merge-jobs"))).toEqual([]);
});

test("bad output, nonzero exit and timeout conservatively retain a whole-root decision", async () => {
  const base = snapshot("base"), current = snapshot("current"), incoming = snapshot("incoming");
  const { request, inputs } = await prepare(base, current, incoming);
  for (const [script, timeoutMs] of [
    ['process.stdout.write("not JSON")', 3000],
    ['process.exit(42)', 3000],
    ['setTimeout(() => {}, 10000)', 50],
    ['console.log(JSON.stringify({ result: {object: "sha256:' + '0'.repeat(64) + '"}, objects: [], decisions: [], evidence: {rule: {id:"tree-default",revision:1}}}))', 3000],
  ] as const) {
    const file = join(directory, "fake.ts"); await writeFile(file, script);
    const broken = new MergeTool(directory, { command: [process.execPath, file], timeoutMs });
    await expect(broken.evaluate(request, inputs)).rejects.toThrow();
    const result = await broken.tree(base.root, incoming.root, current.root, inputs);
    expect(result).toMatchObject({ root: incoming.root, conflicts: [{ path: "/", reason: "node-conflict" }], unresolvedDirectories: ["/"] });
    expect(await readdir(join(directory, "merge-jobs"))).toEqual([]);
  }
});

test("corrupt staged output cannot be accepted or published", async () => {
  const base = snapshot("base"), current = snapshot("current"), incoming = snapshot("incoming");
  const { request, inputs } = await prepare(base, current, incoming);
  const fake = join(directory, "fake.ts");
  await writeFile(fake, `import {mkdir,writeFile} from "node:fs/promises"; import {join} from "node:path";
    const root = process.argv[process.argv.indexOf("--staging")+1];
    await mkdir(join(root,"00"),{recursive:true}); await writeFile(join(root,"00","${"0".repeat(62)}"),"wrong");
    console.log(JSON.stringify({result:{object:"${incoming.root}"},objects:["sha256:${"0".repeat(64)}"],decisions:[],evidence:{rule:{id:"tree-default",revision:1}}}));`);
  await expect(new MergeTool(directory, { command: [process.execPath, fake] }).evaluate(request, inputs)).rejects.toThrow("hash mismatch");
  expect(await store.find("sha256:" + "0".repeat(64))).toBeNull();
});

test("serve mode uses the same messages and survives an invalid request", async () => {
  const base = snapshot("one"), { request, inputs } = await prepare(base, base, base);
  const staging = join(directory, "serve-staging");
  await new ObjectStore(staging).store([...inputs].map(([hash, bytes]) => ({ hash, bytes })));
  const process = Bun.spawn([globalThis.process.execPath, "packages/merge/src/cli.ts", "serve", "--objects", join(directory, "objects"), "--staging", staging], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  process.stdin.write('{}\n' + JSON.stringify(request) + '\n' + JSON.stringify(request) + '\n'); process.stdin.end();
  const output = (await new Response(process.stdout).text()).trim().split("\n").map(s => JSON.parse(s));
  expect(await process.exited).toBe(0);
  expect(output[0].error).toBeDefined();
  expect(output[1].result.object).toBe(base.root);
  expect(output[2]).toEqual(output[1]);
});


test("collection rule process runs outside the checkout with a minimal environment", async () => {
  const base = await collection([{ id: "a", title: "A" }]);
  const current = await collection([{ id: "a", title: "A" }, { id: "b", title: "B" }]);
  const incoming = await collection([{ id: "a", title: "Changed" }]);
  const { request, inputs } = await prepare(base, current, incoming);
  const staging = join(directory, "standalone-staging");
  const staged = new ObjectStore(staging);
  await staged.store([...inputs].map(([hash, bytes]) => ({ hash, bytes })));
  const child = Bun.spawn([process.execPath, new URL("../../../packages/merge/src/cli.ts", import.meta.url).pathname, "evaluate", "--objects", join(directory, "objects"), "--staging", staging], {
    cwd: directory, stdin: "pipe", stdout: "pipe", stderr: "pipe", env: {},
  });
  child.stdin.write(JSON.stringify(request)); child.stdin.end();
  const [out, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(errors).toBe(""); expect(code).toBe(0);
  const expected = await mergeWireTrees(base.root, incoming.root, current.root, hash => store.load(hash, inputs));
  expect(JSON.parse(out).result.object).toBe(expected.root);
});
