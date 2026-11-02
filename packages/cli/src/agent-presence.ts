// `story agent status|done|hook|install|uninstall` (Agents 001 phase 7): an
// agent working in a placed folder reports to Story Sync, which shows it in
// the tree's presence. Reports are best effort: a hook never fails the agent.

import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { AGENT_SKILL } from "@ovst/story-sync";


const HOOK_EVENTS = {
  // Before an edit, so Story Sync holds the tree's publishing from the first one.
  PreToolUse: "Edit|MultiEdit|Write|NotebookEdit",
  PostToolUse: "Read|Edit|MultiEdit|Write|NotebookEdit",
  Stop: undefined,
  SessionEnd: undefined,
} as const;

function isOurPermission(rule: string): boolean {
  return /^Bash\((.*[/\s])?(story|@ovst\/cli) agent:\*\)$/.test(rule);
}
const SKILL_DIRECTORY = "story-placed-folders";

type HookEntry = { matcher?: string; hooks: Array<{ type: "command"; command: string }> };
type ClaudeSettings = {
  hooks?: Record<string, HookEntry[]>;
  permissions?: { allow?: string[] } & Record<string, unknown>;
} & Record<string, unknown>;

export interface AgentInstallOptions {
  /** Claude Code's user directory; default `$CLAUDE_CONFIG_DIR`, else `~/.claude`. */
  claudeDirectory?: string;
  /** How hooks run the command; default `story`. */
  command?: string;
  /** The label the hooks report; default `Claude`. */
  agent?: string;
}

function claudeDirectory(options: AgentInstallOptions): string {
  return options.claudeDirectory ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
}

function isOurs(command: string): boolean {
  return /(^|[/\s])(story|@ovst\/cli) agent hook\b/.test(command);
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
  const story = options.command ?? "story";
  const command = `${story} agent hook --agent ${JSON.stringify(options.agent ?? "Claude")}`;
  const settings = withoutOurHooks(await readSettings(settingsPath));
  const hooks = settings.hooks ?? {};
  for (const [event, matcher] of Object.entries(HOOK_EVENTS)) {
    hooks[event] = [...(hooks[event] ?? []), { ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command }] }];
  }
  const allow = (settings.permissions?.allow ?? []).filter((rule) => !isOurPermission(rule));
  const next: ClaudeSettings = {
    ...settings,
    hooks,
    permissions: { ...settings.permissions, allow: [...allow, `Bash(${story} agent:*)`] },
  };
  await mkdir(directory, { recursive: true });
  await writeFile(settingsPath, `${JSON.stringify(next, null, 2)}\n`);
  const skillPath = join(directory, "skills", SKILL_DIRECTORY, "SKILL.md");
  await mkdir(dirname(skillPath), { recursive: true });
  await writeFile(skillPath, AGENT_SKILL.replace(/\bstory (agent|sync)\b/g, `${story} $1`));
  return { settings: settingsPath, skill: skillPath };
}

/** Take out exactly what `installAgentPresence` put in. */
export async function uninstallAgentPresence(options: AgentInstallOptions = {}): Promise<void> {
  const directory = claudeDirectory(options);
  const settingsPath = join(directory, "settings.json");
  const settings = withoutOurHooks(await readSettings(settingsPath));
  if (settings.permissions?.allow) {
    settings.permissions = { ...settings.permissions, allow: settings.permissions.allow.filter((rule) => !isOurPermission(rule)) };
  }
  if (Object.keys(settings).length || await readFile(settingsPath).then(() => true, () => false)) {
    await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  }
  await rm(join(directory, "skills", SKILL_DIRECTORY), { recursive: true, force: true });
}

/** An agent label presence accepts: one line of at most 40 characters. */
export function agentLabel(value: string | undefined, fallback = "Agent"): string {
  const line = [...(value ?? "").replace(/\s+/g, " ").trim()].slice(0, 40).join("").trim();
  return line || fallback;
}

/** Whether this machine has Claude Code, so its hooks are worth installing. */
export function hasClaudeCode(options: AgentInstallOptions = {}): boolean {
  return Boolean(Bun.which("claude")) || existsSync(claudeDirectory(options));
}

/** A report's body, as `POST /v1/agents/report` takes it. */
export interface AgentReportBody {
  session?: string;
  cwd: string;
  agent?: string;
  status?: string;
  at?: string;
  done?: string;
  hook?: unknown;
}

/** The report for `story agent status|done <text>`, named by the runner's environment when it set one. */
export function textReport(kind: "status" | "done", text: string, cwd: string, environment: NodeJS.ProcessEnv, at?: string): AgentReportBody {
  return {
    cwd,
    ...(at ? { at } : {}),
    ...(environment.STORY_AGENT_SESSION ? { session: environment.STORY_AGENT_SESSION } : {}),
    ...(environment.STORY_AGENT_LABEL ? { agent: environment.STORY_AGENT_LABEL } : {}),
    [kind]: text,
  };
}

/**
 * The report for one hook payload read from stdin; null when it is not one,
 * or inside a run Story Sync started, which reports the agent's tools itself.
 */
export function hookReport(input: string, cwd: string, agent: string | undefined, environment: NodeJS.ProcessEnv): AgentReportBody | null {
  if (environment.STORY_AGENT_RUN) return null;
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
