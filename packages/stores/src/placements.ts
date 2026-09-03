import { watch, type FSWatcher } from "node:fs";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, normalize } from "node:path";
import type { Diagnostic, TreeID } from "@arbor/core";
import { isAlias, isMap, isSeq, parseDocument, type Node } from "yaml";
import { arborDataRoot, prepareArborDataRoot } from "./private-state.ts";
import { configurationTreeID } from "./account-config-v2.ts";

export interface LocalPlacement {
  configurationTree: TreeID;
  path: string;
  tree: TreeID;
}

export interface LocalPlacementsSnapshot {
  placements: LocalPlacement[];
  source: string;
  diagnostics: Diagnostic[];
}

function containsAlias(node: Node | null | undefined): boolean {
  if (!node) return false;
  if (isAlias(node)) return true;
  if (isMap(node) || isSeq(node)) {
    return node.items.some((item: unknown) => {
      if (isMap(node)) {
        const pair = item as { key?: Node; value?: Node };
        return containsAlias(pair.key) || containsAlias(pair.value);
      }
      return containsAlias(item as Node);
    });
  }
  return false;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a mapping`);
  return value as Record<string, unknown>;
}

export function placementsFilePath(): string {
  return join(arborDataRoot(), "placements.yaml");
}

export function parseLocalPlacements(source: string): LocalPlacement[] {
  const document = parseDocument(source, { uniqueKeys: true });
  if (document.errors.length) throw new Error(document.errors[0]!.message);
  if (containsAlias(document.contents as Node | null)) throw new Error("YAML aliases are not allowed");
  const root = record(document.toJS({ maxAliasCount: 0 }), "placements.yaml");
  const placements: LocalPlacement[] = [];
  const paths = new Set<string>();
  for (const [configurationValue, value] of Object.entries(root)) {
    const configurationTree = configurationTreeID(configurationValue, `placements.yaml key ${configurationValue}`);
    const entries = record(value, `placements.yaml.${configurationTree}`);
    for (const [path, treeValue] of Object.entries(entries)) {
      if (!isAbsolute(path) || normalize(path) !== path) throw new Error(`Placement path must be canonical and absolute: ${path}`);
      if (paths.has(path)) throw new Error(`Placement path appears in several accounts: ${path}`);
      paths.add(path);
      const tree = configurationTreeID(treeValue, `placements.yaml.${configurationTree}.${path}`);
      placements.push({ configurationTree, path, tree });
    }
  }
  return placements;
}

export async function loadLocalPlacements(): Promise<LocalPlacementsSnapshot> {
  const path = placementsFilePath();
  try {
    const source = await readFile(path, "utf8");
    try { return { placements: parseLocalPlacements(source), source, diagnostics: [] }; }
    catch (error) {
      return {
        placements: [],
        source,
        diagnostics: [{ code: "invalid-placements-yaml", message: error instanceof Error ? error.message : String(error), path, severity: "warning" }],
      };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { placements: [], source: "", diagnostics: [] };
    throw error;
  }
}

/** Atomically add one exact local placement without replacing another tree or path. */
export async function addLocalPlacement(placement: LocalPlacement): Promise<void> {
  await prepareArborDataRoot();
  const path = placementsFilePath();
  let original: string;
  try { original = await readFile(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    original = "{}\n";
  }
  const parsed = parseLocalPlacements(original);
  const exact = parsed.find((candidate) =>
    candidate.configurationTree === placement.configurationTree
    && candidate.path === placement.path
    && candidate.tree === placement.tree
  );
  if (exact) return;
  const occupiedPath = parsed.find((candidate) => candidate.path === placement.path);
  if (occupiedPath) throw new Error(`Another tree is already placed at ${placement.path}`);
  const placedTree = parsed.find((candidate) => candidate.tree === placement.tree);
  if (placedTree) throw new Error(`Tree ${placement.tree} is already placed at ${placedTree.path}`);
  const document = parseDocument(original, { uniqueKeys: true, keepSourceTokens: true });
  if (document.errors.length) throw new Error(document.errors[0]!.message);
  document.setIn([placement.configurationTree, placement.path], placement.tree);
  const next = document.toString({ lineWidth: 0 });
  parseLocalPlacements(next);
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, next, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

/** Atomically replace one exact local placement while preserving YAML style. */
export async function replaceLocalPlacement(
  source: LocalPlacement,
  destination: Pick<LocalPlacement, "configurationTree" | "path">,
): Promise<void> {
  const path = placementsFilePath();
  const original = await readFile(path, "utf8");
  const document = parseDocument(original, { uniqueKeys: true, keepSourceTokens: true });
  if (document.errors.length) throw new Error(document.errors[0]!.message);
  const value = document.toJS({ maxAliasCount: 0 }) as Record<string, Record<string, unknown>>;
  if (value[source.configurationTree]?.[source.path] !== source.tree) {
    throw new Error(`Placement changed before update: ${source.path}`);
  }
  const parsed = parseLocalPlacements(original);
  const occupied = parsed.find((placement) =>
    placement.path === destination.path
    && (placement.configurationTree !== source.configurationTree || placement.tree !== source.tree)
  );
  if (occupied) throw new Error(`Another tree is already placed at ${destination.path}`);
  document.deleteIn([source.configurationTree, source.path]);
  if (Object.keys(value[source.configurationTree] ?? {}).length === 1) document.deleteIn([source.configurationTree]);
  document.setIn([destination.configurationTree, destination.path], source.tree);
  const next = document.toString({ lineWidth: 0 });
  parseLocalPlacements(next);
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, next, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

export function watchLocalPlacements(onChange: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const watcher: FSWatcher = watch(arborDataRoot(), { persistent: false }, (_event, filename) => {
    if (filename?.toString() !== "placements.yaml") return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(onChange, 80);
  });
  return () => {
    if (timer) clearTimeout(timer);
    watcher.close();
  };
}
