import { join } from "node:path";
import { expect } from "bun:test";
import { ObjectStore, holdsObject } from "@overstory/object-store";
import { stableJSONString } from "@overstory/protocol";
import type { LogEntry, MergeQuestion } from "@overstory/merge-protocol";
import { Sidecar } from "../../packages/canopyd-merge/src/sidecar.ts";
import { acceptedEntries } from "./log-entries.ts";

/** canopyd's default rules, which a fast-forwarded entry records none of. */
const DEFAULT_RULES = { id: "tree-default", revision: 1, config: { contentChoices: "source", conflictProjection: "current", maxMillis: 20_000 } };

/** The question an entry records, asked again with its previous entry as head. */
export function recordedQuestion(entry: LogEntry): MergeQuestion {
  const asked = entry.asked;
  return {
    base: asked?.base ?? entry.previous!,
    head: entry.previous!,
    ...(asked?.prefix ? { prefix: asked.prefix } : {}),
    candidate: {
      root: asked?.candidate ?? entry.trace?.at(-1)?.after ?? entry.root,
      change: entry.change, trace: entry.trace, resolves: entry.resolves,
      ...(asked?.alternatives ? { alternatives: asked.alternatives } : {}),
    },
    rules: asked?.rules ?? DEFAULT_RULES,
  };
}

/** An in-process sidecar over a data root's object store. */
export function sidecar(dataRoot: string, replayMillis?: number): Sidecar {
  const shared = new ObjectStore(join(dataRoot, "objects"));
  const staged = new Map<string, Uint8Array>();
  return new Sidecar({
    shared: { find: (hash) => shared.find(hash), has: (hash) => holdsObject(shared, hash) },
    staging: { find: async (hash) => staged.get(hash) ?? null, stage: async (values) => { for (const v of values) staged.set(v.hash, v.bytes); } },
  }, undefined, undefined, replayMillis);
}

/** Entries are facts a sidecar can reproduce: asking each entry's recorded
 * question again gives its root and decisions from one warm cache across the
 * whole history, and from a cold cache (a fresh sidecar, which rebuilds from
 * the chain's start) for the latest entries. */
export async function expectReplayableHistory(dataRoot: string, tree: string): Promise<void> {
  const entries = acceptedEntries(dataRoot, tree).filter(({ entry }) => entry.previous !== null);
  const warm = sidecar(dataRoot);
  for (const [index, { id, entry }] of entries.entries()) {
    const question = recordedQuestion(entry);
    const cold = index >= entries.length - 3 ? [["cold", sidecar(dataRoot)] as const] : [];
    for (const [label, answering] of [...cold, ["warm", warm] as const]) {
      const answer = await answering.answer(question);
      expect({ id, label, root: answer.root, decisions: stableJSONString(answer.decisions) })
        .toEqual({ id, label, root: entry.root, decisions: stableJSONString(entry.decisions) });
    }
  }
}
