import { validateIntentState } from "../../../packages/canopyd-merge/src/intent-engine.ts";
import { loadIntentState } from "../../../packages/canopyd-merge/src/state-storage.ts";
import { expect, test } from "bun:test";
import type { MaterialRef, SourceOperation } from "@overstory/protocol";
import { Fixture } from "./fixture.ts";
import { stableJSONString } from "@overstory/protocol";
import { changeIdentity, parseIntentRequest } from "../../../packages/canopyd-merge/src/intent-model.ts";

test("exact source edits retain CRLF, Unicode and operation-result coordinates", async () => {
  const f = new Fixture(),
    base = f.tree({ "a.md": "α beta\r\n" }),
    candidate = f.tree({ "a.md": "α Beta!\r\n" });
  const r = await f.run(
    f.request(base, candidate, [
      {
        key: "first",
        kind: "editSource",
        source: f.ref("/a.md", "α beta\r\n", [3, 7]),
        text: "Beta",
      },
      {
        key: "second",
        kind: "editSource",
        source: f.op("edit", "first", [4, 4]),
        text: "!",
      },
    ]),
  );
  expect(r.result.object).toBe(candidate);
  expect(r.decisions).toEqual([]);
});
test.each(["moveEntry", "copyEntry"] as const)(
  "%s preserves exact source",
  async (kind) => {
    const f = new Fixture(),
      base = f.tree({ "a.md": "hello" }),
      candidate = f.tree(
        kind === "moveEntry"
          ? { "b.md": "hello" }
          : { "a.md": "hello", "b.md": "hello" },
      );
    expect(
      (
        await f.run(
          f.request(base, candidate, [
            {
              key: "op",
              kind,
              source: f.ref("/a.md", "hello"),
              destination: { parent: f.root(base), name: "b.md" },
            },
          ]),
        )
      ).result.object,
    ).toBe(candidate);
  },
);
test.each(["moveSource", "copySource"] as const)(
  "%s binds the new source result",
  async (kind) => {
    const f = new Fixture(),
      base = f.tree({ "a.txt": "one two" }),
      candidate = f.tree({
        "a.txt": kind === "moveSource" ? " twoONE" : "one twoONE",
      });
    await f.run(
      f.request(base, candidate, [
        {
          key: "first",
          kind,
          source: f.ref("/a.txt", "one two", [0, 3]),
          at: f.ref("/a.txt", "one two", [7, 7]),
          side: "after",
        },
        {
          key: "second",
          kind: "editSource",
          source: f.op("edit", "first"),
          text: "ONE",
        },
      ]),
    );
  },
);
test("remove and replace retain exact material across evaluations", async () => {
  const f = new Fixture(),
    base = f.tree({ a: "old", b: "stay" });
  const replaced = await f.run(
    f.request(
      base,
      f.tree({ a: "new", b: "stay" }),
      [
        {
          key: "replace",
          kind: "replaceEntry",
          source: f.ref("/a", "old"),
          value: { file: f.put("new") },
        },
      ],
      "replace",
    ),
  );
  const removed = await f.run(
    f.request(
      replaced.result,
      f.tree({ a: "new" }),
      [{ key: "remove", kind: "removeEntry", source: f.ref("/b", "stay") }],
      "remove",
    ),
  );
  expect(removed.result.object).toBe(f.tree({ a: "new" }));
  // Undo is no longer an operation: reverting is authored as an ordinary
  // replacement against the current basis.
  const reverted = await f.run(
    f.request(
      removed.result,
      f.tree({ a: "old" }),
      [
        {
          key: "revert",
          kind: "replaceEntry",
          source: f.ref("/a", "new"),
          value: { file: f.put("old") },
        },
      ],
      "revert",
    ),
  );
  expect(reverted.result.object).toBe(f.tree({ a: "old" }));
});
test("invalid boundaries, false lineage, wrong candidate and undo are distinct", async () => {
  const f = new Fixture(),
    base = f.tree({ a: "αbeta" });
  const edit: SourceOperation = {
    key: "op",
    kind: "editSource",
    source: f.ref("/a", "αbeta", [0, 2]),
    text: "x",
  };
  expect(
    (
      await f.evaluate(
        f.request(base, base, [
          { ...edit, source: f.ref("/a", "αbeta", [0, 1]) },
        ]),
      )
    ).outcome,
  ).toBe("invalid");
  expect((await f.evaluate(f.request(base, base, [edit]))).outcome).toBe(
    "invalid",
  );
  expect(
    (
      await f.evaluate(
        f.request(base, base, [
          {
            ...edit,
            lineage: [{ source: f.ref("/a", "αbeta", [2, 3]), range: [0, 1] }],
          },
        ]),
      )
    ).outcome,
  ).toBe("invalid");
  // Undo left the grammar with frames; an operation kind the grammar does not
  // name is refused outright rather than reported as missing causal context.
  expect(
    (
      await f.evaluate(
        f.request(base, base, [
          {
            key: "op",
            kind: "undoOperation",
            target: { change: "missing", operation: "op" },
          } as unknown as SourceOperation,
        ]),
      )
    ).outcome,
  ).toBe("unsupported");
});

test("concurrent disjoint edits preserve both contributions in either arrival order", async () => {
  for (const reverse of [false, true]) {
    const f = new Fixture(),
      base = f.tree({ "a.txt": "one two" });
    const first = {
      key: "op",
      kind: "editSource" as const,
      source: f.ref("/a.txt", "one two", reverse ? [4, 7] : [0, 3]),
      text: reverse ? "TWO" : "ONE",
    };
    const second = {
      key: "op",
      kind: "editSource" as const,
      source: f.ref("/a.txt", "one two", reverse ? [0, 3] : [4, 7]),
      text: reverse ? "ONE" : "TWO",
    };
    const current = await f.run(
      f.request(
        base,
        f.tree({ "a.txt": reverse ? "one TWO" : "ONE two" }),
        [first],
        "first",
      ),
    );
    const merged = await f.run(
      f.request(
        base,
        f.tree({ "a.txt": reverse ? "ONE two" : "one TWO" }),
        [second],
        "second",
        current.result,
      ),
    );
    expect(merged.result.object).toBe(f.tree({ "a.txt": "ONE TWO" }));
    expect(merged.decisions).toEqual([]);
  }
});
test("entry move carries a concurrent descendant edit", async () => {
  const f = new Fixture(),
    base = f.tree({ "a.txt": "old" }),
    current = await f.run(
      f.request(
        base,
        f.tree({ "a.txt": "new" }),
        [
          {
            key: "edit",
            kind: "editSource",
            source: f.ref("/a.txt", "old"),
            text: "new",
          },
        ],
        "remote",
      ),
    );
  const r = await f.run(
    f.request(
      base,
      f.tree({ "b.txt": "old" }),
      [
        {
          key: "move",
          kind: "moveEntry",
          source: f.ref("/a.txt", "old"),
          destination: { parent: f.root(base), name: "b.txt" },
        },
      ],
      "local",
      current.result,
    ),
  );
  expect(r.result.object).toBe(f.tree({ "b.txt": "new" }));
  expect(r.decisions).toEqual([]);
});
test("delete versus edit retains alternatives", async () => {
  const f = new Fixture(),
    base = f.tree({ "a.txt": "old" }),
    current = await f.run(
      f.request(
        base,
        f.tree({ "a.txt": "new" }),
        [
          {
            key: "edit",
            kind: "editSource",
            source: f.ref("/a.txt", "old"),
            text: "new",
          },
        ],
        "remote",
      ),
    );
  const r = await f.run(
    f.request(
      base,
      f.tree({}),
      [{ key: "delete", kind: "removeEntry", source: f.ref("/a.txt", "old") }],
      "local",
      current.result,
    ),
  );
  expect(r.decisions).toHaveLength(1);
  const decision = r.decisions[0]!;
  expect(decision.kind).toBe("existence");
  // The kept side is the edited file itself; the deleted side names no node.
  expect(decision.alternatives.map((a) => a.node !== undefined)).toEqual([true, false]);
  expect(decision.alternatives[0]!.object).toBe(f.put("new"));
});
test("delete versus edit is a choice about that file while other changes merge", async () => {
  const f = new Fixture(),
    base = f.tree({ "a.txt": "old", "b.txt": "bee", "c.txt": "sea" });
  const remote = await f.run(f.request(base, f.tree({ "a.txt": "new", "b.txt": "BEE", "c.txt": "sea" }), [
    { key: "edit", kind: "editSource", source: f.ref("/a.txt", "old"), text: "new" },
    { key: "b", kind: "editSource", source: f.ref("/b.txt", "bee"), text: "BEE" },
  ], "remote"));
  const r = await f.run(f.request(base, f.tree({ "b.txt": "bee", "c.txt": "SEA" }), [
    { key: "delete", kind: "removeEntry", source: f.ref("/a.txt", "old") },
    { key: "c", kind: "editSource", source: f.ref("/c.txt", "sea"), text: "SEA" },
  ], "local", remote.result));
  expect(r.decisions.map((d) => [d.kind, d.affected.length])).toEqual([["existence", 1]]);
  // Both unrelated edits are in the projection; the file shows the incoming side.
  expect(r.result.object).toBe(f.tree({ "b.txt": "BEE", "c.txt": "SEA" }));
});
test("basis references follow source moved into another file within a batch", async () => {
  const f = new Fixture(),
    base = f.tree({ "a.txt": "one two", "b.txt": "three" });
  await f.run(
    f.request(base, f.tree({ "a.txt": " two", "b.txt": "threeONE" }), [
      {
        key: "move",
        kind: "moveSource",
        source: f.ref("/a.txt", "one two", [0, 3]),
        at: f.ref("/b.txt", "three", [5, 5]),
        side: "after",
      },
      {
        key: "edit",
        kind: "editSource",
        source: f.ref("/a.txt", "one two", [0, 3]),
        text: "ONE",
      },
    ]),
  );
});
test("two separated overlaps become independent source decisions", async () => {
  const f = new Fixture(),
    text = "one two three",
    base = f.tree({ "a.txt": text });
  const ops = (a: string, b: string): SourceOperation[] => [
    {
      key: "a",
      kind: "editSource",
      source: f.ref("/a.txt", text, [0, 3]),
      text: a,
    },
    {
      key: "b",
      kind: "editSource",
      source: f.ref("/a.txt", text, [8, 13]),
      text: b,
    },
  ];
  const current = await f.run(
    f.request(
      base,
      f.tree({ "a.txt": "ONE two THREE" }),
      ops("ONE", "THREE"),
      "a",
    ),
  );
  const r = await f.run(
    f.request(
      base,
      f.tree({ "a.txt": "1 two 3" }),
      ops("1", "3"),
      "b",
      current.result,
    ),
  );
  expect(r.decisions).toHaveLength(2);
  expect(r.decisions.map((d) => d.subject?.range)).toEqual([
    [0, 3],
    [8, 13],
  ]);
});
test.each([false, true])(
  "source move carries an edit to one repeated occurrence (move first %s)",
  async (moveFirst) => {
    const f = new Fixture(),
      source = "same same",
      base = f.tree({ "a.txt": source, "b.txt": "end" });
    const move: SourceOperation = {
      key: "move",
      kind: "moveSource",
      source: f.ref("/a.txt", source, [5, 9]),
      at: f.ref("/b.txt", "end", [3, 3]),
      side: "after",
    };
    const edit: SourceOperation = {
      key: "edit",
      kind: "editSource",
      source: f.ref("/a.txt", source, [5, 9]),
      text: "SECOND",
    };
    const m = f.request(
        base,
        f.tree({ "a.txt": "same ", "b.txt": "endsame" }),
        [move],
        "move",
      ),
      e = f.request(
        base,
        f.tree({ "a.txt": "same SECOND", "b.txt": "end" }),
        [edit],
        "edit",
      );
    const first = await f.run(moveFirst ? m : e),
      second = moveFirst ? e : m;
    second.current = first.result;
    const r = await f.run(second);
    expect(r.decisions).toEqual([]);
    expect(r.result.object).toBe(
      f.tree({ "a.txt": "same ", "b.txt": "endSECOND" }),
    );
  },
);
test("empty operation results keep their insertion anchor", async () => {
  const f = new Fixture(),
    base = f.tree({ "a.txt": "one two" });
  await f.run(
    f.request(base, f.tree({ "a.txt": "ONE two" }), [
      {
        key: "delete",
        kind: "editSource",
        source: f.ref("/a.txt", "one two", [0, 3]),
        text: "",
      },
      {
        key: "insert",
        kind: "editSource",
        source: f.op("edit", "delete", [0, 0]),
        text: "ONE",
      },
    ]),
  );
});
test("hidden alternative edits change retained state without resolving or changing projection", async () => {
  const f = new Fixture(),
    base = f.tree({ "a.txt": "Monday" });
  const a = await f.run(
    f.request(
      base,
      f.tree({ "a.txt": "Tuesday" }),
      [
        {
          key: "edit",
          kind: "editSource",
          source: f.ref("/a.txt", "Monday"),
          text: "Tuesday",
        },
      ],
      "a",
    ),
  );
  const b = await f.run(
    f.request(
      base,
      f.tree({ "a.txt": "Wednesday" }),
      [
        {
          key: "edit",
          kind: "editSource",
          source: f.ref("/a.txt", "Monday"),
          text: "Wednesday",
        },
      ],
      "b",
      a.result,
    ),
  );
  const ref: MaterialRef = {
    material: {
      kind: "alternative",
      state: "accepted",
      conflict: "day",
      alternative: "tuesday",
    },
  };
  const request = f.request(
    b.result,
    b.result.object,
    [{ key: "edit", kind: "editSource", source: ref, text: "Monday" }],
    "hidden",
  );
  request.alternatives = [
    {
      ref,
      decision: b.decisions[0]!.key,
      alternative: 0,
      value: { object: f.put("Tuesday"), kind: "file" },
    },
  ];
  const r = await f.run(request);
  expect(r.result.object).toBe(b.result.object);
  expect(r.result.state).not.toBe(b.result.state);
  expect(r.decisions).toHaveLength(1);
  expect(r.decisions[0]!.alternatives[0]!.object).toBe(f.put("Monday"));
  const resolve = f.request(r.result, r.result.object, [], "resolve");
  resolve.incoming.resolves = [r.decisions[0]!.key];
  expect((await f.run(resolve)).decisions).toEqual([]);
});

test("the earlier source-edit corpus retains its outcomes under the review insertion policy", async () => {
  const corpus = await Bun.file(
    "tests/fixtures/canopy/merge-source-intent.json",
  ).json();
  for (const example of corpus.cases)
    for (const reverse of [false, true]) {
      const f = new Fixture(),
        base = f.tree({ "note.md": example.base });
      const execute = (e: { start: number; end: number; text: string }) =>
        Buffer.concat([
          Buffer.from(example.base).subarray(0, e.start),
          Buffer.from(e.text),
          Buffer.from(example.base).subarray(e.end),
        ]).toString();
      const operation = (e: {
        start: number;
        end: number;
        text: string;
      }): SourceOperation => ({
        key: "edit",
        kind: "editSource",
        source: f.ref("/note.md", example.base, [e.start, e.end]),
        text: e.text,
      });
      const first = reverse ? example.right : example.left,
        second = reverse ? example.left : example.right;
      const current = await f.run(
        f.request(
          base,
          f.tree({ "note.md": execute(first) }),
          [operation(first)],
          "first",
        ),
      );
      const request = f.request(
        base,
        f.tree({ "note.md": execute(second) }),
        [operation(second)],
        "second",
        current.result,
      );
      // Keep the exploratory corpus's original policy explicit; current defaults
      // have separate preserve-both coverage.
      request.rules.config = {
        formats: { "/note.md": { proseInsertions: "review" } },
      };
      const result = await f.run(request);
      if (example.conflict)
        expect(result.decisions.length, example.name).toBeGreaterThan(0);
      else {
        expect(result.decisions, example.name).toEqual([]);
        expect(f.content(result.result.object, "note.md"), example.name).toBe(
          example.expected,
        );
      }
    }
});
test("copying a conflicted file gives the copy independent alternatives", async () => {
  const f = new Fixture(),
    base = f.tree({ "a.txt": "old" });
  const a = await f.run(
    f.request(
      base,
      f.tree({ "a.txt": "one" }),
      [
        {
          key: "edit",
          kind: "editSource",
          source: f.ref("/a.txt", "old"),
          text: "one",
        },
      ],
      "a",
    ),
  );
  const b = await f.run(
    f.request(
      base,
      f.tree({ "a.txt": "two" }),
      [
        {
          key: "edit",
          kind: "editSource",
          source: f.ref("/a.txt", "old"),
          text: "two",
        },
      ],
      "b",
      a.result,
    ),
  );
  const copy = await f.run(
    f.request(
      b.result,
      f.tree({ "a.txt": "two", "b.txt": "two" }),
      [
        {
          key: "copy",
          kind: "copyEntry",
          source: f.ref("/a.txt", "two"),
          destination: { parent: f.root(b.result.object), name: "b.txt" },
        },
      ],
      "copy",
    ),
  );
  expect(copy.decisions).toHaveLength(2);
  expect(copy.decisions[0]!.key).not.toBe(copy.decisions[1]!.key);
  expect(copy.decisions[1]!.alternatives.map((a) => a.object)).toEqual([
    f.put("one"),
    f.put("two"),
  ]);
});
test("ordinary selected-alternative edits revise it without retiring its sibling", async () => {
  const f = new Fixture(),
    base = f.tree({ "a.txt": "old" });
  const a = await f.run(
    f.request(
      base,
      f.tree({ "a.txt": "one" }),
      [
        {
          key: "edit",
          kind: "editSource",
          source: f.ref("/a.txt", "old"),
          text: "one",
        },
      ],
      "a",
    ),
  );
  const b = await f.run(
    f.request(
      base,
      f.tree({ "a.txt": "two" }),
      [
        {
          key: "edit",
          kind: "editSource",
          source: f.ref("/a.txt", "old"),
          text: "two",
        },
      ],
      "b",
      a.result,
    ),
  );
  const r = await f.run(
    f.request(
      b.result,
      f.tree({ "a.txt": "old" }),
      [
        {
          key: "edit",
          kind: "editSource",
          source: f.ref("/a.txt", "two"),
          text: "old",
        },
      ],
      "back",
    ),
  );
  expect(r.decisions).toHaveLength(1);
  expect(r.decisions[0]!.alternatives.map((a) => a.object)).toEqual([
    f.put("one"),
    f.put("old"),
  ]);
});
test("opaque deletion encloses a source choice and hidden edits update its ancestor alternative", async () => {
  const f = new Fixture(),
    base = f.tree({ "a.txt": "old" });
  const a = await f.run(
    f.request(
      base,
      f.tree({ "a.txt": "one" }),
      [
        {
          key: "edit",
          kind: "editSource",
          source: f.ref("/a.txt", "old"),
          text: "one",
        },
      ],
      "a",
    ),
  );
  const b = await f.run(
    f.request(
      base,
      f.tree({ "a.txt": "two" }),
      [
        {
          key: "edit",
          kind: "editSource",
          source: f.ref("/a.txt", "old"),
          text: "two",
        },
      ],
      "b",
      a.result,
    ),
  );
  const removed = await f.run(
    f.request(
      b.result,
      f.tree({}),
      [{ key: "remove", kind: "removeEntry", source: f.ref("/a.txt", "two") }],
      "remove",
    ),
  );
  expect(removed.decisions).toHaveLength(2);
  expect(removed.decisions[1]!.dependencies).toEqual([b.decisions[0]!.key]);
  const ref: MaterialRef = {
    material: {
      kind: "alternative",
      state: "state",
      conflict: "day",
      alternative: "selected",
    },
  };
  const request = f.request(
    removed.result,
    removed.result.object,
    [{ key: "edit", kind: "editSource", source: ref, text: "THREE" }],
    "hidden",
  );
  request.alternatives = [
    {
      ref,
      decision: b.decisions[0]!.key,
      alternative: 1,
      value: { object: f.put("two"), kind: "file" },
    },
  ];
  const r = await f.run(request);
  expect(r.result.object).toBe(removed.result.object);
  expect(r.decisions[1]!.alternatives[0]!.object).toBe(
    f.tree({ "a.txt": "THREE" }),
  );
});
test("explicit selected alternative references update the visible placement", async () => {
  const f = new Fixture(),
    base = f.tree({ "a.txt": "old" });
  const a = await f.run(
    f.request(
      base,
      f.tree({ "a.txt": "one" }),
      [
        {
          key: "edit",
          kind: "editSource",
          source: f.ref("/a.txt", "old"),
          text: "one",
        },
      ],
      "a",
    ),
  );
  const b = await f.run(
    f.request(
      base,
      f.tree({ "a.txt": "two" }),
      [
        {
          key: "edit",
          kind: "editSource",
          source: f.ref("/a.txt", "old"),
          text: "two",
        },
      ],
      "b",
      a.result,
    ),
  );
  const ref: MaterialRef = {
    material: {
      kind: "alternative",
      state: "state",
      conflict: "day",
      alternative: "two",
    },
  };
  const request = f.request(
    b.result,
    f.tree({ "a.txt": "THREE" }),
    [{ key: "edit", kind: "editSource", source: ref, text: "THREE" }],
    "explicit",
  );
  request.alternatives = [
    {
      ref,
      decision: b.decisions[0]!.key,
      alternative: 1,
      value: { object: f.put("two"), kind: "file" },
    },
  ];
  const r = await f.run(request);
  expect(r.decisions[0]!.alternatives.map((a) => a.object)).toEqual([
    f.put("one"),
    f.put("THREE"),
  ]);
});

test("prose insertion policy is explicit and arrival-order deterministic", async () => {
  for (const reverse of [false, true]) {
    const f = new Fixture(),
      base = f.tree({ "note.md": "hello" });
    const op = (text: string): SourceOperation => ({
      key: "insert",
      kind: "editSource",
      source: f.ref("/note.md", "hello", [5, 5]),
      text,
    });
    const a = f.request(
      base,
      f.tree({ "note.md": "hello A" }),
      [op(" A")],
      "a",
    );
    const b = f.request(
      base,
      f.tree({ "note.md": "hello B" }),
      [op(" B")],
      "b",
    );
    const first = await f.run(reverse ? b : a),
      second = reverse ? a : b;
    second.current = first.result;
    second.rules.config = {
      formats: { "/note.md": { proseInsertions: "preserve-both" } },
    };
    const result = await f.run(second);
    expect(result.decisions).toEqual([]);
    expect(f.content(result.result.object, "note.md")).toBe("hello A B");
  }
});

test("malformed intent, unavailable objects, unsupported operations and resource budgets remain distinct", async () => {
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
  const bad = structuredClone(request);
  (bad.incoming.trace[0]!.operations[0] as { kind: string }).kind = "unknown";
  expect((await f.evaluate(bad)).outcome).toBe("unsupported");
  const limited = structuredClone(request);
  limited.rules.config = { maxBytes: 1 };
  expect((await f.evaluate(limited)).outcome).toBe("limit");
  f.objects.delete(base);
  expect((await f.evaluate(request)).outcome).toBe("missing-context");
});

test("nested TreeIDs stay opaque through directory copies and retained state reload", async () => {
  const f = new Fixture(),
    boundary = "tr_aaaaaaaaaaaaaaaaaaaaaaaaaa",
    nested = f.dir([
      { name: "mount", tree: boundary },
      { name: "a.txt", file: f.put("old") },
    ]),
    base = f.dir([{ name: "folder", directory: nested }]);
  const source: MaterialRef = {
    material: { kind: "basis", path: "/folder", object: nested },
  };
  const copy = f.dir([
    { name: "copy", directory: nested },
    { name: "folder", directory: nested },
  ]);
  const result = await f.run(
    f.request(
      base,
      copy,
      [
        {
          key: "copy",
          kind: "copyEntry",
          source,
          destination: { parent: f.root(base), name: "copy" },
        },
      ],
      "copy",
    ),
  );
  const renamed = f.dir([
    { name: "copy", directory: nested },
    { name: "renamed", directory: nested },
  ]);
  await f.run(
    f.request(
      result.result,
      renamed,
      [
        {
          key: "rename",
          kind: "moveEntry",
          source,
          destination: { parent: f.root(copy), name: "renamed" },
        },
      ],
      "rename",
    ),
  );
  const invalid = f.request(
    result.result,
    copy,
    [
      {
        key: "edit",
        kind: "editSource",
        source: {
          material: {
            kind: "basis",
            path: "/folder/mount/file",
            object: f.put("old"),
          },
        },
        text: "new",
      },
    ],
    "invalid",
  );
  expect((await f.evaluate(invalid)).outcome).toBe("invalid");
});
test("a moved source choice remains inspectable and editable after state reload", async () => {
  const f = new Fixture(),
    base = f.tree({ "a.txt": "old", "b.txt": "end" });
  const a = await f.run(
    f.request(
      base,
      f.tree({ "a.txt": "one", "b.txt": "end" }),
      [
        {
          key: "edit",
          kind: "editSource",
          source: f.ref("/a.txt", "old"),
          text: "one",
        },
      ],
      "a",
    ),
  );
  const b = await f.run(
    f.request(
      base,
      f.tree({ "a.txt": "two", "b.txt": "end" }),
      [
        {
          key: "edit",
          kind: "editSource",
          source: f.ref("/a.txt", "old"),
          text: "two",
        },
      ],
      "b",
      a.result,
    ),
  );
  const moved = await f.run(
    f.request(
      b.result,
      f.tree({ "a.txt": "", "b.txt": "endtwo" }),
      [
        {
          key: "move",
          kind: "moveSource",
          source: f.ref("/a.txt", "two"),
          at: f.ref("/b.txt", "end", [3, 3]),
          side: "after",
        },
      ],
      "move",
    ),
  );
  const next = await f.run(
    f.request(
      moved.result,
      f.tree({ "a.txt": "", "b.txt": "endTHREE" }),
      [
        {
          key: "edit",
          kind: "editSource",
          source: f.ref("/b.txt", "endtwo", [3, 6]),
          text: "THREE",
        },
      ],
      "next",
    ),
  );
  expect(next.decisions).toHaveLength(1);
  expect(next.decisions[0]!.alternatives.map((a) => a.object)).toEqual([
    f.put("one"),
    f.put("THREE"),
  ]);
});
test("opaque equal-byte replacement creates fresh origins rather than reviving the basis", async () => {
  const f = new Fixture(),
    base = f.tree({ "a.txt": "same" });
  const replaced = await f.run(
    f.request(
      base,
      base,
      [
        {
          key: "replace",
          kind: "replaceEntry",
          source: f.ref("/a.txt", "same"),
          value: { file: f.put("same") },
        },
      ],
      "replace",
    ),
  );
  expect(replaced.result.state).toBeTruthy();
  const current = await f.run(
    f.request(
      replaced.result,
      f.tree({ "a.txt": "NEW" }),
      [
        {
          key: "edit",
          kind: "editSource",
          source: f.ref("/a.txt", "same"),
          text: "NEW",
        },
      ],
      "edit",
    ),
  );
  const late = await f.run(
    f.request(
      base,
      f.tree({ "a.txt": "OLD" }),
      [
        {
          key: "edit",
          kind: "editSource",
          source: f.ref("/a.txt", "same"),
          text: "OLD",
        },
      ],
      "late",
      current.result,
    ),
  );
  expect(late.decisions.length).toBeGreaterThan(0);
});
test("an old source move cannot claim lineage through equal-byte opaque replacement", async () => {
  const f = new Fixture(),
    base = f.tree({ "a.txt": "same", "b.txt": "" });
  const replaced = await f.run(
    f.request(
      base,
      base,
      [
        {
          key: "replace",
          kind: "replaceEntry",
          source: f.ref("/a.txt", "same"),
          value: { file: f.put("same") },
        },
      ],
      "replace",
    ),
  );
  const late = await f.run(
    f.request(
      base,
      f.tree({ "a.txt": "", "b.txt": "same" }),
      [
        {
          key: "move",
          kind: "moveSource",
          source: f.ref("/a.txt", "same"),
          at: f.ref("/b.txt", "", [0, 0]),
          side: "after",
        },
      ],
      "move",
      replaced.result,
    ),
  );
  expect(late.decisions.length).toBeGreaterThan(0);
});
test("the kept file of a delete-versus-edit choice accepts hidden edits", async () => {
  const f = new Fixture(),
    base = f.tree({ "a.txt": "old" });
  const current = await f.run(
    f.request(
      base,
      f.tree({ "a.txt": "new" }),
      [
        {
          key: "edit",
          kind: "editSource",
          source: f.ref("/a.txt", "old"),
          text: "new",
        },
      ],
      "current",
    ),
  );
  const removed = await f.run(
    f.request(
      base,
      f.tree({}),
      [{ key: "remove", kind: "removeEntry", source: f.ref("/a.txt", "old") }],
      "remove",
      current.result,
    ),
  );
  const ref: MaterialRef = {
    material: {
      kind: "alternative",
      state: "accepted",
      conflict: "entry",
      alternative: "kept",
    },
  };
  const request = f.request(
    removed.result,
    removed.result.object,
    [
      {
        key: "edit",
        kind: "editSource",
        source: ref,
        text: "NEW",
      },
    ],
    "hidden",
  );
  // Delete versus edit is a choice about the file: its kept alternative is the file.
  request.alternatives = [
    {
      ref,
      decision: removed.decisions[0]!.key,
      alternative: 0,
      value: { object: f.put("new"), kind: "file" },
    },
  ];
  const result = await f.run(request);
  expect(result.result.object).toBe(removed.result.object);
  expect(result.decisions[0]!.alternatives[0]!.object).toBe(f.put("NEW"));
  const again = f.request(
    result.result,
    result.result.object,
    [
      {
        key: "edit",
        kind: "editSource",
        source: ref,
        text: "NEWER",
      },
    ],
    "again",
  );
  again.alternatives = [
    {
      ref,
      decision: result.decisions[0]!.key,
      alternative: 0,
      value: { object: f.put("NEW"), kind: "file" },
    },
  ];
  expect((await f.run(again)).decisions[0]!.alternatives[0]!.object).toBe(f.put("NEWER"));
});
test("a delete-versus-edit choice stays scoped to its file while unrelated edits merge", async () => {
  const f = new Fixture(),
    base = f.tree({ "a.txt": "old", "b.txt": "same" });
  const current = await f.run(
    f.request(
      base,
      f.tree({ "a.txt": "new", "b.txt": "same" }),
      [
        {
          key: "edit",
          kind: "editSource",
          source: f.ref("/a.txt", "old"),
          text: "new",
        },
      ],
      "current",
    ),
  );
  const removed = await f.run(
    f.request(
      base,
      f.tree({ "b.txt": "same" }),
      [{ key: "remove", kind: "removeEntry", source: f.ref("/a.txt", "old") }],
      "remove",
      current.result,
    ),
  );
  const next = await f.run(
    f.request(
      removed.result,
      f.tree({ "b.txt": "NEXT" }),
      [
        {
          key: "edit",
          kind: "editSource",
          source: f.ref("/b.txt", "same"),
          text: "NEXT",
        },
      ],
      "next",
    ),
  );
  // The file's choice stays as it was while unrelated edits merge.
  expect(next.decisions.map((d) => d.kind)).toEqual(["existence"]);
  expect(next.result.object).toBe(f.tree({ "b.txt": "NEXT" }));
  await f.run(
    f.request(
      next.result,
      f.tree({ "b.txt": "LATER" }),
      [
        {
          key: "edit",
          kind: "editSource",
          source: f.ref("/b.txt", "NEXT"),
          text: "LATER",
        },
      ],
      "later",
    ),
  );
});
test("keeping an enclosing alternative retains its child choice; discarding requires child guards", async () => {
  const f = new Fixture(),
    base = f.tree({ "a.txt": "old" });
  const a = await f.run(
    f.request(
      base,
      f.tree({ "a.txt": "one" }),
      [
        {
          key: "edit",
          kind: "editSource",
          source: f.ref("/a.txt", "old"),
          text: "one",
        },
      ],
      "a",
    ),
  );
  const b = await f.run(
    f.request(
      base,
      f.tree({ "a.txt": "two" }),
      [
        {
          key: "edit",
          kind: "editSource",
          source: f.ref("/a.txt", "old"),
          text: "two",
        },
      ],
      "b",
      a.result,
    ),
  );
  const removed = await f.run(
    f.request(
      b.result,
      f.tree({}),
      [{ key: "remove", kind: "removeEntry", source: f.ref("/a.txt", "two") }],
      "remove",
    ),
  );
  const parent = removed.decisions[1]!,
    child = removed.decisions[0]!;
  const bad = f.request(removed.result, removed.result.object, [], "discard");
  bad.incoming.resolves = [parent.key];
  expect((await f.evaluate(bad)).outcome).toBe("invalid");
  const ref: MaterialRef = {
    material: {
      kind: "alternative",
      state: "state",
      conflict: "parent",
      alternative: "kept",
    },
  };
  const keep = f.request(
    removed.result,
    b.result.object,
    [
      {
        key: "restore",
        kind: "moveEntry",
        source: { ...ref, within: ["a.txt"] },
        destination: { parent: f.root(removed.result.object), name: "a.txt" },
      },
    ],
    "keep",
  );
  keep.alternatives = [
    {
      ref,
      decision: parent.key,
      alternative: 0,
      value: { object: b.result.object, kind: "directory" },
    },
  ];
  keep.incoming.resolves = [parent.key];
  const kept = await f.run(keep);
  expect(kept.decisions.map((d) => d.key)).toEqual([child.key]);
  expect(kept.decisions[0]!.context).toBeUndefined();
  await f.run(
    f.request(
      kept.result,
      f.tree({ "a.txt": "THREE" }),
      [
        {
          key: "edit",
          kind: "editSource",
          source: f.ref("/a.txt", "two"),
          text: "THREE",
        },
      ],
      "later",
    ),
  );
  bad.incoming.change = "guarded";
  bad.incoming.resolves = [parent.key, child.key];
  expect((await f.run(bad)).decisions).toEqual([]);
});
test("hidden source continuation propagates through two enclosing structural decisions", async () => {
  const f = new Fixture(),
    base = f.tree({ "a.txt": "old", "b.txt": "stay" });
  const a = await f.run(
    f.request(
      base,
      f.tree({ "a.txt": "one", "b.txt": "stay" }),
      [
        {
          key: "edit",
          kind: "editSource",
          source: f.ref("/a.txt", "old"),
          text: "one",
        },
      ],
      "a",
    ),
  );
  const b = await f.run(
    f.request(
      base,
      f.tree({ "a.txt": "two", "b.txt": "stay" }),
      [
        {
          key: "edit",
          kind: "editSource",
          source: f.ref("/a.txt", "old"),
          text: "two",
        },
      ],
      "b",
      a.result,
    ),
  );
  const removed = await f.run(
    f.request(
      b.result,
      f.tree({ "b.txt": "stay" }),
      [{ key: "remove", kind: "removeEntry", source: f.ref("/a.txt", "two") }],
      "remove",
    ),
  );
  const outer = await f.run(
    f.request(
      base,
      f.tree({ "a.txt": "OUTER", "b.txt": "stay" }),
      [
        {
          key: "replace",
          kind: "replaceEntry",
          source: f.ref("/a.txt", "old"),
          value: { file: f.put("OUTER") },
        },
      ],
      "outer",
      removed.result,
    ),
  );
  const ref: MaterialRef = {
    material: {
      kind: "alternative",
      state: "state",
      conflict: "source",
      alternative: "two",
    },
  };
  const request = f.request(
    outer.result,
    outer.result.object,
    [{ key: "edit", kind: "editSource", source: ref, text: "THREE" }],
    "deep",
  );
  request.alternatives = [
    {
      ref,
      decision: b.decisions[0]!.key,
      alternative: 1,
      value: { object: f.put("two"), kind: "file" },
    },
  ];
  const result = await f.run(request);
  expect(result.result.object).toBe(outer.result.object);
  expect(result.decisions[0]!.alternatives[1]!.object).toBe(f.put("THREE"));
  await f.run(
    f.request(
      result.result,
      f.tree({ "a.txt": "OUTER", "b.txt": "LATER" }),
      [
        {
          key: "edit",
          kind: "editSource",
          source: f.ref("/b.txt", "stay"),
          text: "LATER",
        },
      ],
      "later",
    ),
  );
});
test.each([3, 5])(
  "hidden continuation propagates through %s enclosing decisions",
  async (depth) => {
    const f = new Fixture(),
      base = f.tree({ "a.txt": "old", "b.txt": "stay" });
    const a = await f.run(
      f.request(
        base,
        f.tree({ "a.txt": "one", "b.txt": "stay" }),
        [
          {
            key: "edit",
            kind: "editSource",
            source: f.ref("/a.txt", "old"),
            text: "one",
          },
        ],
        "a",
      ),
    );
    const b = await f.run(
      f.request(
        base,
        f.tree({ "a.txt": "two", "b.txt": "stay" }),
        [
          {
            key: "edit",
            kind: "editSource",
            source: f.ref("/a.txt", "old"),
            text: "two",
          },
        ],
        "b",
        a.result,
      ),
    );
    const removed = await f.run(
      f.request(
        b.result,
        f.tree({ "b.txt": "stay" }),
        [
          {
            key: "remove",
            kind: "removeEntry",
            source: f.ref("/a.txt", "two"),
          },
        ],
        "remove",
      ),
    );
    let outer = await f.run(
      f.request(
        base,
        f.tree({ "a.txt": "OUTER", "b.txt": "stay" }),
        [
          {
            key: "replace",
            kind: "replaceEntry",
            source: f.ref("/a.txt", "old"),
            value: { file: f.put("OUTER") },
          },
        ],
        "outer",
        removed.result,
      ),
    );
    for (let i = 2; i < depth; i++)
      outer = await f.run(
        f.request(
          base,
          f.tree({ "a.txt": "OUTER", "b.txt": "stay" }),
          [
            {
              key: "replace",
              kind: "replaceEntry",
              source: f.ref("/a.txt", "old"),
              value: { file: f.put("OUTER") },
            },
          ],
          `outer${i}`,
          outer.result,
        ),
      );
    const ref: MaterialRef = {
      material: {
        kind: "alternative",
        state: "state",
        conflict: "source",
        alternative: "two",
      },
    };
    const request = f.request(
      outer.result,
      outer.result.object,
      [{ key: "edit", kind: "editSource", source: ref, text: "THREE" }],
      "deep",
    );
    request.alternatives = [
      {
        ref,
        decision: b.decisions[0]!.key,
        alternative: 1,
        value: { object: f.put("two"), kind: "file" },
      },
    ];
    const result = await f.run(request);
    expect(result.result.object).toBe(outer.result.object);
    expect(result.decisions[0]!.alternatives[1]!.object).toBe(f.put("THREE"));
    await f.run(
      f.request(
        result.result,
        f.tree({ "a.txt": "OUTER", "b.txt": "LATER" }),
        [
          {
            key: "edit",
            kind: "editSource",
            source: f.ref("/b.txt", "stay"),
            text: "LATER",
          },
        ],
        "later",
      ),
    );
  },
);
test("a partial copy through a source choice stays coupled rather than inventing a slice of another value", async () => {
  const f = new Fixture(),
    base = f.tree({ "a.txt": "old", "b.txt": "end" });
  const a = await f.run(
    f.request(
      base,
      f.tree({ "a.txt": "one", "b.txt": "end" }),
      [
        {
          key: "edit",
          kind: "editSource",
          source: f.ref("/a.txt", "old"),
          text: "one",
        },
      ],
      "a",
    ),
  );
  const b = await f.run(
    f.request(
      base,
      f.tree({ "a.txt": "two", "b.txt": "end" }),
      [
        {
          key: "edit",
          kind: "editSource",
          source: f.ref("/a.txt", "old"),
          text: "two",
        },
      ],
      "b",
      a.result,
    ),
  );
  const copied = await f.run(
    f.request(
      b.result,
      f.tree({ "a.txt": "two", "b.txt": "endwo" }),
      [
        {
          key: "copy",
          kind: "copySource",
          source: f.ref("/a.txt", "two", [1, 3]),
          at: f.ref("/b.txt", "end", [3, 3]),
          side: "after",
        },
      ],
      "copy",
    ),
  );
  expect(copied.decisions).toHaveLength(2);
  expect(copied.decisions[1]!.dependencies).toEqual([b.decisions[0]!.key]);
  const edited = await f.run(
    f.request(
      copied.result,
      f.tree({ "a.txt": "THREE", "b.txt": "endwo" }),
      [
        {
          key: "edit",
          kind: "editSource",
          source: f.ref("/a.txt", "two"),
          text: "THREE",
        },
      ],
      "later",
    ),
  );
  expect(edited.decisions[1]!.alternatives[0]!.object).toBe(
    f.tree({ "a.txt": "THREE", "b.txt": "end" }),
  );
  expect(edited.decisions[1]!.alternatives[1]!.object).toBe(
    edited.result.object,
  );
});

test("three same-anchor prose contributions have one order across all arrivals", async () => {
  for (const order of ["abc", "acb", "bac", "bca", "cab", "cba"]) {
    const f = new Fixture(),
      base = f.tree({ "note.md": "hello" });
    let current: { object: string; state: string } | string = base;
    for (const change of order) {
      const request = f.request(
        base,
        f.tree({ "note.md": `hello ${change}` }),
        [
          {
            key: "insert",
            kind: "editSource",
            source: f.ref("/note.md", "hello", [5, 5]),
            text: ` ${change}`,
          },
        ],
        change,
        current,
      );
      const result = await f.run(request);
      expect(result.decisions).toEqual([]);
      current = result.result;
    }
    expect(
      f.content(
        typeof current === "string" ? current : current.object,
        "note.md",
      ),
    ).toBe("hello a b c");
  }
});
test("retained effects include exact authored copy intent and its basis", async () => {
  const f = new Fixture(),
    base = f.tree({ "a.txt": "original" });
  const operation: SourceOperation = {
    key: "copy",
    kind: "copyEntry",
    source: f.ref("/a.txt", "original"),
    destination: { parent: f.root(base), name: "b.txt" },
  };
  const result = await f.run(
    f.request(
      base,
      f.tree({ "a.txt": "original", "b.txt": "original" }),
      [operation],
      "copy",
    ),
  );
  const state = await loadIntentState(result.result.state, async (hash) => f.objects.get(hash)!);
  const effect = Object.values(state.effects)[0] as {
    authored: { basis: string; operation: string };
  };
  expect(effect.authored.basis).toBe(base);
  expect(
    JSON.parse(
      new TextDecoder().decode(f.objects.get(effect.authored.operation)),
    ),
  ).toEqual(operation);
});

test("a source copy does not silently order a concurrent insertion at its destination", async () => {
  for (const reverse of [false, true]) {
    const f = new Fixture(),
      base = f.tree({ "a.txt": "one two" });
    const copy = f.request(
      base,
      f.tree({ "a.txt": "one twoone" }),
      [
        {
          key: "copy",
          kind: "copySource",
          source: f.ref("/a.txt", "one two", [0, 3]),
          at: f.ref("/a.txt", "one two", [7, 7]),
          side: "after",
        },
      ],
      "copy",
    );
    const insert = f.request(
      base,
      f.tree({ "a.txt": "one two!" }),
      [
        {
          key: "insert",
          kind: "editSource",
          source: f.ref("/a.txt", "one two", [7, 7]),
          text: "!",
        },
      ],
      "insert",
    );
    const first = await f.run(reverse ? insert : copy),
      second = reverse ? copy : insert;
    second.current = first.result;
    expect((await f.run(second)).decisions.length).toBeGreaterThan(0);
  }
});

test("generated UTF-8 disjoint edits preserve exact bytes in every arrival order", async () => {
  for (const prefix of ["", "α", "👩🏽‍💻", "\uFEFF"]) {
    for (const newline of ["\n", "\r\n", ""]) {
      for (const reverse of [false, true]) {
        const f = new Fixture(),
          source = `${prefix}one / two${newline}`,
          base = f.tree({ "a.txt": source });
        const start = Buffer.byteLength(prefix);
        const a = f.request(
          base,
          f.tree({ "a.txt": `${prefix}ONE / two${newline}` }),
          [
            {
              key: "edit",
              kind: "editSource",
              source: f.ref("/a.txt", source, [start, start + 3]),
              text: "ONE",
            },
          ],
          "a",
        );
        const b = f.request(
          base,
          f.tree({ "a.txt": `${prefix}one / TWO${newline}` }),
          [
            {
              key: "edit",
              kind: "editSource",
              source: f.ref("/a.txt", source, [start + 6, start + 9]),
              text: "TWO",
            },
          ],
          "b",
        );
        const first = await f.run(reverse ? b : a),
          second = reverse ? a : b;
        second.current = first.result;
        const result = await f.run(second);
        expect(result.decisions).toEqual([]);
        expect(result.result.object).toBe(
          f.tree({ "a.txt": `${prefix}ONE / TWO${newline}` }),
        );
      }
    }
  }
});

test("copying an empty selected alternative preserves the hidden value", async () => {
  const f = new Fixture(),
    base = f.tree({ "a.txt": "old" });
  const a = await f.run(
    f.request(
      base,
      f.tree({ "a.txt": "one" }),
      [
        {
          key: "edit",
          kind: "editSource",
          source: f.ref("/a.txt", "old"),
          text: "one",
        },
      ],
      "a",
    ),
  );
  const b = await f.run(
    f.request(
      base,
      f.tree({ "a.txt": "" }),
      [
        {
          key: "edit",
          kind: "editSource",
          source: f.ref("/a.txt", "old"),
          text: "",
        },
      ],
      "b",
      a.result,
    ),
  );
  const copy = await f.run(
    f.request(
      b.result,
      f.tree({ "a.txt": "", "b.txt": "" }),
      [
        {
          key: "copy",
          kind: "copyEntry",
          source: f.ref("/a.txt", ""),
          destination: { parent: f.root(b.result.object), name: "b.txt" },
        },
      ],
      "copy",
    ),
  );
  expect(copy.decisions).toHaveLength(2);
  expect(copy.decisions[1]!.alternatives.map((a) => a.object)).toEqual([
    f.put("one"),
    f.put(""),
  ]);
});


test("a two-frame trace reaches the same result as the composed change", async () => {
  const f = new Fixture(),
    base = f.tree({ "a.md": "abc", "b.md": "xyz" });
  const middle = f.tree({ "a.md": "Abc", "b.md": "xyz" });
  const candidate = f.tree({ "a.md": "Abc", "b.md": "Xyz" });
  const editA: SourceOperation = {
    key: "a",
    kind: "editSource",
    source: f.ref("/a.md", "abc", [0, 1]),
    text: "A",
  };
  const editB: SourceOperation = {
    key: "b",
    kind: "editSource",
    source: f.ref("/b.md", "xyz", [0, 1]),
    text: "X",
  };
  const framed = await f.run(
    f.trace(base, [
      { after: middle, operations: [editA] },
      { after: candidate, operations: [editB] },
    ]),
  );
  const composed = await f.run(f.request(base, candidate, [editA, editB]));
  expect(framed.result.object).toBe(candidate);
  expect(framed.result.object).toBe(composed.result.object);
  expect(framed.decisions).toEqual(composed.decisions);
  expect(framed.evidence.operations).toEqual(composed.evidence.operations);
});

test("a frame that does not reproduce its result is invalid", async () => {
  const f = new Fixture(),
    base = f.tree({ "a.md": "abc", "b.md": "xyz" });
  const candidate = f.tree({ "a.md": "abc", "b.md": "Xyz" });
  const response = await f.evaluate({
    kind: "tree",
    tree: "tree",
    base: { object: base },
    current: { object: base },
    incoming: {
      change: "edit",
      object: candidate,
      trace: [
        // Claims the first edit changes nothing, which its operation denies.
        {
          before: base,
          after: base,
          operations: [
            {
              key: "a",
              kind: "editSource",
              source: f.ref("/a.md", "abc", [0, 1]),
              text: "A",
            },
          ],
        },
        {
          before: base,
          after: candidate,
          operations: [
            {
              key: "b",
              kind: "editSource",
              source: f.ref("/b.md", "xyz", [0, 1]),
              text: "X",
            },
          ],
        },
      ],
    },
    rules: { id: "tree-default", revision: 1 },
  });
  expect(response.outcome).toBe("invalid");
  expect((response as { message: string }).message).toContain("Frame does not reproduce its result");
});

test("a trace that leaves its basis or its candidate is rejected", async () => {
  const f = new Fixture(),
    base = f.tree({ "a.md": "abc" }),
    candidate = f.tree({ "a.md": "Abc" });
  const operations: SourceOperation[] = [
    { key: "a", kind: "editSource", source: f.ref("/a.md", "abc", [0, 1]), text: "A" },
  ];
  const request = f.trace(base, [{ after: candidate, operations }]);
  const detached = structuredClone(request);
  detached.incoming.trace![0]!.before = candidate;
  expect((await f.evaluate(detached)).outcome).toBe("invalid");
  const short = structuredClone(request);
  short.incoming.object = base;
  expect((await f.evaluate(short)).outcome).toBe("invalid");
  const reused = structuredClone(request);
  reused.incoming.trace = [
    reused.incoming.trace![0]!,
    { before: candidate, after: candidate, operations },
  ];
  reused.incoming.object = candidate;
  expect((await f.evaluate(reused)).outcome).toBe("invalid");
});

test("a later frame refers to an earlier frame's operation result", async () => {
  const f = new Fixture(),
    base = f.tree({ "a.md": "abc" });
  const middle = f.tree({ "a.md": "aNEWbc" });
  const candidate = f.tree({ "a.md": "aOLDbc" });
  const framed = await f.run(
    f.trace(base, [
      {
        after: middle,
        operations: [
          {
            key: "insert",
            kind: "editSource",
            source: f.ref("/a.md", "abc", [1, 1]),
            text: "NEW",
          },
        ],
      },
      {
        after: candidate,
        operations: [
          {
            key: "revise",
            kind: "editSource",
            source: f.op("edit", "insert", [0, 3]),
            text: "OLD",
          },
        ],
      },
    ]),
  );
  expect(framed.result.object).toBe(candidate);
  expect(f.content(framed.result.object, "a.md")).toBe("aOLDbc");
});

test("a change's identity is its frame chain", async () => {
  const f = new Fixture(),
    base = f.tree({ "a.md": "abc" }),
    candidate = f.tree({ "a.md": "Abc" });
  const edit = { key: "a", kind: "editSource" as const, source: f.ref("/a.md", "abc", [0, 1]), text: "A" };
  // A one-step request is the single frame it states, so the two hash alike.
  const flat = stableJSONString(changeIdentity(parseIntentRequest(f.request(base, candidate, [edit]))));
  const framed = f.trace(base, [{ after: candidate, operations: [edit] }]);
  expect(stableJSONString(changeIdentity(parseIntentRequest(framed)))).toBe(flat);
  expect(flat).toContain('"trace"');
  // A flat operation list is not a request shape the engine accepts.
  const { trace: _trace, ...rest } = f.request(base, candidate, [edit]).incoming;
  expect(() => parseIntentRequest({ ...f.request(base, candidate, [edit]), incoming: { ...rest, operations: [edit] } })).toThrow();
  // The same operations divided into two frames are a different claim, so two
  // changes can never share an identity by regrouping their steps.
  const two = f.trace(base, [
    { after: candidate, operations: [edit] },
    { after: f.tree({ "a.md": "ABc" }), operations: [{ key: "b", kind: "editSource", source: f.ref("/a.md", "Abc", [1, 2]), text: "B" }] },
  ]);
  expect(stableJSONString(changeIdentity(parseIntentRequest(two)))).not.toBe(flat);
});

test("a scoped hidden branch advances without widening or another decision", async () => {
  const f = new Fixture(), source = "prefix old suffix\n", base = f.tree({"a.txt": source});
  const first = await f.run(f.request(base, f.tree({"a.txt":"prefix one suffix\n"}), [
    {key:"edit",kind:"editSource",source:f.ref("/a.txt",source,[7,10]),text:"one"}
  ], "first"));
  const second = await f.run({...f.request(base, f.tree({"a.txt":"prefix two suffix\n"}), [
    {key:"edit",kind:"editSource",source:f.ref("/a.txt",source,[7,10]),text:"two"}
  ], "second",first.result),rules:{id:"tree-default",revision:1,config:{conflictProjection:"current"}}});
  expect(second.decisions).toHaveLength(1);
  const continued = await f.run(f.request(second.authored!,f.tree({"a.txt":"prefix TWO suffix\n"}),[
    {key:"edit",kind:"editSource",source:f.ref("/a.txt","prefix two suffix\n",[7,10]),text:"TWO"}
  ],"third",second.result));
  expect(continued.result.object).toBe(first.result.object);
  expect(continued.decisions).toHaveLength(1);
  expect(continued.decisions[0]!.key).toBe(second.decisions[0]!.key);
  expect(continued.decisions[0]!.alternatives.map(a=>a.object)).toContain(f.put("TWO"));
  const again = await f.run(f.request(continued.authored!, f.tree({"a.txt":"prefix TW suffix\n"}), [
    {key:"delete",kind:"editSource",source:f.ref("/a.txt","prefix TWO suffix\n",[9,10]),text:""}
  ], "fourth", continued.result));
  expect(again.decisions).toHaveLength(1);
  expect(again.decisions[0]!.key).toBe(second.decisions[0]!.key);
  expect(again.decisions[0]!.alternatives.map(a=>a.object)).toContain(f.put("TW"));
  expect(again.result.object).toBe(first.result.object);
});

test("an independent second content conflict stays scoped", async () => {
  const f = new Fixture(), text = "old gap red\n", base = f.tree({"a.txt":text});
  const a = await f.run(f.request(base,f.tree({"a.txt":"one gap red\n"}),[{key:"e",kind:"editSource",source:f.ref("/a.txt",text,[0,3]),text:"one"}],"a"));
  const b = await f.run(f.request(base,f.tree({"a.txt":"two gap red\n"}),[{key:"e",kind:"editSource",source:f.ref("/a.txt",text,[0,3]),text:"two"}],"b",a.result));
  const c = await f.run(f.request(b.result,f.tree({"a.txt":"two gap tan\n"}),[{key:"e",kind:"editSource",source:f.ref("/a.txt","two gap red\n",[8,11]),text:"tan"}],"c"));
  const d = await f.run(f.request(b.result,f.tree({"a.txt":"two gap sky\n"}),[{key:"e",kind:"editSource",source:f.ref("/a.txt","two gap red\n",[8,11]),text:"sky"}],"d",c.result));
  expect(d.decisions).toHaveLength(2);
  expect(d.decisions[1]!.subject?.range).toEqual([8,11]);
  expect(d.decisions[1]!.dependencies).toEqual([]);
  expect(d.decisions[1]!.alternatives.map(a=>a.object).sort()).toEqual([f.put("tan"),f.put("sky")].sort());
});

test("splitting a source choice stays within its file and does not conflict with an unrelated file", async () => {
  const f = new Fixture(), text = "red blue tail\n", base = f.tree({"a.txt":text,"other.txt":"X"});
  const a = await f.run(f.request(base,f.tree({"a.txt":"RED BLUE tail\n","other.txt":"X"}),[{key:"e",kind:"editSource",source:f.ref("/a.txt",text,[0,8]),text:"RED BLUE"}],"a"));
  const source = "tan cyan tail\n";
  const b = await f.run(f.request(base,f.tree({"a.txt":source,"other.txt":"X"}),[{key:"e",kind:"editSource",source:f.ref("/a.txt",text,[0,8]),text:"tan cyan"}],"b",a.result));
  const peer = await f.run(f.request(b.result,f.tree({"a.txt":source,"other.txt":"Y"}),[{key:"e",kind:"editSource",source:f.ref("/other.txt","X"),text:"Y"}],"peer"));
  const result = await f.run(f.request(b.result,f.tree({"a.txt":"cyan tail tan\n","other.txt":"X"}),[{
    key:"reorder",kind:"editSource",source:f.ref("/a.txt",source),text:"cyan tail tan\n",lineage:[
      {range:[0,9],source:f.ref("/a.txt",source,[4,13])},
      {range:[10,13],source:f.ref("/a.txt",source,[0,3])},
      {range:[13,14],source:f.ref("/a.txt",source,[13,14])},
    ]
  }],"reorder",peer.result));
  expect(result.decisions).toHaveLength(2);
  expect(result.decisions.every(d=>d.kind==="content")).toBe(true);
  expect(f.content(result.result.object,"other.txt")).toBe("Y");
  expect(f.content(result.result.object,"a.txt")).toBe("cyan tail tan\n");
});


test("nested enclosures retain readable alternatives as a source branch advances", async () => {
  const f = new Fixture();
  const tree = (a: string, b = "end", c = "end") =>
    f.tree({ "a.txt": a, "b.txt": b, "c.txt": c });
  const edit = (before: string, after: string): SourceOperation[] => [{
    key: "edit", kind: "editSource", source: f.ref("/a.txt", before), text: after,
  }];
  const base = tree("old");
  const a = await f.run(f.request(base, tree("one"), edit("old", "one"), "a"));
  const b = await f.run(f.request(base, tree("two"), edit("old", "two"), "b", a.result));
  const copied = await f.run(f.request(b.result, tree("two", "endwo"), [{
    key: "copy", kind: "copySource", source: f.ref("/a.txt", "two", [1, 3]),
    at: f.ref("/b.txt", "end", [3, 3]), side: "after",
  }], "copy"));
  const twice = await f.run(f.request(copied.result, tree("two", "endwo", "endwo"), [{
    key: "copy", kind: "copySource", source: f.ref("/a.txt", "two", [1, 3]),
    at: f.ref("/c.txt", "end", [3, 3]), side: "after",
  }], "copy2"));
  const objects = { read: async (hash: string) => f.objects.get(hash)!, store: async () => {} };
  await validateIntentState(twice.result, "tree", objects);
  // Both enclosing decisions can alias the same root. Updating the nested
  // choice must not leave either newly recorded context with a stale alias.
  const edited = await f.run(f.request(twice.result, tree("THREE", "endwo", "endwo"),
    edit("two", "THREE"), "later"));
  expect(f.content(edited.result.object, "a.txt")).toBe("THREE");
  expect(edited.decisions.map(d => d.key)).toEqual(twice.decisions.map(d => d.key));
  await validateIntentState(edited.result, "tree", objects);
  const next = await f.run(f.request(edited.result, tree("FOUR", "endwo", "endwo"),
    edit("THREE", "FOUR"), "again"));
  expect(f.content(next.result.object, "a.txt")).toBe("FOUR");
  expect(next.decisions.map(d => d.key)).toEqual(edited.decisions.map(d => d.key));
});
test("later edits follow a selected deletion's anchor without enclosing it", async () => {
  const f = new Fixture(),
    text = "intro\n\nblock one\n\ntail\n",
    base = f.tree({ "p.md": text });
  const remote = await f.run(
    f.request(
      base,
      f.tree({ "p.md": "intro\n\nblock ONE\n\ntail\n" }),
      [{ key: "edit", kind: "editSource", source: f.ref("/p.md", text, [13, 16]), text: "ONE" }],
      "remote",
    ),
  );
  let previous = await f.run(
    f.request(
      base,
      f.tree({ "p.md": "intro\n\ntail\n" }),
      [{ key: "delete", kind: "editSource", source: f.ref("/p.md", text, [7, 18]), text: "" }],
      "local",
      remote.result,
    ),
  );
  expect(previous.decisions).toHaveLength(1);
  const decision = previous.decisions[0]!;
  expect(decision.context).toBeUndefined();
  let current = "intro\n\ntail\n",
    anchor = decision.placement!.anchor;
  // Before the anchor, after it, and before it again.
  for (const [index, at] of [0, current.length, 0].entries()) {
    const insert = `M${index}\n`,
      next = current.slice(0, at) + insert + current.slice(at);
    const r = await f.run(
      f.request(
        previous.result,
        f.tree({ "p.md": next }),
        [{ key: "insert", kind: "editSource", source: f.ref("/p.md", current, [at, at]), text: insert }],
        `local-${index}`,
      ),
    );
    if (at < anchor) anchor += insert.length;
    expect(r.decisions.map((d) => d.key)).toEqual([decision.key]);
    expect(r.decisions[0]!.context).toBeUndefined();
    expect(r.decisions[0]!.placement!.anchor).toBe(anchor);
    expect(await f.content(r.result.object, "p.md")).toBe(next);
    previous = r;
    current = next;
  }
});
test.each(["edit-first", "delete-first"])(
  "a deletion never cuts into the selected side of its own choice (%s)",
  async (order) => {
    const f = new Fixture(),
      text = "intro\n\nblock one\n\ntail\n",
      base = f.tree({ "p.md": text });
    const edit = { key: "edit", kind: "editSource" as const, source: f.ref("/p.md", text, [13, 16]), text: "ONE" },
      remove = { key: "delete", kind: "editSource" as const, source: f.ref("/p.md", text, [7, 18]), text: "" },
      edited = f.tree({ "p.md": "intro\n\nblock ONE\n\ntail\n" }),
      removed = f.tree({ "p.md": "intro\n\ntail\n" });
    const [first, second] = order === "edit-first"
      ? [{ ops: [edit], tree: edited }, { ops: [remove], tree: removed }]
      : [{ ops: [remove], tree: removed }, { ops: [edit], tree: edited }];
    const current = await f.run(f.request(base, first.tree, first.ops, "first"));
    const r = await f.run(f.request(base, second.tree, second.ops, "second", current.result));
    expect(r.decisions).toHaveLength(1);
    const decision = r.decisions[0]!,
      selected = decision.alternatives[decision.selected]!;
    const projected = await f.content(r.result.object, "p.md");
    // The page is exactly the base with the selected side in the choice's range.
    expect([
      "intro\n\nblock ONE\n\ntail\n",
      "intro\n\ntail\n",
    ]).toContain(projected);
    expect(selected.object).toBe(f.put(projected === "intro\n\ntail\n" ? "" : "block ONE\n\n"));
    expect(decision.context).toBeUndefined();
  },
);
