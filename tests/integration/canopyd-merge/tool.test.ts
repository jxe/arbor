import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile, stat, utimes } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ObjectStore } from "@overstory/object-store";
import { type MergeRequest } from "@overstory/canopyd-merge";
import { encodeWireDirectory, hashObject, type TreeSnapshot } from "@overstory/protocol";
import { ProjectionProviderHost } from "@overstory/arborsync/state";
import { resolveSnapshot, snapshotDirectory } from "@overstory/fs";
import { MergeTool } from "../../../packages/canopyd/src/merge-tool.ts";
import { mergeWireTrees } from "../../../packages/canopyd-merge/src/merge.ts";
import { snapshotAccountConfigV2 } from "@overstory/protocol";
import fixtures from "../../fixtures/canopy/wire-merge.json";

let directory: string, store: ObjectStore, tool: MergeTool;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "arbor-merge-tool-")); store = new ObjectStore(join(directory, "objects")); tool = new MergeTool(directory); });
afterEach(async () => { await tool[Symbol.asyncDispose](); await rm(directory, { recursive: true, force: true }); });
/** A fake worker answers each request line with `body`. */
const lineWorker = (body: string) => `for await (const _ of console) { ${body} }`;
/** Every job removed its staged objects; only empty worker directories remain. */
async function expectNoStaging() {
  for (const worker of await readdir(join(directory, "merge-workers")).catch(() => [] as string[]))
    expect(await readdir(join(directory, "merge-workers", worker))).toEqual([]);
}
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
  expect(result.response.decisions.filter(d => d.kind === "conflict" && d.scope === "entry").map(({ path, reason }) => ({ path, reason })) as unknown[]).toEqual(expected.conflicts);
  expect(result.response.evidence.summary).toEqual(expected.summary);
  await expectNoStaging();
  for (const [hash] of result.objects) if (!base.objects.has(hash) && !current.objects.has(hash)) expect(await store.find(hash)).toBeNull();
});

test("account configuration is not a merge-tool rule", async () => {
  const profile = "tr_aaaaaaaaaaaaaaaaaaaaaaaaaa", admin = "dv_aaaaaaaaaaaaaaaaaaaaaaaaaa";
  const config = snapshotAccountConfigV2({ account: { canopy: "https://canopy.example", profile }, resources: {}, devices: {
    [admin]: { id: admin, label: "Mac", administrator: true },
  } });
  const { request, inputs } = await prepare(config, config, config, "account-config-v2");
  await expect(tool.evaluate(request, inputs)).rejects.toThrow("Unknown tree rule");
  await expectNoStaging();
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
  await expectNoStaging();
});

test("bad output, nonzero exit and timeout conservatively retain a whole-root decision", async () => {
  const base = snapshot("base"), current = snapshot("current"), incoming = snapshot("incoming");
  const { request, inputs } = await prepare(base, current, incoming);
  for (const [script, timeoutMs] of [
    [lineWorker('process.stdout.write("not JSON\\n")'), 3000],
    ['process.exit(42)', 3000],
    ['setTimeout(() => {}, 10000)', 50],
    [lineWorker('console.log(JSON.stringify({ result: {object: "sha256:' + '0'.repeat(64) + '"}, objects: [], decisions: [], evidence: {rule: {id:"tree-default",revision:1}}}))'), 3000],
  ] as const) {
    const file = join(directory, "fake.ts"); await writeFile(file, script);
    const broken = new MergeTool(directory, { command: [process.execPath, file], timeoutMs });
    await expect(broken.evaluate(request, inputs)).rejects.toThrow();
    const result = await broken.tree(base.root, incoming.root, current.root, inputs);
    expect(result).toMatchObject({ root: incoming.root, conflicts: [{ path: "/", reason: "node-conflict" }], unresolvedDirectories: ["/"] });
    await broken[Symbol.asyncDispose]();
    await expectNoStaging();
  }
});

test("corrupt staged output cannot be accepted or published", async () => {
  const base = snapshot("base"), current = snapshot("current"), incoming = snapshot("incoming");
  const { request, inputs } = await prepare(base, current, incoming);
  const fake = join(directory, "fake.ts");
  await writeFile(fake, `import {mkdir,writeFile} from "node:fs/promises"; import {join} from "node:path";
    const root = process.argv[process.argv.indexOf("--staging")+1];
    ${lineWorker(`await mkdir(join(root,"00"),{recursive:true}); await writeFile(join(root,"00","${"0".repeat(62)}"),"wrong");
    console.log(JSON.stringify({result:{object:"${incoming.root}"},objects:["sha256:${"0".repeat(64)}"],decisions:[],evidence:{rule:{id:"tree-default",revision:1}}}));`)}`);
  await using corrupt = new MergeTool(directory, { command: [process.execPath, fake] });
  await expect(corrupt.evaluate(request, inputs)).rejects.toThrow("hash mismatch");
  expect(await store.find("sha256:" + "0".repeat(64))).toBeNull();
});

test("serve mode uses the same messages and survives an invalid request", async () => {
  const base = snapshot("one"), { request, inputs } = await prepare(base, base, base);
  const staging = join(directory, "serve-staging");
  await new ObjectStore(staging).store([...inputs].map(([hash, bytes]) => ({ hash, bytes })));
  const process = Bun.spawn([globalThis.process.execPath, "packages/canopyd-merge/src/cli.ts", "serve", "--objects", join(directory, "objects"), "--staging", staging], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
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
  const child = Bun.spawn([process.execPath, new URL("../../../packages/canopyd-merge/src/cli.ts", import.meta.url).pathname, "serve", "--objects", join(directory, "objects"), "--staging", staging], {
    cwd: directory, stdin: "pipe", stdout: "pipe", stderr: "pipe", env: {},
  });
  child.stdin.write(JSON.stringify(request) + "\n"); child.stdin.end();
  const [out, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(errors.split("\n").filter(line => line && !line.startsWith('{"timings"'))).toEqual([]); expect(code).toBe(0);
  const expected = await mergeWireTrees(base.root, incoming.root, current.root, hash => store.load(hash, inputs));
  expect(JSON.parse(out).result.object).toBe(expected.root);
});


test("unchanged shared outputs need no staging copies and existing objects are not rewritten", async () => {
  const base = snapshot("unchanged"), { request } = await prepare(base, base, base);
  const staging = join(directory, "empty-staging");
  const child = Bun.spawn([process.execPath, "packages/canopyd-merge/src/cli.ts", "serve",
    "--objects", join(directory, "objects"), "--staging", staging],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  child.stdin.write(JSON.stringify(request) + "\n"); child.stdin.end();
  const out = JSON.parse(await new Response(child.stdout).text());
  expect(await child.exited).toBe(0);
  expect(out.result.object).toBe(base.root);
  expect(await readdir(staging).catch(() => [])).toEqual([]);
  expect((await tool.evaluate(request, base.objects)).response.result.object).toBe(base.root);
  const shard = join(directory, "objects", base.root.slice(7, 9));
  const timestamp = new Date("2020-01-01T00:00:00Z");
  await utimes(shard, timestamp, timestamp);
  await store.store([{ hash: base.root, bytes: base.objects.get(base.root)! }]);
  expect((await stat(shard)).mtimeMs).toBe(timestamp.getTime());
  await writeFile(store.path(base.root), "corrupt");
  await expect(store.store([{ hash: base.root, bytes: base.objects.get(base.root)! }])).rejects.toThrow("hash mismatch");
});


test("batched checkpoints exactly preserve individual states including legacy alternatives", async () => {
  const roots = [snapshot("base"), snapshot("one"), snapshot("two"), snapshot("hidden")];
  await store.store(roots.flatMap(r => [...r.objects].map(([hash,bytes]) => ({hash,bytes}))));
  const steps = [
    {projection:roots[1]!.root,change:"first",decisions:[]},
    {projection:roots[2]!.root,change:"second",decisions:[{
      key:"legacy-choice",path:["note.md"],dependencies:[],selected:0,
      alternatives:[{object:roots[2]!.root,contributions:[{change:"second",operation:null}]},
        {object:roots[3]!.root,contributions:[{change:"hidden",operation:null}]}],
    }]},
  ];
  let current: {object:string;state?:string} = {object:roots[0]!.root};
  const expected: Array<{object:string;state:string}> = [];
  for (const step of steps) {
    const value = await tool.evaluate({kind:"checkpoint",tree:"history-tree",current,...step},new Map());
    await store.store([...value.objects].map(([hash,bytes])=>({hash,bytes})));
    expected.push(value.response.result); current = value.response.result;
  }
  const request = {kind:"checkpoint-batch" as const,tree:"history-tree",current:{object:roots[0]!.root},steps};
  const result = await tool.evaluate(request,new Map());
  expect(result.response.checkpoints).toEqual(expected);
  expect(result.response.result).toEqual(expected.at(-1)!);
  const {parseResponse} = await import("@overstory/merge-protocol");
  expect(() => parseResponse({...result.response,checkpoints:expected.slice(1)},request)).toThrow();
  expect(() => parseResponse({...result.response,checkpoints:[...expected].reverse()},request)).toThrow();
});


test("only explicit checkpoint byte limits request a smaller historical batch",async()=>{
  const {CheckpointBatchLimitError}=await import("@overstory/canopyd-merge");
  const base=snapshot("base");await store.store([...base.objects].map(([hash,bytes])=>({hash,bytes})));
  const fake=join(directory,"batch-limit.ts");
  await writeFile(fake,lineWorker(`console.log(${JSON.stringify(JSON.stringify({error:{code:"checkpoint-batch-too-large",message:"Checkpoint batch exceeds object byte budget"}}))});`));
  const request={kind:"checkpoint-batch" as const,tree:"tree",current:{object:base.root},steps:[{projection:base.root,change:"change",decisions:[]}]};
  await using limited = new MergeTool(directory,{command:[process.execPath,fake]});
  await expect(limited.evaluate(request,new Map())).rejects.toBeInstanceOf(CheckpointBatchLimitError);
  // Any other failure of a checkpoint batch stays an ordinary worker failure.
  await expect(limited.evaluate({...request,kind:"checkpoint" as const,...request.steps[0]!},new Map())).rejects.not.toBeInstanceOf(CheckpointBatchLimitError);
  await expectNoStaging();
});

test("one persistent stdin worker processes concurrent submissions in FIFO order", async () => {
  const {readFile} = await import("node:fs/promises");
  const script = join(directory, "tracked-worker.ts"), log = join(directory, "starts.log");
  const cli = new URL("../../../packages/canopyd-merge/src/cli.ts", import.meta.url).pathname;
  await writeFile(script, `import {appendFile} from "node:fs/promises"; import {run} from ${JSON.stringify(cli)};
    await appendFile(${JSON.stringify(log)}, process.pid + "\\n"); await run();`);
  await using sequential = new MergeTool(directory, {command:[process.execPath,script]});
  const base = snapshot("base"), requests = [];
  for (let i=0;i<6;i++) requests.push(await prepare(base, base, snapshot(`edit-${i}`)));
  const completed: number[] = [];
  const results = await Promise.all(requests.map(({request,inputs},i) => sequential.evaluate(request,inputs).then(result => {completed.push(i);return result;})));
  expect(completed).toEqual([0,1,2,3,4,5]);
  expect(results.map(result => result.response.result.object)).toEqual(requests.map(({request}) => "incoming" in request ? request.incoming.object : ""));
  expect((await readFile(log,"utf8")).trim().split("\n")).toHaveLength(1);
  const workers = await readdir(join(directory,"merge-workers"));
  expect(workers).toHaveLength(1);
  expect(await readdir(join(directory,"merge-workers",workers[0]!))).toEqual([]);
});

test("persistent jobs cannot borrow discarded staging and a failed job releases the queue", async () => {
  await using sequential = new MergeTool(directory,{});
  const base = snapshot("base"), incoming = snapshot("new staged bytes");
  const {request,inputs} = await prepare(base,base,incoming);
  await sequential.evaluate(request, inputs);
  const missing = sequential.evaluate(request,new Map());
  const retry = sequential.evaluate(request,inputs);
  await expect(missing).rejects.toThrow();
  expect((await retry).response.result.object).toBe(incoming.root);
  await expectNoStaging();
});

test.each(["exit", "timeout"])("persistent worker %s is reaped and the queued successor starts a replacement", async mode => {
  const {readFile} = await import("node:fs/promises");
  const script = join(directory,"fail-once.ts"), marker = join(directory,"started.log");
  const cli = new URL("../../../packages/canopyd-merge/src/cli.ts",import.meta.url).pathname;
  await writeFile(script, `import {existsSync,appendFileSync} from "node:fs"; import {run} from ${JSON.stringify(cli)};
    const first = !existsSync(${JSON.stringify(marker)}); appendFileSync(${JSON.stringify(marker)},process.pid+"\\n");
    if (first) { ${mode === "exit" ? "process.exit(42);" : "await new Promise(resolve=>setTimeout(resolve,10_000));"} }
    await run();`);
  await using sequential = new MergeTool(directory,{command:[process.execPath,script],timeoutMs:500});
  const base = snapshot("base"), {request,inputs} = await prepare(base,base,snapshot("edited"));
  const failed = sequential.evaluate(request,inputs), next = sequential.evaluate(request,inputs);
  await expect(failed).rejects.toThrow(mode === "exit" ? "exited" : "timed out");
  expect((await next).response.result.object).toBe(request.kind === "tree" ? request.incoming.object : "");
  expect((await readFile(marker,"utf8")).trim().split("\n")).toHaveLength(2);
  expect(await readdir(join(directory,"merge-workers"))).toHaveLength(1);
});

test("the single-worker queue is bounded and shutdown rejects waiting work", async () => {
  const sequential = new MergeTool(directory,{});
  const base = snapshot("base"), {request,inputs} = await prepare(base,base,snapshot("queued"));
  const pending = Array.from({length:65}, () => sequential.evaluate(request,inputs).then(
    () => "completed", error => String(error.message),
  ));
  await expect(sequential.evaluate(request,inputs)).rejects.toThrow("queue is full");
  await sequential[Symbol.asyncDispose]();
  const results = await Promise.all(pending);
  expect(results[0]).toBe("completed");
  expect(results.slice(1)).toEqual(Array(64).fill("Merge tool is closing"));
  expect(await readdir(join(directory,"merge-workers"))).toEqual([]);
  await expect(sequential.evaluate(request,inputs)).rejects.toThrow("closing");
});


test("host evaluation budgets are bounded by the worker timeout", () => {
  expect(new MergeTool(directory).evaluationMillis).toBe(20_000);
  expect(new MergeTool(directory, {timeoutMs: 100}).evaluationMillis).toBe(100);
  expect(new MergeTool(directory, {evaluationMillis: 12_000}).evaluationMillis).toBe(12_000);
  expect(() => new MergeTool(directory, {evaluationMillis: 30_001})).toThrow("Invalid merge worker limits");
  expect(() => new MergeTool(directory, {timeoutMs: 60_000, evaluationMillis: 40_000})).toThrow("Invalid merge worker limits");
  expect(() => new MergeTool(directory, {evaluationMillis: NaN})).toThrow("Invalid merge worker limits");
});

test("a worker evaluation failure surfaces its own message, not a response-schema complaint",async()=>{
  const {MergeWorkerError}=await import("../../../packages/canopyd/src/merge-tool.ts");
  const base=snapshot("base");await store.store([...base.objects].map(([hash,bytes])=>({hash,bytes})));
  const fake=join(directory,"worker-error.ts");
  const request={kind:"checkpoint" as const,tree:"tree",current:{object:base.root},projection:base.root,change:"change",decisions:[]};
  const fail=async(error:{message:string;code?:string})=>{
    await writeFile(fake,lineWorker(`console.log(${JSON.stringify(JSON.stringify({error}))});`));
    await using failing=new MergeTool(directory,{command:[process.execPath,fake]});
    return await failing.evaluate(request,new Map()).then(()=>null,(error:unknown)=>error as InstanceType<typeof MergeWorkerError>);
  };
  const budget=await fail({message:"Evaluation time budget exceeded",code:"limit"});
  expect(budget).toBeInstanceOf(MergeWorkerError);
  expect(budget!.message).toBe("Evaluation time budget exceeded");
  expect(budget!.retryable).toBe(true);
  // Retrying is decided by the worker's code, never by the wording of its message.
  expect((await fail({message:"Evaluation time budget exceeded"}))!.retryable).toBe(false);
  expect((await fail({message:"Trace does not follow its basis",code:"invalid"}))!.retryable).toBe(false);
});
