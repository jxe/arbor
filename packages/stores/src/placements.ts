import { watch, type FSWatcher } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, normalize } from "node:path";
import type { Diagnostic, TreeID } from "@arbor/core";
import { isAlias, isMap, isSeq, parseDocument, type Node } from "yaml";
import { arborDataRoot } from "./private-state.ts";
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
