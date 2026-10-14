import { mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { compileUsl, formatDiagnostic, layoutOf, setupSql } from "../../../packages/usl/src/index.ts";

const dataDirectory = join(import.meta.dir, "..", "data");
const destination = join(dataDirectory, "_store.sqlite3");
const schema = compileUsl(await readFile(join(dataDirectory, "schema.usl"), "utf8"));
if (schema.diagnostics.length > 0) throw new Error(formatDiagnostic("schema.usl", schema.diagnostics[0]!));
const temporaryDirectory = await mkdtemp(join(tmpdir(), "story-supplies-fixture-"));
const temporaryDatabase = join(temporaryDirectory, "_store.sqlite3");
const database = new Database(temporaryDatabase, { create: true, strict: true });

try {
  database.exec("pragma foreign_keys = on");
  database.exec(setupSql(layoutOf(schema, { store: "database" }), "sqlite"));
  const insert = database.transaction(() => {
    const profiles = {
      ada: "tr_aaaaaaaaaaaaaaaaaaaaaaaaaa",
      bo: "tr_bbbbbbbbbbbbbbbbbbbbbbbbbb",
      cy: "tr_cccccccccccccccccccccccccc",
    } as const;
    const practices = {
      mutualAid: "00000000-0000-4000-8000-000000000001",
      listening: "00000000-0000-4000-8000-000000000002",
      walking: "00000000-0000-4000-8000-000000000003",
    } as const;
    const lists = {
      care: "10000000-0000-4000-8000-000000000001",
      private: "10000000-0000-4000-8000-000000000002",
      listening: "10000000-0000-4000-8000-000000000003",
    } as const;
    const time = "2026-08-25T12:00:00.000Z";

    // Every row's created/modified is written so the fixture is reproducible.
    const insertPractice = database.prepare("insert into Practice (id, name, about, created, modified) values (?, ?, ?, ?, ?)");
    insertPractice.run(practices.mutualAid, "Mutual aid", "Neighbors share practical help and resources.", time, time);
    insertPractice.run(practices.listening, "Listening circles", "A turn-taking practice for careful group attention.", time, "2026-08-25T13:00:00.000Z");
    insertPractice.run(practices.walking, "Neighborhood walks", "Walk together and notice the place you share.", time, "2026-08-25T14:00:00.000Z");

    const insertList = database.prepare(
      "insert into List (id, owner, name, about, visibility, kind, openToEdits, created, modified) values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    insertList.run(lists.care, profiles.ada, "Community care", "Practices for showing up for one another.", "Public", "Tagged", 1, time, "2026-08-25T15:00:00.000Z");
    insertList.run(lists.private, profiles.ada, "Quiet experiments", "A private working list.", "Private", "Standard", 0, time, "2026-08-25T16:00:00.000Z");
    insertList.run(lists.listening, profiles.bo, "Ways to listen", "Practices that make attention tangible.", "Public", "Standard", 0, time, "2026-08-25T17:00:00.000Z");

    const insertAuthor = database.prepare("insert into Practice_authors (practice, person, created, modified) values (?, ?, ?, ?)");
    insertAuthor.run(practices.mutualAid, profiles.ada, time, time);
    insertAuthor.run(practices.listening, profiles.bo, time, time);

    const insertItem = database.prepare("insert into Item (list, practice, items_position, created, modified) values (?, ?, ?, ?, ?)");
    insertItem.run(lists.care, practices.mutualAid, 0, time, time);
    insertItem.run(lists.care, practices.listening, 1, time, time);
    insertItem.run(lists.private, practices.walking, 0, time, time);
    insertItem.run(lists.listening, practices.listening, 0, time, time);

    const insertReaction = database.prepare("insert into Reaction (list, person, emoji, created, modified) values (?, ?, ?, ?, ?)");
    insertReaction.run(lists.care, profiles.bo, "👍", time, time);
    insertReaction.run(lists.care, profiles.cy, "❤️", time, time);
    insertReaction.run(lists.listening, profiles.ada, "👍", time, time);

    const insertTag = database.prepare("insert into Tag (list, id, name, color, created, modified) values (?, ?, ?, ?, ?, ?)");
    insertTag.run(lists.care, "care", "Care", "#ef4444", time, time);
    insertTag.run(lists.care, "local", "Local", null, time, time);
    database.prepare("insert into Tag_practices (tag_list, tag_id, practice, created, modified) values (?, ?, ?, ?, ?)")
      .run(lists.care, "care", practices.mutualAid, time, time);
    database.prepare("insert into Contribution (list, person, first, last, created, modified) values (?, ?, ?, ?, ?, ?)")
      .run(lists.care, profiles.bo, "2026-08-25", "2026-08-25", time, "2026-08-25T18:00:00.000Z");
  });
  insert();
  const integrity = database.query("pragma integrity_check").get() as { integrity_check: string };
  const foreignKeys = database.query("pragma foreign_key_check").all();
  if (integrity.integrity_check !== "ok" || foreignKeys.length !== 0) throw new Error("Generated Supplies fixture failed SQLite integrity checks");
} finally {
  database.close();
}

await rename(temporaryDatabase, destination);
await rm(temporaryDirectory, { recursive: true, force: true });
console.log(`Seeded ${destination}`);
