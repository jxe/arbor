import type { ChildrenPage, LocalTreeDescriptor, NodeResponse } from "@arbor/core";
import { SYSTEM_TREE, canonicalArborLocator, canonicalHTTPURL, revisionOf } from "@arbor/core";
import { parseMarkdown } from "@arbor/editor";
import type { CommunityConfigStore, VisitedTreeStore } from "@arbor/stores";
import { WireClient, type RemoteAccessEntry, type RemoteTreeDescriptor } from "@arbor/wire";
import type { EventBus } from "./events.ts";
import { sampleExpandedNode, summarizeSample } from "./node-sampling.ts";
import { treeConflict } from "./sync-state.ts";
import type { TreeManager } from "./tree-manager.ts";
import { ProtocolError } from "./workspace.ts";

export const SYSTEM_REMOTE_TIMEOUT_MS = 1_000;

export interface SystemTreeDeps {
  trees: TreeManager;
  events: EventBus;
  communityConfig: CommunityConfigStore;
  visitedTrees: VisitedTreeStore;
  monotonicNow: () => number;
}

interface SystemTreeSegment {
  readonly segment: string;
  readonly tree: LocalTreeDescriptor;
  readonly source: string;
}

interface CachedSystemTreeSegments {
  readonly revision: number;
  readonly expiresAt: number;
  readonly segments: readonly SystemTreeSegment[];
}

interface SystemTreeSegmentsBuild {
  readonly revision: number;
  readonly segments: readonly SystemTreeSegment[];
}

/** The read-only `system:` tree: safe diagnostic projections over local daemon state. */
export class SystemTreeProjection {
  private readonly trees: TreeManager;
  private readonly events: EventBus;
  private readonly communityConfig: CommunityConfigStore;
  private readonly visitedTrees: VisitedTreeStore;
  private readonly monotonicNow: () => number;
  private systemTreeProjection?: CachedSystemTreeSegments;
  private systemTreeProjectionInFlight?: { revision: number; promise: Promise<readonly SystemTreeSegment[]> };

  constructor(deps: SystemTreeDeps) {
    this.trees = deps.trees;
    this.events = deps.events;
    this.communityConfig = deps.communityConfig;
    this.visitedTrees = deps.visitedTrees;
    this.monotonicNow = deps.monotonicNow;
  }

  /** Safe diagnostic projections. Account configuration is ordinary tree content. */
  async systemSnapshot(path: string): Promise<NodeResponse> {
    await this.trees.descriptors();
    const observedThrough = this.events.currentCursor();
    if (path === "/") {
      return sampleExpandedNode({
        path: "/",
        name: "system",
        kind: "directory",
        revision: revisionOf(""),
        writable: false,
        materialization: "available",
        document: parseMarkdown(""),
        diagnostics: [],
      }, { tree: SYSTEM_TREE, observedThrough, writable: false });
    }
    if (path === "/visited") {
      const listing = (await this.visitedTrees.list()).map((visit) => visit.id);
      const revision = revisionOf(listing.join("\n"));
      return sampleExpandedNode({
        path,
        name: path.slice(1),
        kind: "directory",
        revision,
        writable: false,
        materialization: "available",
        document: parseMarkdown(""),
        diagnostics: this.trees.diagnostics(),
      }, { tree: SYSTEM_TREE, observedThrough, writable: false });
    }
    const record = await this.systemRecordAt(path);
    if (!record) {
      throw new ProtocolError("not-found", `Node not found: system:${path.slice(1)}`, 404, { path });
    }
    return sampleExpandedNode({
      path,
      name: record.segment,
      kind: "markdown",
      revision: revisionOf(record.record.source),
      writable: false,
      materialization: "available",
      bodyOrigin: "sibling",
      document: parseMarkdown(record.record.source),
      diagnostics: [],
    }, { tree: SYSTEM_TREE, observedThrough, writable: false });
  }

  async systemChildren(path: string): Promise<ChildrenPage> {
    await this.trees.descriptors();
    const observedThrough = this.events.currentCursor();
    if (path === "/") {
      const items = await Promise.all(["/credentials", "/visited", "/diagnostics"].map(async (childPath) =>
        summarizeSample(await this.systemSnapshot(childPath))
      ));
      return {
        parent: { tree: SYSTEM_TREE, path: "/", stableKey: null },
        items,
        nextCursor: null,
        observedThrough,
      };
    }
    if (path === "/visited") {
      const visits = await this.visitedTrees.list();
      return {
        parent: { tree: SYSTEM_TREE, path: "/visited", stableKey: null },
        items: await Promise.all(visits.map(async (visit) => summarizeSample(await this.systemSnapshot(`/visited/${visit.id}`)))),
        nextCursor: null,
        observedThrough,
      };
    }
    throw new ProtocolError("invalid-reference", `system:${path.slice(1)} does not have children`, 400, { path });
  }

  private async buildSystemTreeSegments(): Promise<SystemTreeSegmentsBuild> {
    const configured = await this.communityConfig.get();
    let remote: RemoteTreeDescriptor[] = [];
    let writable = new Set<string>();
    const remoteAccess = new Map<string, RemoteAccessEntry[]>();
    if (configured) {
      const client = new WireClient(configured.record.origin, configured.accountToken, {
        timeoutMs: SYSTEM_REMOTE_TIMEOUT_MS,
      });
      const [listed, account] = await Promise.allSettled([client.list(), client.account()]);
      if (listed.status === "fulfilled") remote = listed.value.snapshot;
      if (account.status === "fulfilled") {
        writable = new Set(account.value.account.writableProfiles.map((tree) => tree.id));
      }
      if (
        (listed.status === "rejected" && listed.reason instanceof TypeError)
        || (account.status === "rejected" && account.reason instanceof TypeError)
      ) {
        for (const placement of this.trees.sharedPlacements()) {
          if (placement.endpoint === configured.record.origin) this.trees.setSyncState(placement.tree, "offline");
        }
      }
      await Promise.all(remote.map(async (tree) => {
        const entries = await client.access(tree.id).then((value) => value.snapshot).catch(() => []);
        remoteAccess.set(tree.id, entries);
      }));
    }
    // Read local descriptors after the bounded remote refresh so any transport
    // failure above is visible immediately as `sync: offline`.
    const local = await this.trees.descriptors();
    const byID = new Map<string, LocalTreeDescriptor>(local.map((tree) => [tree.id, tree]));
    for (const tree of remote) {
      const current = byID.get(tree.id);
      byID.set(tree.id, {
        id: tree.id,
        name: current?.name ?? tree.canonical?.path.split("/").filter(Boolean).at(-1) ?? "community",
        osPath: current?.osPath,
        kind: tree.kind,
        canonical: tree.canonical,
        access: current?.access ?? tree.access ?? (writable.has(tree.id) ? "write" : "read"),
        placement: current?.placement ?? "remote",
        sync: current?.sync,
      });
    }
    const segments = await Promise.all([...byID.values()].map(async (tree) => ({
      segment: tree.id,
      tree,
      source: this.treeRecordSource(
        tree,
        tree.placement !== "remote" ? await treeConflict(tree.id) : undefined,
      ),
    })));
    return { revision: this.trees.descriptorRevision, segments };
  }

  private async systemTreeSegments(): Promise<readonly SystemTreeSegment[]> {
    const revision = this.trees.descriptorRevision;
    const now = this.monotonicNow();
    const cached = this.systemTreeProjection;
    if (cached && cached.revision === revision && cached.expiresAt > now) return cached.segments;
    const inFlight = this.systemTreeProjectionInFlight;
    if (inFlight) return inFlight.promise;

    const promise = (async () => {
      const build = await this.buildSystemTreeSegments();
      if (this.trees.descriptorRevision === build.revision) {
        this.systemTreeProjection = {
          revision: build.revision,
          expiresAt: this.monotonicNow() + 1_000,
          segments: build.segments,
        };
      }
      return build.segments;
    })();
    this.systemTreeProjectionInFlight = { revision, promise };
    try {
      return await promise;
    } finally {
      if (this.systemTreeProjectionInFlight?.promise === promise) {
        this.systemTreeProjectionInFlight = undefined;
      }
    }
  }

  private async systemTreeChildren() {
    return (await this.systemTreeSegments())
      .map(({ segment, tree }) => ({
        tree: SYSTEM_TREE,
        name: tree.name,
        path: `/trees/${segment}`,
        kind: "markdown" as const,
        materialization: "available" as const,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  private treeRecordSource(
    tree: LocalTreeDescriptor,
    conflict?: Awaited<ReturnType<typeof treeConflict>>,
  ): string {
    return [
      "---",
      `id: ${tree.id}`,
      `name: ${JSON.stringify(tree.name)}`,
      `placement: ${tree.placement}`,
      ...(tree.osPath ? [`path: ${JSON.stringify(tree.osPath)}`] : []),
      ...(tree.canonical ? [`canonical: ${JSON.stringify(canonicalArborLocator(tree.canonical))}`] : []),
      ...(tree.canonical ? [`http: ${JSON.stringify(canonicalHTTPURL(tree.canonical))}`] : []),
      ...(tree.canonical ? [`endpoint: ${JSON.stringify(tree.canonical.endpoint)}`] : []),
      ...(tree.canonical ? [`canonicalPath: ${JSON.stringify(tree.canonical.path)}`] : []),
      `access: ${tree.access}`,
      ...(tree.sync ? [`sync: ${tree.sync}`] : []),
      ...(conflict ? [
        `conflictCurrent: ${JSON.stringify({ update: conflict.details.current.id, root: conflict.details.current.root })}`,
        `conflictBase: ${JSON.stringify(conflict.details.base)}`,
        `conflictCandidate: ${JSON.stringify(conflict.details.candidate)}`,
        `conflictDraft: ${JSON.stringify(conflict.details.draft.root)}`,
        `conflicts: ${JSON.stringify(conflict.details.conflicts)}`,
      ] : []),
      "---",
      "",
      `# ${tree.name}`,
      "",
    ].join("\n");
  }

  private async systemRecordAt(path: string) {
    if (path === "/diagnostics") {
      return {
        segment: "diagnostics",
        record: {
          source: `---\ncount: ${this.trees.diagnostics().length}\n---\n\n# Diagnostics\n\n${this.trees.diagnostics().map((item) => `- ${item.message}`).join("\n")}\n`,
        },
      };
    }
    if (path === "/credentials") {
      const status = await this.communityConfig.status();
      return {
        segment: "credentials",
        record: {
          source: status
            ? `---\ncommunityAccount: connected\ncredential: ${JSON.stringify(status.record.credential)}\ncredentialAvailable: ${status.credentialAvailable}\n---\n\n# Credentials\n\nSecrets are held by the operating system.\n`
            : "---\ncommunityAccount: missing\n---\n\n# Credentials\n",
        },
      };
    }
    const visitedMatch = /^\/visited\/([^/]+)$/.exec(path);
    if (visitedMatch) {
      const visit = (await this.visitedTrees.list()).find((candidate) => candidate.id === visitedMatch[1]);
      if (!visit) return null;
      return {
        segment: visit.name,
        record: {
          source: [
            "---",
            `id: ${JSON.stringify(visit.id)}`,
            `tree: ${JSON.stringify(visit.tree)}`,
            `locator: ${JSON.stringify(visit.locator)}`,
            ...(visit.canonical ? [`canonical: ${JSON.stringify(visit.canonical)}`] : []),
            `visitedAt: ${JSON.stringify(visit.visitedAt)}`,
            "---",
            "",
            `# ${visit.name}`,
            "",
          ].join("\n"),
        },
      };
    }
    return null;
  }
}
