import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply, MigrationStop, plan, revert } from "./run.ts";

const TREE = "tr_owozr6aegt5z7x6qyllvzljl5u";
const roots: string[] = [];

async function tree(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "arbor-021-"));
  roots.push(root);
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), contents);
  }
  return root;
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const doc = (id: string, body = "") => `---\nid: ${id}\n---\n${body}`;

describe("021 file-relative links", () => {
  test("rewrites every legacy form to the 021 writer's output and nothing else", async () => {
    const root = await tree({
      "_index.md": doc("root01", "[Amends](Amends)\r\n[Gone](Nowhere)\r\n[x](Untitled-4.md#cxua95)\r\n"),
      "Calendar.md": doc("h31mlm"),
      "Amends.md": doc("648a2p", "[Cal](../Calendar#h31mlm) [web](https://example.com/#h31mlm)\n"),
      "Amends/Write.md": doc("srv8pf", "[Up](../Calendar#h31mlm)\n"),
      "Picture.md": doc("pic001", [
        "[Row](arbor://tr_owozr6aegt5z7x6qyllvzljl5u/Amends;arbor-key=W1siaWQiLCI2NDhhMnAiXV0)",
        "[Alias](Write#arbor-key=W1siaWQiLCJzcnY4cGYiXV0)",
        "[Other](arbor://tr_otherotherotherotherother/x;arbor-key=W1siaWQiLCJxIl1d)",
        "![img](Assets/p.png)",
        "",
      ].join("\n")),
      "Picture/Assets/p.png": "png",
      "Picture/Write.md": doc("pw0001"),
      "Deep/Leaf.md": doc("leaf01", "[Sibling](Other.md)\n"),
      "Deep/Leaf/Other.md": doc("oth001"),
    });
    const result = plan(root, TREE);
    const changed = Object.fromEntries(result.changes.map((change) => [`${change.file}:${change.before}`, change.after]));
    expect(changed).toEqual({
      "_index.md:Amends": "Amends.md#arbor-key=id:648a2p",
      "_index.md:Untitled-4.md#cxua95": "Untitled-4.md",
      "Amends.md:../Calendar#h31mlm": "Calendar.md#arbor-key=id:h31mlm",
      "Amends/Write.md:../Calendar#h31mlm": "../Calendar.md#arbor-key=id:h31mlm",
      "Picture.md:arbor://tr_owozr6aegt5z7x6qyllvzljl5u/Amends;arbor-key=W1siaWQiLCI2NDhhMnAiXV0": "Amends.md#arbor-key=id:648a2p",
      "Picture.md:Write#arbor-key=W1siaWQiLCJzcnY4cGYiXV0": "Amends/Write.md#arbor-key=id:srv8pf",
      "Picture.md:arbor://tr_otherotherotherotherother/x;arbor-key=W1siaWQiLCJxIl1d": "arbor://tr_otherotherotherotherother/x;arbor-key=id:q",
      "Picture.md:Assets/p.png": "Picture/Assets/p.png",
      "Deep/Leaf.md:Other.md": "Leaf/Other.md#arbor-key=id:oth001",
    });
    expect(result.reports.map((entry) => entry.report).sort()).toEqual(["external", "keyless-dangling"]);

    apply(result);
    const index = await readFile(join(root, "_index.md"), "utf8");
    expect(index).toBe(doc("root01", "[Amends](Amends.md#arbor-key=id:648a2p)\r\n[Gone](Nowhere)\r\n[x](Untitled-4.md)\r\n"));
    expect(await readFile(join(root, "Amends.md"), "utf8")).toBe(doc("648a2p", "[Cal](Calendar.md#arbor-key=id:h31mlm) [web](https://example.com/#h31mlm)\n"));
    expect(plan(root, TREE).changes).toEqual([]);
  });

  test("stops on an unowned bare fragment, a duplicate id, or two readings of one link", async () => {
    const stops = async (files: Record<string, string>) => expect(tree(files).then((root) => plan(root, TREE))).rejects.toThrow(MigrationStop);
    await stops({ "a.md": doc("a00001", "[x](b#section)\n"), "b.md": "" });
    await stops({ "a.md": doc("dup001"), "b.md": doc("dup001") });
    // From `x.md` beside `x/`, `c` is `/c` from the file and `/x/c` from the old node base.
    await stops({ "x.md": doc("x00001", "[c](c)\n"), "c.md": "", "x/c.md": "" });
  });

  test("refuses to write a file that changed after it was read, and reverts only untouched files", async () => {
    const root = await tree({ "a.md": doc("a00001", "[b](b#b00001)\n"), "b.md": doc("b00001"), "c.md": doc("c00001", "[b](b#b00001)\n") });
    const stale = plan(root, TREE);
    await writeFile(join(root, "a.md"), doc("a00001", "[b](b#b00001) edited\n"));
    expect(() => apply(stale)).toThrow(MigrationStop);

    const result = plan(root, TREE);
    apply(result);
    await writeFile(join(root, "c.md"), "edited after the migration\n");
    const originals = new Map(result.files.map((file) => [file.file, file.source]));
    expect(revert(root, { files: result.files }, originals)).toEqual(["a.md"]);
    expect(await readFile(join(root, "a.md"), "utf8")).toBe(doc("a00001", "[b](b#b00001) edited\n"));
  });
});
