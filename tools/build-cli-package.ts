import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";

// The npm package is a small Node launcher plus one standalone executable per platform,
// compiled with Bun, so `npx @ovst/cli` runs where only Node is installed.
const root = resolve(import.meta.dir, "..");
const source = JSON.parse(await readFile(join(root, "packages/cli/package.json"), "utf8"));
const output = resolve(process.argv[2] ?? join(root, "dist/npm-cli"));
const only = process.env.STORY_CLI_TARGETS?.split(",").filter(Boolean);
// Every executable embeds the repository's pinned Bun, whatever Bun runs this script: a canary has no runtimes to cross-compile with.
const bunVersion = (await readFile(join(root, ".bun-version"), "utf8")).trim();

/** The platforms the package ships, as Node names them, with the Bun target and @parcel/watcher prebuild for each. */
const CLI_TARGETS = [
  { os: "darwin", cpu: "arm64", bun: "bun-darwin-arm64", watcher: "@parcel/watcher-darwin-arm64" },
  { os: "darwin", cpu: "x64", bun: "bun-darwin-x64", watcher: "@parcel/watcher-darwin-x64" },
  { os: "linux", cpu: "x64", bun: "bun-linux-x64", watcher: "@parcel/watcher-linux-x64-glibc" },
  { os: "linux", cpu: "arm64", bun: "bun-linux-arm64", watcher: "@parcel/watcher-linux-arm64-glibc" },
] as const;
const targets = CLI_TARGETS.filter((target) => !only || only.includes(`${target.os}-${target.cpu}`));

const watcherPackage = dirname(createRequire(join(root, "packages/fs/package.json")).resolve("@parcel/watcher/package.json"));
const watcherVersion: string = JSON.parse(await readFile(join(watcherPackage, "package.json"), "utf8")).version;

/** The prebuilt watcher.node for a target: the installed one when present, otherwise fetched from npm into a scratch directory. */
async function watcherBinding(name: string, scratch: string): Promise<string> {
  try {
    const installed = createRequire(join(watcherPackage, "package.json")).resolve(`${name}/watcher.node`);
    return installed;
  } catch {}
  const directory = join(scratch, name.replace("/", "+"));
  await mkdir(directory, { recursive: true });
  const pack = Bun.spawnSync(["npm", "pack", "--silent", `${name}@${watcherVersion}`], { cwd: directory, stderr: "inherit" });
  if (pack.exitCode !== 0) throw new Error(`Could not fetch ${name}@${watcherVersion}`);
  const tarball = pack.stdout.toString().trim().split("\n").pop()!;
  const untar = Bun.spawnSync(["tar", "-xzf", tarball], { cwd: directory, stderr: "inherit" });
  if (untar.exitCode !== 0) throw new Error(`Could not unpack ${tarball}`);
  return join(directory, "package", "watcher.node");
}

const common = {
  version: source.version, license: "MIT", homepage: "https://github.com/jxe/arbor#readme",
  repository: { type: "git", url: "git+https://github.com/jxe/arbor.git", directory: "packages/cli" },
  publishConfig: { access: "public" },
};
const platformName = (target: (typeof CLI_TARGETS)[number]) => `${source.name}-${target.os}-${target.cpu}`;

const scratch = await mkdtemp(join(tmpdir(), "story-cli-build-"));
try {
  // A rebuild never keeps an earlier build's files.
  await rm(output, { recursive: true, force: true });
  await mkdir(join(output, "bin"), { recursive: true });
  for (const target of targets) {
    const directory = `${output}-${target.os}-${target.cpu}`;
    await rm(directory, { recursive: true, force: true });
    await mkdir(join(directory, "bin"), { recursive: true });
    const binding = await watcherBinding(target.watcher, scratch);
    const executable = join(directory, "bin", "story");
    const result = await Bun.build({
      entrypoints: [join(root, "packages/cli/src/index.ts")],
      define: { STORY_PACKAGE_VERSION: JSON.stringify(source.version) },
      compile: { target: `${target.bun}-v${bunVersion}`, outfile: executable },
      plugins: [{
        name: "story-watcher-binding",
        setup(build) {
          // @parcel/watcher picks its prebuild by a computed name, which a bundle cannot follow; name this target's directly.
          build.onResolve({ filter: /^@parcel\/watcher$/ }, () => ({ path: "@parcel/watcher", namespace: "story-watcher" }));
          build.onLoad({ filter: /.*/, namespace: "story-watcher" }, () => ({
            loader: "js",
            contents: `const { createWrapper } = require(${JSON.stringify(join(watcherPackage, "wrapper.js"))});\n`
              + `module.exports = createWrapper(require(${JSON.stringify(binding)}));\n`,
          }));
        },
      }],
    });
    if (!result.success) throw new AggregateError(result.logs, `Could not build ${target.bun}`);
    await chmod(executable, 0o755);
    if (target.os === "darwin" && process.platform === "darwin") {
      // Apple silicon runs only signed code; an ad hoc signature is enough outside the App Store.
      const sign = Bun.spawnSync(["codesign", "--force", "--sign", "-", executable], { stderr: "inherit" });
      if (sign.exitCode !== 0) throw new Error(`Could not sign ${executable}`);
    }
    await writeFile(join(directory, "package.json"), JSON.stringify({
      name: platformName(target), ...common,
      description: `The story command for ${target.os} ${target.cpu}. Install @ovst/cli rather than this package.`,
      os: [target.os], cpu: [target.cpu], files: ["bin", "README.md", "LICENSE"],
    }, null, 2) + "\n");
    await copyFile(join(root, "LICENSE"), join(directory, "LICENSE"));
    await writeFile(join(directory, "README.md"), `# ${platformName(target)}\n\nThe standalone \`story\` executable for ${target.os} ${target.cpu}. Install [@ovst/cli](https://www.npmjs.com/package/@ovst/cli), which picks this package for you.\n`);
    console.log(`${directory} (${((await stat(executable)).size / 1e6).toFixed(0)} MB)`);
  }

  await writeFile(join(output, "bin", "story.js"), `#!/usr/bin/env node
// Runs the standalone story executable for this platform, installed as an optional dependency.
const { spawnSync } = require("node:child_process");
const name = \`${source.name}-\${process.platform}-\${process.arch}\`;
let executable;
try { executable = require.resolve(\`\${name}/bin/story\`); }
catch {
  console.error(\`story: no build for \${process.platform} \${process.arch} (looked for \${name}); supported: ${CLI_TARGETS.map((t) => `${t.os}-${t.cpu}`).join(", ")}\`);
  process.exit(1);
}
const result = spawnSync(executable, process.argv.slice(2), { stdio: "inherit" });
if (result.error) { console.error(\`story: \${result.error.message}\`); process.exit(1); }
if (result.signal) process.kill(process.pid, result.signal);
process.exit(result.status ?? 1);
`);
  await chmod(join(output, "bin", "story.js"), 0o755);
  await writeFile(join(output, "package.json"), JSON.stringify({
    name: source.name, ...common, description: source.description,
    // CommonJS, so the launcher runs under any Node the package supports.
    type: "commonjs", bin: { story: "bin/story.js" },
    files: ["bin", "README.md", "LICENSE"], engines: { node: ">=18" },
    optionalDependencies: Object.fromEntries(CLI_TARGETS.map((target) => [platformName(target), source.version])),
  }, null, 2) + "\n");
  await copyFile(join(root, "LICENSE"), join(output, "LICENSE"));
  await writeFile(join(output, "README.md"), `# Story CLI

The \`story\` command for [Overstory](https://github.com/jxe/arbor). It runs on macOS and Linux (arm64 or x64) with Node 18 or newer; Bun is not required.

\`\`\`sh
npx @ovst/cli@${source.version} --help
\`\`\`

For an isolated agent session, put an agent bundle string in \`STORY_CLOUD_BUNDLE\`, then:

\`\`\`sh
npx @ovst/cli@${source.version} agent run --root ./work -- <agent command>
\`\`\`

Where the harness starts the agent itself, use the two steps:

\`\`\`sh
npx @ovst/cli@${source.version} agent start --root ./work --json
# edit files under ./work
npx @ovst/cli@${source.version} agent finish --root ./work --json
\`\`\`

Ordinary sync commands need a running Story Sync: \`story daemon install\` on macOS, or \`story daemon run --control\` under a Linux service manager.
`);
  console.log(output);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
