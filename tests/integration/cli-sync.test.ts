import { HostAccountStore, ProtocolClient, loadAccountConfigurations, generateArborID, treeConfigurationID } from "@overstory/protocol";
import { editTreeConfig, readTreeConfig } from "../helpers/tree-config.ts";
import { LocalAccountService } from "../../packages/arborsync/src/account-service.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ArborSyncDaemon, EventBus, TreeManager } from "@overstory/arborsync";
import { serveArborSyncControl } from "@overstory/arborsync";
import { serveHost } from "@overstory/canopyd";
import { ProfileIdentityStore, loadLocalPlacements } from "@overstory/arborsync/state";
import { parseDocument } from "yaml";

const bunExecutable = process.execPath;
const cliEntry = process.env.ARBOR_TEST_CLI_ENTRY ?? join(import.meta.dir, "../../packages/cli/src/index.ts");
let sandbox: string;
let state: string;
let profile: string;
let firstHost: Awaited<ReturnType<typeof serveHost>>;
let secondHost: Awaited<ReturnType<typeof serveHost>>;
let profileTree: string;
let previousCloudHome: string | undefined;

async function arborOutput(args: string[]): Promise<{ stdout: string; stderr: string }> {
  const daemon = await serveArborSyncControl({ port: 0 });
  const process = Bun.spawn([bunExecutable, cliEntry, ...args], {
    cwd: Bun.env.ARBOR_TEST_CLI_ENTRY ? sandbox : join(import.meta.dir, "../.."),
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
  const process = Bun.spawn([bunExecutable, cliEntry, "status", "--json"], {
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
  const process = Bun.spawn([bunExecutable, cliEntry, ...args], {
    cwd: Bun.env.ARBOR_TEST_CLI_ENTRY ? sandbox : join(import.meta.dir, "../.."),
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

async function hostFailure(args: string[], env: Record<string, string>): Promise<string> {
  const process = Bun.spawn(["bun", "packages/canopyd/src/cli.ts", ...args], {
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
  firstHost = await serveHost({
    dataRoot: join(sandbox, "first-canopy"),
    publicOrigin: "http://127.0.0.1:0",
    hostname: "127.0.0.1",
    port: 0,
    community: { handle: "first", name: "First", firstWriter: { handle: "alice", profileTree: identity.profileTree } },
  });
  secondHost = await serveHost({
    dataRoot: join(sandbox, "second-canopy"),
    publicOrigin: "http://127.0.0.1:0",
    hostname: "127.0.0.1",
    port: 0,
    community: { handle: "second", name: "Second", firstWriter: { handle: "joe", profileTree: identity.profileTree } },
  });
  profileTree = identity.profileTree;
  const daemon = await ArborSyncDaemon.open(profile);
  try {
    await new LocalAccountService({ trees: daemon.trees, events: daemon.events }).claimHostAccount(`${firstHost.url}/~alice`, profile, "Alice");
    // One home host per profile until Security 007: a second host's claim is refused.
    await expect(new LocalAccountService({ trees: daemon.trees, events: daemon.events }).claimHostAccount(`${secondHost.url}/~joe`, profile, "Joe"))
      .rejects.toThrow("one home host");
    await new LocalAccountService({ trees: daemon.trees, events: daemon.events }).cancelPendingClaim().catch(() => {});
  } finally {
    await daemon[Symbol.asyncDispose]();
  }
});

afterAll(async () => {
  process.env.ARBOR_DATA_HOME = state;
  for (const account of await HostAccountStore.list()) await new HostAccountStore(account.configurationTree).remove();
  firstHost.server.stop(true);
  secondHost.server.stop(true);
  await firstHost.canopy[Symbol.asyncDispose]();
  await secondHost.canopy[Symbol.asyncDispose]();
  await rm(sandbox, { recursive: true, force: true });
  if (previousCloudHome === undefined) delete process.env.ARBOR_CLOUD_HOME;
  else process.env.ARBOR_CLOUD_HOME = previousCloudHome;
});

describe("plural-account CLI place", () => {
  test("reuses and revokes a cloud bundle across complete start and finish sessions", async () => {
    const original = await source("cloud-source", "# From the creator\n");
    const canonical = `${firstHost.url}/~alice/cloud-source`;
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

  test("declares, mounts and activates a placed tree below the profile, publicly readable when asked", async () => {
    const firstSource = await source("first-source", "# First\n");
    const firstCanonical = `${firstHost.url}/~alice/notes`;
    expect(await arbor(["place", "--access", "public=read", firstSource, firstCanonical])).toContain(firstCanonical);
    const accounts = await loadAccountConfigurations();
    const placements = (await loadLocalPlacements()).placements;
    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.configurationTree).toBe(treeConfigurationID(profileTree));
    expect(placements.find((placement) => placement.path === firstSource)?.configurationTree).toBe(accounts[0]!.configurationTree);
    const tree = firstHost.canopy.boundary("/~alice/notes")!.id;
    expect(firstHost.canopy.canRead(null, tree)).toBe(true);
    // The mount is in the profile's configuration, which is the local checkout.
    expect(await readFile(join(accounts[0]!.path, "mounts.yaml"), "utf8")).toContain(`notes: ${tree}`);
    expect(firstHost.canopy.canAdminister(firstHost.canopy.account(profileTree)!, tree)).toBe(true);
  });

  test("creates private trees by default and updates existing access", async () => {
    const privateSource = await source("private-source", "# Private\n");
    const canonical = `${firstHost.url}/~alice/private-notes`;

    const created = await arborOutput(["place", privateSource, canonical]);
    expect(created.stderr).toContain("private access");
    expect(firstHost.canopy.canRead(null, firstHost.canopy.boundary("/~alice/private-notes")!.id)).toBe(false);

    await arbor(["place", "--access", "public=read", privateSource, canonical]);
    expect(firstHost.canopy.canRead(null, firstHost.canopy.boundary("/~alice/private-notes")!.id)).toBe(true);
    const repeated = await arborOutput(["place", privateSource, canonical]);
    expect(repeated.stderr).toBe("");
    expect(firstHost.canopy.canRead(null, firstHost.canopy.boundary("/~alice/private-notes")!.id)).toBe(true);
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

  test("refuses canonical URLs on a Canopy with no claimed account", async () => {
    const misplaced = await source("misplaced-source");
    const error = await arborFailure(["place", misplaced, `${secondHost.url}/~someone-else/notes`]);
    expect(error).toContain("No claimed Canopy account contains");
  });

  test("places an existing private tree from its canonical URL", async () => {
    const original = await source("remote-source", "# Private remote\n");
    const destination = join(sandbox, "remote-destination");
    const canonical = `${firstHost.url}/~alice/private-remote`;
    await arbor(["place", original, canonical]);

    const account = (await loadAccountConfigurations())[0]!;
    const tree = firstHost.canopy.boundary("/~alice/private-remote")!.id;
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
    const canonical = `${firstHost.url}/~alice/invalid-access`;
    const error = await arborFailure(["place", "--access", "public=reader,~editors", invalidSource, canonical]);
    expect(error).toContain("Expected subject=read|write|none");
    expect(firstHost.canopy.boundary("/~alice/invalid-access")).toBeNull();
  });

  test("renames a canonical tree by renaming its mount", async () => {
    const healthySource = await source("healthy", "# Healthy account\n");
    const canonical = `${firstHost.url}/~alice/healthy`;
    expect(await arbor(["place", healthySource, canonical])).toContain(canonical);
    const tree = firstHost.canopy.boundary("/~alice/healthy")!.id;
    const moved = `${firstHost.url}/~alice/healthy-moved`;
    expect(await arbor(["mv", canonical, moved])).toContain(`to ${moved}`);
    expect(firstHost.canopy.boundary("/~alice/healthy")).toBeNull();
    expect(firstHost.canopy.boundary("/~alice/healthy-moved")?.id).toBe(tree);
  });

  test("refuses to declare a tree while its Canopy is unreachable, changing nothing", async () => {
    firstHost.server.stop(true);
    try {
      const offlineSource = await source("placed-while-first-offline", "# Placed offline\n");
      const account = (await loadAccountConfigurations())[0]!;
      const before = await readFile(join(account.path, "mounts.yaml"), "utf8");
      await arborFailure(["place", offlineSource, `${firstHost.url}/~alice/offline-placed`]);
      expect(await readFile(join(account.path, "mounts.yaml"), "utf8")).toBe(before);
      expect((await loadLocalPlacements()).placements.some((placement) => placement.path === offlineSource)).toBe(false);
    } finally {
      firstHost = await serveHost({
        dataRoot: join(sandbox, "first-canopy"),
        publicOrigin: firstHost.url,
        hostname: "127.0.0.1",
        port: Number(new URL(firstHost.url).port),
        community: { handle: "first", name: "First" },
      });
    }
  });
});

describe("Canopy deployment guards", () => {
  test("refuses an ephemeral or unnamed Railway Canopy", async () => {
    const noDomain = await hostFailure([], {
      RAILWAY_PROJECT_ID: "test-project",
      RAILWAY_PUBLIC_DOMAIN: "",
      RAILWAY_VOLUME_MOUNT_PATH: "",
      ARBOR_DOMAIN: "",
    });
    expect(noDomain).toContain("needs a public domain");

    const noVolume = await hostFailure([], {
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
      ARBOR_ACCOUNTS_JSON: "",
    };
    const missingCommunity = await hostFailure([join(sandbox, "unattended-no-community")], { ...bootstrapEnv, ARBOR_COMMUNITY_HANDLE: "" });
    expect(missingCommunity).toContain("No community at");
    expect(missingCommunity).toContain("canopyd init <community> --founder <handle>=<TreeID>");
    const missingFirstWriter = await hostFailure(
      [join(sandbox, "unattended-no-writer")],
      { ...bootstrapEnv, ARBOR_COMMUNITY_HANDLE: "garden", ARBOR_FIRST_WRITER_HANDLE: "", ARBOR_FIRST_WRITER_PROFILE: "" },
    );
    expect(missingFirstWriter).toContain("requires ARBOR_FIRST_WRITER_HANDLE and ARBOR_FIRST_WRITER_PROFILE");
    const badFounder = await hostFailure(["init", "lab", "--founder", "joe", "--data", join(sandbox, "init-bad-founder")], bootstrapEnv);
    expect(badFounder).toContain("--founder must be <handle>=<TreeID>");
  });
});

test("CLI sharing edits preserve unrelated granular and executable rules", async () => {
  const path = await source("resource-policy-cli", "# Resource policy\n");
  const canonical = `${firstHost.url}/~alice/resource-policy-cli`;
  await arbor(["place", path, canonical]);
  const account = (await loadAccountConfigurations())[0]!;
  const record = await new HostAccountStore(account.configurationTree).get();
  const wire = new ProtocolClient(firstHost.url, record!.accountToken);
  const tree = firstHost.canopy.boundary("/~alice/resource-policy-cli")!.id;
  const grants = [
    { who: { profile: generateArborID("tr") }, allow: ["create-child" as const] },
    { who: "everyone" as const, app: "tr_supplies", allow: ["read" as const] },
    { who: { profile: generateArborID("tr") }, within: "/inbox", allow: ["create-child" as const] },
  ];
  await editTreeConfig(wire, tree, "tree", (values) => ({ ...values, access: [...values.access, ...grants] }));
  await arbor(["place", "--access", "public=read", path, canonical]);
  const { values } = await readTreeConfig(wire, tree, "tree");
  expect(values.access.filter((rule) => !rule.allow.includes("admin"))).toEqual(expect.arrayContaining([...grants, { who: "everyone", allow: ["read"] }]));
  expect(values.access.filter((rule) => !rule.allow.includes("admin"))).toHaveLength(4);
});
