/** Writes only to an explicitly prepared restored copy; never opens a listener. */
import { Database } from "bun:sqlite";
import { resolve, join } from "node:path";
import { CanopyDaemon } from "../../packages/canopy/src/canopy.ts";
import {
  decodeWireDirectory,
  encodeWireDirectory,
  hashObject,
  type CandidateUpdate,
} from "@arbor/wire";
const root = resolve(Bun.argv[2] ?? "");
if (!Bun.argv[2] || !(await Bun.file(join(root, "before-rows.json")).exists()))
  throw new Error(
    "Provide a restored rehearsal root with its before-rows.json audit; live roots are forbidden"
  );
const db = new Database(join(root, "canopy.sqlite3"), { readonly: true });
const accountIDs = db
  .query("SELECT id FROM accounts WHERE enabled=1")
  .all() as Array<{ id: string }>;
const trees = db
  .query("SELECT id FROM trees WHERE policy='ordinary' AND status='active'")
  .all() as Array<{ id: string }>;
const oldRows = db.query("SELECT * FROM accepted_updates ORDER BY id").all();
db.close();
let canopy = await CanopyDaemon.open(root);
try {
  const account = accountIDs
    .map((a) => canopy.account(a.id))
    .find((a) => a && trees.some((t) => canopy.canWrite(a, t.id)))!;
  const tree = trees.find((t) => canopy.canWrite(account, t.id))!.id;
  const original = canopy.currentUpdate(tree)!;
  const bytes = Buffer.from("rehearsal base\n"),
    file = hashObject(bytes);
  const directory = decodeWireDirectory(await canopy.object(original.root));
  const name = `merge-rehearsal-${crypto.randomUUID()}.md`;
  directory.entries.push({ name, file });
  directory.entries.sort((a, b) =>
    Buffer.compare(Buffer.from(a.name), Buffer.from(b.name))
  );
  const encoded = encodeWireDirectory(directory),
    candidate = hashObject(encoded);
  const submit = async (base: string, update: CandidateUpdate) => {
    const response = await canopy.submitUpdate(
      tree,
      { base, updates: [update] },
      account
    );
    if ("error" in response.result) throw new Error(response.result.message);
    return response.result.results[0]!.update;
  };
  const seeded = await submit(original.id, {
    change: crypto.randomUUID(),
    candidate,
    trace: null,
    resolves: [],
    objects: [
      { hash: file, bytes },
      { hash: candidate, bytes: encoded },
    ],
    deltas: [],
  });
  const edit = (text: string): CandidateUpdate => {
    const bytes = Buffer.from(text),
      hash = hashObject(bytes),
      value = {
        ...directory,
        entries: directory.entries.map((e) =>
          e.name === name ? { name, file: hash } : e
        ),
      };
    const encoded = encodeWireDirectory(value),
      candidate = hashObject(encoded);
    return {
      change: crypto.randomUUID(),
      candidate,
      trace: [
      {
        before: seeded.root,
        after: candidate,
        operations: [
        {
          key: "edit",
          kind: "editSource",
          source: {
            material: { kind: "basis", path: `/${name}`, object: file },
          },
          text,
        },
        ],
      },
      ],
      resolves: [],
      objects: [
        { hash, bytes },
        { hash: candidate, bytes: encoded },
      ],
      deltas: [],
    };
  };
  await submit(seeded.id, edit("left\n"));
  const right = edit("right\n");
  const conflict = await submit(seeded.id, right);
  if (!conflict.conflicted) throw new Error("Expected accepted ambiguity");
  await canopy[Symbol.asyncDispose]();
  canopy = await CanopyDaemon.open(root);
  if ((await submit(seeded.id, right)).id !== conflict.id)
    throw new Error("Receipt changed after restart");
  const recordDB = new Database(join(root, "canopy.sqlite3"), {
    readonly: true,
  });
  const record = JSON.parse(
    (
      recordDB
        .query(
          "SELECT record_json FROM accepted_merge_states WHERE accepted_id=?"
        )
        .get(conflict.id) as { record_json: string }
    ).record_json
  );
  recordDB.close();
  const resolved = await submit(conflict.id, {
    change: crypto.randomUUID(),
    candidate: conflict.root,
    trace: [],
    resolves: record.decisions.map((d: any) => ({
      state: conflict.id,
      conflict: d.inspection.id,
      alternatives: d.inspection.alternatives.map((a: any) => a.id),
    })),
    objects: [],
    deltas: [],
  });
  if (resolved.conflicted) throw new Error("Resolution remained conflicted");
  await submit(resolved.id, {
    change: crypto.randomUUID(),
    candidate: original.root,
    trace: null,
    resolves: [],
    objects: [],
    deltas: [],
  });
  if (canopy.currentUpdate(tree)!.root !== original.root)
    throw new Error("Cleanup root changed");
  await canopy.verifyIntegrity();
  const after = new Database(join(root, "canopy.sqlite3"), { readonly: true });
  for (const row of oldRows as Array<Record<string, unknown>>)
    if (
      JSON.stringify(
        after
          .query("SELECT * FROM accepted_updates WHERE id=?")
          .get(row.id as string)
      ) !== JSON.stringify(row)
    )
      throw new Error("Historical accepted row changed");
  const count = (
    after.query("SELECT count(*) AS n FROM accepted_updates").get() as {
      n: number;
    }
  ).n;
  after.close();
  console.log(
    JSON.stringify({
      historicalAcceptedRows: oldRows.length,
      acceptedRows: count,
      sourceConflict: true,
      restartReplay: true,
      guardedResolution: true,
      cleanupRootUnchanged: true,
      integrity: "passed",
    })
  );
} finally {
  await canopy[Symbol.asyncDispose]();
}
