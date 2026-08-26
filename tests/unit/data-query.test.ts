import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { compileQuery, database, introspectStoreSchema, query, resolveDatabaseLocation, QueryCompileError } from "arbor/data";

const repository = join(import.meta.dir, "..", "..");
const supplies = join(repository, "sites", "supplies");

describe("arbor/data query planning", () => {
  test("runs an authored planner once and retains symbolic input", () => {
    const data = database("./data");
    let invocations = 0;
    const handle = query.many(data.relations.practices!, (practice, { input }: any) => {
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
    const data = database("./data");
    const unknown = query.many(data.relations.lists!, (list) => ({ select: { leaked: (list as any).secret } }));
    const ambiguous = query.maybe(data.relations.lists!, (list) => ({
      where: (list.visibility as any).eq("public"),
      select: (list as any).pick("id"),
    }));
    expect(() => compileQuery(unknown, schema)).toThrow(QueryCompileError);
    expect(() => compileQuery(ambiguous, schema)).toThrow("not constrained by a proved unique key");
  });
});
