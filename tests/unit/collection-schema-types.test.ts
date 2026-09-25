import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { collectionTypeDeclarations, compileCollectionSchema } from "@overstory/collection-schema";

const source = `overstory-schema-version = 1
overstory-primary-key = ["id"]
status = "draft" / "done"
point = { x: number, y: number }
tag-name = tstr
meta = { ? title: tstr, * tstr => any }
row = {
  id: tstr,
  status: status,
  ? note: tstr,
  maybe: tstr / null,
  count: 0..10,
  answer: 42,
  flag: bool,
  tags: [* tag-name],
  path: [+ point],
  "display name": text,
  ? meta: meta,
}
`;

const expected = [
  "type Row_status = \"draft\" | \"done\";",
  "type Row_tag_name = string;",
  "type Row_point = { \"x\": number; \"y\": number; };",
  "type Row_meta = { \"title\"?: string; [member: string]: unknown; };",
  "type Row = { \"id\": string; \"status\": Row_status; \"note\"?: string; \"maybe\": string | null; \"count\": number; \"answer\": 42; \"flag\": boolean; \"tags\": Array<Row_tag_name>; \"path\": [Row_point, ...Array<Row_point>]; \"display name\": string; \"meta\"?: Row_meta; [member: string]: unknown; };",
].join("\n");

describe("generated collection declarations", () => {
  test("are static, deterministic declarations of the declarative schema", () => {
    const first = collectionTypeDeclarations(compileCollectionSchema(source), "Row");
    const second = collectionTypeDeclarations(compileCollectionSchema(new TextEncoder().encode(source)), "Row");
    expect(first).toBe(expected);
    expect(second).toBe(first);
    expect(first).not.toContain("import");
    expect(first).not.toContain("zod");
  });

  test("typecheck without authored schema modules or Zod", async () => {
    const directory = await mkdtemp(join(tmpdir(), "arbor-collection-types-"));
    try {
      await writeFile(join(directory, "tree.gen.d.ts"), `${collectionTypeDeclarations(compileCollectionSchema(source), "Row")}\n`);
      await writeFile(join(directory, "use.ts"), [
        'const valid: Row = { id: "a", status: "done", maybe: null, count: 3, answer: 42, flag: true, tags: [], path: [{ x: 1, y: 2 }], "display name": "A" };',
        'const noted: Row = { ...valid, note: "optional" };',
        "// Rows are open: undeclared members of any type are allowed.",
        'const extended: Row = { ...valid, color: "red", rank: 1, nested: { deep: [null] } };',
        'const described: Row = { ...valid, meta: { title: "T", anything: [1] } };',
        "// @ts-expect-error declared members keep their types",
        'const badTitle: Row = { ...valid, meta: { title: 1 } };',
        "// @ts-expect-error nested maps without * tstr => any stay closed",
        "const extraPoint: Row = { ...valid, path: [{ x: 1, y: 2, z: 3 }] };",
        "// @ts-expect-error a declared optional member keeps its type",
        "const badNote: Row = { ...valid, note: 1 };",
        "// @ts-expect-error status is a closed literal union",
        'const badStatus: Row = { ...valid, status: "archived" };',
        "// @ts-expect-error a non-empty array needs one element",
        "const emptyPath: Row = { ...valid, path: [] };",
        "// @ts-expect-error maybe is required even though it admits null",
        "const { maybe: _omitted, ...missing } = valid; const missingMaybe: Row = missing;",
        "export { valid, noted, extended, described, badTitle, extraPoint, badNote, badStatus, emptyPath, missingMaybe };",
        "",
      ].join("\n"));
      const tsc = join(import.meta.dir, "../../node_modules/typescript/bin/tsc");
      const result = Bun.spawnSync([process.execPath, tsc, "--noEmit", "--strict", "--exactOptionalPropertyTypes", "--lib", "es2023,dom", join(directory, "tree.gen.d.ts"), join(directory, "use.ts")], {
        stdout: "pipe", stderr: "pipe",
      });
      expect(`${result.stdout.toString()}${result.stderr.toString()}`).toBe("");
      expect(result.exitCode).toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);
});
