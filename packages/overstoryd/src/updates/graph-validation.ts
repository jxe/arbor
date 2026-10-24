import {
  decodeProtocolDirectory,
  decodeProtocolRows,
  hashObject,
  protocolDirectoryReferences,
  protocolObjectReferences,
  type ProtocolDirectory,
  type ProtocolObjectKind,
} from "@ovst/protocol";

type Reference = { hash: string; kind: ProtocolObjectKind };
type ValidatedObject = { kind: Reference["kind"]; children: Reference[] };
/** A structural proof for one immutable graph. It contains no object bytes.
 * Only use a previous proof as a basis after its graph has been durably retained. */
export interface ValidatedGraph {
  root: string;
  objects: ReadonlyMap<string, ValidatedObject>;
}

/** Validate new objects against a previously accepted Merkle graph. Unchanged
 * objects inherit their verified shape; only changed paths load/decode bytes.
 * Cross-kind checks remain even when subtrees are shared, moved, removed, or
 * reused as another kind. Storage accounting belongs in an offline audit.
 * `load` returns verified bytes (the object store checks every read); each
 * proposed object is hashed here exactly once. */
export async function validateGraphChange(
  root: string,
  load: (hash: string) => Promise<Uint8Array>,
  proposed: ReadonlyMap<string, Uint8Array>,
  validateCollection: (
    directory: ProtocolDirectory,
    load: (hash: string) => Promise<Uint8Array>,
  ) => Promise<void>,
  basis?: ValidatedGraph,
): Promise<ValidatedGraph> {
  const objects = new Map<string, ValidatedObject>();
  const pending: Reference[] = [{ hash: root, kind: "directory" }];
  const reads = new Map<string, Uint8Array>();
  const read = async (hash: string) => {
    const known = reads.get(hash);
    if (known) return known;
    const overlay = proposed.get(hash);
    if (overlay && hashObject(overlay) !== hash)
      throw Error(`Object hash mismatch: ${hash}`);
    const bytes = overlay ?? (await load(hash));
    reads.set(hash, bytes);
    return bytes;
  };
  while (pending.length) {
    const { hash, kind } = pending.pop()!;
    const seen = objects.get(hash);
    if (seen) {
      if (seen.kind !== kind) throw Error(`Object kind conflict: ${hash}`);
      continue;
    }
    // A proposed object is checked even where the basis proves its hash.
    if (proposed.has(hash)) await read(hash);
    let proof = basis?.objects.get(hash);
    if (proof?.kind !== kind) proof = undefined;
    if (!proof) {
      const bytes = await read(hash);
      let children: Reference[] = [];
      if (kind === "directory") {
        const directory = decodeProtocolDirectory(bytes),
          names = new Set<string>();
        for (const entry of directory.entries) {
          if (
            !entry.name ||
            entry.name === "." ||
            entry.name === ".." ||
            /[/\\]/.test(entry.name) ||
            names.has(entry.name)
          )
            throw Error(`Invalid or duplicate directory entry: ${entry.name}`);
          names.add(entry.name);
        }
        children = protocolDirectoryReferences(directory);
        // The collection's tables and rows are validated with it, as a whole.
        if (directory.collection) await validateCollection(directory, read);
      } else if (kind === "table") {
        children = protocolObjectReferences(kind, bytes);
      } else if (kind === "rows") {
        decodeProtocolRows(bytes);
      }
      proof = { kind, children };
    }
    objects.set(hash, proof);
    for (const child of proof.children) pending.push(child);
  }
  return { root, objects };
}
