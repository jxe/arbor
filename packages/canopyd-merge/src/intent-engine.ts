import { isEditableState, loadEditableIntentState, loadIntentState, loadLazyIntentState, storeLazyIntentState } from "./state-storage.ts";
import { cloneHistory, need, since, union } from "./history-view.ts";
import type { MapProof, StateMapValidationCache } from "./state-map.ts";
import { stableJSONString } from "@overstory/protocol";
import { encodeJSON } from "./state-value.ts";
import {
  decodeWireDirectory,
  encodeWireDirectory,
  hashObject,
  type MaterialRef,
  type SourceOperation,
  type WireDirectory,
} from "@overstory/protocol";
import type { MergeObjects } from "./index.ts";
import {
  IntentError,
  alternativeKey,
  changeIdentity,
  keyOf,
  parseIntentRequest,
  traceOperations,
  type Effect,
  type IntentRequest,
  type IntentRequestInput,
  type IntentDecision,
  type IntentResponse,
  type IntentState,
  type Material,
  type Node,
  type Piece,
  type View,
} from "./intent-model.ts";

import {
  evaluateFormat,
  evaluateSourceTransfer,
  evaluateProseInsertions,
  type FormatEvidence,
} from "./format-rules.ts";
import {
  pieceEdits,
  applyPieceEdits,
  intersect,
  normalizePieces as normalize,
  overlap,
  pieceLength as length,
  pieceSlice as slice,
  replacePieces,
  subtractPieces,
  type PieceEdit,
} from "./pieces.ts";

const encoder = new TextEncoder(),
  decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const clone = <T>(value: T): T => structuredClone(value);
/** Lazy history maps are shared views; everything else is copied. */
const cloneState = (state: IntentState): IntentState => {
  const { outputs, effects, origins, alternatives, changes, ...rest } = state;
  return {
    ...clone(rest),
    outputs: cloneHistory(outputs, clone),
    effects: cloneHistory(effects, clone),
    origins: cloneHistory(origins, clone),
    alternatives: cloneHistory(alternatives, clone),
    changes: cloneHistory(changes, clone),
  };
};
/** Whether `a` and `b` have one `stableJSONString` form, decided without
 * building either string (evaluation compares whole node maps with it).
 * Evaluation data is JSON, so equal references and primitives serialize
 * alike, and each member of an array or record serializes unambiguously and
 * can be compared alone. The one collision between different shapes, an
 * array of one unserializable member against an empty array, is left to the
 * full form. */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  const objectA = a !== null && typeof a === "object",
    objectB = b !== null && typeof b === "object";
  if (!objectA || !objectB)
    return !objectA && !objectB && JSON.stringify(a) === JSON.stringify(b);
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const other = b as unknown[];
    if (a.length !== other.length)
      return stableJSONString(a) === stableJSONString(other);
    for (let index = 0; index < a.length; index++)
      if (!same(a[index], other[index])) return false;
    return true;
  }
  const left = a as Record<string, unknown>,
    right = b as Record<string, unknown>;
  let count = 0;
  for (const key of Object.keys(left)) {
    if (left[key] === undefined) continue;
    if (right[key] === undefined || !Object.hasOwn(right, key) || !same(left[key], right[key]))
      return false;
    count++;
  }
  for (const key of Object.keys(right)) if (right[key] !== undefined) count--;
  return count === 0;
}
const fail = (message: string): never => {
  throw new IntentError("invalid", message);
};
const missing = (message: string): never => {
  throw new IntentError("missing-context", message);
};
const components = (path: string): string[] => {
  if (
    !path.startsWith("/") ||
    (path !== "/" &&
      path
        .slice(1)
        .split("/")
        .some((p) => !p || p === "." || p === ".." || /[\\\0]/.test(p)))
  )
    return fail("Invalid material path");
  return path === "/" ? [] : path.slice(1).split("/");
};

/** Per-validation material proof, inherited only from a fully validated state.
 * No bytes or global hash cache: compare file nodes against the preceding state. */
export type ValidatedMaterial = Map<string, {node: Node; object: string}>;
type StateValidation = {
  /** Wall-clock budget for validation; defaults to the evaluator's 5 s. */
  maxMillis?: number;
  historyCache: StateMapValidationCache;
  retained: (hash: string) => void;
  summary?: {bytes: (count: number) => void; references: (refs: ReadonlySet<string>) => void; history?: (proofs: readonly MapProof[]) => void};
  material?: {previous?: ValidatedMaterial; next: ValidatedMaterial};
};
/** An evaluation-local material graph. State is immutable object data, not a database. */
class Engine {
  private validation?: StateValidation;
  private appliedDeletions?: Record<string, unknown>;
  private lazy = false;
  /** Load the history records this request names: its change identity, its
   * operation identities and the operation or alternative material it cites. */
  private async prefetch(...states: IntentState[]) {
    const change = this.request.incoming.change,
      operations = traceOperations(this.request.incoming),
      refs: MaterialRef[] = [];
    const walk = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      if ("material" in value) refs.push(value as MaterialRef);
      for (const child of Object.values(value)) walk(child);
    };
    walk(operations);
    walk(this.request.alternatives ?? []);
    const outputs = refs.flatMap((ref) =>
      ref.material.kind === "operation" ? [keyOf(ref.material.change, ref.material.operation)] : []);
    const alternatives = refs.flatMap((ref) =>
      ref.material.kind === "alternative" ? [alternativeKey(ref)] : []);
    for (const state of states) {
      await need(state.changes, [change]);
      await need(state.effects, operations.map((op) => keyOf(change, op.key)));
      await need(state.outputs, outputs);
      await need(state.alternatives, alternatives);
    }
  }
  /** Load every origin record reachable from `pieces`, as far as the bounded
   * synchronous walks in `evolved` and contribution grouping can go. */
  private async originChains(states: IntentState[], pieces: Iterable<Piece>) {
    let frontier = new Set([...pieces].map((p) => p.origin));
    const seen = new Set<string>();
    while (frontier.size && seen.size < 65_536) {
      const next = new Set<string>();
      for (const origin of frontier) seen.add(origin);
      for (const state of states) {
        await need(state.origins, frontier);
        for (const origin of frontier)
          for (const parent of state.origins[origin] ?? [])
            if (!seen.has(parent.origin)) next.add(parent.origin);
      }
      frontier = next;
    }
  }
  /** Effects whose deletions the state's nodes may not reflect yet. */
  private async pendingDeletions(state: IntentState): Promise<Record<string, Effect>> {
    if (!this.appliedDeletions) return state.effects;
    return (await since(state.effects, this.appliedDeletions, same)) as Record<string, Effect>;
  }
  eager = false;
  private projection?: StateValidation["material"];
  /** Byte lengths of file objects already known from projected material, so
   * an import need not read them again. */
  knownLengths?: Map<string, number>;
  authoredResult?: { object: string; state: string };
  readonly pendingEnclosures = new Set<string>();
  readonly formatEvidence: FormatEvidence[] = [];
  readonly generated = new Map<string, Uint8Array>();
  private readonly cache = new Map<string, Uint8Array>();
  private readonly contexts = new Map<string, IntentState>();
  private readBytes = 0;
  private writtenBytes = 0;
  private started = performance.now();
  checkBudget() {
    if (
      performance.now() - this.started >
      (this.request.rules.config?.maxMillis ?? 5000)
    )
      throw new IntentError("limit", "Evaluation time budget exceeded");
  }
  constructor(readonly request: IntentRequest, readonly store: MergeObjects) {}
  async read(hash: string): Promise<Uint8Array> {
    this.checkBudget();
    const known = this.generated.get(hash) ?? this.cache.get(hash);
    if (known) return known;
    let bytes: Uint8Array;
    try {
      bytes = await this.store.read(hash);
    } catch {
      return missing(`Missing object ${hash}`);
    }
    if (hashObject(bytes) !== hash) return fail("Object hash mismatch");
    this.readBytes += bytes.length;
    if (
      this.readBytes > (this.request.rules.config?.maxBytes ?? 32 * 1024 * 1024)
    )
      throw new IntentError("limit", "Evaluation object byte budget exceeded");
    this.cache.set(hash, bytes);
    return bytes;
  }
  put(bytes: Uint8Array): string {
    const hash = hashObject(bytes);
    if (this.cache.has(hash)) return hash;
    if (!this.generated.has(hash)) {
      this.writtenBytes += bytes.length;
      if (
        this.writtenBytes >
        (this.request.rules.config?.maxBytes ?? 32 * 1024 * 1024)
      )
        throw new IntentError("limit", "Generated object byte budget exceeded");
    }
    this.generated.set(hash, bytes);
    return hash;
  }
  async bytes(pieces: Piece[]): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    for (const p of pieces) {
      const b = await this.read(p.object);
      if (
        !Number.isSafeInteger(p.offset) ||
        !Number.isSafeInteger(p.length) ||
        p.offset < 0 ||
        p.length < 0 ||
        p.offset + p.length > b.length
      )
        return fail("Invalid retained piece");
      chunks.push(b.subarray(p.offset, p.offset + p.length));
    }
    return new Uint8Array(Buffer.concat(chunks));
  }
  async text(node: Node): Promise<Piece[]> {
    if (node.kind !== "file") return fail("Source target is not a file");
    if (!node.pieces) {
      const b = await this.read(node.object);
      try {
        decoder.decode(b);
      } catch {
        return fail("Source target is not UTF-8 text");
      }
      node.pieces = b.length
        ? [
            {
              origin: node.id,
              start: 0,
              object: node.object,
              offset: 0,
              length: b.length,
            },
          ]
        : [];
    }
    return node.pieces;
  }
  async importNode(
    view: View,
    object: string,
    kind: Node["kind"],
    id: string,
    parent: string | null,
    name: string,
    // Counted once per import rather than per node, which was quadratic.
    count = { nodes: Object.keys(view.nodes).length }
  ): Promise<string> {
    if (id.length > 16_384)
      throw new IntentError("limit", "Material nesting budget exceeded");
    if (count.nodes >= (this.request.rules.config?.maxNodes ?? 20_000))
      throw new IntentError("limit", "Evaluation node budget exceeded");
    if (view.nodes[id]) return fail("Duplicate material identity");
    const node: Node = { id, parent, name, kind, object, active: true };
    view.nodes[id] = node;
    count.nodes++;
    if (kind === "file") {
      const size = this.knownLengths?.get(object) ?? (await this.read(object)).length;
      node.pieces = size
        ? [{ origin: id, start: 0, object, offset: 0, length: size }]
        : [];
    }
    if (kind === "directory") {
      const directory = decodeWireDirectory(await this.read(object));
      node.directory = { ...directory, entries: [] };
      for (const entry of directory.entries) {
        await this.importNode(
          view,
          (entry.file ?? entry.directory ?? entry.tree)!,
          entry.file ? "file" : entry.directory ? "directory" : "tree",
          `${id}/${encodeURIComponent(entry.name)}`,
          id,
          entry.name,
          count
        );
      }
    }
    return id;
  }
  async initial(root: string): Promise<IntentState> {
    const state: IntentState = {
      format: "arbor-merge-intent-state",
      tree: this.request.tree,
      root: `basis:${this.request.tree}:${root}`,
      nodes: {},
      outputs: {},
      alternatives: {},
      origins: {},
      effects: {},
      changes: {},
      decisions: [],
    };
    await this.importNode(state, root, "directory", state.root, null, "");
    return state;
  }
  async load(ref: { object: string; state?: string }, validation?: StateValidation): Promise<IntentState> {
    this.validation = validation;
    if (!ref.state) return this.initial(ref.object);
    let state: IntentState;
    try {
      state = this.lazy && !validation
        ? await loadLazyIntentState(ref.state, (hash) => this.read(hash))
        : await loadIntentState(ref.state, (hash) => this.read(hash), validation?.retained, validation?.historyCache, validation?.summary);
    } catch (error) {
      if (error instanceof IntentError) throw error;
      return fail("Invalid material state");
    }
    // An accepted input pair was validated by the host when it was accepted,
    // as the exact-basis path already relies on. Recover its file hashes from
    // the root's directory metadata instead of rebuilding every file.
    const trusted = this.lazy && !validation;
    if (trusted) {
      const material = await this.trustedProjection(state, ref.object);
      this.projection ??= {previous: new Map(), next: new Map()};
      // Detached copies: evaluation edits loaded nodes in place, and a reused
      // entry must still describe the material as the accepted root holds it.
      for (const [id, entry] of material)
        if (!this.projection.previous!.has(id))
          this.projection.previous!.set(id, {node: clone(entry.node), object: entry.object});
    }
    return this.validateState(state, ref, trusted);
  }
  async validateState(state: IntentState, ref: {object: string}, trusted = false): Promise<IntentState> {
    if (
      state.format !== "arbor-merge-intent-state" ||
      state.tree !== this.request.tree ||
      !state.nodes ||
      !state.outputs ||
      !state.effects ||
      !state.origins ||
      !state.alternatives ||
      !state.changes ||
      !Array.isArray(state.decisions)
    )
      return fail("Invalid material state envelope");
    const nodes = Object.entries(state.nodes);
    if (nodes.length > (this.request.rules.config?.maxNodes ?? 20_000))
      throw new IntentError("limit", "Evaluation node budget exceeded");
    for (const [id, node] of nodes) {
      if (
        id !== node.id ||
        !["file", "directory", "tree"].includes(node.kind) ||
        typeof node.active !== "boolean" ||
        typeof node.name !== "string" ||
        (node.parent !== null && !state.nodes[node.parent])
      )
        return fail("Invalid material state node");
      if (node.parent !== null && components("/" + node.name).length !== 1)
        return fail("Invalid entry name");
    }
    if (!trusted && (await this.project(state)) !== ref.object)
      return fail("State does not project to supplied root");
    const decisions = new Map(state.decisions.map((d) => [d.key, d]));
    const visiting = new Set<string>(),
      visited = new Set<string>();
    const checkDecision = (key: string): void => {
      if (visited.has(key)) return;
      if (visiting.has(key)) return fail("Decision dependency cycle");
      const decision =
        decisions.get(key) ?? fail("Missing decision dependency");
      visiting.add(key);
      for (const dependency of decision.dependencies) checkDecision(dependency);
      visiting.delete(key);
      visited.add(key);
    };
    for (const decision of state.decisions) {
      checkDecision(decision.key);
      for (const alternative of decision.alternatives)
        if (
          !decision.context &&
          alternative.node &&
          (await this.project(state, alternative.node)) !== alternative.object
        )
          return fail(
            `Alternative does not match retained material: ${decision.key} (${alternative.node})`
          );
      if (decision.placement && !decision.context) {
        const node = state.nodes[decision.placement.node];
        if (!node?.active || !node.pieces)
          return fail("Decision placement is unavailable");
        if (decision.placement.pieces.length)
          this.locate(node.pieces, decision.placement.pieces, [
            0,
            length(decision.placement.pieces),
          ]);
        else if (decision.placement.anchor > length(node.pieces))
          return fail("Decision anchor is outside its material");
      }
    }

    return state;
  }
  /** A copy of `id` and its active descendants: everything a later operation
   * can read through an entry operation's result (`binding` descends with
   * `within`; `copy`, `copyEntry` and `selection` read the subtree). Older
   * records carry the whole tree; readers accept both. */
  subtree(view: View, id: string): View {
    const index = this.childIndex(view);
    const nodes: Record<string, Node> = {};
    const visit = (node: Node) => {
      nodes[node.id] = clone(node);
      for (const child of this.children(view, node.id, index)) visit(child);
    };
    visit(view.nodes[id]!);
    return { root: id, nodes };
  }
  /** Every node under each parent, active or not, in node order. A walk
   * builds one and passes it down: nodes are edited in place, so an index
   * kept across edits could name a stale parent. */
  childIndex(view: View): Map<string, Node[]> {
    const index = new Map<string, Node[]>();
    for (const node of Object.values(view.nodes)) if (node.parent !== null) {
      const siblings = index.get(node.parent);
      if (siblings) siblings.push(node); else index.set(node.parent, [node]);
    }
    return index;
  }
  /** The active children of `id`, from `index` when the caller walks many. */
  children(view: View, id: string, index?: Map<string, Node[]>): Node[] {
    return index
      ? (index.get(id) ?? []).filter((n) => n.active)
      : Object.values(view.nodes).filter((n) => n.active && n.parent === id);
  }
  async project(
    view: View,
    root = view.root,
    visiting = new Set<string>(),
    index = this.childIndex(view)
  ): Promise<string> {
    this.checkBudget();
    const node = view.nodes[root];
    if (!node?.active) return fail("Projection root is absent");
    if (visiting.has(root)) return fail("Directory cycle");
    if (visiting.size > 256)
      throw new IntentError("limit", "Directory depth budget exceeded");
    visiting.add(root);
    try {
      if (node.kind === "file") {
        const material = this.projection ?? this.validation?.material;
        const previous = material?.previous?.get(node.id);
        const object = previous && same(previous.node, node)
          ? previous.object
          : node.pieces ? this.put(await this.bytes(node.pieces))
          : (await this.read(node.object), node.object);
        material?.next.set(node.id, {node, object});
        return object;
      }
      if (node.kind === "tree") return node.object;
      const entries = [];
      const names = new Set<string>();
      for (const child of this.children(view, root, index).sort((a, b) =>
        Buffer.compare(Buffer.from(a.name), Buffer.from(b.name))
      )) {
        if (names.has(child.name)) return fail("Duplicate directory placement");
        names.add(child.name);
        const object = await this.project(view, child.id, visiting, index);
        entries.push(
          child.kind === "file"
            ? { name: child.name, file: object }
            : child.kind === "directory"
            ? { name: child.name, directory: object }
            : { name: child.name, tree: object }
        );
      }
      return this.put(
        encodeWireDirectory({
          ...node.directory,
          type: "directory",
          entries,
        } as WireDirectory)
      );
    } finally {
      visiting.delete(root);
    }
  }
  async binding(
    ref: MaterialRef,
    basis: View,
    state: IntentState
  ): Promise<Material> {
    let material: Material;
    if (ref.material.kind === "basis") {
      let node = basis.nodes[basis.root]!;
      for (const part of components(ref.material.path)) {
        if (node.kind !== "directory")
          return fail("Reference crosses a file or tree boundary");
        node =
          this.children(basis, node.id).find((n) => n.name === part) ??
          fail("Basis path is absent");
      }
      if ((await this.project(basis, node.id)) !== ref.material.object)
        return fail("Basis object does not match path");
      material = { node: node.id, view: basis };
    } else if (ref.material.kind === "operation") {
      material =
        state.outputs[keyOf(ref.material.change, ref.material.operation)] ??
        missing("Operation result is unavailable");
    } else {
      const node =
        state.alternatives[alternativeKey(ref)] ??
        missing("Alternative material is unavailable");
      material = { node, view: state };
    }
    material = { ...material };
    for (const part of ref.within ?? []) {
      if (material.pieces) return fail("Cannot descend through a text result");
      const view = material.view ?? state,
        node = view.nodes[material.node]!;
      if (node.kind !== "directory")
        return fail("Selector crosses a file or tree boundary");
      material.node =
        this.children(view, node.id).find((n) => n.name === part)?.id ??
        fail("Selected child is absent");
    }
    return material;
  }
  async selection(
    ref: MaterialRef,
    basis: View,
    state: IntentState
  ): Promise<{
    node: string;
    observed: Piece[];
    selected: Piece[];
    range: [number, number];
  }> {
    const binding = await this.binding(ref, basis, state);
    const observed =
      binding.anchor?.observed ??
      binding.pieces ??
      (await this.text((binding.view ?? state).nodes[binding.node]!));
    const bytes = await this.bytes(observed),
      range: [number, number] = binding.anchor
        ? [binding.anchor.offset, binding.anchor.offset]
        : ref.range ?? [0, bytes.length];
    if (
      binding.anchor &&
      ref.range &&
      (ref.range[0] !== 0 || ref.range[1] !== 0)
    )
      return fail("Empty result has only the zero range");
    if (
      !range.every(Number.isSafeInteger) ||
      range[0] < 0 ||
      range[1] < range[0] ||
      range[1] > bytes.length
    )
      return fail("Selection outside material");
    try {
      decoder.decode(bytes);
    } catch {
      return fail("Source material is not text");
    }
    if (range.some((n) => n < bytes.length && (bytes[n]! & 0xc0) === 0x80))
      return fail("Selection splits a UTF-8 scalar");
    return {
      node: binding.node,
      observed,
      selected: slice(observed, ...range),
      range,
    };
  }
  /** Locate immutable origin coordinates, never equal-text matches. */
  locate(
    current: Piece[],
    observed: Piece[],
    range: [number, number]
  ): [number, number] {
    if (current.length * observed.length > 2_000_000)
      throw new IntentError("limit", "Source lookup work budget exceeded");
    const selected = slice(observed, ...range);
    if (!observed.length && current.length)
      return fail("Empty source anchor has concurrent content");
    const positions: Array<[number, number]> = [];
    let offset = 0,
      covered = 0;
    for (const p of current) {
      for (const q of selected) {
        const shared = intersect(p, q);
        if (shared) {
          positions.push([offset + shared[0] - p.start, offset + shared[1] - p.start]);
          covered += shared[1] - shared[0];
        }
      }
      offset += p.length;
    }
    if (range[0] !== range[1]) {
      positions.sort((a, b) => a[0] - b[0]);
      if (
        covered !== length(selected) ||
        !positions.length ||
        positions.at(-1)![1] - positions[0]![0] !== covered
      )
        return fail("Selected material was changed or duplicated");
      return [positions[0]![0], positions.at(-1)![1]];
    }
    const left = slice(observed, Math.max(0, range[0] - 1), range[0])[0];
    const right = slice(
      observed,
      range[0],
      Math.min(length(observed), range[0] + 1)
    )[0];
    let l: number | undefined = left ? undefined : 0,
      r: number | undefined = right ? undefined : length(current);
    offset = 0;
    for (const p of current) {
      if (
        left &&
        p.origin === left.origin &&
        left.start >= p.start &&
        left.start < p.start + p.length
      )
        l = offset + left.start - p.start + 1;
      if (
        right &&
        p.origin === right.origin &&
        right.start >= p.start &&
        right.start < p.start + p.length
      )
        r = offset + right.start - p.start;
      offset += p.length;
    }
    if (!right && left) r = l;
    if (!left && right) l = r;
    if (l === undefined || r === undefined || l > r)
      return fail("Insertion anchor is unavailable");
    return [r, r];
  }
  async evolved(
    state: IntentState,
    current: Piece[],
    selected: Piece[]
  ): Promise<[number, number]> {
    await this.originChains([state], current);
    if (current.length * selected.length > 2_000_000)
      throw new IntentError("limit", "Source transport work budget exceeded");
    const contained = (p: Piece) =>
      selected.some(
        (q) =>
          q.origin === p.origin &&
          q.start <= p.start &&
          q.start + q.length >= p.start + p.length
      );
    const derives = (p: Piece, seen = new Set<string>()): boolean => {
      if (contained(p)) return true;
      if (seen.has(p.origin) || seen.size > 256) return false;
      const ancestors = state.origins[p.origin];
      if (!ancestors?.length) return false;
      const next = new Set(seen).add(p.origin);
      return ancestors.every((q) => derives(q, next));
    };
    const positions: Array<[number, number]> = [];
    let offset = 0;
    for (const p of current) {
      if (derives(p)) positions.push([offset, offset + p.length]);
      else
        for (const q of selected) {
          const shared = intersect(q, p);
          if (shared)
            positions.push([offset + shared[0] - p.start, offset + shared[1] - p.start]);
        }
      offset += p.length;
    }
    positions.sort((a, b) => a[0] - b[0]);
    if (!positions.length) return fail("Moved source is no longer present");
    let end = positions[0]![0];
    for (const p of positions) {
      if (p[0] !== end)
        return fail("Moved source has ambiguous correspondence");
      end = p[1];
    }
    return [positions[0]![0], end];
  }
  realm(view: View, id: string): string {
    const seen = new Set<string>();
    let node = view.nodes[id];
    while (node?.parent !== null) {
      if (!node || seen.has(node.id) || seen.size > 256)
        return fail("Invalid material occurrence scope");
      seen.add(node.id);
      node = view.nodes[node.parent!];
    }
    return node?.id ?? fail("Missing material occurrence");
  }
  /** `realm` memoized per id, for a loop that changes no parent link. */
  realms(view: View): (id: string) => string {
    const known = new Map<string, string>();
    return (id) => {
      let realm = known.get(id);
      if (realm === undefined) known.set(id, (realm = this.realm(view, id)));
      return realm;
    };
  }
  importContext(
    state: IntentState,
    context: IntentState,
    prefix: string
  ): { root: string; ids: Map<string, string> } {
    const ids = new Map<string, string>(),
      index = this.childIndex(context);
    const visit = (id: string, parent: string | null): string => {
      const prior = context.nodes[id]!,
        next = `${prefix}/${encodeURIComponent(id)}`;
      ids.set(id, next);
      if (state.nodes[next])
        return fail("Alternative occurrence identity reused");
      state.nodes[next] = { ...clone(prior), id: next, parent };
      for (const child of this.children(context, id, index)) visit(child.id, next);
      return next;
    };
    return { root: visit(context.root, null), ids };
  }
  path(view: View, id: string): string {
    const parts: string[] = [],
      seen = new Set<string>();
    let node = view.nodes[id];
    while (node?.parent !== null) {
      if (!node || seen.has(node.id)) return fail("Invalid parent chain");
      seen.add(node.id);
      parts.push(node.name);
      node = view.nodes[node.parent!];
    }
    return "/" + parts.reverse().join("/");
  }
  placement(state: IntentState, id: string, parent: string, name: string) {
    const destination = state.nodes[parent];
    if (!destination?.active || destination.kind !== "directory")
      return fail("Destination is not a live directory");
    let cursor: Node | undefined = destination;
    const seen = new Set<string>();
    while (cursor) {
      if (seen.has(cursor.id)) return fail("Parent cycle");
      seen.add(cursor.id);
      if (cursor.id === id) return fail("Move creates a cycle");
      cursor = cursor.parent ? state.nodes[cursor.parent] : undefined;
    }
    if (
      this.children(state, parent).some((n) => n.id !== id && n.name === name)
    )
      return fail("Destination already exists");
    const node = state.nodes[id]!;
    node.parent = parent;
    node.name = name;
  }
  /** Removing changes no parent, so one index serves the whole subtree. */
  remove(state: IntentState, id: string, contribution?: string, index = this.childIndex(state)) {
    for (const child of this.children(state, id, index))
      this.remove(state, child.id, contribution, index);
    if (contribution)
      state.nodes[id]!.deletions = [
        ...new Set([...(state.nodes[id]!.deletions ?? []), contribution]),
      ];
    state.nodes[id]!.active = false;
  }
  copy(
    state: IntentState,
    view: View,
    id: string,
    prefix: string,
    parent: string | null,
    name: string,
    index = this.childIndex(view)
  ): string {
    const before = view.nodes[id]!;
    const newID = `${prefix}/${encodeURIComponent(id)}`;
    const node = clone(before);
    node.id = newID;
    node.parent = parent;
    node.name = name;
    node.active = true;
    delete node.deletions;
    if (node.pieces)
      node.pieces = node.pieces.map((p, index) => ({
        ...p,
        origin: `${newID}:${index}`,
        start: 0,
      }));
    state.nodes[newID] = node;
    // Copies are placed under fresh identities, never under a node of `view`.
    for (const child of this.children(view, id, index))
      this.copy(state, view, child.id, prefix, newID, child.name, index);
    return newID;
  }
  copyDecisions(
    state: IntentState,
    sourceID: string,
    destinationID: string,
    source: Piece[],
    destination: Piece[],
    key: string,
    sourceRange: [number, number] = [0, length(source)],
    destinationOffset = 0
  ) {
    const originals = state.decisions.filter(
      (d) => d.placement?.node === sourceID
    );
    for (const original of originals) {
      const placement = original.placement!;
      const at = placement.pieces.length
        ? this.locate(source, placement.pieces, [0, length(placement.pieces)])
        : [placement.anchor, placement.anchor];
      if (at[0] === at[1]) {
        if (at[0]! < sourceRange[0] || at[0]! > sourceRange[1]) continue;
      } else if (at[1]! <= sourceRange[0] || at[0]! >= sourceRange[1]) continue;
      if (at[0]! < sourceRange[0] || at[1]! > sourceRange[1]) {
        // There is no justified character mapping into the other value. Keep
        // the literal authored copy inside a coupled choice with its source.
        this.pendingEnclosures.add(original.key);
        continue;
      }
      const decision = clone(original);
      decision.key = `${key}:${original.key}`;
      decision.affected = [destinationID];
      const start = destinationOffset + at[0]! - sourceRange[0],
        end = destinationOffset + at[1]! - sourceRange[0];
      decision.placement = {
        node: destinationID,
        pieces: clone(slice(destination, start, end)),
        anchor: start,
      };
      decision.dependencies = original.dependencies.map((d) => `${key}:${d}`);
      decision.alternatives = decision.alternatives.map(
        (alternative, index) => {
          if (!alternative.node)
            throw new IntentError(
              "missing-context",
              "Copied choice material is unavailable"
            );
          const node = clone(state.nodes[alternative.node]!);
          node.id = `${key}:${alternative.node}`;
          node.parent = null;
          node.pieces =
            index === decision.selected
              ? clone(decision.placement!.pieces)
              : (node.pieces ?? []).map((p, i) => ({
                  ...p,
                  origin: `${node.id}:${i}`,
                  start: 0,
                }));
          state.nodes[node.id] = node;
          return { ...alternative, node: node.id };
        }
      );
      state.decisions.push(decision);
    }
  }
  async apply(
    state: IntentState,
    basis: View,
    operation: SourceOperation,
    change: string,
    validatedBasisObject?: string
  ): Promise<void> {
    this.checkBudget();
    const key = keyOf(change, operation.key),
      before: Record<string, Node> = validatedBasisObject ? Object.create(null) : clone(state.nodes);
    if (Object.hasOwn(state.effects, key))
      return fail("Operation identity reused");
    let result: Material | undefined;
    if (
      operation.kind === "editSource" ||
      operation.kind === "moveSource" ||
      operation.kind === "copySource"
    ) {
      const source = await this.selection(operation.source, basis, state);
      let node = state.nodes[source.node];
      if (source.selected.length && node?.parent !== null) {
        const realm = this.realms(state);
        const matches = Object.values(state.nodes).filter(
          (n) =>
            n.active &&
            realm(n.id) === realm(source.node) &&
            n.kind === "file" &&
            n.pieces?.some((p) => source.selected.some((q) => intersect(p, q)))
        );
        if (matches.length === 1) node = matches[0];
        else if (matches.length > 1)
          return fail("Selection spans multiple current entries");
      }
      if (!node || (!node.active && operation.kind !== "copySource"))
        return fail("Source entry was removed");
      // The exact-basis edit path can mutate only this file. Capture it before
      // text() or replacement changes it; other operation kinds retain the full
      // structural comparison below.
      if (validatedBasisObject) before[node.id] = clone(node);
      const current = await this.text(node),
        range =
          operation.kind === "copySource"
            ? source.range
            : operation.kind === "moveSource" && source.selected.length
            ? await this.evolved(state, current, source.selected)
            : this.locate(current, source.observed, source.range);
      let pieces: Piece[];
      if (operation.kind === "editSource") {
        const bytes = encoder.encode(operation.text);
        if (decoder.decode(bytes) !== operation.text)
          return fail("Replacement is not scalar text");
        const object = this.put(bytes);
        pieces = bytes.length
          ? [{ origin: key, start: 0, object, offset: 0, length: bytes.length }]
          : [];
        state.origins[key] = clone(
          source.selected.length
            ? source.selected
            : [
                ...slice(
                  source.observed,
                  Math.max(0, source.range[0] - 1),
                  source.range[0]
                ),
                ...slice(source.observed, source.range[0], source.range[0] + 1),
              ]
        );
        let cursor = 0;
        const mapped: Piece[] = [],
          preserved: Piece[] = [];
        for (const lineage of operation.lineage ?? []) {
          const selected = await this.selection(lineage.source, basis, state),
            [start, end] = lineage.range;
          if (
            start < cursor ||
            end > bytes.length ||
            end < start ||
            selected.node !== source.node ||
            selected.range[0] < source.range[0] ||
            selected.range[1] > source.range[1]
          )
            return fail("Invalid preservation lineage");
          if (
            selected.selected.some((p) => preserved.some((q) => intersect(p, q)))
          )
            return fail(
              "Preservation lineage duplicates material; use copySource"
            );
          preserved.push(...selected.selected);
          if (
            !Buffer.from(await this.bytes(selected.selected)).equals(
              Buffer.from(bytes.subarray(start, end))
            )
          )
            return fail("False source lineage");
          mapped.push(...slice(pieces, cursor, start), ...selected.selected);
          cursor = end;
        }
        if (operation.lineage?.length)
          pieces = [...mapped, ...slice(pieces, cursor, bytes.length)];
        node.pieces = replacePieces(current, range[0], range[1], pieces);
        result = {
          node: node.id,
          pieces: clone(pieces),
          ...(pieces.length
            ? {}
            : { anchor: { observed: clone(node.pieces), offset: range[0] } }),
        };
      } else {
        const target = await this.selection(operation.at, basis, state),
          destination = state.nodes[target.node];
        if (!destination?.active) return fail("Destination entry was removed");
        let targetPieces = await this.text(destination);
        const atRange = this.locate(
          targetPieces,
          target.observed,
          target.range
        );
        let at = operation.side === "before" ? atRange[0] : atRange[1];
        pieces = clone(
          operation.kind === "moveSource"
            ? slice(current, ...range)
            : source.selected
        );
        if (operation.kind === "copySource")
          pieces = pieces.map((p, i) => ({
            ...p,
            origin: `${key}:${i}`,
            start: 0,
          }));
        else {
          if (node.id === destination.id && at > range[0] && at < range[1])
            return fail("Move destination is inside source");
          node.pieces = replacePieces(current, range[0], range[1]);
          if (node.id === destination.id) {
            if (at >= range[1]) at -= range[1] - range[0];
            targetPieces = node.pieces;
          }
        }
        destination.pieces = replacePieces(targetPieces, at, at, pieces);
        if (operation.kind === "moveSource") {
          for (const decision of state.decisions) {
            if (decision.placement?.node !== node.id) continue;
            try {
              const observed = this.locate(current, decision.placement.pieces, [
                0,
                length(decision.placement.pieces),
              ]);
              if (observed[0] < range[0] || observed[1] > range[1]) continue;
              const moved = await this.evolved(
                state,
                destination.pieces,
                decision.placement.pieces
              );
              decision.placement = {
                node: destination.id,
                pieces: clone(slice(destination.pieces, ...moved)),
                anchor: moved[0],
              };
              decision.affected = [destination.id];
            } catch (error) {
              if (error instanceof IntentError && error.code === "limit")
                throw error;
              /* A partial choice is enclosed by the lifecycle pass. */
            }
          }
        }
        if (operation.kind === "copySource")
          this.copyDecisions(
            state,
            source.node,
            destination.id,
            source.observed,
            destination.pieces,
            key,
            source.range,
            at
          );
        result = { node: destination.id, pieces: clone(pieces) };
      }
    } else if (operation.kind === "addEntry") {
      // A new entry under an existing directory: the value's objects are
      // imported under this operation's identity, exactly as replaceEntry
      // imports a replacement, and the name must be free.
      const target = await this.binding(operation.destination.parent, basis, state);
      if (operation.destination.parent.range || target.pieces)
        return fail("Invalid entry destination");
      const value = operation.value,
        kind = "file" in value ? "file" : "directory";
      await this.importNode(state, "file" in value ? value.file : value.directory, kind, key, null, operation.destination.name);
      this.placement(state, key, target.node, operation.destination.name);
      // The exact-basis path records effects only for nodes it names.
      if (validatedBasisObject)
        for (const id of Object.keys(state.nodes))
          if (id === key || id.startsWith(`${key}/`)) (before as Record<string, Node | undefined>)[id] = undefined;
      result = { node: key, view: this.subtree(state, key) };
    } else {
      const material = await this.binding(operation.source, basis, state),
        node = state.nodes[material.node];
      if (
        !node?.active ||
        node.id === state.root ||
        operation.source.range ||
        material.pieces
      )
        return fail("Invalid entry target");
      if (operation.kind === "removeEntry") this.remove(state, node.id, key);
      else if (
        operation.kind === "moveEntry" ||
        operation.kind === "copyEntry"
      ) {
        const target = await this.binding(
          operation.destination.parent,
          basis,
          state
        );
        if (operation.destination.parent.range || target.pieces)
          return fail("Invalid entry destination");
        const id =
          operation.kind === "moveEntry"
            ? node.id
            : this.copy(
                state,
                material.view ?? basis,
                node.id,
                key,
                null,
                node.name
              );
        this.placement(state, id, target.node, operation.destination.name);
        if (operation.kind === "copyEntry") {
          for (const old of Object.values((material.view ?? basis).nodes)) {
            const copied = state.nodes[`${key}/${encodeURIComponent(old.id)}`];
            if (copied?.pieces && old.pieces)
              this.copyDecisions(
                state,
                old.id,
                copied.id,
                old.pieces,
                copied.pieces,
                key
              );
          }
        }
        result = { node: id, view: this.subtree(state, id) };
      } else if (operation.kind === "replaceEntry") {
        const value = operation.value;
        if ("material" in value) {
          const replacement = await this.binding(value, basis, state),
            other = state.nodes[replacement.node];
          if (!other?.active || replacement.pieces || value.range)
            return fail("Invalid replacement material");
          if (other.id !== node.id && other.parent !== null)
            return fail("Replacement would alias placed identity; use copy");
          if (other.id !== node.id) {
            const index = this.childIndex(state);
            for (const child of this.children(state, node.id, index))
              this.remove(state, child.id, undefined, index);
          }
          node.kind = other.kind;
          node.object = other.object;
          node.pieces = other.pieces ? clone(other.pieces) : undefined;
          node.directory = other.directory ? clone(other.directory) : undefined;
          for (const child of this.children(state, other.id))
            child.parent = node.id;
        } else {
          const index = this.childIndex(state);
          for (const child of this.children(state, node.id, index))
            this.remove(state, child.id, undefined, index);
          const object = "file" in value ? value.file : value.directory;
          node.kind = "file" in value ? "file" : "directory";
          node.object = object;
          delete node.pieces;
          delete node.directory;
          const replacementBytes = await this.read(object);
          if (node.kind === "file")
            node.pieces = replacementBytes.length
              ? [
                  {
                    origin: key,
                    start: 0,
                    object,
                    offset: 0,
                    length: replacementBytes.length,
                  },
                ]
              : [];
          if (node.kind === "directory") {
            const temporary: View = { root: key, nodes: {} };
            await this.importNode(
              temporary,
              object,
              "directory",
              key,
              null,
              node.name
            );
            node.directory = temporary.nodes[key]!.directory;
            const imported = this.childIndex(temporary);
            for (const child of this.children(temporary, key, imported))
              this.copy(state, temporary, child.id, key, node.id, child.name, imported);
          }
        }
        result = { node: node.id, view: this.subtree(state, node.id) };
      }
    }
    const effect: Effect = {
      authored: {
        operation: this.put(encodeJSON(operation)),
        basis: validatedBasisObject ?? await this.project(basis),
      },
      change,
      operation: operation.key,
      kind: operation.kind,
      ...(operation.kind === "editSource" && operation.lineage?.length
        ? { preserves: true }
        : {}),
      before: {},
      after: {},
      edits: {},
      undone: false,
    };
    for (const id of validatedBasisObject ? Object.keys(before) : new Set([
      ...Object.keys(before),
      ...Object.keys(state.nodes),
    ]))
      if (!same(before[id], state.nodes[id])) {
        const old = before[id], now = state.nodes[id];
        // Source edits store their piece delta instead of two whole copies of
        // the file's pieces: the delta is all deletion enforcement reads.
        if (operation.kind === "editSource" && old?.pieces && now?.pieces) {
          const edits = pieceEdits(old.pieces, now.pieces).map((edit) => ({
            range: edit.range,
            removed: clone(slice(old.pieces!, ...edit.range)),
            inserted: clone(edit.pieces),
          }));
          if (edits.length) effect.edits[id] = edits;
          const { pieces: _before, ...slimBefore } = old;
          const { pieces: _after, ...slimAfter } = clone(now);
          effect.before[id] = slimBefore;
          effect.after[id] = slimAfter;
          continue;
        }
        if (old) effect.before[id] = old;
        if (now) effect.after[id] = clone(now);
      }
    state.effects[key] = effect;
    if (result) state.outputs[key] = result;
  }
  async edits(base: Piece[], changed: Piece[], state: IntentState): Promise<PieceEdit[]> {
    const edits = pieceEdits(base, changed);
    // Only an insertion's own pieces decide whether it is an attachment.
    await need(state.effects, new Set(edits.flatMap((e) => e.pieces.map((p) => p.origin))));
    return edits.map((edit) => ({
      ...edit,
      attachment:
        edit.range[0] === edit.range[1] &&
        edit.pieces.length > 0 &&
        edit.pieces.every((p) => state.effects[p.origin]?.preserves === true),
    }));
  }
  /** Enforce the deletions of `effects` (by default all of the state's).
   * `kept` names, per node, pieces a new choice selected: a deletion that
   * choice retains as its other alternative must not cut into them. */
  enforceDeletions(state: IntentState, effects: Record<string, Effect> = state.effects, kept: ReadonlyMap<string, Piece[]> = new Map()) {
    const realm = this.realms(state);
    for (const effect of Object.values(effects)) {
      if (effect.undone || effect.kind !== "editSource") continue;
      for (const [id, edits] of Object.entries(effect.edits)) {
        for (const edit of edits) {
          if (edit.inserted.length || edit.range[0] === edit.range[1]) continue;
          for (const node of Object.values(state.nodes))
            if (
              node.active &&
              node.pieces &&
              realm(node.id) === realm(id)
            ) {
              const removed = subtractPieces(edit.removed, kept.get(node.id) ?? []);
              node.pieces = normalize(subtractPieces(node.pieces, removed));
            }
        }
      }
    }
  }
  // A structural alternative can alias a root whose children have just changed.
  // Preserve its immutable value through the state reference; a stale local
  // alias would make the recorded context unreadable on the next continuation.
  private async retainDirectoryAlternatives(state: IntentState): Promise<void> {
    for (const decision of state.decisions) {
      if (decision.kind !== "directory") continue;
      for (const alternative of decision.alternatives)
        if (alternative.node && (!state.nodes[alternative.node] ||
            await this.project(state, alternative.node) !== alternative.object))
          delete alternative.node;
    }
  }
  async propagateDecisions(
    authored: IntentState,
    base: IntentState
  ): Promise<void> {
    for (const decision of authored.decisions) {
      if (
        same(
          decision,
          base.decisions.find((d) => d.key === decision.key)
        )
      )
        continue;
      const parents = authored.decisions.filter((d) =>
        d.dependencies.includes(decision.key)
      );
      for (const parent of parents)
        for (const branch of parent.alternatives) {
          const context = await this.context(branch.state),
            retained = context.decisions.find((d) => d.key === decision.key);
          // A dependency can be present only in another alternative/context.
          if (!retained || retained.context) continue;
          const updated = clone(decision);
          delete updated.context;
          let oldPieces: Piece[] | undefined, newPieces: Piece[] | undefined;
          if (retained.placement) {
            const target = context.nodes[retained.placement.node];
            if (
              !target?.active ||
              !target.pieces ||
              this.realm(context, target.id) !== context.root
            )
              continue;
            const selected = decision.alternatives[decision.selected]!,
              prior = retained.alternatives[retained.selected]!;
            const material =
              (selected.node ? authored.nodes[selected.node] : undefined) ??
              (prior.node ? context.nodes[prior.node] : undefined);
            if (!material?.pieces)
              throw new IntentError(
                "missing-context",
                "Hidden selected source material is unavailable"
              );
            const at = this.locate(target.pieces, retained.placement.pieces, [
              0,
              length(retained.placement.pieces),
            ]);
            oldPieces = retained.placement.pieces;
            newPieces = material.pieces;
            target.pieces = replacePieces(target.pieces, at[0], at[1], newPieces);
            updated.placement = {
              node: target.id,
              pieces: clone(newPieces),
              anchor: at[0],
            };
            for (const [index, alternative] of updated.alternatives.entries()) {
              if (alternative.node && authored.nodes[alternative.node])
                context.nodes[alternative.node] = clone(
                  authored.nodes[alternative.node]!
                );
              else if (
                retained.alternatives[index]?.object === alternative.object
              )
                alternative.node = retained.alternatives[index]!.node;
              else
                throw new IntentError(
                  "missing-context",
                  "Hidden alternative material is unavailable"
                );
            }
          } else if (retained.kind === "directory") {
            const selected = updated.alternatives[updated.selected]!;
            if ((await this.project(context)) !== selected.object) {
              const value = await this.contextView(selected.state);
              if ((await this.project(value)) !== selected.object)
                throw new IntentError(
                  "missing-context",
                  "Selected structural branch is unavailable"
                );
              const imported = this.importContext(
                context,
                value,
                `continuation:${this.request.incoming.change}:${decision.key}`
              );
              context.root = imported.root;
              selected.node = imported.root;
            }
            for (const alternative of updated.alternatives)
              if (
                alternative.node &&
                (!context.nodes[alternative.node] ||
                  (await this.project(context, alternative.node)) !==
                    alternative.object)
              )
                delete alternative.node;
          } else
            throw new IntentError(
              "missing-context",
              "Decision correspondence is unavailable"
            );
          context.decisions[context.decisions.indexOf(retained)] = updated;
          for (const [index, child] of context.decisions.entries()) {
            const latest = authored.decisions.find((d) => d.key === child.key);
            if (latest?.context && child.key !== updated.key)
              context.decisions[index] = clone(latest);
          }
          for (const map of ["origins", "effects", "outputs"] as const)
            for (const [key, value] of Object.entries(await since(authored[map], base[map], same)))
              (context[map] as Record<string, unknown>)[key] = clone(value);
          // Continuing one fragment can displace an overlapping sibling.
          // Keep that sibling in the prior valid context instead of storing a
          // live placement that a later edit or redo cannot read.
          const oldState = branch.state;
          for (const child of context.decisions) {
            if (child.context || !child.placement) continue;
            const target = context.nodes[child.placement.node];
            try {
              if (!target?.active || !target.pieces) throw new Error("Placement disappeared");
              const at = this.locate(target.pieces, child.placement.pieces, [0, length(child.placement.pieces)]);
              child.placement.anchor = at[0];
            } catch (error) {
              if (error instanceof IntentError && error.code === "limit") throw error;
              child.context = oldState;
            }
          }
          await this.retainDirectoryAlternatives(context);
          const result = await this.record(context);
          branch.state = result.state;
          if (
            parent.kind === "content" &&
            branch.node &&
            oldPieces &&
            newPieces
          ) {
            const fragment = authored.nodes[branch.node];
            if (!fragment?.pieces)
              throw new IntentError(
                "missing-context",
                "Containing fragment is unavailable"
              );
            try {
              const at = this.locate(fragment.pieces, oldPieces, [
                0,
                length(oldPieces),
              ]);
              fragment.pieces = replacePieces(fragment.pieces, at[0], at[1], newPieces);
              branch.object = await this.project(authored, fragment.id);
              if (
                parent.alternatives[parent.selected] === branch &&
                parent.placement
              )
                parent.placement.pieces = clone(fragment.pieces);
            } catch (error) {
              if (error instanceof IntentError && error.code === "limit")
                throw error;
            }
          } else if (parent.kind !== "content") {
            branch.object = result.object;
            if (branch.node && (!authored.nodes[branch.node] ||
                await this.project(authored, branch.node) !== branch.object))
              delete branch.node;
          }
          // A structural child can change retained decisions without changing the
          // containing text. Its context root is never a text-fragment object.
          for (const child of authored.decisions)
            if (child.context === oldState) child.context = result.state;
        }
    }
  }
  /** A retained context state, as a copy the caller may edit. */
  async context(hash: string): Promise<IntentState> {
    return cloneState(await this.contextView(hash));
  }
  /** A retained context state, loaded and validated once per evaluation and
   * shared: callers only read it. */
  private async contextView(hash: string): Promise<IntentState> {
    let context = this.contexts.get(hash);
    if (!context) {
      const state = await loadIntentState(hash, (hash) => this.read(hash));
      context = await this.load({ object: await this.project(state), state: hash });
      this.contexts.set(hash, context);
    }
    return context;
  }
  /** Read history on demand when the basis is an editable state: its nodes
   * already reflect every deletion in its effects, so evaluation only needs
   * the records it touches. Non-editable states (transported, kept-current, imported beside history) load eagerly. */
  async detectLazy(ref: { state?: string }): Promise<boolean> {
    this.lazy = !this.eager && !!ref.state &&
      await isEditableState(ref.state, (hash) => this.read(hash));
    return this.lazy;
  }
  async record(state: IntentState, editable = false): Promise<{ object: string; state: string }> {
    const object = await this.project(state),
      stored = await storeLazyIntentState(state, (hash) => this.read(hash), (bytes) => this.put(bytes), editable);
    return { object, state: stored };
  }
  // What `current` recorded under keys `base` lacks. An evaluation compares
  // one fixed current/base pair that neither side edits, so each list is
  // read once however many operations or alternatives ask for it.
  private addedEffectList?: Promise<Effect[]>;
  private addedChangeList?: Promise<Array<{ change: string; checkpoint?: { affected: string[] } }>>;
  private addedEffects(current: IntentState, base: IntentState): Promise<Effect[]> {
    return (this.addedEffectList ??= since(current.effects, base.effects, same).then((effects) =>
      Object.entries(effects as Record<string, Effect>)
        .filter(([key]) => !Object.hasOwn(base.effects, key))
        .map(([, effect]) => effect)));
  }
  private addedChanges(current: IntentState, base: IntentState) {
    return (this.addedChangeList ??= (async () => {
      const added: Array<{ change: string; checkpoint?: { affected: string[] } }> = [];
      for (const [change, hash] of Object.entries(await since(current.changes, base.changes, same) as Record<string, string>)) {
        if (Object.hasOwn(base.changes, change)) continue;
        added.push({ change, checkpoint: JSON.parse(decoder.decode(await this.read(hash))).checkpoint });
      }
      return added;
    })());
  }
  async contributions(
    current: IntentState,
    base: IntentState,
    id: string
  ): Promise<Array<{ change: string; operation: string | null }>> {
    const result: Array<{ change: string; operation: string | null }> =
      (await this.addedEffects(current, base))
        .filter((e) => e.before[id] || e.after[id])
        .map((e) => ({ change: e.change, operation: e.operation }));
    for (const { change, checkpoint } of await this.addedChanges(current, base))
      if (checkpoint?.affected.includes(id))
        result.push({ change, operation: null });
    return result;
  }
  async run(incremental = true): Promise<IntentResponse> {
    const startedFast = performance.now();
    const fastForward = incremental ? await this.editFastForward() : undefined;
    engineDiagnostics["fast-forward-ms"] = performance.now() - startedFast;
    engineDiagnostics.path = fastForward ? 1 : 0;
    if (fastForward) return fastForward;
    const startedLoad = performance.now();
    // An editable base's nodes reflect every deletion in its effects, so only
    // newer effects are enforced and history is read on demand.
    await this.detectLazy(this.request.base);
    const request = this.request,
      base = await this.load(request.base),
      sameBasis = request.base.object === request.current.object && request.base.state === request.current.state,
      // A matching state/root pair was just fully validated. Alternatives may
      // mutate the authored basis, so copy that view rather than loading and
      // validating the identical retained graph a second time.
      current = sameBasis
        ? (!base.decisions.length && !request.alternatives?.length ? base : cloneState(base))
        : await this.load(request.current);
    await this.prefetch(base, current);
    engineDiagnostics["load-ms"] = performance.now() - startedLoad;
    if (this.lazy) this.appliedDeletions = base.effects;
    const signature = this.put(encodeJSON(changeIdentity(request)));
    const prior = Object.hasOwn(current.changes, request.incoming.change)
      ? current.changes[request.incoming.change]
      : undefined;
    if (prior && prior !== signature)
      return fail("Change identity reused with different intent");
    if (prior) {
      const result = await this.record(current);
      return this.response(result, current);
    }
    const guardDecisions = clone(base.decisions);
    for (const binding of request.alternatives ?? []) {
      const decision = base.decisions.find((d) => d.key === binding.decision),
        alternative = decision?.alternatives[binding.alternative];
      if (!alternative || alternative.object !== binding.value.object)
        return fail(
          "Alternative binding does not match retained decision material"
        );
      if (
        decision?.context &&
        (!alternative.node ||
          !base.nodes[alternative.node] ||
          (await this.project(base, alternative.node)) !== alternative.object)
      ) {
        const context = await loadIntentState(decision.context, (hash) => this.read(hash));
        const retained = context.decisions.find((d) => d.key === decision.key)
          ?.alternatives[binding.alternative];
        if (!retained?.node)
          throw new IntentError(
            "missing-context",
            "Context alternative material is unavailable"
          );
        const imported = this.importContext(
          base,
          { ...context, root: retained.node },
          `context:${binding.decision}:${binding.alternative}`
        );
        alternative.node = imported.root;
      }
      if (!alternative.node) {
        if (binding.value.kind !== "directory")
          return fail("Structural branch material is a directory");
        const context = await this.load({
          object: alternative.object,
          state: alternative.state,
        });
        const imported = this.importContext(
          base,
          context,
          `alternative:${binding.decision}:${binding.alternative}`
        );
        alternative.node = imported.root;
        for (const child of base.decisions)
          if (child.context === alternative.state && child.placement) {
            const node = imported.ids.get(child.placement.node);
            if (node) child.placement.node = node;
          }
      }
      const node = base.nodes[alternative.node];
      if (!node || node.kind !== binding.value.kind)
        return fail("Alternative kind does not match retained material");
      base.alternatives[alternativeKey(binding.ref)] = alternative.node;
    }
    // The alternatives above were the last edits to `base` and nothing edits
    // `current`, so their paths and records are computed once from here on.
    const operations = traceOperations(request.incoming),
      contributed = () => operations.map((op) => ({ change: request.incoming.change, operation: op.key }));
    const basePaths = new Map<string, string>(),
      basePath = (id: string) => {
        let path = basePaths.get(id);
        if (path === undefined) basePaths.set(id, (path = this.path(base, id)));
        return path;
      };
    let currentRecord: Promise<{ object: string; state: string }> | undefined;
    const recordCurrent = () => (currentRecord ??= this.record(current));
    const resolved = new Set(request.incoming.resolves ?? []);
    if (resolved.size !== (request.incoming.resolves?.length ?? 0))
      return fail("Duplicate resolution declaration");
    for (const key of resolved) {
      const decision = guardDecisions.find((d) => d.key === key),
        now = current.decisions.find((d) => d.key === key);
      if (!decision || !same(decision, now))
        return fail("Resolution decision is absent or stale");
    }
    const authored = cloneState(base);
    // Each frame is authored against its own `before` tree, so a later frame's
    // basis references name the previous frame's result. The frame a given
    // operation was authored in is kept for the concurrent replay below.
    let basis = cloneState(base);
    const authoredIn = new Map<string, View>();
    for (const [index, frame] of request.incoming.trace.entries()) {
      for (const operation of frame.operations) {
        authoredIn.set(operation.key, basis);
        await this.apply(authored, basis, operation, request.incoming.change);
      }
      // The final frame's result is checked below, after decisions propagate
      // and retained deletions are enforced; that is the candidate check this
      // evaluator has always made. Intermediate frames are checked as authored.
      if (index === request.incoming.trace.length - 1) break;
      if ((await this.project(authored)) !== frame.after)
        return fail("Frame does not reproduce its result");
      basis = cloneState(authored);
    }
    const wrapped = new Set<string>([...this.pendingEnclosures].filter(key => !resolved.has(key)));
    for (const decision of authored.decisions) {
      // Explicitly guarded replacement need not preserve the selected pieces of
      // the choice it resolves. Unguarded siblings still follow normal tracking.
      if (resolved.has(decision.key)) continue;
      for (const [index, alternative] of decision.alternatives.entries()) {
        if (!alternative.node) continue;
        const old = base.nodes[alternative.node],
          node = authored.nodes[alternative.node];
        if (!old || !node) continue;
        if (node.kind === "directory") {
          if (
            decision.context &&
            this.realm(authored, node.id) === authored.root
          )
            continue;
          const object = await this.project(authored, node.id);
          if (object !== alternative.object) {
            alternative.object = object;
            const context = cloneState(authored);
            context.root = node.id;
            await this.retainDirectoryAlternatives(context);
            alternative.state = (await this.record(context)).state;
            alternative.contributions.push(...contributed());
          }
          continue;
        }
        const placement = decision.placement,
          visibleBefore = placement ? base.nodes[placement.node] : undefined,
          visibleAfter = placement ? authored.nodes[placement.node] : undefined;
        // A decision with its own context is placed within that context, not
        // the live file, so live edits neither move nor enclose it.
        if (
          index === decision.selected &&
          placement &&
          !decision.context &&
          same(old, node) &&
          !same(visibleBefore, visibleAfter)
        ) {
          if (
            !visibleAfter?.active ||
            visibleAfter.kind !== "file" ||
            !visibleAfter.pieces
          ) {
            wrapped.add(decision.key);
            continue;
          }
          // An empty selection has no pieces to follow: carry its anchor
          // through the file's edits, enclosing only when an edit spans it.
          if (!placement.pieces.length && visibleBefore?.pieces) {
            let anchor = placement.anchor,
              spanned = false;
            for (const edit of await this.edits(visibleBefore.pieces, visibleAfter.pieces, authored)) {
              const [from, to] = edit.range;
              if (from < placement.anchor && to > placement.anchor) spanned = true;
              else if (to < placement.anchor || (to === placement.anchor && from < to))
                anchor += length(edit.pieces) - (to - from);
            }
            if (spanned) {
              wrapped.add(decision.key);
              continue;
            }
            placement.anchor = anchor;
            continue;
          }
          try {
            const at = await this.evolved(
              authored,
              visibleAfter.pieces,
              placement.pieces
            );
            node.pieces = clone(slice(visibleAfter.pieces, ...at));
            placement.pieces = clone(node.pieces);
            placement.anchor = at[0];
          } catch (error) {
            if (error instanceof IntentError && error.code === "limit")
              throw error;
            wrapped.add(decision.key);
            continue;
          }
        }
        if (same(old, node)) continue;
        alternative.object = await this.project(authored, node.id);
        alternative.contributions.push(...contributed());
        if (
          index === decision.selected &&
          decision.placement &&
          !decision.context
        ) {
          const target = authored.nodes[decision.placement.node];
          if (!target?.pieces)
            return fail("Selected alternative placement is unavailable");
          const located = decision.placement.pieces.length
            ? this.locate(target.pieces, decision.placement.pieces, [
                0,
                length(decision.placement.pieces),
              ])
            : [decision.placement.anchor, decision.placement.anchor];
          target.pieces = replacePieces(target.pieces, located[0]!, located[1]!, node.pieces ?? []);
          decision.placement.pieces = clone(node.pieces ?? []);
          decision.placement.anchor = located[0]!;
        }
      }
    }
    await this.propagateDecisions(authored, base);
    this.enforceDeletions(authored, await this.pendingDeletions(authored));
    const authoredRoot = await this.project(authored);
    if (authoredRoot !== request.incoming.object)
      return fail("Operations do not reproduce the complete candidate");
    authored.changes[request.incoming.change] = signature;
    if (wrapped.size) {
      const old = await this.record(base);
      for (const decision of authored.decisions)
        if (
          wrapped.has(decision.key) &&
          !this.pendingEnclosures.has(decision.key)
        )
          decision.context = decision.context ?? old.state;
      const candidate = await this.record(authored);
      const placements = [...wrapped].map(key => base.decisions.find(d => d.key === key)?.placement?.node);
      const fileID = placements.length && placements.every(id => id === placements[0]) ? placements[0] : undefined;
      const fileBefore = fileID ? base.nodes[fileID] : undefined;
      const fileAfter = fileID ? authored.nodes[fileID] : undefined;
      const filePath = fileID ? basePath(fileID) : undefined;
      const fileOnly = fileBefore?.pieces && fileAfter?.active && fileAfter.pieces &&
        operations.every(op => op.kind === "editSource" &&
          op.source.material.kind === "basis" && op.source.material.path === filePath);
      if (fileOnly) {
        const alternatives = [fileBefore!, fileAfter!].map((source, index) => {
          const node = clone(source);
          node.id = `enclosure-file:${request.incoming.change}:${index}`;
          node.parent = null;
          authored.nodes[node.id] = node;
          return node;
        });
        authored.decisions.push({
          key: `enclosure:${request.incoming.change}`, kind: "content", affected: [fileID!], selected: 1,
          alternatives: await Promise.all(alternatives.map(async (node, index) => ({
            state: index === 0 ? old.state : candidate.state, node: node.id,
            object: await this.project(authored, node.id),
            contributions: index === 0 ? [] : contributed(),
          }))),
          dependencies: [...wrapped], reason: "Source transformation encloses existing file decisions",
          subject: {material: {kind: "basis", path: filePath!, object: await this.project(base, fileID!)}},
          placement: {node: fileID!, pieces: clone(fileAfter!.pieces!), anchor: 0},
        });
      } else authored.decisions.push({
        key: `enclosure:${request.incoming.change}`,
        kind: "directory",
        affected: [base.root],
        selected: 1,
        alternatives: [
          { ...old, contributions: [] },
          {
            ...candidate,
            node: authored.root,
            contributions: contributed(),
          },
        ],
        dependencies: [...wrapped],
        reason: "Opaque transformation encloses existing decisions",
      });
    }
    // With an identical retained basis and no decisions, authored and accepted
    // material are identical. All operation/candidate checks above still run;
    // no second state copy, projection, or serialization is necessary.
    if (sameBasis && !authored.decisions.length && !resolved.size) {
      const result = await this.record(authored, true);
      return this.response(result, authored);
    }
    // Recording is immutable. Without resolution removals, copying the entire
    // authored graph/history before serializing it adds no isolation.
    const authoredSnapshot = resolved.size ? cloneState(authored) : authored;
    if (resolved.size) {
      authoredSnapshot.decisions = authoredSnapshot.decisions.filter(d => !resolved.has(d.key));
      for (const decision of authoredSnapshot.decisions)
        decision.dependencies = decision.dependencies.filter(d => !resolved.has(d));
    }
    this.authoredResult = await this.record(authoredSnapshot, true);
    let resultState = authored;
    // Whether every deletion in the result's effects is reflected in its nodes.
    let enforced = true;
    if (
      request.current.object !== request.base.object ||
      request.current.state !== request.base.state
    ) {
      // First enforce the complete causal context. Snapshot equality never invents
      // correspondence; branches without retained identity remain explicit choices.
      const structuralTransfer =
        operations.some((op) =>
          ["moveSource", "copySource"].includes(op.kind)
        ) ||
        (await this.addedEffects(current, base)).some((e) =>
          ["moveSource", "copySource"].includes(e.kind)
        );
      let transported: IntentState | undefined;
      if (
        structuralTransfer &&
        current.root === base.root &&
        authored.decisions.length === base.decisions.length
      ) {
        const attempt = cloneState(current);
        try {
          for (const operation of operations) {
            if (
              !["editSource", "moveSource", "copySource"].includes(
                operation.kind
              )
            )
              throw new Error(
                "Mixed structural transfer needs a coupled decision"
              );
            // Replaying a transfer must not quietly order concurrent insertions.
            // Compare immutable authored anchors before locating them in current.
            const anchorRef =
              operation.kind === "editSource"
                ? operation.source
                : operation.kind === "moveSource" ||
                  operation.kind === "copySource"
                ? operation.at
                : undefined;
            const frameBasis = authoredIn.get(operation.key) ?? basis;
            if (anchorRef) {
              const anchor = await this.selection(anchorRef, frameBasis, authored);
              const old = base.nodes[anchor.node],
                now = current.nodes[anchor.node];
              if (
                anchor.range[0] === anchor.range[1] &&
                old?.pieces &&
                now?.pieces &&
                pieceEdits(old.pieces, now.pieces).some(
                  (e) =>
                    e.range[0] === e.range[1] && e.range[0] === anchor.range[0]
                )
              )
                throw new Error(
                  "Concurrent source destination requires anchor policy"
                );
            }
            if (operation.kind === "moveSource") {
              const selected = await this.selection(
                operation.source,
                frameBasis,
                authored
              );
              for (const effect of await this.addedEffects(current, base))
                if (
                  effect.kind === "moveSource" &&
                  Object.values(effect.before).some((n) =>
                    n.pieces?.some((p) =>
                      selected.selected.some((q) => intersect(p, q))
                    )
                  )
                )
                  throw new Error("Competing source moves");
            }
            await this.apply(
              attempt,
              frameBasis,
              operation,
              request.incoming.change
            );
          }
          // Format rules inspect all branches and the replay result. Successful
          // source location alone does not establish semantic independence.
          for (const id of Object.keys(base.nodes)) {
            const b = base.nodes[id]!,
              next = attempt.nodes[id];
            if (
              b.kind !== "file" ||
              !next?.active ||
              same(b.pieces, next.pieces)
            )
              continue;
            const path = basePath(id),
              config = request.rules.config?.formats?.[path];
            const evidence = evaluateSourceTransfer(path, [
              await this.bytes(b.pieces ?? []),
              await this.bytes(current.nodes[id]?.pieces ?? []),
              await this.bytes(authored.nodes[id]?.pieces ?? []),
              await this.bytes(next.pieces ?? []),
            ], config);
            this.formatEvidence.push(evidence);
            if (evidence.outcome !== "resolved")
              throw new Error("Transfer requires format review");
          }
          for (const operation of operations) {
            const key = keyOf(request.incoming.change, operation.key);
            if (authored.outputs[key])
              attempt.outputs[key] = clone(authored.outputs[key]!);
          }
          attempt.changes[request.incoming.change] = signature;
          await this.project(attempt);
          transported = attempt;
        } catch (error) {
          if (
            error instanceof IntentError &&
            ["limit", "missing-context"].includes(error.code)
          )
            throw error;
        }
      }
      const merged = cloneState(current),
        affected: string[] =
          structuralTransfer && !transported ? [base.root] : [];
      // Merging edits `merged` only, so the candidate records once as well.
      let candidateRecord: Promise<{ object: string; state: string }> | undefined;
      const recordCandidate = () => (candidateRecord ??= this.record(authored));
      for (const decision of authored.decisions) {
        const before = base.decisions.find((d) => d.key === decision.key),
          index = merged.decisions.findIndex((d) => d.key === decision.key);
        if (!same(before, decision)) {
          if (index < 0 && !before) merged.decisions.push(clone(decision));
          else if (index < 0 || !same(merged.decisions[index], before))
            affected.push(...decision.affected);
          else merged.decisions[index] = clone(decision);
        }
      }
      // A queued successor is authored on its predecessor's candidate, which
      // may now be a hidden alternative. Match retained occurrence provenance,
      // never equal bytes, before reconciling against the visible projection.
      const continuedNodes = new Set<string>();
      let branchContinuation = false,
        baseVisible: unknown;

      for (const decision of merged.decisions) {
        if (decision.kind !== "directory") continue;
        for (const [index, alternative] of decision.alternatives.entries()) {
          if (
            index === decision.selected ||
            alternative.object !== request.base.object
          )
            continue;
          const context = await this.contextView(alternative.state);
          const visible = (view: IntentState) =>
            Object.values(view.nodes)
              .filter((n) => n.active && this.realm(view, n.id) === view.root)
              .map((n) => [
                this.path(view, n.id),
                n.kind,
                n.kind === "file"
                  ? n.pieces
                  : n.kind === "tree"
                  ? n.object
                  : null,
              ])
              .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
          if (!same((baseVisible ??= visible(base)), visible(context))) continue;
          branchContinuation = true;
          alternative.object = this.authoredResult!.object;
          alternative.state = this.authoredResult!.state;
          delete alternative.node;
          alternative.contributions.push(...contributed());
          for (const id of Object.keys(base.nodes)) continuedNodes.add(id);
          for (const id of Object.keys(authored.nodes)) continuedNodes.add(id);
        }
      }
      for (const [id, before] of Object.entries(base.nodes)) {
        const after = authored.nodes[id];
        if (!before.pieces || !after?.pieces || same(before, after)) continue;
        let authoredEdits: Promise<PieceEdit[]> | undefined;
        const edits = () => (authoredEdits ??= this.edits(before.pieces!, after.pieces!, authored));
        const matches = merged.decisions.flatMap((decision) =>
          decision.kind === "content"
            ? decision.alternatives.flatMap((alternative, index) => {
                const node = alternative.node
                  ? merged.nodes[alternative.node]
                  : undefined;
                return node?.pieces && same(node.pieces, before.pieces)
                  ? [{ decision, alternative, index, node }]
                  : [];
              })
            : []
        );
        // A source choice contains a fragment, while its retained context
        // identifies the complete authored branch. Match that provenance first;
        // equal source bytes alone never authorize branch continuation.
        if (!matches.length) {
          const changed = await edits();
          for (const decision of merged.decisions) {
            if (decision.kind !== "content") continue;
            for (const [index, alternative] of decision.alternatives.entries()) {
              if (index === decision.selected && !decision.context) continue;
              const node = alternative.node ? merged.nodes[alternative.node] : undefined;
              if (!node?.pieces?.length) continue;
              const context = await this.contextView(alternative.state);
              if (!same(context.nodes[id]?.pieces, before.pieces)) continue;
              let at: [number, number];
              try { at = this.locate(before.pieces, node.pieces, [0, length(node.pieces)]); }
              catch (error) {
                if (error instanceof IntentError && error.code === "limit") throw error;
                continue;
              }
              if (!changed.length || changed.some(e => e.range[0] < at[0] || e.range[1] > at[1])) continue;
              matches.push({ decision, alternative, index, node });
            }
          }
        }
        if (matches.length !== 1) continue;
        const { decision, alternative, index, node } = matches[0]!;
        // Visible edits already use the ordinary three-way path.
        if (index === decision.selected && !decision.context) continue;
        if (same(node.pieces, before.pieces)) node.pieces = clone(after.pieces);
        else {
          const at = this.locate(before.pieces, node.pieces!, [0, length(node.pieces!)]);
          node.pieces = normalize(applyPieceEdits(node.pieces!, (await edits()).map(e => ({
            ...e, range: [e.range[0] - at[0], e.range[1] - at[0]] as [number, number],
          }))));
        }
        alternative.object = await this.project(merged, node.id);
        alternative.state = this.authoredResult!.state;
        alternative.contributions.push(...contributed());
        continuedNodes.add(id);
      }
      if (branchContinuation) affected.length = 0;
      const contentDecisions: IntentState["decisions"] = [];
      let branchStates:
        | {
            old: { object: string; state: string };
            candidate: { object: string; state: string };
          }
        | undefined;
      const existenceChoice = async (id: string, sides: [Node | undefined, Node | undefined]) => {
        branchStates ??= {
          old: await recordCurrent(),
          candidate: await recordCandidate(),
        };
        const selectedSide = request.rules.config?.conflictProjection === "current" ? 0 : 1;
        const alternatives = await Promise.all(sides.map(async (node, side) => {
          const branch = side === 0 ? branchStates!.old : branchStates!.candidate;
          const contributions = side === 0
            ? await this.contributions(current, base, id)
            : contributed();
          // The deleted side names its whole branch and no node of its own.
          if (!node?.active || !node.pieces) return { ...branch, contributions };
          const occurrence = clone(node);
          occurrence.id = `existence:${request.incoming.change}:${id}:${side}`;
          occurrence.parent = null;
          merged.nodes[occurrence.id] = occurrence;
          return { state: branch.state, object: await this.project(merged, occurrence.id), node: occurrence.id, contributions };
        }));
        const chosen = sides[selectedSide];
        if (chosen) merged.nodes[id] = clone(chosen);
        else delete merged.nodes[id];
        contentDecisions.push({
          key: `${request.incoming.change}:existence:${id}`,
          kind: "existence",
          affected: [id],
          selected: selectedSide,
          alternatives,
          dependencies: current.decisions.filter((d) => d.affected.includes(id)).map((d) => d.key),
          reason: "Deleted in one version and changed in another",
          subject: { material: { kind: "basis", path: basePath(id), object: await this.project(base, id) } },
        });
      };
      for (const id of new Set([
        ...Object.keys(base.nodes),
        ...Object.keys(authored.nodes),
      ])) {
        if (continuedNodes.has(id)) continue;
        const b = base.nodes[id],
          incoming = authored.nodes[id],
          remote = merged.nodes[id];
        if (same(b, incoming)) continue;
        if (!b) {
          if (remote && !same(remote, incoming)) affected.push(id);
          else if (incoming) merged.nodes[id] = clone(incoming);
          continue;
        }
        const existenceConflict = !incoming || !remote || (
          b.active &&
          incoming.active !== remote.active &&
          !same(incoming, remote) &&
          !same(incoming, b) &&
          !same(remote, b)
        );
        if (existenceConflict) {
          // A file deleted on one side and changed on the other is a choice
          // about that file alone; everything else still merges.
          if (b.kind === "file" && b.active) await existenceChoice(id, [remote, incoming]);
          else affected.push(id);
          continue;
        }
        for (const field of Object.keys(incoming) as Array<keyof Node>) {
          if (same(b[field], incoming[field])) continue;
          if (field === "deletions") {
            const prior = new Set(b.deletions ?? []),
              desired = new Set(incoming.deletions ?? []);
            remote.deletions = [
              ...new Set([
                ...(remote.deletions ?? []).filter(
                  (d) => !prior.has(d) || desired.has(d)
                ),
                ...[...desired].filter((d) => !prior.has(d)),
              ]),
            ].sort();
            continue;
          }
          if (!same(remote[field], b[field])) {
            if (same(remote[field], incoming[field])) continue;
            if (
              field === "pieces" &&
              b.pieces &&
              incoming.pieces &&
              remote.pieces
            ) {
              const localEdits = await this.edits(
                  b.pieces,
                  incoming.pieces,
                  authored
                ),
                remoteEdits = await this.edits(b.pieces, remote.pieces, current);
              let basisBytes: Promise<Uint8Array> | undefined;
              const baseBytes = () => (basisBytes ??= this.bytes(b.pieces!));
              if (
                !localEdits.some((a) => remoteEdits.some((c) => overlap(a, c)))
              ) {
                const proposal = normalize(
                  applyPieceEdits(b.pieces, [...localEdits, ...remoteEdits])
                );
                const path = basePath(id);
                const evidence = await evaluateFormat(
                  path,
                  await baseBytes(),
                  await this.bytes(remote.pieces),
                  await this.bytes(incoming.pieces),
                  await this.bytes(proposal),
                  remoteEdits,
                  localEdits,
                  this.request.rules.config?.formats?.[path]
                );
                this.formatEvidence.push(evidence);
                if (evidence.outcome === "resolved") {
                  remote.pieces = proposal;
                  continue;
                }
              }
              branchStates ??= {
                old: await recordCurrent(),
                candidate: await recordCandidate(),
              };
              const left: Array<PieceEdit & { side: number }> = remoteEdits.map(
                (e) => ({ ...e, side: 0 })
              );
              const right = localEdits.map((e) => ({ ...e, side: 1 }));
              const edits: Array<PieceEdit & { side: number }> = [
                ...left,
                ...right,
              ].sort((a, c) => a.range[0] - c.range[0]);
              const groups: Array<Array<PieceEdit & { side: number }>> = [];
              for (const edit of edits) {
                const last = groups.at(-1);
                if (last?.some((e) => overlap(e, edit))) last.push(edit);
                else groups.push([edit]);
              }
              // A policy refusal couples this file even if byte edits are disjoint.
              const hasOverlap = groups.some(
                (g) =>
                  g.some((e) => e.side === 0) && g.some((e) => e.side === 1)
              );
              let coupledByFormat = !hasOverlap;
              if (hasOverlap) {
                const path = basePath(id);
                const tentative = applyPieceEdits(b.pieces, [
                  ...right,
                  ...left.filter((a) => !right.some((b) => overlap(a, b))),
                ]);
                const policy = await evaluateFormat(
                  path,
                  await baseBytes(),
                  await this.bytes(remote.pieces),
                  await this.bytes(incoming.pieces),
                  await this.bytes(tentative),
                  left,
                  right,
                  request.rules.config?.formats?.[path]
                );
                this.formatEvidence.push(policy);
                coupledByFormat = policy.outcome !== "resolved";
              }
              if (
                coupledByFormat &&
                edits.every((e) => e.range[0] === e.range[1])
              ) {
                const path = basePath(id),
                  bytes = await baseBytes();
                const policies = await Promise.all(
                  groups.map(async (group) =>
                    evaluateProseInsertions(
                      path,
                      bytes,
                      group[0]!.range[0],
                      await Promise.all(group.map((e) => this.bytes(e.pieces))),
                      request.rules.config?.formats?.[path]
                    )
                  )
                );
                this.formatEvidence.push(...policies);
                if (policies.every((p) => p.outcome === "resolved"))
                  coupledByFormat = false;
              }
              if (coupledByFormat) groups.splice(0, groups.length, edits);
              const selected = [];
              for (const group of groups) {
                const start = Math.min(...group.map((e) => e.range[0])),
                  end = Math.max(...group.map((e) => e.range[1]));
                const versions = [0, 1].map((side) =>
                  applyPieceEdits(
                    slice(b.pieces!, start, end),
                    group
                      .filter((e) => e.side === side)
                      .map((e) => ({
                        range: [e.range[0] - start, e.range[1] - start] as [
                          number,
                          number
                        ],
                        pieces: e.pieces,
                      }))
                  )
                );
                if (
                  group.some((e) => e.side === 0) &&
                  group.some((e) => e.side === 1)
                ) {
                  const formatConfig =
                    request.rules.config?.formats?.[basePath(id)];
                  if (start === end) {
                    const basisOrigins = new Set(b.pieces.map((p) => p.origin));
                    await this.originChains([current, authored], versions.flat());
                    const origins = (origin: string) =>
                      Object.hasOwn(authored.origins, origin)
                        ? authored.origins[origin]
                        : current.origins[origin];
                    const contribution = (
                      origin: string,
                      seen = new Set<string>()
                    ): string => {
                      if (seen.has(origin) || seen.size > 256) return origin;
                      const parents = origins(origin);
                      if (
                        parents?.length &&
                        parents.every((p) => !basisOrigins.has(p.origin))
                      ) {
                        const keys = new Set(
                          parents.map((p) =>
                            contribution(p.origin, new Set(seen).add(origin))
                          )
                        );
                        if (keys.size === 1) return [...keys][0]!;
                      }
                      // Copy suffixes identify pieces of one fresh contribution.
                      return origin.startsWith("[")
                        ? origin.slice(0, origin.indexOf("]") + 1)
                        : origin;
                    };
                    const contributions = new Map<string, Piece[]>();
                    for (const pieces of versions)
                      for (const piece of pieces) {
                        const key = contribution(piece.origin);
                        const group = contributions.get(key) ?? [];
                        group.push(piece);
                        contributions.set(key, group);
                      }
                    const combined = [...contributions]
                      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
                      .flatMap(([, pieces]) => pieces);
                    const policy = evaluateProseInsertions(
                      basePath(id),
                      await baseBytes(),
                      start,
                      await Promise.all(versions.map((p) => this.bytes(p))),
                      formatConfig
                    );
                    this.formatEvidence.push(policy);
                    if (
                      policy.outcome === "resolved" &&
                      /^(markdown|text)-/.test(policy.id)
                    ) {
                      selected.push({
                        range: [start, end] as [number, number],
                        pieces: combined,
                      });
                      continue;
                    }
                  }
                  const selectedSide = request.rules.config?.conflictProjection === "current" ? 0 : 1;
                  const path = basePath(id),
                    object = await this.project(base, id);
                  contentDecisions.push({
                    key: `${request.incoming.change}:${id}:${start}:${end}`,
                    kind: "content",
                    affected: [id],
                    selected: selectedSide,
                    subject: {
                      material: { kind: "basis", path, object },
                      range: [start, end],
                    },
                    placement: {
                      node: id,
                      pieces: clone(versions[selectedSide]!),
                      anchor: start,
                    },
                    alternatives: await Promise.all(
                      versions.map(async (pieces, side) => {
                        const object = this.put(await this.bytes(pieces)),
                          node = `choice:${request.incoming.change}:${id}:${start}:${end}:${side}`;
                        // Alternative material has its own occurrence; binding it is
                        // explicit and cannot accidentally target equal visible text.
                        merged.nodes[node] = {
                          id: node,
                          parent: null,
                          name: "",
                          kind: "file",
                          object,
                          pieces: clone(pieces),
                          active: true,
                        };
                        return {
                          state:
                            side === 0
                              ? branchStates!.old.state
                              : branchStates!.candidate.state,
                          object,
                          node,
                          contributions:
                            side === 0
                              ? await this.contributions(current, base, id)
                              : contributed(),
                        };
                      })
                    ),
                    dependencies: current.decisions
                      .filter(d => {
                        if (!d.affected.includes(id)) return false;
                        if (!d.placement || d.context) return true;
                        try {
                          const at = d.placement.pieces.length
                            ? this.locate(b.pieces!, d.placement.pieces, [0, length(d.placement.pieces)])
                            : [d.placement.anchor, d.placement.anchor];
                          return overlap({range: [start, end], pieces: []}, {range: [at[0]!, at[1]!], pieces: []});
                        } catch (error) {
                          if (error instanceof IntentError && error.code === "limit") throw error;
                          return true;
                        }
                      })
                      .map((d) => d.key),
                    reason: coupledByFormat
                      ? "Format policy requires a coupled source choice"
                      : "Overlapping source contributions",
                  });
                  selected.push({
                    range: [start, end] as [number, number],
                    pieces: versions[selectedSide]!,
                  });
                } else selected.push(...group);
              }
              remote.pieces = normalize(applyPieceEdits(b.pieces, selected));
              continue;
            }
            affected.push(id);
            continue;
          }
          (remote as unknown as Record<string, unknown>)[field] = clone(
            incoming[field]
          );
        }
      }
      for (const map of [
        "outputs",
        "effects",
        "origins",
        "alternatives",
      ] as const) {
        for (const [key, value] of Object.entries(await since(authored[map], base[map], same)))
          (merged[map] as Record<string, unknown>)[key] = clone(value);
      }
      merged.changes[request.incoming.change] = signature;
      for (const node of Object.values(merged.nodes))
        if (node.deletions?.length) node.active = false;
      const kept = new Map<string, Piece[]>();
      for (const decision of contentDecisions)
        if (decision.placement)
          kept.set(decision.placement.node, [...(kept.get(decision.placement.node) ?? []), ...decision.placement.pieces]);
      this.enforceDeletions(merged, await this.pendingDeletions(merged), kept);
      try {
        if (!affected.length) await this.project(merged);
      } catch (error) {
        if (error instanceof IntentError && error.code === "limit") throw error;
        affected.push(merged.root);
      }
      if (affected.length) {
        const old = await recordCurrent(),
          candidate = await recordCandidate();
        const decision = {
          key: `change:${request.incoming.change}`,
          kind: "directory" as const,
          affected: [...new Set(affected)].sort(),
          selected: 1,
          alternatives: [
            { ...old, contributions: [] },
            {
              ...candidate,
              node: authored.root,
              contributions: contributed(),
            },
          ],
          dependencies: current.decisions.map((d) => d.key),
          reason: "Concurrent material changes require a choice",
        };
        const retained = new Map<string, IntentState["decisions"][number]>(
          current.decisions.map((d) => [
            d.key,
            { ...clone(d), context: d.context ?? old.state },
          ])
        );
        for (const authoredDecision of authored.decisions)
          if (!retained.has(authoredDecision.key))
            retained.set(authoredDecision.key, clone(authoredDecision));
        decision.dependencies = [...retained.keys()];
        resultState.decisions = [...retained.values(), decision];
      } else {
        merged.decisions.push(...contentDecisions);
        resultState = merged;
      }
      if (transported) {
        resultState = transported;
        enforced = false;
      }
    }
    // Presentation granularity and selected projection are policy, not a second
    // executor. Canopy initially requests whole-file choices for installed clients.
    if (request.rules.config?.contentChoices === "file") {
      const fresh = resultState.decisions.filter(
        (d) =>
          d.kind === "content" &&
          !current.decisions.some((old) => old.key === d.key)
      );
      const groups = new Map<string, IntentDecision[]>();
      for (const decision of fresh) {
        const node = decision.placement!.node;
        const group = groups.get(node) ?? [];
        group.push(decision);
        groups.set(node, group);
      }
      for (const [node, group] of groups) {
        const values = [current.nodes[node], authored.nodes[node]];
        if (values.some((n) => !n?.pieces)) continue;
        const decision = group[0]!,
          keys = new Set(group.map((d) => d.key));
        decision.selected =
          request.rules.config?.conflictProjection === "current" ? 0 : 1;
        decision.alternatives = await Promise.all(
          values.map(async (value, index) => {
            const occurrence = clone(value!);
            occurrence.id = `file-choice:${decision.key}:${index}`;
            occurrence.parent = null;
            resultState.nodes[occurrence.id] = occurrence;
            const object = await this.project(resultState, occurrence.id);
            // `authored` may be the result state, which this pass edits.
            const context = await (index === 0 ? recordCurrent() : this.record(authored));
            return {
              ...context,
              object,
              node: occurrence.id,
              contributions: [
                ...new Map(
                  group
                    .flatMap((d) => d.alternatives[index]!.contributions)
                    .map((c) => [stableJSONString(c), c])
                ).values(),
              ],
            };
          })
        );
        const chosen = values[decision.selected]!;
        resultState.nodes[node]!.pieces = clone(chosen.pieces!);
        decision.placement = { node, pieces: clone(chosen.pieces!), anchor: 0 };
        decision.subject = {
          material: {
            kind: "basis",
            path: basePath(node),
            object: await this.project(base, node),
          },
        };
        resultState.decisions = resultState.decisions.filter(
          (d) => !keys.has(d.key) || d === decision
        );
        for (const d of resultState.decisions)
          d.dependencies = [
            ...new Set(
              d.dependencies.map((key) => (keys.has(key) ? decision.key : key))
            ),
          ].filter((key) => key !== d.key);
      }
    }
    if (request.rules.config?.conflictProjection === "current") {
      const rootChoice = resultState.decisions.find(
        (d) =>
          d.kind === "directory" &&
          d.key === `change:${request.incoming.change}`
      );
      if (rootChoice) {
        resultState.nodes = clone(current.nodes);
        resultState.root = current.root;
        enforced = false;
        rootChoice.selected = 0;
        for (const map of [
          "outputs",
          "effects",
          "origins",
          "changes",
          "alternatives",
        ] as const)
          resultState[map] = (await union(current[map], resultState[map], same)).map as never;
        for (const old of current.decisions) {
          const index = resultState.decisions.findIndex(
            (d) => d.key === old.key
          );
          if (index >= 0) resultState.decisions[index] = clone(old);
        }
        for (const decision of resultState.decisions)
          for (const alternative of decision.alternatives)
            if (
              alternative.node &&
              (!resultState.nodes[alternative.node]?.active ||
                (await this.project(resultState, alternative.node)) !==
                  alternative.object)
            )
              delete alternative.node;
      }
    }
    let continuedContext: { object: string; state: string } | undefined;
    for (const decision of resultState.decisions) {
      if (decision.context) continue;
      if (decision.placement) {
        const node = resultState.nodes[decision.placement.node];
        try {
          if (!node?.active || !node.pieces)
            throw new Error("Placement disappeared");
          // An empty selection (a retained deletion) has no pieces to find;
          // it stays attached at its anchor, as validation accepts.
          if (!decision.placement.pieces.length) {
            if (decision.placement.anchor > length(node.pieces))
              throw new Error("Anchor is outside its material");
            continue;
          }
          const at = this.locate(node.pieces, decision.placement.pieces, [
            0,
            length(decision.placement.pieces),
          ]);
          decision.placement.anchor = at[0];
        } catch (error) {
          if (error instanceof IntentError && error.code === "limit")
            throw error;
          continuedContext ??= await recordCurrent();
          decision.context = continuedContext.state;
        }
      }
    }
    for (const decision of resultState.decisions) {
      if (decision.context || decision.kind !== "directory") continue;
      const selected = decision.alternatives[decision.selected]!;
      if (selected.node === resultState.root) {
        const root = await this.project(resultState);
        if (root !== selected.object) {
          selected.object = root;
          selected.state = (await this.record(resultState)).state;
        }
      }
    }
    // Resolution moves placements, never nodes.
    const realm = this.realms(resultState);
    for (const key of resolved) {
      const enclosing = resultState.decisions.find((d) => d.key === key);
      if (!enclosing) continue;
      for (const dependency of enclosing.dependencies) {
        if (resolved.has(dependency)) continue;
        const child = resultState.decisions.find((d) => d.key === dependency);
        if (!child?.placement)
          return fail("Coupled decisions require one guarded resolution");
        const matches: Array<{ node: Node; range: [number, number] }> = [];
        for (const node of Object.values(resultState.nodes)) {
          if (
            !node.active ||
            !node.pieces ||
            realm(node.id) !== resultState.root
          )
            continue;
          try {
            const range = this.locate(node.pieces, child.placement.pieces, [
              0,
              length(child.placement.pieces),
            ]);
            matches.push({ node, range });
          } catch (error) {
            if (error instanceof IntentError && error.code === "limit")
              throw error;
          }
        }
        if (matches.length !== 1)
          return fail(
            "Resolution would discard an unguarded dependent decision"
          );
        const match = matches[0]!;
        child.placement = {
          node: match.node.id,
          pieces: clone(slice(match.node.pieces!, ...match.range)),
          anchor: match.range[0],
        };
        child.affected = [match.node.id];
        delete child.context;
      }
    }
    resultState.decisions = resultState.decisions.filter(
      (d) => !resolved.has(d.key)
    );
    for (const decision of resultState.decisions)
      decision.dependencies = decision.dependencies.filter(
        (key) => !resolved.has(key)
      );
    const result = await this.record(resultState, enforced);
    return this.response(result, resultState);
  }
  /** Recover projected file hashes from accepted directory metadata, without
   * rereading file bodies or re-proving the host-validated state/root relation. */
  private async trustedProjection(state: IntentState, object: string): Promise<ValidatedMaterial> {
    const index = this.childIndex(state);
    const material: ValidatedMaterial = new Map();
    const visit = async (id: string, hash: string, depth: number): Promise<void> => {
      this.checkBudget();
      if (depth > 256) return fail("Directory depth budget exceeded");
      const node = state.nodes[id] ?? fail("Missing validated node");
      if (node.kind === "file") { material.set(id, {node, object: hash}); return; }
      if (node.kind === "tree") return;
      const entries = new Map(decodeWireDirectory(await this.read(hash)).entries.map(e => [e.name, e]));
      for (const child of this.children(state, id, index)) {
        const entry = entries.get(child.name);
        const target = entry && (child.kind === "file" && "file" in entry ? entry.file
          : child.kind === "directory" && "directory" in entry ? entry.directory
          : child.kind === "tree" && "tree" in entry ? entry.tree : undefined);
        if (!target) return fail("Validated basis directory mismatch");
        await visit(child.id, target, depth + 1);
      }
    };
    await visit(state.root, object, 0);
    return material;
  }

  /** Exact-basis source replacements and entry additions cannot import
   * historical material (an added entry brings only fresh objects). Read
   * current nodes and identity keys, then append records by path-copying their
   * maps. Existing history remains reachable without being decoded or copied. */
  private async editFastForward(): Promise<IntentResponse | undefined> {
    const request = this.request;
    // Decline reasons are diagnostics only (see engineDiagnostics.decline):
    // 1 divergent or stateless basis, 2 alternatives/resolutions, 3 no operations,
    // 4 non-basis or lineage-bearing operation, 5 unreadable state, 6 decisions,
    // 7 change already recorded, 8 trace not rooted at the basis.
    const decline = (reason: number) => { engineDiagnostics.decline = reason; return undefined; };
    if (!request.base.state || request.base.state !== request.current.state ||
        request.base.object !== request.current.object) return decline(1);
    if (request.alternatives?.length || request.incoming.resolves?.length) return decline(2);
    const trace = request.incoming.trace;
    const operations = traceOperations(request.incoming);
    if (!operations.length) return decline(3);
    if (!operations.every(op =>
          op.kind === "editSource" ? op.source.material.kind === "basis" && !op.lineage?.length
          : op.kind === "addEntry" && op.destination.parent.material.kind === "basis")) return decline(4);
    if (trace[0]!.before !== request.base.object) return decline(8);
    const partial = await loadEditableIntentState(request.base.state, hash => this.read(hash));
    if (!partial) return decline(5);
    if (partial.value.decisions.length) return decline(6);
    // The identity lookup must consult retained history, not the empty write set.
    if (await partial.get("changes", request.incoming.change) !== undefined) return decline(7);
    // The host supplies a previously validated state/root pair. Recover file
    // hashes from directory metadata; do not revalidate accepted file bodies.
    const basis = partial.value;
    if (basis.tree !== request.tree) return fail("Invalid material state tree");
    const projected = await this.trustedProjection(basis, request.base.object);
    this.projection = {previous: projected, next: new Map()};
    const authored = cloneState(basis);
    // Frames apply in order. Each one is authored against the previous frame's
    // result, which this path has just projected, so its material needs no
    // second trusted projection; the projected file objects carry forward.
    let frameBasis: View = basis;
    let object = request.base.object;
    for (const frame of trace) {
      for (const operation of frame.operations) {
        if (await partial.get("effects", keyOf(request.incoming.change, operation.key)) !== undefined)
          return fail("Operation identity reused");
        await this.apply(authored, frameBasis, operation, request.incoming.change, frame.before);
      }
      // Historical deletions have already been applied to this exact basis. These
      // operations introduce only fresh source origins, so only new deletion
      // effects can remove any additional material.
      this.enforceDeletions(authored);
      object = await this.project(authored);
      if (object !== frame.after)
        return fail(trace.length > 1
          ? "Frame does not reproduce its result"
          : "Operations do not reproduce the complete candidate");
      frameBasis = cloneState(authored);
      // Carry the projected file objects into the next frame, detached from the
      // live nodes: the next frame edits those nodes in place, and a reused
      // entry must still describe the material as this frame left it.
      this.projection = {
        previous: new Map([...this.projection!.next].map(([id, entry]) => [id, {node: clone(entry.node), object: entry.object}])),
        next: new Map(),
      };
    }
    if (object !== request.incoming.object) return fail("Operations do not reproduce the complete candidate");
    authored.changes[request.incoming.change] = this.put(encodeJSON(changeIdentity(request)));
    const state = await partial.store(authored, bytes => this.put(bytes));
    return this.response({object, state}, authored);
  }
  response(
    result: { object: string; state: string },
    state: IntentState
  ): IntentResponse {
    return {
      outcome: "evaluated",
      result,
      authored: this.authoredResult ?? result,
      objects: [...this.generated.keys()],
      decisions: state.decisions,
      evidence: {
        rule: { id: "tree-default", revision: 1 },
        inputs: {
          base: this.request.base.object,
          current: this.request.current.object,
          incoming: this.request.incoming.object,
        },
        change: this.request.incoming.change,
        operations: traceOperations(this.request.incoming).map((op) => op.key),
        validation: "verified",
        formats: this.formatEvidence,
      },
    };
  }
}

/** Diagnostics for the most recent evaluation in this process: which path ran
 * (1 = exact-basis fast forward, 0 = full evaluator) and phase durations. No
 * request content. */
export const engineDiagnostics: Record<string, number> = {};

export async function mergeIntent(
  raw: IntentRequestInput,
  objects: MergeObjects,
  options: {incremental?: boolean; eager?: boolean} = {}
): Promise<IntentResponse> {
  try {
    const engine = new Engine(parseIntentRequest(raw), objects);
    // Eager evaluation reads and re-enforces all history. It is the reference
    // the differential suite compares the history-proportional path against.
    engine.eager = options.eager ?? false;
    const result = await engine.run(options.incremental);
    await objects.store(
      [...engine.generated].map(([hash, bytes]) => ({ hash, bytes }))
    );
    return result;
  } catch (error) {
    if (error instanceof IntentError)
      return { outcome: error.code, message: error.message };
    return {
      outcome: "invalid",
      message:
        error instanceof Error ? error.message : "Invalid intent request",
    };
  }
}

/** Rebind an accepted snapshot without asserting a move, copy or source lineage.
 * Unchanged occurrences retain origins; changed bytes are an opaque barrier.
 * Existing decisions whose projection disappears are enclosed, never erased. */
export async function checkpointIntent(
  request: import("./checkpoint.ts").CheckpointRequest,
  objects: MergeObjects
): Promise<import("./checkpoint.ts").CheckpointResponse> {
  const engine = new Engine(
    {
      kind: "tree",
      tree: request.tree,
      base: request.current,
      current: request.current,
      incoming: {
        change: request.change,
        object: request.projection,
        trace: [],
      },
      rules: { id: "tree-default", revision: 1 },
    },
    objects
  );
  // A checkpoint of an editable state needs its active material and the
  // records it writes, never the whole history: the trusted projection seeds
  // per-file objects from the accepted root, and lazy views path-copy on store.
  // A first import has no effects, so it vacuously enforces every deletion
  // they name: it is editable, and the tree's first edit can fast-forward.
  const editable = (await engine.detectLazy(request.current)) || !request.current.state;
  const previous = await engine.load(request.current);
  const state = cloneState(previous);
  // The previous state as a record: a wrapped decision's context and the kept
  // alternative. Only decisions need it, so a plain snapshot never stores it.
  let previousRecorded: Promise<{ object: string; state: string }> | undefined;
  const previousRecord = () => (previousRecorded ??= engine.record(previous));
  const resolved = new Set(request.resolves ?? []);
  for (const key of resolved) {
    const decision = state.decisions.find((d) => d.key === key);
    if (!decision) throw new Error("Resolution decision is unavailable");
    if (
      request.projection !== request.current.object &&
      decision.dependencies.some((d) => !resolved.has(d))
    )
      throw new Error("Snapshot resolution must guard dependent decisions");
  }
  state.decisions = state.decisions.filter((d) => !resolved.has(d.key));
  for (const decision of state.decisions)
    decision.dependencies = decision.dependencies.filter(
      (d) => !resolved.has(d)
    );
  const oldObjects = new Map<string, string>();
  engine.knownLengths = new Map();
  const previousChildren = engine.childIndex(previous);
  for (const node of Object.values(previous.nodes))
    if (node.active && node.kind === "file") {
      const object = await engine.project(previous, node.id, new Set(), previousChildren);
      oldObjects.set(node.id, object);
      if (node.pieces) engine.knownLengths.set(object, length(node.pieces));
    }
  const fresh = await engine.initial(request.projection);
  engine.knownLengths = undefined;
  // New material is named by this change and its path, never by the projected
  // root: checkpoints of one change onto one state (the accepted projection
  // and the author's own candidate) then agree wherever their bytes agree, so
  // a batch suffix authored against the candidate still finds its material.
  const local = (id: string) => id.startsWith(fresh.root) ? id.slice(fresh.root.length) || "/" : id;
  const freshChildren = engine.childIndex(fresh);
  // Each old directory's active children by name, the first of a name winning.
  const previousNames = new Map<string, Map<string, Node>>();
  const priorChild = (parent: string, name: string) => {
    let names = previousNames.get(parent);
    if (!names) {
      names = new Map();
      for (const node of engine.children(previous, parent, previousChildren))
        if (!names.has(node.name)) names.set(node.name, node);
      previousNames.set(parent, names);
    }
    return names.get(name);
  };
  const rebind = (
    id: string,
    parent: string | null,
    oldID?: string
  ): string => {
    const value = fresh.nodes[id]!,
      old = oldID ? previous.nodes[oldID] : undefined;
    const next =
      old?.kind === value.kind ? old.id : `snapshot:${request.change}:${local(id)}`;
    state.nodes[next] = {
      ...clone(value),
      id: next,
      parent,
      ...(old?.kind === "file" && oldObjects.get(old.id) === value.object
        ? { pieces: clone(old.pieces) }
        : {}),
    };
    if (
      value.kind === "file" &&
      state.nodes[next]!.pieces &&
      (!old || oldObjects.get(old.id) !== value.object)
    )
      state.nodes[next]!.pieces = state.nodes[next]!.pieces!.map((p) => ({
        ...p,
        origin: `snapshot:${request.change}:${local(p.origin)}`,
      }));
    for (const child of engine.children(fresh, id, freshChildren)) {
      const prior = old ? priorChild(old.id, child.name) : undefined;
      rebind(child.id, next, prior?.id);
    }
    return next;
  };
  for (const node of Object.values(state.nodes))
    if (engine.realm(previous, node.id) === previous.root) node.active = false;
  state.root = rebind(fresh.root, null, previous.root);
  const changedNodes = Object.values(state.nodes)
    .filter(
      (node) =>
        node.active &&
        engine.realm(state, node.id) === state.root &&
        (node.kind === "file"
          ? oldObjects.get(node.id) !== node.object
          : !previous.nodes[node.id]?.active)
    )
    .map((node) => node.id);
  if (request.current.state && request.projection !== request.current.object) {
    state.changes[request.change] = engine.put(
      encoder.encode(
        stableJSONString({
          base: request.current,
          incoming: {
            change: request.change,
            object: request.projection,
            operations: null,
          },
          checkpoint: { affected: changedNodes },
        })
      )
    );
  }
  const wrapped: string[] = [];
  const continuations: Array<{ decision: IntentDecision; apply: () => Promise<void> }> = [];
  for (const decision of state.decisions) {
    if (decision.context) continue;
    if (decision.placement) {
      const node = state.nodes[decision.placement.node];
      if (node?.active && node.pieces) {
        try {
          engine.locate(node.pieces, decision.placement.pieces, [
            0,
            length(decision.placement.pieces),
          ]);
          continue;
        } catch {}
        // A current-basis snapshot edits the selected whole-file alternative. It
        // does not resolve the sibling, nor claim lineage for its replacement bytes.
        const old = previous.nodes[decision.placement.node];
        if (
          request.continueSelected !== false &&
          !request.decisions.length &&
          old?.pieces &&
          decision.placement.anchor === 0 &&
          length(decision.placement.pieces) === length(old.pieces)
        ) {
          const selected = decision.alternatives[decision.selected]!;
          const material = clone(node);
          material.id = `snapshot-alternative:${request.change}:${decision.key}`;
          material.parent = null;
          state.nodes[material.id] = material;
          selected.node = material.id;
          selected.object = node.object;
          selected.contributions.push({
            change: request.change,
            operation: null,
          });
          decision.placement = {
            node: node.id,
            pieces: clone(node.pieces),
            anchor: 0,
          };
          selected.state = (await engine.record(state)).state;
          continue;
        }
      }
    } else if (request.current.object === request.projection) continue;
    else if (decision.kind === "existence") {
      // A choice about one file concerns only that file.
      const id = decision.affected[0]!,
        before = previous.nodes[id]?.active ? oldObjects.get(id) : undefined,
        after = state.nodes[id]?.active ? state.nodes[id]!.object : undefined;
      if (before === after) continue;
      const selected = decision.alternatives[decision.selected]!;
      if (request.continueSelected !== false && !request.decisions.length &&
          selected.node && before !== undefined && after !== undefined) {
        // Editing the kept file edits that alternative; the deletion stays.
        continuations.push({ decision, apply: async () => {
          const material = clone(state.nodes[id]!);
          material.id = `snapshot-alternative:${request.change}:${decision.key}`;
          material.parent = null;
          state.nodes[material.id] = material;
          selected.node = material.id;
          selected.object = after;
          selected.contributions.push({ change: request.change, operation: null });
          selected.state = (await engine.record(state)).state;
        } });
        continue;
      }
    } else if (decision.kind === "directory" && request.continueSelected !== false &&
        !request.decisions.length && decision.alternatives[decision.selected]!.node === previous.root) {
      // A snapshot of the displayed tree edits that alternative, as a traced edit would.
      const selected = decision.alternatives[decision.selected]!;
      continuations.push({ decision, apply: async () => {
        selected.node = state.root;
        selected.object = request.projection;
        selected.contributions.push({ change: request.change, operation: null });
        selected.state = (await engine.record(state)).state;
      } });
      continue;
    }
    decision.context = (await previousRecord()).state;
    wrapped.push(decision.key);
  }
  // Continuing an alternative claims the snapshot's material. When another
  // choice's material is wrapped and the current projection is kept, the
  // snapshot is withheld as a whole, so those choices are wrapped with it.
  const withheld = wrapped.length > 0 && !request.decisions.some((d) => !d.path) &&
    request.current.object !== request.projection && request.conflictProjection === "current";
  for (const { decision, apply } of continuations) {
    if (!withheld) { await apply(); continue; }
    decision.context = (await previousRecord()).state;
    wrapped.push(decision.key);
  }
  for (const input of request.decisions) {
    if (state.decisions.some((d) => d.key === input.key)) continue;
    if (input.path) {
      const locate = (view: View) => {
        let node = view.nodes[view.root]!;
        for (const name of input.path!)
          node =
            engine.children(view, node.id).find((n) => n.name === name) ??
            fail("Checkpoint decision path is absent");
        return node;
      };
      const find = (view: View) => { try { return locate(view); } catch { return undefined; } };
      const contexts = await Promise.all(input.alternatives.map((a) => engine.initial(a.object)));
      if (contexts.some((context) => !find(context))) {
        // Deleted in one alternative: a choice about this file's existence.
        const present = contexts.map(find);
        if (present.some((node) => node && (node.kind !== "file" || !node.pieces)))
          throw new Error("Checkpoint existence alternative is not a file");
        const kept = present.find((node) => node)!;
        let target = find(state);
        if (!target) {
          // The projection shows the deletion: keep an inactive occurrence at the path.
          const parentPath = input.path.slice(0, -1);
          let parent = state.nodes[state.root]!;
          for (const name of parentPath)
            parent = engine.children(state, parent.id).find((n) => n.name === name) ?? fail("Checkpoint decision parent is absent");
          target = { ...clone(kept), id: `existence:${input.key}`, parent: parent.id, name: input.path.at(-1)!, active: false };
          state.nodes[target.id] = target;
        }
        const alternatives = [];
        for (const [index, a] of input.alternatives.entries()) {
          const recorded = await engine.record(contexts[index]!), node = present[index];
          if (!node) { alternatives.push({ ...recorded, contributions: a.contributions }); continue; }
          const material = clone(node);
          material.id = `legacy:${input.key}:${index}`;
          material.parent = null;
          if (index === input.selected && target.active) material.pieces = clone(target.pieces);
          state.nodes[material.id] = material;
          alternatives.push({ ...recorded, object: await engine.project(state, material.id), node: material.id, contributions: a.contributions });
        }
        state.decisions.push({
          key: input.key,
          kind: "existence",
          affected: [target.id],
          selected: input.selected,
          alternatives,
          dependencies: input.dependencies ?? [],
          reason: "Deleted in one version and changed in another",
          subject: { material: { kind: "basis", path: "/" + input.path.join("/"), object: alternatives.find((a) => "node" in a)!.object } },
        });
        continue;
      }
      const selected = locate(state);
      if (!selected.pieces)
        throw new Error("Checkpoint file decision has no file placement");
      const alternatives = [];
      for (const [index, a] of input.alternatives.entries()) {
        const context = await engine.initial(a.object),
          material = clone(locate(context));
        if (!material.pieces)
          throw new Error("Checkpoint file alternative is not a file");
        material.id = `legacy:${input.key}:${index}`;
        material.parent = null;
        if (index === input.selected) material.pieces = clone(selected.pieces);
        state.nodes[material.id] = material;
        alternatives.push({
          ...(await engine.record(context)),
          object: await engine.project(state, material.id),
          node: material.id,
          contributions: a.contributions,
        });
      }
      state.decisions.push({
        key: input.key,
        kind: "content",
        affected: [selected.id],
        selected: input.selected,
        alternatives,
        dependencies: input.dependencies ?? [],
        reason: "Retained whole-file ambiguity",
        subject: {
          material: {
            kind: "basis",
            path: "/" + input.path.join("/"),
            object: await engine.project(state, selected.id),
          },
        },
        placement: {
          node: selected.id,
          pieces: clone(selected.pieces),
          anchor: 0,
        },
      });
      continue;
    }
    const alternatives = [];
    for (const a of input.alternatives) {
      const context = await engine.initial(a.object);
      const recorded = await engine.record(context);
      alternatives.push({
        ...recorded,
        ...(a.object === request.projection ? { node: state.root } : {}),
        contributions: a.contributions,
      });
    }
    state.decisions.push({
      key: input.key,
      kind: "directory",
      affected: [state.root],
      selected: input.selected,
      alternatives,
      dependencies: [...new Set([...wrapped, ...(input.dependencies ?? [])])],
      reason: "Retained snapshot ambiguity",
    });
  }
  // Whole-root inputs already enclose what they wrap; per-path ones do not.
  if (
    wrapped.length &&
    !request.decisions.some((d) => !d.path) &&
    request.current.object !== request.projection
  ) {
    const projected = await engine.record(state);
    const incoming = {
      ...projected,
      contributions: [{ change: request.change, operation: null }],
    };
    if (request.conflictProjection === "current") {
      state.nodes = clone(previous.nodes);
      state.root = previous.root;
      for (const decision of state.decisions) {
        const prior = previous.decisions.find((d) => d.key === decision.key);
        if (prior) {
          if (prior.context) decision.context = prior.context;
          else delete decision.context;
        }
      }
    }
    const extra =
      request.candidate &&
      request.candidate !== projected.object &&
      request.candidate !== (await previousRecord()).object
        ? [
            {
              ...(await engine.record(await engine.initial(request.candidate))),
              contributions: [{ change: request.change, operation: null }],
            },
          ]
        : [];
    state.decisions.push({
      key: `snapshot:${request.change}`,
      kind: "directory",
      affected: [state.root],
      selected: request.conflictProjection === "current" ? 0 : 1,
      alternatives: [
        {
          ...(await previousRecord()),
          ...(request.conflictProjection === "current"
            ? { node: state.root }
            : {}),
          contributions: [],
        },
        {
          ...incoming,
          ...(request.conflictProjection === "current"
            ? {}
            : { node: state.root }),
        },
        ...extra,
      ],
      dependencies: wrapped,
      reason: "Snapshot changes unresolved material",
    });
  }
  // An editable input already reflects every deletion in its effects, and the
  // snapshot adds no effects: unchanged files keep their enforced pieces and
  // replaced files get fresh origins no recorded deletion names. The result is
  // therefore editable too, so the next edit fast-forwards instead of taking
  // the complete scan an imported or transported state needs.
  const result = await engine.record(state, editable);
  await objects.store(
    [...engine.generated].map(([hash, bytes]) => ({ hash, bytes }))
  );
  if (!request.authored)
    return { kind: "checkpoint", result, objects: [...engine.generated.keys()] };
  // The author's checkpoint of the same projection differs from this one only
  // where a decision is added or enclosed (the conflict projection, the
  // candidate alternative): with neither, both requests yield the same state.
  const own = request.candidate ?? request.projection;
  if (!wrapped.length && !request.decisions.length && own === request.projection)
    return { kind: "checkpoint", result, authored: result, objects: [...engine.generated.keys()] };
  const author = await checkpointIntent({
    kind: "checkpoint", tree: request.tree, current: request.current, projection: own,
    change: request.change, decisions: [], ...(request.resolves ? { resolves: request.resolves } : {}),
  }, objects);
  return {
    kind: "checkpoint", result, authored: author.result,
    objects: [...new Set([...engine.generated.keys(), ...author.objects])],
  };
}

/** Validate a worker-owned graph at the authority boundary without running edits. */
export async function validateIntentState(
  ref: { object: string; state: string },
  tree: string,
  objects: MergeObjects,
  validation?: StateValidation
): Promise<IntentState> {
  const engine = new Engine(
    {
      kind: "tree",
      tree,
      base: ref,
      current: ref,
      incoming: { change: "validate", object: ref.object, trace: [] },
      // Validation walks every history record on a cold cache; the evaluator's
      // 32 MiB read budget is for one edit. The state loader caps expansion at
      // 128 MiB itself, so allow that much here.
      rules: { id: "tree-default", revision: 1, ...(validation ? { config: { maxBytes: 128 * 1024 * 1024, ...(validation.maxMillis ? { maxMillis: validation.maxMillis } : {}) } } : {}) },
    },
    objects
  );
  return engine.load(ref, validation);
}
