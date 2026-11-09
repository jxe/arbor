import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { hashObject, type PresenceEvent, type PresenceUpdate } from "@ovst/protocol";
import { addAllowRule, AgentRuns, blockedRules, findTaskBlock, markTaskDone, permissionRule, RUN_TOOLS, runArguments, runPrompt, type AgentRun } from "../../packages/story-sync/src/agent-runs.ts";
import { AgentSessions, type AgentPresenceClient } from "../../packages/story-sync/src/agents.ts";

// Agents 001 phase 8: Run starts the person's agent in the placed folder,
// shows it in presence, removes the task block, and can undo the run.

let sandbox: string;
let folder: string;
let updates: PresenceUpdate[];
let published: number;
let hostCalls: string[];
let sessions: AgentSessions;
let runs: AgentRuns;

const PAGE = "# Groceries\n\n> [!agent] merge the duplicates\n\n- milk\n- milk\n- eggs\n";

const client: AgentPresenceClient = {
  async *presence(_tree, options) {
    yield { kind: "presence.ready", ready: { self: "pr_agent", peers: [] } } satisfies PresenceEvent;
    await new Promise<void>((resolve) => options.signal?.addEventListener("abort", () => resolve(), { once: true }));
  },
  async updatePresence(_tree, _id, update) { updates.push(update); },
};

/** A stand-in for Claude Code: emits stream-json for one Read and one Edit, edits the file, and says done. */
const FAKE_AGENT = `#!/usr/bin/env bun
const page = process.cwd() + "/Groceries.md";
const emit = (value) => console.log(JSON.stringify(value));
if (process.env.FAKE_FAIL) { console.error("agent crashed"); process.exit(3); }
emit({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: page } }] } });
emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1" }] } });
const text = await Bun.file(page).text();
await Bun.write(page, text.replace("- milk\\n- milk\\n", "- milk\\n"));
emit({ type: "assistant", message: { content: [{ type: "tool_use", id: "t2", name: "Edit", input: { file_path: page, old_string: "- milk\\n- milk", new_string: "- milk" } }] } });
emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t2" }] } });
emit({ type: "result", result: "Merged the duplicate milk.\\nAnything else?", permission_denials: process.env.FAKE_DENIED ? [{ tool_name: process.env.FAKE_DENIED, tool_input: {} }] : [] });
`;

beforeEach(async () => {
  // Real path: the agent's cwd is resolved, and macOS's tmpdir is behind /var -> /private/var.
  sandbox = await realpath(await mkdtemp(join(tmpdir(), "agent-runs-")));
  folder = join(sandbox, "notes");
  await Bun.write(join(folder, "Groceries.md"), PAGE);
  await Bun.write(join(folder, ".state", "private"), "not snapshotted");
  const agent = join(sandbox, "fake-claude");
  await writeFile(agent, FAKE_AGENT);
  await chmod(agent, 0o755);
  updates = [];
  published = 0;
  hostCalls = [];
  sessions = new AgentSessions({
    locate: async (path) => path.startsWith(folder) ? { tree: "tr_notes", root: folder, path: path.slice(folder.length) || "/" } : null,
    presence: async () => client,
  }, { updateIntervalMs: 0, doneLingerMs: 0 });
  runs = new AgentRuns({
    folder: async (tree) => tree === "tr_notes" ? folder : null,
    publish: async () => { published += 1; hostCalls.push("publish"); },
    hold: (tree) => { hostCalls.push(`hold ${tree}`); },
    release: async (tree) => { hostCalls.push(`release ${tree}`); },
    stateDirectory: join(sandbox, "state"),
  }, sessions, { command: agent, argumentsFor: () => [] });
});

afterEach(async () => {
  await runs[Symbol.asyncDispose]();
  await sessions[Symbol.asyncDispose]();
  await rm(sandbox, { recursive: true, force: true });
});

async function settled(id: string): Promise<AgentRun> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const run = runs.get(id)!;
    if (run.state !== "queued" && run.state !== "running") return run;
    await Bun.sleep(25);
  }
  throw new Error("run did not finish");
}

describe("agent runs", () => {
  test("a run edits the page, removes its task block, reports the result and can be undone", async () => {
    const started = await runs.start({ tree: "tr_notes", page: "/Groceries.md", task: "merge the duplicates" });
    const run = await settled(started.id);
    expect(run.state).toBe("finished");
    expect(run.result).toBe("Merged the duplicate milk.");
    expect(run.changed).toEqual(["Groceries.md"]);
    expect(run.undoable).toBe(true);
    expect(await readFile(join(folder, "Groceries.md"), "utf8")).toBe("# Groceries\n\n> [!agent-done] merge the duplicates\n\n- milk\n- eggs\n");
    expect(published).toBeGreaterThan(0);
    // Held from before the agent starts; let go before the final publish.
    expect(hostCalls[0]).toBe("hold tr_notes");
    expect(hostCalls.indexOf("release tr_notes")).toBeLessThan(hostCalls.lastIndexOf("publish"));
    await Bun.sleep(30);
    expect(updates.some((update) => update.status === "Editing Groceries")).toBe(true);
    // The agent starts at its task block, not wherever a whole-page read would put it.
    expect(updates.find((update) => update.selection)!.selection).toMatchObject({ anchor: 13, head: 45 });
    expect(updates.at(-1)).toEqual({ status: "Merged the duplicate milk." });

    expect(await runs.undo(run.id)).toEqual({ restored: ["Groceries.md"], skipped: [] });
    expect(await readFile(join(folder, "Groceries.md"), "utf8")).toBe(PAGE);
    expect(runs.get(run.id)!.state).toBe("undone");
  });

  test("a finished run and its Undo survive a restart", async () => {
    const run = await settled((await runs.start({ tree: "tr_notes", page: "/Groceries.md", task: "merge the duplicates" })).id);
    const restarted = new AgentRuns({
      folder: async (tree) => tree === "tr_notes" ? folder : null,
      publish: async () => {},
      stateDirectory: join(sandbox, "state"),
    }, sessions, { command: "unused" });
    expect(restarted.get(run.id)).toMatchObject({ state: "finished", undoable: true, result: "Merged the duplicate milk." });
    expect(await restarted.undo(run.id)).toEqual({ restored: ["Groceries.md"], skipped: [] });
    expect(await readFile(join(folder, "Groceries.md"), "utf8")).toBe(PAGE);
  });

  test("undo leaves a file changed again since the run", async () => {
    const run = await settled((await runs.start({ tree: "tr_notes", page: "/Groceries.md", task: "merge the duplicates" })).id);
    await writeFile(join(folder, "Groceries.md"), "# Groceries\n\n- oat milk\n");
    expect(await runs.undo(run.id)).toEqual({ restored: [], skipped: ["Groceries.md"] });
    expect(await readFile(join(folder, "Groceries.md"), "utf8")).toBe("# Groceries\n\n- oat milk\n");
  });

  test("a failed run keeps its task block and says why", async () => {
    process.env.FAKE_FAIL = "1";
    try {
      const run = await settled((await runs.start({ tree: "tr_notes", page: "/Groceries.md", task: "merge the duplicates" })).id);
      expect(run.state).toBe("failed");
      expect(run.result).toBe("agent crashed");
      expect(await readFile(join(folder, "Groceries.md"), "utf8")).toBe(PAGE);
    } finally {
      delete process.env.FAKE_FAIL;
    }
  });

  test("a run request's ID names the run, and sending it again runs it once", async () => {
    const first = await runs.start({ tree: "tr_notes", page: "/Groceries.md", task: "merge the duplicates", run: "phone-1" });
    const again = await runs.start({ tree: "tr_notes", page: "/Groceries.md", task: "merge the duplicates", run: "phone-1" });
    expect(first.id).toBe("phone-1");
    expect(again.id).toBe("phone-1");
    expect((await settled("phone-1")).state).toBe("finished");
    expect(runs.list().length).toBe(1);
    // The agent's presence entry names the run, so a phone can match it to its block.
    expect(updates.some((update) => update.run === "phone-1")).toBe(true);
  });

  test("a tree that is not placed here cannot run", async () => {
    await expect(runs.start({ tree: "tr_elsewhere", page: "/x.md", task: "anything" })).rejects.toThrow("not placed");
  });
});

describe("external runs (story agent start --task)", () => {
  const request = { tree: "tr_notes", page: "/Groceries.md", task: "merge the duplicates", run: "run-ext", external: true, label: "Cloud" } as const;

  test("the agent's own session takes over the run and marks the block done when it says done", async () => {
    const started = await runs.start(request);
    expect(started).toMatchObject({ id: "run-ext", state: "running", external: true, undoable: false, file: join(folder, "Groceries.md") });
    expect(started.prompt).toContain("merge the duplicates");
    expect(started.prompt).toContain(join(folder, "Groceries.md"));
    // Shown from the start, holding the tree, with the run's ID.
    expect(hostCalls[0]).toBe("hold tr_notes");
    // The agent's hooks name their own session: it takes over the stand-in rather than showing twice.
    await sessions.report({ cwd: folder, session: "claude-session", hook: { hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: join(folder, "Groceries.md") } } });
    expect(sessions.list()).toEqual([{ session: "claude-session", tree: "tr_notes", agent: "Cloud" }]);
    await writeFile(join(folder, "Groceries.md"), PAGE.replace("- milk\n- milk\n", "- milk\n"));
    // `story agent done` names no session: it goes to the tree's agent. The block is marked before it returns.
    await sessions.report({ cwd: folder, done: "Merged the milk" });
    const run = runs.get("run-ext")!;
    expect(run).toMatchObject({ state: "finished", result: "Merged the milk", changed: ["Groceries.md"] });
    expect(await readFile(join(folder, "Groceries.md"), "utf8")).toBe("# Groceries\n\n> [!agent-done] merge the duplicates\n\n- milk\n- eggs\n");
    expect(hostCalls).toContain("release tr_notes");
    expect(published).toBeGreaterThan(0);
    await Bun.sleep(30);
    expect(updates.some((update) => update.run === "run-ext")).toBe(true);
  });

  test("a task on the tree's own page is found in _index.md and marked done", async () => {
    await writeFile(join(folder, "_index.md"), "# Console\n\n> [!agent] list lunch ideas\n");
    const started = await runs.start({ ...request, page: "/", task: "list lunch ideas", run: "run-root" });
    expect(started.file).toBe(join(folder, "_index.md"));
    expect(started.prompt).toContain(join(folder, "_index.md"));
    await sessions.report({ cwd: folder, done: "Listed three" });
    expect(runs.get("run-root")).toMatchObject({ state: "finished", changed: ["_index.md"] });
    expect(await readFile(join(folder, "_index.md"), "utf8")).toBe("# Console\n\n> [!agent-done] list lunch ideas\n");
  });

  test("an agent that leaves without saying done leaves the block, and says why", async () => {
    await runs.start(request);
    await sessions.report({ cwd: folder, session: "claude-session", hook: { hook_event_name: "SessionEnd" } });
    await Bun.sleep(10);
    expect(runs.get("run-ext")).toMatchObject({ state: "failed", result: "The agent stopped without saying it was done" });
    expect(await readFile(join(folder, "Groceries.md"), "utf8")).toBe(PAGE);
  });

  test("stopping an external run takes its agent out of presence and leaves the block", async () => {
    await runs.start(request);
    runs.stop("run-ext");
    expect(runs.get("run-ext")).toMatchObject({ state: "stopped", result: "Stopped" });
    expect(sessions.list()).toEqual([]);
    expect(await readFile(join(folder, "Groceries.md"), "utf8")).toBe(PAGE);
  });

  test("the sender's range picks its block among copies when this folder has the sender's version", async () => {
    const twice = "# Groceries\n\n> [!agent] tidy\n\n## Later\n\n> [!agent] tidy\n";
    await writeFile(join(folder, "Groceries.md"), twice);
    const second = Buffer.byteLength(twice.slice(0, twice.lastIndexOf("> [!agent]")));
    const range = { source: hashObject(new TextEncoder().encode(twice)) as never, anchor: second, head: second };
    await runs.start({ ...request, task: "tidy", range });
    await sessions.report({ cwd: folder, done: "Tidied" });
    expect(await readFile(join(folder, "Groceries.md"), "utf8")).toBe("# Groceries\n\n> [!agent] tidy\n\n## Later\n\n> [!agent-done] tidy\n");
  });
});

describe("what a run was refused", () => {
  test("a refused call becomes the rule that would allow it", () => {
    expect(permissionRule("WebFetch", { url: "https://example.com" })).toBe("WebFetch");
    expect(permissionRule("mcp__claude_ai_Google_Drive__create_file", {})).toBe("mcp__claude_ai_Google_Drive__create_file");
    expect(permissionRule("Bash", { command: "curl -s https://example.com | jq ." })).toBe("Bash(curl:*)");
    expect(permissionRule("Bash", { command: "git push origin main" })).toBe("Bash(git push:*)");
    expect(permissionRule("Bash", { command: "FOO=1 npm run build && rm x" })).toBe("Bash(npm run:*)");
    // Never all of Bash, whatever the command looks like.
    expect(permissionRule("Bash", { command: "$(evil) now" })).toBeNull();
    expect(permissionRule("Bash", {})).toBeNull();
  });

  test("each rule once, without what a run already has or what no rule can help", () => {
    expect(blockedRules([
      { tool_name: "NotebookEdit", tool_input: { path: "a" } },
      { tool_name: "NotebookEdit", tool_input: { path: "b" } },
      { tool_name: "WebFetch", tool_input: { url: "a" } },
      { tool_name: "AskUserQuestion", tool_input: {} },
      // A read-only command's refused flag: its rule is one a run already has.
      { tool_name: "Bash", tool_input: { command: "rg --pre sh x" } },
      { tool_name: "Bash", tool_input: { command: "curl x" } },
      null,
    ])).toEqual(["NotebookEdit", "Bash(curl:*)"]);
    expect(blockedRules(undefined)).toEqual([]);
    expect(blockedRules([{ tool_name: "mcp__claude_ai_Notion__notion-update-page", tool_input: {} }])).toEqual(["mcp__claude_ai_Notion__notion-update-page"]);
  });

  test("runs read settings from the person only, and refuse the flags that make a read-only command run things", () => {
    const args = runArguments("the task", "session", "/settings.json");
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("user");
    expect(args[args.indexOf("--settings") + 1]).toBe("/settings.json");
    expect(args[args.indexOf("--disallowedTools") + 1]).toContain("Bash(rg *--pre*)");
    expect(runArguments("the task", "session", null)).not.toContain("--settings");
    // Connectors: read tools only, never a whole server.
    const connectors = RUN_TOOLS.filter((tool) => tool.startsWith("mcp__"));
    expect(connectors.length).toBeGreaterThan(0);
    for (const tool of connectors) {
      expect(tool).toMatch(/^mcp__\w+__[\w-]+$/);
      expect(tool).not.toMatch(/create|update|delete|trash|share|copy|move/);
    }
  });

  test("allowing a rule keeps the file's other content and adds it once", async () => {
    const path = join(sandbox, "nested", "agent-settings.json");
    await addAllowRule(path, "WebFetch");
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ permissions: { allow: ["WebFetch"] } });
    await writeFile(path, JSON.stringify({ model: "x", permissions: { deny: ["Bash"], allow: ["Read"] } }));
    await addAllowRule(path, "WebFetch");
    await addAllowRule(path, "WebFetch");
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ model: "x", permissions: { deny: ["Bash"], allow: ["Read", "WebFetch"] } });
  });

  test("a settings file Story cannot read is left alone", async () => {
    const path = join(sandbox, "agent-settings.json");
    await writeFile(path, "{ not json");
    await expect(addAllowRule(path, "WebFetch")).rejects.toThrow("left it alone");
    expect(await readFile(path, "utf8")).toBe("{ not json");
    await writeFile(path, JSON.stringify({ permissions: { allow: "WebFetch" } }));
    await expect(addAllowRule(path, "WebFetch")).rejects.toThrow("left it alone");
  });

  test("a run shows what it was refused until it is allowed, and only that can be allowed", async () => {
    process.env.FAKE_DENIED = "mcp__claude_ai_Google_Drive__create_file";
    try {
      const rule = process.env.FAKE_DENIED;
      const { id } = await runs.start({ tree: "tr_notes", page: "/Groceries.md", task: "merge the duplicates" });
      const run = await settled(id);
      expect(run.blocked).toEqual([rule]);
      await expect(runs.allow(id, "Bash(rm:*)")).rejects.toThrow("not refused");
      expect((await runs.allow(id, rule)).blocked).toEqual([]);
      expect(runs.list()[0]!.blocked).toEqual([]);
      expect(JSON.parse(await readFile(join(sandbox, "agent-settings.json"), "utf8")).permissions.allow).toEqual([rule]);
    } finally {
      delete process.env.FAKE_DENIED;
    }
  });
});

describe("task blocks", () => {
  test("found by text, with their section, and marked done in place", () => {
    const source = "# Plan\n\nIntro\n\n## Shopping\n\n> [!agent] merge the duplicates\\\n> and sort by aisle\n\n- milk\n";
    // A line break in the task is a hard break; the editor sends the newline.
    expect(findTaskBlock(source, "merge the duplicates\nand sort by aisle")).toEqual({ start: 6, end: 8, section: "Shopping" });
    expect(markTaskDone(source, "merge the duplicates\nand sort by aisle")).toBe(source.replace("[!agent]", "[!agent-done]"));
    expect(markTaskDone("> [!agent] tidy up\n> a quote\n", "tidy up")).toBe("> [!agent-done] tidy up\n> a quote\n");
    expect(markTaskDone("> \\[!agent\\] tidy up\n", "tidy up")).toBe("> \\[!agent-done\\] tidy up\n");
    expect(markTaskDone(source, "something else")).toBeNull();
    // A done task is not a task to run.
    expect(findTaskBlock("> [!agent-done] tidy up\n", "tidy up")).toBeNull();
    expect(findTaskBlock("> an ordinary quote\n", "an ordinary quote")).toBeNull();
    // As Story's editor writes an edited one: escaped punctuation, matched by its plain text.
    expect(findTaskBlock("> \\[!agent\\] sort *these*\\_now\n", "sort these_now")).toEqual({ start: 0, end: 1, section: null });
    // Story writes a typed URL as a link; the task's plain text holds only the URL.
    const linked = "> [!agent] images from [https://example.com/a](https://example.com/a) and <https://example.com/b>\n";
    expect(markTaskDone(linked, "images from https://example.com/a and https://example.com/b")).toBe(linked.replace("[!agent]", "[!agent-done]"));
  });

  test("near a line or holding a byte, among blocks with the same task", () => {
    const source = "> [!agent] tidy\n\ntext\n\n> [!agent] tidy\n";
    expect(findTaskBlock(source, "tidy")!.start).toBe(0);
    expect(findTaskBlock(source, "tidy", { line: 3 })!.start).toBe(4);
    expect(findTaskBlock(source, "tidy", { byte: source.lastIndexOf(">") + 3 })!.start).toBe(4);
    // A byte in no task block falls back to the text.
    expect(findTaskBlock(source, "tidy", { byte: source.indexOf("text") })!.start).toBe(0);
    expect(markTaskDone(source, "tidy", { line: 4 })).toBe("> [!agent] tidy\n\ntext\n\n> [!agent-done] tidy\n");
  });

  test("the prompt names the page, the section and the task", () => {
    const prompt = runPrompt({ page: "/Groceries.md", task: "merge the duplicates" }, "Groceries");
    expect(prompt).toContain('on the page /Groceries.md, in the section "Groceries"');
    expect(prompt).toContain("merge the duplicates");
    expect(prompt).toContain("story agent done");
  });
});
