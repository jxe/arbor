import {
  decodeProtocolDirectory,
  decodeProtocolPage,
  encodeProtocolDirectory,
  encodeProtocolPage,
  hashObject,
  isPageName,
  parsePage,
  type ProtocolPage,
  type ObjectHash,
  type UpdateConflict,
  type ProtocolDirectory,
  type ProtocolDirectoryEntry,
} from "@ovst/protocol";
import { collectionFieldsV1, frontmatter, markdownAdditiveV1, pagePropertiesV1, type CollectionFieldConflict, type PagePropertyConflict, type RuleContext } from "./merge-rules.ts";
import { ModelHashes } from "./model-hash.ts";

/** Rule evidence a snapshot tree merge reports beside its result. */
export type MergeSummary =
  | { version: "markdown-additive-v1"; approximatePlacements: number }
  | { version: "collection-fields-v1"; mergedRows: number }
  | { version: "page-properties-v1"; mergedPages: number; approximatePlacements: number };

export interface MergeResult {
  root: ObjectHash;
  objects: Map<ObjectHash, Uint8Array>;
  conflicts: UpdateConflict[];
  /** Coupled rule failures that require a whole-directory alternative. */
  unresolvedDirectories?: string[];
  /** Present only when a merge rule ran. */
  summary?: MergeSummary;
  /** Collection fields both sides set differently: each keeps current's
   * value and is left for a decision, not reported as a conflict. */
  fields?: CollectionFieldConflict[];
  /** Page properties both sides set differently, kept and left for a
   * decision as collection fields are. */
  properties?: PagePropertyConflict[];
}

type Load = (hash: ObjectHash) => Promise<Uint8Array>;

function entryEqual(left: ProtocolDirectoryEntry | undefined, right: ProtocolDirectoryEntry | undefined): boolean {
  return left?.name === right?.name
    && left?.file === right?.file
    && left?.page === right?.page
    && left?.directory === right?.directory
    && left?.tree === right?.tree;
}

function sortedEntries(entries: ProtocolDirectoryEntry[]): ProtocolDirectoryEntry[] {
  return entries.sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
}

/** Name a conflict by the shape of the node the two sides disagree on. */
function conflictReason(
  before: ProtocolDirectoryEntry | undefined,
  local: ProtocolDirectoryEntry | undefined,
  accepted: ProtocolDirectoryEntry | undefined,
): UpdateConflict["reason"] {
  const present = [before, local, accepted].filter((entry): entry is ProtocolDirectoryEntry => entry !== undefined);
  if (present.some((entry) => entry.tree)) return "nested-boundary-conflict";
  // A page is a file that was converted: the same kind of node.
  const kinds = new Set(present.map((entry) => entry.file || entry.page ? "file" : entry.directory ? "directory" : "none"));
  if (kinds.size > 1) return "path-kind-conflict";
  if (local?.file && accepted?.file && !isPageName(local.name)) return "binary-conflict";
  return "node-conflict";
}

function childPath(path: string, name: string): string {
  return `${path === "/" ? "" : path}/${name}`;
}

/**
 * Merge a candidate onto current, node by node. A node the candidate did not
 * touch keeps current's version; a node current did not touch takes the
 * candidate's. A node both changed conflicts unless current only changed its
 * bytes and not its model, in which case the candidate's bytes win. A
 * conflicting node whose representation has a merge
 * rule is resolved by that rule; every other conflict is reported and the
 * draft keeps the candidate's version.
 */
export async function mergeProtocolTrees(
  base: ObjectHash,
  candidate: ObjectHash,
  current: ObjectHash,
  load: Load,
): Promise<MergeResult> {
  const generated = new Map<ObjectHash, Uint8Array>();
  const conflicts: UpdateConflict[] = [];
  const unresolvedDirectories = new Set<string>();
  const loadAny = async (hash: ObjectHash) => generated.get(hash) ?? await load(hash);
  const context: RuleContext = {
    store(bytes) {
      const hash = hashObject(bytes);
      generated.set(hash, bytes);
      return hash;
    },
    file: loadAny,
    conflicts,
  };
  const hashes = new ModelHashes(loadAny);
  let approximatePlacements = 0;
  let mergedRows = 0;
  let sawMarkdownRule = false;
  let sawCollectionRule = false;
  let mergedPages = 0;
  const fields: CollectionFieldConflict[] = [];
  const properties: PagePropertyConflict[] = [];

  /** An entry's page: a page entry's own, or the page a Markdown file
   * reads as; null for anything else, or a file whose frontmatter does not
   * parse. */
  const pageOf = async (entry: ProtocolDirectoryEntry | undefined): Promise<ProtocolPage | null> => {
    if (entry?.page) return decodeProtocolPage(await loadAny(entry.page));
    if (entry?.file && isPageName(entry.name)) return parsePage(await loadAny(entry.file));
    return null;
  };
  /** Once current holds a page at a name, a merge keeps it a page: a
   * candidate's Markdown file there is written as the page it reads as. */
  const asPage = async (entry: ProtocolDirectoryEntry | undefined, accepted: ProtocolDirectoryEntry | undefined) => {
    if (!entry?.file || !accepted?.page || !isPageName(entry.name)) return entry;
    const page = await pageOf(entry);
    return page ? { name: entry.name, page: context.store(encodeProtocolPage(page)) } : entry;
  };

  const directoryObject = async (entry: ProtocolDirectoryEntry | undefined): Promise<ProtocolDirectory | null> => {
    return entry?.directory ? decodeProtocolDirectory(await loadAny(entry.directory)) : null;
  };

  /** Resolve one conflicting node with its representation's rule; undefined when it has none. */
  const applyRule = async (
    path: string,
    before: ProtocolDirectoryEntry | undefined,
    local: ProtocolDirectoryEntry,
    accepted: ProtocolDirectoryEntry,
  ): Promise<ProtocolDirectoryEntry | undefined> => {
    // Pages, or Markdown files where any side is already a page, merge
    // property by property.
    if ([before, local, accepted].some((entry) => entry?.page) && isPageName(local.name)) {
      const [b, c, u] = await Promise.all([pageOf(before), pageOf(local), pageOf(accepted)]);
      if (c && u && (b || !before)) {
        const merged = pagePropertiesV1(path, b, c, u, context);
        mergedPages++;
        approximatePlacements += merged.approximate;
        properties.push(...merged.properties);
        return { name: local.name, page: context.store(encodeProtocolPage(merged.page)) };
      }
    }
    if (local.file && accepted.file && isPageName(local.name) && (!before || before.file)) {
      const baseHash = before?.file ?? context.store(new Uint8Array());
      const merged = await markdownAdditiveV1(path, baseHash, local.file, accepted.file, context);
      sawMarkdownRule = true;
      approximatePlacements += merged.approximate;
      return { name: local.name, file: merged.hash };
    }
    return undefined;
  };

  /** A page's frontmatter id by file object: the three sides mostly share their pages, so each is parsed once. */
  const pageIDs = new Map<ObjectHash, Promise<string | undefined>>();
  const pageID = (file: ObjectHash, page = false): Promise<string | undefined> => {
    let id = pageIDs.get(file);
    if (!id) {
      id = (async () => {
        const value = await context.file(file);
        if (page) {
          try { return decodeProtocolPage(value).id; } catch { return undefined; }
        }
        let source: string;
        try {
          source = new TextDecoder("utf-8", { fatal: true }).decode(value);
        } catch {
          return undefined;
        }
        return frontmatter(source)?.get("id");
      })();
      pageIDs.set(file, id);
    }
    return id;
  };

  /** Markdown pages keyed by a unique frontmatter id, so a rename and an edit on the other side still meet as one node. */
  const pagesByID = async (directory: Map<string, ProtocolDirectoryEntry>): Promise<Map<string, ProtocolDirectoryEntry>> => {
    const unique = new Map<string, ProtocolDirectoryEntry>();
    const duplicates = new Set<string>();
    for (const entry of directory.values()) {
      if (!(entry.file || entry.page) || !isPageName(entry.name)) continue;
      const id = await pageID((entry.file ?? entry.page)!, !!entry.page);
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
    before: ProtocolDirectoryEntry | undefined,
    local: ProtocolDirectoryEntry | undefined,
    accepted: ProtocolDirectoryEntry | undefined,
  ): Promise<ProtocolDirectoryEntry | null> => {
    const path = childPath(parentPath, name);
    const [localChildren, acceptedChildren] = await Promise.all([directoryObject(local), directoryObject(accepted)]);
    if (localChildren && acceptedChildren) {
      const baseChildren = (await directoryObject(before)) ?? { type: "directory" as const, entries: [] };
      return { name, directory: await mergeDirectory(path, baseChildren, localChildren, acceptedChildren) };
    }
    const [baseModel, currentModel] = await Promise.all([hashes.entry(before), hashes.entry(accepted)]);
    if (baseModel === currentModel) return (await asPage(local, accepted)) ?? null;
    if (local && accepted) {
      const resolved = await applyRule(path, before, local, accepted);
      if (resolved) return resolved;
    }
    const kindMismatch = local !== undefined && accepted !== undefined && (localChildren === null) !== (acceptedChildren === null);
    conflicts.push({ path, reason: kindMismatch ? "path-kind-conflict" : conflictReason(before, local, accepted) });
    return local ?? null;
  };

  const mergeDirectory = async (
    parentPath: string,
    baseDirectory: ProtocolDirectory,
    candidateDirectory: ProtocolDirectory,
    currentDirectory: ProtocolDirectory,
  ): Promise<ObjectHash> => {
    const baseEntries = new Map(baseDirectory.entries.map((entry) => [entry.name, entry]));
    const candidateEntries = new Map(candidateDirectory.entries.map((entry) => [entry.name, entry]));
    const currentEntries = new Map(currentDirectory.entries.map((entry) => [entry.name, entry]));
    const entries: ProtocolDirectoryEntry[] = [];
    const handled = new Set<string>();
    const [basePages, candidatePages, currentPages] = await Promise.all([
      pagesByID(baseEntries), pagesByID(candidateEntries), pagesByID(currentEntries),
    ]);
    for (const [id, before] of basePages) {
      const local = candidatePages.get(id);
      const accepted = currentPages.get(id);
      if (!local || !accepted || (local.name === before.name && accepted.name === before.name)) continue;
      const priorConflicts = conflicts.length;
      const names = [before.name, local.name, accepted.name];
      const localMoved = local.name !== before.name;
      const acceptedMoved = accepted.name !== before.name;
      if (localMoved && acceptedMoved && local.name !== accepted.name) {
        conflicts.push({ path: childPath(parentPath, before.name), reason: "page-id-move-conflict" });
        unresolvedDirectories.add(parentPath);
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
      if (conflicts.length > priorConflicts) unresolvedDirectories.add(parentPath);
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
    let directory: ProtocolDirectory = { type: "directory", entries: sortedEntries(entries) };
    // A collection's rows merge after its entries, since they are checked
    // against the folder's merged schema.usl.
    if (baseDirectory.collection || candidateDirectory.collection || currentDirectory.collection) {
      const priorConflicts = conflicts.length;
      const [baseState, candidateState, currentState] = [baseDirectory, candidateDirectory, currentDirectory]
        .map((d) => d.collection ? JSON.stringify(d.collection) : null);
      const take = (d: ProtocolDirectory) => d.collection ? { ...directory, collection: d.collection } : directory;
      if (candidateState === baseState) directory = take(currentDirectory);
      else if (currentState === baseState || candidateState === currentState) directory = take(candidateDirectory);
      else if (baseDirectory.collection && candidateDirectory.collection && currentDirectory.collection) {
        const merged = await collectionFieldsV1(parentPath, baseDirectory, candidateDirectory, currentDirectory, directory, context);
        directory = merged.directory;
        sawCollectionRule = true;
        mergedRows += merged.mergedRows;
        fields.push(...merged.fields);
      } else {
        conflicts.push({ path: parentPath, reason: "collection-schema-conflict" });
        directory = take(candidateDirectory);
      }
      if (conflicts.length > priorConflicts) unresolvedDirectories.add(parentPath);
    }
    return context.store(encodeProtocolDirectory(directory));
  };

  const rootDirectory = async (hash: ObjectHash): Promise<ProtocolDirectory> => {
    const object = decodeProtocolDirectory(await loadAny(hash));
    if (object.type !== "directory") throw new Error("Tree root is not a directory object");
    return object;
  };
  const root = await mergeDirectory("/", await rootDirectory(base), await rootDirectory(candidate), await rootDirectory(current));
  const summary: MergeSummary | undefined = sawCollectionRule
    ? { version: "collection-fields-v1", mergedRows }
    : mergedPages ? { version: "page-properties-v1", mergedPages, approximatePlacements }
    : sawMarkdownRule ? { version: "markdown-additive-v1", approximatePlacements } : undefined;
  return { root, objects: generated, conflicts, ...(unresolvedDirectories.size ? { unresolvedDirectories: [...unresolvedDirectories] } : {}), ...(summary ? { summary } : {}), ...(fields.length ? { fields } : {}), ...(properties.length ? { properties } : {}) };
}
