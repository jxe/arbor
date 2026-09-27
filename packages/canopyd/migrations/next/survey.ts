import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { parse as parseYAML } from "yaml";
import type { HostSurvey } from "./survey-host.ts";

/**
 * The pre-cutover survey: read-only checks that the state each legacy reader
 * existed for is gone from this Mac, the iPhone's copied container and the
 * live host. It never writes anything. Joe runs it on the Mac before the
 * cutover (see README.md, "Before cutover: the survey"):
 *
 *   bun run packages/canopyd/migrations/next/survey.ts \
 *     [--iphone <copied container>] [--live <survey-host.json>]
 *
 * Each line is PASS, FAIL or SKIP, the check, the commit to `git revert` when
 * it fails (for the legacy removals on this branch), and details. It exits 1
 * when any check fails.
 */

/** The commit subjects of the removals, as `git log` prints them. */
export const REVERT = {
  scalarMembers: "Remove scalar /~handle group members",
  prePluralFiles: "Remove the pre-plural account files refusal from account bootstrap",
  placementConfiguration: "Require a configuration tree on every placement",
  keychainIdentities: "Remove Keychain identities without metadata",
  earlyConnections: "Remove early Interface 005 connection records from HostAccountStore.safe",
  earlierSyncState: "Remove the earlier folder synchronizer's state",
  updateControl: "Remove update control before schema 4",
  legacyModifiedAt: "Remove legacyModifiedAt from working-tree node records",
} as const;

/** Checks whose state must be fixed rather than a commit reverted name what they gate. */
const GATES = {
  digestRetirement: "gates batch step 026 and key-only devices: deauthorize the device, do not revert",
  singletonCredential: "gates the removal of the singleton device credential: re-place the tree first",
  batch024: "gates batch step 024 (drop profile_resets), which refuses otherwise",
  claimShape: "gates the CBOR claim shape: finish or discard the pending claim with the current build first",
} as const;

export interface CheckResult {
  status: "PASS" | "FAIL" | "SKIP";
  name: string;
  /** The commit subject to revert, or what else the check gates. */
  revert?: string;
  gate?: string;
  details: string;
}

export interface SurveyOptions {
  /** The home directory whose `.arbor` and `Library/Application Support/Arbor` are surveyed. */
  home: string;
  /** A copy of the iPhone app's data container (`xcrun devicectl … copy from`). */
  iphone?: string;
  /** survey-host.ts output. */
  live?: string;
  /** Defaults to `process.platform`; the Keychain check runs only on darwin. */
  platform?: NodeJS.Platform;
  /** Runs `/usr/bin/security` read-only; injectable for tests. */
  security?: (args: string[]) => { status: number | null; stdout: string };
}

const TREE_ID = /^tr_[a-z2-7]+$/;
const IDENTITY_SERVICE = "org.arbor.person-profile";
/** The Mac app's own identity record, which Canopy for Mac no longer reads. */
const NATIVE_IDENTITY_SERVICE = "org.nxhx.Arbor.profile";
/** Where the Mac app keeps a pending account claim (`pending-account:<digest>`). */
const NATIVE_DEVICE_SERVICE = "org.nxhx.Arbor.device";

// MARK: File helpers (read-only)

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

async function isDirectory(path: string): Promise<boolean> {
  return stat(path).then((info) => info.isDirectory(), () => false);
}

async function entries(path: string): Promise<string[]> {
  return readdir(path).catch(() => []);
}

async function readJSON(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

function list(values: string[], limit = 5): string {
  return values.length <= limit ? values.join(", ") : `${values.slice(0, limit).join(", ")} and ${values.length - limit} more`;
}

function result(passed: boolean, name: string, attribution: { revert?: string; gate?: string }, pass: string, fail: string): CheckResult {
  return { status: passed ? "PASS" : "FAIL", name, ...attribution, details: passed ? pass : fail };
}

function skip(name: string, attribution: { revert?: string; gate?: string }, details: string): CheckResult {
  return { status: "SKIP", name, ...attribution, details };
}

// MARK: The data home (~/.arbor)

/** The configuration checkouts: `configurations/` once the data home is
 * renamed at cutover, `accounts/` before. */
async function checkouts(dataHome: string): Promise<string> {
  return await isDirectory(join(dataHome, "configurations")) ? join(dataHome, "configurations") : join(dataHome, "accounts");
}

async function prePluralFiles(dataHome: string): Promise<CheckResult> {
  const found: string[] = [];
  for (const name of ["account.yaml", "trees.yaml"]) if (await exists(join(dataHome, name))) found.push(name);
  if ((await entries(join(dataHome, "devices"))).length) found.push("devices/");
  return result(!found.length, "data home: no pre-plural account files", { revert: REVERT.prePluralFiles },
    "no account.yaml, trees.yaml or devices/ at the top of the data home", `found ${list(found)}`);
}

async function placementsUnderConfigurations(dataHome: string): Promise<CheckResult> {
  const name = "data home: every placements.yaml entry is under a configuration TreeID";
  const attribution = { revert: REVERT.placementConfiguration };
  const path = join(dataHome, "placements.yaml");
  if (!await exists(path)) return result(true, name, attribution, "no placements.yaml", "");
  let root: unknown;
  try { root = parseYAML(await readFile(path, "utf8")); }
  catch (error) { return result(false, name, attribution, "", `placements.yaml does not parse: ${(error as Error).message}`); }
  if (root == null) return result(true, name, attribution, "placements.yaml is empty", "");
  if (typeof root !== "object" || Array.isArray(root)) return result(false, name, attribution, "", "placements.yaml is not a mapping");
  const problems: string[] = [];
  let count = 0;
  for (const [key, value] of Object.entries(root as Record<string, unknown>)) {
    if (!TREE_ID.test(key)) { problems.push(`${key} is not a TreeID`); continue; }
    if (!await isDirectory(join(await checkouts(dataHome), key))) problems.push(`${key} has no configuration checkout in ~/.arbor`);
    if (!value || typeof value !== "object" || Array.isArray(value)) { problems.push(`${key} does not map paths to trees`); continue; }
    count += Object.keys(value).length;
  }
  return result(!problems.length, name, attribution, `${count} placements under ${Object.keys(root).length} configurations`, list(problems));
}

async function connectionsHaveAccount(dataHome: string): Promise<CheckResult> {
  const name = "data home: every .state/accounts/*/connection.json has account";
  const attribution = { revert: REVERT.earlyConnections };
  const root = join(dataHome, ".state", "accounts");
  const missing: string[] = [];
  let count = 0;
  for (const tree of await entries(root)) {
    const path = join(root, tree, "connection.json");
    if (!await exists(path)) continue;
    count += 1;
    try {
      const record = await readJSON(path) as { account?: unknown };
      if (typeof record?.account !== "string" || !record.account) missing.push(tree);
    } catch { missing.push(`${tree} (unparseable)`); }
  }
  return result(!missing.length, name, attribution, `${count} connection records, each with account`, `missing account: ${list(missing)}`);
}

async function connectionsUseDeviceKeys(dataHome: string): Promise<CheckResult> {
  const name = "data home: every connection record names device-key";
  const attribution = { gate: GATES.digestRetirement };
  const root = join(dataHome, ".state", "accounts");
  const problems: string[] = [];
  let count = 0;
  for (const tree of await entries(root)) {
    const path = join(root, tree, "connection.json");
    if (!await exists(path)) continue;
    count += 1;
    try {
      const record = await readJSON(path) as { credential?: unknown; deviceKey?: unknown };
      const credential = typeof record?.credential === "string" ? record.credential : "";
      const keyed = credential === "file:device-key" || (credential !== "file:credential" && credential.endsWith("-key"));
      if (!keyed || typeof record.deviceKey !== "string") problems.push(`${tree} (${credential || "no credential"})`);
    } catch { problems.push(`${tree} (unparseable)`); }
  }
  return result(!problems.length, name, attribution, `${count} connection records, each a key device`, `not a key device: ${list(problems)}`);
}

async function devicesHaveKeys(dataHome: string): Promise<CheckResult> {
  const name = "data home: every devices.yaml entry has a key";
  const attribution = { gate: GATES.digestRetirement };
  const root = await checkouts(dataHome);
  const missing: string[] = [];
  let count = 0;
  for (const configuration of await entries(root)) {
    const path = join(root, configuration, "devices.yaml");
    if (!await exists(path)) continue;
    let devices: unknown;
    try { devices = parseYAML(await readFile(path, "utf8")); }
    catch { missing.push(`${configuration}/devices.yaml (unparseable)`); continue; }
    for (const [device, entry] of Object.entries((devices ?? {}) as Record<string, { key?: unknown } | null>)) {
      count += 1;
      if (typeof entry?.key !== "string" || !entry.key) missing.push(device);
    }
  }
  return result(!missing.length, name, attribution, `${count} devices, each with a key`, `no key: ${list(missing)}`);
}

async function noEarlierSyncState(dataHome: string): Promise<CheckResult> {
  const found = (await entries(join(dataHome, ".state", "sync")))
    .filter((file) => /^[A-Za-z0-9_-]+\.json$/.test(file));
  return result(!found.length, "data home: no .state/sync/<base64url>.json", { revert: REVERT.earlierSyncState },
    "no earlier synchronizer state", `${found.length} file(s): ${list(found.map((file) => {
      const tree = Buffer.from(basename(file, ".json"), "base64url").toString("utf8");
      return TREE_ID.test(tree) ? `${file} (${tree})` : file;
    }))}`);
}

/** Every `<root>/*\/sync/update-control.json` names schema 4. */
async function updateControlFiles(roots: string[]): Promise<{ count: number; problems: string[] }> {
  const problems: string[] = [];
  let count = 0;
  for (const root of roots) {
    for (const key of await entries(root)) {
      const path = join(root, key, "sync", "update-control.json");
      if (!await exists(path)) continue;
      count += 1;
      try {
        const schema = (await readJSON(path) as { schema?: unknown })?.schema;
        if (schema !== 4) problems.push(`${basename(root)}/${key}: schema ${String(schema)}`);
      } catch { problems.push(`${basename(root)}/${key}: unparseable`); }
    }
  }
  return { count, problems };
}

async function dataHomeUpdateControl(dataHome: string): Promise<CheckResult> {
  const { count, problems } = await updateControlFiles([join(dataHome, ".state", "trees")]);
  return result(!problems.length, "data home: every update-control.json is schema 4", { revert: REVERT.updateControl },
    `${count} update-control records, all schema 4`, list(problems));
}

// MARK: The Keychain (darwin)

function keychainItems(dump: string): Array<{ service: string; account: string }> {
  const value = (block: string, attribute: string) =>
    new RegExp(`"${attribute}"<blob>=(?:0x[0-9A-Fa-f]+\\s+)?"((?:[^"\\\\]|\\\\.)*)"`).exec(block)?.[1];
  return dump.split(/^keychain: /m).flatMap((block) => {
    const service = value(block, "svce");
    return service === undefined ? [] : [{ service, account: value(block, "acct") ?? "" }];
  });
}

async function keychainIdentity(dataHome: string, options: SurveyOptions): Promise<CheckResult> {
  const name = "Keychain: only the indexed profile identity";
  const attribution = { revert: REVERT.keychainIdentities };
  if ((options.platform ?? process.platform) !== "darwin") return skip(name, attribution, "not macOS; check the iPhone by hand (Settings → Accounts)");
  const security = options.security ?? ((args: string[]) => {
    const run = spawnSync("/usr/bin/security", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return { status: run.status, stdout: run.stdout ?? "" };
  });
  let metadata: { profileTree?: unknown; credential?: unknown };
  try { metadata = await readJSON(join(dataHome, ".state", "self.json")) as typeof metadata; }
  catch { return result(false, name, attribution, "", "no readable ~/.arbor/.state/self.json: the data home has no indexed identity"); }
  const credential = typeof metadata.credential === "string" ? metadata.credential : "";
  if (!credential.startsWith(`${IDENTITY_SERVICE}/`)) return result(false, name, attribution, "", `self.json names credential ${credential || "(none)"}`);
  const indexed = credential.slice(IDENTITY_SERVICE.length + 1);
  // Attributes only: without -g or -w, security never reads a secret.
  if (security(["find-generic-password", "-s", IDENTITY_SERVICE, "-a", indexed]).status !== 0) {
    return result(false, name, attribution, "", `the indexed record ${credential} is not in the Keychain`);
  }
  const dump = security(["dump-keychain"]);
  if (dump.status !== 0) return result(false, name, attribution, "", "security dump-keychain failed; unlock the login keychain and rerun");
  const items = keychainItems(dump.stdout);
  const others = items.filter((item) => item.service === IDENTITY_SERVICE && item.account !== indexed).map((item) => item.account);
  const native = items.some((item) => item.service === NATIVE_IDENTITY_SERVICE);
  const note = native ? `; Canopy's own ${NATIVE_IDENTITY_SERVICE} record is also present and no longer read` : "";
  return result(!others.length, name, attribution, `${credential} for ${String(metadata.profileTree)}${note}`,
    `other ${IDENTITY_SERVICE} records: ${list(others)}${note}`);
}

/** No account claim is pending: an old build replaying one after the host
 * changes would send the `{ root, objects }` configuration the host now refuses. */
async function noPendingClaims(dataHome: string, options: SurveyOptions): Promise<CheckResult> {
  const name = "no pending account claim (CLI journal or Mac app keychain)";
  const attribution = { gate: GATES.claimShape };
  const found: string[] = [];
  if (await exists(join(dataHome, ".state", "bootstrap-account-claim.json"))) found.push(".state/bootstrap-account-claim.json");
  if ((options.platform ?? process.platform) === "darwin") {
    const security = options.security ?? ((args: string[]) => {
      const run = spawnSync("/usr/bin/security", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      return { status: run.status, stdout: run.stdout ?? "" };
    });
    const dump = security(["dump-keychain"]);
    if (dump.status !== 0) return result(false, name, attribution, "", "security dump-keychain failed; unlock the login keychain and rerun");
    for (const item of keychainItems(dump.stdout)) {
      if (item.service === NATIVE_DEVICE_SERVICE && item.account.startsWith("pending-account:")) found.push(`Keychain ${item.account}`);
    }
  }
  return result(!found.length, name, attribution, "none pending (the iPhone's Keychain is checked by hand: no account is mid-claim)", list(found));
}

// MARK: An app container (the Mac's Application Support, or the iPhone's copy)

async function appRoot(container: string): Promise<string | null> {
  for (const candidate of [join(container, "Library", "Application Support", "Arbor"), join(container, "Application Support", "Arbor"), container]) {
    if (await exists(join(candidate, "WorkingTrees")) || await exists(join(candidate, "Native Placement.json"))) return candidate;
  }
  return null;
}

async function appUpdateControl(label: string, root: string): Promise<CheckResult> {
  const { count, problems } = await updateControlFiles(["WorkingTrees", "Sync", "RemoteSync"].map((name) => join(root, name)));
  return result(!problems.length, `${label}: every update-control.json is schema 4`, { revert: REVERT.updateControl },
    `${count} update-control records, all schema 4`, list(problems));
}

async function nativePlacements(label: string, root: string): Promise<CheckResult> {
  const name = `${label}: every Native Placement.json placement names its configuration tree`;
  const attribution = { gate: GATES.singletonCredential };
  const path = join(root, "Native Placement.json");
  if (!await exists(path)) return result(true, name, attribution, "no Native Placement.json", "");
  let value: { placements?: unknown; tree?: { id?: unknown } };
  try { value = await readJSON(path) as typeof value; }
  catch { return result(false, name, attribution, "", "Native Placement.json does not parse"); }
  // Version 2 holds a collection; version 1 was one record.
  const placements = (Array.isArray(value?.placements) ? value.placements : [value]) as Array<{ configurationTree?: unknown; tree?: { id?: unknown } }>;
  const missing = placements.filter((placement) => typeof placement?.configurationTree !== "string" || !TREE_ID.test(placement.configurationTree))
    .map((placement) => String(placement?.tree?.id ?? "(no tree)"));
  return result(!missing.length, name, attribution, `${placements.length} placements, each with a configuration tree`, `no configuration tree: ${list(missing)}`);
}

/** Node records (`path` and `kind`) that hold a top-level `modifiedAt`, anywhere in a JSON value. */
function bareDates(value: unknown): number {
  if (Array.isArray(value)) return value.reduce((sum: number, item) => sum + bareDates(item), 0);
  if (!value || typeof value !== "object") return 0;
  const record = value as Record<string, unknown>;
  const own = typeof record.path === "string" && typeof record.kind === "string" && "modifiedAt" in record ? 1 : 0;
  return own + Object.values(record).reduce((sum: number, item) => sum + bareDates(item), 0);
}

async function jsonFiles(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await jsonFiles(path));
    else if (entry.name.endsWith(".json")) found.push(path);
  }
  return found;
}

async function nodeDates(label: string, root: string): Promise<CheckResult> {
  const found: string[] = [];
  let files = 0;
  for (const replicas of ["WorkingTrees", "RemoteWorkingTrees"]) {
    for (const key of await entries(join(root, replicas))) {
      for (const directory of ["materialized", "journals"]) {
        for (const path of await jsonFiles(join(root, replicas, key, directory))) {
          files += 1;
          try {
            const bare = bareDates(await readJSON(path));
            if (bare) found.push(`${replicas}/${key}/${path.slice(join(root, replicas, key).length + 1)}: ${bare}`);
          } catch { /* A journal mid-write is not a node record. */ }
        }
      }
    }
  }
  return result(!found.length, `${label}: no node record with a top-level modifiedAt`, { revert: REVERT.legacyModifiedAt },
    `${files} working-tree state files, no bare dates`, list(found));
}

async function appChecks(label: string, container: string | undefined, missing: string): Promise<CheckResult[]> {
  const names = [
    [`${label}: every update-control.json is schema 4`, { revert: REVERT.updateControl }],
    [`${label}: every Native Placement.json placement names its configuration tree`, { gate: GATES.singletonCredential }],
    [`${label}: no node record with a top-level modifiedAt`, { revert: REVERT.legacyModifiedAt }],
  ] as const;
  const root = container ? await appRoot(container) : null;
  if (!root) return names.map(([name, attribution]) => skip(name, attribution, container ? `no Arbor app state under ${container}` : missing));
  return [await appUpdateControl(label, root), await nativePlacements(label, root), await nodeDates(label, root)];
}

// MARK: The live host (survey-host.ts output)

async function liveChecks(path: string | undefined): Promise<CheckResult[]> {
  const checks = [
    ["live: no unrevoked device without a public key", { gate: GATES.digestRetirement }, "unrevokedDevicesWithoutPublicKey"],
    ["live: no group member stored as a bare string", { revert: REVERT.scalarMembers }, "bareStringGroupMembers"],
    ["live: profile_resets is empty", { gate: GATES.batch024 }, "profileResets"],
  ] as const;
  if (!path) return checks.map(([name, attribution]) => skip(name, attribution, "pass --live <file> with survey-host.ts output"));
  let survey: Partial<HostSurvey>;
  try { survey = await readJSON(path) as Partial<HostSurvey>; }
  catch (error) { return checks.map(([name, attribution]) => result(false, name, attribution, "", `${path} does not parse: ${(error as Error).message}`)); }
  if (survey.version !== 1) return checks.map(([name, attribution]) => result(false, name, attribution, "", `${path} is not survey-host.ts version 1 output`));
  return checks.map(([name, attribution, field]) => {
    const value = survey[field];
    if (field === "profileResets" && value === null) return result(true, name, attribution, "the table is already gone", "");
    return typeof value === "number"
      ? result(value === 0, name, attribution, `0 (schema ${survey.schema})`, `${value} (schema ${survey.schema})`)
      : result(false, name, attribution, "", `${field} is missing`);
  });
}

// MARK: The survey

export async function survey(options: SurveyOptions): Promise<CheckResult[]> {
  const dataHome = join(options.home, ".arbor");
  const results: CheckResult[] = [];
  if (!await isDirectory(dataHome)) {
    results.push({ status: "FAIL", name: "data home", details: `${dataHome} does not exist; pass --home` });
  } else {
    results.push(
      await prePluralFiles(dataHome),
      await placementsUnderConfigurations(dataHome),
      await connectionsHaveAccount(dataHome),
      await connectionsUseDeviceKeys(dataHome),
      await devicesHaveKeys(dataHome),
      await noEarlierSyncState(dataHome),
      await dataHomeUpdateControl(dataHome),
      await keychainIdentity(dataHome, options),
      await noPendingClaims(dataHome, options),
    );
  }
  results.push(...await appChecks("Mac app", options.home, "no Mac app state"));
  results.push(...await appChecks("iPhone", options.iphone, "pass --iphone <dir> with a copy of the iPhone app's data container"));
  results.push(...await liveChecks(options.live));

  return results;
}

export function formatResult(check: CheckResult): string {
  const attribution = check.revert ? `revert "${check.revert}"` : check.gate ?? "-";
  return `${check.status.padEnd(4)}  ${check.name}  |  ${attribution}  |  ${check.details}`;
}

function parseArguments(argv: string[]): SurveyOptions {
  const options: SurveyOptions = { home: process.env.SURVEY_HOME || homedir() };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    const value = argv[index + 1];
    if (flag === "--help" || flag === "-h") {
      console.log("usage: survey.ts [--home <dir>] [--iphone <copied container>] [--live <survey-host.json>]");
      process.exit(0);
    }
    if (!["--home", "--iphone", "--live"].includes(flag) || !value) throw new Error(`unknown or incomplete argument: ${flag}`);
    if (flag === "--home") options.home = value;
    if (flag === "--iphone") options.iphone = value;
    if (flag === "--live") options.live = value;
    index += 1;
  }
  if (options.iphone && !existsSync(options.iphone)) throw new Error(`--iphone ${options.iphone} does not exist`);
  return options;
}

if (import.meta.main) {
  const results = await survey(parseArguments(process.argv.slice(2)));
  for (const check of results) console.log(formatResult(check));
  const failed = results.filter((check) => check.status === "FAIL").length;
  console.log(failed ? `\n${failed} check(s) failed.` : "\nNo check failed.");
  process.exit(failed ? 1 : 0);
}
