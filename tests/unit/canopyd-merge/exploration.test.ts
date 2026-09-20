import { test, expect } from "bun:test";
import type { SourceOperation } from "@overstory/protocol";
import { Fixture } from "./fixture.ts";
import corpus from "../../fixtures/canopy/merge-source-intent.json";
const replace = (text: string, start: number, end: number, value: string) =>
  Buffer.concat([
    Buffer.from(text).subarray(0, start),
    Buffer.from(value),
    Buffer.from(text).subarray(end),
  ]).toString();
for (const example of corpus.lineageCases)
  test("retained lineage: " + example.name, async () => {
    for (const reverse of [false, true]) {
      const f = new Fixture(),
        base = f.tree({ "note.txt": example.base });
      const wrapper: SourceOperation = {
        key: "wrap",
        kind: "editSource",
        source: f.ref("/note.txt", example.base),
        text: example.text,
        lineage: example.lineage.map((l) => ({
          source: f.ref("/note.txt", example.base, [
            l.sourceStart,
            l.sourceEnd,
          ]),
          range: [l.start, l.end],
        })),
      };
      const peer: SourceOperation = {
        key: "edit",
        kind: "editSource",
        source: f.ref("/note.txt", example.base, [
          example.peer.start,
          example.peer.end,
        ]),
        text: example.peer.text,
      };
      const w = f.request(
          base,
          f.tree({ "note.txt": example.text }),
          [wrapper],
          "wrapper",
        ),
        p = f.request(
          base,
          f.tree({
            "note.txt": replace(
              example.base,
              example.peer.start,
              example.peer.end,
              example.peer.text,
            ),
          }),
          [peer],
          "peer",
        );
      const first = await f.run(reverse ? p : w),
        second = reverse ? w : p;
      second.current = first.result;
      const result = await f.run(second);
      if ("conflict" in example)
        expect(result.decisions.length).toBeGreaterThan(0);
      else {
        expect(result.decisions).toEqual([]);
        expect(f.content(result.result.object, "note.txt")).toBe(
          example.expected,
        );
      }
    }
  });
for (const example of corpus.sourceTransferCases)
  for (const kind of ["moveSource", "copySource"] as const)
    test(`${kind}: ${example.name}`, async () => {
      for (const reverse of [false, true]) {
        const f = new Fixture(),
          base = f.tree({ "note.txt": example.base });
        const source = Buffer.from(example.base)
          .subarray(example.start, example.end)
          .toString();
        let candidate = replace(example.base, example.at, example.at, source);
        if (kind === "moveSource")
          candidate =
            example.at <= example.start
              ? replace(
                  candidate,
                  example.start + Buffer.byteLength(source),
                  example.end + Buffer.byteLength(source),
                  "",
                )
              : replace(candidate, example.start, example.end, "");
        const move: SourceOperation = {
          key: "transfer",
          kind,
          source: f.ref("/note.txt", example.base, [
            example.start,
            example.end,
          ]),
          at: f.ref("/note.txt", example.base, [example.at, example.at]),
          side: example.side as "before" | "after",
        };
        const peer: SourceOperation = {
          key: "edit",
          kind: "editSource",
          source: f.ref("/note.txt", example.base, [
            example.peer.start,
            example.peer.end,
          ]),
          text: example.peer.text,
        };
        const m = f.request(
            base,
            f.tree({ "note.txt": candidate }),
            [move],
            "transfer",
          ),
          p = f.request(
            base,
            f.tree({
              "note.txt": replace(
                example.base,
                example.peer.start,
                example.peer.end,
                example.peer.text,
              ),
            }),
            [peer],
            "peer",
          );
        const first = await f.run(reverse ? p : m),
          second = reverse ? m : p;
        second.current = first.result;
        const result = await f.run(second);
        expect(result.decisions).toEqual([]);
        expect(f.content(result.result.object, "note.txt")).toBe(
          example[kind === "moveSource" ? "move" : "copy"],
        );
      }
    });
