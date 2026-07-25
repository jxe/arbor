import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { sha256, type ArborBlock, type MutationEffect, type MutationReceipt } from "@arbor/core";
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

export interface DurableMutationRecord {
  mutationID: string;
  requestHash: string;
  request: unknown;
  state: "pending" | "materialized" | "completed";
  expectedEffects?: MutationEffect[];
  effects?: MutationEffect[];
  receipt?: MutationReceipt;
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
    await this.append(pageID, flatten(blocks)
      .filter((item) => !known.has(item.hash))
      .map((item) => ({ op: "observe" as const, h: item.hash, p: item.parent, m: item.markdown })));
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
    return restored.length ? { blocks: [...blocks, ...restored], restored: restored.length } : { blocks, restored: 0 };
  }

  async markMaterialized(pageID: string): Promise<void> {
    await writeAtomic(this.watermarkPath(pageID), `${await this.counter(pageID)}\n`);
  }

  async list(pageID: string, liveBlocks: ArborBlock[]): Promise<RecoveryEntry[]> {
    const live = new Set(flatten(liveBlocks).map((item) => item.hash));
    const intent = this.fold(await this.read(pageID));
    const result: RecoveryEntry[] = [];
    for (const [hash, state] of intent) {
      if (live.has(hash) || !state.markdown) continue;
      if (state.status === "alive" || state.status === "observed") result.push({ hash, markdown: state.markdown, parent: state.parent, status: "lost", changedAt: state.changedAt });
      else result.push({ hash, markdown: state.markdown, parent: state.parent, status: "purged", changedAt: state.changedAt });
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
    for (const record of [...records].sort((a, b) => a.c - b.c)) {
      const state = byHash.get(record.h) ?? { observed: false };
      if (record.op === "add" || record.op === "purge") state.authoritative = record;
      if ((record.op === "add" || record.op === "observe") && record.m !== undefined) state.snapshot = record;
      if (record.op === "observe") state.observed = true;
      byHash.set(record.h, state);
    }
    const result = new Map<string, { status: "alive" | "observed" | "purged"; markdown: string; parent: string | null; changedAt: number; counter: number }>();
    for (const [hash, state] of byHash) {
      const source = state.authoritative ?? state.snapshot;
      if (!source) continue;
      result.set(hash, {
        status: state.authoritative?.op === "purge" ? "purged" : state.authoritative?.op === "add" ? "alive" : "observed",
        markdown: state.snapshot?.m ?? "",
        parent: state.snapshot?.p ?? null,
        changedAt: source.t,
        counter: source.c,
      });
    }
    return result;
  }

  private async counter(pageID: string): Promise<number> {
    const cached = this.counters.get(pageID);
    if (cached !== undefined) return cached;
    const records = await this.read(pageID);
    const value = records.reduce((max, record) => Math.max(max, record.c), 0);
    this.counters.set(pageID, value);
    return value;
  }

  private async watermark(pageID: string): Promise<number> {
    try { return Number((await readFile(this.watermarkPath(pageID), "utf8")).trim()) || 0; } catch { return 0; }
  }

  private pageKey(pageID: string): string {
    return /^[a-z0-9]{6}$/.test(pageID) ? pageID : `id-${sha256(pageID)}`;
  }

  private path(pageID: string): string { return join(this.directory, `${this.pageKey(pageID)}.jsonl`); }
  private watermarkPath(pageID: string): string { return join(this.directory, `${this.pageKey(pageID)}.watermark`); }
}

export class MutationJournal {
  constructor(private directory: string) {}

  async prepare(mutationID: string, requestHash: string, request: unknown): Promise<DurableMutationRecord> {
    const existing = await this.get(mutationID);
    if (existing) return existing;
    const record: DurableMutationRecord = { mutationID, requestHash, request, state: "pending" };
    await this.write(record);
    return record;
  }

  async markMaterialized(mutationID: string, requestHash: string, effects: MutationEffect[]): Promise<DurableMutationRecord> {
    const current = await this.get(mutationID);
    if (!current || current.requestHash !== requestHash) throw new Error(`Mutation journal mismatch: ${mutationID}`);
    if (current.state === "completed") return current;
    const record: DurableMutationRecord = { ...current, state: "materialized", effects };
    await this.write(record);
    return record;
  }

  async markExpected(mutationID: string, requestHash: string, effects: MutationEffect[]): Promise<DurableMutationRecord> {
    const current = await this.get(mutationID);
    if (!current || current.requestHash !== requestHash) throw new Error(`Mutation journal mismatch: ${mutationID}`);
    if (current.state !== "pending") return current;
    const record: DurableMutationRecord = { ...current, expectedEffects: effects };
    await this.write(record);
    return record;
  }

  async complete(mutationID: string, requestHash: string, receipt: MutationReceipt): Promise<DurableMutationRecord> {
    const current = await this.get(mutationID);
    if (!current || current.requestHash !== requestHash) throw new Error(`Mutation journal mismatch: ${mutationID}`);
    if (current.state === "completed") return current;
    const record: DurableMutationRecord = { ...current, state: "completed", effects: receipt.effects, receipt };
    await this.write(record);
    return record;
  }

  async get(mutationID: string): Promise<DurableMutationRecord | null> {
    try {
      return JSON.parse(await readFile(this.path(mutationID), "utf8")) as DurableMutationRecord;
    } catch {
      return null;
    }
  }

  async pending(): Promise<DurableMutationRecord[]> {
    const { readdir } = await import("node:fs/promises");
    try {
      const entries = await readdir(this.directory);
      const records = await Promise.all(entries.filter((entry) => entry.endsWith(".json")).map(async (entry) => {
        try { return JSON.parse(await readFile(join(this.directory, entry), "utf8")) as DurableMutationRecord; }
        catch { return null; }
      }));
      return records.filter((record): record is DurableMutationRecord => Boolean(record && record.state !== "completed"));
    } catch {
      return [];
    }
  }

  private async write(record: DurableMutationRecord): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    await writeAtomic(this.path(record.mutationID), JSON.stringify(record));
  }

  private path(mutationID: string): string {
    return join(this.directory, `${sha256(mutationID)}.json`);
  }
}
