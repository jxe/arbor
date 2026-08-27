import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CollectionStore, type ConnectionStore } from "@arbor/stores";

const dsn = process.env.ARBOR_TEST_POSTGRES_DSN;

test("Postgres collections stay live without exposing credentials", async () => {
  if (!dsn) return;
  const directory = await mkdtemp(join(tmpdir(), "arbor-postgres-collection-"));
  const sql = new Bun.SQL(dsn);
  const schema = `arbor_test_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  try {
    await sql.unsafe(`create schema "${schema}"`);
    await sql.unsafe(`create table "${schema}".items (id integer primary key, title text not null, published boolean)`);
    await sql.unsafe(`insert into "${schema}".items values (1, 'First', true), (2, 'Second', null)`);
    await writeFile(join(directory, "_store.postgres"), [
      "driver: postgres",
      "connection: system:connections/disposable",
      `schema: ${schema}`,
      "",
    ].join("\n"));

    const connections = {
      get: async () => ({
        record: { name: "disposable", driver: "postgres", host: "127.0.0.1", database: "postgres", credential: "private" },
        dsn,
      }),
    } as unknown as ConnectionStore;
    const collections = new CollectionStore(undefined, connections);
    const summary = await collections.summary(directory);
    const page = await collections.children(
      directory,
      "/database/items",
      { tree: "tr_test", path: "/database/items", stableKey: null },
      { tree: "tr_test", observedThrough: "test:0", writable: false },
      null,
      1,
      "items",
    );
    const catalog = await collections.postgresSchema(directory);

    expect(summary?.tables).toEqual(["items"]);
    expect(page.items[0]?.properties.title).toBe("First");
    expect(page.nextCursor).toBe("1");
    expect(catalog.items).toEqual({ id: "number", title: "string", published: "boolean | null" });
    const publicPayload = JSON.stringify({ summary, page, catalog });
    expect(publicPayload).not.toContain(dsn);
    const password = new URL(dsn).password;
    if (password) expect(publicPayload).not.toContain(password);
  } finally {
    try { await sql.unsafe(`drop schema if exists "${schema}" cascade`); } catch {}
    await sql.close();
    await rm(directory, { recursive: true, force: true });
  }
});
