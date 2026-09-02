// Restore a backup archive into an empty data root.
//   bun run migrations/tools/restore-canopy.ts <archive.tar> <data-root>
import { mkdir, readdir } from "node:fs/promises";
import { resolve } from "node:path";

const [archiveArg, rootArg] = process.argv.slice(2);
if (!archiveArg || !rootArg) {
  console.error("usage: bun run migrations/tools/restore-canopy.ts <archive.tar> <data-root>");
  process.exit(2);
}
const root = resolve(rootArg);
await mkdir(root, { recursive: true });
if ((await readdir(root)).length) {
  console.error(`refusing to restore into a nonempty directory: ${root}`);
  process.exit(1);
}
const tar = Bun.spawn(["tar", "-xf", resolve(archiveArg), "-C", root], { stdout: "inherit", stderr: "inherit" });
process.exit(await tar.exited);
