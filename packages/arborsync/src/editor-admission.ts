import { applySourceEdits, revisionOf, type NodeRef, type SourceEdit } from "@arbor/core";
import {
  decodeObjectEnvelopes,
  decodeWireObject,
  encodeObjectDeltaJSON,
  encodeObjectEnvelopes,
  encodeWireObject,
  hashObject,
  objectDelta,
  type ObjectDelta,
  type ObjectHash,
  type TreeSnapshot,
  type CandidateUpdateJSON,
} from "@arbor/wire";

interface AdmissionBasisValue {
  version: 1;
  id: string;
  ref: NodeRef;
  baseUpdate: string;
  baseRoot: ObjectHash;
  candidateRoot: ObjectHash;
  wirePath: string;
  contentRevision: string;
  /** Exact Wire file revision when the public content revision also covers directory children. */
  storedContentRevision?: string;
  objects: ReturnType<typeof encodeObjectEnvelopes>;
}

export interface FrozenEditorAdmission {
  id: string;
  ref: NodeRef;
  request: CandidateUpdateJSON & { base: string };
  source: string;
  contentRevision: string;
  admissionBasis: string;
  /** Durable acknowledgement marker; retained until the editor reanchors on a newer watchpoint. */
  acknowledged?: boolean;
}

function encodeBasis(value: AdmissionBasisValue): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeBasis(value: string): AdmissionBasisValue {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new Error("Document admission basis is invalid");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Document admission basis is invalid");
  const record = parsed as Record<string, unknown>;
  const ref = record.ref as Record<string, unknown> | undefined;
  if (
    record.version !== 1
    || typeof record.id !== "string"
    || !ref
    || typeof ref !== "object"
    || Array.isArray(ref)
    || typeof ref.tree !== "string"
    || typeof ref.path !== "string"
    || (ref.stableKey !== null && typeof ref.stableKey !== "string")
    || Object.keys(ref).some((key) => !["tree", "path", "stableKey"].includes(key))
    || typeof record.baseUpdate !== "string"
    || typeof record.baseRoot !== "string"
    || typeof record.candidateRoot !== "string"
    || typeof record.wirePath !== "string"
    || typeof record.contentRevision !== "string"
    || (record.storedContentRevision !== undefined && typeof record.storedContentRevision !== "string")
    || !Array.isArray(record.objects)
    || Object.keys(record).some((key) => ![
      "version", "id", "ref", "baseUpdate", "baseRoot", "candidateRoot", "wirePath", "contentRevision", "storedContentRevision", "objects",
    ].includes(key))
  ) throw new Error("Document admission basis is invalid");
  // Decode once here so malformed, noncanonical, or hash-mismatched objects
  // never survive until an admission attempt.
  decodeObjectEnvelopes(record.objects);
  return record as unknown as AdmissionBasisValue;
}

function pathSegments(path: string): string[] {
  if (!path.startsWith("/") || path.includes("\\") || path.includes("\0")) {
    throw new Error("Document admission Wire path is invalid");
  }
  const segments = path.split("/").slice(1);
  if (!segments.length || segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("Document admission Wire path must name an ordinary file");
  }
  return segments;
}

/** Retain only the file and directory spine Native must return with a later edit. */
export function documentAdmissionBasis(input: {
  ref: NodeRef;
  update: string;
  snapshot: TreeSnapshot;
  wirePath: string;
  contentRevision: string;
  contentSource: string;
}): string {
  const objects = new Map<ObjectHash, Uint8Array>();
  const segments = pathSegments(input.wirePath);
  let hash = input.snapshot.root;
  let storedContentRevision: string | undefined;
  for (const [index, segment] of segments.entries()) {
    const bytes = input.snapshot.objects.get(hash);
    if (!bytes) throw new Error(`Accepted snapshot is missing object: ${hash}`);
    objects.set(hash, bytes);
    const object = decodeWireObject(bytes);
    if (object.type !== "directory") throw new Error(`Document admission path is not a directory before ${segment}`);
    const entry = object.entries.find((candidate) => candidate.name === segment);
    if (!entry?.hash || entry.tree) throw new Error(`Document admission path is absent from its accepted tree: ${input.wirePath}`);
    hash = entry.hash;
    if (index === segments.length - 1) {
      const fileBytes = input.snapshot.objects.get(hash);
      if (!fileBytes) throw new Error(`Accepted snapshot is missing object: ${hash}`);
      const file = decodeWireObject(fileBytes);
      if (file.type !== "file") throw new Error(`Document admission path is not a file: ${input.wirePath}`);
      const source = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
      if (source !== input.contentSource) {
        throw new Error("Document source does not match its accepted Wire file");
      }
      storedContentRevision = revisionOf(file.bytes);
      objects.set(hash, fileBytes);
    }
  }
  return encodeBasis({
    version: 1,
    id: crypto.randomUUID(),
    ref: input.ref,
    baseUpdate: input.update,
    baseRoot: input.snapshot.root,
    candidateRoot: input.snapshot.root,
    wirePath: input.wirePath,
    contentRevision: input.contentRevision,
    storedContentRevision,
    objects: encodeObjectEnvelopes(objects),
  });
}

/** Build one standard updates-v1 candidate from an opaque basis returned by Native. */
export function freezeEditorAdmission(input: {
  ref: NodeRef;
  admissionBasis: string;
  baseContentRevision: string;
  source: string;
  sourceEdits?: SourceEdit[];
}): FrozenEditorAdmission {
  const basis = decodeBasis(input.admissionBasis);
  if (
    basis.ref.tree !== input.ref.tree
    || basis.ref.path !== input.ref.path
    || basis.ref.stableKey !== input.ref.stableKey
  ) throw new Error("Document admission basis belongs to another document");
  if (basis.contentRevision !== input.baseContentRevision) throw new Error("Document admission basis has another content revision");
  const objects = new Map(decodeObjectEnvelopes(basis.objects).map((object) => [object.hash, object.bytes]));
  const segments = pathSegments(basis.wirePath);
  const generated = new Map<ObjectHash, Uint8Array>();
  let baseFileBytes: Uint8Array | undefined;
  let resultFileBytes: Uint8Array | undefined;

  const replace = (hash: ObjectHash, index: number): ObjectHash => {
    const bytes = objects.get(hash);
    if (!bytes) throw new Error(`Document admission basis is missing object: ${hash}`);
    const object = decodeWireObject(bytes);
    if (object.type !== "directory") throw new Error("Document admission basis has an invalid directory spine");
    const name = segments[index]!;
    const offset = object.entries.findIndex((entry) => entry.name === name);
    const entry = object.entries[offset];
    if (!entry?.hash || entry.tree) throw new Error(`Document admission path is absent from its basis: ${basis.wirePath}`);
    let replacement: ObjectHash;
    if (index === segments.length - 1) {
      const stored = objects.get(entry.hash);
      if (!stored) throw new Error(`Document admission basis is missing object: ${entry.hash}`);
      const file = decodeWireObject(stored);
      if (file.type !== "file") throw new Error(`Document admission target is not a file: ${basis.wirePath}`);
      if (revisionOf(file.bytes) !== (basis.storedContentRevision ?? input.baseContentRevision)) {
        throw new Error("Document admission source changed before it was frozen");
      }
      const baseSource = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
      if (input.sourceEdits && applySourceEdits(baseSource, input.sourceEdits) !== input.source) {
        throw new Error("Document source edits do not produce the submitted exact source");
      }
      baseFileBytes = stored;
      resultFileBytes = encodeWireObject({ type: "file", bytes: new TextEncoder().encode(input.source) });
      replacement = hashObject(resultFileBytes);
      generated.set(replacement, resultFileBytes);
    } else {
      replacement = replace(entry.hash, index + 1);
    }
    const entries = [...object.entries];
    entries[offset] = { name, hash: replacement };
    const resultBytes = encodeWireObject({ ...object, entries });
    const result = hashObject(resultBytes);
    generated.set(result, resultBytes);
    return result;
  };

  const candidate = replace(basis.candidateRoot, 0);
  if (!baseFileBytes || !resultFileBytes) throw new Error("Document admission basis omitted its file");
  const completeObjects = new Map(generated);
  const deltas: ObjectDelta[] = [];
  // A delta may only name an object reachable from the accepted base. A later
  // edit in the same queued chain therefore sends its final file completely.
  if (basis.candidateRoot === basis.baseRoot && hashObject(baseFileBytes) !== hashObject(resultFileBytes)) {
    const delta: ObjectDelta = {
      base: hashObject(baseFileBytes),
      result: hashObject(resultFileBytes),
      instructions: objectDelta(baseFileBytes, resultFileBytes),
    };
    const deltaSize = Buffer.byteLength(JSON.stringify(encodeObjectDeltaJSON(delta)));
    const completeSize = Buffer.byteLength(JSON.stringify(encodeObjectEnvelopes([[delta.result, resultFileBytes]])[0]));
    if (deltaSize < completeSize) {
      completeObjects.delete(delta.result);
      deltas.push(delta);
    }
  }

  const nextObjects = new Map(generated);
  return {
    id: basis.id,
    ref: input.ref,
    request: {
      base: basis.baseUpdate,
      candidate,
      ifMatch: "modelHash",
      objects: encodeObjectEnvelopes(completeObjects),
      deltas: deltas.map(encodeObjectDeltaJSON),
    },
    source: input.source,
    contentRevision: revisionOf(input.source),
    admissionBasis: encodeBasis({
      ...basis,
      candidateRoot: candidate,
      contentRevision: revisionOf(input.source),
      storedContentRevision: revisionOf(input.source),
      objects: encodeObjectEnvelopes(nextObjects),
    }),
  };
}
