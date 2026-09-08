#!/usr/bin/env bun
import { lstat, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { resolveUserPath, serveArborSync, serveArborSyncControl } from "@arbor/arborsync";
import { runArborSyncDaemon } from "@arbor/arborsync/cli";
import { ArborSyncRESTClient } from "@arbor/arborsync-client";
import { canonicalArborLocator, canonicalHTTPURL, generateArborID, sha256 } from "@arbor/core";
import { materializeTree, snapshotDirectory } from "@arbor/fs";
import {
  addLocalPlacement,
  accountCheckoutPath,
  CanopyAccountStore,
  arborDataRoot,
  clearRehomeTransaction,
  loadCanopyAccountConfigurations,
  loadLocalPlacements,
  parseAccountDevicesConfiguration,
  parseHostedTreesConfiguration,
  ProfileIdentityStore,
  replaceLocalPlacement,
  saveCurrentAccountDeviceID,
  saveRehomeTransaction,
  type CanopyAccountConfigurationSnapshot,
} from "@arbor/stores";
import { WireClient } from "@arbor/wire";
import { parseDocument, type Document } from "yaml";
import { ARBOR_SYNC_PORT, arborDaemonSupervisor } from "./daemon.ts";
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

function usage(): never {
  console.error(`Usage:
  arbor open [<locator>]
  arbor me
  arbor me create [<profile-folder>]
  arbor me backup <file>
  arbor me restore <file> [<profile-folder>]
  arbor daemon <install|uninstall|start|stop|restart|status|logs>
  arbor status [<locator>] [--json]
  arbor cloud bundle create [--name <label>] --place <canonical-url> <relative-path> [...]
  arbor cloud bundle list [--json]
  arbor cloud bundle revoke <bundle-id>
  arbor cloud start [<bundle-string>] [--root <directory>] [--timeout <duration>] [--json]
  arbor cloud finish [--root <directory>] [--timeout <duration>] [--json]
  arbor place [--clear-access] [--access <subject>=<read|write|none>[,...]] <local-path> <canonical-url>
  arbor place <canonical-url> <local-path>
  arbor mv [--dry-run] <placed-local-root> <new-local-path>
  arbor mv [--dry-run] <source-canonical-url> <destination-canonical-url>`);
  process.exit(2);
}

async function openBrowser(url: string): Promise<void> {
  const command = process.platform === "darwin" ? ["open", url] : process.platform === "win32" ? ["cmd", "/c", "start", url] : ["xdg-open", url];
  try { Bun.spawn(command, { stdout: "ignore", stderr: "ignore" }); } catch {}
}

export async function attachedArborSyncURL(target: OpenTarget, port: number, selectedOrigin?: string): Promise<URL | null> {
  const origin = selectedOrigin ?? `http://127.0.0.1:${port}`;
  try {
    const status = await fetch(`${origin}/v1/status`);
    if (!status.ok || (await status.json() as { service?: string }).service !== "arborsync") return null;
    if (target.path) {
      const client = new ArborSyncRESTClient({ baseURL: origin });
      await client.openSession(target.path);
      return new URL(`${origin}/render${target.path}`);
    }
    const browserURL = new URL(`${origin}/render`);
    if (target.remoteURL) browserURL.searchParams.set("browse", target.remoteURL);
    return browserURL;
  } catch {
    return null;
  }
}

interface CanonicalTarget {
  endpoint: string;
  canonicalPath: string;
  supplied: string;
}

function canonicalTarget(input: string): CanonicalTarget {
  const url = new URL(input);
  if (url.protocol !== "http:" && url.protocol !== "https:" && url.protocol !== "arbor:") {
    throw new Error("Use an HTTP or arbor:// canonical URL");
  }
  if (url.protocol === "arbor:" && url.hostname === "tree") {
    throw new Error("A raw TreeID is not a canonical community URL");
  }
  const endpoint = url.protocol === "arbor:"
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
  if (!/^(?:https?|arbor):\/\//.test(input)) return { path: resolve(cwd, input) };
  const target = canonicalTarget(input);
  const source = new URL(input);
  const remoteURL = source.protocol === "arbor:"
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
    if (!response.ok) return false;
    if (response.headers.get("x-arbor-profile-state") === "reserved") return true;
    return (await response.text()).includes("has not been claimed");
  } catch {
    return false;
  }
}

export async function placedRemotePath(target: OpenTarget, client: ArborSyncRESTClient): Promise<string | null> {
  if (!target.remoteURL) return null;
  try {
    const canonical = canonicalTarget(target.remoteURL);
    const placement = (await client.trees()).snapshot.filter((tree) =>
      tree.osPath
      && tree.canonical?.endpoint === canonical.endpoint
      && sameOrDescendantPath(canonical.canonicalPath, tree.canonical.path)
    ).sort((left, right) => right.canonical!.path.length - left.canonical!.path.length)[0];
    if (!placement?.osPath || !placement.canonical) return null;
    const relative = canonical.canonicalPath.slice(placement.canonical.path.length);
    return `${placement.osPath}${relative}`;
  } catch {
    return null;
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

function placeArguments(args: string[]): { operands: string[]; audience: CliAudienceOperation[] } {
  const operands: string[] = [];
  const audience: CliAudienceOperation[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--access" || arg.startsWith("--access=")) {
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
  return { operands, audience };
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

async function withArborSync<T>(
  path: string,
  run: (
    client: ArborSyncRESTClient,
    service: { synchronizeNow(configurationTree?: string): Promise<void> },
  ) => Promise<T>,
): Promise<T> {
  if (!process.env.ARBOR_DATA_HOME) {
    const cloud = !process.env.ARBOR_SYNC_URL ? await cloudSessionForPath(path) : null;
    const baseURL = process.env.ARBOR_SYNC_URL ?? cloud?.origin ?? `http://127.0.0.1:${ARBOR_SYNC_PORT}`;
    let client = new ArborSyncRESTClient({ baseURL });
    let compatible = await client.status().then(
      (status) => status.service === "arborsync" && status.protocolVersion === "v1",
      () => false,
    );
    if (!compatible && !process.env.ARBOR_SYNC_URL && !cloud && process.platform === "darwin") {
      const supervisor = arborDaemonSupervisor();
      const status = await supervisor.status();
      if (!status.installed) throw new Error("Arbor Sync is not running; run `arbor daemon install` first");
      await supervisor.start();
      client = new ArborSyncRESTClient({ baseURL });
      compatible = true;
    }
    if (!compatible) {
      throw new Error(`A compatible Arbor Sync is not reachable at ${baseURL}; start \`arborsync --control\` with your user service manager`);
    }
    await client.openSession(path);
    return run(client, {
      async synchronizeNow(configurationTree?: string) { await client.synchronizeNow(configurationTree); },
    });
  }
  const running = await serveArborSync(path, { port: 0 });
  try {
    return await run(new ArborSyncRESTClient({ baseURL: running.url }), running.service);
  } finally {
    running.server.stop(true);
    await running.service[Symbol.asyncDispose]();
  }
}

async function editAccountConfigurationYAML(
  client: ArborSyncRESTClient,
  configurationTree: string,
  change: (document: Document) => void | Promise<void>,
  validate: (source: string) => void,
  filename = "trees.yaml",
): Promise<void> {
  const ref = { tree: configurationTree, path: `/${filename}`, stableKey: null } as const;
  const file = await client.file(ref);
  const document = parseDocument(new TextDecoder("utf-8", { fatal: true }).decode(file.bytes), { uniqueKeys: true, keepSourceTokens: true });
  if (document.errors.length) throw new Error(document.errors[0]!.message);
  await change(document);
  const source = document.toString({ lineWidth: 0 });
  validate(source);
  await client.writeText(ref, file.revision, source);
}

function sameOrDescendantPath(path: string, root: string): boolean {
  const normalizedRoot = root === "/" ? "" : root.replace(/\/$/, "");
  return path === (normalizedRoot || "/") || path.startsWith(`${normalizedRoot}/`);
}

interface SelectedCanopyAccount {
  configuration: CanopyAccountConfigurationSnapshot & Required<Pick<CanopyAccountConfigurationSnapshot, "account" | "trees" | "currentDevice">>;
  connection: NonNullable<Awaited<ReturnType<CanopyAccountStore["get"]>>>;
}

async function accountForCanonicalTarget(
  target: CanonicalTarget,
  options: { administrator: boolean },
): Promise<SelectedCanopyAccount> {
  const [configurations, records] = await Promise.all([
    loadCanopyAccountConfigurations(),
    CanopyAccountStore.list(),
  ]);
  const candidates = records.filter((record) =>
    record.origin === target.endpoint
    && sameOrDescendantPath(target.canonicalPath, new URL(record.account).pathname)
  ).sort((left, right) => new URL(right.account).pathname.length - new URL(left.account).pathname.length);
  if (!candidates.length) {
    throw new Error(`No claimed Canopy account contains ${target.supplied}`);
  }
  if (candidates.length > 1) {
    const firstLength = new URL(candidates[0]!.account).pathname.length;
    const secondLength = new URL(candidates[1]!.account).pathname.length;
    if (firstLength === secondLength) throw new Error(`Several claimed Canopy accounts contain ${target.supplied}`);
  }
  const record = candidates[0]!;
  const configuration = configurations.find((candidate) => candidate.configurationTree === record.configurationTree);
  if (!configuration) throw new Error(`Account ${record.configurationTree} has no configuration checkout`);
  if (configuration.diagnostics.length || !configuration.account || !configuration.trees || !configuration.currentDevice) {
    throw new Error(`Account ${record.configurationTree} is not valid: ${configuration.diagnostics[0]?.message ?? "incomplete checkout"}`);
  }
  if (configuration.account.canopy !== record.origin) {
    throw new Error(`Account ${record.configurationTree} does not match its claimed Canopy connection`);
  }
  if (options.administrator && !configuration.currentDevice.administrator) {
    throw new Error(`The current device is not an administrator of account ${record.configurationTree}`);
  }
  const connection = await new CanopyAccountStore(record.configurationTree).get();
  if (!connection) throw new Error(`Account credential is unavailable for ${record.configurationTree}`);
  return {
    configuration: configuration as SelectedCanopyAccount["configuration"],
    connection,
  };
}

async function waitForCanonicalPlacement(
  client: ArborSyncRESTClient,
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
  throw new Error("Arbor Sync did not adopt the destination placement");
}

async function waitForLocalPlacement(
  client: ArborSyncRESTClient,
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
  throw new Error(`Arbor Sync did not adopt the placement at ${path}`);
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
  const sourceIsCanonical = /^(?:https?|arbor):\/\//.test(sourceInput);
  const destinationIsCanonical = /^(?:https?|arbor):\/\//.test(destinationInput);
  if (sourceIsCanonical !== destinationIsCanonical) {
    throw new Error("arbor mv requires either two local paths or two canonical URLs; use arbor place to add a placement");
  }
  if (sourceIsCanonical) {
    await moveCanonicalTree(sourceInput, destinationInput, dryRun);
    return;
  }
  const source = await realpath(resolve(sourceInput));
  const destination = resolve(destinationInput);
  await withArborSync(source, async (client) => {
    const result = await client.movePlacement(source, destination, dryRun);
    console.log(`${result.check ? "Would move" : "Moved"} ${result.tree}`);
    console.log(`  from ${result.source}`);
    console.log(`  to   ${result.destination}`);
  });
}

async function moveCanonicalTree(sourceInput: string, destinationInput: string, dryRun: boolean): Promise<void> {
  const source = canonicalTarget(sourceInput);
  const destination = canonicalTarget(destinationInput);
  const sourceCanonical = `${source.endpoint}${source.canonicalPath}`;
  const destinationCanonical = `${destination.endpoint}${destination.canonicalPath}`;

  await withArborSync(arborDataRoot(), async (client, service) => {
    let selectedSource = await accountForCanonicalTarget(source, { administrator: true });
    let selectedDestination = await accountForCanonicalTarget(destination, { administrator: true });
    await service.synchronizeNow(selectedSource.configuration.configurationTree);
    if (selectedDestination.configuration.configurationTree !== selectedSource.configuration.configurationTree) {
      await service.synchronizeNow(selectedDestination.configuration.configurationTree);
    }
    selectedSource = await accountForCanonicalTarget(source, { administrator: true });
    selectedDestination = await accountForCanonicalTarget(destination, { administrator: true });
    const local = await loadLocalPlacements();
    if (local.diagnostics.length) throw new Error(`placements.yaml is invalid: ${local.diagnostics[0]!.message}`);

    const sourceMatch = Object.entries(selectedSource.configuration.trees).map(([tree, declaration]) => ({
      configurationTree: selectedSource.configuration.configurationTree,
      tree,
      declaration,
      configuration: selectedSource.configuration,
    })).find((candidate) => candidate.declaration.canonical === sourceCanonical);
    if (!sourceMatch) throw new Error(`No exact canonical tree matches ${sourceInput}`);
    const sourceConfiguration = sourceMatch.configuration;
    const sourceDeclaration = sourceMatch.declaration;
    const sourceTree = sourceMatch.tree;
    const destinationConfiguration = selectedDestination.configuration;
    const activePlacement = local.placements.find((placement) => placement.tree === sourceTree);
    if (!activePlacement) throw new Error(`Canonical move requires a local placement of ${sourceInput}`);
    const nested = local.placements.find((placement) =>
      placement.path !== activePlacement.path && placement.path.startsWith(`${activePlacement.path}/`)
    );
    if (nested) throw new Error(`Canonical move does not yet move a nested tree closure: ${nested.path}`);
    const canonicalDescendant = Object.entries(sourceConfiguration.trees!).find(([tree, declaration]) =>
      tree !== sourceTree && declaration.canonical.startsWith(`${sourceCanonical}/`)
    );
    if (canonicalDescendant) throw new Error(`Canonical move would strand descendant ${canonicalDescendant[0]} at ${canonicalDescendant[1].canonical}`);

    if (destinationConfiguration.configurationTree === sourceConfiguration.configurationTree) {
      if (sourceCanonical === destinationCanonical) {
        console.log(`${sourceTree} is already at ${destination.supplied}`);
        return;
      }
      const occupied = Object.entries(destinationConfiguration.trees!).find(([tree, declaration]) =>
        tree !== sourceTree && declaration.canonical === destinationCanonical
      );
      if (occupied) throw new Error(`${destination.supplied} is already declared for ${occupied[0]}`);
      const localDescriptor = (await client.trees()).snapshot.find((candidate) =>
        candidate.id === sourceTree && candidate.configurationTree === sourceConfiguration.configurationTree
      );
      if (!localDescriptor || localDescriptor.sync !== "idle" || localDescriptor.missing) {
        throw new Error(`Source tree must be present and idle before a canonical move; current state is ${localDescriptor?.sync ?? "unavailable"}`);
      }
      const wire = new WireClient(selectedDestination.connection.record.origin, selectedDestination.connection.accountToken, { timeoutMs: REHOME_WIRE_TIMEOUT_MS });
      const sourceRemote = (await wire.descriptor(sourceTree)).tree;
      console.log(`${dryRun ? "Would move" : "Moving"} ${sourceTree}`);
      console.log(`  from ${sourceCanonical}`);
      console.log(`  to   ${destinationCanonical}`);
      console.log(`  path ${activePlacement.path}`);
      if (dryRun) return;
      await editAccountConfigurationYAML(
        client,
        sourceConfiguration.configurationTree,
        (document) => document.setIn([sourceTree, "canonical"], destinationCanonical),
        (value) => { parseHostedTreesConfiguration(value, sourceConfiguration.account!); },
      );
      await service.synchronizeNow(sourceConfiguration.configurationTree);
      await waitForCanonicalPlacement(client, sourceTree, sourceConfiguration.configurationTree, destination.endpoint, destination.canonicalPath);
      const finalLocal = (await client.trees()).snapshot.find((candidate) =>
        candidate.id === sourceTree && candidate.configurationTree === sourceConfiguration.configurationTree
      );
      if (!finalLocal || finalLocal.sync !== "idle") {
        throw new Error(`Destination placement did not become idle; current state is ${finalLocal?.sync ?? "unavailable"}`);
      }
      const finalRemote = (await wire.descriptor(sourceTree)).tree;
      if (finalRemote.root !== sourceRemote.root || finalRemote.canonical?.path !== destination.canonicalPath) {
        throw new Error("Canonical rename did not preserve the source snapshot and exact destination path");
      }
      console.log(`Moved ${sourceTree} to ${destinationCanonical}.`);
      return;
    }

    const occupied = Object.entries(destinationConfiguration.trees!).find(([tree, declaration]) =>
      tree !== sourceTree && declaration.canonical === destinationCanonical
    );
    if (occupied) throw new Error(`${destination.supplied} is already declared for ${occupied[0]}`);
    const existingDestinationDeclaration = destinationConfiguration.trees![sourceTree];
    if (existingDestinationDeclaration && existingDestinationDeclaration.canonical !== destinationCanonical) {
      throw new Error(`Destination account already declares ${sourceTree} at ${existingDestinationDeclaration.canonical}`);
    }
    const resuming = activePlacement.configurationTree === destinationConfiguration.configurationTree
      && existingDestinationDeclaration?.canonical === destinationCanonical;
    if (!resuming && activePlacement.configurationTree !== sourceConfiguration.configurationTree) {
      throw new Error(`The local placement for ${sourceTree} belongs to neither the source nor destination account`);
    }

    const sourceConnection = await new CanopyAccountStore(sourceConfiguration.configurationTree).get();
    const destinationConnection = selectedDestination.connection;
    if (!sourceConnection) throw new Error(`Source credential is unavailable for ${sourceConfiguration.configurationTree}`);
    const localDescriptor = (await client.trees()).snapshot.find((candidate) =>
      candidate.id === sourceTree && candidate.configurationTree === activePlacement.configurationTree
    );
    if (!resuming && (!localDescriptor || localDescriptor.sync !== "idle" || localDescriptor.missing)) {
      throw new Error(`Source tree must be present and idle before moving Canopies; current state is ${localDescriptor?.sync ?? "unavailable"}`);
    }
    const sourceRemote = (await new WireClient(sourceConnection.record.origin, sourceConnection.accountToken, { timeoutMs: REHOME_WIRE_TIMEOUT_MS })
      .descriptor(sourceTree)).tree;
    const destinationWire = new WireClient(destinationConnection.record.origin, destinationConnection.accountToken, { timeoutMs: REHOME_WIRE_TIMEOUT_MS });
    const existingRemote = (await destinationWire.list()).snapshot.find((tree) => tree.id === sourceTree);
    if (existingRemote && !resuming && existingRemote.root !== sourceRemote.root) {
      throw new Error(`Destination already has a different current snapshot for ${sourceTree}`);
    }

    console.log(`${dryRun ? "Would move" : "Moving"} ${sourceTree}`);
    console.log(`  from ${sourceCanonical}`);
    console.log(`  to   ${destinationCanonical}`);
    console.log(`  path ${activePlacement.path}`);
    console.log("  history starts again at the destination; the source server history is retained and retired");
    if (dryRun) return;

    await saveRehomeTransaction({
      version: 1,
      tree: sourceTree,
      sourceConfigurationTree: sourceConfiguration.configurationTree,
      destinationConfigurationTree: destinationConfiguration.configurationTree,
      sourceCanonical,
      destinationCanonical,
    });

    if (!existingDestinationDeclaration) {
      await editAccountConfigurationYAML(
        client,
        destinationConfiguration.configurationTree,
        (document) => document.setIn([sourceTree], { canonical: destinationCanonical, access: sourceDeclaration.access }),
        (source) => { parseHostedTreesConfiguration(source, destinationConfiguration.account!); },
      );
      await service.synchronizeNow(destinationConfiguration.configurationTree);
    }
    if (!resuming) {
      await replaceLocalPlacement(activePlacement, {
        configurationTree: destinationConfiguration.configurationTree,
        path: activePlacement.path,
      });
    }
    await waitForCanonicalPlacement(client, sourceTree, destinationConfiguration.configurationTree, destination.endpoint, destination.canonicalPath);
    await service.synchronizeNow(destinationConfiguration.configurationTree);
    const finalLocal = (await client.trees()).snapshot.find((candidate) =>
      candidate.id === sourceTree && candidate.configurationTree === destinationConfiguration.configurationTree
    );
    if (!finalLocal || finalLocal.sync !== "idle") {
      throw new Error(`Destination placement did not become idle; current state is ${finalLocal?.sync ?? "unavailable"}`);
    }
    const finalRemote = (await destinationWire.descriptor(sourceTree)).tree;
    if (!resuming && finalRemote.root !== sourceRemote.root) throw new Error("Destination activation did not preserve the source's current snapshot");
    await editAccountConfigurationYAML(
      client,
      sourceConfiguration.configurationTree,
      (document) => { document.deleteIn([sourceTree]); },
      (source) => { parseHostedTreesConfiguration(source, sourceConfiguration.account!); },
    );
    await service.synchronizeNow(sourceConfiguration.configurationTree);
    const finalConfigurations = await loadCanopyAccountConfigurations();
    const finalSource = finalConfigurations.find((configuration) =>
      configuration.configurationTree === sourceConfiguration.configurationTree
    );
    if (finalSource?.trees?.[sourceTree]) {
      throw new Error("Source account still declares the tree after destination activation");
    }
    await clearRehomeTransaction(sourceTree);
    console.log(`Moved ${sourceTree} to ${destinationCanonical}; source server history retained and source account declaration removed.`);
  });
}

async function accessRulesFor(client: WireClient, audience: ShareAudience) {
  const raw = audience.kind === "private" ? [] : audience.kind === "everyone"
    ? [{ subject: { kind: "everyone" as const }, access: audience.access }]
    : audience.kind === "profile"
      ? [{ subject: { kind: "profile" as const, locator: audience.locator }, access: audience.access }]
      : audience.rules;
  return Promise.all(raw.map(async (rule) => rule.subject.kind === "profile"
    ? { subject: { kind: "profile" as const, tree: (await client.resolve(new URL(rule.subject.locator).pathname)).ref.tree }, access: rule.access }
    : rule));
}

async function placeLocal(
  first: string,
  second: string,
  audience: CliAudienceOperation[],
): Promise<void> {
  const path = await realpath(resolve(first));
  if (!(await stat(path)).isDirectory()) throw new Error(`Not a directory: ${path}`);
  const target = canonicalTarget(second);
  await withArborSync(path, async (client, service) => {
    let selected = await accountForCanonicalTarget(target, { administrator: true });
    await service.synchronizeNow(selected.configuration.configurationTree);
    selected = await accountForCanonicalTarget(target, { administrator: true });
    const config = selected.configuration;
    const wire = new WireClient(selected.connection.record.origin, selected.connection.accountToken);
    const local = await loadLocalPlacements();
    if (local.diagnostics.length) throw new Error(`placements.yaml is invalid: ${local.diagnostics[0]!.message}`);
    const existing = local.placements.find((placement) => placement.path === path);
    let tree = existing?.tree;
    const isNew = tree === undefined;
    if (existing) {
      if (existing.configurationTree !== config.configurationTree) {
        throw new Error(`${path} is already placed through a different Canopy account`);
      }
      const declaration = config.trees[existing.tree];
      if (!declaration || declaration.canonical !== `${target.endpoint}${target.canonicalPath}`) {
        throw new Error(`${path} already has a different canonical URL`);
      }
    } else {
      tree = generateArborID("tr");
      const rules = await accessRulesFor(wire, initialAudience(audience, target));
      await editAccountConfigurationYAML(client, config.configurationTree, (document) => {
        document.setIn([tree!], { canonical: `${target.endpoint}${target.canonicalPath}`, access: rules });
      }, (source) => { parseHostedTreesConfiguration(source, config.account); });
      try {
        await addLocalPlacement({ configurationTree: config.configurationTree, path, tree });
      } catch (error) {
        await editAccountConfigurationYAML(client, config.configurationTree, (document) => {
          document.deleteIn([tree!]);
        }, (source) => { parseHostedTreesConfiguration(source, config.account); }).catch(() => {});
        throw error;
      }
      await waitForLocalPlacement(client, tree, config.configurationTree, path);
    }
    if (tree && !isNew) {
      const declaration = config.trees[tree]!;
      let rules = [...declaration.access];
      for (const operation of audience) {
        if (operation.kind === "clear") {
          rules = [];
        } else {
          const subject = accessSubject(operation.subject, target);
          const normalized = subject.kind === "everyone" ? { kind: "everyone" as const }
            : { kind: "profile" as const, tree: (await wire.resolve(new URL(subject.locator).pathname)).ref.tree };
          const key = JSON.stringify(normalized);
          rules = rules.filter((rule) => JSON.stringify(rule.subject) !== key);
          if (operation.access !== "none") rules.push({ subject: normalized, access: operation.access });
        }
      }
      if (audience.length) {
        await editAccountConfigurationYAML(client, config.configurationTree, (document) => {
          document.setIn([tree!, "access"], rules);
        }, (source) => { parseHostedTreesConfiguration(source, config.account); });
      }
    }
    if (isNew && audience.length === 0) {
      console.warn(`Warning: no audience options supplied; created ${target.supplied} with private access.`);
    }
    await service.synchronizeNow(config.configurationTree);
    console.log(`${target.supplied} ↔ ${path}`);
  });
}

async function placeCommand(args: string[]): Promise<void> {
  const { operands, audience } = placeArguments(args);
  if (operands.length !== 2) usage();
  const [first, second] = operands as [string, string];
  const firstIsURL = /^(?:https?|arbor):\/\//.test(first);
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
  await withArborSync(dirname(destination), async (client, service) => {
    let selected = await accountForCanonicalTarget(target, { administrator: false });
    await service.synchronizeNow(selected.configuration.configurationTree);
    selected = await accountForCanonicalTarget(target, { administrator: false });
    const remote = await new WireClient(target.endpoint, selected.connection.accountToken).resolve(target.canonicalPath);
    const descriptor = remote.enclosingTree;
    if (!descriptor?.canonical) throw new Error("Server resolution omitted its canonical tree");
    const declaration = selected.configuration.trees[descriptor.id];
    const canonical = canonicalHTTPURL(descriptor.canonical);
    if (!declaration || declaration.canonical !== canonical) {
      throw new Error(`${canonical} is not declared by the matching claimed Canopy account`);
    }
    await addLocalPlacement({
      configurationTree: selected.configuration.configurationTree,
      path: destination,
      tree: descriptor.id,
    });
    await waitForLocalPlacement(client, descriptor.id, selected.configuration.configurationTree, destination);
    await service.synchronizeNow(selected.configuration.configurationTree);
    console.log(`${canonicalArborLocator(descriptor.canonical)} ↔ ${destination} (${descriptor.access})`);
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
      usageError(`Unknown cloud bundle option: ${arg}`);
    }
  }
  if (!placements.length) usageError("Cloud bundle creation requires at least one --place URL path pair");
  const normalizedPaths = validateCloudPlacementPaths(placements.map((placement) => placement.relativePath));
  return {
    ...(label ? { label } : {}),
    placements: placements.map((placement, index) => ({ ...placement, relativePath: normalizedPaths[index]! })),
  };
}

async function createCloudBundle(args: string[]): Promise<void> {
  const requested = cloudBundleCreateArguments(args);
  await withArborSync(process.cwd(), async (client, service) => {
    let selected: SelectedCanopyAccount | undefined;
    const placements: CloudBundlePlacement[] = [];
    for (const requestedPlacement of requested.placements) {
      const target = canonicalTarget(requestedPlacement.canonicalURL);
      const candidate = await accountForCanonicalTarget(target, { administrator: true });
      if (!selected) {
        await service.synchronizeNow(candidate.configuration.configurationTree);
        selected = await accountForCanonicalTarget(target, { administrator: true });
      } else if (candidate.configuration.configurationTree !== selected.configuration.configurationTree) {
        throw new Error("A cloud bundle may contain trees from only one Arbor account");
      }
      if (target.endpoint !== selected.connection.record.origin) {
        throw new Error("A cloud bundle may target only one Canopy");
      }
      const wire = new WireClient(selected.connection.record.origin, selected.connection.accountToken);
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
    if (!selected) throw new Error("Cloud bundle has no account");
    if (new Set(placements.map((placement) => placement.treeID)).size !== placements.length) {
      throw new Error("A cloud bundle may not place the same tree more than once");
    }
    const bundleID = `cb_${crypto.randomUUID().replaceAll("-", "")}`;
    const label = (requested.label ?? `Cloud bundle ${bundleID.slice(-8)}`).trim();
    if (!label || label.length > 100) throw new Error("Cloud bundle name must be from 1 through 100 characters");
    const deviceID = generateArborID("dv");
    const credential = `arb_${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
    const createdAt = new Date().toISOString();
    const payload: CloudBundlePayload = {
      version: 1,
      bundleID,
      label,
      createdAt,
      origin: selected.connection.record.origin,
      account: selected.connection.record.account,
      accountID: selected.connection.record.accountID,
      configurationTree: selected.configuration.configurationTree,
      profileTree: selected.connection.record.profileTree,
      deviceID,
      credential,
      placements,
    };
    const encoded = encodeCloudBundle(payload);
    const wire = new WireClient(selected.connection.record.origin, selected.connection.accountToken);
    const pairing = await wire.createPairing();
    await new WireClient(selected.connection.record.origin).claimPairing(pairing.id, pairing.secret, {
      id: deviceID,
      label,
      credentialDigest: `sha256:${sha256(credential)}`,
    });
    await saveCloudBundleRecord({
      bundleID,
      label,
      createdAt,
      origin: payload.origin,
      account: payload.account,
      configurationTree: payload.configurationTree,
      deviceID,
    });
    console.error(`Created reusable cloud bundle ${bundleID} (${placements.length} placement${placements.length === 1 ? "" : "s"}).`);
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
    console.log("No cloud bundles have been created on this device.");
    return;
  }
  for (const bundle of bundles) {
    console.log(`${bundle.bundleID}  ${bundle.revokedAt ? "revoked" : "active"}  ${bundle.label}  ${bundle.account}`);
  }
}

async function revokeCloudBundle(bundleID: string): Promise<void> {
  const record = (await loadCloudBundles()).find((candidate) => candidate.bundleID === bundleID);
  if (!record) throw new Error(`Unknown local cloud bundle: ${bundleID}`);
  if (record.revokedAt) {
    console.log(`Cloud bundle ${bundleID} was already revoked.`);
    return;
  }
  await withArborSync(process.cwd(), async (client, service) => {
    await service.synchronizeNow(record.configurationTree);
    const configuration = (await loadCanopyAccountConfigurations()).find((candidate) => candidate.configurationTree === record.configurationTree);
    if (!configuration?.account || !configuration.devices || !configuration.currentDevice) {
      throw new Error(`Account ${record.configurationTree} is unavailable or invalid`);
    }
    if (!configuration.currentDevice.administrator) {
      throw new Error(`The current device is not an administrator of account ${record.configurationTree}`);
    }
    if (configuration.devices[record.deviceID]) {
      await editAccountConfigurationYAML(
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
    console.log(`Revoked cloud bundle ${bundleID}.`);
  });
}

function cloudStartArguments(args: string[]): { bundle: string; root: string; timeoutMs: number; json: boolean } {
  let bundleArgument: string | undefined;
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
    else if (arg.startsWith("--")) usageError(`Unknown cloud start option: ${arg}`);
    else if (bundleArgument) usageError("arbor cloud start accepts at most one bundle argument");
    else bundleArgument = arg;
  }
  const environmentBundle = process.env.ARBOR_CLOUD_BUNDLE;
  if (bundleArgument && environmentBundle) usageError("Supply the cloud bundle as an argument or ARBOR_CLOUD_BUNDLE, not both");
  const bundle = bundleArgument ?? environmentBundle;
  if (!bundle) usageError("arbor cloud start requires a bundle argument or ARBOR_CLOUD_BUNDLE");
  return { bundle, root: resolve(root), timeoutMs: parseDuration(timeout), json };
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
  await withEnvironment({ ARBOR_DATA_HOME: session.dataHome, ARBOR_CREDENTIAL_STORE: "file" }, async () => {
    const wire = new WireClient(payload.origin, payload.credential, { timeoutMs: 60_000 });
    const account = await wire.account();
    if (
      account.account.id !== payload.accountID
      || account.account.configuration.id !== payload.configurationTree
      || account.account.profileTree !== payload.profileTree
      || account.account.device?.id !== payload.deviceID
    ) throw new Error("Cloud bundle authorization does not match its account identity");
    const configuration = (await wire.descriptor(payload.configurationTree)).tree;
    const snapshot = await wire.snapshot(payload.configurationTree, configuration.root);
    const checkout = accountCheckoutPath(payload.configurationTree);
    await materializeTree(checkout, snapshot.root, (hash) => {
      const bytes = snapshot.objects.get(hash);
      if (!bytes) throw new Error(`Account configuration snapshot is missing ${hash}`);
      return Promise.resolve(bytes);
    });
    await new CanopyAccountStore(payload.configurationTree).set(payload.credential, {
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
    const status = await new ArborSyncRESTClient({ baseURL: session.origin }).status();
    return status.service === "arborsync" && status.protocolVersion === "v1" && status.instanceID === session.instanceID ? status : null;
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
  const stdoutPath = join(cloudSessionDirectory(session.sessionID), "arborsync.stdout.log");
  while (Date.now() < deadline) {
    const source = await readFile(stdoutPath, "utf8").catch(() => "");
    const url = source.match(/https?:\/\/127\.0\.0\.1:\d+/)?.[0];
    if (url) {
      try {
        const status = await new ArborSyncRESTClient({ baseURL: url }).status();
        if (status.instanceID === session.instanceID && status.runtimeKind === "cloud") return url;
      } catch {}
    }
    await Bun.sleep(50);
  }
  throw new Error("Cloud Arbor Sync did not become reachable before the timeout");
}

async function cloudPlacementsReady(
  session: CloudSessionRecord,
  payload: Pick<CloudBundlePayload, "origin" | "credential" | "configurationTree">,
): Promise<{ ready: boolean; reason?: string }> {
  if (!session.origin) return { ready: false, reason: "Arbor Sync has no recorded origin" };
  const client = new ArborSyncRESTClient({ baseURL: session.origin });
  const local = (await client.trees()).snapshot;
  const wire = new WireClient(payload.origin, payload.credential, { timeoutMs: 60_000 });
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
    if (descriptor.acceptedUpdate !== remote.update) return { ready: false, reason: `${target.relativePath} has not accepted the current Canopy update` };
    const localSnapshot = await snapshotDirectory(target.path);
    if (localSnapshot.root !== remote.root) return { ready: false, reason: `${target.relativePath} differs from Canopy` };
  }
  return { ready: true };
}

async function waitForCloudPlacements(
  session: CloudSessionRecord,
  payload: Pick<CloudBundlePayload, "origin" | "credential" | "configurationTree">,
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

async function startCloud(args: string[]): Promise<void> {
  const options = cloudStartArguments(args);
  const payload = decodeCloudBundle(options.bundle);
  delete process.env.ARBOR_CLOUD_BUNDLE;
  await mkdir(options.root, { recursive: true });
  const root = await realpath(options.root);
  let session = await cloudSessionForRoot(root);
  const existing = Boolean(session);
  if (session && session.bundleID !== payload.bundleID) {
    throw new Error(`${root} already belongs to cloud bundle ${session.bundleID}`);
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
      throw new Error("The recorded cloud Arbor Sync process is alive but its instance cannot be verified; refusing to start a second writer");
    }
    if (!attached) {
      await prepareCloudDataHome(payload, session);
      const directory = cloudSessionDirectory(session.sessionID);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const stdoutPath = join(directory, "arborsync.stdout.log");
      const stderrPath = join(directory, "arborsync.stderr.log");
      await Promise.all([
        writeFile(stdoutPath, "", { mode: 0o600 }),
        writeFile(stderrPath, "", { mode: 0o600 }),
      ]);
      session = { ...session, instanceID: crypto.randomUUID(), phase: "preparing", updatedAt: new Date().toISOString(), origin: undefined, pid: undefined, lastError: undefined };
      await saveCloudSession(session);
      const cliEntryPoint = process.argv[1];
      if (!cliEntryPoint) throw new Error("Cannot locate the Arbor CLI entry point");
      const child = Bun.spawn([
        process.execPath,
        cliEntryPoint,
        "__cloud-arborsync",
        "--control",
        "--port", "0",
        "--runtime-kind", "cloud",
        "--instance-id", session.instanceID,
      ], {
        cwd: root,
        env: { ...process.env, ARBOR_DATA_HOME: session.dataHome, ARBOR_CREDENTIAL_STORE: "file" },
        stdout: Bun.file(stdoutPath),
        stderr: Bun.file(stderrPath),
      });
      spawnedPID = child.pid;
      child.unref();
      const origin = await waitForCloudOrigin(session, deadline);
      session = { ...session, origin, pid: child.pid, updatedAt: new Date().toISOString() };
      await saveCloudSession(session);
    }
    if (!session.origin) throw new Error("Cloud Arbor Sync origin is unavailable");
    const client = new ArborSyncRESTClient({ baseURL: session.origin });
    await client.synchronizeNow(payload.configurationTree);
    await waitForCloudPlacements(session, payload, deadline);
    session = { ...session, phase: "ready", updatedAt: new Date().toISOString(), lastError: undefined };
    await saveCloudSession(session);
    const result = { schemaVersion: 1, ready: true, sessionID: session.sessionID, bundleID: session.bundleID, root, origin: session.origin, placements: session.placements };
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`Cloud Arbor Sync is ready at ${session.origin}.`);
      for (const placement of session.placements) console.log(`${placement.canonicalURL} ↔ ${placement.path}`);
    }
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
    else usageError(`Unknown cloud finish option: ${arg}`);
  }
  return { root: resolve(root), timeoutMs: parseDuration(timeout), json };
}

async function finishCloud(args: string[]): Promise<void> {
  const options = cloudFinishArguments(args);
  let session = await cloudSessionForPath(options.root);
  if (!session || session.phase === "finished") throw new Error(`No active cloud session contains ${options.root}`);
  if (!session.origin || !session.pid || !await liveCloudStatus(session)) {
    await saveCloudSession({ ...session, phase: "needs-sync", updatedAt: new Date().toISOString(), lastError: "Cloud Arbor Sync is not running" });
    throw new Error("Cloud Arbor Sync is not running; retained session state requires recovery before it can finish");
  }
  session = { ...session, phase: "draining", updatedAt: new Date().toISOString(), lastError: undefined };
  await saveCloudSession(session);
  try {
    const deadline = Date.now() + options.timeoutMs;
    const connection = await withEnvironment(
      { ARBOR_DATA_HOME: session.dataHome, ARBOR_CREDENTIAL_STORE: "file" },
      () => new CanopyAccountStore(session!.configurationTree).get(),
    );
    if (!connection) throw new Error("Cloud session credential is unavailable");
    const payload = {
      origin: connection.record.origin,
      credential: connection.accountToken,
      configurationTree: connection.record.configurationTree,
    };
    const client = new ArborSyncRESTClient({ baseURL: session.origin });
    await client.synchronizeNow(payload.configurationTree);
    await waitForCloudPlacements(session, payload, deadline);
    if (!await liveCloudStatus(session)) throw new Error("Cloud Arbor Sync instance changed before shutdown");
    const pid = session.pid;
    if (!pid) throw new Error("Cloud Arbor Sync PID is unavailable");
    process.kill(pid, "SIGTERM");
    while (Date.now() < deadline && await liveCloudStatus(session)) await Bun.sleep(50);
    if (await liveCloudStatus(session)) throw new Error("Cloud Arbor Sync did not stop before the timeout");
    await rm(session.dataHome, { recursive: true, force: true });
    session = { ...session, phase: "finished", updatedAt: new Date().toISOString(), lastError: undefined };
    await saveCloudSession(session);
    const result = { schemaVersion: 1, finished: true, sessionID: session.sessionID, root: session.root, placements: session.placements };
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else console.log(`Cloud session ${session.sessionID} synchronized and stopped.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await saveCloudSession({ ...session, phase: "needs-sync", updatedAt: new Date().toISOString(), lastError: message });
    throw error;
  }
}

type StatusTreeCondition = "missing" | "conflict" | "error" | "offline" | "syncing" | "not-placed" | "up-to-date";

function statusTreeCondition(tree: Awaited<ReturnType<ArborSyncRESTClient["trees"]>>["snapshot"][number]): StatusTreeCondition {
  if (tree.missing) return "missing";
  if (tree.sync === "conflict") return "conflict";
  if (tree.sync === "error") return "error";
  if (tree.sync === "offline") return "offline";
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
    else if (locator) usageError("arbor status accepts at most one locator");
    else locator = arg;
  }
  return { ...(locator ? { locator } : {}), json };
}

async function statusCommand(args: string[]): Promise<void> {
  const options = statusArguments(args);
  const selectionPath = options.locator && !/^(?:https?|arbor):\/\//.test(options.locator)
    ? resolve(options.locator)
    : process.cwd();
  const cloud = !process.env.ARBOR_SYNC_URL && !process.env.ARBOR_DATA_HOME
    ? await cloudSessionForPath(selectionPath)
    : null;
  const contextKind = process.env.ARBOR_SYNC_URL
    ? "explicit-url"
    : process.env.ARBOR_DATA_HOME
      ? "foreground"
      : cloud
        ? "cloud"
        : "persistent";
  const origin = process.env.ARBOR_SYNC_URL ?? cloud?.origin ?? `http://127.0.0.1:${ARBOR_SYNC_PORT}`;
  let liveStatus: Awaited<ReturnType<ArborSyncRESTClient["status"]>> | null = null;
  let accounts: Awaited<ReturnType<ArborSyncRESTClient["accounts"]>>["accounts"] = [];
  let trees: Awaited<ReturnType<ArborSyncRESTClient["trees"]>>["snapshot"] = [];
  let observedThrough: string | undefined;
  let runtimeState: "running" | "stopped" | "unreachable" | "incompatible" | "not-installed" = "unreachable";
  let supervision: Awaited<ReturnType<ReturnType<typeof arborDaemonSupervisor>["status"]>> | undefined;
  const diagnostics: Array<{ code: string; message: string }> = [];
  try {
    const client = new ArborSyncRESTClient({ baseURL: origin });
    const status = await client.status();
    if (status.service !== "arborsync" || status.protocolVersion !== "v1" || (cloud && status.instanceID !== cloud.instanceID)) {
      runtimeState = "incompatible";
      diagnostics.push({ code: "incompatible-runtime", message: "The selected endpoint is not the expected Arbor Sync instance" });
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
    if (contextKind === "persistent") {
      supervision = await arborDaemonSupervisor().status();
      runtimeState = supervision.state === "not-installed"
        ? "not-installed"
        : supervision.state === "stopped"
          ? "stopped"
          : "unreachable";
    } else if (cloud?.phase === "finished") runtimeState = "stopped";
  }
  const cloudPhase = cloud && runtimeState !== "running" && ["preparing", "ready", "draining"].includes(cloud.phase)
    ? "interrupted"
    : cloud?.phase;
  const decoratedTrees = trees.map((tree) => ({ ...tree, condition: statusTreeCondition(tree) }));
  let selection: Record<string, unknown> | undefined;
  if (options.locator) {
    if (!liveStatus) throw new Error(`Cannot resolve ${options.locator} because the selected Arbor Sync is not running`);
    const input = /^(?:https?|arbor):\/\//.test(options.locator) ? options.locator : resolve(options.locator);
    const resolved = await new ArborSyncRESTClient({ baseURL: origin }).resolve(input);
    const tree = resolved.enclosingTree
      ? decoratedTrees.find((candidate) => candidate.id === resolved.enclosingTree!.id)
      : undefined;
    selection = {
      input: options.locator,
      ref: resolved.ref,
      historical: resolved.historical,
      ...(tree ? { tree, condition: tree.condition } : { condition: /^(?:https?|arbor):\/\//.test(options.locator) ? "not-placed" : "not-applicable" }),
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
      ...(process.env.ARBOR_DATA_HOME ? { dataHome: resolve(process.env.ARBOR_DATA_HOME) } : {}),
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
  console.log(`Arbor Sync: ${runtimeState} (${contextKind})`);
  if (cloud) {
    console.log(`Cloud session: ${cloudPhase}`);
    console.log(`Workspace: ${cloud.root}`);
  }
  console.log(`Origin: ${origin}`);
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
      console.log(`  ${tree.condition.padEnd(11)} ${tree.osPath ?? (tree.canonical ? canonicalArborLocator(tree.canonical) : tree.id)} (${tree.access})`);
    }
  }
  if (cloud && ["needs-sync", "interrupted"].includes(cloudPhase ?? "")) {
    console.log(`Recovery: run arbor cloud finish --root ${JSON.stringify(cloud.root)}`);
  }
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === "__cloud-arborsync") {
    await runArborSyncDaemon(args);
    return;
  }
  if (command === "status") {
    await statusCommand(args);
    return;
  }
  if (command === "cloud") {
    const [action, ...operands] = args;
    if (action === "bundle") {
      const [bundleAction, ...bundleOperands] = operands;
      if (bundleAction === "create") await createCloudBundle(bundleOperands);
      else if (bundleAction === "list") {
        if (bundleOperands.length > 1 || (bundleOperands.length === 1 && bundleOperands[0] !== "--json")) usage();
        await listCloudBundles(bundleOperands[0] === "--json");
      } else if (bundleAction === "revoke") {
        if (bundleOperands.length !== 1) usage();
        await revokeCloudBundle(bundleOperands[0]!);
      } else usage();
      return;
    }
    if (action === "start") {
      await startCloud(operands);
      return;
    }
    if (action === "finish") {
      await finishCloud(operands);
      return;
    }
    usage();
  }
  if (command === "me") {
    const store = new ProfileIdentityStore();
    const [action, ...operands] = args;
    if (!action) {
      const status = await store.status();
      if (!status) throw new Error("No person identity exists; run `arbor me create`");
      console.log(`Profile TreeID: ${status.profileTree}`);
      console.log(`Profile folder: ${status.profilePath}`);
      console.log(`Private key: ${status.keyAvailable ? "available" : "unavailable"}`);
      return;
    }
    if (action === "create") {
      if (operands.length > 1) usage();
      const status = await store.create(resolveUserPath(operands[0] ?? `${arborDataRoot()}/profile`));
      console.log(`Profile TreeID: ${status.profileTree}`);
      console.log(`Profile folder: ${status.profilePath}`);
      return;
    }
    if (action === "backup") {
      if (operands.length !== 1) usage();
      const destination = resolveUserPath(operands[0]!);
      await store.backup(destination);
      console.log(`Backed up Arbor identity to ${destination}`);
      return;
    }
    if (action === "restore") {
      if (operands.length < 1 || operands.length > 2) usage();
      const status = await store.restore(
        resolveUserPath(operands[0]!),
        resolveUserPath(operands[1] ?? `${arborDataRoot()}/profile`),
      );
      console.log(`Restored ${status.profileTree}`);
      console.log(`Profile folder: ${status.profilePath}`);
      return;
    }
    usage();
  }
  if (command === "daemon") {
    if (args.length !== 1) usage();
    const supervisor = arborDaemonSupervisor();
    const [action] = args;
    if (action === "install") console.log(await supervisor.install());
    else if (action === "uninstall") console.log(await supervisor.uninstall());
    else if (action === "start") console.log(await supervisor.start());
    else if (action === "stop") console.log(await supervisor.stop());
    else if (action === "restart") console.log(await supervisor.restart());
    else if (action === "logs") console.log(await supervisor.logs());
    else if (action === "status") {
      const status = await supervisor.status();
      console.log(`Arbor Sync: ${status.state}`);
      console.log(`Supervision: ${status.installed ? "installed" : "not installed"} (${status.platform})`);
      console.log(`Origin: ${status.origin}`);
      if (status.pid) console.log(`PID: ${status.pid}`);
      console.log(status.detail);
    } else usage();
    return;
  }
  if (command === "open") {
    if (args.length > 1 || args.some((arg) => arg.startsWith("-"))) usage();
    const input = args[0] ?? ".";
    const target = openTarget(input);
    const cloud = !process.env.ARBOR_SYNC_URL && !process.env.ARBOR_DATA_HOME
      ? await cloudSessionForPath(target.path ?? process.cwd())
      : null;
    const selectedOrigin = process.env.ARBOR_SYNC_URL ?? cloud?.origin;
    let attached = await attachedArborSyncURL(target, ARBOR_SYNC_PORT, selectedOrigin);
    if (!attached && !process.env.ARBOR_DATA_HOME && !process.env.ARBOR_SYNC_URL && !cloud && process.platform === "darwin") {
      const supervisor = arborDaemonSupervisor();
      const status = await supervisor.status();
      if (!status.installed) throw new Error("Arbor Sync is not running; run `arbor daemon install` first");
      await supervisor.start();
      attached = await attachedArborSyncURL(target, ARBOR_SYNC_PORT);
      if (!attached) throw new Error(`Arbor Sync started but could not open ${input}`);
    }
    if (attached) {
      if (target.remoteURL && await isReservedProfile(target)) attached.searchParams.set("claimable", "true");
      console.log(`Attached to Arbor Sync at ${attached.origin}`);
      await openBrowser(attached.toString());
      return;
    }
    if (!process.env.ARBOR_DATA_HOME) {
      throw new Error(`A compatible Arbor Sync is not reachable on port ${ARBOR_SYNC_PORT}; run \`arbor daemon status\` for details`);
    }
    const running = target.remoteURL
      ? await serveArborSyncControl({ port: ARBOR_SYNC_PORT })
      : await serveArborSync(target.path!, { port: ARBOR_SYNC_PORT });
    const { service, server, url } = running;
    let start = "";
    if (running.mode === "workspace") {
      start = running.start;
      const descriptor = running.workspace.descriptor();
      const scope = descriptor.canonical
        ? `shared tree "${descriptor.name}"`
        : "ordinary local files";
      console.log(`Arbor Sync is serving ${start} (${scope})`);
    } else {
      console.log(`Arbor Sync is opening ${target.remoteURL}`);
    }
    console.log(url);
    const claimable = target.remoteURL ? await isReservedProfile(target) : false;
    const placedPath = target.remoteURL && !claimable
      ? await placedRemotePath(target, new ArborSyncRESTClient({ baseURL: url }))
      : null;
    const browserURL = new URL(`${url}/render${placedPath ?? start}`);
    if (target.remoteURL) {
      if (!placedPath) browserURL.searchParams.set("browse", target.remoteURL);
      if (claimable) browserURL.searchParams.set("claimable", "true");
    }
    await openBrowser(browserURL.toString());
    const shutdown = async () => {
      server.stop(true);
      await service[Symbol.asyncDispose]();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    return;
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
