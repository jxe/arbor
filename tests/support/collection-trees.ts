import { collectionFileRows, compileCollectionSchema } from "@ovst/collection-schema";
import { decodeProtocolDirectory, encodeProtocolDirectory, hashObject, type CollectionFileDescriptor, type ObjectHash, type ProtocolDirectoryEntry } from "@ovst/protocol";

export interface CollectionTree {
  root: ObjectHash;
  /** The collection directory at `/items`. */
  collection: ObjectHash;
  objects: Map<ObjectHash, Uint8Array>;
}

/** A tree holding one collection folder, `/items`, beside a page. */
export function collectionTree(
  format: CollectionFileDescriptor["format"],
  schemaSource: string,
  source: string,
  objects = new Map<ObjectHash, Uint8Array>(),
): CollectionTree {
  const put = (bytes: Uint8Array) => { const hash = hashObject(bytes); objects.set(hash, bytes); return hash; };
  const schemaBytes = new TextEncoder().encode(schemaSource), sourceBytes = new TextEncoder().encode(source);
  const schema = compileCollectionSchema(schemaBytes);
  const store = `_store.${format}` as CollectionFileDescriptor["source"];
  const childrenSource: CollectionFileDescriptor = {
    version: 1, type: "collection-file", format, source: store, schemaSource: "schema.usl",
    schemaFingerprint: schema.revision, childSetHash: collectionFileRows(format, sourceBytes, schema).childSetHash,
  };
  const entries: ProtocolDirectoryEntry[] = [{ name: store, file: put(sourceBytes) }, { name: "schema.usl", file: put(schemaBytes) }]
    .sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
  const collection = put(encodeProtocolDirectory({ type: "directory", entries, childrenSource }));
  const page = put(new TextEncoder().encode("# Notes\n"));
  const root = put(encodeProtocolDirectory({ type: "directory", entries: [{ name: "items", directory: collection }, { name: "notes.md", file: page }] }));
  return { root, collection, objects };
}

/** The `_store.*` text of `/items` in `root`. */
export function collectionSource(root: ObjectHash, objects: ReadonlyMap<ObjectHash, Uint8Array>): string {
  const top = decodeProtocolDirectory(objects.get(root)!);
  const items = decodeProtocolDirectory(objects.get(top.entries.find((e) => e.name === "items")!.directory!)!);
  return new TextDecoder().decode(objects.get(items.entries.find((e) => e.name === items.childrenSource!.source)!.file!)!);
}
