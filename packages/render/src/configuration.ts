import type { AccessEntry } from "@arbor/core";
import { canonicalArborLocator } from "@arbor/core";
import { sha256 } from "@arbor/core/hash";
import { ArborSyncRESTClient } from "@arbor/client";
import { parseDocument, type Document } from "yaml";

type ShareAudience =
  | { kind: "private" }
  | { kind: "everyone"; access: "read" | "write" }
  | { kind: "profile"; locator: string; access: "read" | "write" }
  | { kind: "rules"; rules: Array<
      | { subject: { kind: "everyone" }; access: "read" | "write" }
      | { subject: { kind: "profile"; locator: string }; access: "read" | "write" }
    > };

export type ConfigurationAction =
  | { op: "promoteTree"; path: string; canonicalPath: string; audience: ShareAudience }
  | { op: "placeTree"; tree: string; path: string; endpoint?: string; canonical?: string }
  | { op: "removeTreePlacement"; path: string; endpoint?: string; canonicalPath?: string }
  | {
      op: "setTreeAccess";
      tree: string;
      subject: { kind: "all" } | { kind: "everyone" } | { kind: "profile"; locator: string }
        | { kind: "link"; secret: string } | { kind: "entry"; id: string };
      access: "none" | "read" | "write";
    };

export interface ActiveDevice {
  id: string;
  label: string;
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: null;
}

async function context(client: ArborSyncRESTClient) {
  const [trees, status] = await Promise.all([client.trees(), client.status()]);
  const configuration = trees.snapshot.find((tree) => tree.kind === "account-configuration");
  if (!configuration || !status.deviceID) throw new Error("This device has no active account configuration checkout");
  const accountFile = await client.file({ tree: configuration.id, path: "/account.yaml", stableKey: null });
  const account = parseDocument(new TextDecoder().decode(accountFile.bytes), { uniqueKeys: true }).toJS() as {
    community?: unknown;
    profile?: { tree?: unknown; handle?: unknown };
  };
  if (typeof account.community !== "string") throw new Error("account.yaml has no community origin");
  return { tree: configuration.id, device: status.deviceID, community: account.community, account, configuration };
}

export async function configurationStatus(client: ArborSyncRESTClient) {
  const accounts = (await client.accounts()).accounts;
  if (accounts.length) {
    const account = accounts[0]!;
    return {
      configured: true,
      credentialAvailable: account.credentialAvailable,
      ...(account.canopy ? { origin: account.canopy, communityURL: `arbor://${new URL(account.canopy).host}/` } : {}),
      ...(account.handle ? { handle: account.handle } : {}),
      ...(account.profileTree ? { profileTree: account.profileTree } : {}),
      ...(account.canopy && account.handle ? { profileURL: `${account.canopy}/~${account.handle}` } : {}),
      configurationTree: account.configurationTree,
    };
  }
  const { account, community, configuration } = await context(client);
  return {
    configured: true,
    credentialAvailable: true,
    origin: community,
    ...(typeof account.profile?.handle === "string" ? { handle: account.profile.handle } : {}),
    ...(typeof account.profile?.tree === "string" ? { profileTree: account.profile.tree } : {}),
    ...(typeof account.profile?.handle === "string"
      ? {
          profileURL: `${community}/~${account.profile.handle}`,
          communityURL: `arbor://${new URL(community).host}/`,
        }
      : {}),
    configurationTree: configuration.id,
  };
}

async function edit(client: ArborSyncRESTClient, tree: string, path: string, change: (document: Document) => void | Promise<void>) {
  const ref = { tree, path, stableKey: null } as const;
  const file = await client.file(ref);
  const source = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
  const document = parseDocument(source, { uniqueKeys: true, keepSourceTokens: true });
  if (document.errors.length) throw new Error(document.errors[0]!.message);
  await change(document);
  await client.writeText(ref, file.revision, document.toString({ lineWidth: 0 }));
}

async function waitForPlacement(client: ArborSyncRESTClient, tree: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if ((await client.trees()).snapshot.some((descriptor) => descriptor.id === tree && descriptor.osPath)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`The placement for ${tree} was written but arborsync has not applied it yet`);
}

function rules(audience: ShareAudience): any[] {
  if (audience.kind === "private") return [];
  if (audience.kind === "everyone") return [{ subject: { kind: "everyone" }, access: audience.access }];
  if (audience.kind === "profile") return [{ subject: { kind: "profile", locator: audience.locator }, access: audience.access }];
  return audience.rules.map((rule) => ({ subject: rule.subject, access: rule.access }));
}

async function normalizedRules(client: ArborSyncRESTClient, input: any[]): Promise<any[]> {
  return Promise.all(input.map(async (rule) => rule.subject.kind === "profile"
    ? { subject: { kind: "profile", tree: (await client.resolve(rule.subject.locator)).ref.tree }, access: rule.access }
    : rule));
}

function subjectID(subject: any): string {
  if (subject.kind === "everyone") return "everyone";
  if (subject.kind === "profile" && typeof subject.tree === "string") return `profile:${subject.tree}`;
  if (subject.kind === "link" && typeof subject.digest === "string") return `link:${subject.digest}`;
  throw new Error("Invalid access subject in trees.yaml");
}

export async function configurationAccessEntries(client: ArborSyncRESTClient, treeID: string): Promise<AccessEntry[]> {
  const { tree } = await context(client);
  const [file, descriptors] = await Promise.all([
    client.file({ tree, path: "/trees.yaml", stableKey: null }),
    client.trees(),
  ]);
  const locators = new Map(descriptors.snapshot.map((descriptor) => [descriptor.id, descriptor.canonical ? canonicalArborLocator(descriptor.canonical) : undefined]));
  const value = parseDocument(new TextDecoder().decode(file.bytes), { uniqueKeys: true }).toJS() as any;
  const declaration = value?.trees?.[treeID];
  if (!declaration) throw new Error(`Unknown tree ${treeID}`);
  return (declaration.access ?? []).map((rule: any) => ({
    id: subjectID(rule.subject),
    subject: rule.subject.kind === "link" ? { kind: "link" }
      : rule.subject.kind === "profile" ? {
          kind: "profile",
          tree: rule.subject.tree,
          ...(locators.get(rule.subject.tree) ? { locator: locators.get(rule.subject.tree) } : {}),
        }
      : { kind: "everyone" },
    access: rule.access,
  }));
}

export async function applyConfigurationAction(client: ArborSyncRESTClient, action: ConfigurationAction): Promise<void> {
  const { tree: configTree, device, community } = await context(client);
  if (action.op === "promoteTree") {
    const id = await client.treeID();
    const access = await normalizedRules(client, rules(action.audience));
    await edit(client, configTree, "/trees.yaml", (document) => {
      document.setIn(["trees", id], { canonicalPath: action.canonicalPath, access });
    });
    await edit(client, configTree, `/devices/${device}.yaml`, (document) => {
      document.setIn(["placements", id], { server: community, path: action.path });
    });
    await waitForPlacement(client, id);
    return;
  }
  if (action.op === "placeTree") {
    const server = action.endpoint ?? (action.canonical ? new URL(action.canonical.replace(/^arbor:/, "https:")).origin : undefined);
    if (!server) throw new Error("Placement requires a server endpoint");
    await edit(client, configTree, `/devices/${device}.yaml`, (document) => {
      document.setIn(["placements", action.tree], { server: new URL(server).origin, path: action.path });
    });
    return;
  }
  if (action.op === "removeTreePlacement") {
    await edit(client, configTree, `/devices/${device}.yaml`, (document) => {
      const value = document.toJS() as any;
      const found = Object.entries(value.placements).find(([, placement]: [string, any]) => placement.path === action.path);
      if (!found) throw new Error(`No placement at ${action.path}`);
      document.deleteIn(["placements", found[0]]);
    });
    return;
  }
  await edit(client, configTree, "/trees.yaml", async (document) => {
    const value = document.toJS() as any;
    const declaration = value.trees[action.tree];
    if (!declaration) throw new Error(`Unknown tree ${action.tree}`);
    if (action.subject.kind === "all") {
      if (action.access !== "none") throw new Error("Clearing access requires none");
      document.setIn(["trees", action.tree, "access"], []);
      return;
    }
    let subject: any;
    if (action.subject.kind === "everyone") subject = { kind: "everyone" };
    else if (action.subject.kind === "profile") subject = { kind: "profile", tree: (await client.resolve(action.subject.locator)).ref.tree };
    else if (action.subject.kind === "link") subject = { kind: "link", digest: `sha256:${sha256(action.subject.secret)}` };
    else if (action.subject.kind === "entry") {
      const entryID = action.subject.id;
      const existing = (declaration.access ?? []).find((rule: any) => subjectID(rule.subject) === entryID);
      if (!existing) throw new Error("Access entry no longer exists in trees.yaml");
      subject = existing.subject;
    } else throw new Error("Invalid access subject");
    const key = JSON.stringify(subject);
    const index = (declaration.access ?? []).findIndex((rule: any) => JSON.stringify(rule.subject) === key);
    if (action.access === "none") {
      if (index >= 0) document.deleteIn(["trees", action.tree, "access", index]);
    } else if (index >= 0) {
      document.setIn(["trees", action.tree, "access", index, "access"], action.access);
    } else {
      document.addIn(["trees", action.tree, "access"], { subject, access: action.access });
    }
  });
}

export async function activeDevices(client: ArborSyncRESTClient): Promise<ActiveDevice[]> {
  const { tree } = await context(client);
  const children = await client.allChildren({ tree, path: "/devices", stableKey: null });
  return Promise.all(children.filter((child) => child.name.startsWith("dv_")).map(async (child) => {
    const file = await client.file(child.ref);
    const value = parseDocument(new TextDecoder().decode(file.bytes), { uniqueKeys: true }).toJS() as { label?: unknown };
    return {
      id: child.name.replace(/\.yaml$/, ""),
      label: typeof value.label === "string" ? value.label : child.name,
      createdAt: 0,
      lastUsedAt: null,
      revokedAt: null,
    };
  }));
}

export async function revokeActiveDevice(client: ArborSyncRESTClient, id: string): Promise<void> {
  const { tree } = await context(client);
  await client.mutateStructural([{ op: "trash", refs: [{ tree, path: `/devices/${id}.yaml`, stableKey: null }] }]);
}
