import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ObjectStore } from "@arbor/object-store";
import { MergeTool } from "../../../packages/canopy/src/merge-tool.ts";
import { Fixture } from "../../unit/merge/fixture.ts";

test("operation evaluation is identical through library, fresh worker, persistent worker and Canopy staging validation", async () => {
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
    const tool = new MergeTool(directory),
      actual = await tool.evaluate(request, f.objects);
    expect(actual.response).toEqual(expected);
    for (const mode of ["evaluate", "serve"]) {
      const child = Bun.spawn(
        [
          process.execPath,
          "packages/merge/src/cli.ts",
          mode,
          "--objects",
          shared,
          "--staging",
          join(directory, mode),
        ],
        { cwd: process.cwd(), stdin: "pipe", stdout: "pipe", stderr: "pipe" }
      );
      child.stdin.write(
        JSON.stringify(request) +
          "\n" +
          (mode === "serve" ? JSON.stringify(request) + "\n" : "")
      );
      child.stdin.end();
      const lines = (await new Response(child.stdout).text())
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(await child.exited).toBe(0);
      expect(lines).toEqual(
        mode === "serve" ? [expected, expected] : [expected]
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("typed evaluation refusals match library and executable modes", async () => {
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
  (unsupported.incoming.operations[0] as { kind: string }).kind =
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
    for (const mode of ["evaluate", "serve"]) {
      for (const batch of mode === "serve"
        ? [requests]
        : requests.map((r) => [r])) {
        const child = Bun.spawn(
          [
            process.execPath,
            "packages/merge/src/cli.ts",
            mode,
            "--objects",
            shared,
            "--staging",
            join(directory, mode),
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
      `console.log(${JSON.stringify(
        JSON.stringify({ ...reply, result: { ...reply.result, object: base } })
      )});`
    );
    const tool = new MergeTool(directory, {
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
      `console.log(${JSON.stringify(JSON.stringify(reply))});`
    );
    await expect(tool.evaluate(request, new Map())).rejects.toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
