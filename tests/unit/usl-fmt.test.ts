import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { compileUsl, formatUsl } from "@ovst/usl";

const examples = join(import.meta.dir, "../../packages/usl/examples");
const usl = (dir: string) => readdirSync(dir).filter((f) => f.endsWith(".usl")).map((f) => join(dir, f));
const sources = [...usl(examples), ...usl(join(examples, "invalid")), join(import.meta.dir, "../../examples/supplies/data/schema.usl")];

const format = (source: string) => {
  const result = formatUsl(source);
  if (result.text === null) throw new Error(result.diagnostics[0]!.message);
  return result.text;
};

/** A checked schema without source positions, which formatting moves. */
const meaning = (source: string) => {
  const result = compileUsl(source);
  const strip = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(strip)
      : value && typeof value === "object"
        ? Object.fromEntries(Object.entries(value).filter(([k]) => !["at", "line", "column", "message"].includes(k)).map(([k, v]) => [k, strip(v)]))
        : value;
  return strip({ models: result.models, connections: result.connections, codes: result.diagnostics.map((d) => d.code).sort() });
};

describe("usl fmt", () => {
  for (const path of sources) {
    const source = readFileSync(path, "utf8");
    if (path.endsWith("syntax.usl")) continue;
    test(`${path.split("/").slice(-2).join("/")} keeps its meaning and is stable`, () => {
      const once = format(source);
      expect(meaning(once)).toEqual(meaning(source));
      expect(format(once)).toBe(once);
    });
  }

  test("returns a syntax error instead of a format", () => {
    expect(formatUsl("model X {\n  y\n}\n").text).toBeNull();
  });

  test("moves presentation to re blocks and model-level items last", () => {
    const source = [
      "// Tags.",
      "model Tag (list, id) {",
      "  @index(name)",
      "  name Text // shown",
      '  color Text? ~color @column("tint")',
      "  ~views([{ label: \"All\" }])",
      "}",
      "Tag.list <-> List.tags[]",
      "model List { name Text }",
      'enum Status { A ~color("#111111"), B }',
      "",
      "",
      "re Status {",
      "  B @stored(\"b\")",
      "}",
      "",
    ].join("\n");
    expect(format(source)).toBe(
      [
        "// Tags.",
        "model Tag (list, id) {",
        "  name  Text  // shown",
        '  color Text? @column("tint")',
        "",
        "  @index(name)",
        "}",
        "",
        "re Tag {",
        "  color ~color",
        "",
        '  ~views([{ label: "All" }])',
        "}",
        "",
        "Tag.list <-> List.tags[]",
        "",
        "model List {",
        "  name Text",
        "}",
        "",
        "enum Status { A, B }",
        "",
        "re Status {",
        '  B @stored("b")',
        '  A ~color("#111111")',
        "}",
        "",
      ].join("\n"),
    );
  });

  test("keeps an item with a comment inside as written", () => {
    const source = 're X {\n  ~views([\n    { label: "A" },  // first\n    { label: "B" },\n  ])\n}\n';
    expect(format(source)).toBe(source);
  });
});
