import { expect, test } from "bun:test";
import { encodeProtocolDirectory, hashObject, markdownStableKey, type ProtocolDirectory } from "@ovst/protocol";
import { collectionDirectory, idRow } from "../../support/collection-trees.ts";
import { ProtocolProjection } from "../../../packages/overstoryd/src/projection.ts";

function store() {
  const objects = new Map<string, Uint8Array>();
  const put = (bytes: Uint8Array) => { const hash = hashObject(bytes); objects.set(hash, bytes); return hash; };
  const text = (value: string) => put(new TextEncoder().encode(value));
  const directory = (value: ProtocolDirectory) => put(encodeProtocolDirectory(value));
  return { objects, text, directory, load: async (hash: string) => objects.get(hash)! };
}

test("projects a collection's rows as children: the main model's under the folder, others under their model, and a schema.ts is an ordinary file", async () => {
  const f = store();
  const schema = "main model Item {\n  slug path Text\n  note Text?\n}\n\nmodel Tag {\n  label Text\n}\n";
  const current = collectionDirectory(schema, {
    Item: [idRow("1", { slug: "first", note: "kept" })],
    Tag: [idRow("t1", { label: "Red" })],
  }, f.objects);
  const scripts = f.directory({ type: "directory", entries: [{ name: "schema.ts", file: f.text("export const schema = {};\n") }] });
  const root = f.directory({ type: "directory", entries: [{ name: "people", directory: current }, { name: "scripts", directory: scripts }] });
  const projection = new ProtocolProjection({ root, load: f.load });
  expect(await projection.resolve("/people/first")).toMatchObject({
    kind: "collection-row",
    path: "/people/first",
    row: { model: "Item", properties: { id: "1", slug: "first", note: "kept" } },
  });
  expect(await projection.resolve("/people/Tag")).toMatchObject({ kind: "collection-table", path: "/people/Tag" });
  expect(await projection.resolve("/people/Tag/t1")).toMatchObject({ kind: "collection-row", row: { model: "Tag", properties: { id: "t1", label: "Red" } } });
  expect(await projection.resolve("/scripts/schema.ts")).toMatchObject({ kind: "node", node: { kind: "file" } });
});

test("stable-key healing reads each directory once and only Markdown files", async () => {
  const f = store();
  const page = (id: string) => f.text(`---\nid: ${id}\n---\n\n# ${id}\n`);
  const image = f.text("---\nid: image\n---\n");
  const deep = f.directory({ type: "directory", entries: [{ name: "moved.md", file: page("moved") }, { name: "photo.png", file: image }] });
  const section = f.directory({ type: "directory", entries: [{ name: "_index.md", file: page("section") }, { name: "deep", directory: deep }] });
  const root = f.directory({ type: "directory", entries: [
    { name: "a.md", file: page("a") }, { name: "photo.png", file: image },
    { name: "section", directory: section }, { name: "section.md", file: page("shadowed") },
  ] });
  const reads = new Map<string, number>();
  const load = async (hash: string) => { reads.set(hash, (reads.get(hash) ?? 0) + 1); return f.objects.get(hash)!; };
  const projection = new ProtocolProjection({ root, load });
  expect(await projection.resolve("/gone", markdownStableKey("moved"))).toMatchObject({ kind: "node", path: "/section/deep/moved", node: { kind: "file", objectName: "moved.md" } });
  expect(reads.get(image)).toBeUndefined();
  expect(reads.get(section)).toBe(1);
  expect(reads.get(deep)).toBe(1);
  expect(await projection.resolve("/gone", markdownStableKey("section"))).toMatchObject({ kind: "node", path: "/section", node: { kind: "directory", bodyOrigin: "index", shadowedBody: true } });
  expect(await projection.resolve("/gone", markdownStableKey("shadowed"))).toEqual({ kind: "missing", path: "/gone" });
  expect(await projection.resolve("/gone", markdownStableKey("image"))).toEqual({ kind: "missing", path: "/gone" });
  expect(await projection.resolve("/photo.png", markdownStableKey("image"))).toEqual({ kind: "missing", path: "/photo.png" });
});
