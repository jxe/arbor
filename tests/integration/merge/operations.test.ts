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
      "first",
    ),
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
    first.result,
  );
  const expected = await f.run(request),
    directory = await mkdtemp(join(tmpdir(), "arbor-operation-worker-"));
  try {
    const shared = join(directory, "objects");
    await new ObjectStore(shared).store(
      [...f.objects].map(([hash, bytes]) => ({ hash, bytes })),
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
        { cwd: process.cwd(), stdin: "pipe", stdout: "pipe", stderr: "pipe" },
      );
      child.stdin.write(
        JSON.stringify(request) +
          "\n" +
          (mode === "serve" ? JSON.stringify(request) + "\n" : ""),
      );
      child.stdin.end();
      const lines = (await new Response(child.stdout).text())
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(await child.exited).toBe(0);
      expect(lines).toEqual(
        mode === "serve" ? [expected, expected] : [expected],
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
