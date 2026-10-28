import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { materializeTree, resolveSnapshot, snapshotDirectory } from "@ovst/fs";
import { deriveRowOperations } from "@ovst/collection-schema";
import {
  decodeProtocolDirectory,
  decodeProtocolPage,
  encodeProtocolDirectory,
  encodeProtocolPage,
  hashObject,
  treeHoldsPages,
  type ObjectHash,
} from "@ovst/protocol";

const encoder = new TextEncoder(), decoder = new TextDecoder();

async function folder(files: Record<string, string>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "story-pages-")));
  for (const [name, text] of Object.entries(files)) await writeFile(join(root, name), text);
  return root;
}

describe("Markdown as pages on disk", () => {
  test("page mode reads Markdown as pages, except frontmatter that does not parse", async () => {
    const root = await folder({
      "a.md": "---\nid: p1\ntitle: 'A'   # kept as written\n---\nBody\n",
      "broken.md": "---\ntitle: [\n---\nBody\n",
      "notes.txt": "plain",
    });
    try {
      const legacy = await resolveSnapshot(await snapshotDirectory(root));
      expect(decodeProtocolDirectory(legacy.objects.get(legacy.root)!).entries.every((entry) => entry.file)).toBe(true);
      expect(await treeHoldsPages(legacy.root, async (hash) => legacy.objects.get(hash)!)).toBe(false);

      const paged = await resolveSnapshot(await snapshotDirectory(root, new Map(), [], undefined, undefined, undefined, true));
      const entries = new Map(decodeProtocolDirectory(paged.objects.get(paged.root)!).entries.map((entry) => [entry.name, entry]));
      expect(entries.get("a.md")?.page).toBeDefined();
      expect(entries.get("broken.md")?.file).toBeDefined();
      expect(entries.get("notes.txt")?.file).toBeDefined();
      const page = decodeProtocolPage(paged.objects.get(entries.get("a.md")!.page!)!);
      expect(page).toEqual({ type: "page", id: "p1", properties: [["title", "A"]], body: encoder.encode("Body\n") });
      expect(await treeHoldsPages(paged.root, async (hash) => paged.objects.get(hash)!)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("materializing a page changes only what changed in the file on disk", async () => {
    const source = "---\nid: p1\ntitle: 'A'   # kept as written\nstatus: draft\n---\nBody\n";
    const root = await folder({ "a.md": source });
    try {
      const objects = new Map<ObjectHash, Uint8Array>();
      const put = (bytes: Uint8Array) => { const hash = hashObject(bytes); objects.set(hash, bytes); return hash; };
      const treeOf = (status: string) => put(encodeProtocolDirectory({ type: "directory", entries: [{ name: "a.md",
        page: put(encodeProtocolPage({ type: "page", id: "p1", properties: [["title", "A"], ["status", status]], body: encoder.encode("Body\n") })) }] }));
      const load = async (hash: ObjectHash) => objects.get(hash)!;
      // A file that already reads as the page is left as written.
      await materializeTree(root, treeOf("draft"), load);
      expect(await readFile(join(root, "a.md"), "utf8")).toBe(source);
      await materializeTree(root, treeOf("done"), load);
      expect(await readFile(join(root, "a.md"), "utf8")).toBe(source.replace("status: draft", "status: done"));
      // Reading it back in page mode gives the same tree.
      const read = await resolveSnapshot(await snapshotDirectory(root, new Map(), [], undefined, undefined, undefined, true));
      expect(read.root).toBe(treeOf("done"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a change to page properties alone is derived as property operations", async () => {
    const root = await folder({ "a.md": "---\ntitle: A\ntags: [x, y]\n---\nBody\n" });
    try {
      const before = await resolveSnapshot(await snapshotDirectory(root, new Map(), [], undefined, undefined, undefined, true));
      await writeFile(join(root, "a.md"), "---\ntitle: B\ntags: [y, z]\n---\nBody\n");
      const after = await resolveSnapshot(await snapshotDirectory(root, new Map(), [], undefined, undefined, undefined, true));
      const read = async (hash: ObjectHash) => after.objects.get(hash) ?? before.objects.get(hash)!;
      const operations = await deriveRowOperations(before.root, after.root, read);
      expect(operations?.map((op) => [op.kind, op.kind === "rowCreate" || op.kind === "rowDelete" ? null : op.field])).toEqual([
        ["set", "title"], ["disconnect", "tags"], ["connect", "tags"],
      ]);
      await writeFile(join(root, "a.md"), "---\ntitle: B\ntags: [y, z]\n---\nBody changed\n");
      const edited = await resolveSnapshot(await snapshotDirectory(root, new Map(), [], undefined, undefined, undefined, true));
      expect(await deriveRowOperations(before.root, edited.root, async (hash) => edited.objects.get(hash) ?? before.objects.get(hash)!)).toBeNull();
      expect(decoder.decode(decodeProtocolPage(edited.objects.get(decodeProtocolDirectory(edited.objects.get(edited.root)!).entries[0]!.page!)!).body)).toBe("Body changed\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
