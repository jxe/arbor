import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ObjectStore } from "@overstory/object-store";
import { MergeTool } from "../../../packages/canopyd/src/merge-tool.ts";
import { Fixture } from "../../unit/canopyd-merge/fixture.ts";

test("operation evaluation is identical through library, worker process and Canopy staging validation", async () => {
  const f = new Fixture(),
    base = f.tree({ "a.txt": "one two" });
  const first = await f.run(
    f.request(
      base,
      f.tree({ "a.txt": "ONE two" }),
      [
        {
          key: "op",
          kind: "editSource",
          source: f.ref("/a.txt", "one two", [0, 3]),
          text: "ONE",
        },
      ],
      "first"
    )
  );
  const request = f.request(
    base,
    f.tree({ "a.txt": "1 two" }),
    [
      {
        key: "op",
        kind: "editSource",
        source: f.ref("/a.txt", "one two", [0, 3]),
        text: "1",
      },
    ],
    "second",
    first.result
  );
  const expected = await f.run(request),
    directory = await mkdtemp(join(tmpdir(), "arbor-operation-worker-"));
  try {
    const shared = join(directory, "objects");
    await new ObjectStore(shared).store(
      [...f.objects].map(([hash, bytes]) => ({ hash, bytes }))
    );
    await using tool = new MergeTool(directory);
    const actual = await tool.evaluate(request, f.objects);
    expect(actual.response).toEqual(expected);
    const child = Bun.spawn(
      [
        process.execPath,
        "packages/canopyd-merge/src/cli.ts",
        "serve",
        "--objects",
        shared,
        "--staging",
        join(directory, "serve"),
      ],
      { cwd: process.cwd(), stdin: "pipe", stdout: "pipe", stderr: "pipe" }
    );
    child.stdin.write(JSON.stringify(request) + "\n" + JSON.stringify(request) + "\n");
    child.stdin.end();
    const lines = (await new Response(child.stdout).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(await child.exited).toBe(0);
    expect(lines).toEqual([expected, expected]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("typed evaluation refusals match the library in shared and fresh worker processes", async () => {
  const f = new Fixture(),
    base = f.tree({ "a.txt": "old" });
  const valid = f.request(base, f.tree({ "a.txt": "new" }), [
    {
      key: "edit",
      kind: "editSource",
      source: f.ref("/a.txt", "old"),
      text: "new",
    },
  ]);
  const invalid = structuredClone(valid);
  invalid.incoming.object = base;
  const missing = structuredClone(valid);
  missing.base.object = "sha256:" + "0".repeat(64);
  const limited = structuredClone(valid);
  limited.rules.config = { maxBytes: 1 };
  const unsupported = structuredClone(valid);
  (unsupported.incoming.operations![0] as { kind: string }).kind =
    "futureOperation";
  const requests = [invalid, missing, limited, unsupported, valid];
  const expected = await Promise.all(requests.map((r) => f.evaluate(r)));
  expect(expected.map((r) => r.outcome)).toEqual([
    "invalid",
    "missing-context",
    "limit",
    "unsupported",
    "evaluated",
  ]);
  const directory = await mkdtemp(join(tmpdir(), "arbor-operation-refusals-"));
  try {
    const shared = join(directory, "objects");
    await new ObjectStore(shared).store(
      [...f.objects].map(([hash, bytes]) => ({ hash, bytes }))
    );
    // One process serving every request, then a fresh process per request.
    for (const [index, batch] of [requests, ...requests.map((r) => [r])].entries()) {
      {
        const child = Bun.spawn(
          [
            process.execPath,
            "packages/canopyd-merge/src/cli.ts",
            "serve",
            "--objects",
            shared,
            "--staging",
            join(directory, `staging-${index}`),
          ],
          { cwd: process.cwd(), stdin: "pipe", stdout: "pipe", stderr: "pipe" }
        );
        child.stdin.write(
          batch.map((r) => JSON.stringify(r)).join("\n") + "\n"
        );
        child.stdin.end();
        const lines = (await new Response(child.stdout).text())
          .trim()
          .split("\n")
          .map((s) => JSON.parse(s));
        expect(await child.exited).toBe(0);
        expect(lines).toEqual(batch.map((r) => expected[requests.indexOf(r)]));
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("authority rejects missing inverse material and a forged result projection", async () => {
  const f = new Fixture(),
    base = f.tree({ "a.txt": "old" });
  const request = f.request(base, f.tree({ "a.txt": "new" }), [
    {
      key: "edit",
      kind: "editSource",
      source: f.ref("/a.txt", "old"),
      text: "new",
    },
  ]);
  const response = await f.run(request);
  const directory = await mkdtemp(join(tmpdir(), "arbor-worker-validation-"));
  try {
    const script = join(directory, "worker.ts");
    const reply = { ...response, objects: [] };
    await new ObjectStore(join(directory, "objects")).store(
      [...f.objects].map(([hash, bytes]) => ({ hash, bytes }))
    );
    // All hashes exist, but the claimed root is not the projection of its state.
    await Bun.write(
      script,
      `for await (const _ of console) console.log(${JSON.stringify(
        JSON.stringify({ ...reply, result: { ...reply.result, object: base } })
      )});`
    );
    await using tool = new MergeTool(directory, {
      command: [process.execPath, script],
    });
    await expect(tool.evaluate(request, new Map())).rejects.toThrow(
      "State does not project"
    );
    // New visible bytes are intact; deleting the old bytes breaks retained undo.
    const old = f.put("old").slice(7);
    await rm(join(directory, "objects", old.slice(0, 2), old.slice(2)));
    await Bun.write(
      script,
      `for await (const _ of console) console.log(${JSON.stringify(JSON.stringify(reply))});`
    );
    await expect(tool.evaluate(request, new Map())).rejects.toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("accepted-state proofs share bounded history rather than charging it to every head", async () => {
  const { loadIntentState, storeIntentState } = await import("../../../packages/canopyd-merge/src/state-storage.ts");
  const f = new Fixture(), base = f.tree({"a.txt": "one"});
  const first = await f.run(f.request(base, base, [{kind: "editSource", key: "same", source: f.ref("/a.txt", "one"), text: "one"}], "initial"));
  const state = await loadIntentState(first.result.state, async hash => f.objects.get(hash)!);
  const change = f.put(JSON.stringify({base: {object: base}, incoming: {object: base}}));
  for (let i = 0; i < 2000; i++) state.changes[`history-${i}`] = change;
  const ref = {object: base, state: storeIntentState(state, bytes => f.put(bytes))};
  const directory = await mkdtemp(join(tmpdir(), "arbor-proof-ownership-"));
  try {
    const objects = new ObjectStore(join(directory, "objects"));
    await objects.store([...f.objects].map(([hash, bytes]) => ({hash, bytes})));
    // Large history has a separate, shared budget. The per-head budget only
    // owns active state, material validation, and references into that history.
    await using tool = new MergeTool(directory, {objects, stateProofBytes: 16_384, historyCacheBytes: 2_000_000});
    await tool.warm("tree", ref);
    expect(tool.validatedState("tree", ref)?.changes["history-1999"]).toBe(change);
    const reads = objects.readCounters.reads;
    await tool.warm("tree", ref);
    expect(objects.readCounters.reads).toBe(reads);
  } finally { await rm(directory, {recursive: true, force: true}); }
});
