/**
 * `story migrate`: Rename 001's one-time move of this Mac's local state from
 * the Arbor and Canopy names to the Story names
 * (plans/rename/001-overstory-names.md, step 2).
 *
 * Throwaway. This module, its command in index.ts, the
 * `relocateProfilePath` method it calls in @ovst/client, and its test
 * (tests/integration/cli-migrate-rename-001.test.ts) are deleted at the
 * plan's close-out. The old names in it are intended.
 *
 * It refuses unless nothing is using the old home, takes
 * `<old home>/.state/migration.lock`, renames the home, and then rewrites
 * what recorded the old paths. There is no rollback: when a step fails after
 * the rename it stops, leaves the lock in place so nothing starts on a
 * half-moved home, and prints what was done and what was not.
 */
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { isMap, isScalar, parseDocument } from "yaml";
import { parseLocalPlacements, ProfileIdentityStore } from "@ovst/client";

const DEFAULT_PROBE_URL = "http://127.0.0.1:4317/v1/status";
/** Rebuildable or disposable app-support entries that are dropped instead of moved. */
const DROPPED_SUPPORT_ENTRIES = ["CLI", "Logs", "Directory.json", "Avatars", "LinkPreviews", "EditorRecovery"];
/** Directories a placed folder's walk never enters. */
const SKIPPED_DIRECTORIES = new Set([".git", "node_modules", ".overstory", ".arbor"]);

interface MigrateOptions {
  oldHome: string;
  newHome: string;
  oldSupport: string;
  newSupport: string;
  /** True when no location was overridden: the real `~/.arbor` and Application Support. */
  defaults: boolean;
  dryRun: boolean;
  probeURL: string;
}

type Relocate = (path: string) => string;

export const MIGRATE_USAGE = "story migrate [--dry-run] [--old-home <dir> --new-home <dir> --old-support <dir> --new-support <dir>] [--probe-url <url>]";

function parseOptions(args: string[]): MigrateOptions {
  const values: Record<string, string> = {};
  let dryRun = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--dry-run") dryRun = true;
    else if (["--old-home", "--new-home", "--old-support", "--new-support", "--probe-url"].includes(argument)) {
      const value = args[++index];
      if (!value) throw new Error(`${argument} requires a value\nUsage: ${MIGRATE_USAGE}`);
      values[argument] = value;
    } else throw new Error(`Unknown argument: ${argument}\nUsage: ${MIGRATE_USAGE}`);
  }
  const locations = ["--old-home", "--new-home", "--old-support", "--new-support"];
  const given = locations.filter((name) => values[name] !== undefined);
  // An override run never falls back to a real location for the ones left out.
  if (given.length !== 0 && given.length !== locations.length) {
    throw new Error(`Override all four locations or none: ${locations.join(", ")}`);
  }
  const defaults = given.length === 0;
  const support = join(homedir(), "Library", "Application Support");
  return {
    oldHome: resolve(values["--old-home"] ?? join(homedir(), ".arbor")),
    newHome: resolve(values["--new-home"] ?? join(homedir(), ".story")),
    oldSupport: resolve(values["--old-support"] ?? join(support, "Arbor")),
    newSupport: resolve(values["--new-support"] ?? join(support, "Story")),
    defaults,
    dryRun,
    probeURL: values["--probe-url"] ?? DEFAULT_PROBE_URL,
  };
}

async function kind(path: string): Promise<"missing" | "directory" | "file" | "other"> {
  try {
    const info = await lstat(path);
    return info.isDirectory() ? "directory" : info.isFile() ? "file" : "other";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

async function readOptional(path: string): Promise<string | null> {
  try { return await readFile(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function readJSON(path: string): Promise<unknown> {
  const source = await readOptional(path);
  if (source === null) return undefined;
  try { return JSON.parse(source); }
  catch { throw new Error(`${path} is not valid JSON`); }
}

async function atomicWrite(path: string, contents: string): Promise<void> {
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, contents, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

/** The canonical form a path will have once it exists: its nearest existing ancestor resolved. */
async function canonical(path: string): Promise<string> {
  const missing: string[] = [];
  let current = path;
  for (;;) {
    try { return join(await realpath(current), ...missing.reverse()); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(current) === current) throw error;
      missing.push(basename(current));
      current = dirname(current);
    }
  }
}

async function device(path: string): Promise<number> {
  let current = path;
  for (;;) {
    try { return (await stat(current)).dev; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(current) === current) throw error;
      current = dirname(current);
    }
  }
}

/** Map a path at or under one of the old locations to its new location; longer prefixes win. */
function relocator(pairs: Array<[string, string]>): Relocate {
  const ordered = [...pairs].sort((left, right) => right[0].length - left[0].length);
  return (path) => {
    for (const [from, to] of ordered) {
      if (path === from) return to;
      if (path.startsWith(`${from}/`)) return `${to}${path.slice(from.length)}`;
    }
    return path;
  };
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

async function somethingAnswers(url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(2_000) });
    return true;
  } catch (error) {
    // A listener that accepts and never answers is still a running daemon.
    return error instanceof Error && error.name === "TimeoutError";
  }
}

/** Reasons a real run must not start. Reads only. */
async function refusals(options: MigrateOptions): Promise<{ fatal: string[]; blocking: string[] }> {
  const fatal: string[] = [], blocking: string[] = [];
  if (options.defaults) {
    for (const name of ["STORY_HOME", "ARBOR_DATA_HOME", "STORY_REQUIRE_HOME"]) {
      if (process.env[name]) blocking.push(`${name} is set; unset it so the default data home is the one migrated`);
    }
  }
  if (await kind(options.oldHome) !== "directory") {
    fatal.push(`${options.oldHome} is not a directory; there is nothing to migrate`);
    return { fatal, blocking };
  }
  if (await kind(options.newHome) !== "missing") blocking.push(`${options.newHome} already exists`);
  const state = join(options.oldHome, ".state");
  if (await kind(join(state, "migration.lock")) !== "missing") {
    blocking.push(`${join(state, "migration.lock")} exists; an earlier migration did not finish`);
  }
  if (await kind(join(state, "bootstrap-account-claim.json")) !== "missing") blocking.push("an account claim is in progress (.state/bootstrap-account-claim.json)");
  if (await kind(join(state, "bootstrap-pairing.json")) !== "missing") blocking.push("a device pairing is in progress (.state/bootstrap-pairing.json)");
  try {
    const registry = object(await readJSON(join(options.oldHome, "cloud-sessions", "sessions.json")));
    if (registry) {
      if (!Array.isArray(registry.sessions)) throw new Error("cloud-sessions/sessions.json has no session list");
      const live = registry.sessions.filter((session) => object(session)?.phase !== "finished");
      if (live.length) {
        blocking.push(`${live.length} cloud session(s) are not finished: ${live.map((session) => `${object(session)?.sessionID ?? "?"} (${object(session)?.phase ?? "?"})`).join(", ")}`);
      }
    }
  } catch (error) { fatal.push(error instanceof Error ? error.message : String(error)); }
  try {
    const placements = await readOptional(join(options.oldHome, "placements.yaml"));
    if (placements !== null) parseLocalPlacements(placements);
  } catch (error) { fatal.push(`placements.yaml is invalid: ${error instanceof Error ? error.message : String(error)}`); }
  for (const name of ["workspaces.json", "self.json"]) {
    try {
      const value = await readJSON(join(state, name));
      if (value !== undefined && !object(value)) throw new Error(`${join(state, name)} is not a JSON object`);
    } catch (error) { fatal.push(error instanceof Error ? error.message : String(error)); }
  }
  if (await device(options.oldHome) !== await device(options.newHome)) {
    blocking.push(`${options.oldHome} and ${options.newHome} are on different volumes; the home is moved only by a rename`);
  }
  const oldSupport = await kind(options.oldSupport);
  if (oldSupport === "file" || oldSupport === "other") fatal.push(`${options.oldSupport} is not a directory`);
  if (oldSupport === "directory") {
    try {
      const placement = await readJSON(join(options.oldSupport, "Native Placement.json"));
      if (placement !== undefined && !object(placement)) throw new Error(`${join(options.oldSupport, "Native Placement.json")} is not a JSON object`);
    } catch (error) { fatal.push(error instanceof Error ? error.message : String(error)); }
    const newSupport = await kind(options.newSupport);
    if (newSupport === "file" || newSupport === "other") blocking.push(`${options.newSupport} exists and is not a directory`);
    if (newSupport === "directory") {
      for (const entry of await readdir(options.oldSupport)) {
        if (DROPPED_SUPPORT_ENTRIES.includes(entry) || entry === ".DS_Store") continue;
        if (await kind(join(options.newSupport, entry)) !== "missing") blocking.push(`${join(options.newSupport, entry)} already exists`);
      }
    }
    if (await device(options.oldSupport) !== await device(options.newSupport)) {
      blocking.push(`${options.oldSupport} and ${options.newSupport} are on different volumes`);
    }
  }
  if (await somethingAnswers(options.probeURL)) {
    blocking.push(`something answers ${options.probeURL}; stop the sync daemon and quit the app first`);
  }
  return { fatal, blocking };
}

/** The steps' shared context: where things are now, how paths move, and how an action is carried out or only printed. */
interface Run {
  options: MigrateOptions;
  /** Where the data home and app-support directory are while the steps run: the old ones in a dry run. */
  home: string;
  support: string;
  relocate: Relocate;
  /** Carry out one change, or in a dry run only print it. */
  act(description: string, change: () => Promise<void>): Promise<void>;
  /** Print something that needs no change. */
  note(message: string): void;
  /** Placed folders (and the profile folder) at their current paths, collected before the files naming them are rewritten. */
  folders: string[];
  /** Things the person should look at afterwards. */
  attention: string[];
}

async function rewritePlacements(run: Run): Promise<void> {
  const path = join(run.home, "placements.yaml");
  const source = await readOptional(path);
  if (source === null) return run.note(`${path}: absent`);
  const before = parseLocalPlacements(source);
  // What the daemon will walk after the move; in a dry run, where they are now.
  for (const placement of before) run.folders.push(run.options.dryRun ? placement.path : run.relocate(placement.path));
  const document = parseDocument(source, { uniqueKeys: true, keepSourceTokens: true });
  if (document.errors.length) throw new Error(document.errors[0]!.message);
  let changed = 0;
  if (isMap(document.contents)) {
    for (const account of document.contents.items) {
      if (!isMap(account.value)) continue;
      for (const placement of account.value.items) {
        const key = placement.key;
        if (!isScalar(key) || typeof key.value !== "string") continue;
        const next = run.relocate(key.value);
        if (next === key.value) continue;
        key.value = next;
        changed += 1;
      }
    }
  }
  if (!changed) return run.note(`${path}: no placement is under the old locations`);
  const next = document.toString({ lineWidth: 0 });
  const expected = before.map((placement) => ({ ...placement, path: run.relocate(placement.path) }));
  if (JSON.stringify(parseLocalPlacements(next)) !== JSON.stringify(expected)) {
    throw new Error("Rewriting placements.yaml would change more than its paths");
  }
  await run.act(`rewrite ${changed} placement path(s) in ${path}`, () => atomicWrite(path, next));
}

async function rewriteWorkspaces(run: Run): Promise<void> {
  const path = join(run.home, ".state", "workspaces.json");
  const stored = object(await readJSON(path));
  if (!stored) return run.note(`${path}: absent`);
  const next: Record<string, unknown> = {};
  let changed = 0;
  for (const [key, value] of Object.entries(stored)) {
    const nextKey = run.relocate(key);
    if (nextKey in next) throw new Error(`Two workspace records would share ${nextKey}`);
    const record = object(value);
    const nextPath = record && typeof record.path === "string" ? run.relocate(record.path) : undefined;
    if (nextKey !== key || (nextPath !== undefined && nextPath !== record!.path)) changed += 1;
    next[nextKey] = nextPath === undefined ? value : { ...record, path: nextPath };
  }
  if (!changed) return run.note(`${path}: no workspace is under the old locations`);
  await run.act(`rewrite ${changed} workspace path(s) in ${path}`, () => atomicWrite(path, `${JSON.stringify(next, null, 2)}\n`));
}

async function rewriteSelf(run: Run): Promise<void> {
  const path = join(run.home, ".state", "self.json");
  const stored = object(await readJSON(path));
  if (!stored) return run.note(`${path}: absent (no identity in this home)`);
  if (typeof stored.profilePath !== "string") throw new Error(`${path} has no profilePath`);
  run.folders.push(run.options.dryRun ? stored.profilePath : run.relocate(stored.profilePath));
  const next = run.relocate(stored.profilePath);
  if (next === stored.profilePath) return run.note(`${path}: the profile folder is outside the old locations`);
  // `credential` names the credential-store item, which does not move.
  await run.act(`set profilePath to ${next} in ${path}`, () => atomicWrite(path, `${JSON.stringify({ ...stored, profilePath: next }, null, 2)}\n`));
}

async function rewriteCloudSessions(run: Run): Promise<void> {
  const path = join(run.home, "cloud-sessions", "sessions.json");
  const stored = object(await readJSON(path));
  if (!stored || !Array.isArray(stored.sessions)) return run.note(`${path}: absent`);
  let changed = 0;
  const sessions = stored.sessions.map((session) => {
    const record = object(session);
    if (!record || typeof record.dataHome !== "string") return session;
    const next = run.relocate(record.dataHome);
    if (next === record.dataHome) return session;
    changed += 1;
    return { ...record, dataHome: next };
  });
  if (!changed) return run.note(`${path}: no session data home is under the old locations`);
  await run.act(`rewrite dataHome of ${changed} cloud session(s) in ${path}`, () => atomicWrite(path, `${JSON.stringify({ ...stored, sessions }, null, 2)}\n`));
}

async function withEnvironment<T>(values: Record<string, string>, operation: () => Promise<T>): Promise<T> {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  try { return await operation(); }
  finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/**
 * The identity record (a keychain item, or `self.identity.json` with the
 * file credential store) repeats `profilePath`. It is updated in place under
 * the same service and account, and read back.
 */
async function rewriteIdentityRecord(run: Run): Promise<void> {
  const self = object(await readJSON(join(run.home, ".state", "self.json")));
  if (!self) return run.note("identity record: no identity in this home");
  if (run.options.dryRun) {
    // A dry run never opens the credential store.
    console.log(`would update profilePath inside the identity record ${String(self.credential)} (or .state/self.identity.json with the file credential store), same service and account, and read it back`);
    return;
  }
  // An override run works on a scratch or copied home: it must never reach
  // the real keychain item, so it uses the file credential store only.
  const environment: Record<string, string> = run.options.defaults ? {} : { STORY_HOME: run.options.newHome, STORY_CREDENTIAL_STORE: "file" };
  await withEnvironment(environment, async () => {
    const store = new ProfileIdentityStore();
    const result = await store.relocateProfilePath(run.relocate);
    if (result.status === "absent") {
      run.note(`identity record: not rewritten, ${result.reason}`);
      run.attention.push(`The identity record was not rewritten (${result.reason}). Run \`story me\` and confirm the private key is available.`);
      return;
    }
    const check = await store.relocateProfilePath(run.relocate);
    if (check.status !== "unchanged" || check.to !== result.to) throw new Error("The identity record did not read back with the new profilePath");
    if (result.status === "updated") console.log(`did   update profilePath inside the identity record ${result.credential}: ${result.from} -> ${result.to} (read back)`);
    else run.note(`identity record ${result.credential}: profilePath is outside the old locations`);
  });
}

async function moveSupport(run: Run): Promise<void> {
  const { oldSupport, newSupport } = run.options;
  if (await kind(oldSupport) !== "directory") return run.note(`${oldSupport}: absent`);
  if (await kind(newSupport) === "missing") await run.act(`create ${newSupport}`, async () => { await mkdir(newSupport, { recursive: true, mode: 0o700 }); });
  for (const entry of (await readdir(oldSupport)).sort()) {
    const from = join(oldSupport, entry);
    if (DROPPED_SUPPORT_ENTRIES.includes(entry) || entry === ".DS_Store") {
      await run.act(`remove ${from} (rebuildable)`, () => rm(from, { recursive: true, force: true }));
    } else {
      await run.act(`move ${from} to ${join(newSupport, entry)}`, () => rename(from, join(newSupport, entry)));
    }
  }
  await run.act(`remove the emptied ${oldSupport}`, () => rmdir(oldSupport));
  const path = join(run.support, "Native Placement.json");
  const stored = object(await readJSON(path));
  if (!stored) return run.note(`${path}: absent`);
  let changed = 0;
  const moved = (value: unknown): unknown => {
    const record = object(value);
    if (!record || typeof record.osPath !== "string") return value;
    const next = run.relocate(record.osPath);
    if (next === record.osPath) return value;
    changed += 1;
    return { ...record, osPath: next };
  };
  // Either the collection layout or the original single-record file.
  const next = Array.isArray(stored.placements) ? { ...stored, placements: stored.placements.map(moved) } : moved(stored);
  if (!changed) return run.note(`${path}: no osPath is under the old locations`);
  await run.act(`rewrite ${changed} osPath value(s) in ${join(newSupport, "Native Placement.json")}`, () => atomicWrite(path, `${JSON.stringify(next, null, 2)}\n`));
}

async function tidyPlacedFolders(run: Run): Promise<void> {
  const roots = [...new Set(run.folders)].sort();
  const rootSet = new Set(roots);
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        // A nested placed folder is walked once, as its own root.
        if (!SKIPPED_DIRECTORIES.has(entry.name) && !rootSet.has(path)) await walk(path);
      } else if (!entry.isFile()) {
        continue;
      } else if (entry.name === ".arborignore") {
        const target = join(directory, ".overstoryignore");
        if (await kind(target) !== "missing") {
          run.note(`${path}: kept, because ${target} already exists`);
          run.attention.push(`${path} was kept because .overstoryignore already exists beside it; merge and delete it by hand.`);
        } else await run.act(`rename ${path} to .overstoryignore`, () => rename(path, target));
      } else if (entry.name.includes(".arbor-write-") || entry.name.includes(".arbor-txn-")) {
        await run.act(`delete stray temporary ${path}`, () => rm(path, { force: true }));
      }
    }
  };
  if (!roots.length) return run.note("placed folders: none");
  for (const root of roots) {
    if (await kind(root) !== "directory") {
      run.note(`placed folder ${root}: missing, skipped`);
      continue;
    }
    await walk(root);
  }
}

async function deleteRebuildableState(run: Run): Promise<void> {
  const state = join(run.home, ".state");
  const sessions: string[] = [];
  const find = async (directory: string): Promise<void> => {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) await find(join(directory, entry.name));
      else if (entry.name === "session.json") sessions.push(join(directory, entry.name));
    }
  };
  await find(join(state, "accounts"));
  for (const path of sessions.sort()) await run.act(`delete ${path}`, () => rm(path, { force: true }));
  const workspaces = join(state, "workspaces");
  if (await kind(workspaces) !== "directory") return;
  for (const workspace of (await readdir(workspaces)).sort()) {
    if (await kind(join(workspaces, workspace)) !== "directory") continue;
    for (const entry of (await readdir(join(workspaces, workspace))).sort()) {
      if (!entry.startsWith("index.sqlite")) continue;
      const path = join(workspaces, workspace, entry);
      await run.act(`delete ${path}`, () => rm(path, { force: true }));
    }
  }
}

/** Run the migration; the result is the process exit status. */
export async function migrateCommand(args: string[]): Promise<number> {
  const options = parseOptions(args);
  const { oldHome, newHome, oldSupport, newSupport, dryRun } = options;
  console.log(`${dryRun ? "Dry run: nothing is changed.\n" : ""}Data home:   ${oldHome} -> ${newHome}\nApp support: ${oldSupport} -> ${newSupport}`);
  if (!options.defaults) console.log("Locations are overridden: the identity record is handled through the file credential store only.");

  const { fatal, blocking } = await refusals(options);
  if (fatal.length || blocking.length) {
    console.error(`${dryRun ? "A real run would refuse" : "Refusing to migrate"}:`);
    for (const reason of [...fatal, ...blocking]) console.error(`  - ${reason}`);
    if (!dryRun || fatal.length) {
      console.error("Nothing was changed.");
      return 1;
    }
  }

  const pairs: Array<[string, string]> = [[oldHome, newHome], [await realpath(oldHome), await canonical(newHome)]];
  if (await kind(oldSupport) === "directory") pairs.push([oldSupport, newSupport], [await realpath(oldSupport), await canonical(newSupport)]);
  const done: string[] = [];
  const run: Run = {
    options,
    home: dryRun ? oldHome : newHome,
    support: dryRun ? oldSupport : newSupport,
    relocate: relocator(pairs),
    folders: [],
    attention: [],
    note: (message) => console.log(`      ${message}`),
    act: async (description, change) => {
      if (dryRun) {
        console.log(`would ${description}`);
        return;
      }
      await change();
      done.push(description);
      console.log(`did   ${description}`);
    },
  };

  const oldLock = join(oldHome, ".state", "migration.lock"), newLock = join(newHome, ".state", "migration.lock");
  if (dryRun) {
    console.log(`would create ${oldLock}`);
    console.log(`would rename ${oldHome} to ${newHome}`);
  } else {
    await mkdir(join(oldHome, ".state"), { recursive: true, mode: 0o700 });
    await writeFile(oldLock, `${JSON.stringify({ migration: "rename-001", pid: process.pid, startedAt: new Date().toISOString() })}\n`, { mode: 0o600, flag: "wx" });
    try { await rename(oldHome, newHome); }
    catch (error) {
      await rm(oldLock, { force: true });
      console.error(`Could not rename ${oldHome} to ${newHome}: ${error instanceof Error ? error.message : String(error)}`);
      console.error("Nothing was changed.");
      return 1;
    }
    done.push(`rename ${oldHome} to ${newHome} (with .state/migration.lock held)`);
    console.log(`did   rename ${oldHome} to ${newHome}`);
  }

  const steps: Array<[string, (run: Run) => Promise<void>]> = [
    ["rewrite paths in placements.yaml", rewritePlacements],
    ["rewrite paths in .state/workspaces.json", rewriteWorkspaces],
    ["rewrite profilePath in .state/self.json", rewriteSelf],
    ["rewrite dataHome in cloud-sessions/sessions.json", rewriteCloudSessions],
    ["update profilePath inside the identity record", rewriteIdentityRecord],
    ["move the app-support directory and rewrite Native Placement.json", moveSupport],
    ["rename .arborignore and delete stray temporaries in placed folders", tidyPlacedFolders],
    ["delete accounts/**/session.json and workspaces/*/index.sqlite*", deleteRebuildableState],
  ];
  for (let index = 0; index < steps.length; index += 1) {
    const [name, step] = steps[index]!;
    try { await step(run); }
    catch (error) {
      // No rollback: every change so far is kept and listed, and the lock stays.
      console.error(`\nMigration stopped while it was to ${name}: ${error instanceof Error ? error.message : String(error)}`);
      if (dryRun) return 1;
      console.error("Done:");
      for (const description of done) console.error(`  - ${description}`);
      console.error("Not done (this step may be partly done; see the list above):");
      for (const [remaining] of steps.slice(index)) console.error(`  - ${remaining}`);
      console.error(`  - remove ${newLock}`);
      console.error(`The lock ${newLock} is left in place, so Story will not start on this home. Finish the steps by hand, then delete the lock.`);
      return 1;
    }
  }

  if (dryRun) {
    console.log(`would remove ${oldLock.replace(oldHome, newHome)}`);
    console.log(blocking.length ? "\nDry run finished; a real run would refuse for the reasons above." : "\nDry run finished; a real run would not refuse.");
    return blocking.length ? 1 : 0;
  }
  await rm(newLock, { force: true });
  console.log(`did   remove ${newLock}`);
  console.log(`\nMigrated: ${done.length} change(s). The data home is ${newHome}.`);
  for (const item of run.attention) console.log(`Attention: ${item}`);
  console.log("Next:\n  story daemon install\n  story status");
  return 0;
}
