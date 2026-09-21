import { withLocalStateLock } from "./local-state-lock.ts";
import { homedir } from "node:os";
import type { ProfileIdentity } from "@overstory/protocol";
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { chmod, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  accountChallengeBytes,
  isPersonProfileTreeID,
  personProfileTreeID,
  sha256,
  validateAccountChallenge,
  type AccountChallenge,
  parseMarkdown,
  patchFrontmatter,
} from "@overstory/protocol";
import { arborPrivateRoot, bindWorkspaceIdentity, prepareArborDataRoot, loadWorkspaceRegistry } from "@overstory/protocol";

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

/** The stored identity plus key availability; the same shape Arbor Sync reports as `identity`. */
export type ProfileIdentityStatus = ProfileIdentity;

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

interface IdentityRecord extends ProfileIdentityBackup { profilePath: string }

function verifiedRecord(input: unknown): IdentityRecord {
  const value = input as Partial<IdentityRecord> | null;
  if (!value || value.version !== 1 || typeof value.privateKey !== "string" || typeof value.profilePath !== "string") {
    throw new Error("Malformed identity recovery record; recover your identity backup");
  }
  const material = materialFromSeed(bytes(value.privateKey, 32, "Profile private key"));
  if (material.profileTree !== value.profileTree || base64url(material.publicKey) !== value.publicKey) {
    throw new Error("Identity recovery record does not match its key");
  }
  return value as IdentityRecord;
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

  private get fileCredentials(): boolean { return process.env.ARBOR_CREDENTIAL_STORE === "file"; }
  private get isolatedHome(): boolean {
    return resolve(arborPrivateRoot()) !== join(homedir(), ".arbor", ".state");
  }
  private get slot(): string {
    // Explicit data homes remain isolated; only the ordinary installation has
    // a path-independent primary identity in the credential store.
    return this.isolatedHome
      ? `home-v2-${sha256(arborPrivateRoot()).slice(0, 24)}` : "primary-v2";
  }
  private get lockPath(): string {
    return !this.fileCredentials && !this.isolatedHome
      ? join(homedir(), process.platform === "darwin" ? "Library/Application Support" : ".local/state", "Arbor", "Identity", "setup.sqlite")
      : join(arborPrivateRoot(), "identity-lock.sqlite");
  }
  private async locked<T>(operation: () => Promise<T>): Promise<T> {
    await prepareArborDataRoot();
    return withLocalStateLock(this.lockPath, operation);
  }

  async metadata(): Promise<ProfileIdentityMetadata | null> {
    try {
      const value = JSON.parse(await readFile(this.path, "utf8")) as Partial<ProfileIdentityMetadata>;
      if (!value || value.version !== 1 || typeof value.profileTree !== "string" || !isPersonProfileTreeID(value.profileTree)
        || typeof value.publicKey !== "string" || typeof value.profilePath !== "string"
        || typeof value.credential !== "string" || !/^org\.arbor\.person-profile\/(?:self-[a-f0-9]{24}|primary-v2|home-v2-[a-f0-9]{24})$/.test(value.credential)) {
        throw new Error("Malformed Arbor identity metadata; recover the existing identity");
      }
      if (personProfileTreeID(bytes(value.publicKey, 32, "Profile public key")) !== value.profileTree) {
        throw new Error("Stored identity does not match its public key");
      }
      return value as ProfileIdentityMetadata;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private async readRecord(slot: string): Promise<IdentityRecord | null> {
    const source = this.fileCredentials
      ? await readFile(join(arborPrivateRoot(), "self.identity.json"), "utf8").catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        })
      : await Bun.secrets.get({ service: SERVICE, name: slot });
    return source === null ? null : verifiedRecord(JSON.parse(source));
  }

  private async saveRecord(record: IdentityRecord, slot: string): Promise<void> {
    const source = JSON.stringify(record);
    if (this.fileCredentials) {
      const path = join(arborPrivateRoot(), "self.identity.json");
      const temporary = `${path}.${crypto.randomUUID()}.tmp`;
      await writeFile(temporary, source, { mode: 0o600 });
      await rename(temporary, path);
    } else await Bun.secrets.set({ service: SERVICE, name: slot, value: source });
    const saved = await this.readRecord(slot);
    if (!saved || JSON.stringify(saved) !== source) throw new Error("Identity key could not be verified after saving");
  }

  private async state(): Promise<{ metadata: ProfileIdentityMetadata | null; record: IdentityRecord | null; slot: string }> {
    const metadata = await this.metadata();
    // A moved data home keeps the credential reference it already owns.
    const storedName = metadata?.credential.slice(SERVICE.length + 1);
    const slot = storedName && !storedName.startsWith("self-") ? storedName : this.slot;
    let record = await this.readRecord(slot);
    if (record && metadata && (record.profileTree !== metadata.profileTree || record.publicKey !== metadata.publicKey)) {
      throw new Error("Stored profile identity does not match its private key");
    }
    if (!record && metadata) {
      const seed = this.fileCredentials
        ? await readFile(join(arborPrivateRoot(), "self.key"), "utf8").catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return null;
            throw error;
          })
        : storedName?.startsWith("self-") ? await Bun.secrets.get({ service: SERVICE, name: storedName }) : null;
      if (seed !== null) {
        record = verifiedRecord({ ...metadata, privateKey: seed });
        await this.saveRecord(record, slot);
      }
    }
    if (!record && !metadata) {
      const registry = await loadWorkspaceRegistry();
      const candidates: IdentityRecord[] = [];
      for (const entry of Object.values(registry.registry)) {
        if (!isPersonProfileTreeID(entry.rootID)) continue;
        const seed = this.fileCredentials
          ? await readFile(join(arborPrivateRoot(), "self.key"), "utf8").catch((error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT") return null;
              throw error;
            })
          : await Bun.secrets.get({ service: SERVICE, name: credentialName(entry.rootID) });
        if (!seed) continue;
        const material = materialFromSeed(bytes(seed, 32, "Profile private key"));
        if (material.profileTree === entry.rootID) candidates.push({ version: 1, profileTree: material.profileTree,
          publicKey: base64url(material.publicKey), privateKey: seed, profilePath: entry.path });
      }
      if (candidates.length > 1) throw new Error("Several existing identities were found; recover the intended identity backup");
      if (candidates.length === 1) {
        record = candidates[0]!;
        await this.saveRecord(record, slot);
      } else if (this.fileCredentials) {
        const orphan = await readFile(join(arborPrivateRoot(), "self.key"), "utf8").catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        if (orphan !== null) throw new Error("An identity key survives without its profile metadata. Recover its backup before creating an identity.");
      } else if (!this.isolatedHome && process.platform === "darwin") {
        // Legacy pre-index identities cannot be enumerated through Bun.secrets.
        // Check for their existence without requesting or logging secret values.
        const check = Bun.spawn(["/usr/bin/security", "find-generic-password", "-s", SERVICE], { stdout: "ignore", stderr: "ignore" });
        const code = await check.exited;
        if (code === 0) throw new Error("Existing Keychain identity records were found without local metadata. Recover your identity backup instead of creating another identity.");
        if (code !== 44) throw new Error("Keychain identity discovery failed. Unlock Keychain and retry.");
      }
    }
    return { metadata, record, slot };
  }

  private async finish(record: IdentityRecord, slot: string): Promise<ProfileIdentityStatus> {
    const profilePath = await ensureProfileFolder(record.profilePath);
    const binding = (await loadWorkspaceRegistry()).registry[profilePath];
    if (binding?.rootID !== record.profileTree) await bindWorkspaceIdentity(profilePath, record.profileTree);
    const metadata: ProfileIdentityMetadata = { version: 1, profileTree: record.profileTree,
      publicKey: record.publicKey, profilePath, credential: `${SERVICE}/${slot}` };
    const source = `${JSON.stringify(metadata, null, 2)}\n`;
    if (await readFile(this.path, "utf8").catch(() => null) !== source) {
      const temporary = `${this.path}.${crypto.randomUUID()}.tmp`;
      await writeFile(temporary, source, { mode: 0o600 });
      await rename(temporary, this.path);
    }
    return { ...metadata, keyAvailable: true };
  }

  async status(): Promise<ProfileIdentityStatus | null> {
    return this.locked(async () => {
      const { metadata, record, slot } = await this.state();
      if (record) return this.finish(record, slot);
      return metadata ? { ...metadata, keyAvailable: false } : null;
    });
  }

  private async install(material: ReturnType<typeof materialFromSeed>, inputPath: string): Promise<ProfileIdentityStatus> {
    const { metadata, record, slot } = await this.state();
    const existing = record ?? metadata;
    if (existing && existing.profileTree !== material.profileTree) throw new Error(`This Arbor home already belongs to ${existing.profileTree}`);
    const profilePath = await ensureProfileFolder(inputPath);
    if (existing && await realpath(existing.profilePath).catch(() => existing.profilePath) !== profilePath) {
      throw new Error(`This Arbor identity is already bound to ${existing.profilePath}`);
    }
    const binding = (await loadWorkspaceRegistry()).registry[profilePath];
    if (binding && binding.rootID !== material.profileTree) throw new Error(`This profile folder already belongs to ${binding.rootID}; recover that identity`);
    const next: IdentityRecord = { version: 1, profileTree: material.profileTree, publicKey: base64url(material.publicKey),
      privateKey: base64url(material.seed), profilePath };
    // The secure record is the commit point. All filesystem work after this
    // can be resumed with the same key, even if self.json never gets written.
    await this.saveRecord(next, slot);
    return this.finish(next, slot);
  }

  async create(profilePath: string): Promise<ProfileIdentityStatus> {
    return this.locked(async () => {
      const { metadata, record, slot } = await this.state();
      if (metadata || record) {
        const existing = record ?? metadata!;
        const canonical = await realpath(profilePath).catch(() => resolve(profilePath));
        if (canonical !== await realpath(existing.profilePath).catch(() => existing.profilePath)) {
          throw new Error(`This Arbor identity is already bound to ${existing.profilePath}`);
        }
        if (!record) throw new Error(`The private key for ${existing.profileTree} is unavailable; restore a backup`);
        return this.finish(record, slot);
      }
      return this.install(generatedMaterial(), profilePath);
    });
  }

  async updateProfile(patch: { displayName?: string; avatar?: string; description?: string }): Promise<ProfileIdentityStatus> {
    const status = await this.status();
    if (!status) throw new Error("No person identity exists; run `arbor me create`");
    const path = join(status.profilePath, "_index.md");
    const source = await readFile(path, "utf8");
    const document = parseMarkdown(source);
    const frontmatter = patchFrontmatter(document.frontmatterSource, patch);
    if (!frontmatter) throw new Error("Profile frontmatter is unavailable");
    const temporary = `${path}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, `${frontmatter}${document.bodySource}`, { mode: 0o600 });
    await rename(temporary, path);
    return status;
  }

  private async keyMaterial(): Promise<{ metadata: ProfileIdentityMetadata; seed: Buffer; publicKey: Buffer }> {
    return this.locked(async () => {
      const { metadata, record, slot } = await this.state();
      if (!record) throw new Error(metadata ? `The private identity key for ${metadata.profileTree} is unavailable; restore a backup` : "No person identity exists; run `arbor me create`");
      const settled = await this.finish(record, slot);
      const material = materialFromSeed(bytes(record.privateKey, 32, "Profile private key"));
      return { metadata: settled, seed: material.seed, publicKey: material.publicKey };
    });
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
    return this.restoreValue(JSON.parse(await readFile(resolve(sourceInput), "utf8")), profilePath);
  }

  async restoreValue(input: unknown, profilePath: string): Promise<ProfileIdentityStatus> {
    if (!input || typeof input !== "object") throw new Error("Malformed Arbor identity backup");
    const value = input as Partial<ProfileIdentityBackup>;
    if (value.version !== 1 || typeof value.profileTree !== "string" || typeof value.publicKey !== "string" || typeof value.privateKey !== "string") {
      throw new Error("Malformed Arbor identity backup");
    }
    const material = materialFromSeed(bytes(value.privateKey, 32, "Profile private key"));
    if (!isPersonProfileTreeID(value.profileTree) || material.profileTree !== value.profileTree || base64url(material.publicKey) !== value.publicKey) {
      throw new Error("Arbor identity backup does not match its Profile TreeID");
    }
    return this.locked(async () => {
      try { await this.metadata(); }
      catch (error) {
        // Explicit recovery may repair damaged public metadata only when the
        // surviving secure record proves exactly the supplied backup identity.
        // Preserve the damaged bytes for inspection; never treat errors as absence.
        const record = await this.readRecord(this.slot);
        if (!record || record.profileTree !== material.profileTree || record.privateKey !== value.privateKey) throw error;
        if (await realpath(profilePath).catch(() => resolve(profilePath)) !== record.profilePath) {
          throw new Error(`This Arbor identity is already bound to ${record.profilePath}`);
        }
        await readFile(this.path, "utf8");
        await rename(this.path, `${this.path}.damaged-${crypto.randomUUID()}`);
      }
      if (!await this.metadata() && !await this.readRecord(this.slot)) {
        const seed = this.fileCredentials
          ? await readFile(join(arborPrivateRoot(), "self.key"), "utf8").catch((error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT") return null; throw error;
            })
          : await Bun.secrets.get({ service: SERVICE, name: credentialName(material.profileTree) });
        if (seed !== null) {
          if (seed !== value.privateKey) throw new Error("The surviving identity key does not match this backup");
          await this.saveRecord({ version: 1, profileTree: material.profileTree, publicKey: value.publicKey!,
            privateKey: seed, profilePath: await ensureProfileFolder(profilePath) }, this.slot);
        }
      }
      return this.install(material, profilePath);
    });
  }
}
