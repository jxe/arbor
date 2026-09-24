import {
  decodeProtocolDirectory,
  hashObject,
  protocolEntryObject,
  type ProtocolDirectory,
} from "@overstory/protocol";

type Reference = { hash: string; kind: "file" | "directory" };
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
  ) => Promise<void | "unproven">,
  basis?: ValidatedGraph,
): Promise<ValidatedGraph> {
  const objects = new Map<string, ValidatedObject>();
  // Collections a validator leaves unproven are walked but never lend their
  // proof to a later graph, so a candidate that keeps one revalidates it.
  const unproven = new Set<string>();
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
      const bytes = await read(hash),
        children: Reference[] = [];
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
          const target = protocolEntryObject(entry);
          if (target) children.push(target);
        }
        if (directory.childrenSource && (await validateCollection(directory, read)) === "unproven") unproven.add(hash);
      }
      proof = { kind, children };
    }
    objects.set(hash, proof);
    for (const child of proof.children) pending.push(child);
  }
  for (const hash of unproven) objects.delete(hash);
  return { root, objects };
}
