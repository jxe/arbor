import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ARBOR_SYNC_LABEL,
  DarwinArborDaemonSupervisor,
  darwinDaemonCommand,
  darwinDaemonPaths,
  darwinLaunchAgentPlist,
} from "../../packages/cli/src/daemon.ts";

const roots: string[] = [];
const previousDataHome = process.env.ARBOR_DATA_HOME;

// Supervision owns only the default data home, so tests that install clear the
// override inside their own body; it is restored before the next test starts.
afterEach(async () => {
  if (previousDataHome === undefined) delete process.env.ARBOR_DATA_HOME;
  else process.env.ARBOR_DATA_HOME = previousDataHome;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Arbor daemon supervision", () => {
  test("generates a literal per-user launch agent without data-home secrets", () => {
    const paths = darwinDaemonPaths("/Users/alice");
    const command = darwinDaemonCommand({ executable: "/Applications/Arbor CLI/bin/arborsync" });
    const plist = darwinLaunchAgentPlist(command, paths);

    expect(plist).toContain(`<string>${ARBOR_SYNC_LABEL}</string>`);
    expect(plist).toContain("<string>/Applications/Arbor CLI/bin/arborsync</string>");
    expect(plist).toContain("<string>--control</string>");
    expect(plist).toContain("<key>Crashed</key>");
    expect(plist).toContain("/Users/alice/Library/Logs/Arbor/arborsync.log");
    expect(plist).not.toContain("ARBOR_DATA_HOME");
  });

  test("installs, reports, stops, restarts, and uninstalls one launchd job", async () => {
    delete process.env.ARBOR_DATA_HOME;
    const home = await mkdtemp(join(tmpdir(), "arbor-daemon-supervision-"));
    roots.push(home);
    const commands: string[][] = [];
    let loaded = false;
    let running = false;
    const supervisor = new DarwinArborDaemonSupervisor({
      home,
      executable: "/opt/arbor/arborsync",
      fetcher: (async () => running
        ? Response.json({ service: "arborsync", protocolVersion: "v1" })
        : Promise.reject(new Error("stopped"))),
      run: async (command) => {
        commands.push(command);
        const action = command[1];
        if (action === "print") {
          return loaded
            ? { exitCode: 0, stdout: `state = ${running ? "running" : "waiting"}\npid = 812`, stderr: "" }
            : { exitCode: 113, stdout: "", stderr: "not found" };
        }
        if (action === "bootstrap") { loaded = true; running = true; }
        if (action === "kickstart") { running = true; }
        if (action === "kill") running = false;
        if (action === "bootout") { loaded = false; running = false; }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    expect(await supervisor.install()).toContain("Installed and started");
    expect(await readFile(darwinDaemonPaths(home).plist, "utf8")).toContain("/opt/arbor/arborsync");
    expect(await supervisor.status()).toMatchObject({ state: "running", installed: true, pid: 812 });
    expect(await supervisor.stop()).toContain("Stopped");
    expect((await supervisor.status()).state).toBe("stopped");
    expect(await supervisor.restart()).toContain("Restarted");
    expect(await supervisor.uninstall()).toContain("data was left untouched");
    expect((await supervisor.status()).state).toBe("not-installed");
    expect(commands.some((command) => command[1] === "bootstrap")).toBe(true);
    expect(commands.some((command) => command.includes("-k"))).toBe(true);
  });

  test("does not register an alternate Arbor data home as the default service", async () => {
    process.env.ARBOR_DATA_HOME = "/tmp/arbor-isolated";
    const supervisor = new DarwinArborDaemonSupervisor({
      run: async () => ({ exitCode: 1, stdout: "", stderr: "" }),
    });
    await expect(supervisor.install()).rejects.toThrow("default Arbor data home");
  });

  test("refuses to install over an unsupervised process on the well-known port", async () => {
    delete process.env.ARBOR_DATA_HOME;
    const home = await mkdtemp(join(tmpdir(), "arbor-daemon-collision-"));
    roots.push(home);
    const supervisor = new DarwinArborDaemonSupervisor({
      home,
      fetcher: async () => Response.json({ service: "arborsync", protocolVersion: "v1" }),
      run: async () => ({ exitCode: 113, stdout: "", stderr: "not found" }),
    });
    await expect(supervisor.install()).rejects.toThrow("unsupervised Arbor Sync");
  });
});
