import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

async function sourceFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(path));
    else if (entry.name.endsWith(".ts")) files.push(path);
  }
  return files;
}

describe("@arbor/wire package boundary", () => {
  test("does not acquire server implementation dependencies", async () => {
    const root = join(import.meta.dir, "../../../packages/wire/src");
    for (const path of await sourceFiles(root)) {
      const source = await readFile(path, "utf8");
      expect(source).not.toContain("@arbor/authority");
      expect(source).not.toContain("bun:sqlite");
      expect(source).not.toContain("@arbor/editor");
    }
  });
});
