import { hashObject, stableJSONString } from "@overstory/protocol";
import {
  decodeLogEntry,
  MergeRefusal,
  parseQuestion,
  type Candidate,
  type LogDecision,
  type LogEntry,
  type MergeAnswer,
  type MergeQuestion,
  type MergeRules,
} from "@overstory/merge-protocol";
import { EvaluationFailure, treeDefaultConfig, type CheckpointRequest, type IntentRequest, type MergeObjects } from "./engine-contract.ts";
import { checkpointIntent, mergeIntent } from "./intent-engine.ts";
import { IntentError, type Node } from "./intent-model.ts";
import { logDecisions } from "./log-decisions.ts";
import { mergeWireTrees } from "@overstory/tree-merge";
import { decodeRetainedState, encodeRetainedState, lookup, type RetainedState } from "./retained-state.ts";
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
  /** Where the sidecar saves some entries' states, so that a restart replays
   * from the nearest saved entry instead of the chain's start. Optional, and
   * a cache like the rest: anything missing or unreadable is replayed. */
  saved?: SavedStates;
}

/** Saved entry states, one value per entry, grouped by tree. */
export interface SavedStates {
  list(): Promise<Array<{ tree: string; entry: string; savedAt: number }>>;
  read(tree: string, entry: string): Promise<Uint8Array | null>;
  write(tree: string, entry: string, bytes: Uint8Array): Promise<void>;
  remove(tree: string, entry: string): Promise<void>;
}

/** A tree's head state is saved once this many of its entries were replayed
 * since its last save, and the newest `SAVES_KEPT` saves per tree are kept:
 * a restart replays at most about `SAVE_AFTER` entries more than a warm
 * sidecar would. */
const SAVE_AFTER = 32;
const SAVES_KEPT = 2;
const SAVED_FORMAT = "arbor-merge-saved-entry";

/** Change identities a client can see as contributions. canopyd's own
 * acceptances (tree creation, pairing, boundary rewrites) are not changes an
 * author made. */
const CLIENT_CHANGE = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * The reference merge sidecar. It answers each question as a deterministic
 * function of objects and its rules. Everything it keeps is a cache: engine
 * states for log entries, rebuilt by replaying entries from each chain's
 * start (trace, then align to the accepted root and decisions), and the
 * objects its answers generate, all held in memory only. A cache wipe
 * changes no answer.
 *
 * With a `saved` store it also writes some entries' states, after answering
 * (`save`), and reads them back when replay reaches one. A saved state is the
 * state replay built, byte for byte, so this too changes no answer.
 */
/** How long one question may replay history before it answers retryably
 * (`ARBOR_MERGE_REPLAY_MS` overrides it). With canopyd's evaluation budget
 * it stays inside canopyd's 30-second timeout. */
export const REPLAY_MILLIS = 10_000;

export class Sidecar {
  private memory = new Map<string, Uint8Array>();
  private memoryBytes = 0;
  /** Engine states by identity, decoded; each is counted in `memoryBytes`
   * by its estimated size. */
  private recorded = new Map<string, RetainedState>();
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
  /** Entries the current question read back from saved states; a diagnostic. */
  restored = 0;
  /** Saved entries by hash, listed once; kept across `clear`. */
  private savedEntries?: Map<string, { tree: string; savedAt: number }>;
  /** Entries replayed per tree since its last save. */
  private unsaved = new Map<string, number>();
  /** The last question's head, whose state `save` may write. */
  private lastHead?: string;

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
    this.recorded.clear();
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
    states: {
      get: (id) => this.recorded.get(id),
      set: (id, value) => {
        if (this.recorded.has(id)) return;
        this.recorded.set(id, value);
        this.memoryBytes += value.bytes;
      },
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
    this.restored = 0;
    this.lastHead = question.head;
    this.replayDeadline = performance.now() + this.replayMillis;
    const { result, evidence } = await this.solve(question, rules);
    const { decisions } = await this.cached(result);
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
    return { result: evaluated.result, evidence: evaluated.evidence as unknown };
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
    while (at && !this.states.has(at) && !(await this.restore(at))) {
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
      const tree = (await this.entry(entry)).tree;
      this.unsaved.set(tree, (this.unsaved.get(tree) ?? 0) + 1);
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
        change: entry.change, decisions: entry.decisions, align: true,
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
        state = await this.cached(solved.result);
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

  /** Save the last question's head state if its tree replayed enough since
   * its last save, and drop that tree's older saves. Called after answering;
   * a failure here affects no answer. */
  async save(): Promise<void> {
    const saved = this.stores.saved, head = this.lastHead;
    if (!saved || !head) return;
    const cached = this.states.get(head), tree = (await this.entry(head)).tree;
    if (!cached || (this.unsaved.get(tree) ?? 0) < SAVE_AFTER) return;
    // The state and every state its decisions name, and the objects they
    // name that only this sidecar holds.
    const states: Record<string, unknown> = {};
    for (const pending = [cached.state]; pending.length;) {
      const id = pending.pop()!;
      if (states[id]) continue;
      const retained = this.recorded.get(id);
      if (!retained) return;
      states[id] = encodeRetainedState(retained);
      for (const decision of retained.decisions) {
        if (decision.context) pending.push(decision.context);
        for (const alternative of decision.alternatives) pending.push(alternative.state);
      }
    }
    const named = new Set(JSON.stringify(states).match(/sha256:[a-f0-9]{64}/g) ?? []);
    const objects: Array<[string, string]> = [];
    for (const hash of named) {
      const bytes = this.memory.get(hash);
      if (bytes && !(await this.stores.shared.has(hash))) objects.push([hash, Buffer.from(bytes).toString("base64")]);
    }
    const value = { format: SAVED_FORMAT, tree, entry: head, object: cached.object, state: cached.state, decisions: cached.decisions, states, objects };
    await saved.write(tree, head, new TextEncoder().encode(JSON.stringify(value)));
    const index = await this.savedIndex();
    index.set(head, { tree, savedAt: Date.now() });
    this.unsaved.set(tree, 0);
    const older = [...index].filter(([entry, s]) => s.tree === tree && entry !== head).sort((a, b) => b[1].savedAt - a[1].savedAt);
    for (const [entry] of older.slice(SAVES_KEPT - 1)) {
      index.delete(entry);
      await saved.remove(tree, entry);
    }
  }

  private async savedIndex() {
    if (!this.savedEntries) {
      this.savedEntries = new Map();
      for (const { tree, entry, savedAt } of (await this.stores.saved?.list()) ?? []) this.savedEntries.set(entry, { tree, savedAt });
    }
    return this.savedEntries;
  }

  /** Read an entry's saved state into the cache. Anything unreadable, or
   * whose states or objects do not match their identities, is removed and
   * replayed instead. */
  private async restore(hash: string): Promise<boolean> {
    const saved = this.stores.saved;
    if (!saved) return false;
    const index = await this.savedIndex(), known = index.get(hash);
    if (!known) return false;
    try {
      const bytes = await saved.read(known.tree, hash);
      if (!bytes) throw new Error("Saved state is missing");
      const value = JSON.parse(new TextDecoder().decode(bytes)) as {
        format: string; tree: string; entry: string; object: string; state: string; decisions: LogDecision[];
        states: Record<string, unknown>; objects: Array<[string, string]>;
      };
      if (value.format !== SAVED_FORMAT || value.entry !== hash || value.tree !== known.tree || !value.states[value.state])
        throw new Error("Saved state does not match its entry");
      const decoded = Object.entries(value.states).map(([id, encoded]) => {
        const { id: actual, state } = decodeRetainedState(encoded);
        if (actual !== id || state.tree !== value.tree) throw new Error("Saved state does not match its identity");
        return [id, state] as const;
      });
      const objects = value.objects.map(([object, base64]) => {
        const bytes = new Uint8Array(Buffer.from(base64, "base64"));
        if (hashObject(bytes) !== object) throw new Error("Saved object does not match its hash");
        return [object, bytes] as const;
      });
      if (this.states.has(hash)) return true;
      for (const [id, state] of decoded) this.objects.states.set(id, state);
      for (const [object, bytes] of objects) this.remember(object, bytes);
      this.states.set(hash, { object: value.object, state: value.state, decisions: value.decisions });
      this.restored++;
      return true;
    } catch (error) {
      process.stderr.write(`Discarding a saved state: ${error instanceof Error ? error.message : String(error)}\n`);
      index.delete(hash);
      await saved.remove(known.tree, hash).catch(() => {});
      return false;
    }
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
      decisions: entry.decisions.filter((d) => !kept.has(d.key)),
      align: true,
    });
  }

  /** A result as the cache keeps it: with its recorded state's decisions as
   * a log entry records them. */
  private async cached(result: { object: string; state: string }): Promise<Cached> {
    const recorded = this.recorded.get(result.state);
    if (!recorded) throw new Error(`Unrecorded engine state ${result.state}`);
    const nodeOf = (id: string) => lookup(recorded.nodes, id) as Node | undefined;
    return { ...result, decisions: await logDecisions(this.io, result.object, recorded.decisions, nodeOf) };
  }

  private async checkpoint(request: CheckpointRequest): Promise<Cached> {
    const response = await checkpointIntent(request, this.objects);
    return this.cached(response.result);
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
    return { result: response.result, evidence: { rule, ...(merged.summary ? { summary: merged.summary } : {}) } };
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
