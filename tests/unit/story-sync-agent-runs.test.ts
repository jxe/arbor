import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { PresenceEvent, PresenceUpdate } from "@ovst/protocol";
import { AgentRuns, findTaskBlock, removeTaskBlock, runPrompt, type AgentRun } from "../../packages/story-sync/src/agent-runs.ts";
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
emit({ type: "result", result: "Merged the duplicate milk.\\nAnything else?" });
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
    expect(await readFile(join(folder, "Groceries.md"), "utf8")).toBe("# Groceries\n\n- milk\n- eggs\n");
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

  test("a tree that is not placed here cannot run", async () => {
    await expect(runs.start({ tree: "tr_elsewhere", page: "/x.md", task: "anything" })).rejects.toThrow("not placed");
  });
});

describe("task blocks", () => {
  test("found by text, with their section, and removed with the blank line after", () => {
    const source = "# Plan\n\nIntro\n\n## Shopping\n\n> [!agent] merge the duplicates\\\n> and sort by aisle\n\n- milk\n";
    // A line break in the task is a hard break; the editor sends the newline.
    expect(findTaskBlock(source, "merge the duplicates\nand sort by aisle")).toEqual({ start: 6, end: 8, section: "Shopping" });
    expect(removeTaskBlock(source, "merge the duplicates\nand sort by aisle")).toBe("# Plan\n\nIntro\n\n## Shopping\n\n- milk\n");
    // Without a hard break the next `>` line is a quote of its own, and stays.
    expect(removeTaskBlock("> [!agent] tidy up\n> a quote\n", "tidy up")).toBe("> a quote\n");
    expect(removeTaskBlock(source, "something else")).toBeNull();
    expect(findTaskBlock("> an ordinary quote\n", "an ordinary quote")).toBeNull();
    // As Story's editor writes an edited one: escaped punctuation, matched by its plain text.
    expect(findTaskBlock("> \\[!agent\\] sort *these*\\_now\n", "sort these_now")).toEqual({ start: 0, end: 1, section: null });
  });

  test("the prompt names the page, the section and the task", () => {
    const prompt = runPrompt({ page: "/Groceries.md", task: "merge the duplicates" }, "Groceries");
    expect(prompt).toContain('on the page /Groceries.md, in the section "Groceries"');
    expect(prompt).toContain("merge the duplicates");
    expect(prompt).toContain("story agent done");
  });
});
