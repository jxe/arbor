import { expect, test } from "bun:test";
import { encodeProtocolDirectory, hashObject, type Hash, type ProtocolDirectory } from "@overstory/protocol";
import { collectionChildSetHash, ProtocolCollectionFileError } from "@overstory/collection-schema";
import { ProtocolProjection } from "../../../packages/canopyd/src/projection.ts";

function store() {
  const objects = new Map<string, Uint8Array>();
  const put = (bytes: Uint8Array) => { const hash = hashObject(bytes); objects.set(hash, bytes); return hash; };
  const text = (value: string) => put(new TextEncoder().encode(value));
  const directory = (value: ProtocolDirectory) => put(encodeProtocolDirectory(value));
  return { objects, text, directory, load: async (hash: string) => objects.get(hash)! };
}

test("projects declarative collection rows and refuses to interpret a retired schema.ts collection", async () => {
  const f = store();
  const schema = 'overstory-schema-version = 1\noverstory-primary-key = ["id"]\noverstory-child-name = "slug"\nrow = { id: tstr, slug: tstr }\n';
  const rows = [{ id: "1", slug: "first" }];
  const current = f.directory({
    type: "directory",
    entries: [{ name: "_store.json", file: f.text(JSON.stringify(rows)) }, { name: "schema.cddl", file: f.text(schema) }],
    childrenSource: {
      version: 2, type: "collection-file", format: "json", source: "_store.json", schemaSource: "schema.cddl",
      schemaFingerprint: hashObject(new TextEncoder().encode(schema)) as Hash,
      childSetHash: collectionChildSetHash([{ key: '[["id","1"]]', name: "first", properties: rows[0] }]),
    },
  });
  const legacySource = 'import { z } from "zod"; export const schema = z.object({ id: z.string() });\n';
  const legacy = f.directory({
    type: "directory",
    entries: [{ name: "_store.json", file: f.text("[]") }, { name: "schema.ts", file: f.text(legacySource) }],
    childrenSource: {
      version: 1, type: "collection-file", format: "json", source: "_store.json", schemaSource: "schema.ts",
      schemaFingerprint: hashObject(new TextEncoder().encode(legacySource)) as Hash, childSetHash: collectionChildSetHash([]),
    },
  });
  const root = f.directory({ type: "directory", entries: [{ name: "legacy", directory: legacy }, { name: "people", directory: current }] });
  const projection = new ProtocolProjection({ root, load: f.load });
  expect(await projection.resolve("/people/first")).toMatchObject({ kind: "collection-file-row", path: "/people/first" });
  // The retired directory itself is still an addressable node; its rows are an unsupported read.
  expect((await projection.resolve("/legacy")).kind).toBe("node");
  const error = await projection.resolve("/legacy/anything").catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(ProtocolCollectionFileError);
  expect((error as ProtocolCollectionFileError).kind).toBe("unsupported");
});
