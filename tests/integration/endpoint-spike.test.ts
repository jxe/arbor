// SPIKE: endpoints whose shape is traced into a plan and whose values are plain JS.
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { revisionOf } from "@ovst/protocol";
import {
  resolveDatabaseLocation,
  resolveStorySource,
  SQLiteQueryEngine,
  type ProfileResolver,
  type QueryHandle,
} from "overstory/data";
import { runEndpoint, type Endpoint } from "overstory/endpoint";

mock.module("overstory/react", () => ({
  Markdown: () => null,
  skipQuery: Symbol("skip-query"),
  useMutationAction: () => [{}, () => undefined, false],
  useNavigate: () => () => undefined,
  useQuery: () => [],
  useUser: () => null,
}));

const repository = join(import.meta.dir, "..", "..");
const supplies = join(repository, "examples", "supplies");
const shared = join(supplies, "endpoints", "shared.tsx");
const ada = "tr_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const careList = "10000000-0000-4000-8000-000000000001";
const privateList = "10000000-0000-4000-8000-000000000002";
const listeningPractice = "00000000-0000-4000-8000-000000000002";
const walkingPractice = "00000000-0000-4000-8000-000000000003";
const boundaries = [
  { root: supplies, tree: "tr_supplies_source" },
  { root: join(supplies, "data"), tree: "tr_supplies_data" },
];

let engine: SQLiteQueryEngine;
let oldList: QueryHandle<unknown, unknown>;
let endpoints: Record<string, Endpoint<any, any>>;

beforeAll(async () => {
  const profiles = JSON.parse(await readFile(join(repository, "tests", "fixtures", "supplies", "profiles.json"), "utf8")) as Array<Record<string, unknown>>;
  const resolver: ProfileResolver = {
    async resolve(ids, fields) {
      const rows = profiles
        .filter((profile) => ids.includes(String(profile.id)))
        .map((profile) => Object.fromEntries(fields.map((field) => [field, profile[field]])));
      return {
        rows,
        dependencies: rows.map((profile) => ({ profile: String(profile.id), tree: String(profile.id), ref: revisionOf(JSON.stringify(profile)) })),
      };
    },
  };
  const location = await resolveDatabaseLocation(shared, "../data", boundaries);
  engine = await SQLiteQueryEngine.open(location, resolver);
  const [list, practice, search] = await Promise.all([
    import(join(supplies, "endpoints", "list.tsx")),
    import(join(supplies, "endpoints", "practice.tsx")),
    import(join(supplies, "endpoints", "search.tsx")),
  ]);
  endpoints = { ...list, ...practice, ...search };
  const listModule = join(supplies, "List.tsx");
  oldList = (await import(listModule)).list;
  engine.bind(oldList, await resolveStorySource(listModule, oldList.source.path, boundaries, engine.schema.fingerprint, { virtualLeaf: true }));
});

afterAll(async () => {
  await engine?.[Symbol.asyncDispose]();
  mock.restore();
});

async function run(name: string, input: unknown, user: { profile: string } | null = null) {
  return runEndpoint(endpoints[name]!, {
    engine,
    input,
    user,
    resolve: (handle) => resolveStorySource(shared, handle.source.path, boundaries, engine.schema.fingerprint, { virtualLeaf: true }),
  });
}

const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

/** The plan as the host sees it: relation, cardinality and the selection tree, without node ids. */
function shape(plan: QueryHandle<unknown, unknown>): unknown {
  const visit = (select: Record<string, any>): unknown => Object.fromEntries(Object.entries(select).map(([key, value]) => [
    key,
    value.kind === "relationship" ? visit(value.plan.select) : value.kind,
  ]));
  return { relation: plan.plan.relation, cardinality: plan.plan.cardinality, select: visit(plan.plan.select) };
}

describe("endpoint spike", () => {
  test("a JSON endpoint traces one plan and answers what the old list query answered", async () => {
    const result = await run("listData", { id: careList }, { profile: ada });
    expect(result.plans).toHaveLength(1);
    expect(result.reruns).toBe(0);
    const output = result.output as any;
    expect(output.name).toBe("Community care");
    expect(output.owner.id).toBe(ada);
    expect(output.items.map((item: any) => item.practice.name)).toEqual(["Mutual aid", "Listening circles"]);
    expect(output.tags.map((tag: any) => tag.name)).toEqual(["Care", "Local"]);
    expect(output.items[0].practice.tags.map((tag: any) => tag.id)).toEqual(["care"]);
    expect(shape(result.plans[0]!)).toMatchSnapshot("listData plan");
    expect(result.output).toMatchSnapshot("listData output");
    // The same SQL work as the hand-written query it replaces.
    const old = await engine.execute(oldList, { input: { id: careList }, user: { profile: ada } });
    expect(result.statements).toBe(old.statements.length);
  });

  test("private lists stay on the host because visibility is narrowing, not JS", async () => {
    expect((await run("listData", { id: privateList })).output).toBeNull();
    expect((await run("listData", { id: privateList }, { profile: ada })).output.name).toBe("Quiet experiments");
  });

  test("a view endpoint widens once when a branch the trace skipped reads new fields", async () => {
    const result = await run("ListPage", { id: careList }, { profile: ada });
    // The trace compared l.kind to "Tagged" with a stand-in, took the else branch and never saw tags.
    expect(result.reruns).toBe(1);
    expect([...new Set(result.widened)]).toEqual(["List.items[0].practice.tags", "List.items[1].practice.tags"]);
    expect(JSON.stringify(result.output)).toContain('"Care"');
    expect(plain(result.output)).toMatchSnapshot("ListPage view");
  });

  test("a second root inside a row runs as its own plan", async () => {
    const result = await run("practiceData", { id: walkingPractice }, { profile: ada });
    expect(result.plans.map((plan) => plan.plan.relation).sort()).toEqual(["List", "Practice"]);
    expect(result.output.lists.map((list: any) => list.id)).toEqual([privateList]);
    expect((await run("practiceData", { id: walkingPractice })).output.lists).toEqual([]);
    const listening = await run("practiceData", { id: listeningPractice });
    expect(listening.plans.map(shape)).toMatchSnapshot("practiceData plans");
    expect(listening.output).toMatchSnapshot("practiceData output");
    expect(plain((await run("PracticePage", { id: listeningPractice })).output)).toMatchSnapshot("PracticePage view");
  });

  test("search trims in JS before narrowing on the host, and an empty search reads nothing", async () => {
    const empty = await run("practiceSearchData", { search: "  " });
    expect(empty.plans).toEqual([]);
    expect(empty.output).toEqual([]);
    const found = await run("practiceSearchData", { search: " listen " });
    expect(found.output.map((practice: any) => practice.name)).toEqual(["Listening circles"]);
    expect(plain((await run("PracticeSearch", { search: "walk" })).output)).toMatchSnapshot("PracticeSearch view");
  });
});
