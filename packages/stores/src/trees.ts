import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { watch, type FSWatcher } from "node:fs";
import type { Diagnostic } from "@arbor/core";
import { resolveLogicalURL, revisionOf } from "@arbor/core";
import { isMap, isScalar, Pair, parseDocument, Scalar, YAMLMap, type Document } from "yaml";
import { arborDataRoot, prepareArborDataRoot } from "./private-state.ts";

export interface LocalTreePlacement {
  path: string;
  source: "local";
}

export interface TreeRegistrySnapshot {
  placements: LocalTreePlacement[];
  diagnostics: Diagnostic[];
  revision: string;
  source: string;
}

export function treesFilePath(): string {
  return join(arborDataRoot(), "trees.yaml");
}

function diagnostic(code: string, message: string, path = treesFilePath()): Diagnostic {
  return { code, message, path, severity: "warning" };
}

function parseRegistry(source: string): TreeRegistrySnapshot {
  const document = parseDocument(source, { uniqueKeys: true });
  const diagnostics: Diagnostic[] = document.errors.map((error) =>
    diagnostic("invalid-trees-yaml", `trees.yaml is invalid: ${error.message}`)
  );
  const placements: LocalTreePlacement[] = [];
  if (diagnostics.length) {
    return { placements, diagnostics, revision: revisionOf(source), source };
  }
  if (!isMap(document.contents)) {
    return {
      placements,
      diagnostics: [diagnostic("invalid-trees-yaml", "trees.yaml must contain a path-keyed mapping")],
      revision: revisionOf(source),
      source,
    };
  }

  for (const pair of document.contents.items) {
    if (!isScalar(pair.key) || typeof pair.key.value !== "string") {
      diagnostics.push(diagnostic("invalid-tree-path", "Every trees.yaml key must be an absolute path string"));
      continue;
    }
    const path = pair.key.value;
    if (!isAbsolute(path) || normalize(path) !== path) {
      diagnostics.push(diagnostic("invalid-tree-path", `Tree placement path must be canonical and absolute: ${path}`, path));
      continue;
    }
    if (!isMap(pair.value)) {
      diagnostics.push(diagnostic("invalid-tree-placement", `Tree placement ${path} must be an object`, path));
      continue;
    }
    const sourceValue = pair.value.get("source", true);
    if (!isScalar(sourceValue) || typeof sourceValue.value !== "string") {
      diagnostics.push(diagnostic("invalid-tree-source", `Tree placement ${path} requires a string source`, path));
      continue;
    }
    const sourceName = sourceValue.value;
    if (sourceName !== "local") {
      const resolved = resolveLogicalURL("/", sourceName);
      if (!resolved || resolved.kind !== "arbor") {
        diagnostics.push(diagnostic("invalid-tree-source", `Tree source is not local or a valid arbor:// URL: ${sourceName}`, path));
      } else {
        diagnostics.push(diagnostic("unsupported-tree-source", `Shared tree source is not operational yet: ${sourceName}`, path));
      }
      continue;
    }
    const unknown = pair.value.items
      .map((item) => isScalar(item.key) ? item.key.value : null)
      .filter((key) => key !== "source");
    if (unknown.length) {
      diagnostics.push(diagnostic("invalid-tree-placement", `Local tree placement ${path} has unsupported fields: ${unknown.join(", ")}`, path));
      continue;
    }
    placements.push({ path, source: "local" });
  }

  return { placements, diagnostics, revision: revisionOf(source), source };
}

export async function loadTreeRegistry(): Promise<TreeRegistrySnapshot> {
  await prepareArborDataRoot();
  const path = treesFilePath();
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    try {
      await writeFile(path, "{}\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
    } catch (writeError) {
      if ((writeError as NodeJS.ErrnoException).code !== "EEXIST") throw writeError;
    }
    await chmod(path, 0o600);
    source = await readFile(path, "utf8");
  }
  return parseRegistry(source);
}

function editableDocument(source: string): Document {
  const snapshot = parseRegistry(source);
  if (snapshot.diagnostics.length) {
    throw new Error(snapshot.diagnostics.map((item) => item.message).join("; "));
  }
  const document = parseDocument(source, { uniqueKeys: true });
  if (!isMap(document.contents)) throw new Error("trees.yaml must contain a path-keyed mapping");
  return document;
}

function doubleQuoted(value: string): Scalar {
  const scalar = new Scalar(value);
  scalar.type = Scalar.QUOTE_DOUBLE;
  return scalar;
}

function setLocalPlacement(document: Document, path: string): void {
  const mapping = document.contents as YAMLMap;
  mapping.flow = false;
  const existing = mapping.items.find((pair) => isScalar(pair.key) && pair.key.value === path);
  if (existing) {
    (existing.key as Scalar).type = Scalar.QUOTE_DOUBLE;
    return;
  }
  const value = new YAMLMap();
  value.flow = false;
  value.set("source", "local");
  mapping.items.push(new Pair(doubleQuoted(path), value));
}

function deletePlacement(document: Document, path: string): void {
  const mapping = document.contents as YAMLMap;
  mapping.items = mapping.items.filter((pair) => !(isScalar(pair.key) && pair.key.value === path));
}

async function writeRegistry(document: Document): Promise<void> {
  await prepareArborDataRoot();
  const path = treesFilePath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const source = document.toString({ lineWidth: 0 }) || "{}\n";
  const checked = parseRegistry(source);
  if (checked.diagnostics.length) throw new Error(checked.diagnostics.map((item) => item.message).join("; "));
  const temporary = `${path}.arbor-write-${crypto.randomUUID()}`;
  try {
    await writeFile(temporary, source, { mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

export async function saveLocalTreePlacement(path: string): Promise<LocalTreePlacement> {
  const canonical = normalize(path);
  if (!isAbsolute(path) || canonical !== path) {
    throw new Error(`Tree placement path must be canonical and absolute: ${path}`);
  }
  const current = await loadTreeRegistry();
  const document = editableDocument(current.source);
  setLocalPlacement(document, canonical);
  await writeRegistry(document);
  return { path: canonical, source: "local" };
}

export async function deleteTreePlacement(path: string): Promise<void> {
  const current = await loadTreeRegistry();
  const document = editableDocument(current.source);
  deletePlacement(document, path);
  await writeRegistry(document);
}

export async function legacySystemRootsExist(): Promise<boolean> {
  try {
    return (await stat(join(arborDataRoot(), "system", "roots"))).isDirectory();
  } catch {
    return false;
  }
}

export async function watchTreeRegistry(onChange: () => void): Promise<() => void> {
  await prepareArborDataRoot();
  const directory = dirname(treesFilePath());
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let watcher: FSWatcher;
  watcher = watch(directory, { persistent: false }, (_event, filename) => {
    if (filename?.toString() !== "trees.yaml") return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(onChange, 80);
  });
  return () => {
    if (timer) clearTimeout(timer);
    watcher.close();
  };
}
