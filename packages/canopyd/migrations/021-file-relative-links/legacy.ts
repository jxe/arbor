import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix, relative, sep } from "node:path";

/** Everything this migration knows about the pre-021 link spellings. Product
 * code no longer reads any of it, so it lives here and is deleted with the
 * directory. */

/** Same pattern as the product's `markdownLinkDestinations`; group 1 is `!` for images. */
export const LINK = /(!?)\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

export interface MarkdownFile {
  /** Placement-relative POSIX path, e.g. `Picture-of-Life.md` or `Amends/_index.md`. */
  file: string;
  /** Logical node path, e.g. `/Picture-of-Life`. */
  node: string;
  body: "sibling" | "index";
  id: string | null;
  source: string;
}

const SKIP = new Set([".arbor", ".state", ".git", "node_modules"]);

export function scanMarkdown(root: string): MarkdownFile[] {
  const files: MarkdownFile[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (name.startsWith(".") || SKIP.has(name)) continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      if (!name.endsWith(".md")) continue;
      const file = relative(root, full).split(sep).join("/");
      const index = name === "_index.md";
      const node = index ? "/" + posix.dirname(file).replace(/^\.$/, "") : "/" + file.slice(0, -3);
      const source = readFileSync(full, "utf8");
      files.push({ file, node: node === "/" ? "/" : node.replace(/\/$/, ""), body: index ? "index" : "sibling", id: frontmatterID(source), source });
    }
  };
  walk(root);
  return files;
}

export function frontmatterID(source: string): string | null {
  const text = source.replace(/^﻿/, "");
  if (!text.startsWith("---")) return null;
  const end = text.indexOf("\n---", 3);
  if (end < 0) return null;
  const match = text.slice(3, end).match(/^id:\s*["']?([^"'\s]+)["']?\s*$/m);
  return match?.[1] ?? null;
}

/** Old base64url key token → canonical key JSON, or null. */
export function decodeLegacyKeyToken(token: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(token)) return null;
  try {
    const json = Buffer.from(token, "base64url").toString("utf8");
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed) || JSON.stringify(parsed) !== json) return null;
    if (Buffer.from(json).toString("base64url") !== token) return null;
    return json;
  } catch {
    return null;
  }
}

export function idFromKey(key: string): string | null {
  const parsed = JSON.parse(key) as unknown[][];
  return parsed.length === 1 && parsed[0]![0] === "id" && typeof parsed[0]![1] === "string" ? parsed[0]![1] as string : null;
}

/** Pre-021 Swift link base: a directory node resolves against itself, anything else against its parent. */
export function legacyBase(file: MarkdownFile, hasChildren: boolean): string {
  return hasChildren || file.body === "index" ? file.node : posix.dirname(file.node);
}

/** File-relative base: the directory holding the source file. */
export function fileBase(file: MarkdownFile): string {
  return file.body === "index" ? file.node : posix.dirname(file.node);
}

/** Resolve a relative path (no query/fragment/parameters) the way both old and new code do. */
export function resolveRelative(base: string, raw: string): string | null {
  const parts = raw.startsWith("/") ? [] : base.split("/").filter(Boolean);
  for (const segment of raw.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") { if (!parts.length) return null; parts.pop(); continue; }
    let decoded: string;
    try { decoded = decodeURIComponent(segment); } catch { return null; }
    parts.push(decoded);
  }
  let path = "/" + parts.join("/");
  if (path.endsWith("/_index.md")) path = path.slice(0, -"/_index.md".length) || "/";
  else if (path.endsWith(".md")) path = path.slice(0, -3);
  return path;
}

export type LinkClass =
  | "external" | "arbor-same-tree" | "arbor-cross-tree" | "node-shim" | "alias-key" | "segment-key"
  | "bare-owned-id" | "bare-unowned" | "keyless" | "image" | "other";

export function classify(href: string, tree: string, ids: Set<string>, image: boolean): LinkClass {
  if (image) return "image";
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith("arbor:")) return "external";
  if (href.startsWith("arbor://")) {
    if (href.includes("/node/") && href.includes("stableKey=")) return "node-shim";
    return href.startsWith(`arbor://${tree}/`) || href === `arbor://${tree}` ? "arbor-same-tree" : "arbor-cross-tree";
  }
  const [path, fragment] = splitOnce(href, "#");
  if (fragment?.startsWith("arbor-key=")) return "alias-key";
  if (path.includes(";arbor-key=")) return "segment-key";
  if (fragment !== null && fragment !== "") return ids.has(fragment) ? "bare-owned-id" : "bare-unowned";
  return path ? "keyless" : "other";
}

export function splitOnce(value: string, separator: string): [string, string | null] {
  const at = value.indexOf(separator);
  return at < 0 ? [value, null] : [value.slice(0, at), value.slice(at + 1)];
}
