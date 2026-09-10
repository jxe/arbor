import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ArborSyncDaemon, EventBus, TreeManager } from "@arbor/arborsync";
import { serveArborSyncControl } from "@arbor/arborsync";
import { serveCanopy } from "@arbor/canopy";
import { ArborSyncRESTClient } from "@arbor/arborsync-client";
import { CanopyAccountStore, ProfileIdentityStore, loadCanopyAccountConfigurations, loadLocalPlacements } from "@arbor/stores";
import { generateArborID } from "@arbor/core";
import { parseDocument } from "yaml";

let sandbox: string;
let state: string;
let profile: string;
let firstCanopy: Awaited<ReturnType<typeof serveCanopy>>;
let secondCanopy: Awaited<ReturnType<typeof serveCanopy>>;
let previousCloudHome: string | undefined;

async function arborOutput(args: string[]): Promise<{ stdout: string; stderr: string }> {
  const daemon = await serveArborSyncControl({ port: 0 });
  const process = Bun.spawn(["bun", "packages/cli/src/index.ts", ...args], {
    cwd: join(import.meta.dir, "../.."),
    env: { ...Bun.env, ARBOR_DATA_HOME: state, ARBOR_SYNC_URL: daemon.url },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exit, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  daemon.server.stop(true);
  await daemon.service[Symbol.asyncDispose]();
  if (exit !== 0) throw new Error(stderr);
  return { stdout: stdout.trim(), stderr: stderr.trim() };
}

async function arbor(args: string[]): Promise<string> {
  return (await arborOutput(args)).stdout;
}

async function cloudStatus(path: string): Promise<Record<string, unknown>> {
  const environment: Record<string, string | undefined> = { ...Bun.env };
  delete environment.ARBOR_DATA_HOME;
  delete environment.ARBOR_SYNC_URL;
  const process = Bun.spawn(["bun", join(import.meta.dir, "../../packages/cli/src/index.ts"), "status", "--json"], {
    cwd: path,
    env: environment,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exit, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  expect(exit, stderr).toBe(0);
  return JSON.parse(stdout) as Record<string, unknown>;
}

async function arborFailure(args: string[]): Promise<string> {
  const daemon = await serveArborSyncControl({ port: 0 });
  const process = Bun.spawn(["bun", "packages/cli/src/index.ts", ...args], {
    cwd: join(import.meta.dir, "../.."),
    env: { ...Bun.env, ARBOR_DATA_HOME: state, ARBOR_SYNC_URL: daemon.url },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exit, stderr] = await Promise.all([
    process.exited,
    new Response(process.stderr).text(),
  ]);
  daemon.server.stop(true);
  await daemon.service[Symbol.asyncDispose]();
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
  previousCloudHome = process.env.ARBOR_CLOUD_HOME;
  process.env.ARBOR_CLOUD_HOME = join(sandbox, "cloud-sessions");
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
  if (previousCloudHome === undefined) delete process.env.ARBOR_CLOUD_HOME;
  else process.env.ARBOR_CLOUD_HOME = previousCloudHome;
});

describe("plural-account CLI place", () => {
  test("reuses and revokes a cloud bundle across complete start and finish sessions", async () => {
    const original = await source("cloud-source", "# From the creator\n");
    const canonical = `${firstCanopy.url}/~alice/cloud-source`;
    await arbor(["place", original, canonical]);
    const created = await arborOutput([
      "cloud", "bundle", "create", "--name", "Integration cloud bundle",
      "--place", canonical, "checkout",
    ]);
    expect(created.stderr).toContain("Created reusable cloud bundle");
    expect(created.stdout).toStartWith("arbor-cloud-v1.cb_");
    expect(created.stdout).not.toContain("From the creator");

    const firstRoot = join(sandbox, "cloud-run-one");
    expect(await arborFailure(["cloud", "start", created.stdout, "--root", firstRoot, "--timeout", "1ms"]))
      .toContain("retained for retry");
    expect(await cloudStatus(firstRoot)).toMatchObject({
      ready: false,
      context: { kind: "cloud" },
      cloudSession: { phase: "interrupted" },
    });
    const started = await arborOutput(["cloud", "start", created.stdout, "--root", firstRoot, "--timeout", "15s", "--json"]);
    expect(JSON.parse(started.stdout)).toMatchObject({ ready: true, root: await realpath(firstRoot) });
    expect(await cloudStatus(firstRoot)).toMatchObject({
      ready: true,
      context: { kind: "cloud" },
      runtime: { state: "running", runtimeKind: "cloud" },
      cloudSession: { phase: "ready" },
    });
    expect(await readFile(join(firstRoot, "checkout", "note.md"), "utf8")).toBe("# From the creator\n");
    await writeFile(join(firstRoot, "checkout", "note.md"), "# From cloud one\n");
    expect(JSON.parse((await arborOutput(["cloud", "finish", "--root", firstRoot, "--timeout", "15s", "--json"])).stdout))
      .toMatchObject({ finished: true, root: await realpath(firstRoot) });
    expect(await cloudStatus(firstRoot)).toMatchObject({
      ready: false,
      context: { kind: "cloud" },
      runtime: { state: "stopped" },
      cloudSession: { phase: "finished" },
    });

    const secondRoot = join(sandbox, "cloud-run-two");
    await arborOutput(["cloud", "start", created.stdout, "--root", secondRoot, "--timeout", "15s"]);
    expect(await readFile(join(secondRoot, "checkout", "note.md"), "utf8")).toBe("# From cloud one\n");
    await arborOutput(["cloud", "finish", "--root", secondRoot, "--timeout", "15s"]);

    const bundleID = created.stdout.split(".")[1]!;
    await arborOutput(["cloud", "bundle", "revoke", bundleID]);
    const listed = JSON.parse((await arborOutput(["cloud", "bundle", "list", "--json"])).stdout);
    expect(listed.bundles).toContainEqual(expect.objectContaining({ bundleID, revokedAt: expect.any(String) }));
    expect(JSON.stringify(listed)).not.toContain(created.stdout);
    expect(await arborFailure(["cloud", "start", created.stdout, "--root", join(sandbox, "cloud-run-revoked"), "--timeout", "2s"]))
      .toContain("unauthenticated");
  }, 45_000);

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

    // A root-shaped placement on another Canopy cannot become this tree's
    // canonical parent merely because its URL path is a lexical prefix.
    const firstTree = Object.entries(firstAccount.trees!).find(([, declaration]) => declaration.canonical === firstCanonical)![0];
    const firstTreesPath = join(firstAccount.path, "trees.yaml");
    const firstTreesSource = await readFile(firstTreesPath, "utf8");
    const firstDocument = parseDocument(firstTreesSource, { uniqueKeys: true, keepSourceTokens: true });
    firstDocument.setIn([firstTree, "canonical"], firstCanopy.url);
    await writeFile(firstTreesPath, firstDocument.toString({ lineWidth: 0 }));
    const manager = new TreeManager(new EventBus());
    try {
      await manager.init();
      const secondTree = Object.entries(secondAccount.trees!).find(([, declaration]) => declaration.canonical === secondCanonical)![0];
      const descriptor = (await manager.descriptors()).find((candidate) => candidate.id === secondTree)!;
      expect(descriptor.canonical?.parentTree).toBeNull();
    } finally {
      await manager[Symbol.asyncDispose]();
      await writeFile(firstTreesPath, firstTreesSource);
    }
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

  test("reopens an unplaced session after an offline identity rebind", async () => {
    const path = await source("offline-identity-rebind");
    const manager = new TreeManager(new EventBus());
    try {
      await manager.init();
      const before = await manager.openSession(path);
      const reboundTree = generateArborID("tr");
      const registryPath = join(state, ".state", "workspaces.json");
      const registry = JSON.parse(await readFile(registryPath, "utf8"));
      registry[path].rootID = reboundTree;
      await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`);

      const after = await manager.openSession(path);
      expect(after.tree).toBe(reboundTree);
      expect(after).not.toBe(before);
    } finally {
      await manager[Symbol.asyncDispose]();
    }
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

  test("does not let an offline account block placement through a healthy account", async () => {
    firstCanopy.server.stop(true);
    const healthySource = await source("healthy-while-first-offline", "# Healthy account\n");
    const canonical = `${secondCanopy.url}/~joe/healthy`;
    expect(await arbor(["place", healthySource, canonical])).toContain(canonical);
    expect(secondCanopy.canopy.boundary("/~joe/healthy")?.id).toBeDefined();

    const moved = `${secondCanopy.url}/~joe/healthy-moved`;
    expect(await arbor(["mv", canonical, moved])).toContain(`to ${moved}`);
    expect(secondCanopy.canopy.boundary("/~joe/healthy")).toBeNull();
    expect(secondCanopy.canopy.boundary("/~joe/healthy-moved")?.id).toBeDefined();
  });

  test("places through a stopped Canopy by editing trees.yaml on disk, then pushes on reconnect", async () => {
    // firstCanopy was stopped by the previous test and stays stopped here.
    const offlineSource = await source("placed-while-first-offline", "# Placed offline\n");
    const canonical = `${firstCanopy.url}/~alice/offline-placed`;
    const account = (await loadCanopyAccountConfigurations()).find((candidate) => candidate.account?.canopy === firstCanopy.url)!;
    const before = await readFile(join(account.path, "trees.yaml"), "utf8");

    const daemon = await serveArborSyncControl({ port: 0 });
    try {
      const placed = Bun.spawn(["bun", "packages/cli/src/index.ts", "place", offlineSource, canonical], {
        cwd: join(import.meta.dir, "../.."),
        env: { ...Bun.env, ARBOR_DATA_HOME: state, ARBOR_SYNC_URL: daemon.url },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exit, stdout, stderr] = await Promise.all([placed.exited, new Response(placed.stdout).text(), new Response(placed.stderr).text()]);
      expect(exit, stderr).toBe(0);
      expect(stdout).toContain(canonical);
      expect(stderr).toContain("unreachable");

      const after = await readFile(join(account.path, "trees.yaml"), "utf8");
      expect(after).not.toBe(before);
      const declared = parseDocument(after).toJS() as Record<string, { canonical: string }>;
      const tree = Object.entries(declared).find(([, declaration]) => declaration.canonical === canonical)?.[0];
      expect(tree).toBeDefined();
      expect((await loadLocalPlacements()).placements).toContainEqual({ configurationTree: account.configurationTree, path: offlineSource, tree: tree! });

      const client = new ArborSyncRESTClient({ baseURL: daemon.url });
      const configurationDescriptor = () => client.trees().then((value) =>
        value.snapshot.find((candidate) => candidate.id === account.configurationTree && candidate.configurationTree === account.configurationTree)
      );
      expect((await configurationDescriptor())?.sync).toBe("offline");

      firstCanopy = await serveCanopy({
        dataRoot: join(sandbox, "first-canopy"),
        publicOrigin: firstCanopy.url,
        hostname: "127.0.0.1",
        port: Number(new URL(firstCanopy.url).port),
        community: { handle: "first", name: "First" },
      });
      await client.synchronizeNow(account.configurationTree);
      expect((await configurationDescriptor())?.sync).toBe("idle");
      expect(firstCanopy.canopy.boundary("/~alice/offline-placed")?.id).toBe(tree);
    } finally {
      daemon.server.stop(true);
      await daemon.service[Symbol.asyncDispose]();
    }
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
