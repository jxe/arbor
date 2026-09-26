import { timingSafeEqual } from "node:crypto";
import type { Database } from "bun:sqlite";
import { generateArborID, sha256 } from "@overstory/protocol";
import type { PairingOffer, ServerDevice } from "@overstory/protocol";
import type { HostAccount, HostAuthentication } from "./model.ts";

/** A device's last-use time is advisory; refresh it at most this often. */
const LAST_USED_RESOLUTION_MS = 60_000;

/** A digest device's credential digest, or a key device's public key. */
export type DeviceBinding = { tokenDigest: string } | { publicKey: string };

export interface PendingResetRecord {
  profileTree: string;
  device: { id: string; label: string; key: string };
  requestedAt: number;
  effectiveAt: number;
  proofDigest: string;
}

export interface PairingRecord {
  id: string;
  accountID: string;
  confirmationCode: string;
  expiresAt: number;
  claimedAt: number | null;
  claimedDevice: string | null;
  accountEnabled: boolean;
  /** Constant-time comparison of a presented secret against the stored digest. */
  secretMatches(secret: string): boolean;
}

/** Accounts, device credentials, and pairing offers: the rows behind every authenticated request. */
export class AccountDirectory {
  constructor(private readonly db: Database) {}

  account(id: string): HostAccount | null {
    const row = this.db.query("SELECT id, handle, enabled FROM accounts WHERE id = ?").get(id) as
      | { id: string; handle: string; enabled: number }
      | null;
    return row
      ? { id: row.id, handle: row.handle, profileTree: row.id, enabled: row.enabled === 1 }
      : null;
  }

  /** The account row when it exists and the community has not disabled it. */
  enabledAccount(id: string): HostAccount | null {
    const account = this.account(id);
    return account?.enabled ? account : null;
  }

  /** The handle of the enabled account whose profile this is. */
  handleForProfile(profileTree: string): string | undefined {
    const row = this.db.query("SELECT handle FROM accounts WHERE id = ? AND enabled = 1").get(profileTree) as { handle: string } | null;
    return row?.handle;
  }

  accountByHandle(handle: string): HostAccount | null {
    const row = this.db.query("SELECT id FROM accounts WHERE handle = ?").get(handle) as { id: string } | null;
    return row ? this.account(row.id) : null;
  }

  /**
   * A digest device's credential, or a key device's unexpired session. A
   * profile whose reset has taken effect authenticates none of its earlier
   * devices, even before the reset's update is accepted.
   */
  authenticateToken(token: string | undefined): HostAuthentication | null {
    if (!token) return null;
    const digest = sha256(token);
    const now = Date.now();
    const device = this.db.query(`
      SELECT d.id AS device_id, d.account_id, d.last_used_at, NULL AS expires_at
      FROM devices d JOIN accounts a ON a.id = d.account_id
      WHERE d.token_digest = ? AND d.revoked_at IS NULL AND a.enabled = 1
      UNION ALL
      SELECT d.id AS device_id, d.account_id, d.last_used_at, s.expires_at
      FROM device_sessions s JOIN devices d ON d.id = s.device_id JOIN accounts a ON a.id = d.account_id
      WHERE s.token_digest = ? AND s.expires_at > ? AND d.revoked_at IS NULL AND a.enabled = 1
    `).get(digest, digest, now) as { device_id: string; account_id: string; last_used_at: number | null; expires_at: number | null } | null;
    if (!device || this.resetIsDue(device.account_id, now)) return null;
    // Skip the write on the hot path while the stored time is recent enough.
    if (device.last_used_at === null || now - device.last_used_at >= LAST_USED_RESOLUTION_MS) {
      this.db.run("UPDATE devices SET last_used_at = ? WHERE id = ?", [now, device.device_id]);
    }
    return {
      account: this.account(device.account_id)!, subject: `device:${device.device_id}`, device: device.device_id,
      ...(device.expires_at !== null ? { expiresAt: device.expires_at } : {}),
    };
  }

  private deviceRow(value: unknown): ServerDevice | null {
    if (!value) return null;
    const row = value as {
      id: string;
      account_id: string;
      label: string;
      created_at: number;
      last_used_at: number | null;
      revoked_at: number | null;
    };
    return {
      id: row.id,
      account: row.account_id,
      label: row.label,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
      revokedAt: row.revoked_at,
    };
  }

  device(id: string): ServerDevice | null {
    return this.deviceRow(this.db.query("SELECT * FROM devices WHERE id = ?").get(id));
  }

  devices(account: HostAccount): ServerDevice[] {
    return this.db.query("SELECT * FROM devices WHERE account_id = ? ORDER BY created_at, id")
      .all(account.id).map((row) => this.deviceRow(row)!);
  }

  /** Whether a DeviceID was ever bound; retired IDs are never reused. */
  deviceExists(id: string): boolean {
    return Boolean(this.db.query("SELECT 1 FROM devices WHERE id = ?").get(id));
  }

  /** The stored binding for one device of one account, for exact pairing replay. */
  deviceBinding(id: string, accountID: string): { binding: DeviceBinding; label: string; revokedAt: number | null } | null {
    const row = this.db.query("SELECT token_digest, public_key, label, revoked_at FROM devices WHERE id = ? AND account_id = ?")
      .get(id, accountID) as { token_digest: string | null; public_key: string | null; label: string; revoked_at: number | null } | null;
    if (!row) return null;
    return {
      binding: row.public_key !== null ? { publicKey: row.public_key } : { tokenDigest: row.token_digest! },
      label: row.label,
      revokedAt: row.revoked_at,
    };
  }

  insertDevice(id: string, accountID: string, label: string, binding: DeviceBinding, at: number): void {
    this.db.run(
      "INSERT INTO devices (id, account_id, label, token_digest, public_key, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      [id, accountID, label, "tokenDigest" in binding ? binding.tokenDigest : null, "publicKey" in binding ? binding.publicKey : null, at],
    );
  }

  /** A digest device moves to a key: its credential stops working in the same
   * transaction. Callers run this inside the transaction that accepts the key. */
  bindDeviceKey(id: string, publicKey: string): void {
    this.db.run("UPDATE devices SET public_key = ?, token_digest = NULL WHERE id = ?", [publicKey, id]);
  }

  /** End every session of one device; callers run this inside their transaction. */
  endSessions(deviceID: string): void {
    this.db.run("DELETE FROM device_sessions WHERE device_id = ?", [deviceID]);
  }

  insertChallenge(id: string, challengeJSON: string, expiresAt: number, now: number): void {
    // An expired challenge can never be used, consumed or not.
    this.db.run("DELETE FROM device_challenges WHERE expires_at <= ?", [now]);
    this.db.run("INSERT INTO device_challenges (id, challenge_json, expires_at) VALUES (?, ?, ?)", [id, challengeJSON, expiresAt]);
  }

  /** Consume a challenge exactly as issued; false when it is unknown, altered,
   * expired or already used. */
  consumeChallenge(id: string, challengeJSON: string, now: number): boolean {
    return this.db.run(
      "UPDATE device_challenges SET consumed_at = ? WHERE id = ? AND challenge_json = ? AND consumed_at IS NULL AND expires_at > ?",
      [now, id, challengeJSON, now],
    ).changes === 1;
  }

  insertSession(tokenDigest: string, deviceID: string, now: number, expiresAt: number): void {
    this.db.run("DELETE FROM device_sessions WHERE expires_at <= ?", [now]);
    this.db.run("INSERT INTO device_sessions (token_digest, device_id, created_at, expires_at) VALUES (?, ?, ?, ?)", [tokenDigest, deviceID, now, expiresAt]);
  }

  pendingReset(profileTree: string): PendingResetRecord | null {
    const row = this.db.query("SELECT * FROM profile_resets WHERE profile_tree = ?").get(profileTree) as {
      profile_tree: string; device_id: string; label: string; public_key: string; requested_at: number; effective_at: number; proof_digest: string;
    } | null;
    return row ? {
      profileTree: row.profile_tree, device: { id: row.device_id, label: row.label, key: row.public_key },
      requestedAt: row.requested_at, effectiveAt: row.effective_at, proofDigest: row.proof_digest,
    } : null;
  }

  insertReset(reset: PendingResetRecord): void {
    this.db.run(
      "INSERT INTO profile_resets (profile_tree, device_id, label, public_key, requested_at, effective_at, proof_digest) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [reset.profileTree, reset.device.id, reset.device.label, reset.device.key, reset.requestedAt, reset.effectiveAt, reset.proofDigest],
    );
  }

  deleteReset(profileTree: string): boolean {
    return this.db.run("DELETE FROM profile_resets WHERE profile_tree = ?", [profileTree]).changes === 1;
  }

  resetIsDue(profileTree: string, now: number): boolean {
    return Boolean(this.db.query("SELECT 1 FROM profile_resets WHERE profile_tree = ? AND effective_at <= ?").get(profileTree, now));
  }

  /** Profiles whose reset has taken effect but not yet been accepted. */
  dueResets(now: number): string[] {
    return (this.db.query("SELECT profile_tree FROM profile_resets WHERE effective_at <= ? ORDER BY effective_at").all(now) as Array<{ profile_tree: string }>)
      .map((row) => row.profile_tree);
  }

  createPairing(account: HostAccount): PairingOffer {
    const id = generateArborID("pa");
    const secret = `arp_${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
    const confirmationCode = String(Number.parseInt(sha256(secret).slice(0, 12), 16) % 1_000_000).padStart(6, "0");
    const now = Date.now();
    const expiresAt = now + 10 * 60 * 1000;
    // An expired unclaimed pairing can never be claimed; a claimed one stays for exact replay.
    this.db.run("DELETE FROM pairings WHERE claimed_at IS NULL AND expires_at <= ?", [now]);
    this.db.run(`
      INSERT INTO pairings (id, account_id, secret_digest, confirmation_code, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [id, account.id, sha256(secret), confirmationCode, now, expiresAt]);
    return { id, secret, confirmationCode, expiresAt };
  }

  pairing(id: string): PairingRecord | null {
    const row = this.db.query(`
      SELECT p.*, a.enabled AS account_enabled
      FROM pairings p JOIN accounts a ON a.id = p.account_id
      WHERE p.id = ?
    `).get(id) as {
      account_id: string;
      secret_digest: string;
      confirmation_code: string;
      expires_at: number;
      claimed_at: number | null;
      claimed_device: string | null;
      account_enabled: number;
    } | null;
    if (!row) return null;
    return {
      id,
      accountID: row.account_id,
      confirmationCode: row.confirmation_code,
      expiresAt: row.expires_at,
      claimedAt: row.claimed_at,
      claimedDevice: row.claimed_device,
      accountEnabled: row.account_enabled === 1,
      secretMatches: (secret) => {
        const presented = Buffer.from(sha256(secret));
        const expected = Buffer.from(row.secret_digest);
        return presented.length === expected.length && timingSafeEqual(presented, expected);
      },
    };
  }

  /** Mark a pairing claimed; returns false when it was already used or has expired. */
  claimPairing(id: string, deviceID: string, at: number): boolean {
    const claimed = this.db.run(
      "UPDATE pairings SET claimed_at = ?, claimed_device = ? WHERE id = ? AND claimed_at IS NULL AND expires_at > ?",
      [at, deviceID, id, at],
    );
    return claimed.changes === 1;
  }

  /** Revoke every device of an account and end their sessions; callers run this inside their transaction. */
  revokeAllDevices(accountID: string, at: number): void {
    this.db.run("DELETE FROM device_sessions WHERE device_id IN (SELECT id FROM devices WHERE account_id = ?)", [accountID]);
    this.db.run("UPDATE devices SET revoked_at = ? WHERE account_id = ? AND revoked_at IS NULL", [at, accountID]);
  }

  communityHandle(): string {
    const row = this.db.query("SELECT value FROM meta WHERE key = 'community_handle'").get() as { value: string } | null;
    return row?.value ?? "community";
  }

  setCommunityHost(host: string, allowTestPortChange = false): void {
    const normalized = host.toLowerCase();
    const existing = this.db.query("SELECT value FROM meta WHERE key = 'community_host'")
      .get() as { value: string } | null;
    if (existing && existing.value !== normalized && !allowTestPortChange) {
      throw new Error(`Community canonical host is ${existing.value}, not ${normalized}`);
    }
    this.db.run(
      "INSERT INTO meta (key, value) VALUES ('community_host', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      [normalized],
    );
  }
}
