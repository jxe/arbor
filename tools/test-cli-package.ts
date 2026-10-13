import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { persistPackageRuntime } from "../packages/cli/src/package-runtime.ts";

const root = resolve(import.meta.dir, "..");
const scratch = await mkdtemp(join(tmpdir(), "story-package-check-"));
const environment = { ...process.env, STORY_CREDENTIAL_STORE: "file", STORY_HOME: join(scratch, "data") };
// The installed command must need Node and nothing else: no Bun on PATH.
const nodeOnly = { ...environment, PATH: [dirname(Bun.which("node") ?? "/usr/bin/node"), "/usr/bin", "/bin"].join(":") };
async function run(command: string[], cwd: string, env: Record<string, string | undefined> = environment) {
  const child = Bun.spawn(command, { cwd, env, stdout: "inherit", stderr: "inherit" });
  if (await child.exited !== 0) throw new Error(`Package verification failed: ${command.slice(0, 3).join(" ")}`);
}
try {
  const artifact = join(scratch, "artifact");
  const host = `${process.platform}-${process.arch}`;
  await run([process.execPath, join(root, "tools/build-cli-package.ts"), artifact], root, { ...environment, STORY_CLI_TARGETS: host });
  for (const directory of [artifact, `${artifact}-${host}`]) await run(["npm", "pack", "--ignore-scripts", "--pack-destination", scratch], directory);
  const manifest = await Bun.file(join(artifact, "package.json")).json();
  // The package's one command must resolve by package name alone, as `npx @ovst/cli` does.
  if (Object.keys(manifest.bin).join() !== "story") throw new Error("The package must declare exactly the story command");
  if (!manifest.optionalDependencies[`${manifest.name}-${host}`]) throw new Error(`The package must depend on its ${host} build`);
  const tarballs = (await readdir(scratch)).filter((name) => name.endsWith(".tgz")).map((name) => join(scratch, name));
  await run(["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund", ...tarballs], scratch);
  const story = join(scratch, "node_modules/.bin/story");
  const version = Bun.spawnSync([story, "--version"], { env: nodeOnly });
  if (version.stdout.toString().trim() !== manifest.version) throw new Error(`story --version printed ${version.stdout.toString().trim()}${version.stderr.toString()}, expected ${manifest.version}`);
  await run([story, "--help"], scratch, nodeOnly);
  const executable = join(scratch, `node_modules/@ovst/cli-${host}/bin/story`);
  // Runs the existing real-host lifecycle and ordinary command tests against the installed executable.
  let lifecycleError: unknown;
  try {
    await run([process.execPath, "test", "tests/integration/cli-sync.test.ts"], root, { ...environment, STORY_TEST_CLI_EXECUTABLE: executable });
  } catch (error) { lifecycleError = error; }
  if (process.platform === "darwin") {
    const installed = await persistPackageRuntime(executable, scratch);
    await rm(join(scratch, "node_modules"), { recursive: true, force: true });
    await run([process.execPath, join(root, "tools/test-sync-helper.ts"), installed, "daemon", "run"], scratch);
  }
  if (lifecycleError) throw lifecycleError;
} finally {
  await rm(scratch, { recursive: true, force: true });
}
