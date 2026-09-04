import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { chmod, mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  accountChallengeBytes,
  isPersonProfileTreeID,
  personProfileTreeID,
  sha256,
  validateAccountChallenge,
  type AccountChallenge,
} from "@arbor/core";
import { arborPrivateRoot, bindWorkspaceIdentity, prepareArborDataRoot } from "./private-state.ts";

const SERVICE = "org.arbor.person-profile";
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export interface ProfileIdentityMetadata {
  version: 1;
  profileTree: string;
  publicKey: string;
  profilePath: string;
  credential: string;
}

export interface ProfileIdentityStatus extends ProfileIdentityMetadata {
  keyAvailable: boolean;
}

interface ProfileIdentityBackup {
  version: 1;
  profileTree: string;
  publicKey: string;
  privateKey: string;
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function bytes(value: string, length: number, label: string): Buffer {
  const decoded = Buffer.from(value, "base64url");
  if (decoded.byteLength !== length || base64url(decoded) !== value) throw new Error(`${label} is not canonical base64url`);
  return decoded;
}

function materialFromSeed(seed: Uint8Array): { seed: Buffer; publicKey: Buffer; profileTree: string } {
  if (seed.byteLength !== 32) throw new Error("Profile private key must be a 32-byte Ed25519 seed");
  const privateDER = Buffer.concat([PKCS8_PREFIX, seed]);
  createPrivateKey({ key: privateDER, format: "der", type: "pkcs8" });
  // Node accepts a PKCS#8 private key here and derives its public component;
  // Bun's current node:crypto declarations omit that documented input variant.
  const publicDER = createPublicKey({ key: privateDER, format: "der", type: "pkcs8" } as never).export({ format: "der", type: "spki" });
  const publicKey = Buffer.from(publicDER).subarray(SPKI_PREFIX.byteLength);
  if (publicKey.byteLength !== 32) throw new Error("Could not derive the Ed25519 public key");
  return { seed: Buffer.from(seed), publicKey, profileTree: personProfileTreeID(publicKey) };
}

function generatedMaterial(): { seed: Buffer; publicKey: Buffer; profileTree: string } {
  const { privateKey } = generateKeyPairSync("ed25519");
  const privateDER = Buffer.from(privateKey.export({ format: "der", type: "pkcs8" }));
  if (!privateDER.subarray(0, PKCS8_PREFIX.byteLength).equals(PKCS8_PREFIX)) throw new Error("Unexpected Ed25519 private-key encoding");
  return materialFromSeed(privateDER.subarray(PKCS8_PREFIX.byteLength));
}

function credentialName(profileTree: string): string {
  return `self-${sha256(`${arborPrivateRoot()}\0${profileTree}`).slice(0, 24)}`;
}

function credentialReference(profileTree: string): string {
  return `${SERVICE}/${credentialName(profileTree)}`;
}

async function ensureProfileFolder(inputPath: string): Promise<string> {
  const path = resolve(inputPath);
  await mkdir(path, { recursive: true, mode: 0o700 });
  const canonical = await realpath(path);
  const index = join(canonical, "_index.md");
  const source = await readFile(index, "utf8").catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? null : Promise.reject(error));
  if (source === null) await writeFile(index, "---\ntype: person\n---\n\n# Profile\n", { mode: 0o600, flag: "wx" });
  else if (!/^type:\s*person\s*$/m.test(source)) throw new Error("Profile _index.md must declare type: person");
  return canonical;
}

export class ProfileIdentityStore {
  private get path(): string { return join(arborPrivateRoot(), "self.json"); }

  async metadata(): Promise<ProfileIdentityMetadata | null> {
    try {
      const value = JSON.parse(await readFile(this.path, "utf8")) as Partial<ProfileIdentityMetadata>;
      if (
        value.version !== 1 || typeof value.profileTree !== "string" || !isPersonProfileTreeID(value.profileTree)
        || typeof value.publicKey !== "string" || typeof value.profilePath !== "string"
        || value.credential !== credentialReference(value.profileTree)
      ) return null;
      const publicKey = bytes(value.publicKey, 32, "Profile public key");
      if (personProfileTreeID(publicKey) !== value.profileTree) return null;
      return value as ProfileIdentityMetadata;
    } catch { return null; }
  }

  async status(): Promise<ProfileIdentityStatus | null> {
    const metadata = await this.metadata();
    if (!metadata) return null;
    return { ...metadata, keyAvailable: Boolean(await Bun.secrets.get({ service: SERVICE, name: credentialName(metadata.profileTree) }).catch(() => null)) };
  }

  private async install(material: { seed: Buffer; publicKey: Buffer; profileTree: string }, inputPath: string): Promise<ProfileIdentityStatus> {
    await prepareArborDataRoot();
    const existing = await this.metadata();
    if (existing && existing.profileTree !== material.profileTree) throw new Error(`This Arbor home already belongs to ${existing.profileTree}`);
    const profilePath = await ensureProfileFolder(inputPath);
    if (existing && await realpath(existing.profilePath).catch(() => existing.profilePath) !== profilePath) {
      throw new Error(`This Arbor identity is already bound to ${existing.profilePath}`);
    }
    await bindWorkspaceIdentity(profilePath, material.profileTree);
    await Bun.secrets.set({ service: SERVICE, name: credentialName(material.profileTree), value: base64url(material.seed) });
    const metadata: ProfileIdentityMetadata = {
      version: 1,
      profileTree: material.profileTree,
      publicKey: base64url(material.publicKey),
      profilePath,
      credential: credentialReference(material.profileTree),
    };
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.path);
    return { ...metadata, keyAvailable: true };
  }

  async begin(profilePath: string): Promise<ProfileIdentityStatus> {
    const existing = await this.status();
    if (existing) {
      const canonical = await realpath(profilePath).catch(() => resolve(profilePath));
      if (canonical !== existing.profilePath) throw new Error(`This Arbor identity is already bound to ${existing.profilePath}`);
      if (!existing.keyAvailable) throw new Error(`The private key for ${existing.profileTree} is unavailable; restore a backup`);
      return existing;
    }
    return this.install(generatedMaterial(), profilePath);
  }

  private async keyMaterial(): Promise<{ metadata: ProfileIdentityMetadata; seed: Buffer; publicKey: Buffer }> {
    const metadata = await this.metadata();
    if (!metadata) throw new Error("No person identity exists; run `arbor me create`");
    const encoded = await Bun.secrets.get({ service: SERVICE, name: credentialName(metadata.profileTree) }).catch(() => null);
    if (!encoded) throw new Error(`The private key for ${metadata.profileTree} is unavailable; restore a backup`);
    const material = materialFromSeed(bytes(encoded, 32, "Profile private key"));
    if (material.profileTree !== metadata.profileTree || base64url(material.publicKey) !== metadata.publicKey) {
      throw new Error("Stored profile identity does not match its private key");
    }
    return { metadata, seed: material.seed, publicKey: material.publicKey };
  }

  async signChallenge(input: AccountChallenge): Promise<{ publicKey: string; signature: string }> {
    const challenge = validateAccountChallenge(input);
    const material = await this.keyMaterial();
    if (challenge.profileTree !== material.metadata.profileTree) throw new Error("Account challenge names another profile identity");
    const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, material.seed]), format: "der", type: "pkcs8" });
    return {
      publicKey: base64url(material.publicKey),
      signature: sign(null, accountChallengeBytes(challenge), privateKey).toString("base64url"),
    };
  }

  async backup(destinationInput: string): Promise<void> {
    const material = await this.keyMaterial();
    const destination = resolve(destinationInput);
    await mkdir(dirname(destination), { recursive: true });
    const backup: ProfileIdentityBackup = {
      version: 1,
      profileTree: material.metadata.profileTree,
      publicKey: material.metadata.publicKey,
      privateKey: base64url(material.seed),
    };
    await writeFile(destination, `${JSON.stringify(backup, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await chmod(destination, 0o600);
  }

  async restore(sourceInput: string, profilePath: string): Promise<ProfileIdentityStatus> {
    const source = resolve(sourceInput);
    const value = JSON.parse(await readFile(source, "utf8")) as Partial<ProfileIdentityBackup>;
    if (value.version !== 1 || typeof value.profileTree !== "string" || typeof value.publicKey !== "string" || typeof value.privateKey !== "string") {
      throw new Error("Malformed Arbor identity backup");
    }
    const material = materialFromSeed(bytes(value.privateKey, 32, "Profile private key"));
    if (!isPersonProfileTreeID(value.profileTree) || material.profileTree !== value.profileTree || base64url(material.publicKey) !== value.publicKey) {
      throw new Error("Arbor identity backup does not match its Profile TreeID");
    }
    return this.install(material, profilePath);
  }
}
