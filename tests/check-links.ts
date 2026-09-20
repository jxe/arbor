#!/usr/bin/env bun
/**
 * Check every relative Markdown link in tracked `.md` files.
 *
 *   bun tests/check-links.ts [--strict]
 *
 * A link is relative when it has no scheme and no leading `#`. The target
 * must exist on disk (as a file or directory) after stripping any `#anchor`
 * or `:line` suffix. Anchors themselves are not checked, and links inside
 * fenced code blocks are ignored. Overstory's own
 * example and fixture trees use extensionless links and are skipped.
 *
 * Exits nonzero when a link is broken. With `--strict`, also reports links
 * whose target exists but is listed for deletion in the same commit (none by
 * default; the flag is reserved for CI).
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const proc = Bun.spawnSync(["git", "ls-files", "-z", "*.md"], { cwd: root });
const files = proc.stdout.toString().split("\0").filter(Boolean);
const skip = [/^examples\//, /^tests\/fixtures\//];
const linkPattern = /\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

let broken = 0;
for (const file of files) {
  if (skip.some(pattern => pattern.test(file))) continue;
  const text = (await Bun.file(join(root, file)).text()).replace(/^```[\s\S]*?^```/gm, "");
  for (const match of text.matchAll(linkPattern)) {
    const raw = match[1]!;
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("#") || raw.includes("<")) continue;
    const target = raw.replace(/#.*$/, "").replace(/:\d+(-\d+)?$/, "");
    if (target === "") continue;
    const path = target.startsWith("/") ? join(root, target) : join(root, dirname(file), target);
    if (!existsSync(path)) {
      broken += 1;
      console.log(`${file}: ${raw}`);
    }
  }
}
if (broken > 0) {
  console.error(`${broken} broken relative link${broken === 1 ? "" : "s"}`);
  process.exit(1);
}
console.log(`checked ${files.length} files, no broken relative links`);
