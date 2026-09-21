import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";

const root = resolve(import.meta.dir, "..");
const output = resolve(process.argv[2] ?? join(root, "dist/npm-cli"));
await mkdir(join(output, "bin"), { recursive: true });
for (const [entry, name] of [
  ["packages/cli/src/index.ts", "arbor.js"],
  ["packages/arborsync/src/cli.ts", "arborsync.js"],
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
  type: "module", bin: { arbor: "bin/arbor.js", arborsync: "bin/arborsync.js" },
  files: ["bin", "README.md"], engines: { bun: ">=1.3.14" },
  os: ["darwin", "linux"], cpu: ["arm64", "x64"],
  dependencies: { "@parcel/watcher": "2.5.1" },
}, null, 2) + "\n");
await writeFile(join(output, "README.md"), `# Arbor CLI\n\nRequires Bun 1.3.14 or newer.\n\nRun \`bunx --bun --package @overstory/cli@${source.version} arbor status\`.\n\nFor an isolated agent session, set ARBOR_CLOUD_BUNDLE and run \`arbor cloud start\`, then \`arbor cloud finish\`. Ordinary sync commands require an ArborSync service; use \`arbor daemon install\` on macOS or run \`arborsync --control\` under a Linux service manager.\n`);
console.log(output);
