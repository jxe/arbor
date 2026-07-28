import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { watch, type FSWatcher } from "node:fs";
import type { Diagnostic, PublicationMode, TreeID } from "@arbor/core";
import { resolveLogicalURL, revisionOf } from "@arbor/core";
import { isMap, isScalar, Pair, parseDocument, Scalar, YAMLMap, type Document } from "yaml";
import { arborDataRoot, prepareArborDataRoot } from "./private-state.ts";

export interface LocalTreePlacement {
  path: string;
  source: "local";
}

export interface SharedTreePlacement {
  path: string;
  source: `arbor://${string}`;
  tree: TreeID;
  canonical: string;
  access: "read" | "write";
  endpoint: string;
  ref: string;
  publication?: PublicationMode;
}

export type TreePlacement = LocalTreePlacement | SharedTreePlacement;

export interface TreeRegistrySnapshot {
  placements: TreePlacement[];
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
  const placements: TreePlacement[] = [];
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
    const fields = Object.fromEntries(pair.value.items.flatMap((item) =>
      isScalar(item.key) && typeof item.key.value === "string" && isScalar(item.value)
        ? [[item.key.value, item.value.value]]
        : []
    ));
    if (sourceName === "local") {
      const unknown = Object.keys(fields).filter((key) => key !== "source");
      if (unknown.length) {
        diagnostics.push(diagnostic("invalid-tree-placement", `Legacy local placement ${path} has unsupported fields: ${unknown.join(", ")}`, path));
        continue;
      }
      placements.push({ path, source: "local" });
      continue;
    }
    const resolved = resolveLogicalURL("/", sourceName);
    if (!resolved || resolved.kind !== "arbor" || !("treeID" in resolved.authority)) {
      diagnostics.push(diagnostic("invalid-tree-source", `Shared tree source must be an arbor://tree/<TreeID> URL: ${sourceName}`, path));
      continue;
    }
    const tree = fields.tree;
    const canonical = fields.canonical;
    const endpoint = fields.endpoint;
    const access = fields.access;
    const ref = fields.ref;
    const publication = fields.publication;
    if (
      typeof tree !== "string"
      || tree !== resolved.authority.treeID
      || typeof canonical !== "string"
      || resolveLogicalURL("/", canonical)?.kind !== "arbor"
      || typeof endpoint !== "string"
      || !endpoint.startsWith("http")
      || typeof ref !== "string"
      || (access !== "read" && access !== "write")
      || (publication !== undefined && !["private", "public-read", "public-write"].includes(String(publication)))
    ) {
      diagnostics.push(diagnostic("invalid-tree-placement", `Shared tree placement ${path} is incomplete or inconsistent`, path));
      continue;
    }
    const unknown = Object.keys(fields).filter((key) =>
      !["source", "tree", "canonical", "endpoint", "ref", "access", "publication"].includes(key)
    );
    if (unknown.length) {
      diagnostics.push(diagnostic("invalid-tree-placement", `Shared tree placement ${path} has unsupported fields: ${unknown.join(", ")}`, path));
      continue;
    }
    placements.push({
      path,
      source: sourceName as `arbor://${string}`,
      tree,
      canonical,
      endpoint,
      ref,
      access,
      ...(publication ? { publication: publication as PublicationMode } : {}),
    });
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

function setSharedPlacement(document: Document, placement: SharedTreePlacement): void {
  const mapping = document.contents as YAMLMap;
  mapping.flow = false;
  let existing = mapping.items.find((pair) => isScalar(pair.key) && pair.key.value === placement.path);
  if (!existing) {
    existing = new Pair(doubleQuoted(placement.path), new YAMLMap());
    mapping.items.push(existing);
  }
  (existing.key as Scalar).type = Scalar.QUOTE_DOUBLE;
  const value = new YAMLMap();
  value.flow = false;
  value.set("source", placement.source);
  value.set("tree", placement.tree);
  value.set("canonical", placement.canonical);
  value.set("endpoint", placement.endpoint);
  value.set("ref", placement.ref);
  value.set("access", placement.access);
  if (placement.publication) value.set("publication", placement.publication);
  existing.value = value;
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

export async function saveSharedTreePlacement(placement: SharedTreePlacement): Promise<SharedTreePlacement> {
  const canonicalPath = normalize(placement.path);
  if (!isAbsolute(placement.path) || canonicalPath !== placement.path) {
    throw new Error(`Tree placement path must be canonical and absolute: ${placement.path}`);
  }
  const current = await loadTreeRegistry();
  const document = editableDocument(current.source);
  setSharedPlacement(document, { ...placement, path: canonicalPath });
  await writeRegistry(document);
  return { ...placement, path: canonicalPath };
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
