// Runs (Agents 001 phase 8): Run on a task block asks Story Sync to start the
// person's own Claude Code headless in the tree's placed folder. Story Sync
// snapshots the folder first, shows the agent in presence while it works,
// marks the task block done (`> [!agent-done]`) when it finishes, and can undo
// what it changed. Finished runs and their snapshots survive a restart.

import { spawn, type ChildProcess } from "node:child_process";
import { constants, existsSync, readFileSync, statSync } from "node:fs";
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
  /** Permission rules for the tools the run was refused, less any allowed since. */
  blocked: string[];
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
  /** The person's extra grants, passed with `--settings`; default: `agent-settings.json` beside the state directory. */
  settingsPath?: string;
}

/** Names never snapshotted or restored: Story Sync's own state and VCS metadata. */
const SKIPPED = new Set([".state", ".git", ".DS_Store"]);

/** What every run may use. More comes from the person's own settings, never from the tree. */
export const RUN_TOOLS = [
  "Read", "Edit", "MultiEdit", "Write", "Glob", "Grep", "WebFetch", "WebSearch", "Task",
  "Bash(story agent:*)", "Bash(story sync status:*)",
  "Bash(ls:*)", "Bash(rg:*)", "Bash(git log:*)", "Bash(git diff:*)", "Bash(git status:*)", "Bash(git show:*)",
  // Connectors, read tools only: Undo Run cannot take back what a write tool does.
  ...["read_file_content", "download_file_content", "get_file_metadata", "search_files", "list_recent_files"].map((tool) => `mcp__claude_ai_Google_Drive__${tool}`),
  ...["fetch", "search", "get-comments", "query-data-sources", "query-multiple-data-sources", "list-page-backlinks"].map((tool) => `mcp__claude_ai_Notion__notion-${tool}`),
];

/** The flags that turn those read-only commands into running or writing something else. */
export const RUN_REFUSED_TOOLS = ["Bash(rg *--pre*)", "Bash(rg *--hostname-bin*)", "Bash(git *--output*)", "Bash(git *--ext-diff*)"];

/** Tools no rule can help: a headless run has no one to ask. */
const NEVER_OFFERED = new Set(["AskUserQuestion", "EnterPlanMode", "ExitPlanMode"]);
/** Commands whose second word says what they do. */
const SUBCOMMANDS = new Set(["git", "gh", "npm", "bun", "pnpm", "yarn", "story", "cargo", "swift", "brew"]);

/** The arguments a run gives Claude Code. Settings come from the person only, so a synced `.claude/` grants nothing. */
export function runArguments(prompt: string, session: string, settingsPath: string | null): string[] {
  return [
    "-p", prompt,
    "--output-format", "stream-json", "--verbose",
    "--session-id", session,
    "--permission-mode", "acceptEdits",
    "--setting-sources", "user",
    ...(settingsPath ? ["--settings", settingsPath] : []),
    "--allowedTools", RUN_TOOLS.join(","),
    "--disallowedTools", RUN_REFUSED_TOOLS.join(","),
    "--append-system-prompt", AGENT_SKILL,
  ];
}

/** The rule that would allow a refused call, or null where none can be read from it. A connector tool's rule names that tool, not its server. */
export function permissionRule(tool: string, input: unknown): string | null {
  if (tool !== "Bash") return tool;
  const command = (input as { command?: unknown } | null)?.command;
  if (typeof command !== "string") return null;
  const words = command.split(/&&|\|\||[;|&\n]/, 1)[0]!.trim().split(/\s+/).filter((word) => !/^\w+=/.test(word));
  const [word, next] = words;
  if (!word || !/^[\w./-]+$/.test(word)) return null;
  return next && SUBCOMMANDS.has(word) && /^[a-z][\w-]*$/.test(next) ? `Bash(${word} ${next}:*)` : `Bash(${word}:*)`;
}

/** The rules worth offering for a run's `permission_denials`: each once, without what a run already has. */
export function blockedRules(denials: unknown): string[] {
  if (!Array.isArray(denials)) return [];
  const rules = denials.map((denial: { tool_name?: unknown; tool_input?: unknown } | null) =>
    typeof denial?.tool_name === "string" && !NEVER_OFFERED.has(denial.tool_name) ? permissionRule(denial.tool_name, denial.tool_input) : null);
  return [...new Set(rules)].filter((rule): rule is string => rule !== null && !RUN_TOOLS.includes(rule));
}

/** The `permissions.allow` rules in a settings file; none if it is missing or unreadable. */
export function allowedRules(path: string): string[] {
  try {
    const allow = (JSON.parse(readFileSync(path, "utf8")) as { permissions?: { allow?: unknown } }).permissions?.allow;
    return Array.isArray(allow) ? allow.filter((rule): rule is string => typeof rule === "string") : [];
  } catch { return []; }
}

/** Add a rule to a settings file's `permissions.allow`, keeping all else in it. */
export async function addAllowRule(path: string, rule: string): Promise<void> {
  const text = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
  const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
  let settings: unknown = {};
  if (text !== null) {
    try { settings = JSON.parse(text); } catch { throw new AgentRunError("bad-settings", `${path} is not valid JSON, so Story left it alone.`); }
  }
  const permissions = isObject(settings) ? settings.permissions ?? {} : null;
  const allow = isObject(permissions) ? permissions.allow ?? [] : null;
  if (!isObject(settings) || !isObject(permissions) || !Array.isArray(allow)) throw new AgentRunError("bad-settings", `${path} does not have the shape of Claude Code settings, so Story left it alone.`);
  if (allow.includes(rule)) return;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ ...settings, permissions: { ...permissions, allow: [...allow, rule] } }, null, 2)}\n`);
}

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
    "Do the task in this folder. Story marks the task block done itself when you finish, so leave it as it is.",
    'When you are done, run `story agent done "<what you did, in one line>"`.',
  ].join("\n");
}

/** A task block's lines in a Markdown page: `> [!agent] text`, with any `> ` continuation lines. */
export function findTaskBlock(source: string, task: string): { start: number; end: number; section: string | null } | null {
  const lines = source.split("\n");
  // The task arrives as the editor's plain text; the file may hold link
  // markup, escapes and emphasis delimiters, so both sides are compared without them.
  const plain = (value: string) => value
    .replace(/!?\[((?:\\.|[^\]\\])*)\]\([^)\s]*\)/g, "$1")
    .replace(/<((?:https?|mailto):[^>\s]*)>/g, "$1")
    .replace(/[\\*_~`]/g, "").replace(/\s+/g, " ").trim();
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

/** The page with its task block marked done: `> [!agent]` becomes `> [!agent-done]`, all else as it was. */
export function markTaskDone(source: string, task: string): string | null {
  const found = findTaskBlock(source, task);
  if (!found) return null;
  const lines = source.split("\n");
  lines[found.start] = lines[found.start]!.replace(/\[!agent(\\?)\]/i, "[!agent-done$1]");
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

/** A run as runs.json keeps it. */
type SavedRun = Omit<RunRecord, "after" | "process" | "stopRequested"> & { after?: Array<[string, string | null]> };

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
    this.load();
  }

  private get settingsPath(): string {
    return this.options.settingsPath ?? join(dirname(this.host.stateDirectory), "agent-settings.json");
  }

  private get savedPath(): string {
    return join(this.host.stateDirectory, "agent-runs", "runs.json");
  }

  /** Finished runs from before a restart, so a done task's Undo Run still works. */
  private load(): void {
    let saved: SavedRun[];
    try { saved = JSON.parse(readFileSync(this.savedPath, "utf8")) as SavedRun[]; } catch { return; }
    if (!Array.isArray(saved)) return;
    for (const entry of saved) {
      const run: RunRecord = {
        ...entry, after: entry.after ? new Map(entry.after) : undefined, stopRequested: false,
        blocked: entry.blocked ?? [],
        // A run cut off by the restart did not finish.
        ...(entry.state === "queued" || entry.state === "running" ? { state: "failed" as const, result: "Story Sync restarted during the run" } : {}),
      };
      if (run.undoable && (!run.snapshotDirectory || !existsSync(run.snapshotDirectory))) {
        run.undoable = false;
        run.snapshotDirectory = undefined;
      }
      this.runs.set(run.id, run);
      if (run.undoable) this.expireLater(run, (run.finishedAt ?? 0) + this.snapshotMs - Date.now());
    }
  }

  /** Keep the latest runs on disk; a write that fails only costs Undo after a restart. */
  private async save(): Promise<void> {
    const runs = [...this.runs.values()].filter((run) => run.state !== "queued" && run.state !== "running").slice(-100);
    const saved: SavedRun[] = runs.map(({ process: _process, stopRequested: _stop, after, ...rest }) => ({ ...rest, after: after ? [...after] : undefined }));
    try {
      await mkdir(dirname(this.savedPath), { recursive: true });
      await writeFile(this.savedPath, JSON.stringify(saved));
    } catch { /* best effort */ }
  }

  /** Drop the run's snapshot after `ms`: Undo Run is gone from then on. */
  private expireLater(run: RunRecord, ms: number): void {
    const directory = run.snapshotDirectory;
    const expire = () => {
      if (run.snapshotDirectory !== directory) return;
      run.undoable = false;
      run.snapshotDirectory = undefined;
      if (directory) void rm(directory, { recursive: true, force: true });
      void this.save();
    };
    if (ms <= 0) return expire();
    const timer = setTimeout(expire, ms);
    (timer as { unref?: () => void }).unref?.();
  }

  list(): AgentRun[] {
    const allowed = allowedRules(this.settingsPath);
    return [...this.runs.values()].map((run) => this.view(run, allowed));
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
      changed: [], undoable: false, blocked: [], startedAt: null, finishedAt: null, folder,
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

  /** Let future runs use a tool this run was refused. Only a refused rule, so this route cannot grant anything else. */
  async allow(id: string, rule: string): Promise<AgentRun> {
    const run = this.require(id);
    if (!run.blocked.includes(rule)) throw new AgentRunError("not-blocked", "This run was not refused that tool.");
    await addAllowRule(this.settingsPath, rule);
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
    run.snapshotDirectory = undefined;
    await this.save();
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

  private view(run: RunRecord, allowed = allowedRules(this.settingsPath)): AgentRun {
    const { id, tree, page, task, state, result, changed, undoable, blocked, startedAt, finishedAt } = run;
    return { id, tree, page, task, state, result, changed: [...changed], undoable, blocked: blocked.filter((rule) => !allowed.includes(rule)), startedAt, finishedAt };
  }

  private async execute(run: RunRecord, command: string): Promise<void> {
    if (run.stopRequested) return;
    const folder = run.folder!;
    run.state = "running";
    run.startedAt = Date.now();
    // Earlier runs keep their snapshots: each done task keeps its own Undo Run
    // until it expires, and undo leaves alone what a later run changed again.
    const pagePath = this.pageFile(folder, run.page);
    const source = pagePath ? await readFile(pagePath, "utf8").catch(() => null) : null;
    const found = source ? findTaskBlock(source, run.task) : null;
    const section = found?.section ?? null;
    run.snapshotDirectory = join(this.host.stateDirectory, "agent-runs", run.id);
    await rm(run.snapshotDirectory, { recursive: true, force: true });
    await snapshot(folder, run.snapshotDirectory);
    const before = await fileHashes(folder);
    // The agent's edits and the task block's removal go up as one change.
    // Held under the run's session, which the agent's own reports hold too.
    this.host.hold?.(run.tree, run.session);

    const report = (body: { status?: string; hold?: boolean; done?: string; hook?: unknown }) =>
      this.agents.report({ cwd: folder, session: run.session, agent: "Claude", ...body }).catch(() => null);
    // The session holds too, so it shows the page as others still see it.
    await report({ status: "Starting", hold: true });
    // Show the agent at the task block from the start.
    if (pagePath) {
      const lines = found ? { offset: found.start + 1, limit: found.end - found.start } : {};
      await report({ hook: { hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: pagePath, ...lines } } });
    }

    const prompt = runPrompt(run, section);
    const args = this.options.argumentsFor?.(run, prompt, run.session)
      ?? runArguments(prompt, run.session, existsSync(this.settingsPath) ? this.settingsPath : null);
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
        let message: { type?: string; message?: { content?: unknown }; result?: unknown; permission_denials?: unknown };
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
        if (message.type === "result") run.blocked = blockedRules(message.permission_denials);
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
      // The task is done: its block stays, checked off, until the person deletes it.
      if (pagePath) {
        const current = await readFile(pagePath, "utf8").catch(() => null);
        const done = current === null ? null : markTaskDone(current, run.task);
        if (done !== null) {
          await writeFile(pagePath, done);
          const relativePage = relative(folder, pagePath).split(sep).join("/");
          changes.set(relativePage, hashObject(new TextEncoder().encode(done)));
        }
      }
      run.result = this.resultLine(run, finalText);
      // Finished only with its result: a poll never sees one without the other.
      run.state = "finished";
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
      this.expireLater(run, this.snapshotMs);
    }
    await this.save();
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
  constructor(readonly code: "not-placed" | "no-agent" | "not-found" | "not-undoable" | "not-blocked" | "bad-settings", message: string) {
    super(message);
  }
}

