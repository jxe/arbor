import { Database } from "bun:sqlite";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { ObjectStore } from "@ovst/object-store";
import { decodeProtocolDirectory, type ObjectHash } from "@ovst/protocol";
import { memberReservations, readStoredProfile } from "./profile.ts";

/**
 * The operator's overview of a data root (`overstoryd report`): the
 * community's members and invitations, the accounts and their devices, and
 * each tree's place, administrators, current size and update history. It
 * only reads, so it runs beside a live server (the database is in WAL mode).
 */
export interface HostReport {
  generatedAt: number;
  community: { handle: string | null; host: string | null; tree: string | null };
  disk: { databaseBytes: number; objectBytes: number; objectFiles: number };
  /** The community's `members`, in its `_index.md` order. */
  members: ReportMember[];
  accounts: ReportAccount[];
  trees: ReportTree[];
}

export interface ReportMember {
  handle: string;
  /** `invited`: an open invitation. `joined`: a claimed account here.
   * `reserved`: held for a profile that has not claimed it yet. `elsewhere`:
   * a profile another host holds. */
  status: "invited" | "joined" | "reserved" | "elsewhere";
  /** When an invitation was claimed, for members who joined by one. */
  claimedAt?: number;
  locator?: string;
}

export interface ReportAccount {
  handle: string;
  profileTree: string;
  enabled: boolean;
  homeHost: string | null;
  devices: number;
  revokedDevices: number;
  lastSeenAt: number | null;
}

export interface ReportTree {
  id: string;
  path: string | null;
  kind: "ordinary" | "tree-configuration";
  /** The tree a configuration configures. */
  governs: string | null;
  /** Administrators by handle, or by profile TreeID when no account here has it. */
  admins: string[];
  /** The current root's files, with nested trees left to their own rows. */
  files: number;
  bytes: number;
  conflicted: boolean;
  updates: { total: number; last7d: number; last30d: number; firstAt: number | null; lastAt: number | null };
  /** Who wrote in the last 30 days, by handle where a device or account is known. */
  recentWriters: string[];
}

const DAY = 24 * 60 * 60 * 1000;

export async function hostReport(dataRoot: string, now = Date.now()): Promise<HostReport> {
  const db = new Database(join(dataRoot, "overstoryd.sqlite3"), { readonly: true });
  try {
    db.run("PRAGMA busy_timeout = 5000");
    const objects = new ObjectStore(join(dataRoot, "objects"));
    const meta = (key: string) => (db.query("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | null)?.value ?? null;

    const accountRows = db.query("SELECT id, handle, enabled, home_host FROM accounts ORDER BY handle").all() as
      Array<{ id: string; handle: string; enabled: number; home_host: string | null }>;
    const handleOf = new Map(accountRows.map((row) => [row.id, row.handle]));
    const deviceRows = db.query("SELECT id, account_id, last_used_at, revoked_at FROM devices").all() as
      Array<{ id: string; account_id: string; last_used_at: number | null; revoked_at: number | null }>;
    const deviceAccount = new Map(deviceRows.map((row) => [row.id, row.account_id]));
    const accounts: ReportAccount[] = accountRows.map((row) => {
      const devices = deviceRows.filter((device) => device.account_id === row.id);
      const live = devices.filter((device) => device.revoked_at === null);
      const seen = live.map((device) => device.last_used_at).filter((at): at is number => at !== null);
      return {
        handle: row.handle, profileTree: row.id, enabled: row.enabled === 1, homeHost: row.home_host,
        devices: live.length, revokedDevices: devices.length - live.length, lastSeenAt: seen.length ? Math.max(...seen) : null,
      };
    });

    /** A recorded update subject as a person: `device:` and `account:` subjects by handle. */
    const writer = (subject: string): string => {
      const [kind, id] = [subject.slice(0, subject.indexOf(":")), subject.slice(subject.indexOf(":") + 1)];
      const account = kind === "device" ? deviceAccount.get(id) : kind === "account" ? id : undefined;
      return account ? `~${handleOf.get(account) ?? account}` : subject;
    };

    const community = db.query("SELECT tree_id FROM boundaries WHERE path = '/'").get() as { tree_id: string } | null;
    const claims = new Map((db.query("SELECT subject, accepted_at FROM accepted_updates WHERE tree_id = ? AND subject LIKE 'invite:%'")
      .all(community?.tree_id ?? "") as Array<{ subject: string; accepted_at: number }>).map((row) => [row.subject.slice("invite:".length), row.accepted_at]));
    const profile = community ? readStoredProfile(db, community.tree_id) : null;
    const members: ReportMember[] = [...memberReservations(profile?.facts.members ?? [])].map(([handle, reservation]) => {
      if (reservation.inviteDigest) return { handle, status: "invited" };
      if (reservation.locator) return { handle, status: "elsewhere", locator: reservation.locator };
      const joined = reservation.profileTree !== undefined && handleOf.get(reservation.profileTree) === handle;
      const claimedAt = claims.get(handle);
      return { handle, status: joined ? "joined" : "reserved", ...(joined && claimedAt !== undefined ? { claimedAt } : {}) };
    });

    const adminRows = db.query("SELECT tree_id, profile_tree FROM tree_admins").all() as Array<{ tree_id: string; profile_tree: string }>;
    const treeRows = db.query(`
      SELECT t.id, t.governs, b.path,
        (SELECT root FROM accepted_updates WHERE tree_id = t.id ORDER BY ordinal DESC LIMIT 1) AS root,
        (SELECT conflicted FROM accepted_updates WHERE tree_id = t.id ORDER BY ordinal DESC LIMIT 1) AS conflicted,
        (SELECT COUNT(*) FROM accepted_updates WHERE tree_id = t.id) AS total,
        (SELECT COUNT(*) FROM accepted_updates WHERE tree_id = t.id AND accepted_at >= ?1) AS last7d,
        (SELECT COUNT(*) FROM accepted_updates WHERE tree_id = t.id AND accepted_at >= ?2) AS last30d,
        (SELECT MIN(accepted_at) FROM accepted_updates WHERE tree_id = t.id) AS first_at,
        (SELECT MAX(accepted_at) FROM accepted_updates WHERE tree_id = t.id) AS last_at
      FROM trees t LEFT JOIN boundaries b ON b.tree_id = t.id
      ORDER BY b.path IS NULL, b.path, t.id
    `).all(now - 7 * DAY, now - 30 * DAY) as Array<{
      id: string; governs: string | null; path: string | null; root: ObjectHash | null; conflicted: number | null;
      total: number; last7d: number; last30d: number; first_at: number | null; last_at: number | null;
    }>;
    const recentSubjects = db.query("SELECT DISTINCT tree_id, subject FROM accepted_updates WHERE accepted_at >= ? AND subject IS NOT NULL")
      .all(now - 30 * DAY) as Array<{ tree_id: string; subject: string }>;

    const sizes = new Map<ObjectHash, { files: number; bytes: number }>();
    const trees: ReportTree[] = [];
    for (const row of treeRows) {
      const size = row.root ? await rootSize(objects, row.root, sizes) : { files: 0, bytes: 0 };
      trees.push({
        id: row.id, path: row.path, kind: row.governs === null ? "ordinary" : "tree-configuration", governs: row.governs,
        admins: adminRows.filter((admin) => admin.tree_id === row.id).map((admin) => {
          const handle = handleOf.get(admin.profile_tree);
          return handle ? `~${handle}` : admin.profile_tree;
        }).sort(),
        ...size,
        conflicted: row.conflicted === 1,
        updates: { total: row.total, last7d: row.last7d, last30d: row.last30d, firstAt: row.first_at, lastAt: row.last_at },
        recentWriters: [...new Set(recentSubjects.filter((s) => s.tree_id === row.id).map((s) => writer(s.subject)))].sort(),
      });
    }

    return {
      generatedAt: now,
      community: { handle: meta("community_handle"), host: meta("community_host"), tree: community?.tree_id ?? null },
      disk: { databaseBytes: await fileBytes(join(dataRoot, "overstoryd.sqlite3")), ...await directoryBytes(join(dataRoot, "objects")) },
      members, accounts, trees,
    };
  } finally {
    db.close();
  }
}

/** The files a root reaches and their bytes, counting each path once;
 * nested trees are not entered. `sizes` memoizes directories across roots. */
async function rootSize(objects: ObjectStore, root: ObjectHash, sizes: Map<ObjectHash, { files: number; bytes: number }>): Promise<{ files: number; bytes: number }> {
  const known = sizes.get(root);
  if (known) return known;
  const bytes = await objects.find(root);
  if (!bytes) return { files: 0, bytes: 0 };
  const total = { files: 0, bytes: 0 };
  for (const entry of decodeProtocolDirectory(bytes).entries) {
    if (entry.directory !== undefined) {
      const nested = await rootSize(objects, entry.directory, sizes);
      total.files += nested.files;
      total.bytes += nested.bytes;
    } else if (entry.file !== undefined) {
      let file = sizes.get(entry.file);
      if (!file) {
        file = { files: 1, bytes: (await objects.find(entry.file))?.byteLength ?? 0 };
        sizes.set(entry.file, file);
      }
      total.files += 1;
      total.bytes += file.bytes;
    }
  }
  sizes.set(root, total);
  return total;
}

async function fileBytes(path: string): Promise<number> {
  return stat(path).then((info) => info.size, () => 0);
}

async function directoryBytes(path: string): Promise<{ objectBytes: number; objectFiles: number }> {
  const total = { objectBytes: 0, objectFiles: 0 };
  const entries = await readdir(path, { recursive: true, withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    total.objectBytes += await fileBytes(join(entry.parentPath, entry.name));
    total.objectFiles += 1;
  }
  return total;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

function formatAge(at: number | null, now: number): string {
  if (at === null) return "never";
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 60) return `${Math.max(minutes, 0)}m ago`;
  if (minutes < 48 * 60) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / (24 * 60))}d ago`;
}

function table(header: string[], rows: string[][]): string[] {
  const widths = header.map((title, column) => Math.max(title.length, ...rows.map((row) => row[column]!.length)));
  const line = (cells: string[]) => cells.map((cell, column) => cell.padEnd(widths[column]!)).join("  ").trimEnd();
  return [line(header), ...rows.map(line)];
}

/** The report as plain text for a terminal. */
export function formatHostReport(report: HostReport): string {
  const { generatedAt: now } = report;
  const out: string[] = [];
  out.push(`Community ${report.community.handle ?? "(unnamed)"} at ${report.community.host ?? "(no host yet)"}, ${new Date(now).toISOString()}`);
  out.push(`Disk: database ${formatBytes(report.disk.databaseBytes)}, objects ${formatBytes(report.disk.objectBytes)} in ${report.disk.objectFiles} files`);

  const count = (status: ReportMember["status"]) => report.members.filter((member) => member.status === status).length;
  out.push("", `Members: ${count("joined")} joined, ${count("invited")} open invitations, ${count("reserved")} reserved, ${count("elsewhere")} on other hosts`);
  if (report.members.length) {
    out.push(...table(["HANDLE", "STATUS", "CLAIMED"], report.members.map((member) => [
      `~${member.handle}`, member.status === "elsewhere" ? `elsewhere (${member.locator})` : member.status,
      member.claimedAt === undefined ? "" : formatAge(member.claimedAt, now),
    ])));
  }

  out.push("", `Accounts: ${report.accounts.length}`);
  if (report.accounts.length) {
    out.push(...table(["HANDLE", "DEVICES", "LAST SEEN", "NOTES"], report.accounts.map((account) => [
      `~${account.handle}`, `${account.devices}${account.revokedDevices ? ` (+${account.revokedDevices} revoked)` : ""}`,
      formatAge(account.lastSeenAt, now),
      [account.enabled ? "" : "disabled", account.homeHost ? `home ${account.homeHost}` : ""].filter(Boolean).join(", "),
    ])));
  }

  const ordinary = report.trees.filter((tree) => tree.kind === "ordinary");
  const configurations = report.trees.length - ordinary.length;
  out.push("", `Trees: ${ordinary.length} (plus ${configurations} tree configurations), ${formatBytes(ordinary.reduce((sum, tree) => sum + tree.bytes, 0))} in current files`);
  if (ordinary.length) {
    out.push(...table(["PATH", "ADMINS", "FILES", "SIZE", "UPDATES 7D/30D/ALL", "LAST UPDATE", "WRITERS 30D"], ordinary.map((tree) => [
      `${tree.path ?? `(unmounted ${tree.id})`}${tree.conflicted ? " [conflicted]" : ""}`,
      tree.admins.join(" ") || "-", String(tree.files), formatBytes(tree.bytes),
      `${tree.updates.last7d}/${tree.updates.last30d}/${tree.updates.total}`, formatAge(tree.updates.lastAt, now),
      tree.recentWriters.join(" ") || "-",
    ])));
  }
  return out.join("\n");
}
