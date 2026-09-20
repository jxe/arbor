import type { SyncConflictContent } from "@overstory/protocol";
import { compareWireNames, decodeWireDirectory, encodeWireDirectory, hashObject, verifyTreeSnapshotGraph, type ObjectHash, type WireEntryKind, type TreeSnapshot } from "@overstory/protocol";

type ConflictTarget = { kind: "object"; hash: ObjectHash; objectKind: WireEntryKind } | { kind: "boundary"; tree: string } | { kind: "missing" };

function conflictPath(path: string): string[] {
  if (!path.startsWith("/")) throw new Error("Conflict path is not absolute");
  if (path === "/") return [];
  const parts = path.slice(1).split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) throw new Error("Conflict path is invalid");
  return parts;
}

function conflictTarget(snapshot: TreeSnapshot, path: string): ConflictTarget {
  verifyTreeSnapshotGraph(snapshot);
  const parts = conflictPath(path);
  if (!parts.length) return { kind: "object", hash: snapshot.root, objectKind: "directory" };
  let hash = snapshot.root;
  for (const [index, part] of parts.entries()) {
    const bytes = snapshot.objects.get(hash);
    if (!bytes) throw new Error(`Conflict snapshot is missing object: ${hash}`);
    const object = decodeWireDirectory(bytes);
    if (object.type !== "directory") return { kind: "missing" };
    const entry = object.entries.find((candidate) => candidate.name === part);
    if (!entry) return { kind: "missing" };
    if (index === parts.length - 1) {
      if (entry.tree) return { kind: "boundary", tree: entry.tree };
      return entry.file || entry.directory ? { kind: "object", hash: (entry.file ?? entry.directory)!, objectKind: entry.file ? "file" : "directory" } : { kind: "missing" };
    }
    if (!entry.directory) return { kind: "missing" };
    hash = entry.directory;
  }
  return { kind: "missing" };
}

export function conflictContent(snapshot: TreeSnapshot, path: string): SyncConflictContent {
  const target = conflictTarget(snapshot, path);
  if (target.kind === "missing") return { kind: "missing" };
  if (target.kind === "boundary") return { kind: "boundary", tree: target.tree };
  const bytes = snapshot.objects.get(target.hash);
  if (!bytes) throw new Error(`Conflict snapshot is missing object: ${target.hash}`);
  if (target.objectKind === "directory") return { kind: "directory", entries: decodeWireDirectory(bytes).entries.map((entry) => entry.name) };
  try { return { kind: "text", text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) }; }
  catch { return { kind: "binary", bytes: Buffer.from(bytes).toString("base64") }; }
}

export function replaceConflictTarget(destination: TreeSnapshot, path: string, source: TreeSnapshot, editedText?: string): TreeSnapshot {
  verifyTreeSnapshotGraph(destination);
  verifyTreeSnapshotGraph(source);
  const replacement = editedText === undefined
    ? conflictTarget(source, path)
    : (() => {
        const bytes = new TextEncoder().encode(editedText);
        return { kind: "object", hash: hashObject(bytes), objectKind: "file", bytes } as const;
      })();
  const parts = conflictPath(path);
  const objects = new Map(destination.objects);
  for (const [hash, bytes] of source.objects) objects.set(hash, bytes);
  if ("bytes" in replacement) objects.set(replacement.hash, replacement.bytes);
  if (!parts.length) {
    if (replacement.kind !== "object") throw new Error("The tree root cannot be removed or become a boundary");
    return reachableSnapshot(replacement.hash, objects);
  }
  const rewrite = (directoryHash: ObjectHash, depth: number): ObjectHash => {
    const bytes = objects.get(directoryHash);
    if (!bytes) throw new Error(`Conflict snapshot is missing object: ${directoryHash}`);
    const directory = decodeWireDirectory(bytes);
    if (directory.type !== "directory") throw new Error("Conflict path parent is not a directory");
    const name = parts[depth]!;
    const entries = directory.entries.filter((entry) => entry.name !== name);
    if (depth === parts.length - 1) {
      if (replacement.kind === "object") entries.push(replacement.objectKind === "file" ? { name, file: replacement.hash } : { name, directory: replacement.hash });
      if (replacement.kind === "boundary") entries.push({ name, tree: replacement.tree });
    } else {
      const prior = directory.entries.find((entry) => entry.name === name);
      if (!prior?.directory) throw new Error("Conflict path parent is missing");
      entries.push({ name, directory: rewrite(prior.directory, depth + 1) });
    }
    entries.sort((left, right) => compareWireNames(left.name, right.name));
    const next = encodeWireDirectory({ type: "directory", entries, ...(directory.childrenSource ? { childrenSource: directory.childrenSource } : {}) });
    const nextHash = hashObject(next);
    objects.set(nextHash, next);
    return nextHash;
  };
  return reachableSnapshot(rewrite(destination.root, 0), objects);
}

function reachableSnapshot(root: ObjectHash, available: ReadonlyMap<ObjectHash, Uint8Array>): TreeSnapshot {
  const objects = new Map<ObjectHash, Uint8Array>();
  const visit = (hash: ObjectHash, kind: "file" | "directory") => {
    if (objects.has(hash)) return;
    const bytes = available.get(hash);
    if (!bytes) throw new Error(`Retained conflict candidate is missing object: ${hash}`);
    objects.set(hash, bytes);
    if (kind === "directory") for (const entry of decodeWireDirectory(bytes).entries) {
      if (entry.directory) visit(entry.directory, "directory");
      if (entry.file) visit(entry.file, "file");
    }
  };
  visit(root, "directory");
  return verifyTreeSnapshotGraph({ root, objects });
}

/** Directory entries classify children; only directories and Markdown enter the spine. */
