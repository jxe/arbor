import { hashObject, stableJSONString } from "@overstory/protocol";
import {
  decodeLogEntry,
  MergeRefusal,
  parseQuestion,
  treeDefaultConfig,
  type Candidate,
  type LogDecision,
  type LogEntry,
  type MergeAnswer,
  type MergeQuestion,
  type MergeRules,
} from "@overstory/merge-protocol";
import type { MergeObjects } from "./index.ts";
import { EvaluationFailure, type CheckpointRequest, type IntentRequest } from "./engine-contract.ts";
import { checkpointIntent, mergeIntent } from "./intent-engine.ts";
import { IntentError } from "./intent-model.ts";
import { logDecisions } from "./log-decisions.ts";
import { mergeWireTrees } from "./merge.ts";
import { snapshotDecisions } from "./snapshot.ts";
import { absentClosure, changedEntryPaths, type TreeIO } from "./trees.ts";

/** A replayed or evaluated retained state: its projection, the engine's state
 * object, and its decisions as a log entry records them. */
interface Cached {
  object: string;
  state: string;
  decisions: LogDecision[];
}

/** Where the sidecar reads accepted objects and writes an answer's new ones.
 * `shared` is canopyd's store (read-only); `staging` is this question's.
 * `find` returns an object's verified bytes, or null when it is absent; a
 * corrupt object is an error, never bytes (as `ObjectStore.find` does). */
export interface SidecarStores {
  shared: { find(hash: string): Promise<Uint8Array | null>; has(hash: string): Promise<boolean> };
  staging: { find(hash: string): Promise<Uint8Array | null>; stage(values: Array<{ hash: string; bytes: Uint8Array }>): Promise<void> };
}

/** Change identities a client can see as contributions. canopyd's own
 * acceptances (tree creation, pairing, boundary rewrites) are not changes an
 * author made. */
const CLIENT_CHANGE = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * The reference merge sidecar. It answers each question as a deterministic
 * function of objects and its rules. Everything it keeps is a cache: engine
 * states for log entries, rebuilt by replaying entries from each chain's
 * start (trace, then align to the accepted root and decisions), and the
 * objects those states are made of, held in memory only. A cache wipe
 * changes no answer.
 */
/** How long one question may replay history before it answers retryably
 * (`ARBOR_MERGE_REPLAY_MS` overrides it). With canopyd's evaluation budget
 * it stays inside canopyd's 30-second timeout. */
export const REPLAY_MILLIS = 10_000;

export class Sidecar {
  private memory = new Map<string, Uint8Array>();
  private memoryBytes = 0;
  private states = new Map<string, Cached>();
  private entries = new Map<string, LogEntry>();
  /** Paths each entry changed from its previous entry's root. Entries are
   * immutable, so this is a cache; it is counted in `memoryBytes`. */
  private changed = new Map<string, string[]>();
  /** Recently solved questions. The next question's head is usually the entry
   * canopyd recorded from the last answer, and replaying it asks the same
   * question again: the same inputs give the same state, so it is reused. */
  private solved = new Map<string, Cached>();
  /** Entries the current question replayed (a solved question reused counts); a diagnostic. */
  replayed = 0;
  private replayDeadline = Infinity;

  constructor(
    private readonly stores: SidecarStores,
    private readonly cacheBytes = 512 * 1024 * 1024,
    /** The snapshot tree merge; replaceable so a test can make it fail. */
    private readonly treeMerge = mergeWireTrees,
    /** How long one question may spend replaying history (see `stateOf`). */
    private readonly replayMillis = REPLAY_MILLIS,
  ) {}

  /** Drop every cached state and object. */
  clear(): void {
    this.memory.clear();
    this.memoryBytes = 0;
    this.states.clear();
    this.entries.clear();
    this.changed.clear();
    this.solved.clear();
  }

  readonly objects: MergeObjects = {
    read: async (hash) => {
      const bytes = this.memory.get(hash) ?? (await this.stores.shared.find(hash)) ?? (await this.stores.staging.find(hash));
      if (!bytes) throw new MergeRefusal("missing-context", `Object is unavailable: ${hash}`);
      return bytes;
    },
    store: async (values) => {
      for (const { hash, bytes } of values) this.remember(hash, bytes);
    },
  };

  private readonly io: TreeIO = {
    read: (hash) => this.objects.read(hash),
    put: (bytes) => {
      const hash = hashObject(bytes);
      this.remember(hash, bytes);
      return hash;
    },
  };

  private remember(hash: string, bytes: Uint8Array): void {
    if (this.memory.has(hash)) return;
    this.memory.set(hash, bytes);
    this.memoryBytes += bytes.byteLength;
  }

  private async entry(hash: string): Promise<LogEntry> {
    let entry = this.entries.get(hash);
    if (!entry) {
      // Not hashed again: stores verify what they return, and memory holds
      // only objects this process generated under their own hash.
      entry = decodeLogEntry(await this.objects.read(hash));
      this.entries.set(hash, entry);
    }
    return entry;
  }

  async answer(raw: unknown): Promise<MergeAnswer> {
    const question = parseQuestion(raw);
    const rules = this.rules(question);
    if (this.memoryBytes > this.cacheBytes) this.clear();
    this.replayed = 0;
    this.replayDeadline = performance.now() + this.replayMillis;
    const { result, reports, evidence } = await this.solve(question, rules);
    const decisions = await logDecisions(this.io, result.object, reports);
    this.rememberSolved(question, { ...result, decisions });
    return { root: result.object, objects: await this.export(result.object, decisions), decisions, evidence };
  }

  private rememberSolved(question: MergeQuestion, state: Cached): void {
    const key = stableJSONString(question);
    this.solved.delete(key);
    this.solved.set(key, state);
    for (const oldest of this.solved.keys()) {
      if (this.solved.size <= 32) break;
      this.solved.delete(oldest);
    }
  }

  /** Evaluate a question against the retained states of its entries: a traced
   * candidate by the engine, a snapshot by a tree merge and a checkpoint. */
  private async solve(question: MergeQuestion, rules: IntentRequest["rules"]) {
    const head = await this.entry(question.head);
    const base = await this.entry(question.base);
    if (head.tree !== base.tree) throw new MergeRefusal("invalid", "Question entries belong to different trees");
    const current = await this.stateOf(question.head, rules);
    let basis: { object: string; state: string } = await this.stateOf(question.base, rules);
    for (const prior of question.prefix ?? []) basis = await this.authored(head.tree, basis, prior, rules);
    const candidate = question.candidate;
    if (candidate.trace === null) return this.snapshot(question, head, basis.object, current);
    const evaluated = await this.evaluate(head.tree, basis, current, candidate, rules);
    if (evaluated.outcome !== "evaluated") throw new MergeRefusal(evaluated.outcome, evaluated.message);
    return { result: evaluated.result, reports: evaluated.reports, evidence: evaluated.evidence as unknown };
  }

  private rules({ rules }: { rules: MergeRules }): IntentRequest["rules"] {
    if (rules.id !== "tree-default" || rules.revision !== 1)
      throw new MergeRefusal("unsupported", `Unknown rules: ${rules.id} revision ${rules.revision}`);
    const parsed = treeDefaultConfig.safeParse(rules.config ?? {});
    if (!parsed.success) throw new MergeRefusal("invalid", "Invalid rule configuration");
    return { id: "tree-default", revision: 1, ...(rules.config === undefined ? {} : { config: parsed.data }) };
  }

  /** The retained state of an entry, replaying from the nearest cached entry
   * or the chain's start. */
  private async stateOf(hash: string, rules: IntentRequest["rules"]): Promise<Cached> {
    const chain: string[] = [];
    let at: string | null = hash;
    while (at && !this.states.has(at)) {
      chain.push(at);
      at = (await this.entry(at)).previous;
    }
    let previous = at ? this.states.get(at)! : null;
    chain.reverse();
    for (const [index, entry] of chain.entries()) {
      // A long rebuild (a cold cache over a long chain) stops at the budget,
      // keeping every state it built, and asks canopyd to retry: the next
      // attempt continues from there. A canopyd timeout would instead end
      // the process and lose them, so a long chain could never be rebuilt.
      // Every attempt replays at least one entry, so retries always progress.
      if (index > 0 && performance.now() > this.replayDeadline)
        throw new EvaluationFailure(`Rebuilding accepted history: ${index} of ${chain.length} entries replayed; retry to continue`, "unavailable");
      previous = await this.replay(entry, previous, rules);
      this.states.set(entry, previous);
      this.replayed++;
    }
    return previous!;
  }

  /** Entries are facts. Ask the entry's question again with its previous
   * entry as the head, as the entry records it; then align to the recorded
   * root and decisions, which a replay under other rules or a canopyd
   * decision the sidecar did not make can differ from. */
  private async replay(hash: string, previous: Cached | null, rules: IntentRequest["rules"]): Promise<Cached> {
    const entry = await this.entry(hash);
    if (!previous) {
      const imported = await this.checkpoint({
        kind: "checkpoint", tree: entry.tree, current: { object: entry.root }, projection: entry.root,
        change: entry.change, decisions: entry.decisions.map(checkpointDecision), align: true,
      });
      return this.align(entry, imported);
    }
    let state: Cached = previous;
    try {
      const asked = entry.asked;
      const question = parseQuestion({
        base: asked?.base ?? entry.previous!,
        head: entry.previous!,
        ...(asked?.prefix ? { prefix: asked.prefix } : {}),
        candidate: {
          root: asked?.candidate ?? entry.trace?.at(-1)?.after ?? entry.root,
          change: entry.change, trace: entry.trace, resolves: entry.resolves,
          ...(asked?.alternatives ? { alternatives: asked.alternatives } : {}),
        },
        rules: asked?.rules ?? rules,
      });
      const known = this.solved.get(stableJSONString(question));
      if (known) state = known;
      else {
        const solved = await this.solve(question, asked ? this.rules(asked) : rules);
        state = { ...solved.result, decisions: await logDecisions(this.io, solved.result.object, solved.reports) };
      }
    } catch (error) {
      // An entry its question no longer explains (a refusal, which is a
      // property of the question) is aligned to as a fact. A failure to
      // evaluate is not: a time budget or a store failure could pass on a
      // retry, and aligning past it would make the cached state depend on
      // load. Those, and anything unexpected, fail this question instead.
      if (!(error instanceof MergeRefusal || error instanceof IntentError)) throw error;
    }
    return this.align(entry, state);
  }

  /** Make a state's projection and decisions the entry's. Decisions that
   * already match are kept with their retained detail; the rest are removed
   * and imported from the entry. */
  private async align(entry: LogEntry, from: Cached): Promise<Cached> {
    let state = from;
    if (state.object !== entry.root)
      state = await this.checkpoint({
        kind: "checkpoint", tree: entry.tree, current: state, projection: entry.root, change: entry.change,
        continueSelected: entry.asked?.base === undefined, decisions: [], align: true,
      });
    const wanted = new Map(entry.decisions.map((d) => [d.key, d]));
    const kept = new Set(state.decisions.filter((d) => wanted.has(d.key) && stableJSONString(d) === stableJSONString(wanted.get(d.key))).map((d) => d.key));
    // A kept decision that depends on a replaced one is replaced with it.
    for (let changed = true; changed;) {
      changed = false;
      for (const d of state.decisions)
        if (kept.has(d.key) && d.dependencies.some((k) => !kept.has(k))) { kept.delete(d.key); changed = true; }
    }
    if (kept.size === state.decisions.length && kept.size === wanted.size) return state;
    return this.checkpoint({
      kind: "checkpoint", tree: entry.tree, current: state, projection: entry.root, change: entry.change,
      resolves: state.decisions.filter((d) => !kept.has(d.key)).map((d) => d.key),
      decisions: entry.decisions.filter((d) => !kept.has(d.key)).map(checkpointDecision),
      align: true,
    });
  }

  private async checkpoint(request: CheckpointRequest): Promise<Cached> {
    const response = await checkpointIntent(request, this.objects);
    return { ...response.result, decisions: await logDecisions(this.io, response.result.object, response.decisions) };
  }

  private evaluate(
    tree: string,
    base: { object: string; state: string },
    current: { object: string; state: string },
    candidate: Candidate,
    rules: IntentRequest["rules"],
  ) {
    return mergeIntent({
      kind: "tree", tree,
      base: { object: base.object, state: base.state },
      current: { object: current.object, state: current.state },
      incoming: {
        change: candidate.change, object: candidate.root, trace: candidate.trace ?? [],
        ...(candidate.resolves.length ? { resolves: candidate.resolves } : {}),
      },
      rules,
      ...(candidate.alternatives?.length ? { alternatives: candidate.alternatives } : {}),
    } as IntentRequest, this.objects);
  }

  /** The author's own state after an earlier batch element: its trace
   * evaluated on the basis, or its snapshot checkpointed onto it. */
  private async authored(tree: string, basis: { object: string; state: string }, prior: Candidate, rules: IntentRequest["rules"]) {
    if (prior.trace !== null) {
      const evaluated = await this.evaluate(tree, basis, basis, prior, rules);
      if (evaluated.outcome !== "evaluated") throw new MergeRefusal(evaluated.outcome, evaluated.message);
      return evaluated.authored;
    }
    const response = await checkpointIntent({ kind: "checkpoint", tree, current: basis, projection: prior.root, change: prior.change, decisions: [] }, this.objects);
    return response.result;
  }

  /** A snapshot: a tree merge against the head, then a checkpoint of the
   * projection onto the head's state with a choice for each conflict. */
  private async snapshot(question: MergeQuestion, head: LogEntry, baseRoot: string, current: Cached) {
    const candidate = question.candidate;
    const rule = { id: "tree-default", revision: 1 };
    let merged: { root: string; conflicts: Array<{ path: string }>; folders: string[]; summary?: unknown };
    if (candidate.root === head.root || candidate.root === baseRoot) merged = { root: head.root, conflicts: [], folders: [] };
    else if (head.root === baseRoot) merged = { root: candidate.root, conflicts: [], folders: [] };
    else {
      try {
        const result = await this.treeMerge(baseRoot, candidate.root, head.root, (hash) => this.objects.read(hash));
        for (const [hash, bytes] of result.objects) this.remember(hash, bytes);
        merged = { root: result.root, conflicts: result.conflicts, folders: result.unresolvedDirectories ?? [], ...(result.summary ? { summary: result.summary } : {}) };
      } catch (error) {
        // Ordinary content is preserved as a whole-root choice that keeps the current tree.
        process.stderr.write(`Tree merge failed; preserving ambiguity: ${error instanceof Error ? error.message.split("\n")[0] : "invalid result"}\n`);
        merged = { root: head.root, conflicts: [{ path: "/" }], folders: ["/"] };
      }
    }
    const conflictProjection = (question.rules.config as { conflictProjection?: "current" | "incoming" } | undefined)?.conflictProjection ?? "current";
    // Attribution is needed only for a choice.
    const { projection, decisions, replaces } = !merged.conflicts.length && !merged.folders.length
      ? { projection: merged.root, decisions: [], replaces: [] }
      : await snapshotDecisions(this.io, candidate.change, head, baseRoot, candidate.root, merged.root, merged.conflicts, merged.folders,
        await this.concurrentChanges(question.base, question.head));
    const response = await checkpointIntent({
      kind: "checkpoint", tree: head.tree, current: { object: current.object, state: current.state }, projection,
      candidate: candidate.root, continueSelected: baseRoot === head.root, conflictProjection,
      change: candidate.change, resolves: [...candidate.resolves, ...replaces], decisions,
    }, this.objects);
    return { result: response.result, reports: response.decisions, evidence: { rule, ...(merged.summary ? { summary: merged.summary } : {}) } };
  }

  /** Attribution for the current side of a snapshot choice: each change
   * accepted after `base` through `head` that touched a path, or a path
   * within or above it. */
  private async concurrentChanges(base: string, head: string) {
    const touched: Array<{ change: string; paths: string[] }> = [];
    for (let at: string | null = head; at && at !== base;) {
      const entry = await this.entry(at);
      if (!entry.previous) break;
      const previous = await this.entry(entry.previous);
      if (CLIENT_CHANGE.test(entry.change))
        touched.unshift({ change: entry.change, paths: await this.changedPaths(at, previous.root, entry.root) });
      at = entry.previous;
    }
    const related = (a: string, b: string) => a === "/" || b === "/" || a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
    return (path: string) => touched.filter((t) => t.paths.some((p) => related(p, path))).map((t) => ({ change: t.change, operation: null }));
  }

  private async changedPaths(hash: string, before: string, after: string): Promise<string[]> {
    let paths = this.changed.get(hash);
    if (!paths) {
      paths = await changedEntryPaths(this.io, before, after);
      this.changed.set(hash, paths);
      this.memoryBytes += paths.reduce((bytes, path) => bytes + 2 * path.length + 32, 64);
    }
    return paths;
  }

  /** Stage every object the answer names that canopyd does not hold. */
  private async export(root: string, decisions: LogDecision[]): Promise<string[]> {
    const roots = [root], raw: string[] = [];
    for (const d of decisions) {
      if (d.range) raw.push(...d.alternatives.map((a) => a.object), ...(d.at ? [d.at] : []));
      else roots.push(...d.alternatives.map((a) => a.object));
    }
    const present = async (hash: string) => !this.memory.has(hash) || await this.stores.shared.has(hash);
    const missing = await absentClosure(this.io, roots, present);
    for (const hash of raw) if (!(await present(hash))) missing.add(hash);
    const values = [...missing].map((hash) => ({ hash, bytes: this.memory.get(hash)! }));
    await this.stores.staging.stage(values);
    return values.map((v) => v.hash);
  }
}

function checkpointDecision(d: LogDecision): CheckpointRequest["decisions"][number] {
  return {
    key: d.key,
    ...(d.path ? { path: d.path } : {}),
    ...(d.range ? { range: d.range } : {}),
    ...(d.at ? { at: d.at } : {}),
    dependencies: d.dependencies,
    selected: d.selected,
    alternatives: d.alternatives,
  };
}
