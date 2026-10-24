/**
 * A check-in on how the host, Story Sync and Story.app have been doing: one
 * Markdown report from overstoryd's Railway logs, Story Sync's launchd log,
 * Story.app's unified log and its network log. Run on Joe's Mac from an
 * arbor checkout linked to Railway. Read-only, except `--mark`.
 *
 *   bun tools/log-checkin.ts --mark            # start a period now
 *   bun tools/log-checkin.ts                   # report since the mark
 *   bun tools/log-checkin.ts --since 2026-10-21T00:00:00Z [--out report.md]
 *
 * Story Sync's log has no timestamps, so its period starts at the byte
 * offset the mark recorded (the whole file without a mark).
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const home = homedir();
const MARK = join(home, ".story", "log-checkin.json");
const SYNC_LOG = join(home, "Library", "Logs", "Story", "story-sync.log");
const NETWORK_LOGS = join(home, ".story", "Logs");

const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

if (args.includes("--mark")) {
  const mark = { since: new Date().toISOString(), storySyncLogBytes: existsSync(SYNC_LOG) ? statSync(SYNC_LOG).size : 0 };
  writeFileSync(MARK, `${JSON.stringify(mark, null, 2)}\n`);
  console.log(`Marked ${mark.since}; Story Sync log at byte ${mark.storySyncLogBytes}.`);
  process.exit(0);
}

const mark = existsSync(MARK) ? JSON.parse(readFileSync(MARK, "utf8")) as { since: string; storySyncLogBytes: number } : null;
const since = new Date(flag("--since") ?? mark?.since ?? new Date(Date.now() - 3 * 86_400_000).toISOString());
const syncFrom = flag("--since") ? 0 : mark?.storySyncLogBytes ?? 0;

/** A message with its identifiers, hashes, paths and numbers blanked, so repeats group together. */
const shape = (text: string) => text
  .replace(/sha256:[0-9a-f]{8,}/g, "sha256:…")
  .replace(/\btr_[a-z0-9]{8,}\b/g, "tr_…")
  .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, "<uuid>")
  .replace(/\/(?:Users|tmp|private|var)\/[^\s"')]+/g, "<path>")
  .replace(/\b\d+(\.\d+)?\b/g, "N")
  .slice(0, 220);
const top = (counts: Map<string, number>, n = 10) => [...counts].sort((a, b) => b[1] - a[1]).slice(0, n);
const bump = (counts: Map<string, number>, key: string) => counts.set(key, (counts.get(key) ?? 0) + 1);
const quantile = (values: number[], q: number) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]! * 10) / 10;
};
const table = (rows: Array<[string, number]>) => rows.length ? rows.map(([text, count]) => `| ${count} | \`${text.replaceAll("|", "\\|").replaceAll("`", "'")}\` |`).join("\n") : "| 0 | (none) |";

const report: string[] = [`# Log check-in, ${since.toISOString().slice(0, 16)}Z to ${new Date().toISOString().slice(0, 16)}Z`, ""];

// overstoryd on Railway: one JSON object per line; update events carry timings at the top level.
function overstoryd(): string[] {
  const out = ["## overstoryd (Railway)", ""];
  const run = Bun.spawnSync(["railway", "logs", "--json", "--since", since.toISOString(), "--lines", "50000"], { cwd: join(home, "src", "arbor") });
  if (run.exitCode !== 0) return [...out, `Couldn't read Railway logs: ${run.stderr.toString().trim().slice(0, 300)}`, ""];
  const updates: Array<Record<string, any>> = [];
  const messages = new Map<string, number>();
  const fellThrough = new Map<string, number>();
  for (const line of run.stdout.toString().split("\n")) {
    if (!line.trim()) continue;
    let record: Record<string, any>;
    try { record = JSON.parse(line); } catch { continue; }
    if (record.event === "update") { updates.push(record); continue; }
    const message = String(record.message ?? "").replace(/^\S+Z\s+/, "");
    if (!message || message.startsWith("$ bun ")) continue;
    if (message.startsWith("Fast-forward fell through")) bump(fellThrough, shape(message));
    else bump(messages, `${record.level ?? "?"}: ${shape(message)}`);
  }
  const byStatus = new Map<string, number>();
  for (const update of updates) bump(byStatus, String(update.status));
  const accepted = updates.filter((update) => update.status === 200 || update.status === 201);
  const totals = accepted.map((update) => Number(update.total)).filter(Number.isFinite);
  const sidecar = accepted.filter((update) => update["worker-worker-process"] !== undefined).map((update) => Number(update.total));
  const errors = new Map<string, number>();
  for (const update of updates) if (update.status === "error" || Number(update.status) >= 400) bump(errors, `${update.status}: ${shape(String(update.error ?? update.message ?? ""))}`);
  out.push(
    `${updates.length} update requests: ${top(byStatus, 20).map(([status, count]) => `${count} × ${status}`).join(", ") || "none"}.`,
    "",
    `Accepted updates took ${quantile(totals, 0.5)} ms at the median, ${quantile(totals, 0.9)} ms at p90 and ${quantile(totals, 0.99)} ms at p99 (server time). ` +
      `${sidecar.length} went through the merge sidecar (median ${quantile(sidecar, 0.5)} ms).`,
    "", "**Refused or failed updates**", "", "| Count | Error |", "|---|---|", table(top(errors)), "",
    "**Fast-forwards that fell through to the merge sidecar**", "", "| Count | Reason |", "|---|---|", table(top(fellThrough)), "",
    "**Other messages**", "", "| Count | Message |", "|---|---|", table(top(messages)), "",
  );
  return out;
}

// Story Sync's launchd log: plain lines, stack frames after errors, no timestamps.
function storySync(): string[] {
  const out = ["## Story Sync (`~/Library/Logs/Story/story-sync.log`)", ""];
  if (!existsSync(SYNC_LOG)) return [...out, "No log file.", ""];
  const text = readFileSync(SYNC_LOG).subarray(Math.min(syncFrom, statSync(SYNC_LOG).size)).toString("utf8");
  const counts = new Map<string, number>();
  let lines = 0;
  for (const line of text.split("\n")) {
    if (!line.trim() || /^\s+at /.test(line) || /^\s*\d+ \|/.test(line) || /^\s*\^/.test(line)) continue;
    lines++;
    bump(counts, shape(line.trim()));
  }
  return [...out, `${lines} lines since byte ${syncFrom}${mark ? " (the mark)" : ""}.`, "", "| Count | Line |", "|---|---|", table(top(counts, 15)), ""];
}

// Story.app's unified log, without test runs (swiftpm-testing-helper, or an app built under /tmp).
function storyApp(): string[] {
  const out = ["## Story.app (unified log, `org.arbor.native`)", ""];
  const start = since.toISOString().replace("T", " ").slice(0, 19);
  const run = Bun.spawnSync(["/usr/bin/log", "show", "--start", start, "--timezone", "UTC", "--predicate", 'subsystem == "org.arbor.native"', "--style", "ndjson"]);
  if (run.exitCode !== 0) return [...out, `Couldn't read the unified log: ${run.stderr.toString().trim().slice(0, 300)}`, ""];
  const byCategory = new Map<string, number>();
  const problems = new Map<string, number>();
  let entries = 0;
  for (const line of run.stdout.toString().split("\n")) {
    let entry: Record<string, any>;
    try { entry = JSON.parse(line); } catch { continue; }
    const process = String(entry.processImagePath ?? "");
    if (!entry.category || process.includes("swiftpm-testing-helper") || process.startsWith("/tmp/") || process.startsWith("/private/tmp/") || process.includes("/xctest")) continue;
    entries++;
    bump(byCategory, `${entry.category} ${entry.messageType}`);
    if (entry.messageType === "Error" || entry.messageType === "Fault") bump(problems, `${entry.category}: ${shape(String(entry.eventMessage ?? ""))}`);
  }
  return [...out, `${entries} entries from the app: ${top(byCategory, 20).map(([kind, count]) => `${count} ${kind}`).join(", ") || "none"}.`, "",
    "**Errors and faults**", "", "| Count | Message |", "|---|---|", table(top(problems, 15)), ""];
}

// Story.app's network log: one JSON line per request or watch event.
function network(): string[] {
  const out = ["## Story.app network (`~/.story/Logs/network-*.jsonl`)", ""];
  if (!existsSync(NETWORK_LOGS)) return [...out, "No network logs.", ""];
  const durations = new Map<string, number[]>();
  const failures = new Map<string, number>();
  let requests = 0;
  for (const name of readdirSync(NETWORK_LOGS).filter((file) => /^network-\d{4}-\d{2}-\d{2}\.jsonl$/.test(file)).sort()) {
    if (name.slice(8, 18) < since.toISOString().slice(0, 10)) continue;
    for (const line of readFileSync(join(NETWORK_LOGS, name), "utf8").split("\n")) {
      let entry: Record<string, any>;
      try { entry = JSON.parse(line); } catch { continue; }
      if (!entry.at || new Date(entry.at) < since) continue;
      requests++;
      const key = `${entry.kind} ${entry.name}`;
      if (typeof entry.durationMs === "number" && !entry.error) (durations.get(key) ?? durations.set(key, []).get(key)!).push(entry.durationMs);
      // A watch the app cancels itself is routine.
      if ((entry.error && !String(entry.error).includes("-999")) || Number(entry.status) >= 400) bump(failures, `${key} ${entry.status ?? ""} ${shape(String(entry.error ?? ""))}`.trim());
    }
  }
  const timing = [...durations].sort((a, b) => b[1].length - a[1].length).slice(0, 10)
    .map(([key, values]) => `| ${key} | ${values.length} | ${quantile(values, 0.5)} | ${quantile(values, 0.9)} |`);
  return [...out, `${requests} entries.`, "", "| Request | Count | Median ms | p90 ms |", "|---|---|---|---|", ...(timing.length ? timing : ["| (none) | 0 | | |"]), "",
    "**Failures** (cancelled watches left out)", "", "| Count | Failure |", "|---|---|", table(top(failures, 15)), ""];
}

report.push(...overstoryd(), ...storySync(), ...storyApp(), ...network());
const text = report.join("\n");
const path = flag("--out");
if (path) writeFileSync(path, text);
console.log(text);
