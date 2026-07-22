import { appendFile, mkdir, readFile, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ArborBlock } from "@arbor/core";
import { blockFingerprint, parseMarkdown, serializeBlocks } from "@arbor/editor";
import { writeAtomic } from "./file-ops.ts";

export type JournalOperation = "add" | "observe" | "purge";

export interface JournalRecord {
  op: JournalOperation;
  h: string;
  p?: string | null;
  m?: string;
  t: number;
  c: number;
}

export interface RecoveryEntry {
  hash: string;
  markdown: string;
  parent: string | null;
  status: "lost" | "purged";
  changedAt: number;
}

interface FlatBlock {
  hash: string;
  parent: string | null;
  markdown: string;
  block: ArborBlock;
}

function flatten(blocks: ArborBlock[], parent: string | null = null, result: FlatBlock[] = []): FlatBlock[] {
  for (const block of blocks) {
    const hash = blockFingerprint(block);
    const atomic = { ...block, children: [], source: undefined, sourceHash: undefined };
    result.push({ hash, parent, markdown: serializeBlocks([atomic]), block });
    flatten(block.children, hash, result);
  }
  return result;
}

export class WriteJournal {
  private counters = new Map<string, number>();
  constructor(private directory: string) {}

  async commit(pageID: string, before: ArborBlock[], after: ArborBlock[]): Promise<void> {
    const beforeFlat = flatten(before);
    const afterFlat = flatten(after);
    const beforeHashes = new Set(beforeFlat.map((item) => item.hash));
    const afterHashes = new Set(afterFlat.map((item) => item.hash));
    const records: Omit<JournalRecord, "c" | "t">[] = [];
    for (const item of beforeFlat) if (!afterHashes.has(item.hash)) records.push({ op: "purge", h: item.hash });
    for (const item of afterFlat) if (!beforeHashes.has(item.hash)) records.push({ op: "add", h: item.hash, p: item.parent, m: item.markdown });
    await this.append(pageID, records);
  }

  async observe(pageID: string, blocks: ArborBlock[]): Promise<void> {
    const known = new Set((await this.read(pageID)).map((record) => record.h));
    const records = flatten(blocks)
      .filter((item) => !known.has(item.hash))
      .map((item) => ({ op: "observe" as const, h: item.hash, p: item.parent, m: item.markdown }));
    await this.append(pageID, records);
  }

  async reconcile(pageID: string, blocks: ArborBlock[], fileMtime: number): Promise<{ blocks: ArborBlock[]; restored: number }> {
    const records = await this.read(pageID);
    if (!records.length) return { blocks, restored: 0 };
    const intent = this.fold(records);
    const watermark = await this.watermark(pageID);
    const live = new Set(flatten(blocks).map((item) => item.hash));
    const restored: ArborBlock[] = [];
    for (const [hash, state] of intent) {
      const pendingCrashIntent = state.status === "alive" && state.counter > watermark && state.changedAt >= fileMtime;
      if (pendingCrashIntent && !live.has(hash) && state.markdown) {
        const parsed = parseMarkdown(state.markdown).blocks[0];
        if (parsed) restored.push(parsed);
      }
    }
    if (!restored.length) return { blocks, restored: 0 };
    return { blocks: [...blocks, ...restored], restored: restored.length };
  }

  async markMaterialized(pageID: string): Promise<void> {
    const counter = await this.counter(pageID);
    await writeAtomic(this.watermarkPath(pageID), `${counter}\n`);
  }

  async list(pageID: string, liveBlocks: ArborBlock[]): Promise<RecoveryEntry[]> {
    const live = new Set(flatten(liveBlocks).map((item) => item.hash));
    const intent = this.fold(await this.read(pageID));
    const result: RecoveryEntry[] = [];
    for (const [hash, state] of intent) {
      if (live.has(hash) || !state.markdown) continue;
      if (state.status === "alive" || state.status === "observed") {
        result.push({ hash, markdown: state.markdown, parent: state.parent, status: "lost", changedAt: state.changedAt });
      } else if (state.status === "purged") {
        result.push({ hash, markdown: state.markdown, parent: state.parent, status: "purged", changedAt: state.changedAt });
      }
    }
    return result.sort((a, b) => b.changedAt - a.changedAt);
  }

  async restore(pageID: string, hash: string, blocks: ArborBlock[]): Promise<ArborBlock[]> {
    const entry = (await this.list(pageID, blocks)).find((item) => item.hash === hash);
    if (!entry) throw new Error("Recovery entry not found");
    const block = parseMarkdown(entry.markdown).blocks[0];
    if (!block) throw new Error("Recovery entry could not be parsed");
    const next = [...blocks, block];
    await this.commit(pageID, blocks, next);
    return next;
  }

  private async append(pageID: string, entries: Array<Omit<JournalRecord, "c" | "t">>): Promise<void> {
    if (!entries.length) return;
    const path = this.path(pageID);
    await mkdir(dirname(path), { recursive: true });
    let counter = await this.counter(pageID);
    const now = Date.now() / 1_000;
    const records = entries.map((entry) => ({ ...entry, t: now, c: ++counter }));
    await appendFile(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, { mode: 0o600 });
    const file = await import("node:fs/promises").then(({ open }) => open(path, "r"));
    try { await file.sync(); } finally { await file.close(); }
    this.counters.set(pageID, counter);
  }

  private async read(pageID: string): Promise<JournalRecord[]> {
    try {
      const source = await readFile(this.path(pageID), "utf8");
      return source.split(/\r?\n/).filter(Boolean).flatMap((line) => {
        try { return [JSON.parse(line) as JournalRecord]; } catch { return []; }
      });
    } catch { return []; }
  }

  private fold(records: JournalRecord[]): Map<string, { status: "alive" | "observed" | "purged"; markdown: string; parent: string | null; changedAt: number; counter: number }> {
    const byHash = new Map<string, { authoritative?: JournalRecord; snapshot?: JournalRecord; observed: boolean }>();
    for (const record of records.sort((a, b) => a.c - b.c)) {
      const state = byHash.get(record.h) ?? { observed: false };
      if (record.op === "add" || record.op === "purge") state.authoritative = record;
      if ((record.op === "add" || record.op === "observe") && record.m !== undefined) state.snapshot = record;
      if (record.op === "observe") state.observed = true;
      byHash.set(record.h, state);
    }
    const result = new Map<string, { status: "alive" | "observed" | "purged"; markdown: string; parent: string | null; changedAt: number; counter: number }>();
    for (const [hash, state] of byHash) {
      const status = state.authoritative?.op === "purge" ? "purged" : state.authoritative?.op === "add" ? "alive" : "observed";
      result.set(hash, {
        status,
        markdown: state.snapshot?.m ?? "",
        parent: state.snapshot?.p ?? null,
        changedAt: (state.authoritative ?? state.snapshot)?.t ?? 0,
        counter: (state.authoritative ?? state.snapshot)?.c ?? 0,
      });
    }
    return result;
  }

  private async counter(pageID: string): Promise<number> {
    const cached = this.counters.get(pageID);
    if (cached !== undefined) return cached;
    const records = await this.read(pageID);
    return Math.max(0, ...records.map((record) => record.c ?? 0));
  }

  private path(pageID: string): string {
    if (!/^[a-z0-9]{6}$/.test(pageID)) throw new Error("Invalid page ID");
    return join(this.directory, `${pageID}.jsonl`);
  }

  private async watermark(pageID: string): Promise<number> {
    try { return Number((await readFile(this.watermarkPath(pageID), "utf8")).trim()) || 0; }
    catch { return 0; }
  }

  private watermarkPath(pageID: string): string {
    if (!/^[a-z0-9]{6}$/.test(pageID)) throw new Error("Invalid page ID");
    return join(this.directory, "watermarks", `${pageID}.txt`);
  }
}
