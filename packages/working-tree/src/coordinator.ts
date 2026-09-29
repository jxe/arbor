import { applyTransitionPayload, decodeTreeSnapshotJSON, hashObject, ProtocolHTTPError, ProtocolUnsupportedOperation, ProtocolUpdateConflict,
  type CurrentTree, type TreeSnapshot, type UpdateResponse, type WatchEvent, type ProtocolClient } from "@overstory/protocol";
import { attemptEncoding, attemptRequest, emptyControl, encodeAttempt, verifyAttempt, UpdateStateError, UpdateValidationError,
  type ControlStore, type UpdateAttempt, type UpdateControl } from "./control.ts";
import { compactTransport, branchPublications, publication, type ChangePublication } from "./publication.ts";
import { equal, type LocalChange } from "./local-change.ts";
import { reduceUpdate, type AcceptedBase, type AuthorityResult, type HeldReason, type LocalTip, type PreparedRequest,
  type UpdateEffect, type UpdateEvent, type UpdateOptions, type UpdateState } from "./update-machine.ts";

/** The change log as the runner uses it; `ChangeLog` in `./node` is the file-backed one. */
export interface ChangeLogPort {
  readonly tree: string;
  retained(): Promise<LocalChange[]>;
  /** The newest change of the oldest unsettled authored chain. */
  nextPublication(settled: ReadonlySet<string>): Promise<string | undefined>;
  /** The chain from its accepted basis through `through`; settled changes are repeated without objects. */
  request(through: string, settled: ReadonlySet<string>): Promise<{ base: { root: string; update: string }; request: { base: string; updates: unknown[] } }>;
  /** Drop settled records nothing pending needs; true when the log is now empty. */
  compact(settled: ReadonlySet<string>, preservingSettledTail?: boolean, publications?: readonly string[][]): Promise<boolean>;
  /** Remove these changes and every change authored on them. */
  discard(changes: ReadonlySet<string>): Promise<void>;
}

export type UpdateTransport = Pick<ProtocolClient, "submitUpdates" | "descriptor"> & Partial<Pick<ProtocolClient, "snapshot" | "object">>;

/**
 * Where an accepted state's objects come from: those the runner already holds
 * (a projection of our own candidate, a replayed watch batch), then the tree's
 * own, then the host. Every object is verified against its hash.
 */
export interface AcceptedSource {
  readonly root: string;
  object(hash: string): Promise<Uint8Array>;
  /** The complete graph from the host, for a tree that needs every file at once. */
  snapshot(): Promise<TreeSnapshot>;
}

/**
 * The working tree the runner installs accepted states into. An editor's tree
 * installs them as its accepted base and derives its view from the change
 * log. A folder writes accepted bytes to disk only when `pending` is false and
 * it still holds what it last wrote or scanned; otherwise it records the
 * accepted state and leaves its files alone (spec 09 rule 13).
 */
export interface AcceptedTree {
  /** The installed accepted state, or undefined before one is placed. */
  accepted(): Promise<AcceptedBase | undefined>;
  /** An object this tree holds locally. */
  object(hash: string): Promise<Uint8Array | undefined>;
  /** Durably install `base` as the accepted state. When its root is already installed, only its identity and cursor are new. */
  install(base: AcceptedBase, source: AcceptedSource, local: { pending: boolean }): Promise<void>;
  /** Durably record new identity or observation progress for the installed root. */
  recordAccepted(base: AcceptedBase): Promise<void>;
  /** Accepted or local state changed; derived views are stale. */
  changed?(): void;
}

export interface UpdateCoordinatorOptions extends UpdateOptions {
  transportAvailable?: boolean;
  /** Called after every transition, for a host that mirrors the state elsewhere. */
  onState?: (state: UpdateState) => void;
}

/** What a tree's synchronization status shows, derived from the machine and the change log. */
export interface UpdatePresentation {
  state: "unplaced" | "current" | "locally-pending" | "request-pending" | "uploading" | "downloading"
    | "offline" | "authentication-failure" | "revoked" | "held" | "stopped";
  detail?: string;
  /** Local changes not yet settled. */
  pending: number;
  acceptedRoot?: string;
  acceptedConflicted?: boolean;
}

type Work = { kind: "effect"; effect: UpdateEffect } | { kind: "recordCursor"; base: AcceptedBase };
interface Current { update: string; root: string; conflicted: boolean; cursor: string }

/** A 4xx answer other than timeouts and rate limits: the host refused this request. */
function refusal(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

function phaseTip(state: UpdateState): LocalTip | undefined {
  return "tip" in state ? state.tip : undefined;
}
function phaseRequest(state: UpdateState): PreparedRequest | undefined {
  return "request" in state ? state.request : undefined;
}

/**
 * The runner for the update machine over a working tree, its change log, and
 * an Overstory transport. The machine decides; the coordinator performs. The
 * TypeScript twin of Swift's `UpdateCoordinator`.
 *
 * Every source (an editor, a folder scan, a structural action) appends a
 * `LocalChange` to the change log and then calls `noteLocalChange()`. The
 * coordinator turns I/O results into events and executes every effect the
 * machine returns, in order. It never writes the machine's phase and keeps no
 * flag that decides what happens next; what it keeps is what an effect needs:
 * the exact persisted request, the response an `apply` installs, the watch
 * batch a `catchUp` replays. Submissions run on their own promise, so a
 * hanging attempt never blocks its ambiguous extension or a catch-up.
 */
export class UpdateCoordinator {
  private machine: UpdateState;
  private control: UpdateControl = emptyControl();
  private loaded?: Promise<void>;
  private entering?: Promise<void>;
  private closed = false;
  private readonly queue: Work[] = [];
  private worker?: Promise<void>;
  private readonly submissions = new Map<string, Promise<void>>();
  private readonly timers = new Map<"trailing" | "max" | "poll", ReturnType<typeof setTimeout>>();
  private idleWaiters: Array<() => void> = [];
  /**
   * A watch can acknowledge a request before its POST returns. That apply
   * waits off the worker until the submission supplies the response (or
   * fails, and apply retrieves the stored receipts), so the request is never
   * sent twice.
   */
  private deferredApply?: { digest: string; result: AuthorityResult };
  /** The validated response of the persisted attempt, kept for the `apply` it leads to. */
  private submission?: { digest: string; response: UpdateResponse; current: Current };
  /** The latest watch event, kept for the `catchUp` its cursor names. */
  private watchEvent?: Extract<WatchEvent, { kind: "tree.update" }>;
  private watching = false;
  private failure?: string;

  constructor(
    readonly tree: string,
    private readonly log: ChangeLogPort,
    private readonly store: ControlStore,
    private readonly transport: UpdateTransport,
    private readonly working: AcceptedTree,
    private readonly options: UpdateCoordinatorOptions = {},
  ) {
    if (log.tree !== tree) throw new UpdateStateError("Change log belongs to another tree");
    this.machine = { kind: "unplaced", transportAvailable: options.transportAvailable ?? true };
  }

  /** The machine state, for status and tests. */
  get state(): UpdateState { return this.machine; }

  // MARK: Entry

  private load(): Promise<void> {
    this.loaded ??= (async () => {
      const control = await this.store.load();
      verifyAttempt(control);
      this.control = control;
    })();
    return this.loaded;
  }

  /** Enter the machine from the tree's accepted state, then recover a retained request and the log's tip through ordinary events. */
  async start(): Promise<void> {
    this.requireOpen();
    await this.load();
    if (this.machine.kind !== "unplaced") return;
    this.entering ??= (async () => {
      try {
        const accepted = await this.working.accepted();
        if (!accepted || this.machine.kind !== "unplaced") return;
        this.dispatch({ type: "bootstrapInstalled", root: accepted.root, update: accepted.update,
          ...(accepted.cursor ? { cursor: accepted.cursor } : {}), ...(this.control.acceptedConflicted === undefined ? {} : { conflicted: this.control.acceptedConflicted }) });
        const attempt = this.control.attempt;
        if (attempt) {
          const held = this.control.held;
          this.dispatch({ type: "recovered", request: this.prepared(attempt), ...(held ? { held: held.reason, ...(held.detail === undefined ? {} : { detail: held.detail }) } : {}) });
        }
        await this.publishTip();
      } finally { this.entering = undefined; }
    })();
    await this.entering;
  }

  private readonly activeSources = new Set<string>();

  /** An editor has captured work that has not finished admission. */
  async sourceActivity(id: string, pending: boolean): Promise<void> {
    await this.start();
    const wasActive = this.activeSources.size > 0;
    if (pending) this.activeSources.add(id); else this.activeSources.delete(id);
    if (wasActive !== (this.activeSources.size > 0)) this.dispatch({type: "sourceActivity", pending: this.activeSources.size > 0});
  }

  /** A source appended a durable local change: tell the machine the log's tip. */
  async noteLocalChange(): Promise<void> {
    await this.start();
    await this.publishTip();
  }

  private prepared(attempt: UpdateAttempt): PreparedRequest {
    return { id: attempt.digest, base: attempt.base.update, candidate: attempt.candidate, tip: this.control.attemptTip ?? "", digests: [...attempt.requestDigests] };
  }

  private settledSet(): Set<string> { return new Set(this.control.settled); }

  /** Tell the machine the change log's publishable tip. Retelling a tip it already knows would only restart its delay. */
  private async publishTip(): Promise<void> {
    if (this.machine.kind === "unplaced") return;
    try {
      const tip = await this.log.nextPublication(this.settledSet());
      if (!tip) return;
      const known = phaseTip(this.machine);
      if (known?.change === tip) return;
      if (!known && phaseRequest(this.machine)?.tip === tip) return;
      const retained = await this.log.retained();
      const record = retained.find(record => record.change === tip);
      if (!record) return;
      const requiresAcceptance = retained.some(item => !this.control.settled.includes(item.change) &&
        (item.update.trace !== null || item.update.resolves.length > 0 || item.update.ifCurrent !== undefined));
      this.dispatch({ type: "localChange", change: tip, root: record.candidate.root, settleIfUnchanged: !requiresAcceptance });
    } catch (error) {
      this.failure = String(error);
    }
  }

  // MARK: Dispatch

  private dispatch(event: UpdateEvent): void {
    const before = this.machine;
    const { state, effects } = reduceUpdate(before, event, this.options);
    this.machine = state;
    if (state !== before) this.options.onState?.(state);
    if (before.kind === "current" && state.kind === "current" && state.base.cursor !== before.base.cursor
        && state.base.root === before.base.root && state.base.update === before.base.update) {
      this.queue.push({ kind: "recordCursor", base: state.base });
    }
    for (const effect of effects) {
      if (effect.type === "schedule") this.schedule(effect.timer, effect.delay);
      else if (effect.type === "cancelTimers") for (const timer of ["trailing", "max"] as const) this.cancel(timer);
      else this.queue.push({ kind: "effect", effect });
    }
    this.startWorker();
  }

  private schedule(timer: "trailing" | "max" | "poll", delay: number): void {
    this.cancel(timer);
    if (this.closed) return;
    const handle = setTimeout(() => {
      this.timers.delete(timer);
      if (this.closed) return;
      // A clean tree whose watch is open learns of updates from it; the poll
      // is only for a watch that is down (a dead one fails its idle timeout).
      if (timer === "poll" && this.watching && this.machine.kind === "current") return this.schedule("poll", delay);
      this.dispatch({ type: timer === "trailing" ? "publishDelayElapsed" : timer === "max" ? "maxDelayElapsed" : "pollElapsed" });
    }, delay);
    (handle as { unref?: () => void }).unref?.();
    this.timers.set(timer, handle);
  }

  private cancel(timer: "trailing" | "max" | "poll"): void {
    const handle = this.timers.get(timer);
    if (handle !== undefined) clearTimeout(handle);
    this.timers.delete(timer);
  }

  private startWorker(): void {
    if (this.worker) return;
    if (!this.queue.length || this.closed) {
      if (!this.submissions.size) this.resumeIdle();
      return;
    }
    this.worker = this.drain();
  }

  private async drain(): Promise<void> {
    // Yield once so the dispatching caller finishes its synchronous work first.
    await Promise.resolve();
    while (this.queue.length && !this.closed) {
      const work = this.queue.shift()!;
      if (work.kind === "effect") await this.perform(work.effect);
      else {
        try { await this.working.recordAccepted(work.base); }
        catch (error) { this.failure = String(error); }
      }
    }
    this.worker = undefined;
    if (this.queue.length && !this.closed) this.startWorker();
    else if (!this.submissions.size) this.resumeIdle();
  }

  private resumeIdle(): void {
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const resume of waiters) resume();
  }

  /** Wait until every queued effect has been performed and no submission is on the network. */
  settle(): Promise<void> {
    if (!this.worker && !this.queue.length && !this.submissions.size) return Promise.resolve();
    return new Promise(resolve => this.idleWaiters.push(resolve));
  }

  // MARK: Effects

  private async perform(effect: UpdateEffect): Promise<void> {
    switch (effect.type) {
      case "persistRequest": return this.persistRequest(effect.tip, effect.extends);
      case "submit": {
        const id = effect.request.id;
        if (this.submissions.has(id)) return;
        const running = (async () => {
          // Leave the worker first: a submission never blocks it.
          await Promise.resolve();
          await this.submit(effect.request);
        })().finally(() => this.submissionFinished(id));
        this.submissions.set(id, running);
        return;
      }
      case "apply": return this.apply(effect.result);
      case "catchUp": return this.catchUp(effect.cursor);
      case "settle": return this.settleLocally(effect.tip);
      case "stop":
        this.failure = effect.reason;
        for (const timer of [...this.timers.keys()]) this.cancel(timer);
        return;
      case "schedule":
      case "cancelTimers":
        return;
    }
  }

  private submissionFinished(id: string): void {
    this.submissions.delete(id);
    const deferred = this.deferredApply;
    if (deferred?.digest === id) {
      this.deferredApply = undefined;
      if (!this.closed && this.control.attempt?.digest === id
          && this.machine.kind === "accepted-pending-apply" && this.machine.request?.id === id) {
        this.queue.push({ kind: "effect", effect: { type: "apply", result: deferred.result } });
      }
    }
    this.startWorker();
  }

  private async persistRequest(tip: LocalTip, extended?: PreparedRequest): Promise<void> {
    const existing = this.control.attempt;
    if (existing && !extended) {
      // A retained request is resubmitted exactly; it is never re-cut from the log.
      this.dispatch({ type: "requestPersisted", request: this.prepared(existing) });
      return;
    }
    try {
      const prepared = await this.log.request(tip.change, this.settledSet());
      prepared.request = await this.composePublication(prepared.request);
      const attempt = encodeAttempt(this.tree, prepared.base, prepared.request);
      if (extended && !extended.digests.every((digest, index) => attempt.requestDigests[index] === digest)) {
        // The tip no longer descends from the transmitted request: retry it exactly.
        this.dispatch({ type: "requestPersisted", request: extended });
        return;
      }
      this.control.attempt = attempt;
      this.control.attemptTip = tip.change;
      await this.writeControl();
      this.failure = undefined;
      this.dispatch({ type: "requestPersisted", request: this.prepared(attempt) });
    } catch (error) {
      await this.fail(error);
    }
  }

  private async submit(request: PreparedRequest): Promise<void> {
    const attempt = this.control.attempt;
    if (!attempt || attempt.digest !== request.id) return;
    try {
      // An earlier write may have failed before it was durable. Reestablish
      // durability before treating the attempt as sendable.
      await this.writeControl();
      this.dispatch({ type: "submitStarted", id: attempt.digest });
      const response = await this.transport.submitUpdates(this.tree, attemptRequest(attempt), { encoding: attemptEncoding(attempt) });
      const current = await this.validate(response, attempt);
      this.submission = { digest: attempt.digest, response, current };
      this.failure = undefined;
      this.dispatch({ type: "accepted", id: attempt.digest, result: { kind: "accepted", root: current.root, update: current.update,
        cursor: current.cursor, digests: [...attempt.requestDigests], conflicted: current.conflicted } });
    } catch (error) {
      await this.fail(error, attempt.digest);
    }
  }

  /**
   * Check that `response` answers `attempt` exactly and select the host's
   * current head to install, the head the response reports. Receipts prove
   * acceptance, not the current boundary.
   */
  private async validate(response: UpdateResponse, attempt: UpdateAttempt): Promise<Current> {
    if (response.results.length !== attempt.requestDigests.length
        || response.results.some((result, index) => result.requestDigest !== attempt.requestDigests[index])) {
      throw new UpdateValidationError("The host answered a different request");
    }
    if (response.results.some(result => result.update.tree !== attempt.tree)) throw new UpdateValidationError("The host answered for another tree");
    const head = response.head;
    return { update: head.update, root: head.root, conflicted: head.conflicted, cursor: head.observedThrough };
  }

  private current(descriptor: CurrentTree): Current {
    if (descriptor.tree.id !== this.tree || !descriptor.tree.update) throw new UpdateValidationError("The host described another tree");
    return { update: descriptor.tree.update, root: descriptor.tree.root, conflicted: descriptor.tree.conflicted, cursor: descriptor.observedThrough };
  }

  /** Install an accepted decision for the persisted attempt, settle the changes it carried, and report the installed state. */
  private async apply(result: AuthorityResult): Promise<void> {
    const attempt = this.control.attempt;
    if (!attempt) {
      // A previous pass already applied and cleared this attempt.
      this.dispatch({ type: "applied" });
      return;
    }
    try {
      let stashed = this.submission?.digest === attempt.digest ? this.submission : undefined;
      if (!stashed && this.submissions.has(attempt.digest)) {
        this.deferredApply = { digest: attempt.digest, result };
        return;
      }
      if (!stashed) {
        // Watch evidence or a restart: replaying the exact durable request obtains the host's stored response.
        const response = await this.transport.submitUpdates(this.tree, attemptRequest(attempt), { encoding: attemptEncoding(attempt) });
        stashed = { digest: attempt.digest, response, current: await this.validate(response, attempt) };
      }
      const { response, current } = stashed;
      const final = response.results.at(-1);
      if (!final) throw new UpdateValidationError("The host returned no result");
      const request = attemptRequest(attempt);
      const carried = new Set(this.localChanges(request));
      const records = await this.log.retained();
      // The projection of our own candidate, while the log still holds it.
      let objects = new Map<string, Uint8Array>();
      const record = records.find(record => record.change === this.control.attemptTip);
      if (record && record.candidate.root === attempt.candidate && current.update === final.update.id && current.root === final.update.root) {
        const candidate = new Map(decodeTreeSnapshotJSON(record.candidate).objects);
        if (final.reconciliation) {
          for (const hash of new Set(final.reconciliation.deltas.map(delta => delta.base))) {
            if (!candidate.has(hash)) candidate.set(hash, await this.object(hash, candidate));
          }
          objects = applyTransitionPayload(candidate, final.reconciliation);
        } else if (final.update.root === record.candidate.root) {
          objects = candidate;
        }
      }
      const settled = new Set([...this.control.settled, ...carried]);
      const installed = await this.install(current, objects, { pending: records.some(record => !settled.has(record.change)) });
      this.control.settled = [...settled].sort();
      delete this.control.attempt;
      delete this.control.attemptTip;
      delete this.control.held;
      this.control.acceptedConflicted = current.conflicted;
      await this.writeControl();
      this.submission = undefined;
      await this.compactLog();
      this.working.changed?.();
      await this.publishTip();
      this.dispatch({ type: "applied", installed });
    } catch (error) {
      await this.fail(error, attempt.digest);
    }
  }

  /** Install the host's current state. The tree decides what that costs: an already installed root only records identity and observation progress. */
  private async install(current: Current, objects: ReadonlyMap<string, Uint8Array>, local: { pending: boolean }): Promise<AcceptedBase> {
    const base: AcceptedBase = { root: current.root, update: current.update, cursor: current.cursor, conflicted: current.conflicted };
    await this.working.install(base, this.source(current.root, objects), local);
    return base;
  }

  private source(root: string, objects: ReadonlyMap<string, Uint8Array>): AcceptedSource {
    return {
      root,
      object: hash => this.object(hash, objects),
      snapshot: async () => {
        if (!this.transport.snapshot) throw new UpdateValidationError("The transport serves no snapshots");
        const snapshot = await this.transport.snapshot(this.tree, root);
        if (snapshot.root !== root) throw new UpdateValidationError("The host returned another snapshot");
        return snapshot;
      },
    };
  }

  private async object(hash: string, held: ReadonlyMap<string, Uint8Array>): Promise<Uint8Array> {
    const bytes = held.get(hash) ?? await this.working.object(hash) ?? await (async () => {
      if (!this.transport.object) throw new UpdateValidationError(`Object ${hash} is unavailable`);
      return this.transport.object(this.tree, hash);
    })();
    if (hashObject(bytes) !== hash) throw new UpdateValidationError(`Object ${hash} does not match its hash`);
    return bytes;
  }

  /** Clean catch-up: replay the watch batch the cursor names when it chains from the installed state, otherwise install the host's current state. */
  private async catchUp(cursor?: string): Promise<void> {
    try {
      const pending = await this.pendingCount() > 0;
      let installed: AcceptedBase | undefined;
      const event = this.watchEvent;
      if (cursor && event?.cursor === cursor) {
        try { installed = await this.replay(event, pending); } catch { installed = undefined; }
      }
      installed ??= await this.install(this.current(await this.transport.descriptor(this.tree)), new Map(), { pending });
      this.watchEvent = undefined;
      this.control.acceptedConflicted = installed.conflicted;
      await this.writeControl();
      this.failure = undefined;
      this.working.changed?.();
      this.dispatch({ type: "applied", installed });
    } catch (error) {
      await this.fail(error);
    }
  }

  private async replay(event: Extract<WatchEvent, { kind: "tree.update" }>, pending: boolean): Promise<AcceptedBase> {
    const accepted = await this.working.accepted();
    const transition = event.transition;
    const basis = transition.from ?? transition.update.previous;
    if (!accepted || basis?.id !== accepted.update || basis.root !== accepted.root) {
      throw new UpdateValidationError("Watch predecessor differs from the installed accepted state");
    }
    const bases = new Map<string, Uint8Array>();
    for (const hash of new Set(transition.deltas.map(delta => delta.base))) bases.set(hash, await this.object(hash, bases));
    const objects = applyTransitionPayload(bases, transition);
    const { update } = transition;
    return this.install({ update: update.id, root: update.root, conflicted: update.conflicted, cursor: event.cursor }, objects, { pending });
  }

  /** The chain through `tip` reproduces the accepted root: settle it without a request. */
  private async settleLocally(tip: LocalTip): Promise<void> {
    try {
      const records = new Map((await this.log.retained()).map(record => [record.change, record]));
      const settled = this.settledSet();
      for (let change: string | undefined = tip.change; change && records.has(change) && !settled.has(change);) {
        settled.add(change);
        const basis: LocalChange["basis"] = records.get(change)!.basis;
        change = basis.kind === "authored" ? basis.change : undefined;
      }
      this.control.settled = [...settled].sort();
      await this.writeControl();
      await this.compactLog();
      this.working.changed?.();
      await this.publishTip();
    } catch (error) {
      await this.fail(error);
    }
  }

  /** Drop settled records no pending change still needs. */
  private async compactLog(): Promise<void> {
    if (await this.log.compact(this.settledSet(), true, this.control.publications?.map(group => group.changes))) this.control.settled = [];
    else {
      const retained = new Set((await this.log.retained()).map(record => record.change));
      this.control.settled = this.control.settled.filter(change => retained.has(change));
    }
    const retained = new Set((await this.log.retained()).map(record => record.change));
    this.control.publications = this.control.publications?.filter(group => group.changes.some(change => retained.has(change)));
    await this.writeControl();
  }

  private localChanges(request: { updates: Array<{ change: string }> }): string[] {
    return request.updates.flatMap(update => this.control.publications?.find(group => group.update.change === update.change)?.changes ?? [update.change]);
  }

  private async composePublication(request: { base: string; updates: unknown[] }): Promise<{ base: string; updates: unknown[] }> {
    const records = new Map((await this.log.retained()).map(record => [record.change, record]));
    const children = new Map<string, number>();
    for (const record of records.values()) if (record.basis.kind === "authored") children.set(record.basis.change, (children.get(record.basis.change) ?? 0) + 1);
    const originals = request.updates as LocalChange["update"][];
    const updates: LocalChange["update"][] = [];
    // A retained authored graph may be a hidden candidate, not the request base.
    const transportBase = [...records.values()].find(record => record.basis.kind === "accepted" && record.basis.update === request.base && record.basis.root === record.graph.root)?.graph;
    const compact = (update: LocalChange["update"], change: string) => {
      const candidate = records.get(change)?.candidate;
      // Later elements start at the preceding authored candidate. Until that
      // graph is retained by the host, keep their self-contained envelopes.
      return updates.length === 0 && transportBase && candidate ? compactTransport(update, transportBase, candidate) : update;
    };
    const groups = this.control.publications ??= [];
    const frozen = new Set(this.control.attempt ? attemptRequest(this.control.attempt).updates.map(update => update.change) : []);
    let index = 0;
    while (index < originals.length) {
      const current = originals[index]!;
      const group = groups.find(group => group.changes[0] === current.change);
      if (group) {
        let shared = 0;
        while (shared < group.changes.length && originals[index + shared]?.change === group.changes[shared]) shared++;
        if (shared !== group.changes.length) {
          const branch = originals.slice(index + shared).map(update => records.get(update.change));
          const continuations = branch.every(record => record !== undefined) ? branchPublications(group, shared, branch, records) : undefined;
          if (!continuations) throw new UpdateValidationError("Pending branch overlaps an already composed publication; original changes are retained");
          updates.push({...group.update, ...(group.changes.every(change => this.control.settled.includes(change)) ? {objects: [], deltas: []} : {})});
          for (const continuation of continuations) {
            const existing = groups.find(value => value.changes[0] === continuation.changes[0]);
            if (existing && !equal(existing, continuation)) throw new UpdateValidationError("Composed continuation identity changed");
            if (!existing) groups.push(continuation);
            updates.push(existing?.update ?? continuation.update);
          }
          break;
        }
        updates.push(group.changes.every(change => this.control.settled.includes(change)) ? {...group.update, objects: [], deltas: []} : group.update);
        index += group.changes.length;
        continue;
      }
      const run: LocalChange[] = [];
      let best: ChangePublication | undefined;
      for (let cursor = index; cursor < originals.length; cursor++) {
        const record = records.get(originals[cursor]!.change);
        if (!record || !record.update.trace || this.control.settled.includes(record.change) || frozen.has(record.change) || groups.some(group => group.changes.includes(record.change))) break;
        const previous = run.at(-1);
        if (previous && (children.get(previous.change) ?? 0) > 1) break;
        if (previous && (record.basis.kind !== "authored" || record.basis.change !== previous.change)) break;
        const boundary = record.update.resolves.length > 0 || record.update.ifCurrent !== undefined;
        if (boundary && run.length) break;
        run.push(record);
        if (boundary) break;
      }
      const mentions = (value: unknown): boolean => {
        if (!value || typeof value !== "object") return false;
        const fields = value as Record<string, unknown>;
        return (fields.kind === "operation" && groups.some(group => group.changes.includes(fields.change as string))) || Object.values(fields).some(mentions);
      };
      if (run.length > 1 || (run[0]?.update.trace?.length ?? 0) > 1 || mentions(run[0]?.update.trace)) {
        best = publication(run, groups);
        if (!best) {
          let frames = 0, operations = 0, end = 0;
          for (const record of run) {
            frames += record.update.trace!.length;
            operations += record.update.trace!.reduce((n, frame) => n + frame.operations.length, 0);
            if (frames > 64 || operations > 1024) break;
            end++;
          }
          if (end > 0 && end < run.length) best = publication(run.slice(0, end), groups);
        }
      }
      if (best) { best.update = compact(best.update, best.changes.at(-1)!); groups.push(best); updates.push(best.update); index += best.changes.length; }
      else { updates.push(compact(current, current.change)); index++; }
    }
    return { base: request.base, updates };
  }

  /** Classify a failure into the machine's taxonomy. */
  private async fail(error: unknown, id?: string): Promise<void> {
    this.failure = error instanceof Error ? error.message : String(error);
    if (error instanceof ProtocolHTTPError && (error.status === 401 || error.status === 403)) {
      this.dispatch({ type: "authenticationFailed", reason: error.message });
    } else if (error instanceof ProtocolUnsupportedOperation && id) {
      await this.hold("unsupported", error.message, id);
    } else if (error instanceof ProtocolUpdateConflict && id) {
      await this.hold("rejected", "the change conflicts with a newer decision", id);
    } else if (error instanceof ProtocolHTTPError && refusal(error.status) && id) {
      // Repeating a request the host refused cannot change the answer.
      await this.hold("rejected", error.message, id);
    } else if (error instanceof UpdateValidationError || error instanceof UpdateStateError) {
      this.dispatch({ type: "validationFailed", reason: this.failure });
    } else {
      this.dispatch({ type: "transportFailed", ...(id ? { id } : {}) });
    }
  }

  private async hold(reason: HeldReason, detail: string, id: string): Promise<void> {
    this.control.held = { reason, detail };
    try { await this.writeControl(); } catch (error) { this.failure = String(error); }
    this.dispatch({ type: reason, id, detail });
  }

  private writeControl(): Promise<void> {
    return this.store.write(this.control, this.machine.kind);
  }

  private async pendingCount(): Promise<number> {
    const settled = this.settledSet();
    return (await this.log.retained()).filter(record => !settled.has(record.change)).length;
  }

  // MARK: Public operations

  /** Explicit synchronization: publish now, retry, or catch up, then wait for the result. */
  async syncOnce(): Promise<UpdatePresentation> {
    await this.start();
    this.dispatch({ type: "syncRequested" });
    await this.settle();
    // A successor published after an apply waits on a zero delay; follow it.
    for (let round = 0; round < 8; round++) {
      if (this.machine.kind !== "locally-pending" || this.machine.preparing) break;
      this.dispatch({ type: "syncRequested" });
      await this.settle();
    }
    return this.presentation();
  }

  /** Reestablish a coherent snapshot-then-follow boundary after watch history expires. */
  async recoverWatchGap(): Promise<UpdatePresentation> {
    await this.start();
    this.dispatch({ type: this.machine.kind === "current" ? "watchGap" : "syncRequested" });
    await this.settle();
    return this.presentation();
  }

  /** Feed one watch event to the machine and wait for what it caused. */
  /** Whether the tree's watch stream is open; while it is, a clean tree skips its freshness poll. */
  setWatching(open: boolean): void {
    this.watching = open;
  }

  async observe(event: WatchEvent): Promise<UpdatePresentation> {
    await this.start();
    if (event.tree !== this.tree) return this.presentation();
    if (event.kind === "resync-required") return this.recoverWatchGap();
    this.watchEvent = event;
    const { update, requestDigest } = event.transition;
    this.dispatch({ type: "watch", cursor: event.cursor, root: update.root, update: update.id,
      digests: requestDigest ? [requestDigest] : [], transitions: true, conflicted: update.conflicted });
    await this.settle();
    return this.presentation();
  }

  /** Where a watch resumes. */
  async watchCursor(): Promise<string | undefined> {
    await this.start();
    return ("base" in this.machine ? this.machine.base?.cursor : undefined) ?? (await this.working.accepted())?.cursor;
  }

  /** Record network-path availability; reconnection resumes from durable state. */
  async setTransportAvailable(available: boolean): Promise<void> {
    await this.start();
    this.dispatch({ type: "transportAvailable", available });
    if (available) await this.settle();
  }

  /** Refreshed credentials resume a request that failed authentication. */
  async credentialsRefreshed(): Promise<void> {
    await this.start();
    this.dispatch({ type: "credentialsRefreshed" });
    await this.settle();
  }

  /** Discard a held request and every change authored on it, then catch up. This is the explicit way out of `held`. */
  async discardHeldChanges(): Promise<void> {
    await this.start();
    const state = this.machine, attempt = this.control.attempt;
    if (state.kind !== "held" || !attempt || attempt.digest !== state.request.id) return;
    const settled = this.settledSet();
    await this.log.discard(new Set(this.localChanges(attemptRequest(attempt)).filter(change => !settled.has(change))));
    delete this.control.attempt;
    delete this.control.attemptTip;
    delete this.control.held;
    await this.writeControl();
    this.submission = undefined;
    this.working.changed?.();
    this.dispatch({ type: "heldDiscarded" });
    await this.settle();
    await this.publishTip();
  }

  /** The held request and why, for a source that can prove what later work is independent of it. */
  heldRequest(): { reason: HeldReason; detail?: string; attempt: UpdateAttempt } | undefined {
    const state = this.machine, attempt = this.control.attempt;
    if (state.kind !== "held" || !attempt || attempt.digest !== state.request.id) return undefined;
    return { reason: state.reason, ...(state.detail === undefined ? {} : { detail: state.detail }), attempt };
  }

  /** Local changes not yet settled, oldest first. */
  async pendingChanges(): Promise<LocalChange[]> {
    await this.load();
    const settled = this.settledSet();
    return (await this.log.retained()).filter(record => !settled.has(record.change));
  }

  close(): void {
    this.closed = true;
    this.deferredApply = undefined;
    for (const timer of [...this.timers.keys()]) this.cancel(timer);
    this.resumeIdle();
  }

  private requireOpen(): void {
    if (this.closed) throw new UpdateStateError("This synchronization session is closed");
  }

  async presentation(): Promise<UpdatePresentation> {
    const state = this.machine;
    const pending = (await this.pendingChanges()).length;
    const base = "base" in state ? state.base : undefined;
    const value: UpdatePresentation = { state: "current", pending, ...(base ? { acceptedRoot: base.root } : {}),
      ...(base?.conflicted ?? this.control.acceptedConflicted) === undefined ? {} : { acceptedConflicted: base?.conflicted ?? this.control.acceptedConflicted } };
    switch (state.kind) {
      case "unplaced": return { ...value, state: "unplaced", detail: "Not placed" };
      case "current":
        return { ...value, state: pending ? "locally-pending" : "current", ...(state.base.conflicted ? { detail: "Accepted state has unresolved conflicts" } : {}) };
      case "locally-pending": return { ...value, state: "locally-pending" };
      case "prepared": return { ...value, state: "request-pending" };
      case "submitting":
      case "submitting-pending": return { ...value, state: "uploading" };
      case "accepted-pending-apply": return { ...value, state: "downloading" };
      case "offline":
        if (state.availability.kind === "transport") return { ...value, state: "offline", ...(this.failure ? { detail: this.failure } : {}) };
        return { ...value, state: state.availability.reason?.includes("device-revoked") ? "revoked" : "authentication-failure",
          ...(this.failure ?? state.availability.reason ? { detail: this.failure ?? state.availability.reason } : {}) };
      case "held": {
        const lead = state.reason === "unsupported" ? "This change needs a newer client" : "The host refused this change; it is kept on this device";
        return { ...value, state: "held", detail: state.detail ? `${lead}: ${state.detail}` : lead };
      }
      case "terminal": return { ...value, state: "stopped", detail: `Synchronization stopped: ${state.reason}` };
    }
  }
}
