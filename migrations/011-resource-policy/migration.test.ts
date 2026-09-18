import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createCanopySchema,
  assertCurrentCanopySchema,
} from "../../packages/canopy/src/schema.ts";
import { migrateResourcePolicySchema } from "./run.ts";

test("offline schema migration backs up and preserves existing rows", async () => {
  const root = await mkdtemp(join(tmpdir(), "arbor-policy-migration-"));
  try {
    const path = join(root, "canopy.sqlite3"),
      backup = join(root, "backup.sqlite3");
    const db = new Database(path, { create: true });
    createCanopySchema(db);
    db.run("DROP TABLE resource_policy");
    db.run("UPDATE meta SET value='12' WHERE key='schema_version'");
    db.run("INSERT INTO meta VALUES ('evidence','exact')");
    db.run("INSERT INTO accounts(id,handle,config_tree,token_digest) VALUES ('account','owner','tr_config','digest')");
    db.run("INSERT INTO trees(id,ref,updated_at,policy,status,account_id) VALUES ('tr_config','root',0,'account-config-v2','active','account')");
    db.run("INSERT INTO devices(id,account_id,label,token_digest,created_at) VALUES ('device','account','Mac','device-digest',0)");
    db.run("INSERT INTO accepted_updates(id,tree_id,root,kind,accepted_at) VALUES ('accepted','tr_config','root','initial',0)");
    db.close();
    expect(migrateResourcePolicySchema(path, backup)).toEqual({
      migrated: true,
    });
    const saved = new Database(backup, { readonly: true });
    expect(
      saved.query("SELECT value FROM meta WHERE key='schema_version'").get()
    ).toEqual({ value: "12" });
    saved.close();
    const after = new Database(path, { readonly: true });
    assertCurrentCanopySchema(after);
    expect(
      after.query("SELECT value FROM meta WHERE key='evidence'").get()
    ).toEqual({ value: "exact" });
    expect(after.query("SELECT value FROM meta WHERE key='resource-policy-format:account'").get()).toEqual({ value: "1" });
    after.close();
    expect(
      migrateResourcePolicySchema(path, join(root, "unused.sqlite3"))
    ).toEqual({ migrated: false });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unexpected schema fails before changing version", async () => {
  const root = await mkdtemp(join(tmpdir(), "arbor-policy-invalid-"));
  try {
    const path = join(root, "canopy.sqlite3");
    const db = new Database(path, { create: true });
    createCanopySchema(db);
    db.run("DROP TABLE resource_policy");
    db.run("UPDATE meta SET value='12' WHERE key='schema_version'");
    db.run("ALTER TABLE access ADD COLUMN unexpected TEXT");
    db.close();
    expect(() =>
      migrateResourcePolicySchema(path, join(root, "backup.sqlite3"))
    ).toThrow("Unexpected source schema");
    const after = new Database(path, { readonly: true });
    expect(
      after.query("SELECT value FROM meta WHERE key='schema_version'").get()
    ).toEqual({ value: "12" });
    after.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("configuration preparation preserves exact account/device objects and binds an accepted guard", async () => {
  const root = await mkdtemp(join(tmpdir(), "arbor-policy-prepare-"));
  try {
    const { ObjectStore } = await import("@arbor/object-store");
    const { snapshotAccountConfigV2 } = await import(
      "../../packages/merge/src/account-v2.ts"
    );
    const { decodeWireDirectory } = await import("@arbor/wire");
    const { inspectResourcePolicy } = await import("./run.ts");
    const tree = "tr_aaaaaaaaaaaaaaaaaaaaaaaaaa",
      config = "tr_bbbbbbbbbbbbbbbbbbbbbbbbbb",
      device = "dv_aaaaaaaaaaaaaaaaaaaaaaaaaa";
    const snapshot = snapshotAccountConfigV2({
      account: { canopy: "https://example.org", profile: tree },
      trees: {
        [tree]: {
          canonical: "https://example.org/~owner",
          access: [{ subject: { kind: "everyone" }, access: "read" }],
        },
      },
      devices: { [device]: { id: device, label: "Mac", administrator: true } },
    });
    const objects = new ObjectStore(join(root, "objects"));
    await objects.store(
      [...snapshot.objects].map(([hash, bytes]) => ({ hash, bytes }))
    );
    const db = new Database(join(root, "canopy.sqlite3"), { create: true });
    db.run("CREATE TABLE meta(key TEXT, value TEXT)");
    db.run("INSERT INTO meta VALUES ('schema_version','12')");
    db.run("CREATE TABLE trees(id TEXT, ref TEXT, policy TEXT)");
    db.run("INSERT INTO trees VALUES (?,?,'account-config-v2')", [
      config,
      snapshot.root,
    ]);
    db.run(
      "CREATE TABLE accepted_updates(id TEXT, tree_id TEXT, root TEXT, conflicted INTEGER)"
    );
    db.run("INSERT INTO accepted_updates VALUES ('accepted',?,?,0)", [
      config,
      snapshot.root,
    ]);
    db.close();
    const prepared = (await inspectResourcePolicy(root)).configurations[0]!;
    const before = decodeWireDirectory(snapshot.objects.get(snapshot.root)!);
    const after = decodeWireDirectory(
      prepared.candidate.objects.get(prepared.after)!
    );
    for (const name of ["account.yaml", "devices.yaml"])
      expect(after.entries.find((e) => e.name === name)).toEqual(
        before.entries.find((e) => e.name === name)
      );
    expect(prepared.afterSource).toContain("who: everyone");
    expect(prepared.request.updates[0]!.ifCurrent).toBe("accepted");
    expect(
      (await inspectResourcePolicy(root)).configurations[0]!.request
    ).toEqual(prepared.request);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
