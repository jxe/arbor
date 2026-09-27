import { expect, test } from "bun:test";
import { encodeProtocolDirectory, hashObject, markdownStableKey, type Hash, type ProtocolDirectory } from "@overstory/protocol";
import { collectionChildSetHash } from "@overstory/collection-schema";
import { ProtocolProjection } from "../../../packages/canopyd/src/projection.ts";

function store() {
  const objects = new Map<string, Uint8Array>();
  const put = (bytes: Uint8Array) => { const hash = hashObject(bytes); objects.set(hash, bytes); return hash; };
  const text = (value: string) => put(new TextEncoder().encode(value));
  const directory = (value: ProtocolDirectory) => put(encodeProtocolDirectory(value));
  return { objects, text, directory, load: async (hash: string) => objects.get(hash)! };
}

test("projects declarative collection rows with their undeclared members, and a schema.ts is an ordinary file", async () => {
  const f = store();
  const schema = 'overstory-schema-version = 1\noverstory-primary-key = ["id"]\noverstory-child-name = "slug"\nrow = { id: tstr, slug: tstr }\n';
  const rows = [{ id: "1", slug: "first", note: { kept: [null] } }];
  const current = f.directory({
    type: "directory",
    entries: [{ name: "_store.json", file: f.text(JSON.stringify(rows)) }, { name: "schema.cddl", file: f.text(schema) }],
    childrenSource: {
      version: 1, type: "collection-file", format: "json", source: "_store.json", schemaSource: "schema.cddl",
      schemaFingerprint: hashObject(new TextEncoder().encode(schema)) as Hash,
      childSetHash: collectionChildSetHash([{ key: '[["id","1"]]', name: "first", properties: rows[0] }]),
    },
  });
  const scripts = f.directory({ type: "directory", entries: [{ name: "schema.ts", file: f.text("export const schema = {};\n") }] });
  const root = f.directory({ type: "directory", entries: [{ name: "people", directory: current }, { name: "scripts", directory: scripts }] });
  const projection = new ProtocolProjection({ root, load: f.load });
  expect(await projection.resolve("/people/first")).toMatchObject({
    kind: "collection-file-row",
    path: "/people/first",
    row: { properties: { id: "1", slug: "first", note: { kept: [null] } } },
  });
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
