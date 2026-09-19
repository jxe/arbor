import { expect, test } from "bun:test";
import { Fixture } from "./fixture.ts";
import type { Format } from "../../../packages/merge/src/format-rules.ts";
const cases: Array<{
  name: string;
  source: string;
  format?: Format;
  key?: string;
}> = [
  { name: "note.md", source: "alpha 1\n\nbeta 2\n" },
  { name: "data.json", source: '{ "a": 1, "b": 2 }\r\n' },
  {
    name: "data.jsonl",
    source: '{"id":"a","value":1}\n{"id":"b","value":2}\n',
    key: "id",
  },
  { name: "data.yaml", source: "a: 1 # keep\nb: 2\n" },
  { name: "data.toml", source: "a = 1 # keep\nb = 2\n" },
  { name: "data.csv", source: "id,value\na,1\nb,2\n", key: "id" },
  { name: "data.tsv", source: "id\tvalue\na\t1\nb\t2\n", key: "id" },
  { name: "code.ts", source: "const a = 1;\nconst b = 2;\n" },
  { name: "code.js", source: "const a = 1;\nconst b = 2;\n" },
  { name: "code.swift", source: "let a = 1\nlet b = 2\n" },
  { name: "code.py", source: "a = 1\nb = 2\n" },
  { name: "page.html", source: '<div id="a">1</div><div id="b">2</div>' },
  { name: "page.xml", source: "<root><a>1</a><b>2</b></root>" },
  { name: "style.css", source: ".a { width: 1px; }\n.b { height: 2px; }" },
];
for (const c of cases)
  test(`${c.name}: exact independent fields/scopes in both orders`, async () => {
    for (const reverse of [false, true]) {
      const f = new Fixture(),
        base = f.tree({ [c.name]: c.source });
      const change = (from: string, to: string) => [
        {
          key: "op",
          kind: "editSource" as const,
          source: f.ref("/" + c.name, c.source, [
            Buffer.byteLength(c.source.slice(0, c.source.indexOf(from))),
            Buffer.byteLength(
              c.source.slice(0, c.source.indexOf(from) + from.length),
            ),
          ]),
          text: to,
        },
      ];
      const first = reverse ? ["2", "4"] : ["1", "3"],
        second = reverse ? ["1", "3"] : ["2", "4"];
      const r1 = f.request(
        base,
        f.tree({ [c.name]: c.source.replace(first[0]!, first[1]!) }),
        change(first[0]!, first[1]!),
        "a",
      );
      const a = await f.run(r1);
      const r2 = f.request(
        base,
        f.tree({ [c.name]: c.source.replace(second[0]!, second[1]!) }),
        change(second[0]!, second[1]!),
        "b",
        a.result,
      );
      r2.rules.config = {
        formats: { ["/" + c.name]: { recordKey: c.key, format: c.format } },
      };
      const result = await f.run(r2);
      expect(result.decisions).toEqual([]);
      expect(f.content(result.result.object, c.name)).toBe(
        c.source.replace("1", "3").replace("2", "4"),
      );
    }
  });
test.each([
  ["a.json", '{"a":12,"a":34}'],
  ["a.yaml", "a: &x 12\nb: *x #34\n"],
  ["a.ts", "const a = 12;\nconst a = 34;"],
  ["a.swift", "@MainActor let a = 12\nlet b = 34\n"],
  ["a.py", "@decorator\ndef a(): return 12\ndef b(): return 34\n"],
  ["a.css", ".a {width:12px;width:34px;}"],
  ["a.xml", "<r><a>12</a><a>34</a></r>"],
  ["a.html", "<div>12</div><div>34</div>"],
  ["a.bin", "12 34"],
])("%s: ambiguous structure keeps alternatives", async (name, source) => {
  const f = new Fixture(),
    base = f.tree({ [name]: source });
  const op = (char: string, text: string) => ({
    key: "op",
    kind: "editSource" as const,
    source: f.ref("/" + name, source, [
      source.indexOf(char),
      source.indexOf(char) + 1,
    ]),
    text,
  });
  const a = await f.run(
    f.request(
      base,
      f.tree({ [name]: source.replace("1", "5") }),
      [op("1", "5")],
      "a",
    ),
  );
  const r = await f.run(
    f.request(
      base,
      f.tree({ [name]: source.replace("3", "6") }),
      [op("3", "6")],
      "b",
      a.result,
    ),
  );
  expect(r.decisions.length).toBeGreaterThan(0);
});

test("code overlaps do not authorize independent-looking edits within the same declaration", async () => {
  const f = new Fixture(),
    source = "const a = 12 + 34;",
    base = f.tree({ "a.ts": source });
  const edit = (position: number, text: string) => ({
    key: "edit" + position,
    kind: "editSource" as const,
    source: f.ref("/a.ts", source, [position, position + 1]),
    text,
  });
  const current = await f.run(
    f.request(
      base,
      f.tree({ "a.ts": "const a = 52 + 64;" }),
      [edit(10, "5"), edit(15, "6")],
      "current",
    ),
  );
  const result = await f.run(
    f.request(
      base,
      f.tree({ "a.ts": "const a = 72 + 34;" }),
      [edit(10, "7")],
      "incoming",
      current.result,
    ),
  );
  expect(f.content(result.result.object, "a.ts")).toBe("const a = 72 + 34;");
  expect(result.decisions).toHaveLength(1);
  expect(result.decisions[0]!.reason).toContain("Format policy");
});

for (const c of [
  ...cases,
  { name: "opaque.bin", source: "\u0000\u0001opaque" },
]) {
  test(`${c.name}: entry transformations preserve opaque source`, async () => {
    for (const kind of [
      "moveEntry",
      "copyEntry",
      "removeEntry",
      "replaceEntry",
    ] as const) {
      const f = new Fixture(),
        base = f.tree({ [c.name]: c.source, "other.txt": "old" });
      const candidate = f.tree({
        ...(kind === "moveEntry" || kind === "removeEntry"
          ? {}
          : { [c.name]: kind === "replaceEntry" ? "replacement" : c.source }),
        ...(kind === "moveEntry" || kind === "copyEntry"
          ? { destination: c.source }
          : {}),
        "other.txt": "old",
      });
      const operation = {
        key: "op",
        kind,
        source: f.ref("/" + c.name, c.source),
        ...(kind === "moveEntry" || kind === "copyEntry"
          ? { destination: { parent: f.root(base), name: "destination" } }
          : {}),
        ...(kind === "replaceEntry"
          ? { value: { file: f.put("replacement") } }
          : {}),
      };
      const transformed = await f.run(
        f.request(
          base,
          candidate,
          [operation as import("@arbor/wire").SourceOperation],
          kind,
        ),
      );
      expect(transformed.result.object).toBe(candidate);
      expect(transformed.decisions).toEqual([]);
    }
  });
}
