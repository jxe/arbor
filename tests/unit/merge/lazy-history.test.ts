import { test, expect } from "bun:test";
import type { SourceOperation } from "@arbor/wire";
import {
  checkpointIntent,
  mergeIntent,
} from "../../../packages/merge/src/intent-engine.ts";
import type {
  IntentRequestInput,
  IntentResponse,
} from "../../../packages/merge/src/intent-model.ts";
import { Fixture } from "./fixture.ts";

type State = { object: string; state: string };
type Step = { text: string; result: State };

/** Eager evaluation reads and re-enforces all history; the default path uses
 * only what an edit touches. Every accepted outcome must be identical. */
async function differential(f: Fixture, request: IntentRequestInput) {
  const objects = {
    read: async (hash: string) => f.objects.get(hash)!,
    store: async (values: Array<{ hash: string; bytes: Uint8Array }>) => {
      for (const value of values) f.objects.set(value.hash, value.bytes);
    },
  };
  const eager = await mergeIntent(request, objects, { incremental: false, eager: true });
  const full = await mergeIntent(request, objects, { incremental: false });
  const fast = await mergeIntent(request, objects);
  const shape = (r: IntentResponse) =>
    r.outcome === "evaluated"
      ? {
          outcome: r.outcome,
          result: r.result,
          authored: r.authored,
          decisions: r.decisions,
          operations: r.evidence.operations,
        }
      : r;
  expect(shape(full)).toEqual(shape(eager));
  expect(shape(fast)).toEqual(shape(eager));
  if (eager.outcome !== "evaluated") throw Error(JSON.stringify(eager));
  return eager;
}

const end = (text: string) => text.length - 1;
function edit(f: Fixture, text: string, range: [number, number], inserted: string, key = "edit"): { op: SourceOperation; next: string } {
  return {
    op: { kind: "editSource", key, source: f.ref("/a.md", text, range), text: inserted },
    next: text.slice(0, range[0]) + inserted + text.slice(range[1]),
  };
}

/** Sixty head edits: appends, deletions, moves, copies, lineage edits and two
 * checkpoint barriers. Returns the text and accepted state after every step. */
async function history(f: Fixture, count = 60): Promise<Step[]> {
  let text = "alpha beta gamma delta\n";
  const root = f.tree({ "a.md": text });
  const steps: Step[] = [];
  let current: State = (
    await differential(f, f.request(root, root, [edit(f, text, [0, 0], "").op], "start"))
  ).result;
  for (let i = 1; i <= count; i++) {
    if (i === 20 || i === 40) {
      text = `snapshot${i} ${text}`;
      const objects = {
        read: async (hash: string) => f.objects.get(hash)!,
        store: async (values: Array<{ hash: string; bytes: Uint8Array }>) => {
          for (const value of values) f.objects.set(value.hash, value.bytes);
        },
      };
      const checkpoint = await checkpointIntent(
        { kind: "checkpoint", tree: "tree", current, projection: f.tree({ "a.md": text }), change: `snapshot-${i}`, decisions: [] },
        objects,
      );
      if (!("result" in checkpoint)) throw Error(JSON.stringify(checkpoint));
      current = checkpoint.result;
    }
    let op: SourceOperation, next: string;
    if (i % 10 === 3) ({ op, next } = edit(f, text, [2, 5], ""));
    else if (i % 10 === 6) {
      op = { kind: "moveSource", key: "edit", source: f.ref("/a.md", text, [0, 3]), at: f.ref("/a.md", text, [end(text), end(text)]), side: "after" };
      next = text.slice(3, end(text)) + text.slice(0, 3) + "\n";
    } else if (i % 10 === 8) {
      op = { kind: "copySource", key: "edit", source: f.ref("/a.md", text, [1, 4]), at: f.ref("/a.md", text, [end(text), end(text)]), side: "after" };
      next = text.slice(0, end(text)) + text.slice(1, 4) + "\n";
    } else if (i % 10 === 9) {
      // Wrap preserved bytes: the lineage source lies inside the edited range.
      const kept = text.slice(2, 4);
      op = { kind: "editSource", key: "edit", source: f.ref("/a.md", text, [0, 6]), text: `<${kept}>`, lineage: [{ source: f.ref("/a.md", text, [2, 4]), range: [1, 3] }] };
      next = `<${kept}>` + text.slice(6);
    } else ({ op, next } = edit(f, text, [end(text), end(text)], ` w${i}`));
    current = (await differential(f, f.request(current, f.tree({ "a.md": next }), [op], `step-${i}`))).result;
    text = next;
    steps.push({ text, result: current });
  }
  return steps;
}

test("a head edit on a long history matches eager evaluation", async () => {
  const f = new Fixture();
  const steps = await history(f);
  const head = steps.at(-1)!;
  const { op, next } = edit(f, head.text, [0, 0], "HEAD ");
  await differential(f, f.request(head.result, f.tree({ "a.md": next }), [op], "head"));
});

test("a divergent edit based at step 32 merges into head as eager evaluation does", async () => {
  const f = new Fixture();
  const steps = await history(f);
  const old = steps[31]!, head = steps.at(-1)!;
  const { op, next } = edit(f, old.text, [0, 0], "OLD ");
  await differential(f, f.request(old.result, f.tree({ "a.md": next }), [op], "divergent", head.result));
});

test("moving and copying old text from a divergent basis matches eager evaluation", async () => {
  const f = new Fixture();
  const steps = await history(f);
  const old = steps[49]!, head = steps.at(-1)!;
  for (const kind of ["moveSource", "copySource"] as const) {
    const t = old.text;
    const next = kind === "moveSource"
      ? t.slice(6, end(t)) + t.slice(0, 6) + "\n"
      : t.slice(0, end(t)) + t.slice(0, 6) + "\n";
    await differential(
      f,
      f.request(old.result, f.tree({ "a.md": next }), [
        { kind, key: "edit", source: f.ref("/a.md", t, [0, 6]), at: f.ref("/a.md", t, [end(t), end(t)]), side: "after" },
      ], `old-${kind}`, head.result),
    );
  }
});

test("concurrent inserts at one anchor match eager evaluation", async () => {
  const f = new Fixture();
  const steps = await history(f);
  const old = steps[54]!, head = steps.at(-1)!;
  const { op, next } = edit(f, old.text, [end(old.text), end(old.text)], " concurrent");
  await differential(f, f.request(old.result, f.tree({ "a.md": next }), [op], "concurrent", head.result));
});

test("an edit inside text deleted on the other branch matches eager evaluation", async () => {
  const f = new Fixture();
  const steps = await history(f);
  const basis = steps.at(-1)!;
  // Head deletes [3, 12); the incoming branch, based before that, edits inside it.
  const deleted = edit(f, basis.text, [3, 12], "", "delete");
  const head = await differential(
    f,
    f.request(basis.result, f.tree({ "a.md": deleted.next }), [deleted.op], "delete"),
  );
  const inside = edit(f, basis.text, [6, 8], "INSIDE");
  await differential(
    f,
    f.request(basis.result, f.tree({ "a.md": inside.next }), [inside.op], "inside", head.result),
  );
  // And once more on top: the next head edit must still see that deletion.
  const later = edit(f, deleted.next, [0, 0], "later ");
  await differential(
    f,
    f.request(head.result, f.tree({ "a.md": later.next }), [later.op], "later"),
  );
});

test.each([undefined, "current"] as const)("a live decision is created and resolved as eager evaluation does (projection %s)", async (projection) => {
  const f = new Fixture();
  const request = f.request.bind(f);
  f.request = (...args: Parameters<Fixture["request"]>) => {
    const r = request(...args);
    if (projection) r.rules.config = { ...r.rules.config, conflictProjection: projection };
    return r;
  };
  const steps = await history(f);
  const basis = steps.at(-1)!;
  const one = edit(f, basis.text, [0, 5], "ONE");
  const a = await differential(f, f.request(basis.result, f.tree({ "a.md": one.next }), [one.op], "one"));
  const two = edit(f, basis.text, [0, 5], "TWO");
  const b = await differential(
    f,
    f.request(basis.result, f.tree({ "a.md": two.next }), [two.op], "two", a.result),
  );
  expect(b.decisions.length).toBeGreaterThan(0);
  // An edit elsewhere while the decision is live, then its resolution.
  const text = f.content(b.result.object, "a.md");
  const more = edit(f, text, [end(text), end(text)], " more");
  const c = await differential(f, f.request(b.result, f.tree({ "a.md": more.next }), [more.op], "more"));
  const resolve = f.request(c.result, c.result.object, [], "resolve");
  resolve.incoming.resolves = [c.decisions[0]!.key];
  const resolved = await differential(f, resolve);
  expect(resolved.decisions).toEqual([]);
});

test("a divergent merge reads history in proportion to the edit, not its length", async () => {
  const reads: Record<string, number[]> = { eager: [], lazy: [] };
  for (const count of [30, 90]) {
    const f = new Fixture();
    const steps = await history(f, count);
    const old = steps.at(-4)!, head = steps.at(-1)!;
    const { op, next } = edit(f, old.text, [0, 0], "OLD ");
    const request = f.request(old.result, f.tree({ "a.md": next }), [op], "divergent", head.result);
    for (const eager of [true, false]) {
      let bytes = 0;
      const response = await mergeIntent(request, {
        read: async (hash) => {
          const value = f.objects.get(hash)!;
          bytes += value.length;
          return value;
        },
        store: async () => {},
      }, { incremental: false, eager });
      expect(response.outcome).toBe("evaluated");
      reads[eager ? "eager" : "lazy"]!.push(bytes);
    }
  }
  // Measured: eager 162 KB -> 556 KB, lazy 32 KB -> 57 KB. What the lazy path
  // still grows by is the file itself (95 -> 238 bytes, one piece per append),
  // whose piece lists every effect record carries.
  expect(reads.lazy![1]!).toBeLessThan(reads.eager![1]! / 5);
  expect(reads.lazy![1]! / reads.lazy![0]!).toBeLessThan(2.5);
});
