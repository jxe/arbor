import { describe, expect, test } from "bun:test";
import { mergeProtocolTrees } from "@ovst/tree-merge";
import {
  decodeProtocolDirectory,
  decodeProtocolPage,
  encodeProtocolDirectory,
  encodeProtocolPage,
  hashObject,
  pageDate,
  parsePage,
  type ObjectHash,
  type PageProperty,
  type ProtocolDirectoryEntry,
} from "@ovst/protocol";

const objects = new Map<string, Uint8Array>();
const load = async (hash: ObjectHash) => {
  const bytes = objects.get(hash);
  if (!bytes) throw new Error(`missing ${hash}`);
  return bytes;
};
const put = (bytes: Uint8Array) => {
  const hash = hashObject(bytes);
  objects.set(hash, bytes);
  return hash;
};
const encoder = new TextEncoder(), decoder = new TextDecoder();
const file = (text: string) => put(encoder.encode(text));
const page = (properties: PageProperty[], body: string, id?: string) =>
  put(encodeProtocolPage({ type: "page", ...(id ? { id } : {}), properties, body: encoder.encode(body) }));
const dir = (entries: ProtocolDirectoryEntry[]) => put(encodeProtocolDirectory({
  type: "directory",
  entries: entries.sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name))),
}));
const merge = async (base: ObjectHash, candidate: ObjectHash, current: ObjectHash) => {
  const result = await mergeProtocolTrees(base, candidate, current, load);
  for (const [hash, bytes] of result.objects) objects.set(hash, bytes);
  return result;
};
const only = async (root: ObjectHash) => decodeProtocolDirectory(await load(root)).entries[0]!;
const pageAt = async (root: ObjectHash) => {
  const entry = await only(root);
  expect(entry.page).toBeDefined();
  return decodeProtocolPage(await load(entry.page!));
};

describe("page-properties-v1", () => {
  test("two sides' properties and body edits all merge", async () => {
    const base = dir([{ name: "a.md", page: page([["title", "A"], ["status", "draft"]], "One\nTwo\n", "p1") }]);
    const candidate = dir([{ name: "a.md", page: page([["title", "A2"], ["status", "draft"], ["tags", ["x"]]], "One\nTwo\nThree\n", "p1") }]);
    const current = dir([{ name: "a.md", page: page([["title", "A"], ["status", "done"]], "Zero\nOne\nTwo\n", "p1") }]);
    const result = await merge(base, candidate, current);
    expect(result.conflicts).toEqual([]);
    expect(result.properties).toBeUndefined();
    expect(result.summary).toEqual({ version: "page-properties-v1", mergedPages: 1, approximatePlacements: 0 });
    const merged = await pageAt(result.root);
    expect(merged.id).toBe("p1");
    expect(merged.properties).toEqual([["title", "A2"], ["status", "done"], ["tags", ["x"]]]);
    expect(decoder.decode(merged.body)).toBe("Zero\nOne\nTwo\nThree\n");
  });

  test("one property both sides set differently keeps current's value for a decision", async () => {
    const base = dir([{ name: "a.md", page: page([["status", "draft"], ["owner", "jo"]], "Body\n") }]);
    const candidate = dir([{ name: "a.md", page: page([["status", "review"], ["owner", "jo"]], "Body\n") }]);
    const current = dir([{ name: "a.md", page: page([["status", "done"], ["owner", "kim"]], "Body\n") }]);
    const result = await merge(base, candidate, current);
    expect(result.conflicts).toEqual([]);
    expect(result.properties).toEqual([{ path: "/a.md", property: "status", current: "done", candidate: "review" }]);
    expect((await pageAt(result.root)).properties).toEqual([["status", "done"], ["owner", "kim"]]);
  });

  test("a list both sides changed merges member by member", async () => {
    const base = dir([{ name: "a.md", page: page([["tags", ["a", "b"]]], "") }]);
    const candidate = dir([{ name: "a.md", page: page([["tags", ["a", "b", "c"]]], "") }]);
    const current = dir([{ name: "a.md", page: page([["tags", ["b"]]], "") }]);
    const result = await merge(base, candidate, current);
    expect((await pageAt(result.root)).properties).toEqual([["tags", ["b", "c"]]]);
  });

  test("a timestamp and its string are different values", async () => {
    const base = dir([{ name: "a.md", page: page([["due", pageDate("2026-10-28")]], "") }]);
    const candidate = dir([{ name: "a.md", page: page([["due", "2026-10-28"]], "") }]);
    const current = dir([{ name: "a.md", page: page([["due", pageDate("2026-10-29")]], "") }]);
    const result = await merge(base, candidate, current);
    expect(result.properties?.map((p) => p.property)).toEqual(["due"]);
  });
});

describe("converting to pages", () => {
  const source = "---\nid: p1\ntitle: \"A\"\n---\nBody\n";

  test("a file replaced by the page it reads as is no change to merge", async () => {
    const converted = page([["title", "A"]], "Body\n", "p1");
    expect(converted).toBe(put(encodeProtocolPage(parsePage(encoder.encode(source))!)));
    const base = dir([{ name: "a.md", file: file(source) }, { name: "b.txt", file: file("b") }]);
    const candidate = dir([{ name: "a.md", page: converted }, { name: "b.txt", file: file("b") }]);
    const current = dir([{ name: "a.md", file: file(source) }, { name: "b.txt", file: file("b2") }]);
    const result = await merge(base, candidate, current);
    expect(result.conflicts).toEqual([]);
    expect(result.root).toBe(dir([{ name: "a.md", page: converted }, { name: "b.txt", file: file("b2") }]));
  });

  test("a conversion meeting a concurrent edit keeps the edit, as a page", async () => {
    const base = dir([{ name: "a.md", file: file(source) }]);
    const candidate = dir([{ name: "a.md", page: page([["title", "A"]], "Body\n", "p1") }]);
    const current = dir([{ name: "a.md", file: file("---\nid: p1\ntitle: B\n---\nBody\nMore\n") }]);
    const result = await merge(base, candidate, current);
    expect(result.conflicts).toEqual([]);
    const merged = await pageAt(result.root);
    expect(merged.properties).toEqual([["title", "B"]]);
    expect(decoder.decode(merged.body)).toBe("Body\nMore\n");
  });

  test("an edit from a writer that has not converted lands as a page", async () => {
    const base = dir([{ name: "a.md", file: file(source) }]);
    const candidate = dir([{ name: "a.md", file: file("---\nid: p1\ntitle: A\n---\nBody\nMore\n") }]);
    const current = dir([{ name: "a.md", page: page([["title", "A"]], "Body\n", "p1") }]);
    const result = await merge(base, candidate, current);
    expect(result.conflicts).toEqual([]);
    expect(decoder.decode((await pageAt(result.root)).body)).toBe("Body\nMore\n");
  });

  test("a page renamed on one side and edited on the other meets by id", async () => {
    const base = dir([{ name: "a.md", page: page([["title", "A"]], "Body\n", "p1") }]);
    const candidate = dir([{ name: "b.md", page: page([["title", "A"]], "Body\n", "p1") }]);
    const current = dir([{ name: "a.md", page: page([["title", "A2"]], "Body\n", "p1") }]);
    const result = await merge(base, candidate, current);
    expect(result.conflicts).toEqual([]);
    const entry = await only(result.root);
    expect(entry.name).toBe("b.md");
    expect((await pageAt(result.root)).properties).toEqual([["title", "A2"]]);
  });
});
