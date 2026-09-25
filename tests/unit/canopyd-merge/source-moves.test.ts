import { expect, test } from "bun:test";
import { arrangeSources, checkPlainTrace, type SourceOperation } from "@overstory/protocol";
import { engineDiagnostics, mergeIntent } from "../../../packages/canopyd-merge/src/intent-engine.ts";
import type { IntentRequest, IntentResponse } from "../../../packages/canopyd-merge/src/intent-model.ts";
import { Fixture } from "./fixture.ts";

// The byte executor (`arrangeSources`, which canopyd's own fast path runs) and
// the merge engine (which the sidecar replays and merges with) must agree on
// every move frame a client emits: the same bytes, on the engine's exact-basis
// path as on its full and eager paths, and with a peer's edit to the moved
// text following it.

const encoder = new TextEncoder(), decoder = new TextDecoder();
const at = (text: string, needle: string, from = 0): [number, number] => {
  const index = text.indexOf(needle, from);
  if (index < 0) throw Error(`missing ${JSON.stringify(needle)}`);
  const start = encoder.encode(text.slice(0, index)).length;
  return [start, start + encoder.encode(needle).length];
};

interface Shape {
  name: string;
  text: string;
  moves: Array<{ source: string; anchor: string; side: "before" | "after" }>;
  edits?: Array<{ range: [number, number]; text: string }>;
  expected: string;
  /** A word inside moved text a peer replaces concurrently. The Markdown
   * transfer policy (canopyd 014) merges moved prose; a moved list item
   * changes protected list structure, so it becomes a choice that keeps both. */
  peer?: { find: string; replace: string; choice?: true };
}

const list = "Intro\n\n- one\n- two\n  - child\n- three\n\nOutro\n";
const shapes: Shape[] = [
  {
    name: "a block moves down past its sibling",
    text: "A para\n\nB para\n\nC para\n",
    moves: [{ source: "A para\n\n", anchor: "B para\n\n", side: "after" }],
    expected: "B para\n\nA para\n\nC para\n",
    peer: { find: "A para", replace: "A peer" },
  },
  {
    name: "a block moves up to the top",
    text: "A para\n\nB para\n\nC para\n\n",
    moves: [{ source: "C para\n\n", anchor: "A para\n\n", side: "before" }],
    expected: "C para\n\nA para\n\nB para\n\n",
    peer: { find: "C para", replace: "C peer" },
  },
  {
    name: "two blocks land one after another",
    text: "A\n\nB\n\nC\n\nD\n\n",
    moves: [
      { source: "C\n\n", anchor: "A\n\n", side: "before" },
      { source: "D\n\n", anchor: "C\n\n", side: "after" },
    ],
    expected: "C\n\nD\n\nA\n\nB\n\n",
  },
  {
    name: "an item moves under a sibling and is re-indented",
    text: list,
    // "- three\n" becomes a child of "two", after "child".
    moves: [{ source: "- three\n", anchor: "  - child\n", side: "after" }],
    edits: [{ range: [0, 1], text: "  -" }],
    expected: "Intro\n\n- one\n- two\n  - child\n  - three\n\nOutro\n",
    peer: { find: "three", replace: "THREE", choice: true },
  },
  {
    name: "an item is indented in place",
    text: list,
    moves: [],
    edits: [{ range: [0, 1], text: "  -" }],
    expected: "Intro\n\n- one\n  - two\n  - child\n- three\n\nOutro\n",
  },
  {
    name: "multibyte text with CRLF moves intact",
    text: "Café\r\n\r\nnaïve ☕\r\n\r\né\r\n",
    moves: [{ source: "naïve ☕\r\n\r\n", anchor: "Café\r\n\r\n", side: "before" }],
    expected: "naïve ☕\r\n\r\nCafé\r\n\r\né\r\n",
    peer: { find: "naïve", replace: "NAÏVE" },
  },
];

/** Resolve a shape's text anchors, and edits relative to moved or stationary
 * spans, into basis coordinates. Edits in "an item is indented in place" apply
 * to "- two"; in "moves under a sibling" to the moved "- three". */
function resolve(shape: Shape) {
  const moves = shape.moves.map(m => ({ source: at(shape.text, m.source), anchor: at(shape.text, m.anchor), side: m.side }));
  const base = shape.name.includes("in place") ? at(shape.text, "- two")[0] : moves[0]?.source[0] ?? 0;
  const edits = (shape.edits ?? []).map(e => ({ range: [base + e.range[0], base + e.range[1]] as [number, number], text: e.text }));
  return { moves, edits };
}

function operations(f: Fixture, shape: Shape): SourceOperation[] {
  const { moves, edits } = resolve(shape);
  return [
    ...moves.map((m, i): SourceOperation => ({ key: `move-${i}`, kind: "moveSource", source: f.ref("/a.md", shape.text, m.source), at: f.ref("/a.md", shape.text, m.anchor), side: m.side })),
    ...edits.map((e, i): SourceOperation => ({ key: `adjust-${i}`, kind: "editSource", source: f.ref("/a.md", shape.text, e.range), text: e.text })),
  ];
}

async function differential(f: Fixture, request: IntentRequest) {
  const objects = { read: async (hash: string) => f.objects.get(hash)!, states: f.states, store: async (values: Array<{ hash: string; bytes: Uint8Array }>) => { for (const v of values) f.objects.set(v.hash, v.bytes); } };
  const shape = (r: IntentResponse) => r.outcome === "evaluated" ? { result: r.result, decisions: r.decisions, operations: r.evidence.operations } : r;
  const eager = await mergeIntent(request, objects, { incremental: false, eager: true });
  const full = await mergeIntent(request, objects, { incremental: false });
  const fast = await mergeIntent(request, objects);
  expect(shape(full)).toEqual(shape(eager));
  expect(shape(fast)).toEqual(shape(eager));
  if (fast.outcome !== "evaluated") throw Error(JSON.stringify(fast));
  return fast;
}

/** An accepted, editable state holding `text`, as a head edit would leave it. */
async function head(f: Fixture, text: string) {
  const root = f.tree({ "a.md": text });
  return (await f.run(f.request(root, root, [{ key: "start", kind: "editSource", source: f.ref("/a.md", text, [0, 0]), text: "" }], "start"))).result;
}

test.each(shapes)("the byte executor states $name exactly", (shape) => {
  const { moves, edits } = resolve(shape);
  const arranged = arrangeSources(
    new Map([["/a.md", encoder.encode(shape.text)]]),
    moves.map(m => ({ source: { path: "/a.md", range: m.source }, anchor: { path: "/a.md", range: m.anchor }, side: m.side })),
    edits.map(e => ({ path: "/a.md", range: e.range, text: encoder.encode(e.text) })),
  );
  expect(decoder.decode(arranged.get("/a.md"))).toBe(shape.expected);
});

test.each(shapes)("canopyd and the engine's exact-basis path accept $name with the same bytes", async (shape) => {
  const f = new Fixture();
  const basis = await head(f, shape.text);
  const candidate = f.tree({ "a.md": shape.expected });
  const request = f.request(basis, candidate, operations(f, shape), "arranged");
  const plain = await checkPlainTrace(request.incoming.trace!, async hash => f.objects.get(hash)!);
  expect(plain).toMatchObject({ plain: true, touched: ["/a.md"] });
  const result = await differential(f, request);
  expect(engineDiagnostics.path).toBe(1);
  expect(result.result.object).toBe(candidate);
});

for (const shape of shapes.filter(s => s.peer))
  for (const reverse of [false, true])
    test(`a peer edit follows the moved text: ${shape.name}${reverse ? ", peer second" : ""}`, async () => {
      const f = new Fixture();
      const basis = await head(f, shape.text);
      const { find, replace } = shape.peer!;
      const arranged = f.request(basis, f.tree({ "a.md": shape.expected }), operations(f, shape), "arranged");
      const peer = f.request(basis, f.tree({ "a.md": shape.text.replace(find, replace) }), [
        { key: "peer", kind: "editSource", source: f.ref("/a.md", shape.text, at(shape.text, find)), text: replace },
      ], "peer");
      const first = await f.run(reverse ? arranged : peer);
      const second = reverse ? peer : arranged;
      second.current = first.result;
      const result = await differential(f, second);
      if (shape.peer!.choice) {
        // Nothing is lost: each side's contribution is one alternative.
        expect(result.decisions).toHaveLength(1);
        const contributions = result.decisions[0]!.alternatives.flatMap(a => a.contributions.map(c => c.change));
        expect(contributions).toContain(reverse ? "peer" : "arranged");
        return;
      }
      expect(result.decisions).toEqual([]);
      expect(f.content(result.result.object, "a.md")).toBe(shape.expected.replace(find, replace));
    });

test("ambiguous placements are declined for the full evaluator, not guessed", async () => {
  const text = "A\n\nB\n\nC\n\n", files = new Map([["/a.md", encoder.encode(text)]]);
  const span = (needle: string) => ({ path: "/a.md", range: at(text, needle) });
  const cases = [
    // Two moves beside one anchor on one side.
    { moves: [{ source: span("B\n\n"), anchor: span("A\n\n"), side: "before" as const }, { source: span("C\n\n"), anchor: span("A\n\n"), side: "before" as const }], edits: [] },
    // An insertion at the edge of moved material.
    { moves: [{ source: span("C\n\n"), anchor: span("A\n\n"), side: "before" as const }], edits: [{ path: "/a.md", range: [at(text, "C\n\n")[0], at(text, "C\n\n")[0]] as [number, number], text: encoder.encode("x") }] },
    // An edit across a moved span's edge.
    { moves: [{ source: span("C\n\n"), anchor: span("A\n\n"), side: "before" as const }], edits: [{ path: "/a.md", range: [at(text, "B")[0], at(text, "C")[1]] as [number, number], text: encoder.encode("x") }] },
  ];
  for (const { moves, edits } of cases) expect(() => arrangeSources(files, moves, edits)).toThrow();
  expect(() => arrangeSources(files, [{ source: span("A\n\n"), anchor: span("A\n\n"), side: "after" }], [])).toThrow("inside its source");
});
