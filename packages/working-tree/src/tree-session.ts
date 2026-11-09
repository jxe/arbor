import type { CurrentTree, ObjectHash, ProtocolClient } from "@ovst/protocol";
import { hostSource, memorySource, ObjectSourceChain, type ObjectSource } from "@ovst/object-store/sources";
import { NodeIndex, type Prefetch } from "./node-index.ts";

/**
 * How a session holds a tree (Clients 003 module 5). The TypeScript twin of
 * Swift's `TreeSessionSettings`: what to fetch ahead, and where objects come
 * from besides what the session already holds. Editing goes through an
 * `UpdateCoordinator` over the session's index or a folder; the session
 * itself only reads.
 */
export interface TreeSessionSettings {
  prefetch: Prefetch;
  /** Tried in order before the host. */
  sources: ObjectSource[];
  /** Whether the host is the chain's last source. */
  host: boolean;
}

/** Browse: opened pages, from the host, nothing kept. Visits, and trees too big for the device. */
export function browseSettings(): TreeSessionSettings {
  return { prefetch: "opened-pages", sources: [], host: true };
}

/** Replica: everything, from `cache` (a disk store) and then the host. */
export function replicaSettings(cache: ObjectSource): TreeSessionSettings {
  return { prefetch: "everything", sources: [cache], host: true };
}

/**
 * Alongside Story Sync: objects only from Story Sync's loopback reads; the
 * host is never asked directly.
 */
export function alongsideStorySyncSettings(reads: Pick<ProtocolClient, "object">, tree: string): TreeSessionSettings {
  return { prefetch: "opened-pages", sources: [hostSource(reads, tree)], host: false };
}

type SessionClient = Pick<ProtocolClient, "descriptor" | "object"> & Partial<Pick<ProtocolClient, "pathRead" | "watch">>;

/**
 * One open tree: its current accepted state, a lazy node index over it, and
 * the object source chain both read through. A page opens with one path read
 * where the host serves them; what it brings is held in memory, ahead of
 * every other source.
 */
export class TreeSession {
  private readonly held = new Map<string, Uint8Array>();
  readonly objects: ObjectSourceChain;
  readonly index: NodeIndex;
  private currentTree: CurrentTree;

  private constructor(
    readonly tree: string,
    private readonly client: SessionClient,
    readonly settings: TreeSessionSettings,
    current: CurrentTree,
  ) {
    this.currentTree = current;
    this.objects = new ObjectSourceChain([
      memorySource(this.held),
      ...settings.sources,
      ...(settings.host ? [hostSource(client, tree)] : []),
    ]);
    this.index = new NodeIndex(current.tree.root as ObjectHash, this.objects);
  }

  /** Open `tree` with `settings`. `opening` is the current tree the caller already read. */
  static async open(tree: string, client: SessionClient, settings: TreeSessionSettings, opening?: CurrentTree): Promise<TreeSession> {
    const session = new TreeSession(tree, client, settings, opening ?? await client.descriptor(tree));
    await session.index.prefetch(settings.prefetch, async (hash) => session.keep(hash));
    return session;
  }

  get current(): CurrentTree {
    return this.currentTree;
  }

  get root(): ObjectHash {
    return this.currentTree.tree.root as ObjectHash;
  }

  private async keep(hash: string): Promise<void> {
    if (this.held.has(hash)) return;
    const bytes = await this.objects.object(hash);
    if (bytes) this.held.set(hash, bytes);
  }

  /**
   * Open the page at `path`: one path read when the client serves them,
   * otherwise the index's own walk. Returns the objects it brought.
   */
  async openPage(path: string): Promise<Map<ObjectHash, Uint8Array>> {
    const root = this.root;
    if (this.client.pathRead && this.settings.host) {
      const objects = await this.client.pathRead(this.tree, root, path);
      for (const [hash, bytes] of objects) this.held.set(hash, bytes);
      // The index decodes the directories it brought from the held copies.
      await this.index.pathRead(path);
      return objects;
    }
    const objects = await this.index.pathRead(path);
    for (const [hash, bytes] of objects) this.held.set(hash, bytes);
    return objects;
  }

  /** Move to a newer accepted state; directories already held are reused. */
  advance(current: CurrentTree): void {
    this.currentTree = current;
    this.index.rebase(current.tree.root as ObjectHash);
  }

  /**
   * Follow the host's watch without payloads (tree operations §1.1.3): each
   * accepted update moves the index to its root, and the pages a reader
   * opens load again from there. A `resync-required` rereads the current
   * tree. Ends when `signal` aborts.
   */
  async follow(signal: AbortSignal, onChange: (current: CurrentTree) => void = () => {}): Promise<void> {
    if (!this.client.watch) throw new Error("This client cannot watch");
    let after: string | null = this.currentTree.observedThrough;
    while (!signal.aborted) {
      for await (const event of this.client.watch(this.tree, after, { signal, objects: "none" })) {
        if (event.kind === "resync-required") {
          this.advance(await this.client.descriptor(this.tree));
          after = this.currentTree.observedThrough;
          onChange(this.currentTree);
          break;
        }
        after = event.cursor;
        this.advance({
          tree: { ...this.currentTree.tree, root: event.transition.update.root as CurrentTree["tree"]["root"], update: event.transition.update.id,
            conflicted: event.transition.update.conflicted, access: event.access, canonical: event.canonical },
          observedThrough: event.cursor,
        });
        onChange(this.currentTree);
      }
    }
  }
}
