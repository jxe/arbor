import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { node, compileQuery, introspectStoreSchema, query, resolveDatabaseLocation, QueryCompileError } from "overstory/data";

const repository = join(import.meta.dir, "..", "..");
const supplies = join(repository, "examples", "supplies");

describe("story/data query planning", () => {
  test("runs an authored planner once and retains symbolic input", () => {
    let invocations = 0;
    const handle = query.many(node("./data/Practice").children, (practice, { input }: any) => {
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
    const lists = node("./data/List").children;
    const unknown = query.many(lists, (list) => ({ select: { leaked: (list as any).secret } }));
    const ambiguous = query.maybe(lists, (list) => ({
      where: (list.visibility as any).eq("Public"),
      select: (list as any).pick("id"),
    }));
    expect(() => compileQuery(unknown, schema)).toThrow(QueryCompileError);
    expect(() => compileQuery(ambiguous, schema)).toThrow("not constrained by a proved unique key");
  });
  test("plans some() over a relationship and keeps it inside the database", async () => {
    const location = await resolveDatabaseLocation(join(supplies, "List.tsx"), "./data");
    const schema = await introspectStoreSchema(location);
    const onPractice = query.many(node("./data/List").children, (list: any, { input }: any) => ({
      where: list.items.some((item: any) => item.practice.eq(input.id)),
      select: list.pick("id"),
    }));
    expect(onPractice.plan.where).toMatchObject({
      kind: "exists",
      relationship: "items",
      where: { kind: "comparison", left: { kind: "field", field: "practice" }, right: { kind: "parameter", path: ["id"] } },
    });
    expect(() => compileQuery(onPractice, schema)).not.toThrow();
    const fromPeople = query.maybe(node("./data/Person").children, (person: any) => ({
      where: [person.id.eq("tr_aaaaaaaaaaaaaaaaaaaaaaaaaa"), person.ownedLists.some()],
      select: person.pick("id"),
    }));
    expect(() => compileQuery(fromPeople, schema)).toThrow("must stay inside the database");
  });

  test("reads an overstory: node path and refuses other schemes", () => {
    expect(node("overstory://garden.example/~ada/data/List").children).toBeDefined();
    expect(() => node("arbor://garden.example/~ada/data/List")).toThrow("node() requires");
    expect(() => node("ftp://garden.example/data/List")).toThrow("node() requires");
  });
});
