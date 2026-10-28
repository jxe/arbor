import { expect, test } from "bun:test";
import { decodeProtocolDirectory, decodeProtocolPage, encodeProtocolPage, type PageProperty, type SourceOperation } from "@ovst/protocol";
import { Fixture } from "./fixture.ts";

const encoder = new TextEncoder(), decoder = new TextDecoder();
const pageOf = (f: Fixture, body: string, properties: PageProperty[] = [["title", "A"]]) =>
  f.put(encodeProtocolPage({ type: "page", id: "p1", properties, body: encoder.encode(body) }));
const edit = (f: Fixture, page: string, range: [number, number], text: string, key = "edit"): SourceOperation =>
  ({ key, kind: "editSource", source: { material: { kind: "basis", path: "/a.md", object: page }, range }, text });

test("an edit of a page's body keeps its properties", async () => {
  const f = new Fixture();
  const page = pageOf(f, "Hello world\n"), base = f.dir([{ name: "a.md", page }]);
  const next = pageOf(f, "Hello there\n"), candidate = f.dir([{ name: "a.md", page: next }]);
  const result = await f.run(f.request(base, candidate, [edit(f, page, [6, 11], "there")]));
  expect(result.result.object).toBe(candidate);
});

test("concurrent edits of one page's body merge as text", async () => {
  const f = new Fixture();
  const page = pageOf(f, "One\nTwo\n"), base = f.dir([{ name: "a.md", page }]);
  const theirs = await f.run(f.request(base, f.dir([{ name: "a.md", page: pageOf(f, "Zero\nOne\nTwo\n") }]),
    [edit(f, page, [0, 0], "Zero\n", "theirs")], "theirs"));
  const merged = await f.run(f.request(base, f.dir([{ name: "a.md", page: pageOf(f, "One\nTwo\nThree\n") }]),
    [edit(f, page, [8, 8], "Three\n", "mine")], "mine", theirs.result));
  expect(merged.decisions).toEqual([]);
  const entry = decodeProtocolDirectory(f.objects.get(merged.result.object)!).entries[0]!;
  const written = decodeProtocolPage(f.objects.get(entry.page!)!);
  expect(decoder.decode(written.body)).toBe("Zero\nOne\nTwo\nThree\n");
  expect(written.properties).toEqual([["title", "A"]]);
});

test("a page and a file at different names stay what they are", async () => {
  const f = new Fixture();
  const page = pageOf(f, "Body\n"), base = f.dir([{ name: "a.md", page }, { name: "b.txt", file: f.put("b") }]);
  const candidate = f.dir([{ name: "a.md", page: pageOf(f, "Body!\n") }, { name: "b.txt", file: f.put("b") }]);
  const result = await f.run(f.request(base, candidate, [edit(f, page, [4, 4], "!")]));
  const entries = decodeProtocolDirectory(f.objects.get(result.result.object)!).entries;
  expect(entries.map((entry) => [entry.name, !!entry.page, !!entry.file])).toEqual([["a.md", true, false], ["b.txt", false, true]]);
});
