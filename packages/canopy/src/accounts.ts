import { timingSafeEqual } from "node:crypto";
import type { Database } from "bun:sqlite";
import { generateArborID, sha256 } from "@arbor/core";
import type { PairingOffer, ServerDevice } from "@arbor/wire";
import type { CanopyAccount, CanopyAuthentication } from "./canopy.ts";

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

  account(id: string): CanopyAccount | null {
    const row = this.db.query("SELECT * FROM accounts WHERE id = ?").get(id) as
      | { id: string; handle: string; profile_tree: string | null; config_tree: string | null; enabled: number }
      | null;
    return row
      ? { id: row.id, handle: row.handle, profileTree: row.profile_tree, configTree: row.config_tree, enabled: row.enabled === 1 }
      : null;
  }

  accountByHandle(handle: string): CanopyAccount | null {
    const row = this.db.query("SELECT id FROM accounts WHERE handle = ?").get(handle) as { id: string } | null;
    return row ? this.account(row.id) : null;
  }

  authenticateToken(token: string | undefined): CanopyAuthentication | null {
    if (!token) return null;
    const digest = sha256(token);
    const device = this.db.query(`
      SELECT d.id AS device_id, d.account_id
      FROM devices d JOIN accounts a ON a.id = d.account_id
      WHERE d.token_digest = ? AND d.revoked_at IS NULL AND a.enabled = 1
    `).get(digest) as { device_id: string; account_id: string } | null;
    if (!device) return null;
    this.db.run("UPDATE devices SET last_used_at = ? WHERE id = ?", [Date.now(), device.device_id]);
    return { account: this.account(device.account_id)!, subject: `device:${device.device_id}`, device: device.device_id };
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

  devices(account: CanopyAccount): ServerDevice[] {
    return this.db.query("SELECT * FROM devices WHERE account_id = ? ORDER BY created_at, id")
      .all(account.id).map((row) => this.deviceRow(row)!);
  }

  /** Whether a DeviceID was ever bound; retired IDs are never reused. */
  deviceExists(id: string): boolean {
    return Boolean(this.db.query("SELECT 1 FROM devices WHERE id = ?").get(id));
  }

  /** The stored credential binding for one device of one account, for exact pairing replay. */
  deviceBinding(id: string, accountID: string): { tokenDigest: string; label: string } | null {
    const row = this.db.query("SELECT token_digest, label FROM devices WHERE id = ? AND account_id = ?")
      .get(id, accountID) as { token_digest: string; label: string } | null;
    return row ? { tokenDigest: row.token_digest, label: row.label } : null;
  }

  insertDevice(id: string, accountID: string, label: string, tokenDigest: string, at: number): void {
    this.db.run(
      "INSERT INTO devices (id, account_id, label, token_digest, created_at) VALUES (?, ?, ?, ?, ?)",
      [id, accountID, label, tokenDigest, at],
    );
  }

  createPairing(account: CanopyAccount): PairingOffer {
    const id = generateArborID("pa");
    const secret = `arp_${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
    const confirmationCode = String(Number.parseInt(sha256(secret).slice(0, 12), 16) % 1_000_000).padStart(6, "0");
    const now = Date.now();
    const expiresAt = now + 10 * 60 * 1000;
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

  resetAccountToken(handle: string, token: string): CanopyAccount {
    if (!/^arb_[a-f0-9]{64}$/.test(token)) {
      throw new Error("A replacement account token must be arb_ followed by 64 lowercase hexadecimal characters");
    }
    const account = this.accountByHandle(handle);
    if (!account) throw new Error(`Unknown account: ~${handle}`);
    const digest = sha256(token);
    const now = Date.now();
    this.db.transaction(() => {
      this.db.run("UPDATE accounts SET token_digest = ? WHERE id = ?", [digest, account.id]);
      this.db.run("UPDATE devices SET revoked_at = ? WHERE account_id = ? AND revoked_at IS NULL", [now, account.id]);
      this.db.run(
        "INSERT INTO devices (id, account_id, label, token_digest, created_at) VALUES (?, ?, 'Recovered device', ?, ?)",
        [generateArborID("dv"), account.id, digest, now],
      );
    })();
    return this.account(account.id)!;
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
