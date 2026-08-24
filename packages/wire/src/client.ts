import type {
  AcceptedUpdate,
  BoundaryKind,
  PublicAccess,
  UpdateConflictResult,
  UpdateRequest,
  UpdateResult,
  AuthorityDevice,
  PairingOffer,
  TreeAccess,
} from "./authority.ts";
import type { ObjectHash, TreeSnapshot } from "./objects.ts";

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

function bytesBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function base64Bytes(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64"));
}

function encodedSnapshot(snapshot: TreeSnapshot) {
  return {
    root: snapshot.root,
    objects: [...snapshot.objects].map(([hash, bytes]) => ({ hash, bytes: bytesBase64(bytes) })),
  };
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

  async resolve(path: string): Promise<RemoteTreeDescriptor & { path: string }> {
    const canonical = path === "/" ? "" : `/${path.split("/").filter(Boolean).map(encodeURIComponent).join("/")}`;
    const response = await this.checked(await this.request(`/.well-known/arbor${canonical}`, {
      headers: this.headers(),
    }));
    return response.json();
  }

  async updates(tree: string, cursor?: string): Promise<{ updates: AcceptedUpdate[]; cursor: string | null }> {
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
    const response = await this.checked(await this.request(`/.arbor/trees/${encodeURIComponent(tree)}/updates${query}`, {
      headers: this.headers(),
    }));
    return response.json();
  }

  async submitUpdate(
    tree: string,
    idempotencyKey: string,
    base: { root: ObjectHash; update: string },
    snapshot: TreeSnapshot,
  ): Promise<UpdateResult> {
    const request: UpdateRequest = {
      base,
      candidate: snapshot.root,
      objects: [...snapshot.objects].map(([hash, bytes]) => ({ hash, bytes })),
    };
    const response = await this.request(`/.arbor/trees/${encodeURIComponent(tree)}/updates`, {
      method: "POST",
      headers: { ...this.headers(true), "idempotency-key": idempotencyKey },
      body: JSON.stringify({
        base: request.base,
        candidate: request.candidate,
        objects: request.objects.map(({ hash, bytes }) => ({ hash, bytes: bytesBase64(bytes) })),
      }),
    });
    if (response.status === 409) {
      const body = await response.json() as (Omit<UpdateConflictResult, "draft"> & {
        draft: { root: ObjectHash; objects: Array<{ hash: ObjectHash; bytes: string }> };
      }) | { error?: unknown; message?: unknown };
      if (body.error === "conflict") {
        const conflict = body as Omit<UpdateConflictResult, "draft"> & {
          draft: { root: ObjectHash; objects: Array<{ hash: ObjectHash; bytes: string }> };
        };
        throw new WireUpdateConflict({
          ...conflict,
          draft: {
            root: conflict.draft.root,
            objects: conflict.draft.objects.map(({ hash, bytes }) => ({ hash, bytes: base64Bytes(bytes) })),
          },
        });
      }
      const rejection = body as { error?: unknown; message?: unknown };
      throw new Error(`${response.url}: ${typeof rejection.error === "string" ? rejection.error : "update rejected"}${typeof rejection.message === "string" ? `: ${rejection.message}` : ""}`);
    }
    return (await this.checked(response)).json();
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

  static decodeObjects(value: unknown): Array<{ hash: ObjectHash; bytes: Uint8Array }> {
    if (!Array.isArray(value)) throw new Error("Expected objects");
    return value.map((item) => {
      if (!item || typeof item !== "object") throw new Error("Invalid object");
      const record = item as { hash?: unknown; bytes?: unknown };
      if (typeof record.hash !== "string" || typeof record.bytes !== "string") throw new Error("Invalid object");
      return { hash: record.hash, bytes: base64Bytes(record.bytes) };
    });
  }
}
