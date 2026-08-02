import type {
  BoundaryKind,
  PublicAccess,
  PushRequest,
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

export interface RemoteAccessEntry {
  id: string;
  kind: "everyone" | "profile" | "link";
  access: TreeAccess;
  locator?: string;
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
  constructor(readonly origin: string, private accountToken?: string) {}

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

  async account(): Promise<RemoteAccountDescriptor> {
    const response = await this.checked(await fetch(`${this.origin}/.arbor/account`, { headers: this.headers() }));
    return response.json();
  }

  async create(
    canonicalPath: string,
    snapshot: TreeSnapshot,
    options: { kind?: Exclude<BoundaryKind, "community-profile" | "person-profile">; publicAccess?: PublicAccess } = {},
  ): Promise<RemoteTreeDescriptor> {
    const response = await this.checked(await fetch(`${this.origin}/.arbor/trees`, {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify({
        canonicalPath,
        kind: options.kind ?? "shared-subtree",
        publicAccess: options.publicAccess ?? "none",
        ...encodedSnapshot(snapshot),
      }),
    }));
    return response.json();
  }

  async claim(handle: string, snapshot: TreeSnapshot): Promise<ClaimResult> {
    const response = await this.checked(await fetch(`${this.origin}/.arbor/claims/${encodeURIComponent(handle)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(encodedSnapshot(snapshot)),
    }));
    return response.json();
  }

  async list(): Promise<RemoteTreeDescriptor[]> {
    const response = await this.checked(await fetch(`${this.origin}/.arbor/trees`, { headers: this.headers() }));
    return response.json();
  }

  async ref(tree: string): Promise<RemoteTreeDescriptor> {
    const response = await this.checked(await fetch(`${this.origin}/.arbor/trees/${encodeURIComponent(tree)}/ref`, {
      headers: this.headers(),
    }));
    return response.json();
  }

  async resolve(path: string): Promise<RemoteTreeDescriptor & { path: string }> {
    const canonical = path === "/" ? "" : `/${path.split("/").filter(Boolean).map(encodeURIComponent).join("/")}`;
    const response = await this.checked(await fetch(`${this.origin}/.well-known/arbor${canonical}`, {
      headers: this.headers(),
    }));
    return response.json();
  }

  async push(tree: string, expected: ObjectHash, snapshot: TreeSnapshot): Promise<RemoteTreeDescriptor> {
    const request: PushRequest = {
      expected,
      root: snapshot.root,
      objects: [...snapshot.objects].map(([hash, bytes]) => ({ hash, bytes })),
    };
    const response = await this.checked(await fetch(`${this.origin}/.arbor/trees/${encodeURIComponent(tree)}/push`, {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify({
        expected: request.expected,
        root: request.root,
        objects: request.objects.map(({ hash, bytes }) => ({ hash, bytes: bytesBase64(bytes) })),
      }),
    }));
    return response.json();
  }

  async access(tree: string): Promise<RemoteAccessEntry[]> {
    const response = await this.checked(await fetch(
      `${this.origin}/.arbor/trees/${encodeURIComponent(tree)}/access`,
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
    const response = await this.checked(await fetch(
      `${this.origin}/.arbor/trees/${encodeURIComponent(tree)}/access`,
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
    const response = await this.checked(await fetch(`${this.origin}/.arbor/objects/${hash}`, {
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
