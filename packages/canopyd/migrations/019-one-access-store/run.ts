import { Database } from "bun:sqlite";
import { join, resolve } from "node:path";
import { ObjectStore } from "@overstory/object-store";
import { readAccountConfigGraph, type ResourceAccessRule } from "@overstory/protocol";
import { assertCurrentCanopySchema } from "../../../../packages/canopyd/src/schema.ts";

/** Schema 19 → 20: one access store, and no unread columns.
 *
 * A tree an account owns (`trees.account_id`) is governed by that account's
 * resource rules alone; `access` keeps only the rules of trees no account
 * owns. Schema 19 kept a lossy whole-tree copy of every hosted tree's rules in
 * `access` as well, and left the trees an account hosts but did not activate
 * (its bootstrap profile, the community root) without an owner.
 *
 * For every active account configuration, the run reads the accepted
 * `trees.yaml` and:
 * - rewrites the account's `resource_policy` rows from its resources (a
 *   configuration converted at bootstrap never had them written);
 * - makes the account the owner of each tree it hosts that has none. A tree
 *   hosted by two accounts, or hosted by one account and owned by another,
 *   stops the run with nothing changed.
 * Then it deletes every owned tree's `access` rows, drops `trees.updated_at`,
 * `tree_reservations.status` and `.error`, `account_challenges.claim_digest`
 * and the `community_name` meta row, and stamps 20.
 *
 * Order: stamp and `quick_check` → read-only checks and the plan → one
 * transaction (the changes, stamp 20, `foreign_key_check`) → schema check. A
 * crash before the transaction leaves the database unchanged. A rerun reports
 * `migrated: false`.
 *
 * The report names no link digest: a link subject is reported by kind only.
 */
export interface MigrationReport {
  migrated: boolean;
  from: string;
  /** Every tree with its unchanged root (as `verify.ts` reads it) and its owner after the run. */
  trees: Array<{ id: string; root: string; path: string | null; status: string; owner: string | null }>;
  /** Trees that gained an owner: the account whose configuration hosts them. */
  adopted: Array<{ tree: string; account: string }>;
  /** Accounts whose `resource_policy` rows the run rewrote because they differed. */
  policyRewritten: string[];
  accessRowsDeleted: number;
  /** Per owned tree, whole-tree access the deleted rows granted that the owner's rules do not
   * (`narrowed`), and the reverse (`widened`). The owner's own profile is never a difference. */
  accessDifferences: Array<{ tree: string; narrowed: string[]; widened: string[] }>;
  /** The `access` rows kept: trees no account owns. */
  unownedAccess: Array<{ tree: string; subject: string; access: string }>;
  ms: Record<string, number>;
}
type Log = (event: Record<string, unknown>) => void;

export class UnmigratableAccessError extends Error {}

interface AccessRow { tree_id: string; subject_kind: string; subject: string; access: string }

/** A subject as the report may show it: profile trees by id, links by kind only. */
function reported(kind: string, subject: string): string {
  return kind === "profile" ? `profile:${subject}` : kind;
}

/** The whole-tree grants a rule list makes, as `access` rows would state them. */
function wholeTree(rules: readonly ResourceAccessRule[]): Map<string, string> {
  const grants = new Map<string, string>();
  for (const rule of rules) {
    if (rule.via || (rule.within ?? "/") !== "/" || rule.who === "me") continue;
    const access = rule.allow.includes("write") ? "write" : rule.allow.includes("read") ? "read" : null;
    if (!access) continue;
    const key = rule.who === "everyone" ? "everyone\neveryone" : "profile" in rule.who ? `profile\n${rule.who.profile}` : `link\n${rule.who.link}`;
    if (grants.get(key) !== "write") grants.set(key, access);
  }
  return grants;
}

export async function migrateAccessStore(root: string, log: Log = () => {}): Promise<MigrationReport> {
  const started = performance.now();
  const ms: Record<string, number> = {};
  const objects = new ObjectStore(join(root, "objects"));
  const db = new Database(join(root, "canopy.sqlite3"), { readwrite: true, strict: true });
  try {
    const trees = () => db.query(`SELECT t.id, t.ref AS root, b.path, t.status, t.account_id AS owner FROM trees t
      LEFT JOIN boundaries b ON b.tree_id = t.id ORDER BY t.id`).all() as MigrationReport["trees"];
    const unownedAccess = () => (db.query(`SELECT a.tree_id, a.subject_kind, a.subject, a.access FROM access a
      JOIN trees t ON t.id = a.tree_id WHERE t.account_id IS NULL ORDER BY a.tree_id, a.subject_kind, a.subject`).all() as AccessRow[])
      .map((row) => ({ tree: row.tree_id, subject: reported(row.subject_kind, row.subject), access: row.access }));
    const stamp = (db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value;
    if (stamp === "20")
      return { migrated: false, from: stamp, trees: trees(), adopted: [], policyRewritten: [], accessRowsDeleted: 0,
        accessDifferences: [], unownedAccess: unownedAccess(), ms };
    if (stamp !== "19") throw new Error(`Migration 019 requires schema 19, found ${stamp}`);
    const check = db.query("PRAGMA quick_check").get() as { quick_check: string };
    if (check.quick_check !== "ok") throw new Error(`quick_check: ${check.quick_check}`);

    // The columns this run drops hold nothing a build reads.
    const reservations = db.query("SELECT COUNT(*) AS n FROM tree_reservations WHERE status IS NOT 'awaiting-initialization' OR error IS NOT NULL").get() as { n: number };
    if (reservations.n) throw new UnmigratableAccessError(`${reservations.n} tree reservations are not awaiting initialization`);

    let since = performance.now();
    const configurations = db.query(`SELECT a.id AS account, t.id AS tree, t.ref FROM accounts a
      JOIN trees t ON t.id = a.config_tree WHERE t.status = 'active' ORDER BY a.rowid`).all() as Array<{ account: string; tree: string; ref: string }>;
    const policies = new Map<string, Array<[string, string]>>();
    const hosts = new Map<string, string[]>();
    const rulesOf = new Map<string, ResourceAccessRule[]>();
    for (const { account, tree, ref } of configurations) {
      const graph = readAccountConfigGraph(await objects.completeSnapshot(ref), tree);
      policies.set(account, Object.entries(graph.resources).map(([id, declaration]) => [id, JSON.stringify(declaration.access)]));
      for (const [id, declaration] of Object.entries(graph.resources)) {
        rulesOf.set(`${account}\n${id}`, declaration.access);
        if (declaration.canonical !== undefined) hosts.set(id, [...hosts.get(id) ?? [], account]);
      }
      log({ event: "configuration", account, resources: Object.keys(graph.resources).length });
    }
    ms.read = Math.round(performance.now() - since);

    const adopted: MigrationReport["adopted"] = [];
    for (const [id, accounts] of hosts) {
      const row = db.query("SELECT account_id, status, policy FROM trees WHERE id = ?").get(id) as { account_id: string | null; status: string; policy: string } | null;
      if (!row || row.status !== "active") continue;
      if (row.policy !== "ordinary") throw new UnmigratableAccessError(`A configuration hosts governed tree ${id}`);
      if (row.account_id === null) {
        if (accounts.length > 1) throw new UnmigratableAccessError(`Tree ${id} is hosted by ${accounts.length} accounts: ${accounts.join(", ")}`);
        adopted.push({ tree: id, account: accounts[0]! });
      } else if (accounts.some((account) => account !== row.account_id)) {
        throw new UnmigratableAccessError(`Tree ${id} is owned by ${row.account_id} but hosted by ${accounts.join(", ")}`);
      }
    }
    const owners = new Map((db.query("SELECT id, account_id FROM trees WHERE account_id IS NOT NULL AND policy = 'ordinary'").all() as Array<{ id: string; account_id: string }>)
      .map(({ id, account_id }) => [id, account_id]));
    for (const { tree, account } of adopted) owners.set(tree, account);

    const policyRewritten = [...policies].filter(([account, rows]) => {
      const stored = db.query("SELECT tree_id, rules_json FROM resource_policy WHERE account_id = ? ORDER BY tree_id").all(account) as Array<{ tree_id: string; rules_json: string }>;
      const wanted = [...rows].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
      return JSON.stringify(stored.map((row) => [row.tree_id, row.rules_json])) !== JSON.stringify(wanted);
    }).map(([account]) => account);

    const accessDifferences: MigrationReport["accessDifferences"] = [];
    for (const [tree, owner] of owners) {
      const ownerProfile = (db.query("SELECT profile_tree FROM accounts WHERE id = ?").get(owner) as { profile_tree: string | null } | null)?.profile_tree;
      const own = (key: string) => key === `profile\n${ownerProfile}`;
      const stored = new Map((db.query("SELECT subject_kind, subject, access FROM access WHERE tree_id = ?").all(tree) as AccessRow[])
        .map((row) => [`${row.subject_kind}\n${row.subject}`, row.access]));
      const granted = wholeTree(rulesOf.get(`${owner}\n${tree}`) ?? []);
      const show = (key: string) => { const [kind, subject] = key.split("\n") as [string, string]; return reported(kind, subject); };
      const narrowed = [...stored].filter(([key, access]) => !own(key) && !(granted.get(key) === access || granted.get(key) === "write")).map(([key, access]) => `${show(key)} ${access}`);
      const widened = [...granted].filter(([key, access]) => !own(key) && !(stored.get(key) === access || stored.get(key) === "write")).map(([key, access]) => `${show(key)} ${access}`);
      if (narrowed.length || widened.length) accessDifferences.push({ tree, narrowed, widened });
    }

    since = performance.now();
    let accessRowsDeleted = 0;
    db.run("PRAGMA foreign_keys = OFF");
    db.transaction(() => {
      for (const { tree, account } of adopted) db.run("UPDATE trees SET account_id = ? WHERE id = ? AND account_id IS NULL", [account, tree]);
      for (const [account, rows] of policies) {
        db.run("DELETE FROM resource_policy WHERE account_id = ?", [account]);
        for (const [tree, rules] of rows) db.run("INSERT INTO resource_policy (account_id, tree_id, rules_json) VALUES (?, ?, ?)", [account, tree, rules]);
      }
      accessRowsDeleted = db.run("DELETE FROM access WHERE tree_id IN (SELECT id FROM trees WHERE account_id IS NOT NULL)").changes;
      db.run("ALTER TABLE trees DROP COLUMN updated_at");
      db.run("ALTER TABLE tree_reservations DROP COLUMN status");
      db.run("ALTER TABLE tree_reservations DROP COLUMN error");
      db.run("ALTER TABLE account_challenges DROP COLUMN claim_digest");
      db.run("DELETE FROM meta WHERE key = 'community_name'");
      db.run("UPDATE meta SET value = '20' WHERE key = 'schema_version'");
      const violations = db.query("PRAGMA foreign_key_check").all();
      if (violations.length) throw new Error(`foreign_key_check: ${JSON.stringify(violations.slice(0, 5))}`);
    })();
    db.run("PRAGMA foreign_keys = ON");
    ms.commit = Math.round(performance.now() - since);
    assertCurrentCanopySchema(db);
    ms.total = Math.round(performance.now() - started);
    return { migrated: true, from: stamp, trees: trees(), adopted, policyRewritten, accessRowsDeleted, accessDifferences, unownedAccess: unownedAccess(), ms };
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  const root = process.argv[2];
  if (!root) { console.error("usage: run.ts <data-root>"); process.exit(2); }
  const report = await migrateAccessStore(resolve(root), (event) => console.error(JSON.stringify(event)));
  console.log(JSON.stringify(report));
}
