import { chmod, copyFile, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { STORY_VERSION } from "@ovst/story-sync";

/** True in the `bun build --compile` executable the npm package ships, whose own modules live in Bun's embedded filesystem. */
export const compiledExecutable = import.meta.path.startsWith("/$bunfs/") || /^[A-Za-z]:[\\/]~BUN[\\/]/.test(import.meta.path);

/** The command that runs this same CLI again: the executable alone when compiled, otherwise Bun and the entry script. */
export function storyCommand(): string[] {
  if (compiledExecutable) return [process.execPath];
  const entry = process.argv[1];
  if (!entry) throw new Error("Cannot locate the Story CLI entry point");
  return [process.execPath, entry];
}

/** Preserve the executable a service runs independently of npx's or bunx's disposable package cache. */
export async function persistPackageRuntime(executable: string, home: string): Promise<string> {
  const hash = createHash("sha256").update("story-runtime-3").update(await readFile(executable)).digest("hex").slice(0, 16);
  const destination = join(home, "Library", "Application Support", "Story", "CLI", `${STORY_VERSION}-${hash}`);
  const installed = join(destination, "story");
  if (await stat(installed).then(() => true, () => false)) return installed;
  const staging = `${destination}.${crypto.randomUUID()}.tmp`;
  await mkdir(staging, { recursive: true, mode: 0o700 });
  try {
    await copyFile(executable, join(staging, "story"));
    await chmod(join(staging, "story"), 0o755);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    try { await rename(staging, destination); }
    catch (error) {
      if (!await stat(installed).then(() => true, () => false)) throw error;
    }
    return installed;
  } finally { await rm(staging, { recursive: true, force: true }); }
}
