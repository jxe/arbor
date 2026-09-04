import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ArborSyncDaemon } from "@arbor/arborsync";
import { serveCanopy } from "@arbor/canopy";
import { CanopyAccountStore, ProfileIdentityStore, loadCanopyAccountConfigurations, loadLocalPlacements } from "@arbor/stores";
import { parseDocument } from "yaml";

let sandbox: string;
let state: string;
let profile: string;
let firstCanopy: Awaited<ReturnType<typeof serveCanopy>>;
let secondCanopy: Awaited<ReturnType<typeof serveCanopy>>;

async function arborOutput(args: string[]): Promise<{ stdout: string; stderr: string }> {
  const process = Bun.spawn(["bun", "packages/cli/src/index.ts", ...args], {
    cwd: join(import.meta.dir, "../.."),
    env: { ...Bun.env, ARBOR_DATA_HOME: state },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exit, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  if (exit !== 0) throw new Error(stderr);
  return { stdout: stdout.trim(), stderr: stderr.trim() };
}

async function arbor(args: string[]): Promise<string> {
  return (await arborOutput(args)).stdout;
}

async function arborFailure(args: string[]): Promise<string> {
  const process = Bun.spawn(["bun", "packages/cli/src/index.ts", ...args], {
    cwd: join(import.meta.dir, "../.."),
    env: { ...Bun.env, ARBOR_DATA_HOME: state },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exit, stderr] = await Promise.all([
    process.exited,
    new Response(process.stderr).text(),
  ]);
  expect(exit).not.toBe(0);
  return stderr;
}

async function canopyFailure(args: string[], env: Record<string, string>): Promise<string> {
  const process = Bun.spawn(["bun", "packages/canopy/src/cli.ts", ...args], {
    cwd: join(import.meta.dir, "../.."),
    env: { ...Bun.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exit, stderr] = await Promise.all([process.exited, new Response(process.stderr).text()]);
  expect(exit).not.toBe(0);
  return stderr;
}

async function source(name: string, contents = "# CLI place\n"): Promise<string> {
  const path = join(sandbox, name);
  await mkdir(path);
  await writeFile(join(path, "note.md"), contents);
  return realpath(path);
}

beforeAll(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "arbor-cli-sync-"));
  state = join(sandbox, "state");
  profile = join(sandbox, "profile");
  await Promise.all([state, profile].map((path) => mkdir(path, { recursive: true })));
  process.env.ARBOR_DATA_HOME = state;
  const identity = await new ProfileIdentityStore().create(profile);
  firstCanopy = await serveCanopy({
    dataRoot: join(sandbox, "first-canopy"),
    publicOrigin: "http://127.0.0.1:0",
    hostname: "127.0.0.1",
    port: 0,
    community: { handle: "first", name: "First", firstWriter: { handle: "alice", profileTree: identity.profileTree } },
  });
  secondCanopy = await serveCanopy({
    dataRoot: join(sandbox, "second-canopy"),
    publicOrigin: "http://127.0.0.1:0",
    hostname: "127.0.0.1",
    port: 0,
    community: { handle: "second", name: "Second", firstWriter: { handle: "joe", profileTree: identity.profileTree } },
  });
  const daemon = await ArborSyncDaemon.open(profile);
  try {
    await daemon.claimCanopyAccount(`${firstCanopy.url}/~alice`, profile, "Alice");
    await daemon.claimCanopyAccount(`${secondCanopy.url}/~joe`, profile, "Joe");
  } finally {
    await daemon[Symbol.asyncDispose]();
  }
});

afterAll(async () => {
  process.env.ARBOR_DATA_HOME = state;
  for (const account of await CanopyAccountStore.list()) await new CanopyAccountStore(account.configurationTree).remove();
  firstCanopy.server.stop(true);
  secondCanopy.server.stop(true);
  await firstCanopy.canopy[Symbol.asyncDispose]();
  await secondCanopy.canopy[Symbol.asyncDispose]();
  await rm(sandbox, { recursive: true, force: true });
});

describe("plural-account CLI place", () => {
  test("selects the account that owns each canonical namespace", async () => {
    const firstSource = await source("first-source", "# First\n");
    const secondSource = await source("second-source", "# Second\n");
    const firstCanonical = `${firstCanopy.url}/~alice/notes`;
    const secondCanonical = `${secondCanopy.url}/~joe/notes`;

    expect(await arbor(["place", "--access", "public=read", firstSource, firstCanonical])).toContain(firstCanonical);
    expect(await arbor(["place", "--access", "public=read", secondSource, secondCanonical])).toContain(secondCanonical);

    const accounts = await loadCanopyAccountConfigurations();
    const placements = (await loadLocalPlacements()).placements;
    const firstAccount = accounts.find((account) => account.account?.canopy === firstCanopy.url)!;
    const secondAccount = accounts.find((account) => account.account?.canopy === secondCanopy.url)!;
    expect(placements.find((placement) => placement.path === firstSource)?.configurationTree).toBe(firstAccount.configurationTree);
    expect(placements.find((placement) => placement.path === secondSource)?.configurationTree).toBe(secondAccount.configurationTree);
    expect(firstCanopy.canopy.boundary("/~alice/notes")?.publicAccess).toBe("read");
    expect(secondCanopy.canopy.boundary("/~joe/notes")?.publicAccess).toBe("read");
  });

  test("creates private trees by default and updates existing access", async () => {
    const privateSource = await source("private-source", "# Private\n");
    const canonical = `${secondCanopy.url}/~joe/private-notes`;

    const created = await arborOutput(["place", privateSource, canonical]);
    expect(created.stderr).toContain("private access");
    expect(secondCanopy.canopy.boundary("/~joe/private-notes")?.publicAccess).toBe("none");

    await arbor(["place", "--access", "public=read", privateSource, canonical]);
    expect(secondCanopy.canopy.boundary("/~joe/private-notes")?.publicAccess).toBe("read");
    const repeated = await arborOutput(["place", privateSource, canonical]);
    expect(repeated.stderr).toBe("");
    expect(secondCanopy.canopy.boundary("/~joe/private-notes")?.publicAccess).toBe("read");
  });

  test("refuses canonical paths outside every claimed account allocation", async () => {
    const misplaced = await source("misplaced-source");
    const error = await arborFailure(["place", misplaced, `${secondCanopy.url}/~someone-else/notes`]);
    expect(error).toContain("No claimed Canopy account contains");
  });

  test("places an existing private tree through its matching account", async () => {
    const original = await source("remote-source", "# Private remote\n");
    const destination = join(sandbox, "remote-destination");
    const canonical = `${secondCanopy.url}/~joe/private-remote`;
    await arbor(["place", original, canonical]);

    const accounts = await loadCanopyAccountConfigurations();
    const account = accounts.find((candidate) => candidate.account?.canopy === secondCanopy.url)!;
    const tree = Object.entries(account.trees!).find(([, declaration]) => declaration.canonical === canonical)![0];
    const placementsPath = join(state, "placements.yaml");
    const document = parseDocument(await readFile(placementsPath, "utf8"), { uniqueKeys: true, keepSourceTokens: true });
    document.deleteIn([account.configurationTree, original]);
    await writeFile(placementsPath, document.toString({ lineWidth: 0 }));
    await rm(join(state, ".state", "accounts", account.configurationTree, "refs", `${tree}.json`), { force: true });
    await rm(original, { recursive: true });

    expect(await arbor(["place", canonical, destination])).toContain("(write)");
    expect(await arbor(["place", canonical, destination])).toContain("(write)");
    expect(await readFile(join(destination, "note.md"), "utf8")).toBe("# Private remote\n");
    const placedDestination = await realpath(destination);
    expect((await loadLocalPlacements()).placements).toContainEqual({
      configurationTree: account.configurationTree,
      path: placedDestination,
      tree,
    });
  });

  test("rejects malformed access assignments before changing configuration", async () => {
    const invalidSource = await source("invalid-source");
    const canonical = `${firstCanopy.url}/~alice/invalid-access`;
    const error = await arborFailure(["place", "--access", "public=reader,~editors", invalidSource, canonical]);
    expect(error).toContain("Expected subject=read|write|none");
    expect(firstCanopy.canopy.boundary("/~alice/invalid-access")).toBeNull();
  });
});

describe("Canopy deployment guards", () => {
  test("refuses an ephemeral or unnamed Railway Canopy", async () => {
    const noDomain = await canopyFailure([], {
      RAILWAY_PROJECT_ID: "test-project",
      RAILWAY_PUBLIC_DOMAIN: "",
      RAILWAY_VOLUME_MOUNT_PATH: "",
      ARBOR_DOMAIN: "",
    });
    expect(noDomain).toContain("needs a public domain");

    const noVolume = await canopyFailure([], {
      RAILWAY_PROJECT_ID: "test-project",
      RAILWAY_PUBLIC_DOMAIN: "garden.up.railway.app",
      RAILWAY_VOLUME_MOUNT_PATH: "",
      ARBOR_DOMAIN: "",
    });
    expect(noVolume).toContain("needs a persistent volume");
  });

  test("requires explicit bootstrap handles for a fresh unattended Canopy", async () => {
    const bootstrapEnv = {
      RAILWAY_PROJECT_ID: "",
      RAILWAY_ENVIRONMENT_ID: "",
      ARBOR_DOMAIN: "",
      ARBOR_ACCOUNT_TOKEN: "",
      ARBOR_OWNER_TOKEN: "",
      ARBOR_ACCOUNTS_JSON: "",
    };
    const missingCommunity = await canopyFailure([join(sandbox, "unattended-no-community")], bootstrapEnv);
    expect(missingCommunity).toContain("requires --community <handle>");
    const missingFirstWriter = await canopyFailure(
      [join(sandbox, "unattended-no-writer"), "--community", "garden"],
      bootstrapEnv,
    );
    expect(missingFirstWriter).toContain("requires --first-writer <handle>");
  });
});
