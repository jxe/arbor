import type {
  UpdateConflictResult,
  UpdateRequest,
  UpdateResult,
  FilePatch,
  AuthorityDevice,
  PairingOffer,
  TreeSnapshotEnvelope,
} from "./updates/types.ts";
import type {
  AccessEntry,
  ArborError,
  EventCursor,
  LocatorResolution,
  RemoteTreeDescriptor,
  SnapshotEnvelope,
  TreeID,
} from "@arbor/core";
import {
  decodeWireObject,
  encodeWireObject,
  hashObject,
  type ObjectHash,
  type TreeSnapshot,
} from "./objects.ts";
import {
  decodeBase64,
  encodeObjectEnvelopes,
  encodeUpdateRequestJSON,
} from "./updates/json.ts";
import { updateRequestDigest } from "./updates/intent.ts";

export type { RemoteTreeDescriptor } from "@arbor/core";

export interface CurrentTreeSnapshot {
  tree: RemoteTreeDescriptor;
  snapshot: TreeSnapshotEnvelope;
  observedThrough: EventCursor;
}

export class WireUpdateConflict extends Error {
  constructor(readonly result: UpdateConflictResult) {
    super("Authority could not safely accept the candidate update");
    this.name = "WireUpdateConflict";
  }
}

export interface RemoteAccountDescriptor {
  id: string;
  handle: string;
  profileTree: string | null;
  profileURL: string | null;
  community: RemoteTreeDescriptor;
  configuration: RemoteTreeDescriptor;
  writableProfiles: RemoteTreeDescriptor[];
  device?: { id: string; label: string };
}

export interface RemoteAccountSnapshot {
  account: RemoteAccountDescriptor;
  observedThrough: EventCursor;
}

export interface ClaimResult {
  account: RemoteAccountDescriptor;
  tree: RemoteTreeDescriptor;
  configuration: RemoteTreeDescriptor;
}

export interface ClaimRequest {
  profileTree: TreeID;
  configurationTree: TreeID;
  device: { id: string; label: string; credentialDigest: `sha256:${string}` };
  profile: TreeSnapshot;
  configuration: TreeSnapshot;
}

export interface PairingClaimResult {
  device: AuthorityDevice;
  confirmationCode: string;
}

export type RemoteAccessEntry = AccessEntry;

export class WireTransportError extends TypeError {
  override readonly cause: unknown;

  constructor(message: string, cause: unknown) {
    super(message);
    this.name = "WireTransportError";
    this.cause = cause;
  }
}

function encodedSnapshot(snapshot: TreeSnapshot) {
  return {
    root: snapshot.root,
    objects: encodeObjectEnvelopes(snapshot.objects),
  };
}

function decodedSnapshot(snapshot: { root: ObjectHash; objects: Array<{ hash: ObjectHash; bytes: string }> }) {
  if (!/^sha256:[a-f0-9]{64}$/.test(snapshot.root)) throw new Error("Snapshot root hash is invalid");
  const objects = new Map<ObjectHash, Uint8Array>();
  for (const envelope of snapshot.objects) {
    if (!/^sha256:[a-f0-9]{64}$/.test(envelope.hash)) throw new Error("Snapshot object hash is invalid");
    const bytes = decodeBase64(envelope.bytes);
    if (hashObject(bytes) !== envelope.hash) throw new Error(`Snapshot object hash mismatch: ${envelope.hash}`);
    const existing = objects.get(envelope.hash);
    if (existing && (existing.length !== bytes.length || existing.some((byte, index) => byte !== bytes[index]))) {
      throw new Error(`Snapshot object ${envelope.hash} was supplied with different bytes`);
    }
    objects.set(envelope.hash, bytes);
  }
  const visited = new Set<ObjectHash>();
  const visit = (hash: ObjectHash) => {
    if (visited.has(hash)) return;
    const bytes = objects.get(hash);
    if (!bytes) throw new Error(`Snapshot is missing reachable object: ${hash}`);
    const object = decodeWireObject(bytes);
    const canonical = encodeWireObject(object);
    if (canonical.length !== bytes.length || canonical.some((byte, index) => byte !== bytes[index])) {
      throw new Error(`Snapshot object is not canonical CBOR: ${hash}`);
    }
    visited.add(hash);
    if (object.type === "directory") {
      for (const entry of object.entries) if (entry.hash) visit(entry.hash);
    }
  };
  visit(snapshot.root);
  if (visited.size !== objects.size) throw new Error("Snapshot contains unreachable objects");
  return { root: snapshot.root, objects: [...objects].map(([hash, bytes]) => ({ hash, bytes })) };
}

export class WireClient {
  private readonly timeoutMs: number;

  constructor(
    readonly origin: string,
    private accountToken?: string,
    options: { timeoutMs?: number } = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 5_000;
  }

  private headers(json = false): HeadersInit {
    return {
      ...(json ? { "content-type": "application/json" } : {}),
      ...(this.accountToken ? { authorization: `Bearer ${this.accountToken}` } : {}),
    };
  }

  private async checked(response: Response): Promise<Response> {
    if (response.ok) return response;
    const body = await response.text();
    let envelope: ArborError | undefined;
    try { envelope = JSON.parse(body) as ArborError; } catch {}
    throw new Error(`${response.url}: ${envelope?.error ?? response.status} ${envelope?.message ?? (body || response.statusText)}`);
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    try {
      return await fetch(`${this.origin}${path}`, {
        ...init,
        signal: init.signal ?? AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new WireTransportError(`Could not reach Arbor authority at ${this.origin}`, error);
    }
  }

  async account(): Promise<RemoteAccountSnapshot> {
    const response = await this.checked(await this.request("/.arbor/account", { headers: this.headers() }));
    return response.json();
  }

  async createPairing(): Promise<PairingOffer> {
    const response = await this.checked(await this.request("/.arbor/pairings", {
      method: "POST",
      headers: this.headers(true),
      body: "{}",
    }));
    return response.json();
  }

  async claimPairing(
    id: string,
    secret: string,
    device: { id: string; label: string; credentialDigest: `sha256:${string}` },
    placements: Record<TreeID, { authority: string; path?: string }> = {},
  ): Promise<PairingClaimResult> {
    const response = await this.checked(await this.request(`/.arbor/pairings/${encodeURIComponent(id)}/claim`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret, device, placements }),
    }));
    return response.json();
  }

  async claim(handle: string, input: ClaimRequest): Promise<ClaimResult> {
    const response = await this.checked(await this.request(`/.arbor/claims/${encodeURIComponent(handle)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        profileTree: input.profileTree,
        configurationTree: input.configurationTree,
        device: input.device,
        profile: encodedSnapshot(input.profile),
        configuration: encodedSnapshot(input.configuration),
      }),
    }));
    return response.json();
  }

  async list(): Promise<SnapshotEnvelope<RemoteTreeDescriptor[]>> {
    const response = await this.checked(await this.request("/.arbor/trees", { headers: this.headers() }));
    return response.json();
  }

  async ref(tree: string): Promise<SnapshotEnvelope<RemoteTreeDescriptor>> {
    const response = await this.checked(await this.request(`/.arbor/trees/${encodeURIComponent(tree)}/ref`, {
      headers: this.headers(),
    }));
    return response.json();
  }

  async currentSnapshot(tree: string): Promise<CurrentTreeSnapshot> {
    const response = await this.checked(await this.request(
      `/.arbor/trees/${encodeURIComponent(tree)}/snapshot`,
      { headers: this.headers() },
    ));
    const value = await response.json() as {
      tree: RemoteTreeDescriptor;
      snapshot: { root: ObjectHash; objects: Array<{ hash: ObjectHash; bytes: string }> };
      observedThrough: EventCursor;
    };
    const snapshot = decodedSnapshot(value.snapshot);
    if (value.tree.id !== tree || value.tree.ref !== snapshot.root || !value.tree.update) {
      throw new Error("Current snapshot descriptor does not match its graph");
    }
    return { tree: value.tree, snapshot, observedThrough: value.observedThrough };
  }

  async activateTree(tree: TreeID, snapshot: TreeSnapshot): Promise<SnapshotEnvelope<RemoteTreeDescriptor>> {
    const response = await this.checked(await this.request(`/.arbor/trees/${encodeURIComponent(tree)}`, {
      method: "PUT",
      headers: this.headers(true),
      body: JSON.stringify(encodedSnapshot(snapshot)),
    }));
    return response.json();
  }

  async resolve(path: string): Promise<LocatorResolution> {
    const canonical = path === "/" ? "" : `/${path.split("/").filter(Boolean).map(encodeURIComponent).join("/")}`;
    const response = await this.checked(await this.request(`/.well-known/arbor${canonical}`, {
      headers: this.headers(),
    }));
    return response.json();
  }

  async submitUpdate(
    tree: string,
    base: { root: ObjectHash; update: string },
    snapshot: TreeSnapshot,
    options: { returnSnapshot?: true | "if-result-differs"; filePatches?: FilePatch[] } = {},
  ): Promise<UpdateResult> {
    const request: UpdateRequest = {
      base,
      candidate: snapshot.root,
      objects: [...snapshot.objects].map(([hash, bytes]) => ({ hash, bytes })),
      ...(options.filePatches?.length ? { filePatches: options.filePatches } : {}),
      ...(options.returnSnapshot ? { returnSnapshot: options.returnSnapshot } : {}),
    };
    const response = await this.request(`/.arbor/trees/${encodeURIComponent(tree)}/updates`, {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify(encodeUpdateRequestJSON(request)),
    });
    if (response.status === 409) {
      type ConflictJSON = Omit<UpdateConflictResult, "details"> & {
        details: Omit<UpdateConflictResult["details"], "draft" | "currentSnapshot"> & {
          draft: { root: ObjectHash; objects: Array<{ hash: ObjectHash; bytes: string }> };
          currentSnapshot?: { root: ObjectHash; objects: Array<{ hash: ObjectHash; bytes: string }> };
        };
      };
      const body = await response.json() as ConflictJSON | { error?: unknown; message?: unknown };
      if (body.error === "conflict") {
        const conflict = body as ConflictJSON;
        const { draft, currentSnapshot, ...details } = conflict.details;
        throw new WireUpdateConflict({
          ...conflict,
          details: {
            ...details,
            draft: decodedSnapshot(draft),
            ...(currentSnapshot ? { currentSnapshot: decodedSnapshot(currentSnapshot) } : {}),
          },
        });
      }
      const rejection = body as { error?: unknown; message?: unknown };
      throw new Error(`${response.url}: ${typeof rejection.error === "string" ? rejection.error : "update rejected"}${typeof rejection.message === "string" ? `: ${rejection.message}` : ""}`);
    }
    const result = await (await this.checked(response)).json() as {
      requestDigest?: unknown;
      snapshot?: { root: ObjectHash; objects: Array<{ hash: ObjectHash; bytes: string }> };
      [key: string]: unknown;
    };
    if (result.requestDigest !== updateRequestDigest(tree, request)) {
      throw new Error("Authority response request digest mismatch");
    }
    return result.snapshot ? {
      ...result,
      snapshot: decodedSnapshot(result.snapshot),
    } as UpdateResult : result as UpdateResult;
  }

  async access(tree: string): Promise<SnapshotEnvelope<RemoteAccessEntry[]>> {
    const response = await this.checked(await this.request(
      `/.arbor/trees/${encodeURIComponent(tree)}/access`,
      { headers: this.headers() },
    ));
    return response.json();
  }

  async object(tree: TreeID, hash: string): Promise<Uint8Array> {
    const response = await this.checked(await this.request(`/.arbor/trees/${encodeURIComponent(tree)}/objects/${hash}`, {
      headers: this.headers(),
    }));
    return new Uint8Array(await response.arrayBuffer());
  }

}
