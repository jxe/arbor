import { defaultSourceMergeRule, type SourceMergeRuleSelector } from "./merge-rules.ts";
import { decodeWireDirectory, hashObject, type AcceptedUpdate, type ObjectHash, type SourceOperation } from "@arbor/wire";
import { executeExactSourceEdits, UnsupportedSourceEdit } from "./source-edits.ts";
import type { SourceIntent, StoredSourceIntent } from "./source-intent-store.ts";
import type { MergeSummary, ReconciledUpdate, SourceReconciliation } from "./reconcile.ts";

export interface SourceHistoryEntry {
  update: AcceptedUpdate;
  intent: StoredSourceIntent | null;
  summary: MergeSummary | null;
}

async function fileAt(root: ObjectHash, path: string, load: (hash: ObjectHash) => Promise<Uint8Array>): Promise<Uint8Array | null> {
  const parts = path.slice(1).split("/");
  let hash = root;
  for (const [index, name] of parts.entries()) {
    const entry = decodeWireDirectory(await load(hash)).entries.find(entry => entry.name === name);
    if (!entry || entry.tree) return null;
    if (index === parts.length - 1) return entry.file ? load(entry.file) : null;
    if (!entry.directory) return null;
    hash = entry.directory;
  }
  return null;
}

/** First causal reconciliation rule: disjoint selections from one accepted basis.
 * No byte diff, content equality, or snapshot merge may stand in for a contribution.
 * Candidate execution and tree authorization are the caller's preconditions.
 */
export async function reconcileSourceEdits(
  basis: { id: string; root: ObjectHash },
  candidate: ObjectHash,
  incoming: SourceIntent,
  current: AcceptedUpdate,
  history: SourceHistoryEntry[] | null,
  load: (hash: ObjectHash) => Promise<Uint8Array>,
  selectRule: SourceMergeRuleSelector = defaultSourceMergeRule,
): Promise<ReconciledUpdate> {
  const rejected = (): ReconciledUpdate => ({ outcome: "rejected", root: candidate,
    generated: new Map(), conflicts: [{ path: "/", reason: "node-conflict" }] });
  if (current.conflicted || !history || history.length > 64) return rejected();
  const contributions: SourceReconciliation["contributions"] = [];
  const operations: SourceOperation[] = [];
  const authoredChanges: Array<{ change: string; operations: SourceOperation[] }> = [];
  const changes = new Set<string>();
  const files = new Map<string, ObjectHash>();
  function append(intent: SourceIntent): boolean {
    // A change's frames are its steps; replay reads its whole contribution in
    // authored order, which is the flattened chain.
    const authored = intent.trace.flatMap((frame) => frame.operations);
    if (changes.has(intent.change) || operations.length + authored.length > 4096) return false;
    changes.add(intent.change);
    authoredChanges.push({ change: intent.change, operations: authored });
    for (const evidence of intent.evidence) files.set(evidence.path, evidence.source.object);
    for (const operation of authored) {
      contributions.push({ change: intent.change, operation: operation.key });
      // Keys are local to each change. These transient execution keys are never
      // stored or exposed as material identity.
      operations.push({ ...operation, key: `combined_${operations.length}` });
    }
    return true;
  }
  let previous = basis;
  for (const entry of history) {
    const { update, intent, summary } = entry;
    if (update.tree !== current.tree || update.conflicted || update.previous?.id !== previous.id ||
        update.previous.root !== previous.root || !intent || intent.tree !== current.tree ||
        intent.acceptedUpdate !== update.id || intent.basisRoot !== basis.root) return rejected();
    if (!append(intent)) return rejected();
    if (summary?.version === "exact-source-disjoint-v1") {
      if (summary.basis.id !== basis.id || summary.basis.root !== basis.root ||
          JSON.stringify(summary.contributions) !== JSON.stringify(contributions)) return rejected();
    } else {
      // Before this rule existed, operation acceptance required the exact current
      // basis and stored no summary. Only a direct, unmerged successor qualifies.
      if (summary || previous.id !== basis.id || update.root !== intent.candidateRoot) return rejected();
    }
    previous = { id: update.id, root: update.root };
  }
  if (previous.id !== current.id || previous.root !== current.root) return rejected();
  try {
    // Prove that retained contributions account for the entire current projection.
    // This also prevents accepting incomplete history because its bytes happen to match.
    if ((await executeExactSourceEdits(basis.root, operations, load)).root !== current.root) return rejected();
    if (!append(incoming)) return rejected();
    const result = await executeExactSourceEdits(basis.root, operations, load);
    const rules: NonNullable<SourceReconciliation["rules"]> = [];
    if (history.length) {
      const mergedLoad = async (hash: ObjectHash) => result.generated.get(hash) ?? load(hash);
      for (const [path, object] of files) {
        const rule = selectRule(current.tree, path);
        if (!rule) return rejected();
        const [before, accepted, authored, proposed] = await Promise.all([
          load(object), fileAt(current.root, path, load), fileAt(candidate, path, load), fileAt(result.root, path, mergedLoad),
        ]);
        if (!accepted || !authored || !proposed) return rejected();
        const identity = { rule: rule.id, revision: rule.revision };
        const decision = await rule.evaluate(structuredClone({ tree: current.tree, path, basis: before,
          current: accepted, candidate: authored, proposed, contributions, changes: authoredChanges }));
        if (decision.outcome !== "resolved") return rejected();
        rules.push({ path, ...identity, outcome: "resolved", reason: decision.reason,
          inputs: { basis: object, current: hashObject(accepted), candidate: hashObject(authored), proposed: hashObject(proposed) } });
      }
    }
    return { outcome: "merged", root: result.root, generated: result.generated, conflicts: [],
      merge: { version: "exact-source-disjoint-v1", basis, contributions, rules } };
  } catch (error) {
    // Overlap across individually supported requests is a reconciliation conflict,
    // not an unsupported-operation error and never an implicit resolution.
    if (error instanceof UnsupportedSourceEdit) return rejected();
    throw error;
  }
}
