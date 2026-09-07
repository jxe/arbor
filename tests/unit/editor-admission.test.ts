import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { revisionOf } from "@arbor/core";
import { mergeWireTrees } from "@arbor/canopy";
import { snapshotDirectory } from "@arbor/fs";
import { applyTransitionPayload, decodeCandidateUpdateJSON, decodeWireObject } from "@arbor/wire";
import { documentAdmissionBasis, freezeEditorAdmission } from "../../packages/arborsync/src/editor-admission.ts";

describe("opaque editor admission basis", () => {
  test("freezes _index.md edits as an ordinary update without touching disk", async () => {
    const root = await mkdtemp(join(tmpdir(), "arbor-editor-admission-"));
    try {
      const source = "# Rehearsal\n\nOriginal.\n";
      await writeFile(join(root, "_index.md"), source);
      await writeFile(join(root, "other.md"), "# Other\n");
      const accepted = await snapshotDirectory(root);
      const directoryContentRevision = revisionOf(`${source}\0children`);
      const basis = documentAdmissionBasis({
        ref: { tree: "tr_rehearsal", path: "/", stableKey: null },
        update: "197",
        snapshot: accepted,
        wirePath: "/_index.md",
        contentRevision: directoryContentRevision,
        contentSource: source,
      });
      const replacement = "Native.\n";
      const resultSource = `${source}${replacement}`;
      const frozen = freezeEditorAdmission({
        ref: { tree: "tr_rehearsal", path: "/", stableKey: null },
        admissionBasis: basis,
        baseContentRevision: directoryContentRevision,
        source: resultSource,
        sourceEdits: [{ offset: Buffer.byteLength(source), length: 0, replacement }],
      });

      const request = decodeCandidateUpdateJSON(frozen.request);
      expect(frozen.request.base).toBe("197");
      expect(typeof request.candidate).toBe("string");
      expect(request.objects.length + request.deltas.length).toBeGreaterThan(0);
      const candidateObjects = applyTransitionPayload(accepted.objects, request);
      const candidateRoot = decodeWireObject(candidateObjects.get(request.candidate)!);
      if (candidateRoot.type !== "directory") throw new Error("Expected directory candidate");
      const index = candidateRoot.entries.find((entry) => entry.name === "_index.md");
      if (!index?.hash) throw new Error("Expected _index.md candidate");
      const file = decodeWireObject(candidateObjects.get(index.hash)!);
      if (file.type !== "file") throw new Error("Expected file candidate");
      expect(new TextDecoder().decode(file.bytes)).toBe(resultSource);
      expect(await readFile(join(root, "_index.md"), "utf8")).toBe(source);
      expect(freezeEditorAdmission({
        ref: frozen.ref,
        admissionBasis: basis,
        baseContentRevision: directoryContentRevision,
        source: resultSource,
        sourceEdits: [{ offset: Buffer.byteLength(source), length: 0, replacement }],
      }, [frozen])).toEqual(frozen);

      const secondSource = `${resultSource}Again.\n`;
      const second = freezeEditorAdmission({
        ref: frozen.ref,
        admissionBasis: frozen.admissionBasis,
        baseContentRevision: frozen.contentRevision,
        source: secondSource,
        sourceEdits: [{ offset: Buffer.byteLength(resultSource), length: 0, replacement: "Again.\n" }],
      });
      expect(second.id).toBe(frozen.id);
      expect(second.request.base).toBe("197");
      expect(second.request.candidate).not.toBe(frozen.request.candidate);
      expect(second.request.deltas).toEqual([]);
      const secondRequest = decodeCandidateUpdateJSON(second.request);
      const firstObjects = applyTransitionPayload(accepted.objects, request);
      const secondObjects = applyTransitionPayload(firstObjects, secondRequest);
      expect(secondObjects.has(secondRequest.candidate)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects edits whose guards do not match the accepted source", async () => {
    const root = await mkdtemp(join(tmpdir(), "arbor-editor-admission-"));
    try {
      const source = "# Base\n";
      await writeFile(join(root, "note.md"), source);
      const accepted = await snapshotDirectory(root);
      const basis = documentAdmissionBasis({
        ref: { tree: "tr_notes", path: "/note", stableKey: null },
        update: "12",
        snapshot: accepted,
        wirePath: "/note.md",
        contentRevision: revisionOf(source),
        contentSource: source,
      });
      expect(() => freezeEditorAdmission({
        ref: { tree: "tr_notes", path: "/note", stableKey: null },
        admissionBasis: basis,
        baseContentRevision: revisionOf(source),
        source: "# Edited\n",
        sourceEdits: [{ offset: 2, length: 4, replacement: "Edited", expected: "Else" }],
      })).toThrow("expected bytes do not match");
      expect(() => freezeEditorAdmission({
        ref: { tree: "tr_notes", path: "/other", stableKey: null },
        admissionBasis: basis,
        baseContentRevision: revisionOf(source),
        source: "# Edited\n",
      })).toThrow("belongs to another document");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("keeps sibling editor bases as independent Canopy candidates", async () => {
    const root = await mkdtemp(join(tmpdir(), "arbor-editor-admission-"));
    try {
      const noteSource = "# Note\n\nOriginal note.\n";
      const otherSource = "# Other\n\nOriginal other.\n";
      await writeFile(join(root, "note.md"), noteSource);
      await writeFile(join(root, "other.md"), otherSource);
      const accepted = await snapshotDirectory(root);
      const noteBasis = documentAdmissionBasis({
        ref: { tree: "tr_notes", path: "/note", stableKey: null },
        update: "12",
        snapshot: accepted,
        wirePath: "/note.md",
        contentRevision: revisionOf(noteSource),
        contentSource: noteSource,
      });
      const otherBasis = documentAdmissionBasis({
        ref: { tree: "tr_notes", path: "/other", stableKey: null },
        update: "12",
        snapshot: accepted,
        wirePath: "/other.md",
        contentRevision: revisionOf(otherSource),
        contentSource: otherSource,
      });

      const noteReplacement = "Edited note.";
      const first = freezeEditorAdmission({
        ref: { tree: "tr_notes", path: "/note", stableKey: null },
        admissionBasis: noteBasis,
        baseContentRevision: revisionOf(noteSource),
        source: noteSource.replace("Original note.", noteReplacement),
        sourceEdits: [{
          offset: Buffer.byteLength("# Note\n\n"),
          length: Buffer.byteLength("Original note."),
          replacement: noteReplacement,
          expected: "Original note.",
        }],
      });
      const otherReplacement = "Edited other.";
      const second = freezeEditorAdmission({
        ref: { tree: "tr_notes", path: "/other", stableKey: null },
        admissionBasis: otherBasis,
        baseContentRevision: revisionOf(otherSource),
        source: otherSource.replace("Original other.", otherReplacement),
        sourceEdits: [{
          offset: Buffer.byteLength("# Other\n\n"),
          length: Buffer.byteLength("Original other."),
          replacement: otherReplacement,
          expected: "Original other.",
        }],
      }, [first]);

      expect(second.id).not.toBe(first.id);
      expect(second.editorID).not.toBe(first.editorID);
      expect(second.request.base).toBe(first.request.base);
      const firstRequest = decodeCandidateUpdateJSON(first.request);
      const secondRequest = decodeCandidateUpdateJSON(second.request);
      const afterFirst = applyTransitionPayload(accepted.objects, firstRequest);
      const sibling = applyTransitionPayload(accepted.objects, secondRequest);
      const firstRoot = decodeWireObject(afterFirst.get(firstRequest.candidate)!);
      const candidateRoot = decodeWireObject(sibling.get(secondRequest.candidate)!);
      if (firstRoot.type !== "directory") throw new Error("Expected first directory candidate");
      if (candidateRoot.type !== "directory") throw new Error("Expected directory candidate");
      const firstNote = firstRoot.entries.find((entry) => entry.name === "note.md");
      const note = candidateRoot.entries.find((entry) => entry.name === "note.md");
      const other = candidateRoot.entries.find((entry) => entry.name === "other.md");
      if (!firstNote?.hash || !note?.hash || !other?.hash) throw new Error("Expected both candidate documents");
      const firstNoteFile = decodeWireObject(afterFirst.get(firstNote.hash)!);
      const noteFile = decodeWireObject(sibling.get(note.hash)!);
      const otherFile = decodeWireObject(sibling.get(other.hash)!);
      if (firstNoteFile.type !== "file" || noteFile.type !== "file" || otherFile.type !== "file") throw new Error("Expected file candidates");
      expect(new TextDecoder().decode(firstNoteFile.bytes)).toContain(noteReplacement);
      expect(new TextDecoder().decode(noteFile.bytes)).toBe(noteSource);
      expect(new TextDecoder().decode(otherFile.bytes)).toContain(otherReplacement);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("keeps overlapping sibling edits for Canopy reconciliation", async () => {
    const root = await mkdtemp(join(tmpdir(), "arbor-editor-admission-"));
    try {
      const source = "# Note\n\nFirst.\nSecond.\n";
      await writeFile(join(root, "note.md"), source);
      const accepted = await snapshotDirectory(root);
      const makeBasis = () => documentAdmissionBasis({
        ref: { tree: "tr_notes", path: "/note", stableKey: null },
        update: "12",
        snapshot: accepted,
        wirePath: "/note.md",
        contentRevision: revisionOf(source),
        contentSource: source,
      });
      const firstOffset = Buffer.byteLength("# Note\n\n");
      const secondOffset = Buffer.byteLength("# Note\n\nFirst.\n");
      const sharedBasis = makeBasis();
      const first = freezeEditorAdmission({
        ref: { tree: "tr_notes", path: "/note", stableKey: null },
        editorID: "editor-a",
        admissionBasis: sharedBasis,
        baseContentRevision: revisionOf(source),
        source: source.replace("Second.", "Changed second."),
        sourceEdits: [{ offset: secondOffset, length: 7, replacement: "Changed second.", expected: "Second." }],
      });
      const sibling = freezeEditorAdmission({
        ref: { tree: "tr_notes", path: "/note", stableKey: null },
        editorID: "editor-b",
        admissionBasis: sharedBasis,
        baseContentRevision: revisionOf(source),
        source: source.replace("First.", "Changed first."),
        sourceEdits: [{ offset: firstOffset, length: 6, replacement: "Changed first.", expected: "First." }],
      }, [first]);
      expect(sibling.id).not.toBe(first.id);
      expect(sibling.request.base).toBe(first.request.base);
      expect(sibling.source).toBe("# Note\n\nChanged first.\nSecond.\n");

      const overlap = freezeEditorAdmission({
        ref: { tree: "tr_notes", path: "/note", stableKey: null },
        editorID: "editor-c",
        admissionBasis: sharedBasis,
        baseContentRevision: revisionOf(source),
        source: source.replace("Second.", "Competing second."),
        sourceEdits: [{ offset: secondOffset, length: 7, replacement: "Competing second.", expected: "Second." }],
      }, [first]);
      expect(overlap.id).not.toBe(first.id);
      expect(overlap.source).toBe("# Note\n\nFirst.\nCompeting second.\n");

      const firstRequest = decodeCandidateUpdateJSON(first.request);
      const overlapRequest = decodeCandidateUpdateJSON(overlap.request);
      const firstObjects = applyTransitionPayload(accepted.objects, firstRequest);
      const overlapObjects = applyTransitionPayload(accepted.objects, overlapRequest);
      const objects = new Map([...accepted.objects, ...firstObjects, ...overlapObjects]);
      const merged = await mergeWireTrees(
        accepted.root,
        overlapRequest.candidate,
        firstRequest.candidate,
        async (hash) => objects.get(hash)!,
      );
      expect(merged.conflicts).toEqual([]);
      expect(merged.summary?.version).toBe("markdown-additive-v1");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a stale same-editor generation supersedes an overlapping earlier generation", async () => {
    const root = await mkdtemp(join(tmpdir(), "arbor-editor-admission-"));
    try {
      const source = "# Note\n\nFirst.\nSecond.\n";
      await writeFile(join(root, "note.md"), source);
      const accepted = await snapshotDirectory(root);
      const basis = documentAdmissionBasis({
        ref: { tree: "tr_notes", path: "/note", stableKey: null },
        update: "12",
        snapshot: accepted,
        wirePath: "/note.md",
        contentRevision: revisionOf(source),
        contentSource: source,
      });
      const first = freezeEditorAdmission({
        ref: { tree: "tr_notes", path: "/note", stableKey: null },
        editorID: "editor-native",
        admissionBasis: basis,
        baseContentRevision: revisionOf(source),
        source: source.replace("Second.", "Earlier generation."),
        sourceEdits: [{
          offset: Buffer.byteLength("# Note\n\nFirst.\n"),
          length: Buffer.byteLength("Second."),
          replacement: "Earlier generation.",
          expected: "Second.",
        }],
      });
      const secondSource = first.source.replace("First.", "Changed first.");
      const second = freezeEditorAdmission({
        ref: first.ref,
        editorID: "editor-native",
        admissionBasis: first.admissionBasis,
        baseContentRevision: first.contentRevision,
        source: secondSource,
        sourceEdits: [{
          offset: Buffer.byteLength("# Note\n\n"),
          length: Buffer.byteLength("First."),
          replacement: "Changed first.",
          expected: "First.",
        }],
      }, [first]);

      const latestSource = source.replace("Second.", "Latest exact editor state.");
      const latest = freezeEditorAdmission({
        ref: first.ref,
        editorID: "editor-native",
        admissionBasis: basis,
        baseContentRevision: revisionOf(source),
        source: latestSource,
        sourceEdits: [{
          offset: Buffer.byteLength("# Note\n\nFirst.\n"),
          length: Buffer.byteLength("Second."),
          replacement: "Latest exact editor state.",
          expected: "Second.",
        }],
      }, [first, second]);

      expect(latest.editorID).toBe(first.editorID);
      expect(latest.source).toBe(latestSource);
      expect(latest.request.candidate).not.toBe(second.request.candidate);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
