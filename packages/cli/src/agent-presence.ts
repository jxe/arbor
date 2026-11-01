// `story agent status|done|hook|install|uninstall` (Agents 001 phase 7): an
// agent working in a placed folder reports to Story Sync, which shows it in
// the tree's presence. Reports are best effort: a hook never fails the agent.

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** The skill that teaches an agent the house rules and the `story agent` commands. */
export const AGENT_SKILL = `---
name: story-placed-folders
description: Use when working in a folder that Story syncs (a placed Overstory tree), to keep its pages intact and let Story show what you are doing.
---

# Working in a Story folder

This folder is a placed Overstory tree: Story Sync publishes every change you
make here to its host, and people may be reading or editing the same pages in
Story right now. They see you there as an agent, with what you say you are
doing.

1. Run \`story sync status --json\` first. If the tree is held (a conflict, a
   declined change, paused), stop and say so instead of editing.
2. Resolve a locator with \`story sync status <locator> --json\` before you assume
   which tree it is in or that you may write it.
3. Edit only inside the placed folder. Keep every frontmatter \`id:\` value and
   every link as it is unless the task is to change them.
4. When the task names a section (a task block sits under a heading), keep to
   that section unless the task says otherwise.
5. Say what you are doing, in a few words, whenever it changes:
   \`story agent status "merging duplicates"\`. People see this beside your
   cursor.
6. When you are finished, say what you did in one line:
   \`story agent done "Merged 3 duplicates and sorted by aisle"\`.
`;

const HOOK_EVENTS = {
  PostToolUse: "Read|Edit|MultiEdit|Write|NotebookEdit",
  Stop: undefined,
  SessionEnd: undefined,
} as const;

const PERMISSION = "Bash(story agent:*)";
const SKILL_DIRECTORY = "story-placed-folders";

type HookEntry = { matcher?: string; hooks: Array<{ type: "command"; command: string }> };
type ClaudeSettings = {
  hooks?: Record<string, HookEntry[]>;
  permissions?: { allow?: string[] } & Record<string, unknown>;
} & Record<string, unknown>;

export interface AgentInstallOptions {
  /** Claude Code's user directory; default `~/.claude`. */
  claudeDirectory?: string;
  /** How hooks run the command; default `story`. */
  command?: string;
  /** The label the hooks report; default `Claude`. */
  agent?: string;
}

function claudeDirectory(options: AgentInstallOptions): string {
  return options.claudeDirectory ?? join(homedir(), ".claude");
}

function isOurs(command: string): boolean {
  return /(^|[/\s])story agent hook\b/.test(command);
}

async function readSettings(path: string): Promise<ClaudeSettings> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} is not a JSON object`);
    return value as ClaudeSettings;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

function withoutOurHooks(settings: ClaudeSettings): ClaudeSettings {
  const hooks: Record<string, HookEntry[]> = {};
  for (const [event, entries] of Object.entries(settings.hooks ?? {})) {
    const kept = entries
      .map((entry) => ({ ...entry, hooks: entry.hooks.filter((hook) => !isOurs(hook.command)) }))
      .filter((entry) => entry.hooks.length);
    if (kept.length) hooks[event] = kept;
  }
  const next: ClaudeSettings = { ...settings, hooks };
  if (!Object.keys(hooks).length) delete next.hooks;
  return next;
}

/**
 * Put the skill, the hooks and the permission into Claude Code's user
 * settings. Running it again replaces what an earlier install put there and
 * leaves everything else alone.
 */
export async function installAgentPresence(options: AgentInstallOptions = {}): Promise<{ settings: string; skill: string }> {
  const directory = claudeDirectory(options);
  const settingsPath = join(directory, "settings.json");
  const command = `${options.command ?? "story"} agent hook --agent ${JSON.stringify(options.agent ?? "Claude")}`;
  const settings = withoutOurHooks(await readSettings(settingsPath));
  const hooks = settings.hooks ?? {};
  for (const [event, matcher] of Object.entries(HOOK_EVENTS)) {
    hooks[event] = [...(hooks[event] ?? []), { ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command }] }];
  }
  const allow = settings.permissions?.allow ?? [];
  const next: ClaudeSettings = {
    ...settings,
    hooks,
    permissions: { ...settings.permissions, allow: allow.includes(PERMISSION) ? allow : [...allow, PERMISSION] },
  };
  await mkdir(directory, { recursive: true });
  await writeFile(settingsPath, `${JSON.stringify(next, null, 2)}\n`);
  const skillPath = join(directory, "skills", SKILL_DIRECTORY, "SKILL.md");
  await mkdir(dirname(skillPath), { recursive: true });
  await writeFile(skillPath, AGENT_SKILL);
  return { settings: settingsPath, skill: skillPath };
}

/** Take out exactly what `installAgentPresence` put in. */
export async function uninstallAgentPresence(options: AgentInstallOptions = {}): Promise<void> {
  const directory = claudeDirectory(options);
  const settingsPath = join(directory, "settings.json");
  const settings = withoutOurHooks(await readSettings(settingsPath));
  if (settings.permissions?.allow) {
    settings.permissions = { ...settings.permissions, allow: settings.permissions.allow.filter((rule) => rule !== PERMISSION) };
  }
  if (Object.keys(settings).length || await readFile(settingsPath).then(() => true, () => false)) {
    await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  }
  await rm(join(directory, "skills", SKILL_DIRECTORY), { recursive: true, force: true });
}

/** A report's body, as `POST /v1/agents/report` takes it. */
export interface AgentReportBody {
  session?: string;
  cwd: string;
  agent?: string;
  status?: string;
  done?: string;
  hook?: unknown;
}

/** The report for `story agent status|done <text>`, named by the runner's environment when it set one. */
export function textReport(kind: "status" | "done", text: string, cwd: string, environment: NodeJS.ProcessEnv): AgentReportBody {
  return {
    cwd,
    ...(environment.STORY_AGENT_SESSION ? { session: environment.STORY_AGENT_SESSION } : {}),
    ...(environment.STORY_AGENT_LABEL ? { agent: environment.STORY_AGENT_LABEL } : {}),
    [kind]: text,
  };
}

/** The report for one hook payload read from stdin; null when it is not one. */
export function hookReport(input: string, cwd: string, agent: string | undefined, environment: NodeJS.ProcessEnv): AgentReportBody | null {
  let hook: unknown;
  try { hook = JSON.parse(input); } catch { return null; }
  if (!hook || typeof hook !== "object" || Array.isArray(hook)) return null;
  const hookCwd = (hook as { cwd?: unknown }).cwd;
  return {
    cwd: typeof hookCwd === "string" && hookCwd.startsWith("/") ? hookCwd : cwd,
    ...(environment.STORY_AGENT_SESSION ? { session: environment.STORY_AGENT_SESSION } : {}),
    ...(agent ?? environment.STORY_AGENT_LABEL ? { agent: agent ?? environment.STORY_AGENT_LABEL } : {}),
    hook,
  };
}
