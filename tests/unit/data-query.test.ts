import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { node, compileQuery, introspectStoreSchema, query, resolveDatabaseLocation, QueryCompileError } from "overstory/data";

const repository = join(import.meta.dir, "..", "..");
const supplies = join(repository, "examples", "supplies");

describe("story/data query planning", () => {
  test("runs an authored planner once and retains symbolic input", () => {
    let invocations = 0;
    const handle = query.many(node("./data/practices").children, (practice, { input }: any) => {
      invocations += 1;
      return {
        where: (practice.name as any).contains(input.search),
        select: (practice as any).pick("id", "name"),
      };
    });
    expect(invocations).toBe(1);
    expect(handle.plan.where).toMatchObject({
      kind: "comparison",
      operator: "contains",
      left: { kind: "field", field: "name" },
      right: { kind: "parameter", path: ["search"] },
    });
  });

  test("rejects unknown fields and unproved singular queries during compilation", async () => {
    const location = await resolveDatabaseLocation(join(supplies, "List.tsx"), "./data");
    const schema = await introspectStoreSchema(location);
    const lists = node("./data/lists").children;
    const unknown = query.many(lists, (list) => ({ select: { leaked: (list as any).secret } }));
    const ambiguous = query.maybe(lists, (list) => ({
      where: (list.visibility as any).eq("public"),
      select: (list as any).pick("id"),
    }));
    expect(() => compileQuery(unknown, schema)).toThrow(QueryCompileError);
    expect(() => compileQuery(ambiguous, schema)).toThrow("not constrained by a proved unique key");
  });
  // Rename 002: authored sources may still carry the old spellings.
  test("reads the old arbor: node path and arbor-profile relation source", async () => {
    expect(node("arbor://garden.example/~ada/data/lists").path).toBe("arbor://garden.example/~ada/data/lists");
    expect(node("overstory://garden.example/~ada/data/lists").children).toBeDefined();
    expect(() => node("ftp://garden.example/data/lists")).toThrow("node() requires");

    const location = await resolveDatabaseLocation(join(supplies, "List.tsx"), "./data");
    const current = await introspectStoreSchema(location);
    const authored = await readFile(location.relationshipsPath, "utf8");
    expect(authored).toContain('"source": "overstory-profile"');
    const scratch = await mkdtemp(join(tmpdir(), "story-relation-source-"));
    try {
      const relationshipsPath = join(scratch, "relationships.json");
      await writeFile(relationshipsPath, authored.replace('"source": "overstory-profile"', '"source": "arbor-profile"'));
      const old = await introspectStoreSchema({ ...location, relationshipsPath });
      expect(old.relations.arbor_profiles?.source).toBe("overstory-profile");
      expect(old.relations).toEqual(current.relations);
      await writeFile(relationshipsPath, authored.replace('"source": "overstory-profile"', '"source": "canopy-profile"'));
      await expect(introspectStoreSchema({ ...location, relationshipsPath })).rejects.toThrow("unknown source");
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});
