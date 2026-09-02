// One-archive backup of a Canopy data root: an application-consistent SQLite
// copy via VACUUM INTO plus a tar of objects/. Run inside the container or
// against a local data root.
//   bun run migrations/tools/backup-canopy.ts <data-root> <archive.tar>
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const [rootArg, archiveArg] = process.argv.slice(2);
if (!rootArg || !archiveArg) {
  console.error("usage: bun run migrations/tools/backup-canopy.ts <data-root> <archive.tar>");
  process.exit(2);
}
const root = resolve(rootArg);
const archive = resolve(archiveArg);
const staging = await mkdtemp(join(tmpdir(), "canopy-backup-"));
try {
  const db = new Database(join(root, "canopy.sqlite3"), { readonly: true });
  db.run(`VACUUM INTO '${join(staging, "canopy.sqlite3").replaceAll("'", "''")}'`);
  db.close();
  const tar = Bun.spawn(["tar", "-cf", archive, "-C", staging, "canopy.sqlite3", "-C", root, "objects"], { stdout: "inherit", stderr: "inherit" });
  if ((await tar.exited) !== 0) throw new Error("tar failed");
  const size = Bun.file(archive).size;
  console.log(JSON.stringify({ archive, bytes: size }, null, 2));
} finally {
  await rm(staging, { recursive: true, force: true });
}
