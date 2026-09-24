import { loadIntentState } from "@overstory/canopyd-merge";
import { Database } from "bun:sqlite";
import { stableJSONString } from "@overstory/protocol";
import {
  hashObject,
  decodeWireDirectory,
  type AcceptedUpdate,
  type CandidateUpdate,
  type InspectedDecision,
  type MaterialRef,
  type SourceOperation,
} from "@overstory/protocol";
import { MergeTool } from "../merge-tool.ts";
import { MergeStateStore, type MergeStateRecord } from "./merge-state-store.ts";
import { AcceptedUpdateStore } from "./store.ts";
import {
  type IntentRequest,
  type IntentRequestInput,
  type IntentResponse,
} from "@overstory/canopyd-merge";
const encoder = new TextEncoder();
const id = (value: unknown) =>
  hashObject(encoder.encode(stableJSONString(value))).slice(7);
export type StateRef = { object: string; state: string };
export type Evaluated = Extract<IntentResponse, { outcome: "evaluated" }>;
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
  constructor(
    db: Database,
    private tool: MergeTool,
    private read: (
      hash: string,
      objects: ReadonlyMap<string, Uint8Array>
    ) => Promise<Uint8Array>
  ) {
    this.store = new MergeStateStore(db);
    this.updates = new AcceptedUpdateStore(db);
  }
  /** The merge state an accepted update recorded. Every accepted update has
   * one (schema 18). */
  state(update: AcceptedUpdate): StateRef {
    const record = this.store.get(update.id);
    if (!record) throw new Error(`Accepted update ${update.id} has no merge state`);
    return { object: update.root, state: record.state };
  }

  /** Open decisions at an accepted update. */
  openDecisions(update: AcceptedUpdate): number {
    return this.store.get(update.id)?.decisions.length ?? 0;
  }

  /** The merge state of an acceptance the host makes itself (a tree's first
   * root, pairing, a nested-tree boundary): `root` checkpointed onto `from`'s
   * state, or imported as the tree's first state when there is no `from`.
   * Generated objects join `objects`; the caller stores them before commit. */
  async checkpoint(
    tree: string,
    from: AcceptedUpdate | null,
    root: string,
    change: string,
    objects: Map<string, Uint8Array>
  ): Promise<MergeStateRecord> {
    const current = from ? this.state(from) : { object: root };
    const evaluated = await this.tool.evaluate({ kind: "checkpoint", tree, current, projection: root, change, decisions: [] }, objects);
    for (const [hash, bytes] of evaluated.objects) objects.set(hash, bytes);
    const result = evaluated.response.result;
    return this.record(tree, result, result, { change, candidate: root, trace: null, resolves: [] }, objects, null);
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
        const decision = this.store.get(material.state)?.decisions.find(
          (d) => d.inspection.id === material.conflict
        );
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
    const input: IntentRequestInput = {
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
    request: MergeStateRecord["request"],
    objects: Map<string, Uint8Array>,
    evidence: Evaluated["evidence"] | null
  ): Promise<MergeStateRecord> {
    const state = this.tool.validatedState(tree, result)
      ?? await loadIntentState(result.state, (hash) => this.read(hash, objects));
    if (state.tree !== tree) throw new Error("Merge state tree mismatch");
    const decisionID = (key: string) => id([tree, "decision", key]);
    const path = (nodeID: string) => {
      const names: string[] = [];
      let node = state.nodes[nodeID];
      const seen = new Set<string>();
      while (node?.parent !== null) {
        if (!node || seen.has(node.id))
          throw new Error("Invalid decision path");
        seen.add(node.id);
        names.unshift(node.name);
        node = state.nodes[node.parent!];
      }
      return "/" + names.join("/");
    };
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
    const decisions = await Promise.all(state.decisions.map(async (d) => {
      const node = d.placement ? state.nodes[d.placement.node] : undefined;
      const affected: MaterialRef[] =
        node && node.active && !d.context
          ? [
              {
                material: {
                  kind: "basis",
                  path: path(node.id),
                  object: await projectedFile(path(node.id)),
                },
                range: [
                  d.placement!.anchor,
                  d.placement!.anchor +
                    d.placement!.pieces.reduce((n, p) => n + p.length, 0),
                ],
              },
            ]
          : [
              d.subject ?? {
                material: { kind: "basis", path: "/", object: result.object },
              },
            ];
      const alternatives = d.alternatives.map((a, index) => ({
        id: id([tree, "alternative", d.key, index]),
        revision: id([a.object, a.state, a.contributions]),
        value:
          d.kind === "existence"
            ? a.node ? { file: a.object } : { absent: true as const }
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
          : node
          ? path(node.id)
          : "/"
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
    await this.tool.verifyRetention([result.state, authored.state], objects);
    return {
      state: result.state,
      authored: authored.state,
      decisions,
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
      const decision = record?.decisions.find((d) => d.inspection.id === guard.conflict);
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
