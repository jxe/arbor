import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeWireDirectory, encodeWireDirectory, hashObject, type TreeSnapshot, type WireDirectoryEntry } from "@arbor/wire";
import { continueTerms, simplify, type Term } from "../../../packages/canopy/src/experimental/conflict-terms/algebra.ts";
import { ConflictTermsBackend, type Review } from "../../../packages/canopy/src/experimental/conflict-terms/backend.ts";
import type { Resolution } from "../../../packages/canopy/src/experimental/conflict-terms/projection.ts";

const tree = "tr_experiment";
const owner = "alice";
const encode = (source: string): Uint8Array => new TextEncoder().encode(source);
const decode = (bytes: Uint8Array): string => new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

/** Most scenarios author fresh operations; retry tests pass the same explicit ID. */
class TestBackend extends ConflictTermsBackend {
  override update(tree: string, subject: string, base: number, snapshot: TreeSnapshot, requestID: string = crypto.randomUUID()): Review {
    return super.update(tree, subject, base, snapshot, requestID);
  }
  override resolve(tree: string, subject: string, expected: number, choices: Resolution[], requestID: string = crypto.randomUUID()): Review {
    return super.resolve(tree, subject, expected, choices, requestID);
  }
}

function database(maxTerms?: number): { backend: TestBackend; filename: string; reopen(): TestBackend } {
  const directory = mkdtempSync(join(tmpdir(), "arbor-conflict-terms-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, "experiment.sqlite");
  const backend = new TestBackend(filename, maxTerms);
  cleanups.push(() => backend.close());
  return { backend, filename, reopen() {
    const next = new TestBackend(filename, maxTerms);
    cleanups.push(() => next.close());
    return next;
  } };
}

/** Actual Wire byte objects, directories, and opaque nested TreeID boundaries. */
function snapshot(files: Record<string, string | Uint8Array>, boundaries: Record<string, string> = {}): TreeSnapshot {
  const objects = new Map<string, Uint8Array>();
  const put = (bytes: Uint8Array): string => { const hash = hashObject(bytes); objects.set(hash, bytes); return hash; };
  const nodes = new Map<string, WireDirectoryEntry[]>();
  nodes.set("", []);
  for (const [path, value] of Object.entries(files)) {
    const parts = path.split("/");
    const name = parts.pop()!;
    const parent = parts.join("/");
    nodes.set(parent, [...(nodes.get(parent) ?? []), { name, file: put(typeof value === "string" ? encode(value) : value) }]);
    for (let end = parts.length - 1; end >= 0; end--) {
      const ancestor = parts.slice(0, end).join("/");
      if (!nodes.has(ancestor)) nodes.set(ancestor, []);
    }
  }
  for (const [name, id] of Object.entries(boundaries)) nodes.get("")!.push({ name, tree: id });
  const paths = [...nodes.keys()].sort((a, b) => b.split("/").length - a.split("/").length || b.length - a.length);
  let root = "";
  for (const path of paths) {
    const entries = nodes.get(path)!.sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
    const hash = put(encodeWireDirectory({ type: "directory", entries }));
    if (!path) root = hash;
    else {
      const parts = path.split("/");
      const name = parts.pop()!;
      nodes.get(parts.join("/"))!.push({ name, directory: hash });
    }
  }
  return { root, objects };
}

function source(backend: ConflictTermsBackend, state: Review, path = "note.md", subject = owner): string | null {
  let hash = state.root;
  const parts = path.split("/");
  for (let index = 0; index < parts.length; index++) {
    const entry = decodeWireDirectory(backend.readObject(state.tree, subject, hash)).entries.find((entry) => entry.name === parts[index]);
    if (!entry) return null;
    if (index === parts.length - 1) return entry.file ? decode(backend.readObject(state.tree, subject, entry.file)) : null;
    if (!entry.directory) return null;
    hash = entry.directory;
  }
  return null;
}

function conflict(backend: TestBackend, base = "Monday\n", current = "Tuesday\n", candidate = "Wednesday\n"): Review {
  const first = backend.create(tree, owner, snapshot({ "note.md": base }));
  backend.update(tree, owner, first.update, snapshot({ "note.md": current }));
  return backend.update(tree, owner, first.update, snapshot({ "note.md": candidate }));
}

describe("exact ordered conflict algebra", () => {
  const plus = (value: string): Term<string> => ({ sign: 1, value });
  const minus = (value: string): Term<string> => ({ sign: -1, value });
  test("flattens repeated rebases by cancellation without keeping obsolete context", () => {
    const first = [plus("C"), plus("B"), minus("A")];
    expect(simplify([plus("D"), ...first, minus("C")], String)).toEqual([plus("D"), plus("B"), minus("A")]);
    expect(continueTerms(first, "C", "D", String)).toEqual([plus("D"), plus("B"), minus("A")]);
  });
  test("does not silently use the lossy same-change rule", () => {
    expect(simplify([plus("A"), plus("A"), minus("B")], String)).toEqual([plus("A"), plus("A"), minus("B")]);
    expect(() => simplify([plus("A"), minus("A")], String)).toThrow("weight one");
  });
  test("exact inverse cancels a nested conflicted expression", () => {
    const expression = [plus("C"), plus("B"), minus("A")];
    expect(simplify([...expression, plus("C"), ...expression.map(({ value, sign }): Term<string> => ({ value, sign: sign === 1 ? -1 : 1 }))], String)).toEqual([plus("C")]);
  });
});

describe("durable composable conflict backend experiment", () => {
  test("accepts alternatives with ordinary marker-free bytes and stable restart evidence", () => {
    const db = database();
    const state = conflict(db.backend);
    expect(state.update).toBe(3);
    expect(state.conflicts).toHaveLength(1);
    expect(source(db.backend, state)).toBe("Wednesday\n");
    expect(state.conflicts[0]!.terms.map((term) => term.sign)).toEqual([1, 1, -1]);
    expect(db.reopen().review(tree, owner)).toEqual(state);
  });

  test("continues edits inside the visible alternative, then adds an independent edit", () => {
    const { backend } = database();
    const state = conflict(backend, "# Day\nMonday\n# Other\nunchanged\n", "# Day\nTuesday\n# Other\nunchanged\n", "# Day\nWednesday\n# Other\nunchanged\n");
    const changed = backend.update(tree, owner, state.update, snapshot({ "note.md": "# Day\nThursday\n# Other\nunchanged\n" }));
    expect(changed.conflicts).toHaveLength(1);
    const region = changed.conflicts[0]!;
    if (region.kind !== "text") throw new Error("Expected text conflict");
    expect(region.terms.map((term) => decode(term.value))).toEqual(["Thursday\n", "Tuesday\n", "Monday\n"]);
    const later = backend.update(tree, owner, changed.update, snapshot({ "note.md": "# Day\nThursday\n# Other\nnew independent text\n", "other.md": "new file\n" }));
    expect(later.conflicts).toHaveLength(1);
    expect(source(backend, later)).toBe("# Day\nThursday\n# Other\nnew independent text\n");
    expect(source(backend, later, "other.md")).toBe("new file\n");
  });

  test("unchanged projections preserve unresolved state and do not advance the head", () => {
    const { backend } = database();
    const state = conflict(backend);
    expect(backend.update(tree, owner, state.update, snapshot({ "note.md": "Wednesday\n" }))).toEqual(state);
  });

  test("ordinary edits cannot cancel an unresolved region by returning to its old base", () => {
    const { backend } = database();
    const state = conflict(backend);
    // Monday + (Wednesday + Tuesday - Monday) - Wednesday = Tuesday.
    // Algebra alone would make this look clean and even hide the authored Monday.
    expect(() => backend.update(tree, owner, state.update, snapshot({ "note.md": "Monday\n" }))).toThrow("preserve unresolved");
    expect(backend.review(tree, owner)).toEqual(state);
    const resolved = backend.resolve(tree, owner, state.update, [{ conflict: state.conflicts[0]!.id, bytes: encode("Monday\n") }]);
    expect(source(backend, resolved)).toBe("Monday\n");
    expect(resolved.conflicts).toHaveLength(0);
  });

  test("an identical new conflict elsewhere is not proof the original region survived", () => {
    const { backend } = database();
    const state = conflict(backend, "# First\nMonday\n# Second\nMonday\n", "# First\nTuesday\n# Second\nMonday\n", "# First\nWednesday\n# Second\nMonday\n");
    const advanced = backend.update(tree, owner, state.update, snapshot({ "note.md": "# First\nWednesday\n# Second\nTuesday\n" }));
    expect(() => backend.update(tree, owner, state.update, snapshot({ "note.md": "# First\nMonday\n# Second\nWednesday\n" }))).toThrow("preserve unresolved");
    expect(backend.review(tree, owner)).toEqual(advanced);
  });

  test("two equal changes stay unresolved even when the accepted projection is unchanged", () => {
    const { backend } = database();
    const base = backend.create(tree, owner, snapshot({ "note.md": "before\n" }));
    const first = backend.update(tree, owner, base.update, snapshot({ "note.md": "after\n" }));
    const second = backend.update(tree, owner, base.update, snapshot({ "note.md": "after\n" }));
    expect(second.root).toBe(first.root);
    expect(second.update).toBe(first.update + 1);
    expect(second.conflicts).toHaveLength(1);
    const resolved = backend.resolve(tree, owner, second.update, [{ conflict: second.conflicts[0]!.id, take: 0 }]);
    expect(resolved.root).toBe(second.root);
    expect(resolved.update).toBe(second.update + 1);
    expect(resolved.conflicts).toHaveLength(0);
  });

  test("exact update and resolution retries survive restart without adding another term", () => {
    const db = database();
    const first = db.backend.create(tree, owner, snapshot({ "note.md": "before\n" }));
    const request = snapshot({ "note.md": "after\n" });
    const accepted = db.backend.update(tree, owner, first.update, request, "same-request");
    const peer = db.reopen();
    expect(peer.update(tree, owner, first.update, request, "same-request")).toEqual(accepted);
    expect(() => peer.update(tree, owner, first.update, snapshot({ "note.md": "different\n" }), "same-request")).toThrow("different intent");
    const conflicted = peer.update(tree, owner, first.update, snapshot({ "note.md": "another\n" }), "another-request");
    const choices = [{ conflict: conflicted.conflicts[0]!.id, take: 0 }];
    const resolved = peer.resolve(tree, owner, conflicted.update, choices, "resolution");
    expect(db.reopen().resolve(tree, owner, conflicted.update, choices, "resolution")).toEqual(resolved);
    expect(peer.review(tree, owner)).toEqual(resolved);
  });

  test("resolves one of two hunks, preserves exact CRLF/BOM bytes and later edits", () => {
    const { backend } = database();
    const state = conflict(backend,
      "\uFEFF# One\r\nold one\r\n# Two\r\nold two\r\n# End\r\nno final newline",
      "\uFEFF# One\r\nleft one\r\n# Two\r\nleft two\r\n# End\r\nno final newline",
      "\uFEFF# One\r\nright one\r\n# Two\r\nright two\r\n# End\r\nno final newline");
    expect(state.conflicts).toHaveLength(2);
    const first = backend.resolve(tree, owner, state.update, [{ conflict: state.conflicts[0]!.id, bytes: encode("chosen one\r\n") }]);
    expect(first.conflicts).toHaveLength(1);
    expect(source(backend, first)).toBe("\uFEFF# One\r\nchosen one\r\n# Two\r\nright two\r\n# End\r\nno final newline");
    const edited = backend.update(tree, owner, first.update, snapshot({ "note.md": source(backend, first)!.replace("no final newline", "later edit") }));
    expect(edited.conflicts).toHaveLength(1);
    const second = backend.resolve(tree, owner, edited.update, [{ conflict: edited.conflicts[0]!.id, bytes: encode("chosen two\r\n") }]);
    expect(second.conflicts).toHaveLength(0);
    expect(source(backend, second)).toBe("\uFEFF# One\r\nchosen one\r\n# Two\r\nchosen two\r\n# End\r\nlater edit");
    expect(second.terms).toHaveLength(1);
  });

  test("merges disjoint text edits and checkpoints a clean state", () => {
    const { backend } = database();
    const state = conflict(backend, "# One\nold\n# Two\nold\n", "# One\nleft\n# Two\nold\n", "# One\nold\n# Two\nright\n");
    expect(state.conflicts).toHaveLength(0);
    expect(source(backend, state)).toBe("# One\nleft\n# Two\nright\n");
    expect(state.terms).toHaveLength(1);
  });

  test("stale and concurrent resolutions cannot overwrite newly accepted work", () => {
    const db = database();
    const state = conflict(db.backend);
    const peer = db.reopen();
    const winner = peer.resolve(tree, owner, state.update, [{ conflict: state.conflicts[0]!.id, bytes: encode("chosen\n") }]);
    expect(() => db.backend.resolve(tree, owner, state.update, [{ conflict: state.conflicts[0]!.id, take: 0 }])).toThrow("Stale conflict review");
    expect(db.backend.review(tree, owner)).toEqual(winner);
  });

  test("an old client's unrelated edit does not resurrect a resolved alternative", () => {
    const { backend } = database();
    const state = conflict(backend, "# Day\nMonday\n# Other\nold\n", "# Day\nTuesday\n# Other\nold\n", "# Day\nWednesday\n# Other\nold\n");
    backend.resolve(tree, owner, state.update, [{ conflict: state.conflicts[0]!.id, bytes: encode("Friday\n") }]);
    const later = backend.update(tree, owner, state.update, snapshot({ "note.md": "# Day\nWednesday\n# Other\nnew\n" }));
    expect(later.conflicts).toHaveLength(0);
    expect(source(backend, later)).toBe("# Day\nFriday\n# Other\nnew\n");
  });

  test("an old client's overlapping edit becomes a new conflict with the resolution", () => {
    const { backend } = database();
    const state = conflict(backend);
    backend.resolve(tree, owner, state.update, [{ conflict: state.conflicts[0]!.id, bytes: encode("Friday\n") }]);
    const later = backend.update(tree, owner, state.update, snapshot({ "note.md": "Saturday\n" }));
    expect(later.conflicts).toHaveLength(1);
    const region = later.conflicts[0]!;
    if (region.kind !== "text") throw new Error("Expected text conflict");
    expect(region.terms.map((term) => decode(term.value))).toEqual(["Saturday\n", "Friday\n", "Wednesday\n"]);
  });

  test("delete versus edit is a structural alternative and can explicitly choose deletion", () => {
    const { backend } = database();
    const first = backend.create(tree, owner, snapshot({ "note.md": "old\n" }));
    backend.update(tree, owner, first.update, snapshot({ "note.md": "edited\n" }));
    const state = backend.update(tree, owner, first.update, snapshot({}));
    expect(state.conflicts).toHaveLength(1);
    expect(state.conflicts[0]!.kind).toBe("entry");
    const resolved = backend.resolve(tree, owner, state.update, [{ conflict: state.conflicts[0]!.id, take: 0 }]);
    expect(resolved.conflicts).toHaveLength(0);
    expect(source(backend, resolved)).toBeNull();
  });

  test("file/directory and nested boundary conflicts preserve their kinds", () => {
    const { backend } = database();
    const first = backend.create(tree, owner, snapshot({ "item": "old" }, { nested: "tr_childa" }));
    backend.update(tree, owner, first.update, snapshot({ "item": "edit" }, { nested: "tr_childb" }));
    const state = backend.update(tree, owner, first.update, snapshot({ "item/child.md": "nested" }, { nested: "tr_childc" }));
    expect(state.conflicts.map((region) => [region.path, region.kind]).sort()).toEqual([["/item", "entry"], ["/nested", "entry"]]);
    const resolved = backend.resolve(tree, owner, state.update, state.conflicts.map((region) => ({ conflict: region.id, take: 0 })));
    expect(resolved.conflicts).toHaveLength(0);
    expect(source(backend, resolved, "item/child.md")).toBe("nested");
    const root = decodeWireDirectory(backend.readObject(tree, owner, resolved.root));
    expect(root.entries.find((entry) => entry.name === "nested")).toEqual({ name: "nested", tree: "tr_childc" });
  });

  test("a rename concurrent with an edit remains explicitly reviewable", () => {
    const { backend } = database();
    const first = backend.create(tree, owner, snapshot({ "note.md": "---\nid: page\n---\nold\n" }));
    backend.update(tree, owner, first.update, snapshot({ "note.md": "---\nid: page\n---\nedit\n" }));
    const state = backend.update(tree, owner, first.update, snapshot({ "moved.md": "---\nid: page\n---\nold\n" }));
    expect(state.conflicts.map((region) => region.path)).toEqual(["/note.md"]);
    expect(source(backend, state, "moved.md")).toContain("old");
    // The experiment conservatively preserves the edited source as an alternative;
    // it does not pretend term algebra provides page-ID rename tracking.
    const region = state.conflicts[0]!;
    if (region.kind !== "entry") throw new Error("Expected structural conflict");
    const edited = region.terms.find((term) => term.sign === 1 && term.value?.file);
    expect(decode(backend.readObject(tree, owner, edited!.value!.file!))).toContain("edit");
  });

  test("crossed anchors and repeated context fail conservatively without inventing text", () => {
    const { backend } = database();
    const state = conflict(backend, "first\nsecond\nrepeat\nrepeat\n", "second\nfirst\nrepeat\nrepeat\n", "first\nsecond\nchanged\nrepeat\n");
    expect(state.conflicts).toHaveLength(1);
    expect(source(backend, state)).toBe("first\nsecond\nchanged\nrepeat\n");
  });

  test("binary bytes, including invalid UTF-8 with a Markdown suffix, stay exact", () => {
    const { backend } = database();
    const first = backend.create(tree, owner, snapshot({ "note.md": new Uint8Array([255, 0, 1]) }));
    backend.update(tree, owner, first.update, snapshot({ "note.md": new Uint8Array([255, 0, 2]) }));
    const state = backend.update(tree, owner, first.update, snapshot({ "note.md": new Uint8Array([255, 0, 3]) }));
    expect(state.conflicts[0]!.kind).toBe("entry");
    const resolved = backend.resolve(tree, owner, state.update, [{ conflict: state.conflicts[0]!.id, take: 1 }]);
    const entry = decodeWireDirectory(backend.readObject(tree, owner, resolved.root)).entries[0]!;
    expect(backend.readObject(tree, owner, entry.file!)).toEqual(new Uint8Array([255, 0, 2]));
  });

  test("retention keeps hidden alternatives, expires old bases, then releases resolved objects", () => {
    const { backend } = database();
    const state = conflict(backend);
    const tuesday = hashObject(encode("Tuesday\n"));
    backend.prune(tree, owner, 1);
    expect(decode(backend.readObject(tree, owner, tuesday))).toBe("Tuesday\n");
    expect(() => backend.update(tree, owner, 1, snapshot({ "note.md": "stale\n" }))).toThrow("no longer retained");
    const resolved = backend.resolve(tree, owner, state.update, [{ conflict: state.conflicts[0]!.id, take: 0 }]);
    expect(backend.prune(tree, owner, 1).removedObjects).toBeGreaterThan(0);
    expect(() => backend.readObject(tree, owner, tuesday)).toThrow("not retained");
    expect(source(backend, resolved)).toBe("Wednesday\n");
  });

  test("ownership fences alternatives and prohibits guessing another tree's objects", () => {
    const { backend } = database();
    const secret = backend.create("tr_secret", "bob", snapshot({ "private.md": "private\n" }));
    const state = conflict(backend);
    expect(() => backend.review(tree, "bob")).toThrow("access denied");
    expect(() => backend.resolve(tree, "bob", state.update, [{ conflict: state.conflicts[0]!.id, take: 0 }])).toThrow("access denied");
    expect(() => backend.readObject(tree, owner, secret.root)).toThrow("not retained");
    expect(() => backend.update(tree, owner, state.update, { root: secret.root, objects: new Map() })).toThrow("unauthorized object");
    backend.prune(tree, owner, 1);
    expect(source(backend, secret, "private.md", "bob")).toBe("private\n");
  });

  test("corrupt candidates and invalid resolutions leave the accepted state intact", () => {
    const { backend } = database();
    const state = conflict(backend);
    const broken = snapshot({ "note.md": "changed\n" });
    broken.objects.set(hashObject(encode("changed\n")), encode("corrupt\n"));
    expect(() => backend.update(tree, owner, state.update, broken)).toThrow("hash mismatch");
    expect(() => backend.resolve(tree, owner, state.update, [{ conflict: state.conflicts[0]!.id, take: 2 }])).toThrow("positive alternative");
    expect(() => backend.resolve(tree, owner, state.update, [{ conflict: "missing", take: 0 }])).toThrow("Unknown");
    expect(backend.review(tree, owner)).toEqual(state);
  });

  test("bounds unresolved history by refusing a new update, never dropping alternatives", () => {
    const { backend } = database(3);
    const state = conflict(backend);
    expect(() => backend.update(tree, owner, 1, snapshot({ "note.md": "fourth\n" }))).toThrow("term limit");
    expect(backend.review(tree, owner)).toEqual(state);
    // Sequential edits to the selected alternative cancel rather than accumulating.
    let next = state;
    for (let index = 0; index < 20; index++) next = backend.update(tree, owner, next.update, snapshot({ "note.md": `new ${index}\n` }));
    expect(next.terms).toHaveLength(3);
    expect(next.conflicts).toHaveLength(1);
  });

  test("refuses a production-shaped database without touching its schema", () => {
    const { filename } = database();
    const db = new Database(filename);
    db.run("CREATE TABLE trees (id TEXT)");
    expect(() => new ConflictTermsBackend(filename)).toThrow("separate database");
    expect(db.query("SELECT name FROM sqlite_master WHERE name = 'trees'").get()).not.toBeNull();
    db.close();
  });

  test("a committed resolution survives process death without a graceful database close", async () => {
    const db = database();
    const state = conflict(db.backend);
    const module = new URL("../../../packages/canopy/src/experimental/conflict-terms/backend.ts", import.meta.url).pathname;
    const child = Bun.spawn([process.execPath, "--eval", `
      import { ConflictTermsBackend } from ${JSON.stringify(module)};
      const backend = new ConflictTermsBackend(${JSON.stringify(db.filename)});
      const review = backend.review(${JSON.stringify(tree)}, ${JSON.stringify(owner)});
      backend.resolve(review.tree, ${JSON.stringify(owner)}, review.update, [{ conflict: review.conflicts[0].id, bytes: new TextEncoder().encode("durable\\n") }], "child-resolution");
      process.stdout.write("committed\\n");
      setInterval(() => {}, 1000);
    `], { stdout: "pipe", stderr: "pipe" });
    try {
      const reader = child.stdout.getReader();
      const ready = await reader.read();
      expect(decode(ready.value!)).toBe("committed\n");
      reader.releaseLock();
    } finally {
      child.kill("SIGKILL");
      await child.exited;
    }
    const reopened = db.reopen();
    const recovered = reopened.review(tree, owner);
    expect(recovered.update).toBe(state.update + 1);
    expect(recovered.conflicts).toHaveLength(0);
    expect(source(reopened, recovered)).toBe("durable\n");
  });
});
