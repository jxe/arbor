import { mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";

const dataDirectory = join(import.meta.dir, "..", "sites", "supplies", "data");
const destination = join(dataDirectory, "_store.sqlite3");
const temporaryDirectory = await mkdtemp(join(tmpdir(), "arbor-supplies-fixture-"));
const temporaryDatabase = join(temporaryDirectory, "_store.sqlite3");
const database = new Database(temporaryDatabase, { create: true, strict: true });

try {
  database.exec("pragma foreign_keys = on");
  database.exec(await readFile(join(dataDirectory, "schema.sql"), "utf8"));
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

    const insertPractice = database.prepare("insert into practices values (?, ?, ?, ?, ?)");
    insertPractice.run(practices.mutualAid, "Mutual aid", "Neighbors share practical help and resources.", time, time);
    insertPractice.run(practices.listening, "Listening circles", "A turn-taking practice for careful group attention.", time, "2026-08-25T13:00:00.000Z");
    insertPractice.run(practices.walking, "Neighborhood walks", "Walk together and notice the place you share.", time, "2026-08-25T14:00:00.000Z");

    const insertList = database.prepare("insert into lists values (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    insertList.run(lists.care, profiles.ada, "Community care", "Practices for showing up for one another.", "public", "tagged", 1, time, "2026-08-25T15:00:00.000Z");
    insertList.run(lists.private, profiles.ada, "Quiet experiments", "A private working list.", "private", "standard", 0, time, "2026-08-25T16:00:00.000Z");
    insertList.run(lists.listening, profiles.bo, "Ways to listen", "Practices that make attention tangible.", "public", "standard", 0, time, "2026-08-25T17:00:00.000Z");

    const insertAuthor = database.prepare("insert into practice_authors values (?, ?)");
    insertAuthor.run(practices.mutualAid, profiles.ada);
    insertAuthor.run(practices.listening, profiles.bo);

    const insertItem = database.prepare("insert into list_practices values (?, ?, ?)");
    insertItem.run(lists.care, practices.mutualAid, 0);
    insertItem.run(lists.care, practices.listening, 1);
    insertItem.run(lists.private, practices.walking, 0);
    insertItem.run(lists.listening, practices.listening, 0);

    const insertReaction = database.prepare("insert into list_reactions values (?, ?, ?)");
    insertReaction.run(lists.care, profiles.bo, "👍");
    insertReaction.run(lists.care, profiles.cy, "❤️");
    insertReaction.run(lists.listening, profiles.ada, "👍");

    const insertTag = database.prepare("insert into list_tags values (?, ?, ?, ?)");
    insertTag.run(lists.care, "care", "Care", "#ef4444");
    insertTag.run(lists.care, "local", "Local", null);
    database.prepare("insert into practice_tags values (?, ?, ?)").run(lists.care, practices.mutualAid, "care");
    database.prepare("insert into list_contributors values (?, ?, ?, ?)").run(lists.care, profiles.bo, time, "2026-08-25T18:00:00.000Z");
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
