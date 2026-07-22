import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { sha256 } from "@arbor/core";

export function arborDataRoot(): string {
  if (process.env.ARBOR_DATA_HOME) return process.env.ARBOR_DATA_HOME;
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "Arbor");
  if (process.platform === "win32") return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Arbor");
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "arbor");
}

export async function workspaceStateDirectory(root: string): Promise<string> {
  const canonical = await realpath(root);
  const registryPath = join(arborDataRoot(), "workspaces.json");
  await mkdir(dirname(registryPath), { recursive: true });
  let registry: Record<string, string> = {};
  try {
    registry = JSON.parse(await readFile(registryPath, "utf8")) as Record<string, string>;
  } catch {}
  let id = registry[canonical];
  if (!id) {
    id = `${sha256(canonical).slice(0, 12)}-${crypto.randomUUID().slice(0, 8)}`;
    registry[canonical] = id;
    await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 });
  }
  const directory = join(arborDataRoot(), "workspaces", id);
  await mkdir(directory, { recursive: true });
  return directory;
}
