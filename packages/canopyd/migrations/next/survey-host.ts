import { Database } from "bun:sqlite";
import { join } from "node:path";

/**
 * The host half of the pre-cutover survey: counts, never content or digests,
 * read from the live database opened read-only. Run on the host,
 *
 *   railway ssh -- bun run packages/canopyd/migrations/next/survey-host.ts /data
 *
 * and give its JSON to `survey.ts --live <file>` on the Mac.
 */
export interface HostSurvey {
  version: 1;
  /** `meta.schema_version`, or null when the database has none. */
  schema: string | null;
  /** Devices neither revoked nor holding a public key: digest devices. The digest retirement refuses unless 0. */
  unrevokedDevicesWithoutPublicKey: number;
  /**
   * Group members authored as a bare string: `profile_facts` stores them as
   * `{ profile, legacy: true }` (or, from an older writer, as the string
   * itself). Scalar `/~handle` member removal needs 0.
   */
  bareStringGroupMembers: number;
  /** Rows of `profile_resets`, or null when the table is gone. Batch step 024 refuses unless 0. */
  profileResets: number | null;
}

function tableExists(db: Database, name: string): boolean {
  return db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== null;
}

function count(db: Database, sql: string): number {
  return (db.query(sql).get() as { n: number }).n;
}

export function surveyHost(dataRoot: string): HostSurvey {
  const db = new Database(join(dataRoot, "canopy.sqlite3"), { readonly: true });
  try {
    const schema = tableExists(db, "meta")
      ? (db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | null)?.value ?? null
      : null;
    return {
      version: 1,
      schema,
      unrevokedDevicesWithoutPublicKey: count(db, "SELECT COUNT(*) AS n FROM devices WHERE revoked_at IS NULL AND public_key IS NULL"),
      bareStringGroupMembers: count(db, `
        SELECT COUNT(*) AS n FROM profile_facts AS p, json_each(p.facts, '$.members') AS m
        WHERE m.type = 'text' OR (m.type = 'object' AND json_extract(m.value, '$.legacy') = 1)
      `),
      profileResets: tableExists(db, "profile_resets") ? count(db, "SELECT COUNT(*) AS n FROM profile_resets") : null,
    };
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  const dataRoot = process.argv[2];
  if (!dataRoot) throw new Error("usage: survey-host.ts <data-root>");
  console.log(JSON.stringify(surveyHost(dataRoot), null, 2));
}
