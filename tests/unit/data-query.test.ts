import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { arbor, compileQuery, introspectStoreSchema, query, resolveDatabaseLocation, QueryCompileError } from "arbor/data";

const repository = join(import.meta.dir, "..", "..");
const supplies = join(repository, "sites", "supplies");

describe("arbor/data query planning", () => {
  test("runs an authored planner once and retains symbolic input", () => {
    let invocations = 0;
    const handle = query.many(arbor("./data/practices").children, (practice, { input }: any) => {
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
    const lists = arbor("./data/lists").children;
    const unknown = query.many(lists, (list) => ({ select: { leaked: (list as any).secret } }));
    const ambiguous = query.maybe(lists, (list) => ({
      where: (list.visibility as any).eq("public"),
      select: (list as any).pick("id"),
    }));
    expect(() => compileQuery(unknown, schema)).toThrow(QueryCompileError);
    expect(() => compileQuery(ambiguous, schema)).toThrow("not constrained by a proved unique key");
  });
});
