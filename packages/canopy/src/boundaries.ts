import {
  compareWireNames,
  decodeWireObject,
  encodeWireObject,
  hashObject,
  type ObjectHash,
  type WireDirectory,
  type WireDirectoryEntry,
} from "@arbor/wire";

export function normalizeBoundaryPath(input: string): string {
  const decoded = decodeURI(input);
  if (!decoded.startsWith("/")) throw new Error(`Canonical boundary must be absolute: ${input}`);
  const segments = decoded.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === ".." || segment.includes("\\"))) {
    throw new Error(`Invalid canonical boundary: ${input}`);
  }
  return segments.length ? `/${segments.join("/")}` : "/";
}

export function pathSegments(path: string): string[] {
  return normalizeBoundaryPath(path).split("/").filter(Boolean);
}

export interface BoundaryEdit {
  path: string;
  tree: string;
}

export interface BoundaryRewrite {
  nextRoot: ObjectHash;
  /** Every directory object generated along the rewritten paths. */
  generated: Map<ObjectHash, Uint8Array>;
}

export interface BoundaryRewriteOptions {
  /**
   * Whether a plain file or directory entry at an added boundary's name is
   * replaced by the nested-tree entry. Attaching a newly created tree
   * replaces; moving an existing boundary rejects, so a move can never
   * silently shadow authored content.
   */
  replaceEntries?: boolean;
}

/**
 * Rewrite a parent tree's directory graph so nested-tree boundary entries are
 * removed and added at the given canonical paths. Attaching one new tree is
 * the single-addition case. Every touched directory is regenerated in
 * canonical order; the caller stores `generated` and commits `nextRoot`.
 */
export async function rewriteBoundaries(
  parent: { ref: ObjectHash; canonicalPath: string },
  removals: BoundaryEdit[],
  additions: BoundaryEdit[],
  load: (hash: ObjectHash, generated: ReadonlyMap<ObjectHash, Uint8Array>) => Promise<Uint8Array>,
  options: BoundaryRewriteOptions = {},
): Promise<BoundaryRewrite> {
  const prefix = pathSegments(parent.canonicalPath);
  const generated = new Map<ObjectHash, Uint8Array>();
  type Edit = { segments: string[]; tree: string; remove: boolean; path: string };
  const edits: Edit[] = [
    ...removals.map((item) => ({ segments: pathSegments(item.path).slice(prefix.length), tree: item.tree, remove: true, path: item.path })),
    ...additions.map((item) => ({ segments: pathSegments(item.path).slice(prefix.length), tree: item.tree, remove: false, path: item.path })),
  ];
  if (edits.some((edit) => edit.segments.length === 0)) throw new Error("A boundary cannot replace its parent root");

  const rewrite = async (hash: ObjectHash, pending: Edit[]): Promise<ObjectHash> => {
    const object = decodeWireObject(await load(hash, generated));
    if (object.type !== "directory") throw new Error("Canonical boundary crosses a file");
    const entries = [...object.entries];
    const grouped = new Map<string, Edit[]>();
    for (const edit of pending) {
      const [name, ...rest] = edit.segments;
      const values = grouped.get(name!) ?? [];
      values.push({ ...edit, segments: rest });
      grouped.set(name!, values);
    }
    for (const [name, group] of grouped) {
      let index = entries.findIndex((entry) => entry.name === name);
      const leaf = group.filter((edit) => edit.segments.length === 0);
      const deeper = group.filter((edit) => edit.segments.length > 0);
      for (const edit of leaf) {
        if (edit.remove) {
          if (index < 0 || entries[index]!.tree !== edit.tree) throw new Error(`Canonical boundary moved concurrently: ${edit.tree}`);
          entries.splice(index, 1);
          index = -1;
          continue;
        }
        const existing = index >= 0 ? entries[index]! : undefined;
        if (existing && existing.tree && existing.tree !== edit.tree) {
          throw new Error(`Canonical boundary is already occupied: ${edit.path}`);
        }
        if (existing && !existing.tree && !options.replaceEntries) {
          throw new Error(`Canonical boundary is occupied: ${name}`);
        }
        const next: WireDirectoryEntry = { name, tree: edit.tree };
        if (index >= 0) entries[index] = next;
        else {
          entries.push(next);
          index = entries.length - 1;
        }
      }
      if (deeper.length) {
        if (index >= 0 && entries[index]!.tree) throw new Error(`Canonical boundary crosses another tree: ${name}`);
        let childHash = index >= 0 ? entries[index]!.hash : undefined;
        if (!childHash) {
          const empty = encodeWireObject({ type: "directory", entries: [] });
          childHash = hashObject(empty);
          generated.set(childHash, empty);
        }
        const updated = await rewrite(childHash, deeper);
        const next: WireDirectoryEntry = { name, hash: updated };
        if (index >= 0) entries[index] = next;
        else entries.push(next);
      }
    }
    entries.sort((a, b) => compareWireNames(a.name, b.name));
    const bytes = encodeWireObject({ type: "directory", entries } satisfies WireDirectory);
    const nextHash = hashObject(bytes);
    generated.set(nextHash, bytes);
    return nextHash;
  };
  const nextRoot = await rewrite(parent.ref, edits);
  return { nextRoot, generated };
}
