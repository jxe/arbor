#!/usr/bin/env bun
import { mkdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { resolveUserPath, serveArborSync, serveArborSyncControl } from "@arbor/arborsync";
import { ArborSyncRESTClient } from "@arbor/client";
import { canonicalArborLocator, canonicalHTTPURL } from "@arbor/core";
import {
  addLocalPlacement,
  CanopyAccountStore,
  arborDataRoot,
  clearRehomeTransaction,
  loadCanopyAccountConfigurations,
  loadLocalPlacements,
  parseHostedTreesConfiguration,
  ProfileIdentityStore,
  replaceLocalPlacement,
  saveRehomeTransaction,
  type CanopyAccountConfigurationSnapshot,
} from "@arbor/stores";
import { WireClient } from "@arbor/wire";
import { parseDocument, type Document } from "yaml";
import { ARBOR_SYNC_PORT, arborDaemonSupervisor } from "./daemon.ts";

const REHOME_WIRE_TIMEOUT_MS = 60_000;

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

export async function attachedArborSyncURL(target: OpenTarget, port: number): Promise<URL | null> {
  const origin = `http://127.0.0.1:${port}`;
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
    } else if (["-r", "--read", "-rw", "--read-write", "--remove"].includes(arg)) {
      // Compatibility aliases for the pre-ACL-builder command surface.
      const subject = args[index + 1];
      if (!subject || subject.startsWith("-")) throw new Error(`${arg} requires public or ~<handle>`);
      audience.push({
        kind: "set",
        subject,
        access: arg === "--remove" ? "none" : arg === "-r" || arg === "--read" ? "read" : "write",
      });
      index += 1;
    } else if (arg === "--private") {
      // Compatibility alias for --clear-access.
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
    service: { synchronizeNow(): Promise<void> },
  ) => Promise<T>,
): Promise<T> {
  if (!process.env.ARBOR_DATA_HOME) {
    const baseURL = process.env.ARBOR_SYNC_URL ?? `http://127.0.0.1:${ARBOR_SYNC_PORT}`;
    let client = new ArborSyncRESTClient({ baseURL });
    let compatible = await client.status().then(
      (status) => status.service === "arborsync" && status.protocolVersion === "v1",
      () => false,
    );
    if (!compatible && !process.env.ARBOR_SYNC_URL && process.platform === "darwin") {
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
      async synchronizeNow() { await client.synchronizeNow(); },
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
): Promise<void> {
  const ref = { tree: configurationTree, path: "/trees.yaml", stableKey: null } as const;
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
    await service.synchronizeNow();
    const configurations = await loadCanopyAccountConfigurations();
    if (!configurations.length) throw new Error("Canonical moves require a claimed Canopy account");
    const invalid = configurations.find((configuration) =>
      configuration.diagnostics.length || !configuration.account || !configuration.trees || !configuration.currentDevice
    );
    if (invalid) throw new Error(`Account ${invalid.configurationTree} is not valid: ${invalid.diagnostics[0]?.message ?? "incomplete checkout"}`);
    const local = await loadLocalPlacements();
    if (local.diagnostics.length) throw new Error(`placements.yaml is invalid: ${local.diagnostics[0]!.message}`);

    const sourceMatch = configurations.flatMap((configuration) =>
      Object.entries(configuration.trees!).map(([tree, declaration]) => ({
        configurationTree: configuration.configurationTree,
        tree,
        declaration,
        configuration,
      })),
    ).find((candidate) => candidate.declaration.canonical === sourceCanonical);
    if (!sourceMatch) throw new Error(`No exact canonical tree matches ${sourceInput}`);
    const sourceConfiguration = sourceMatch.configuration;
    const sourceDeclaration = sourceMatch.declaration;
    const sourceTree = sourceMatch.tree;
    const selectedDestination = await accountForCanonicalTarget(destination, { administrator: true });
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
      await service.synchronizeNow();
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

    if (configurations.length < 2) throw new Error("Moving between Canopies requires at least two valid account checkouts");
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
      await service.synchronizeNow();
    }
    if (!resuming) {
      await replaceLocalPlacement(activePlacement, {
        configurationTree: destinationConfiguration.configurationTree,
        path: activePlacement.path,
      });
    }
    await waitForCanonicalPlacement(client, sourceTree, destinationConfiguration.configurationTree, destination.endpoint, destination.canonicalPath);
    await service.synchronizeNow();
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
    await service.synchronizeNow();
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
    await service.synchronizeNow();
    const selected = await accountForCanonicalTarget(target, { administrator: true });
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
      tree = await client.treeID();
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
    await service.synchronizeNow();
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
    await service.synchronizeNow();
    const selected = await accountForCanonicalTarget(target, { administrator: false });
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
    await service.synchronizeNow();
    console.log(`${canonicalArborLocator(descriptor.canonical)} ↔ ${destination} (${descriptor.access})`);
  });
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
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
      const status = await store.begin(resolveUserPath(operands[0] ?? `${arborDataRoot()}/profile`));
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
    let attached = await attachedArborSyncURL(target, ARBOR_SYNC_PORT);
    if (!attached && !process.env.ARBOR_DATA_HOME && process.platform === "darwin") {
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
    process.exit(1);
  });
}
