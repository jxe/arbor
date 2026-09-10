#!/usr/bin/env bun
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { accountWireClient } from "@arbor/canopy-client";
import { decodeSnapshotBundle, encodeSnapshotBundle, type ObjectHash, type TreeSnapshot } from "@arbor/wire";
import {
  decodeAdmissionBasis,
  assertUnchangedCanopy,
  mergeRecoveryVariant,
  readRawSyncState,
  replaceWireFile,
  sha256Bytes,
  snapshotDisk,
  snapshotFromAdmission,
  snapshotFromTransition,
  textAtWirePath,
  type RecoveryVariant,
} from "./recovery/arborsync-recovery.ts";

interface TreeListItem {
  id: string;
  configurationTree?: string;
  osPath?: string;
  canonical?: { endpoint?: string } | null;
  root?: ObjectHash;
  update?: string;
}

interface Manifest {
  version: 1;
  createdAt: string;
  tree: string;
  configurationTree: string;
  dataHome: string;
  arborsync: string;
  diskPath: string;
  exclusions: string[];
  state: { path: string; sha256: string; acceptedRoot: ObjectHash; acceptedUpdate: string };
  current: { root: ObjectHash; update: string };
  admissions: Array<Record<string, unknown>>;
  pending?: Record<string, unknown>;
  variants: Array<{
    name: string;
    file: string;
    root: ObjectHash;
    sha256: string;
    basisUpdate: string;
    basisRoot: ObjectHash;
    localRoot: ObjectHash;
    conflicts: unknown[];
    mergeSummary?: unknown;
    source?: RecoveryVariant["source"];
  }>;
}

function usage(): never {
  console.error(`Usage:
  bun tools/recover-arborsync-tree.ts prepare --tree TREE --output DIR [--data-home DIR] [--arborsync URL] [--disk DIR] [--exclude PATH]
  bun tools/recover-arborsync-tree.ts submit --manifest FILE --candidate NAME --expect-current-update UPDATE --expect-current-root ROOT --expect-candidate-root ROOT

prepare is read-only with respect to Arbor, ArborSync, and Canopy. It creates a private evidence bundle.
submit requires an unchanged Canopy update/root, a conflict-free prepared candidate, and posts with onConflict=reject.`);
  process.exit(2);
}

function argumentsFor(argv: string[]): { command: string; values: Map<string, string[]> } {
  const command = argv[0];
  if (!command || !["prepare", "submit"].includes(command)) usage();
  const values = new Map<string, string[]>();
  for (let index = 1; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) usage();
    values.set(key.slice(2), [...(values.get(key.slice(2)) ?? []), value]);
  }
  return { command, values };
}

function required(values: Map<string, string[]>, key: string): string {
  const value = values.get(key)?.at(-1);
  if (!value) usage();
  return value;
}

async function treePlacement(arborsync: string, tree: string): Promise<TreeListItem> {
  const response = await fetch(`${arborsync}/v1/trees`);
  if (!response.ok) throw new Error(`ArborSync tree list failed: ${response.status} ${await response.text()}`);
  const body = await response.json() as { snapshot?: TreeListItem[] };
  const item = body.snapshot?.find((candidate) => candidate.id === tree);
  if (!item) throw new Error(`ArborSync does not know tree ${tree}`);
  return item;
}

async function writePrivate(path: string, bytes: Uint8Array | string): Promise<void> {
  await writeFile(path, bytes, { mode: 0o600 });
  await chmod(path, 0o600).catch(() => {});
}

async function prepare(values: Map<string, string[]>): Promise<void> {
  const tree = required(values, "tree");
  const output = resolve(required(values, "output"));
  const dataHome = resolve(values.get("data-home")?.at(-1) ?? `${process.env.HOME}/.arbor`);
  const arborsync = new URL(values.get("arborsync")?.at(-1) ?? "http://127.0.0.1:4317").origin;
  const placement = await treePlacement(arborsync, tree);
  const configurationTree = placement.configurationTree;
  const diskInput = values.get("disk")?.at(-1) ?? placement.osPath;
  if (!configurationTree) throw new Error(`Tree ${tree} has no account configuration tree`);
  if (!diskInput) throw new Error(`Tree ${tree} has no placed disk path; pass --disk`);
  const diskPath = resolve(diskInput);
  const exclusions = (values.get("exclude") ?? []).map((path) => resolve(path));

  const raw = await readRawSyncState(dataHome, tree);
  if (!raw.state.accepted) throw new Error("ArborSync state has no accepted object inventory");
  const acceptedUpdate = raw.state.pending?.base ?? placement.update;
  if (!acceptedUpdate) throw new Error("Cannot identify the accepted update for the local basis");

  const wire = await accountWireClient({ configurationTree }, { required: true, timeoutMs: 30_000 });
  const currentDescriptor = await wire.client.descriptor(tree);
  const [accepted, current, disk] = await Promise.all([
    // Older running daemons do not expose object reads. The journal still
    // supplies the exact accepted root/inventory; ask Canopy for that immutable
    // historical graph and verify that every journaled object is present.
    wire.client.snapshot(tree, raw.state.accepted.root).then((snapshot) => {
      const expected = new Set(raw.state.accepted!.hashes);
      if (snapshot.objects.size !== expected.size || [...snapshot.objects.keys()].some((hash) => !expected.has(hash))) {
        throw new Error("Canopy's immutable accepted snapshot does not match ArborSync's accepted object inventory");
      }
      return snapshot;
    }),
    wire.client.snapshot(tree, currentDescriptor.tree.root),
    snapshotDisk(diskPath, exclusions),
  ]);

  const variants: RecoveryVariant[] = [];
  variants.push(await mergeRecoveryVariant({
    name: "disk",
    base: accepted,
    basisUpdate: acceptedUpdate,
    local: disk,
    current,
    sourcePath: "/_index.md",
  }));

  let pendingSnapshot: TreeSnapshot | undefined;
  if (raw.state.pending) {
    if (raw.state.pending.base !== acceptedUpdate) throw new Error("Pending transition does not derive from the accepted local update");
    pendingSnapshot = snapshotFromTransition(accepted, raw.state.pending);
    variants.push(await mergeRecoveryVariant({
      name: "pending",
      base: accepted,
      basisUpdate: acceptedUpdate,
      local: pendingSnapshot,
      current,
      sourcePath: "/_index.md",
    }));
    const pendingSource = await textAtWirePath(pendingSnapshot, "/_index.md");
    if (pendingSource !== null) {
      variants.push(await mergeRecoveryVariant({
        name: "disk-with-pending-index",
        base: accepted,
        basisUpdate: acceptedUpdate,
        local: replaceWireFile(disk, "/_index.md", pendingSource),
        current,
        sourcePath: "/_index.md",
      }));
    }
  }

  const baseSnapshots = new Map<ObjectHash, Promise<TreeSnapshot>>();
  const snapshotFor = (root: ObjectHash) => {
    let result = baseSnapshots.get(root);
    if (!result) {
      result = root === accepted.root ? Promise.resolve(accepted) : wire.client.snapshot(tree, root);
      baseSnapshots.set(root, result);
    }
    return result;
  };
  for (const [index, admission] of raw.state.editorAdmissions.entries()) {
    const basis = decodeAdmissionBasis(admission.admissionBasis);
    if (basis.ref.tree !== tree || admission.ref.tree !== tree) throw new Error(`Admission ${index} belongs to another tree`);
    const base = await snapshotFor(basis.baseRoot);
    const local = snapshotFromAdmission(base, admission);
    const suffix = String(index + 1).padStart(3, "0");
    variants.push(await mergeRecoveryVariant({
      name: `admission-${suffix}`,
      base,
      basisUpdate: basis.baseUpdate,
      local,
      current,
      sourcePath: basis.wirePath,
    }));
    variants.push(await mergeRecoveryVariant({
      name: `disk-with-admission-${suffix}`,
      base: accepted,
      basisUpdate: acceptedUpdate,
      local: replaceWireFile(disk, basis.wirePath, admission.source),
      current,
      sourcePath: basis.wirePath,
    }));
  }

  await mkdir(output, { recursive: false, mode: 0o700 });
  await chmod(output, 0o700).catch(() => {});
  await writePrivate(join(output, "arborsync-state.json"), raw.source);
  await writePrivate(join(output, "accepted.cbor"), encodeSnapshotBundle(accepted));
  await writePrivate(join(output, "current.cbor"), encodeSnapshotBundle(current));
  await writePrivate(join(output, "disk.cbor"), encodeSnapshotBundle(disk));
  const sourceDirectory = join(output, "sources");
  await mkdir(sourceDirectory, { mode: 0o700 });
  const sourceEvidence: Array<[string, string | null]> = [
    ["accepted-index.md", await textAtWirePath(accepted, "/_index.md")],
    ["current-canopy-index.md", await textAtWirePath(current, "/_index.md")],
    ["disk-index.md", await textAtWirePath(disk, "/_index.md")],
    ["pending-index.md", pendingSnapshot ? await textAtWirePath(pendingSnapshot, "/_index.md") : null],
    ...raw.state.editorAdmissions.map((admission, index) => [
      `admission-${String(index + 1).padStart(3, "0")}-exact.md`,
      admission.source,
    ] as [string, string]),
  ];
  for (const [name, source] of sourceEvidence) if (source !== null) await writePrivate(join(sourceDirectory, name), source);

  const manifest: Manifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    tree,
    configurationTree,
    dataHome,
    arborsync,
    diskPath,
    exclusions,
    state: {
      path: raw.path,
      sha256: sha256Bytes(raw.source),
      acceptedRoot: accepted.root,
      acceptedUpdate,
    },
    current: { root: current.root, update: currentDescriptor.tree.update },
    admissions: raw.state.editorAdmissions.map((admission, index) => {
      const basis = decodeAdmissionBasis(admission.admissionBasis);
      return {
        index: index + 1,
        id: admission.id,
        editorID: admission.editorID ?? basis.editorID ?? null,
        path: admission.ref.path,
        wirePath: basis.wirePath,
        baseUpdate: basis.baseUpdate,
        baseRoot: basis.baseRoot,
        candidateRoot: admission.request.candidate,
        contentRevision: admission.contentRevision,
        sourceSha256: sha256Bytes(admission.source),
        sourceBytes: Buffer.byteLength(admission.source),
        requestDigest: admission.requestDigest ?? null,
        digestInAcceptedLedger: admission.requestDigest ? raw.state.acceptedRequestDigests.includes(admission.requestDigest) : false,
        transmitted: admission.transmitted ?? false,
        acknowledged: admission.acknowledged ?? false,
      };
    }),
    ...(raw.state.pending ? {
      pending: {
        base: raw.state.pending.base,
        candidateRoot: raw.state.pending.candidate,
        objects: decodeObjectEnvelopesCount(raw.state.pending.objects),
        deltas: Array.isArray(raw.state.pending.deltas) ? raw.state.pending.deltas.length : 0,
      },
    } : {}),
    variants: [],
  };
  for (const variant of variants) {
    const file = `${variant.name}.cbor`;
    const bundle = encodeSnapshotBundle(variant.snapshot);
    await writePrivate(join(output, file), bundle);
    if (variant.source) {
      const mergedSource = await textAtWirePath(variant.snapshot, variant.source.path);
      if (mergedSource !== null) await writePrivate(join(sourceDirectory, `${variant.name}-merged.md`), mergedSource);
    }
    manifest.variants.push({
      name: variant.name,
      file,
      root: variant.snapshot.root,
      sha256: sha256Bytes(bundle),
      basisUpdate: variant.basisUpdate,
      basisRoot: variant.basisRoot,
      localRoot: variant.localRoot,
      conflicts: variant.merge.conflicts,
      ...(variant.merge.summary ? { mergeSummary: variant.merge.summary } : {}),
      ...(variant.source ? { source: variant.source } : {}),
    });
  }
  await writePrivate(join(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify({
    output,
    tree,
    current: manifest.current,
    admissions: manifest.admissions.length,
    variants: manifest.variants.map(({ name, root, conflicts, source }) => ({ name, root, conflicts: conflicts.length, source })),
    submitted: false,
  }, null, 2));
}

function decodeObjectEnvelopesCount(value: unknown): number {
  if (!Array.isArray(value)) return 0;
  return value.length;
}

async function submit(values: Map<string, string[]>): Promise<void> {
  const manifestPath = resolve(required(values, "manifest"));
  const candidateName = required(values, "candidate");
  const expectedCurrentUpdate = required(values, "expect-current-update");
  const expectedCurrentRoot = required(values, "expect-current-root");
  const expectedCandidateRoot = required(values, "expect-candidate-root");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Manifest;
  if (manifest.version !== 1) throw new Error("Unsupported recovery manifest version");
  const candidate = manifest.variants.find((variant) => variant.name === candidateName);
  if (!candidate) throw new Error(`Unknown candidate ${candidateName}`);
  if (manifest.current.update !== expectedCurrentUpdate || manifest.current.root !== expectedCurrentRoot) {
    throw new Error("Typed current Canopy identity does not match the recovery manifest");
  }
  if (candidate.root !== expectedCandidateRoot) throw new Error("Typed candidate root does not match the selected recovery candidate");
  if (candidate.conflicts.length) throw new Error(`Candidate ${candidateName} has unresolved merge conflicts`);
  if (candidate.mergeSummary && typeof candidate.mergeSummary === "object"
    && (candidate.mergeSummary as { approximatePlacements?: unknown }).approximatePlacements !== undefined
    && (candidate.mergeSummary as { approximatePlacements: number }).approximatePlacements > 0) {
    throw new Error(`Candidate ${candidateName} needs review because its Markdown merge used approximate placements`);
  }
  const candidatePath = join(resolve(manifestPath, ".."), basename(candidate.file));
  const bundle = new Uint8Array(await readFile(candidatePath));
  if (sha256Bytes(bundle) !== candidate.sha256) throw new Error("Prepared candidate bundle changed after inspection");
  const snapshot = decodeSnapshotBundle(candidate.root, bundle);
  const wire = await accountWireClient({ configurationTree: manifest.configurationTree }, { required: true, timeoutMs: 30_000 });
  const before = await wire.client.descriptor(manifest.tree);
  assertUnchangedCanopy(manifest.current, before.tree);
  const result = await wire.client.submitUpdate(manifest.tree, before.tree.update, snapshot, {
    ifMatch: "modelHash",
    onConflict: "reject",
  });
  if (result.update.root !== snapshot.root) throw new Error(`Canopy accepted an unexpected root ${result.update.root}`);
  const after = await wire.client.descriptor(manifest.tree);
  if (after.tree.update !== result.update.id || after.tree.root !== snapshot.root) throw new Error("Canopy verification did not match the accepted recovery update");
  console.log(JSON.stringify({ submitted: true, candidate: candidateName, outcome: result.outcome, update: result.update.id, root: result.update.root }, null, 2));
}

const parsed = argumentsFor(process.argv.slice(2));
await (parsed.command === "prepare" ? prepare(parsed.values) : submit(parsed.values));
