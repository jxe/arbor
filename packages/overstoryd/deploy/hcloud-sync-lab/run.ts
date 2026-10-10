#!/usr/bin/env bun
import { chmod, mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { LabDevice } from "./lab-node.ts";

const ROOT = resolve(import.meta.dir, "..", "..", "..", "..");
/** Where `configure-node.sh` keeps the owner's first device on the community machine, root-only. */
const OWNER_DEVICE_PATH = "/etc/overstoryd-owner.json";
/** A shell line on the community machine that sets `$session` to an owner session token. */
const OWNER_SESSION = `session=$(/usr/local/bin/bun /opt/story-current/packages/overstoryd/deploy/hcloud-sync-lab/lab-node.ts owner-session < ${OWNER_DEVICE_PATH})`;
const STATE_ROOT = join(ROOT, ".story-lab");
const TAILSCALE_AUTH_KEY_ENV = "TAILSCALE_AUTH_KEY";
const ROLES = ["community", "alice", "bob", "carol"] as const;
type Role = typeof ROLES[number];

interface LabNode {
  role: Role;
  id: number;
  name: string;
  ipv4: string;
}

interface LabState {
  version: 1;
  runId: string;
  createdAt: string;
  destroyedAt?: string;
  revision: string;
  context: string;
  location: string;
  serverType: string;
  image: string;
  sshKeyName: string;
  sshPrivateKey: string;
  bunVersion: string;
  nodes: Partial<Record<Role, LabNode>>;
  steps: Partial<Record<"up" | "provisioned" | "tailscale" | "configured" | "smoke" | "acceptance" | "authorization" | "collected", string>>;
  acceptance?: {
    additive: { scenario: string; tree: string };
    conflict: { scenario: string; tree: string };
    replay: { scenario: string; tree: string };
  };
  authorization?: { scenario: string; tree: string };
}

interface Options {
  command: string;
  runId?: string;
  context: string;
  location: string;
  serverType: string;
  image: string;
  sshKeyName: string;
  sshPrivateKey: string;
  allowDirty: boolean;
  skipCollect: boolean;
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function usage(exitCode = 2): never {
  console.error(`Usage: bun run lab:hcloud <command> [options]

Commands:
  preflight   Verify local tools, hcloud context, SSH key, and pinned runtime
  up          Create or resume the four exactly scoped VMs
  provision   Install Ubuntu dependencies, Tailscale, and the exact Git revision
  resume      Continue provisioning after Tailscale authentication
  run         Run up, provision, Tailscale check, and configuration
  smoke       Run a quick private-tree three-client synchronization
  test        Run the complete accepted-update pre-rollout acceptance suite
  test:authorization
              Run distinct-user read, write, read-only, and no-access checks
  status      Show recorded phase and live server state
  collect     Download journals, Canopy backup, and immutable objects
  reset       Clear and reconfigure the four recorded disposable lab servers
  down        Collect evidence, log out of Tailscale, and delete recorded server IDs

Options:
  --run-id <id>             Resume a specific run (latest active run by default)
  --context <name>          hcloud context (default: arbor-lab)
  --location <name>         Hetzner location (default: nbg1)
  --server-type <name>      Hetzner server type (default: cx23)
  --image <name>            Hetzner image (default: ubuntu-24.04)
  --hetzner-ssh-key <name>  Registered Hetzner SSH key (default: arbor-lab)
  --ssh-key <path>          Local private SSH key (default: ~/.ssh/arbor_hetzner)
  --allow-dirty             Permit preflight only; deployments still use committed HEAD
  --skip-collect            Skip best-effort evidence collection before down

Environment:
  TAILSCALE_AUTH_KEY        Reusable auth key for browserless node authentication
`);
  process.exit(exitCode);
}

function parseOptions(argv: string[]): Options {
  const command = argv.shift() ?? "help";
  const options: Options = {
    command,
    context: "arbor-lab",
    location: "nbg1",
    serverType: "cx23",
    image: "ubuntu-24.04",
    sshKeyName: "arbor-lab",
    sshPrivateKey: join(homedir(), ".ssh", "arbor_hetzner"),
    allowDirty: false,
    skipCollect: false,
  };
  while (argv.length) {
    const flag = argv.shift()!;
    if (flag === "--allow-dirty") options.allowDirty = true;
    else if (flag === "--skip-collect") options.skipCollect = true;
    else {
      const value = argv.shift();
      if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
      if (flag === "--run-id") options.runId = value;
      else if (flag === "--context") options.context = value;
      else if (flag === "--location") options.location = value;
      else if (flag === "--server-type") options.serverType = value;
      else if (flag === "--image") options.image = value;
      else if (flag === "--hetzner-ssh-key") options.sshKeyName = value;
      else if (flag === "--ssh-key") options.sshPrivateKey = resolve(value);
      else throw new Error(`Unknown option: ${flag}`);
    }
  }
  return options;
}

async function command(
  args: string[],
  options: { stdin?: string; timeoutMs?: number; allowFailure?: boolean; quiet?: boolean } = {},
): Promise<CommandResult> {
  const child = Bun.spawn(args, {
    cwd: ROOT,
    env: labChildEnvironment(),
    stdin: options.stdin === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (options.stdin !== undefined) {
    const stdin = child.stdin;
    if (!stdin) throw new Error(`Failed to open stdin for ${args[0]}`);
    stdin.write(options.stdin);
    stdin.end();
  }
  const timer = setTimeout(() => child.kill(), options.timeoutMs ?? 120_000);
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]).finally(() => clearTimeout(timer));
  if (!options.quiet && stdout.trim()) process.stdout.write(stdout);
  if (exitCode !== 0 && !options.allowFailure) {
    throw new Error(`${args[0]} failed (${exitCode}): ${stderr.trim() || stdout.trim()}`);
  }
  return { exitCode, stdout, stderr };
}

function hcloudArgs(stateOrOptions: Pick<LabState, "context"> | Pick<Options, "context">, args: string[]): string[] {
  return ["hcloud", "--context", stateOrOptions.context, "--http-timeout", "30s", ...args];
}

async function hcloudJSON<T>(stateOrOptions: Pick<LabState, "context"> | Pick<Options, "context">, args: string[]): Promise<T> {
  const result = await command(hcloudArgs(stateOrOptions, [...args, "-o", "json"]), { quiet: true });
  return JSON.parse(result.stdout) as T;
}

function statePath(runId: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(runId)) throw new Error(`Invalid run ID: ${runId}`);
  return join(STATE_ROOT, `${runId}.json`);
}

function knownHostsPath(runId: string): string {
  statePath(runId);
  return join(STATE_ROOT, `${runId}.known_hosts`);
}

function validateState(state: LabState): LabState {
  statePath(state.runId);
  if (
    state.version !== 1
    || !/^[a-f0-9]{40}$/.test(state.revision)
    || !/^\d+\.\d+\.\d+$/.test(state.bunVersion)
  ) throw new Error("Invalid lab state file");
  for (const role of ROLES) {
    const node = state.nodes[role];
    if (!node) continue;
    if (
      node.role !== role
      || node.name !== `story-${role}`
      || !Number.isSafeInteger(node.id)
      || node.id <= 0
      || !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(node.ipv4)
    ) {
      throw new Error(`Invalid recorded node for ${role}`);
    }
  }
  return state;
}

async function saveState(state: LabState): Promise<void> {
  await mkdir(STATE_ROOT, { recursive: true, mode: 0o700 });
  const destination = statePath(state.runId);
  const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, destination);
  await chmod(destination, 0o600);
}

async function loadState(runId?: string): Promise<LabState> {
  if (runId) return validateState(JSON.parse(await readFile(statePath(runId), "utf8")) as LabState);
  const entries = await readdir(STATE_ROOT, { withFileTypes: true }).catch(() => []);
  const states = await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map(async (entry) => validateState(JSON.parse(await readFile(join(STATE_ROOT, entry.name), "utf8")) as LabState)));
  const active = states.filter((state) => !state.destroyedAt).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (!active.length) throw new Error("No active lab run. Start with `bun run lab:hcloud up`.");
  if (active.length > 1) throw new Error("Several active runs exist; choose one with --run-id.");
  return active[0]!;
}

function makeRunId(): string {
  const time = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "z").toLowerCase();
  return `${time}-${crypto.randomUUID().slice(0, 6)}`;
}

export function tailscaleAuthKeyFromEnvironment(
  environment: Record<string, string | undefined> = process.env,
): string | undefined {
  const authKey = environment[TAILSCALE_AUTH_KEY_ENV];
  if (authKey === undefined) return undefined;
  if (!authKey || /\s/.test(authKey)) {
    throw new Error(`${TAILSCALE_AUTH_KEY_ENV} must contain exactly one non-whitespace auth key`);
  }
  return authKey;
}

export function labChildEnvironment(
  environment: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
  const childEnvironment = { ...environment };
  delete childEnvironment[TAILSCALE_AUTH_KEY_ENV];
  return childEnvironment;
}

async function pinnedBunVersion(): Promise<string> {
  return (await readFile(join(ROOT, ".bun-version"), "utf8")).trim();
}

async function preflight(options: Options): Promise<void> {
  const tailscaleAuthKey = tailscaleAuthKeyFromEnvironment();
  const checks = await Promise.all([
    command(["hcloud", "version"], { quiet: true }),
    command(["ssh", "-V"], { allowFailure: true, quiet: true }),
    command(["git", "rev-parse", "HEAD"], { quiet: true }),
    command(["git", "status", "--porcelain"], { quiet: true }),
  ]);
  if (checks[1]!.exitCode !== 0) throw new Error("OpenSSH is required");
  if (!options.allowDirty && checks[3]!.stdout.trim()) {
    throw new Error("The worktree is dirty. Commit the intended lab revision or pass --allow-dirty for preflight only.");
  }
  const key = await stat(options.sshPrivateKey).catch(() => null);
  if (!key?.isFile()) throw new Error(`SSH private key not found: ${options.sshPrivateKey}`);
  await Promise.all([
    hcloudJSON(options, ["ssh-key", "describe", options.sshKeyName]),
    hcloudJSON(options, ["server-type", "describe", options.serverType]),
    hcloudJSON(options, ["image", "describe", options.image]),
    hcloudJSON(options, ["location", "describe", options.location]),
  ]);
  const tailscaleMode = tailscaleAuthKey ? "automatic Tailscale authentication enabled" : "interactive Tailscale authentication";
  console.log(`Preflight passed: ${options.context}, ${options.serverType}/${options.image}/${options.location}, Bun ${await pinnedBunVersion()}, ${tailscaleMode}.`);
}

function serverObject(value: unknown): Record<string, unknown> {
  const record = value as Record<string, unknown>;
  return (record.server as Record<string, unknown> | undefined) ?? record;
}

function nodeFromServer(role: Role, value: unknown): LabNode {
  const server = serverObject(value);
  const publicNet = server.public_net as { ipv4?: { ip?: string } } | undefined;
  if (typeof server.id !== "number" || typeof server.name !== "string" || !publicNet?.ipv4?.ip) {
    throw new Error(`Unexpected hcloud server response for ${role}`);
  }
  return { role, id: server.id, name: server.name, ipv4: publicNet.ipv4.ip };
}

async function createState(options: Options): Promise<LabState> {
  await preflight(options);
  const revision = (await command(["git", "rev-parse", "HEAD"], { quiet: true })).stdout.trim();
  const state: LabState = {
    version: 1,
    runId: options.runId ?? makeRunId(),
    createdAt: new Date().toISOString(),
    revision,
    context: options.context,
    location: options.location,
    serverType: options.serverType,
    image: options.image,
    sshKeyName: options.sshKeyName,
    sshPrivateKey: options.sshPrivateKey,
    bunVersion: await pinnedBunVersion(),
    nodes: {},
    steps: {},
  };
  await saveState(state);
  return state;
}

async function up(options: Options): Promise<LabState> {
  let state: LabState;
  try {
    state = await loadState(options.runId);
  } catch (error) {
    if (options.runId && await stat(statePath(options.runId)).catch(() => null)) throw error;
    if (!(error instanceof Error) || !error.message.startsWith("No active lab run.")) throw error;
    state = await createState(options);
  }
  if (state.destroyedAt) throw new Error(`Lab run ${state.runId} was already destroyed`);
  for (const role of ROLES) {
    if (state.nodes[role]) continue;
    const name = `story-${role}`;
    const existing = await command(hcloudArgs(state, ["server", "describe", name, "-o", "json"]), {
      allowFailure: true,
      quiet: true,
    });
    if (existing.exitCode === 0) {
      throw new Error(`Refusing to adopt existing server ${name}; remove it or resume its recorded run.`);
    }
    console.log(`Creating ${name}…`);
    const created = await hcloudJSON<unknown>(state, [
      "server", "create",
      "--name", name,
      "--type", state.serverType,
      "--image", state.image,
      "--location", state.location,
      "--ssh-key", state.sshKeyName,
      "--label", "purpose=story-sync-lab",
      "--label", `overstory-run=${state.runId}`,
    ]);
    state.nodes[role] = nodeFromServer(role, created);
    await saveState(state);
  }
  state.steps.up = new Date().toISOString();
  await saveState(state);
  return state;
}

function sshBase(state: LabState, node: LabNode): string[] {
  return [
    "ssh", "-i", state.sshPrivateKey,
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", `UserKnownHostsFile=${knownHostsPath(state.runId)}`,
    `root@${node.ipv4}`,
  ];
}

async function ssh(
  state: LabState,
  role: Role,
  remote: string[],
  options: { stdin?: string; allowFailure?: boolean; quiet?: boolean; timeoutMs?: number } = {},
): Promise<CommandResult> {
  const node = state.nodes[role];
  if (!node) throw new Error(`Missing node ${role}`);
  return command([...sshBase(state, node), ...remote], options);
}

async function sshBash(
  state: LabState,
  role: Role,
  script: string,
  options: { allowFailure?: boolean; quiet?: boolean; timeoutMs?: number } = {},
): Promise<CommandResult> {
  return ssh(state, role, ["bash", "-s", "--"], { ...options, stdin: `set -euo pipefail\n${script}\n` });
}

async function waitForSSH(state: LabState, role: Role): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const result = await ssh(state, role, ["true"], { allowFailure: true, quiet: true, timeoutMs: 15_000 });
    if (result.exitCode === 0) return;
    await Bun.sleep(2_000);
  }
  throw new Error(`SSH did not become ready on story-${role}`);
}

async function deployRevision(state: LabState, role: Role): Promise<void> {
  const release = `/opt/story-releases/${state.revision}`;
  const marker = await ssh(state, role, ["test", "-f", `${release}/.story-revision`], { allowFailure: true, quiet: true });
  if (marker.exitCode !== 0) {
    await sshBash(state, role, `rm -rf '${release}'\ninstall -d -m 0755 '${release}'`);
    const archive = Bun.spawn(["git", "archive", "--format=tar", state.revision], {
      cwd: ROOT,
      env: labChildEnvironment(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const node = state.nodes[role]!;
    const extract = Bun.spawn([...sshBase(state, node), "tar", "-x", "-C", release], {
      cwd: ROOT,
      env: labChildEnvironment(),
      stdin: archive.stdout,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [archiveExit, extractExit, archiveError, extractError] = await Promise.all([
      archive.exited,
      extract.exited,
      new Response(archive.stderr).text(),
      new Response(extract.stderr).text(),
    ]);
    if (archiveExit !== 0 || extractExit !== 0) throw new Error(`Revision upload failed: ${archiveError || extractError}`);
    await sshBash(state, role, `printf '%s\\n' '${state.revision}' > '${release}/.story-revision'`);
  }
  await sshBash(state, role, [
    `ln -sfn '${release}' /opt/story-current`,
    "cd /opt/story-current",
    "bun install --frozen-lockfile",
  ].join("\n"), { timeoutMs: 600_000 });
}

async function provision(state: LabState): Promise<void> {
  const bootstrap = await readFile(join(ROOT, "packages/overstoryd/deploy/hcloud-sync-lab/bootstrap-ubuntu.sh"), "utf8");
  for (const role of ROLES) {
    await waitForSSH(state, role);
    console.log(`Provisioning story-${role}…`);
    await ssh(state, role, ["bash", "-s", "--", `story-${role}`, state.bunVersion], {
      stdin: bootstrap,
      timeoutMs: 600_000,
    });
    await deployRevision(state, role);
  }
  state.steps.provisioned = new Date().toISOString();
  await saveState(state);
}

async function tailscaleReady(state: LabState): Promise<boolean> {
  if (state.steps.tailscale) {
    for (let attempt = 0; attempt < 18; attempt += 1) {
      const statuses = await Promise.all(ROLES.map(async (role) => {
        const result = await ssh(state, role, ["tailscale", "status", "--json"], { allowFailure: true, quiet: true });
        if (result.exitCode !== 0) return {};
        return JSON.parse(result.stdout) as { BackendState?: string; Self?: { Online?: boolean } };
      }));
      if (statuses.every((value) => value.BackendState === "Running" && value.Self?.Online)) return true;
      if (statuses.some((value) => value.BackendState === "NeedsLogin")) break;
      await Bun.sleep(5_000);
    }
  }

  const authKey = tailscaleAuthKeyFromEnvironment();
  let ready = true;
  for (const role of ROLES) {
    const status = await ssh(state, role, ["tailscale", "status", "--json"], { allowFailure: true, quiet: true });
    const value = status.exitCode === 0 ? JSON.parse(status.stdout) as { BackendState?: string; Self?: { Online?: boolean } } : {};
    if (value.BackendState === "Running" && value.Self?.Online) continue;
    if (authKey) {
      const login = await ssh(state, role, [
        "tailscale", "up", "--auth-key=file:/dev/stdin", `--hostname=story-${role}`,
      ], {
        stdin: `${authKey}\n`,
        allowFailure: true,
        quiet: true,
        timeoutMs: 30_000,
      });
      if (login.exitCode !== 0) {
        throw new Error(
          `Automatic Tailscale authentication failed for story-${role}. Verify ${TAILSCALE_AUTH_KEY_ENV}, or unset it to use interactive approval.`,
        );
      }
      let authenticatedValue: { BackendState?: string; Self?: { Online?: boolean } } = {};
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const authenticated = await ssh(state, role, ["tailscale", "status", "--json"], {
          allowFailure: true,
          quiet: true,
        });
        authenticatedValue = authenticated.exitCode === 0
          ? JSON.parse(authenticated.stdout) as typeof authenticatedValue
          : {};
        if (authenticatedValue.BackendState === "Running" && authenticatedValue.Self?.Online) break;
        await Bun.sleep(1_000);
      }
      if (authenticatedValue.BackendState !== "Running" || !authenticatedValue.Self?.Online) {
        throw new Error(`story-${role} did not become ready after automatic Tailscale authentication`);
      }
      continue;
    }
    ready = false;
    const node = state.nodes[role]!;
    const login = await ssh(state, role, ["timeout", "10s", "tailscale", "up", `--hostname=story-${role}`], {
      allowFailure: true,
      quiet: true,
      timeoutMs: 15_000,
    });
    const prompt = `${login.stdout}\n${login.stderr}`.trim();
    if (prompt) console.log(`Tailscale login for story-${role}:\n${prompt}`);
    else console.log(`Authenticate story-${role}: ssh -i ${state.sshPrivateKey} root@${node.ipv4} tailscale up --hostname=story-${role}`);
  }
  if (ready) {
    state.steps.tailscale = new Date().toISOString();
    await saveState(state);
  }
  return ready;
}

async function tailscaleIPv4(state: LabState, role: Role): Promise<string> {
  const status = await ssh(state, role, ["tailscale", "status", "--json"], { quiet: true });
  const value = JSON.parse(status.stdout) as { Self?: { TailscaleIPs?: string[] } };
  const address = value.Self?.TailscaleIPs?.find((candidate) => /^\d+\.\d+\.\d+\.\d+$/.test(candidate));
  if (!address) throw new Error(`Tailscale IPv4 address is unavailable for story-${role}`);
  return address;
}

const CLIENT_PATHS: Record<Exclude<Role, "community">, string> = {
  alice: "/home/story/lab",
  bob: "/srv/story/lab",
  carol: "/mnt/story/lab",
};

async function configure(state: LabState): Promise<void> {
  const communityIP = await tailscaleIPv4(state, "community");
  for (const role of ["alice", "bob", "carol"] as const) {
    await sshBash(state, role, [
      "sed -i '/[[:space:]]story-community$/d' /etc/hosts",
      `printf '%s\\n' '${communityIP} story-community' >> /etc/hosts`,
    ].join("\n"));
    await ssh(state, role, ["ping", "-c", "1", "-W", "5", communityIP], { timeoutMs: 10_000 });
  }
  await ssh(state, "community", ["bash", "/opt/story-current/packages/overstoryd/deploy/hcloud-sync-lab/configure-node.sh", "community"]);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const health = await ssh(state, "community", ["curl", "-fsS", "http://127.0.0.1:4318/.overstory/health"], {
      allowFailure: true,
      quiet: true,
    });
    if (health.exitCode === 0) break;
    if (attempt === 29) throw new Error("Canopy health did not become ready");
    await Bun.sleep(1_000);
  }
  const owner = await ownerDevice(state);
  for (const role of ["alice", "bob", "carol"] as const) {
    // Each client pairs as its own administrator device of the owner account;
    // the owner's device only offers the pairing and is not kept there.
    await ssh(state, role, [
      "bash", "/opt/story-current/packages/overstoryd/deploy/hcloud-sync-lab/configure-node.sh", role, CLIENT_PATHS[role],
    ], {
      stdin: `${JSON.stringify({ owner, label: `Hetzner lab ${role}`, administrator: true })}\n`,
      timeoutMs: 120_000,
    });
  }
  state.steps.configured = new Date().toISOString();
  await saveState(state);
}

function clientCommand(body: string): string {
  return `sudo -u story -H env STORY_HOME=/home/story/.overstory ${body}`;
}

/** The owner account's first key device, which `configure-node.sh` made on the community machine. */
async function ownerDevice(state: LabState): Promise<LabDevice> {
  const result = await ssh(state, "community", ["cat", OWNER_DEVICE_PATH], { quiet: true });
  const device = JSON.parse(result.stdout) as LabDevice;
  if (!device?.profileTree || !device.device || !device.seed) throw new Error("The owner's device is unavailable");
  return device;
}

/** Run one mode of a checked-in lab script on a node, passing its input on standard input. */
async function nodeScript<T>(
  state: LabState,
  role: Role,
  script: "authorization-node.ts" | "lab-node.ts",
  mode: string,
  input: unknown,
): Promise<T> {
  const result = await ssh(state, role, [
    "/usr/local/bin/bun",
    `/opt/story-current/packages/overstoryd/deploy/hcloud-sync-lab/${script}`,
    mode,
  ], {
    stdin: `${JSON.stringify(input)}\n`,
    quiet: true,
    timeoutMs: 120_000,
  });
  try {
    return JSON.parse(result.stdout.trim()) as T;
  } catch {
    throw new Error(`story-${role} returned invalid ${script} ${mode} output`);
  }
}

function authorizationNode<T>(state: LabState, role: Role, mode: string, input: unknown): Promise<T> {
  return nodeScript<T>(state, role, "authorization-node.ts", mode, input);
}

const PLACE = "/usr/local/libexec/story-headless-session /usr/local/bin/bun /opt/story-current/packages/cli/src/index.ts place";

/**
 * Create a tree from Alice's folder at `/~owner/<scenario>` and place it on Bob
 * and Carol. `story place` edits the account through the running Story Sync,
 * so every client service stays up. `files` are shell lines that write into
 * `$folder`.
 */
async function placeScenario(state: LabState, scenario: string, files: string[]): Promise<void> {
  const alicePath = `${CLIENT_PATHS.alice}/${scenario}`;
  const canonical = `http://story-community:4318/~owner/${scenario}`;
  await sshBash(state, "alice", [
    `folder='${alicePath}'`,
    "install -d -o story -g story -m 0700 \"$folder\"",
    ...files,
    "chown -R story:story \"$folder\"",
  ].join("\n"));
  await sshBash(state, "alice", clientCommand(`${PLACE} '${alicePath}' '${canonical}'`), { timeoutMs: 180_000 });
  for (const role of ["bob", "carol"] as const) {
    await sshBash(state, role, clientCommand(`${PLACE} '${canonical}' '${CLIENT_PATHS[role]}/${scenario}'`), { timeoutMs: 180_000 });
  }
}

async function manifest(state: LabState, role: Exclude<Role, "community">, scenario: string): Promise<string> {
  const path = `${CLIENT_PATHS[role]}/${scenario}`;
  return (await sshBash(state, role, `cd '${path}'\nfind . -type f -print0 | sort -z | xargs -0 sha256sum`, { quiet: true })).stdout;
}

async function waitUntil(label: string, check: () => Promise<boolean>, timeoutMs = 120_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check().catch(() => false)) return;
    await Bun.sleep(2_000);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function setClients(
  state: LabState,
  action: "start" | "stop" | "restart",
  roles: readonly Exclude<Role, "community">[] = ["alice", "bob", "carol"],
): Promise<void> {
  await Promise.all(roles.map((role) => ssh(state, role, ["systemctl", action, "story-client.service"], { quiet: true })));
}

async function waitForConvergence(
  state: LabState,
  scenario: string,
  markers: string[] = [],
): Promise<void> {
  await waitUntil(`${scenario} convergence`, async () => {
    const manifests = await Promise.all((['alice', 'bob', 'carol'] as const).map((role) => manifest(state, role, scenario)));
    if (!manifests.every((value) => value === manifests[0])) return false;
    if (!markers.length) return true;
    const sources = await Promise.all((['alice', 'bob', 'carol'] as const).map((role) =>
      ssh(state, role, ["cat", `${CLIENT_PATHS[role]}/${scenario}/note.md`], { quiet: true })
    ));
    return sources.every(({ stdout }) => markers.every((marker) => stdout.includes(marker)));
  });
}

async function createScenario(state: LabState, scenario: string, binary = "common-binary"): Promise<string> {
  await placeScenario(state, scenario, [
    `printf '# ${scenario}\\n\\ncommon\\n' > "$folder/note.md"`,
    `printf '${binary}' > "$folder/sample.bin"`,
  ]);
  await waitForConvergence(state, scenario);
  const found = await sshBash(state, "alice", [
    "for attempt in $(seq 1 30); do",
    `  tree=$(curl -fsS 'http://127.0.0.1:4317/v1/trees' | jq -r --arg path '${CLIENT_PATHS.alice}/${scenario}' '.snapshot[] | select(.osPath == $path) | .id' | head -n1)`,
    "  if [[ $tree == tr_* ]]; then printf '%s' \"$tree\"; exit 0; fi",
    "  sleep 1",
    "done",
    "exit 1",
  ].join("\n"), { quiet: true });
  const tree = found.stdout.trim();
  if (!/^tr_[a-z2-7]+$/.test(tree)) throw new Error(`Could not resolve TreeID for ${scenario}`);
  return tree;
}

async function authorityHistoryCount(state: LabState, tree: string): Promise<number> {
  const result = await sshBash(state, "community", [
    `sqlite3 /var/lib/overstoryd/overstoryd.sqlite3 "SELECT count(*) FROM accepted_updates WHERE tree_id = '${tree}';"`,
  ].join("\n"), { quiet: true });
  const count = Number(result.stdout.trim());
  if (!Number.isSafeInteger(count)) throw new Error(`Invalid update history count for ${tree}`);
  return count;
}

async function treeDescriptor(state: LabState, role: Exclude<Role, "community">, tree: string): Promise<{ sync?: string; conflicted?: boolean } | undefined> {
  const response = await sshBash(state, role,
    "curl -fsS 'http://127.0.0.1:4317/v1/trees'",
    { allowFailure: true, quiet: true });
  if (response.exitCode !== 0) return undefined;
  try {
    const body = JSON.parse(response.stdout) as { snapshot?: Array<{ id?: string; sync?: string; conflicted?: boolean }> };
    return body.snapshot?.find((descriptor) => descriptor.id === tree);
  } catch {
    return undefined;
  }
}

/** The host refused this client's changes; they are held until discarded. */
async function hasConflict(state: LabState, role: Exclude<Role, "community">, tree: string): Promise<boolean> {
  return (await treeDescriptor(state, role, tree))?.sync === "conflict";
}

/** The client is current on an accepted state that retains unresolved alternatives. */
async function acceptedConflicted(state: LabState, role: Exclude<Role, "community">, tree: string): Promise<boolean> {
  const descriptor = await treeDescriptor(state, role, tree);
  return descriptor?.sync === "idle" && descriptor.conflicted === true;
}

async function smoke(state: LabState): Promise<void> {
  if (!state.steps.configured) throw new Error("Run or resume the lab before testing");
  const scenario = `smoke-${state.runId.replace(/[^a-z0-9-]/g, "-").slice(-20)}`;
  await placeScenario(state, scenario, [
    `printf '# ${scenario}\\n\\nprivate authenticated placement\\n' > "$folder/note.md"`,
    "head -c 128 /dev/urandom > \"$folder/sample.bin\"",
  ]);
  let manifests: string[] = [];
  for (let attempt = 0; attempt < 45; attempt += 1) {
    manifests = await Promise.all((["alice", "bob", "carol"] as const).map((role) => manifest(state, role, scenario)));
    if (manifests.every((value) => value === manifests[0])) break;
    await Bun.sleep(2_000);
  }
  if (!manifests.length || !manifests.every((value) => value === manifests[0])) {
    throw new Error(`Smoke synchronization did not converge for ${scenario}`);
  }
  const health = await ssh(state, "community", ["curl", "-fsS", "http://127.0.0.1:4318/.overstory/health"], { quiet: true });
  if (!health.stdout.includes('"ok"')) throw new Error(`Canopy health failed: ${health.stdout}`);
  state.steps.smoke = new Date().toISOString();
  await saveState(state);
  console.log(`Smoke synchronization passed: ${scenario}`);
}

async function acceptance(state: LabState): Promise<void> {
  if (!state.steps.configured) throw new Error("Run or resume the lab before testing");
  if (state.steps.acceptance && state.acceptance) {
    console.log(`Accepted-update acceptance already passed for ${state.runId}`);
    return;
  }
  await smoke(state);
  const suffix = `${state.runId.replace(/[^a-z0-9-]/g, "-").slice(-16)}-${Date.now().toString(36)}`;

  const additive = `accepted-additive-${suffix}`;
  const additiveTree = await createScenario(state, additive);
  const serialMarkers: string[] = [];
  for (const role of ["alice", "bob", "carol"] as const) {
    const marker = `${additive} serial ${role}`;
    serialMarkers.push(marker);
    await sshBash(state, role, `printf '\\n${marker}\\n' >> '${CLIENT_PATHS[role]}/${additive}/note.md'`);
    await waitForConvergence(state, additive, serialMarkers);
  }

  await setClients(state, "stop");
  const offlineMarkers = (["alice", "bob", "carol"] as const).map((role) => `${additive} offline ${role}`);
  for (const [index, role] of (["alice", "bob", "carol"] as const).entries()) {
    await sshBash(state, role, `printf '\\n${offlineMarkers[index]}\\n' >> '${CLIENT_PATHS[role]}/${additive}/note.md'`);
  }
  await ssh(state, "alice", ["systemctl", "start", "story-client.service"]);
  await Bun.sleep(4_000);
  await ssh(state, "bob", ["systemctl", "start", "story-client.service"]);
  await Bun.sleep(4_000);
  await ssh(state, "carol", ["systemctl", "start", "story-client.service"]);
  await waitForConvergence(state, additive, [...serialMarkers, ...offlineMarkers]);
  const additiveStates = await Promise.all((["alice", "bob", "carol"] as const).map((role) => treeDescriptor(state, role, additiveTree)));
  if (additiveStates.some((descriptor) => descriptor?.sync === "conflict" || descriptor?.conflicted)) {
    throw new Error("Additive Markdown divergence produced a held refusal or an unresolved alternative");
  }

  const replayScenario = `accepted-replay-${suffix}`;
  const owner = await ownerDevice(state);
  const replayResult = await nodeScript<{ tree: string; historical: string; current: string }>(
    state, "community", "lab-node.ts", "replay", { owner },
  );
  const replayTree = replayResult.tree;
  if (!/^tr_[a-z2-7]+$/.test(replayTree)) throw new Error("Exact replay scenario did not return a TreeID");
  if (await authorityHistoryCount(state, replayTree) !== 2) {
    throw new Error("Semantic replay duplicated internal accepted history");
  }
  const privateSurface = await sshBash(state, "community", [
    OWNER_SESSION,
    `history_status=$(curl -sS -o /dev/null -w '%{http_code}' -H \"Authorization: Bearer $session\" 'http://127.0.0.1:4318/.overstory/trees/${replayTree}/updates')`,
    `object_status=$(curl -sS -o /dev/null -w '%{http_code}' -H \"Authorization: Bearer $session\" 'http://127.0.0.1:4318/.overstory/trees/${replayTree}/objects/${replayResult.historical}')`,
    `snapshot_status=$(curl -sS -o /dev/null -w '%{http_code}' -H \"Authorization: Bearer $session\" 'http://127.0.0.1:4318/.overstory/trees/${replayTree}/snapshots/${replayResult.historical}')`,
    "printf '%s %s %s' \"$history_status\" \"$object_status\" \"$snapshot_status\"",
  ].join("\n"), { quiet: true });
  // No route lists accepted history; an earlier accepted root stays readable
  // as an immutable snapshot, and its objects by hash through the tree.
  if (privateSurface.stdout.trim() !== "405 200 200") {
    throw new Error(`Accepted-history, object, or immutable snapshot surface disagreed: ${privateSurface.stdout.trim()}`);
  }

  const conflictScenario = `accepted-conflict-${suffix}`;
  const conflictTree = await createScenario(state, conflictScenario);
  const before = await authorityHistoryCount(state, conflictTree);
  await setClients(state, "stop");
  await sshBash(state, "alice", `printf 'binary-from-alice' > '${CLIENT_PATHS.alice}/${conflictScenario}/sample.bin'`);
  await sshBash(state, "bob", `printf 'binary-from-bob' > '${CLIENT_PATHS.bob}/${conflictScenario}/sample.bin'`);
  await ssh(state, "alice", ["systemctl", "start", "story-client.service"]);
  await waitUntil("Alice binary update acceptance", async () => await authorityHistoryCount(state, conflictTree) === before + 1);
  // Canopy accepts Bob's divergent bytes as an unresolved alternative; nothing is held.
  await ssh(state, "bob", ["systemctl", "start", "story-client.service"]);
  await waitUntil("Bob accepted binary alternative", async () => await authorityHistoryCount(state, conflictTree) === before + 2
    && await acceptedConflicted(state, "bob", conflictTree));
  await setClients(state, "restart", ["bob"] as const);
  await waitUntil("Bob accepted alternative after restart", () => acceptedConflicted(state, "bob", conflictTree));
  if (await hasConflict(state, "bob", conflictTree)) throw new Error("An accepted binary alternative was held as a refusal");
  const selected = await ssh(state, "bob", ["cat", `${CLIENT_PATHS.bob}/${conflictScenario}/sample.bin`], { quiet: true });
  if (selected.stdout !== "binary-from-alice") throw new Error(`Bob does not hold the accepted selection: ${selected.stdout}`);
  // Resolve explicitly through Canopy: a new update keeps Bob's alternative.
  await nodeScript(state, "community", "lab-node.ts", "resolve-binary", {
    owner, tree: conflictTree, path: "sample.bin", keep: "binary-from-bob",
  });
  if (await authorityHistoryCount(state, conflictTree) !== before + 3) {
    throw new Error("The explicit resolution did not add exactly one accepted update");
  }
  await setClients(state, "start", ["alice", "carol"] as const);
  await waitForConvergence(state, conflictScenario);
  for (const role of ["alice", "bob", "carol"] as const) {
    const value = await ssh(state, role, ["cat", `${CLIENT_PATHS[role]}/${conflictScenario}/sample.bin`], { quiet: true });
    if (value.stdout !== "binary-from-bob") throw new Error(`${role} did not materialize the explicit resolution`);
    if ((await treeDescriptor(state, role, conflictTree))?.conflicted) throw new Error(`${role} still shows the resolved alternative`);
  }

  await sshBash(state, "community", [
    OWNER_SESSION,
    "test \"$(curl -sS -o /dev/null -w '%{http_code}' -X POST -H \"Authorization: Bearer $session\" http://127.0.0.1:4318/.overstory/trees/ignored/push)\" = 404",
  ].join("\n"), { quiet: true });
  // Revocation is an administrator's edit of devices.yaml in the profile's configuration.
  await nodeScript(state, "community", "lab-node.ts", "device-revocation", { owner, tree: conflictTree });

  state.steps.acceptance = new Date().toISOString();
  state.acceptance = {
    additive: { scenario: additive, tree: additiveTree },
    conflict: { scenario: conflictScenario, tree: conflictTree },
    replay: { scenario: replayScenario, tree: replayTree },
  };
  await saveState(state);
  console.log(`Accepted-update acceptance passed: ${additiveTree}, ${conflictTree}, ${replayTree}`);
}

interface AuthorizationIdentity {
  handle: string;
  locator: string;
  profile: string;
  device: LabDevice;
}

async function authorization(state: LabState): Promise<void> {
  if (!state.steps.configured) throw new Error("Run or resume the lab before testing");
  if (state.steps.authorization && state.authorization) {
    console.log(`Authorization acceptance already passed for ${state.runId}`);
    return;
  }

  const suffix = `${state.runId.replace(/[^a-z0-9]/g, "").slice(-8)}${Date.now().toString(36).slice(-5)}`;
  const scenario = `authorization-${suffix}`;
  const handles = {
    alice: `alice-${suffix}`,
    bob: `bob-${suffix}`,
    carol: `carol-${suffix}`,
  };
  const owner = await ownerDevice(state);
  const identities = await authorizationNode<Record<"alice" | "bob" | "carol", AuthorizationIdentity>>(
    state,
    "community",
    "setup",
    { owner, handles },
  );
  for (const role of ["alice", "bob", "carol"] as const) {
    const identity = identities[role];
    if (!identity?.device?.seed || !/^tr_[a-z2-7]+$/.test(identity.profile) || identity.handle !== handles[role]) {
      throw new Error(`Invalid ${role} authorization identity`);
    }
  }

  const aliceCreate = await authorizationNode<{
    tree: string;
    root: string;
    update: string;
    canonical: string;
  }>(state, "alice", "create", {
    device: identities.alice.device,
    bob: identities.bob.profile,
    carol: identities.carol.profile,
    scenario,
  });
  if (!/^tr_[a-z2-7]+$/.test(aliceCreate.tree) || !aliceCreate.update) {
    throw new Error("Alice did not create the authorization tree");
  }

  const historyBefore = await authorityHistoryCount(state, aliceCreate.tree);
  if (historyBefore !== 1) throw new Error(`Authorization tree began with ${historyBefore} accepted updates`);
  const bobDenied = await authorizationNode<{ candidate: string }>(state, "bob", "deny-write", {
    device: identities.bob.device,
    tree: aliceCreate.tree,
    scenario,
  });
  if (await authorityHistoryCount(state, aliceCreate.tree) !== historyBefore) {
    throw new Error("Bob's denied write changed accepted history");
  }

  const carolWrite = await authorizationNode<{ root: string; update: string }>(state, "carol", "write", {
    device: identities.carol.device,
    tree: aliceCreate.tree,
    scenario,
  });
  if (await authorityHistoryCount(state, aliceCreate.tree) !== historyBefore + 1) {
    throw new Error("Carol's permitted write did not create exactly one accepted update");
  }

  await authorizationNode<{ ok: true }>(state, "bob", "verify-reader", {
    device: identities.bob.device,
    tree: aliceCreate.tree,
    scenario,
    ...carolWrite,
  });

  await authorizationNode<{ ok: true }>(state, "alice", "verify-writer", {
    device: identities.alice.device,
    tree: aliceCreate.tree,
    scenario,
    rejected: bobDenied.candidate,
    ...carolWrite,
  });

  await authorizationNode<{ ok: true }>(state, "community", "verify-owner", {
    device: owner,
    tree: aliceCreate.tree,
    root: carolWrite.root,
    canonical: aliceCreate.canonical,
  });

  state.steps.authorization = new Date().toISOString();
  state.authorization = { scenario, tree: aliceCreate.tree };
  await saveState(state);
  console.log(`Multi-user authorization acceptance passed: ${aliceCreate.tree}`);
}

async function status(state: LabState): Promise<void> {
  console.log(JSON.stringify({ runId: state.runId, revision: state.revision, steps: state.steps, destroyedAt: state.destroyedAt }, null, 2));
  for (const role of ROLES) {
    const node = state.nodes[role];
    if (!node) continue;
    const live = await command(hcloudArgs(state, ["server", "describe", String(node.id), "-o", "json"]), {
      allowFailure: true,
      quiet: true,
    });
    if (live.exitCode !== 0) console.log(`${node.name}: missing (recorded ID ${node.id})`);
    else console.log(`${node.name}: ${(serverObject(JSON.parse(live.stdout)).status as string) ?? "unknown"} ${node.ipv4} (ID ${node.id})`);
  }
}

async function download(state: LabState, role: Role, remote: string, local: string): Promise<void> {
  const node = state.nodes[role]!;
  await command([
    "scp", "-i", state.sshPrivateKey,
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", `UserKnownHostsFile=${knownHostsPath(state.runId)}`,
    `root@${node.ipv4}:${remote}`, local,
  ]);
}

async function collect(state: LabState): Promise<string> {
  const destination = join(ROOT, "test-results", `hcloud-sync-lab-${state.runId}`);
  await mkdir(destination, { recursive: true });
  for (const role of ROLES) {
    const service = role === "community" ? "overstoryd.service" : "story-client.service";
    const report = await sshBash(state, role, [
      "hostname",
      "printf 'revision: '; cat /opt/story-current/.story-revision",
      "printf 'bun: '; bun --version",
      "tailscale status",
      `systemctl status '${service}' --no-pager || true`,
      `journalctl -u '${service}' --no-pager -n 1000 || true`,
      ...(role === "community" ? [] : [
        `find '${CLIENT_PATHS[role]}' -mindepth 2 -type f -print0 | sort -z | xargs -0 sha256sum || true`,
        "curl -fsS 'http://127.0.0.1:4317/v1/trees' || true",
      ]),
    ].join("\n"), { allowFailure: true, quiet: true, timeoutMs: 60_000 });
    await writeFile(join(destination, `${role}.log`), `${report.stdout}\n${report.stderr}`);
  }
  await sshBash(state, "community", [
    "sqlite3 /var/lib/overstoryd/overstoryd.sqlite3 \".backup '/tmp/overstoryd.sqlite3'\"",
    "tar -C /var/lib/overstoryd -czf /tmp/story-community-objects.tar.gz objects",
  ].join("\n"));
  await download(state, "community", "/tmp/overstoryd.sqlite3", join(destination, "overstoryd.sqlite3"));
  await download(state, "community", "/tmp/story-community-objects.tar.gz", join(destination, "objects.tar.gz"));
  state.steps.collected = new Date().toISOString();
  await saveState(state);
  await writeFile(join(destination, "state.json"), `${JSON.stringify(state, null, 2)}\n`);
  console.log(`Evidence collected in ${destination}`);
  return destination;
}

async function reset(state: LabState): Promise<void> {
  if (state.destroyedAt) throw new Error(`Lab run ${state.runId} was already destroyed`);
  if (!state.steps.provisioned || !state.steps.tailscale) {
    throw new Error("Reset requires a provisioned lab with authenticated Tailscale nodes");
  }

  // Validate the complete deletion scope before removing any data.
  for (const role of ROLES) {
    const node = state.nodes[role];
    if (!node) throw new Error(`Reset requires the recorded ${role} node`);
    const described = await command(hcloudArgs(state, ["server", "describe", String(node.id), "-o", "json"]), { quiet: true });
    const server = serverObject(JSON.parse(described.stdout));
    const labels = server.labels as Record<string, string> | undefined;
    if (server.name !== node.name || labels?.purpose !== "story-sync-lab" || labels?.["overstory-run"] !== state.runId) {
      throw new Error(`Refusing to reset server ID ${node.id}; its name or run labels no longer match recorded state.`);
    }
  }

  await ssh(state, "community", ["systemctl", "stop", "overstoryd.service"], { allowFailure: true });
  await sshBash(state, "community", "find /var/lib/overstoryd -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +");
  for (const role of ["alice", "bob", "carol"] as const) {
    await ssh(state, role, ["systemctl", "stop", "story-client.service"], { allowFailure: true });
    await sshBash(state, role, [
      `find '${CLIENT_PATHS[role]}' -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +`,
      "find /home/story/.overstory -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +",
      "rm -rf -- /tmp/story-replay",
    ].join("\n"));
  }

  delete state.steps.configured;
  delete state.steps.smoke;
  delete state.steps.acceptance;
  delete state.steps.authorization;
  delete state.steps.collected;
  delete state.acceptance;
  delete state.authorization;
  await saveState(state);
  await continueRun(state);
  console.log(`Lab ${state.runId} was reset without replacing its VMs, Tailscale identities, credentials, or deployed revision.`);
}

async function down(state: LabState, options: Options): Promise<void> {
  if (state.destroyedAt) {
    console.log(`Lab ${state.runId} is already down.`);
    return;
  }
  if (!options.skipCollect) {
    try { await collect(state); }
    catch (error) { console.warn(`Evidence collection failed; continuing exact-ID teardown: ${error}`); }
  }
  for (const role of ROLES) {
    const node = state.nodes[role];
    if (!node) continue;
    await ssh(state, role, ["tailscale", "logout"], { allowFailure: true, quiet: true, timeoutMs: 30_000 });
    const described = await command(hcloudArgs(state, ["server", "describe", String(node.id), "-o", "json"]), {
      allowFailure: true,
      quiet: true,
    });
    if (described.exitCode !== 0) continue;
    const server = serverObject(JSON.parse(described.stdout));
    const labels = server.labels as Record<string, string> | undefined;
    if (server.name !== node.name || labels?.purpose !== "story-sync-lab" || labels?.["overstory-run"] !== state.runId) {
      throw new Error(`Refusing to delete server ID ${node.id}; its name or run labels no longer match recorded state.`);
    }
    console.log(`Deleting ${node.name} (ID ${node.id})…`);
    await command(hcloudArgs(state, ["server", "delete", String(node.id)]));
  }
  state.destroyedAt = new Date().toISOString();
  await saveState(state);
  console.log(`Lab ${state.runId} is down. Tailscale logout was requested on every reachable node.`);
}

async function continueRun(state: LabState): Promise<void> {
  if (!state.steps.provisioned) await provision(state);
  if (!await tailscaleReady(state)) {
    throw new Error(
      `Tailscale authentication is still required. Approve the printed URLs and use \`bun run lab:hcloud resume\`, or set ${TAILSCALE_AUTH_KEY_ENV} and resume without browser approval.`,
    );
  }
  if (!state.steps.configured) await configure(state);
  console.log(`Lab ${state.runId} is ready. Run \`bun run lab:hcloud test\` or follow packages/overstoryd/deploy/hcloud-sync-lab.md.`);
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  if (options.command === "help" || options.command === "--help" || options.command === "-h") usage(0);
  if (options.command === "preflight") return preflight(options);
  if (options.command === "up") { await up(options); return; }
  if (options.command === "run") return continueRun(await up(options));
  const state = await loadState(options.runId);
  if (options.command === "provision") return provision(state);
  if (options.command === "resume") return continueRun(state);
  if (options.command === "smoke") return smoke(state);
  if (options.command === "test") return acceptance(state);
  if (options.command === "test:authorization") return authorization(state);
  if (options.command === "status") return status(state);
  if (options.command === "collect") { await collect(state); return; }
  if (options.command === "reset") return reset(state);
  if (options.command === "down") return down(state, options);
  usage();
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
