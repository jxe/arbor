import { applyTransitionPayload, decodeTreeSnapshotJSON, hashObject, WireHTTPError, WireUnsupportedOperation, WireUpdateConflict,
  type CurrentTree, type TreeSnapshot, type UpdateResponse, type WatchEvent, type WireClient } from "@overstory/protocol";
import { attemptRequest, emptyControl, encodeAttempt, verifyAttempt, UpdateStateError, UpdateValidationError,
  type ControlStore, type UpdateAttempt, type UpdateControl } from "./control.ts";
import type { LocalChange } from "./local-change.ts";
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
  compact(settled: ReadonlySet<string>): Promise<boolean>;
  /** Remove these changes and every change authored on them. */
  discard(changes: ReadonlySet<string>): Promise<void>;
}

export type UpdateTransport = Pick<WireClient, "submitUpdates" | "descriptor"> & Partial<Pick<WireClient, "snapshot" | "object">>;

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
  /** The validated response of the persisted attempt, kept for the `apply` it leads to. */
  private submission?: { digest: string; response: UpdateResponse; current: Current };
  /** The latest watch event, kept for the `catchUp` its cursor names. */
  private watchEvent?: Extract<WatchEvent, { kind: "tree.update" }>;
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
      const record = (await this.log.retained()).find(record => record.change === tip);
      if (!record) return;
      this.dispatch({ type: "localChange", change: tip, root: record.candidate.root });
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
        })().finally(() => {
          this.submissions.delete(id);
          this.startWorker();
        });
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

  private async persistRequest(tip: LocalTip, extended?: PreparedRequest): Promise<void> {
    const existing = this.control.attempt;
    if (existing && !extended) {
      // A retained request is resubmitted exactly; it is never re-cut from the log.
      this.dispatch({ type: "requestPersisted", request: this.prepared(existing) });
      return;
    }
    try {
      const prepared = await this.log.request(tip.change, this.settledSet());
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
      const response = await this.transport.submitUpdates(this.tree, attemptRequest(attempt));
      const current = await this.validate(response, attempt);
      this.submission = { digest: attempt.digest, response, current };
      this.failure = undefined;
      this.dispatch({ type: "accepted", id: attempt.digest, result: { kind: "accepted", root: current.root, update: current.update,
        cursor: current.cursor, digests: [...attempt.requestDigests], conflicted: current.conflicted } });
    } catch (error) {
      await this.fail(error, attempt.digest);
    }
  }

  /** Check that `response` answers `attempt` exactly and read the host's current head to install. */
  private async validate(response: UpdateResponse, attempt: UpdateAttempt): Promise<Current> {
    if (response.results.length !== attempt.requestDigests.length
        || response.results.some((result, index) => result.requestDigest !== attempt.requestDigests[index])) {
      throw new UpdateValidationError("The host answered a different request");
    }
    if (response.results.some(result => result.update.tree !== attempt.tree)) throw new UpdateValidationError("The host answered for another tree");
    return this.current(await this.transport.descriptor(this.tree));
  }

  private current(descriptor: CurrentTree): Current {
    if (descriptor.tree.id !== this.tree || !descriptor.tree.update) throw new UpdateValidationError("The host described another tree");
    return { update: descriptor.tree.update, root: descriptor.tree.root, conflicted: descriptor.tree.conflicted, cursor: descriptor.observedThrough };
  }

  /** Install an accepted decision for the persisted attempt, settle the changes it carried, and report the installed state. */
  private async apply(_result: AuthorityResult): Promise<void> {
    const attempt = this.control.attempt;
    if (!attempt) {
      // A previous pass already applied and cleared this attempt.
      this.dispatch({ type: "applied" });
      return;
    }
    try {
      let stashed = this.submission?.digest === attempt.digest ? this.submission : undefined;
      if (!stashed) {
        // Watch evidence or a restart: replaying the exact durable request obtains the host's stored response.
        const response = await this.transport.submitUpdates(this.tree, attemptRequest(attempt));
        stashed = { digest: attempt.digest, response, current: await this.validate(response, attempt) };
      }
      const { response, current } = stashed;
      const final = response.results.at(-1);
      if (!final) throw new UpdateValidationError("The host returned no result");
      const request = attemptRequest(attempt);
      const carried = new Set(request.updates.map(update => update.change));
      const records = await this.log.retained();
      // The projection of our own candidate, while the log still holds it.
      let objects = new Map<string, Uint8Array>();
      const record = records.find(record => record.change === this.control.attemptTip);
      if (record && current.update === final.update.id && current.root === final.update.root) {
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
      if (cursor && event?.cursor === cursor && event.transitions.length) {
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
    const first = event.transitions[0]!, final = event.transitions.at(-1)!;
    if (final.update.id !== event.descriptor.update || final.update.root !== event.descriptor.root) {
      throw new UpdateValidationError("Watch transition batch does not match its descriptor");
    }
    if (!accepted || first.from?.id !== accepted.update || first.from.root !== accepted.root) {
      throw new UpdateValidationError("Watch predecessor differs from the installed accepted state");
    }
    let objects = new Map<string, Uint8Array>();
    for (const transition of event.transitions) {
      for (const hash of new Set(transition.deltas.map(delta => delta.base))) {
        if (!objects.has(hash)) objects.set(hash, await this.object(hash, objects));
      }
      objects = applyTransitionPayload(objects, transition);
    }
    return this.install({ update: final.update.id, root: final.update.root, conflicted: final.update.conflicted, cursor: event.cursor }, objects, { pending });
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
    if (await this.log.compact(this.settledSet())) this.control.settled = [];
    else {
      const retained = new Set((await this.log.retained()).map(record => record.change));
      this.control.settled = this.control.settled.filter(change => retained.has(change));
    }
    await this.writeControl();
  }

  /** Classify a failure into the machine's taxonomy. */
  private async fail(error: unknown, id?: string): Promise<void> {
    this.failure = error instanceof Error ? error.message : String(error);
    if (error instanceof WireHTTPError && (error.status === 401 || error.status === 403)) {
      this.dispatch({ type: "authenticationFailed", reason: error.message });
    } else if (error instanceof WireUnsupportedOperation && id) {
      await this.hold("unsupported", error.message, id);
    } else if (error instanceof WireUpdateConflict && id) {
      await this.hold("rejected", "the change conflicts with a newer decision", id);
    } else if (error instanceof WireHTTPError && refusal(error.status) && id) {
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
  async observe(event: WatchEvent): Promise<UpdatePresentation> {
    await this.start();
    if (event.tree !== this.tree) return this.presentation();
    if (event.kind === "resync-required") return this.recoverWatchGap();
    this.watchEvent = event;
    this.dispatch({ type: "watch", cursor: event.cursor, root: event.descriptor.root, update: event.descriptor.update,
      digests: event.requestDigest ? [event.requestDigest] : [], transitions: event.transitions.length > 0, conflicted: event.descriptor.conflicted });
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
    await this.log.discard(new Set(attemptRequest(attempt).updates.map(update => update.change).filter(change => !settled.has(change))));
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

  /** Local changes not yet settled, oldest first. */
  async pendingChanges(): Promise<LocalChange[]> {
    await this.load();
    const settled = this.settledSet();
    return (await this.log.retained()).filter(record => !settled.has(record.change));
  }

  close(): void {
    this.closed = true;
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
