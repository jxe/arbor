import { test, expect } from "bun:test";
import { engineDiagnostics, mergeIntent } from "../../../packages/overstoryd-merge/src/intent-engine.ts";
import { historyMapDiagnostics, resetHistoryMapDiagnostics, retainState } from "../../../packages/overstoryd-merge/src/retained-state.ts";
import { Fixture, refusal } from "./fixture.ts";
import { keyOf } from "../../../packages/overstoryd-merge/src/intent-model.ts";

test("exact-basis execution preserves complete state and does not read unrelated history", async () => {
  const readCounts: number[] = [];
  const historyWork: Array<typeof historyMapDiagnostics> = [];
  for (const count of [100, 10_000]) {
    const f = new Fixture(),
      base = f.tree({ "a.md": "abc\r\n" });
    const initial = await f.run(
      f.request(
        base,
        f.tree({ "a.md": "ABC\r\n" }),
        [
          {
            kind: "editSource",
            key: "first",
            source: f.ref("/a.md", "abc\r\n", [0, 3]),
            text: "ABC",
          },
        ],
        "first-change",
      ),
    );
    const state = structuredClone(f.state(initial.result));
    const envelope = state.changes["first-change"]!;
    const effect = Object.values(state.effects)[0]!, output = Object.values(state.outputs)[0]!, origin = Object.values(state.origins)[0]!;
    for (let i = 0; i < count; i++) {
      state.changes[`historic-${i}`] = envelope;
      state.effects[`historic-${i}`] = effect;
      state.outputs[`historic-${i}`] = output;
      state.origins[`historic-${i}`] = origin;
    }
    const indexed = retainState(f.states, state, initial.result.object, true).id;
    const request = f.request(
      { object: initial.result.object, state: indexed },
      f.tree({ "a.md": "Aα!C\r\n" }),
      [
        {
          kind: "editSource",
          key: "replace",
          source: f.ref("/a.md", "ABC\r\n", [1, 2]),
          text: "α!",
        },
      ],
      "next-change",
    );
    let reads = 0,
      readBytes = 0;
    const objects = {
      read: async (hash: string) => {
        reads++;
        const bytes = f.objects.get(hash)!;
        readBytes += bytes.length;
        return bytes;
      },
      states: f.states,
      store: async (values: Array<{ hash: string; bytes: Uint8Array }>) => {
        for (const value of values) f.objects.set(value.hash, value.bytes);
      },
    };
    resetHistoryMapDiagnostics();
    const fast = await mergeIntent(request, objects);
    historyWork.push({ ...historyMapDiagnostics });
    readCounts.push(reads);
    expect(readBytes).toBeLessThan(50_000);
    const full = await mergeIntent(request, objects, { incremental: false });
    expect(fast.result).toEqual(full.result);
    expect(fast.authored).toEqual(full.authored);
    const retained = f.state(fast.result);
    expect(Object.keys(retained.changes)).toHaveLength(count + 2);
    expect(retained.effects[keyOf("first-change", "first")]).toBeDefined();
  }
  expect(readCounts[1]! - readCounts[0]!).toBeLessThan(10);
  // Loading, cloning, diffing and recording must not enumerate the unrelated
  // history, even though it remains in the complete retained state.
  expect(historyWork[1]!.enumerated).toBe(0);
  expect(historyWork[1]!.compared).toBeLessThanOrEqual(historyWork[0]!.compared + 4);
  expect(historyWork[1]!.recorded).toBeLessThanOrEqual(historyWork[0]!.recorded + 4);
});

test("incremental replacements and deletions match full execution across snapshot barriers", async () => {
  const { checkpointIntent } = await import(
    "../../../packages/overstoryd-merge/src/intent-engine.ts"
  );
  const f = new Fixture();
  let text = "abcdef\r\n";
  const root = f.tree({ "a.md": text });
  let current = (
    await f.run(
      f.request(
        root,
        root,
        [
          {
            kind: "editSource",
            key: "same",
            source: f.ref("/a.md", text),
            text,
          },
        ],
        "start",
      ),
    )
  ).result;
  const objects = {
    read: async (hash: string) => f.objects.get(hash)!,
    states: f.states,
    store: async (values: Array<{ hash: string; bytes: Uint8Array }>) => {
      for (const value of values) f.objects.set(value.hash, value.bytes);
    },
  };
  for (let i = 0; i < 24; i++) {
    if (i % 6 === 0) {
      text = "snapshot " + text;
      current = await checkpointIntent(
        {
          tree: "tree",
          current,
          projection: f.tree({ "a.md": text }),
          change: `snapshot-${i}`,
          decisions: [],
        },
        objects,
      );
    }
    const range: [number, number] = i % 3 === 0 ? [0, 0] : [0, 1];
    const inserted = i % 3 === 1 ? "" : "XY";
    const next = text.slice(0, range[0]) + inserted + text.slice(range[1]);
    const request = f.request(
      current,
      f.tree({ "a.md": next }),
      [
        {
          kind: "editSource",
          key: "edit",
          source: f.ref("/a.md", text, range),
          text: inserted,
        },
      ],
      `change-${i}`,
    );
    const fast = await mergeIntent(request, objects);
    const full = await mergeIntent(request, objects, { incremental: false });
    expect(fast.result).toEqual(full.result);
    current = fast.result;
    text = next;
  }
});

test("a stored state whose pieces do not project its files is refused", async () => {
  const { mergeIntent } = await import("../../../packages/overstoryd-merge/src/intent-engine.ts");
  const f = new Fixture();
  const root = f.tree({ "file-0": "body-0", "file-1": "body-1" });
  const initial = await f.run(f.request(root, root, [
    { kind: "editSource", key: "same", source: f.ref("/file-0", "body-0"), text: "body-0" },
  ], "start"));
  const state = structuredClone(f.state(initial.result));
  const file = Object.values(state.nodes).find((node) => node.name === "file-0")!;
  file.pieces![0]!.length += 100;
  const malformed = { ...initial.result, state: retainState(f.states, state, initial.result.object, false).id };
  const candidate = f.tree({ "file-0": "body-0", "file-1": "BODY-1" });
  const next = (basis: { object: string; state: string }) => mergeIntent(f.request(basis, candidate, [
    { kind: "editSource", key: "next", source: f.ref("/file-1", "body-1"), text: "BODY-1" },
  ], "next"), {
    read: async (hash) => f.objects.get(hash)!,
    states: f.states,
    store: async () => {},
  }, { eager: true });
  await next(initial.result);
  expect(await refusal(next(malformed))).toBe("invalid");
});

test("worker-local projection reuse and targeted effects match full evaluation for multiple edits", async () => {
  const f = new Fixture();
  const files = Object.fromEntries(
    Array.from({ length: 100 }, (_, i) => [
      `untouched-${i}`,
      `unrelated-${i}\n`.repeat(100),
    ]),
  );
  files["a.md"] = "abcdef";
  files["b.md"] = "uvwxyz";
  const first = await f.run(
    f.request(
      f.tree(files),
      f.tree({ ...files, "a.md": "Abcdef" }),
      [
        {
          kind: "editSource",
          key: "first",
          source: f.ref("/a.md", "abcdef", [0, 1]),
          text: "A",
        },
      ],
      "first",
    ),
  );
  const request = f.request(
    first.result,
    f.tree({ ...files, "a.md": "ABcdEF", "b.md": "uvz" }),
    [
      {
        kind: "editSource",
        key: "one",
        source: f.ref("/a.md", "Abcdef", [1, 2]),
        text: "B",
      },
      {
        kind: "editSource",
        key: "two",
        source: f.ref("/a.md", "Abcdef", [4, 6]),
        text: "EF",
      },
      {
        kind: "editSource",
        key: "three",
        source: f.ref("/b.md", "uvwxyz", [2, 5]),
        text: "",
      },
    ],
    "second",
  );
  const objects = {
    read: async (hash: string) => f.objects.get(hash)!,
    states: f.states,
    store: async (values: Array<{ hash: string; bytes: Uint8Array }>) => {
      for (const value of values) f.objects.set(value.hash, value.bytes);
    },
  };
  const fast = await mergeIntent(request, objects),
    full = await mergeIntent(request, objects, { incremental: false });
  expect(fast.result).toEqual(full.result);
  expect(fast.authored).toEqual(full.authored);
  const state = f.state(fast.result);
  for (const operation of ["one", "two", "three"])
    expect(
      Object.keys(state.effects[keyOf("second", operation)]!.before),
    ).toHaveLength(1);
});

test("host-validated basis skips untouched bodies but still verifies the edit and candidate", async () => {
  const f = new Fixture();
  const unrelated = "untouched content ".repeat(10000);
  const base = f.tree({"a.md": "abc", "other.bin": unrelated});
  const first = await f.run(f.request(base, f.tree({"a.md": "Abc", "other.bin": unrelated}), [
    {kind: "editSource", key: "first", source: f.ref("/a.md", "abc", [0, 1]), text: "A"},
  ], "first"));
  const request = f.request(first.result, f.tree({"a.md": "ABc", "other.bin": unrelated}), [
    {kind: "editSource", key: "second", source: f.ref("/a.md", "Abc", [1, 2]), text: "B"},
  ], "second");
  const full = await mergeIntent(request, {
    read: async hash => f.objects.get(hash)!,
    states: f.states,
    store: async values => { for (const value of values) f.objects.set(value.hash, value.bytes); },
  }, {incremental: false});
  const untouched = f.put(unrelated);
  const reads: string[] = [];
  const objects = {
    read: async (hash: string) => {
      reads.push(hash);
      if (hash === untouched) throw Error("Untouched file must not be read");
      const bytes = f.objects.get(hash);
      if (!bytes) throw Error("missing");
      return bytes;
    },
    states: f.states,
    store: async (values: Array<{hash: string; bytes: Uint8Array}>) => {
      for (const value of values) f.objects.set(value.hash, value.bytes);
    },
  };
  const fast = await mergeIntent(request, objects);
  expect(reads).not.toContain(untouched);
  expect(fast.result).toEqual(full.result);
  expect(fast.authored).toEqual(full.authored);
  // The fast path still reads the edited file. A store verifies what it
  // returns, so a corrupt object is its failure to evaluate, not a refusal.
  const damaged = {...objects, read: async (hash: string) => {
    if (hash === f.put("abc")) throw new Error(`Stored object hash mismatch: ${hash}`);
    return objects.read(hash);
  }};
  await expect(mergeIntent(request, damaged)).rejects.toThrow("hash mismatch");
  expect(await refusal(mergeIntent({...request, incoming: {...request.incoming, object: base}}, objects))).toBe("invalid");
  expect(await refusal(mergeIntent({...request, incoming: {...request.incoming, trace: [{...request.incoming.trace[0]!, operations: [
    {kind: "editSource", key: "bad", source: f.ref("/a.md", "wrong", [1, 2]), text: "B"},
  ]}]}}, objects))).toBe("invalid");
});

test("a multi-frame trace of exact-basis edits takes the fast path", async () => {
  const f = new Fixture(),
    base = f.tree({ "a.md": "abc\r\n", "b.md": "xyz\r\n" });
  // Establish a retained state so the fast path has an exact basis to reuse.
  const initial = await f.run(
    f.request(
      base,
      f.tree({ "a.md": "Abc\r\n", "b.md": "xyz\r\n" }),
      [{ key: "first", kind: "editSource", source: f.ref("/a.md", "abc\r\n", [0, 1]), text: "A" }],
      "first",
    ),
  );
  const start = initial.result.object;
  const middle = f.tree({ "a.md": "ABc\r\n", "b.md": "xyz\r\n" });
  const candidate = f.tree({ "a.md": "ABc\r\n", "b.md": "Xyz\r\n" });
  const framed = f.trace(
    initial.result,
    [
      {
        after: middle,
        operations: [
          { key: "second", kind: "editSource", source: f.ref("/a.md", "Abc\r\n", [1, 2]), text: "B" },
        ],
      },
      {
        after: candidate,
        operations: [
          { key: "third", kind: "editSource", source: f.ref("/b.md", "xyz\r\n", [0, 1]), text: "X" },
        ],
      },
    ],
    "second",
  );
  expect(start).toBe(f.tree({ "a.md": "Abc\r\n", "b.md": "xyz\r\n" }));
  const fast = await f.run(framed);
  expect(engineDiagnostics.path).toBe(1);
  expect(fast.result.object).toBe(candidate);
  const full = await mergeIntent(structuredClone(framed), {
    read: async (hash: string) => {
      const bytes = f.objects.get(hash);
      if (!bytes) throw new Error("missing");
      return bytes;
    },
    states: f.states,
    store: async (values: Array<{ hash: string; bytes: Uint8Array }>) => {
      for (const value of values) f.objects.set(value.hash, value.bytes);
    },
  }, { incremental: false });
  expect(engineDiagnostics.path).toBe(0);
  expect(fast.result).toEqual(full.result);
  expect(fast.authored).toEqual(full.authored);
  expect(fast.decisions).toEqual(full.decisions);
});

test("a multi-frame trace whose frame result is wrong is rejected on the fast path", async () => {
  const f = new Fixture(),
    base = f.tree({ "a.md": "abc\r\n", "b.md": "xyz\r\n" });
  const initial = await f.run(
    f.request(
      base,
      f.tree({ "a.md": "Abc\r\n", "b.md": "xyz\r\n" }),
      [{ key: "first", kind: "editSource", source: f.ref("/a.md", "abc\r\n", [0, 1]), text: "A" }],
      "first",
    ),
  );
  const candidate = f.tree({ "a.md": "ABc\r\n", "b.md": "Xyz\r\n" });
  const wrong = f.trace(
    initial.result,
    [
      {
        // Names the final tree as this frame's result, which its one edit does
        // not reach.
        after: candidate,
        operations: [
          { key: "second", kind: "editSource", source: f.ref("/a.md", "Abc\r\n", [1, 2]), text: "B" },
        ],
      },
      {
        after: candidate,
        operations: [
          { key: "third", kind: "editSource", source: f.ref("/b.md", "xyz\r\n", [0, 1]), text: "X" },
        ],
      },
    ],
    "second",
  );
  expect(await refusal(f.run(wrong))).toBe("invalid");
});
