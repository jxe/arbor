import { expect, test } from "bun:test";
import { encodeLogEntry, LOG_ENTRY_FORMAT, type LogEntry } from "@overstory/merge-protocol";
import { mergeIntent } from "../../../packages/canopyd-merge/src/intent-engine.ts";
import { EvaluationFailure } from "../../../packages/canopyd-merge/src/engine-contract.ts";
import { Sidecar } from "../../../packages/canopyd-merge/src/sidecar.ts";
import { Fixture, singleStep } from "./fixture.ts";

/** A refusal is a property of the question; a failure to evaluate is not. */

function edit(f: Fixture) {
  const base = f.tree({ "a.md": "abc" }), candidate = f.tree({ "a.md": "Abc" });
  const request = f.request(base, candidate, [
    { kind: "editSource", key: "first", source: f.ref("/a.md", "abc", [0, 1]), text: "A" },
  ]);
  return { base, candidate, request };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("an absent object is missing context; any other store failure propagates", async () => {
  const f = new Fixture(), { base, request } = edit(f);
  const store = (fail: (hash: string) => Error | undefined) => ({
    read: async (hash: string) => {
      const error = fail(hash);
      if (error) throw error;
      return f.objects.get(hash)!;
    },
    store: async () => {},
  });
  const enoent = Object.assign(new Error("no such file"), { code: "ENOENT" });
  expect((await mergeIntent(request, store((hash) => hash === base ? enoent : undefined))).outcome).toBe("missing-context");
  const io = Object.assign(new Error("input/output error"), { code: "EIO" });
  const failed = mergeIntent(request, store((hash) => hash === base ? io : undefined));
  await expect(failed).rejects.toBeInstanceOf(EvaluationFailure);
  await expect(failed).rejects.toThrow("input/output error");
});

test("a malformed request or candidate is still an invalid request", async () => {
  const f = new Fixture(), { request } = edit(f);
  const notATree = f.put("not a directory");
  expect((await f.evaluate({ ...request, incoming: { ...request.incoming, object: notATree,
    trace: [{ ...request.incoming.trace[0]!, after: notATree }] } })).outcome).toBe("invalid");
  expect((await f.evaluate({ ...request, base: { object: "not a hash" } } as never)).outcome).toBe("invalid");
});

test("an engine bug is not reported as an invalid request", async () => {
  const f = new Fixture(), { request } = edit(f);
  const broken = mergeIntent(request, {
    read: async (hash) => f.objects.get(hash)!,
    store: async () => { throw new TypeError("store bug"); },
  });
  await expect(broken).rejects.toThrow("store bug");
});

test("running out of evaluation time is a failure with the limit code, not a refusal", async () => {
  const f = new Fixture(), { request } = edit(f);
  request.rules.config = { maxMillis: 1 };
  const slow = mergeIntent(request, {
    read: async (hash) => { await sleep(5); return f.objects.get(hash)!; },
    store: async () => {},
  });
  const error = await slow.then(() => undefined, (error: unknown) => error);
  expect(error).toBeInstanceOf(EvaluationFailure);
  expect((error as EvaluationFailure).code).toBe("limit");
  expect((error as Error).message).toBe("Evaluation time budget exceeded");
  // A deterministic budget remains a refusal.
  request.rules.config = { maxBytes: 1 };
  expect((await f.evaluate(request)).outcome).toBe("limit");
});

/** A sidecar over the fixture's objects; `delay` slows every shared read. */
function sidecar(f: Fixture, delay = 0) {
  return new Sidecar({
    shared: {
      find: async (hash) => { if (delay) await sleep(delay); return f.objects.get(hash) ?? null; },
      has: async (hash) => f.objects.has(hash),
    },
    staging: { find: async () => null, stage: async () => {} },
  });
}
function entries(f: Fixture, second: Partial<LogEntry>) {
  const { base, candidate, request } = edit(f);
  const entry = (value: Partial<LogEntry>) => f.put(encodeLogEntry({
    format: LOG_ENTRY_FORMAT, tree: "tr_test", previous: null, root: base, change: "base",
    trace: null, resolves: [], decisions: [], ...value,
  }));
  const first = entry({});
  const head = entry({ previous: first, root: candidate, change: "first", trace: request.incoming.trace, ...second });
  return { head, candidate, question: {
    base: head, head, candidate: { root: candidate, change: "next", trace: null, resolves: [] },
    rules: { id: "tree-default", revision: 1 },
  } };
}

test("replay aligns to an entry whose question is refused", async () => {
  const f = new Fixture();
  // The recorded trace names bytes its basis does not have: an invalid question.
  const { base } = edit(f);
  const { question, candidate } = entries(f, {
    trace: singleStep(base, f.tree({ "a.md": "Abc" }), [
      { kind: "editSource", key: "first", source: f.ref("/a.md", "xyz", [0, 1]), text: "A" },
    ]),
  });
  const answer = await sidecar(f).answer(question);
  expect(answer.root).toBe(candidate);
  expect(answer.decisions).toEqual([]);
});

test("replay does not align past a failure to evaluate", async () => {
  const f = new Fixture();
  // Asked under a 1 ms budget, on a store too slow to meet it.
  const { question } = entries(f, { asked: { rules: { id: "tree-default", revision: 1, config: { maxMillis: 1 } } } });
  const failed = sidecar(f, 5).answer(question);
  await expect(failed).rejects.toBeInstanceOf(EvaluationFailure);
  await expect(failed).rejects.toThrow("Evaluation time budget exceeded");
});
