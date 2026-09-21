import { cp, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/** Preserve installed services independently of bunx's disposable package cache. */
export async function persistPackageRuntime(script: string, home: string): Promise<string> {
  const packageRoot = dirname(dirname(script));
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  if (manifest.name !== "@overstory/cli") throw new Error("Expected a packaged Arbor CLI runtime");
  const hash = createHash("sha256").update("arbor-runtime-2").update(await readFile(script)).digest("hex").slice(0, 16);
  const destination = join(home, "Library", "Application Support", "Arbor", "CLI", `${manifest.version}-${hash}`);
  const installed = join(destination, "bin", "arborsync.js");
  if (await stat(installed).then(() => true, () => false)) return installed;
  const staging = `${destination}.${crypto.randomUUID()}.tmp`;
  await mkdir(staging, { recursive: true, mode: 0o700 });
  try {
    await cp(join(packageRoot, "bin"), join(staging, "bin"), { recursive: true, dereference: true });
    await cp(join(packageRoot, "package.json"), join(staging, "package.json"));
    const copied = new Set<string>();
    const copyDependency = async (name: string, from: string): Promise<void> => {
      if (copied.has(name)) return;
      const manifestPath = createRequire(from).resolve(`${name}/package.json`);
      const dependency = JSON.parse(await readFile(manifestPath, "utf8"));
      copied.add(name);
      await cp(dirname(manifestPath), join(staging, "node_modules", name), { recursive: true, dereference: true });
      for (const child of Object.keys(dependency.dependencies ?? {})) await copyDependency(child, manifestPath);
    };
    await copyDependency("@parcel/watcher", script);
    await copyDependency(`@parcel/watcher-darwin-${process.arch}`, createRequire(script).resolve("@parcel/watcher"));
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    try { await rename(staging, destination); }
    catch (error) {
      if (!await stat(installed).then(() => true, () => false)) throw error;
    }
    return installed;
  } finally { await rm(staging, { recursive: true, force: true }); }
}
