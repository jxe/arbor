import type { ChildrenPage, NodeResponse } from "@arbor/core";
import { SYSTEM_TREE, revisionOf } from "@arbor/core";
import { parseMarkdown } from "@arbor/editor";
import type { CommunityConfigStore, VisitedTreeStore } from "@arbor/stores";
import type { EventBus } from "./events.ts";
import { sampleExpandedNode as sampleNode, summarizeSample } from "./node-sampling.ts";

/**
 * System records reuse the expanded-node sampler for their properties and
 * capabilities, but `system:` nodes never carry stable keys: the sampler's
 * PageID-derived key would only be rejected when a client dereferenced it.
 */
function sampleExpandedNode(...args: Parameters<typeof sampleNode>): ReturnType<typeof sampleNode> {
  const sample = sampleNode(...args);
  return { ...sample, ref: { ...sample.ref, stableKey: null } };
}
import type { TreeManager } from "./tree-manager.ts";
import { ProtocolError } from "./workspace.ts";

export interface SystemTreeDeps {
  trees: TreeManager;
  events: EventBus;
  communityConfig: CommunityConfigStore;
  visitedTrees: VisitedTreeStore;
}

/** The read-only `system:` tree: safe diagnostic projections over local daemon state. */
export class SystemTreeProjection {
  private readonly trees: TreeManager;
  private readonly events: EventBus;
  private readonly communityConfig: CommunityConfigStore;
  private readonly visitedTrees: VisitedTreeStore;

  constructor(deps: SystemTreeDeps) {
    this.trees = deps.trees;
    this.events = deps.events;
    this.communityConfig = deps.communityConfig;
    this.visitedTrees = deps.visitedTrees;
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
