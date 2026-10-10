// Lists Story Keychain records that the ordinary installation does not name:
// identity and account slots left behind by test runs and temporary data
// homes. Read-only: it reads record attributes (never secret values) through
// `security dump-keychain`, and with --print-delete-commands prints the
// `security delete-generic-password` lines for a person to review and run.
//
//   bun tools/list-stray-keychain-records.ts [--print-delete-commands]
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const SERVICES = ["org.arbor.person-profile", "org.arbor.community-account"];

if (process.platform !== "darwin") throw new Error("This lists the macOS login Keychain");

/** The `service/name` references the real ~/.story installation holds. */
async function referenced(): Promise<Set<string>> {
  const state = join(homedir(), ".story", ".state");
  const references = new Set<string>();
  const add = async (path: string) => {
    try {
      const credential = (JSON.parse(await readFile(path, "utf8")) as { credential?: unknown }).credential;
      if (typeof credential === "string") references.add(credential);
    } catch {}
  };
  await add(join(state, "self.json"));
  const accounts = await readdir(join(state, "accounts")).catch(() => [] as string[]);
  for (const name of accounts) await add(join(state, "accounts", name, "connection.json"));
  return references;
}

interface KeychainRecord { service: string; account: string; created: string }

function records(): KeychainRecord[] {
  const dump = Bun.spawnSync(["/usr/bin/security", "dump-keychain"], { stdout: "pipe", stderr: "pipe", maxBuffer: 256 * 1024 * 1024 } as never);
  if (dump.exitCode !== 0) throw new Error(`security dump-keychain failed: ${dump.stderr.toString().trim()}`);
  const found: KeychainRecord[] = [];
  for (const entry of dump.stdout.toString().split(/^keychain: /m)) {
    if (!/^class: "genp"$/m.test(entry)) continue;
    const service = entry.match(/"svce"<blob>="([^"]*)"/)?.[1];
    const account = entry.match(/"acct"<blob>="([^"]*)"/)?.[1];
    if (!service || account === undefined || !SERVICES.includes(service)) continue;
    const stamp = entry.match(/"cdat"<timedate>=0x[0-9A-F]+\s+"(\d{4})(\d{2})(\d{2})/);
    found.push({ service, account, created: stamp ? `${stamp[1]}-${stamp[2]}-${stamp[3]}` : "unknown" });
  }
  return found;
}

const keep = await referenced();
const all = records();
const stray = all.filter((record) => !keep.has(`${record.service}/${record.account}`));
const kept = all.filter((record) => keep.has(`${record.service}/${record.account}`));

if (process.argv.includes("--print-delete-commands")) {
  for (const record of stray) console.log(`security delete-generic-password -s '${record.service}' -a '${record.account}' >/dev/null`);
} else {
  const shape = (account: string) => account.replace(/-[a-f0-9]{16,}/g, "-<hex>");
  const groups = new Map<string, { count: number; first: string; last: string }>();
  for (const record of stray) {
    const key = `${record.service}  ${shape(record.account)}`;
    const group = groups.get(key) ?? { count: 0, first: record.created, last: record.created };
    group.count++;
    if (record.created < group.first) group.first = record.created;
    if (record.created > group.last) group.last = record.created;
    groups.set(key, group);
  }
  console.log(`Kept (named by ~/.story/.state): ${kept.map((record) => `${record.service}/${record.account}`).join(", ") || "none"}`);
  for (const reference of keep) if (!kept.some((record) => `${record.service}/${record.account}` === reference)) console.log(`  missing from Keychain: ${reference}`);
  console.log(`Stray: ${stray.length}`);
  for (const [key, group] of [...groups].sort()) console.log(`  ${key}  ${group.count}  (${group.first} … ${group.last})`);
}
