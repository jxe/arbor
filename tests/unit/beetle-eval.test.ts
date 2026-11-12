import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { layoutOf, logicalFromRows, rowsFromLogical, setupSql, type LogicalTables, type RowsByTable } from "@ovst/usl";
import { BeetleError, compileProgram, editedLogical, Evaluator, runMutation, StoreSchema, type ViewNode } from "@ovst/beetle";
import { SQLiteStore } from "@ovst/beetle/sqlite";
import { changedCollectionRows, compileLogicalSchema, encodeCollection } from "@ovst/collection-schema";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Materialization } from "../../packages/overstoryd/src/beetle-materialized.ts";
import { exampleFiles } from "../support/beetle-vectors.ts";

const files = exampleFiles();
// Facts the examples don't exercise.
files["/supplies/more.beetle"] = `use "data/schema.beetle"

mutation clash(l List, m List):
  l.name = "One"
  m.name = "Two"

mutation renameAll(owner Person, prefix Text):
  for l in List where l.owner == owner:
    l.name = prefix + l.name

mutation existsAndNot(l List, p Practice):
  Item(list: l, practice: p)
  not Item(list: l, practice: p)
`;
const read = (path: string) => files[path];
const SCHEMA = "/supplies/data/schema.beetle";
const ALICE = "tr_alice", BOB = "tr_bob", CARA = "tr_cara";
const people: Record<string, Record<string, unknown>> = {
  [ALICE]: { name: "Alice", handle: "alice" },
  [BOB]: { name: "Bob", handle: "bob" },
  [CARA]: { name: "Cara", handle: "cara" },
};
const T = "2026-11-01T00:00:00.000Z";

/** Supplies' rows in its database layout. */
function rows(): RowsByTable {
  const at = { created: T, modified: T };
  return {
    List: [
      { id: "L1", name: "Rituals", about: "Small *rituals*", visibility: "Public", kind: "Standard", openToEdits: false, owner: ALICE, ...at },
      { id: "L2", name: "Secret", about: null, visibility: "Private", kind: "Standard", openToEdits: false, owner: BOB, ...at },
      { id: "L3", name: "Open", about: null, visibility: "Public", kind: "Standard", openToEdits: true, owner: BOB, created: T, modified: "2026-11-02T00:00:00.000Z" },
    ],
    Practice: [
      { id: "P1", name: "Gratitude", about: "Say thanks", ...at },
      { id: "P2", name: "Walks", about: "Walk together", ...at },
      { id: "P3", name: "Feasts", about: "Eat together", ...at },
    ],
    Item: [
      { list: "L1", practice: "P2", items_position: 0, ...at },
      { list: "L1", practice: "P1", items_position: 1, ...at },
      { list: "L3", practice: "P3", items_position: 0, ...at },
    ],
    Practice_authors: [
      { practice: "P1", person: ALICE, ...at },
      { practice: "P2", person: BOB, ...at },
      { practice: "P2", person: CARA, ...at },
    ],
    Tag: [{ list: "L1", id: "T1", name: "warm", color: "#f00", ...at }],
    Tag_practices: [{ tag_list: "L1", tag_id: "T1", practice: "P1", ...at }],
    Reaction: [{ list: "L1", person: BOB, emoji: "👍", ...at }],
    Contribution: [],
  };
}

function evaluator(path: string, me: string | null, data = rows()) {
  const program = compileProgram(files[path]!, { path, read });
  expect(program.check.diagnostics).toEqual([]);
  return new Evaluator(program, { [SCHEMA]: data }, { me, now: new Date("2026-11-11T12:00:00Z"), person: (id) => people[id] ?? null });
}

/** Every node of a tree, depth first. */
function nodes(tree: Array<ViewNode | string>): ViewNode[] {
  return tree.flatMap((n) => (typeof n === "string" ? [] : [n, ...nodes(n.children)]));
}
const text = (n: ViewNode | string): string => (typeof n === "string" ? n : n.children.map(text).join(""));

describe("beetle views", () => {
  test("List draws its curators, likes, items in order and their tags", () => {
    const tree = evaluator("/supplies/List.beetle", BOB).view("", { id: "L1" });
    expect(tree).toHaveLength(1);
    expect(tree[0]!.type).toBe("Shell");
    expect(tree[0]!.props.title).toBe("Rituals");
    const all = nodes(tree);
    // The owner's avatar, drawn from the Avatar view in place.
    expect(all.filter((n) => n.type === "Portrait").map((n) => n.props.name)).toEqual(["Alice", "Bob", "Cara", "Alice"]);
    const like = all.find((n) => n.type === "Button")!;
    expect(text(like).trim()).toBe("👍 1");
    expect(like.props.action).toEqual({ action: "toggleListReaction", from: "/supplies/mutations.beetle", args: { l: { row: "List", key: "L1" } } });
    // One column per item, in the list's order; Walks first.
    const columns = all.filter((n) => n.type === "Column");
    expect(columns.map((c) => nodes(c.children).find((n) => n.type === "Link")!.props.to)).toEqual(["Practice?id=P2", "Practice?id=P1"]);
    expect(columns.map((c) => c.key)).toEqual(['[{"list":"L1","practice":"P2"}]', '[{"list":"L1","practice":"P1"}]']);
    const badges = all.filter((n) => n.type === "Badge");
    expect(badges.map((b) => [text(b), b.props.color])).toEqual([["warm", "#f00"]]);
  });

  test("a missing row draws the fallback, and if hides what doesn't hold", () => {
    expect(evaluator("/supplies/List.beetle", BOB).view("", { id: "nope" })[0]!.props.title).toBe("List unavailable");
    const anonymous = nodes(evaluator("/supplies/List.beetle", null).view("", { id: "L1" }));
    expect(anonymous.some((n) => n.type === "Button")).toBe(false);
  });

  test("Home lists public lists, most liked first", () => {
    const all = nodes(evaluator("/supplies/Home.beetle", null).view("", {}));
    const cards = all.filter((n) => n.type === "Card");
    expect(cards.map((c) => text(nodes(c.children).find((n) => n.type === "Link")!))).toEqual(["Rituals", "Open"]);
    expect(text(cards[0]!)).toContain("2 practices");
  });

  test("Profile expands by the names an element uses", () => {
    const all = nodes(evaluator("/supplies/Profile.beetle", null).view("", { id: BOB }));
    // One avatar per collaborator, one line per (practice, collaborator) pair.
    const collaborators = all.filter((n) => n.type === "Section" && n.props.title === "Collaborators");
    expect(nodes(collaborators).filter((n) => n.type === "Portrait").map((n) => n.props.name)).toEqual(["Cara"]);
    const lines = all.filter((n) => n.type === "Text" && text(n).includes(" on "));
    expect(lines.map((n) => text(n).trim())).toEqual(["Cara on Walks"]);
    // Rules with two alternatives: lists Bob owns or contributed to.
    const curated = all.find((n) => n.type === "Section" && n.props.title === "Lists they curate")!;
    expect(nodes([curated]).filter((n) => n.type === "Link" && n.props.style === "heading").map(text)).toEqual(["Open", "Secret"]);
  });

  test("a data view answers JSON", () => {
    const ev = evaluator("/supplies/Feeds.beetle", null);
    expect(ev.data("ListsByOwner", { owner: ALICE })).toEqual({
      lists: [{ name: "Rituals", size: 2, owner: { name: "Alice", handle: "alice" }, practices: [{ name: "Gratitude" }, { name: "Walks" }] }],
    });
    expect(ev.data("OnePractice", { id: "P1" })).toEqual({
      practice: [{ name: "Gratitude", about: "Say thanks", authors: [{ name: "Alice" }], lists: 1, tagged: { tags: [{ name: "warm", color: "#f00" }] } }],
    });
  });

  test("the schema's Rows view groups lines", () => {
    const tree = evaluator(SCHEMA, null).view("ByOwner", {});
    expect(tree[0]!.type).toBe("Rows");
    expect(tree[0]!.children.map((g) => (g as ViewNode).props.value)).toEqual([{ row: "Person", key: ALICE }, { row: "Person", key: BOB }]);
    const bob = tree[0]!.children[1] as ViewNode;
    // Newest first within the group.
    expect(bob.children.map((line) => text((line as ViewNode).children[1]!))).toEqual(["Open", "Secret"]);
    expect((bob.children[0] as ViewNode).children[0]).toMatchObject({ type: "Bullet", props: { value: { enum: "Visibility", name: "Public" } } });
  });
});

describe("beetle mutations", () => {
  const mutate = (me: string | null, name: string, input: unknown, data = rows()) =>
    runMutation(evaluator("/supplies/mutations.beetle", me, data), name, input, { mutationID: "m-1" });
  const failure = (fn: () => unknown) => {
    try {
      fn();
    } catch (error) {
      if (error instanceof BeetleError) return [error.code, error.message];
      throw error;
    }
    return null;
  };

  test("toggleListReaction removes a like and adds one", () => {
    const off = mutate(BOB, "toggleListReaction", { l: "L1" });
    expect(off.rows[SCHEMA]!.Reaction).toEqual([]);
    expect(off.writes).toEqual({ Reaction: [{ list: "L1", person: BOB }] });
    const on = mutate(ALICE, "toggleListReaction", { l: "L1" });
    expect(on.rows[SCHEMA]!.Reaction!.map((r) => [r.person, r.emoji]).sort()).toEqual([[ALICE, "👍"], [BOB, "👍"]]);
  });

  test("public errors come first and write nothing", () => {
    expect(failure(() => mutate(null, "toggleListReaction", { l: "L1" }))).toEqual(["unauthorized", "This operation requires a Story user"]);
    expect(failure(() => mutate(ALICE, "toggleListReaction", { l: "L2" }))).toEqual(["missing", "Only public lists can be liked"]);
    expect(failure(() => mutate(BOB, "renameList", { l: "L1", name: "Mine" }))).toEqual(["forbidden", "Only the owner can rename this list"]);
    expect(failure(() => mutate(BOB, "renameList", { l: "nope", name: "x" }))?.[0]).toBe("missing");
    expect(failure(() => mutate(ALICE, "setListSharing", { l: "L1", visibility: "Everyone", openToEdits: true }))?.[0]).toBe("invalid");
  });

  test("createList makes a row whose id comes from the mutation identity", () => {
    const a = mutate(ALICE, "createList", { name: "New", visibility: "Private" });
    const b = mutate(ALICE, "createList", { name: "New", visibility: "Private" });
    const made = a.rows[SCHEMA]!.List!.find((l) => l.name === "New")!;
    expect(made).toMatchObject({ owner: ALICE, visibility: "Private", kind: "Standard", openToEdits: false });
    expect(made.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5/);
    expect(b.rows[SCHEMA]!.List!.find((l) => l.name === "New")!.id).toBe(made.id);
  });

  test("setListPractice appends an item and records a contributor with the default date", () => {
    const out = mutate(BOB, "setListPractice", { l: "L3", p: "P1", included: true });
    const items = out.rows[SCHEMA]!.Item!.filter((i) => i.list === "L3").sort((x, y) => Number(x.items_position) - Number(y.items_position));
    expect(items.map((i) => i.practice)).toEqual(["P3", "P1"]);
    // Bob owns L3: no contribution.
    expect(out.rows[SCHEMA]!.Contribution).toEqual([]);
    const cara = mutate(CARA, "setListPractice", { l: "L3", p: "P2", included: true });
    expect(cara.rows[SCHEMA]!.Contribution).toEqual([expect.objectContaining({ list: "L3", person: CARA, first: "2026-11-11", last: "2026-11-11" })]);
    expect(failure(() => mutate(CARA, "setListPractice", { l: "L1", p: "P3", included: true }))?.[0]).toBe("forbidden");
  });

  test("reorderList writes the connection as a whole, in order", () => {
    const out = mutate(ALICE, "reorderList", { l: "L1", practices: ["P1", "P3", "P2"] });
    const items = out.rows[SCHEMA]!.Item!.filter((i) => i.list === "L1").sort((x, y) => Number(x.items_position) - Number(y.items_position));
    expect(items.map((i) => i.practice)).toEqual(["P1", "P3", "P2"]);
  });

  test("tags: a join row is added, and deleting a tag takes its taggings", () => {
    const tagged = mutate(ALICE, "setPracticeTag", { l: "L1", p: "P2", t: { list: "L1", id: "T1" }, included: true });
    expect(tagged.rows[SCHEMA]!.Tag_practices!.map((r) => r.practice).sort()).toEqual(["P1", "P2"]);
    const gone = mutate(ALICE, "deleteListTag", { l: "L1", t: { list: "L1", id: "T1" } });
    expect(gone.rows[SCHEMA]!.Tag).toEqual([]);
    expect(gone.rows[SCHEMA]!.Tag_practices).toEqual([]);
    expect(failure(() => mutate(ALICE, "setPracticeTag", { l: "L1", p: "P3", t: { list: "L1", id: "T1" }, included: true }))?.[0]).toBe("invalid");
  });

  test("createPractice names its new row with let and adds it to a list", () => {
    const out = mutate(BOB, "createPractice", { name: "Songs", about: "Sing", addToList: "L3" });
    const practice = out.rows[SCHEMA]!.Practice!.find((p) => p.name === "Songs")!;
    expect(out.rows[SCHEMA]!.Practice_authors!.filter((a) => a.practice === practice.id).map((a) => a.person)).toEqual([BOB]);
    expect(out.rows[SCHEMA]!.Item!.filter((i) => i.list === "L3").map((i) => i.practice).sort()).toEqual(["P3", practice.id].sort());
  });

  test("duplicateList copies the items into a new list's connection", () => {
    const out = mutate(BOB, "duplicateList", { original: "L1" });
    const copy = out.rows[SCHEMA]!.List!.find((l) => l.name === "Copy of Rituals")!;
    const items = out.rows[SCHEMA]!.Item!.filter((i) => i.list === copy.id).sort((x, y) => Number(x.items_position) - Number(y.items_position));
    expect(items.map((i) => i.practice)).toEqual(["P2", "P1"]);
  });

  test("facts that can't both hold are a conflict; for blocks hold per match", () => {
    const more = (name: string, input: unknown) => runMutation(evaluator("/supplies/more.beetle", ALICE), name, input, { mutationID: "m-2" });
    expect(failure(() => more("clash", { l: "L1", m: "L1" }))?.[0]).toBe("conflict");
    expect(failure(() => more("existsAndNot", { l: "L1", p: "P1" }))?.[0]).toBe("conflict");
    const renamed = more("renameAll", { owner: BOB, prefix: "Bob's " });
    expect(renamed.rows[SCHEMA]!.List!.map((l) => l.name)).toEqual(["Rituals", "Bob's Secret", "Bob's Open"]);
    expect(renamed.writes).toEqual({ List: ["L2", "L3"] });
  });

  test("the rows afterwards read back as logical tables", () => {
    const ev = evaluator("/supplies/mutations.beetle", BOB);
    const { result, layout } = ev.stores.get(SCHEMA)!.schema;
    const out = mutate(BOB, "setListPractice", { l: "L3", p: "P1", included: true });
    const after = logicalFromRows(result, layout, out.rows[SCHEMA]!, { now: 1 });
    expect(after.List!.find((l) => l.key[0]![1] === "L3")!.fields.items).toEqual([[["list", "L3"], ["practice", "P3"]], [["list", "L3"], ["practice", "P1"]]]);
    // And back to the same rows.
    const again = rowsFromLogical(result, layout, after);
    expect(again.Item!.filter((i) => i.list === "L3").map((i) => [i.practice, i.items_position])).toEqual([["P1", 1], ["P3", 0]]);
  });
});

describe("beetle over SQLite", () => {
  /** Supplies' rows written to a SQLite file in the database layout. */
  function database(data: RowsByTable): Database {
    const program = compileProgram(files[SCHEMA]!, { path: SCHEMA, read });
    const result = program.checker.schemas.get(SCHEMA)!.result;
    const db = new Database(":memory:", { strict: true });
    const layout = layoutOf(result, { store: "database" });
    db.exec(setupSql(layout, "sqlite"));
    for (const table of layout) {
      for (const row of data[table.name] ?? []) {
        const columns = Object.keys(row);
        db.query(`insert into "${table.name}" (${columns.map((c) => `"${c}"`).join(", ")}) values (${columns.map(() => "?").join(", ")})`)
          .run(...columns.map((c) => (typeof row[c] === "boolean" ? (row[c] ? 1 : 0) : row[c] ?? null)) as never[]);
      }
    }
    return db;
  }

  function both(path: string, me: string | null) {
    const memory = evaluator(path, me);
    const program = compileProgram(files[path]!, { path, read });
    const person = (id: string) => people[id] ?? null;
    const store = new SQLiteStore(new StoreSchema(program.checker.schemas.get(SCHEMA)!.result), database(rows()), person);
    const sqlite = new Evaluator(program, new Map([[SCHEMA, store]]), { me, now: new Date("2026-11-11T12:00:00Z"), person });
    return { memory, sqlite, store };
  }

  const cases: Array<[string, string | null, string, Record<string, unknown>, boolean]> = [
    ["/supplies/List.beetle", BOB, "", { id: "L1" }, false],
    ["/supplies/List.beetle", BOB, "", { id: "nope" }, false],
    ["/supplies/List.beetle", null, "", { id: "L1" }, false],
    ["/supplies/Home.beetle", null, "", {}, false],
    ["/supplies/Profile.beetle", null, "", { id: BOB }, false],
    ["/supplies/Feeds.beetle", null, "ListsByOwner", { owner: ALICE }, true],
    ["/supplies/Feeds.beetle", null, "OnePractice", { id: "P1" }, true],
    [SCHEMA, null, "ByOwner", {}, false],
  ];
  for (const [path, me, name, input, data] of cases) {
    test(`${path}${name ? `?view=${name}` : ""} ${JSON.stringify(input)} answers the same from SQLite`, () => {
      const { memory, sqlite } = both(path, me);
      if (data) expect(sqlite.data(name, input)).toEqual(memory.data(name, input));
      else expect(sqlite.view(name, input)).toEqual(memory.view(name, input));
    });
  }

  test("a view reads each table it ranges over once, with every relationship it follows from the rows nested in the same statement", () => {
    const counts = cases.map(([path, me, name, input, data]) => {
      const { sqlite, store } = both(path, me);
      if (data) sqlite.data(name, input); else sqlite.view(name, input);
      return [`${path}${name ? `?view=${name}` : ""}`, store.statements.length];
    });
    // Profile: the people any row names, then Practice and List once each. OnePractice: the practice, then List for its count.
    expect(counts).toEqual([
      ["/supplies/List.beetle", 1], ["/supplies/List.beetle", 1], ["/supplies/List.beetle", 1], ["/supplies/Home.beetle", 1],
      ["/supplies/Profile.beetle", 3], ["/supplies/Feeds.beetle?view=ListsByOwner", 1], ["/supplies/Feeds.beetle?view=OnePractice", 2],
      ["/supplies/data/schema.beetle?view=ByOwner", 1],
    ]);
  });

  test("a for over a table reads only the rows its conditions keep", () => {
    const { sqlite, store } = both("/supplies/List.beetle", BOB);
    sqlite.view("", { id: "L1" });
    const lists = store.statements.filter((s) => s.sql.includes('from "List" as "r0"'));
    expect(lists.length).toBeGreaterThan(0);
    expect(lists.every((s) => s.sql.includes("where"))).toBe(true);
  });

  test("a for whose conditions and ordering are all on the row's columns reads only what its limit keeps", () => {
    const { sqlite, store } = both("/supplies/Feeds.beetle", null);
    sqlite.data("ListsByOwner", { owner: ALICE });
    expect(store.statements[0]!.sql).toEndWith(' from "List" as "r0" where "owner" is ? order by ("modified" is null) desc, "modified" desc, "id" limit 20');
    expect(store.statements[0]!.parameters).toEqual([ALICE]);
  });

  /** The logical rows that differ between two sets of logical tables, by model and key. */
  function changes(before: LogicalTables, after: LogicalTables): Record<string, [unknown, unknown]> {
    const out: Record<string, [unknown, unknown]> = {};
    const index = (tables: LogicalTables) => new Map(Object.entries(tables).flatMap(([model, list]) => list.map((row) => [`${model} ${JSON.stringify(row.key)}`, row] as const)));
    const b = index(before), a = index(after);
    for (const key of new Set([...b.keys(), ...a.keys()])) {
      const x = b.get(key) ?? null, y = a.get(key) ?? null;
      if (JSON.stringify(x) !== JSON.stringify(y)) out[key] = [x, y];
    }
    return out;
  }

  const mutations: Array<[string, string, string, unknown]> = [
    ["/supplies/mutations.beetle", BOB, "toggleListReaction", { l: "L1" }],
    ["/supplies/mutations.beetle", ALICE, "toggleListReaction", { l: "L1" }],
    ["/supplies/mutations.beetle", ALICE, "createList", { name: "New", visibility: "Private" }],
    ["/supplies/mutations.beetle", ALICE, "renameList", { l: "L1", name: "Mine" }],
    ["/supplies/mutations.beetle", BOB, "setListPractice", { l: "L3", p: "P1", included: true }],
    ["/supplies/mutations.beetle", CARA, "setListPractice", { l: "L3", p: "P2", included: true }],
    ["/supplies/mutations.beetle", BOB, "setListPractice", { l: "L3", p: "P3", included: false }],
    ["/supplies/mutations.beetle", ALICE, "reorderList", { l: "L1", practices: ["P1", "P3", "P2"] }],
    ["/supplies/mutations.beetle", ALICE, "setPracticeTag", { l: "L1", p: "P2", t: { list: "L1", id: "T1" }, included: true }],
    ["/supplies/mutations.beetle", ALICE, "deleteListTag", { l: "L1", t: { list: "L1", id: "T1" } }],
    ["/supplies/mutations.beetle", BOB, "createPractice", { name: "Songs", about: "Sing", addToList: "L3" }],
    ["/supplies/mutations.beetle", BOB, "duplicateList", { original: "L1" }],
    ["/supplies/more.beetle", ALICE, "renameAll", { owner: BOB, prefix: "Bob's " }],
  ];
  for (const [path, me, name, input] of mutations) {
    test(`${name} ${JSON.stringify(input)} as ${me}: the touched rows give the same logical changes as whole collections`, () => {
      const whole = runMutation(evaluator(path, me), name, input, { mutationID: "m-1" });
      const { result, layout } = evaluator(path, me).stores.get(SCHEMA)!.schema;
      const expected = changes(logicalFromRows(result, layout, rows(), { now: 1 }), logicalFromRows(result, layout, whole.rows[SCHEMA]!, { now: 1 }));
      expect(Object.keys(expected).length).toBeGreaterThan(0);
      const { sqlite, store } = both(path, me);
      const outcome = runMutation(sqlite, name, input, { mutationID: "m-1" });
      const { before, after } = outcome.changed[SCHEMA]!;
      expect(before).toBe(store);
      const touched = editedLogical(before, after, after.edits(), 1);
      expect(changes(touched.before, touched.after)).toEqual(expected);
      // The SQLite rows themselves are as they were.
      expect(store.data()).toEqual(new SQLiteStore(store.schema, database(rows()), store.personFields).data());
    });
  }

  for (const [path, me, name, input] of mutations) {
    test(`${name} ${JSON.stringify(input)} as ${me}: a copy caught up from the changed chunks equals one built afresh`, async () => {
      const outcome = runMutation(evaluator(path, me), name, input, { mutationID: "m-1" });
      const logicalSchema = compileLogicalSchema(files[SCHEMA]!);
      const schema = new StoreSchema(logicalSchema.result);
      // Rows as the tree holds them, with every row's times.
      const settled = (data: RowsByTable) => rowsFromLogical(schema.result, schema.layout, logicalFromRows(schema.result, schema.layout, data, { now: 1 }));
      const encode = (data: RowsByTable) => encodeCollection(logicalSchema, logicalFromRows(schema.result, schema.layout, data, { now: 1 }));
      const before = encode(rows()), after = encode(outcome.rows[SCHEMA]!);
      const objects = new Map([...before.objects, ...after.objects]);
      const read: string[] = [];
      const load = async (hash: string) => { read.push(hash); return objects.get(hash as never)!; };
      const changes = await changedCollectionRows(logicalSchema, before.reference, after.reference, load);
      expect(Object.keys(changes).length).toBeGreaterThan(0);
      // Unchanged tables aren't read.
      const changedTables = new Set([...before.reference.tables, ...after.reference.tables].filter((t, i, all) => all.filter((u) => u.model === t.model).some((u) => u.table !== t.table)).map((t) => t.table));
      const unchanged = before.reference.tables.map((t) => t.table).filter((h) => !changedTables.has(h));
      expect(read.filter((h) => unchanged.includes(h as never))).toEqual([]);
      const dir = mkdtempSync(join(tmpdir(), "beetle-copy-"));
      try {
        const layout = schema.layout;
        const caught = Materialization.build(join(dir, "a"), layout, settled(rows()), "d1", "s");
        caught.applyChanges(schema, changes, "d2");
        const fresh = Materialization.build(join(dir, "b"), layout, settled(outcome.rows[SCHEMA]!), "d2", "s");
        const dump = (m: Materialization) => Object.fromEntries(layout.map((t) => [t.name, m.database.query(`select * from "${t.name}" order by ${t.primaryKey.map((k) => `"${k}"`).join(", ")}`).all()]));
        expect(dump(caught)).toEqual(dump(fresh));
        expect(caught.directory).toBe("d2");
        caught.close();
        fresh.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
