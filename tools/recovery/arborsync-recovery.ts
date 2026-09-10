import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { mergeWireTrees, type MergeResult } from "@arbor/canopy";
import { resolveSnapshot, snapshotDirectory } from "@arbor/fs";
import {
  applyTransitionPayload,
  compareWireNames,
  decodeObjectDeltas,
  decodeObjectEnvelopes,
  decodeWireObject,
  encodeWireObject,
  hashObject,
  resolveWireLogicalNode,
  verifyTreeSnapshotGraph,
  type ObjectHash,
  type TreeSnapshot,
} from "@arbor/wire";

const HASH = /^sha256:[a-f0-9]{64}$/;

export interface StoredCandidate {
  base: string | null;
  candidate: ObjectHash;
  ifMatch: "bytesHash" | "modelHash";
  onConflict?: "reject" | "merge";
  objects: unknown;
  deltas?: unknown;
  successors?: unknown[];
  origin?: string;
}

export interface LegacyEditorAdmission {
  editorID?: string;
  id: string;
  ref: { tree: string; path: string; stableKey: string | null };
  request: StoredCandidate;
  source: string;
  contentRevision: string;
  admissionBasis: string;
  requestDigest?: ObjectHash;
  transmitted?: boolean;
  acknowledged?: boolean;
}

export interface AdmissionBasis {
  version: 1;
  editorID?: string;
  id: string;
  ref: { tree: string; path: string; stableKey: string | null };
  baseUpdate: string;
  baseRoot: ObjectHash;
  candidateRoot: ObjectHash;
  wirePath: string;
  contentRevision: string;
  storedContentRevision?: string;
  objects: unknown;
}

export interface RawSyncState {
  accepted?: { root: ObjectHash; hashes: ObjectHash[] };
  pending?: StoredCandidate;
  editorAdmissions: LegacyEditorAdmission[];
  acceptedRequestDigests: ObjectHash[];
  raw: unknown;
}

export interface RecoveryVariant {
  name: string;
  localRoot: ObjectHash;
  basisUpdate: string;
  basisRoot: ObjectHash;
  snapshot: TreeSnapshot;
  merge: MergeResult;
  source?: { path: string; sha256: string; bytes: number };
}

function record(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function string(value: unknown, message: string): string {
  if (typeof value !== "string" || !value) throw new Error(message);
  return value;
}

function objectHash(value: unknown, message: string): ObjectHash {
  const result = string(value, message);
  if (!HASH.test(result)) throw new Error(message);
  return result;
}

export function sha256Bytes(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function syncStatePath(dataHome: string, tree: string): string {
  return join(dataHome, ".state", "sync", `${Buffer.from(tree).toString("base64url")}.json`);
}

/** Read the legacy keys directly: the refactored state adapter intentionally drops them. */
export function decodeRawSyncState(value: unknown): RawSyncState {
  const root = record(value, "ArborSync state must be an object");
  const acceptedValue = root.accepted === undefined ? undefined : record(root.accepted, "accepted is invalid");
  const accepted = acceptedValue === undefined ? undefined : {
    root: objectHash(acceptedValue.root, "accepted.root is invalid"),
    hashes: Array.isArray(acceptedValue.hashes)
      ? acceptedValue.hashes.map((hash) => objectHash(hash, "accepted.hashes is invalid"))
      : (() => { throw new Error("accepted.hashes is invalid"); })(),
  };
  const pending = root.pending === undefined ? undefined : decodeStoredCandidate(root.pending);
  const admissions = root.editorAdmissions === undefined ? [] : root.editorAdmissions;
  if (!Array.isArray(admissions)) throw new Error("editorAdmissions is invalid");
  const editorAdmissions = admissions.map(decodeAdmission);
  const digests = root.acceptedRequestDigests === undefined ? [] : root.acceptedRequestDigests;
  if (!Array.isArray(digests)) throw new Error("acceptedRequestDigests is invalid");
  return {
    ...(accepted ? { accepted } : {}),
    ...(pending ? { pending } : {}),
    editorAdmissions,
    acceptedRequestDigests: digests.map((digest) => objectHash(digest, "acceptedRequestDigests is invalid")),
    raw: value,
  };
}

export async function readRawSyncState(dataHome: string, tree: string): Promise<{ path: string; source: string; state: RawSyncState }> {
  const path = syncStatePath(dataHome, tree);
  const source = await readFile(path, "utf8");
  return { path, source, state: decodeRawSyncState(JSON.parse(source)) };
}

function decodeStoredCandidate(value: unknown): StoredCandidate {
  const item = record(value, "candidate is invalid");
  const base = item.base;
  if (base !== null && (typeof base !== "string" || !base)) throw new Error("candidate.base is invalid");
  const ifMatch = item.ifMatch;
  if (ifMatch !== "bytesHash" && ifMatch !== "modelHash") throw new Error("candidate.ifMatch is invalid");
  const onConflict = item.onConflict;
  if (onConflict !== undefined && onConflict !== "reject" && onConflict !== "merge") throw new Error("candidate.onConflict is invalid");
  // Decode now to validate canonical base64, duplicate envelopes, and deltas.
  decodeObjectEnvelopes(item.objects);
  decodeObjectDeltas(item.deltas ?? []);
  return {
    base,
    candidate: objectHash(item.candidate, "candidate root is invalid"),
    ifMatch,
    ...(onConflict ? { onConflict } : {}),
    objects: item.objects,
    deltas: item.deltas ?? [],
    ...(Array.isArray(item.successors) ? { successors: item.successors } : {}),
    ...(typeof item.origin === "string" ? { origin: item.origin } : {}),
  };
}

function decodeAdmission(value: unknown): LegacyEditorAdmission {
  const item = record(value, "editor admission is invalid");
  const ref = record(item.ref, "editor admission ref is invalid");
  const stableKey = ref.stableKey;
  if (stableKey !== null && typeof stableKey !== "string") throw new Error("editor admission stable key is invalid");
  return {
    ...(typeof item.editorID === "string" ? { editorID: item.editorID } : {}),
    id: string(item.id, "editor admission id is invalid"),
    ref: {
      tree: string(ref.tree, "editor admission tree is invalid"),
      path: string(ref.path, "editor admission path is invalid"),
      stableKey,
    },
    request: decodeStoredCandidate(item.request),
    source: typeof item.source === "string" ? item.source : (() => { throw new Error("editor admission source is invalid"); })(),
    contentRevision: string(item.contentRevision, "editor admission revision is invalid"),
    admissionBasis: string(item.admissionBasis, "editor admission basis is invalid"),
    ...(item.requestDigest === undefined ? {} : { requestDigest: objectHash(item.requestDigest, "editor admission digest is invalid") }),
    ...(typeof item.transmitted === "boolean" ? { transmitted: item.transmitted } : {}),
    ...(typeof item.acknowledged === "boolean" ? { acknowledged: item.acknowledged } : {}),
  };
}

export function decodeAdmissionBasis(encoded: string): AdmissionBasis {
  let value: unknown;
  try { value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")); }
  catch { throw new Error("editor admission basis is not valid base64url JSON"); }
  const item = record(value, "editor admission basis is invalid");
  const ref = record(item.ref, "editor admission basis ref is invalid");
  const stableKey = ref.stableKey;
  if (stableKey !== null && typeof stableKey !== "string") throw new Error("editor admission basis stable key is invalid");
  if (item.version !== 1) throw new Error("unsupported editor admission basis version");
  decodeObjectEnvelopes(item.objects);
  return {
    version: 1,
    ...(typeof item.editorID === "string" ? { editorID: item.editorID } : {}),
    id: string(item.id, "editor admission basis id is invalid"),
    ref: {
      tree: string(ref.tree, "editor admission basis tree is invalid"),
      path: string(ref.path, "editor admission basis path is invalid"),
      stableKey,
    },
    baseUpdate: string(item.baseUpdate, "editor admission base update is invalid"),
    baseRoot: objectHash(item.baseRoot, "editor admission base root is invalid"),
    candidateRoot: objectHash(item.candidateRoot, "editor admission candidate root is invalid"),
    wirePath: string(item.wirePath, "editor admission wire path is invalid"),
    contentRevision: string(item.contentRevision, "editor admission content revision is invalid"),
    ...(typeof item.storedContentRevision === "string" ? { storedContentRevision: item.storedContentRevision } : {}),
    objects: item.objects,
  };
}

export function snapshotFromTransition(basis: TreeSnapshot, candidate: StoredCandidate): TreeSnapshot {
  const objects = applyTransitionPayload(basis.objects, {
    objects: decodeObjectEnvelopes(candidate.objects),
    deltas: decodeObjectDeltas(candidate.deltas ?? []),
  });
  return reachableSnapshot(candidate.candidate, objects);
}

export function snapshotFromAdmission(base: TreeSnapshot, admission: LegacyEditorAdmission): TreeSnapshot {
  const basis = decodeAdmissionBasis(admission.admissionBasis);
  if (base.root !== basis.baseRoot) throw new Error(`Admission base mismatch: expected ${basis.baseRoot}, got ${base.root}`);
  const basisObjects = applyTransitionPayload(base.objects, {
    objects: decodeObjectEnvelopes(basis.objects),
    deltas: [],
  });
  const candidateBasis = reachableSnapshot(basis.candidateRoot, basisObjects);
  return snapshotFromTransition(candidateBasis, admission.request);
}

export function reachableSnapshot(root: ObjectHash, available: ReadonlyMap<ObjectHash, Uint8Array>): TreeSnapshot {
  const objects = new Map<ObjectHash, Uint8Array>();
  const visit = (hash: ObjectHash): void => {
    if (objects.has(hash)) return;
    const bytes = available.get(hash);
    if (!bytes) throw new Error(`Snapshot is missing reachable object: ${hash}`);
    objects.set(hash, bytes);
    const object = decodeWireObject(bytes);
    if (object.type === "directory") for (const entry of object.entries) if (entry.hash) visit(entry.hash);
  };
  visit(root);
  return verifyTreeSnapshotGraph({ root, objects });
}

export async function textAtWirePath(snapshot: TreeSnapshot, path: string): Promise<string | null> {
  const node = await resolveWireLogicalNode(snapshot.root, logicalPathForWireFile(path), async (hash) => {
    const bytes = snapshot.objects.get(hash);
    if (!bytes) throw new Error(`Snapshot is missing object: ${hash}`);
    return bytes;
  });
  if (!node?.body) return null;
  return new TextDecoder("utf8", { fatal: true }).decode(node.body.bytes);
}

function logicalPathForWireFile(path: string): string {
  const parts = path.split("/").filter(Boolean);
  if (parts.at(-1) === "_index.md") parts.pop();
  else if (parts.at(-1)?.endsWith(".md")) parts[parts.length - 1] = parts.at(-1)!.slice(0, -3);
  return `/${parts.join("/")}`;
}

/** Replace one physical Wire file while retaining every other disk node and byte. */
export function replaceWireFile(snapshot: TreeSnapshot, path: string, source: string): TreeSnapshot {
  const parts = path.split("/").filter(Boolean);
  if (!parts.length || parts.some((part) => part === "." || part === "..")) throw new Error(`Invalid Wire file path: ${path}`);
  const objects = new Map(snapshot.objects);
  const fileBytes = encodeWireObject({ type: "file", bytes: new TextEncoder().encode(source) });
  const fileHash = hashObject(fileBytes);
  objects.set(fileHash, fileBytes);
  const rewrite = (directoryHash: ObjectHash, depth: number): ObjectHash => {
    const bytes = objects.get(directoryHash);
    if (!bytes) throw new Error(`Snapshot is missing object: ${directoryHash}`);
    const directory = decodeWireObject(bytes);
    if (directory.type !== "directory") throw new Error(`Wire path parent is not a directory: ${path}`);
    const name = parts[depth]!;
    const prior = directory.entries.find((entry) => entry.name === name);
    let replacement = fileHash;
    if (depth < parts.length - 1) {
      if (!prior?.hash || prior.tree) throw new Error(`Wire path parent is missing: ${path}`);
      replacement = rewrite(prior.hash, depth + 1);
    }
    const entries = directory.entries.filter((entry) => entry.name !== name);
    entries.push({ name, hash: replacement });
    entries.sort((left, right) => compareWireNames(left.name, right.name));
    const next = encodeWireObject({
      type: "directory",
      entries,
      ...(directory.childrenSource ? { childrenSource: directory.childrenSource } : {}),
    });
    const hash = hashObject(next);
    objects.set(hash, next);
    return hash;
  };
  return reachableSnapshot(rewrite(snapshot.root, 0), objects);
}

export async function snapshotDisk(path: string, exclusions: string[] = []): Promise<TreeSnapshot> {
  return resolveSnapshot(await snapshotDirectory(path, new Map(), exclusions));
}

export async function mergeRecoveryVariant(input: {
  name: string;
  base: TreeSnapshot;
  basisUpdate: string;
  local: TreeSnapshot;
  current: TreeSnapshot;
  sourcePath?: string;
}): Promise<RecoveryVariant> {
  const available = new Map<ObjectHash, Uint8Array>([
    ...input.base.objects,
    ...input.local.objects,
    ...input.current.objects,
  ]);
  const merge = await mergeWireTrees(input.base.root, input.local.root, input.current.root, async (hash) => {
    const bytes = available.get(hash);
    if (!bytes) throw new Error(`Merge object unavailable: ${hash}`);
    return bytes;
  }, "merge");
  const snapshot = reachableSnapshot(merge.root, new Map([...available, ...merge.objects]));
  const source = input.sourcePath ? await textAtWirePath(input.local, input.sourcePath) : null;
  return {
    name: input.name,
    localRoot: input.local.root,
    basisUpdate: input.basisUpdate,
    basisRoot: input.base.root,
    snapshot,
    merge,
    ...(source === null || input.sourcePath === undefined ? {} : {
      source: { path: input.sourcePath, sha256: sha256Bytes(source), bytes: Buffer.byteLength(source) },
    }),
  };
}

export function assertUnchangedCanopy(
  expected: { update: string; root: ObjectHash },
  actual: { update: string; root: ObjectHash },
): void {
  if (actual.update !== expected.update || actual.root !== expected.root) {
    throw new Error(`Canopy drifted since preparation: expected ${expected.update}/${expected.root}, got ${actual.update}/${actual.root}`);
  }
}
