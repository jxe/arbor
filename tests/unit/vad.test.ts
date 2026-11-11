import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compileUsl, layoutOf, modelLayer } from "@ovst/usl";
import { checkView, compileSchema, formatPage, formatView, parseView, viewBlocks, type ElementPlan } from "@ovst/vad";
import { exampleFiles, vadVectors } from "../support/vad-vectors.ts";

const files = exampleFiles();
const read = (path: string) => files[path];
const check = (path: string) => checkView(files[path]!, { path, read });
const sources = (dir: string) => Object.keys(files).filter((p) => p.startsWith(dir));

describe("vad examples", () => {
  for (const path of sources("/supplies/")) {
    test(`${path} checks clean`, () => {
      expect(check(path).diagnostics).toEqual([]);
    });
  }
});

// A file without `// expect:` lines is a helper the others use, and checks clean.
describe("vad broken examples", () => {
  for (const path of sources("/invalid/")) {
    test(`${path} reports exactly what it expects, at or after each expect`, () => {
      const lines = files[path]!.split("\n");
      const expected = lines
        .flatMap((line, i) => {
          const m = /^\s*\/\/ expect: ([a-z-]+)$/.exec(line);
          if (!m) return [];
          // The diagnostic is on the next line that isn't another expect comment.
          let at = i + 1;
          while (/^\s*\/\/ expect:/.test(lines[at] ?? "")) at += 1;
          return [`${at + 1} ${m[1]}`];
        })
        .sort();
      const own = check(path).diagnostics.filter((d) => !d.path);
      expect(own.map((d) => d.code).sort()).toEqual(expected.map((e) => e.split(" ")[1]!).sort());
      for (const d of own) expect(expected.some((e) => e.endsWith(" " + d.code) && Number(e.split(" ")[0]) <= d.line)).toBe(true);
    });
  }
});

describe("vad schemas", () => {
  test("Supplies' schema.vad has the same data layer and layout as its schema.usl", () => {
    const vad = compileSchema(files["/supplies/data/schema.vad"]!);
    const usl = compileUsl(readFileSync(join(import.meta.dir, "../../examples/supplies/data/schema.usl"), "utf8"));
    expect(vad.diagnostics).toEqual([]);
    expect(modelLayer(vad)).toEqual(modelLayer(usl));
    expect(layoutOf(vad)).toEqual(layoutOf(usl));
    expect(vad.defaults).toEqual({ Contribution: { first: expect.objectContaining({ kind: "name", name: "today" }) } });
  });

  test("defaults, state tables and the schema's own views leave the data layer alone", () => {
    const base = "main table Note:\n  text Text\n";
    const more = "main table Note:\n  text Text = \"\"  // a default\n\nmy table Pin:\n  note Note\n\nview Recent():\n  <Rows for={n in Note}>\n    <Text>{n.text}</Text>\n  </Rows>\n";
    expect(modelLayer(compileSchema(more))).toEqual(modelLayer(compileSchema(base)));
  });

  test("data tables belong in schema.vad", () => {
    const result = checkView("table Note:\n  text Text\n", { path: "/Notes.vad" });
    expect(result.diagnostics.map((d) => d.code)).toEqual(["data-table-outside-schema"]);
  });

  test("a schema.vad checks its own tables, and its views read them", () => {
    const result = checkView(files["/supplies/data/schema.vad"]!, { path: "/supplies/data/schema.vad", read });
    expect(result.diagnostics).toEqual([]);
    expect(result.views.map((v) => v.name)).toEqual(["ByOwner"]);
    expect(result.views[0]!.plan).toMatchObject({ type: "Rows", group: { path: { name: "l" }, fields: ["owner"] } });
    const broken = checkView("table A:\n  b B\n", { path: "/schema.vad" });
    expect(broken.diagnostics.map((d) => d.code)).toEqual(["unknown-type"]);
  });
});

describe("vad formatting", () => {
  for (const path of Object.keys(files).filter((p) => p !== "/invalid/syntax.vad")) {
    test(`${path} is in the conventional form`, () => {
      const format = path.endsWith(".md") ? (text: string) => formatPage(text, formatView) : formatView;
      expect(format(files[path]!)).toBe(files[path]!);
    });
  }

  test("a page's blocks are formatted and its prose kept", () => {
    const page = "# Title\n\nSome *prose*.\n\n```view\nview   Late( ) :\n  <Text   if={ not  page.done }>late</Text>\n```\n";
    expect(formatPage(page, formatView)).toBe("# Title\n\nSome *prose*.\n\n```view\nview Late():\n  <Text if={not page.done}>late</Text>\n```\n");
  });

  test("formatting keeps comments, lines up fields and connections, and wraps long facts", () => {
    const source = [
      "table Tag (list, id):  // why",
      "  name Text",
      "  color   Text? ~color",
      "",
      "Tag.list <-> List.tags[]",
      "Tag.practices[]   <-> Practice.tags[]",
      "",
      "mutation m(l List, longName Text):",
      "  if me == null:",
      "    unauthorized",
      "  List(name: longName, about: longName, visibility: Public, kind: Standard, openToEdits: true, owner: me)",
      "",
    ].join("\n");
    expect(formatView(source)).toBe([
      "table Tag (list, id):  // why",
      "  name  Text",
      "  color Text? ~color",
      "",
      "Tag.list        <-> List.tags[]",
      "Tag.practices[] <-> Practice.tags[]",
      "",
      "mutation m(l List, longName Text):",
      "  if me == null:",
      "    unauthorized",
      "  List(name: longName, about: longName, visibility: Public, kind: Standard, openToEdits: true,",
      "       owner: me)",
      "",
    ].join("\n"));
  });

  test("a data view's record stays on one line only when it was written on one", () => {
    const source = "view A(o Person) {\n  x: { name, size: count(l.items) }   orderBy={l.name} for={l in List}\n  // note\n\n  y: 1, z: { a: 2 }  if={ o != null }\n}\n";
    expect(formatView(source)).toBe("view A(o Person) {\n  x: { name, size: count(l.items) } for={l in List} orderBy={l.name}\n  // note\n\n  y: 1\n  z: { a: 2 } if={o != null}\n}\n");
  });

  test("a source with syntax errors isn't formatted", () => {
    expect(() => formatView("view(:\n  <Text/>\n")).toThrow();
  });
});

describe("vad parsing", () => {
  test("expressions follow the spec's precedence", () => {
    const { file } = parseView("rule r(a, b, c):\n  a or b and not c == 1 + 2 * 3 ?? 4\n");
    const decl = file.declarations[0]!.decl;
    expect(decl.kind).toBe("rule");
    if (decl.kind !== "rule") return;
    // ?? binds loosest of these, then or, and, comparison, +, *.
    const line = decl.body[0]!;
    expect(line.kind === "condition" && line.condition.kind === "binary" && line.condition.operator).toBe("??");
    expect(formatView("rule r(a, b, c):\n  (a or b) and c\n")).toBe("rule r(a, b, c):\n  (a or b) and c\n");
    expect(formatView("rule r(a, b):\n  a in b.x and not (b.y excludes a)\n  a ∉ b.z\n")).toBe("rule r(a, b):\n  a in b.x and not (b.y excludes a)\n  a ∉ b.z\n");
  });

  test("a header's `:` ends its line, and old forms say what to write", () => {
    const codes = (text: string) => parseView(text).diagnostics.map((d) => d.message);
    expect(codes("view(): <Text/>\n")[0]).toContain("Nothing follows ':'");
    expect(codes("model List:\n  name Text\n")[0]).toContain("Write `table`");
    expect(codes("r(a): a == 1\n")[0]).toContain("rule r(…):");
  });

  test("element text collapses whitespace; spans are 1-based", () => {
    const { file, diagnostics } = parseView("view():\n  <Text>\n    {a}  and\n    {b}\n  </Text>\n");
    expect(diagnostics).toEqual([]);
    const decl = file.declarations[0]!.decl;
    if (decl.kind !== "view") throw new Error("expected a view");
    const child = decl.body!.children![0]!;
    expect(child.kind).toBe("text");
    if (child.kind === "text") expect(child.parts.map((p) => (typeof p === "string" ? p : "{}"))).toEqual(["{}", " and ", "{}"]);
    expect(decl.body!.span).toMatchObject({ line: 2, column: 3, endLine: 5, endColumn: 10 });
  });

  test("a broken declaration doesn't hide the next", () => {
    const { file, diagnostics } = parseView("view(:\n  <Text/>\n\nview Ok():\n  <Text/>\n");
    expect(diagnostics.map((d) => [d.line, d.code])).toEqual([[1, "syntax"]]);
    expect(file.declarations.map((d) => d.decl.kind)).toEqual(["view"]);
  });

  test("view blocks are found by their info string, with their page lines", () => {
    const blocks = viewBlocks("# A\n\n```js\nx\n```\n\n```view\n<Text/>\n```\n");
    expect(blocks).toEqual([{ text: "<Text/>", line: 8 }]);
  });
});

function find(plan: ElementPlan | null, type: string): ElementPlan[] {
  if (!plan) return [];
  return [...(plan.type === type ? [plan] : []), ...(plan.children ?? []).flatMap((c) => find(c, type)), ...find(plan.fallback ?? null, type)];
}

describe("vad plans", () => {
  test("Profile: a person by id, their practices, and collaborators joined through p", () => {
    const [view] = check("/supplies/Profile.vad").views;
    expect(view!.params).toEqual([{ name: "id", type: "Text", arity: "one" }]);
    const plan = view!.plan!;
    expect(plan.for).toEqual([{ name: "person", source: { model: "Person" } }]);
    expect(plan.where).toEqual([{ op: "==", args: [{ path: { name: "person" }, fields: ["id"] }, { param: "id" }] }]);
    expect(plan.reads).toEqual([{ path: { name: "person" }, fields: ["name"] }, { path: { name: "person" }, fields: ["handle"] }]);
    const avatars = find(plan, "Avatar");
    // p joins without multiplying the avatar: it appears once per collaborator.
    expect(avatars[0]!.expandsBy).toEqual(["other"]);
    expect(avatars[0]!.draws).toMatchObject({ view: "Avatar", from: "/supplies/parts/cards.vad", args: { person: { name: "other" } } });
    // The Text that shows both names expands by both.
    expect(find(plan, "Text")[0]!.expandsBy).toEqual(["p", "other"]);
    // A rule is expanded in place; its two declarations are alternatives.
    const curated = find(plan, "ListCard").find((c) => c.orderBy)!;
    expect(curated.where).toEqual([{
      op: "or",
      args: [
        { op: "==", args: [{ path: { name: "l" }, fields: ["owner"] }, { name: "person" }] },
        { op: "in", args: [{ name: "person" }, { path: { name: "l" }, fields: ["contributors", "person"] }] },
      ],
    }]);
  });

  test("Home: an enum value by name, ordered by a count and cut by the host", () => {
    const plan = check("/supplies/Home.vad").views[0]!.plan!;
    expect(plan).toMatchObject({
      type: "ListCard",
      where: [{ op: "==", args: [{ path: { name: "l" }, fields: ["visibility"] }, { enum: "Visibility", value: "Public" }] }],
      orderBy: [{ value: { call: "count", args: [{ path: { name: "l" }, fields: ["reactions"] }] }, desc: true }],
      limit: { value: 12 },
    });
  });

  test("Practices: conditions and orderings that read state go to the client", () => {
    const view = check("/supplies/Practices.vad").views[0]!;
    expect(view.state).toEqual([{ name: "q", kind: "state" }, { name: "sortBy", kind: "keep" }]);
    const card = view.plan!;
    expect(card.where).toBeUndefined();
    expect(card.clientWhere).toHaveLength(1);
    expect(card.clientOrderBy).toHaveLength(1);
    expect(card.for).toEqual([{ name: "p", source: { model: "Practice" } }]);
  });

  test("List: if on an element without for, split between host and client", () => {
    const plan = check("/supplies/List.vad").views[0]!.plan!;
    expect(find(plan, "Button")[0]!.if).toHaveLength(2);
    expect(find(plan, "Row").find((r) => r.clientIf)!.clientIf).toEqual([{ state: "showTags" }]);
  });

  test("Timer: a state table is read on the client, and its mutation writes it", () => {
    const result = check("/supplies/Timer.vad");
    expect(result.views[0]!.events).toEqual(["every 1s"]);
    expect(result.mutations[0]!.writes).toEqual([{ op: "insert", table: "Lap", fields: ["at", "label"] }]);
  });

  test("Feeds: a data view's plan follows its record", () => {
    const [byOwner] = check("/supplies/Feeds.vad").views;
    expect(byOwner!.plan).toBeNull();
    const lists = byOwner!.data!.entries[0]!;
    expect(lists).toMatchObject({
      key: "lists",
      for: [{ name: "l", source: { model: "List" } }],
      where: [{ op: "==", args: [{ path: { name: "l" }, fields: ["owner"] }, { param: "owner" }] }],
      orderBy: [{ value: { path: { name: "l" }, fields: ["modified"] }, desc: true }],
      limit: { value: 20 },
    });
    expect("record" in lists && lists.record!.entries.map((e) => e.key)).toEqual(["name", "size", "owner", "practices"]);
    expect("record" in lists && lists.record!.entries[2]).toEqual({ key: "owner", field: "owner", record: { entries: [{ key: "name", field: "name" }, { key: "handle", field: "handle" }] } });
  });

  test("a page's blocks: unnamed views are #n, named ones keep their names", () => {
    expect(check("/supplies/Today.md").views.map((v) => v.name)).toEqual(["#1", "Late"]);
  });
});

describe("vad mutations", () => {
  const mutations = Object.fromEntries(check("/supplies/mutations.vad").mutations.map((m) => [m.name, m]));

  test("all 13 Supplies mutations, plus the shared step", () => {
    expect(Object.keys(mutations).filter((n) => n !== "recordContributor")).toHaveLength(13);
  });

  test("a fact giving the whole key is an upsert, one without it a new row", () => {
    expect(mutations.toggleListReaction!.writes).toEqual([
      { op: "delete", table: "Reaction" },
      { op: "upsert", table: "Reaction", fields: ["emoji", "list", "person"] },
    ]);
    expect(mutations.createListTag!.writes).toEqual([{ op: "insert", table: "Tag", fields: ["color", "list", "name"] }]);
  });

  test("writes include what called mutations add; field lines are updates", () => {
    expect(mutations.setListPractice!.writes).toEqual([
      { op: "upsert", table: "Contribution", fields: ["last", "list", "person"] },
      { op: "delete", table: "Item" },
      { op: "upsert", table: "Item", fields: ["list", "practice"] },
    ]);
    expect(mutations.reorderList!.writes).toContainEqual({ op: "update", table: "List", fields: ["items"] });
    expect(mutations.reorderList!.params).toEqual([
      { name: "l", type: "List", arity: "one" },
      { name: "practices", type: "Practice", arity: "many" },
    ]);
  });

  test("let names and public errors are part of the result", () => {
    expect(mutations.createPractice!.lets).toEqual([{ name: "practice", table: "Practice" }]);
    expect(mutations.createPractice!.errors).toEqual(["unauthorized", "forbidden"]);
    expect(mutations.toggleListReaction!.errors).toEqual(["unauthorized", "missing"]);
  });
});

describe("vad conformance vectors", () => {
  test("docs/overstory-spec/conformance/vad.json is current", () => {
    const stored = JSON.parse(readFileSync(join(import.meta.dir, "../../docs/overstory-spec/conformance/vad.json"), "utf8"));
    expect(stored).toEqual(JSON.parse(JSON.stringify(vadVectors())));
  });
});

describe("converting schema.usl to schema.vad", () => {
  const root = join(import.meta.dir, "../..");
  const schemas = [
    "examples/supplies/data/schema.usl",
    "tests/fixtures/workspace/books/schema.usl",
    "tools/directory-seed/people/schema.usl",
    "tools/directory-seed/trees/schema.usl",
    ...["books", "excellences", "games", "stress", "supplies"].map((name) => `packages/usl/examples/${name}.usl`),
  ];
  for (const path of schemas) {
    test(`${path} converts to the same tables, layout and presentation, formatted`, async () => {
      const { convertVerified } = await import("../../tools/convert-usl-to-vad.ts");
      const vad = convertVerified(readFileSync(join(root, path), "utf8"));
      expect(formatView(vad)).toBe(vad);
    });
  }

  test("~views keeps names with attributes, paths and quoted mentions", () => {
    const source = [
      "main table Game:",
      "  name   Text",
      "  status Status",
      "",
      "Game.status <-> Status.games[]",
      "",
      "enum Status:",
      "  Draft",
      '  "In review"',
      "",
      "re Game:",
      '  ~views([{ label: "By game", line: [status ~bullet, name, name ~label("title")], sort: modified }])',
      "",
      "re Status:",
      '  "In review" ~color("#bd861a")',
      "",
    ].join("\n");
    expect(formatView(source)).toBe(source);
    const schema = compileSchema(source);
    expect(schema.diagnostics).toEqual([]);
    const game = schema.models.find((m) => m.name === "Game")!;
    expect(JSON.stringify(game)).toContain('"bullet"');
  });
});
