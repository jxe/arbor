import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { classify, fileBase, legacyBase, LINK, resolveRelative, scanMarkdown, splitOnce, type LinkClass } from "./legacy.ts";

/** Read-only inventory of every link form in every ordinary tree the local
 * Arbor Sync places. Writes only a private receipt under
 * `~/.arbor/.state/migration/`. Usage: `bun audit.ts [endpoint]`. */

interface TreeDescriptor { id: string; kind: string; osPath: string; root: string; update: string; sync: string; conflicted: boolean }

const endpoint = process.argv[2] ?? "http://127.0.0.1:4317";
const trees = (await (await fetch(`${endpoint}/v1/trees`)).json() as { snapshot: TreeDescriptor[] }).snapshot
  .filter((tree) => tree.kind === "ordinary");

const report = trees.map((tree) => {
  const files = scanMarkdown(tree.osPath);
  const ids = new Set(files.flatMap((file) => file.id ? [file.id] : []));
  const nodes = new Set(files.map((file) => file.node));
  const parents = new Set(files.map((file) => file.node.split("/").slice(0, -1).join("/") || "/"));
  const counts: Partial<Record<LinkClass | "keyless-shifted" | "keyless-dangling", number>> = {};
  const notable: Array<{ file: string; href: string; class: string }> = [];
  for (const file of files) {
    for (const match of file.source.matchAll(LINK)) {
      const href = match[2]!;
      const kind = classify(href, tree.id, ids, match[1] === "!");
      counts[kind] = (counts[kind] ?? 0) + 1;
      if (kind === "bare-unowned" || kind === "node-shim" || kind === "arbor-cross-tree") notable.push({ file: file.file, href, class: kind });
      if (kind !== "keyless") continue;
      const path = splitOnce(splitOnce(href, "#")[0], "?")[0];
      const before = resolveRelative(legacyBase(file, parents.has(file.node)), path);
      const after = resolveRelative(fileBase(file), path);
      if (before !== after && before && nodes.has(before)) {
        counts["keyless-shifted"] = (counts["keyless-shifted"] ?? 0) + 1;
        notable.push({ file: file.file, href, class: "keyless-shifted" });
      } else if (!(before && nodes.has(before)) && !(after && nodes.has(after))) {
        counts["keyless-dangling"] = (counts["keyless-dangling"] ?? 0) + 1;
      }
    }
  }
  const digest = createHash("sha256");
  for (const file of files) digest.update(file.file).update("\0").update(file.source).update("\0");
  return {
    tree: tree.id, osPath: tree.osPath, root: tree.root, update: tree.update, sync: tree.sync, conflicted: tree.conflicted,
    markdownFiles: files.length, ids: ids.size, sourceDigest: `sha256:${digest.digest("hex")}`, counts, notable,
  };
});

const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
const directory = join(homedir(), ".arbor", ".state", "migration", `file-relative-links-audit-${stamp}`);
mkdirSync(directory, { recursive: true });
const receipt = { audited: new Date().toISOString(), endpoint, trees: report };
writeFileSync(join(directory, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify(receipt, null, 2));
console.error(`receipt: ${join(directory, "receipt.json")}`);
