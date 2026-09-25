import { expect, test } from "bun:test";
import { compareProtocolNames, encodeProtocolDirectory, hashObject, type ObjectHash, type ProtocolDirectoryEntry } from "@overstory/protocol";
import { differences, declinedPoint, maskDeclined, resolveDeclined } from "../../packages/arborsync/src/declined-paths.ts";

type Spec = { [name: string]: string | Spec | { tree: string } };
const objects = new Map<ObjectHash, Uint8Array>();
const load = async (hash: ObjectHash) => {
  const bytes = objects.get(hash);
  if (!bytes) throw new Error(`missing ${hash}`);
  return bytes;
};

/** A tree from nested objects: strings are file contents, `{ tree }` is a child-tree boundary. */
function tree(spec: Spec): ObjectHash {
  const entries: ProtocolDirectoryEntry[] = Object.entries(spec).map(([name, value]) => {
    if (typeof value === "string") {
      const bytes = new TextEncoder().encode(value), file = hashObject(bytes);
      objects.set(file, bytes);
      return { name, file };
    }
    if (typeof value.tree === "string") return { name, tree: value.tree };
    return { name, directory: tree(value as Spec) };
  });
  const bytes = encodeProtocolDirectory({ type: "directory", entries: entries.sort((a, b) => compareProtocolNames(a.name, b.name)) });
  const hash = hashObject(bytes);
  objects.set(hash, bytes);
  return hash;
}

test("a footprint is the smallest differing entries", async () => {
  const before = tree({ notes: { "a.md": "a", "b.md": "b" }, "keep.md": "k" });
  const after = tree({ notes: { "a.md": "A", "b.md": "b", new: { "c.md": "c" } }, "keep.md": "k", "gone": { "x": "x" } });
  expect(await differences(before, after, load)).toEqual(["/gone", "/notes/a.md", "/notes/new"]);
});

test("a declined file whose directory was deleted on disk holds the whole directory", async () => {
  const accepted = tree({ notes: { "a.md": "a", "b.md": "b" } });
  const disk = tree({ other: "o" });
  expect(await declinedPoint("/notes/a.md", disk, accepted, load)).toBe("/notes");
  const both = tree({ notes: { "a.md": "A" } });
  expect(await declinedPoint("/notes/a.md", both, accepted, load)).toBe("/notes/a.md");
});

test("the published view keeps the accepted state at declined points and everything else from disk", async () => {
  const accepted = tree({ "trees.yaml": "accepted", notes: { "a.md": "a" }, "old.md": "old" });
  const disk = tree({ "trees.yaml": "refused", notes: { "a.md": "edited" }, "new.md": "n" });
  const { points } = await resolveDeclined(["/trees.yaml"], disk, accepted, load);
  expect(points).toEqual(["/trees.yaml"]);
  const masked = await maskDeclined(disk, accepted, points, load);
  for (const [hash, bytes] of masked.objects) objects.set(hash, bytes);
  expect(masked.root).toBe(tree({ "trees.yaml": "accepted", notes: { "a.md": "edited" }, "new.md": "n" }));
  // A declined deletion publishes the accepted entry, not the deletion.
  const deleted = await maskDeclined(tree({ notes: { "a.md": "a" } }), accepted, ["/trees.yaml"], load);
  for (const [hash, bytes] of deleted.objects) objects.set(hash, bytes);
  expect(deleted.root).toBe(tree({ "trees.yaml": "accepted", notes: { "a.md": "a" } }));
});

test("a nested declined point rewrites only its own directory", async () => {
  const accepted = tree({ a: { b: { "held.md": "accepted", "free.md": "1" } }, "top.md": "t" });
  const disk = tree({ a: { b: { "held.md": "refused", "free.md": "2" } }, "top.md": "T" });
  const masked = await maskDeclined(disk, accepted, ["/a/b/held.md"], load);
  for (const [hash, bytes] of masked.objects) objects.set(hash, bytes);
  expect(masked.root).toBe(tree({ a: { b: { "held.md": "accepted", "free.md": "2" } }, "top.md": "T" }));
});

test("a declined path lifts once the folder matches the accepted state there", async () => {
  const accepted = tree({ "trees.yaml": "accepted", "other.md": "o" });
  const fixed = tree({ "trees.yaml": "accepted", "other.md": "changed" });
  expect(await resolveDeclined(["/trees.yaml"], fixed, accepted, load)).toEqual({ points: [], lifted: ["/trees.yaml"] });
  // A declined addition lifts when the folder no longer has it.
  expect(await resolveDeclined(["/LinkPreviews"], fixed, accepted, load)).toEqual({ points: [], lifted: ["/LinkPreviews"] });
});

test("content moved out of a declined path is declined where it lands, so a declined move is never half-published", async () => {
  const accepted = tree({ projects: { "plan.md": "the plan", "notes.md": "notes" }, "free.md": "f" });
  // The refused change moved /projects to /archive; the person then renamed it again.
  const disk = tree({ elsewhere: { "plan.md": "the plan", "notes.md": "notes" }, "free.md": "edited" });
  const view = await resolveDeclined(["/archive", "/projects"], disk, accepted, load);
  expect(view).toEqual({ points: ["/elsewhere", "/projects"], lifted: ["/archive"] });
  // An unrelated new file is not declined.
  const unrelated = tree({ "new.md": "brand new", "free.md": "f" });
  expect((await resolveDeclined(["/projects"], unrelated, accepted, load)).points).toEqual(["/projects"]);
});
