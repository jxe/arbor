import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, posix } from "node:path";
import {
  buildMarkdownLink,
  encodeStableKey,
  markdownLinkDestinations,
  markdownStableKey,
  relativeFileReference,
  resolveLogicalURL,
  resolveNodeTarget,
  type MarkdownBodyOrigin,
} from "@overstory/protocol";
import { decodeLegacyKeyToken, fileBase, idFromKey, legacyBase, resolveRelative, scanMarkdown, splitOnce, type MarkdownFile } from "./legacy.ts";

/** Rewrite one placed tree's links to the 021 spellings. See README.md.
 *
 * `bun run.ts <placement> --tree <TreeID> [--expect counts.json] [--apply | --revert <receipt.json>] [--rehearsal]`
 *
 * Dry run by default. `--apply` requires the placement to be paused in the
 * local Arbor Sync (`arbor pause`), unless `--rehearsal` names a scratch copy
 * that is not placed. Every write re-checks the file's hash and is atomic.
 */

export type Rule =
  | "same-tree-row" | "alias-key" | "segment-key" | "bare-id" | "dangling-fragment-stripped"
  | "keyless-respelled" | "keyless-shifted" | "image-shifted";
export type Report =
  | "keyless-dangling" | "key-dangling" | "image-dangling" | "unchanged" | "external" | "cross-tree" | "content-fragment";

export interface Change { file: string; line: number; before: string; after: string; rule: Rule }
export interface Plan {
  root: string;
  tree: string;
  counts: Partial<Record<Rule | Report, number>>;
  changes: Change[];
  reports: Array<{ file: string; line: number; href: string; report: Report }>;
  files: Array<{ file: string; before: string; after: string; source: string; rewritten: string }>;
}

/** Fragments whose owner never existed; decision 5 strips them. */
const DANGLING_FRAGMENTS = new Set(["cxua95"]);

export class MigrationStop extends Error {}

interface Node { path: string; body: MarkdownBodyOrigin | null; id: string | null }

export function plan(root: string, tree: string): Plan {
  const files = scanMarkdown(root);
  const nodes = new Map<string, Node>();
  const owners = new Map<string, Node>();
  for (const file of files) {
    const shadowed = file.body === "sibling" && files.some((other) => other.body === "index" && other.node === file.node);
    if (shadowed) throw new MigrationStop(`${file.file} is shadowed by ${file.node}/_index.md`);
    const node = { path: file.node, body: file.body, id: file.id };
    nodes.set(file.node, node);
    if (!file.id) continue;
    if (owners.has(file.id)) throw new MigrationStop(`duplicate id ${file.id}: ${owners.get(file.id)!.path} and ${file.node}`);
    owners.set(file.id, node);
  }
  const nodeAt = (path: string): Node | null => {
    const known = nodes.get(path);
    if (known) return known;
    const full = join(root, ...path.split("/").filter(Boolean));
    return path !== "/" && existsSync(full) && statSync(full).isDirectory() ? { path, body: null, id: null } : null;
  };
  const hasChildren = (file: MarkdownFile) => file.body === "index" || existsSync(join(root, file.node.slice(1)));

  const result: Plan = { root, tree, counts: {}, changes: [], reports: [], files: [] };
  const count = (key: Rule | Report) => { result.counts[key] = (result.counts[key] ?? 0) + 1; };

  for (const file of files) {
    const writeFrom = fileBase(file);
    const oldBase = legacyBase(file, hasChildren(file));
    let rewritten = "";
    let copied = 0;
    for (const destination of markdownLinkDestinations(file.source)) {
      const line = file.source.slice(0, destination.start).split("\n").length;
      const report = (kind: Report) => { count(kind); result.reports.push({ file: file.file, line, href: destination.href, report: kind }); };
      const decision = decide(destination.href, destination.image);
      if (!decision) continue;
      if ("report" in decision) { report(decision.report); continue; }
      const verified = resolveNodeTarget(writeFrom, decision.href);
      if (!destination.image && (verified?.path !== decision.target.path || verified.stableKey !== decision.target.stableKey)) {
        throw new MigrationStop(`${file.file}:${line} ${destination.href} → ${decision.href} does not resolve back to ${decision.target.path}`);
      }
      if (decision.href === destination.href) { report("unchanged"); continue; }
      count(decision.rule);
      result.changes.push({ file: file.file, line, before: destination.href, after: decision.href, rule: decision.rule });
      rewritten += file.source.slice(copied, destination.start) + decision.href;
      copied = destination.end;
    }
    if (!copied) continue;
    rewritten += file.source.slice(copied);
    if (skeleton(rewritten) !== skeleton(file.source)) {
      throw new MigrationStop(`${file.file}: the rewrite changed something other than link destinations`);
    }
    result.files.push({ file: file.file, before: hash(file.source), after: hash(rewritten), source: file.source, rewritten });

    function decide(href: string, image: boolean):
      | { href: string; rule: Rule; target: { path: string; stableKey: string | null } }
      | { report: Report }
      | null {
      if (image) {
        const path = splitOnce(splitOnce(href, "#")[0], "?")[0];
        if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return { report: "external" };
        const now = resolveRelative(writeFrom, path);
        const then = resolveRelative(oldBase, path);
        const exists = (logical: string | null) => logical !== null && existsSync(join(root, ...logical.split("/").filter(Boolean)));
        if (exists(now)) return { report: "unchanged" };
        if (!exists(then)) return { report: "image-dangling" };
        return { href: relativeFileReference(writeFrom, then!), rule: "image-shifted", target: { path: then!, stableKey: null } };
      }
      const modern = href.replace(/arbor-key=(W1[A-Za-z0-9_-]+)/, (match, token: string) => {
        const key = decodeLegacyKeyToken(token);
        if (!key) throw new MigrationStop(`${file.file}: undecodable legacy key token in ${href}`);
        return `arbor-key=${encodeStableKey(key)}`;
      });
      if (href.startsWith("arbor://") && /\/node(\/|\?)/.test(href) && href.includes("stableKey=")) {
        throw new MigrationStop(`${file.file}: unexpected /node/?stableKey= link ${href}`);
      }
      // Links written against the old node base can climb above the root from the file's directory;
      // their key or id still names the target, so read them from the base they were written against.
      const resolved = resolveLogicalURL(writeFrom, modern) ?? resolveLogicalURL(oldBase, modern);
      if (!resolved) throw new MigrationStop(`${file.file}: ${href} resolves from neither ${writeFrom} nor ${oldBase}`);
      if (resolved.kind === "external" || resolved.kind === "system" || resolved.kind === "overlay") return { report: "external" };
      if (resolved.kind === "fragment") return { report: "content-fragment" };
      if (resolved.kind === "arbor" && (!("treeID" in resolved.authority) || resolved.authority.treeID !== tree)) {
        return modern === href ? { report: "cross-tree" } : { href: modern, rule: "segment-key", target: { path: resolved.path, stableKey: resolved.stableKey } };
      }
      const emit = (node: Node, rule: Rule, contentFragment: string | null) => {
        const stableKey = node.id ? markdownStableKey(node.id) : null;
        return {
          href: buildMarkdownLink(writeFrom, { path: node.path, body: node.body, stableKey, applicationQuery: resolved.applicationQuery, contentFragment, revision: resolved.revision }),
          rule,
          target: { path: node.path, stableKey },
        };
      };
      if (resolved.stableKey) {
        const id = idFromKey(resolved.stableKey);
        const owner = id ? owners.get(id) : undefined;
        if (!owner) return { report: "key-dangling" };
        const rule: Rule = resolved.kind === "arbor" ? "same-tree-row" : modern.includes("#arbor-key=") ? "alias-key" : "segment-key";
        return emit(owner, rule, resolved.contentFragment);
      }
      if (resolved.kind === "arbor") return { report: "cross-tree" };
      const fragment = resolved.contentFragment;
      if (fragment !== null) {
        const owner = owners.get(fragment);
        if (owner) return emit(owner, "bare-id", null);
        if (DANGLING_FRAGMENTS.has(fragment)) return { href: splitOnce(href, "#")[0], rule: "dangling-fragment-stripped", target: { path: resolved.path, stableKey: null } };
        throw new MigrationStop(`${file.file}: bare fragment #${fragment} names no owner and is not on the dangling list (${href})`);
      }
      const rawPath = splitOnce(modern, "?")[0];
      const now = nodeAt(resolved.path);
      const oldPath = resolveRelative(oldBase, rawPath);
      const then = oldPath ? nodeAt(oldPath) : null;
      if (now && then && now.path !== then.path) {
        throw new MigrationStop(`${file.file}: ${href} names ${now.path} from its file but ${then.path} from its node; decide by hand`);
      }
      if (now) return emit(now, "keyless-respelled", null);
      if (then) return emit(then, "keyless-shifted", null);
      return existsSync(join(root, ...resolved.path.split("/").filter(Boolean))) ? { report: "unchanged" } : { report: "keyless-dangling" };
    }
  }
  return result;
}

/** The source with every link destination blanked: equal skeletons differ only in hrefs. */
function skeleton(source: string): string {
  let result = "";
  let copied = 0;
  for (const destination of markdownLinkDestinations(source)) {
    result += `${source.slice(copied, destination.start)}\0`;
    copied = destination.end;
  }
  return result + source.slice(copied);
}

function hash(source: string): string {
  return `sha256:${createHash("sha256").update(source).digest("hex")}`;
}

function writeAtomically(path: string, contents: string): void {
  const temporary = join(dirname(path), `.${posix.basename(path)}.021-${process.pid}`);
  const handle = openSync(temporary, "w");
  try {
    writeSync(handle, contents);
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
  renameSync(temporary, path);
}

async function assertPaused(root: string, tree: string): Promise<void> {
  const trees = (await (await fetch("http://127.0.0.1:4317/v1/trees")).json() as { snapshot: Array<{ id: string; osPath: string; sync: string; conflicted: boolean }> }).snapshot;
  const placement = trees.find((candidate) => candidate.id === tree);
  if (!placement || placement.osPath !== root) throw new MigrationStop(`${tree} is not placed at ${root}`);
  if (placement.sync !== "paused" || placement.conflicted) throw new MigrationStop(`${tree} must be paused and not conflicted (sync: ${placement.sync})`);
}

export function apply(result: Plan): void {
  for (const file of result.files) {
    const path = join(result.root, file.file);
    if (hash(readFileSync(path, "utf8")) !== file.before) throw new MigrationStop(`${file.file} changed since it was read`);
  }
  for (const file of result.files) writeAtomically(join(result.root, file.file), file.rewritten);
}

export function revert(root: string, receipt: { files: Array<{ file: string; before: string; after: string }> }, sources: Map<string, string>): string[] {
  const reverted: string[] = [];
  for (const file of receipt.files) {
    const path = join(root, file.file);
    if (hash(readFileSync(path, "utf8")) !== file.after) continue;
    const original = sources.get(file.file);
    if (!original || hash(original) !== file.before) throw new MigrationStop(`no original bytes for ${file.file}`);
    writeAtomically(path, original);
    reverted.push(file.file);
  }
  return reverted;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const option = (name: string) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
  const root = args[0]!.replace(/\/$/, "");
  const tree = option("--tree");
  if (!root || !tree) throw new Error("usage: bun run.ts <placement> --tree <TreeID> [--expect counts.json] [--apply | --revert receipt.json] [--rehearsal]");
  const revertReceipt = option("--revert");
  if (revertReceipt) {
    if (!args.includes("--rehearsal")) await assertPaused(root, tree);
    const receipt = JSON.parse(readFileSync(revertReceipt, "utf8"));
    const originals = new Map<string, string>(Object.entries(JSON.parse(readFileSync(join(dirname(revertReceipt), "originals.json"), "utf8"))));
    console.log(JSON.stringify({ reverted: revert(root, receipt, originals) }, null, 2));
  } else {
    const result = plan(root, tree);
    const expectPath = option("--expect");
    if (expectPath) {
      const expected = JSON.parse(readFileSync(expectPath, "utf8"));
      if (JSON.stringify(sorted(expected)) !== JSON.stringify(sorted(result.counts))) {
        throw new MigrationStop(`counts differ from ${expectPath}: ${JSON.stringify(result.counts)}`);
      }
    }
    console.log(JSON.stringify({ counts: result.counts, files: result.files.length }, null, 2));
    for (const change of result.changes) console.log(`${change.rule.padEnd(26)} ${change.file}:${change.line}  ${change.before}  →  ${change.after}`);
    for (const item of result.reports.filter((entry) => entry.report.endsWith("dangling"))) console.log(`${item.report.padEnd(26)} ${item.file}:${item.line}  ${item.href}`);
    if (args.includes("--apply")) {
      if (!args.includes("--rehearsal")) await assertPaused(root, tree);
      const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
      const directory = join(homedir(), ".arbor", ".state", "migration", `file-relative-links-${args.includes("--rehearsal") ? "rehearsal-" : ""}${stamp}`);
      mkdirSync(directory, { recursive: true });
      const receipt = { root, tree, applied: new Date().toISOString(), counts: result.counts, changes: result.changes,
        files: result.files.map(({ file, before, after }) => ({ file, before, after })) };
      writeAtomically(join(directory, "originals.json"), JSON.stringify(Object.fromEntries(result.files.map((file) => [file.file, file.source]))));
      writeAtomically(join(directory, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
      apply(result);
      console.error(`applied ${result.files.length} files; receipt ${join(directory, "receipt.json")}`);
    }
  }
}

function sorted(value: Record<string, number>): Array<[string, number]> {
  return Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
}
