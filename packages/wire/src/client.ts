import type {
  BoundaryKind,
  PublicAccess,
  UpdateConflictResult,
  UpdateRequest,
  UpdateResult,
  FilePatch,
  AuthorityDevice,
  PairingOffer,
  TreeSnapshotEnvelope,
  TreeAccess,
} from "./updates/types.ts";
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

export interface RemoteTreeDescriptor {
  id: string;
  canonicalPath: string;
  parentTree: string | null;
  kind: BoundaryKind;
  ref: ObjectHash;
  publicAccess: PublicAccess;
  access: TreeAccess;
  httpURL: string;
  arborURL: string;
  update?: string;
  /** Present only on same-credential watch frames for a correlated accepted request. */
  requestDigest?: ObjectHash;
}

export interface CurrentTreeSnapshot {
  tree: RemoteTreeDescriptor;
  snapshot: TreeSnapshotEnvelope;
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
  writableProfiles: RemoteTreeDescriptor[];
}

export interface ClaimResult {
  accountToken: string;
  account: RemoteAccountDescriptor;
  tree: RemoteTreeDescriptor;
}

export interface PairingClaimResult {
  deviceToken: string;
  device: AuthorityDevice;
  confirmationCode: string;
}

export interface RemoteAccessEntry {
  id: string;
  kind: "everyone" | "profile" | "link";
  access: TreeAccess;
  locator?: string;
}

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
    throw new Error(`${response.url}: ${body || `${response.status} ${response.statusText}`}`);
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

  async account(): Promise<RemoteAccountDescriptor> {
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

  async claimPairing(id: string, secret: string, label: string): Promise<PairingClaimResult> {
    const response = await this.checked(await this.request(`/.arbor/pairings/${encodeURIComponent(id)}/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret, label }),
    }));
    return response.json();
  }

  async devices(): Promise<AuthorityDevice[]> {
    const response = await this.checked(await this.request("/.arbor/devices", { headers: this.headers() }));
    return response.json();
  }

  async revokeDevice(id: string): Promise<AuthorityDevice> {
    const response = await this.checked(await this.request(`/.arbor/devices/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: this.headers(),
    }));
    return response.json();
  }

  async create(
    canonicalPath: string,
    snapshot: TreeSnapshot,
    options: {
      kind?: Exclude<BoundaryKind, "community-profile" | "person-profile">;
      publicAccess?: PublicAccess;
      profileAccess?: Array<{ locator: string; access: TreeAccess }>;
    } = {},
  ): Promise<RemoteTreeDescriptor> {
    const response = await this.checked(await this.request("/.arbor/trees", {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify({
        canonicalPath,
        kind: options.kind ?? "shared-subtree",
        publicAccess: options.publicAccess ?? "none",
        profileAccess: options.profileAccess ?? [],
        ...encodedSnapshot(snapshot),
      }),
    }));
    return response.json();
  }

  async claim(handle: string, snapshot: TreeSnapshot): Promise<ClaimResult> {
    const response = await this.checked(await this.request(`/.arbor/claims/${encodeURIComponent(handle)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(encodedSnapshot(snapshot)),
    }));
    return response.json();
  }

  async list(): Promise<RemoteTreeDescriptor[]> {
    const response = await this.checked(await this.request("/.arbor/trees", { headers: this.headers() }));
    return response.json();
  }

  async ref(tree: string): Promise<RemoteTreeDescriptor> {
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
    };
    const snapshot = decodedSnapshot(value.snapshot);
    if (value.tree.id !== tree || value.tree.ref !== snapshot.root || !value.tree.update) {
      throw new Error("Current snapshot descriptor does not match its graph");
    }
    return { tree: value.tree, snapshot };
  }

  async resolve(path: string): Promise<RemoteTreeDescriptor & { path: string }> {
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
      type ConflictJSON = Omit<UpdateConflictResult, "draft" | "currentSnapshot"> & {
        draft: { root: ObjectHash; objects: Array<{ hash: ObjectHash; bytes: string }> };
        currentSnapshot?: { root: ObjectHash; objects: Array<{ hash: ObjectHash; bytes: string }> };
      };
      const body = await response.json() as ConflictJSON | { error?: unknown; message?: unknown };
      if (body.error === "conflict") {
        const conflict = body as ConflictJSON;
        const { draft, currentSnapshot, ...envelope } = conflict;
        throw new WireUpdateConflict({
          ...envelope,
          draft: decodedSnapshot(draft),
          ...(currentSnapshot ? { currentSnapshot: decodedSnapshot(currentSnapshot) } : {}),
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

  async access(tree: string): Promise<RemoteAccessEntry[]> {
    const response = await this.checked(await this.request(
      `/.arbor/trees/${encodeURIComponent(tree)}/access`,
      { headers: this.headers() },
    ));
    return response.json();
  }

  async revokeAccess(tree: string, id: string): Promise<RemoteTreeDescriptor> {
    return this.setAccess(tree, { kind: "entry", id }, "none");
  }

  async clearAccess(tree: string): Promise<RemoteTreeDescriptor> {
    return this.setAccess(tree, { kind: "all" }, "none");
  }

  async setAccess(
    tree: string,
    subject:
      | { kind: "all" }
      | { kind: "everyone" }
      | { kind: "profile"; locator: string }
      | { kind: "link"; digest: string }
      | { kind: "entry"; id: string },
    access: TreeAccess | "none",
  ): Promise<RemoteTreeDescriptor> {
    const response = await this.checked(await this.request(
      `/.arbor/trees/${encodeURIComponent(tree)}/access`,
      {
        method: "POST",
        headers: this.headers(true),
        body: JSON.stringify({ subject, access }),
      },
    ));
    return response.json();
  }

  async setPublicAccess(tree: string, access: PublicAccess): Promise<RemoteTreeDescriptor> {
    return this.setAccess(tree, { kind: "everyone" }, access);
  }

  async object(hash: string): Promise<Uint8Array> {
    const response = await this.checked(await this.request(`/.arbor/objects/${hash}`, {
      headers: this.headers(),
    }));
    return new Uint8Array(await response.arrayBuffer());
  }

}
