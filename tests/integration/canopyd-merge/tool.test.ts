import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile, stat, utimes } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ObjectStore } from "@overstory/object-store";
import { encodeLogEntry, LOG_ENTRY_FORMAT, MergeRefusal, type LogEntry, type MergeQuestion } from "@overstory/merge-protocol";
import { encodeWireDirectory, hashObject, type TreeSnapshot } from "@overstory/protocol";
import { ProjectionProviderHost } from "@overstory/arborsync/state";
import { resolveSnapshot, snapshotDirectory } from "@overstory/fs";
import { MergeTool } from "../../../packages/canopyd/src/merge-tool.ts";
import { mergeWireTrees } from "../../../packages/canopyd-merge/src/merge.ts";
import { snapshotAccountConfig } from "@overstory/protocol";
import fixtures from "../../fixtures/canopy/wire-merge.json";

let directory: string, store: ObjectStore, tool: MergeTool;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "arbor-merge-tool-")); store = new ObjectStore(join(directory, "objects")); tool = new MergeTool(directory); });
afterEach(async () => { await tool[Symbol.asyncDispose](); await rm(directory, { recursive: true, force: true }); });
/** A fake worker answers each question line with `body`. */
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
/** Store a log entry as canopyd would, before any question names it. */
async function entry(value: Omit<LogEntry, "format" | "tree" | "trace" | "resolves" | "decisions">): Promise<string> {
  const bytes = encodeLogEntry({ format: LOG_ENTRY_FORMAT, tree: "tr_test", trace: null, resolves: [], decisions: [], ...value });
  const hash = hashObject(bytes);
  await store.store([{ hash, bytes }]);
  return hash;
}
/** A tree whose history is `base` then `current`, and a snapshot of `incoming` authored on `base`. */
async function prepare(base: TreeSnapshot, current: TreeSnapshot, incoming: TreeSnapshot, id = "tree-default") {
  await store.store([...base.objects, ...current.objects].map(([hash, bytes]) => ({ hash, bytes })));
  const first = await entry({ previous: null, root: base.root, change: "base" });
  const head = current.root === base.root ? first : await entry({ previous: first, root: current.root, change: "current" });
  const question: MergeQuestion = {
    base: first, head,
    candidate: { root: incoming.root, change: "incoming", trace: null, resolves: [] },
    rules: { id, revision: 1 },
  };
  return { question, inputs: incoming.objects };
}

test.each(fixtures.markdownCases)("a snapshot question keeps the tree merge's output: $name", async fixture => {
  const base = snapshot(fixture.base), current = snapshot(fixture.remote), incoming = snapshot(fixture.candidate);
  const { question, inputs } = await prepare(base, current, incoming);
  const expected = await mergeWireTrees(base.root, incoming.root, current.root, hash => store.load(hash, inputs));
  const { answer, objects } = await tool.ask(question, inputs);
  if (expected.conflicts.length) {
    // A conflict shows the current material and keeps the candidate as a choice.
    expect(answer.root).toBe(current.root);
    expect(answer.decisions.map((d) => d.path)).toEqual([["note.md"]]);
  } else {
    expect(answer.root).toBe(incoming.root === base.root ? current.root : expected.root);
    expect(answer.decisions).toEqual([]);
    for (const [hash, bytes] of expected.objects) if (answer.objects.includes(hash)) expect(objects.get(hash)).toEqual(bytes);
    if (expected.summary) expect((answer.evidence as { summary?: unknown }).summary).toEqual(expected.summary);
  }
  await expectNoStaging();
  for (const hash of answer.objects) expect(await store.find(hash)).toBeNull();
});

test("unknown rules are a typed refusal", async () => {
  const profile = "tr_aaaaaaaaaaaaaaaaaaaaaaaaaa", admin = "dv_aaaaaaaaaaaaaaaaaaaaaaaaaa";
  const config = snapshotAccountConfig({ account: { canopy: "https://canopy.example", profile }, resources: {}, devices: {
    [admin]: { id: admin, label: "Mac", administrator: true },
  } });
  const { question, inputs } = await prepare(config, config, config, "account-config-v2");
  const refusal = await tool.ask(question, inputs).then(() => null, (error: unknown) => error);
  expect(refusal).toBeInstanceOf(MergeRefusal);
  expect((refusal as MergeRefusal).code).toBe("unsupported");
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
test("collection row rules merge through the process, and a row conflict is a choice", async () => {
  const base = await collection([{ id: "a", title: "A" }]);
  const current = await collection([{ id: "a", title: "A" }, { id: "b", title: "B" }]);
  for (const rows of [[{ id: "a", title: "changed" }], [{ id: "b", title: "different B" }]]) {
    const incoming = await collection(rows), { question, inputs } = await prepare(base, current, incoming);
    const expected = await mergeWireTrees(base.root, incoming.root, current.root, hash => store.load(hash, inputs));
    const { answer } = await tool.ask(question, inputs);
    if (!expected.conflicts.length && !expected.unresolvedDirectories?.length) {
      expect(answer.root).toBe(expected.root);
      expect(answer.decisions).toEqual([]);
    } else expect(answer.decisions.length).toBeGreaterThan(0);
  }
});

test("concurrent jobs share immutable inputs without publishing either output", async () => {
  const base = snapshot("before\nafter\n"), current = snapshot("before\npeer\nafter\n"), incoming = snapshot("before\nafter\nnew\n");
  const { question, inputs } = await prepare(base, current, incoming);
  const results = await Promise.all(Array.from({ length: 4 }, () => tool.ask(question, inputs)));
  expect(new Set(results.map(r => r.answer.root)).size).toBe(1);
  expect(await store.find(results[0]!.answer.root)).toBeNull();
  await expectNoStaging();
});

test("bad output, nonzero exit and timeout accept nothing, retryably when the sidecar is unavailable", async () => {
  const base = snapshot("base"), current = snapshot("current"), incoming = snapshot("incoming");
  const { question, inputs } = await prepare(base, current, incoming);
  const { MergeWorkerError } = await import("../../../packages/canopyd/src/merge-tool.ts");
  for (const [script, timeoutMs, retryable] of [
    [lineWorker('process.stdout.write("not JSON\\n")'), 3000, false],
    ['process.exit(42)', 3000, true],
    ['setTimeout(() => {}, 10000)', 50, true],
    [lineWorker('console.log(JSON.stringify({ root: "sha256:' + '0'.repeat(64) + '", objects: [], decisions: [], evidence: null }))'), 3000, false],
  ] as const) {
    const file = join(directory, "fake.ts"); await writeFile(file, script);
    const broken = new MergeTool(directory, { command: [process.execPath, file], timeoutMs });
    const failure = await broken.ask(question, inputs).then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure instanceof MergeWorkerError && failure.retryable).toBe(retryable);
    await broken[Symbol.asyncDispose]();
    await expectNoStaging();
  }
});

test("a failed tree merge inside the sidecar keeps the current tree behind a whole-root choice", async () => {
  const base = snapshot("base"), current = snapshot("current"), incoming = snapshot("incoming");
  const { question, inputs } = await prepare(base, current, incoming);
  const cli = new URL("../../../packages/canopyd-merge/src/cli.ts", import.meta.url).pathname;
  const script = join(directory, "failing-merge.ts");
  await writeFile(script, `import {run} from ${JSON.stringify(cli)};
    await run(process.argv.slice(2), { treeMerge: async () => { throw new Error("injected merge failure"); } });`);
  await using failing = new MergeTool(directory, { command: [process.execPath, script] });
  const { answer } = await failing.ask(question, inputs);
  expect(answer.root).toBe(current.root);
  expect(answer.decisions).toHaveLength(1);
  expect(answer.decisions[0]!.path).toBeUndefined();
  expect(answer.decisions[0]!.alternatives.map((a) => a.object)).toEqual([current.root, incoming.root]);
});

test("corrupt staged output cannot be accepted or published", async () => {
  const base = snapshot("base"), current = snapshot("current"), incoming = snapshot("incoming");
  const { question, inputs } = await prepare(base, current, incoming);
  const fake = join(directory, "fake.ts");
  await writeFile(fake, `import {mkdir,writeFile} from "node:fs/promises"; import {join} from "node:path";
    const root = process.argv[process.argv.indexOf("--staging")+1];
    ${lineWorker(`await mkdir(join(root,"00"),{recursive:true}); await writeFile(join(root,"00","${"0".repeat(62)}"),"wrong");
    console.log(JSON.stringify({root:"${incoming.root}",objects:["sha256:${"0".repeat(64)}"],decisions:[],evidence:null}));`)}`);
  await using corrupt = new MergeTool(directory, { command: [process.execPath, fake] });
  await expect(corrupt.ask(question, inputs)).rejects.toThrow("hash mismatch");
  expect(await store.find("sha256:" + "0".repeat(64))).toBeNull();
});

test("serve mode answers in order and survives an invalid question", async () => {
  const base = snapshot("one"), { question, inputs } = await prepare(base, base, snapshot("two"));
  const staging = join(directory, "serve-staging");
  await new ObjectStore(staging).store([...inputs].map(([hash, bytes]) => ({ hash, bytes })));
  const child = Bun.spawn([process.execPath, "packages/canopyd-merge/src/cli.ts", "serve", "--objects", join(directory, "objects"), "--staging", staging], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  child.stdin.write('{}\n' + JSON.stringify(question) + '\n' + JSON.stringify(question) + '\n'); child.stdin.end();
  const output = (await new Response(child.stdout).text()).trim().split("\n").map(s => JSON.parse(s));
  expect(await child.exited).toBe(0);
  expect(output[0].error).toBeDefined();
  expect(output[1].root).toBe(question.candidate.root);
  expect(output[2]).toEqual(output[1]);
});

test("collection rule process runs outside the checkout with a minimal environment", async () => {
  const base = await collection([{ id: "a", title: "A" }]);
  const current = await collection([{ id: "a", title: "A" }, { id: "b", title: "B" }]);
  const incoming = await collection([{ id: "a", title: "Changed" }]);
  const { question, inputs } = await prepare(base, current, incoming);
  const staging = join(directory, "standalone-staging");
  await new ObjectStore(staging).store([...inputs].map(([hash, bytes]) => ({ hash, bytes })));
  const child = Bun.spawn([process.execPath, new URL("../../../packages/canopyd-merge/src/cli.ts", import.meta.url).pathname, "serve", "--objects", join(directory, "objects"), "--staging", staging], {
    cwd: directory, stdin: "pipe", stdout: "pipe", stderr: "pipe", env: {},
  });
  child.stdin.write(JSON.stringify(question) + "\n"); child.stdin.end();
  const [out, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(errors.split("\n").filter(line => line && !line.startsWith('{"timings"'))).toEqual([]); expect(code).toBe(0);
  const expected = await mergeWireTrees(base.root, incoming.root, current.root, hash => store.load(hash, inputs));
  expect(JSON.parse(out).root).toBe(expected.root);
});

test("unchanged shared outputs need no staging copies and existing objects are not rewritten", async () => {
  const base = snapshot("unchanged"), { question } = await prepare(base, base, base);
  const staging = join(directory, "empty-staging");
  const child = Bun.spawn([process.execPath, "packages/canopyd-merge/src/cli.ts", "serve",
    "--objects", join(directory, "objects"), "--staging", staging],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  child.stdin.write(JSON.stringify(question) + "\n"); child.stdin.end();
  const out = JSON.parse(await new Response(child.stdout).text());
  expect(await child.exited).toBe(0);
  expect(out.root).toBe(base.root);
  expect(out.objects).toEqual([]);
  expect(await readdir(staging).catch(() => [])).toEqual([]);
  expect((await tool.ask(question, base.objects)).answer.root).toBe(base.root);
  const shard = join(directory, "objects", base.root.slice(7, 9));
  const timestamp = new Date("2020-01-01T00:00:00Z");
  await utimes(shard, timestamp, timestamp);
  await store.store([{ hash: base.root, bytes: base.objects.get(base.root)! }]);
  expect((await stat(shard)).mtimeMs).toBe(timestamp.getTime());
  await writeFile(store.path(base.root), "corrupt");
  // Bytes this process made durable are not read again; a store that has not
  // verified them (another process) checks them before trusting them.
  await expect(new ObjectStore(join(directory, "objects")).store([{ hash: base.root, bytes: base.objects.get(base.root)! }])).rejects.toThrow("hash mismatch");
});

test("one persistent stdin worker processes concurrent submissions in FIFO order", async () => {
  const {readFile} = await import("node:fs/promises");
  const script = join(directory, "tracked-worker.ts"), log = join(directory, "starts.log");
  const cli = new URL("../../../packages/canopyd-merge/src/cli.ts", import.meta.url).pathname;
  await writeFile(script, `import {appendFile} from "node:fs/promises"; import {run} from ${JSON.stringify(cli)};
    await appendFile(${JSON.stringify(log)}, process.pid + "\\n"); await run();`);
  await using sequential = new MergeTool(directory, {command:[process.execPath,script]});
  const base = snapshot("base"), questions = [];
  for (let i=0;i<6;i++) questions.push(await prepare(base, base, snapshot(`edit-${i}`)));
  const completed: number[] = [];
  const results = await Promise.all(questions.map(({question,inputs},i) => sequential.ask(question,inputs).then(result => {completed.push(i);return result;})));
  expect(completed).toEqual([0,1,2,3,4,5]);
  expect(results.map(result => result.answer.root)).toEqual(questions.map(({question}) => question.candidate.root));
  expect((await readFile(log,"utf8")).trim().split("\n")).toHaveLength(1);
  const workers = await readdir(join(directory,"merge-workers"));
  expect(workers).toHaveLength(1);
  expect(await readdir(join(directory,"merge-workers",workers[0]!))).toEqual([]);
});

test("persistent jobs cannot borrow discarded staging and a failed job releases the queue", async () => {
  await using sequential = new MergeTool(directory,{});
  const base = snapshot("base"), incoming = snapshot("new staged bytes");
  const {question,inputs} = await prepare(base,base,incoming);
  await sequential.ask(question, inputs);
  const missing = sequential.ask(question,new Map());
  const retry = sequential.ask(question,inputs);
  await expect(missing).rejects.toThrow();
  expect((await retry).answer.root).toBe(incoming.root);
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
  const base = snapshot("base"), {question,inputs} = await prepare(base,base,snapshot("edited"));
  const failed = sequential.ask(question,inputs), next = sequential.ask(question,inputs);
  await expect(failed).rejects.toThrow(mode === "exit" ? "exited" : "timed out");
  expect((await next).answer.root).toBe(question.candidate.root);
  expect((await readFile(marker,"utf8")).trim().split("\n")).toHaveLength(2);
  expect(await readdir(join(directory,"merge-workers"))).toHaveLength(1);
});

test("the single-worker queue is bounded and shutdown rejects waiting work", async () => {
  const sequential = new MergeTool(directory,{});
  const base = snapshot("base"), {question,inputs} = await prepare(base,base,snapshot("queued"));
  const pending = Array.from({length:65}, () => sequential.ask(question,inputs).then(
    () => "completed", error => String(error.message),
  ));
  await expect(sequential.ask(question,inputs)).rejects.toThrow("queue is full");
  await sequential[Symbol.asyncDispose]();
  const results = await Promise.all(pending);
  expect(results[0]).toBe("completed");
  expect(results.slice(1)).toEqual(Array(64).fill("Merge tool is closing"));
  expect(await readdir(join(directory,"merge-workers"))).toEqual([]);
  await expect(sequential.ask(question,inputs)).rejects.toThrow("closing");
});

test("host evaluation budgets are bounded by the worker timeout", () => {
  expect(new MergeTool(directory).evaluationMillis).toBe(20_000);
  expect(new MergeTool(directory, {timeoutMs: 100}).evaluationMillis).toBe(100);
  expect(new MergeTool(directory, {evaluationMillis: 12_000}).evaluationMillis).toBe(12_000);
  expect(() => new MergeTool(directory, {evaluationMillis: 30_001})).toThrow("Invalid merge worker limits");
  expect(() => new MergeTool(directory, {timeoutMs: 60_000, evaluationMillis: 40_000})).toThrow("Invalid merge worker limits");
  expect(() => new MergeTool(directory, {evaluationMillis: NaN})).toThrow("Invalid merge worker limits");
});

test("a sidecar failure surfaces its own message, and refusals keep their code", async () => {
  const {MergeWorkerError}=await import("../../../packages/canopyd/src/merge-tool.ts");
  const base=snapshot("base"), { question } = await prepare(base, base, base);
  const fake=join(directory,"worker-error.ts");
  const fail=async(line:unknown)=>{
    await writeFile(fake,lineWorker(`console.log(${JSON.stringify(JSON.stringify(line))});`));
    await using failing=new MergeTool(directory,{command:[process.execPath,fake]});
    return await failing.ask(question,new Map()).then(()=>null,(error:unknown)=>error as Error);
  };
  const budget=await fail({error:{message:"Evaluation time budget exceeded",code:"limit"}});
  expect(budget).toBeInstanceOf(MergeWorkerError);
  expect(budget!.message).toBe("Evaluation time budget exceeded");
  expect((budget as InstanceType<typeof MergeWorkerError>).retryable).toBe(true);
  // Retrying is decided by the sidecar's code, never by the wording of its message.
  expect(((await fail({error:{message:"Evaluation time budget exceeded"}})) as InstanceType<typeof MergeWorkerError>).retryable).toBe(false);
  const refusal = await fail({refusal:{code:"invalid",message:"Trace does not follow its basis"}});
  expect(refusal).toBeInstanceOf(MergeRefusal);
  expect((refusal as MergeRefusal).code).toBe("invalid");
});

test("a refusal or an error line keeps the worker and its cache; malformed output retires it", async () => {
  const {readFile} = await import("node:fs/promises");
  const {MergeWorkerError}=await import("../../../packages/canopyd/src/merge-tool.ts");
  const base=snapshot("base"), { question } = await prepare(base, base, base);
  const script=join(directory,"answers.ts"), starts=join(directory,"starts.log");
  const lines=[{refusal:{code:"invalid",message:"Trace does not follow its basis"}},{error:{message:"Evaluation time budget exceeded",code:"limit"}},{refusal:{code:"bogus",message:"?"}}];
  await writeFile(script, `import {appendFileSync} from "node:fs"; appendFileSync(${JSON.stringify(starts)}, process.pid + "\\n");
    const lines = ${JSON.stringify(lines.map((line) => JSON.stringify(line)))}; let next = 0;
    ${lineWorker("console.log(lines[next++ % lines.length]);")}`);
  await using answering=new MergeTool(directory,{command:[process.execPath,script]});
  const ask=()=>answering.ask(question,new Map()).then(()=>null,(error:unknown)=>error as Error);
  expect(await ask()).toBeInstanceOf(MergeRefusal);
  expect(await ask()).toBeInstanceOf(MergeWorkerError);
  expect((await readFile(starts,"utf8")).trim().split("\n")).toHaveLength(1);
  // A refusal with an unknown code is malformed: the worker is replaced.
  expect(await ask()).not.toBeInstanceOf(MergeRefusal);
  expect(await ask()).toBeInstanceOf(MergeRefusal);
  expect((await readFile(starts,"utf8")).trim().split("\n")).toHaveLength(2);
  await expectNoStaging();
});
