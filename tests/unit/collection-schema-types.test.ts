import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { collectionTypeDeclarations, compileCollectionSchema } from "@ovst/collection-schema";

const source = `model Entry {
  status  Status
  note    Markdown?
  count   Int
  flag    Bool
  due     Date?
  tags    Text[]
  authors Person[]
}

Entry.status <-> Status.entries[]
Entry.authors[] @fold <-> Person.entries[]

model Status {
  @@fixed { draft, done }
}
`;

const expected = 'type Row = { "id": string; "note"?: string | null; "count": number; "flag": boolean; "due"?: string | null; "tags"?: string[]; "status": "draft" | "done"; "authors"?: string[]; "created"?: string | null; "modified"?: string | null; [member: string]: unknown; };';

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
    const directory = await mkdtemp(join(tmpdir(), "story-collection-types-"));
    try {
      await writeFile(join(directory, "tree.gen.d.ts"), `${collectionTypeDeclarations(compileCollectionSchema(source), "Row")}\n`);
      await writeFile(join(directory, "use.ts"), [
        'const valid: Row = { id: "a", status: "done", count: 3, flag: true };',
        'const noted: Row = { ...valid, note: "optional", due: null, tags: ["x"], authors: ["profile"] };',
        "// Rows are open: undeclared members of any type are allowed.",
        'const extended: Row = { ...valid, color: "red", rank: 1, nested: { deep: [null] } };',
        "// @ts-expect-error a declared optional member keeps its type",
        "const badNote: Row = { ...valid, note: 1 };",
        "// @ts-expect-error status is one of the fixed rows",
        'const badStatus: Row = { ...valid, status: "archived" };',
        "// @ts-expect-error array items keep their type",
        "const badTags: Row = { ...valid, tags: [1] };",
        "// @ts-expect-error count is required",
        "const { count: _omitted, ...missing } = valid; const missingCount: Row = missing;",
        "export { valid, noted, extended, badNote, badStatus, badTags, missingCount };",
        "",
      ].join("\n"));
      const tsc = join(import.meta.dir, "../../node_modules/typescript/bin/tsc");
      const result = Bun.spawnSync([process.execPath, tsc, "--ignoreConfig", "--noEmit", "--strict", "--exactOptionalPropertyTypes", "--lib", "es2023,dom", join(directory, "tree.gen.d.ts"), join(directory, "use.ts")], {
        stdout: "pipe", stderr: "pipe",
      });
      expect(`${result.stdout.toString()}${result.stderr.toString()}`).toBe("");
      expect(result.exitCode).toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);
});
