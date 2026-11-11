import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkView, formatPage, formatView, parseView, viewBlocks, type ElementPlan } from "@ovst/uvl";
import { exampleFiles, viewLanguageVectors } from "../support/view-language-vectors.ts";

const files = exampleFiles();
const read = (path: string) => files[path];
const check = (path: string) => checkView(files[path]!, { path, read });
const sources = (dir: string) => Object.keys(files).filter((p) => p.startsWith(dir) && !p.endsWith(".usl"));

describe("uvl examples", () => {
  for (const path of sources("/supplies/")) {
    test(`${path} checks clean`, () => {
      expect(check(path).diagnostics).toEqual([]);
    });
  }
});

// A file without `// expect:` lines is a helper the others use, and checks clean.
describe("uvl broken examples", () => {
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

describe("uvl formatting", () => {
  for (const path of Object.keys(files).filter((p) => p.endsWith(".view") && p !== "/invalid/syntax.view")) {
    test(`${path} is in the conventional form`, () => {
      expect(formatView(files[path]!)).toBe(files[path]!);
    });
  }

  test("a page's blocks are formatted and its prose kept", () => {
    const page = "# Title\n\nSome *prose*.\n\n```view\nview   Late( ) :\n  <Text   where={ not  page.done }>late</Text>\n```\n";
    expect(formatPage(page, formatView)).toBe("# Title\n\nSome *prose*.\n\n```view\nview Late():\n  <Text where={not page.done}>late</Text>\n```\n");
  });

  test("formatting keeps comments, aligns guards, and wraps long records", () => {
    const source = [
      "mutation m(l: List, longName: Text):  // why",
      "  require me != null else user-required",
      "  require l.owner == me else permission-denied \"no\"",
      "  update l { name: longName, about: longName, visibility: \"Public\", kind: \"Standard\", openToEdits: true }",
      "",
    ].join("\n");
    expect(formatView(source)).toBe([
      "mutation m(l: List, longName: Text):  // why",
      "  require me != null    else user-required",
      "  require l.owner == me else permission-denied \"no\"",
      "  update l { name: longName, about: longName, visibility: \"Public\", kind: \"Standard\",",
      "             openToEdits: true }",
      "",
    ].join("\n"));
  });

  test("a source with syntax errors isn't formatted", () => {
    expect(() => formatView("view(:\n  <Text/>\n")).toThrow();
  });
});

describe("uvl parsing", () => {
  test("expressions follow the spec's precedence", () => {
    const { file } = parseView("r(a, b, c): a or b and not c == 1 + 2 * 3 ?? 4\n");
    const decl = file.declarations[0]!.decl;
    expect(decl.kind).toBe("rule");
    if (decl.kind !== "rule") return;
    // ?? binds loosest of these, then or, and, comparison, +, *.
    expect(decl.body.kind === "binary" && decl.body.operator).toBe("??");
    expect(formatView("r(a, b, c): (a or b) and c\n")).toBe("r(a, b, c): (a or b) and c\n");
    expect(formatView("r(a, b): a in b.x and not (a not in b.y)\n")).toBe("r(a, b): a in b.x and not (a not in b.y)\n");
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

describe("uvl plans", () => {
  test("Profile: a person by id, their practices, and collaborators joined through p", () => {
    const [view] = check("/supplies/Profile.view").views;
    expect(view!.params).toEqual([{ name: "id", type: "Text", arity: "one" }]);
    const plan = view!.plan!;
    expect(plan.for).toEqual([{ name: "person", source: { model: "Person" } }]);
    expect(plan.where).toEqual([{ op: "==", args: [{ path: { name: "person" }, fields: ["id"] }, { param: "id" }] }]);
    expect(plan.reads).toEqual([{ path: { name: "person" }, fields: ["name"] }, { path: { name: "person" }, fields: ["handle"] }]);
    const avatars = find(plan, "Avatar");
    // p joins without multiplying the avatar: it appears once per collaborator.
    expect(avatars[0]!.expandsBy).toEqual(["other"]);
    expect(avatars[0]!.draws).toMatchObject({ view: "Avatar", from: "/supplies/parts/cards.view", args: { person: { name: "other" } } });
    // The Text that shows both names expands by both.
    expect(find(plan, "Text")[0]!.expandsBy).toEqual(["p", "other"]);
    // A rule is expanded in place.
    const curated = find(plan, "ListCard").find((c) => c.orderBy)!;
    expect(curated.where).toEqual([{
      op: "or",
      args: [
        { op: "==", args: [{ path: { name: "l" }, fields: ["owner"] }, { name: "person" }] },
        { op: "in", args: [{ name: "person" }, { path: { name: "l" }, fields: ["contributors", "person"] }] },
      ],
    }]);
  });

  test("Home: ordered by a count and cut by the host", () => {
    const plan = check("/supplies/Home.view").views[0]!.plan!;
    expect(plan).toMatchObject({
      type: "ListCard",
      orderBy: [{ value: { call: "count", args: [{ path: { name: "l" }, fields: ["reactions"] }] }, desc: true }],
      limit: { value: 12 },
    });
  });

  test("Practices: conditions and orderings that read state go to the client", () => {
    const view = check("/supplies/Practices.view").views[0]!;
    expect(view.state).toEqual([{ name: "q", kind: "state" }, { name: "sortBy", kind: "keep" }]);
    const card = view.plan!;
    expect(card.where).toBeUndefined();
    expect(card.clientWhere).toHaveLength(1);
    expect(card.clientOrderBy).toHaveLength(1);
    expect(card.for).toEqual([{ name: "p", source: { model: "Practice" } }]);
  });

  test("a page's blocks: unnamed views are #n, named ones keep their names", () => {
    expect(check("/supplies/Today.md").views.map((v) => v.name)).toEqual(["#1", "Late", "#2"]);
  });
});

describe("uvl mutations", () => {
  const mutations = Object.fromEntries(check("/supplies/actions.view").mutations.map((m) => [m.name, m]));

  test("all 13 Supplies mutations, plus the shared step", () => {
    expect(Object.keys(mutations).filter((n) => n !== "recordContributor")).toHaveLength(13);
  });

  test("write sets include what `do` adds", () => {
    expect(mutations.toggleListReaction!.writes).toEqual([
      { op: "delete", model: "Reaction" },
      { op: "insert", model: "Reaction", fields: ["emoji", "list", "person"] },
    ]);
    expect(mutations.setListPractice!.writes).toEqual([
      { op: "upsert", model: "Contribution", fields: ["first", "last", "list", "person"] },
      { op: "append", model: "Item", relationship: "List.items" },
      { op: "remove", model: "Item", relationship: "List.items" },
    ]);
    expect(mutations.reorderList!.params).toEqual([
      { name: "l", type: "List", arity: "one" },
      { name: "practices", type: "Practice", arity: "many" },
    ]);
  });
});

describe("uvl conformance vectors", () => {
  test("docs/overstory-spec/conformance/view-language.json is current", () => {
    const stored = JSON.parse(readFileSync(join(import.meta.dir, "../../docs/overstory-spec/conformance/view-language.json"), "utf8"));
    expect(stored).toEqual(JSON.parse(JSON.stringify(viewLanguageVectors())));
  });
});
