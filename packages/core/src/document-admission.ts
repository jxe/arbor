/**
 * Document admission: the state machine every editor talking to a working
 * tree's document session runs (Reliability 005, machine A).
 *
 * The reducer is pure. It owns every timer, in-flight, successor, flush,
 * observation, failure, and conflict transition; the caller runs the effects
 * it returns. Sources are opaque: the reducer only compares them with the
 * `equal` option, so a web editor can keep block snapshots and a native
 * editor can use exact Markdown strings while executing the same fixtures.
 * Admission is working-tree durability, not accepted history: the update
 * machine (`@arbor/canopy-client` `reduceUpdate`, spec/09) publishes the
 * durable heads afterwards, and the two machines compose in sequence.
 */

/** Reference debounce for the current web and native editors. */
export const ADMISSION_DEBOUNCE_MS = 250;

export interface AdmissionAccepted<S> {
  /** Exact source the editor last acknowledged as locally durable. */
  source: S;
  /** Content revision the next request must name as its base. */
  revision: string;
}

export interface AdmissionSubmission<S> {
  generation: number;
  source: S;
}

export interface AdmissionObservation<S> {
  source: S;
  revision: string;
}

/** Captured before an asynchronous read so a stale result can be discarded. */
export interface AdmissionAnchor {
  generation: number;
  revision: string;
}

export interface AdmissionResult<S> {
  source: S;
  revision: string;
}

export interface AdmissionFailure {
  message: string;
  retryable: boolean;
}

interface Base<S> {
  accepted: AdmissionAccepted<S>;
  /** Monotonic editor generation; every edit increments it. */
  generation: number;
}

export type AdmissionState<S> =
  | (Base<S> & { kind: "clean" })
  | (Base<S> & { kind: "dirty"; latest: AdmissionSubmission<S>; timer: boolean })
  | (Base<S> & { kind: "submitting"; submitted: AdmissionSubmission<S> })
  | (Base<S> & { kind: "submitting-dirty"; submitted: AdmissionSubmission<S>; latest: AdmissionSubmission<S> })
  | (Base<S> & {
    kind: "conflict";
    submitted: AdmissionSubmission<S>;
    current?: AdmissionObservation<S>;
    latest?: AdmissionSubmission<S>;
  })
  | (Base<S> & { kind: "failed"; pending: AdmissionSubmission<S>; error: AdmissionFailure; latest?: AdmissionSubmission<S> })
  | (Base<S> & { kind: "closed" });

export type AdmissionEvent<S> =
  | { type: "edit"; source: S }
  | { type: "debounceElapsed" }
  /** Explicit Save, navigation, focus loss, backgrounding, or close: admit the latest source now. */
  | { type: "flush" }
  | { type: "admitted"; generation: number; result: AdmissionResult<S> }
  | { type: "admissionConflicted"; generation: number; current?: AdmissionObservation<S> }
  | { type: "admissionFailed"; generation: number; error: AdmissionFailure }
  | { type: "observed"; observation: AdmissionObservation<S>; anchor?: AdmissionAnchor }
  | { type: "retry" }
  | { type: "resolveConflict"; choice: "use-current" | "keep-submitted" }
  | { type: "close" };

export type AdmissionEffect<S> =
  | { type: "schedule"; delay: number }
  | { type: "cancelTimer" }
  | { type: "admit"; generation: number; source: S; baseRevision: string }
  /** The working tree acknowledged the exact tree already in the editor; advance source authority without replacing it. */
  | { type: "acknowledge"; result: AdmissionResult<S> }
  /** Replace the editor with authoritative content. */
  | { type: "apply"; source: S; revision: string }
  /** The working tree rejected the write; the caller may run its explicit local merge helper or surface the conflict. */
  | { type: "mergeLocally"; current?: AdmissionObservation<S>; submitted: S; base: S }
  | { type: "surfaceFailure"; error: AdmissionFailure }
  | { type: "stop" };

export interface AdmissionOptions<S> {
  equal(left: S, right: S): boolean;
  debounceMs?: number;
}

export interface AdmissionTransition<S> {
  state: AdmissionState<S>;
  effects: AdmissionEffect<S>[];
}

export function initialAdmissionState<S>(accepted: AdmissionAccepted<S>): AdmissionState<S> {
  return { kind: "clean", accepted, generation: 0 };
}

/** Whether the machine still holds authored intent that is not locally durable. */
export function admissionIsDirty<S>(state: AdmissionState<S>): boolean {
  switch (state.kind) {
    case "dirty":
    case "submitting":
    case "submitting-dirty":
    case "failed":
    case "conflict":
      return true;
    default:
      return false;
  }
}

/** Whether a request is in flight or a timer may still start one. */
export function admissionIsSettled<S>(state: AdmissionState<S>): boolean {
  return state.kind !== "dirty" && state.kind !== "submitting" && state.kind !== "submitting-dirty";
}

function admitEffect<S>(state: Base<S>, submission: AdmissionSubmission<S>): AdmissionEffect<S> {
  return {
    type: "admit",
    generation: submission.generation,
    source: submission.source,
    baseRevision: state.accepted.revision,
  };
}

function base<S>(state: AdmissionState<S>): Base<S> {
  return { accepted: state.accepted, generation: state.generation };
}

function submit<S>(state: AdmissionState<S>, latest: AdmissionSubmission<S>, options: AdmissionOptions<S>): AdmissionTransition<S> {
  // Editing back to the accepted bytes is an idempotent local success.
  if (options.equal(latest.source, state.accepted.source)) {
    return { state: { ...base(state), kind: "clean" }, effects: [] };
  }
  return {
    state: { ...base(state), kind: "submitting", submitted: latest },
    effects: [admitEffect(state, latest)],
  };
}

export function reduceAdmission<S>(
  state: AdmissionState<S>,
  event: AdmissionEvent<S>,
  options: AdmissionOptions<S>,
): AdmissionTransition<S> {
  const debounce = options.debounceMs ?? ADMISSION_DEBOUNCE_MS;
  if (state.kind === "closed") return { state, effects: [] };

  switch (event.type) {
    case "edit": {
      const generation = state.generation + 1;
      const latest = { generation, source: event.source };
      switch (state.kind) {
        case "clean":
        case "dirty":
          return {
            state: { ...base(state), generation, kind: "dirty", latest, timer: true },
            effects: [{ type: "schedule", delay: debounce }],
          };
        case "submitting":
        case "submitting-dirty":
          return { state: { ...base(state), generation, kind: "submitting-dirty", submitted: state.submitted, latest }, effects: [] };
        case "conflict":
          return { state: { ...state, generation, latest }, effects: [] };
        case "failed":
          return { state: { ...state, generation, latest }, effects: [] };
      }
      return { state, effects: [] };
    }

    case "debounceElapsed": {
      if (state.kind !== "dirty") return { state, effects: [] };
      return submit(state, state.latest, options);
    }

    case "flush": {
      switch (state.kind) {
        case "dirty": {
          const transition = submit(state, state.latest, options);
          return { ...transition, effects: [{ type: "cancelTimer" }, ...transition.effects] };
        }
        case "failed":
          // The caller asked for durability; retry the exact pending source once.
          return submit(state, state.latest ?? state.pending, options);
        default:
          return { state, effects: [] };
      }
    }

    case "admitted": {
      if (state.kind !== "submitting" && state.kind !== "submitting-dirty") return { state, effects: [] };
      if (event.generation !== state.submitted.generation) return { state, effects: [] };
      const accepted: AdmissionAccepted<S> = { source: event.result.source, revision: event.result.revision };
      const next: Base<S> = { accepted, generation: state.generation };
      const effects: AdmissionEffect<S>[] = [{ type: "acknowledge", result: event.result }];
      if (state.kind === "submitting-dirty") {
        // Derive the successor's patch from the admitted source and submit it at once.
        const transition = submit({ ...next, kind: "clean" }, state.latest, options);
        return { state: transition.state, effects: [...effects, ...transition.effects] };
      }
      return { state: { ...next, kind: "clean" }, effects };
    }

    case "admissionConflicted": {
      if (state.kind !== "submitting" && state.kind !== "submitting-dirty") return { state, effects: [] };
      if (event.generation !== state.submitted.generation) return { state, effects: [] };
      const latest = state.kind === "submitting-dirty" ? state.latest : undefined;
      const conflict: AdmissionState<S> = {
        ...base(state),
        kind: "conflict",
        submitted: state.submitted,
        ...(event.current ? { current: event.current } : {}),
        ...(latest ? { latest } : {}),
      };
      return {
        state: conflict,
        effects: [{ type: "mergeLocally", current: event.current, submitted: state.submitted.source, base: state.accepted.source }],
      };
    }

    case "admissionFailed": {
      if (state.kind !== "submitting" && state.kind !== "submitting-dirty") return { state, effects: [] };
      if (event.generation !== state.submitted.generation) return { state, effects: [] };
      const latest = state.kind === "submitting-dirty" ? state.latest : undefined;
      return {
        state: { ...base(state), kind: "failed", pending: state.submitted, error: event.error, ...(latest ? { latest } : {}) },
        effects: [{ type: "surfaceFailure", error: event.error }],
      };
    }

    case "observed": {
      const { observation, anchor } = event;
      // A read captured before a newer generation or revision is stale evidence.
      if (anchor && (anchor.generation !== state.generation || anchor.revision !== state.accepted.revision)) {
        return { state, effects: [] };
      }
      switch (state.kind) {
        case "clean": {
          if (observation.revision === state.accepted.revision) return { state, effects: [] };
          return {
            state: { ...base(state), kind: "clean", accepted: acceptedFrom(observation) },
            effects: [{ type: "apply", source: observation.source, revision: observation.revision }],
          };
        }
        case "dirty":
          // External change while local intent is coalescing: make the local
          // intent durable now so the authority, not this editor, reconciles.
          if (observation.revision === state.accepted.revision) return { state, effects: [] };
          {
            const transition = submit(state, state.latest, options);
            return { state: transition.state, effects: [{ type: "cancelTimer" }, ...transition.effects] };
          }
        default:
          return { state, effects: [] };
      }
    }

    case "retry": {
      if (state.kind !== "failed") return { state, effects: [] };
      return submit(state, state.latest ?? state.pending, options);
    }

    case "resolveConflict": {
      if (state.kind !== "conflict") return { state, effects: [] };
      if (event.choice === "use-current") {
        if (!state.current) return { state, effects: [] };
        return {
          state: { ...base(state), kind: "clean", accepted: acceptedFrom(state.current) },
          effects: [{ type: "apply", source: state.current.source, revision: state.current.revision }],
        };
      }
      // Keep the submitted (or newer local) source and resubmit it against the current revision.
      const accepted = state.current ? acceptedFrom(state.current) : state.accepted;
      const rebased: Base<S> = { accepted, generation: state.generation };
      const latest = state.latest ?? state.submitted;
      return submit({ ...rebased, kind: "clean" }, latest, options);
    }

    case "close": {
      const effects: AdmissionEffect<S>[] = [{ type: "cancelTimer" }, { type: "stop" }];
      return { state: { ...base(state), kind: "closed" }, effects };
    }
  }
  return { state, effects: [] };
}

function acceptedFrom<S>(observation: AdmissionObservation<S>): AdmissionAccepted<S> {
  return { source: observation.source, revision: observation.revision };
}

export interface AdmissionClock {
  setTimeout(callback: () => void, delay: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface AdmissionRunnerCallbacks<S> {
  admit(effect: Extract<AdmissionEffect<S>, { type: "admit" }>): Promise<AdmissionResult<S>>;
  /** Classify a rejected admission; return a conflict observation or a failure. */
  classify(error: unknown): { conflict: true; current?: AdmissionObservation<S> } | { conflict: false; error: AdmissionFailure };
  acknowledge(result: AdmissionResult<S>): void;
  apply(source: S, revision: string): void;
  mergeLocally(effect: Extract<AdmissionEffect<S>, { type: "mergeLocally" }>): void;
  surfaceFailure(error: AdmissionFailure): void;
  changed(state: AdmissionState<S>): void;
}

/**
 * Runs the admission machine's effects: one timer, one request in flight, and
 * a `settle` promise that resolves when no request or timer remains so app
 * lifecycle paths can drain explicitly.
 */
export class DocumentAdmissionController<S> {
  private stateValue: AdmissionState<S>;
  private timer: unknown = null;
  private settleWaiters: Array<() => void> = [];

  constructor(
    initial: AdmissionState<S>,
    private readonly options: AdmissionOptions<S>,
    private readonly callbacks: AdmissionRunnerCallbacks<S>,
    private readonly clock: AdmissionClock = systemClock,
  ) {
    this.stateValue = initial;
  }

  get state(): AdmissionState<S> { return this.stateValue; }

  anchor(): AdmissionAnchor {
    return { generation: this.stateValue.generation, revision: this.stateValue.accepted.revision };
  }

  dispatch(event: AdmissionEvent<S>): void {
    const transition = reduceAdmission(this.stateValue, event, this.options);
    this.stateValue = transition.state;
    for (const effect of transition.effects) this.run(effect);
    this.callbacks.changed(this.stateValue);
    if (admissionIsSettled(this.stateValue)) {
      for (const resolve of this.settleWaiters.splice(0)) resolve();
    }
  }

  /** Force the latest pending source through and wait until no request or timer remains. */
  async flush(): Promise<void> {
    this.dispatch({ type: "flush" });
    while (!admissionIsSettled(this.stateValue)) {
      await new Promise<void>((resolve) => this.settleWaiters.push(resolve));
    }
  }

  private run(effect: AdmissionEffect<S>): void {
    switch (effect.type) {
      case "schedule":
        if (this.timer !== null) this.clock.clearTimeout(this.timer);
        this.timer = this.clock.setTimeout(() => {
          this.timer = null;
          this.dispatch({ type: "debounceElapsed" });
        }, effect.delay);
        return;
      case "cancelTimer":
        if (this.timer !== null) this.clock.clearTimeout(this.timer);
        this.timer = null;
        return;
      case "admit":
        void this.callbacks.admit(effect).then(
          (result) => this.dispatch({ type: "admitted", generation: effect.generation, result }),
          (error) => {
            const classified = this.callbacks.classify(error);
            if (classified.conflict) {
              this.dispatch({ type: "admissionConflicted", generation: effect.generation, current: classified.current });
            } else {
              this.dispatch({ type: "admissionFailed", generation: effect.generation, error: classified.error });
            }
          },
        );
        return;
      case "acknowledge":
        this.callbacks.acknowledge(effect.result);
        return;
      case "apply":
        this.callbacks.apply(effect.source, effect.revision);
        return;
      case "mergeLocally":
        this.callbacks.mergeLocally(effect);
        return;
      case "surfaceFailure":
        this.callbacks.surfaceFailure(effect.error);
        return;
      case "stop":
        return;
    }
  }
}

const systemClock: AdmissionClock = {
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
