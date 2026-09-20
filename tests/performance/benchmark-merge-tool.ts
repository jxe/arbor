/** Disposable, repeatable rule workload; never opens Canopy data. */
import { performance } from "node:perf_hooks";
import { Fixture } from "../unit/canopyd-merge/fixture.ts";
const f = new Fixture(),
  source = "one two\n".repeat(8192),
  base = f.tree({ "large.txt": source });
let current: { object: string; state: string } | string = base,
  text = source;
const times: number[] = [];
let stateBytes = 0;
for (let index = 0; index < 32; index++) {
  const position = index * 8,
    next = text.slice(0, position) + "ONE" + text.slice(position + 3);
  const request = f.request(
    current,
    f.tree({ "large.txt": next }),
    [
      {
        key: "edit",
        kind: "editSource",
        source: f.ref("/large.txt", text, [position, position + 3]),
        text: "ONE",
      },
    ],
    `change${index}`,
  );
  const started = performance.now(),
    result = await f.run(request);
  times.push(performance.now() - started);
  current = result.result;
  text = next;
  stateBytes = f.objects.get(result.result.state)!.length;
}
const sorted = times.toSorted((a, b) => a - b);
console.log(
  JSON.stringify(
    {
      evaluations: times.length,
      sourceBytes: Buffer.byteLength(source),
      coldMs: times[0],
      warmMedianMs: sorted[Math.floor(sorted.length / 2)],
      p95Ms: sorted[Math.floor(sorted.length * 0.95)],
      stateBytes,
      immutableObjects: f.objects.size,
      objectBytes: [...f.objects.values()].reduce((n, b) => n + b.length, 0),
      rssBytes: process.memoryUsage().rss,
    },
    null,
    2,
  ),
);

// Parser initialization and repeated policy evaluation are measured separately.
const { evaluateFormat } = await import(
  "../../packages/canopyd-merge/src/format-rules.ts"
);
const encoder = new TextEncoder();
for (const [path, source] of [
  ["sample.ts", "const a = 1;\nconst b = 2;\n"],
  ["sample.swift", "let a = 1\nlet b = 2\n"],
  ["sample.py", "a = 1\nb = 2\n"],
]) {
  const times: number[] = [];
  for (let index = 0; index < 12; index++) {
    const start = performance.now();
    const verdict = await evaluateFormat(
      path!,
      encoder.encode(source!),
      encoder.encode(source!.replace("1", "3")),
      encoder.encode(source!.replace("2", "4")),
      encoder.encode(source!.replace("1", "3").replace("2", "4")),
      [],
      [],
      {},
    );
    if (verdict.outcome !== "resolved")
      throw new Error(JSON.stringify(verdict));
    times.push(performance.now() - start);
  }
  console.log(
    JSON.stringify({
      parser: path,
      coldMs: times[0],
      warmMedianMs: times.slice(1).sort((a, b) => a - b)[5],
      rssBytes: process.memoryUsage().rss,
    }),
  );
}
