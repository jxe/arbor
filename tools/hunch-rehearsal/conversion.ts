import { chmod, lstat, mkdir, readFile, readdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, posix, relative, resolve } from "node:path";
import { promisify } from "node:util";

const DEFAULT_ASSET_ROOTS = ["Assets"];
const RESERVED_SOURCE_ROOTS = new Set(["Trash", ".history"]);
const PAGE_ID_PATTERN = /^[a-z0-9]{6}$/;
const RUN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const REPOSITORY_ROOT = resolve(import.meta.dir, "../..");
const execFileAsync = promisify(execFile);
let repositoryStatePromise: Promise<ConversionPlan["repositoryState"]> | undefined;

export type RecipePage =
  | { action: "keep"; pageID?: string }
  | { action: "discard"; reason: string }
  | { action: "review"; proposedPageID?: string };

export interface ConversionRecipe {
  version: 1;
  home: string;
  assetRoots?: string[];
  pages: Record<string, RecipePage>;
}

export interface InventoryPage {
  path: string;
  bytes: number;
  digest: string;
  clamshellID?: string;
  hasClamshellStamp: boolean;
  hasArborID: boolean;
  malformed: string[];
}

export interface SourceInventory {
  version: 1;
  source: string;
  sourceDigest: string;
  home?: string;
  pages: InventoryPage[];
  assetFiles: Array<{ path: string; bytes: number; digest: string }>;
  trashMarkdown: number;
  historyFiles: number;
  otherFiles: string[];
  symlinks: string[];
}

export interface PlannedEntry {
  sourcePath: string;
  destinationPath: string;
  kind: "page" | "asset";
  bytes: number;
  digest: string;
  pageID?: string;
}

export interface LinkWarning {
  sourcePath: string;
  destination: string;
  resolvedPath?: string;
  reason: "discarded-target" | "missing-target" | "fragmentless-home-link";
}

export interface ConversionPlan {
  version: 1;
  runId: string;
  source: string;
  destination: string;
  sourceDigest: string;
  recipeDigest: string;
  repositoryState: {
    revision: string;
    dirty: boolean;
    statusDigest: string;
    toolDigest: string;
  };
  knownGaps: string[];
  planDigest: string;
  homeSource: string;
  homeDestination: "_index.md";
  entries: PlannedEntry[];
  keptPages: number;
  discardedPages: number;
  assetFiles: number;
  preservedPageIDs: number;
  suppliedPageIDs: number;
  linkWarnings: LinkWarning[];
}

export interface RunManifest extends ConversionPlan {
  dryRuns: Array<{ confirmedAt: string; sourceDigest: string; planDigest: string }>;
  disposition: "active rehearsal" | "retained" | "retired";
  appliedAt?: string;
  sourceDigestAfter?: string;
  verifiedAt?: string;
}

interface TreeFile {
  path: string;
  absolutePath: string;
  bytes: Uint8Array;
  digest: string;
}

interface SourceTree {
  root: string;
  files: TreeFile[];
  symlinks: string[];
  digest: string;
}

interface MaterializedPlan {
  plan: ConversionPlan;
  files: Map<string, Uint8Array>;
}

interface ParsedEnvelope {
  clamshellID?: string;
  hasClamshellStamp: boolean;
  hasArborID: boolean;
  malformed: string[];
  transformed: Uint8Array;
  pageID: string;
}

export function expandUserPath(input: string): string {
  if (input === "~") return homedir();
  if (input.startsWith("~/")) return join(homedir(), input.slice(2));
  return input;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function compareUTF8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareUTF8(left, right))
      .map(([key, nested]) => [key, stableValue(nested)]));
  }
  return value;
}

function stableJSON(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function normalizedRelativePath(input: string, label = "path"): string {
  if (!input || input.includes("\0") || input.includes("\\") || input.startsWith("/")) {
    throw new Error(`Unsafe ${label}: ${JSON.stringify(input)}`);
  }
  const normalized = posix.normalize(input);
  if (normalized !== input || normalized === "." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new Error(`Unsafe ${label}: ${JSON.stringify(input)}`);
  }
  return normalized;
}

function underRoot(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

function firstComponent(path: string): string {
  return path.split("/")[0]!;
}

async function assertDirectory(path: string, label: string): Promise<void> {
  const info = await stat(path).catch(() => null);
  if (!info?.isDirectory()) throw new Error(`${label} is not a directory: ${path}`);
}

async function readSourceTree(sourceInput: string): Promise<SourceTree> {
  const supplied = resolve(expandUserPath(sourceInput));
  await assertDirectory(supplied, "Source");
  const root = await realpath(supplied);
  const files: TreeFile[] = [];
  const symlinks: string[] = [];

  const walk = async (directory: string, prefix = ""): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => compareUTF8(left.name, right.name));
    for (const entry of entries) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolutePath = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        symlinks.push(path);
        continue;
      }
      if (entry.isDirectory()) {
        await walk(absolutePath, path);
        continue;
      }
      if (!entry.isFile()) continue;
      const bytes = new Uint8Array(await readFile(absolutePath));
      files.push({ path, absolutePath, bytes, digest: sha256(bytes) });
    }
  };
  await walk(root);
  files.sort((left, right) => compareUTF8(left.path, right.path));
  symlinks.sort(compareUTF8);
  const digest = sha256(files.map((file) => `${file.path}\0${file.bytes.byteLength}\0${file.digest}\n`).join("")
    + symlinks.map((path) => `${path}\0symlink\n`).join(""));
  return { root, files, symlinks, digest };
}

function decodeUTF8(bytes: Uint8Array, path: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`Markdown is not valid UTF-8: ${path}`);
  }
}

interface SourceLine {
  text: string;
  eol: string;
  full: string;
}

function sourceLines(source: string): SourceLine[] {
  const matches = source.match(/.*(?:\r\n|\n|\r|$)/g) ?? [];
  return matches
    .filter((value, index) => value.length > 0 || index < matches.length - 1)
    .map((full) => {
      const eol = full.endsWith("\r\n") ? "\r\n" : full.endsWith("\n") ? "\n" : full.endsWith("\r") ? "\r" : "";
      return { full, eol, text: eol ? full.slice(0, -eol.length) : full };
    });
}

function topLevelValue(line: string, key: string): string | null {
  if (!line.startsWith(`${key}:`)) return null;
  return line.slice(key.length + 1).trim();
}

function hunchValue(line: string, key: string): string | null {
  const trimmed = line.trimStart();
  if (!trimmed.startsWith(`${key}:`)) return null;
  return trimmed.slice(key.length + 1).trim();
}

function unquoteScalar(value: string): string {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1);
  }
  return value;
}

function transformPage(bytes: Uint8Array, path: string, suppliedPageID?: string): ParsedEnvelope {
  const source = decodeUTF8(bytes, path);
  const lines = sourceLines(source);
  const newline = source.includes("\r\n") ? "\r\n" : source.includes("\r") ? "\r" : "\n";
  let opening = -1;
  let closing = -1;
  if (lines[0]?.text === "---") {
    opening = 0;
    for (let index = 1; index < lines.length; index += 1) {
      if (lines[index]!.text === "---") {
        closing = index;
        break;
      }
    }
    if (closing < 0) throw new Error(`Unclosed YAML frontmatter: ${path}`);
  }

  const frontmatter = opening === 0 ? lines.slice(1, closing) : [];
  const clamshellIDLines = frontmatter.filter((line) => hunchValue(line.text, "clamshell-id") !== null);
  const arborIDLines = frontmatter.filter((line) => topLevelValue(line.text, "id") !== null);
  const clamshellStampLines = frontmatter.filter((line) => hunchValue(line.text, "clamshell") !== null);
  const malformed: string[] = [];
  if (clamshellIDLines.length > 1) malformed.push("duplicate-clamshell-id");
  if (arborIDLines.length > 0) malformed.push("preexisting-arbor-id");
  if (clamshellIDLines.length === 1) {
    const raw = unquoteScalar(hunchValue(clamshellIDLines[0]!.text, "clamshell-id")!);
    if (!PAGE_ID_PATTERN.test(raw)) malformed.push("invalid-clamshell-id");
  }

  const clamshellID = clamshellIDLines.length === 1
    ? unquoteScalar(hunchValue(clamshellIDLines[0]!.text, "clamshell-id")!)
    : undefined;
  const validClamshellID = clamshellID && PAGE_ID_PATTERN.test(clamshellID) ? clamshellID : undefined;
  if (suppliedPageID !== undefined && !PAGE_ID_PATTERN.test(suppliedPageID)) {
    malformed.push("invalid-recipe-page-id");
  }
  if (validClamshellID && suppliedPageID && validClamshellID !== suppliedPageID) {
    malformed.push("recipe-page-id-mismatch");
  }
  const pageID = validClamshellID ?? suppliedPageID;
  if (!pageID) malformed.push("missing-page-id");
  if (malformed.length) {
    return {
      ...(validClamshellID ? { clamshellID: validClamshellID } : {}),
      hasClamshellStamp: clamshellStampLines.length > 0,
      hasArborID: arborIDLines.length > 0,
      malformed,
      transformed: bytes,
      pageID: pageID ?? "",
    };
  }
  if (!pageID) throw new Error(`Internal error: validated page has no PageID: ${path}`);

  let transformed: string;
  if (opening === 0) {
    const output: string[] = [lines[0]!.full];
    let insertedID = false;
    for (const line of frontmatter) {
      if (hunchValue(line.text, "clamshell") !== null) continue;
      if (hunchValue(line.text, "clamshell-id") !== null) {
        output.push(`id: ${pageID}${line.eol || newline}`);
        insertedID = true;
      } else {
        output.push(line.full);
      }
    }
    if (!insertedID) output.push(`id: ${pageID}${lines[closing]!.eol || newline}`);
    output.push(...lines.slice(closing).map((line) => line.full));
    transformed = output.join("");
  } else {
    transformed = `---${newline}id: ${pageID}${newline}---${newline}${source}`;
  }
  return {
    ...(validClamshellID ? { clamshellID: validClamshellID } : {}),
    hasClamshellStamp: clamshellStampLines.length > 0,
    hasArborID: false,
    malformed: [],
    transformed: new TextEncoder().encode(transformed),
    pageID,
  };
}

function metadataHome(file: TreeFile | undefined): string | undefined {
  if (!file) return undefined;
  try {
    const parsed = JSON.parse(decodeUTF8(file.bytes, file.path)) as { homeRelativePath?: unknown };
    return typeof parsed.homeRelativePath === "string" ? normalizedRelativePath(parsed.homeRelativePath, "Hunch Home path") : undefined;
  } catch (error) {
    throw new Error(`Invalid .clamshell.json: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function fileUnderAssetRoots(path: string, assetRoots: readonly string[]): boolean {
  return assetRoots.some((root) => underRoot(path, root));
}

function candidatePageFiles(tree: SourceTree, assetRoots: readonly string[]): TreeFile[] {
  return tree.files.filter((file) =>
    file.path.toLowerCase().endsWith(".md")
    && !RESERVED_SOURCE_ROOTS.has(firstComponent(file.path))
    && !fileUnderAssetRoots(file.path, assetRoots)
  );
}

export async function inventorySource(sourceInput: string, assetRootsInput: readonly string[] = DEFAULT_ASSET_ROOTS): Promise<SourceInventory> {
  const assetRoots = assetRootsInput.map((path) => normalizedRelativePath(path, "asset root"));
  const tree = await readSourceTree(sourceInput);
  const pages = candidatePageFiles(tree, assetRoots).map((file): InventoryPage => {
    const parsed = transformPage(file.bytes, file.path);
    return {
      path: file.path,
      bytes: file.bytes.byteLength,
      digest: file.digest,
      ...(parsed.clamshellID ? { clamshellID: parsed.clamshellID } : {}),
      hasClamshellStamp: parsed.hasClamshellStamp,
      hasArborID: parsed.hasArborID,
      malformed: parsed.malformed.filter((item) => item !== "missing-page-id"),
    };
  });
  const pagePaths = new Set(pages.map((page) => page.path));
  const assetFiles = tree.files.filter((file) => fileUnderAssetRoots(file.path, assetRoots))
    .map((file) => ({ path: file.path, bytes: file.bytes.byteLength, digest: file.digest }));
  const assetPaths = new Set(assetFiles.map((file) => file.path));
  const ignored = new Set([".clamshell.json"]);
  const otherFiles = tree.files
    .filter((file) => !pagePaths.has(file.path) && !assetPaths.has(file.path)
      && !underRoot(file.path, "Trash") && !underRoot(file.path, ".history") && !ignored.has(file.path))
    .map((file) => file.path);
  return {
    version: 1,
    source: tree.root,
    sourceDigest: tree.digest,
    ...(metadataHome(tree.files.find((file) => file.path === ".clamshell.json")) ? {
      home: metadataHome(tree.files.find((file) => file.path === ".clamshell.json")),
    } : {}),
    pages,
    assetFiles,
    trashMarkdown: tree.files.filter((file) => underRoot(file.path, "Trash") && file.path.toLowerCase().endsWith(".md")).length,
    historyFiles: tree.files.filter((file) => underRoot(file.path, ".history")).length,
    otherFiles,
    symlinks: tree.symlinks,
  };
}

function validateRecipe(value: unknown): ConversionRecipe {
  if (!value || typeof value !== "object") throw new Error("Recipe must be a JSON object");
  const candidate = value as Partial<ConversionRecipe>;
  if (candidate.version !== 1 || typeof candidate.home !== "string" || !candidate.pages || typeof candidate.pages !== "object") {
    throw new Error("Recipe must contain version: 1, home, and pages");
  }
  const home = normalizedRelativePath(candidate.home, "recipe Home");
  if (home.includes("/")) {
    throw new Error("Nested Hunch Home pages are not supported because moving one to root would change relative-link bases");
  }
  const pages: Record<string, RecipePage> = {};
  for (const [rawPath, rawAction] of Object.entries(candidate.pages)) {
    const path = normalizedRelativePath(rawPath, "recipe page path");
    if (!path.toLowerCase().endsWith(".md")) throw new Error(`Recipe page is not Markdown: ${path}`);
    if (!rawAction || typeof rawAction !== "object" || !("action" in rawAction)) throw new Error(`Invalid recipe action: ${path}`);
    const action = rawAction as RecipePage;
    if (action.action === "keep") {
      if (action.pageID !== undefined && !PAGE_ID_PATTERN.test(action.pageID)) throw new Error(`Invalid recipe PageID for ${path}`);
      pages[path] = action.pageID ? { action: "keep", pageID: action.pageID } : { action: "keep" };
    } else if (action.action === "discard") {
      if (!action.reason?.trim()) throw new Error(`Discard action needs a reason: ${path}`);
      pages[path] = { action: "discard", reason: action.reason };
    } else if (action.action === "review") {
      throw new Error(`Recipe still needs review: ${path}`);
    } else {
      throw new Error(`Unknown recipe action: ${path}`);
    }
  }
  const assetRoots = (candidate.assetRoots ?? DEFAULT_ASSET_ROOTS).map((path) => normalizedRelativePath(path, "asset root"));
  if (new Set(assetRoots).size !== assetRoots.length) throw new Error("Recipe has duplicate asset roots");
  return { version: 1, home, pages, assetRoots };
}

export async function readRecipe(recipeInput: string): Promise<{ recipe: ConversionRecipe; path: string; digest: string }> {
  const path = await realpath(resolve(expandUserPath(recipeInput)));
  const bytes = new Uint8Array(await readFile(path));
  const parsed = validateRecipe(JSON.parse(decodeUTF8(bytes, path)));
  return { recipe: parsed, path, digest: sha256(bytes) };
}

function resolveLinkPath(sourcePath: string, destination: string): { path?: string; fragment?: string } {
  if (/^[a-z][a-z0-9+.-]*:/i.test(destination) || destination.startsWith("#") || destination.startsWith("/")) return {};
  const hash = destination.lastIndexOf("#");
  const rawPath = hash >= 0 ? destination.slice(0, hash) : destination;
  const fragment = hash >= 0 ? destination.slice(hash + 1) : undefined;
  let decoded: string;
  try { decoded = decodeURIComponent(rawPath); } catch { return {}; }
  const joined = posix.normalize(posix.join(posix.dirname(sourcePath), decoded));
  if (joined.startsWith("../") || joined === "..") return {};
  return { path: joined, ...(fragment ? { fragment } : {}) };
}

function linkWarningsFor(sourceFiles: Map<string, TreeFile>, recipe: ConversionRecipe): LinkWarning[] {
  const warnings: LinkWarning[] = [];
  const linkPattern = /(?<!!)\[[^\]\r\n]*\]\(([^)\s]+)\)/g;
  for (const [sourcePath, file] of sourceFiles) {
    const source = decodeUTF8(file.bytes, sourcePath);
    for (const match of source.matchAll(linkPattern)) {
      const destination = match[1]!;
      const resolved = resolveLinkPath(sourcePath, destination);
      if (!resolved.path?.toLowerCase().endsWith(".md")) continue;
      const target = recipe.pages[resolved.path];
      if (!target) warnings.push({ sourcePath, destination, resolvedPath: resolved.path, reason: "missing-target" });
      else if (target.action === "discard") warnings.push({ sourcePath, destination, resolvedPath: resolved.path, reason: "discarded-target" });
      else if (resolved.path === recipe.home && (!resolved.fragment || !PAGE_ID_PATTERN.test(resolved.fragment))) {
        warnings.push({ sourcePath, destination, resolvedPath: resolved.path, reason: "fragmentless-home-link" });
      }
    }
  }
  return warnings.sort((left, right) => compareUTF8(
    `${left.sourcePath}\0${left.destination}\0${left.reason}`,
    `${right.sourcePath}\0${right.destination}\0${right.reason}`,
  ));
}

function publicPlanDigest(plan: Omit<ConversionPlan, "planDigest">): string {
  return sha256(stableJSON(plan));
}

async function repositoryState(): Promise<ConversionPlan["repositoryState"]> {
  repositoryStatePromise ??= (async () => {
    const [revisionResult, statusResult, conversionBytes, cliBytes] = await Promise.all([
      execFileAsync("git", ["rev-parse", "HEAD"], { cwd: REPOSITORY_ROOT, encoding: "utf8" })
        .catch(() => ({ stdout: "unknown\n" })),
      execFileAsync("git", ["status", "--porcelain=v1"], { cwd: REPOSITORY_ROOT, encoding: "utf8" })
        .catch(() => ({ stdout: "unavailable\n" })),
      readFile(join(import.meta.dir, "conversion.ts")),
      readFile(join(import.meta.dir, "cli.ts")),
    ]);
    const status = statusResult.stdout;
    return {
      revision: revisionResult.stdout.trim() || "unknown",
      dirty: status.trim().length > 0,
      statusDigest: sha256(status),
      toolDigest: sha256(Buffer.concat([conversionBytes, Buffer.from([0]), cliBytes])),
    };
  })();
  return repositoryStatePromise;
}

export async function buildPlan(options: {
  source: string;
  recipePath: string;
  destination: string;
  runId: string;
  knownGaps?: readonly string[];
}): Promise<MaterializedPlan> {
  if (!RUN_ID_PATTERN.test(options.runId)) throw new Error(`Invalid run ID: ${options.runId}`);
  const destination = resolve(expandUserPath(options.destination));
  const tree = await readSourceTree(options.source);
  const { recipe, digest: recipeDigest } = await readRecipe(options.recipePath);
  const repoState = await repositoryState();
  const knownGaps = [...new Set((options.knownGaps ?? []).map((gap) => gap.trim()).filter(Boolean))].sort(compareUTF8);
  const assetRoots = recipe.assetRoots ?? DEFAULT_ASSET_ROOTS;
  if (tree.symlinks.length) throw new Error(`Source contains unsupported symlinks: ${tree.symlinks.join(", ")}`);
  const sourceRemainder = relative(tree.root, destination);
  const destinationRemainder = relative(destination, tree.root);
  if (!sourceRemainder.startsWith("..") || !destinationRemainder.startsWith("..")) {
    throw new Error("Source and destination must not contain one another");
  }

  const sourcePages = candidatePageFiles(tree, assetRoots);
  const sourcePageMap = new Map(sourcePages.map((file) => [file.path, file]));
  const sourcePaths = new Set(sourcePageMap.keys());
  const recipePaths = new Set(Object.keys(recipe.pages));
  const unknown = [...sourcePaths].filter((path) => !recipePaths.has(path)).sort(compareUTF8);
  const missing = [...recipePaths].filter((path) => !sourcePaths.has(path)).sort(compareUTF8);
  if (unknown.length || missing.length) {
    throw new Error([
      unknown.length ? `Source pages need recipe decisions: ${unknown.join(", ")}` : "",
      missing.length ? `Recipe pages are absent from source: ${missing.join(", ")}` : "",
    ].filter(Boolean).join("; "));
  }
  const homeAction = recipe.pages[recipe.home];
  if (homeAction?.action !== "keep") throw new Error("Recipe Home must be a kept page");
  const sourceHome = metadataHome(tree.files.find((file) => file.path === ".clamshell.json"));
  if (sourceHome && sourceHome !== recipe.home) {
    throw new Error(`Recipe Home ${recipe.home} does not match .clamshell.json Home ${sourceHome}`);
  }

  const files = new Map<string, Uint8Array>();
  const entries: PlannedEntry[] = [];
  const pageIDs = new Map<string, string>();
  let keptPages = 0;
  let discardedPages = 0;
  let preservedPageIDs = 0;
  let suppliedPageIDs = 0;

  for (const sourcePath of [...recipePaths].sort(compareUTF8)) {
    const action = recipe.pages[sourcePath]!;
    if (action.action === "discard") {
      discardedPages += 1;
      continue;
    }
    if (action.action !== "keep") throw new Error(`Recipe still needs review: ${sourcePath}`);
    const sourceFile = sourcePageMap.get(sourcePath)!;
    const envelope = transformPage(sourceFile.bytes, sourcePath, action.pageID);
    if (envelope.malformed.length) throw new Error(`Cannot convert ${sourcePath}: ${envelope.malformed.join(", ")}`);
    const priorOwner = pageIDs.get(envelope.pageID);
    if (priorOwner) throw new Error(`Duplicate PageID ${envelope.pageID}: ${priorOwner}, ${sourcePath}`);
    pageIDs.set(envelope.pageID, sourcePath);
    if (envelope.clamshellID) preservedPageIDs += 1;
    else suppliedPageIDs += 1;
    const destinationPath = sourcePath === recipe.home ? "_index.md" : sourcePath;
    normalizedRelativePath(destinationPath, "destination path");
    if (files.has(destinationPath)) throw new Error(`Several inputs target ${destinationPath}`);
    files.set(destinationPath, envelope.transformed);
    entries.push({
      sourcePath,
      destinationPath,
      kind: "page",
      bytes: envelope.transformed.byteLength,
      digest: sha256(envelope.transformed),
      pageID: envelope.pageID,
    });
    keptPages += 1;
  }

  const assets = tree.files.filter((file) => fileUnderAssetRoots(file.path, assetRoots));
  for (const asset of assets) {
    if (files.has(asset.path)) throw new Error(`Asset collides with converted page: ${asset.path}`);
    files.set(asset.path, asset.bytes);
    entries.push({
      sourcePath: asset.path,
      destinationPath: asset.path,
      kind: "asset",
      bytes: asset.bytes.byteLength,
      digest: asset.digest,
    });
  }
  entries.sort((left, right) => compareUTF8(left.destinationPath, right.destinationPath));
  const withoutDigest: Omit<ConversionPlan, "planDigest"> = {
    version: 1,
    runId: options.runId,
    source: tree.root,
    destination,
    sourceDigest: tree.digest,
    recipeDigest,
    repositoryState: repoState,
    knownGaps,
    homeSource: recipe.home,
    homeDestination: "_index.md",
    entries,
    keptPages,
    discardedPages,
    assetFiles: assets.length,
    preservedPageIDs,
    suppliedPageIDs,
    linkWarnings: linkWarningsFor(new Map(
      [...sourcePageMap].filter(([path]) => recipe.pages[path]?.action === "keep")
    ), recipe),
  };
  const plan: ConversionPlan = { ...withoutDigest, planDigest: publicPlanDigest(withoutDigest) };
  return { plan, files };
}

function manifestComparable(manifest: RunManifest): ConversionPlan {
  const {
    dryRuns: _dryRuns,
    disposition: _disposition,
    appliedAt: _appliedAt,
    sourceDigestAfter: _sourceDigestAfter,
    verifiedAt: _verifiedAt,
    ...plan
  } = manifest;
  return plan;
}

function assertPlanMatches(manifest: RunManifest, plan: ConversionPlan): void {
  if (stableJSON(manifestComparable(manifest)) !== stableJSON(plan)) {
    throw new Error("Current conversion plan does not match the recorded manifest; create a new run instead of overwriting it");
  }
}

async function writePrivateJSON(pathInput: string, value: unknown): Promise<string> {
  const path = resolve(expandUserPath(pathInput));
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await rename(temporary, path);
  await chmod(path, 0o600);
  return path;
}

export async function readManifest(pathInput: string): Promise<{ path: string; manifest: RunManifest }> {
  const path = await realpath(resolve(expandUserPath(pathInput)));
  const value = JSON.parse(await readFile(path, "utf8")) as RunManifest;
  if (
    value.version !== 1
    || !RUN_ID_PATTERN.test(value.runId)
    || !Array.isArray(value.dryRuns)
    || !Array.isArray(value.knownGaps)
    || !value.repositoryState
    || typeof value.repositoryState.revision !== "string"
    || typeof value.repositoryState.toolDigest !== "string"
    || !["active rehearsal", "retained", "retired"].includes(value.disposition)
  ) {
    throw new Error(`Invalid rehearsal manifest: ${path}`);
  }
  return { path, manifest: value };
}

export async function recordDryRun(options: {
  source: string;
  recipePath: string;
  destination: string;
  runId: string;
  manifestPath: string;
  knownGaps?: readonly string[];
  now?: string;
}): Promise<RunManifest> {
  const materialized = await buildPlan(options);
  const confirmation = {
    confirmedAt: options.now ?? new Date().toISOString(),
    sourceDigest: materialized.plan.sourceDigest,
    planDigest: materialized.plan.planDigest,
  };
  const manifestPath = resolve(expandUserPath(options.manifestPath));
  const existing = await lstat(manifestPath).catch(() => null);
  let manifest: RunManifest;
  if (existing) {
    if (!existing.isFile()) throw new Error(`Manifest is not a file: ${manifestPath}`);
    const current = (await readManifest(manifestPath)).manifest;
    if (current.appliedAt) throw new Error("Run has already been applied; use a new run ID and destination");
    assertPlanMatches(current, materialized.plan);
    manifest = { ...current, dryRuns: [...current.dryRuns, confirmation] };
  } else {
    manifest = { ...materialized.plan, dryRuns: [confirmation], disposition: "active rehearsal" };
  }
  await writePrivateJSON(manifestPath, manifest);
  return manifest;
}

async function writePlannedFiles(root: string, files: ReadonlyMap<string, Uint8Array>): Promise<void> {
  await mkdir(root, { mode: 0o700 });
  for (const [path, bytes] of [...files].sort(([left], [right]) => compareUTF8(left, right))) {
    const destination = join(root, ...path.split("/"));
    await mkdir(dirname(destination), { recursive: true, mode: 0o755 });
    await writeFile(destination, bytes, { mode: 0o644, flag: "wx" });
  }
}

async function destinationFiles(root: string): Promise<Map<string, { digest: string; bytes: number }>> {
  const found = new Map<string, { digest: string; bytes: number }>();
  const walk = async (directory: string, prefix = ""): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Converted tree contains a symlink: ${path}`);
      if (entry.isDirectory()) await walk(absolute, path);
      else if (entry.isFile()) {
        const bytes = new Uint8Array(await readFile(absolute));
        found.set(path, { digest: sha256(bytes), bytes: bytes.byteLength });
      }
    }
  };
  await walk(root);
  return found;
}

export async function verifyDestination(destinationInput: string, entries: readonly PlannedEntry[]): Promise<void> {
  const destination = resolve(expandUserPath(destinationInput));
  await assertDirectory(destination, "Destination");
  const actual = await destinationFiles(destination);
  const expected = new Map(entries.map((entry) => [entry.destinationPath, entry]));
  const missing = [...expected.keys()].filter((path) => !actual.has(path)).sort(compareUTF8);
  const extra = [...actual.keys()].filter((path) => !expected.has(path)).sort(compareUTF8);
  const changed = [...expected].filter(([path, entry]) => {
    const value = actual.get(path);
    return value && (value.digest !== entry.digest || value.bytes !== entry.bytes);
  }).map(([path]) => path).sort(compareUTF8);
  if (missing.length || extra.length || changed.length) {
    throw new Error([
      missing.length ? `Missing output files: ${missing.join(", ")}` : "",
      extra.length ? `Unexpected output files: ${extra.join(", ")}` : "",
      changed.length ? `Changed output files: ${changed.join(", ")}` : "",
    ].filter(Boolean).join("; "));
  }
}

export async function applyRun(options: {
  source: string;
  recipePath: string;
  destination: string;
  runId: string;
  manifestPath: string;
  now?: string;
}): Promise<RunManifest> {
  const { path: manifestPath, manifest } = await readManifest(options.manifestPath);
  if (manifest.runId !== options.runId) throw new Error("Run ID does not match manifest");
  if (manifest.appliedAt) throw new Error("Run has already been applied");
  if (manifest.dryRuns.length < 2) throw new Error("Apply requires two matching dry-run confirmations");
  const materialized = await buildPlan({ ...options, knownGaps: manifest.knownGaps });
  assertPlanMatches(manifest, materialized.plan);
  const destination = materialized.plan.destination;
  const parent = dirname(destination);
  await assertDirectory(parent, "Destination parent");
  if (await lstat(destination).catch(() => null)) throw new Error(`Destination already exists: ${destination}`);
  const staging = `${destination}.arbor-rehearsal-${options.runId}.incomplete`;
  if (await lstat(staging).catch(() => null)) throw new Error(`Incomplete staging destination already exists: ${staging}`);
  await writePlannedFiles(staging, materialized.files);
  await verifyDestination(staging, materialized.plan.entries);
  const after = await readSourceTree(options.source);
  if (after.digest !== materialized.plan.sourceDigest) {
    throw new Error(`Source changed during apply; incomplete output remains at ${staging}`);
  }
  await rename(staging, destination);
  const now = options.now ?? new Date().toISOString();
  const updated: RunManifest = {
    ...manifest,
    appliedAt: now,
    sourceDigestAfter: after.digest,
    verifiedAt: now,
  };
  await writePrivateJSON(manifestPath, updated);
  return updated;
}

export async function verifyRun(options: {
  manifestPath: string;
  destination?: string;
  now?: string;
}): Promise<RunManifest> {
  const { path, manifest } = await readManifest(options.manifestPath);
  if (!manifest.appliedAt) throw new Error("Run has not been applied");
  const destination = options.destination ? resolve(expandUserPath(options.destination)) : manifest.destination;
  if (destination !== manifest.destination) throw new Error("Destination does not match manifest");
  await verifyDestination(destination, manifest.entries);
  const updated = { ...manifest, verifiedAt: options.now ?? new Date().toISOString() };
  await writePrivateJSON(path, updated);
  return updated;
}

function mintPageID(existing: Set<string>): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  for (;;) {
    const bytes = randomBytes(6);
    let value = "";
    for (const byte of bytes) value += alphabet[byte % alphabet.length]!;
    if (!existing.has(value)) return value;
  }
}

export async function draftRecipe(sourceInput: string, outputPath: string): Promise<ConversionRecipe> {
  const resolvedOutput = resolve(expandUserPath(outputPath));
  if (await lstat(resolvedOutput).catch(() => null)) {
    throw new Error(`Draft recipe already exists; refusing to remint PageIDs: ${resolvedOutput}`);
  }
  const inventory = await inventorySource(sourceInput);
  const existing = new Set(inventory.pages.flatMap((page) => page.clamshellID ? [page.clamshellID] : []));
  const pages: Record<string, RecipePage> = {};
  for (const page of inventory.pages) {
    if (page.clamshellID) pages[page.path] = { action: "review" };
    else {
      const proposedPageID = mintPageID(existing);
      existing.add(proposedPageID);
      pages[page.path] = { action: "review", proposedPageID };
    }
  }
  const recipe: ConversionRecipe = {
    version: 1,
    home: inventory.home ?? "",
    assetRoots: [...DEFAULT_ASSET_ROOTS],
    pages,
  };
  await writePrivateJSON(resolvedOutput, recipe);
  return recipe;
}
