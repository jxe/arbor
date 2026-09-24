#!/usr/bin/env bun
/**
 * Conflict lab: a disposable local Canopy and tree for exercising the Mac
 * app's accepted-choice review against real canopyd merges.
 *
 *   bun swift/scripts/conflict-lab.ts up            start canopyd, claim, place and seed
 *   bun swift/scripts/conflict-lab.ts app [--build] launch the Debug app against the lab
 *   bun swift/scripts/conflict-lab.ts make <scenario>
 *   bun swift/scripts/conflict-lab.ts edit <page> <find> <replace>
 *   bun swift/scripts/conflict-lab.ts inspect       accepted decisions, as the server holds them
 *   bun swift/scripts/conflict-lab.ts resolve <decision> <alternative>
 *   bun swift/scripts/conflict-lab.ts down | reset
 *
 * Every command prints one JSON object on stdout. Everything lives under
 * `.arbor-lab/conflicts` (gitignored). The app runs with a redirected
 * `ARBOR_DATA_HOME` (which also holds its Application Support state) and its
 * bundled helper on the test port, so it never reaches the user's daemon,
 * data or the live host.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const repository = join(import.meta.dir, "../..");
const lab = join(repository, ".arbor-lab/conflicts");
const dataHome = join(lab, "data-home");
const folder = join(lab, "tree");
const statePath = join(lab, "state.json");
const port = 4390;
const origin = `http://127.0.0.1:${port}`;
process.env.ARBOR_DATA_HOME = dataHome;

interface LabState { tree: string; canopyPid: number; appPid?: number }

const pages: Record<string, string> = {
  "_index.md": "---\nid: pg_lab_index\n---\n\n# Conflict lab\n\nScenario pages live beside this one.\n",
  "Errands.md": "---\nid: pg_lab_errands\n---\n\n# Errands\n\nPick up the bike from the shop on Thursday.\n\n- Once Rebecca is here\n  - Run\n  - Tips for each of the cleaners €40\n  - Groceries\n\nCall the landlord about the heater.\n",
  "Sentence.md": "---\nid: pg_lab_sentence\n---\n\n# Sentence\n\nWe meet at the farmers market every Saturday morning.\n\nBring a bag.\n",
  "List.md": "---\nid: pg_lab_list\n---\n\n# List\n\n- Milk\n- Eggs from the farm stand\n- Bread\n",
  "Table.md": "---\nid: pg_lab_table\n---\n\n# Table\n\n| Day | Plan |\n| --- | --- |\n| Mon | Swim |\n| Tue | Run |\n",
  "Two.md": "---\nid: pg_lab_two\n---\n\n# Two\n\nThe first paragraph talks about apples.\n\nA quiet middle paragraph.\n\nThe last paragraph talks about pears.\n",
  "Title.md": "---\nid: pg_lab_title\ntitle: Title\n---\n\n# Title\n\nFrontmatter clash.\n",
  "Notes.txt": "Plain notes, not a page.\nSecond line.\n",
  "Photo.bin": "original\0",
  "Assets": "Assets is a file for now.\n",
};

/** A whole-entry writer: each named entry becomes this text, bytes, folder, or is deleted. */
type EntryValue = { text: string } | { folder: Record<string, string> } | null;

type Edit = [page: string, find: string, replace: string];
/** Each scenario is a set of concurrent writers; each writer's edits apply from the same base. */
const scenarios: Record<string, { page: string; writers: (Edit[] | Record<string, EntryValue>)[]; after?: Edit[] }> = {
  binary: { page: "Photo.bin", writers: [{ "Photo.bin": { text: "left\0" } }, { "Photo.bin": { text: "right\0" } }] },
  "delete-file": { page: "Notes.txt", writers: [
    { "Notes.txt": { text: "Plain notes, rewritten on the laptop.\nSecond line.\n" } },
    { "Notes.txt": null },
  ] },
  kind: { page: "Assets", writers: [
    { Assets: { text: "Assets is still a file, edited.\n" } },
    { Assets: { folder: { "logo.txt": "logo\n", "notes.txt": "notes\n" } } },
  ] },
  sentence: { page: "Sentence.md", writers: [
    [["Sentence.md", "the farmers market", "the co-op"]],
    [["Sentence.md", "the farmers market", "the corner bakery"]],
  ] },
  "delete-edit": { page: "Errands.md", writers: [
    [["Errands.md", "  - Tips for each of the cleaners €40\n", "  - Tips for each of the cleaners €50\n"]],
    [["Errands.md", "- Once Rebecca is here\n  - Run\n  - Tips for each of the cleaners €40\n  - Groceries\n\n", ""]],
  ] },
  "list-item": { page: "List.md", writers: [
    [["List.md", "Eggs from the farm stand", "Eggs (a dozen)"]],
    [["List.md", "Eggs from the farm stand", "Eggs from the market"]],
  ] },
  "table-cell": { page: "Table.md", writers: [
    [["Table.md", "| Tue | Run |", "| Tue | Long run |"]],
    [["Table.md", "| Tue | Run |", "| Tue | Rest |"]],
  ] },
  "two-ranges": { page: "Two.md", writers: [
    [["Two.md", "talks about apples", "praises apples"], ["Two.md", "talks about pears", "praises pears"]],
    [["Two.md", "talks about apples", "doubts apples"], ["Two.md", "talks about pears", "doubts pears"]],
  ] },
  frontmatter: { page: "Title.md", writers: [
    [["Title.md", "title: Title", "title: Morning"]],
    [["Title.md", "title: Title", "title: Evening"]],
  ] },
  "keep-editing": { page: "Errands.md", writers: [
    [["Errands.md", "  - Tips for each of the cleaners €40\n", "  - Tips for each of the cleaners €50\n"]],
    [["Errands.md", "- Once Rebecca is here\n  - Run\n  - Tips for each of the cleaners €40\n  - Groceries\n\n", ""]],
  ], after: [
    ["Errands.md", "on Thursday", "on Friday"],
    ["Errands.md", "about the heater", "about the heater and the sink"],
    ["Errands.md", "# Errands\n", "# Errands\n\nUpdated plan.\n"],
  ] },
};

function out(value: unknown): void { console.log(JSON.stringify(value, null, 2)); }
function log(message: string): void { console.error(message); }
async function loadState(): Promise<LabState> {
  if (!existsSync(statePath)) throw new Error("The lab is not up; run `conflict-lab.ts up`");
  return JSON.parse(await readFile(statePath, "utf8"));
}
function alive(pid?: number): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}
async function run(command: string[], environment: Record<string, string> = {}, cwd = repository): Promise<void> {
  const child = Bun.spawn(command, { cwd, env: { ...Bun.env, ...environment }, stdout: 2, stderr: "inherit" });
  if (await child.exited !== 0) throw new Error(`${command.join(" ")} failed`);
}
async function waitForCanopy(): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { await fetch(`${origin}/.arbor/`); return; } catch { await Bun.sleep(100); }
  }
  throw new Error("Lab canopyd did not start");
}

async function client() {
  const { WireClient } = await import("@overstory/protocol");
  const { listLocalAccounts } = await import("@overstory/arborsync/state");
  const { CanopyAccountStore } = await import("@overstory/protocol");
  const account = (await listLocalAccounts()).find((candidate) => candidate.canopy?.startsWith(origin));
  if (!account) throw new Error("No lab account is claimed");
  const credential = await new CanopyAccountStore(account.configurationTree).get();
  if (!credential) throw new Error("The lab account credential is unavailable");
  return new WireClient(origin, credential.accountToken);
}

/** The tree's current accepted state with every object of its root. */
async function current(wire: Awaited<ReturnType<typeof client>>, tree: string) {
  const { tree: descriptor } = await wire.descriptor(tree);
  const snapshot = await wire.snapshot(tree, descriptor.root);
  return { state: descriptor.update, root: descriptor.root, conflicted: descriptor.conflicted, objects: new Map(snapshot.objects) };
}

async function fileHash(objects: Map<string, Uint8Array>, root: string, name: string) {
  const { decodeWireDirectory } = await import("@overstory/protocol");
  const entry = decodeWireDirectory(objects.get(root)!).entries.find((candidate) => candidate.name === name);
  if (!entry?.file) throw new Error(`No page ${name}`);
  return entry.file;
}

/** One candidate made of exact source edits located by UTF-8 byte offset. */
async function candidate(base: { root: string; objects: Map<string, Uint8Array> }, edits: Edit[]) {
  const { executeExactSourceEdits } = await import("../../packages/canopyd/src/updates/source-edits.ts");
  const operations = [];
  for (const [index, [page, find, replace]] of edits.entries()) {
    const object = await fileHash(base.objects, base.root, page);
    const source = Buffer.from(base.objects.get(object)!);
    const at = source.indexOf(Buffer.from(find));
    if (at < 0) throw new Error(`${page} does not contain ${JSON.stringify(find)}`);
    operations.push({
      key: `edit${index}`, kind: "editSource" as const,
      source: { material: { kind: "basis" as const, path: `/${page}`, object }, range: [at, at + Buffer.byteLength(find)] as [number, number] },
      text: replace,
    });
  }
  const executed = await executeExactSourceEdits(base.root as never, operations, async (hash) => base.objects.get(hash)!);
  return {
    change: crypto.randomUUID(), candidate: executed.root,
    trace: [{ before: base.root, after: executed.root, operations }], resolves: [],
    objects: [...executed.generated].map(([hash, bytes]) => ({ hash, bytes })), deltas: [],
  };
}

/** One snapshot candidate replacing whole root entries (no source trace). */
async function entriesCandidate(base: { root: string; objects: Map<string, Uint8Array> }, entries: Record<string, EntryValue>) {
  const { decodeWireDirectory, encodeWireDirectory, hashObject } = await import("@overstory/protocol");
  const objects = new Map<string, Uint8Array>();
  const put = (bytes: Uint8Array) => { const hash = hashObject(bytes); objects.set(hash, bytes); return hash; };
  const folder = (value: { type: "directory"; entries: any[] }) => {
    value.entries.sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
    return put(encodeWireDirectory(value as never));
  };
  const root = decodeWireDirectory(base.objects.get(base.root)!);
  for (const [name, value] of Object.entries(entries)) {
    root.entries = root.entries.filter((entry) => entry.name !== name);
    if (value && "text" in value) root.entries.push({ name, file: put(new TextEncoder().encode(value.text)) } as never);
    else if (value) root.entries.push({ name, directory: folder({ type: "directory", entries:
      Object.entries(value.folder).map(([child, text]) => ({ name: child, file: put(new TextEncoder().encode(text)) })) }) } as never);
  }
  const candidate = folder(root as never);
  return { change: crypto.randomUUID(), candidate, trace: null, resolves: [], deltas: [],
    objects: [...objects].map(([hash, bytes]) => ({ hash, bytes })) };
}

async function inspect(wire: Awaited<ReturnType<typeof client>>, tree: string) {
  const now = await current(wire, tree);
  const decisions = [];
  let after: string | undefined;
  do {
    const page = await wire.conflicts(tree, now.state, now.root, after ? { after } : {});
    decisions.push(...page.decisions);
    after = page.next ?? undefined;
  } while (after);
  return {
    state: now.state, conflicted: now.conflicted,
    decisions: decisions.map((decision) => ({
      id: decision.id, kind: decision.kind, dependencies: decision.dependencies.length,
      affected: decision.affected.map((ref) => ({ path: ref.material.kind === "basis" ? ref.material.path : ref.material.kind, range: ref.range })),
      selected: decision.selected,
      alternatives: decision.alternatives.map((alternative) => ({ id: alternative.id, value: Object.keys(alternative.value)[0] })),
    })),
  };
}

async function up() {
  await mkdir(lab, { recursive: true });
  const fresh = !existsSync(join(lab, "canopy"));
  if (!existsSync(statePath) || !alive((await loadState()).canopyPid)) {
    const child = Bun.spawn(["bun", import.meta.path, "serve", fresh ? "--fresh" : ""], {
      cwd: repository, env: { ...process.env, ARBOR_DATA_HOME: dataHome }, stdout: Bun.file(join(lab, "canopyd.log")), stderr: Bun.file(join(lab, "canopyd.log")),
    });
    child.unref();
    await waitForCanopy();
    if (!fresh) {
      const state = await loadState();
      await writeFile(statePath, JSON.stringify({ ...state, canopyPid: child.pid }));
      return out({ canopy: origin, tree: state.tree, dataHome, restarted: true });
    }
    await writeFile(statePath, JSON.stringify({ tree: "", canopyPid: child.pid }));
  } else {
    const state = await loadState();
    return out({ canopy: origin, tree: state.tree, dataHome, running: true });
  }
  // First run: claim `~joe` into the lab data home and place the seeded tree.
  await mkdir(folder, { recursive: true });
  for (const [name, text] of Object.entries(pages)) await writeFile(join(folder, name), text);
  const profile = join(lab, "profile");
  // A throwaway control daemon claims `~joe` and places the tree; the app's
  // bundled helper later finds both in the lab data home.
  const { serveArborSyncControl } = await import("@overstory/arborsync");
  const control = await serveArborSyncControl({ port: 0 });
  try {
    const claimed = await fetch(`${control.url}/v1/bootstrap/accounts`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ account: `${origin}/~joe`, path: profile, displayName: "Conflict lab Mac" }),
    });
    if (!claimed.ok) throw new Error(`Claim failed: ${await claimed.text()}`);
    await run(["bun", "packages/cli/src/index.ts", "place", await realpath(folder), `${origin}/~joe/lab`],
      { ARBOR_DATA_HOME: dataHome, ARBOR_SYNC_URL: control.url });
  } finally {
    control.server.stop(true);
    await control.service[Symbol.asyncDispose]();
  }
  const { loadLocalPlacements } = await import("@overstory/arborsync/state");
  const placed = (await loadLocalPlacements()).placements.find((candidate) => candidate.path === folder || candidate.path.endsWith("/conflicts/tree"));
  if (!placed) throw new Error("The lab tree was not placed");
  const state = { ...(await loadState()), tree: placed.tree };
  await writeFile(statePath, JSON.stringify(state));
  out({ canopy: origin, tree: placed.tree, dataHome, created: true });
}

async function serve(fresh: boolean) {
  const { serveCanopy } = await import("@overstory/canopyd");
  let community;
  if (fresh) {
    const { ProfileIdentityStore } = await import("@overstory/arborsync/state");
    const profile = join(lab, "profile");
    await mkdir(profile, { recursive: true });
    const identity = await new ProfileIdentityStore().create(profile);
    community = { handle: "lab", name: "Conflict lab", firstWriter: { handle: "joe", profileTree: identity.profileTree } };
  }
  await serveCanopy({ dataRoot: join(lab, "canopy"), publicOrigin: origin, hostname: "127.0.0.1", port, ...(community ? { community } : {}) });
  log(`conflict lab canopyd on ${origin}`);
  await new Promise(() => {});
}

async function app(build: boolean) {
  const state = await loadState();
  const derived = join(lab, "DerivedData");
  const workspace = existsSync(join(repository, "swift/Canopy.local.xcworkspace")) ? ["-workspace", "Canopy.local.xcworkspace"] : ["-project", "Canopy.xcodeproj"];
  const binary = join(derived, "Build/Products/Debug/Canopy.app/Contents/MacOS/Canopy");
  if (build || !existsSync(binary)) {
    await run(["xcodebuild", ...workspace, "-scheme", "Canopy", "-configuration", "Debug", "-destination", "platform=macOS",
      "-derivedDataPath", derived, "build", "-quiet",
      // Its own identity, so nothing that addresses the app by bundle
      // (automation, Launch Services) can reach the user's installed Canopy.
      "PRODUCT_BUNDLE_IDENTIFIER=org.nxhx.Arbor.lab"], {}, join(repository, "swift"));
  }
  if (alive(state.appPid)) process.kill(state.appPid!);
  // The bundled helper outlives its app; a new build must not reuse an old one.
  Bun.spawnSync(["pkill", "-f", `${join(derived, "Build/Products/Debug/Canopy.app")}/Contents/MacOS/arborsync`]);
  const child = Bun.spawn([binary], {
    env: { ...Bun.env, ARBOR_DATA_HOME: dataHome, ARBOR_TEST_BUNDLED_HELPER: "1", ARBOR_DISABLE_PERSISTENT_DAEMON: "1", ARBOR_TEST_TREE: state.tree },
    stdout: Bun.file(join(lab, "app.log")), stderr: Bun.file(join(lab, "app.log")),
  });
  child.unref();
  // A bare exec opens no window until the app is asked to reopen.
  await Bun.sleep(1500);
  Bun.spawnSync(["open", "-b", "org.nxhx.Arbor.lab"]);
  await writeFile(statePath, JSON.stringify({ ...state, appPid: child.pid }));
  out({ app: binary, pid: child.pid, tree: state.tree });
}

async function make(name: string) {
  const scenario = scenarios[name];
  if (!scenario) throw new Error(`Unknown scenario; choose one of ${Object.keys(scenarios).join(", ")}`);
  const state = await loadState(), wire = await client();
  const base = await current(wire, state.tree);
  const results = [];
  for (const edits of scenario.writers) {
    const update = Array.isArray(edits) ? await candidate(base, edits) : await entriesCandidate(base, edits);
    const response = await wire.submitUpdates(state.tree, { base: base.state, updates: [update] });
    results.push(response.results.map((result) => ({ outcome: result.outcome, conflicted: result.update.conflicted })));
  }
  for (const edit of scenario.after ?? []) {
    const now = await current(wire, state.tree);
    const response = await wire.submitUpdates(state.tree, { base: now.state, updates: [await candidate(now, [edit])] });
    results.push(response.results.map((result) => ({ outcome: result.outcome, conflicted: result.update.conflicted })));
  }
  out({ scenario: name, page: scenario.page, submissions: results, ...(await inspect(wire, state.tree)) });
}

async function edit(page: string, find: string, replace: string) {
  const state = await loadState(), wire = await client();
  const now = await current(wire, state.tree);
  const response = await wire.submitUpdates(state.tree, { base: now.state, updates: [await candidate(now, [[page, find, replace]])] });
  out({ outcome: response.results[0]!.outcome, conflicted: response.results[0]!.update.conflicted });
}

async function resolve(decision: string, alternative: string) {
  const state = await loadState(), wire = await client();
  const now = await current(wire, state.tree);
  const response = await wire.submitUpdates(state.tree, { base: now.state, updates: [{
    change: crypto.randomUUID(), candidate: now.root, trace: null,
    resolves: [{ state: now.state, conflict: decision, alternatives: [alternative] }], objects: [], deltas: [],
  } as never] });
  out({ outcome: response.results[0]!.outcome, conflicted: response.results[0]!.update.conflicted });
}

async function down() {
  if (!existsSync(statePath)) return out({ stopped: [] });
  const state = await loadState(), stopped = [];
  for (const pid of [state.appPid, state.canopyPid]) if (alive(pid)) { process.kill(pid!); stopped.push(pid); }
  out({ stopped });
}

const [command, ...rest] = process.argv.slice(2);
switch (command) {
  case "up": await up(); break;
  case "serve": await serve(rest.includes("--fresh")); break;
  case "app": await app(rest.includes("--build")); break;
  case "make": await make(rest[0] ?? ""); break;
  case "edit": await edit(rest[0]!, rest[1]!, rest[2] ?? ""); break;
  case "inspect": { const state = await loadState(); out(await inspect(await client(), state.tree)); break; }
  case "resolve": await resolve(rest[0]!, rest[1]!); break;
  case "down": await down(); break;
  case "reset": {
    // Everything but the app build, which is slow to redo and holds no lab state.
    await down();
    const { readdir } = await import("node:fs/promises");
    for (const name of existsSync(lab) ? await readdir(lab) : []) if (name !== "DerivedData") await rm(join(lab, name), { recursive: true, force: true });
    out({ reset: lab });
    break;
  }
  default:
    console.error("usage: conflict-lab.ts up | app [--build] | make <scenario> | edit <page> <find> <replace> | inspect | resolve <decision> <alternative> | down | reset");
    process.exit(2);
}
process.exit(0);
