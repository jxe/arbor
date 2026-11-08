#!/usr/bin/env bun
import { HANDLE_PATH, decodeRunRequest, type RunRequest, agentBundleID, agentDevice, buildAgentLink, generateAgentCode, openDeviceSessionByDevice, parseAgentLink, decodeCandidateUpdateJSON, describeTransitionPayload, canonicalOverstoryLocator, canonicalHTTPURL, deviceKeyFromSeed, generateOverstoryID, generateDeviceKeySeed, openDeviceSession, resourceRuleKey, configurationCheckoutPath, editProfileConfigurationFile, HostAccountStore, HostPlacementStore, readStorySyncAccess, storyDataRoot, loadProfileConfigurations, parseAccountDevicesConfiguration, parseMountsYAML, readTreeConfigGraph, saveCurrentAccountDeviceID, snapshotTreeConfig, treeHoldsPages, type AccessRule, type HostPlacementRecord, type ProfileConfigurationSnapshot, type ObjectHash, type ResourceAccessRule, type TreeConfigKind, type TreeConfigValues, ProtocolClient, setProtocolClientName } from "@ovst/protocol";
import { lstat, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { constants as osConstants } from "node:os";
import { resolveUserPath, STORY_VERSION } from "@ovst/story-sync";
import { runStorySyncDaemon } from "@ovst/story-sync/cli";
import { StorySyncRESTClient, type AgentRunView, type DeclinedChanges } from "./daemon-client.ts";
import { agentLabel, hasClaudeCode, hookReport, installAgentPresence, textReport, uninstallAgentPresence } from "./agent-presence.ts";
import { loadIgnorePolicy, materializeTree, membershipSkip, snapshotDirectory, trackedEntries } from "@ovst/fs";
import { listLocalAccounts } from "@ovst/story-sync/state";
import { accountProtocolClient, addLocalPlacement, cancelInvitation, createInvitation, pendingInvitations, renewInvitation, backupIsEncrypted, connectPlacementAccount, loadLocalPlacements, ProfileIdentityStore } from "@ovst/client";
import type { Document } from "yaml";
import { STORY_SYNC_PORT, storyDaemonSupervisor } from "./daemon.ts";
import { compiledExecutable, storyCommand } from "./package-runtime.ts";
import { DOMAIN_CHECK_PATH, domainOrigin, domainProfileResolver, validateProfileAvatarPath, validateProfileDescription, validateProfileDisplayName } from "@ovst/overstoryd";
import { DOMAIN_PROFILE_PATH, domainTXTName, parseMarkdown, parseProfileLocator, profileDomains, resolveDomainDelegation, treeConfigurationID } from "@ovst/protocol";
import {
  cloudPlacementPath,
  cloudSessionDirectory,
  cloudSessionForPath,
  cloudSessionForRoot,
  decodeCloudBundle,
  encodeCloudBundle,
  loadCloudBundles,
  saveCloudBundleRecord,
  saveCloudSession,
  updateCloudBundleRecord,
  validateCloudPlacementPaths,
  type CloudBundlePayload,
  type CloudBundlePlacement,
  type CloudSessionRecord,
} from "./cloud.ts";

const REHOME_WIRE_TIMEOUT_MS = 60_000;

class CLIUsageError extends Error {}

function usageError(message: string): never {
  throw new CLIUsageError(message);
}

type ShareAudience =
  | { kind: "private" }
  | { kind: "everyone"; access: "read" | "write" }
  | { kind: "profile"; locator: string; access: "read" | "write" }
  | { kind: "rules"; rules: Array<
      | { subject: { kind: "everyone" }; access: "read" | "write" }
      | { subject: { kind: "profile"; locator: string }; access: "read" | "write" }
    > };

/**
 * A passphrase from the terminal without echo, or the first line of standard
 * input when it is not a terminal. Never an argument, which would reach the
 * shell's history and the process list.
 */
async function readPassphrase(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    passphraseInput ??= new Response(Bun.stdin.stream()).text().then((text) => text.split(/\r?\n/));
    const line = (await passphraseInput).shift();
    if (line === undefined) throw new Error("A passphrase is required on standard input");
    return line;
  }
  process.stderr.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  try {
    return await new Promise<string>((resolveLine, reject) => {
      let value = "";
      const onData = (chunk: Buffer) => {
        for (const character of chunk.toString("utf8")) {
          if (character === "\r" || character === "\n") { stdin.off("data", onData); process.stderr.write("\n"); return resolveLine(value); }
          if (character === "\u0003") { stdin.off("data", onData); process.stderr.write("\n"); return reject(new Error("Cancelled")); }
          if (character === "\u007f" || character === "\b") value = [...value].slice(0, -1).join("");
          else value += character;
        }
      };
      stdin.on("data", onData);
    });
  } finally {
    stdin.setRawMode(false);
    stdin.pause();
  }
}
let passphraseInput: Promise<string[]> | undefined;

/** `story agent run` exits with this when the command succeeded but the drain did not (EX_TEMPFAIL). */
const AGENT_RUN_UNSENT_EXIT = 75;

const USAGE = `Usage:
  story --help | --version

Folders
  story place [--clear-access] [--access <subject>=<read|write|none>[,...]] <local-path> <canonical-url>
  story place <canonical-url> <local-path>
  story place --read-only <canonical-url> <local-path>
      Follow a tree you can read at any host, without an account there; edits in the folder are never sent.
      Put a local folder at a URL, or check a URL out to a local folder.
      (the URL may be on the home host or under a placement root, such as https://<placement-host>/~<handle>/<name>)
  story mv [--dry-run] <placed-local-root> <new-local-path>
  story mv [--dry-run] <source-canonical-url> <destination-canonical-url>
      Move a placed folder on this device, or rename it on its host.

Agents, for you
  story agent create [--name <label>] --place <canonical-url> <relative-path> [...]
      Make an agent bundle: a revocable string that lets an agent work in the chosen folders and nothing else.
  story agent list [--json]
  story agent revoke <bundle-id>
  story agent run [<bundle-string>] [--root <directory>] [--timeout <duration>] [-- <command> [<argument>...]]
      In the agent's workspace: check those folders out, run the command there, then send what is left and stop.
  story agent runner [on|off]
      Whether this Mac runs tasks you send from your other devices (Run on the iPhone). On by default.
  story agent install [--command <path>] [--agent <label>]
  story agent uninstall
      Add (or remove) the hooks, the skill and the permission that let Claude Code sessions in placed folders show up in Story.

Agents, for the agent
  story agent start [<bundle-string>] [--task <run request>] [--root <directory>] [--timeout <duration>] [--json]
      Check those folders out and keep them syncing, for a harness that starts the agent itself.
      With --task (JSON, or @file, or STORY_RUN_REQUEST): also take on that task, in a tree placed here
      if there is no bundle. Story shows the agent from then on and marks the task done when it says done.
  story agent finish [--root <directory>] [--timeout <duration>] [--json]
      Send what is left and stop.
  story agent status <text> [--at <text on the page>]
  story agent done <text>
      From an agent in a placed folder: say what it is doing, or what it did; Story shows it beside the agent's cursor.
  story agent hook [--agent <label>]
      Read a Claude Code hook's JSON on stdin and show the agent's page and cursor. Never fails the agent.

People
  story invite <account-url>
      Invite someone to your community: reserve https://<host>/~<handle> and print its join link.
  story invite list [<host-url>]
  story invite renew <account-url>
      Print a new join link for a pending invitation; the old link stops working.
  story invite cancel <account-url>

Browser
  story open [<locator>]

Identity
  story me
  story me create [<profile-folder>] [--name <display-name>]
  story me set [--name <display-name>] [--avatar <relative-path>] [--description <text>]
  story me domain [<domain>] [--remove <domain>] [--check]
      Name your profile by a domain you control, or have your home host serve your trees there: add it to your profile, print the records to publish, and check.
  story me backup <file>
  story me restore <file> [<profile-folder>]
  story me accounts
  story me device [--account <ConfigurationTreeID>]

Sync state
  story sync status [<locator>] [--json]
  story sync pause <placed-path>
  story sync resume <placed-path>
  story sync pending <placed-path> [--json]
  story sync declined <placed-path> [--json]
  story sync declined restore <placed-path>
  story sync declined resend <placed-path>

Daemon
  story daemon <install|uninstall|start|stop|restart|logs>
  story daemon run [--control]

Notes:
  story place / mv  edit the account checkout under accounts/<ConfigurationTreeID>/ on disk; Story Sync pushes it.
    A URL on another host places the tree there, under your placement root, once that host's community reserves
    your profile by its URL at your home host (such as https://<home>/~<handle>); the first place connects this
    device there. Placing the placement root's own URL activates it with the folder. Trees never move between hosts.
    --access may also be written --access=<subject>=<read|write|none>[,...].
  story agent run / start  take the bundle as an argument or from STORY_CLOUD_BUNDLE, never both. run removes it
    from the command's environment, passes the command's exit status through, and exits ${AGENT_RUN_UNSENT_EXIT} when the command
    succeeded but its last changes could not be sent. With no command it runs $SHELL, on a terminal only.
  story open  opens the daemon-hosted web editor, which is being rebuilt and may be unavailable.
  story invite  talks to the host with this device's key; it needs no Story Sync. The link is printed once and
    stored nowhere: lose it and use renew. list prints pending invitations, not members.
  story me accounts  lists your home account and your placement accounts at other hosts.
  story sync status  reports Story Sync itself (state, supervision, origin) and every placed folder.
    story status is short for it.
  story sync pause / resume  stop and restart publishing a placed folder's changes; accepted updates still arrive.
  story sync pending  shows exactly what Story Sync would send next for a placed folder.
  story sync declined  shows folder paths whose changes the host refused; the rest of the folder keeps syncing.
    restore puts back the host's version of those paths; resend sends them again as they are.
  story daemon run  runs Story Sync in the foreground, for a service manager where \`story daemon install\` is unavailable.
  story help, -h and -V are also accepted.`;

function usage(): never {
  console.error(USAGE);
  process.exit(2);
}

async function openBrowser(url: string): Promise<void> {
  const command = process.platform === "darwin" ? ["open", url] : process.platform === "win32" ? ["cmd", "/c", "start", url] : ["xdg-open", url];
  try { Bun.spawn(command, { stdout: "ignore", stderr: "ignore" }); } catch {}
}

/**
 * Where the selected data home's Story Sync listens: the origin it recorded,
 * else the well-known port. Another user's Story Sync may hold that port, so a
 * second account's records another (data-home.md).
 */
export async function storySyncOrigin(): Promise<string> {
  return (await readStorySyncAccess().catch(() => null))?.origin ?? `http://127.0.0.1:${STORY_SYNC_PORT}`;
}

export async function attachedStorySyncURL(target: OpenTarget, selectedOrigin?: string, dataHome?: string): Promise<URL | null> {
  const origin = selectedOrigin ?? await storySyncOrigin();
  try {
    const status = await new StorySyncRESTClient({ baseURL: origin, ...(dataHome ? { dataHome } : {}) }).status();
    if (status.service !== "story-sync") return null;
    if (target.path) return new URL(`${origin}/render${target.path}`);
    const browserURL = new URL(`${origin}/render`);
    if (target.remoteURL) browserURL.searchParams.set("browse", target.remoteURL);
    return browserURL;
  } catch {
    return null;
  }
}

const CANONICAL_INPUT = /^(?:https?|overstory):\/\//;

interface CanonicalTarget {
  endpoint: string;
  canonicalPath: string;
  supplied: string;
}

function canonicalTarget(input: string): CanonicalTarget {
  const url = new URL(input);
  if (url.protocol !== "http:" && url.protocol !== "https:" && url.protocol !== "overstory:") {
    throw new Error("Use an HTTP or overstory:// canonical URL");
  }
  if (url.protocol === "overstory:" && url.hostname === "tree") {
    throw new Error("A raw TreeID is not a canonical community URL");
  }
  const endpoint = url.protocol === "overstory:"
    ? `${url.hostname === "localhost" || url.hostname === "127.0.0.1" ? "http" : "https"}://${url.host}`
    : url.origin;
  const canonicalPath = `/${url.pathname.split("/").filter(Boolean).map(decodeURIComponent).join("/")}`;
  return {
    endpoint,
    canonicalPath: canonicalPath === "/" ? "/" : canonicalPath.replace(/\/$/, ""),
    supplied: input.replace(/\/$/, ""),
  };
}

export interface OpenTarget {
  path?: string;
  remoteURL?: string;
  profile?: { origin: string; handle: string; path: string };
}

export function openTarget(input: string, cwd = process.cwd()): OpenTarget {
  if (!CANONICAL_INPUT.test(input)) return { path: resolve(cwd, input) };
  const target = canonicalTarget(input);
  const source = new URL(input);
  const remoteURL = source.protocol === "overstory:"
    ? `${target.endpoint}${source.pathname}${source.search}${source.hash}`
    : source.toString();
  const profile = /^\/~([a-z0-9](?:[a-z0-9-]{0,62}))\/?$/.exec(target.canonicalPath);
  return {
    remoteURL,
    ...(profile ? { profile: { origin: target.endpoint, handle: profile[1]!, path: target.canonicalPath } } : {}),
  };
}

export async function isReservedProfile(target: OpenTarget): Promise<boolean> {
  if (!target.profile || !target.remoteURL) return false;
  try {
    const response = await fetch(target.remoteURL, { headers: { accept: "text/html" } });
    return response.ok && response.headers.get("overstory-profile-state") === "reserved";
  } catch {
    return false;
  }
}

type CliAudienceOperation =
  | { kind: "clear" }
  | { kind: "set"; subject: string; access: "none" | "read" | "write" };

function accessOperations(value: string): CliAudienceOperation[] {
  if (!value.trim()) throw new Error("--access requires at least one subject=read|write|none entry");
  return value.split(",").map((entry) => {
    const assignment = entry.trim();
    const separator = assignment.indexOf("=");
    if (separator <= 0 || assignment.indexOf("=", separator + 1) !== -1) {
      throw new Error(`Invalid access entry: ${assignment || "(empty)"}. Expected subject=read|write|none`);
    }
    const subject = assignment.slice(0, separator).trim();
    const access = assignment.slice(separator + 1).trim();
    if (!subject || !["none", "read", "write"].includes(access)) {
      throw new Error(`Invalid access entry: ${assignment}. Expected subject=read|write|none`);
    }
    return { kind: "set" as const, subject, access: access as "none" | "read" | "write" };
  });
}

function placeArguments(args: string[]): { operands: string[]; audience: CliAudienceOperation[]; readOnly: boolean } {
  const operands: string[] = [];
  const audience: CliAudienceOperation[] = [];
  let readOnly = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--read-only") {
      readOnly = true;
    } else if (arg === "--access" || arg.startsWith("--access=")) {
      const inline = arg.startsWith("--access=") ? arg.slice("--access=".length) : undefined;
      const value = inline ?? args[index + 1];
      if (value === undefined || (!inline && value.startsWith("-"))) {
        throw new Error("--access requires subject=read|write|none");
      }
      audience.push(...accessOperations(value));
      if (inline === undefined) index += 1;
    } else if (arg === "--clear-access") {
      audience.push({ kind: "clear" });
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown place option: ${arg}`);
    } else {
      operands.push(arg);
    }
  }
  return { operands, audience, readOnly };
}

function accessSubject(subject: string, target: CanonicalTarget): { kind: "everyone" } | { kind: "profile"; locator: string } {
  if (subject === "public") return { kind: "everyone" };
  if (!/^~[a-z0-9](?:[a-z0-9-]{0,62})$/.test(subject)) {
    throw new Error(`Audience must be public or a same-community profile such as ~editors: ${subject}`);
  }
  return { kind: "profile", locator: `${target.endpoint}/${subject}` };
}

function initialAudience(operations: CliAudienceOperation[], target: CanonicalTarget): ShareAudience {
  const afterLastClear = operations.slice(operations.findLastIndex((operation) => operation.kind === "clear") + 1);
  const access = new Map<string, "read" | "write">();
  for (const operation of afterLastClear) {
    if (operation.kind !== "set") continue;
    if (operation.access === "none") access.delete(operation.subject);
    else access.set(operation.subject, operation.access);
  }
  if (!access.size) return { kind: "private" };
  return {
    kind: "rules",
    rules: [...access].map(([name, permission]) => {
      const subject = accessSubject(name, target);
      return subject.kind === "everyone"
        ? { subject: { kind: "everyone" as const }, access: permission }
        : { subject: { kind: "profile" as const, locator: subject.locator }, access: permission };
    }),
  };
}

async function withStorySync<T>(
  path: string,
  run: (
    client: StorySyncRESTClient,
    service: { synchronizeNow(configurationTree?: string): Promise<void> },
  ) => Promise<T>,
): Promise<T> {
  // The CLI never starts a private daemon: it attaches to the Story Sync that
  // owns this data home (explicit URL, cloud session, or the well-known
  // loopback port) and fails clearly when none answers.
  const cloud = !process.env.STORY_SYNC_URL ? await cloudSessionForPath(path) : null;
  const baseURL = process.env.STORY_SYNC_URL ?? cloud?.origin ?? await storySyncOrigin();
  const client = new StorySyncRESTClient({ baseURL, ...(cloud ? { dataHome: cloud.dataHome } : {}) });
  const compatible = await client.status().then(
    (status) => status.service === "story-sync" && status.protocolVersion === "v1",
    () => false,
  );
  if (!compatible) {
    throw new Error(`A compatible Story Sync is not reachable at ${baseURL}; run \`story daemon install\` (first use) or \`story daemon start\` on macOS, or \`story-sync --control\`, or point STORY_SYNC_URL at it`);
  }
  return run(client, {
    async synchronizeNow(configurationTree?: string) { await client.synchronizeNow(configurationTree); },
  });
}

async function editProfileConfigurationYAML(
  client: StorySyncRESTClient,
  configurationTree: string,
  change: (document: Document) => void | Promise<void>,
  validate: (source: string) => void,
  filename: string,
): Promise<void> {
  // The configuration checkout is a placed folder: edit it on disk and let the
  // daemon push it. Refuse while the daemon holds a conflict on it, so a local
  // edit cannot silently overwrite a review that is still pending.
  const descriptor = (await client.trees()).snapshot.find((candidate) =>
    candidate.id === configurationTree && candidate.configurationTree === configurationTree
  );
  if (descriptor?.sync === "conflict") {
    throw new Error(`Account configuration ${configurationTree} has a synchronization conflict; resolve it (\`story sync status\`) before editing ${filename}`);
  }
  await editProfileConfigurationFile(configurationTree, filename, change, validate);
}

function sameOrDescendantPath(path: string, root: string): boolean {
  const normalizedRoot = root === "/" ? "" : root.replace(/\/$/, "");
  return path === (normalizedRoot || "/") || path.startsWith(`${normalizedRoot}/`);
}

interface SelectedHostAccount {
  configuration: ProfileConfigurationSnapshot & Required<Pick<ProfileConfigurationSnapshot, "host" | "profile" | "configuration" | "currentDevice">>;
  /** The profile's home connection, which holds its configuration and this device's key. */
  connection: NonNullable<Awaited<ReturnType<HostAccountStore["get"]>>>;
  /**
   * The host the target is on and the session this device holds there: the
   * home connection's, or a placement account's (accounts §1.3), whose
   * session the same device key opens.
   */
  host: { origin: string; token: string; placement?: HostPlacementRecord };
}

/** A placement's `host` in `placements.yaml`: absent for the home host. */
function placementHost(selected: SelectedHostAccount): { host?: string } {
  return selected.host.placement ? { host: selected.host.origin } : {};
}

async function accountForCanonicalTarget(
  target: CanonicalTarget,
  options: { administrator: boolean },
): Promise<SelectedHostAccount> {
  const [configurations, records] = await Promise.all([loadProfileConfigurations(), HostAccountStore.list()]);
  let placements = await HostPlacementStore.list();
  // A host that is neither home nor connected yet: connect to the placement
  // account its community reserved for this profile (accounts §1.3).
  if (records.length === 1 && !records.some((record) => record.origin === target.endpoint)
    && !placements.some((record) => record.origin === target.endpoint)) {
    await connectPlacementAccount(target.endpoint);
    placements = await HostPlacementStore.list();
  }
  // A profile has one account per host, its home or a placement account; any
  // tree its profile administers there may be placed.
  const homes = records.filter((record) => record.origin === target.endpoint)
    .map((record) => ({ configurationTree: record.configurationTree, account: record.account, placement: undefined as HostPlacementRecord | undefined }));
  const placed = homes.length ? [] : placements.filter((record) => record.origin === target.endpoint)
    .map((record) => ({ configurationTree: record.configurationTree, account: record.account, placement: record as HostPlacementRecord | undefined }));
  const atOrigin = homes.length ? homes : placed;
  const candidates = atOrigin.length > 1
    ? atOrigin.filter((record) => sameOrDescendantPath(target.canonicalPath, new URL(record.account).pathname))
    : atOrigin;
  if (!candidates.length) {
    throw new Error(`No claimed account contains ${target.supplied}`);
  }
  if (candidates.length > 1) throw new Error(`Several claimed accounts contain ${target.supplied}`);
  const { configurationTree, placement } = candidates[0]!;
  const record = (await new HostAccountStore(configurationTree).safe());
  if (!record) throw new Error(`Account ${configurationTree} has no home connection`);
  const configuration = configurations.find((candidate) => candidate.configurationTree === record.configurationTree);
  if (!configuration) throw new Error(`Account ${record.configurationTree} has no configuration checkout`);
  if (configuration.diagnostics.length || !configuration.configuration || !configuration.profile || !configuration.currentDevice) {
    throw new Error(`Account ${record.configurationTree} is not valid: ${configuration.diagnostics[0]?.message ?? "incomplete checkout"}`);
  }
  if (configuration.host !== record.origin) {
    throw new Error(`Account ${record.configurationTree} does not match its claimed host connection`);
  }
  if (options.administrator && !configuration.currentDevice.administrator) {
    throw new Error(`The current device is not an administrator of account ${record.configurationTree}`);
  }
  const connection = await new HostAccountStore(record.configurationTree).get();
  if (!connection) throw new Error(`Account credential is unavailable for ${record.configurationTree}`);
  let host: SelectedHostAccount["host"] = { origin: connection.record.origin, token: connection.accountToken };
  if (placement) {
    const opened = await new HostPlacementStore(record.configurationTree, placement.origin).get();
    if (!opened) throw new Error(`Placement credential is unavailable for ${placement.account}`);
    host = { origin: opened.record.origin, token: opened.accountToken, placement: opened.record };
  }
  return {
    configuration: configuration as SelectedHostAccount["configuration"],
    connection,
    host,
  };
}

async function waitForCanonicalPlacement(
  client: StorySyncRESTClient,
  tree: string,
  configurationTree: string,
  endpoint: string,
  canonicalPath: string,
): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const descriptor = (await client.trees()).snapshot.find((candidate) =>
      candidate.id === tree && candidate.configurationTree === configurationTree
    );
    if (descriptor?.canonical?.endpoint === endpoint && descriptor.canonical.path === canonicalPath) return;
    await Bun.sleep(25);
  }
  throw new Error("Story Sync did not adopt the destination placement");
}

async function waitForLocalPlacement(
  client: StorySyncRESTClient,
  tree: string,
  configurationTree: string,
  path: string,
): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const descriptor = (await client.trees()).snapshot.find((candidate) =>
      candidate.id === tree
      && candidate.configurationTree === configurationTree
      && candidate.osPath === path
    );
    if (descriptor) return;
    await Bun.sleep(25);
  }
  throw new Error(`Story Sync did not adopt the placement at ${path}`);
}

async function mvCommand(args: string[]): Promise<void> {
  let dryRun = false;
  const operands: string[] = [];
  for (const arg of args) {
    if (arg === "--dry-run") dryRun = true;
    else if (arg.startsWith("-")) throw new Error(`Unknown mv option: ${arg}`);
    else operands.push(arg);
  }
  if (operands.length !== 2) usage();
  const [sourceInput, destinationInput] = operands as [string, string];
  const sourceIsCanonical = CANONICAL_INPUT.test(sourceInput);
  const destinationIsCanonical = CANONICAL_INPUT.test(destinationInput);
  if (sourceIsCanonical !== destinationIsCanonical) {
    throw new Error("story mv requires either two local paths or two canonical URLs; use story place to add a placement");
  }
  if (sourceIsCanonical) {
    await moveCanonicalTree(sourceInput, destinationInput, dryRun);
    return;
  }
  const source = await realpath(resolve(sourceInput));
  const destination = resolve(destinationInput);
  await withStorySync(source, async (client) => {
    const result = await client.movePlacement(source, destination, dryRun);
    console.log(`${result.check ? "Would move" : "Moved"} ${result.tree}`);
    console.log(`  from ${result.source}`);
    console.log(`  to   ${result.destination}`);
  });
}

/** The placed tree whose folder holds `input`, by the daemon's `osPath`s; the deepest placement wins. */
async function placedTree(client: StorySyncRESTClient, input: string) {
  const path = await realpath(resolve(input)).catch(() => resolve(input));
  const tree = (await client.trees()).snapshot
    .filter((candidate) => candidate.osPath && candidate.placement === "placed" && sameOrDescendantPath(path, candidate.osPath))
    .sort((left, right) => right.osPath!.length - left.osPath!.length)[0];
  if (!tree) throw new Error(`Not inside a placed folder: ${path}`);
  return tree;
}

async function pauseCommand(args: string[], action: "pause" | "resume"): Promise<void> {
  if (args.length !== 1 || args[0]!.startsWith("-")) usage();
  await withStorySync(resolve(args[0]!), async (client) => {
    const tree = await placedTree(client, args[0]!);
    await (action === "pause" ? client.pauseFolder(tree.id) : client.resumeFolder(tree.id));
    console.log(`${action === "pause" ? "Paused" : "Resumed"} ${tree.osPath} (${tree.id})`);
  });
}

async function pendingCommand(args: string[]): Promise<void> {
  const json = args.includes("--json");
  const operands = args.filter((arg) => arg !== "--json");
  if (operands.length !== 1 || operands[0]!.startsWith("-")) usage();
  await withStorySync(resolve(operands[0]!), async (client) => {
    const tree = await placedTree(client, operands[0]!);
    const pending = await client.pending(tree.id);
    if (json) {
      console.log(JSON.stringify(pending.request, null, 2));
      return;
    }
    const state = pending.paused ? "paused" : tree.sync ?? "unknown";
    if (!pending.request || !pending.base) {
      console.log(`Nothing pending for ${tree.osPath} (${tree.id}, ${state})`);
      return;
    }
    const { updates } = pending.request;
    console.log(`Pending for ${tree.osPath} (${tree.id}, ${state})`);
    console.log(`Accepted base: update ${pending.request.base}, root ${pending.base.root}`);
    // Earlier elements' objects serve later elements' bases; the rest come from the daemon.
    const objects = new Map<string, Uint8Array>();
    const reads = await client.reads();
    let before = pending.base.root;
    for (const [index, element] of updates.entries()) {
      const update = decodeCandidateUpdateJSON(element);
      for (const object of update.objects) objects.set(object.hash, object.bytes);
      console.log(`\nUpdate ${index + 1} of ${updates.length}: ${update.change}${update.trace === null ? "" : " (traced)"}`);
      console.log(await describeTransitionPayload({
        before, after: update.candidate, payload: update,
        load: async (hash) => objects.get(hash) ?? await reads.object(tree.id, hash).catch(() => undefined),
      }));
      before = update.candidate;
    }
  });
}

function printDeclined(declined: DeclinedChanges, osPath: string): void {
  console.log(`Declined in ${osPath} (${declined.tree}) since ${declined.since}`);
  if (declined.detail) console.log(`The host said: ${declined.detail}`);
  console.log("Kept on this device and not published:");
  for (const point of declined.points) console.log(`  ${point}`);
  console.log("The rest of the folder keeps syncing. Make these match the host and they are released, or:");
  console.log(`  story sync declined restore ${JSON.stringify(osPath)}   put back the host's version`);
  console.log(`  story sync declined resend ${JSON.stringify(osPath)}    send them again as they are`);
}

async function declinedCommand(args: string[]): Promise<void> {
  const flags = args.filter((arg) => arg.startsWith("-"));
  const operands = args.filter((arg) => !arg.startsWith("-"));
  const json = flags.includes("--json");
  // One operand is the path to show; two are a verb and its path.
  const action = operands.length === 2 && (operands[0] === "restore" || operands[0] === "resend") ? operands[0] : "show";
  const path = operands[action === "show" ? 0 : 1];
  if (!path || operands.length !== (action === "show" ? 1 : 2) || flags.some((flag) => flag !== "--json")
    || (json && action !== "show")) usage();
  await withStorySync(resolve(path), async (client) => {
    const tree = await placedTree(client, path);
    const declined = await client.declined(tree.id);
    if (action === "show" && json) console.log(JSON.stringify(declined, null, 2));
    else if (!declined) console.log(`Nothing declined in ${tree.osPath} (${tree.id})`);
    else if (action === "show") printDeclined(declined, tree.osPath!);
    else {
      await (action === "restore" ? client.restoreDeclined(tree.id) : client.resendDeclined(tree.id));
      console.log(action === "restore" ? `Put back the host's version in ${tree.osPath}:` : `Sending again from ${tree.osPath}:`);
      for (const point of declined.points) console.log(`  ${point}`);
    }
  });
}

/** The tree `path` falls in, and the mount name `path` would be below it. */
async function mountPoint(wire: ProtocolClient, path: string): Promise<{ parent: string; name: string }> {
  const segments = path.split("/").filter(Boolean);
  if (!segments.length) throw new Error("The community root is not mounted anywhere");
  const parentPath = `/${segments.slice(0, -1).join("/")}`;
  const resolved = await wire.resolve(parentPath);
  const within = resolved.ref.path === "/" ? "" : resolved.ref.path.replace(/^\//, "");
  return { parent: resolved.ref.tree, name: within ? `${within}/${segments.at(-1)!}` : segments.at(-1)! };
}

/**
 * Change a tree's mounts: in the local account checkout when the parent is
 * the account's own profile (Story Sync pushes it), otherwise as an update of
 * the parent's configuration, which only its administrators may make.
 */
async function editMounts(
  client: StorySyncRESTClient,
  selected: SelectedHostAccount,
  wire: ProtocolClient,
  parent: string,
  change: (mounts: Record<string, string>) => Record<string, string>,
): Promise<void> {
  if (parent === selected.configuration.profile) {
    await editProfileConfigurationYAML(client, selected.configuration.configurationTree, (document) => {
      const before = (document.toJS() ?? {}) as Record<string, string>;
      const after = change({ ...before });
      for (const name of Object.keys(before)) if (!(name in after)) document.deleteIn([name]);
      for (const [name, tree] of Object.entries(after)) if (before[name] !== tree) document.setIn([name], tree);
    }, (source) => { parseMountsYAML(source); }, "mounts.yaml");
    return;
  }
  await editRemoteTreeConfig(wire, parent, (values) => ({ ...values, mounts: change({ ...values.mounts }) }));
}

/** Edit a configuration the host holds, as one of its tree's administrators. */
async function editRemoteTreeConfig(wire: ProtocolClient, tree: string, change: (values: TreeConfigValues) => TreeConfigValues): Promise<void> {
  const { tree: descriptor, snapshot } = await wire.treeConfiguration(tree);
  // The host knows the tree's kind; the files a configuration holds show it.
  let current: TreeConfigValues | undefined;
  for (const kind of ["tree", "group", "person"] satisfies TreeConfigKind[]) {
    try { const { sources: _sources, ...values } = readTreeConfigGraph(snapshot, kind, tree); current = values; break; } catch { /* another kind */ }
  }
  if (!current) throw new Error(`The configuration of ${tree} is not readable`);
  await wire.submitUpdate(descriptor.id, descriptor.update, snapshotTreeConfig(change(current)), { ifCurrent: descriptor.update });
}

/** A whole-tree grant as an `access.yaml` rule. */
function resourceRule(rule: AccessRule): ResourceAccessRule {
  const who = rule.subject.kind === "everyone" ? "everyone" as const
    : rule.subject.kind === "profile" ? { profile: rule.subject.tree } : { link: rule.subject.digest };
  return { who, allow: [rule.access] };
}

async function moveCanonicalTree(sourceInput: string, destinationInput: string, dryRun: boolean): Promise<void> {
  const source = canonicalTarget(sourceInput);
  const destination = canonicalTarget(destinationInput);
  const sourceCanonical = `${source.endpoint}${source.canonicalPath}`;
  const destinationCanonical = `${destination.endpoint}${destination.canonicalPath}`;
  if (source.endpoint !== destination.endpoint) {
    throw new Error("Moving a tree to another host is not supported: a tree stays on the host that holds it");
  }

  await withStorySync(storyDataRoot(), async (client, service) => {
    let selected = await accountForCanonicalTarget(source, { administrator: true });
    await service.synchronizeNow(selected.configuration.configurationTree);
    selected = await accountForCanonicalTarget(source, { administrator: true });
    const local = await loadLocalPlacements();
    if (local.diagnostics.length) throw new Error(`placements.yaml is invalid: ${local.diagnostics[0]!.message}`);
    const wire = new ProtocolClient(selected.host.origin, selected.host.token, { timeoutMs: REHOME_WIRE_TIMEOUT_MS });
    const resolved = await wire.resolve(source.canonicalPath);
    const sourceRemote = resolved.enclosingTree as import("@ovst/protocol").RemoteTreeDescriptor | undefined;
    if (!sourceRemote?.canonical || sourceRemote.canonical.path !== source.canonicalPath) throw new Error(`No exact canonical tree matches ${sourceInput}`);
    const sourceTree = sourceRemote.id;
    const activePlacement = local.placements.find((placement) => placement.tree === sourceTree);
    if (!activePlacement) throw new Error(`Canonical move requires a local placement of ${sourceInput}`);
    const nested = local.placements.find((placement) =>
      placement.path !== activePlacement.path && placement.path.startsWith(`${activePlacement.path}/`)
    );
    if (nested) throw new Error(`Canonical move does not yet move a nested tree closure: ${nested.path}`);
    if (sourceCanonical === destinationCanonical) {
      console.log(`${sourceTree} is already at ${destination.supplied}`);
      return;
    }
    const from = await mountPoint(wire, source.canonicalPath);
    const to = await mountPoint(wire, destination.canonicalPath);
    const occupied = await wire.resolve(destination.canonicalPath).catch(() => null);
    if (occupied?.enclosingTree?.canonical?.path === destination.canonicalPath) {
      throw new Error(`${destination.supplied} is already the address of ${occupied.enclosingTree.id}`);
    }
    const localDescriptor = (await client.trees()).snapshot.find((candidate) =>
      candidate.id === sourceTree && candidate.configurationTree === selected.configuration.configurationTree
    );
    if (!localDescriptor || localDescriptor.sync !== "idle" || localDescriptor.missing) {
      throw new Error(`Source tree must be present and idle before a canonical move; current state is ${localDescriptor?.sync ?? "unavailable"}`);
    }
    const before = (await wire.descriptor(sourceTree)).tree;
    console.log(`${dryRun ? "Would move" : "Moving"} ${sourceTree}`);
    console.log(`  from ${sourceCanonical}`);
    console.log(`  to   ${destinationCanonical}`);
    console.log(`  path ${activePlacement.path}`);
    if (dryRun) return;
    // The address belongs to the parent: a rename edits one parent's mounts;
    // a move to another parent unmounts, then mounts, which needs both parents'
    // administrators and the tree's.
    if (from.parent === to.parent) {
      await editMounts(client, selected, wire, from.parent, (mounts) => {
        delete mounts[from.name];
        return { ...mounts, [to.name]: sourceTree };
      });
    } else {
      await editMounts(client, selected, wire, from.parent, (mounts) => { delete mounts[from.name]; return mounts; });
      await service.synchronizeNow(selected.configuration.configurationTree);
      await editMounts(client, selected, wire, to.parent, (mounts) => ({ ...mounts, [to.name]: sourceTree }));
    }
    await service.synchronizeNow(selected.configuration.configurationTree);
    await waitForCanonicalPlacement(client, sourceTree, selected.configuration.configurationTree, destination.endpoint, destination.canonicalPath);
    const finalLocal = (await client.trees()).snapshot.find((candidate) =>
      candidate.id === sourceTree && candidate.configurationTree === selected.configuration.configurationTree
    );
    if (!finalLocal || finalLocal.sync !== "idle") {
      throw new Error(`Destination placement did not become idle; current state is ${finalLocal?.sync ?? "unavailable"}`);
    }
    const finalRemote = (await wire.descriptor(sourceTree)).tree;
    if (finalRemote.root !== before.root || finalRemote.canonical?.path !== destination.canonicalPath) {
      throw new Error("Canonical rename did not preserve the source snapshot and exact destination path");
    }
    console.log(`Moved ${sourceTree} to ${destinationCanonical}.`);
  });
}

async function accessRulesFor(client: ProtocolClient, audience: ShareAudience): Promise<import("@ovst/protocol").AccessRule[]> {
  const raw = audience.kind === "private" ? [] : audience.kind === "everyone"
    ? [{ subject: { kind: "everyone" as const }, access: audience.access }]
    : audience.kind === "profile"
      ? [{ subject: { kind: "profile" as const, locator: audience.locator }, access: audience.access }]
      : audience.rules;
  return Promise.all(raw.map(async (rule) => rule.subject.kind === "profile"
    ? { subject: { kind: "profile" as const, tree: (await client.resolve(new URL(rule.subject.locator).pathname)).ref.tree }, access: rule.access }
    : { subject: { kind: "everyone" as const }, access: rule.access }));
}

/**
 * Push one account's configuration now, or leave it on disk for the daemon to
 * push later when that account's host is unreachable. Any other failure is
 * surfaced as before.
 */
async function synchronizeOrDefer(
  client: StorySyncRESTClient,
  service: { synchronizeNow(configurationTree?: string): Promise<void> },
  configurationTree: string,
): Promise<boolean> {
  try {
    await service.synchronizeNow(configurationTree);
    return true;
  } catch (error) {
    const descriptor = (await client.trees()).snapshot.find((candidate) =>
      candidate.id === configurationTree && candidate.configurationTree === configurationTree
    );
    if (descriptor?.sync !== "offline") throw error;
    return false;
  }
}

async function placeLocal(
  first: string,
  second: string,
  audience: CliAudienceOperation[],
): Promise<void> {
  const path = await realpath(resolve(first));
  if (!(await stat(path)).isDirectory()) throw new Error(`Not a directory: ${path}`);
  const target = canonicalTarget(second);
  await withStorySync(path, async (client, service) => {
    let selected = await accountForCanonicalTarget(target, { administrator: true });
    await synchronizeOrDefer(client, service, selected.configuration.configurationTree);
    selected = await accountForCanonicalTarget(target, { administrator: true });
    const config = selected.configuration;
    const wire = new ProtocolClient(selected.host.origin, selected.host.token);
    const local = await loadLocalPlacements();
    if (local.diagnostics.length) throw new Error(`placements.yaml is invalid: ${local.diagnostics[0]!.message}`);
    const existing = local.placements.find((placement) => placement.path === path);
    let tree = existing?.tree;
    const isNew = tree === undefined;
    const rootPath = selected.host.placement ? new URL(selected.host.placement.account).pathname.replace(/\/$/, "") : null;
    if (existing) {
      if (existing.configurationTree !== config.configurationTree || existing.host !== placementHost(selected).host) {
        throw new Error(`${path} is already placed through a different host account`);
      }
      const current = await wire.descriptor(existing.tree).catch(() => null);
      if (current?.tree.canonical && current.tree.canonical.path !== target.canonicalPath) {
        throw new Error(`${path} already has a different canonical URL`);
      }
    } else if (rootPath === target.canonicalPath) {
      // The placement root: declared by the claim, activated here with the folder's content.
      const { account } = await wire.placementAccount();
      if (account.placementRoot.tree) {
        throw new Error(`${target.supplied} is already active; place it with \`story place ${target.supplied} <local-path>\``);
      }
      if (audience.length) throw new Error("The placement root keeps its own access rules; edit them after placing it");
      tree = account.placementRoot.id;
      await addLocalPlacement({ configurationTree: config.configurationTree, path, tree, ...placementHost(selected) });
      await waitForLocalPlacement(client, tree, config.configurationTree, path);
    } else {
      // Until the placement root is active nothing resolves below it, so a
      // new tree there would have no parent to mount it.
      if (rootPath !== null && !(await wire.placementAccount()).account.placementRoot.tree) {
        throw new Error(`Place a folder at ${selected.host.placement!.account} first; trees below it can be placed once it is active`);
      }
      tree = generateOverstoryID("tr");
      const rules = await accessRulesFor(wire, initialAudience(audience, target));
      const { parent, name } = await mountPoint(wire, target.canonicalPath);
      // Declare the tree with its configuration, mount it where the URL says,
      // then let Story Sync activate it with the folder's content.
      await wire.declareTree(tree, snapshotTreeConfig({
        access: [{ who: { profile: config.profile }, allow: ["admin"] }, ...rules.map(resourceRule)],
        mounts: {},
      }));
      await editMounts(client, selected, wire, parent, (mounts) => {
        if (mounts[name]) throw new Error(`${target.supplied} is already mounted`);
        return { ...mounts, [name]: tree! };
      });
      await addLocalPlacement({ configurationTree: config.configurationTree, path, tree, ...placementHost(selected) });
      await waitForLocalPlacement(client, tree, config.configurationTree, path);
    }
    if (tree && !isNew && audience.length) {
      // Subjects resolve before the one configuration edit that applies them in order.
      const changes: Array<{ clear: true } | { rule: ResourceAccessRule; remove: boolean }> = [];
      for (const operation of audience) {
        if (operation.kind === "clear") { changes.push({ clear: true }); continue; }
        const subject = accessSubject(operation.subject, target);
        const normalized = subject.kind === "everyone" ? { kind: "everyone" as const }
          : { kind: "profile" as const, tree: (await wire.resolve(new URL(subject.locator).pathname)).ref.tree };
        changes.push({ rule: resourceRule({ subject: normalized, access: operation.access === "write" ? "write" : "read" }), remove: operation.access === "none" });
      }
      await editRemoteTreeConfig(wire, tree, (values) => {
        let access = [...values.access];
        for (const change of changes) {
          if ("clear" in change) { access = access.filter((rule) => rule.allow.includes("admin")); continue; }
          access = access.filter((rule) => rule.allow.includes("admin") || resourceRuleKey(rule) !== resourceRuleKey(change.rule));
          if (!change.remove) access.push(change.rule);
        }
        return { ...values, access };
      });
    }
    if (isNew && audience.length === 0 && rootPath !== target.canonicalPath) {
      console.warn(`Warning: no audience options supplied; created ${target.supplied} with private access.`);
    }
    const pushed = await synchronizeOrDefer(client, service, config.configurationTree);
    if (!pushed) console.warn(`Warning: ${selected.host.origin} is unreachable; the placement is saved and Story Sync will push it when the account reconnects.`);
    console.log(`${target.supplied} ↔ ${path}`);
  });
}

async function placeCommand(args: string[]): Promise<void> {
  const { operands, audience, readOnly } = placeArguments(args);
  if (operands.length !== 2) usage();
  const [first, second] = operands as [string, string];
  const firstIsURL = CANONICAL_INPUT.test(first);
  if (readOnly) {
    if (!firstIsURL || audience.length) throw new Error("story place --read-only takes a canonical URL and a local path, and no audience options");
    await placeReadOnly(first, second);
    return;
  }
  if (!firstIsURL) {
    await placeLocal(first, second, audience);
    return;
  }
  if (audience.length) throw new Error("The remote-to-local place form does not take audience options");
  const target = canonicalTarget(first);
  const requestedDestination = resolve(second);
  await mkdir(dirname(requestedDestination), { recursive: true });
  const destination = await realpath(requestedDestination).catch(async () =>
    join(await realpath(dirname(requestedDestination)), basename(requestedDestination))
  );
  await withStorySync(dirname(destination), async (client, service) => {
    let selected = await accountForCanonicalTarget(target, { administrator: false });
    await service.synchronizeNow(selected.configuration.configurationTree);
    selected = await accountForCanonicalTarget(target, { administrator: false });
    const remote = await new ProtocolClient(selected.host.origin, selected.host.token).resolve(target.canonicalPath);
    const descriptor = remote.enclosingTree;
    if (!descriptor?.canonical) throw new Error("Server resolution omitted its canonical tree");
    if (descriptor.canonical.path !== target.canonicalPath) {
      throw new Error(`${canonicalHTTPURL(descriptor.canonical)} is the tree at that address, not ${target.supplied}`);
    }
    await addLocalPlacement({
      configurationTree: selected.configuration.configurationTree,
      path: destination,
      tree: descriptor.id,
      ...placementHost(selected),
    });
    // Synchronization explicitly reloads placements before materializing the tree.
    // Do not depend on delivery of a filesystem notification to adopt this write.
    await service.synchronizeNow(selected.configuration.configurationTree);
    await waitForLocalPlacement(client, descriptor.id, selected.configuration.configurationTree, destination);
    console.log(`${canonicalOverstoryLocator(descriptor.canonical)} ↔ ${destination} (${descriptor.access})`);
  });
}

/**
 * Follow a tree this profile can read, at any host, into a local folder that
 * never publishes (placements.yaml `access: read`). Story Sync reads it with
 * the account there if the profile has one, else a visitor session
 * (accounts §5.6), else as anyone.
 */
async function placeReadOnly(url: string, path: string): Promise<void> {
  const target = canonicalTarget(url);
  const requestedDestination = resolve(path);
  await mkdir(dirname(requestedDestination), { recursive: true });
  const destination = await realpath(requestedDestination).catch(async () =>
    join(await realpath(dirname(requestedDestination)), basename(requestedDestination))
  );
  const records = await HostAccountStore.list();
  const home = records.length === 1 ? records[0]! : records.find((record) => record.origin === target.endpoint);
  if (!home) throw new Error(records.length ? "Several accounts are claimed here; none is at that host to choose by" : "No profile is claimed on this device; run `story me create` first");
  await withStorySync(dirname(destination), async (client, service) => {
    const selected = await accountProtocolClient({ configurationTree: home.configurationTree, origin: target.endpoint }, { timeoutMs: 60_000 });
    const remote = await selected.client.resolve(target.canonicalPath);
    const descriptor = remote.enclosingTree;
    if (!descriptor?.canonical) throw new Error("Server resolution omitted its canonical tree");
    if (descriptor.canonical.path !== target.canonicalPath) {
      throw new Error(`${canonicalHTTPURL(descriptor.canonical)} is the tree at that address, not ${target.supplied}`);
    }
    await addLocalPlacement({
      configurationTree: home.configurationTree,
      path: destination,
      tree: descriptor.id,
      ...(target.endpoint !== home.origin ? { host: target.endpoint } : {}),
      readOnly: true,
    });
    await service.synchronizeNow(home.configurationTree);
    await waitForLocalPlacement(client, descriptor.id, home.configurationTree, destination);
    const how = selected.visitor ? "as a visitor" : selected.authenticated ? "with your account there" : "as anyone";
    console.log(`${canonicalOverstoryLocator(descriptor.canonical)} → ${destination} (read only, ${how})`);
  });
}

function parseDuration(value: string | undefined, fallbackMs = 5 * 60_000): number {
  if (value === undefined) return fallbackMs;
  const match = /^(\d+)(ms|s|m)?$/.exec(value);
  if (!match) usageError(`Invalid duration: ${value}`);
  const amount = Number(match[1]);
  const multiplier = match[2] === "m" ? 60_000 : match[2] === "s" ? 1_000 : 1;
  const result = amount * multiplier;
  if (!Number.isSafeInteger(result) || result <= 0) usageError(`Invalid duration: ${value}`);
  return result;
}

async function withEnvironment<T>(
  values: Record<string, string | undefined>,
  run: () => Promise<T>,
): Promise<T> {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try { return await run(); }
  finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

interface CloudBundleCreateArguments {
  label?: string;
  placements: Array<{ canonicalURL: string; relativePath: string }>;
}

function cloudBundleCreateArguments(args: string[]): CloudBundleCreateArguments {
  let label: string | undefined;
  const placements: Array<{ canonicalURL: string; relativePath: string }> = [];
  for (let index = 0; index < args.length;) {
    const arg = args[index];
    if (arg === "--name") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) usageError("--name requires a label");
      label = value;
      index += 2;
    } else if (arg === "--place") {
      const canonicalURL = args[index + 1];
      const relativePath = args[index + 2];
      if (!canonicalURL || !relativePath || canonicalURL.startsWith("--") || relativePath.startsWith("--")) {
        usageError("--place requires a canonical URL and relative path");
      }
      placements.push({ canonicalURL, relativePath });
      index += 3;
    } else {
      usageError(`Unknown agent create option: ${arg}`);
    }
  }
  if (!placements.length) usageError("Agent bundle creation requires at least one --place URL path pair");
  const normalizedPaths = validateCloudPlacementPaths(placements.map((placement) => placement.relativePath));
  return {
    ...(label ? { label } : {}),
    placements: placements.map((placement, index) => ({ ...placement, relativePath: normalizedPaths[index]! })),
  };
}

async function createCloudBundle(args: string[]): Promise<void> {
  const requested = cloudBundleCreateArguments(args);
  await withStorySync(process.cwd(), async (client, service) => {
    let selected: SelectedHostAccount | undefined;
    const placements: CloudBundlePlacement[] = [];
    for (const requestedPlacement of requested.placements) {
      const target = canonicalTarget(requestedPlacement.canonicalURL);
      const candidate = await accountForCanonicalTarget(target, { administrator: true });
      if (!selected) {
        await service.synchronizeNow(candidate.configuration.configurationTree);
        selected = await accountForCanonicalTarget(target, { administrator: true });
      } else if (candidate.configuration.configurationTree !== selected.configuration.configurationTree) {
        throw new Error("An agent bundle may contain trees from only one Story account");
      }
      if (candidate.host.placement) throw new Error("An agent bundle covers trees at the profile's home host only, not a placement host");
      if (target.endpoint !== selected.connection.record.origin) {
        throw new Error("An agent bundle may target only one host");
      }
      const wire = new ProtocolClient(selected.connection.record.origin, selected.connection.accountToken);
      const resolution = await wire.resolve(target.canonicalPath);
      const descriptor = resolution.enclosingTree;
      if (!descriptor || resolution.ref.tree !== descriptor.id || resolution.ref.path !== "/") {
        throw new Error(`${requestedPlacement.canonicalURL} must identify the root of a tree`);
      }
      if (descriptor.access !== "write") throw new Error(`${requestedPlacement.canonicalURL} is not writable by this account`);
      if (!descriptor.canonical || canonicalHTTPURL(descriptor.canonical) !== `${target.endpoint}${target.canonicalPath}`) {
        throw new Error(`${requestedPlacement.canonicalURL} is not the tree's canonical URL`);
      }
      placements.push({
        treeID: descriptor.id,
        canonicalURL: canonicalHTTPURL(descriptor.canonical),
        relativePath: requestedPlacement.relativePath,
      });
    }
    if (!selected) throw new Error("Agent bundle has no account");
    if (new Set(placements.map((placement) => placement.treeID)).size !== placements.length) {
      throw new Error("An agent bundle may not place the same tree more than once");
    }
    // One tree placed at its own name is all an agent link can say, and then the link is the whole bundle.
    const only = placements.length === 1 ? placements[0]! : undefined;
    const code = only && only.relativePath === agentLinkPath(new URL(only.canonicalURL).pathname) ? generateAgentCode() : undefined;
    const { deviceID, deviceKeySeed } = code ? agentDevice(code) : { deviceID: generateOverstoryID("dv"), deviceKeySeed: generateDeviceKeySeed() };
    const bundleID = code ? agentBundleID(deviceID) : `cb_${crypto.randomUUID().replaceAll("-", "")}`;
    const label = (requested.label ?? `Agent bundle ${bundleID.slice(-8)}`).trim();
    if (!label || label.length > 100) throw new Error("Agent bundle name must be from 1 through 100 characters");
    const createdAt = new Date().toISOString();
    const payload: CloudBundlePayload = {
      version: 2,
      bundleID,
      label,
      createdAt,
      origin: selected.connection.record.origin,
      account: selected.connection.record.account,
      accountID: selected.connection.record.accountID,
      configurationTree: selected.configuration.configurationTree,
      profileTree: selected.connection.record.profileTree,
      deviceID,
      deviceKeySeed,
      placements,
    };
    const encoded = code ? buildAgentLink(only!.canonicalURL, code) : encodeCloudBundle(payload);
    const wire = new ProtocolClient(selected.connection.record.origin, selected.connection.accountToken);
    const pairing = await wire.createPairing();
    await new ProtocolClient(selected.connection.record.origin).claimPairing(pairing.id, pairing.secret, {
      id: deviceID,
      label,
      key: deviceKeyFromSeed(deviceKeySeed),
    });
    await saveCloudBundleRecord({
      bundleID,
      label,
      createdAt,
      origin: payload.origin,
      account: payload.account,
      configurationTree: payload.configurationTree,
      deviceID,
      trees: placements.map((placement) => placement.treeID),
    });
    console.error(`Created reusable agent bundle ${bundleID} (${placements.length} placement${placements.length === 1 ? "" : "s"}).`);
    console.log(encoded);
  });
}

async function listCloudBundles(json: boolean): Promise<void> {
  const bundles = await loadCloudBundles();
  if (json) {
    console.log(JSON.stringify({ schemaVersion: 1, bundles }, null, 2));
    return;
  }
  if (!bundles.length) {
    console.log("No agent bundles have been created on this device.");
    return;
  }
  for (const bundle of bundles) {
    console.log(`${bundle.bundleID}  ${bundle.revokedAt ? "revoked" : "active"}  ${bundle.label}  ${bundle.account}`);
  }
}

async function revokeCloudBundle(bundleID: string): Promise<void> {
  const record = (await loadCloudBundles()).find((candidate) => candidate.bundleID === bundleID);
  if (!record) throw new Error(`Unknown local agent bundle: ${bundleID}`);
  if (record.revokedAt) {
    console.log(`Agent bundle ${bundleID} was already revoked.`);
    return;
  }
  await withStorySync(process.cwd(), async (client, service) => {
    await service.synchronizeNow(record.configurationTree);
    const configuration = (await loadProfileConfigurations()).find((candidate) => candidate.configurationTree === record.configurationTree);
    if (!configuration?.configuration || !configuration.devices || !configuration.currentDevice) {
      throw new Error(`Account ${record.configurationTree} is unavailable or invalid`);
    }
    if (!configuration.currentDevice.administrator) {
      throw new Error(`The current device is not an administrator of account ${record.configurationTree}`);
    }
    if (configuration.devices[record.deviceID]) {
      await editProfileConfigurationYAML(
        client,
        record.configurationTree,
        (document) => { document.deleteIn([record.deviceID]); },
        (source) => { parseAccountDevicesConfiguration(source); },
        "devices.yaml",
      );
      await service.synchronizeNow(record.configurationTree);
    }
    const revokedAt = new Date().toISOString();
    await updateCloudBundleRecord(bundleID, { revokedAt });
    console.log(`Revoked agent bundle ${bundleID}.`);
  });
}

interface CloudStartOptions { bundle: string; root: string; timeoutMs: number; json: boolean }

/** `story agent start`'s options: a bundle, a run request, or both. */
interface AgentStartOptions extends Omit<CloudStartOptions, "bundle"> { bundle?: string; task?: string }

function cloudStartArguments(args: string[], verb: "run"): CloudStartOptions;
function cloudStartArguments(args: string[], verb?: "start"): AgentStartOptions;
function cloudStartArguments(args: string[], verb: "start" | "run" = "start"): AgentStartOptions {
  let bundleArgument: string | undefined;
  let root = process.cwd();
  let timeout: string | undefined;
  let task: string | undefined;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--root" || arg === "--timeout" || (arg === "--task" && verb === "start")) {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) usageError(`${arg} requires a value`);
      if (arg === "--root") root = value;
      else if (arg === "--task") task = value;
      else timeout = value;
      index += 1;
    } else if (arg === "--json" && verb === "start") json = true;
    else if (arg.startsWith("--")) usageError(`Unknown agent ${verb} option: ${arg}`);
    else if (bundleArgument) usageError(`story agent ${verb} accepts at most one bundle argument`);
    else bundleArgument = arg;
  }
  const environmentBundle = process.env.STORY_CLOUD_BUNDLE;
  if (bundleArgument && environmentBundle) usageError("Supply the agent bundle as an argument or STORY_CLOUD_BUNDLE, not both");
  const bundle = bundleArgument ?? environmentBundle;
  if (verb === "start") {
    if (task && process.env.STORY_RUN_REQUEST) usageError("Supply the run request as --task or STORY_RUN_REQUEST, not both");
    task ??= process.env.STORY_RUN_REQUEST;
    // A task alone runs in a tree already placed on this machine.
    if (!bundle && !task) usageError("story agent start requires a bundle argument, STORY_CLOUD_BUNDLE, or --task");
    return { ...(bundle ? { bundle } : {}), ...(task ? { task } : {}), root: resolve(root), timeoutMs: parseDuration(timeout), json };
  }
  if (!bundle) usageError(`story agent ${verb} requires a bundle argument or STORY_CLOUD_BUNDLE`);
  return { bundle, root: resolve(root), timeoutMs: parseDuration(timeout), json };
}

/** A run request as `--task` or STORY_RUN_REQUEST gives it: its JSON, or `@` and a file holding it. */
async function readRunRequest(value: string): Promise<RunRequest> {
  const text = value.startsWith("@") ? await readFile(resolve(value.slice(1)), "utf8") : value;
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error("The run request is not JSON"); }
  return decodeRunRequest(parsed);
}

async function directoryIsEmpty(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    return info.isDirectory() && !info.isSymbolicLink() && (await readdir(path)).length === 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

async function prepareCloudDataHome(payload: CloudBundlePayload, session: CloudSessionRecord): Promise<void> {
  await withEnvironment({ STORY_HOME: session.dataHome, STORY_CREDENTIAL_STORE: "file" }, async () => {
    const opened = await openDeviceSession(payload.origin, payload.profileTree, payload.deviceID, payload.deviceKeySeed);
    const wire = new ProtocolClient(payload.origin, opened.token, { timeoutMs: 60_000 });
    const account = await wire.account();
    if (
      account.account.id !== payload.accountID
      || account.account.configuration.id !== payload.configurationTree
      || account.account.profileTree !== payload.profileTree
      || account.account.device?.id !== payload.deviceID
    ) throw new Error("Agent bundle authorization does not match its account identity");
    const configuration = (await wire.descriptor(payload.configurationTree)).tree;
    const snapshot = await wire.snapshot(payload.configurationTree, configuration.root);
    const checkout = configurationCheckoutPath(payload.configurationTree);
    await materializeTree(checkout, snapshot.root, (hash) => {
      const bytes = snapshot.objects.get(hash);
      if (!bytes) throw new Error(`Account configuration snapshot is missing ${hash}`);
      return Promise.resolve(bytes);
    });
    await new HostAccountStore(payload.configurationTree).setDeviceKey(payload.deviceKeySeed, {
      origin: payload.origin,
      account: payload.account,
      accountID: payload.accountID,
      profileTree: payload.profileTree,
      deviceID: payload.deviceID,
      configurationRef: configuration.root,
      configurationUpdate: configuration.update,
    });
    await saveCurrentAccountDeviceID(payload.configurationTree, payload.deviceID);
    for (const placement of session.placements) {
      await addLocalPlacement({
        configurationTree: payload.configurationTree,
        path: placement.path,
        tree: placement.treeID,
      });
    }
  });
}

async function liveCloudStatus(session: CloudSessionRecord) {
  if (!session.origin) return null;
  try {
    const status = await new StorySyncRESTClient({ baseURL: session.origin, dataHome: session.dataHome }).status();
    return status.service === "story-sync" && status.protocolVersion === "v1" && status.instanceID === session.instanceID ? status : null;
  } catch { return null; }
}

function processIsAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch { return false; }
}

async function stopOwnedProcess(pid: number): Promise<void> {
  try { process.kill(pid, "SIGTERM"); } catch { return; }
  const gracefulDeadline = Date.now() + 5_000;
  while (Date.now() < gracefulDeadline && processIsAlive(pid)) await Bun.sleep(50);
  if (!processIsAlive(pid)) return;
  try { process.kill(pid, "SIGKILL"); } catch { return; }
  const forcedDeadline = Date.now() + 1_000;
  while (Date.now() < forcedDeadline && processIsAlive(pid)) await Bun.sleep(25);
}

async function waitForCloudOrigin(session: CloudSessionRecord, deadline: number): Promise<string> {
  const stdoutPath = join(cloudSessionDirectory(session.sessionID), "story-sync.stdout.log");
  while (Date.now() < deadline) {
    const source = await readFile(stdoutPath, "utf8").catch(() => "");
    const url = source.match(/https?:\/\/127\.0\.0\.1:\d+/)?.[0];
    if (url) {
      try {
        const status = await new StorySyncRESTClient({ baseURL: url, dataHome: session.dataHome }).status();
        if (status.instanceID === session.instanceID && status.runtimeKind === "cloud") return url;
      } catch {}
    }
    await Bun.sleep(50);
  }
  throw new Error("Cloud Story Sync did not become reachable before the timeout");
}

/** The cloud session's account at its host: the session token its device key opened there. */
interface CloudAccountAccess { origin: string; token: string; configurationTree: string }

/** The cloud session's account access, from the session's own data home. */
async function cloudAccountAccess(session: CloudSessionRecord): Promise<CloudAccountAccess> {
  const connection = await withEnvironment(
    { STORY_HOME: session.dataHome, STORY_CREDENTIAL_STORE: "file" },
    () => new HostAccountStore(session.configurationTree).get(),
  );
  if (!connection) throw new Error("Cloud session credential is unavailable");
  return { origin: connection.record.origin, token: connection.accountToken, configurationTree: connection.record.configurationTree };
}

async function cloudPlacementsReady(
  session: CloudSessionRecord,
  payload: CloudAccountAccess,
): Promise<{ ready: boolean; reason?: string }> {
  if (!session.origin) return { ready: false, reason: "Story Sync has no recorded origin" };
  const client = new StorySyncRESTClient({ baseURL: session.origin, dataHome: session.dataHome });
  const local = (await client.trees()).snapshot;
  const wire = new ProtocolClient(payload.origin, payload.token, { timeoutMs: 60_000 });
  for (const target of session.placements) {
    const descriptor = local.find((candidate) =>
      candidate.id === target.treeID
      && candidate.configurationTree === payload.configurationTree
      && candidate.osPath === target.path
    );
    if (!descriptor) return { ready: false, reason: `${target.relativePath} has not been placed` };
    if (descriptor.missing) return { ready: false, reason: `${target.relativePath} is missing` };
    if (descriptor.access !== "write") return { ready: false, reason: `${target.relativePath} is not writable` };
    if (descriptor.sync !== "idle") return { ready: false, reason: `${target.relativePath} is ${descriptor.sync ?? "not synchronized"}` };
    const remote = (await wire.descriptor(target.treeID)).tree;
    if (remote.access !== "write") return { ready: false, reason: `${target.relativePath} lost write access` };
    if (descriptor.update !== remote.update) return { ready: false, reason: `${target.relativePath} has not accepted the current host update` };
    // Roots only; the folder's ignored, untracked content is not part of its tree.
    const skip = membershipSkip(await loadIgnorePolicy(target.path),
      trackedEntries(remote.root as ObjectHash, (hash) => wire.object(target.treeID, hash)));
    const load = (hash: ObjectHash) => wire.object(target.treeID, hash);
    const localSnapshot = await snapshotDirectory(target.path, new Map(), [], undefined, undefined, skip,
      await treeHoldsPages(remote.root as ObjectHash, load));
    if (localSnapshot.root !== remote.root) return { ready: false, reason: `${target.relativePath} differs from the host` };
  }
  return { ready: true };
}

async function waitForCloudPlacements(
  session: CloudSessionRecord,
  payload: CloudAccountAccess,
  deadline: number,
): Promise<void> {
  let reason = "placements are not ready";
  while (Date.now() < deadline) {
    try {
      const result = await cloudPlacementsReady(session, payload);
      if (result.ready) return;
      reason = result.reason ?? reason;
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error);
    }
    await Bun.sleep(100);
  }
  throw new Error(`Cloud placements did not become ready before the timeout: ${reason}`);
}

interface CloudStartResult {
  schemaVersion: 1;
  ready: true;
  sessionID: string;
  bundleID: string;
  root: string;
  origin: string;
  /** The data home the session's Story Sync answers for. */
  dataHome: string;
  /** The agent's name in presence: the bundle's label. */
  label: string;
  placements: CloudSessionRecord["placements"];
  /** What an agent needs to know to work in the checkout, as `story agent start` prints it. */
  instructions: string;
}

/** How this command was run, so the instructions name a command that works where they are read. */
function storyInvocation(): string {
  return /[\\/]@ovst[\\/]cli(-[\w-]+)?[\\/]/.test(compiledExecutable ? process.execPath : process.argv[1] ?? "") ? "npx @ovst/cli" : "story";
}

/** The working rules for an agent session, said once where the agent will read them: start's output. */
function agentInstructions(root: string, placements: CloudSessionRecord["placements"], presence?: { label: string; hooks: boolean }): string {
  const story = storyInvocation();
  const folders = placements.map((placement) => `  ${placement.path}  (${placement.canonicalURL})`).join("\n");
  return [
    `Checked out and syncing:`,
    folders,
    ``,
    `Working here:`,
    `- Read and edit the Markdown files in ${placements.length === 1 ? "that folder" : "those folders"} with your own tools. Changes sync while the session runs.`,
    `- Keep the "id:" line in each page's frontmatter, and leave links between pages as they are written.`,
    `- Files outside ${placements.length === 1 ? "that folder" : "those folders"} are not synced.`,
    `- When you have finished writing, run:`,
    `    ${story} agent finish --root ${root}`,
    `  and wait for it to succeed. Until then your last edits may exist only on this machine.`,
    `- If something seems stuck, "${story} status ${root}" says what is held back.`,
    ...(presence ? [
      ``,
      `People may be reading these pages in Story while you work; Story shows you to them as "${presence.label}".`,
      `- Say what you are doing, in a few words, whenever it changes: ${story} agent status "merging duplicates"`,
      `- When you are weighing one part of a page, point at it: ${story} agent status "checking which are dairy" --at "oat milk"`,
      `- When you are done, say what you did in one line: ${story} agent done "Merged 3 duplicates"`,
      presence.hooks
        ? `- Claude Code's hooks for this are installed, so your reads and edits also move your place on the page.`
        : `- Run these from inside a synced folder.`,
    ] : []),
  ].join("\n");
}

/**
 * `story agent start`: check a bundle's folders out, or start a run request
 * (Agents 002), or both: a run in a fresh checkout. A run goes to the Story
 * Sync serving the tree's folder, which shows the agent with the run's ID and
 * marks the task block done when the agent says done.
 */
async function startCloud(args: string[]): Promise<void> {
  const options = cloudStartArguments(args);
  const request = options.task ? await readRunRequest(options.task) : undefined;
  const result = options.bundle ? await startCloudSession({ ...options, bundle: options.bundle }) : undefined;
  let run: AgentRunView | undefined;
  if (request) {
    const client = result
      ? new StorySyncRESTClient({ baseURL: result.origin, dataHome: result.dataHome })
      : new StorySyncRESTClient({ baseURL: process.env.STORY_SYNC_URL ?? await storySyncOrigin() });
    const label = result?.label ?? agentLabel(process.env.STORY_AGENT_LABEL ?? "Claude");
    run = await client.startRun(request, { external: true, label });
  }
  if (options.json) console.log(JSON.stringify({ ...(result ?? { schemaVersion: 1 }), ...(run ? { run } : {}) }, null, 2));
  else {
    if (result) console.log(result.instructions);
    if (run) {
      if (result) console.log("");
      console.log(run.prompt ?? run.task);
      if (run.state !== "running") console.log(`\n(Run ${run.id} is ${run.state}${run.result ? `: ${run.result}` : ""}.)`);
    }
  }
}

/** Where an agent link places its tree under the root: the last name of its address. */
function agentLinkPath(canonicalPath: string): string {
  return decodeURIComponent(canonicalPath).split("/").filter(Boolean).at(-1) ?? "";
}

/**
 * What a bundle argument stands for. An agent link carries only a code: its
 * device signs in by its own ID, and the host says whose it is and what the
 * link's address names.
 */
async function resolveAgentBundle(input: string): Promise<CloudBundlePayload> {
  const link = parseAgentLink(input);
  if (!link) return decodeCloudBundle(input);
  const { deviceID, deviceKeySeed } = agentDevice(link.code);
  const { session, profileTree } = await openDeviceSessionByDevice(link.origin, deviceID, deviceKeySeed);
  const wire = new ProtocolClient(link.origin, session.token, { timeoutMs: 60_000 });
  const { account } = await wire.account();
  if (!account.handle) throw new Error("The agent link's account has no address on its host");
  const resolution = await wire.resolve(link.canonicalPath);
  const descriptor = resolution.enclosingTree;
  if (!descriptor || resolution.ref.tree !== descriptor.id || resolution.ref.path !== "/") {
    throw new Error(`${link.canonicalURL} must identify the root of a tree`);
  }
  return {
    version: 2,
    bundleID: agentBundleID(deviceID),
    label: account.device?.label ?? "Agent",
    createdAt: new Date(0).toISOString(),
    origin: link.origin,
    account: `${link.origin}/~${account.handle}`,
    accountID: account.id,
    configurationTree: account.configuration.id,
    profileTree,
    deviceID,
    deviceKeySeed,
    placements: [{ treeID: descriptor.id, canonicalURL: link.canonicalURL, relativePath: agentLinkPath(link.canonicalPath) }],
  };
}

async function startCloudSession(options: CloudStartOptions): Promise<CloudStartResult> {
  const payload = await resolveAgentBundle(options.bundle);
  delete process.env.STORY_CLOUD_BUNDLE;
  await mkdir(options.root, { recursive: true });
  const root = await realpath(options.root);
  let session = await cloudSessionForRoot(root);
  const existing = Boolean(session);
  if (session && session.bundleID !== payload.bundleID) {
    throw new Error(`${root} already belongs to agent bundle ${session.bundleID}`);
  }
  if (!session) {
    for (const placement of payload.placements) {
      const destination = cloudPlacementPath(root, placement.relativePath);
      if (!await directoryIsEmpty(destination)) throw new Error(`Cloud placement destination is not empty: ${destination}`);
    }
    const sessionID = `cs_${crypto.randomUUID().replaceAll("-", "")}`;
    const now = new Date().toISOString();
    session = {
      version: 1,
      sessionID,
      bundleID: payload.bundleID,
      configurationTree: payload.configurationTree,
      root,
      dataHome: join(cloudSessionDirectory(sessionID), "data"),
      instanceID: crypto.randomUUID(),
      phase: "preparing",
      createdAt: now,
      updatedAt: now,
      placements: payload.placements.map((placement) => ({
        ...placement,
        path: cloudPlacementPath(root, placement.relativePath),
      })),
    };
    await saveCloudSession(session);
  }
  const deadline = Date.now() + options.timeoutMs;
  let spawnedPID: number | undefined;
  try {
    const attached = await liveCloudStatus(session);
    if (!attached && processIsAlive(session.pid)) {
      throw new Error("The recorded cloud Story Sync process is alive but its instance cannot be verified; refusing to start a second writer");
    }
    if (!attached) {
      await prepareCloudDataHome(payload, session);
      const directory = cloudSessionDirectory(session.sessionID);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const stdoutPath = join(directory, "story-sync.stdout.log");
      const stderrPath = join(directory, "story-sync.stderr.log");
      await Promise.all([
        writeFile(stdoutPath, "", { mode: 0o600 }),
        writeFile(stderrPath, "", { mode: 0o600 }),
      ]);
      session = { ...session, instanceID: crypto.randomUUID(), phase: "preparing", updatedAt: new Date().toISOString(), origin: undefined, pid: undefined, lastError: undefined };
      await saveCloudSession(session);
      const child = Bun.spawn([
        ...storyCommand(),
        "__cloud-story-sync",
        "--control",
        "--port", "0",
        "--runtime-kind", "cloud",
        "--instance-id", session.instanceID,
      ], {
        cwd: root,
        env: { ...process.env, STORY_HOME: session.dataHome, STORY_CREDENTIAL_STORE: "file" },
        stdout: Bun.file(stdoutPath),
        stderr: Bun.file(stderrPath),
        // Its own process group: a caller that ends this command's group must not end the session's writer.
        detached: true,
      });
      spawnedPID = child.pid;
      child.unref();
      const origin = await waitForCloudOrigin(session, deadline);
      session = { ...session, origin, pid: child.pid, updatedAt: new Date().toISOString() };
      await saveCloudSession(session);
    }
    const origin = session.origin;
    if (!origin) throw new Error("Cloud Story Sync origin is unavailable");
    const client = new StorySyncRESTClient({ baseURL: origin, dataHome: session.dataHome });
    await client.synchronizeNow(payload.configurationTree);
    await waitForCloudPlacements(session, await cloudAccountAccess(session), deadline);
    session = { ...session, phase: "ready", updatedAt: new Date().toISOString(), lastError: undefined };
    await saveCloudSession(session);
    // Show this agent in presence under the bundle's own label: Claude Code
    // reports through hooks; any agent can say status and done itself.
    const label = agentLabel(payload.label);
    let hooks = false;
    if (hasClaudeCode()) {
      try { await installAgentPresence({ command: storyInvocation(), agent: label }); hooks = true; } catch { hooks = false; }
    }
    return {
      schemaVersion: 1, ready: true, sessionID: session.sessionID, bundleID: session.bundleID, root, origin, dataHome: session.dataHome, label,
      placements: session.placements, instructions: agentInstructions(root, session.placements, { label, hooks }),
    };
  } catch (error) {
    if (spawnedPID) await stopOwnedProcess(spawnedPID);
    const message = error instanceof Error ? error.message : String(error);
    await saveCloudSession({ ...session, phase: "preparing", updatedAt: new Date().toISOString(), lastError: message });
    if (!existing) console.error(`Cloud session ${session.sessionID} was retained for retry.`);
    throw error;
  }
}

function cloudFinishArguments(args: string[]): { root: string; timeoutMs: number; json: boolean } {
  let root = process.cwd();
  let timeout: string | undefined;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--root" || arg === "--timeout") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) usageError(`${arg} requires a value`);
      if (arg === "--root") root = value;
      else timeout = value;
      index += 1;
    } else if (arg === "--json") json = true;
    else usageError(`Unknown agent finish option: ${arg}`);
  }
  return { root: resolve(root), timeoutMs: parseDuration(timeout), json };
}

async function finishCloud(args: string[]): Promise<void> {
  const options = cloudFinishArguments(args);
  const result = await finishCloudSession(options);
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else console.log(`Cloud session ${result.sessionID} synchronized and stopped.`);
}

async function finishCloudSession(options: { root: string; timeoutMs: number }) {
  let session = await cloudSessionForPath(options.root);
  if (!session || session.phase === "finished") throw new Error(`No active cloud session contains ${options.root}`);
  if (!session.origin || !session.pid || !await liveCloudStatus(session)) {
    await saveCloudSession({ ...session, phase: "needs-sync", updatedAt: new Date().toISOString(), lastError: "Cloud Story Sync is not running" });
    throw new Error("Cloud Story Sync is not running; retained session state requires recovery before it can finish");
  }
  session = { ...session, phase: "draining", updatedAt: new Date().toISOString(), lastError: undefined };
  await saveCloudSession(session);
  try {
    const deadline = Date.now() + options.timeoutMs;
    const payload = await cloudAccountAccess(session);
    const client = new StorySyncRESTClient({ baseURL: session.origin, dataHome: session.dataHome });
    await client.synchronizeNow(payload.configurationTree);
    await waitForCloudPlacements(session, payload, deadline);
    if (!await liveCloudStatus(session)) throw new Error("Cloud Story Sync instance changed before shutdown");
    const pid = session.pid;
    if (!pid) throw new Error("Cloud Story Sync PID is unavailable");
    process.kill(pid, "SIGTERM");
    while (Date.now() < deadline && await liveCloudStatus(session)) await Bun.sleep(50);
    if (await liveCloudStatus(session)) throw new Error("Cloud Story Sync did not stop before the timeout");
    await rm(session.dataHome, { recursive: true, force: true });
    session = { ...session, phase: "finished", updatedAt: new Date().toISOString(), lastError: undefined };
    await saveCloudSession(session);
    return { schemaVersion: 1, finished: true, sessionID: session.sessionID, root: session.root, placements: session.placements };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await saveCloudSession({ ...session, phase: "needs-sync", updatedAt: new Date().toISOString(), lastError: message });
    throw error;
  }
}

/**
 * `story agent run`: a cloud session around one command. The folders are
 * checked out before the command starts and drained after it exits, however
 * it exits, so a command that ends cannot leave its work behind unsent.
 */
async function runAgent(args: string[]): Promise<never> {
  const separator = args.indexOf("--");
  const options = cloudStartArguments(separator === -1 ? args : args.slice(0, separator), "run");
  let command = separator === -1 ? [] : args.slice(separator + 1);
  if (!command.length) {
    if (!process.stdin.isTTY) usageError("story agent run requires -- <command> when standard input is not a terminal");
    command = [process.env.SHELL || "/bin/sh"];
  }
  // Standard output belongs to the command; everything this command says goes to standard error.
  const started = await startCloudSession(options);
  console.error(`Story Sync is ready in ${started.root}; running ${command[0]}.`);
  let status = 1;
  let launched = false;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  // A signal sent to this command ends the command it runs; the drain below still happens.
  const forward = (signal: NodeJS.Signals) => { try { child?.kill(signal); } catch {} };
  const onInterrupt = () => forward("SIGINT");
  const onTerminate = () => forward("SIGTERM");
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  try {
    // startCloudSession removed STORY_CLOUD_BUNDLE from this environment, so the command does not inherit it.
    child = Bun.spawn(command, { cwd: started.root, env: process.env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    launched = true;
    const code = await child.exited;
    status = child.signalCode ? 128 + (osConstants.signals[child.signalCode] ?? 0) : code;
  } catch (error) {
    console.error(`Could not run ${command[0]}: ${error instanceof Error ? error.message : String(error)}`);
    status = 127;
  }
  try {
    await finishCloudSession({ root: started.root, timeoutMs: options.timeoutMs });
    console.error(`Cloud session ${started.sessionID} synchronized and stopped.`);
  } catch (error) {
    console.error(`The last changes in ${started.root} were not sent: ${error instanceof Error ? error.message : String(error)}`);
    console.error(`Run \`story agent finish --root ${JSON.stringify(started.root)}\` to send them.`);
    if (launched && status === 0) status = AGENT_RUN_UNSENT_EXIT;
  } finally {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
  }
  process.exit(status);
}

type StatusTreeCondition = "missing" | "conflict" | "declined" | "error" | "offline" | "paused" | "syncing" | "not-placed" | "up-to-date";

function statusTreeCondition(tree: Awaited<ReturnType<StorySyncRESTClient["trees"]>>["snapshot"][number]): StatusTreeCondition {
  if (tree.missing) return "missing";
  if (tree.sync === "conflict") return "conflict";
  if (tree.declined) return "declined";
  if (tree.sync === "error") return "error";
  if (tree.sync === "offline") return "offline";
  if (tree.sync === "paused") return "paused";
  if (tree.sync === "syncing") return "syncing";
  if (tree.placement === "remote" || !tree.osPath) return "not-placed";
  return "up-to-date";
}

function statusArguments(args: string[]): { locator?: string; json: boolean } {
  let locator: string | undefined;
  let json = false;
  for (const arg of args) {
    if (arg === "--json") json = true;
    else if (arg.startsWith("--")) usageError(`Unknown status option: ${arg}`);
    else if (locator) usageError("story sync status accepts at most one locator");
    else locator = arg;
  }
  return { ...(locator ? { locator } : {}), json };
}

async function statusCommand(args: string[]): Promise<void> {
  const options = statusArguments(args);
  const selectionPath = options.locator && !CANONICAL_INPUT.test(options.locator)
    ? resolve(options.locator)
    : process.cwd();
  const cloud = !process.env.STORY_SYNC_URL && !process.env.STORY_HOME
    ? await cloudSessionForPath(selectionPath)
    : null;
  const contextKind = process.env.STORY_SYNC_URL
    ? "explicit-url"
    : process.env.STORY_HOME
      ? "foreground"
      : cloud
        ? "cloud"
        : "persistent";
  const origin = process.env.STORY_SYNC_URL ?? cloud?.origin ?? await storySyncOrigin();
  const dataHome = cloud ? { dataHome: cloud.dataHome } : {};
  let liveStatus: Awaited<ReturnType<StorySyncRESTClient["status"]>> | null = null;
  let accounts: Awaited<ReturnType<StorySyncRESTClient["accounts"]>>["accounts"] = [];
  let trees: Awaited<ReturnType<StorySyncRESTClient["trees"]>>["snapshot"] = [];
  let observedThrough: string | undefined;
  let runtimeState: "running" | "stopped" | "unreachable" | "incompatible" | "not-installed" = "unreachable";
  let supervision: Awaited<ReturnType<ReturnType<typeof storyDaemonSupervisor>["status"]>> | undefined;
  const diagnostics: Array<{ code: string; message: string }> = [];
  try {
    const client = new StorySyncRESTClient({ baseURL: origin, ...dataHome });
    const status = await client.status();
    if (status.service !== "story-sync" || status.protocolVersion !== "v1" || (cloud && status.instanceID !== cloud.instanceID)) {
      runtimeState = "incompatible";
      diagnostics.push({ code: "incompatible-runtime", message: "The selected endpoint is not the expected Story Sync instance" });
    } else {
      liveStatus = status;
      runtimeState = "running";
      const [accountResult, treeResult] = await Promise.all([client.accounts(), client.trees()]);
      accounts = accountResult.accounts;
      trees = treeResult.snapshot;
      observedThrough = treeResult.observedThrough;
    }
  } catch (error) {
    diagnostics.push({ code: "unreachable-runtime", message: error instanceof Error ? error.message : String(error) });
    // Accounts are durable configuration, not daemon state: report them from
    // this data home even while its Story Sync is down.
    if (contextKind === "persistent" || contextKind === "foreground") accounts = await listLocalAccounts();
    if (contextKind === "persistent") {
      supervision = await storyDaemonSupervisor().status();
      runtimeState = supervision.state === "not-installed"
        ? "not-installed"
        : supervision.state === "stopped"
          ? "stopped"
          : "unreachable";
    } else if (cloud?.phase === "finished") runtimeState = "stopped";
  }
  if (contextKind === "persistent") supervision ??= await storyDaemonSupervisor().status().catch(() => undefined);
  const cloudPhase = cloud && runtimeState !== "running" && ["preparing", "ready", "draining"].includes(cloud.phase)
    ? "interrupted"
    : cloud?.phase;
  const decoratedTrees = trees.map((tree) => ({ ...tree, condition: statusTreeCondition(tree) }));
  let selection: Record<string, unknown> | undefined;
  if (options.locator) {
    if (!liveStatus) throw new Error(`Cannot resolve ${options.locator} because the selected Story Sync is not running`);
    const input = CANONICAL_INPUT.test(options.locator) ? options.locator : resolve(options.locator);
    const resolved = await new StorySyncRESTClient({ baseURL: origin, ...dataHome }).resolve(input);
    const tree = resolved.enclosingTree
      ? decoratedTrees.find((candidate) => candidate.id === resolved.enclosingTree!.id)
      : undefined;
    selection = {
      input: options.locator,
      ref: resolved.ref,
      historical: resolved.historical,
      ...(tree ? { tree, condition: tree.condition } : { condition: CANONICAL_INPUT.test(options.locator) ? "not-placed" : "not-applicable" }),
    };
  }
  const inScopeTrees = cloud
    ? decoratedTrees.filter((tree) => cloud.placements.some((target) => target.treeID === tree.id && target.path === tree.osPath))
    : decoratedTrees.filter((tree) => tree.placement !== "remote");
  const ready = runtimeState === "running"
    && (!cloud || cloud.phase === "ready")
    && inScopeTrees.length === (cloud?.placements.length ?? inScopeTrees.length)
    && inScopeTrees.every((tree) => tree.condition === "up-to-date");
  const result = {
    schemaVersion: 1,
    ready,
    context: {
      kind: contextKind,
      ...(process.env.STORY_HOME ? { dataHome: resolve(process.env.STORY_HOME) } : {}),
      origin,
    },
    runtime: {
      state: runtimeState,
      ...(liveStatus ? { instanceID: liveStatus.instanceID, runtimeKind: liveStatus.runtimeKind } : {}),
      ...(cloud?.pid ? { pid: cloud.pid } : supervision?.pid ? { pid: supervision.pid } : {}),
      ...(supervision ? { supervision: { installed: supervision.installed, platform: supervision.platform } } : {}),
    },
    ...(cloud ? {
      cloudSession: {
        id: cloud.sessionID,
        root: cloud.root,
        phase: cloudPhase,
        updatedAt: cloud.updatedAt,
        targets: cloud.placements.map(({ treeID, canonicalURL, relativePath, path }) => ({ treeID, canonicalURL, relativePath, path })),
        ...(cloud.lastError ? { lastError: cloud.lastError } : {}),
      },
    } : {}),
    ...(liveStatus ? {
      live: {
        service: liveStatus.service,
        version: liveStatus.version,
        protocolVersion: liveStatus.protocolVersion,
        accounts,
        trees: { snapshot: decoratedTrees, observedThrough },
      },
    } : {}),
    ...(selection ? { selection } : {}),
    diagnostics,
  };
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`Story Sync: ${runtimeState} (${contextKind})`);
  if (cloud) {
    console.log(`Cloud session: ${cloudPhase}`);
    console.log(`Workspace: ${cloud.root}`);
  }
  if (supervision) console.log(`Supervision: ${supervision.installed ? "installed" : "not installed"} (${supervision.platform})`);
  console.log(`Origin: ${origin}`);
  if (supervision?.pid) console.log(`PID: ${supervision.pid}`);
  if (supervision && runtimeState !== "running") console.log(supervision.detail);
  if (selection) {
    const selected = selection.tree as (typeof decoratedTrees)[number] | undefined;
    console.log(`Selection: ${options.locator}`);
    if (selected) {
      console.log(`Tree: ${selected.id}`);
      console.log(`Placement: ${selected.osPath ?? "remote only"}`);
      console.log(`Sync: ${selected.condition}`);
    } else {
      console.log(`Tree: ${selection.condition === "not-applicable" ? "not placed" : "remote only"}`);
      console.log(`Sync: ${selection.condition}`);
    }
  } else if (liveStatus) {
    console.log(`Accounts: ${accounts.length} connected`);
    console.log("Trees:");
    if (!decoratedTrees.length) console.log("  none");
    for (const tree of decoratedTrees) {
      console.log(`  ${tree.condition.padEnd(11)} ${tree.osPath ?? (tree.canonical ? canonicalOverstoryLocator(tree.canonical) : tree.id)} (${tree.access})`);
    }
  }
  if (cloud && ["needs-sync", "interrupted"].includes(cloudPhase ?? "")) {
    console.log(`Recovery: run story agent finish --root ${JSON.stringify(cloud.root)}`);
  }
}

/**
 * `story me accounts` lists the profile's connections: its home account and its
 * placement accounts (accounts §1.3), which `story place` connects on first use.
 */
async function accountsCommand(args: string[]): Promise<void> {
  if (args.length) usage();
  const [homes, placements, local] = await Promise.all([HostAccountStore.list(), HostPlacementStore.list(), loadLocalPlacements()]);
  if (!homes.length) console.log("No connected account");
  for (const home of homes) {
    console.log(`Home: ${home.account} (device ${home.deviceID})`);
    for (const placement of placements.filter((candidate) => candidate.configurationTree === home.configurationTree)) {
      console.log(`  Placement: ${placement.account} (root ${placement.placementRoot})`);
      for (const folder of local.placements.filter((candidate) => candidate.configurationTree === home.configurationTree && candidate.host === placement.origin)) {
        console.log(`    ${folder.path} (${folder.tree})`);
      }
    }
  }
}

/** A domain as `domains` front matter writes it, or null: a DNS name (with a port only for a loopback test host). */
function domainName(input: string): string | null {
  const value = input.trim().replace(/^(https?|overstory):\/\//, "").replace(/\/+$/, "").toLowerCase();
  const parsed = parseProfileLocator(`https://${value}`);
  return parsed?.domain === value ? value : null;
}

/**
 * `story invite`: invitations to the community at the account URL's host,
 * made through \`@ovst/client\` with this device's key. Story Sync is not
 * involved (Sharing 002).
 */
async function inviteCommand(args: string[]): Promise<void> {
  const [first, ...rest] = args;
  const sub = first === "list" || first === "renew" || first === "cancel" ? first : undefined;
  const operands = sub ? rest : args;
  if (operands.some((operand) => operand.startsWith("-"))) usage();
  if (sub === "list") {
    if (operands.length > 1) usage();
    const client = await inviteClient(operands[0]);
    const pending = await pendingInvitations(client);
    for (const invitation of pending) console.log(invitation.account);
    if (!pending.length) console.error("No invitations are pending.");
    return;
  }
  if (operands.length !== 1) usage();
  const target = inviteTarget(operands[0]!);
  const client = await inviteClient(target.origin);
  if (sub === "cancel") {
    await cancelInvitation(client, target.handle);
    console.error(`The invitation for ${target.origin}/~${target.handle} is cancelled; its link no longer works.`);
    return;
  }
  const invitation = sub === "renew" ? await renewInvitation(client, target.handle) : await createInvitation(client, target.handle);
  console.log(invitation.link);
}

/** The host origin and handle of an account URL, `https://<host>/~<handle>`. */
function inviteTarget(input: string): { origin: string; handle: string } {
  let url: URL;
  try { url = new URL(input.replace(/^overstory:/, "https:")); } catch { usageError(`Not an account URL: ${input}`); }
  if (url.hash || url.search) usageError(`An account URL has no query or fragment: ${input}`);
  const match = HANDLE_PATH.exec(url.pathname);
  if (!match) usageError(`Not an account URL (https://<host>/~<handle>): ${input}`);
  return { origin: url.origin, handle: match[1]! };
}

/** A client speaking for this device's home account at `host`, or at its only home host. */
async function inviteClient(host?: string): Promise<ProtocolClient> {
  let origin: string | undefined;
  if (host) {
    try { origin = new URL(host.replace(/^overstory:/, "https:")).origin; } catch { usageError(`Not a host URL: ${host}`); }
  }
  const records = await HostAccountStore.list();
  if (!records.length) throw new Error("No account is claimed on this device; join a community or run `story me create` first");
  const record = origin ? records.find((candidate) => candidate.origin === origin) : records.length === 1 ? records[0] : undefined;
  if (!record) {
    throw new Error(origin
      ? `You have no account whose home is ${new URL(origin).host}; only its community's administrators can invite people there`
      : "Several accounts are claimed here; name the host: story invite list <host-url>");
  }
  return (await accountProtocolClient({ configurationTree: record.configurationTree, origin: record.origin }, { required: true, timeoutMs: 60_000 })).client;
}

/**
 * `story me domain` (locators §1.1): with a domain, list it in the profile's
 * front matter; with `--remove`, take it out; with `--check`, resolve each
 * listed domain both ways, as a host would. Prints the records to publish,
 * which name the profile by its locator at its home host, or the CNAME that
 * also has the home host serve the person's trees there (locators §5.1).
 */
async function domainCommand(store: ProfileIdentityStore, operands: string[]): Promise<void> {
  let add: string | undefined;
  let remove: string | undefined;
  let check = false;
  for (let index = 0; index < operands.length; index += 1) {
    const operand = operands[index]!;
    if (operand === "--check") check = true;
    else if (operand === "--remove" && operands[index + 1] && !remove) remove = operands[++index];
    else if (!operand.startsWith("-") && !add) add = operand;
    else usage();
  }
  if (add && remove) usage();
  const status = await store.status();
  if (!status) throw new Error("No person identity exists; run `story me create`");
  const home = (await HostAccountStore.list()).find((candidate) => candidate.configurationTree === treeConfigurationID(status.profileTree));
  const read = async () => profileDomains(parseMarkdown(await readFile(join(status.profilePath, "_index.md"), "utf8")).frontmatter);
  let domains = await read();
  const named = add ?? remove;
  if (named !== undefined) {
    const domain = domainName(named);
    if (!domain) usageError(`Not a domain name: ${named}`);
    const next = add ? [...new Set([...domains, domain])] : domains.filter((candidate) => candidate !== domain);
    if (remove && next.length === domains.length) throw new Error(`Your profile does not list ${domain}`);
    await store.updateProfile({ domains: next.length ? next : null });
    domains = next;
    console.log(add ? `Your profile now names ${domain}.` : `Your profile no longer names ${domain}; remove its record too.`);
  }
  if (!domains.length) {
    if (named === undefined) console.log("Your profile names no domain. Add one with `story me domain <domain>`.");
    return;
  }
  if (!check) {
    if (named === undefined) console.log(`Your profile names ${domains.join(", ")}.`);
    if (!home) {
      console.log("Connect a home account first: the records name your profile by its locator there.");
      return;
    }
    for (const domain of add ? [domainName(add)!] : domains) {
      console.log(`\n${domain}: publish one of these, then let Story Sync publish your profile and run \`story me domain --check\`.`);
      console.log(`  To name you:  DNS TXT   ${domainTXTName(domain)}  "profile=${home.account}"`);
      console.log(`            or  HTTPS     https://${domain}${DOMAIN_PROFILE_PATH}  {"profile": "${home.account}"}`);
      console.log(`  To also serve your trees at https://${domain}/:  DNS CNAME  ${domain}  ${new URL(home.origin).host}`);
      console.log(`    (whoever runs ${new URL(home.origin).host} must also route ${domain} to it with a certificate)`);
    }
    return;
  }
  const resolve = domainProfileResolver();
  let failed = false;
  const hostToken = home ? await domainCheckToken(home.origin).catch(() => null) : null;
  for (const domain of domains) {
    const locator = parseProfileLocator(`https://${domain}`)!.locator;
    if (hostToken) {
      const answer = await domainCheckToken(domainOrigin(domain)).catch(() => null);
      if (answer === hostToken) console.log(`${domain}: reaches ${new URL(home!.origin).host}, which serves your trees there`);
    }
    try {
      const named = await resolve(locator, domain);
      if (named?.profile === status.profileTree) {
        console.log(`${domain}: names your profile, homed at ${named.home}`);
        continue;
      }
      failed = true;
      if (named) {
        console.log(`${domain}: names another profile (${named.profile})`);
        continue;
      }
      const delegated = await resolveDomainDelegation(locator);
      console.log(!delegated
        ? `${domain}: its records name no profile (or disagree)`
        : `${domain}: its records name ${delegated}, but the profile there does not list ${domain} yet; let Story Sync publish your profile, which must be publicly readable`);
    } catch (error) {
      failed = true;
      console.log(`${domain}: cannot be read now: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failed) process.exitCode = 1;
}

/** What a host answers at its domain check route. */
async function domainCheckToken(origin: string): Promise<string | null> {
  const response = await fetch(`${origin}${DOMAIN_CHECK_PATH}`, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
  if (!response.ok) return null;
  const body = await response.json().catch(() => null) as { host?: unknown } | null;
  return typeof body?.host === "string" ? body.host : null;
}

/** `story me device` prints this installation's device for one home account. */
async function deviceCommand(args: string[]): Promise<void> {
  let configurationTree: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--account" && args[index + 1]) configurationTree = args[++index];
    else usage();
  }
  const accounts = await HostAccountStore.list();
  const record = configurationTree
    ? accounts.find((candidate) => candidate.configurationTree === configurationTree)
    : accounts.length === 1 ? accounts[0] : undefined;
  if (!record) {
    throw new Error(accounts.length > 1 && !configurationTree
      ? `Several accounts are connected; name one with --account: ${accounts.map((candidate) => candidate.configurationTree).join(", ")}`
      : "No connected account matches");
  }
  console.log(`Account: ${record.account}`);
  console.log(`Device: ${record.deviceID}`);
  console.log(`Signs in with key: ${record.deviceKey}`);
}

/** The Story Sync an agent's reports go to: the one serving its folder. */
async function agentSyncClient(cwd: string): Promise<StorySyncRESTClient> {
  const cloud = !process.env.STORY_SYNC_URL && !process.env.STORY_HOME ? await cloudSessionForPath(cwd) : null;
  const origin = process.env.STORY_SYNC_URL ?? cloud?.origin ?? await storySyncOrigin();
  return new StorySyncRESTClient({ baseURL: origin, ...(cloud ? { dataHome: cloud.dataHome } : {}) });
}

async function agentTextCommand(kind: "status" | "done", operands: string[]): Promise<void> {
  let at: string | undefined;
  const words: string[] = [];
  for (let index = 0; index < operands.length; index += 1) {
    if (kind === "status" && operands[index] === "--at" && operands[index + 1] !== undefined) at = operands[++index];
    else words.push(operands[index]!);
  }
  const text = words.join(" ").trim();
  if (!text) usageError(`story agent ${kind} needs some text`);
  const cwd = process.cwd();
  const result = await (await agentSyncClient(cwd)).agentReport(textReport(kind, text, cwd, process.env, at));
  if (!result) console.error("This folder is not placed, so Story shows nothing.");
}

/** A hook must never fail the agent: every problem is swallowed. */
async function agentHookCommand(operands: string[]): Promise<void> {
  let agent: string | undefined;
  for (let index = 0; index < operands.length; index += 1) {
    if (operands[index] === "--agent" && operands[index + 1] !== undefined) agent = operands[++index];
  }
  try {
    const input = await new Response(Bun.stdin.stream()).text();
    const body = hookReport(input, process.cwd(), agent, process.env);
    if (body) await (await agentSyncClient(body.cwd)).agentReport(body);
  } catch {
    // Story Sync not running, the folder not placed, a malformed payload: nothing to show.
  }
}

/** `story agent runner [on|off]`: whether this Mac's Story Sync runs tasks sent from the person's other devices. */
async function agentRunnerCommand(operands: string[]): Promise<void> {
  if (operands.length > 1 || (operands[0] !== undefined && operands[0] !== "on" && operands[0] !== "off")) usageError("story agent runner takes on, off, or nothing");
  const client = new StorySyncRESTClient({ baseURL: process.env.STORY_SYNC_URL ?? await storySyncOrigin() });
  const status = await client.runner(operands[0] === undefined ? undefined : operands[0] === "on");
  if (!status.enabled) console.log(`"${status.label}" does not run tasks from your other devices. Turn it on with: story agent runner on`);
  else if (!status.trees.length) console.log(`"${status.label}" runs tasks from your other devices, but is not offered on any tree yet: it is offered on each tree placed here while Story Sync is connected.`);
  else console.log(`"${status.label}" runs tasks from your other devices, on ${status.trees.length} tree${status.trees.length === 1 ? "" : "s"} placed here.`);
}

async function agentInstallCommand(operands: string[]): Promise<void> {
  const options: { command?: string; agent?: string } = {};
  for (let index = 0; index < operands.length; index += 1) {
    const arg = operands[index]!;
    if ((arg === "--command" || arg === "--agent") && operands[index + 1] !== undefined) options[arg === "--command" ? "command" : "agent"] = operands[++index];
    else usageError(`Unknown agent install option: ${arg}`);
  }
  const installed = await installAgentPresence(options);
  console.log(`Added Story's hooks and permission to ${installed.settings}`);
  console.log(`Added the skill at ${installed.skill}`);
  console.log("Claude Code sessions in placed folders now show up in Story as agents.");
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  setProtocolClientName(`story/${STORY_VERSION}`);
  if (command === "__cloud-story-sync") {
    await runStorySyncDaemon(args);
    return;
  }
  if (command === "--help" || command === "-h" || command === "help") {
    console.log(USAGE);
    return;
  }
  if (command === "--version" || command === "-V") {
    console.log(STORY_VERSION);
    return;
  }
  if (command === "agent") {
    const [action, ...operands] = args;
    if (action === "create") await createCloudBundle(operands);
    else if (action === "list") {
      if (operands.length > 1 || (operands.length === 1 && operands[0] !== "--json")) usage();
      await listCloudBundles(operands[0] === "--json");
    } else if (action === "revoke") {
      if (operands.length !== 1) usage();
      await revokeCloudBundle(operands[0]!);
    } else if (action === "run") await runAgent(operands);
    else if (action === "start") await startCloud(operands);
    else if (action === "finish") await finishCloud(operands);
    else if (action === "status" || action === "done") await agentTextCommand(action, operands);
    else if (action === "hook") await agentHookCommand(operands);
    else if (action === "runner") await agentRunnerCommand(operands);
    else if (action === "install") await agentInstallCommand(operands);
    else if (action === "uninstall") {
      if (operands.length) usage();
      await uninstallAgentPresence();
      console.log("Removed Story's hooks, skill and permission from Claude Code's settings.");
    }
    else usage();
    return;
  }
  if (command === "status") {
    await statusCommand(args);
    return;
  }
  if (command === "sync") {
    const [action, ...operands] = args;
    if (action === "status") await statusCommand(operands);
    else if (action === "pause" || action === "resume") await pauseCommand(operands, action);
    else if (action === "pending") await pendingCommand(operands);
    else if (action === "declined") await declinedCommand(operands);
    else usage();
    return;
  }
  if (command === "me") {
    const store = new ProfileIdentityStore();
    const [action, ...operands] = args;
    if (!action) {
      const status = await store.status();
      if (!status) throw new Error("No person identity exists; run `story me create`");
      console.log(`Profile TreeID: ${status.profileTree}`);
      console.log(`Profile folder: ${status.profilePath}`);
      console.log(`Private key: ${status.keyAvailable ? "available" : "unavailable"}`);
      return;
    }
    if (action === "create") {
      let profileFolder: string | undefined;
      let name: string | undefined;
      for (let index = 0; index < operands.length; index += 1) {
        const operand = operands[index]!;
        if (operand === "--name") name = operands[++index];
        else if (!operand.startsWith("-") && !profileFolder) profileFolder = operand;
        else usage();
      }
      if (operands.includes("--name") && name === undefined) usage();
      const displayName = name === undefined ? undefined : validateProfileDisplayName(name);
      if (name !== undefined && !displayName) usageError("--name must be 1-80 characters without line breaks");
      const status = await store.create(resolveUserPath(profileFolder ?? `${storyDataRoot()}/profile`));
      if (displayName) await store.updateProfile({ displayName });
      console.log(`Profile TreeID: ${status.profileTree}`);
      console.log(`Profile folder: ${status.profilePath}`);
      return;
    }
    if (action === "set") {
      const patch: { displayName?: string; avatar?: string; description?: string } = {};
      for (let index = 0; index < operands.length; index += 2) {
        const flag = operands[index];
        const value = operands[index + 1];
        if (!value) usage();
        if (flag === "--name") {
          const name = validateProfileDisplayName(value);
          if (!name) usageError("--name must be 1-80 characters without line breaks");
          patch.displayName = name;
        } else if (flag === "--description") {
          const description = validateProfileDescription(value);
          if (description === undefined) usageError("--description must be no more than 500 characters");
          patch.description = description;
        } else if (flag === "--avatar") {
          const avatar = validateProfileAvatarPath(value);
          if (!avatar) usageError("--avatar must be a relative png, jpg, jpeg, gif, or webp path inside the profile tree");
          const status = await store.status();
          if (!status) throw new Error("No person identity exists; run `story me create`");
          const avatarPath = resolve(status.profilePath, avatar);
          const isFile = await stat(avatarPath).then((value) => value.isFile()).catch(() => false);
          if (!avatarPath.startsWith(`${resolve(status.profilePath)}/`) || !isFile) {
            throw new Error(`Avatar file does not exist inside the profile folder: ${avatar}`);
          }
          patch.avatar = avatar;
        } else usage();
      }
      if (!Object.keys(patch).length) usage();
      const status = await store.updateProfile(patch);
      console.log(`Updated profile ${status.profileTree}`);
      return;
    }
    if (action === "backup") {
      if (operands.length !== 1) usage();
      const destination = resolveUserPath(operands[0]!);
      const passphrase = await readPassphrase("Passphrase for the backup (Return for none): ");
      if (passphrase && process.stdin.isTTY && await readPassphrase("Repeat the passphrase: ") !== passphrase) throw new Error("The passphrases differ; nothing was written");
      await store.backup(destination, passphrase);
      console.log(`Backed up Story identity to ${destination}`);
      return;
    }
    if (action === "accounts") {
      await accountsCommand(operands);
      return;
    }
    if (action === "domain") {
      await domainCommand(store, operands);
      return;
    }
    if (action === "device") {
      await deviceCommand(operands);
      return;
    }
    if (action === "restore") {
      if (operands.length < 1 || operands.length > 2) usage();
      const source = resolveUserPath(operands[0]!);
      const encrypted = backupIsEncrypted(JSON.parse(await readFile(source, "utf8")));
      const status = await store.restore(
        source,
        resolveUserPath(operands[1] ?? `${storyDataRoot()}/profile`),
        encrypted ? await readPassphrase("Backup passphrase: ") : undefined,
      );
      console.log(`Restored ${status.profileTree}`);
      console.log(`Profile folder: ${status.profilePath}`);
      return;
    }
    usage();
  }
  if (command === "daemon") {
    if (args[0] === "run") {
      await runStorySyncDaemon(args.slice(1));
      return;
    }
    if (args.length !== 1) usage();
    const supervisor = storyDaemonSupervisor();
    const [action] = args;
    if (action === "install") console.log(await supervisor.install());
    else if (action === "uninstall") console.log(await supervisor.uninstall());
    else if (action === "start") console.log(await supervisor.start());
    else if (action === "stop") console.log(await supervisor.stop());
    else if (action === "restart") console.log(await supervisor.restart());
    else if (action === "logs") console.log(await supervisor.logs());
    else usage();
    return;
  }
  if (command === "open") {
    if (args.length > 1 || args.some((arg) => arg.startsWith("-"))) usage();
    const input = args[0] ?? ".";
    const target = openTarget(input);
    const cloud = !process.env.STORY_SYNC_URL && !process.env.STORY_HOME
      ? await cloudSessionForPath(target.path ?? process.cwd())
      : null;
    const selectedOrigin = process.env.STORY_SYNC_URL ?? cloud?.origin;
    let attached = await attachedStorySyncURL(target, selectedOrigin, cloud?.dataHome);
    if (!attached && !process.env.STORY_HOME && !process.env.STORY_SYNC_URL && !cloud && process.platform === "darwin") {
      const supervisor = storyDaemonSupervisor();
      const status = await supervisor.status();
      if (!status.installed) throw new Error("Story Sync is not running; run `story daemon install` first");
      await supervisor.start();
      attached = await attachedStorySyncURL(target);
      if (!attached) throw new Error(`Story Sync started but could not open ${input}`);
    }
    if (attached) {
      if (target.remoteURL && await isReservedProfile(target)) attached.searchParams.set("claimable", "true");
      console.log(`Attached to Story Sync at ${attached.origin}`);
      console.log("Note: the web editor is being rebuilt and may be unavailable until it returns.");
      await openBrowser(attached.toString());
      return;
    }
    throw new Error(`A compatible Story Sync is not reachable at ${selectedOrigin ?? await storySyncOrigin()}; run \`story sync status\` for details`);
  }
  if (command === "invite") {
    await inviteCommand(args);
    process.exit(0);
  }
  if (command === "place") {
    await placeCommand(args);
    process.exit(0);
  }
  if (command === "mv") {
    await mvCommand(args);
    process.exit(0);
  }
  usage();
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(error instanceof CLIUsageError ? 2 : 1);
  });
}
