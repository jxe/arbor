#!/usr/bin/env bun
import { chmod, mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const STATE_ROOT = join(ROOT, ".arbor-lab");
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
  steps: Partial<Record<"up" | "provisioned" | "tailscale" | "configured" | "smoke" | "acceptance" | "collected", string>>;
  acceptance?: {
    additive: { scenario: string; tree: string };
    conflict: { scenario: string; tree: string };
    replay: { scenario: string; tree: string };
  };
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
  resume      Continue provisioning after interactive Tailscale authentication
  run         Run up, provision, Tailscale check, and configuration
  smoke       Run a quick private-tree three-client synchronization
  test        Run the complete accepted-update pre-rollout acceptance suite
  status      Show recorded phase and live server state
  collect     Download journals, authority backup, and immutable objects
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
    stdin: options.stdin === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (options.stdin !== undefined) {
    child.stdin.write(options.stdin);
    child.stdin.end();
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
      || node.name !== `arbor-${role}`
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

async function pinnedBunVersion(): Promise<string> {
  return (await readFile(join(ROOT, ".bun-version"), "utf8")).trim();
}

async function preflight(options: Options): Promise<void> {
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
  console.log(`Preflight passed: ${options.context}, ${options.serverType}/${options.image}/${options.location}, Bun ${await pinnedBunVersion()}.`);
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
    const name = `arbor-${role}`;
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
      "--label", "purpose=arbor-sync-lab",
      "--label", `arbor-run=${state.runId}`,
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
  throw new Error(`SSH did not become ready on arbor-${role}`);
}

async function deployRevision(state: LabState, role: Role): Promise<void> {
  const release = `/opt/arbor-releases/${state.revision}`;
  const marker = await ssh(state, role, ["test", "-f", `${release}/.arbor-revision`], { allowFailure: true, quiet: true });
  if (marker.exitCode !== 0) {
    await sshBash(state, role, `rm -rf '${release}'\ninstall -d -m 0755 '${release}'`);
    const archive = Bun.spawn(["git", "archive", "--format=tar", state.revision], {
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    const node = state.nodes[role]!;
    const extract = Bun.spawn([...sshBase(state, node), "tar", "-x", "-C", release], {
      cwd: ROOT,
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
    await sshBash(state, role, `printf '%s\\n' '${state.revision}' > '${release}/.arbor-revision'`);
  }
  await sshBash(state, role, [
    `ln -sfn '${release}' /opt/arbor-current`,
    "cd /opt/arbor-current",
    "bun install --frozen-lockfile",
    "bun run build:web",
  ].join("\n"), { timeoutMs: 600_000 });
}

async function provision(state: LabState): Promise<void> {
  const bootstrap = await readFile(join(ROOT, "deploy/hcloud-sync-lab/bootstrap-ubuntu.sh"), "utf8");
  for (const role of ROLES) {
    await waitForSSH(state, role);
    console.log(`Provisioning arbor-${role}…`);
    await ssh(state, role, ["bash", "-s", "--", `arbor-${role}`, state.bunVersion], {
      stdin: bootstrap,
      timeoutMs: 600_000,
    });
    await deployRevision(state, role);
  }
  state.steps.provisioned = new Date().toISOString();
  await saveState(state);
}

async function tailscaleReady(state: LabState): Promise<boolean> {
  let ready = true;
  for (const role of ROLES) {
    const status = await ssh(state, role, ["tailscale", "status", "--json"], { allowFailure: true, quiet: true });
    const value = status.exitCode === 0 ? JSON.parse(status.stdout) as { BackendState?: string; Self?: { Online?: boolean } } : {};
    if (value.BackendState === "Running" && value.Self?.Online) continue;
    ready = false;
    const node = state.nodes[role]!;
    const login = await ssh(state, role, ["timeout", "10s", "tailscale", "up", `--hostname=arbor-${role}`], {
      allowFailure: true,
      quiet: true,
      timeoutMs: 15_000,
    });
    const prompt = `${login.stdout}\n${login.stderr}`.trim();
    if (prompt) console.log(`Tailscale login for arbor-${role}:\n${prompt}`);
    else console.log(`Authenticate arbor-${role}: ssh -i ${state.sshPrivateKey} root@${node.ipv4} tailscale up --hostname=arbor-${role}`);
  }
  if (ready) {
    state.steps.tailscale = new Date().toISOString();
    await saveState(state);
  }
  return ready;
}

const CLIENT_PATHS: Record<Exclude<Role, "community">, string> = {
  alice: "/home/arbor/lab",
  bob: "/srv/arbor/lab",
  carol: "/mnt/arbor/lab",
};

async function configure(state: LabState): Promise<void> {
  for (const role of ["alice", "bob", "carol"] as const) {
    await ssh(state, role, ["tailscale", "ping", "-c", "1", "arbor-community"], { timeoutMs: 30_000 });
  }
  await ssh(state, "community", ["bash", "/opt/arbor-current/deploy/hcloud-sync-lab/configure-node.sh", "community"]);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const health = await ssh(state, "community", ["curl", "-fsS", "http://127.0.0.1:4318/.arbor/health"], {
      allowFailure: true,
      quiet: true,
    });
    if (health.exitCode === 0) break;
    if (attempt === 29) throw new Error("Authority health did not become ready");
    await Bun.sleep(1_000);
  }
  const tokenLine = await ssh(state, "community", ["sed", "-n", "s/^ARBOR_ACCOUNT_TOKEN=//p", "/etc/arbor-community.env"], { quiet: true });
  const token = tokenLine.stdout.trim();
  if (!token) throw new Error("Authority account token is unavailable");
  for (const role of ["alice", "bob", "carol"] as const) {
    await ssh(state, role, [
      "bash", "/opt/arbor-current/deploy/hcloud-sync-lab/configure-node.sh", role, CLIENT_PATHS[role],
    ], { stdin: `${token}\n`, timeoutMs: 120_000 });
  }
  state.steps.configured = new Date().toISOString();
  await saveState(state);
}

function clientCommand(body: string): string {
  return `sudo -u arbor -H env ARBOR_DATA_HOME=/home/arbor/.arbor ${body}`;
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

async function setClients(state: LabState, action: "start" | "stop" | "restart", roles = ["alice", "bob", "carol"] as const): Promise<void> {
  await Promise.all(roles.map((role) => ssh(state, role, ["systemctl", action, "arbor-client.service"], { quiet: true })));
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
  await setClients(state, "stop");
  try {
    const alicePath = `${CLIENT_PATHS.alice}/${scenario}`;
    await sshBash(state, "alice", [
      `install -d -o arbor -g arbor -m 0700 '${alicePath}'`,
      `printf '# ${scenario}\\n\\ncommon\\n' > '${alicePath}/note.md'`,
      `printf '${binary}' > '${alicePath}/sample.bin'`,
      `chown -R arbor:arbor '${alicePath}'`,
    ].join("\n"));
    const syncPrefix = "/usr/local/libexec/arbor-headless-session /usr/local/bin/bun /opt/arbor-current/packages/cli/src/index.ts sync";
    await sshBash(state, "alice", clientCommand(`${syncPrefix} '${alicePath}' 'http://arbor-community:4318/~owner/${scenario}'`));
    for (const role of ["bob", "carol"] as const) {
      const path = `${CLIENT_PATHS[role]}/${scenario}`;
      await ssh(state, role, ["install", "-d", "-o", "arbor", "-g", "arbor", "-m", "0700", path]);
      await sshBash(state, role, clientCommand(`${syncPrefix} 'http://arbor-community:4318/~owner/${scenario}' '${path}'`));
    }
  } finally {
    await setClients(state, "start");
  }
  await waitForConvergence(state, scenario);
  const found = await sshBash(state, "alice", [
    "for attempt in $(seq 1 30); do",
    `  tree=$(curl -fsS 'http://127.0.0.1:4317/v1/children?tree=system&path=%2Ftrees' | jq -r --arg name '${scenario}' '.items[] | select(.name == $name) | .path | split("/")[-1]' | head -n1)`,
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
    ". /etc/arbor-community.env",
    `curl -fsS -H \"Authorization: Bearer $ARBOR_ACCOUNT_TOKEN\" 'http://127.0.0.1:4318/.arbor/trees/${tree}/updates' | jq '.updates | length'`,
  ].join("\n"), { quiet: true });
  const count = Number(result.stdout.trim());
  if (!Number.isSafeInteger(count)) throw new Error(`Invalid update history count for ${tree}`);
  return count;
}

async function hasConflict(state: LabState, role: Exclude<Role, "community">, tree: string): Promise<boolean> {
  const response = await ssh(state, role, [
    "curl", "-fsS", `http://127.0.0.1:4317/v1/node?tree=system&path=%2Ftrees%2F${tree}`,
  ], { allowFailure: true, quiet: true });
  if (response.exitCode !== 0) return false;
  const body = JSON.parse(response.stdout) as { document?: { frontmatter?: Record<string, unknown> } };
  return body.document?.frontmatter?.sync === "conflict"
    && Array.isArray(body.document.frontmatter.conflicts);
}

async function smoke(state: LabState): Promise<void> {
  if (!state.steps.configured) throw new Error("Run or resume the lab before testing");
  const scenario = `smoke-${state.runId.replace(/[^a-z0-9-]/g, "-").slice(-20)}`;
  for (const role of ["alice", "bob", "carol"] as const) {
    await ssh(state, role, ["systemctl", "stop", "arbor-client.service"]);
  }
  try {
    const alicePath = `${CLIENT_PATHS.alice}/${scenario}`;
    await sshBash(state, "alice", [
      `install -d -o arbor -g arbor -m 0700 '${alicePath}'`,
      `printf '# ${scenario}\\n\\nprivate authenticated placement\\n' > '${alicePath}/note.md'`,
      `head -c 128 /dev/urandom > '${alicePath}/sample.bin'`,
      `chown -R arbor:arbor '${alicePath}'`,
    ].join("\n"));
    const syncPrefix = "/usr/local/libexec/arbor-headless-session /usr/local/bin/bun /opt/arbor-current/packages/cli/src/index.ts sync";
    await sshBash(state, "alice", clientCommand(`${syncPrefix} '${alicePath}' 'http://arbor-community:4318/~owner/${scenario}'`));
    for (const role of ["bob", "carol"] as const) {
      const path = `${CLIENT_PATHS[role]}/${scenario}`;
      await ssh(state, role, ["install", "-d", "-o", "arbor", "-g", "arbor", "-m", "0700", path]);
      await sshBash(state, role, clientCommand(`${syncPrefix} 'http://arbor-community:4318/~owner/${scenario}' '${path}'`));
    }
    for (const role of ["alice", "bob", "carol"] as const) {
      await ssh(state, role, ["systemctl", "start", "arbor-client.service"]);
    }
    let manifests: string[] = [];
    for (let attempt = 0; attempt < 45; attempt += 1) {
      manifests = await Promise.all((["alice", "bob", "carol"] as const).map((role) => manifest(state, role, scenario)));
      if (manifests.every((value) => value === manifests[0])) break;
      await Bun.sleep(2_000);
    }
    if (!manifests.length || !manifests.every((value) => value === manifests[0])) {
      throw new Error(`Smoke synchronization did not converge for ${scenario}`);
    }
    const health = await ssh(state, "community", ["curl", "-fsS", "http://127.0.0.1:4318/.arbor/health"], { quiet: true });
    if (!health.stdout.includes('"ok"')) throw new Error(`Authority health failed: ${health.stdout}`);
  } finally {
    for (const role of ["alice", "bob", "carol"] as const) {
      await ssh(state, role, ["systemctl", "start", "arbor-client.service"], { allowFailure: true, quiet: true });
    }
  }
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
  await ssh(state, "alice", ["systemctl", "start", "arbor-client.service"]);
  await Bun.sleep(4_000);
  await ssh(state, "bob", ["systemctl", "start", "arbor-client.service"]);
  await Bun.sleep(4_000);
  await ssh(state, "carol", ["systemctl", "start", "arbor-client.service"]);
  await waitForConvergence(state, additive, [...serialMarkers, ...offlineMarkers]);
  if (await Promise.all((['alice', 'bob', 'carol'] as const).map((role) => hasConflict(state, role, additiveTree))).then((values) => values.some(Boolean))) {
    throw new Error("Additive Markdown divergence produced a conflict");
  }

  const replayScenario = `accepted-replay-${suffix}`;
  const replay = await sshBash(state, "community", [
    ". /etc/arbor-community.env",
    "export ARBOR_LAB_TOKEN=$ARBOR_ACCOUNT_TOKEN",
    `export ARBOR_LAB_REPLAY=${replayScenario}`,
    "install -d -o arbor -g arbor -m 0700 /tmp/arbor-replay",
    "printf 'one\\n' > /tmp/arbor-replay/note.md",
    "chown -R arbor:arbor /tmp/arbor-replay",
    "sudo -u arbor -H env ARBOR_LAB_TOKEN=\"$ARBOR_LAB_TOKEN\" ARBOR_LAB_REPLAY=\"$ARBOR_LAB_REPLAY\" /usr/local/bin/bun - <<'JAVASCRIPT'",
    "import { WireClient, snapshotDirectory } from '/opt/arbor-current/packages/wire/src/index.ts';",
    "import { writeFile } from 'node:fs/promises';",
    "const client = new WireClient('http://127.0.0.1:4318', process.env.ARBOR_LAB_TOKEN);",
    "const initial = await snapshotDirectory('/tmp/arbor-replay');",
    "const tree = await client.create(`/~owner/${process.env.ARBOR_LAB_REPLAY}`, initial);",
    "await writeFile('/tmp/arbor-replay/note.md', 'two\\n');",
    "const next = await snapshotDirectory('/tmp/arbor-replay');",
    "const first = await client.submitUpdate(tree.id, 'accepted-replay', { root: tree.ref, update: tree.update }, next);",
    "const second = await client.submitUpdate(tree.id, 'accepted-replay', { root: tree.ref, update: tree.update }, next);",
    "const history = await client.updates(tree.id);",
    "if (JSON.stringify(first) !== JSON.stringify(second) || history.updates.length !== 2) throw new Error('Exact replay duplicated or changed accepted history');",
    "process.stdout.write(tree.id);",
    "JAVASCRIPT",
  ].join("\n"), { quiet: true });
  const replayTree = replay.stdout.trim();
  if (!/^tr_[a-z2-7]+$/.test(replayTree)) throw new Error("Exact replay scenario did not return a TreeID");

  const conflictScenario = `accepted-conflict-${suffix}`;
  const conflictTree = await createScenario(state, conflictScenario);
  const before = await authorityHistoryCount(state, conflictTree);
  await setClients(state, "stop");
  await sshBash(state, "alice", `printf 'binary-from-alice' > '${CLIENT_PATHS.alice}/${conflictScenario}/sample.bin'`);
  await sshBash(state, "bob", `printf 'binary-from-bob' > '${CLIENT_PATHS.bob}/${conflictScenario}/sample.bin'`);
  await ssh(state, "alice", ["systemctl", "start", "arbor-client.service"]);
  await waitUntil("Alice binary update acceptance", async () => await authorityHistoryCount(state, conflictTree) === before + 1);
  await ssh(state, "bob", ["systemctl", "start", "arbor-client.service"]);
  await waitUntil("Bob durable binary conflict", () => hasConflict(state, "bob", conflictTree));
  if (await authorityHistoryCount(state, conflictTree) !== before + 1) {
    throw new Error("Rejected binary conflict appeared in authority history");
  }
  const localBinary = await ssh(state, "bob", ["cat", `${CLIENT_PATHS.bob}/${conflictScenario}/sample.bin`], { quiet: true });
  if (localBinary.stdout !== "binary-from-bob") throw new Error("Bob's conflicting bytes were not retained locally");
  await setClients(state, "restart", ["bob"] as const);
  await waitUntil("Bob conflict recovery after restart", () => hasConflict(state, "bob", conflictTree));

  const mutationID = crypto.randomUUID();
  await sshBash(state, "bob", [
    `curl -fsS -H 'content-type: application/json' -d '{"mutationID":"${mutationID}","operations":[{"op":"resolveTreeConflict","tree":"${conflictTree}","choice":"local"}]}' http://127.0.0.1:4317/v1/mutate >/dev/null`,
  ].join("\n"));
  await waitUntil("resolved binary update acceptance", async () => await authorityHistoryCount(state, conflictTree) === before + 2);
  await setClients(state, "start", ["alice", "carol"] as const);
  await waitForConvergence(state, conflictScenario);
  for (const role of ["alice", "bob", "carol"] as const) {
    const value = await ssh(state, role, ["cat", `${CLIENT_PATHS[role]}/${conflictScenario}/sample.bin`], { quiet: true });
    if (value.stdout !== "binary-from-bob") throw new Error(`${role} did not materialize the explicit conflict resolution`);
  }

  await sshBash(state, "community", [
    ". /etc/arbor-community.env",
    "test \"$(curl -sS -o /dev/null -w '%{http_code}' -X POST -H \"Authorization: Bearer $ARBOR_ACCOUNT_TOKEN\" http://127.0.0.1:4318/.arbor/trees/ignored/push)\" = 404",
    "offer=$(curl -fsS -X POST -H \"Authorization: Bearer $ARBOR_ACCOUNT_TOKEN\" -H 'content-type: application/json' -d '{}' http://127.0.0.1:4318/.arbor/pairings)",
    "pairing_id=$(jq -r .id <<<\"$offer\")",
    "pairing_secret=$(jq -r .secret <<<\"$offer\")",
    "claimed=$(curl -fsS -X POST -H 'content-type: application/json' -d \"$(jq -cn --arg secret \"$pairing_secret\" '{secret:$secret,label:\"Hetzner acceptance device\"}')\" \"http://127.0.0.1:4318/.arbor/pairings/$pairing_id/claim\")",
    "device_id=$(jq -r .device.id <<<\"$claimed\")",
    "device_token=$(jq -r .deviceToken <<<\"$claimed\")",
    `curl -fsS -H \"Authorization: Bearer $device_token\" 'http://127.0.0.1:4318/.arbor/trees/${conflictTree}/ref' >/dev/null`,
    "curl -fsS -X DELETE -H \"Authorization: Bearer $ARBOR_ACCOUNT_TOKEN\" \"http://127.0.0.1:4318/.arbor/devices/$device_id\" >/dev/null",
    `test \"$(curl -sS -o /dev/null -w '%{http_code}' -H \"Authorization: Bearer $device_token\" 'http://127.0.0.1:4318/.arbor/trees/${conflictTree}/ref')\" = 401`,
  ].join("\n"), { quiet: true });

  state.steps.acceptance = new Date().toISOString();
  state.acceptance = {
    additive: { scenario: additive, tree: additiveTree },
    conflict: { scenario: conflictScenario, tree: conflictTree },
    replay: { scenario: replayScenario, tree: replayTree },
  };
  await saveState(state);
  console.log(`Accepted-update acceptance passed: ${additiveTree}, ${conflictTree}, ${replayTree}`);
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
    const service = role === "community" ? "arbor-community.service" : "arbor-client.service";
    const report = await sshBash(state, role, [
      "hostname",
      "printf 'revision: '; cat /opt/arbor-current/.arbor-revision",
      "printf 'bun: '; bun --version",
      "tailscale status",
      `systemctl status '${service}' --no-pager || true`,
      `journalctl -u '${service}' --no-pager -n 1000 || true`,
      ...(role === "community" ? [] : [
        `find '${CLIENT_PATHS[role]}' -mindepth 2 -type f -print0 | sort -z | xargs -0 sha256sum || true`,
        "curl -fsS 'http://127.0.0.1:4317/v1/children?tree=system&path=%2Ftrees' || true",
      ]),
    ].join("\n"), { allowFailure: true, quiet: true, timeoutMs: 60_000 });
    await writeFile(join(destination, `${role}.log`), `${report.stdout}\n${report.stderr}`);
  }
  await sshBash(state, "community", [
    "sqlite3 /var/lib/arbor-community/authority.sqlite3 \".backup '/tmp/arbor-authority.sqlite3'\"",
    "tar -C /var/lib/arbor-community -czf /tmp/arbor-community-objects.tar.gz objects",
  ].join("\n"));
  await download(state, "community", "/tmp/arbor-authority.sqlite3", join(destination, "authority.sqlite3"));
  await download(state, "community", "/tmp/arbor-community-objects.tar.gz", join(destination, "objects.tar.gz"));
  state.steps.collected = new Date().toISOString();
  await saveState(state);
  await writeFile(join(destination, "state.json"), `${JSON.stringify(state, null, 2)}\n`);
  console.log(`Evidence collected in ${destination}`);
  return destination;
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
    if (server.name !== node.name || labels?.purpose !== "arbor-sync-lab" || labels?.["arbor-run"] !== state.runId) {
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
    throw new Error("Tailscale authentication is still required. Run the printed commands, approve the nodes, then use `bun run lab:hcloud resume`.");
  }
  if (!state.steps.configured) await configure(state);
  console.log(`Lab ${state.runId} is ready. Run \`bun run lab:hcloud test\` or follow deploy/hcloud-sync-lab.md.`);
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
  if (options.command === "status") return status(state);
  if (options.command === "collect") { await collect(state); return; }
  if (options.command === "down") return down(state, options);
  usage();
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
