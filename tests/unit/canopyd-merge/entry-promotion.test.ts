import { expect, test } from "bun:test";
import { encodeLogEntry, LOG_ENTRY_FORMAT, parseQuestion, type Candidate } from "@overstory/merge-protocol";
import { Sidecar } from "../../../packages/canopyd-merge/src/sidecar.ts";
import { Fixture } from "./fixture.ts";

test("preflight validates a rename on the authored prefix containing its new parent", async () => {
  const f = new Fixture();
  const root = f.tree({ "note.md": "original" });
  const folder = f.tree({ "note.md": "original" });
  const moved = f.dir([{ name: "parent", directory: folder }]);
  const renamed = f.dir([{ name: "parent", directory: f.tree({ "renamed.md": "original" }) }]);
  const base = f.put(encodeLogEntry({ format: LOG_ENTRY_FORMAT, tree: "tr_test", previous: null,
    root, change: "initial", trace: null, resolves: [], decisions: [] }));
  const prefix: Candidate[] = [{ root: moved, change: "move", resolves: [], trace: [{ before: root, after: moved, operations: [
    { key: "parent", kind: "addEntry", destination: { parent: f.root(root), name: "parent" }, value: { directory: f.dir([]) } },
    { key: "transfer", kind: "moveEntry", source: f.ref("/note.md", "original"),
      destination: { parent: f.op("move", "parent"), name: "note.md" } },
  ] }] }];
  const candidate: Candidate = { root: renamed, change: "rename", resolves: [], trace: [{ before: moved, after: renamed, operations: [
    { key: "rename", kind: "moveEntry", source: f.ref("/parent/note.md", "original"),
      destination: { parent: { material: { kind: "basis", path: "/parent", object: folder } }, name: "renamed.md" } },
  ] }] };
  const sidecar = new Sidecar({
    shared: { find: async hash => f.objects.get(hash) ?? null, has: async hash => f.objects.has(hash) },
    staging: { find: async () => null, stage: async values => { for (const value of values) f.objects.set(value.hash, value.bytes); } },
  });
  const question = { validate: true as const, base, head: base, prefix, candidate, rules: { id: "tree-default", revision: 1 } };
  const result = await sidecar.answer(question);
  expect(result.root).toBe(renamed);
  expect(result.decisions).toEqual([]);
  // Validation is an execution check, not a promise to accept the authored result.
  // Corrupt evidence must fail before the host accepts any prefix.
  await expect(sidecar.answer({ ...question, candidate: { ...candidate,
    trace: [{ ...candidate.trace![0]!, after: root }] } })).rejects.toThrow();
  expect(() => parseQuestion({ ...question, head: root })).toThrow("one accepted basis");
  expect(() => parseQuestion({ ...question, candidate: { ...candidate, trace: null } })).toThrow("traced candidate");
});
