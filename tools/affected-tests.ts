// Runs the verification a change can actually reach, instead of the full gate.
//
//   bun run test:affected                 uncommitted changes (staged, unstaged, untracked)
//   bun run test:affected -- --base main  those plus every commit since main
//   bun run test:affected -- <path>...    only the named files
//   add --list to print the plan without running it
//
// A product test is selected when its import closure contains a changed file.
// The closure follows static and dynamic imports, workspace packages, and
// string literals naming a `.ts` file (the entry points tests spawn). A changed
// data file selects every test whose closure mentions its file name. Anything
// the graph cannot see, such as root configuration or the preload, runs the
// whole product suite.
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { Glob } from "bun";

const root = resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
const listOnly = args.includes("--list");
const baseIndex = args.indexOf("--base");
const base = baseIndex >= 0 ? args[baseIndex + 1] : undefined;
const named = args.filter((arg, index) => !arg.startsWith("--") && (baseIndex < 0 || index !== baseIndex + 1));

function git(...command: string[]): string[] {
  const result = Bun.spawnSync(["git", ...command], { cwd: root, stdout: "pipe", stderr: "inherit" });
  if (result.exitCode !== 0) throw new Error(`git ${command.join(" ")} failed`);
  return result.stdout.toString().split("\n").filter(Boolean);
}

const changed = [...new Set(named.length > 0
  ? named.map(path => relative(root, resolve(path)))
  : [
      ...git("diff", "--name-only", "HEAD"),
      ...git("ls-files", "--others", "--exclude-standard"),
      ...(base ? git("diff", "--name-only", `${base}...HEAD`) : []),
    ])].sort();

if (changed.length === 0) {
  console.log("No changed files.");
  process.exit(0);
}

// Files whose effect no import graph shows: they configure every test.
const global = [
  /^package\.json$/, /^packages\/[^/]+\/package\.json$/, /^bun\.lock$/, /^bunfig\.toml$/,
  /^tsconfig[^/]*\.json$/, /^\.bun-version$/, /^tests\/helpers\/data-home-guard\.ts$/,
];
// The cross-language gate: the portable vectors, the reference fixtures, the
// wire models, and the Swift code it runs against a live host. The Swift
// packages it tests (and OverstoryObjectStore, which they depend on) and the
// Mac app's daemon client belong here; StoryEditor and the rest of the app
// have faster suites of their own.
const protocolGate = [
  /^docs\/overstory-spec\/conformance\//, /^tests\/fixtures\//, /^tests\/protocol\//, /^packages\/protocol\//,
  /^swift\/Packages\/(Overstory|OverstoryClient|OverstoryObjectStore|OverstoryWorkingTree|StoryKit)\//,
  /^swift\/StoryApp\/StorySync\//, /^swift\/StoryAppTests\/StorySync/,
];
const storyEditor = /^swift\/(Packages\/StoryEditor\/|scripts\/test-story-editor-local\.sh$)/;
const swiftDocumentation = /^swift\/.*\.md$/;
const documentation = (path: string) => path.endsWith(".md") && !path.startsWith("tests/fixtures/") || /^(plans|status)\b/.test(path);
const sourceExtensions = new Set([".ts", ".tsx"]);

const importGraph = new Map<string, { imports: string[]; text: string }>();
const transpiler = new Bun.Transpiler({ loader: "tsx" });
const pathLiteral = /["'`]((?:\.{1,2}\/|packages\/)[\w@./-]+\.tsx?)["'`]/g;

function resolveImport(specifier: string, from: string): string | undefined {
  try {
    const target = realpathSync(Bun.resolveSync(specifier, dirname(from)));
    return target.startsWith(root + "/") && !target.includes("/node_modules/") ? target : undefined;
  } catch {
    return undefined;
  }
}

function visit(file: string): { imports: string[]; text: string } {
  const known = importGraph.get(file);
  if (known) return known;
  const entry = { imports: [] as string[], text: "" };
  importGraph.set(file, entry);
  entry.text = readFileSync(file, "utf8");
  const specifiers = new Set<string>();
  try {
    for (const found of transpiler.scanImports(entry.text)) specifiers.add(found.path);
  } catch { /* unparsable: rely on the literal scan */ }
  for (const match of entry.text.matchAll(pathLiteral)) {
    const literal = match[1]!;
    const candidate = literal.startsWith("packages/") ? join(root, literal) : resolve(dirname(file), literal);
    if (existsSync(candidate)) entry.imports.push(realpathSync(candidate));
  }
  for (const specifier of specifiers) {
    const target = resolveImport(specifier, file);
    if (target) entry.imports.push(target);
  }
  for (const target of entry.imports) if (sourceExtensions.has(extname(target))) visit(target);
  return entry;
}

function closure(file: string): Set<string> {
  const seen = new Set<string>();
  const pending = [realpathSync(file)];
  while (pending.length > 0) {
    const next = pending.pop()!;
    if (seen.has(next)) continue;
    seen.add(next);
    if (sourceExtensions.has(extname(next))) pending.push(...visit(next).imports);
  }
  return seen;
}

const testFiles = [...new Glob("tests/{unit,integration}/**/*.test.ts").scanSync(root)].sort();
const closures = new Map(testFiles.map(test => [test, closure(join(root, test))]));
const cliClosure = closure(join(root, "packages/cli/src/index.ts"));
const benchmark = "tests/performance/object-index.bench.ts";
const benchmarkClosure = closure(join(root, benchmark));

const selected = new Set<string>();
const reasons: string[] = [];
let fullSuite = false;
let typecheck = false;
let build = false;
let protocol = false;
let editorSuite = false;
let appSuite = false;
let performance = false;
let links = false;
const migrations = new Set<string>();

function mentions(testClosure: Set<string>, token: string): boolean {
  for (const file of testClosure) {
    const entry = importGraph.get(file);
    if (entry?.text.includes(token)) return true;
  }
  return false;
}

for (const path of changed) {
  const absolute = join(root, path);
  const exists = existsSync(absolute) && statSync(absolute).isFile();
  const extension = extname(path);
  if (sourceExtensions.has(extension)) typecheck = true;
  if (global.some(pattern => pattern.test(path))) {
    fullSuite = true;
    reasons.push(`${path}: configures every test`);
    continue;
  }
  if (protocolGate.some(pattern => pattern.test(path))) protocol = true;
  else if (storyEditor.test(path)) editorSuite = appSuite = true;
  else if (path.startsWith("swift/") && !swiftDocumentation.test(path) && !path.startsWith("swift/scripts/")) appSuite = true;
  if (path === "swift/scripts/test-story-app.sh") appSuite = true;
  const migration = /^packages\/overstoryd\/migrations\/([^/]+)\//.exec(path);
  if (migration && migration[1] !== "tools") migrations.add(`packages/overstoryd/migrations/${migration[1]}`);
  if (path.endsWith(".md")) links = true;
  if (documentation(path) || path.startsWith("packages/story-web/")) continue;

  const target = exists ? realpathSync(absolute) : absolute;
  let hits = 0;
  for (const [test, testClosure] of closures) {
    const reached = exists && sourceExtensions.has(extension)
      ? testClosure.has(target)
      : mentions(testClosure, exists ? basename(path) : path.replace(/\.tsx?$/, ""));
    if (reached) { selected.add(test); hits += 1; }
  }
  if (exists && cliClosure.has(target)) build = true;
  if (exists && benchmarkClosure.has(target)) performance = true;
  if (hits === 0 && exists && !sourceExtensions.has(extension) && !path.startsWith("swift/") && !migration) {
    fullSuite = true;
    reasons.push(`${path}: no test names it, so its reach is unknown`);
  }
}

const steps: Array<{ label: string; command: string[] }> = [];
if (typecheck) steps.push({ label: "typecheck", command: ["bun", "run", "typecheck"] });
if (fullSuite) steps.push({ label: "product suite (full)", command: ["bun", "run", "test"] });
else if (selected.size > 0) steps.push({ label: `product suite (${selected.size} of ${testFiles.length} files)`, command: ["bun", "test", "--parallel=4", ...selected] });
for (const directory of migrations) steps.push({ label: `migration ${basename(directory)}`, command: ["bun", "run", "test:migration", directory] });
if (build) steps.push({ label: "build", command: ["bun", "run", "build"] });
if (protocol) steps.push({ label: "protocol gate (TypeScript + Swift)", command: ["bun", "run", "test:protocol"] });
if (editorSuite) steps.push({ label: "StoryEditor", command: ["swift/scripts/test-story-editor-local.sh"] });
// The gate already builds the app and runs its daemon-client suites.
if (appSuite && !protocol) steps.push({ label: "StoryAppTests", command: ["swift/scripts/test-story-app.sh"] });
if (performance) steps.push({ label: "performance", command: ["bun", "run", "test:performance"] });
if (links) steps.push({ label: "links", command: ["bun", "run", "check:links"] });
steps.push({ label: "whitespace", command: ["git", "diff", "--check"] });

console.log(`${changed.length} changed file(s):`);
for (const path of changed) console.log(`  ${path}`);
for (const reason of reasons) console.log(`full suite: ${reason}`);
console.log("\nPlan:");
for (const step of steps) console.log(`  ${step.label}: ${step.command.length > 8 ? `${step.command.slice(0, 3).join(" ")} <${selected.size} files>` : step.command.join(" ")}`);
if (listOnly) {
  if (!fullSuite) for (const test of selected) console.log(`    ${test}`);
  process.exit(0);
}

const failed: string[] = [];
for (const step of steps) {
  console.log(`\n== ${step.label}`);
  const child = Bun.spawn(step.command, { cwd: root, stdout: "inherit", stderr: "inherit" });
  if (await child.exited !== 0) failed.push(step.label);
}
if (failed.length > 0) {
  console.error(`\nFailed: ${failed.join(", ")}`);
  process.exit(1);
}
console.log("\nAll affected checks passed.");
