import { test, expect } from "bun:test";
import { mergeIntent } from "../../../packages/merge/src/intent-engine.ts";
import {
  loadIntentState,
  storeIntentState,
} from "../../../packages/merge/src/state-storage.ts";
import { Fixture } from "./fixture.ts";
import { keyOf } from "../../../packages/merge/src/intent-model.ts";

test("exact-basis execution preserves complete state and does not read unrelated history", async () => {
  const readCounts: number[] = [];
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
    const state = await loadIntentState(
      initial.result.state,
      async (hash) => f.objects.get(hash)!,
    );
    const envelope = state.changes["first-change"]!;
    for (let i = 0; i < count; i++) state.changes[`historic-${i}`] = envelope;
    const indexed = storeIntentState(state, (bytes) => f.put(bytes), true);
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
      store: async (values: Array<{ hash: string; bytes: Uint8Array }>) => {
        for (const value of values) f.objects.set(value.hash, value.bytes);
      },
    };
    const fast = await mergeIntent(request, objects);
    expect(fast.outcome).toBe("evaluated");
    readCounts.push(reads);
    expect(readBytes).toBeLessThan(50_000);
    const full = await mergeIntent(request, objects, { incremental: false });
    expect(full.outcome).toBe("evaluated");
    if (fast.outcome !== "evaluated" || full.outcome !== "evaluated")
      throw Error("Evaluation failed");
    expect(fast.result).toEqual(full.result);
    expect(fast.authored).toEqual(full.authored);
    const retained = await loadIntentState(fast.result.state, objects.read);
    expect(Object.keys(retained.changes)).toHaveLength(count + 2);
    expect(retained.effects[keyOf("first-change", "first")]).toBeDefined();
  }
  expect(readCounts[1]! - readCounts[0]!).toBeLessThan(10);
});

test("incremental replacements and deletions match full execution across snapshot barriers", async () => {
  const { checkpointIntent } = await import(
    "../../../packages/merge/src/intent-engine.ts"
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
    store: async (values: Array<{ hash: string; bytes: Uint8Array }>) => {
      for (const value of values) f.objects.set(value.hash, value.bytes);
    },
  };
  for (let i = 0; i < 24; i++) {
    if (i % 6 === 0) {
      text = "snapshot " + text;
      current = (
        await checkpointIntent(
          {
            kind: "checkpoint",
            tree: "tree",
            current,
            projection: f.tree({ "a.md": text }),
            change: `snapshot-${i}`,
            decisions: [],
          },
          objects,
        )
      ).result;
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
    expect(fast.outcome).toBe("evaluated");
    expect(full.outcome).toBe("evaluated");
    if (fast.outcome !== "evaluated" || full.outcome !== "evaluated")
      throw Error("Evaluation failed");
    expect(fast.result).toEqual(full.result);
    current = fast.result;
    text = next;
  }
});

test("authority validation inherits unchanged file projections but checks changed pieces", async () => {
  const { validateIntentState } = await import(
    "../../../packages/merge/src/intent-engine.ts"
  );
  const { StateMapValidationCache } = await import(
    "../../../packages/merge/src/state-map.ts"
  );
  const f = new Fixture();
  const files = Object.fromEntries(
    Array.from({ length: 100 }, (_, i) => [`file-${i}`, `body-${i}`]),
  );
  const root = f.tree(files);
  const initial = await f.run(
    f.request(
      root,
      root,
      [
        {
          kind: "editSource",
          key: "same",
          source: f.ref("/file-0", "body-0"),
          text: "body-0",
        },
      ],
      "start",
    ),
  );
  const state = await loadIntentState(
    initial.result.state,
    async (hash) => f.objects.get(hash)!,
  );
  const readHashes: string[] = [];
  const objects = {
    read: async (hash: string) => {
      readHashes.push(hash);
      return f.objects.get(hash)!;
    },
    store: async () => {},
  };
  const previous = new Map(),
    historyCache = new StateMapValidationCache();
  await validateIntentState(initial.result, "tree", objects, {
    historyCache,
    retained: () => {},
    material: { next: previous },
  });
  readHashes.length = 0;
  await validateIntentState(initial.result, "tree", objects, {
    historyCache,
    retained: () => {},
    material: { previous, next: new Map() },
  });
  expect(
    Object.values(files).every((text) => !readHashes.includes(f.put(text))),
  ).toBe(true);
  const file = Object.values(state.nodes).find(
    (node) => node.name === "file-0",
  )!;
  file.pieces![0]!.length += 100;
  const malformed = storeIntentState(state, (bytes) => f.put(bytes));
  await expect(
    validateIntentState(
      { ...initial.result, state: malformed },
      "tree",
      objects,
      {
        historyCache,
        retained: () => {},
        material: { previous, next: new Map() },
      },
    ),
  ).rejects.toThrow("Invalid retained piece");
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
    store: async (values: Array<{ hash: string; bytes: Uint8Array }>) => {
      for (const value of values) f.objects.set(value.hash, value.bytes);
    },
  };
  const fast = await mergeIntent(request, objects),
    full = await mergeIntent(request, objects, { incremental: false });
  expect(fast.outcome).toBe("evaluated");
  expect(full.outcome).toBe("evaluated");
  if (fast.outcome !== "evaluated" || full.outcome !== "evaluated")
    throw Error("Evaluation failed");
  expect(fast.result).toEqual(full.result);
  expect(fast.authored).toEqual(full.authored);
  const state = await loadIntentState(fast.result.state, objects.read);
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
    store: async values => { for (const value of values) f.objects.set(value.hash, value.bytes); },
  }, {incremental: false});
  expect(full.outcome).toBe("evaluated");
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
    store: async (values: Array<{hash: string; bytes: Uint8Array}>) => {
      for (const value of values) f.objects.set(value.hash, value.bytes);
    },
  };
  const fast = await mergeIntent(request, objects);
  expect(fast.outcome).toBe("evaluated");
  expect(reads).not.toContain(untouched);
  if (fast.outcome !== "evaluated" || full.outcome !== "evaluated") throw Error("Evaluation failed");
  expect(fast.result).toEqual(full.result);
  expect(fast.authored).toEqual(full.authored);
  const damaged = {...objects, read: async (hash: string) => {
    if (hash === f.put("abc")) return new TextEncoder().encode("corrupt");
    return objects.read(hash);
  }};
  expect((await mergeIntent(request, damaged)).outcome).toBe("invalid");
  expect((await mergeIntent({...request, incoming: {...request.incoming, object: base}}, objects)).outcome).toBe("invalid");
  expect((await mergeIntent({...request, incoming: {...request.incoming, operations: [
    {kind: "editSource", key: "bad", source: f.ref("/a.md", "wrong", [1, 2]), text: "B"},
  ]}}, objects)).outcome).toBe("invalid");
});
