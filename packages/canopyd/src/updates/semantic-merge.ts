import { MAX_CHECKPOINT_BATCH, CheckpointBatchLimitError, type CheckpointRequest, type DecisionReport, type IntentEvaluation, type IntentRequest } from "@overstory/merge-protocol";
import { Database } from "bun:sqlite";
import { stableJSONString } from "@overstory/protocol";
import {
  hashObject,
  encodeWireDirectory,
  decodeWireDirectory,
  type AcceptedUpdate,
  type CandidateUpdate,
  type InspectedDecision,
  type MaterialRef,
  type SourceOperation,
} from "@overstory/protocol";
import { MergeTool } from "../merge-tool.ts";
import { MergeStateStore, type MergeStateRecord } from "./merge-state-store.ts";
import { ConflictStore, decisionPath } from "./conflict-store.ts";
import { AcceptedUpdateStore } from "./store.ts";
import { SourceIntentStore } from "./source-intent-store.ts";
const encoder = new TextEncoder();
const id = (value: unknown) =>
  hashObject(encoder.encode(stableJSONString(value))).slice(7);
export type StateRef = { object: string; state: string };
export type Evaluated = IntentEvaluation;
function operationReferences(op: SourceOperation): MaterialRef[] {
  if (op.kind === "addEntry") return [op.destination.parent];
  const refs = [op.source];
  if (op.kind === "editSource")
    refs.push(...(op.lineage ?? []).map((l) => l.source));
  if (op.kind === "moveSource" || op.kind === "copySource") refs.push(op.at);
  if (op.kind === "moveEntry" || op.kind === "copyEntry")
    refs.push(op.destination.parent);
  if (op.kind === "replaceEntry" && "material" in op.value) refs.push(op.value);
  return refs;
}
/** Authority adapter only: authorization, accepted identities and immutable graph closure.
 * Operation execution and snapshot correspondence live in the merge package. */
export class SemanticMerge {
  readonly store: MergeStateStore;
  readonly updates: AcceptedUpdateStore;
  private readonly checkpoints = new Map<string, StateRef>();
  constructor(
    private db: Database,
    private tool: MergeTool,
    private read: (
      hash: string,
      objects: ReadonlyMap<string, Uint8Array>
    ) => Promise<Uint8Array>,
    private persist: (
      objects: Array<{ hash: string; bytes: Uint8Array }>
    ) => Promise<void>
  ) {
    this.store = new MergeStateStore(db);
    this.updates = new AcceptedUpdateStore(db);
  }
  private async legacyDecisions(
    update: AcceptedUpdate,
    objects: Map<string, Uint8Array>
  ): Promise<CheckpointRequest["decisions"]> {
    const result: CheckpointRequest["decisions"] = [];
    const replace = async (
      root: string,
      path: string[],
      value: Record<string, unknown>
    ): Promise<string> => {
      if (!path.length) {
        if (typeof value.directory !== "string")
          throw new Error("Root alternative is not a directory");
        return value.directory;
      }
      const directory = decodeWireDirectory(await this.read(root, objects)),
        name = path[0]!;
      const prior = directory.entries.find((e) => e.name === name);
      const entry =
        path.length === 1
          ? "absent" in value
            ? null
            : { name, ...value }
          : {
              name,
              directory: await replace(
                prior?.directory ?? "",
                path.slice(1),
                value
              ),
            };
      directory.entries = directory.entries.filter((e) => e.name !== name);
      if (entry)
        directory.entries.push(entry as typeof directory.entries[number]);
      directory.entries.sort((a, b) =>
        Buffer.compare(Buffer.from(a.name), Buffer.from(b.name))
      );
      const bytes = encodeWireDirectory(directory),
        hash = hashObject(bytes);
      objects.set(hash, bytes);
      return hash;
    };
    const legacy = new ConflictStore(this.db).get(update.id)?.decisions ?? [];
    for (const decision of legacy) {
      const alternatives = [];
      for (const alternative of decision.alternatives)
        alternatives.push({
          object: await replace(
            update.root,
            decision.root ? [] : decisionPath(decision).slice(1).split("/"),
            alternative.value
          ),
          contributions: alternative.contributions,
        });
      result.push({
        key: decision.id,
        dependencies: legacy
          .filter(
            (child) =>
              child.id !== decision.id &&
              (decision.root ||
                decisionPath(child).startsWith(decisionPath(decision) + "/"))
          )
          .map((child) => child.id),
        // Files, or a file against its deletion, stay choices about that path.
        ...(!decision.root &&
        decision.alternatives.every((a) => "file" in a.value || "absent" in a.value) &&
        decision.alternatives.some((a) => "file" in a.value)
          ? { path: decisionPath(decision).slice(1).split("/") }
          : {}),
        selected: decision.alternatives.findIndex(
          (a) => a.id === decision.selected
        ),
        alternatives,
      });
    }
    return result;
  }
  remember(accepted: string, state: StateRef) {
    this.checkpoints.set(accepted, state);
    if (this.checkpoints.size > 256)
      this.checkpoints.delete(this.checkpoints.keys().next().value!);
  }
  /** The worker state after an accepted update. Missing states are rebuilt
   * from the nearest retained or cached ancestor, in accepted order: an update
   * canopyd fast-forwarded without the worker replays its own trace, and any
   * other update is checkpointed as its accepted projection. */
  async state(
    update: AcceptedUpdate,
    objects: Map<string, Uint8Array>
  ): Promise<StateRef> {
    // One build per tree at a time: a later build then starts from the states
    // an earlier one recorded instead of replaying the same history again.
    const previous = this.building.get(update.tree) ?? Promise.resolve();
    const built = previous.catch(() => {}).then(() => this.build(update, objects));
    const tail = built.catch(() => {});
    this.building.set(update.tree, tail);
    void tail.then(() => { if (this.building.get(update.tree) === tail) this.building.delete(update.tree); });
    return built;
  }
  private readonly building = new Map<string, Promise<unknown>>();
  private async build(
    update: AcceptedUpdate,
    objects: Map<string, Uint8Array>
  ): Promise<StateRef> {
    const pending: AcceptedUpdate[] = [];
    let cursor: AcceptedUpdate | null = update;
    let prior: {object: string; state?: string} | undefined;
    while (cursor) {
      const cached = this.checkpoints.get(cursor.id);
      const retained = this.store.get(cursor.id);
      if (cached || retained) {
        prior = cached ?? {object: cursor.root, state: retained!.state};
        break;
      }
      pending.push(cursor);
      cursor = cursor.previous ? this.updates.get(cursor.previous.id) : null;
    }
    pending.reverse();
    let current: {object: string; state?: string} = prior ?? {object: pending[0]!.root};
    let offset = 0;
    while (offset < pending.length) {
      const replayed = current.state ? await this.replay(update.tree, current as StateRef, pending[offset]!, objects) : null;
      if (replayed) {
        current = replayed;
        offset++;
        continue;
      }
      // Checkpoint the run of updates up to the next replayable one.
      let end = offset + 1;
      while (end < pending.length && end - offset < MAX_CHECKPOINT_BATCH && !this.fastForwarded(pending[end]!)) end++;
      let size = end - offset;
      for (;;) {
        const slice = pending.slice(offset, offset + size);
        const inputs = new Map(objects), steps = [];
        for (const accepted of slice) steps.push({
          projection: accepted.root,
          change: this.updates.changeForAccepted(accepted.id) ?? `accepted-${accepted.id}`,
          decisions: await this.legacyDecisions(accepted, inputs),
        });
        try {
          const evaluated = await this.tool.evaluate({kind: "checkpoint-batch", tree: update.tree, current, steps}, inputs);
          // Persist only this slice and original inputs, never its growing prefix.
          await this.persist([...inputs, ...evaluated.objects].map(([hash,bytes]) => ({hash,bytes})));
          for (let index = 0; index < slice.length; index++)
            this.remember(slice[index]!.id, evaluated.response.checkpoints[index]!);
          current = evaluated.response.result;
          offset += size;
          break;
        } catch (error) {
          if (!(error instanceof CheckpointBatchLimitError) || size === 1) throw error;
          size = Math.max(1, Math.floor(size / 2));
        }
      }
    }
    return current as StateRef;
  }

  /** An update whose retained trace explains it exactly: accepted on its own
   * basis, at its own candidate. */
  private fastForwarded(update: AcceptedUpdate) {
    const intent = new SourceIntentStore(this.db).forAccepted(update.id);
    return intent && update.previous?.root === intent.basisRoot && update.root === intent.candidateRoot && intent.trace.length
      ? intent : null;
  }

  /** Replay a fast-forwarded update's own trace on the worker state before
   * it, and record the result. Null when it is not one, or when the worker
   * cannot reproduce the accepted root; the caller then checkpoints it. */
  private async replay(
    tree: string,
    basis: StateRef,
    update: AcceptedUpdate,
    objects: Map<string, Uint8Array>
  ): Promise<StateRef | null> {
    const intent = this.fastForwarded(update);
    if (!intent) return null;
    const request = { change: intent.change, candidate: update.root, trace: intent.trace, resolves: [] } as unknown as CandidateUpdate;
    let evaluated: Evaluated;
    const local = new Map(objects);
    try {
      evaluated = await this.evaluate(tree, basis, basis, request, local);
    } catch (error) {
      if (process.env.NODE_ENV !== "test") console.warn(JSON.stringify({ event: "catch-up-replay", update: update.id, error: error instanceof Error ? error.message.split("\n")[0] : String(error) }));
      return null;
    }
    if (evaluated.result.object !== update.root || evaluated.decisions.length) {
      if (process.env.NODE_ENV !== "test") console.warn(JSON.stringify({ event: "catch-up-replay", update: update.id, error: "Replay does not reproduce the accepted root" }));
      return null;
    }
    // Only what the replay generated: the caller's inputs are not accepted.
    const generated = [...local].filter(([hash]) => !objects.has(hash));
    await this.persist(generated.map(([hash, bytes]) => ({ hash, bytes })));
    for (const [hash, bytes] of generated) objects.set(hash, bytes);
    const record = await this.record(tree, evaluated.result, evaluated.authored, [], request, objects, evaluated.evidence);
    this.store.insertCaughtUp(update.id, record);
    this.remember(update.id, evaluated.result);
    return evaluated.result;
  }

  async evaluate(
    tree: string,
    basis: StateRef,
    current: StateRef,
    request: CandidateUpdate,
    objects: Map<string, Uint8Array>,
    resolves: string[] = []
  ) {
    const alternatives: NonNullable<IntentRequest["alternatives"]> = [];
    for (const frame of request.trace ?? [])
      for (const operation of frame.operations)
      for (const ref of operationReferences(operation)) {
        if (ref.material.kind !== "alternative") continue;
        const material = ref.material,
          owner = this.updates.get(material.state);
        if (!owner || owner.tree !== tree)
          throw new Error(
            "Alternative belongs to another tree or unavailable state"
          );
        const previous = new ConflictStore(this.db)
          .get(material.state)
          ?.decisions.find((d) => d.id === material.conflict);
        const retained = this.store.get(material.state),
          decision =
            retained?.decisions.find(
              (d) => d.inspection.id === material.conflict
            ) ??
            (previous ? { key: previous.id, inspection: previous } : undefined);
        const index =
          decision?.inspection.alternatives.findIndex(
            (a) => a.id === material.alternative
          ) ?? -1;
        const value = decision?.inspection.alternatives[index]?.value;
        if (
          !decision ||
          !value ||
          (!("file" in value) && !("directory" in value))
        )
          throw new Error("Alternative material is unavailable");
        const binding = {
          ref: { material },
          decision: decision.key,
          alternative: index,
          value:
            "file" in value
              ? { object: value.file, kind: "file" as const }
              : { object: value.directory, kind: "directory" as const },
        };
        if (
          !alternatives.some(
            (a) => stableJSONString(a.ref) === stableJSONString(binding.ref)
          )
        )
          alternatives.push(binding);
      }
    const input: IntentRequest = {
      kind: "tree",
      tree,
      base: basis,
      current,
      incoming: {
        change: request.change,
        object: request.candidate,
        // The client's own frames, as authored. A snapshot carries no evidence
        // and reaches the engine as an empty chain.
        trace: request.trace ?? [],
        ...(resolves.length ? { resolves } : {}),
      },
      rules: {
        id: "tree-default",
        revision: 1,
        config: { contentChoices: this.tool.contentChoices, conflictProjection: "current", maxMillis: this.tool.evaluationMillis },
      },
      ...(alternatives.length ? { alternatives } : {}),
    };
    const evaluated = await this.tool.evaluate(input, objects);
    for (const [hash, bytes] of evaluated.objects) objects.set(hash, bytes);
    return evaluated.response;
  }
  async record(
    tree: string,
    result: StateRef,
    authored: StateRef,
    reports: readonly DecisionReport[],
    request: CandidateUpdate,
    objects: Map<string, Uint8Array>,
    evidence: Evaluated["evidence"] | null
  ): Promise<MergeStateRecord> {
    const legacy = new Map(
      (reports.length ? new ConflictStore(this.db)
        .forTree(tree)
        .flatMap((row) => row.state.decisions.map((d) => [d.id, d] as const)) : [])
    );
    const decisionID = (key: string) =>
      legacy.has(key) ? key : id([tree, "decision", key]);
    const projectedFile = async (path: string) => {
      let object = result.object;
      for (const name of path.slice(1).split("/")) {
        const directory = decodeWireDirectory(await this.read(object, objects));
        const entry = directory.entries.find(e => e.name === name);
        if (!entry || !(entry.file ?? entry.directory)) throw new Error("Decision placement is absent");
        object = (entry.file ?? entry.directory)!;
      }
      return object;
    };
    const decisions = await Promise.all(reports.map(async (d) => {
      const affected: MaterialRef[] =
        d.placement?.path && d.placement.range
          ? [
              {
                material: {
                  kind: "basis",
                  path: d.placement.path,
                  object: await projectedFile(d.placement.path),
                },
                range: d.placement.range,
              },
            ]
          : [
              d.subject ?? {
                material: { kind: "basis", path: "/", object: result.object },
              },
            ];
      const alternatives = d.alternatives.map((a, index) => ({
        id:
          legacy.get(d.key)?.alternatives[index]?.id ??
          id([tree, "alternative", d.key, index]),
        revision: id([a.object, a.state, a.contributions]),
        value:
          d.kind === "existence"
            ? a.present ? { file: a.object } : { absent: true as const }
            : d.kind === "content" ? { file: a.object } : { directory: a.object },
        contributions: [
          ...new Map(
            a.contributions.map((c) => [stableJSONString(c), c])
          ).values(),
        ],
      }));
      const entry = (d.kind === "content" && d.placement && !d.subject?.range) || d.kind === "existence";
      const logical = entry
        ? d.subject?.material.kind === "basis"
          ? d.subject.material.path
          : d.placement?.path ?? "/"
        : "/";
      const parts = logical.slice(1).split("/"),
        name = parts.pop()!;
      const parent: MaterialRef = {
        material: { kind: "basis", path: "/", object: result.object },
        ...(parts.length ? { within: parts } : {}),
      };
      const inspection: InspectedDecision = {
        id: decisionID(d.key),
        kind: entry ? "entry" : d.kind,
        affected: entry ? [parent] : affected,
        selected: alternatives[d.selected]!.id,
        alternatives: entry
          ? alternatives.map((a) => "absent" in a.value ? a : { ...a, placement: { parent, name } })
          : alternatives,
        dependencies: d.dependencies.map(decisionID),
        actions: ["resolveConflict"],
      };
      return { key: d.key, inspection };
    }));
    return {
      state: result.state,
      authored: authored.state,
      decisions,
      retention: { version: 1, roots: [...new Set([result.state, authored.state])] },
      evidence,
      request: {
        change: request.change,
        candidate: request.candidate,
        trace: request.trace,
        resolves: request.resolves,
      },
    };
  }
  guards(current: AcceptedUpdate, request: CandidateUpdate): string[] | null {
    const record = this.store.get(current.id);
    const keys: string[] = [];
    for (const guard of request.resolves) {
      const previous = new ConflictStore(this.db)
        .get(current.id)
        ?.decisions.find((d) => d.id === guard.conflict);
      const decision =
        record?.decisions.find((d) => d.inspection.id === guard.conflict) ??
        (previous ? { key: previous.id, inspection: previous } : undefined);
      if (
        guard.state !== current.id ||
        !decision ||
        stableJSONString([...guard.alternatives].sort()) !==
          stableJSONString(
            decision.inspection.alternatives.map((a) => a.id).sort()
          )
      )
        return null;
      keys.push(decision.key);
    }
    if (request.trace === null && request.candidate !== current.root) {
      const guarded = new Set(keys);
      for (const key of keys) {
        const decision = record?.decisions.find((d) => d.key === key);
        if (
          decision?.inspection.dependencies.some(
            (id) =>
              !record!.decisions.some(
                (d) => d.inspection.id === id && guarded.has(d.key)
              )
          )
        )
          return null;
      }
    }
    return keys;
  }
}
