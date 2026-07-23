import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { revisionOf } from "@arbor/core";

export function transactionTemporaryPath(path: string, transactionId: string): string {
  return join(dirname(path), `.${path.split("/").pop()}.arbor-txn-${transactionId}`);
}

export async function prepareAtomic(path: string, contents: string | Uint8Array, temporary?: string): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  const target = temporary ?? join(dirname(path), `.${path.split("/").pop()}.arbor-write-${crypto.randomUUID()}`);
  const file = await open(target, "wx", 0o644);
  try {
    await file.writeFile(contents);
    await file.sync();
  } finally { await file.close(); }
  return target;
}

export async function commitPrepared(temporary: string, path: string): Promise<void> {
  await rename(temporary, path);
  await syncDirectory(dirname(path));
}

export async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, "r");
  try { await directory.sync(); } finally { await directory.close(); }
}

export async function writeAtomic(path: string, contents: string | Uint8Array): Promise<void> {
  const temporary = await prepareAtomic(path, contents);
  await commitPrepared(temporary, path);
}

export async function readRevision(path: string): Promise<{ bytes: Uint8Array; revision: string }> {
  const bytes = new Uint8Array(await readFile(path));
  return { bytes, revision: revisionOf(bytes) };
}

export async function pathExists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

export async function removeIfExists(path: string): Promise<void> {
  await rm(path, { force: true, recursive: true });
}
