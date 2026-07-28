import type { PublicationMode, PushRequest } from "./authority.ts";
import type { ObjectHash, TreeSnapshot } from "./objects.ts";

export interface RemoteTreeDescriptor {
  id: string;
  slug: string;
  ref: ObjectHash;
  publication: PublicationMode;
  httpURL: string;
  arborURL: string;
}

function bytesBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function base64Bytes(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64"));
}

export class WireClient {
  constructor(readonly origin: string, private ownerToken?: string) {}

  private headers(json = false): HeadersInit {
    return {
      ...(json ? { "content-type": "application/json" } : {}),
      ...(this.ownerToken ? { authorization: `Bearer ${this.ownerToken}` } : {}),
    };
  }

  private async checked(response: Response): Promise<Response> {
    if (response.ok) return response;
    const body = await response.text();
    throw new Error(`${response.url}: ${body || `${response.status} ${response.statusText}`}`);
  }

  async create(slug: string, snapshot: TreeSnapshot): Promise<RemoteTreeDescriptor> {
    const response = await this.checked(await fetch(`${this.origin}/.arbor/admin/trees`, {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify({
        slug,
        root: snapshot.root,
        objects: [...snapshot.objects].map(([hash, bytes]) => ({ hash, bytes: bytesBase64(bytes) })),
      }),
    }));
    return response.json();
  }

  async list(): Promise<RemoteTreeDescriptor[]> {
    const response = await this.checked(await fetch(`${this.origin}/.arbor/admin/trees`, { headers: this.headers() }));
    return response.json();
  }

  async ref(tree: string): Promise<RemoteTreeDescriptor> {
    const response = await this.checked(await fetch(`${this.origin}/.arbor/trees/${encodeURIComponent(tree)}/ref`, {
      headers: this.headers(),
    }));
    return response.json();
  }

  async resolve(slug: string): Promise<RemoteTreeDescriptor> {
    const response = await this.checked(await fetch(`${this.origin}/.well-known/arbor/${encodeURIComponent(slug)}`, {
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

  async setPublication(tree: string, publication: PublicationMode): Promise<RemoteTreeDescriptor> {
    const response = await this.checked(await fetch(`${this.origin}/.arbor/admin/trees/${encodeURIComponent(tree)}`, {
      method: "PATCH",
      headers: this.headers(true),
      body: JSON.stringify({ publication }),
    }));
    return response.json();
  }

  async object(hash: ObjectHash): Promise<Uint8Array> {
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
