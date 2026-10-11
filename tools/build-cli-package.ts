import { chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";

const root = resolve(import.meta.dir, "..");
const source = JSON.parse(await readFile(join(root, "packages/cli/package.json"), "utf8"));
const output = resolve(process.argv[2] ?? join(root, "dist/npm-cli"));
// The package ships everything in bin/, so a rebuild never keeps an earlier build's commands.
await rm(join(output, "bin"), { recursive: true, force: true });
await mkdir(join(output, "bin"), { recursive: true });
for (const [entry, name] of [
  ["packages/cli/src/index.ts", "story.js"],
  ["packages/story-sync/src/cli.ts", "story-sync.js"],
]) {
  const result = await Bun.build({
    entrypoints: [join(root, entry!)], target: "bun", format: "esm",
    external: ["@parcel/watcher"],
    define: { STORY_PACKAGE_VERSION: JSON.stringify(source.version) },
  });
  if (!result.success) throw new AggregateError(result.logs, `Could not build ${entry}`);
  const text = await result.outputs[0]!.text();
  await writeFile(join(output, "bin", name!), text.startsWith("#!") ? text : `#!/usr/bin/env bun\n${text}`);
  await chmod(join(output, "bin", name!), 0o755);
}
await writeFile(join(output, "package.json"), JSON.stringify({
  name: source.name, version: source.version, description: source.description,
  license: "MIT", homepage: "https://github.com/jxe/arbor#readme",
  repository: { type: "git", url: "git+https://github.com/jxe/arbor.git", directory: "packages/cli" },
  // One command, so `bunx @ovst/cli` and `npx @ovst/cli` resolve it; story-sync.js ships as the daemon's file.
  type: "module", bin: { story: "bin/story.js" },
  files: ["bin", "README.md", "LICENSE"], engines: { bun: ">=1.4.2" },
  publishConfig: { access: "public" },
  os: ["darwin", "linux"], cpu: ["arm64", "x64"],
  dependencies: { "@parcel/watcher": "2.5.1" },
}, null, 2) + "\n");
await copyFile(join(root, "LICENSE"), join(output, "LICENSE"));
await writeFile(join(output, "README.md"), `# Story CLI

The \`story\` command for [Overstory](https://github.com/jxe/arbor). Requires Bun 1.4.2 or newer.

\`\`\`sh
bunx @ovst/cli@${source.version} --help
\`\`\`

For an isolated agent session, put an agent bundle string in \`STORY_CLOUD_BUNDLE\`, then:

\`\`\`sh
bunx @ovst/cli@${source.version} agent run --root ./work -- <agent command>
\`\`\`

Where the harness starts the agent itself, use the two steps:

\`\`\`sh
bunx @ovst/cli@${source.version} agent start --root ./work --json
# edit files under ./work
bunx @ovst/cli@${source.version} agent finish --root ./work --json
\`\`\`

Ordinary sync commands need a running Story Sync: \`story daemon install\` on macOS, or \`story daemon run --control\` under a Linux service manager.
`);
console.log(output);
