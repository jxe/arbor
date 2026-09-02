import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { NodeResponse } from "@arbor/core";
import { canonicalHTTPURL, sha256 } from "@arbor/core";
import { arborPrivateRoot, prepareArborDataRoot } from "./private-state.ts";

export interface VisitedTreeRecord {
  id: string;
  locator: string;
  tree: string;
  name: string;
  canonical?: string;
  visitedAt: string;
  snapshot: NodeResponse;
}

/** A private, credential-free cache of explicitly browsed remote nodes. */
export class VisitedTreeStore {
  private directory = join(arborPrivateRoot(), "system", "visited");

  private id(locator: string): string {
    return sha256(locator).slice(0, 24);
  }

  async remember(locator: string, snapshot: NodeResponse): Promise<VisitedTreeRecord> {
    await prepareArborDataRoot();
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const record: VisitedTreeRecord = {
      id: this.id(locator),
      locator,
      tree: String(snapshot.ref.tree ?? snapshot.enclosingTree?.id ?? ""),
      name: snapshot.enclosingTree?.name ?? snapshot.name,
      canonical: snapshot.enclosingTree?.canonical ? canonicalHTTPURL(snapshot.enclosingTree.canonical) : undefined,
      visitedAt: new Date().toISOString(),
      snapshot,
    };
    const path = join(this.directory, `${record.id}.json`);
    const temporary = `${path}.arbor-write-${crypto.randomUUID()}`;
    try {
      await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
    return record;
  }

  async get(locator: string): Promise<VisitedTreeRecord | null> {
    await prepareArborDataRoot();
    try {
      const record = JSON.parse(await readFile(join(this.directory, `${this.id(locator)}.json`), "utf8")) as VisitedTreeRecord;
      return record.locator === locator && record.snapshot && typeof record.tree === "string" ? record : null;
    } catch {
      return null;
    }
  }

  async list(): Promise<VisitedTreeRecord[]> {
    await prepareArborDataRoot();
    const names = await readdir(this.directory).catch(() => []);
    const records = await Promise.all(names.filter((name) => name.endsWith(".json")).map(async (name) => {
      try { return JSON.parse(await readFile(join(this.directory, name), "utf8")) as VisitedTreeRecord; }
      catch { return null; }
    }));
    return records
      .filter((record): record is VisitedTreeRecord => Boolean(record?.locator && record.snapshot && record.tree))
      .sort((a, b) => b.visitedAt.localeCompare(a.visitedAt));
  }
}
