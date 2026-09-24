import { describe, expect, test } from "bun:test";
import { encodeWireDirectory, hashObject, type MaterialRef, type SourceOperation } from "@overstory/protocol";
import { composeFrames, executeExactSourceEdits, validateSourceEditCandidate, validateSourceTrace, UnsupportedSourceEdit } from "../../support/source-edits.ts";

function fixture(text: string, nested = false) {
  const bytes = new TextEncoder().encode(text), file = hashObject(bytes);
  const leaf = encodeWireDirectory({ type: "directory", entries: [{ name: "note.md", file }] });
  const directory = hashObject(leaf);
  const rootBytes = nested ? encodeWireDirectory({ type: "directory", entries: [{ name: "folder", directory }, { name: "peer", tree: "other-tree" }] }) : leaf;
  const root = hashObject(rootBytes), objects = new Map([[file, bytes], [directory, leaf], [root, rootBytes]]);
  const ref = (range?: [number, number]): MaterialRef => ({ material: { kind: "basis", path: nested ? "/folder/note.md" : "/note.md", object: file }, ...(range ? { range } : {}) });
  const edit = (key: string, range: [number, number], text: string): SourceOperation => ({ key, kind: "editSource", source: ref(range), text });
  const load = async (hash: string) => { const value = objects.get(hash); if (!value) throw Error("Object missing"); return value; };
  return { root, file, directory, objects, ref, edit, load };
}

describe("exact authored source execution", () => {
  test("reconstructs independent edits against unchanged basis coordinates and preserves neighboring boundaries", async () => {
    const base = fixture("alpha beta gamma\r\n", true);
    const result = await executeExactSourceEdits(base.root, [base.edit("last", [11, 16], "G"), base.edit("first", [0, 5], "A")], base.load);
    expect(result.root).toBe(fixture("A beta G\r\n", true).root);
    expect(result.evidence.map(e => e.operation)).toEqual(["last", "first"]);
    expect(result.evidence[0]!.source).toEqual({ object: base.file, range: [11, 16] });
  });
  test("equal file objects at different paths do not imply one material identity", async () => {
    const bytes = new TextEncoder().encode("same"), file = hashObject(bytes);
    const rootBytes = encodeWireDirectory({ type: "directory", entries: [{ name: "a.md", file }, { name: "b.md", file }] });
    const root = hashObject(rootBytes), objects = new Map([[root, rootBytes], [file, bytes]]);
    const changed = new TextEncoder().encode("new");
    const expected = hashObject(encodeWireDirectory({ type: "directory", entries: [{ name: "a.md", file: hashObject(changed) }, { name: "b.md", file }] }));
    const result = await validateSourceEditCandidate(root, expected, [{ key: "edit", kind: "editSource", source: { material: { kind: "basis", path: "/a.md", object: file } }, text: "new" }], async hash => objects.get(hash)!);
    expect(result.evidence[0]!.path).toBe("/a.md");
  });
  test("candidate verification rejects unexplained source changes", async () => {
    const base = fixture("abc");
    await expect(validateSourceEditCandidate(base.root, fixture("aXc!").root, [base.edit("edit", [1, 2], "X")], base.load)).rejects.toThrow("do not explain candidate");
    expect((await validateSourceEditCandidate(base.root, fixture("aXc").root, [base.edit("edit", [1, 2], "X")], base.load)).root).toBe(fixture("aXc").root);
  });
  test("emoji and combining marks use UTF-8 coordinates without normalization", async () => {
    const base = fixture("😀é");
    expect((await executeExactSourceEdits(base.root, [base.edit("emoji", [0, 4], "🙂")], base.load)).root).toBe(fixture("🙂é").root);
  });
  test("insertion, deletion, full replacement and unchanged bytes preserve exact source", async () => {
    for (const [source, range, text, expected] of [
      ["abc", [1, 1], "X", "aXbc"], ["abc", [1, 2], "", "ac"],
      ["\ufeff---\r\nx: 1\r\n---\r\n😀é\r\n", [0, 0], "", "\ufeff---\r\nx: 1\r\n---\r\n😀é\r\n"],
      ["abc", [0, 3], "abc", "abc"],
    ] as Array<[string, [number, number], string, string]>) {
      const base = fixture(source);
      const result = await executeExactSourceEdits(base.root, [base.edit("edit", range, text)], base.load);
      expect(result.root).toBe(fixture(expected).root);
      expect(result.evidence).toHaveLength(1); // Equal bytes do not erase authored provenance.
    }
  });
  test("verifies preserved lineage while retaining new replacement text", async () => {
    const base = fixture("abc");
    const result = await executeExactSourceEdits(base.root, [{ ...base.edit("wrap", [0, 3], "[abc]"), lineage: [{ source: base.ref([0, 3]), range: [1, 4] }] } as SourceOperation], base.load);
    expect(result.root).toBe(fixture("[abc]").root);
    expect(result.evidence[0]!.lineage[0]!.source.object).toBe(base.file);
    await expect(executeExactSourceEdits(base.root, [{ ...base.edit("lie", [0, 3], "xyz"), lineage: [{ source: base.ref([0, 3]), range: [0, 3] }] } as SourceOperation], base.load)).rejects.toThrow("lineage changes bytes");
  });
  test("directory material with within selectors resolves the guarded object first", async () => {
    const base = fixture("abc", true);
    const source: MaterialRef = { material: { kind: "basis", path: "/", object: base.root }, within: ["folder", "note.md"], range: [1, 2] };
    const result = await executeExactSourceEdits(base.root, [{ key: "edit", kind: "editSource", source, text: "B" }], base.load);
    expect(result.root).toBe(fixture("aBc", true).root);
  });
  test("rejects invalid UTF-8 boundaries, object guards, paths, and corrupt objects", async () => {
    const base = fixture("😀é");
    for (const range of [[1, 4], [0, 2], [0, 99], [-1, 0]] as [number, number][]) {
      await expect(executeExactSourceEdits(base.root, [base.edit("bad", range, "x")], base.load)).rejects.toThrow();
    }
    for (const source of [
      { material: { kind: "basis", path: "/note.md", object: base.root } },
      { material: { kind: "basis", path: "/absent.md", object: base.file } },
      { material: { kind: "basis", path: "/../note.md", object: base.file } },
    ] as MaterialRef[]) await expect(executeExactSourceEdits(base.root, [{ key: "bad", kind: "editSource", source, text: "x" }], base.load)).rejects.toThrow();
    await expect(executeExactSourceEdits(base.root, [base.edit("bad", [0, 4], "x")], async () => new Uint8Array([1]))).rejects.toThrow("hash mismatch");
  });
  test("does not traverse another tree or pretend to execute retained-result references", async () => {
    const base = fixture("abc", true);
    for (const source of [
      { material: { kind: "basis", path: "/peer/note.md", object: base.file } },
      { material: { kind: "operation", change: "earlier", operation: "output" } },
    ] as MaterialRef[]) await expect(executeExactSourceEdits(base.root, [{ key: "bad", kind: "editSource", source, text: "x" }], base.load)).rejects.toThrow();
  });
  test("overlap and same-anchor inserts remain unsupported rather than losing one contribution", async () => {
    const base = fixture("abc");
    for (const edits of [[base.edit("a", [0, 2], "x"), base.edit("b", [1, 3], "y")], [base.edit("a", [1, 1], "x"), base.edit("b", [1, 1], "y")]]) {
      await expect(executeExactSourceEdits(base.root, edits, base.load)).rejects.toBeInstanceOf(UnsupportedSourceEdit);
    }
  });
});

describe("authored source traces", () => {
  /** Two files, so frames can touch disjoint paths. */
  function pair(a: string, b: string) {
    const bytesA = new TextEncoder().encode(a), fileA = hashObject(bytesA);
    const bytesB = new TextEncoder().encode(b), fileB = hashObject(bytesB);
    const rootBytes = encodeWireDirectory({ type: "directory", entries: [{ name: "a.md", file: fileA }, { name: "b.md", file: fileB }] });
    const root = hashObject(rootBytes);
    const objects = new Map([[fileA, bytesA], [fileB, bytesB], [root, rootBytes]]);
    return { root, fileA, fileB, objects };
  }
  const edit = (key: string, path: string, object: string, range: [number, number], text: string): Extract<SourceOperation, { kind: "editSource" }> =>
    ({ key, kind: "editSource", source: { material: { kind: "basis", path, object }, range }, text });

  test("each frame reproduces its own result and generated objects carry forward", async () => {
    const start = pair("abc", "xyz"), objects = new Map(start.objects);
    const load = async (hash: string) => { const value = objects.get(hash); if (!value) throw Error("Object missing"); return value; };
    const first = await validateSourceEditCandidate(
      start.root,
      (await executeExactSourceEdits(start.root, [edit("a", "/a.md", start.fileA, [0, 1], "A")], load)).root,
      [edit("a", "/a.md", start.fileA, [0, 1], "A")],
      load,
    );
    for (const [hash, bytes] of first.generated) objects.set(hash, bytes);
    const middle = first.root;
    const second = await executeExactSourceEdits(middle, [edit("b", "/b.md", start.fileB, [0, 1], "X")], load);
    for (const [hash, bytes] of second.generated) objects.set(hash, bytes);
    // The trace validates from the original objects alone: frame two reads the
    // material frame one generated.
    const fresh = new Map(start.objects);
    const trace = await validateSourceTrace(
      [
        { before: start.root, after: middle, operations: [edit("a", "/a.md", start.fileA, [0, 1], "A")] },
        { before: middle, after: second.root, operations: [edit("b", "/b.md", start.fileB, [0, 1], "X")] },
      ],
      async hash => { const value = fresh.get(hash); if (!value) throw Error("Object missing"); return value; },
    );
    expect(trace.root).toBe(second.root);
    expect(trace.evidence.map(e => e.operation)).toEqual(["a", "b"]);
  });

  test("a broken chain, a wrong result, an empty frame and a reused key are rejected", async () => {
    const start = pair("abc", "xyz"), objects = new Map(start.objects);
    const load = async (hash: string) => { const value = objects.get(hash); if (!value) throw Error("Object missing"); return value; };
    const a = edit("a", "/a.md", start.fileA, [0, 1], "A");
    const b = edit("b", "/b.md", start.fileB, [0, 1], "X");
    const middle = (await executeExactSourceEdits(start.root, [a], load)).root;
    for (const [hash, bytes] of (await executeExactSourceEdits(start.root, [a], load)).generated) objects.set(hash, bytes);
    const end = (await executeExactSourceEdits(middle, [b], load)).root;
    const frames = [
      { before: start.root, after: middle, operations: [a] },
      { before: middle, after: end, operations: [b] },
    ];
    await expect(validateSourceTrace([], load)).rejects.toThrow("trace has no frames");
    await expect(validateSourceTrace([frames[0]!, { ...frames[1]!, before: start.root }], load)).rejects.toThrow("does not follow its basis");
    await expect(validateSourceTrace([{ ...frames[0]!, after: start.root }, frames[1]!], load)).rejects.toThrow("do not explain candidate");
    await expect(validateSourceTrace([frames[0]!, { ...frames[1]!, operations: [] }], load)).rejects.toThrow("carries no operations");
    await expect(validateSourceTrace([frames[0]!, { ...frames[1]!, operations: [{ ...b, key: "a" }] }], load)).rejects.toThrow("duplicate operation key");
  });

  test("disjoint frames compose into one frame keyed in output order", async () => {
    const start = pair("abc", "xyz"), objects = new Map(start.objects);
    const load = async (hash: string) => { const value = objects.get(hash); if (!value) throw Error("Object missing"); return value; };
    const a = edit("a", "/a.md", start.fileA, [0, 1], "A");
    const b = edit("b", "/b.md", start.fileB, [0, 1], "X");
    const first = await executeExactSourceEdits(start.root, [a], load);
    for (const [hash, bytes] of first.generated) objects.set(hash, bytes);
    const second = await executeExactSourceEdits(first.root, [b], load);
    for (const [hash, bytes] of second.generated) objects.set(hash, bytes);
    const frames = [
      { before: start.root, after: first.root, operations: [a] },
      { before: first.root, after: second.root, operations: [b] },
    ];
    const composed = await composeFrames(frames, load);
    expect(composed.before).toBe(start.root);
    expect(composed.after).toBe(second.root);
    expect(composed.operations.map(o => o.key)).toEqual(["edit-0-0", "edit-0-1"]);
    expect(composed.operations.map(o => o.kind === "editSource" && o.source.material.kind === "basis" && o.source.material.path)).toEqual(["/a.md", "/b.md"]);
    expect((await validateSourceEditCandidate(composed.before, composed.after, composed.operations, load)).root).toBe(second.root);
    expect(await composeFrames([frames[0]!], load)).toBe(frames[0]!);
    // Lineage names the generation it was captured against and is never rebased.
    const preserved: SourceOperation = { key: "b2", kind: "editSource", source: b.source, text: "y",
      lineage: [{ source: { material: { kind: "basis", path: "/b.md", object: start.fileB }, range: [1, 2] }, range: [0, 1] }] };
    await expect(composeFrames([frames[0]!, { ...frames[1]!, operations: [preserved] }], load)).rejects.toBeInstanceOf(UnsupportedSourceEdit);
  });

  test("a second edit of the same file composes by range over the first, without its bytes", async () => {
    const start = pair("Before plant", "xyz"), objects = new Map(start.objects);
    const load = async (hash: string) => { const value = objects.get(hash); if (!value) throw Error("Object missing"); return value; };
    const g1 = [edit("edit-0-0", "/a.md", start.fileA, [0, 6], "After")];
    const first = await executeExactSourceEdits(start.root, g1, load);
    for (const [hash, bytes] of first.generated) objects.set(hash, bytes);
    const middle = hashObject(new TextEncoder().encode("After plant"));
    // Edit inside the first generation's insertion and append at the end.
    const g2 = [edit("edit-1-0", "/a.md", middle, [1, 3], "FT"), edit("edit-1-1", "/a.md", middle, [11, 11], "!")];
    const second = await executeExactSourceEdits(first.root, g2, load);
    for (const [hash, bytes] of second.generated) objects.set(hash, bytes);
    expect(second.root).toBe(pair("AFTer plant!", "xyz").root);
    const composed = await composeFrames([
      { before: start.root, after: first.root, operations: g1 },
      { before: first.root, after: second.root, operations: g2 },
    ], load);
    expect(composed.operations).toEqual([
      edit("edit-0-0", "/a.md", start.fileA, [0, 6], "AFTer"),
      edit("edit-0-1", "/a.md", start.fileA, [12, 12], "!"),
    ]);
    expect((await validateSourceEditCandidate(composed.before, composed.after, composed.operations, load)).root).toBe(second.root);
    // Typing and deleting it again composes to nothing: the chain is a no-op frame.
    const undone = await composeFrames([
      { before: start.root, after: first.root, operations: g1 },
      { before: first.root, after: start.root, operations: [edit("edit-1-0", "/a.md", middle, [0, 5], "Before")] },
    ], load);
    expect(undone.operations).toEqual([]);
    expect(undone.before).toBe(undone.after);
  });
});
