import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";

const root = resolve(import.meta.dir, "..");
const output = resolve(process.argv[2] ?? join(root, "dist/npm-cli"));
await mkdir(join(output, "bin"), { recursive: true });
for (const [entry, name] of [
  ["packages/cli/src/index.ts", "story.js"],
  ["packages/story-sync/src/cli.ts", "story-sync.js"],
]) {
  const result = await Bun.build({
    entrypoints: [join(root, entry!)], target: "bun", format: "esm",
    external: ["@parcel/watcher"],
  });
  if (!result.success) throw new AggregateError(result.logs, `Could not build ${entry}`);
  const source = await result.outputs[0]!.text();
  await writeFile(join(output, "bin", name!), source.startsWith("#!") ? source : `#!/usr/bin/env bun\n${source}`);
  await chmod(join(output, "bin", name!), 0o755);
}
const source = JSON.parse(await readFile(join(root, "packages/cli/package.json"), "utf8"));
await writeFile(join(output, "package.json"), JSON.stringify({
  name: source.name, version: source.version, description: source.description,
  type: "module", bin: { story: "bin/story.js", "story-sync": "bin/story-sync.js" },
  files: ["bin", "README.md"], engines: { bun: ">=1.4.2" },
  os: ["darwin", "linux"], cpu: ["arm64", "x64"],
  dependencies: { "@parcel/watcher": "2.5.1" },
}, null, 2) + "\n");
await writeFile(join(output, "README.md"), `# Story CLI\n\nRequires Bun 1.4.2 or newer.\n\nRun \`bunx --bun --package @ovst/cli@${source.version} story status\`.\n\nFor an isolated agent session, set STORY_CLOUD_BUNDLE and run \`story cloud start\`, then \`story cloud finish\`. Ordinary sync commands require an StorySync service; use \`story daemon install\` on macOS or run \`story-sync --control\` under a Linux service manager.\n`);
console.log(output);
