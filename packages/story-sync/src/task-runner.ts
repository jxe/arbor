// The Mac as a runner (Agents 002 phase 3, spec 12 §6). Story Sync keeps a
// runner stream, labelled with the Mac's name, open on every tree placed
// here, so the person's other devices see it in presence and can send it a
// task. A `run` message starts the person's agent on it as Run on the Mac
// does (`AgentRuns`), `stop` stops it, and the sender is told `done` with
// the result when it ends. Running is on unless the person turns it off.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { PRESENCE_LIMITS, type PresenceEvent, type PresenceID, type PresenceMessage, type PresenceMessageBody } from "@ovst/protocol";
import type { AgentRun, AgentRuns } from "./agent-runs.ts";

export interface RunnerPresenceClient {
  presence(tree: string, options: { runner: string; device?: "mac"; signal?: AbortSignal }): AsyncGenerator<PresenceEvent>;
  sendPresenceMessage(tree: string, from: PresenceID, to: PresenceID, body: PresenceMessageBody): Promise<void>;
}

/** What the runner needs of Story Sync, so tests can stand in for it. */
export interface TaskRunnerHost {
  /** The trees placed in a folder on this device. */
  trees(): Promise<string[]>;
  presence(tree: string): Promise<RunnerPresenceClient | undefined>;
}

export interface TaskRunnerOptions {
  /** Where the on/off setting is kept. */
  settingsPath: string;
  /** The runner's label in presence; default: this Mac's name. */
  label?: string;
  /** How often streams that ended are opened again, and new placements picked up. */
  refreshMs?: number;
}

export interface TaskRunnerStatus {
  enabled: boolean;
  label: string;
  /** The trees whose runner stream is open now. */
  trees: string[];
}

interface Stream {
  abort: AbortController;
  /** This stream's presence entry, once ready. */
  self: PresenceID | null;
  client: RunnerPresenceClient;
}

/** The Mac's name as people know it ("Joe's MacBook Air"), else its host name. */
export function deviceName(): string {
  let name = "";
  if (process.platform === "darwin") {
    try { name = execFileSync("scutil", ["--get", "ComputerName"], { encoding: "utf8", timeout: 2000 }).trim(); } catch { /* fall back */ }
  }
  name ||= hostname().replace(/\.local$/i, "");
  const flat = name.replace(/\s+/g, " ").trim() || "This Mac";
  return [...flat].slice(0, PRESENCE_LIMITS.labelCharacters).join("");
}

/** What a run's sender is told when it ends. */
export function doneResult(run: AgentRun): string {
  if (run.state === "finished") return run.result ?? "Done";
  if (run.state === "stopped") return "Stopped";
  return `Failed: ${run.result ?? "the agent failed"}`;
}

export class TaskRunner {
  private readonly streams = new Map<string, Stream>();
  private readonly label: string;
  private readonly refreshMs: number;
  private timer?: ReturnType<typeof setInterval>;
  private refreshing?: Promise<void>;
  private disposed = false;

  constructor(private readonly host: TaskRunnerHost, private readonly runs: AgentRuns, private readonly options: TaskRunnerOptions) {
    this.label = options.label ?? deviceName();
    this.refreshMs = options.refreshMs ?? 30_000;
  }

  /** Whether this device runs tasks: on unless the person turned it off. */
  get enabled(): boolean {
    try {
      const saved = JSON.parse(readFileSync(this.options.settingsPath, "utf8")) as { enabled?: unknown };
      return saved.enabled !== false;
    } catch { return true; }
  }

  async setEnabled(enabled: boolean): Promise<TaskRunnerStatus> {
    await mkdir(dirname(this.options.settingsPath), { recursive: true });
    await writeFile(this.options.settingsPath, `${JSON.stringify({ enabled })}\n`);
    await this.refresh();
    return this.status();
  }

  status(): TaskRunnerStatus {
    return { enabled: this.enabled, label: this.label, trees: [...this.streams.entries()].filter(([, stream]) => stream.self).map(([tree]) => tree).sort() };
  }

  /** Keep streams open from now on. */
  start(): void {
    void this.refresh();
    this.timer = setInterval(() => { void this.refresh(); }, this.refreshMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  /** Open a stream on each placed tree that lacks one, and close those no longer wanted. */
  refresh(): Promise<void> {
    this.refreshing ??= this.reconcile().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }

  private async reconcile(): Promise<void> {
    const wanted = this.enabled && !this.disposed ? new Set(await this.host.trees().catch(() => [])) : new Set<string>();
    for (const [tree, stream] of this.streams) {
      if (!wanted.has(tree)) { stream.abort.abort(); this.streams.delete(tree); }
    }
    for (const tree of wanted) {
      if (this.streams.has(tree)) continue;
      const client = await this.host.presence(tree).catch(() => undefined);
      if (client && !this.disposed) this.open(tree, client);
    }
  }

  private open(tree: string, client: RunnerPresenceClient): void {
    const stream: Stream = { abort: new AbortController(), self: null, client };
    this.streams.set(tree, stream);
    void (async () => {
      try {
        for await (const event of client.presence(tree, { runner: this.label, device: "mac", signal: stream.abort.signal })) {
          if (event.kind === "presence.ready") stream.self = event.ready.self;
          else if (event.kind === "presence.message") void this.receive(tree, stream, event.message);
        }
      } catch {
        // A lost stream is opened again on the next refresh.
      } finally {
        if (this.streams.get(tree) === stream) this.streams.delete(tree);
      }
    })();
  }

  /** One message from another of the person's streams. A runner only acts on `run` and `stop`. */
  private async receive(tree: string, stream: Stream, message: PresenceMessage): Promise<void> {
    const { from, body } = message;
    const reply = async (result: string, run: string) => {
      if (!stream.self || stream.abort.signal.aborted) return;
      await stream.client.sendPresenceMessage(tree, stream.self, from, { kind: "done", run, result }).catch(() => {});
    };
    if (body.kind === "stop") {
      const run = this.runs.get(body.run);
      if (run && run.tree === tree) { try { this.runs.stop(body.run); } catch { /* already gone */ } }
      return;
    }
    if (body.kind !== "run") return;
    const { request } = body;
    let started: AgentRun;
    try {
      // The stream's own tree, whatever URL the request names it by.
      started = await this.runs.start({ tree, page: request.page.path, task: request.task.text, run: request.run, range: request.task.range });
    } catch (error) {
      return reply(`Failed: ${error instanceof Error ? error.message : String(error)}`, request.run);
    }
    const ended = await this.runs.ended(started.id);
    await reply(doneResult(ended), request.run);
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    await this.refreshing?.catch(() => {});
    for (const stream of this.streams.values()) stream.abort.abort();
    this.streams.clear();
  }
}
