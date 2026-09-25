import { expect, test } from "bun:test";
import { encodeProtocolDirectory, hashObject, type Hash, type ProtocolDirectory } from "@overstory/protocol";
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
