import { Database } from "bun:sqlite";
import { mkdir, writeFile } from "node:fs/promises";
import {
  encodeWireDirectory,
  decodeWireDirectory,
  hashObject,
  encodeUpdateRequestJSON,
} from "@arbor/wire";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import {
  AUTHORITY_SCHEMA,
  resourcePolicyFormatKey,
  assertCurrentCanopySchema,
} from "../../packages/canopy/src/schema.ts";
import { ObjectStore } from "@arbor/object-store";
import {
  readAccountConfigGraphV2,
  accountConfigSourcesV2,
} from "../../packages/merge/src/account-v2.ts";
import { resourceRuleFromLegacy } from "../../packages/stores/src/resource-configuration.ts";

/** Read-only preparation: exact converted snapshots, no live policy/index mutation. */
export async function inspectResourcePolicy(dataRoot: string) {
  const db = new Database(join(dataRoot, "canopy.sqlite3"), {
    readonly: true,
    strict: true,
  });
  try {
    const version = (
      db.query("SELECT value FROM meta WHERE key='schema_version'").get() as {
        value: string;
      }
    ).value;
    if (version !== "12" && version !== "13")
      throw new Error("Expected schema 12 or 13");
    const objects = new ObjectStore(join(dataRoot, "objects"));
    const rows = db
      .query(
        "SELECT id, ref, policy FROM trees WHERE policy LIKE 'account-config-%'"
      )
      .all() as Array<{ id: string; ref: string; policy: string }>;
    const configurations = [];
    for (const row of rows) {
      if (row.policy !== "account-config-v2")
        throw new Error(
          "Legacy v1 account requires its dedicated prior migration"
        );
      const snapshot = await objects.completeSnapshot(row.ref);
      const graph = readAccountConfigGraphV2(snapshot, row.id);
      const accepted = db
        .query(
          "SELECT id, root, conflicted FROM accepted_updates WHERE tree_id=? ORDER BY rowid DESC LIMIT 1"
        )
        .get(row.id) as { id: string; root: string; conflicted: number } | null;
      if (!accepted || accepted.root !== row.ref || accepted.conflicted)
        throw new Error(
          "Configuration needs consistent unambiguous accepted state"
        );
      const resources =
        graph.resources ??
        Object.fromEntries(
          Object.entries(graph.trees).map(([id, d]) => [
            id,
            {
              canonical: d.canonical,
              access: d.access.map(resourceRuleFromLegacy),
            },
          ])
        );
      const source = accountConfigSourcesV2({ ...graph, resources })[
        "trees.yaml"
      ];
      const bytes = new TextEncoder().encode(source),
        hash = hashObject(bytes);
      const rootDirectory = decodeWireDirectory(
        snapshot.objects.get(snapshot.root)!
      );
      const rootBytes = encodeWireDirectory({
        ...rootDirectory,
        entries: rootDirectory.entries.map((entry) =>
          entry.name === "trees.yaml" ? { name: entry.name, file: hash } : entry
        ),
      });
      const root = hashObject(rootBytes);
      const candidate = {
        root,
        objects: new Map([
          ...snapshot.objects,
          [hash, bytes],
          [root, rootBytes],
        ]),
      };
      const request = encodeUpdateRequestJSON({
        base: accepted.id,
        updates: [
          {
            change: `resource-policy-${row.ref.slice(7)}`,
            operations: null,
            resolves: [],
            ifCurrent: accepted.id,
            candidate: root,
            objects: [...candidate.objects].map(([hash, bytes]) => ({
              hash,
              bytes,
            })),
            deltas: [],
          },
        ],
      });
      configurations.push({
        tree: row.id,
        before: row.ref,
        after: root,
        candidate,
        request,
        beforeSource: graph.sources["trees.yaml"]!,
        afterSource: source,
      });
    }
    return { version, configurations };
  } finally {
    db.close();
  }
}

/** Schema-only offline step. Accepted config transitions follow through governed updates. */
export function migrateResourcePolicySchema(path: string, backup: string) {
  if (existsSync(backup)) throw new Error("Backup path already exists");
  const db = new Database(path, { readwrite: true, strict: true });
  try {
    const stamp = (
      db.query("SELECT value FROM meta WHERE key='schema_version'").get() as {
        value: string;
      }
    ).value;
    if (stamp === "13") {
      assertCurrentCanopySchema(db);
      return { migrated: false };
    }
    if (stamp !== "12") throw new Error("Expected schema 12");
    if (
      (db.query("PRAGMA quick_check").get() as { quick_check: string })
        .quick_check !== "ok" ||
      db.query("PRAGMA foreign_key_check").all().length
    )
      throw new Error("Invalid source database");
    for (const [table, expected] of Object.entries(AUTHORITY_SCHEMA)) {
      const columns = (
        db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
      ).map((r) => r.name);
      if (table === "resource_policy") {
        if (columns.length) throw new Error("Unexpected resource policy table");
        continue;
      }
      if (
        columns.length !== expected.length ||
        expected.some((c) => !columns.includes(c))
      )
        throw new Error(`Unexpected source schema: ${table}`);
    }
    db.run("VACUUM INTO ?", [backup]);
    const saved = new Database(backup, { readonly: true });
    try {
      if (
        (saved.query("PRAGMA quick_check").get() as { quick_check: string })
          .quick_check !== "ok"
      )
        throw new Error("Backup verification failed");
    } finally {
      saved.close();
    }
    db.transaction(() => {
      db.run(
        "CREATE TABLE resource_policy (account_id TEXT NOT NULL, tree_id TEXT NOT NULL, rules_json TEXT NOT NULL, PRIMARY KEY(account_id, tree_id))"
      );
      // Even an all-private configuration has crossed the format boundary.
      // Empty access lists alone cannot encode that durable fact in YAML.
      const accounts = db.query("SELECT accounts.id FROM accounts JOIN trees ON trees.id=accounts.config_tree WHERE trees.policy='account-config-v2'").all() as Array<{id: string}>;
      for (const account of accounts) db.run("INSERT OR REPLACE INTO meta(key,value) VALUES (?, '1')", [resourcePolicyFormatKey(account.id)]);
      db.run("UPDATE meta SET value='13' WHERE key='schema_version'");
      assertCurrentCanopySchema(db);
    }).immediate();
    return { migrated: true };
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  if (args[0] === "--inspect" && args.length === 2) {
    const result = await inspectResourcePolicy(resolve(args[1]!));
    console.log(
      JSON.stringify(
        {
          version: result.version,
          configurations: result.configurations.map(
            ({ tree, before, after }) => ({ tree, before, after })
          ),
        },
        null,
        2
      )
    );
  } else if (
    args[0] === "--prepare" &&
    args[2] === "--out" &&
    args.length === 4
  ) {
    const output = resolve(args[3]!);
    await mkdir(output, { mode: 0o700 });
    const result = await inspectResourcePolicy(resolve(args[1]!));
    for (const config of result.configurations) {
      await writeFile(
        join(output, `${config.tree}.before.yaml`),
        config.beforeSource,
        { mode: 0o600, flag: "wx" }
      );
      await writeFile(
        join(output, `${config.tree}.after.yaml`),
        config.afterSource,
        { mode: 0o600, flag: "wx" }
      );
      await writeFile(
        join(output, `${config.tree}.request.json`),
        JSON.stringify(config.request, null, 2) + "\n",
        { mode: 0o600, flag: "wx" }
      );
    }
    console.log(
      JSON.stringify({ prepared: result.configurations.length, output })
    );
  } else if (
    args[0] === "--offline-database" &&
    args[2] === "--backup" &&
    args.length === 4
  ) {
    console.log(
      JSON.stringify(
        migrateResourcePolicySchema(resolve(args[1]!), resolve(args[3]!))
      )
    );
  } else
    throw new Error(
      "Usage: --inspect <offline-data-root> OR --offline-database <db> --backup <new-backup-path>"
    );
}
