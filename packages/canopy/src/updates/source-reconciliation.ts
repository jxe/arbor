import { decodeWireDirectory, type AcceptedUpdate, type ObjectHash, type SourceOperation } from "@arbor/wire";
import { executeExactSourceEdits, UnsupportedSourceEdit } from "./source-edits.ts";
import type { SourceIntent, StoredSourceIntent } from "./source-intent-store.ts";
import type { MergeSummary, ReconciledUpdate, SourceReconciliation } from "./reconcile.ts";

export interface SourceHistoryEntry {
  update: AcceptedUpdate;
  intent: StoredSourceIntent | null;
  summary: MergeSummary | null;
}

function plainProse(path: string, bytes: Uint8Array): boolean {
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  if (/\.txt$/i.test(path)) return true;
  if (!/\.(md|markdown)$/i.test(path)) return false;
  // Deliberately a small recognition rule, not a Markdown parser. Decline markup,
  // frontmatter, code, links and embedded structures until format-aware rules own them.
  return !/[`~*_<>{}\[\]\\|#$]/.test(text) &&
    !/^\ufeff?---(?:\r?\n|$)/.test(text) &&
    !/^[ \t]*(?:[-=]{2,}|[+]{3,})[ \t]*$/m.test(text) &&
    !/^(?: {4}|\t|\s*(?:[-+]|\d+[.)])\s)/m.test(text);
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
): Promise<ReconciledUpdate> {
  const rejected = (): ReconciledUpdate => ({ outcome: "rejected", root: candidate,
    generated: new Map(), conflicts: [{ path: "/", reason: "node-conflict" }] });
  if (current.conflicted || !history || history.length > 64) return rejected();
  const contributions: SourceReconciliation["contributions"] = [];
  const operations: SourceOperation[] = [];
  const changes = new Set<string>();
  const files = new Map<string, ObjectHash>();
  function append(intent: SourceIntent): boolean {
    if (changes.has(intent.change) || operations.length + intent.operations.length > 4096) return false;
    changes.add(intent.change);
    for (const evidence of intent.evidence) files.set(evidence.path, evidence.source.object);
    for (const operation of intent.operations) {
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
    if (history.length) {
      const mergedLoad = async (hash: ObjectHash) => result.generated.get(hash) ?? load(hash);
      for (const [path, object] of files) {
        const after = await fileAt(result.root, path, mergedLoad);
        if (!after || !plainProse(path, await load(object)) || !plainProse(path, after)) return rejected();
      }
    }
    return { outcome: "merged", root: result.root, generated: result.generated, conflicts: [],
      merge: { version: "exact-source-disjoint-v1", basis, contributions } };
  } catch (error) {
    // Overlap across individually supported requests is a reconciliation conflict,
    // not an unsupported-operation error and never an implicit resolution.
    if (error instanceof UnsupportedSourceEdit) return rejected();
    throw error;
  }
}
