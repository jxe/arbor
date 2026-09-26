import { Database } from "bun:sqlite";
import { join, resolve } from "node:path";
import { ObjectStore } from "@overstory/object-store";
import { LOG_ENTRY_FORMAT } from "@overstory/merge-protocol";
import {
  isTreeID,
  readTreeConfigGraph,
  resourceRuleKey,
  snapshotTreeConfig,
  treeConfigurationID,
  type AppAccessRule,
  type ObjectHash,
  type ResourceAccessRule,
  type TreeConfigKind,
  type TreeConfigValues,
} from "@overstory/protocol";
import { assertCurrentHostSchema, assertHostData, createTreeConfigIndex } from "../../../../packages/canopyd/src/schema.ts";
import { AcceptedUpdateStore } from "../../../../packages/canopyd/src/updates/store.ts";
import { MergeHistory } from "../../../../packages/canopyd/src/updates/merge-history.ts";
import { entryChanges } from "../../../../packages/canopyd/src/updates/entry-metadata.ts";
import { profileLocatorTree, type RootProfileFacts } from "../../../../packages/canopyd/src/profile.ts";
import { readLegacyAccountConfig, type LegacyAccountConfig, type LegacyRule } from "./legacy.ts";

/**
 * Schema 21 → 22: every hosted tree configured in its own tree configuration
 * (canopyd 005).
 *
 * For each active ordinary tree the run writes one configuration, with the
 * derived TreeID, `tree-config-v1` policy and one accepted update:
 * - `access.yaml`: `admin` for the owner's profile (for the community root,
 *   the root itself, so its members administer it), then the tree's rules:
 *   the owner's `trees.yaml` rules, or the `access` rows of a tree no account
 *   owns, less those administration now covers (`who: me` without `via`, and
 *   rules naming an administrator). An owner's rule with `via` and another
 *   `who` becomes the tree's own rule with `app`.
 * - `mounts.yaml`: the tree's current nested boundaries, by path below it.
 *   The root's `/~handle` boundary of a member's profile is a member mount,
 *   not a `mounts.yaml` entry.
 * - `apps.yaml` for a profile tree: for a person, every other `via` rule of
 *   the account's `trees.yaml`, under its app; for a group, nothing.
 * - `devices.yaml` for a person: the account's `devices.yaml`, unchanged.
 *
 * Then accounts are keyed by their profile TreeID (devices and pairings
 * follow), each account configuration tree and its history are deleted, and
 * `resource_policy`, `access`, `tree_reservations`, `trees.account_id`,
 * `accounts.profile_tree` and `accounts.config_tree` are dropped.
 *
 * The run changes nothing and throws `UnmigratableTreeConfigError` when a rule
 * would be dropped other than those administration covers, when a lent rule
 * names access its account holds only through a group or not at all, when a
 * tree's whole-tree access (group administrators and grants expanded to
 * their members) would differ, or when the mounts would not reproduce every
 * boundary.
 *
 * Order: stamp and `quick_check` → read-only plan and checks → configuration
 * objects and log entries stored (unreferenced until the commit) → one
 * transaction (every change, stamp 22, `foreign_key_check`) → schema and row
 * checks. A crash before the transaction leaves the database unchanged. A
 * rerun reports `migrated: false`.
 *
 * The report names no link digest: a link subject is reported by kind only.
 */
export interface MigrationReport {
  migrated: boolean;
  from: string;
  /** Every tree with its root (as `verify.ts` reads it), unchanged for every tree that was not an account configuration. */
  trees: Array<{ id: string; root: string; path: string | null; status: string; policy: string; governs: string | null }>;
  /** One per tree: the configuration written and its files' shape. */
  configurations: Array<{ tree: string; configuration: string; kind: TreeConfigKind; root: string; administrators: string[]; rules: number; mounts: Record<string, string>; apps: number; devices: number }>;
  /** Accounts rekeyed from their old id to their profile TreeID. */
  accounts: Array<{ from: string; profile: string; handle: string; deletedConfiguration: string }>;
  /** Per tree, whole-tree access before and after, and whether they differ (they must not). */
  access: Array<{ tree: string; before: string[]; after: string[] }>;
  /** Every capability code could use through `via` before, and through `app` rules and `apps.yaml` after. */
  lent: { before: string[]; after: string[] };
  /** Rules administration now covers, dropped by design. */
  covered: string[];
  ms: Record<string, number>;
}
type Log = (event: Record<string, unknown>) => void;

export class UnmigratableTreeConfigError extends Error {}

interface TreeRow { id: string; ref: ObjectHash; policy: string; status: string; account_id: string | null; path: string | null; parent_tree: string | null }
interface AccountRow { id: string; handle: string; profile_tree: string | null; config_tree: string | null; enabled: number }
interface AccessRow { tree_id: string; subject_kind: string; subject: string; access: string }

function reportedWho(who: LegacyRule["who"] | ResourceAccessRule["who"]): string {
  if (typeof who === "string") return who;
  return "profile" in who ? `profile:${who.profile}` : "link";
}
function describe(rule: { who: LegacyRule["who"] | ResourceAccessRule["who"]; allow: readonly string[]; within?: string }, extra: string): string {
  return `${extra} who=${reportedWho(rule.who)} allow=${[...rule.allow].sort().join(",")} within=${rule.within ?? "/"}`;
}

/** A schema-21 rule as a schema-22 rule: `via` is `app`. */
function modern(rule: LegacyRule): ResourceAccessRule {
  if (rule.who === "me") throw new Error("me has no schema-22 access.yaml form");
  return {
    who: rule.who,
    ...(rule.via ? { app: rule.via } : {}),
    allow: rule.allow as ResourceAccessRule["allow"],
    ...(rule.within && rule.within !== "/" ? { within: rule.within } : {}),
  };
}

/** The whole-tree read or write each subject holds, as `access` rows would state it. */
function wholeTree(grants: Array<{ who: string; allow: readonly string[] }>, expand: (who: string) => string[]): string[] {
  const held = new Map<string, "read" | "write">();
  for (const grant of grants) {
    const access = grant.allow.includes("admin") || grant.allow.includes("write") ? "write" : grant.allow.includes("read") ? "read" : null;
    if (!access) continue;
    // A group administers through its members; the group itself is not a caller.
    const subjects = grant.allow.includes("admin") ? expand(grant.who).filter((who) => who !== grant.who || expand(grant.who).length === 1) : expand(grant.who);
    for (const who of subjects) if (held.get(who) !== "write") held.set(who, access);
  }
  return [...held].map(([who, access]) => `${who} ${access}`).sort();
}

export async function migrateTreeConfigurations(root: string, log: Log = () => {}): Promise<MigrationReport> {
  const started = performance.now();
  const ms: Record<string, number> = {};
  const objects = new ObjectStore(join(root, "objects"));
  const db = new Database(join(root, "canopy.sqlite3"), { readwrite: true, strict: true });
  try {
    const trees = () => db.query(`SELECT t.id, t.ref AS root, b.path, t.status, t.policy, t.governs FROM trees t
      LEFT JOIN boundaries b ON b.tree_id = t.id ORDER BY t.id`).all() as MigrationReport["trees"];
    const stamp = (db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value;
    if (stamp === "22") {
      return { migrated: false, from: stamp, trees: trees(), configurations: [], accounts: [], access: [], lent: { before: [], after: [] }, covered: [], ms };
    }
    if (stamp !== "21") throw new Error(`Migration 022 requires schema 21, found ${stamp}`);
    const check = db.query("PRAGMA quick_check").get() as { quick_check: string };
    if (check.quick_check !== "ok") throw new Error(`quick_check: ${check.quick_check}`);
    const refuse = (message: string) => { throw new UnmigratableTreeConfigError(message); };

    let since = performance.now();
    const reservations = db.query("SELECT id, canonical_path FROM tree_reservations").all() as Array<{ id: string; canonical_path: string }>;
    if (reservations.length) refuse(`Declared trees await initialization: ${reservations.map((r) => `${r.id} at ${r.canonical_path}`).join(", ")}; activate or remove them first`);
    const accounts = db.query("SELECT id, handle, profile_tree, config_tree, enabled FROM accounts ORDER BY rowid").all() as AccountRow[];
    for (const account of accounts) {
      if (!account.profile_tree || !isTreeID(account.profile_tree)) refuse(`Account ${account.id} (~${account.handle}) has no profile TreeID`);
      if (!account.config_tree) refuse(`Account ${account.id} (~${account.handle}) has no account configuration`);
    }
    const byProfile = new Map<string, AccountRow>();
    for (const account of accounts) {
      if (byProfile.has(account.profile_tree!)) refuse(`Profile ${account.profile_tree} has several accounts on this host`);
      byProfile.set(account.profile_tree!, account);
    }
    const byID = new Map(accounts.map((account) => [account.id, account]));
    const configurations = new Map<string, LegacyAccountConfig>();
    for (const account of accounts) {
      const row = db.query("SELECT ref FROM trees WHERE id = ? AND policy = 'account-config-v2'").get(account.config_tree) as { ref: ObjectHash } | null;
      if (!row) refuse(`Account ${account.id} names a missing configuration tree ${account.config_tree}`);
      const config = readLegacyAccountConfig(await objects.completeSnapshot(row!.ref));
      if (config.account.profile !== account.profile_tree) refuse(`Account ${account.id}'s account.yaml names another profile`);
      configurations.set(account.id, config);
      log({ event: "account", account: account.id, trees: Object.keys(config.trees).length, devices: Object.keys(config.devices).length });
    }
    const all = db.query(`SELECT t.id, t.ref, t.policy, t.status, t.account_id, b.path, b.parent_tree FROM trees t
      LEFT JOIN boundaries b ON b.tree_id = t.id ORDER BY t.id`).all() as TreeRow[];
    const ordinary = all.filter((tree) => tree.policy === "ordinary" && tree.status === "active");
    const community = ordinary.find((tree) => tree.path === "/");
    if (!community) refuse("The community root has no boundary");
    const facts = new Map((db.query("SELECT tree_id, facts FROM profile_facts").all() as Array<{ tree_id: string; facts: string }>)
      .map((row) => [row.tree_id, JSON.parse(row.facts) as RootProfileFacts]));
    const groups = new Set([...facts].filter(([, value]) => value.type === "group").map(([tree]) => tree));
    // One-level membership, as authorization reads it: members that enabled accounts hold.
    const members = (group: string) => (facts.get(group)?.members ?? [])
      .flatMap((member) => { const profile = profileLocatorTree(member.profile); return profile ? [profile] : []; })
      .filter((profile) => byProfile.get(profile)?.enabled === 1);
    const expand = (who: string) => who.startsWith("profile:") && groups.has(who.slice(8)) ? [who, ...members(who.slice(8)).map((profile) => `profile:${profile}`)] : [who];
    const kindOf = (tree: string): TreeConfigKind => byProfile.has(tree) ? "person" : groups.has(tree) ? "group" : "tree";

    // Plan every configuration.
    const covered: string[] = [];
    const lentBefore: string[] = [];
    const lentAfter: string[] = [];
    const accessReport: MigrationReport["access"] = [];
    const apps = new Map<string, Record<string, AppAccessRule[]>>();
    const planned = new Map<string, { kind: TreeConfigKind; values: TreeConfigValues; member: Array<{ path: string; tree: string }> }>();
    for (const tree of ordinary) {
      const owner = tree.account_id ? byID.get(tree.account_id) : undefined;
      if (tree.account_id && !owner) refuse(`Tree ${tree.id} is owned by a missing account ${tree.account_id}`);
      const administrators = tree.id === community!.id ? [community!.id] : owner ? [owner.profile_tree!] : refuse(`Tree ${tree.id} at ${tree.path ?? "(no path)"} has no owner and is not the community root`) as never;
      const access: ResourceAccessRule[] = administrators.map((profile) => ({ who: { profile }, allow: ["admin"] }));
      const administered = new Set(administrators.flatMap((admin) => [admin, ...(groups.has(admin) ? members(admin) : [])]));
      let before: string[];
      if (owner) {
        const rules = configurations.get(owner.id)!.trees[tree.id]?.access ?? [];
        before = wholeTree([{ who: `profile:${owner.profile_tree}`, allow: ["write"] }, ...rules
          .filter((rule) => !rule.via && (rule.within ?? "/") === "/" && rule.who !== "me")
          .map((rule) => ({ who: reportedWho(rule.who), allow: rule.allow }))], expand);
        for (const rule of rules) {
          if (rule.via) lentBefore.push(describe(rule, `${tree.id} via=${rule.via} account=${owner.profile_tree}`));
          if (rule.who === "me") {
            if (!rule.via) { covered.push(describe(rule, `${tree.id} owner`)); continue; }
            const list = apps.get(owner.profile_tree!) ?? {};
            (list[rule.via] ??= []).push({ resource: tree.id, who: "me", allow: rule.allow as AppAccessRule["allow"], ...(rule.within && rule.within !== "/" ? { within: rule.within } : {}) });
            apps.set(owner.profile_tree!, list);
            continue;
          }
          if (!rule.via && typeof rule.who === "object" && "profile" in rule.who && administered.has(rule.who.profile)) {
            covered.push(describe(rule, `${tree.id} administrator`));
            continue;
          }
          access.push(modern(rule));
        }
      } else {
        const rows = db.query("SELECT tree_id, subject_kind, subject, access FROM access WHERE tree_id = ?").all(tree.id) as AccessRow[];
        before = wholeTree(rows.map((row) => ({ who: row.subject_kind === "link" ? "link" : row.subject_kind === "profile" ? `profile:${row.subject}` : "everyone", allow: [row.access] })), expand);
        for (const row of rows) {
          const who: ResourceAccessRule["who"] = row.subject_kind === "everyone" ? "everyone" : row.subject_kind === "profile" ? { profile: row.subject } : { link: row.subject };
          if (row.subject_kind === "profile" && administered.has(row.subject)) { covered.push(`${tree.id} administrator who=profile:${row.subject} allow=${row.access}`); continue; }
          access.push({ who, allow: [row.access as "read" | "write"] });
        }
      }
      if (new Set(access.map(resourceRuleKey)).size !== access.length) refuse(`Tree ${tree.id}'s rules have duplicate keys once converted`);
      const after = wholeTree(access.filter((rule) => !rule.app && (rule.within ?? "/") === "/").map((rule) => ({ who: reportedWho(rule.who), allow: rule.allow })), expand);
      accessReport.push({ tree: tree.id, before, after });
      if (JSON.stringify(before) !== JSON.stringify(after)) refuse(`Tree ${tree.id}'s whole-tree access would change: before ${before.join("; ")}, after ${after.join("; ")}`);
      for (const rule of access.filter((candidate) => candidate.app)) lentAfter.push(describe(rule, `${tree.id} app=${rule.app} tree-rule`));
      // Mounts: nested boundaries, by path below the tree.
      const mounts: Record<string, string> = {};
      const member: Array<{ path: string; tree: string }> = [];
      for (const child of ordinary.filter((candidate) => candidate.parent_tree === tree.id && candidate.path)) {
        const relative = tree.path === "/" ? child.path!.slice(1) : child.path!.slice(tree.path!.length + 1);
        const handle = tree.id === community!.id ? /^~(.+)$/.exec(relative)?.[1] : undefined;
        if (handle && byProfile.get(child.id)?.handle === handle) member.push({ path: relative, tree: child.id });
        else mounts[relative] = child.id;
      }
      planned.set(tree.id, { kind: kindOf(tree.id), values: { access, mounts }, member });
    }
    // Every other rule an account's trees.yaml holds: a `via` rule lands in
    // its profile's apps.yaml; anything else would be dropped.
    for (const account of accounts) {
      const config = configurations.get(account.id)!;
      for (const [tree, declaration] of Object.entries(config.trees)) {
        if (ordinary.find((candidate) => candidate.id === tree)?.account_id === account.id) continue;
        for (const rule of declaration.access) {
          lentBefore.push(describe(rule, `${tree} via=${rule.via ?? "-"} account=${account.profile_tree}`));
          if (!rule.via) refuse(`Account ${account.id}'s rule on ${tree} (${describe(rule, "")}) has no via and would be dropped`);
          if (rule.who !== "me") {
            // Lending: the account's profile must be named directly for what it lends.
            const target = planned.get(tree);
            const named = target?.values.access.some((granted) => !granted.app && typeof granted.who === "object" && "profile" in granted.who
              && granted.who.profile === account.profile_tree && rule.allow.every((op) => granted.allow.includes("admin") || granted.allow.includes("write") || granted.allow.includes(op as never))
              && ((granted.within ?? "/") === "/" || (rule.within ?? "/").startsWith(granted.within ?? "/")));
            if (!named) refuse(`Account ${account.id} would lend access to ${tree} (${describe(rule, "")}) that no rule names its profile for directly`);
          }
          const list = apps.get(account.profile_tree!) ?? {};
          (list[rule.via] ??= []).push({ resource: tree, who: rule.who, allow: rule.allow as AppAccessRule["allow"], ...(rule.within && rule.within !== "/" ? { within: rule.within } : {}) });
          apps.set(account.profile_tree!, list);
        }
      }
    }
    for (const [profile, list] of apps) {
      if (!planned.has(profile)) refuse(`Profile ${profile} has app entries but is not an active tree here`);
      for (const [app, rules] of Object.entries(list)) for (const rule of rules) lentAfter.push(describe(rule, `${rule.resource} app=${app} apps.yaml=${profile}`));
    }
    const configurationsPlanned: MigrationReport["configurations"] = [];
    const accountsReport: MigrationReport["accounts"] = [];
    for (const [tree, plan] of planned) {
      if (plan.kind !== "tree") plan.values.apps = apps.get(tree) ?? {};
      if (plan.kind === "person") {
        const account = byProfile.get(tree)!;
        const devices = configurations.get(account.id)!.devices;
        plan.values.devices = Object.fromEntries(Object.entries(devices).map(([id, device]) => [id, { id, label: device.label, administrator: device.administrator === true }]));
        for (const id of Object.keys(devices)) {
          const row = db.query("SELECT revoked_at FROM devices WHERE id = ? AND account_id = ?").get(id, account.id) as { revoked_at: number | null } | null;
          if (!row || row.revoked_at !== null) refuse(`Device ${id} of ${account.id} has no active credential binding`);
        }
      }
      // The same validation canopyd runs on every configuration.
      readTreeConfigGraph(snapshotTreeConfig(plan.values), plan.kind, tree);
    }
    // The mounts must reproduce every boundary.
    const boundaries = new Map<string, string>([["/", community!.id]]);
    const queue = [{ tree: community!.id, path: "/" }];
    while (queue.length) {
      const { tree, path } = queue.shift()!;
      const plan = planned.get(tree)!;
      for (const [name, child] of [...Object.entries(plan.values.mounts), ...plan.member.map((mount) => [mount.path, mount.tree] as const)]) {
        const childPath = path === "/" ? `/${name}` : `${path}/${name}`;
        if ([...boundaries.values()].includes(child)) refuse(`Tree ${child} would be mounted twice`);
        boundaries.set(childPath, child);
        if (planned.has(child)) queue.push({ tree: child, path: childPath });
      }
    }
    for (const tree of ordinary.filter((candidate) => candidate.path)) {
      if (boundaries.get(tree.path!) !== tree.id) refuse(`The mounts would not reproduce the boundary ${tree.path} of ${tree.id}`);
    }
    if (boundaries.size !== ordinary.filter((candidate) => candidate.path).length) refuse("The mounts would add a boundary");
    ms.plan = Math.round(performance.now() - since);

    // Store every configuration's objects and log entry before the commit.
    since = performance.now();
    const store = new AcceptedUpdateStore(db);
    const history = new MergeHistory(store, objects);
    const prepared: Array<{ tree: string; id: string; kind: TreeConfigKind; values: TreeConfigValues; member: Array<{ path: string; tree: string }>; root: ObjectHash; entry: { hash: ObjectHash; conflicted: boolean }; changes: Awaited<ReturnType<typeof entryChanges>> }> = [];
    for (const [tree, plan] of planned) {
      const id = treeConfigurationID(tree);
      const snapshot = snapshotTreeConfig(plan.values);
      const entry = await history.write({ format: LOG_ENTRY_FORMAT, tree: id, previous: null, root: snapshot.root, change: `initial:${id}`, trace: null, resolves: [], decisions: [] },
        [...snapshot.objects].map(([hash, bytes]) => ({ hash, bytes })));
      const changes = await entryChanges(null, snapshot.root, (hash) => objects.load(hash, snapshot.objects));
      prepared.push({ tree, id, kind: plan.kind, values: plan.values, member: plan.member, root: snapshot.root, entry, changes });
      configurationsPlanned.push({
        tree, configuration: id, kind: plan.kind, root: snapshot.root,
        administrators: plan.values.access.filter((rule) => rule.allow.includes("admin")).map((rule) => reportedWho(rule.who)),
        rules: plan.values.access.filter((rule) => !rule.allow.includes("admin")).length,
        mounts: plan.values.mounts,
        apps: Object.keys(plan.values.apps ?? {}).length,
        devices: Object.keys(plan.values.devices ?? {}).length,
      });
    }
    ms.store = Math.round(performance.now() - since);

    since = performance.now();
    db.run("PRAGMA foreign_keys = OFF");
    db.transaction(() => {
      const now = Date.now();
      // Delete every account configuration tree and its history.
      for (const account of accounts) {
        const tree = account.config_tree!;
        for (const table of ["entry_metadata", "document_versions", "profile_facts"]) db.run(`DELETE FROM ${table} WHERE tree_id = ?`, [tree]);
        db.run("DELETE FROM accepted_updates WHERE tree_id = ?", [tree]);
        db.run("DELETE FROM trees WHERE id = ?", [tree]);
        accountsReport.push({ from: account.id, profile: account.profile_tree!, handle: account.handle, deletedConfiguration: tree });
      }
      // Accounts keyed by profile.
      db.run(`CREATE TABLE accounts_22 (id TEXT PRIMARY KEY, handle TEXT NOT NULL UNIQUE, enabled INTEGER NOT NULL DEFAULT 1, claim_digest TEXT)`);
      db.run(`INSERT INTO accounts_22 (id, handle, enabled, claim_digest) SELECT profile_tree, handle, enabled, claim_digest FROM accounts ORDER BY rowid`);
      for (const account of accounts) {
        db.run("UPDATE devices SET account_id = ? WHERE account_id = ?", [account.profile_tree, account.id]);
        db.run("UPDATE pairings SET account_id = ? WHERE account_id = ?", [account.profile_tree, account.id]);
      }
      db.run("DROP TABLE accounts");
      db.run("ALTER TABLE accounts_22 RENAME TO accounts");
      // A pending challenge names a configuration TreeID no claim can use now.
      db.run("DELETE FROM account_challenges WHERE consumed_at IS NULL");
      db.run("DROP TABLE resource_policy");
      db.run("DROP TABLE access");
      db.run("DROP TABLE tree_reservations");
      db.run("ALTER TABLE trees DROP COLUMN account_id");
      db.run("ALTER TABLE trees ADD COLUMN governs TEXT");
      createTreeConfigIndex(db);
      for (const item of prepared) {
        db.run("INSERT INTO trees (id, ref, policy, status, governs) VALUES (?, ?, 'tree-config-v1', 'active', ?)", [item.id, item.root, item.tree]);
        store.insert({ tree: item.id, root: item.root, previousRoot: null, acceptedAt: now, subject: "migration:022", entryChanges: item.changes, entry: item.entry });
        db.run("INSERT INTO tree_policy (tree_id, rules_json) VALUES (?, ?)", [item.tree, JSON.stringify(item.values.access)]);
        for (const rule of item.values.access) {
          if (rule.allow.includes("admin") && typeof rule.who === "object" && "profile" in rule.who) {
            db.run("INSERT INTO tree_admins (tree_id, profile_tree) VALUES (?, ?)", [item.tree, rule.who.profile]);
          }
        }
        for (const [app, rules] of Object.entries(item.values.apps ?? {})) {
          db.run("INSERT INTO app_policy (profile_tree, app_tree, rules_json) VALUES (?, ?, ?)", [item.tree, app, JSON.stringify(rules)]);
        }
        for (const [path, child] of Object.entries(item.values.mounts)) db.run("INSERT INTO mounts (parent_tree, path, tree_id, member) VALUES (?, ?, ?, 0)", [item.tree, path, child]);
        for (const mount of item.member) db.run("INSERT INTO mounts (parent_tree, path, tree_id, member) VALUES (?, ?, ?, 1)", [item.tree, mount.path, mount.tree]);
      }
      db.run("UPDATE meta SET value = '22' WHERE key = 'schema_version'");
      const violations = db.query("PRAGMA foreign_key_check").all();
      if (violations.length) throw new Error(`foreign_key_check: ${JSON.stringify(violations.slice(0, 5))}`);
    })();
    db.run("PRAGMA foreign_keys = ON");
    ms.commit = Math.round(performance.now() - since);
    assertCurrentHostSchema(db);
    assertHostData(db);
    ms.total = Math.round(performance.now() - started);
    return {
      migrated: true, from: stamp, trees: trees(), configurations: configurationsPlanned, accounts: accountsReport,
      access: accessReport, lent: { before: lentBefore.sort(), after: lentAfter.sort() }, covered, ms,
    };
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  const root = process.argv[2];
  if (!root) { console.error("usage: run.ts <data-root>"); process.exit(2); }
  const report = await migrateTreeConfigurations(resolve(root), (event) => console.error(JSON.stringify(event)));
  console.log(JSON.stringify(report));
}
