import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { revisionOf } from "@arbor/core";
import { snapshotDirectory } from "@arbor/fs";
import { applyTransitionPayload, decodeUpdateRequestJSON, decodeWireObject } from "@arbor/wire";
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

      const request = decodeUpdateRequestJSON(frozen.request);
      expect(request.base).toBe("197");
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
      const secondRequest = decodeUpdateRequestJSON(second.request);
      const secondObjects = applyTransitionPayload(accepted.objects, secondRequest);
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
});
