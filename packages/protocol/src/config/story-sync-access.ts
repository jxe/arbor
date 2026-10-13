import { chmod, link, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { storyDataRoot } from "./private-state.ts";

/**
 * Who may call a data home's Story Sync: the holder of its caller token, which
 * only the data home's own user can read. `origin` is where its Story Sync last
 * started listening. See docs/architecture/story-sync/data-home.md.
 */
export interface StorySyncAccess {
  version: 1;
  token: string;
  origin?: string;
}

/** The port a data home's Story Sync prefers, and how far past it one looks when another user holds it. */
export const STORY_SYNC_DEFAULT_PORT = 4317;
export const STORY_SYNC_PORT_RANGE = 20;

export function storySyncAccessPath(dataHome = storyDataRoot()): string {
  return join(dataHome, ".state", "story-sync.json");
}

function parseAccess(text: string): StorySyncAccess | null {
  try {
    const value = JSON.parse(text) as Partial<StorySyncAccess>;
    if (value?.version !== 1 || typeof value.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value.token)) return null;
    return { version: 1, token: value.token, ...(typeof value.origin === "string" ? { origin: value.origin } : {}) };
  } catch {
    return null;
  }
}

/** The data home's caller token and recorded origin, or null when none has been made yet. */
export async function readStorySyncAccess(dataHome = storyDataRoot()): Promise<StorySyncAccess | null> {
  const text = await readFile(storySyncAccessPath(dataHome), "utf8").catch(() => null);
  return text === null ? null : parseAccess(text);
}

async function writeAtomically(path: string, access: StorySyncAccess, exclusive: boolean): Promise<boolean> {
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(access)}\n`, { mode: 0o600, flag: "wx" });
    if (!exclusive) {
      await rename(temporary, path);
      return true;
    }
    // A hard link never replaces an existing file, so the first writer's token wins.
    try { await link(temporary, path); return true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

/** The data home's caller token, created on first use. */
export async function ensureStorySyncAccess(dataHome = storyDataRoot()): Promise<StorySyncAccess> {
  const existing = await readStorySyncAccess(dataHome);
  if (existing) return existing;
  const state = join(dataHome, ".state");
  await mkdir(state, { recursive: true, mode: 0o700 });
  await chmod(dataHome, 0o700).catch(() => {});
  await chmod(state, 0o700).catch(() => {});
  const path = storySyncAccessPath(dataHome);
  const fresh: StorySyncAccess = { version: 1, token: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url") };
  // An unreadable file left by a crash is replaced; a valid one written meanwhile is kept.
  if (await readFile(path, "utf8").then((text) => parseAccess(text) === null).catch(() => false)) await rm(path, { force: true });
  if (await writeAtomically(path, fresh, true)) return fresh;
  const raced = await readStorySyncAccess(dataHome);
  if (!raced) throw new Error(`Story Sync caller token is unreadable: ${path}`);
  return raced;
}

/** Record where the data home's Story Sync now listens, keeping its token. */
export async function recordStorySyncOrigin(origin: string, dataHome = storyDataRoot()): Promise<void> {
  const access = await ensureStorySyncAccess(dataHome);
  if (access.origin === origin) return;
  await writeAtomically(storySyncAccessPath(dataHome), { ...access, origin }, false);
}

/** The header a caller sends. */
export function storySyncAuthorization(access: Pick<StorySyncAccess, "token">): string {
  return `Bearer ${access.token}`;
}

/** The header that lets the data home's own tools call its Story Sync; empty when it has no token yet. */
export async function storySyncHeaders(dataHome?: string): Promise<Record<string, string>> {
  const access = await readStorySyncAccess(dataHome);
  return access ? { authorization: storySyncAuthorization(access) } : {};
}
