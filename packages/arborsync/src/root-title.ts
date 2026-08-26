import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseMarkdown } from "@arbor/editor";

/** The first non-empty H1 in a root `_index.md`, or its directory basename. */
export async function rootDisplayName(root: string): Promise<string> {
  try {
    const document = parseMarkdown(await readFile(join(root, "_index.md"), "utf8"));
    const heading = document.blocks.find((block) =>
      block.type === "heading"
      && block.props?.level === 1
      && Boolean(block.content?.trim())
    );
    if (heading?.content?.trim()) return heading.content.trim();
  } catch {}
  return basename(root);
}
