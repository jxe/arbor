import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const ARBOR_SYNC_PORT = 4317;
export const ARBOR_SYNC_LABEL = "org.nxhx.Arbor.arborsync";

export type ArborDaemonState = "running" | "stopped" | "not-installed" | "unavailable";

export interface ArborDaemonStatus {
  platform: NodeJS.Platform;
  state: ArborDaemonState;
  installed: boolean;
  origin: string;
  pid?: number;
  detail: string;
}

export interface ArborDaemonSupervisor {
  install(): Promise<string>;
  uninstall(): Promise<string>;
  start(): Promise<string>;
  stop(): Promise<string>;
  restart(): Promise<string>;
  status(): Promise<ArborDaemonStatus>;
  logs(): Promise<string>;
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

type RunCommand = (command: string[]) => Promise<CommandResult>;
type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface DarwinDaemonPaths {
  plist: string;
  log: string;
}

export interface DarwinDaemonOptions {
  home?: string;
  executable?: string;
  script?: string;
  run?: RunCommand;
  fetcher?: Fetcher;
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function darwinDaemonPaths(home = homedir()): DarwinDaemonPaths {
  return {
    plist: join(home, "Library", "LaunchAgents", `${ARBOR_SYNC_LABEL}.plist`),
    log: join(home, "Library", "Logs", "Arbor", "arborsync.log"),
  };
}

export function darwinDaemonCommand(options: Pick<DarwinDaemonOptions, "executable" | "script"> = {}): string[] {
  if (options.executable) return [resolve(options.executable), "--control", "--port", String(ARBOR_SYNC_PORT)];
  return [
    process.execPath,
    resolve(options.script ?? join(import.meta.dir, "../../arborsync/src/cli.ts")),
    "--control",
    "--port",
    String(ARBOR_SYNC_PORT),
  ];
}

export function darwinLaunchAgentPlist(command: string[], paths: DarwinDaemonPaths): string {
  const argumentsXML = command.map((argument) => `\t\t<string>${xml(argument)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${ARBOR_SYNC_LABEL}</string>
\t<key>ProgramArguments</key>
\t<array>
${argumentsXML}
\t</array>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>KeepAlive</key>
\t<dict>
\t\t<key>Crashed</key>
\t\t<true/>
\t</dict>
\t<key>ProcessType</key>
\t<string>Background</string>
\t<key>ThrottleInterval</key>
\t<integer>5</integer>
\t<key>StandardOutPath</key>
\t<string>${xml(paths.log)}</string>
\t<key>StandardErrorPath</key>
\t<string>${xml(paths.log)}</string>
</dict>
</plist>
`;
}

async function defaultRun(command: string[]): Promise<CommandResult> {
  const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
}

function commandFailure(action: string, result: CommandResult): Error {
  return new Error(`${action} failed: ${result.stderr || result.stdout || `exit ${result.exitCode}`}`);
}

export class DarwinArborDaemonSupervisor implements ArborDaemonSupervisor {
  private readonly paths: DarwinDaemonPaths;
  private readonly command: string[];
  private readonly domain: string;
  private readonly service: string;
  private readonly run: RunCommand;
  private readonly fetcher: Fetcher;

  constructor(options: DarwinDaemonOptions = {}) {
    this.paths = darwinDaemonPaths(options.home ?? homedir());
    this.command = darwinDaemonCommand(options);
    const uid = typeof process.getuid === "function" ? process.getuid() : 0;
    this.domain = `gui/${uid}`;
    this.service = `${this.domain}/${ARBOR_SYNC_LABEL}`;
    this.run = options.run ?? defaultRun;
    this.fetcher = options.fetcher ?? fetch;
  }

  async install(): Promise<string> {
    if (process.env.ARBOR_DATA_HOME) {
      throw new Error("Persistent daemon supervision currently owns only the default Arbor data home; unset ARBOR_DATA_HOME first");
    }
    const loaded = await this.launchdRecord();
    const existing = await readFile(this.paths.plist, "utf8").catch(() => null);
    if (loaded && existing === null) {
      if (!await this.reachable()) {
        const result = await this.run(["/bin/launchctl", "kickstart", this.service]);
        if (result.exitCode !== 0) throw commandFailure("Starting the app-managed Arbor Sync", result);
        await this.waitUntilRunning();
      }
      return "Arbor Sync is already installed by the native Arbor app.";
    }
    if (!loaded && await this.reachable()) {
      throw new Error("An unsupervised Arbor Sync is already using port 4317; stop that foreground process, then run `arbor daemon install` again");
    }
    const desired = darwinLaunchAgentPlist(this.command, this.paths);
    if (existing !== desired) {
      if (loaded) await this.bootout();
      await mkdir(dirname(this.paths.plist), { recursive: true, mode: 0o700 });
      await mkdir(dirname(this.paths.log), { recursive: true, mode: 0o700 });
      const staged = `${this.paths.plist}.new`;
      await writeFile(staged, desired, { mode: 0o600 });
      await rename(staged, this.paths.plist);
    }
    if (!loaded || existing !== desired) {
      const result = await this.run(["/bin/launchctl", "bootstrap", this.domain, this.paths.plist]);
      if (result.exitCode !== 0) throw commandFailure("Installing Arbor Sync", result);
    } else if (!await this.reachable()) {
      const result = await this.run(["/bin/launchctl", "kickstart", this.service]);
      if (result.exitCode !== 0) throw commandFailure("Starting Arbor Sync", result);
    }
    await this.waitUntilRunning();
    return `Installed and started Arbor Sync at ${this.origin}.`;
  }

  async uninstall(): Promise<string> {
    const managed = await readFile(this.paths.plist, "utf8").then(() => true).catch(() => false);
    if (!managed) {
      if (await this.launchdRecord()) {
        throw new Error("Arbor Sync is registered by the native Arbor app; unregister it from Arbor rather than removing another owner's service");
      }
      return "Arbor Sync is not installed.";
    }
    await this.bootout();
    await rm(this.paths.plist, { force: true });
    return "Uninstalled Arbor Sync. Arbor data was left untouched.";
  }

  async start(): Promise<string> {
    if (!await this.launchdRecord()) {
      const managed = await readFile(this.paths.plist, "utf8").then(() => true).catch(() => false);
      if (!managed) throw new Error("Arbor Sync is not installed; run `arbor daemon install` first");
      const bootstrap = await this.run(["/bin/launchctl", "bootstrap", this.domain, this.paths.plist]);
      if (bootstrap.exitCode !== 0) throw commandFailure("Loading Arbor Sync", bootstrap);
    }
    const result = await this.run(["/bin/launchctl", "kickstart", this.service]);
    if (result.exitCode !== 0) throw commandFailure("Starting Arbor Sync", result);
    await this.waitUntilRunning();
    return `Arbor Sync is running at ${this.origin}.`;
  }

  async stop(): Promise<string> {
    const record = await this.launchdRecord();
    if (!record) return "Arbor Sync is not installed.";
    if (!record.running) return "Arbor Sync is already stopped.";
    const result = await this.run(["/bin/launchctl", "kill", "SIGTERM", this.service]);
    if (result.exitCode !== 0) throw commandFailure("Stopping Arbor Sync", result);
    return "Stopped Arbor Sync. It remains installed and will start again at login or when requested.";
  }

  async restart(): Promise<string> {
    if (!await this.launchdRecord()) throw new Error("Arbor Sync is not installed; run `arbor daemon install` first");
    const result = await this.run(["/bin/launchctl", "kickstart", "-k", this.service]);
    if (result.exitCode !== 0) throw commandFailure("Restarting Arbor Sync", result);
    await this.waitUntilRunning();
    return `Restarted Arbor Sync at ${this.origin}.`;
  }

  async status(): Promise<ArborDaemonStatus> {
    const record = await this.launchdRecord();
    const managed = await readFile(this.paths.plist, "utf8").then(() => true).catch(() => false);
    const reachable = await this.reachable();
    if (reachable) {
      return {
        platform: process.platform,
        state: "running",
        installed: record !== null || managed,
        origin: this.origin,
        ...(record?.pid ? { pid: record.pid } : {}),
        detail: record ? "Arbor Sync is supervised by launchd." : "Arbor Sync is reachable but is not registered with this launchd user domain.",
      };
    }
    if (record) {
      return {
        platform: process.platform,
        state: record.running ? "unavailable" : "stopped",
        installed: true,
        origin: this.origin,
        ...(record.pid ? { pid: record.pid } : {}),
        detail: record.running ? "launchd reports a process, but Arbor Sync REST v1 is not reachable." : "Arbor Sync is installed but stopped.",
      };
    }
    if (managed) {
      return {
        platform: process.platform,
        state: "stopped",
        installed: true,
        origin: this.origin,
        detail: "Arbor Sync has a CLI-owned LaunchAgent but is not loaded.",
      };
    }
    return {
      platform: process.platform,
      state: "not-installed",
      installed: false,
      origin: this.origin,
      detail: "Arbor Sync is not installed for this user.",
    };
  }

  async logs(): Promise<string> {
    const contents = await readFile(this.paths.log, "utf8").catch(() => "");
    return contents ? contents.slice(-32_768) : `No Arbor Sync log output at ${this.paths.log}`;
  }

  private get origin(): string {
    return `http://127.0.0.1:${ARBOR_SYNC_PORT}`;
  }

  private async reachable(): Promise<boolean> {
    try {
      const response = await this.fetcher(`${this.origin}/v1/status`, { signal: AbortSignal.timeout(1_000) });
      if (!response.ok) return false;
      const status = await response.json() as { service?: string; protocolVersion?: string };
      return status.service === "arborsync" && status.protocolVersion === "v1";
    } catch {
      return false;
    }
  }

  private async waitUntilRunning(): Promise<void> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (await this.reachable()) return;
      await Bun.sleep(100);
    }
    throw new Error(`Arbor Sync was launched but REST v1 did not become ready. Inspect ${this.paths.log}`);
  }

  private async launchdRecord(): Promise<{ running: boolean; pid?: number } | null> {
    const result = await this.run(["/bin/launchctl", "print", this.service]);
    if (result.exitCode !== 0) return null;
    const state = /^\s*state = (\S+)/m.exec(result.stdout)?.[1];
    const pid = Number(/^\s*pid = (\d+)/m.exec(result.stdout)?.[1]);
    return { running: state === "running", ...(Number.isInteger(pid) && pid > 0 ? { pid } : {}) };
  }

  private async bootout(): Promise<void> {
    const result = await this.run(["/bin/launchctl", "bootout", this.service]);
    if (result.exitCode !== 0 && await this.launchdRecord()) throw commandFailure("Unloading Arbor Sync", result);
  }
}

class UnsupportedArborDaemonSupervisor implements ArborDaemonSupervisor {
  constructor(private readonly platform: NodeJS.Platform) {}

  private unsupported(): never {
    throw new Error(`Arbor daemon supervision is not implemented for ${this.platform} yet; run \`arborsync --control\` under your user service manager`);
  }

  async install(): Promise<string> { return this.unsupported(); }
  async uninstall(): Promise<string> { return this.unsupported(); }
  async start(): Promise<string> { return this.unsupported(); }
  async stop(): Promise<string> { return this.unsupported(); }
  async restart(): Promise<string> { return this.unsupported(); }
  async logs(): Promise<string> { return this.unsupported(); }
  async status(): Promise<ArborDaemonStatus> {
    const origin = `http://127.0.0.1:${ARBOR_SYNC_PORT}`;
    try {
      const response = await fetch(`${origin}/v1/status`, { signal: AbortSignal.timeout(1_000) });
      const status = response.ok ? await response.json() as { service?: string; protocolVersion?: string } : null;
      if (status?.service === "arborsync" && status.protocolVersion === "v1") {
        return {
          platform: this.platform,
          state: "running",
          installed: false,
          origin,
          detail: "Arbor Sync is reachable and is supervised outside Arbor's current platform adapter.",
        };
      }
    } catch {}
    return {
      platform: this.platform,
      state: "unavailable",
      installed: false,
      origin,
      detail: `Arbor daemon supervision is not implemented for ${this.platform} yet.`,
    };
  }
}

export function arborDaemonSupervisor(platform: NodeJS.Platform = process.platform): ArborDaemonSupervisor {
  return platform === "darwin" ? new DarwinArborDaemonSupervisor() : new UnsupportedArborDaemonSupervisor(platform);
}
