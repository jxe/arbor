import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ObjectStore } from "@overstory/object-store";
import { encodeLogEntry, LOG_ENTRY_FORMAT, MergeRefusal, type LogEntry, type MergeQuestion } from "@overstory/merge-protocol";
import { hashObject } from "@overstory/protocol";
import { MergeTool } from "../../../packages/canopyd/src/merge-tool.ts";
import { Fixture } from "../../unit/canopyd-merge/fixture.ts";
import type { IntentRequestInput } from "../../../packages/canopyd-merge/src/intent-model.ts";

/** Store `value` as a log entry of `tree`; returns its hash. */
async function entry(store: ObjectStore, value: Partial<LogEntry> & Pick<LogEntry, "previous" | "root" | "change">): Promise<string> {
  const bytes = encodeLogEntry({ format: LOG_ENTRY_FORMAT, tree: "tr_test", trace: null, resolves: [], decisions: [], ...value });
  await store.store([{ hash: hashObject(bytes), bytes }]);
  return hashObject(bytes);
}

/** The question an engine request asks, authored on `base` with `head` current. */
function question(request: IntentRequestInput, base: string, head: string): MergeQuestion {
  return {
    base, head,
    candidate: { root: request.incoming.object, change: request.incoming.change, trace: request.incoming.trace, resolves: [] },
    rules: request.rules,
  };
}

async function serve(shared: string, staging: string, lines: unknown[]): Promise<unknown[]> {
  const child = Bun.spawn(
    [process.execPath, "packages/canopyd-merge/src/cli.ts", "serve", "--objects", shared, "--staging", staging],
    { cwd: process.cwd(), stdin: "pipe", stdout: "pipe", stderr: "pipe" }
  );
  child.stdin.write(lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  child.stdin.end();
  const output = (await new Response(child.stdout).text()).trim().split("\n").map((line) => JSON.parse(line));
  expect(await child.exited).toBe(0);
  return output;
}

test("a traced question gives the engine's result through canopyd and a fresh process", async () => {
  const f = new Fixture(),
    base = f.tree({ "a.txt": "one two" });
  const firstRequest = f.request(base, f.tree({ "a.txt": "ONE two" }),
    [{ key: "op", kind: "editSource", source: f.ref("/a.txt", "one two", [0, 3]), text: "ONE" }], "first");
  const first = await f.run(firstRequest);
  const request = f.request(base, f.tree({ "a.txt": "1 two" }),
    [{ key: "op", kind: "editSource", source: f.ref("/a.txt", "one two", [0, 3]), text: "1" }], "second", first.result);
  const expected = await f.run(request);
  const directory = await mkdtemp(join(tmpdir(), "arbor-operation-worker-"));
  try {
    const shared = join(directory, "objects"), store = new ObjectStore(shared);
    await store.store([...f.objects].map(([hash, bytes]) => ({ hash, bytes })));
    const baseEntry = await entry(store, { previous: null, root: base, change: "base" });
    const head = await entry(store, { previous: baseEntry, root: first.result.object, change: "first", trace: firstRequest.incoming.trace });
    const asked = question(request, baseEntry, head);
    await using tool = new MergeTool(directory);
    const { answer } = await tool.ask(asked, f.objects);
    expect(answer.root).toBe(expected.result.object);
    expect(answer.decisions.length).toBe(expected.reports.length);
    const lines = await serve(shared, join(directory, "serve"), [asked, asked]) as Array<{ root: string }>;
    expect(lines[0]!.root).toBe(expected.result.object);
    expect(lines[1]).toEqual(lines[0]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("typed refusals match the engine in shared and fresh processes", async () => {
  const f = new Fixture(),
    base = f.tree({ "a.txt": "old" });
  const valid = f.request(base, f.tree({ "a.txt": "new" }), [
    { key: "edit", kind: "editSource", source: f.ref("/a.txt", "old"), text: "new" },
  ]);
  const invalid = structuredClone(valid);
  invalid.incoming.object = base;
  const limited = structuredClone(valid);
  limited.rules.config = { maxBytes: 1 };
  const unsupported = structuredClone(valid);
  (unsupported.incoming.trace[0]!.operations[0] as { kind: string }).kind = "futureOperation";
  const requests = [invalid, limited, unsupported, valid];
  const expected = await Promise.all(requests.map((r) => f.evaluate(r)));
  expect(expected.map((r) => r.outcome)).toEqual(["invalid", "limit", "unsupported", "evaluated"]);
  const directory = await mkdtemp(join(tmpdir(), "arbor-operation-refusals-"));
  try {
    const shared = join(directory, "objects"), store = new ObjectStore(shared);
    await store.store([...f.objects].map(([hash, bytes]) => ({ hash, bytes })));
    const root = await entry(store, { previous: null, root: base, change: "base" });
    const questions = requests.map((r) => question(r, root, root));
    const wanted = expected.map((r) => r.outcome === "evaluated" ? r.result.object : { refusal: { code: r.outcome, message: r.message } });
    // One process serving every question, then a fresh process per question.
    for (const [index, batch] of [questions, ...questions.map((q) => [q])].entries()) {
      const lines = await serve(shared, join(directory, `staging-${index}`), batch) as Array<{ root?: string }>;
      expect(lines.map((line) => line.root ?? line) as unknown[]).toEqual(batch.map((q) => wanted[questions.indexOf(q)]));
    }
    await using tool = new MergeTool(directory);
    const refusal = await tool.ask(questions[0]!, f.objects).then(() => null, (error: unknown) => error);
    expect(refusal).toBeInstanceOf(MergeRefusal);
    expect((refusal as MergeRefusal).code).toBe("invalid");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("canopyd checks an answer's shape and objects, not the sidecar's reasoning", async () => {
  const f = new Fixture(),
    base = f.tree({ "a.txt": "old" }), next = f.tree({ "a.txt": "new" });
  const request = f.request(base, next, [
    { key: "edit", kind: "editSource", source: f.ref("/a.txt", "old"), text: "new" },
  ]);
  const directory = await mkdtemp(join(tmpdir(), "arbor-worker-validation-"));
  try {
    const script = join(directory, "worker.ts"), store = new ObjectStore(join(directory, "objects"));
    await store.store([...f.objects].map(([hash, bytes]) => ({ hash, bytes })));
    const root = await entry(store, { previous: null, root: base, change: "base" });
    const reply = { root: next, objects: [], decisions: [], evidence: { any: "thing" } };
    // A fresh process per case: the worker persists across jobs.
    const answer = async (value: unknown) => {
      await Bun.write(script, `for await (const _ of console) console.log(${JSON.stringify(JSON.stringify(value))});`);
      await using tool = new MergeTool(directory, { command: [process.execPath, script] });
      return await tool.ask(question(request, root, root), new Map());
    };
    // The sidecar's own well-formed answer is trusted as it stands.
    expect((await answer(reply)).answer).toEqual(reply);
    // Nothing beyond the answer crosses the boundary.
    await expect(answer({ ...reply, reports: [] })).rejects.toThrow("reports");
    // A generated object the sidecar never wrote.
    const missing = `sha256:${"0".repeat(64)}`;
    await expect(answer({ ...reply, objects: [missing] })).rejects.toThrow();
    // A root that exists nowhere, or an alternative root that does not.
    await expect(answer({ ...reply, root: missing })).rejects.toThrow();
    await expect(answer({ ...reply, decisions: [{ key: "k", dependencies: [], selected: 0,
      alternatives: [{ object: next, contributions: [] }, { object: missing, contributions: [] }] }] })).rejects.toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
