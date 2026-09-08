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
  type AcceptedUpdate,
  decodeCandidateUpdateJSON,
  updateRequestDigests,
} from "@arbor/wire";

interface AdmissionBasisValue {
  version: 1;
  /** Stable identity of one editor session, independent of its shared update epoch. */
  editorID?: string;
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

export function editorAdmissionContext(admission: FrozenEditorAdmission): {
  baseRoot: ObjectHash;
  wirePath: string;
} {
  const basis = decodeBasis(admission.admissionBasis);
  return { baseRoot: basis.baseRoot, wirePath: basis.wirePath };
}

export interface FrozenEditorAdmission {
  editorID?: string;
  id: string;
  ref: NodeRef;
  request: CandidateUpdateJSON & { base: string };
  source: string;
  contentRevision: string;
  admissionBasis: string;
  /** Credential-scoped digest Canopy will echo when this generation is accepted. */
  requestDigest?: `sha256:${string}`;
  /** Set before the first POST that carries this element; a transmitted element is immutable. */
  transmitted?: boolean;
  /** Durable acknowledgement marker; retained until the editor reanchors on a newer watchpoint. */
  acknowledged?: boolean;
  /** The exact authority decision for this candidate, retained through materialization. */
  accepted?: AcceptedUpdate;
}

export function acceptedEditorAdmissionNeedsReview(admission: FrozenEditorAdmission): boolean {
  if (!admission.accepted) return admission.transmitted === true;
  return admission.accepted.merge?.version === "markdown-additive-v1"
    && admission.accepted.merge.approximatePlacements > 0;
}

export class EditorAdmissionReconciliationError extends Error {
  constructor(
    message: string,
    public reason: "missing-head-object" | "missing-path" | "invalid-path" | "invalid-utf8" | "independent-replacement" | "overlapping-source-edits",
  ) {
    super(message);
    this.name = "EditorAdmissionReconciliationError";
  }
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
    || (record.editorID !== undefined && typeof record.editorID !== "string")
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
      "version", "editorID", "id", "ref", "baseUpdate", "baseRoot", "candidateRoot", "wirePath", "contentRevision", "storedContentRevision", "objects",
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
  const editorID = crypto.randomUUID();
  return encodeBasis({
    version: 1,
    editorID,
    id: editorID,
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

/**
 * Build one standard updates-v1 candidate from an opaque basis returned by
 * Native. Later generations from the same editor extend its immutable string;
 * sibling editors retain independent candidates from their shared accepted
 * base so Canopy, rather than a local patch heuristic, reconciles them.
 */
export function freezeEditorAdmission(input: {
  ref: NodeRef;
  editorID?: string;
  admissionBasis: string;
  baseContentRevision: string;
  source: string;
  sourceEdits?: SourceEdit[];
}, predecessors: readonly FrozenEditorAdmission[] = []): FrozenEditorAdmission {
  let basis = decodeBasis(input.admissionBasis);
  if (input.editorID && basis.editorID !== input.editorID) {
    // The basis describes the graph the editor saw; this value identifies the
    // live editor which authored the new generation. A newly opened editor may
    // legitimately receive another editor's retained pending graph.
    basis = { ...basis, editorID: input.editorID, id: input.editorID };
  }
  if (
    basis.ref.tree !== input.ref.tree
    || basis.ref.path !== input.ref.path
    || basis.ref.stableKey !== input.ref.stableKey
  ) throw new Error("Document admission basis belongs to another document");
  if (basis.contentRevision !== input.baseContentRevision) throw new Error("Document admission basis has another content revision");
  let objects = new Map(decodeObjectEnvelopes(basis.objects).map((object) => [object.hash, object.bytes]));
  const segments = pathSegments(basis.wirePath);
  const sourceAt = (root: ObjectHash, graph: ReadonlyMap<ObjectHash, Uint8Array>): string => {
    let hash = root;
    for (const [index, segment] of segments.entries()) {
      const bytes = graph.get(hash);
      if (!bytes) throw new EditorAdmissionReconciliationError(`Pending editor head is missing object: ${hash}`, "missing-head-object");
      const object = decodeWireObject(bytes);
      if (object.type !== "directory") throw new EditorAdmissionReconciliationError("Pending editor path is not a directory", "invalid-path");
      const entry = object.entries.find((candidate) => candidate.name === segment);
      if (!entry?.hash || entry.tree) {
        throw new EditorAdmissionReconciliationError(`Pending editor path no longer exists: ${basis.wirePath}`, "missing-path");
      }
      hash = entry.hash;
      if (index === segments.length - 1) {
        const fileBytes = graph.get(hash);
        if (!fileBytes) throw new EditorAdmissionReconciliationError(`Pending editor head is missing object: ${hash}`, "missing-head-object");
        const file = decodeWireObject(fileBytes);
        if (file.type !== "file") throw new EditorAdmissionReconciliationError("Pending editor target is not a file", "invalid-path");
        try {
          return new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
        } catch {
          throw new EditorAdmissionReconciliationError("Pending editor target is not UTF-8 Markdown", "invalid-utf8");
        }
      }
    }
    throw new EditorAdmissionReconciliationError("Pending editor path omitted its file", "missing-path");
  };

  const basisSource = sourceAt(basis.candidateRoot, objects);
  if (input.sourceEdits && applySourceEdits(basisSource, input.sourceEdits) !== input.source) {
    throw new Error("Document source edits do not produce the submitted exact source");
  }

  let resultSource = input.source;
  const editorID = input.editorID ?? basis.editorID ?? basis.id;
  // An editor's speculative string is independent of sibling editors which
  // happened to observe the same accepted Canopy base. Keep those siblings as
  // separate local epochs: the authority can then reconcile each
  // (base, candidate, current) tuple with the representation's merge rule.
  const predecessor = predecessors.findLast((candidate) => {
    const candidateBasis = decodeBasis(candidate.admissionBasis);
    return (candidate.editorID ?? candidateBasis.editorID ?? candidateBasis.id) === editorID;
  });
  if (predecessor) {
    // Derive the submitted candidate without a local head once so an exact
    // retry remains idempotent even after later generations were appended.
    const submitted = freezeEditorAdmission(input);
    const duplicate = predecessors.find((candidate) =>
      candidate.id === basis.id && candidate.request.candidate === submitted.request.candidate
    );
    if (duplicate) return duplicate;

    const predecessorBasis = decodeBasis(predecessor.admissionBasis);
    const predecessorEditorID = predecessor.editorID ?? predecessorBasis.editorID ?? predecessorBasis.id;
    const continuesDeclaredChain = predecessor.id === basis.id
      && predecessor.request.candidate === basis.candidateRoot;
    const sharesAcceptedBase = predecessor.request.base === basis.baseUpdate;
    if (!continuesDeclaredChain && sharesAcceptedBase) {
      for (const admission of predecessors) {
        const admissionBasis = decodeBasis(admission.admissionBasis);
        for (const object of decodeObjectEnvelopes(admissionBasis.objects)) objects.set(object.hash, object.bytes);
      }
      const headSource = sourceAt(predecessor.request.candidate, objects);
      if (headSource !== basisSource) {
        if (predecessorEditorID === editorID && predecessor.ref.tree === input.ref.tree
          && predecessor.ref.path === input.ref.path && predecessor.ref.stableKey === input.ref.stableKey) {
          // Responses and watch echoes can arrive after a newer commit has
          // already captured the editor tree. Within one editor session,
          // request arrival is the generation order and the later exact source
          // supersedes the earlier source for this document.
          resultSource = input.source;
        } else if (!input.sourceEdits) {
          throw new EditorAdmissionReconciliationError("Another local editor changed this document before the submitted replacement", "independent-replacement");
        } else {
          try {
            resultSource = applySourceEdits(headSource, input.sourceEdits);
          } catch {
            throw new EditorAdmissionReconciliationError("Another local editor changed the submitted patch range", "overlapping-source-edits");
          }
        }
      }
      basis = {
        ...basis,
        id: predecessor.id,
        baseUpdate: predecessor.request.base,
        baseRoot: predecessorBasis.baseRoot,
        candidateRoot: predecessor.request.candidate,
        storedContentRevision: revisionOf(headSource),
      };
    }
  }

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
      baseFileBytes = stored;
      resultFileBytes = encodeWireObject({ type: "file", bytes: new TextEncoder().encode(resultSource) });
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
  const request: CandidateUpdateJSON & { base: string } = {
    base: basis.baseUpdate,
    candidate,
    ifMatch: "modelHash",
    objects: encodeObjectEnvelopes(completeObjects),
    deltas: deltas.map(encodeObjectDeltaJSON),
  };
  const sameEpoch = predecessors.filter((admission) => admission.id === basis.id);
  const requestDigest = updateRequestDigests(input.ref.tree, {
    base: request.base,
    updates: [...sameEpoch.map((admission) => decodeCandidateUpdateJSON(admission.request)), decodeCandidateUpdateJSON(request)],
  }).at(-1)! as `sha256:${string}`;
  return {
    editorID: basis.editorID ?? basis.id,
    id: basis.id,
    ref: input.ref,
    request,
    source: resultSource,
    contentRevision: revisionOf(resultSource),
    admissionBasis: encodeBasis({
      ...basis,
      candidateRoot: candidate,
      contentRevision: revisionOf(resultSource),
      storedContentRevision: revisionOf(resultSource),
      objects: encodeObjectEnvelopes(nextObjects),
    }),
    requestDigest,
  };
}
