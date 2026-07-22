import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

export async function writeAtomic(path: string, contents: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${path.split("/").pop()}.arbor-${crypto.randomUUID()}.tmp`);
  const file = await open(temporary, "wx", 0o644);
  try {
    await file.writeFile(contents);
    await file.sync();
  } finally { await file.close(); }
  await rename(temporary, path);
  const directory = await open(dirname(path), "r");
  try { await directory.sync(); } finally { await directory.close(); }
}

export async function moveCollisionSafe(source: string, destination: string): Promise<string> {
  await mkdir(dirname(destination), { recursive: true });
  let candidate = destination;
  let suffix = 2;
  const dot = destination.lastIndexOf(".");
  const stem = dot > destination.lastIndexOf("/") ? destination.slice(0, dot) : destination;
  const extension = stem === destination ? "" : destination.slice(dot);
  for (;;) {
    try { await stat(candidate); candidate = `${stem}-${suffix++}${extension}`; }
    catch { break; }
  }
  await rename(source, candidate);
  return candidate;
}

export async function removeIfExists(path: string): Promise<void> {
  await rm(path, { force: true, recursive: true });
}
