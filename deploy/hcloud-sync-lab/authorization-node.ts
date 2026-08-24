#!/usr/bin/env bun
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  materializeTree,
  snapshotDirectory,
  WireClient,
} from "../../packages/wire/src/index.ts";

type Role = "alice" | "bob" | "carol";

interface Identity {
  handle: string;
  locator: string;
  profile: string;
  token: string;
}

async function input<T>(): Promise<T> {
  return JSON.parse(await Bun.stdin.text()) as T;
}

function output(value: unknown): void {
  process.stdout.write(JSON.stringify(value));
}

async function expectNotFound(read: () => Promise<unknown>, message: string): Promise<void> {
  try {
    await read();
  } catch (error) {
    if (String(error).includes("Not found")) return;
    throw error;
  }
  throw new Error(message);
}

async function setup(): Promise<void> {
  const value = await input<{
    ownerToken: string;
    handles: Record<Role, string>;
  }>();
  const endpoint = "http://127.0.0.1:4318";
  const owner = new WireClient(endpoint, value.ownerToken);
  const account = await owner.account();
  if (!account.profileTree) throw new Error("Owner profile is unavailable");
  const arborOrigin = account.community.arborURL.replace(/\/$/, "");
  const root = "/tmp/arbor-authorization-community";
  const members = ["owner", value.handles.alice, value.handles.bob, value.handles.carol];

  const authorCommunity = async (boundaries: Array<{ handle: string; tree: string }>) => {
    await rm(root, { recursive: true, force: true });
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "_index.md"), [
      "---",
      "type: group",
      "members:",
      ...members.map((handle) => `  - ${arborOrigin}/~${handle}`),
      "---",
      "",
      "# Authorization community",
      "",
    ].join("\n"));
    const current = await owner.ref(account.community.id);
    await owner.submitUpdate(
      account.community.id,
      { root: current.ref, update: current.update! },
      await snapshotDirectory(root, new Map(boundaries.map(({ handle, tree }) => [join(root, `~${handle}`), tree]))),
    );
  };

  const claim = async (role: string, handle: string) => {
    const path = `/tmp/arbor-authorization-${role.toLowerCase()}`;
    await rm(path, { recursive: true, force: true });
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "_index.md"), `---\ntype: person\n---\n\n# ${role}\n`);
    return new WireClient(endpoint).claim(handle, await snapshotDirectory(path));
  };

  await authorCommunity([{ handle: "owner", tree: account.profileTree }]);
  const alice = await claim("Alice", value.handles.alice);
  const bob = await claim("Bob", value.handles.bob);
  const carol = await claim("Carol", value.handles.carol);
  await authorCommunity([
    { handle: "owner", tree: account.profileTree },
    { handle: value.handles.alice, tree: alice.tree.id },
    { handle: value.handles.bob, tree: bob.tree.id },
    { handle: value.handles.carol, tree: carol.tree.id },
  ]);
  await rm(root, { recursive: true, force: true });
  output({
    alice: { handle: value.handles.alice, locator: alice.tree.arborURL, profile: alice.tree.id, token: alice.accountToken },
    bob: { handle: value.handles.bob, locator: bob.tree.arborURL, profile: bob.tree.id, token: bob.accountToken },
    carol: { handle: value.handles.carol, locator: carol.tree.arborURL, profile: carol.tree.id, token: carol.accountToken },
  } satisfies Record<Role, Identity>);
}

async function create(): Promise<void> {
  const value = await input<{
    token: string;
    bob: string;
    carol: string;
    scenario: string;
    canonicalPath: string;
    endpoint?: string;
  }>();
  const path = `/tmp/${value.scenario}-alice`;
  await rm(path, { recursive: true, force: true });
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "note.md"), `# ${value.scenario}\n\nalice initial\n`);
  const client = new WireClient(value.endpoint ?? "http://arbor-community:4318", value.token);
  const tree = await client.create(value.canonicalPath, await snapshotDirectory(path), {
    publicAccess: "none",
    profileAccess: [
      { locator: value.bob, access: "read" },
      { locator: value.carol, access: "write" },
    ],
  });
  if (tree.access !== "write" || !tree.update) throw new Error("Alice did not receive owner write access");
  const access = await client.access(tree.id);
  if (access.some((entry) => entry.kind === "everyone")) throw new Error("Private authorization tree became public");
  if (!access.some((entry) => entry.locator === value.bob && entry.access === "read")) {
    throw new Error("Bob read access is missing");
  }
  if (!access.some((entry) => entry.locator === value.carol && entry.access === "write")) {
    throw new Error("Carol write access is missing");
  }
  output({ tree: tree.id, root: tree.ref, update: tree.update, canonical: tree.httpURL });
}

async function denyWrite(): Promise<void> {
  const value = await input<{ token: string; tree: string; scenario: string; endpoint?: string }>();
  const client = new WireClient(value.endpoint ?? "http://arbor-community:4318", value.token);
  const remote = await client.ref(value.tree);
  if (remote.access !== "read" || !remote.update) throw new Error("Bob did not receive read-only access");
  const path = `/tmp/${value.scenario}-bob`;
  await rm(path, { recursive: true, force: true });
  await mkdir(path, { recursive: true });
  await materializeTree(path, remote.ref, (hash) => client.object(hash));
  if (!(await readFile(join(path, "note.md"), "utf8")).includes("alice initial")) {
    throw new Error("Bob could not read Alice content");
  }
  await writeFile(join(path, "note.md"), `# ${value.scenario}\n\nbob denied write\n`);
  const candidate = await snapshotDirectory(path);
  await expectNotFound(
    () => client.submitUpdate(value.tree, { root: remote.ref, update: remote.update! }, candidate),
    "Bob read-only update was accepted",
  );
  const unchanged = await client.ref(value.tree);
  if (unchanged.ref !== remote.ref || unchanged.update !== remote.update) {
    throw new Error("Bob denial changed the accepted ref");
  }
  output({ candidate: candidate.root });
}

async function write(): Promise<void> {
  const value = await input<{ token: string; tree: string; scenario: string; endpoint?: string }>();
  const client = new WireClient(value.endpoint ?? "http://arbor-community:4318", value.token);
  const remote = await client.ref(value.tree);
  if (remote.access !== "write" || !remote.update) throw new Error("Carol did not receive write access");
  const path = `/tmp/${value.scenario}-carol`;
  await rm(path, { recursive: true, force: true });
  await mkdir(path, { recursive: true });
  await materializeTree(path, remote.ref, (hash) => client.object(hash));
  const source = await readFile(join(path, "note.md"), "utf8");
  if (!source.includes("alice initial")) throw new Error("Carol could not read Alice content");
  await writeFile(join(path, "note.md"), `${source}\ncarol permitted write\n`);
  const candidate = await snapshotDirectory(path);
  const result = await client.submitUpdate(value.tree, { root: remote.ref, update: remote.update }, candidate);
  if (result.outcome !== "accepted") throw new Error(`Carol update was ${result.outcome}, not accepted`);
  const current = await client.ref(value.tree);
  if (current.ref !== candidate.root || !current.update) throw new Error("Carol accepted bytes are not current");
  output({ root: current.ref, update: current.update });
}

async function verifyReader(): Promise<void> {
  const value = await input<{
    token: string;
    tree: string;
    scenario: string;
    root: string;
    update: string;
    endpoint?: string;
  }>();
  const client = new WireClient(value.endpoint ?? "http://arbor-community:4318", value.token);
  const remote = await client.ref(value.tree);
  if (remote.access !== "read" || remote.ref !== value.root || remote.update !== value.update) {
    throw new Error("Bob did not observe Carol current ref");
  }
  const path = `/tmp/${value.scenario}-bob-current`;
  await rm(path, { recursive: true, force: true });
  await mkdir(path, { recursive: true });
  await materializeTree(path, remote.ref, (hash) => client.object(hash));
  const source = await readFile(join(path, "note.md"), "utf8");
  if (!source.includes("alice initial") || !source.includes("carol permitted write") || source.includes("bob denied write")) {
    throw new Error("Bob observed incorrect accepted bytes");
  }
  output({ ok: true });
}

async function verifyOwner(): Promise<void> {
  const value = await input<{
    token: string;
    tree: string;
    root: string;
    canonical: string;
  }>();
  const owner = new WireClient("http://127.0.0.1:4318", value.token);
  if ((await owner.list()).some((tree) => tree.id === value.tree)) {
    throw new Error("No-access owner could list Alice private tree");
  }
  await expectNotFound(() => owner.ref(value.tree), "No-access owner could read Alice private ref");
  await expectNotFound(() => owner.object(value.root), "No-access owner could read Alice private object");
  if ((await fetch(value.canonical)).status !== 404) throw new Error("Anonymous reader could read Alice private tree");
  output({ ok: true });
}

async function verifyWriter(): Promise<void> {
  const value = await input<{
    token: string;
    tree: string;
    scenario: string;
    root: string;
    update: string;
    rejected: string;
    endpoint?: string;
  }>();
  const client = new WireClient(value.endpoint ?? "http://arbor-community:4318", value.token);
  const remote = await client.ref(value.tree);
  if (remote.ref !== value.root || remote.update !== value.update) throw new Error("Alice did not observe Carol current ref");
  const path = `/tmp/${value.scenario}-alice-current`;
  await rm(path, { recursive: true, force: true });
  await mkdir(path, { recursive: true });
  await materializeTree(path, remote.ref, (hash) => client.object(hash));
  if (!(await readFile(join(path, "note.md"), "utf8")).includes("carol permitted write")) {
    throw new Error("Alice did not receive Carol bytes");
  }
  await expectNotFound(() => client.object(value.rejected), "Bob rejected candidate object became readable");
  output({ ok: true });
}

const mode = process.argv[2];
if (mode === "setup") await setup();
else if (mode === "create") await create();
else if (mode === "deny-write") await denyWrite();
else if (mode === "write") await write();
else if (mode === "verify-reader") await verifyReader();
else if (mode === "verify-writer") await verifyWriter();
else if (mode === "verify-owner") await verifyOwner();
else throw new Error(`Unknown authorization-node mode: ${mode ?? "(missing)"}`);
