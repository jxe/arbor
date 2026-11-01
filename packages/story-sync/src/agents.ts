// Agents in placed folders (Agents 001 phase 7). Any agent working in a
// placed folder, such as a Claude Code session, reports here through
// `story agent status|done|hook`, and Story Sync shows it in the tree's
// presence (spec 12) as an agent of this device's person: its page, the
// range it last read or edited, and what it says it is doing.

import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { hashObject, type PresenceEvent, type PresencePage, type PresenceSelection, type PresenceUpdate, PRESENCE_LIMITS } from "@ovst/protocol";

/** Where an absolute path lives: its placed tree, the folder's root, and the logical page path. */
export interface AgentLocation {
  tree: string;
  root: string;
  path: string;
}

/** What sessions need of Story Sync, so tests can stand in for it. */
export interface AgentHost {
  locate(absolutePath: string): Promise<AgentLocation | null>;
  presence(tree: string): Promise<AgentPresenceClient | undefined>;
}

export interface AgentPresenceClient {
  presence(tree: string, options: { agent?: string; signal?: AbortSignal }): AsyncGenerator<PresenceEvent>;
  updatePresence(tree: string, id: string, update: PresenceUpdate): Promise<void>;
}

/** One report: from `story agent status|done`, or a hook's JSON payload. */
export interface AgentReport {
  /** The agent session, as a runner names it; otherwise a hook's own `session_id`; otherwise the latest session in the tree. */
  session?: string;
  /** The agent's working directory, which names the tree. */
  cwd: string;
  /** The agent's name, such as "Claude". */
  agent?: string;
  status?: string;
  done?: string;
  hook?: unknown;
}

export interface AgentReportResult {
  session: string;
  tree: string;
}

export interface AgentSessionsOptions {
  /** A session with no report for this long leaves. */
  quietMs?: number;
  /** How long the final line stays after `done`. */
  doneLingerMs?: number;
  /** Least time between presence POSTs; later changes coalesce. */
  updateIntervalMs?: number;
}

interface Session {
  key: string;
  tree: string;
  root: string;
  label: string;
  abort: AbortController;
  /** Resolves with the stream's PresenceID once ready, or null if it failed. */
  self: Promise<string | null>;
  client: AgentPresenceClient;
  pending: PresenceUpdate;
  flushTimer?: ReturnType<typeof setTimeout>;
  lastSent: number;
  quietTimer?: ReturnType<typeof setTimeout>;
  lastReport: number;
  ended: boolean;
}

const DEFAULT_LABEL = "Agent";

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const characters = [...flat];
  return characters.length <= max ? flat : `${characters.slice(0, max - 1).join("")}…`;
}

function fileName(path: string): string {
  const last = path.split("/").filter(Boolean).pop() ?? path;
  return last.replace(/\.md$/i, "");
}

/** The byte range of 1-based lines `offset` … `offset + limit - 1`. */
export function lineRange(bytes: Uint8Array, offset?: number, limit?: number): { anchor: number; head: number } {
  const starts = [0];
  for (let index = 0; index < bytes.length; index += 1) if (bytes[index] === 0x0a) starts.push(index + 1);
  const first = Math.max(1, offset ?? 1);
  const anchor = starts[Math.min(first - 1, starts.length - 1)] ?? 0;
  const last = limit === undefined ? starts.length : first - 1 + limit;
  const head = last < starts.length ? starts[last]! : bytes.length;
  return { anchor, head: Math.max(anchor, head) };
}

/** Where `text` now sits in the file's bytes: its first occurrence, or null. */
export function textRange(bytes: Uint8Array, text: string): { anchor: number; head: number } | null {
  if (!text) return null;
  const needle = new TextEncoder().encode(text);
  const index = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).indexOf(Buffer.from(needle));
  return index < 0 ? null : { anchor: index, head: index + needle.length };
}

/** What a hook reports, in the shape Claude Code sends it; anything else is ignored. */
interface HookPayload {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
}

export class AgentSessions {
  private readonly sessions = new Map<string, Session>();
  /** What each session said with `done`, kept after it leaves; the most recent 100. */
  private readonly results = new Map<string, string>();
  private readonly quietMs: number;
  private readonly doneLingerMs: number;
  private readonly updateIntervalMs: number;

  constructor(private readonly host: AgentHost, options: AgentSessionsOptions = {}) {
    this.quietMs = options.quietMs ?? 10 * 60_000;
    this.doneLingerMs = options.doneLingerMs ?? 5_000;
    this.updateIntervalMs = options.updateIntervalMs ?? 1000 / PRESENCE_LIMITS.cursorsPerSecond;
  }

  /** Sessions now shown, for status and tests. */
  list(): Array<{ session: string; tree: string; agent: string }> {
    return [...this.sessions.values()].filter((session) => !session.ended)
      .map((session) => ({ session: session.key, tree: session.tree, agent: session.label }));
  }

  /** Take one report. Null when `cwd` is not inside a placed tree: nothing to show. */
  async report(report: AgentReport): Promise<AgentReportResult | null> {
    const hook = (report.hook && typeof report.hook === "object" ? report.hook : undefined) as HookPayload | undefined;
    const cwd = hook?.cwd && isAbsolute(hook.cwd) ? hook.cwd : report.cwd;
    if (!isAbsolute(cwd)) throw new Error("An agent report's working directory must be absolute");
    const location = await this.host.locate(cwd);
    if (!location) return null;
    const key = report.session ?? hook?.session_id ?? this.latestIn(location.tree)?.key ?? `cwd:${location.tree}`;
    const session = await this.open(key, location, report.agent);
    if (!session) return null;
    session.lastReport = Date.now();
    this.armQuiet(session);

    if (report.status !== undefined) this.change(session, { status: oneLine(report.status, PRESENCE_LIMITS.statusCharacters) || null });
    if (hook) await this.applyHook(session, hook);
    if (report.done !== undefined) {
      const result = oneLine(report.done, PRESENCE_LIMITS.statusCharacters) || "Done";
      this.results.set(session.key, result);
      if (this.results.size > 100) this.results.delete(this.results.keys().next().value!);
      this.change(session, { status: result });
      this.finish(session, this.doneLingerMs);
    }
    return { session: session.key, tree: session.tree };
  }

  /** What a session said with `done`, if it did. */
  result(key: string): string | undefined {
    return this.results.get(key);
  }

  /** End a session now, as when its run stops. */
  end(key: string): void {
    const session = this.sessions.get(key);
    if (session) this.close(session);
  }

  async [Symbol.asyncDispose](): Promise<void> {
    for (const session of [...this.sessions.values()]) this.close(session);
  }

  private latestIn(tree: string): Session | undefined {
    let latest: Session | undefined;
    for (const session of this.sessions.values()) {
      if (session.tree === tree && !session.ended && (!latest || session.lastReport > latest.lastReport)) latest = session;
    }
    return latest;
  }

  private async open(key: string, location: AgentLocation, label: string | undefined): Promise<Session | null> {
    const existing = this.sessions.get(key);
    if (existing && !existing.ended && existing.tree === location.tree) return existing;
    if (existing) this.close(existing);
    const client = await this.host.presence(location.tree);
    if (!client) return null;
    const abort = new AbortController();
    const agent = oneLine(label ?? DEFAULT_LABEL, PRESENCE_LIMITS.labelCharacters) || DEFAULT_LABEL;
    let ready!: (id: string | null) => void;
    const self = new Promise<string | null>((resolve) => { ready = resolve; });
    const session: Session = {
      key, tree: location.tree, root: location.root, label: agent, abort, self, client,
      pending: {}, lastSent: 0, lastReport: Date.now(), ended: false,
    };
    this.sessions.set(key, session);
    // Drain the stream for as long as the session lasts: the roster is not
    // needed here, but an unread stream would back up at the host.
    void (async () => {
      try {
        for await (const event of client.presence(location.tree, { agent, signal: abort.signal })) {
          if (event.kind === "presence.ready") ready(event.ready.self);
        }
      } catch {
        // A lost stream is a lost entry; the next report reopens it.
      } finally {
        ready(null);
        if (!session.ended) this.close(session);
      }
    })();
    return session;
  }

  private async applyHook(session: Session, hook: HookPayload): Promise<void> {
    if (hook.hook_event_name === "SessionEnd") return this.finish(session, 0);
    if (hook.hook_event_name === "Stop") return this.change(session, { status: "Waiting" });
    const input = hook.tool_input ?? {};
    const file = typeof input.file_path === "string" ? input.file_path : typeof input.notebook_path === "string" ? input.notebook_path : undefined;
    if (!file) {
      if (hook.tool_name) this.change(session, { status: `Using ${oneLine(hook.tool_name, 40)}` });
      return;
    }
    const absolute = isAbsolute(file) ? file : resolve(session.root, file);
    const location = await this.host.locate(absolute);
    // A file outside this session's tree moves nothing.
    if (!location || location.tree !== session.tree) return;
    const page: PresencePage = { path: location.path, stableKey: null };
    let bytes: Uint8Array;
    try { bytes = new Uint8Array(await readFile(absolute)); } catch { return this.change(session, { page }); }
    const source = hashObject(bytes) as PresenceSelection["source"];
    const tool = hook.tool_name ?? "";
    let range: { anchor: number; head: number } | null = null;
    let status: string;
    if (tool === "Read") {
      range = lineRange(bytes, numberOf(input.offset), numberOf(input.limit));
      status = `Reading ${fileName(location.path)}`;
    } else if (tool === "Edit" || tool === "MultiEdit") {
      const edits = tool === "MultiEdit" && Array.isArray(input.edits) ? input.edits as Array<Record<string, unknown>> : [input];
      const last = edits[edits.length - 1];
      range = typeof last?.new_string === "string" ? textRange(bytes, last.new_string) : null;
      status = `Editing ${fileName(location.path)}`;
    } else if (tool === "Write") {
      range = { anchor: bytes.length, head: bytes.length };
      status = `Writing ${fileName(location.path)}`;
    } else {
      status = `${oneLine(tool || "Working", 40)} ${fileName(location.path)}`;
    }
    const selection: PresenceSelection | null = range ? { source, ...range } : null;
    this.change(session, { page, selection }, status);
  }

  /** Queue a change; POSTs are coalesced to the update interval. A fallback
   * status applies only when the agent has not set its own since. */
  private change(session: Session, update: PresenceUpdate, fallbackStatus?: string): void {
    if (session.ended) return;
    if (update.page !== undefined && session.pending.page !== undefined && update.page?.path !== session.pending.page?.path) {
      // A page change clears the selection at the host; send the queued page first.
      void this.flush(session);
    }
    Object.assign(session.pending, update);
    if (fallbackStatus !== undefined && update.status === undefined) session.pending.status = oneLine(fallbackStatus, PRESENCE_LIMITS.statusCharacters);
    if (session.flushTimer) return;
    const wait = Math.max(0, session.lastSent + this.updateIntervalMs - Date.now());
    session.flushTimer = setTimeout(() => { session.flushTimer = undefined; void this.flush(session); }, wait);
    (session.flushTimer as { unref?: () => void }).unref?.();
  }

  private async flush(session: Session): Promise<void> {
    if (session.flushTimer) { clearTimeout(session.flushTimer); session.flushTimer = undefined; }
    const update = session.pending;
    if (!Object.keys(update).length) return;
    session.pending = {};
    session.lastSent = Date.now();
    const id = await session.self;
    if (!id || session.ended) return;
    // A page change clears the selection, so the page goes first, then the rest.
    const { page, ...rest } = update;
    try {
      if (page !== undefined) await session.client.updatePresence(session.tree, id, { page });
      if (Object.keys(rest).length) await session.client.updatePresence(session.tree, id, rest);
    } catch {
      // Presence is best effort; the next change tries again.
    }
  }

  private finish(session: Session, afterMs: number): void {
    void this.flush(session);
    const timer = setTimeout(() => this.close(session), afterMs);
    (timer as { unref?: () => void }).unref?.();
  }

  private armQuiet(session: Session): void {
    if (session.quietTimer) clearTimeout(session.quietTimer);
    session.quietTimer = setTimeout(() => this.close(session), this.quietMs);
    (session.quietTimer as { unref?: () => void }).unref?.();
  }

  private close(session: Session): void {
    if (session.ended) return;
    session.ended = true;
    if (session.flushTimer) clearTimeout(session.flushTimer);
    if (session.quietTimer) clearTimeout(session.quietTimer);
    session.abort.abort();
    if (this.sessions.get(session.key) === session) this.sessions.delete(session.key);
  }
}

function numberOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
