// Runs (Agents 001 phase 8): Run on a task block asks Story Sync to start the
// person's own Claude Code headless in the tree's placed folder. Story Sync
// snapshots the folder first, shows the agent in presence while it works,
// removes the task block when it finishes, and can undo what it changed.

import { spawn, type ChildProcess } from "node:child_process";
import { constants, existsSync, statSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { createInterface } from "node:readline";
import { hashObject } from "@ovst/protocol";
import { AGENT_SKILL } from "./agent-skill.ts";
import type { AgentSessions } from "./agents.ts";

export type AgentRunState = "queued" | "running" | "finished" | "failed" | "stopped" | "undone";

export interface AgentRunRequest {
  tree: string;
  /** The page's logical path, as presence names it. */
  page: string;
  /** The task block's text, without its `> [!agent]` marker. */
  task: string;
}

export interface AgentRun {
  id: string;
  tree: string;
  page: string;
  task: string;
  state: AgentRunState;
  /** The agent's one-line result, or why the run failed. */
  result: string | null;
  /** Folder-relative paths the run changed. */
  changed: string[];
  /** Whether Undo Run can still take it back. */
  undoable: boolean;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface UndoResult {
  restored: string[];
  /** Changed again since the run; left alone. */
  skipped: string[];
}

/** What runs need of Story Sync, so tests can stand in for it. */
export interface AgentRunHost {
  /** The placed folder of a tree on this device, or null. */
  folder(tree: string): Promise<string | null>;
  /** Publish the folder's changes and wait until the host has them. */
  publish(tree: string): Promise<void>;
  /** Hold the folder's publishing while `holder` edits it (see AgentHost.hold). */
  hold?(tree: string, holder: string): void;
  /** Let go; the folder publishes once no one holds it. */
  release?(tree: string, holder: string): Promise<void>;
  /** Where runs keep their snapshots. */
  stateDirectory: string;
}

export interface AgentRunsOptions {
  /** The agent command; default: Claude Code, found by `findClaude`. */
  command?: string;
  /** Extra arguments before the agent's own, for tests. */
  argumentsFor?: (run: AgentRun, prompt: string, session: string) => string[];
  /** How long a snapshot is kept for Undo Run. */
  snapshotMs?: number;
}

/** Names never snapshotted or restored: Story Sync's own state and VCS metadata. */
const SKIPPED = new Set([".state", ".git", ".DS_Store"]);

/** Where Claude Code usually lives; Story Sync runs without the person's shell PATH. */
export function findClaude(environment: NodeJS.ProcessEnv = process.env): string | null {
  if (environment.STORY_CLAUDE_PATH) return environment.STORY_CLAUDE_PATH;
  const home = homedir();
  const candidates = [
    join(home, ".claude", "local", "claude"),
    join(home, ".local", "bin", "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
    join(home, ".npm-global", "bin", "claude"),
    ...(environment.PATH ?? "").split(":").filter(Boolean).map((directory) => join(directory, "claude")),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

/** The prompt a run gives the agent. */
export function runPrompt(run: Pick<AgentRun, "page" | "task">, section: string | null): string {
  return [
    `A person left you a task in Story, on the page ${run.page}${section ? `, in the section "${section}"` : ""}:`,
    "",
    run.task,
    "",
    "Do the task in this folder. Story removes the task block itself when you finish, so leave it in place.",
    'When you are done, run `story agent done "<what you did, in one line>"`.',
  ].join("\n");
}

/** A task block's lines in a Markdown page: `> [!agent] text`, with any `> ` continuation lines. */
export function findTaskBlock(source: string, task: string): { start: number; end: number; section: string | null } | null {
  const lines = source.split("\n");
  // The task arrives as the editor's plain text; the file may hold escapes and
  // emphasis delimiters, so both sides are compared without them.
  const plain = (value: string) => value.replace(/[\\*_~`]/g, "").replace(/\s+/g, " ").trim();
  const wanted = plain(task);
  let section: string | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const heading = /^#{1,6}\s+(.*)$/.exec(lines[index]!);
    if (heading) section = heading[1]!.trim();
    const marker = /^(\s*)>\s*\\?\[!agent\\?\]\s?(.*)$/i.exec(lines[index]!);
    if (!marker) continue;
    let end = index + 1;
    const text = [marker[2]!];
    // A line ending in a hard break (an odd run of `\`) continues the task, as Story writes a line break.
    while (end < lines.length && /(?:^|[^\\])(?:\\\\)*\\\r?$/.test(lines[end - 1]!) && /^\s*>/.test(lines[end]!)) {
      text.push(lines[end]!.replace(/^\s*>\s?/, ""));
      end += 1;
    }
    if (plain(text.join(" ")) === wanted) return { start: index, end, section };
  }
  return null;
}

/** The page without its task block, and one blank line it leaves behind. */
export function removeTaskBlock(source: string, task: string): string | null {
  const found = findTaskBlock(source, task);
  if (!found) return null;
  const lines = source.split("\n");
  let { start, end } = found;
  if (end < lines.length && lines[end]!.trim() === "" && (start === 0 || lines[start - 1]!.trim() === "")) end += 1;
  lines.splice(start, end - start);
  return lines.join("\n");
}

async function* walk(root: string, directory = root): AsyncGenerator<string> {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (SKIPPED.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(root, path);
    else if (entry.isFile()) yield relative(root, path).split(sep).join("/");
  }
}

async function fileHashes(root: string): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();
  for await (const path of walk(root)) {
    try { hashes.set(path, hashObject(new Uint8Array(await readFile(join(root, path))))); } catch { /* vanished */ }
  }
  return hashes;
}

/** Copy the folder's files, as clones where the filesystem can (APFS). */
async function snapshot(root: string, into: string): Promise<void> {
  for await (const path of walk(root)) {
    const target = join(into, path);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(root, path), target, constants.COPYFILE_FICLONE).catch(() => {});
  }
}

interface RunRecord extends AgentRun {
  folder?: string;
  snapshotDirectory?: string;
  /** Each changed file's hash right after the run, or null where it deleted it. */
  after?: Map<string, string | null>;
  process?: ChildProcess;
  session: string;
  stopRequested: boolean;
}

export class AgentRuns {
  private readonly runs = new Map<string, RunRecord>();
  /** Each tree's queue: runs on one tree go one at a time. */
  private readonly tails = new Map<string, Promise<void>>();
  private readonly snapshotMs: number;

  constructor(private readonly host: AgentRunHost, private readonly agents: AgentSessions, private readonly options: AgentRunsOptions = {}) {
    this.snapshotMs = options.snapshotMs ?? 24 * 60 * 60_000;
  }

  list(): AgentRun[] {
    return [...this.runs.values()].map((run) => this.view(run));
  }

  get(id: string): AgentRun | undefined {
    const run = this.runs.get(id);
    return run ? this.view(run) : undefined;
  }

  /** Queue a run; it starts when the tree's earlier runs finish. */
  async start(request: AgentRunRequest): Promise<AgentRun> {
    const folder = await this.host.folder(request.tree);
    if (!folder) throw new AgentRunError("not-placed", "This tree is not placed on this Mac, so it cannot run a task here.");
    const command = this.options.command ?? findClaude();
    if (!command) throw new AgentRunError("no-agent", "Story could not find Claude Code. Install it, or set its path in STORY_CLAUDE_PATH.");
    const id = `run_${crypto.randomUUID().replaceAll("-", "")}`;
    const run: RunRecord = {
      id, tree: request.tree, page: request.page, task: request.task.trim(), state: "queued", result: null,
      changed: [], undoable: false, startedAt: null, finishedAt: null, folder,
      session: crypto.randomUUID(), stopRequested: false,
    };
    this.runs.set(id, run);
    const previous = this.tails.get(request.tree) ?? Promise.resolve();
    const next = previous.then(() => this.execute(run, command)).catch(() => {});
    this.tails.set(request.tree, next);
    return this.view(run);
  }

  /** Stop a queued or running run; what it already changed stays, and can be undone. */
  stop(id: string): AgentRun {
    const run = this.require(id);
    run.stopRequested = true;
    if (run.state === "queued") { run.state = "stopped"; run.finishedAt = Date.now(); }
    run.process?.kill("SIGTERM");
    return this.view(run);
  }

  /** Restore every file the run changed that is still as the run left it. */
  async undo(id: string): Promise<UndoResult> {
    const run = this.require(id);
    if (!run.undoable || !run.after || !run.snapshotDirectory || !run.folder) throw new AgentRunError("not-undoable", "This run can no longer be undone.");
    const restored: string[] = [];
    const skipped: string[] = [];
    for (const [path, afterHash] of run.after) {
      const live = join(run.folder, path);
      const current = await readFile(live).then((bytes) => hashObject(new Uint8Array(bytes)), () => null);
      if (current !== afterHash) { skipped.push(path); continue; }
      const saved = join(run.snapshotDirectory, path);
      if (existsSync(saved)) {
        await mkdir(dirname(live), { recursive: true });
        await copyFile(saved, live);
      } else {
        await rm(live, { force: true });
      }
      restored.push(path);
    }
    run.state = "undone";
    run.undoable = false;
    await rm(run.snapshotDirectory, { recursive: true, force: true });
    await this.host.publish(run.tree).catch(() => {});
    return { restored, skipped };
  }

  async [Symbol.asyncDispose](): Promise<void> {
    for (const run of this.runs.values()) run.process?.kill("SIGTERM");
  }

  private require(id: string): RunRecord {
    const run = this.runs.get(id);
    if (!run) throw new AgentRunError("not-found", "No such run");
    return run;
  }

  private view(run: RunRecord): AgentRun {
    const { id, tree, page, task, state, result, changed, undoable, startedAt, finishedAt } = run;
    return { id, tree, page, task, state, result, changed: [...changed], undoable, startedAt, finishedAt };
  }

  private async execute(run: RunRecord, command: string): Promise<void> {
    if (run.stopRequested) return;
    const folder = run.folder!;
    run.state = "running";
    run.startedAt = Date.now();
    // An earlier run's snapshot goes when the next run on its tree starts.
    for (const other of this.runs.values()) {
      if (other !== run && other.tree === run.tree && other.snapshotDirectory) {
        await rm(other.snapshotDirectory, { recursive: true, force: true });
        other.snapshotDirectory = undefined;
        other.undoable = false;
      }
    }
    const pagePath = this.pageFile(folder, run.page);
    const source = pagePath ? await readFile(pagePath, "utf8").catch(() => null) : null;
    const section = source ? findTaskBlock(source, run.task)?.section ?? null : null;
    run.snapshotDirectory = join(this.host.stateDirectory, "agent-runs", run.id);
    await rm(run.snapshotDirectory, { recursive: true, force: true });
    await snapshot(folder, run.snapshotDirectory);
    const before = await fileHashes(folder);
    // The agent's edits and the task block's removal go up as one change.
    // Held under the run's session, which the agent's own reports hold too.
    this.host.hold?.(run.tree, run.session);

    const report = (body: { status?: string; done?: string; hook?: unknown }) =>
      this.agents.report({ cwd: folder, session: run.session, agent: "Claude", ...body }).catch(() => null);
    await report({ status: "Starting" });
    // Show the agent at the task block from the start.
    if (pagePath) await report({ hook: { hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: pagePath } } });

    const prompt = runPrompt(run, section);
    const args = this.options.argumentsFor?.(run, prompt, run.session) ?? [
      "-p", prompt,
      "--output-format", "stream-json", "--verbose",
      "--session-id", run.session,
      "--permission-mode", "acceptEdits",
      "--allowedTools", "Read,Edit,MultiEdit,Write,Glob,Grep,Bash(story agent:*),Bash(story sync status:*)",
      "--append-system-prompt", AGENT_SKILL,
    ];
    let finalText: string | null = null;
    // Tool reports still in flight when the agent exits land before its result.
    const reports: Array<Promise<unknown>> = [];
    const exit = await new Promise<{ code: number | null; error?: string }>((resolve) => {
      const child = spawn(command, args, {
        cwd: folder,
        // STORY_AGENT_RUN quiets `story agent hook`: this runner reports the tools itself.
        env: { ...process.env, STORY_AGENT_SESSION: run.session, STORY_AGENT_LABEL: "Claude", STORY_AGENT_RUN: run.id },
        stdio: ["ignore", "pipe", "pipe"],
      });
      run.process = child;
      let stderr = "";
      child.stderr!.on("data", (chunk) => { stderr = (stderr + String(chunk)).slice(-2000); });
      // The agent's own tool calls show where it is, whether or not its hooks are installed.
      const pending = new Map<string, { name: string; input: unknown }>();
      createInterface({ input: child.stdout! }).on("line", (line) => {
        let message: { type?: string; message?: { content?: unknown }; result?: unknown };
        try { message = JSON.parse(line); } catch { return; }
        const content = Array.isArray(message.message?.content) ? message.message!.content as Array<Record<string, unknown>> : [];
        for (const part of content) {
          if (part.type === "tool_use" && typeof part.id === "string") pending.set(part.id, { name: String(part.name), input: part.input });
          if (part.type === "tool_result" && typeof part.tool_use_id === "string") {
            const call = pending.get(part.tool_use_id);
            pending.delete(part.tool_use_id);
            if (call && !part.is_error) reports.push(report({ hook: { hook_event_name: "PostToolUse", tool_name: call.name, tool_input: call.input } }));
          }
        }
        if (message.type === "result" && typeof message.result === "string") finalText = message.result;
      });
      child.on("error", (error) => resolve({ code: null, error: error.message }));
      child.on("close", (code) => resolve({ code, ...(code === 0 ? {} : { error: stderr.trim().split("\n").pop() || `exited with ${code}` }) }));
    });
    run.process = undefined;
    await Promise.all(reports);

    const after = await fileHashes(folder);
    const changes = new Map<string, string | null>();
    for (const [path, hash] of after) if (before.get(path) !== hash) changes.set(path, hash);
    for (const path of before.keys()) if (!after.has(path)) changes.set(path, null);

    if (run.stopRequested) {
      run.state = "stopped";
      run.result = "Stopped";
    } else if (exit.code === 0) {
      run.state = "finished";
      // The task is done: its block goes, and history keeps it.
      if (pagePath) {
        const current = await readFile(pagePath, "utf8").catch(() => null);
        const without = current === null ? null : removeTaskBlock(current, run.task);
        if (without !== null) {
          await writeFile(pagePath, without);
          const relativePage = relative(folder, pagePath).split(sep).join("/");
          changes.set(relativePage, hashObject(new TextEncoder().encode(without)));
        }
      }
      run.result = this.resultLine(run, finalText);
    } else {
      run.state = "failed";
      run.result = exit.error ?? "The agent failed";
    }
    run.after = changes;
    run.changed = [...changes.keys()].sort();
    run.undoable = changes.size > 0;
    run.finishedAt = Date.now();
    if (!run.undoable) {
      await rm(run.snapshotDirectory, { recursive: true, force: true });
      run.snapshotDirectory = undefined;
    } else {
      const directory = run.snapshotDirectory;
      const timer = setTimeout(() => {
        if (run.snapshotDirectory !== directory) return;
        run.undoable = false;
        run.snapshotDirectory = undefined;
        void rm(directory, { recursive: true, force: true });
      }, this.snapshotMs);
      (timer as { unref?: () => void }).unref?.();
    }
    await this.host.release?.(run.tree, run.session).catch(() => {});
    await this.host.publish(run.tree).catch(() => {});
    // The agent's own `done` already showed its result; otherwise show the run's.
    if (run.state !== "finished" || this.agents.result(run.session) === undefined) {
      await report({ done: run.state === "finished" ? run.result! : `${run.state === "stopped" ? "Stopped" : "Failed"}: ${run.result}` });
    }
  }

  /** The agent's own `done` line if it said one, otherwise its final message's first line. */
  private resultLine(run: RunRecord, finalText: string | null): string {
    const said = this.agents.result(run.session);
    if (said) return said;
    const first = finalText?.split("\n").map((line) => line.trim()).find(Boolean);
    return first ? [...first].slice(0, 140).join("") : "Done";
  }

  /** The page's file in the folder: the path itself, or its `.md` sibling. */
  private pageFile(folder: string, page: string): string | null {
    const trimmed = page.replace(/^\/+/, "");
    if (!trimmed) return null;
    for (const candidate of [trimmed, `${trimmed}.md`, `${trimmed}/_index.md`]) {
      const path = join(folder, candidate);
      if (!relative(folder, path).startsWith("..") && existsSync(path) && !isDirectory(path)) return path;
    }
    return null;
  }
}

function isDirectory(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

export class AgentRunError extends Error {
  constructor(readonly code: "not-placed" | "no-agent" | "not-found" | "not-undoable", message: string) {
    super(message);
  }
}

