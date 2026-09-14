import { hashObject } from "@arbor/wire";
import { continueTerms, selected, type Term } from "./algebra.ts";

/** Small model experiment, NOT Wire types or a production Markdown parser.
 * Initial targets are source chunks with externally established identity.
 * Placement slots are explicit and collision-checked, not a general list CRDT. */
export interface SourceTarget {
  id: string;
  path: string;
  slot: number;
  source: string;
}
interface Placement { path: string; slot: number }
interface Deletion { id: string; body: string[]; placement: string[] }
interface Target {
  body: Term<string>[];
  placement: Term<string>[];
  deletions: Deletion[];
}
interface State { targets: Record<string, Target> }
type Effect =
  | { kind: "replace"; target: string; before: string; source: string }
  | { kind: "move"; target: string; path: string; slot: number }
  | { kind: "copy"; target: string; newTarget: string; path: string; slot: number }
  | { kind: "delete"; target: string }
  | { kind: "undo-delete"; target: string; deletion: string }
  | { kind: "edit-alternative"; target: string; alternative: string; before: string; source: string }
  | { kind: "resolve-text"; target: string; source: string };

export interface IntentRequest {
  tree: string;
  id: string;
  base: number;
  effects: Effect[];
  /** Exact locally authored ordinary Markdown projection, before reconciliation. */
  candidate: Record<string, string>;
}
export interface IntentReview {
  update: number;
  files: Record<string, string>;
  conflicts: Array<{ target: string; kind: "text" | "placement" | "delete-edit" }>;
  targets: Record<string, {
    body: Array<{ revision: string; source: string }>;
    placement: Array<{ revision: string; value: Placement }>;
    deletions: string[];
  }>;
}
interface Archive {
  version: 1;
  tree: string;
  initial: SourceTarget[];
  requests: IntentRequest[];
}
const clone = <T>(value: T): T => structuredClone(value);
const positive = (terms: Term<string>[]): string[] => terms.filter((term) => term.sign === 1).map((term) => term.value);
const one = (revision: string): Term<string>[] => [{ sign: 1, value: revision }];
const owns = (object: object, key: string): boolean => Object.hasOwn(object, key);

/**
 * Terms reference authored revisions, not hashes of their bytes. Values may be
 * identical without being the same operation. No per-character graph is stored.
 * A retained serialized operation log supplies restart/retry/causal evidence.
 * It is deliberately unbounded here: compaction is NOT proved by this model.
 */
export class SourceIntentModel {
  private states: State[] = [];
  private revisions: Record<string, string | Placement> = {};
  private requests: IntentRequest[] = [];
  private receipts = new Map<string, { digest: string; update: number }>();

  constructor(readonly tree: string, private readonly initial: SourceTarget[]) {
    if (!/^tr_[a-z0-9]+$/.test(tree)) throw new Error("Invalid TreeID");
    const targets: Record<string, Target> = {};
    for (const [index, input] of initial.entries()) {
      this.identifier(input.id);
      this.placement({ path: input.path, slot: input.slot });
      if (owns(targets, input.id)) throw new Error("Duplicate target identity");
      const body = `initial:${index}:body`;
      const placement = `initial:${index}:placement`;
      this.revisions[body] = input.source;
      this.revisions[placement] = { path: input.path, slot: input.slot };
      targets[input.id] = { body: one(body), placement: one(placement), deletions: [] };
    }
    this.initial = clone(initial);
    this.states.push({ targets });
    this.review();
  }

  private identifier(id: string): void {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id) || ["__proto__", "constructor", "prototype"].includes(id)) throw new Error("Invalid identity");
  }

  private placement(value: Placement): void {
    if (!value.path.startsWith("/") || !value.path.endsWith(".md")
      || value.path.split("/").slice(1).some((part) => !part || part === "." || part === "..")
      || /[\\\0]/.test(value.path) || !Number.isSafeInteger(value.slot) || value.slot < 0) throw new Error("Invalid placement");
  }

  private value<T extends string | Placement>(revision: string): T {
    if (!owns(this.revisions, revision)) throw new Error("Missing revision");
    return this.revisions[revision] as T;
  }

  private read(state: State, update: number): IntentReview {
    const chunks = new Map<string, Array<{ slot: number; source: string }>>();
    const conflicts: IntentReview["conflicts"] = [];
    const targets: IntentReview["targets"] = {};
    for (const [id, target] of Object.entries(state.targets)) {
      const body = positive(target.body);
      const placement = positive(target.placement);
      targets[id] = {
        body: body.map((revision) => ({ revision, source: this.value<string>(revision) })),
        placement: placement.map((revision) => ({ revision, value: this.value<Placement>(revision) })),
        deletions: target.deletions.map((deletion) => deletion.id),
      };
      const unseenEdit = target.deletions.some((deletion) =>
        body.some((revision) => !deletion.body.includes(revision))
        || placement.some((revision) => !deletion.placement.includes(revision)));
      if (unseenEdit) conflicts.push({ target: id, kind: "delete-edit" });
      if (target.body.length > 1) conflicts.push({ target: id, kind: "text" });
      if (target.placement.length > 1) conflicts.push({ target: id, kind: "placement" });
      // A deletion projects absence, but never hides the review signal or bytes.
      if (target.deletions.length) continue;
      const selectedPlacement = this.value<Placement>(selected(target.placement));
      const file = chunks.get(selectedPlacement.path) ?? [];
      if (file.some((chunk) => chunk.slot === selectedPlacement.slot)) throw new Error("Ambiguous placement slot");
      file.push({ slot: selectedPlacement.slot, source: this.value<string>(selected(target.body)) });
      chunks.set(selectedPlacement.path, file);
    }
    const files: Record<string, string> = {};
    for (const [path, file] of [...chunks].sort(([a], [b]) => a.localeCompare(b))) {
      files[path] = file.sort((a, b) => a.slot - b.slot).map((chunk) => chunk.source).join("");
    }
    return clone({ update, files, conflicts, targets });
  }

  review(update = this.states.length - 1): IntentReview {
    if (!Number.isSafeInteger(update) || update < 0 || !this.states[update]) throw new Error("Unknown accepted base");
    return this.read(this.states[update]!, update);
  }

  private replay(base: State, current: State, request: IntentRequest, reconciling: boolean): State {
    const authored = clone(base);
    const merged = clone(current);
    for (const [index, effect] of request.effects.entries()) {
      this.identifier(effect.target);
      if (!owns(authored.targets, effect.target) || !owns(merged.targets, effect.target)) throw new Error("Unknown source target");
      const before = authored.targets[effect.target]!;
      const target = merged.targets[effect.target]!;
      const id = `op:${request.id}:${index}`;
      if (before.deletions.length && effect.kind !== "undo-delete") throw new Error("Deleted target requires review");
      const clean = (terms: Term<string>[]): string => {
        if (terms.length !== 1) throw new Error("Operation must target an explicit alternative");
        return terms[0]!.value;
      };
      switch (effect.kind) {
        case "replace": {
          const basis = clean(before.body);
          if (this.value<string>(basis) !== effect.before) throw new Error("Source guard mismatch");
          this.revisions[id] = effect.source;
          target.body = continueTerms(target.body, basis, id, String);
          before.body = one(id);
          break;
        }
        case "move": {
          const value = { path: effect.path, slot: effect.slot };
          this.placement(value);
          const basis = clean(before.placement);
          this.revisions[id] = value;
          target.placement = continueTerms(target.placement, basis, id, String);
          before.placement = one(id);
          break;
        }
        case "copy": {
          this.identifier(effect.newTarget);
          if (owns(merged.targets, effect.newTarget)) throw new Error("Copy requires fresh identity");
          const value = { path: effect.path, slot: effect.slot };
          this.placement(value);
          this.revisions[`${id}:body`] = this.value<string>(clean(before.body));
          this.revisions[`${id}:placement`] = value;
          const copy = { body: one(`${id}:body`), placement: one(`${id}:placement`), deletions: [] };
          authored.targets[effect.newTarget] = clone(copy);
          merged.targets[effect.newTarget] = copy;
          break;
        }
        case "delete": {
          clean(before.body);
          clean(before.placement);
          const deletion = { id, body: positive(before.body), placement: positive(before.placement) };
          target.deletions.push(deletion);
          before.deletions.push(clone(deletion));
          break;
        }
        case "undo-delete": {
          if (!before.deletions.some((deletion) => deletion.id === effect.deletion)
            || !target.deletions.some((deletion) => deletion.id === effect.deletion)) throw new Error("Deletion is not active");
          target.deletions = target.deletions.filter((deletion) => deletion.id !== effect.deletion);
          before.deletions = before.deletions.filter((deletion) => deletion.id !== effect.deletion);
          break;
        }
        case "edit-alternative": {
          if (!positive(before.body).includes(effect.alternative) || !positive(target.body).includes(effect.alternative)) throw new Error("Alternative is no longer current");
          if (this.value<string>(effect.alternative) !== effect.before) throw new Error("Source guard mismatch");
          this.revisions[id] = effect.source;
          const replace = (terms: Term<string>[]): Term<string>[] => terms.map((term) =>
            term.sign === 1 && term.value === effect.alternative ? { ...term, value: id } : term);
          target.body = replace(target.body);
          before.body = replace(before.body);
          break;
        }
        case "resolve-text": {
          if (reconciling && request.base !== this.states.length - 1) throw new Error("Stale resolution");
          if (before.body.length === 1) throw new Error("No text conflict to resolve");
          this.revisions[id] = effect.source;
          target.body = one(id);
          before.body = one(id);
          break;
        }
        default: {
          const unsupported: never = effect;
          throw new Error(`Unsupported source operation: ${JSON.stringify(unsupported)}`);
        }
      }
    }
    return merged;
  }

  submit(request: IntentRequest): IntentReview {
    if (request.tree !== this.tree) throw new Error("Wrong TreeID");
    this.identifier(request.id);
    this.review(request.base);
    if (!request.effects.length) throw new Error("Empty operation");
    // Candidate key order is irrelevant; effect order is semantic.
    const digest = hashObject(new TextEncoder().encode(JSON.stringify([
      request.tree, request.base, request.effects, Object.entries(request.candidate).sort(([a], [b]) => a.localeCompare(b)),
    ])));
    const prior = this.receipts.get(request.id);
    if (prior) {
      if (prior.digest !== digest) throw new Error("Operation identity reused with different intent");
      return this.review(prior.update);
    }
    const revisions = clone(this.revisions);
    try {
      const base = this.states[request.base]!;
      const candidate = this.replay(base, base, request, false);
      const projected = this.read(candidate, request.base).files;
      if (JSON.stringify(Object.entries(projected).sort()) !== JSON.stringify(Object.entries(request.candidate).sort())) throw new Error("Intent does not reproduce candidate source");
      const state = this.replay(base, this.states.at(-1)!, request, true);
      const update = this.states.length;
      const result = this.read(state, update);
      this.states.push(state);
      this.requests.push(clone(request));
      this.receipts.set(request.id, { digest, update });
      return result;
    } catch (error) {
      this.revisions = revisions;
      throw error;
    }
  }

  /** Serialized semantic log for restart tests, not a durable write API. */
  archive(): string {
    const value: Archive = { version: 1, tree: this.tree, initial: this.initial, requests: this.requests };
    return JSON.stringify(value);
  }

  static restore(source: string): SourceIntentModel {
    const value = JSON.parse(source) as Archive;
    if (value.version !== 1) throw new Error("Unsupported model archive");
    const model = new SourceIntentModel(value.tree, value.initial);
    for (const request of value.requests) model.submit(request);
    return model;
  }
}
