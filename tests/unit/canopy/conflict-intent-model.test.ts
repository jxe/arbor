import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeWireDirectory, hashObject } from "@arbor/wire";
import { ConflictTermsBackend } from "../../../packages/canopy/src/experimental/conflict-terms/backend.ts";
import { SourceIntentModel, type IntentRequest, type SourceTarget } from "../../../packages/canopy/src/experimental/conflict-terms/intent-model.ts";

const tree = "tr_intent";
const initial: SourceTarget[] = [
  { id: "p", path: "/note.md", slot: 10, source: "Alpha\n\n" },
  { id: "q", path: "/note.md", slot: 20, source: "Beta\n\n" },
];
function request(id: string, base: number, effects: IntentRequest["effects"], candidate: IntentRequest["candidate"]): IntentRequest {
  return { tree, id, base, effects, candidate };
}
function dayConflict(): SourceIntentModel {
  const model = new SourceIntentModel(tree, [{ id: "day", path: "/day.md", slot: 10, source: "Monday\n" }]);
  model.submit(request("tuesday", 0, [{ kind: "replace", target: "day", before: "Monday\n", source: "Tuesday\n" }], { "/day.md": "Tuesday\n" }));
  model.submit(request("wednesday", 0, [{ kind: "replace", target: "day", before: "Monday\n", source: "Wednesday\n" }], { "/day.md": "Wednesday\n" }));
  return model;
}

describe("intent-bearing source targets with revision-identified terms", () => {
  test.each([false, true])("move plus concurrent edit preserves one edited paragraph (move first: %s)", (moveFirst) => {
    const model = new SourceIntentModel(tree, initial);
    const move = request("move", 0, [{ kind: "move", target: "p", path: "/note.md", slot: 30 }], { "/note.md": "Beta\n\nAlpha\n\n" });
    const edit = request("edit", 0, [{ kind: "replace", target: "p", before: "Alpha\n\n", source: "Edited\n\n" }], { "/note.md": "Edited\n\nBeta\n\n" });
    model.submit(moveFirst ? move : edit);
    const result = model.submit(moveFirst ? edit : move);
    expect(result.files).toEqual({ "/note.md": "Beta\n\nEdited\n\n" });
    expect(Object.keys(result.targets)).toEqual(["p", "q"]);
    expect(result.conflicts).toEqual([]);
  });

  test.each([false, true])("copy plus concurrent edit freezes the copy and preserves the original identity (copy first: %s)", (copyFirst) => {
    const model = new SourceIntentModel(tree, initial);
    const copy = request("copy", 0, [{ kind: "copy", target: "p", newTarget: "copied", path: "/note.md", slot: 30 }], { "/note.md": "Alpha\n\nBeta\n\nAlpha\n\n" });
    const edit = request("edit", 0, [{ kind: "replace", target: "p", before: "Alpha\n\n", source: "Edited\n\n" }], { "/note.md": "Edited\n\nBeta\n\n" });
    model.submit(copyFirst ? copy : edit);
    const result = model.submit(copyFirst ? edit : copy);
    expect(result.files).toEqual({ "/note.md": "Edited\n\nBeta\n\nAlpha\n\n" });
    expect(result.targets.copied!.body[0]!.source).toBe("Alpha\n\n");
    expect(result.conflicts).toEqual([]);
  });

  test("identical paragraphs remain distinct through a targeted edit and a concurrent cross-file move", () => {
    const model = new SourceIntentModel(tree, initial.map((target) => ({ ...target, source: "Same\n\n" })));
    model.submit(request("edit-second", 0, [{ kind: "replace", target: "q", before: "Same\n\n", source: "Second\n\n" }], { "/note.md": "Same\n\nSecond\n\n" }));
    const result = model.submit(request("move-second", 0, [{ kind: "move", target: "q", path: "/other.md", slot: 10 }], { "/note.md": "Same\n\n", "/other.md": "Same\n\n" }));
    expect(result.files).toEqual({ "/note.md": "Same\n\n", "/other.md": "Second\n\n" });
    expect(result.targets.p!.body[0]!.source).toBe("Same\n\n");
    expect(result.conflicts).toEqual([]);
  });

  test.each([false, true])("concurrent delete versus edit preserves the disagreement (delete first: %s)", (deleteFirst) => {
    const model = new SourceIntentModel(tree, initial);
    const deletion = request("delete", 0, [{ kind: "delete", target: "p" }], { "/note.md": "Beta\n\n" });
    const edit = request("edit", 0, [{ kind: "replace", target: "p", before: "Alpha\n\n", source: "Edited\n\n" }], { "/note.md": "Edited\n\nBeta\n\n" });
    model.submit(deleteFirst ? deletion : edit);
    const result = model.submit(deleteFirst ? edit : deletion);
    expect(result.files).toEqual({ "/note.md": "Beta\n\n" });
    expect(result.conflicts).toEqual([{ target: "p", kind: "delete-edit" }]);
    expect(result.targets.p!.body[0]!.source).toBe("Edited\n\n");
  });

  test("deletion after observing the edit is not confused with concurrent deletion", () => {
    const model = new SourceIntentModel(tree, initial);
    model.submit(request("edit", 0, [{ kind: "replace", target: "p", before: "Alpha\n\n", source: "Edited\n\n" }], { "/note.md": "Edited\n\nBeta\n\n" }));
    const result = model.submit(request("delete", 1, [{ kind: "delete", target: "p" }], { "/note.md": "Beta\n\n" }));
    expect(result.conflicts).toEqual([]);
    expect(result.files).toEqual({ "/note.md": "Beta\n\n" });
  });

  test("undoing one of two independent deletions does not undo the other", () => {
    const model = new SourceIntentModel(tree, initial);
    const deleted = { "/note.md": "Beta\n\n" };
    model.submit(request("alice-delete", 0, [{ kind: "delete", target: "p" }], deleted));
    model.submit(request("bob-delete", 0, [{ kind: "delete", target: "p" }], deleted));
    expect(model.review().targets.p!.deletions).toEqual(["op:alice-delete:0", "op:bob-delete:0"]);
    // Alice has not seen Bob's deletion. Her local undo candidate restores p.
    const result = model.submit(request("alice-undo", 1, [{ kind: "undo-delete", target: "p", deletion: "op:alice-delete:0" }], { "/note.md": "Alpha\n\nBeta\n\n" }));
    expect(result.files).toEqual(deleted);
    expect(result.targets.p!.deletions).toEqual(["op:bob-delete:0"]);
    expect(result.conflicts).toEqual([]);
  });

  test("editing an alternative back to base bytes preserves that value and the other alternative", () => {
    const model = dayConflict();
    const result = model.submit(request("back-to-monday", 2, [{ kind: "edit-alternative", target: "day", alternative: "op:wednesday:0", before: "Wednesday\n", source: "Monday\n" }], { "/day.md": "Monday\n" }));
    expect(result.files).toEqual({ "/day.md": "Monday\n" });
    expect(result.targets.day!.body.map((alternative) => alternative.source)).toEqual(["Monday\n", "Tuesday\n"]);
    expect(result.conflicts).toEqual([{ target: "day", kind: "text" }]);
  });

  test("the same source change refused by the snapshot baseline is admitted with explicit alternative intent", () => {
    const directory = mkdtempSync(join(tmpdir(), "arbor-intent-comparison-"));
    const baseline = new ConflictTermsBackend(join(directory, "baseline.sqlite"));
    const snapshot = (source: string) => {
      const bytes = new TextEncoder().encode(source);
      const file = hashObject(bytes);
      const rootBytes = encodeWireDirectory({ type: "directory", entries: [{ name: "day.md", file }] });
      const root = hashObject(rootBytes);
      return { root, objects: new Map([[file, bytes], [root, rootBytes]]) };
    };
    try {
      const first = baseline.create(tree, "owner", snapshot("Monday\n"));
      baseline.update(tree, "owner", first.update, snapshot("Tuesday\n"), "tuesday");
      const conflict = baseline.update(tree, "owner", first.update, snapshot("Wednesday\n"), "wednesday");
      expect(() => baseline.update(tree, "owner", conflict.update, snapshot("Monday\n"), "back-to-monday")).toThrow("preserve unresolved");
      const model = dayConflict();
      const result = model.submit(request("back-to-monday", 2, [{ kind: "edit-alternative", target: "day", alternative: "op:wednesday:0", before: "Wednesday\n", source: "Monday\n" }], { "/day.md": "Monday\n" }));
      expect(result.files).toEqual({ "/day.md": "Monday\n" });
      expect(result.targets.day!.body.map((alternative) => alternative.source)).toEqual(["Monday\n", "Tuesday\n"]);
      expect(result.conflicts).toEqual([{ target: "day", kind: "text" }]);
    } finally {
      baseline.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("moving a conflict and editing its hidden alternative survives restart without changing projected bytes", () => {
    const model = dayConflict();
    model.submit(request("move", 2, [{ kind: "move", target: "day", path: "/archive.md", slot: 10 }], { "/archive.md": "Wednesday\n" }));
    const restored = SourceIntentModel.restore(model.archive());
    // Offline operation authored before the move; edits the nonprojected Tuesday.
    const edit = request("hidden-edit", 2, [{ kind: "edit-alternative", target: "day", alternative: "op:tuesday:0", before: "Tuesday\n", source: "Friday\n" }], { "/day.md": "Wednesday\n" });
    const result = restored.submit(edit);
    expect(result.files).toEqual({ "/archive.md": "Wednesday\n" });
    expect(result.targets.day!.body.map((alternative) => alternative.source)).toEqual(["Wednesday\n", "Friday\n"]);
    expect(SourceIntentModel.restore(restored.archive()).submit(edit)).toEqual(result);
    expect(result.update).toBe(4);
  });

  test("explicit resolution retires alternatives and fences stale alternative edits", () => {
    const model = dayConflict();
    const resolved = model.submit(request("resolution", 2, [{ kind: "resolve-text", target: "day", source: "Thursday\n" }], { "/day.md": "Thursday\n" }));
    expect(resolved.conflicts).toEqual([]);
    const before = model.archive();
    expect(() => model.submit(request("stale-edit", 2, [{ kind: "edit-alternative", target: "day", alternative: "op:tuesday:0", before: "Tuesday\n", source: "Friday\n" }], { "/day.md": "Wednesday\n" }))).toThrow("no longer current");
    expect(model.archive()).toBe(before);
    expect(() => model.submit(request("stale-resolution", 2, [{ kind: "resolve-text", target: "day", source: "Saturday\n" }], { "/day.md": "Saturday\n" }))).toThrow("Stale resolution");
  });

  test("equal replacement bytes retain distinct authored identities", () => {
    const model = new SourceIntentModel(tree, initial);
    for (const id of ["alice", "bob"]) model.submit(request(id, 0, [{ kind: "replace", target: "p", before: "Alpha\n\n", source: "Same change\n\n" }], { "/note.md": "Same change\n\nBeta\n\n" }));
    expect(model.review().targets.p!.body.map((alternative) => alternative.revision)).toEqual(["op:bob:0", "op:alice:0"]);
    expect(model.review().conflicts).toEqual([{ target: "p", kind: "text" }]);
  });

  test("grouped move then typing retains both effects, exact bytes, and retry identity across serialization", () => {
    const source = "\uFEFF# Title\r\n\r\nexact source without newline";
    const model = new SourceIntentModel(tree, [{ id: "p", path: "/original.md", slot: 10, source }]);
    const operation = request("grouped", 0, [
      { kind: "move", target: "p", path: "/moved.md", slot: 10 },
      { kind: "replace", target: "p", before: source, source: source + "!" },
    ], { "/moved.md": source + "!" });
    const result = model.submit(operation);
    const saved = JSON.parse(model.archive());
    expect(saved.requests[0].effects).toHaveLength(2);
    const restarted = SourceIntentModel.restore(model.archive());
    expect(restarted.review()).toEqual(result);
    expect(restarted.submit(operation)).toEqual(result);
    expect(restarted.review().update).toBe(1);
    expect(result.files).toEqual({ "/moved.md": source + "!" });
  });

  test("source guards, candidate effects, TreeID, and fresh copy identity are checked atomically", () => {
    const model = new SourceIntentModel(tree, initial);
    const saved = model.archive();
    expect(() => model.submit(request("guard", 0, [{ kind: "replace", target: "p", before: "wrong", source: "new" }], {}))).toThrow("Source guard mismatch");
    expect(() => model.submit(request("contradiction", 0, [{ kind: "move", target: "p", path: "/other.md", slot: 10 }], { "/note.md": "Alpha\n\nBeta\n\n", "/other.md": "Alpha\n\n" }))).toThrow("does not reproduce");
    expect(() => model.submit({ ...request("scope", 0, [{ kind: "delete", target: "p" }], {}), tree: "tr_other" })).toThrow("Wrong TreeID");
    expect(() => model.submit(request("copy", 0, [{ kind: "copy", target: "p", newTarget: "q", path: "/other.md", slot: 10 }], {}))).toThrow("fresh identity");
    expect(model.archive()).toBe(saved);
  });

  test("semantic operations participate in retry identity even when candidate bytes match", () => {
    const model = dayConflict();
    const first = request("hidden", 2, [{ kind: "edit-alternative", target: "day", alternative: "op:tuesday:0", before: "Tuesday\n", source: "Friday\n" }], { "/day.md": "Wednesday\n" });
    model.submit(first);
    const before = model.archive();
    expect(() => model.submit({ ...first, effects: [{ kind: "edit-alternative", target: "day", alternative: "op:tuesday:0", before: "Tuesday\n", source: "Saturday\n" }] })).toThrow("different intent");
    expect(model.archive()).toBe(before);
  });

  test("colliding placement requests fail explicitly rather than silently reordering content", () => {
    const model = new SourceIntentModel(tree, initial);
    const saved = model.archive();
    expect(() => model.submit(request("collision", 0, [{ kind: "move", target: "p", path: "/note.md", slot: 20 }], { "/note.md": "Alpha\n\nBeta\n\n" }))).toThrow("Ambiguous placement slot");
    expect(model.archive()).toBe(saved);
  });

  test("operation revisions cannot collide with the initial source identity namespace", () => {
    const model = new SourceIntentModel(tree, initial);
    const before = model.review(0);
    model.submit(request("initial", 0, [{ kind: "copy", target: "q", newTarget: "copy", path: "/copied.md", slot: 10 }], {
      "/note.md": "Alpha\n\nBeta\n\n", "/copied.md": "Beta\n\n",
    }));
    expect(model.review(0)).toEqual(before);
    expect(SourceIntentModel.restore(model.archive()).review(0)).toEqual(before);
  });

  test("split/merge lineage is an explicit unsupported case, not a successful no-op", () => {
    const model = new SourceIntentModel(tree, initial);
    const before = model.archive();
    const effects = [{ kind: "split", target: "p", offset: 3 }] as unknown as IntentRequest["effects"];
    expect(() => model.submit(request("split", 0, effects, { "/note.md": "Alpha\n\nBeta\n\n" }))).toThrow("Unsupported source operation");
    expect(model.archive()).toBe(before);
  });
});
