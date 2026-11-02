// Presence (spec 12): who is in a tree, on which page, and where their caret
// is. Ephemeral by construction: never part of a tree, its history or a watch.

import type { Hash, LogicalPath, TreeID } from "./identifiers.ts";

/** Opaque, unguessable, valid only for the stream that received it. */
export type PresenceID = string;

/** A page as a presence entry names it. */
export interface PresencePage {
  path: LogicalPath;
  stableKey: string | null;
}

/** UTF-8 byte offsets into the file object whose hash is `source`. */
export interface PresenceSelection {
  source: Hash;
  anchor: number;
  head: number;
}

/** What an agent's entry says beyond a person's. */
export interface PresenceAgent {
  /** The agent's name, such as "Claude"; the client adds the device. */
  label: string;
  status: string | null;
}

/** What a client says it runs on; a hint for showing the entry. */
export type PresenceDevice = "mac" | "ios";

export interface PresencePeer {
  id: PresenceID;
  profile: TreeID;
  name: string | null;
  page: PresencePage | null;
  /** Null for a person. */
  agent: PresenceAgent | null;
  /** Null when the client didn't say. */
  device: PresenceDevice | null;
}

export interface PresenceReady {
  /** Null when the subscriber is not visible. */
  self: PresenceID | null;
  peers: PresencePeer[];
}

export interface PresenceCursor {
  id: PresenceID;
  selection: PresenceSelection | null;
}

export interface PresenceLeave {
  id: PresenceID;
}

export type PresenceEvent =
  | { kind: "presence.ready"; ready: PresenceReady }
  | { kind: "presence.peer"; peer: PresencePeer }
  | { kind: "presence.cursor"; cursor: PresenceCursor }
  | { kind: "presence.leave"; leave: PresenceLeave };

/** The body of `POST …/presence/{PresenceID}`; an omitted member is unchanged. */
export interface PresenceUpdate {
  page?: PresencePage | null;
  selection?: PresenceSelection | null;
  /** Accepted only on an agent stream. */
  status?: string | null;
}

/** Presence bounds (spec 12 §5). */
export const PRESENCE_LIMITS = {
  /** Largest POST body, in bytes. */
  bodyBytes: 1024,
  /** Longest status line, in characters. */
  statusCharacters: 140,
  /** Longest agent label, in characters. */
  labelCharacters: 40,
  /** Most cursor updates a client sends a second. */
  cursorsPerSecond: 4,
  /** Largest plausible byte offset in a selection. */
  maxOffset: 2 ** 32 - 1,
} as const;

export const PRESENCE_EVENT_KINDS = ["presence.ready", "presence.peer", "presence.cursor", "presence.leave"] as const;

export class PresenceDecodeError extends Error {}

function fail(message: string): never {
  throw new PresenceDecodeError(message);
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${what} must be an object`);
  return value as Record<string, unknown>;
}

function characters(value: string): number {
  return [...value].length;
}

function text(value: unknown, what: string): string {
  if (typeof value !== "string" || !value) fail(`${what} must be a non-empty string`);
  return value;
}

function line(value: unknown, what: string, max: number): string {
  const result = text(value, what);
  if (characters(result) > max || /[\r\n]/.test(result)) fail(`${what} must be one line of at most ${max} characters`);
  return result;
}

function offset(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > PRESENCE_LIMITS.maxOffset) {
    fail(`${what} must be a byte offset`);
  }
  return value;
}

export function decodePresencePage(value: unknown): PresencePage | null {
  if (value === null) return null;
  const page = record(value, "page");
  const path = text(page.path, "page.path");
  if (path.includes("\0")) fail("page.path must not contain NUL");
  if (page.stableKey !== null && typeof page.stableKey !== "string") fail("page.stableKey must be a string or null");
  return { path, stableKey: page.stableKey as string | null };
}

export function decodePresenceSelection(value: unknown): PresenceSelection | null {
  if (value === null) return null;
  const selection = record(value, "selection");
  if (typeof selection.source !== "string" || !/^sha256:[0-9a-f]{64}$/.test(selection.source)) fail("selection.source must be a sha256 hash");
  return {
    source: selection.source as Hash,
    anchor: offset(selection.anchor, "selection.anchor"),
    head: offset(selection.head, "selection.head"),
  };
}

export function decodePresenceStatus(value: unknown): string | null {
  return value === null ? null : line(value, "status", PRESENCE_LIMITS.statusCharacters);
}

function decodeAgent(value: unknown): PresenceAgent | null {
  if (value === null) return null;
  const agent = record(value, "agent");
  return { label: line(agent.label, "agent.label", PRESENCE_LIMITS.labelCharacters), status: decodePresenceStatus(agent.status) };
}

/** A device kind from a query parameter or a peer; anything else is no kind. */
export function decodePresenceDevice(value: unknown): PresenceDevice | null {
  return value === "mac" || value === "ios" ? value : null;
}

export function decodePresencePeer(value: unknown): PresencePeer {
  const peer = record(value, "peer");
  if (peer.name !== null && typeof peer.name !== "string") fail("peer.name must be a string or null");
  return {
    id: text(peer.id, "peer.id"),
    profile: text(peer.profile, "peer.profile"),
    name: peer.name as string | null,
    page: decodePresencePage(peer.page),
    agent: decodeAgent(peer.agent),
    device: decodePresenceDevice(peer.device),
  };
}

/** One presence frame's event and data, decoded; anything else is refused. */
export function decodePresenceEvent(event: string | undefined, data: unknown): PresenceEvent {
  switch (event) {
    case "presence.ready": {
      const ready = record(data, "ready");
      if (ready.self !== null && typeof ready.self !== "string") fail("ready.self must be a string or null");
      if (!Array.isArray(ready.peers)) fail("ready.peers must be an array");
      return { kind: event, ready: { self: ready.self as string | null, peers: ready.peers.map(decodePresencePeer) } };
    }
    case "presence.peer":
      return { kind: event, peer: decodePresencePeer(data) };
    case "presence.cursor": {
      const cursor = record(data, "cursor");
      return { kind: event, cursor: { id: text(cursor.id, "cursor.id"), selection: decodePresenceSelection(cursor.selection) } };
    }
    case "presence.leave":
      return { kind: event, leave: { id: text(record(data, "leave").id, "leave.id") } };
    default:
      fail(`unsupported presence event ${JSON.stringify(event)}`);
  }
}

/** A POST body's members, decoded; unknown members are refused. */
export function decodePresenceUpdate(value: unknown): PresenceUpdate {
  const body = record(value, "update");
  const update: PresenceUpdate = {};
  for (const key of Object.keys(body)) {
    if (key === "page") update.page = decodePresencePage(body.page);
    else if (key === "selection") update.selection = decodePresenceSelection(body.selection);
    else if (key === "status") update.status = decodePresenceStatus(body.status);
    else fail(`unknown presence update member ${JSON.stringify(key)}`);
  }
  return update;
}

/** An agent label as a stream's `agent` query parameter carries it. */
export function decodePresenceAgentLabel(value: string): string {
  return line(value, "agent", PRESENCE_LIMITS.labelCharacters);
}
