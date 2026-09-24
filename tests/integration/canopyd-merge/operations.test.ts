import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ObjectStore } from "@overstory/object-store";
import { MergeTool } from "../../../packages/canopyd/src/merge-tool.ts";
import { wireResponse } from "../../../packages/canopyd-merge/src/index.ts";
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
    expect(actual.response).toEqual(wireResponse(expected) as typeof actual.response);
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
    expect(lines).toEqual([wireResponse(expected), wireResponse(expected)]);
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
  missing.incoming.trace[0]!.before = missing.base.object;
  const limited = structuredClone(valid);
  limited.rules.config = { maxBytes: 1 };
  const unsupported = structuredClone(valid);
  (unsupported.incoming.trace[0]!.operations[0] as { kind: string }).kind =
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
        expect(lines).toEqual(batch.map((r) => wireResponse(expected[requests.indexOf(r)]!)));
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("canopyd checks a worker response's shape and objects, not its retained state", async () => {
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
  const reply = wireResponse(await f.run(request)) as Extract<ReturnType<typeof wireResponse>, { outcome: "evaluated" }>;
  const directory = await mkdtemp(join(tmpdir(), "arbor-worker-validation-"));
  try {
    const script = join(directory, "worker.ts");
    await new ObjectStore(join(directory, "objects")).store(
      [...f.objects].map(([hash, bytes]) => ({ hash, bytes }))
    );
    // A fresh process per case: the worker persists across jobs.
    const answer = async (value: unknown) => {
      await Bun.write(script, `for await (const _ of console) console.log(${JSON.stringify(JSON.stringify(value))});`);
      await using tool = new MergeTool(directory, { command: [process.execPath, script] });
      return await tool.evaluate(request, new Map());
    };
    // The worker's own well-formed answer is trusted as it stands.
    expect((await answer({ ...reply, objects: [] })).response.result).toEqual(reply.result);
    // Its engine records never cross the boundary.
    await expect(answer({ ...reply, objects: [], reports: [] })).rejects.toThrow("reports");
    // A generated object the worker never wrote.
    const missing = `sha256:${"0".repeat(64)}`;
    await expect(answer({ ...reply, objects: [missing] })).rejects.toThrow();
    // A result root that exists nowhere.
    await expect(answer({ ...reply, objects: [], result: { ...reply.result, object: missing } })).rejects.toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
