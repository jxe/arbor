import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { revisionOf } from "@ovst/protocol";
import {
  not,
  or,
  QueryInputError,
  QueryUserRequiredError,
  resolveDatabaseLocation,
  resolveStorySource,
  runView,
  runViewOverRows,
  SQLiteQueryEngine,
  view,
  type NodeHandle,
  type ProfileResolver,
  type ReadRules,
  type ResolvedDatabaseLocation,
  type RowsAnswer,
  type View,
} from "overstory/data";

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
const shared = join(supplies, "scripts", "views.ts");
const ada = "tr_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const bo = "tr_bbbbbbbbbbbbbbbbbbbbbbbbbb";
const careList = "10000000-0000-4000-8000-000000000001";
const privateList = "10000000-0000-4000-8000-000000000002";
const mutualAid = "00000000-0000-4000-8000-000000000001";
const listeningPractice = "00000000-0000-4000-8000-000000000002";
const walkingPractice = "00000000-0000-4000-8000-000000000003";
const boundaries = [
  { root: supplies, tree: "tr_supplies_source" },
  { root: join(supplies, "data"), tree: "tr_supplies_data" },
];

let location: ResolvedDatabaseLocation;
let engine: SQLiteQueryEngine;
let views: Record<string, View<any, any>>;
let sources: { List: any; Practice: any; Person: any };

/** Supplies' read rule, as the host would hold it once read rules can test a value. */
const listRule: ReadRules = {
  List: (l, { user }) => [or([l.visibility.is("Public")], [l.owner.is(user?.profile ?? null)])],
};

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
  location = await resolveDatabaseLocation(shared, "../data", boundaries);
  engine = await SQLiteQueryEngine.open(location, resolver);
  const load = (path: string): Promise<Record<string, any>> => import(join(supplies, path));
  const modules = await Promise.all(["List.tsx", "Practice.tsx", "Profile.tsx", "components/PracticeSearch.tsx", "components/PopularLists.tsx", "scripts/views.ts", "views/list.tsx"].map(load));
  views = Object.fromEntries(modules.flatMap((module) => Object.entries(module).filter(([, value]) => value?.kind === "view")));
  const scripts = modules[5]!;
  sources = { List: scripts.List, Practice: scripts.Practice, Person: scripts.Person };
});

afterAll(async () => {
  await engine?.[Symbol.asyncDispose]();
  mock.restore();
});

// Every Supplies source is declared in scripts/views.ts, so its node() paths resolve from there.
const resolve = (source: NodeHandle) => resolveStorySource(shared, source.path, boundaries, engine.schema.fingerprint, { virtualLeaf: true });

function run<Input, Output>(handle: View<Input, Output> | string, input?: Input, user: { profile: string } | null = null, options: { readRules?: ReadRules; form?: "value" | "rows" | "tree"; missed?: string[][] } = {}) {
  return runView(typeof handle === "string" ? views[handle]! : handle, { engine, resolve, input, user, ...options });
}

const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

describe("Supplies views", () => {
  test("canonicalizes module-relative paths through the longest nested tree boundary", async () => {
    const fromPage = await resolveDatabaseLocation(join(supplies, "List.tsx"), "./data", boundaries);
    expect(fromPage.directory).toBe(location.directory);
    expect(fromPage.databasePath).toBe(location.databasePath);
    expect(fromPage.tree).toBe("tr_supplies_data");
  });

  test("introspects stable keys, booleans, virtual people, schema.usl relationships and field types", () => {
    expect(engine.schema.relations.List?.primaryKey).toEqual(["id"]);
    expect(engine.schema.relations.List?.fields.openToEdits?.type).toBe("boolean");
    expect(engine.schema.relations.Person?.source).toBe("overstory-profile");
    expect(engine.schema.relationships["Tag.practices"]?.through?.source).toHaveLength(2);
    expect(engine.schema.relationships["List.items"]?.key).toEqual(["practice"]);
    expect(engine.schema.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(engine.schema.fieldTypes?.List).toMatchObject({ name: "Text", about: "Markdown", visibility: "Visibility", owner: "Person", openToEdits: "Bool" });
  });

  test("every data view answers what its query answered, with the same SQL statement count", async () => {
    const runs = {
      practiceSearch: await run("practiceSearch", { search: "listen" }),
      popularLists: await run("popularLists"),
      profile: await run("profile", { profile: ada }),
      list: await run("list", { id: careList }),
      practiceChoices: await run("practiceChoices"),
      practice: await run("practice", { id: listeningPractice }),
      practiceLists: await run("practiceLists", { id: listeningPractice }),
      myLists: await run("myLists", undefined, { profile: ada }),
    };
    // The snapshots are the old select-object queries' results, unchanged.
    for (const [name, result] of Object.entries(runs)) {
      expect(plain(result.output)).toMatchSnapshot(`${name} result`);
      expect(result.reruns).toBe(0);
      for (const execution of result.executions) {
        for (const statement of execution.statements) expect(statement.sql.toLowerCase()).not.toContain("select *");
      }
    }
    expect(Object.fromEntries(Object.entries(runs).map(([name, result]) => [name, result.statements]))).toEqual({
      practiceSearch: 2, popularLists: 2, profile: 3, list: 8, practiceChoices: 2, practice: 2, practiceLists: 2, myLists: 3,
    });
    expect(Object.fromEntries(Object.entries(runs).map(([name, result]) => [name, result.executions.flatMap((execution) => execution.queryPlans.map((plan) => plan.details))])))
      .toMatchSnapshot("SQLite query plans");
    expect(runs.list.executions[0]!.dependencies.profiles.map((dependency) => dependency.profile)).toEqual([ada, bo, "tr_cccccccccccccccccccccccccc"]);
  });

  test("a direct to-one's key comes from the row's own column, without a join", async () => {
    const result = await run("myLists", undefined, { profile: ada });
    const items = (result.plans[0]!.plan.select["items~"] as any).plan.select;
    expect(Object.keys(items).sort()).toEqual(["items_position", "list", "practice"]);
    expect(result.output[0].ownerProfile).toBe(ada);
  });

  test("keeps private lists out of anonymous results while allowing their owner", async () => {
    expect((await run("list", { id: privateList })).output).toBeNull();
    expect((await run("list", { id: privateList }, { profile: ada })).output.id).toBe(privateList);
    expect((await run("practiceLists", { id: walkingPractice })).output).toEqual([]);
    expect((await run("practiceLists", { id: walkingPractice }, { profile: ada })).output.map((list: any) => list.id)).toEqual([privateList]);
  });

  test("validates input and required users before reading", async () => {
    await expect(run("practiceSearch", {})).rejects.toBeInstanceOf(QueryInputError);
    await expect(run("myLists")).rejects.toBeInstanceOf(QueryUserRequiredError);
  });

  test("uses parameters for caller-controlled values", async () => {
    const result = await run("practiceSearch", { search: "listen" });
    const statement = result.executions[0]!.statements[0]!;
    expect(statement.sql).not.toContain("listen");
    expect(statement.parameters).toContain("listen");
  });

  test("a data view's result carries field types and row identity from the schema", async () => {
    const { shape } = await run("list", { id: careList });
    expect(shape?.fields?.name).toEqual({ type: "Text" });
    expect(shape?.fields?.about).toEqual({ type: "Markdown" });
    expect(shape?.fields?.visibility).toEqual({ type: "Visibility" });
    expect(shape?.row).toEqual({ model: "List", key: careList });
    expect(shape?.fields?.owner?.row).toEqual({ model: "Person", key: ada });
    const practice = shape?.fields?.items?.items?.[0]?.fields?.practice;
    expect(practice?.row).toEqual({ model: "Practice", key: mutualAid });
    expect(practice?.fields?.name).toEqual({ type: "Text" });
    // A tag's key is two fields, so its object isn't matched to the row, but its values still carry types.
    expect(practice?.fields?.tags?.items?.[0]?.fields?.color).toEqual({ type: "Text" });
  });
});

describe("JSX views", () => {
  test("a branch the plan pass skipped widens once", async () => {
    const result = await run("ListPage", { id: careList }, { profile: ada }, { form: "tree" });
    // The plan pass compared l.kind to "Tagged" with a stand-in and never saw the tags.
    expect(result.reruns).toBe(1);
    expect(result.widened.every((path) => path[path.length - 1]!.startsWith("tags~"))).toBe(true);
    expect(JSON.stringify(result.output)).toContain('"Care"');
    expect(plain(result.output)).toMatchSnapshot("ListPage tree");
  });

  test("a second root names a row of the first, and runs once per row it names", async () => {
    const result = await run("PracticePage", { id: walkingPractice }, { profile: ada }, { form: "tree" });
    expect(result.plans.map((plan) => plan.plan.relation).sort()).toEqual(["List", "Practice"]);
    expect(JSON.stringify(result.output)).toContain("Quiet experiments");
    expect(JSON.stringify((await run("PracticePage", { id: walkingPractice }, null, { form: "tree" })).output)).toContain("Not on any list you can see.");
    expect(plain((await run("PracticePage", { id: listeningPractice }, null, { form: "tree" })).output)).toMatchSnapshot("PracticePage tree");
  });

  test("search trims in JS before narrowing, and an empty search reads nothing", async () => {
    const empty = await run("PracticeSearch", { search: "  " }, null, { form: "tree" });
    expect(empty.plans).toEqual([]);
    expect(empty.output).toBeNull();
    expect(plain((await run("PracticeSearch", { search: " walk " }, null, { form: "tree" })).output)).toMatchSnapshot("PracticeSearch tree");
  });

  test("a rows answer reruns on a client to the same tree", async () => {
    const tree = await run("ListPage", { id: careList }, { profile: ada }, { form: "tree" });
    const rows = await run("ListPage", { id: careList }, { profile: ada }, { form: "rows" });
    const answer = JSON.parse(JSON.stringify(rows.output)) as RowsAnswer;
    const client = await runViewOverRows(views.ListPage!, { input: { id: careList }, user: { profile: ada }, rows: answer });
    expect(client.missed).toEqual([]);
    expect(plain(client.output)).toEqual(plain(tree.output));
    // The answer carries row identity and field types for each row.
    const root = rows.shape?.fields?.roots?.items?.[0]?.fields?.results?.items?.[0]?.items?.[1];
    expect(root?.row).toEqual({ model: "List", key: careList });
    expect(root?.fields?.name).toEqual({ type: "Text" });
  });

  test("a client's missed read widens the plan once", async () => {
    // A client whose rows lack the tags (say its own state took a branch the host's didn't).
    // It sends the link and everything it read beneath it, so one widening is enough.
    const rows = (await run("ListPage", { id: careList }, { profile: ada }, { form: "rows" })).output as RowsAnswer;
    const stripped = JSON.parse(JSON.stringify(rows), (key, value) => (key.startsWith("tags~") ? undefined : value)) as RowsAnswer;
    const first = await runViewOverRows(views.ListPage!, { input: { id: careList }, user: { profile: ada }, rows: stripped });
    expect(first.missed.length).toBeGreaterThan(0);
    const widened = await run("ListPage", { id: careList }, { profile: ada }, { form: "rows", missed: first.missed });
    const second = await runViewOverRows(views.ListPage!, { input: { id: careList }, user: { profile: ada }, rows: JSON.parse(JSON.stringify(widened.output)) });
    expect(second.missed).toEqual([]);
    expect(JSON.stringify(second.output)).toContain('"Care"');
  });
});

describe("facts", () => {
  test("helper variables join through a shared variable, and not() excludes", async () => {
    const { List, Practice } = sources;
    const onTagged = view(() => Practice.all({ l: List }, (p: any, { l }: any) => [l.items.practice.is(p), l.kind.is("Tagged")]).map((p: any) => p.name).sort());
    expect((await run(onTagged)).output).toEqual(["Listening circles", "Mutual aid"]);
    const notAda = view(() => Practice.all((p: any) => [not(p.authors.has(ada))]).map((p: any) => p.name).sort());
    expect((await run(notAda)).output).toEqual(["Listening circles", "Neighborhood walks"]);
  });

  test("a count over facts is one aggregate, not rows", async () => {
    const { List } = sources;
    const tagged = view(() => List.all((l: any) => [l.id.is(careList)]).map((l: any) => ({
      items: l.items.length,
      taggedItems: l.items.all((i: any) => [i.practice.tags.list.is(l)]).length,
    })));
    const result = await run(tagged);
    expect(result.output).toEqual([{ items: 2, taggedItems: 1 }]);
    expect(result.statements).toBe(1);
  });

  test("a fact that expects one model's row refuses another's", async () => {
    const { List, Practice } = sources;
    const wrong = view(() => {
      const practice = Practice.one((p: any) => [p.id.is(mutualAid)]);
      return List.all((l: any) => [l.owner.is(practice)]).length;
    });
    await expect(run(wrong)).rejects.toThrow("Expected a Person row, not a Practice row");
  });
});

describe("read rules", () => {
  test("the host adds a model's read rule to every read, so a view that forgets it sees only what the rule allows", async () => {
    const { List, Practice } = sources;
    const everything = view(() => List.all(() => []).map((l: any) => l.id).sort());
    expect((await run(everything)).output).toHaveLength(3);
    expect((await run(everything, undefined, null, { readRules: listRule })).output).not.toContain(privateList);
    expect((await run(everything, undefined, { profile: ada }, { readRules: listRule })).output).toContain(privateList);
    // Through a relationship read and a path fact too.
    const viaPractice = view(() => ({
      // A hidden list reads as null. (Its key, held in the item's own column, isn't hidden.)
      lists: Practice.one((p: any) => [p.id.is(walkingPractice)])!.items.map((i: any) => i.list?.name ?? null),
      onPrivate: Practice.all((p: any) => [p.items.list.id.is(privateList)]).map((p: any) => p.id),
    }));
    expect((await run(viaPractice, undefined, null, { readRules: listRule })).output).toEqual({ lists: [null], onPrivate: [] });
    expect((await run(viaPractice, undefined, { profile: ada }, { readRules: listRule })).output).toEqual({ lists: ["Quiet experiments"], onPrivate: [walkingPractice] });
  });

  test("a forged missed path can't read a row the facts or read rules exclude", async () => {
    const forged = (await run("list", { id: careList }, null, { form: "rows" })).output as RowsAnswer;
    const key = forged.roots[0]!.key;
    // Ask for the same root without the visibility facts: a whole-table read.
    const unrestricted = `List|many|{"orderBy":[]}`;
    const widened = await run("list", { id: careList }, null, { form: "rows", readRules: listRule, missed: [[unrestricted, "name"], [key, "items~", "practice~", "items~", "list~", "name"]] });
    const answer = widened.output as RowsAnswer;
    const names = JSON.stringify(answer);
    expect(names).not.toContain("Quiet experiments");
    expect(answer.roots.find((root) => root.key === unrestricted)?.results[0]?.[1]).toHaveLength(2);
    await expect(run("list", { id: careList }, null, { form: "rows", missed: [["Secret|many|{}", "name"]] })).rejects.toBeInstanceOf(QueryInputError);
  });
});
