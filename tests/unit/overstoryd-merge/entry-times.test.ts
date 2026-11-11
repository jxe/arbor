import { expect, test } from "bun:test";
import { decodeProtocolDirectory, type ProtocolDirectoryEntry } from "@ovst/protocol";
import { Fixture } from "./fixture.ts";

const entries = (f: Fixture, root: string) => decodeProtocolDirectory(f.objects.get(root)!).entries as Array<ProtocolDirectoryEntry & { file: string; modified: number }>;
const text = (f: Fixture, hash: string) => new TextDecoder().decode(f.objects.get(hash)!);

/** Base holds a.txt and b.txt dated 0; current's change edits `name` at 200. */
async function concurrent(name: "a.txt" | "b.txt") {
  const f = new Fixture(), files = (a: string, b: string, times: Record<string, number> = {}) => f.dir([
    { name: "a.txt", file: f.put(a), created: 0, modified: times["a.txt"] ?? 0 },
    { name: "b.txt", file: f.put(b), created: 0, modified: times["b.txt"] ?? 0 },
  ]);
  const base = files("one two", "b");
  const first = f.request(base, name === "a.txt" ? files("ONE two", "b", { "a.txt": 200 }) : files("one two", "B", { "b.txt": 200 }),
    [{ key: "op", kind: "editSource", source: name === "a.txt" ? f.ref("/a.txt", "one two", [0, 3]) : f.ref("/b.txt", "b"), text: name === "a.txt" ? "ONE" : "B" }], "first");
  first.incoming.at = 200;
  const current = (await f.run(first)).result;
  /** The second change edits a.txt's second word at `at`, concurrently. */
  const second = async (at: number) => {
    const request = f.request(base, files("one TWO", "b", { "a.txt": at }),
      [{ key: "op", kind: "editSource", source: f.ref("/a.txt", "one two", [4, 7]), text: "TWO" }], "second", current);
    request.incoming.at = at;
    const merged = await f.run(request);
    expect(merged.decisions).toEqual([]);
    return entries(f, merged.result.object);
  };
  return { f, second };
}

// Data model §6: when both sides changed an entry, the merge takes the later
// `modified` of the two and keeps `created` from the basis.
for (const [at, expected] of [[100, 200], [300, 300]] as const) {
  test(`an entry both sides edited is modified at the later time (incoming at ${at})`, async () => {
    const { f, second } = await concurrent("a.txt");
    const [a] = await second(at);
    expect(text(f, a!.file)).toBe("ONE TWO");
    expect(a).toMatchObject({ created: 0, modified: expected });
  });
}

test("an entry only the incoming side changed is modified at its own time, though current edited another later", async () => {
  const { second } = await concurrent("b.txt");
  expect((await second(100)).map((e) => [e.name, e.modified])).toEqual([["a.txt", 100], ["b.txt", 200]]);
});
