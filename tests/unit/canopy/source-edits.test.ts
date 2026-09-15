import { describe, expect, test } from "bun:test";
import { encodeWireDirectory, hashObject, type MaterialRef, type SourceOperation } from "@arbor/wire";
import { executeExactSourceEdits, validateSourceEditCandidate, UnsupportedSourceEdit } from "../../../packages/canopy/src/updates/source-edits.ts";

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
