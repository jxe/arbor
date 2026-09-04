import {
  decodeWireObject,
  encodeWireObject,
  hashObject,
  type MergeSummary,
  type ObjectHash,
  type OnConflict,
  type UpdateConflict,
  type WireDirectory,
  type WireDirectoryEntry,
} from "@arbor/wire";
import { collectionFileRowsV1, frontmatter, markdownAdditiveV1, type CollectionFileMergeInput, type RuleContext } from "./merge-rules.ts";
import { ModelHashes } from "./model-hash.ts";

export interface MergeResult {
  root: ObjectHash;
  objects: Map<ObjectHash, Uint8Array>;
  conflicts: UpdateConflict[];
  /** Present only when a merge rule ran. */
  summary?: MergeSummary;
}

type Load = (hash: ObjectHash) => Promise<Uint8Array>;

function entryEqual(left: WireDirectoryEntry | undefined, right: WireDirectoryEntry | undefined): boolean {
  return left?.name === right?.name
    && left?.hash === right?.hash
    && left?.tree === right?.tree;
}

function sortedEntries(entries: WireDirectoryEntry[]): WireDirectoryEntry[] {
  return entries.sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
}

/** Name a conflict by the shape of the node the two sides disagree on. */
function conflictReason(
  before: WireDirectoryEntry | undefined,
  local: WireDirectoryEntry | undefined,
  accepted: WireDirectoryEntry | undefined,
): UpdateConflict["reason"] {
  const present = [before, local, accepted].filter((entry): entry is WireDirectoryEntry => entry !== undefined);
  if (present.some((entry) => entry.tree)) return "nested-boundary-conflict";
  const kinds = new Set(present.map((entry) => entry.hash ? "object" : "none"));
  if (kinds.size > 1) return "path-kind-conflict";
  if (local?.hash && accepted?.hash && !local.name.endsWith(".md")) return "binary-conflict";
  return "node-conflict";
}

function childPath(path: string, name: string): string {
  return `${path === "/" ? "" : path}/${name}`;
}

/**
 * Merge a candidate onto current, node by node. A node the candidate did not
 * touch keeps current's version; a node current did not touch takes the
 * candidate's. A node both changed conflicts unless current only changed its
 * bytes and not its model, in which case the candidate's bytes win. Under
 * `onConflict: "merge"`, a conflicting node whose representation has a merge
 * rule is resolved by that rule; every other conflict is reported and the
 * draft keeps the candidate's version.
 */
export async function mergeWireTrees(
  base: ObjectHash,
  candidate: ObjectHash,
  current: ObjectHash,
  load: Load,
  onConflict: OnConflict = "merge",
): Promise<MergeResult> {
  const generated = new Map<ObjectHash, Uint8Array>();
  const conflicts: UpdateConflict[] = [];
  const loadAny = async (hash: ObjectHash) => generated.get(hash) ?? await load(hash);
  const context: RuleContext = {
    store(object) {
      const bytes = encodeWireObject(object);
      const hash = hashObject(bytes);
      generated.set(hash, bytes);
      return hash;
    },
    async object(hash) {
      return decodeWireObject(await loadAny(hash));
    },
    conflicts,
  };
  const hashes = new ModelHashes(loadAny);
  let approximatePlacements = 0;
  let mergedRows = 0;
  let sawMarkdownRule = false;
  let sawCollectionFileRule = false;

  const directoryObject = async (entry: WireDirectoryEntry | undefined): Promise<WireDirectory | null> => {
    if (!entry?.hash) return null;
    const object = await context.object(entry.hash);
    return object.type === "directory" ? object : null;
  };

  /** Resolve one conflicting node with its representation's rule; undefined when it has none. */
  const applyRule = async (
    path: string,
    before: WireDirectoryEntry | undefined,
    local: WireDirectoryEntry,
    accepted: WireDirectoryEntry,
  ): Promise<WireDirectoryEntry | undefined> => {
    if (local.hash && accepted.hash && local.name.endsWith(".md") && (!before || before.hash)) {
      const baseHash = before?.hash ?? context.store({ type: "file", bytes: new Uint8Array() });
      const merged = await markdownAdditiveV1(path, baseHash, local.hash, accepted.hash, context);
      sawMarkdownRule = true;
      approximatePlacements += merged.approximate;
      return { name: local.name, hash: merged.hash };
    }
    return undefined;
  };

  /** Markdown pages keyed by a unique frontmatter id, so a rename and an edit on the other side still meet as one node. */
  const pagesByID = async (directory: Map<string, WireDirectoryEntry>): Promise<Map<string, WireDirectoryEntry>> => {
    const unique = new Map<string, WireDirectoryEntry>();
    const duplicates = new Set<string>();
    for (const entry of directory.values()) {
      if (!entry.hash || !entry.name.endsWith(".md")) continue;
      const value = await context.object(entry.hash);
      if (value.type !== "file") continue;
      let source: string;
      try {
        source = new TextDecoder("utf-8", { fatal: true }).decode(value.bytes);
      } catch {
        continue;
      }
      const id = frontmatter(source)?.get("id");
      if (!id) continue;
      if (unique.has(id)) {
        unique.delete(id);
        duplicates.add(id);
      } else if (!duplicates.has(id)) {
        unique.set(id, entry);
      }
    }
    return unique;
  };

  /** Resolve one node the two sides both changed; returns the entry to keep, or null to omit it. */
  const resolveNode = async (
    parentPath: string,
    name: string,
    before: WireDirectoryEntry | undefined,
    local: WireDirectoryEntry | undefined,
    accepted: WireDirectoryEntry | undefined,
  ): Promise<WireDirectoryEntry | null> => {
    const path = childPath(parentPath, name);
    const [localChildren, acceptedChildren] = await Promise.all([directoryObject(local), directoryObject(accepted)]);
    if (localChildren && acceptedChildren) {
      const baseChildren = (await directoryObject(before)) ?? { type: "directory" as const, entries: [] };
      return { name, hash: await mergeDirectory(path, baseChildren, localChildren, acceptedChildren) };
    }
    const [baseModel, currentModel] = await Promise.all([hashes.entry(before), hashes.entry(accepted)]);
    if (baseModel === currentModel) return local ?? null;
    if (onConflict === "merge" && local && accepted) {
      const resolved = await applyRule(path, before, local, accepted);
      if (resolved) return resolved;
    }
    const kindMismatch = local !== undefined && accepted !== undefined && (localChildren === null) !== (acceptedChildren === null);
    conflicts.push({ path, reason: kindMismatch ? "path-kind-conflict" : conflictReason(before, local, accepted) });
    return local ?? null;
  };

  const mergeDirectory = async (
    parentPath: string,
    baseDirectory: WireDirectory,
    candidateDirectory: WireDirectory,
    currentDirectory: WireDirectory,
  ): Promise<ObjectHash> => {
    const baseEntries = new Map(baseDirectory.entries.map((entry) => [entry.name, entry]));
    const candidateEntries = new Map(candidateDirectory.entries.map((entry) => [entry.name, entry]));
    const currentEntries = new Map(currentDirectory.entries.map((entry) => [entry.name, entry]));
    const entries: WireDirectoryEntry[] = [];
    const handled = new Set<string>();
    const descriptorState = (directory: WireDirectory): string | null => directory.childrenSource
      ? JSON.stringify(directory.childrenSource)
      : null;
    const collectionInput = (directory: WireDirectory): CollectionFileMergeInput | null => {
      const descriptor = directory.childrenSource;
      if (!descriptor) return null;
      const source = directory.entries.find((entry) => entry.name === descriptor.source)?.hash;
      const schemaSource = directory.entries.find((entry) => entry.name === descriptor.schemaSource)?.hash;
      return source && schemaSource ? { descriptor, source, schemaSource } : null;
    };
    const baseCollection = collectionInput(baseDirectory);
    const candidateCollection = collectionInput(candidateDirectory);
    const currentCollection = collectionInput(currentDirectory);
    let selectedCollection: CollectionFileMergeInput | null = null;
    if (baseDirectory.childrenSource || candidateDirectory.childrenSource || currentDirectory.childrenSource) {
      const baseState = descriptorState(baseDirectory);
      const candidateState = descriptorState(candidateDirectory);
      const currentState = descriptorState(currentDirectory);
      if (candidateState === baseState) selectedCollection = currentCollection;
      else if (currentState === baseState || candidateState === currentState) selectedCollection = candidateCollection;
      else if (onConflict === "merge" && baseCollection && candidateCollection && currentCollection) {
        const merged = await collectionFileRowsV1(parentPath, baseCollection, candidateCollection, currentCollection, context);
        selectedCollection = merged;
        sawCollectionFileRule = true;
        mergedRows += merged.mergedRows;
      } else {
        conflicts.push({ path: parentPath, reason: "collection-file-schema-conflict" });
        selectedCollection = candidateCollection;
      }
      for (const directory of [baseDirectory, candidateDirectory, currentDirectory]) {
        if (directory.childrenSource) {
          handled.add(directory.childrenSource.source);
          handled.add(directory.childrenSource.schemaSource);
        }
      }
      if (selectedCollection) {
        entries.push(
          { name: selectedCollection.descriptor.source, hash: selectedCollection.source },
          { name: selectedCollection.descriptor.schemaSource, hash: selectedCollection.schemaSource },
        );
      }
    }
    const [basePages, candidatePages, currentPages] = await Promise.all([
      pagesByID(baseEntries), pagesByID(candidateEntries), pagesByID(currentEntries),
    ]);
    for (const [id, before] of basePages) {
      const local = candidatePages.get(id);
      const accepted = currentPages.get(id);
      if (!local || !accepted || (local.name === before.name && accepted.name === before.name)) continue;
      const names = [before.name, local.name, accepted.name];
      const localMoved = local.name !== before.name;
      const acceptedMoved = accepted.name !== before.name;
      if (localMoved && acceptedMoved && local.name !== accepted.name) {
        conflicts.push({ path: childPath(parentPath, before.name), reason: "page-id-move-conflict" });
        entries.push(local);
        for (const name of names) handled.add(name);
        continue;
      }
      const target = localMoved ? local.name : accepted.name;
      const localAtTarget = candidateEntries.get(target);
      const acceptedAtTarget = currentEntries.get(target);
      if ((localAtTarget && !entryEqual(localAtTarget, local)) || (acceptedAtTarget && !entryEqual(acceptedAtTarget, accepted))) {
        conflicts.push({ path: childPath(parentPath, target), reason: "page-id-move-conflict" });
        entries.push(local);
      } else {
        const moved = { ...local, name: target };
        const kept = { ...accepted, name: target };
        const resolved = entryEqual(moved, kept) ? moved : await resolveNode(parentPath, target, { ...before, name: target }, moved, kept);
        if (resolved) entries.push(resolved);
      }
      for (const name of names) handled.add(name);
    }
    for (const name of new Set([...baseEntries.keys(), ...candidateEntries.keys(), ...currentEntries.keys()])) {
      if (handled.has(name)) continue;
      const before = baseEntries.get(name);
      const local = candidateEntries.get(name);
      const accepted = currentEntries.get(name);
      if (entryEqual(local, before)) { if (accepted) entries.push(accepted); continue; }
      if (entryEqual(accepted, before)) { if (local) entries.push(local); continue; }
      if (entryEqual(local, accepted)) { if (local) entries.push(local); continue; }
      const resolved = await resolveNode(parentPath, name, before, local, accepted);
      if (resolved) entries.push(resolved);
    }
    return context.store({
      type: "directory",
      entries: sortedEntries(entries),
      ...(selectedCollection ? { childrenSource: selectedCollection.descriptor } : {}),
    });
  };

  const rootDirectory = async (hash: ObjectHash): Promise<WireDirectory> => {
    const object = await context.object(hash);
    if (object.type !== "directory") throw new Error("Tree root is not a directory object");
    return object;
  };
  const root = await mergeDirectory("/", await rootDirectory(base), await rootDirectory(candidate), await rootDirectory(current));
  const summary: MergeSummary | undefined = sawCollectionFileRule
    ? { version: "collection-file-rows-v1", mergedRows }
    : sawMarkdownRule ? { version: "markdown-additive-v1", approximatePlacements } : undefined;
  return { root, objects: generated, conflicts, ...(summary ? { summary } : {}) };
}
