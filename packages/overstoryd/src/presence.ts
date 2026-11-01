// The presence hub (spec 12): every live presence entry, in this process's
// memory only. A restart or deploy empties it, and clients start over.

import { encodeSSEFrame, type PresenceAgent, type PresenceID, type PresencePage, type PresencePeer, type PresenceSelection, type PresenceUpdate } from "@ovst/protocol";
import { randomBytes } from "node:crypto";

/** Who opened a presence stream. Only an account's device can be listed. */
export interface PresenceCaller {
  account: string;
  device: string;
}

export interface PresenceJoin {
  /** Null for a caller who may read but is never listed (access link, anonymous). */
  caller: PresenceCaller | null;
  visible: boolean;
  /** An agent's label: its stream is listed as an agent of the caller's profile. */
  agent: string | null;
  name: string | null;
  /** Wakes the stream's reader when frames are waiting. */
  wake: () => void;
  /** Ends the stream, as for a consumer too slow to keep up. */
  close: () => void;
}

interface Entry {
  id: PresenceID;
  caller: PresenceCaller | null;
  visible: boolean;
  agent: string | null;
  name: string | null;
  page: PresencePage | null;
  selection: PresenceSelection | null;
  status: string | null;
  /** Frames waiting for this subscriber, keyed so a newer frame about the
   * same peer replaces an older one: at most one peer, cursor or leave frame
   * per peer is ever pending. */
  pending: Map<string, string>;
  wake: () => void;
  close: () => void;
  tokens: number;
  refilledAt: number;
}

export class PresenceNotFound extends Error {}
export class PresenceRefused extends Error {}
export class PresenceBusy extends Error {}

/** A subscriber that falls this far behind is closed; it starts over on reconnect. */
const MAX_PENDING = 512;

/** A stream's POSTs: a burst of this many, refilled at this many a second. */
const POST_BURST = 20;
const POSTS_PER_SECOND = 10;

function peerOf(entry: Entry): PresencePeer {
  const agent: PresenceAgent | null = entry.agent === null ? null : { label: entry.agent, status: entry.status };
  return { id: entry.id, profile: entry.caller!.account, name: entry.name, page: entry.page, agent };
}

function samePage(a: PresencePage | null, b: PresencePage | null): boolean {
  return a !== null && b !== null && a.path === b.path;
}

export class PresenceHub {
  private readonly trees = new Map<string, Map<PresenceID, Entry>>();

  /** Join a tree's presence. Returns the stream's entry ID and its first frame. */
  join(tree: string, join: PresenceJoin): { id: PresenceID; listed: boolean; ready: string } {
    const listed = join.caller !== null && (join.visible || join.agent !== null);
    const entry: Entry = {
      id: `pr_${randomBytes(16).toString("base64url")}`,
      caller: join.caller,
      visible: listed,
      agent: listed ? join.agent : null,
      name: join.name,
      page: null,
      selection: null,
      status: null,
      pending: new Map(),
      wake: join.wake,
      close: join.close,
      tokens: POST_BURST,
      refilledAt: Date.now(),
    };
    let entries = this.trees.get(tree);
    if (!entries) this.trees.set(tree, entries = new Map());
    const peers = [...entries.values()].filter((other) => other.visible).map(peerOf);
    entries.set(entry.id, entry);
    if (listed) this.fanOut(tree, entry, "peer", encodeSSEFrame({ event: "presence.peer", data: peerOf(entry) }), () => true);
    return {
      id: entry.id,
      listed,
      ready: encodeSSEFrame({ event: "presence.ready", data: { self: listed ? entry.id : null, peers } }),
    };
  }

  /** Leave: the stream closed, for whatever reason. */
  leave(tree: string, id: PresenceID): void {
    const entries = this.trees.get(tree);
    const entry = entries?.get(id);
    if (!entries || !entry) return;
    entries.delete(id);
    if (!entries.size) this.trees.delete(tree);
    if (!entry.visible) return;
    const frame = encodeSSEFrame({ event: "presence.leave", data: { id } });
    for (const other of entries.values()) {
      other.pending.delete(`peer:${id}`);
      other.pending.delete(`cursor:${id}`);
      this.enqueue(other, `leave:${id}`, frame);
    }
  }

  /** A POST from the stream's own caller; anyone else gets not-found. */
  update(tree: string, id: PresenceID, caller: PresenceCaller, update: PresenceUpdate): void {
    const entry = this.trees.get(tree)?.get(id);
    if (!entry || !entry.visible || entry.caller?.account !== caller.account || entry.caller.device !== caller.device) {
      throw new PresenceNotFound("Presence entry not found");
    }
    if (update.status !== undefined && entry.agent === null) throw new PresenceRefused("Only an agent's stream has a status");
    const now = Date.now();
    entry.tokens = Math.min(POST_BURST, entry.tokens + (now - entry.refilledAt) * POSTS_PER_SECOND / 1000);
    entry.refilledAt = now;
    if (entry.tokens < 1) throw new PresenceBusy("Too many presence updates");
    entry.tokens -= 1;
    let peerChanged = false;
    let cursorChanged = false;
    if (update.page !== undefined && !(update.page === null ? entry.page === null : samePage(update.page, entry.page) && update.page.stableKey === entry.page!.stableKey)) {
      entry.page = update.page;
      // Changing page clears the selection; receivers drop the old cursor
      // when a peer's page changes.
      entry.selection = null;
      peerChanged = true;
    }
    if (update.status !== undefined && update.status !== entry.status) {
      entry.status = update.status;
      peerChanged = true;
    }
    if (update.selection !== undefined) {
      entry.selection = entry.page === null ? null : update.selection;
      cursorChanged = true;
    }
    if (peerChanged) this.fanOut(tree, entry, "peer", encodeSSEFrame({ event: "presence.peer", data: peerOf(entry) }), () => true);
    if (cursorChanged) {
      const frame = encodeSSEFrame({ event: "presence.cursor", data: { id, selection: entry.selection } });
      // Cursors are reciprocal: only visible subscribers on the same page.
      this.fanOut(tree, entry, "cursor", frame, (other) => other.visible && samePage(other.page, entry.page));
    }
  }

  /** The frames waiting for a stream, oldest first; empties its queue. */
  take(tree: string, id: PresenceID): string[] {
    const entry = this.trees.get(tree)?.get(id);
    if (!entry) return [];
    const frames = [...entry.pending.values()];
    entry.pending.clear();
    return frames;
  }

  /** How many entries a tree has, listed or not. For tests and reports. */
  size(tree: string): number {
    return this.trees.get(tree)?.size ?? 0;
  }

  private fanOut(tree: string, from: Entry, kind: string, frame: string, to: (other: Entry) => boolean): void {
    for (const other of this.trees.get(tree)?.values() ?? []) {
      if (other !== from && to(other)) this.enqueue(other, `${kind}:${from.id}`, frame);
    }
  }

  private enqueue(entry: Entry, key: string, frame: string): void {
    // Delete first so a replaced frame moves to the end, after anything it follows.
    entry.pending.delete(key);
    entry.pending.set(key, frame);
    if (entry.pending.size > MAX_PENDING) return entry.close();
    entry.wake();
  }
}
