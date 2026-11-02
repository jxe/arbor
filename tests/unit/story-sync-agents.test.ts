import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { hashObject, type PresenceEvent, type PresenceUpdate } from "@ovst/protocol";
import { AgentSessions, lineRange, textRange, type AgentPresenceClient } from "../../packages/story-sync/src/agents.ts";

// Agents 001 phase 7: an agent in a placed folder reports to Story Sync, which
// shows it in the tree's presence.

let root: string;
let opened: Array<{ tree: string; agent?: string; signal?: AbortSignal }>;
let updates: Array<{ id: string; update: PresenceUpdate }>;
let sessions: AgentSessions;

const client: AgentPresenceClient = {
  async *presence(tree, options) {
    opened.push({ tree, ...options });
    yield { kind: "presence.ready", ready: { self: `pr_${opened.length}`, peers: [] } } satisfies PresenceEvent;
    await new Promise<void>((resolve) => options.signal?.addEventListener("abort", () => resolve(), { once: true }));
  },
  async updatePresence(_tree, id, update) {
    updates.push({ id, update });
  },
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agents-"));
  opened = [];
  updates = [];
  sessions = new AgentSessions({
    locate: async (path) => path.startsWith(root) ? { tree: "tr_notes", root, path: path.slice(root.length) || "/" } : null,
    presence: async () => client,
  }, { updateIntervalMs: 0, doneLingerMs: 0 });
});

afterEach(async () => {
  await sessions[Symbol.asyncDispose]();
  await rm(root, { recursive: true, force: true });
});

async function settle() {
  await Bun.sleep(20);
}

describe("agent sessions", () => {
  test("a report outside a placed tree shows nothing", async () => {
    expect(await sessions.report({ cwd: "/somewhere/else", status: "hello" })).toBeNull();
    expect(opened).toEqual([]);
  });

  test("status joins presence as the named agent and sets its status", async () => {
    const result = await sessions.report({ cwd: root, agent: "Claude", status: "merging duplicates" });
    expect(result).toEqual({ session: "cwd:tr_notes", tree: "tr_notes" });
    await settle();
    expect(opened.map((open) => [open.tree, open.agent])).toEqual([["tr_notes", "Claude"]]);
    expect(updates).toEqual([{ id: "pr_1", update: { status: "merging duplicates" } }]);
  });

  test("a later report without a session joins the latest session in the tree", async () => {
    await sessions.report({ cwd: root, hook: { session_id: "s1", cwd: root, hook_event_name: "PostToolUse", tool_name: "Grep" }, agent: "Claude" });
    const result = await sessions.report({ cwd: root, status: "almost there" });
    expect(result?.session).toBe("s1");
    expect(opened).toHaveLength(1);
  });

  test("an edit moves the agent's page and cursor to the edited text", async () => {
    const file = join(root, "Groceries.md");
    const bytes = new TextEncoder().encode("# Groceries\n\n- oat milk\n- eggs\n");
    await writeFile(file, bytes);
    await sessions.report({
      cwd: root, agent: "Claude",
      hook: { session_id: "s1", cwd: root, hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: file, old_string: "- milk", new_string: "- oat milk" } },
    });
    await settle();
    expect(updates[0]!.update).toEqual({ page: { path: "/Groceries.md", stableKey: null } });
    expect(updates[1]!.update).toEqual({
      selection: { source: hashObject(bytes) as `sha256:${string}`, anchor: 13, head: 23 },
      status: "Editing Groceries",
    });
  });

  test("a read selects the lines read", async () => {
    const file = join(root, "Plan.md");
    await writeFile(file, "one\ntwo\nthree\n");
    await sessions.report({ cwd: root, hook: { session_id: "s1", cwd: root, hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: file, offset: 2, limit: 1 } } });
    await settle();
    expect(updates[1]!.update).toMatchObject({ selection: { anchor: 4, head: 8 }, status: "Reading Plan" });
  });

  test("a whole page read leaves the agent where it is, or puts it at the top", async () => {
    const file = join(root, "Plan.md");
    await writeFile(file, "one\ntwo\nthree\n");
    const read = (input: Record<string, unknown>) => sessions.report({ cwd: root, hook: { session_id: "s1", cwd: root, hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: file, ...input } } });
    await read({});
    await settle();
    expect(updates[1]!.update).toMatchObject({ selection: { anchor: 0, head: 0 }, status: "Reading Plan" });
    await read({ offset: 2, limit: 1 });
    await settle();
    await read({});
    await settle();
    expect(updates.at(-1)!.update).toEqual({ status: "Reading Plan" });
    expect(updates.filter((update) => update.update.selection).at(-1)!.update).toMatchObject({ selection: { anchor: 4, head: 8 } });
  });

  test("held, the agent is placed in the page as others still see it, and --at points there", async () => {
    const held: string[] = [];
    const holding = new AgentSessions({
      locate: async (path) => path.startsWith(root) ? { tree: "tr_notes", root, path: path.slice(root.length) || "/" } : null,
      presence: async () => client,
      hold: (_tree, holder) => { held.push(holder); },
      release: async () => {},
    }, { updateIntervalMs: 0, doneLingerMs: 0 });
    try {
      const file = join(root, "Groceries.md");
      const before = new TextEncoder().encode("# Groceries\n\n- milk\n- milk\n- eggs\n");
      const source = hashObject(before);
      await writeFile(file, before);
      const edit = { session_id: "s1", cwd: root, tool_name: "Edit", tool_input: { file_path: file, old_string: "- milk\n- milk", new_string: "- milk" } };
      await holding.report({ cwd: root, hook: { ...edit, hook_event_name: "PreToolUse" } });
      await writeFile(file, "# Groceries\n\n- milk\n- eggs\n");
      await holding.report({ cwd: root, hook: { ...edit, hook_event_name: "PostToolUse" } });
      await settle();
      // The edited text as the page still reads: the old string, in the old bytes.
      expect(updates.filter((update) => update.update.selection).at(-1)!.update).toMatchObject({ selection: { source, anchor: 13, head: 26 } });
      await holding.report({ cwd: root, session: "s1", status: "checking the dairy", at: "eggs" });
      await settle();
      expect(updates.at(-1)!.update).toMatchObject({ selection: { source, anchor: 29, head: 33 } });
      expect(updates.some((update) => update.update.status === "checking the dairy")).toBe(true);
    } finally {
      await holding[Symbol.asyncDispose]();
    }
  });

  test("done shows the result and then leaves", async () => {
    await sessions.report({ cwd: root, status: "working" });
    await sessions.report({ cwd: root, done: "Merged 3 duplicates" });
    await settle();
    expect(updates.at(-1)!.update).toEqual({ status: "Merged 3 duplicates" });
    expect(opened[0]!.signal?.aborted).toBe(true);
    expect(sessions.list()).toEqual([]);
  });

  test("SessionEnd leaves", async () => {
    await sessions.report({ cwd: root, hook: { session_id: "s1", cwd: root, hook_event_name: "PostToolUse", tool_name: "Grep" } });
    await sessions.report({ cwd: root, hook: { session_id: "s1", cwd: root, hook_event_name: "SessionEnd" } });
    await settle();
    expect(sessions.list()).toEqual([]);
  });
});

describe("ranges", () => {
  test("an edit holds the tree's publishing until the agent stops, and each session holds once", async () => {
    const held: string[] = [];
    const holding = new AgentSessions({
      locate: async (path) => path.startsWith(root) ? { tree: "tr_notes", root, path: path.slice(root.length) || "/" } : null,
      presence: async () => client,
      hold: (tree, holder) => { held.push(`hold ${tree} ${holder}`); },
      release: async (tree, holder) => { held.push(`release ${tree} ${holder}`); },
    }, { updateIntervalMs: 0, doneLingerMs: 0 });
    try {
      const file = join(root, "Groceries.md");
      await writeFile(file, "- milk\n");
      const edit = { session_id: "s1", cwd: root, tool_name: "Edit", tool_input: { file_path: file, new_string: "milk" } };
      await holding.report({ cwd: root, hook: { ...edit, hook_event_name: "PreToolUse" } });
      await holding.report({ cwd: root, hook: { ...edit, hook_event_name: "PostToolUse" } });
      await holding.report({ cwd: root, hook: { session_id: "s1", cwd: root, hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: file } } });
      expect(held).toEqual(["hold tr_notes s1"]);
      await holding.report({ cwd: root, hook: { session_id: "s1", cwd: root, hook_event_name: "Stop" } });
      expect(held).toEqual(["hold tr_notes s1", "release tr_notes s1"]);
      // A session that leaves mid-edit lets go too.
      await holding.report({ cwd: root, hook: { ...edit, session_id: "s2", hook_event_name: "PreToolUse" } });
      await holding.report({ cwd: root, hook: { session_id: "s2", cwd: root, hook_event_name: "SessionEnd" } });
      await settle();
      expect(held.slice(2)).toEqual(["hold tr_notes s2", "release tr_notes s2"]);
    } finally {
      await holding[Symbol.asyncDispose]();
    }
  });

  test("lineRange covers 1-based lines", () => {
    const bytes = new TextEncoder().encode("a\nbb\nccc");
    expect(lineRange(bytes)).toEqual({ anchor: 0, head: 8 });
    expect(lineRange(bytes, 2, 1)).toEqual({ anchor: 2, head: 5 });
    expect(lineRange(bytes, 3)).toEqual({ anchor: 5, head: 8 });
  });

  test("textRange finds UTF-8 bytes", () => {
    const bytes = new TextEncoder().encode("café au lait");
    expect(textRange(bytes, "au")).toEqual({ anchor: 6, head: 8 });
    expect(textRange(bytes, "tea")).toBeNull();
  });
});

describe("story agent install", () => {
  test("adds hooks, the skill and the permission, keeps the rest, and uninstall takes exactly them out", async () => {
    const { installAgentPresence, uninstallAgentPresence } = await import("../../packages/cli/src/agent-presence.ts");
    const claude = join(root, ".claude");
    const settingsPath = join(claude, "settings.json");
    const mine = { hooks: { PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "my-linter" }] }] }, permissions: { allow: ["Bash(ls:*)"] }, model: "opus" };
    await Bun.write(settingsPath, JSON.stringify(mine));
    await installAgentPresence({ claudeDirectory: claude });
    await installAgentPresence({ claudeDirectory: claude, agent: "Claude Code" });
    const installed = await Bun.file(settingsPath).json();
    expect(installed.model).toBe("opus");
    expect(installed.permissions.allow).toEqual(["Bash(ls:*)", "Bash(story agent:*)"]);
    expect(installed.hooks.PostToolUse).toHaveLength(2);
    expect(installed.hooks.PostToolUse[1].hooks[0].command).toBe('story agent hook --agent "Claude Code"');
    expect(installed.hooks.SessionEnd).toHaveLength(1);
    expect(await Bun.file(join(claude, "skills/story-placed-folders/SKILL.md")).text()).toContain("story agent status");
    // An install through npx is replaced and removed the same way.
    await installAgentPresence({ claudeDirectory: claude, command: "npx @ovst/cli" });
    await installAgentPresence({ claudeDirectory: claude, command: "npx @ovst/cli" });
    const throughNpx = await Bun.file(settingsPath).json();
    expect(throughNpx.hooks.SessionEnd).toHaveLength(1);
    // Its permission and skill name the command that works there, in place of the earlier install's.
    expect(throughNpx.permissions.allow).toEqual(["Bash(ls:*)", "Bash(npx @ovst/cli agent:*)"]);
    const skill = await Bun.file(join(claude, "skills/story-placed-folders/SKILL.md")).text();
    expect(skill).toContain("npx @ovst/cli agent status");
    expect(skill).toContain("npx @ovst/cli sync status");
    expect(skill).not.toMatch(/(?<!npx @ovst\/cli )`?story (agent|sync)\b/);
    await uninstallAgentPresence({ claudeDirectory: claude });
    expect(await Bun.file(settingsPath).json()).toEqual(mine);
    expect(await Bun.file(join(claude, "skills/story-placed-folders/SKILL.md")).exists()).toBe(false);
  });

  test("an agent label is one line of at most 40 characters", async () => {
    const { agentLabel } = await import("../../packages/cli/src/agent-presence.ts");
    expect(agentLabel("  Supplies\nbot  ")).toBe("Supplies bot");
    expect(agentLabel("x".repeat(50))).toHaveLength(40);
    expect(agentLabel("   ")).toBe("Agent");
  });

  test("hook and text reports carry the runner's session and label", async () => {
    const { hookReport, textReport } = await import("../../packages/cli/src/agent-presence.ts");
    const environment = { STORY_AGENT_SESSION: "run-1", STORY_AGENT_LABEL: "Claude" };
    expect(textReport("status", "sorting", "/w", environment)).toEqual({ cwd: "/w", session: "run-1", agent: "Claude", status: "sorting" });
    expect(hookReport('{"cwd":"/x","tool_name":"Read"}', "/w", undefined, {})).toEqual({ cwd: "/x", hook: { cwd: "/x", tool_name: "Read" } });
    expect(hookReport("not json", "/w", "Claude", {})).toBeNull();
    expect(hookReport('{"cwd":"/x","tool_name":"Read"}', "/w", undefined, { STORY_AGENT_RUN: "run-1" })).toBeNull();
  });
});
