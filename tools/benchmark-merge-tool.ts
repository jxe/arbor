/** Disposable, repeatable rule workload; never opens Canopy data. */
import { performance } from "node:perf_hooks";
import { Fixture } from "../tests/unit/merge/fixture.ts";
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
