import { encodeProvenance, entryProvenance, hashObject, rebindProvenance, type ObjectHash, type ProvenanceNode, isPropertyOperation, pageValueJSON, stableJSONString, type PageValue, validateSourceTrace, type SourceFrame, type SourceOperation } from "@ovst/protocol";
import { replayCollectionRows } from "@ovst/collection-schema";
import {
  decodeLogEntry,
  MergeRefusal,
  parseQuestion,
  rawAlternatives,
  type Candidate,
  type LogDecision,
  type LogEntry,
  type MergeAnswer,
  type MergeQuestion,
  type MergeRules,
} from "@ovst/merge-protocol";
import { treeDefaultConfig, type CheckpointRequest, type MergeObjects, type TreeDefaultRules } from "./engine-contract.ts";
import { checkpointIntent, indexedIntent, mergeIntent, stateIndex } from "./intent-engine.ts";
import type { ProvenanceIndexes } from "./provenance.ts";
import type { Node } from "./intent-model.ts";
import { logDecisions } from "./log-decisions.ts";
import { mergeProtocolTrees, type CollectionFieldConflict, type PagePropertyConflict } from "@ovst/tree-merge";
import { lookup, type RetainedState } from "./retained-state.ts";
import { snapshotDecisions } from "./snapshot.ts";
import { absentClosure, changedEntryPaths, type TreeIO } from "./trees.ts";

/** An entry's or a result's retained state: its projection, the engine's
 * state object, and its decisions as a log entry records them. */
interface Cached {
  object: string;
  state: string;
  decisions: LogDecision[];
  /** The entry whose provenance index this state was replayed from; its
   * history covers only what came after. Absent: replayed from a state that
   * covers everything since it. */
  seed?: string;
}

/** Where the sidecar reads accepted objects and writes an answer's new ones.
 * `shared` is overstoryd's store (read-only); `staging` is this question's.
 * `find` returns an object's verified bytes, or null when it is absent; a
 * corrupt object is an error, never bytes (as `ObjectStore.find` does). */
export interface SidecarStores {
  shared: { find(hash: string): Promise<Uint8Array | null>; has(hash: string): Promise<boolean> };
  staging: { find(hash: string): Promise<Uint8Array | null>; stage(values: Array<{ hash: string; bytes: Uint8Array }>): Promise<void> };
  /** Entries' provenance indexes, which overstoryd keeps beside accepted
   * history. Optional: an index it lacks is computed from the nearest one
   * before it, as overstoryd's backfill computes it. */
  provenance?: ProvenanceIndexes;
}

/** Change identities a client can see as contributions. overstoryd's own
 * acceptances (tree creation, pairing, boundary rewrites) are not changes an
 * author made. */
const CLIENT_CHANGE = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * The reference merge sidecar. It answers each question as a deterministic
 * function of objects, provenance indexes and its rules. An entry's state
 * replays from a recent cached state, or starts from the entry's provenance
 * index aligned to the decisions its log entry records (Performance 004);
 * history is never replayed from a chain's start. Everything it keeps is a
 * cache in memory: entry states, computed indexes, and the objects its
 * answers generate.
 */
/** How far back a cached state may be for an entry to replay from it rather
 * than start from its own index. */
const SEED_WITHIN = 8;
/** How long one question may replay entries before the entry it needs starts
 * from its index instead (`OVERSTORYD_MERGE_REPLAY_MS` overrides it). */
export const REPLAY_MILLIS = 10_000;

export class Sidecar {
  private memory = new Map<string, Uint8Array>();
  private memoryBytes = 0;
  /** Engine states by identity, decoded; each is counted in `memoryBytes`
   * by its estimated size. */
  private recorded = new Map<string, RetainedState>();
  /** Index records overstoryd holds, so answers skip them. */
  private readonly heldRecords = new Set<string>();
  private states = new Map<string, Cached>();
  private entries = new Map<string, LogEntry>();
  /** Paths each entry changed from its previous entry's root. Entries are
   * immutable, so this is a cache; it is counted in `memoryBytes`. */
  private changed = new Map<string, string[]>();
  /** Recently solved questions. The next question's head is usually the entry
   * overstoryd recorded from the last answer, and replaying it asks the same
   * question again: the same inputs give the same state, so it is reused. */
  private solved = new Map<string, Cached>();
  /** Entries the current question replayed (a solved question reused counts); a diagnostic. */
  replayed = 0;
  private replayDeadline = Infinity;
  /** Indexes this sidecar computed for entries overstoryd has none for. */
  private computed = new Map<string, ProvenanceNode>();
  /** States the current question started from an entry's index; a diagnostic. */
  seededCount = 0;
  /** Indexes the current question computed itself; a diagnostic. */
  indexedCount = 0;

  constructor(
    private readonly stores: SidecarStores,
    private readonly cacheBytes = 512 * 1024 * 1024,
    /** The snapshot tree merge; replaceable so a test can make it fail. */
    private readonly treeMerge = mergeProtocolTrees,
    /** How long one question may spend replaying entries (see `stateOf`). */
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
    this.computed.clear();
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
    this.seededCount = 0;
    this.indexedCount = 0;
    this.replayDeadline = performance.now() + this.replayMillis;
    const { result, evidence } = await this.solve(question, rules);
    // An authored prefix can hide an unresolved ancestor. Its private state is
    // valid evidence, but its choices are not decisions in an accepted root.
    // Preflight checks execution only; acceptance produces and records choices.
    if (question.validate)
      return { root: result.object, objects: await this.export(result.object, []), decisions: [], evidence };
    const { decisions } = await this.cached(result);
    this.rememberSolved(question, { ...result, decisions });
    const objects = await this.export(result.object, decisions);
    const provenance = await this.exportIndex(result.state);
    return { root: result.object, objects: [...objects, ...provenance.objects], decisions, evidence, provenance: provenance.root };
  }

  /** Stage the provenance index of a result's state, so that overstoryd
   * keeps the engine's own lineage beside the entry it records: the root
   * record, and the records overstoryd does not hold yet. */
  private async exportIndex(state: string): Promise<{ root: ObjectHash; objects: string[] }> {
    const recorded = this.recorded.get(state);
    if (!recorded) throw new Error(`Unrecorded engine state ${state}`);
    const records = new Map<ObjectHash, Uint8Array>();
    const root = encodeProvenance(stateIndex(recorded), (bytes) => {
      const hash = hashObject(bytes);
      records.set(hash, bytes);
      return hash;
    });
    if (this.heldRecords.size > 200_000) this.heldRecords.clear();
    const missing = (await Promise.all([...records].map(async ([hash, bytes]) => {
      if (this.heldRecords.has(hash)) return null;
      if (await this.stores.shared.has(hash)) { this.heldRecords.add(hash); return null; }
      return { hash, bytes };
    }))).filter((v) => v !== null);
    await this.stores.staging.stage(missing);
    return { root, objects: missing.map((v) => v.hash) };
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
  private async solve(question: MergeQuestion, rules: TreeDefaultRules) {
    const head = await this.entry(question.head);
    const base = await this.entry(question.base);
    if (head.tree !== base.tree) throw new MergeRefusal("invalid", "Question entries belong to different trees");
    // The head replays from its basis, which starts from its index when it
    // is not cached.
    const current = await this.stateOf(question.head, rules, question.base);
    let basis: { object: string; state: string } = await this.stateOf(question.base, rules);
    for (const prior of question.prefix ?? []) basis = await this.authored(head.tree, basis, prior, rules);
    const candidate = question.candidate;
    if (candidate.trace === null) return this.snapshot(question, head, basis.object, current);
    if (await this.rowTrace(candidate, head, basis.object)) return this.snapshot(question, head, basis.object, current);
    const evaluated = await this.evaluate(head.tree, basis, question.validate ? basis : current, candidate, rules);
    return { result: evaluated.result, evidence: evaluated.evidence as unknown };
  }

  private rules({ rules }: { rules: MergeRules }): TreeDefaultRules {
    if (rules.id !== "tree-default" || rules.revision !== 1)
      throw new MergeRefusal("unsupported", `Unknown rules: ${rules.id} revision ${rules.revision}`);
    const parsed = treeDefaultConfig.safeParse(rules.config ?? {});
    if (!parsed.success) throw new MergeRefusal("invalid", "Invalid rule configuration");
    return { id: "tree-default", revision: 1, ...(rules.config === undefined ? {} : { config: parsed.data }) };
  }

  /** An entry's retained state. A cached state whose history covers the
   * question's `basis` (given for a head) is used as it is. A head replays
   * the entries after its basis, starting the basis from its index when it
   * is not cached; any other entry replays from a cached state within
   * `SEED_WITHIN` entries, else starts from its own index. Nothing is
   * replayed from a chain's start, and a replay that runs past its budget
   * starts the entry from its index instead. */
  private async stateOf(hash: string, rules: TreeDefaultRules, basis?: string): Promise<Cached> {
    if (basis === hash) basis = undefined;
    const chain: string[] = [];
    let previous: Cached | null = null;
    for (let at: string | null = hash; at;) {
      const cached = this.states.get(at);
      if (cached && await this.covers(cached, at, basis ?? at)) { previous = cached; break; }
      if (at === basis) { previous = await this.stateOf(at, rules); break; }
      chain.push(at);
      at = (await this.entry(at)).previous;
      if (!at || (basis === undefined && chain.length > SEED_WITHIN)) return this.seeded(hash);
    }
    chain.reverse();
    for (const [index, entry] of chain.entries()) {
      if (index > 0 && performance.now() > this.replayDeadline) return this.seeded(hash);
      const seed = previous!.seed;
      previous = { ...(await this.replay(entry, previous!, rules)), ...(seed ? { seed } : {}) };
      this.states.set(entry, previous);
      this.replayed++;
    }
    return previous!;
  }

  /** Whether `cached`, the state of entry `at`, has history covering
   * `basis`: it was not seeded, or its seed is `basis` or before it. `at`
   * is `basis` or after it. */
  private async covers(cached: Cached, at: string, basis: string): Promise<boolean> {
    if (!cached.seed || cached.seed === basis || at === basis) return true;
    for (let walk: string | null = at; walk; walk = (await this.entry(walk)).previous) {
      if (walk === basis) return true;
      if (walk === cached.seed) return false;
    }
    return false;
  }

  /** An entry's state from its provenance index (decision 6: its decisions
   * from the log). An index that does not match the entry's root is
   * replaced by a fresh import of the root. */
  private async seeded(hash: string): Promise<Cached> {
    const entry = await this.entry(hash);
    let imported: Cached;
    try {
      imported = await this.cached(await indexedIntent({ tree: entry.tree, root: entry.root, index: await this.indexOf(hash) }, this.objects));
    } catch (error) {
      if (!(error instanceof MergeRefusal)) throw error;
      process.stderr.write(`Importing ${hash} without its index: ${error.message}\n`);
      imported = await this.checkpoint({ tree: entry.tree, current: { object: entry.root }, projection: entry.root,
        change: entry.change, decisions: entry.decisions, align: true });
    }
    const state = { ...(await this.align(entry, imported)), seed: hash };
    this.states.set(hash, state);
    this.seededCount++;
    return state;
  }

  /** Entries are facts. Ask the entry's question again with its previous
   * entry as the head, as the entry records it; then align to the recorded
   * root and decisions, which a replay under other rules or an overstoryd
   * decision the sidecar did not make can differ from. */
  private async replay(hash: string, previous: Cached, rules: TreeDefaultRules): Promise<Cached> {
    const entry = await this.entry(hash);
    let state: Cached = previous;
    try {
      const asked = entry.asked;
      const question = parseQuestion({
        base: asked?.base ?? entry.previous!,
        head: entry.previous!,
        ...(asked?.prefix ? { prefix: asked.prefix } : {}),
        candidate: {
          root: asked?.candidate ?? entry.trace?.at(-1)?.after ?? entry.root,
          change: entry.change, at: entry.at, trace: entry.trace, resolves: entry.resolves,
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
      if (!(error instanceof MergeRefusal)) throw error;
    }
    return this.align(entry, state);
  }

  /** An entry's provenance index: overstoryd's, or else computed as its
   * backfill computes it, from the nearest earlier entry that has one. */
  private async indexOf(hash: string): Promise<ProvenanceNode> {
    const stored = async (at: string) => this.computed.get(at) ?? await this.stores.provenance?.index(at) ?? null;
    const own = await stored(hash);
    if (own) return own;
    const chain: Array<{ hash: string; entry: LogEntry }> = [];
    let previous: { index: ProvenanceNode; root: string } | null = null;
    for (let at: string | null = hash; at;) {
      const entry = await this.entry(at);
      const index = chain.length ? await stored(at) : null;
      if (index) { previous = { index, root: entry.root }; break; }
      chain.push({ hash: at, entry });
      at = entry.previous;
    }
    const load = async (object: ObjectHash) => this.objects.read(object);
    for (const { hash: at, entry } of chain.reverse()) {
      const rebind = (prior: { index: ProvenanceNode; root: string }) =>
        rebindProvenance(prior.index, prior.root as ObjectHash, entry.root as ObjectHash, entry.change, load);
      const index: ProvenanceNode = entry.asked && previous ? await rebind(previous)
        : await entryProvenance(previous as never, entry as never, load).catch((error) => {
          // A trace the index cannot follow is taken as the snapshot it made.
          if (!previous) throw error;
          return rebind(previous);
        });
      this.computed.set(at, index);
      this.indexedCount++;
      previous = { index, root: entry.root };
    }
    return previous!.index;
  }

  /** Make a state's projection and decisions the entry's. Decisions that
   * already match are kept with their retained detail; the rest are removed
   * and imported from the entry. */
  private async align(entry: LogEntry, from: Cached): Promise<Cached> {
    let state = from;
    if (state.object !== entry.root)
      state = await this.checkpoint({
        tree: entry.tree, current: state, projection: entry.root, change: entry.change,
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
      tree: entry.tree, current: state, projection: entry.root, change: entry.change,
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
    return this.cached(await checkpointIntent(request, this.objects));
  }

  private evaluate(
    tree: string,
    base: { object: string; state: string },
    current: { object: string; state: string },
    candidate: Candidate,
    rules: TreeDefaultRules,
  ) {
    return mergeIntent({
      tree,
      base: { object: base.object, state: base.state },
      current: { object: current.object, state: current.state },
      incoming: {
        change: candidate.change, object: candidate.root, at: candidate.at, trace: candidate.trace ?? [],
        ...(candidate.resolves.length ? { resolves: candidate.resolves } : {}),
      },
      rules,
      ...(candidate.alternatives?.length ? { alternatives: candidate.alternatives } : {}),
    }, this.objects);
  }

  /** Whether a traced candidate is evaluated as properties: every frame
   * holds property operations on rows or pages (spec 10 §4.1), or it carries
   * no frames and resolves only field and property choices. Its trace is
   * checked by exact replay on its basis, and its candidate is then merged
   * like a snapshot, field by field and property by property. */
  private async rowTrace(candidate: Candidate, head: LogEntry, basis: string): Promise<boolean> {
    const trace = candidate.trace ?? [];
    if (!trace.length)
      return candidate.resolves.length > 0 && candidate.resolves.every((key) => head.decisions.some((d) => d.key === key && (d.field || d.property)));
    const rows = trace.map((frame) => frame.operations.every((op) => isPropertyOperation(op as SourceOperation)));
    if (!rows.some(Boolean)) return false;
    if (!rows.every(Boolean))
      throw new MergeRefusal("unsupported", "A trace that mixes property operations with other operations is not supported yet");
    if (trace[0]!.before !== basis) throw new MergeRefusal("invalid", "Trace does not follow its basis");
    if (trace.at(-1)!.after !== candidate.root) throw new MergeRefusal("invalid", "Trace does not end at the candidate");
    try {
      const checked = await validateSourceTrace(trace as SourceFrame[], (hash) => this.objects.read(hash), candidate.at, replayCollectionRows);
      for (const [hash, bytes] of checked.generated) this.remember(hash, bytes);
    } catch (error) {
      if (error instanceof MergeRefusal) throw error;
      throw new MergeRefusal("invalid", error instanceof Error ? error.message : "Invalid property operations");
    }
    return true;
  }

  /** The author's own state after an earlier batch element: its trace
   * evaluated on the basis, or its snapshot checkpointed onto it. */
  private async authored(tree: string, basis: { object: string; state: string }, prior: Candidate, rules: TreeDefaultRules) {
    if (prior.trace !== null && !(prior.trace.length && prior.trace.every((f) => f.operations.every((op) => isPropertyOperation(op as SourceOperation)))))
      return (await this.evaluate(tree, basis, basis, prior, rules)).authored;
    return checkpointIntent({ tree, current: basis, projection: prior.root, change: prior.change, decisions: [] }, this.objects);
  }

  /** A snapshot: a tree merge against the head, then a checkpoint of the
   * projection onto the head's state with a choice for each conflict. */
  private async snapshot(question: MergeQuestion, head: LogEntry, baseRoot: string, current: Cached) {
    const candidate = question.candidate;
    const rule = { id: "tree-default", revision: 1 };
    let merged: { root: string; conflicts: Array<{ path: string }>; folders: string[]; summary?: unknown; fields?: CollectionFieldConflict[]; properties?: PagePropertyConflict[] };
    if (candidate.root === head.root || candidate.root === baseRoot) merged = { root: head.root, conflicts: [], folders: [] };
    else if (head.root === baseRoot) merged = { root: candidate.root, conflicts: [], folders: [] };
    else {
      try {
        const result = await this.treeMerge(baseRoot, candidate.root, head.root, (hash) => this.objects.read(hash));
        for (const [hash, bytes] of result.objects) this.remember(hash, bytes);
        merged = { root: result.root, conflicts: result.conflicts, folders: result.unresolvedDirectories ?? [],
          ...(result.summary ? { summary: result.summary } : {}), ...(result.fields ? { fields: result.fields } : {}),
          ...(result.properties ? { properties: result.properties } : {}) };
      } catch (error) {
        // Ordinary content is preserved as a whole-root choice that keeps the current tree.
        process.stderr.write(`Tree merge failed; preserving ambiguity: ${error instanceof Error ? error.message.split("\n")[0] : "invalid result"}\n`);
        merged = { root: head.root, conflicts: [{ path: "/" }], folders: ["/"] };
      }
    }
    const conflictProjection = (question.rules.config as { conflictProjection?: "current" | "incoming" } | undefined)?.conflictProjection ?? "current";
    // Attribution is needed only for a choice.
    const concurrent = merged.conflicts.length || merged.folders.length || merged.fields?.length || merged.properties?.length
      ? await this.concurrentChanges(question.base, question.head) : undefined;
    const { projection, decisions, replaces } = !merged.conflicts.length && !merged.folders.length
      ? { projection: merged.root, decisions: [] as LogDecision[], replaces: [] as string[] }
      : await snapshotDecisions(this.io, candidate.change, head, baseRoot, candidate.root, merged.root, merged.conflicts, merged.folders, concurrent!);
    // A field both sides set differently is a choice about that field. A
    // field inside a folder another choice is about is part of that choice.
    for (const conflict of merged.fields ?? []) {
      const path = conflict.path === "/" ? [] : conflict.path.slice(1).split("/");
      if (decisions.some((d) => !d.path || (!rawAlternatives(d) && d.path.every((name, i) => path[i] === name)))) continue;
      const value = (v: unknown) => {
        const bytes = new TextEncoder().encode(stableJSONString(v ?? null)), hash = hashObject(bytes);
        this.remember(hash, bytes);
        return hash;
      };
      const scope = { model: conflict.table, key: conflict.row, field: conflict.field };
      decisions.push({
        key: `field:${candidate.change}:${hashObject(new TextEncoder().encode(stableJSONString([conflict.path, scope]))).slice(7, 39)}`,
        path, field: scope, selected: 0, dependencies: [],
        alternatives: [
          { object: value(conflict.current), contributions: concurrent!(conflict.path) },
          { object: value(conflict.candidate), contributions: [{ change: candidate.change, operation: null }] },
        ],
      });
    }
    // A page property both sides set differently is a choice about that
    // property, unless another choice already covers its page.
    for (const conflict of merged.properties ?? []) {
      const path = conflict.path.slice(1).split("/");
      if (decisions.some((d) => !d.path || (!rawAlternatives(d) && d.path.every((name, i) => path[i] === name)))) continue;
      const value = (v: PageValue | null) => {
        const bytes = new TextEncoder().encode(stableJSONString(v === null ? null : pageValueJSON(v))), hash = hashObject(bytes);
        this.remember(hash, bytes);
        return hash;
      };
      decisions.push({
        key: `property:${candidate.change}:${hashObject(new TextEncoder().encode(stableJSONString([conflict.path, conflict.property]))).slice(7, 39)}`,
        path, property: conflict.property, selected: 0, dependencies: [],
        alternatives: [
          { object: value(conflict.current), contributions: concurrent!(conflict.path) },
          { object: value(conflict.candidate), contributions: [{ change: candidate.change, operation: null }] },
        ],
      });
    }
    const result = await checkpointIntent({
      tree: head.tree, current: { object: current.object, state: current.state }, projection,
      candidate: candidate.root, continueSelected: baseRoot === head.root, conflictProjection,
      change: candidate.change, resolves: [...candidate.resolves, ...replaces], decisions,
    }, this.objects);
    return { result, evidence: { rule, ...(merged.summary ? { summary: merged.summary } : {}) } };
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

  /** Stage every object the answer names that overstoryd does not hold. */
  private async export(root: string, decisions: LogDecision[]): Promise<string[]> {
    const roots = [root], raw: string[] = [];
    for (const d of decisions) {
      if (rawAlternatives(d)) raw.push(...d.alternatives.map((a) => a.object), ...(d.at ? [d.at] : []));
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

