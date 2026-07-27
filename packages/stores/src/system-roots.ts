import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Diagnostic } from "@arbor/core";
import { parseMarkdown } from "@arbor/editor";
import { arborDataRoot } from "./private-state.ts";

/**
 * A tracked-root record: the minimal `system:roots` pull-forward. One
 * human-readable Markdown file per tracked root under the private Arbor
 * system directory — placement policy for this device, never identity
 * ([spec/system.md](../../../spec/system.md) §1).
 */
export interface SystemRootRecord {
  id: string;
  path: string;
  added: string;
  name: string;
  /** The record's stored Markdown, for the read-only system: page. */
  source: string;
}

export function systemRootsDirectory(): string {
  return join(arborDataRoot(), "system", "roots");
}

export async function loadSystemRoots(): Promise<{ records: SystemRootRecord[]; diagnostics: Diagnostic[] }> {
  const directory = systemRootsDirectory();
  const records: SystemRootRecord[] = [];
  const diagnostics: Diagnostic[] = [];
  let names: string[] = [];
  try {
    names = (await readdir(directory)).filter((name) => name.endsWith(".md")).sort();
  } catch {
    return { records, diagnostics };
  }
  for (const filename of names) {
    try {
      const source = await readFile(join(directory, filename), "utf8");
      const document = parseMarkdown(source);
      const id = document.frontmatter.id;
      const path = document.frontmatter.path;
      const added = document.frontmatter.added;
      if (typeof id !== "string" || !id.startsWith("rt_") || typeof path !== "string" || !path.startsWith("/")) {
        throw new Error("A root record requires an rt_ id and an absolute path");
      }
      const heading = document.blocks.find((block) => block.type === "heading")?.content;
      records.push({
        id,
        path,
        added: typeof added === "string" ? added : String(added ?? ""),
        name: heading?.trim() || basename(path),
        source,
      });
    } catch (error) {
      // Invalid records are surfaced, skipped, and never deleted: the last
      // valid configuration stays active.
      diagnostics.push({
        code: "invalid-root-record",
        message: `system:roots/${filename} is invalid: ${error instanceof Error ? error.message : String(error)}`,
        path: join(directory, filename),
        severity: "warning",
      });
    }
  }
  return { records, diagnostics };
}

export async function saveSystemRoot(record: { id: string; path: string; added: string; name: string }): Promise<SystemRootRecord> {
  const directory = systemRootsDirectory();
  await mkdir(directory, { recursive: true });
  const source = [
    "---",
    `id: ${record.id}`,
    `path: ${record.path}`,
    `added: ${record.added}`,
    "---",
    "",
    `# ${record.name}`,
    "",
  ].join("\n");
  await writeFile(join(directory, `${record.id}.md`), source, { mode: 0o600 });
  return { ...record, source };
}

export async function deleteSystemRoot(id: string): Promise<void> {
  await rm(join(systemRootsDirectory(), `${id}.md`), { force: true });
}
