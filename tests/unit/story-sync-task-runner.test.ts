import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { PresenceEvent, PresenceMessageBody } from "@ovst/protocol";
import { AgentRuns } from "../../packages/story-sync/src/agent-runs.ts";
import { AgentSessions, type AgentPresenceClient } from "../../packages/story-sync/src/agents.ts";
import { doneResult, TaskRunner, type RunnerPresenceClient } from "../../packages/story-sync/src/task-runner.ts";

// Agents 002 phase 3: Story Sync keeps a runner stream on each placed tree and
// runs the `run` messages the person's other devices send it.

const PAGE = "# Groceries\n\n> [!agent] merge the duplicates\n\n- milk\n- milk\n";

/** Claude Code's stand-in: edits the page, or waits to be stopped when FAKE_WAIT is set. */
const FAKE_AGENT = `#!/usr/bin/env bun
if (process.env.FAKE_WAIT) { await new Promise((resolve) => setTimeout(resolve, 10_000)); }
const page = process.cwd() + "/Groceries.md";
await Bun.write(page, (await Bun.file(page).text()).replace("- milk\\n- milk\\n", "- milk\\n"));
console.log(JSON.stringify({ type: "result", result: "Merged the milk." }));
`;

let sandbox: string;
let folder: string;
let sessions: AgentSessions;
let runs: AgentRuns;
let runner: TaskRunner;
let opened: Array<{ tree: string; runner: string }>;
let sent: Array<{ tree: string; from: string; to: string; body: PresenceMessageBody }>;
/** Delivers a message to the runner's stream on a tree. */
let deliver: Map<string, (event: PresenceEvent) => void>;
let placed: string[];

const agentClient: AgentPresenceClient = {
  async *presence(_tree, options) {
    yield { kind: "presence.ready", ready: { self: "pr_agent", peers: [] } };
    await new Promise<void>((resolve) => options.signal?.addEventListener("abort", () => resolve(), { once: true }));
  },
  async updatePresence() {},
};

function runnerClient(): RunnerPresenceClient {
  return {
    async *presence(tree, options) {
      opened.push({ tree, runner: options.runner });
      const queue: PresenceEvent[] = [{ kind: "presence.ready", ready: { self: `pr_runner_${tree}`, peers: [] } }];
      let wake: (() => void) | undefined;
      deliver.set(tree, (event) => { queue.push(event); wake?.(); });
      let stopped = false;
      options.signal?.addEventListener("abort", () => { stopped = true; wake?.(); }, { once: true });
      while (!stopped) {
        while (queue.length) yield queue.shift()!;
        await new Promise<void>((resolve) => { wake = resolve; });
      }
    },
    async sendPresenceMessage(tree, from, to, body) { sent.push({ tree, from, to, body }); },
  };
}

async function until<T>(read: () => T | undefined, what: string): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = read();
    if (value !== undefined) return value;
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const request = { tree: "https://example.com/~joe/notes", page: { path: "/Groceries.md", stableKey: null }, task: { text: "merge the duplicates", range: null }, run: "phone-run-1" };

beforeEach(async () => {
  sandbox = await realpath(await mkdtemp(join(tmpdir(), "task-runner-")));
  folder = join(sandbox, "notes");
  await Bun.write(join(folder, "Groceries.md"), PAGE);
  const agent = join(sandbox, "fake-claude");
  await writeFile(agent, FAKE_AGENT);
  await chmod(agent, 0o755);
  opened = [];
  sent = [];
  deliver = new Map();
  placed = ["tr_notes"];
  sessions = new AgentSessions({
    locate: async (path) => path.startsWith(folder) ? { tree: "tr_notes", root: folder, path: path.slice(folder.length) || "/" } : null,
    presence: async () => agentClient,
  }, { updateIntervalMs: 0, doneLingerMs: 0 });
  runs = new AgentRuns({
    folder: async (tree) => tree === "tr_notes" ? folder : null,
    publish: async () => {},
    stateDirectory: join(sandbox, "state"),
  }, sessions, { command: agent, argumentsFor: () => [] });
  runner = new TaskRunner({ trees: async () => placed, presence: async () => runnerClient() }, runs, {
    settingsPath: join(sandbox, "state", "runner.json"), label: "Joe's Mac", refreshMs: 60_000,
  });
});

afterEach(async () => {
  delete process.env.FAKE_WAIT;
  await runner[Symbol.asyncDispose]();
  await runs[Symbol.asyncDispose]();
  await sessions[Symbol.asyncDispose]();
  await rm(sandbox, { recursive: true, force: true });
});

describe("the Mac as a runner", () => {
  test("a runner stream on each placed tree, labelled with the Mac's name", async () => {
    placed = ["tr_notes", "tr_todos"];
    await runner.refresh();
    expect(opened).toEqual([{ tree: "tr_notes", runner: "Joe's Mac" }, { tree: "tr_todos", runner: "Joe's Mac" }]);
    await until(() => runner.status().trees.length === 2 || undefined, "both streams ready");
    expect(runner.status()).toEqual({ enabled: true, label: "Joe's Mac", trees: ["tr_notes", "tr_todos"] });
    // A tree no longer placed loses its stream; one already open is not opened again.
    placed = ["tr_notes"];
    await runner.refresh();
    expect(opened.length).toBe(2);
    expect(runner.status().trees).toEqual(["tr_notes"]);
  });

  test("a run message runs the task and answers done to its sender", async () => {
    await runner.refresh();
    await until(() => deliver.get("tr_notes"), "the stream");
    deliver.get("tr_notes")!({ kind: "presence.message", message: { from: "pr_phone", body: { kind: "run", request } } });
    const done = await until(() => sent[0], "done");
    expect(done).toEqual({ tree: "tr_notes", from: "pr_runner_tr_notes", to: "pr_phone", body: { kind: "done", run: "phone-run-1", result: "Merged the milk." } });
    expect(runs.get("phone-run-1")).toMatchObject({ state: "finished", external: false, undoable: true });
    expect(await readFile(join(folder, "Groceries.md"), "utf8")).toBe("# Groceries\n\n> [!agent-done] merge the duplicates\n\n- milk\n");
  });

  test("stop stops the run, and the sender hears it stopped", async () => {
    process.env.FAKE_WAIT = "1";
    await runner.refresh();
    await until(() => deliver.get("tr_notes"), "the stream");
    deliver.get("tr_notes")!({ kind: "presence.message", message: { from: "pr_phone", body: { kind: "run", request } } });
    await until(() => runs.get("phone-run-1")?.state === "running" || undefined, "the run to start");
    deliver.get("tr_notes")!({ kind: "presence.message", message: { from: "pr_phone", body: { kind: "stop", run: "phone-run-1" } } });
    const done = await until(() => sent[0], "done");
    expect(done.body).toEqual({ kind: "done", run: "phone-run-1", result: "Stopped" });
    expect(await readFile(join(folder, "Groceries.md"), "utf8")).toBe(PAGE);
  });

  test("a run that cannot start says why", async () => {
    placed = ["tr_elsewhere"];
    await runner.refresh();
    await until(() => deliver.get("tr_elsewhere"), "the stream");
    deliver.get("tr_elsewhere")!({ kind: "presence.message", message: { from: "pr_phone", body: { kind: "run", request } } });
    const done = await until(() => sent[0], "done");
    expect(done.body).toMatchObject({ kind: "done", run: "phone-run-1" });
    expect((done.body as { result: string }).result).toStartWith("Failed: This tree is not placed");
  });

  test("turned off, it keeps no streams; on again, it opens them", async () => {
    await runner.refresh();
    await until(() => runner.status().trees.length || undefined, "the stream");
    expect(await runner.setEnabled(false)).toEqual({ enabled: false, label: "Joe's Mac", trees: [] });
    expect(JSON.parse(await readFile(join(sandbox, "state", "runner.json"), "utf8"))).toEqual({ enabled: false });
    await runner.setEnabled(true);
    await until(() => runner.status().trees.length || undefined, "the stream again");
    expect(opened.length).toBe(2);
  });

  test("what the sender is told", () => {
    const base = { id: "r", tree: "t", page: "/p", task: "x", changed: [], undoable: false, blocked: [], startedAt: 0, finishedAt: 0, external: false };
    expect(doneResult({ ...base, state: "finished", result: "Did it" })).toBe("Did it");
    expect(doneResult({ ...base, state: "stopped", result: "Stopped" })).toBe("Stopped");
    expect(doneResult({ ...base, state: "failed", result: "agent crashed" })).toBe("Failed: agent crashed");
  });
});
