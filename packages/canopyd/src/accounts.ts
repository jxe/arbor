import { timingSafeEqual } from "node:crypto";
import type { Database } from "bun:sqlite";
import { generateArborID, sha256 } from "@overstory/protocol";
import type { PairingOffer, ServerDevice } from "@overstory/protocol";
import type { HostAccount, HostAuthentication } from "./model.ts";
import { PlacementAccountError } from "./errors.ts";

/** A device's last-use time is advisory; refresh it at most this often. */
const LAST_USED_RESOLUTION_MS = 60_000;

/** What a challenge is for; one purpose's challenge is never redeemed by another. */
export type ChallengePurpose = "account-claim" | "device-session";

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

/** Accounts, device keys and sessions, and pairing offers: the rows behind every authenticated request. */
/** Whether a pairing is a recovery pairing, which only the host operator issues. */
export function isRecoveryPairing(id: string): boolean {
  return id.startsWith("pr_");
}

export class AccountDirectory {
  /** Rows this directory changed that no authorization decision reads (a
   * device's last-use time), so the authorization epoch can discount them. */
  advisoryChanges = 0;

  constructor(private readonly db: Database) {}

  account(id: string): HostAccount | null {
    const row = this.db.query("SELECT id, handle, enabled, home_host FROM accounts WHERE id = ?").get(id) as
      | { id: string; handle: string; enabled: number; home_host: string | null }
      | null;
    return row
      ? { id: row.id, handle: row.handle, enabled: row.enabled === 1, homeHost: row.home_host }
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

  /** A key device's unexpired session: the only bearer token a device presents. */
  authenticateToken(token: string | undefined): HostAuthentication | null {
    if (!token) return null;
    const now = Date.now();
    const device = this.db.query(`
      SELECT d.id AS device_id, d.account_id, d.last_used_at, s.expires_at
      FROM device_sessions s JOIN devices d ON d.id = s.device_id JOIN accounts a ON a.id = d.account_id
      WHERE s.token_digest = ? AND s.expires_at > ? AND d.revoked_at IS NULL AND a.enabled = 1
    `).get(sha256(token), now) as { device_id: string; account_id: string; last_used_at: number | null; expires_at: number } | null;
    if (!device) return null;
    // Skip the write on the hot path while the stored time is recent enough.
    if (device.last_used_at === null || now - device.last_used_at >= LAST_USED_RESOLUTION_MS) {
      this.advisoryChanges += this.db.run("UPDATE devices SET last_used_at = ? WHERE id = ?", [now, device.device_id]).changes;
    }
    return { account: this.account(device.account_id)!, subject: `device:${device.device_id}` as const, device: device.device_id, expiresAt: device.expires_at };
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

  /**
   * The stored key of one device of one account, for sessions and exact
   * pairing replay. `publicKey` is null only for a device revoked before
   * every device had a key; its row stays so its DeviceID is never reused.
   */
  deviceBinding(id: string, accountID: string): { publicKey: string | null; label: string; revokedAt: number | null } | null {
    const row = this.db.query("SELECT public_key, label, revoked_at FROM devices WHERE id = ? AND account_id = ?")
      .get(id, accountID) as { public_key: string | null; label: string; revoked_at: number | null } | null;
    return row ? { publicKey: row.public_key, label: row.label, revokedAt: row.revoked_at } : null;
  }

  insertDevice(id: string, accountID: string, label: string, publicKey: string, at: number): void {
    this.db.run("INSERT INTO devices (id, account_id, label, public_key, created_at) VALUES (?, ?, ?, ?, ?)", [id, accountID, label, publicKey, at]);
  }

  /** The DeviceIDs of an account's unrevoked devices. */
  activeDeviceIDs(accountID: string): string[] {
    return (this.db.query("SELECT id FROM devices WHERE account_id = ? AND revoked_at IS NULL ORDER BY id").all(accountID) as Array<{ id: string }>)
      .map((row) => row.id);
  }

  /** Revoke one device and end its sessions; callers run this inside their transaction. */
  revokeDevice(deviceID: string, at: number): void {
    this.db.run("UPDATE devices SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?", [at, deviceID]);
    this.endSessions(deviceID);
  }

  /** Placement accounts with at least one unexpired session, and their home hosts. */
  placementAccountsWithSessions(now: number): Array<{ id: string; homeHost: string }> {
    return (this.db.query(`
      SELECT DISTINCT a.id, a.home_host FROM accounts a
      JOIN devices d ON d.account_id = a.id JOIN device_sessions s ON s.device_id = d.id
      WHERE a.home_host IS NOT NULL AND d.revoked_at IS NULL AND s.expires_at > ?
      ORDER BY a.id
    `).all(now) as Array<{ id: string; home_host: string }>).map((row) => ({ id: row.id, homeHost: row.home_host }));
  }

  /** End every session of one device; callers run this inside their transaction. */
  endSessions(deviceID: string): void {
    this.db.run("DELETE FROM device_sessions WHERE device_id = ?", [deviceID]);
  }

  /** Account claims and device sessions share one challenge table, apart by purpose. */
  insertChallenge(purpose: ChallengePurpose, id: string, challengeJSON: string, expiresAt: number, now: number): void {
    // An expired challenge can never be used, consumed or not.
    this.db.run("DELETE FROM challenges WHERE expires_at <= ?", [now]);
    this.db.run("INSERT INTO challenges (id, purpose, challenge_json, expires_at) VALUES (?, ?, ?, ?)", [id, purpose, challengeJSON, expiresAt]);
  }

  /** An issued challenge as stored, to say why it cannot be consumed. */
  challenge(purpose: ChallengePurpose, id: string): { challengeJSON: string; expiresAt: number; consumedAt: number | null } | null {
    const row = this.db.query("SELECT challenge_json, expires_at, consumed_at FROM challenges WHERE id = ? AND purpose = ?").get(id, purpose) as
      { challenge_json: string; expires_at: number; consumed_at: number | null } | null;
    return row ? { challengeJSON: row.challenge_json, expiresAt: row.expires_at, consumedAt: row.consumed_at } : null;
  }

  /** Consume a challenge exactly as issued; false when it is unknown, altered,
   * expired or already used. */
  consumeChallenge(purpose: ChallengePurpose, id: string, challengeJSON: string, now: number): boolean {
    return this.db.run(
      "UPDATE challenges SET consumed_at = ? WHERE id = ? AND purpose = ? AND challenge_json = ? AND consumed_at IS NULL AND expires_at > ?",
      [now, id, purpose, challengeJSON, now],
    ).changes === 1;
  }

  insertSession(tokenDigest: string, deviceID: string, now: number, expiresAt: number): void {
    this.db.run("DELETE FROM device_sessions WHERE expires_at <= ?", [now]);
    this.db.run("INSERT INTO device_sessions (token_digest, device_id, created_at, expires_at) VALUES (?, ?, ?, ?)", [tokenDigest, deviceID, now, expiresAt]);
  }

  /**
   * A single-use pairing for `account`. A recovery pairing, which only the
   * host operator issues (`canopyd recover`), lasts a day and its claim makes
   * the new device the account's only one; its ID says which it is.
   */
  /**
   * A pairing offer, or with `recovery` the operator's recovery pairing
   * (accounts §5.3). A placement account has neither here: its devices are
   * its home host's (accounts §1.3), so every caller, the `recover` command
   * included, is refused the same way.
   */
  createPairing(account: HostAccount, options: { recovery?: boolean } = {}): PairingOffer {
    if (account.homeHost) {
      throw new PlacementAccountError(account.homeHost, `${options.recovery ? "Recovery" : "Pairing"} is not available here: ~${account.handle} is a placement account, and its profile's configuration and devices are at its home host ${account.homeHost}`);
    }
    const id = generateArborID(options.recovery ? "pr" : "pa");
    const secret = `arp_${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
    const confirmationCode = String(Number.parseInt(sha256(secret).slice(0, 12), 16) % 1_000_000).padStart(6, "0");
    const now = Date.now();
    const expiresAt = now + (options.recovery ? 24 * 60 * 60 * 1000 : 10 * 60 * 1000);
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
