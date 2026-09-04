// Migration 004: add the single-use profile-identity challenge ledger.
//
//   bun run migrations/004-profile-identity-challenges/run.ts canopy-root <data-root>
//
// The runner is offline, explicit, idempotent, and does not rewrite authored
// trees or account identity. Existing random profile IDs remain readable, but
// every new account must use the schema-6 self-certifying claim protocol.
import { Database } from "bun:sqlite";
import { realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isGeneratedArborID, isPersonProfileTreeID, personProfileTreeID, type AccessRule } from "@arbor/core";
import { decodeWireObject, encodeWireObject, hashObject, type ObjectHash, type TreeSnapshot } from "@arbor/wire";
import { readAccountConfigGraphV2, snapshotAccountConfigV2 } from "../../packages/canopy/src/account-policy-v2.ts";
import { ObjectStore } from "../../packages/canopy/src/objects.ts";
import { rootProfileFacts } from "../../packages/canopy/src/profile.ts";
import { AcceptedUpdateStore } from "../../packages/canopy/src/updates/store.ts";
import { AUTHORITY_SCHEMA, CANOPY_SCHEMA_VERSION, assertCurrentCanopySchema } from "../../packages/canopy/src/schema.ts";

const FROM_STAMP = "5";
const TARGET_STAMP = "6";

export interface ProfileIdentityChallengeMigrationReport {
  mode: "canopy-root";
  fromSchema: string;
  toSchema: string;
  alreadyMigrated: boolean;
  accounts: number;
  trees: number;
  profileReplacement?: {
    previous: string;
    profileTree: string;
    account: string;
    communityRoot: ObjectHash;
    configurationTree: string;
    configurationRoot: ObjectHash;
  };
}

interface ProfileReplacement {
  previous: string;
  profileTree: string;
  publicKey: string;
}

function count(db: Database, table: string): number {
  return (db.query(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
}

function assertSchemaFive(db: Database): void {
  const expected = Object.fromEntries(Object.entries(AUTHORITY_SCHEMA).filter(([table]) => table !== "account_challenges"));
  const issues: string[] = [];
  for (const [table, columns] of Object.entries(expected)) {
    const actual = (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(({ name }) => name);
    if (actual.length !== columns.length || columns.some((name) => !actual.includes(name))) issues.push(table);
  }
  if (db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'account_challenges'").get()) {
    issues.push("unexpected account_challenges table");
  }
  if (db.query("PRAGMA foreign_key_check").all().length) issues.push("foreign-key violations");
  if (issues.length) throw new Error(`Canopy schema 5 is not exact: ${issues.join(", ")}`);
}

function decodePublicKey(value: string): Uint8Array {
  const decoded = Buffer.from(value, "base64url");
  if (decoded.byteLength !== 32 || decoded.toString("base64url") !== value) {
    throw new Error("Profile public key must be canonical base64url for 32 raw Ed25519 bytes");
  }
  return decoded;
}

function validateReplacement(value: ProfileReplacement): ProfileReplacement {
  if (!isGeneratedArborID(value.previous, "tr")) throw new Error("Previous profile must be an ordinary 128-bit TreeID");
  if (!isPersonProfileTreeID(value.profileTree)) throw new Error("Replacement profile must be a self-certifying person Profile TreeID");
  if (personProfileTreeID(decodePublicKey(value.publicKey)) !== value.profileTree) {
    throw new Error("Replacement Profile TreeID does not derive from the supplied public key");
  }
  return value;
}

async function rewriteCommunityRoot(
  objects: ObjectStore,
  root: ObjectHash,
  previous: string,
  profileTree: string,
): Promise<TreeSnapshot> {
  const snapshot = await objects.completeSnapshot(root);
  const directory = decodeWireObject(snapshot.objects.get(root)!);
  if (directory.type !== "directory") throw new Error("Community tree root must be a directory");
  const index = directory.entries.find((entry) => entry.name === "_index.md");
  if (!index?.hash) throw new Error("Community tree requires _index.md");
  const file = decodeWireObject(snapshot.objects.get(index.hash)!);
  if (file.type !== "file") throw new Error("Community _index.md must be a file");
  const source = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
  if (!source.includes(previous)) throw new Error("Community membership does not contain the previous profile TreeID");
  const nextSource = source.replaceAll(previous, profileTree);
  if (nextSource.includes(previous)) throw new Error("Community profile replacement was incomplete");
  const fileBytes = encodeWireObject({ type: "file", bytes: new TextEncoder().encode(nextSource) });
  const fileHash = hashObject(fileBytes);
  const rootBytes = encodeWireObject({
    ...directory,
    entries: directory.entries.map((entry) => entry.name === "_index.md" ? { name: entry.name, hash: fileHash } : entry),
  });
  const nextRoot = hashObject(rootBytes);
  const generated = new Map<ObjectHash, Uint8Array>([[fileHash, fileBytes], [nextRoot, rootBytes]]);
  const facts = await rootProfileFacts(nextRoot, (hash) => Promise.resolve(generated.get(hash) ?? snapshot.objects.get(hash)!));
  if (facts.type !== "group" || !facts.members.some((member) => member.profile === `arbor://${profileTree}/` && member.handle)) {
    throw new Error("Rewritten community root does not reserve the replacement profile identity");
  }
  return { root: nextRoot, objects: generated };
}

function replaceProfileRule(rule: AccessRule, previous: string, profileTree: string): AccessRule {
  return rule.subject.kind === "profile" && rule.subject.tree === previous
    ? { ...rule, subject: { kind: "profile", tree: profileTree } }
    : rule;
}

async function prepareProfileReplacement(
  db: Database,
  objects: ObjectStore,
  replacementInput: ProfileReplacement,
) {
  const replacement = validateReplacement(replacementInput);
  const account = db.query(`
    SELECT id, handle, profile_tree, config_tree
    FROM accounts WHERE profile_tree = ? AND enabled = 1
  `).get(replacement.previous) as { id: string; handle: string; profile_tree: string; config_tree: string } | null;
  if (!account) {
    const migrated = db.query("SELECT id, handle, profile_tree, config_tree FROM accounts WHERE profile_tree = ? AND enabled = 1")
      .get(replacement.profileTree) as { id: string; handle: string; profile_tree: string; config_tree: string } | null;
    if (!migrated) throw new Error("No enabled account uses the previous or replacement profile TreeID");
    return { alreadyMigrated: true as const, replacement, account: migrated };
  }
  if (db.query("SELECT 1 FROM accounts WHERE profile_tree = ?").get(replacement.profileTree)) {
    throw new Error("Another account already uses the replacement profile TreeID");
  }
  if (db.query("SELECT 1 FROM trees WHERE id IN (?, ?)").get(replacement.previous, replacement.profileTree)) {
    throw new Error("Migration 004 only rekeys an unhosted profile; place it after the account migration");
  }
  const community = db.query("SELECT t.id, t.ref FROM boundaries b JOIN trees t ON t.id = b.tree_id WHERE b.path = '/'")
    .get() as { id: string; ref: ObjectHash } | null;
  const configuration = db.query("SELECT id, ref, policy FROM trees WHERE id = ? AND account_id = ?")
    .get(account.config_tree, account.id) as { id: string; ref: ObjectHash; policy: string } | null;
  if (!community || !configuration || configuration.policy !== "account-config-v2") {
    throw new Error("Account or community authority is incomplete");
  }
  const communitySnapshot = await rewriteCommunityRoot(objects, community.ref, replacement.previous, replacement.profileTree);
  const currentConfiguration = await objects.completeSnapshot(configuration.ref);
  const graph = readAccountConfigGraphV2(currentConfiguration, configuration.id);
  if (graph.account.profile !== replacement.previous) throw new Error("Account configuration does not name the previous profile TreeID");
  const configurationSnapshot = snapshotAccountConfigV2({
    account: { ...graph.account, profile: replacement.profileTree },
    trees: Object.fromEntries(Object.entries(graph.trees).map(([id, declaration]) => [id, {
      ...declaration,
      access: declaration.access.map((rule) => replaceProfileRule(rule, replacement.previous, replacement.profileTree)),
    }])),
    devices: graph.devices,
  });
  return {
    alreadyMigrated: false as const,
    replacement,
    account,
    community: { ...community, snapshot: communitySnapshot },
    configuration: { ...configuration, snapshot: configurationSnapshot },
  };
}

export async function migrateCanopyRoot(
  input: string,
  profileReplacement?: ProfileReplacement,
): Promise<ProfileIdentityChallengeMigrationReport> {
  if (CANOPY_SCHEMA_VERSION !== TARGET_STAMP) {
    throw new Error(`Migration target ${TARGET_STAMP} does not match this build's schema ${CANOPY_SCHEMA_VERSION}`);
  }
  const dataRoot = await realpath(resolve(input));
  const db = new Database(join(dataRoot, "canopy.sqlite3"));
  try {
    const stamp = (db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | null)?.value ?? null;
    if (stamp === TARGET_STAMP) {
      assertCurrentCanopySchema(db);
      let replacementReport: ProfileIdentityChallengeMigrationReport["profileReplacement"];
      if (profileReplacement) {
        const prepared = await prepareProfileReplacement(db, new ObjectStore(join(dataRoot, "objects")), profileReplacement);
        if (!prepared.alreadyMigrated) throw new Error("Schema 6 still uses the previous profile TreeID; restore the pre-migration archive and rerun migration 004 atomically");
        const roots = db.query("SELECT id, ref FROM trees WHERE id IN ((SELECT tree_id FROM boundaries WHERE path = '/'), ?)")
          .all(prepared.account.config_tree) as Array<{ id: string; ref: ObjectHash }>;
        replacementReport = {
          previous: prepared.replacement.previous,
          profileTree: prepared.replacement.profileTree,
          account: prepared.account.handle,
          communityRoot: roots.find((row) => row.id !== prepared.account.config_tree)!.ref,
          configurationTree: prepared.account.config_tree,
          configurationRoot: roots.find((row) => row.id === prepared.account.config_tree)!.ref,
        };
      }
      return {
        mode: "canopy-root",
        fromSchema: TARGET_STAMP,
        toSchema: TARGET_STAMP,
        alreadyMigrated: true,
        accounts: count(db, "accounts"),
        trees: count(db, "trees"),
        ...(replacementReport ? { profileReplacement: replacementReport } : {}),
      };
    }
    if (stamp !== FROM_STAMP) {
      throw new Error(`Canopy data root is at schema version ${stamp ?? "1 (unstamped)"}; migration 004 requires ${FROM_STAMP}`);
    }
    assertSchemaFive(db);
    const objects = new ObjectStore(join(dataRoot, "objects"));
    const prepared = profileReplacement ? await prepareProfileReplacement(db, objects, profileReplacement) : undefined;
    if (prepared?.alreadyMigrated) throw new Error("Schema 5 cannot already contain the replacement profile identity");
    if (prepared) {
      await objects.store([
        ...[...prepared.community.snapshot.objects].map(([hash, bytes]) => ({ hash, bytes })),
        ...[...prepared.configuration.snapshot.objects].map(([hash, bytes]) => ({ hash, bytes })),
      ]);
    }
    const now = Date.now();
    db.transaction(() => {
      db.run(`
        CREATE TABLE account_challenges (
          id TEXT PRIMARY KEY,
          challenge_json TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          consumed_at INTEGER,
          claim_digest TEXT
        )
      `);
      if (prepared && !prepared.alreadyMigrated) {
        const updates = new AcceptedUpdateStore(db);
        const replaceRoot = (tree: string, previousRoot: ObjectHash, root: ObjectHash) => {
          const changed = db.run("UPDATE trees SET ref = ?, updated_at = ? WHERE id = ? AND ref = ?", [root, now, tree, previousRoot]);
          if (changed.changes !== 1) throw new Error(`Tree ${tree} changed during profile migration`);
          db.run("DELETE FROM observations WHERE tree_id = ?", [tree]);
          db.run("DELETE FROM accepted_updates WHERE tree_id = ?", [tree]);
          db.run("DELETE FROM reflog WHERE tree_id = ?", [tree]);
          updates.insert({ tree, root, previousRoot: null, kind: "restored", acceptedAt: now, subject: "migration:profile-identity" });
          db.run("INSERT INTO reflog (tree_id, ref, previous_ref, changed_at) VALUES (?, ?, NULL, ?)", [tree, root, now]);
        };
        replaceRoot(prepared.community.id, prepared.community.ref, prepared.community.snapshot.root);
        replaceRoot(prepared.configuration.id, prepared.configuration.ref, prepared.configuration.snapshot.root);
        const account = db.run(
          "UPDATE accounts SET profile_tree = ?, claim_digest = NULL WHERE id = ? AND profile_tree = ?",
          [prepared.replacement.profileTree, prepared.account.id, prepared.replacement.previous],
        );
        if (account.changes !== 1) throw new Error("Account profile changed during migration");
        db.run("UPDATE access SET subject = ? WHERE subject_kind = 'profile' AND subject = ?", [
          prepared.replacement.profileTree, prepared.replacement.previous,
        ]);
        db.run("UPDATE access SET claimed_profile = ? WHERE claimed_profile = ?", [
          prepared.replacement.profileTree, prepared.replacement.previous,
        ]);
      }
      db.run("UPDATE meta SET value = ? WHERE key = 'schema_version'", [TARGET_STAMP]);
    })();
    assertCurrentCanopySchema(db);
    return {
      mode: "canopy-root",
      fromSchema: FROM_STAMP,
      toSchema: TARGET_STAMP,
      alreadyMigrated: false,
      accounts: count(db, "accounts"),
      trees: count(db, "trees"),
      ...(prepared && !prepared.alreadyMigrated ? { profileReplacement: {
        previous: prepared.replacement.previous,
        profileTree: prepared.replacement.profileTree,
        account: prepared.account.handle,
        communityRoot: prepared.community.snapshot.root,
        configurationTree: prepared.configuration.id,
        configurationRoot: prepared.configuration.snapshot.root,
      } } : {}),
    };
  } finally {
    db.close();
  }
}

async function main(): Promise<void> {
  const [mode, root, ...extra] = process.argv.slice(2);
  if (mode !== "canopy-root" || !root || (extra.length !== 0 && extra.length !== 5)) {
    throw new Error("Usage: bun run migrations/004-profile-identity-challenges/run.ts canopy-root <data-root> [--replace-profile <old> <new> --public-key <base64url>]");
  }
  let replacement: ProfileReplacement | undefined;
  if (extra.length) {
    if (extra[0] !== "--replace-profile" || extra[3] !== "--public-key" || extra[2] === undefined || extra[4] === undefined) {
      throw new Error("Usage: bun run migrations/004-profile-identity-challenges/run.ts canopy-root <data-root> [--replace-profile <old> <new> --public-key <base64url>]");
    }
    replacement = { previous: extra[1]!, profileTree: extra[2], publicKey: extra[4] };
  }
  console.log(JSON.stringify(await migrateCanopyRoot(root, replacement), null, 2));
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
