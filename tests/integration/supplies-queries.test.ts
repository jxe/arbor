import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { revisionOf } from "@arbor/core";
import { z } from "zod";
import {
  database,
  query,
  QueryInputError,
  QueryUserRequiredError,
  SQLiteQueryEngine,
  resolveDatabaseLocation,
  type ProfileResolver,
  type QueryExecution,
  type ResolvedDatabaseLocation,
} from "arbor/data";

mock.module("arbor/react", () => ({
  Markdown: () => null,
  skipQuery: Symbol("skip-query"),
  useMutationAction: () => [{}, () => undefined, false],
  useNavigate: () => () => undefined,
  useQuery: () => [],
  useUser: () => null,
}));

const repository = join(import.meta.dir, "..", "..");
const supplies = join(repository, "sites", "supplies");
const ada = "tr_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const bo = "tr_bbbbbbbbbbbbbbbbbbbbbbbbbb";
const careList = "10000000-0000-4000-8000-000000000001";
const privateList = "10000000-0000-4000-8000-000000000002";
const listeningPractice = "00000000-0000-4000-8000-000000000002";
const walkingPractice = "00000000-0000-4000-8000-000000000003";

let location: ResolvedDatabaseLocation;
let engine: SQLiteQueryEngine;
let handles: Record<string, any>;

beforeAll(async () => {
  const profiles = JSON.parse(await readFile(join(repository, "tests", "fixtures", "supplies", "profiles.json"), "utf8")) as Array<Record<string, unknown>>;
  const resolver: ProfileResolver = {
    async resolve(ids, fields) {
      const rows = profiles
        .filter((profile) => ids.includes(String(profile.id)))
        .map((profile) => Object.fromEntries(fields.map((field) => [field, profile[field]])));
      return {
        rows,
        dependencies: rows.map((profile) => ({
          profile: String(profile.id),
          tree: String(profile.id),
          ref: revisionOf(JSON.stringify(profiles.find((candidate) => candidate.id === profile.id))),
        })),
      };
    },
  };
  location = await resolveDatabaseLocation(join(supplies, "List.tsx"), "./data", [
    { root: supplies, tree: "tr_supplies_source" },
    { root: join(supplies, "data"), tree: "tr_supplies_data" },
  ]);
  engine = await SQLiteQueryEngine.open(location, resolver);

  const load = (path: string): Promise<Record<string, any>> => import(path);
  const [list, practice, profile, practiceSearch, popularLists, sharedQueries] = await Promise.all([
    load(join(supplies, "List.tsx")),
    load(join(supplies, "Practice.tsx")),
    load(join(supplies, "Profile.tsx")),
    load(join(supplies, "components", "PracticeSearch.tsx")),
    load(join(supplies, "components", "PopularLists.tsx")),
    load(join(supplies, "scripts", "queries.ts")),
  ]);
  handles = {
    list: list.list,
    practiceChoices: list.practiceChoices,
    practice: practice.practice,
    profile: profile.profile,
    practiceSearch: practiceSearch.practiceSearch,
    popularLists: popularLists.popularLists,
    myLists: sharedQueries.myLists,
  };
});

afterAll(async () => {
  await engine?.[Symbol.asyncDispose]();
  mock.restore();
});

function snapshot(execution: QueryExecution<unknown>): { result: unknown; queryPlans: string[][] } {
  for (const statement of execution.statements) {
    expect(statement.sql.toLowerCase()).not.toContain("select *");
  }
  return { result: execution.result, queryPlans: execution.queryPlans.map((plan) => plan.details) };
}

describe("Supplies SQLite query engine", () => {
  test("canonicalizes module-relative paths through the longest nested tree boundary", async () => {
    const fromSharedScript = await resolveDatabaseLocation(join(supplies, "scripts", "queries.ts"), "../data", [
      { root: supplies, tree: "tr_supplies_source" },
      { root: join(supplies, "data"), tree: "tr_supplies_data" },
    ]);
    expect(fromSharedScript.directory).toBe(location.directory);
    expect(fromSharedScript.databasePath).toBe(location.databasePath);
    expect(fromSharedScript.tree).toBe("tr_supplies_data");
  });

  test("introspects stable keys, booleans, virtual profiles, and reviewed relationships", () => {
    expect(engine.schema.relations.lists?.primaryKey).toEqual(["id"]);
    expect(engine.schema.relations.lists?.fields.allow_arbor_user_edits?.type).toBe("boolean");
    expect(engine.schema.relations.arbor_profiles?.source).toBe("arbor-profile");
    expect(engine.schema.relationships["list_practices.tags"]?.through?.source).toHaveLength(2);
    expect(engine.schema.relationships["lists.items"]?.key).toEqual(["practice_id"]);
    expect(engine.schema.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  test("executes every checked-in Supplies query with shaped, deterministic results", async () => {
    const executions = {
      practiceSearch: await engine.execute(handles.practiceSearch, { input: { search: "listen" } }),
      popularLists: await engine.execute(handles.popularLists),
      profile: await engine.execute(handles.profile, { input: { profile: ada } }),
      list: await engine.execute(handles.list, { input: { id: careList } }),
      practiceChoices: await engine.execute(handles.practiceChoices),
      practice: await engine.execute(handles.practice, { input: { id: listeningPractice } }),
      myLists: await engine.execute(handles.myLists, { user: { profile: ada } }),
    };

    for (const [name, execution] of Object.entries(executions)) snapshot(execution).result;
    expect(executions.practiceSearch.result).toMatchSnapshot("practiceSearch result");
    expect(executions.popularLists.result).toMatchSnapshot("popularLists result");
    expect(executions.profile.result).toMatchSnapshot("profile result");
    expect(executions.list.result).toMatchSnapshot("list result");
    expect(executions.practiceChoices.result).toMatchSnapshot("practiceChoices result");
    expect(executions.practice.result).toMatchSnapshot("practice result");
    expect(executions.myLists.result).toMatchSnapshot("myLists result");
    expect(Object.fromEntries(Object.entries(executions).map(([name, execution]) => [name, execution.queryPlans.map((plan) => plan.details)])))
      .toMatchSnapshot("SQLite query plans");
    expect((executions.list.result as { allowArborUserEdits: unknown }).allowArborUserEdits).toBe(true);
    expect(executions.list.dependencies.profiles.map((dependency) => dependency.profile)).toEqual([
      ada,
      bo,
      "tr_cccccccccccccccccccccccccc",
    ]);
  });

  test("keeps private lists out of anonymous results while allowing their owner", async () => {
    const anonymousList = await engine.execute(handles.list, { input: { id: privateList } });
    const ownerList = await engine.execute(handles.list, { input: { id: privateList }, user: { profile: ada } });
    const anonymousPractice = await engine.execute(handles.practice, { input: { id: walkingPractice } });
    const ownerPractice = await engine.execute(handles.practice, { input: { id: walkingPractice }, user: { profile: ada } });
    expect(anonymousList.result).toBeNull();
    expect((ownerList.result as { id: string }).id).toBe(privateList);
    expect((anonymousPractice.result as { lists: unknown[] }).lists).toEqual([]);
    expect((ownerPractice.result as { lists: Array<{ id: string }> }).lists.map((list) => list.id)).toEqual([privateList]);
  });

  test("validates input and required users before query execution", async () => {
    await expect(engine.execute(handles.practiceSearch, { input: {} })).rejects.toBeInstanceOf(QueryInputError);
    await expect(engine.execute(handles.myLists)).rejects.toBeInstanceOf(QueryUserRequiredError);
  });

  test("uses parameters for caller-controlled values", async () => {
    const execution = await engine.execute(handles.practiceSearch, { input: { search: "listen" }, user: { profile: bo } });
    expect(execution.statements[0]?.sql).not.toContain("listen");
    expect(execution.statements[0]?.parameters).toContain("listen");
  });

  test("applies Standard Schema transformations and query.one cardinality", async () => {
    const data = database("./data");
    const transformedSearch = query.many(
      data.relations.practices!,
      z.object({ search: z.string().trim().toLowerCase() }),
      (practice, { input }: any) => ({
        where: (practice.name as any).contains(input.search),
        orderBy: practice.name,
        select: (practice as any).pick("id", "name"),
      }),
    );
    const exactPractice = query.one(
      data.relations.practices!,
      z.object({ id: z.string().uuid() }),
      (practice, { input }: any) => ({
        where: (practice.id as any).eq(input.id),
        select: (practice as any).pick("id", "name"),
      }),
    );
    const searched = await engine.execute(transformedSearch, { input: { search: "  LISTEN  " } });
    const exact = await engine.execute(exactPractice, { input: { id: listeningPractice } });
    expect(searched.result).toEqual([{ id: listeningPractice, name: "Listening circles" }]);
    expect(exact.result).toEqual({ id: listeningPractice, name: "Listening circles" });
    await expect(engine.execute(exactPractice, { input: { id: "00000000-0000-4000-8000-000000000099" } }))
      .rejects.toThrow("query.one returned no row");
  });
});
