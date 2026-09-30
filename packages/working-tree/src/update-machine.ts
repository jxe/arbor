/**
 * Working-tree updates: the state machine a working tree runs against Arbor
 * protocol to turn its local changes into accepted updates (docs/overstory-spec/09).
 *
 * The reducer is pure and language-neutral: roots, updates, cursors, change
 * identities and request digests are opaque tokens. A runner appends local
 * changes to its change log, persists what each state says it retains, and
 * executes every effect the reducer returns. The Swift twin is
 * `UpdateMachine` in `CanopyWorkingTree`; both execute `working-tree-updates`
 * in `docs/overstory-spec/conformance/client-state-machines.json`. The
 * runner is `UpdateCoordinator` in `coordinator.ts`.
 */

/** Trailing delay before unsent durable local work is published. */
export const PUBLICATION_DELAY_MS = 250;
/** Optional cap for continuously active sources; interactive clients wait for idle. */
export const PUBLICATION_MAX_DELAY_MS: number | undefined = undefined;

/** Select one contiguous authored branch in admission order. Prepared requests
 * bypass this selector: uncertain/in-flight bodies must be retried exactly. */
export function publicationTip(
  records: ReadonlyArray<{ change: string; parent?: string }>,
  accepted: ReadonlySet<string>,
): string | undefined {
  let tip: string | undefined;
  for (const record of records) {
    if (accepted.has(record.change)) continue;
    if (tip !== undefined && record.parent !== tip) break;
    tip = record.change;
  }
  return tip;
}

export interface AcceptedBase {
  conflicted?: boolean;
  root: string;
  update: string;
  cursor?: string;
}

/**
 * The newest durable local change in the working tree's change log: its
 * authored identity and the root it produces. Editors and folders append
 * changes the same way; the machine never sees their provenance.
 */
export interface LocalTip {
  change: string;
  root: string;
  /** False when pending work carries identity even if its bytes return to the base. */
  settleIfUnchanged?: boolean;
}

export interface PreparedRequest {
  /** Digest of the last element; the request's identity for response and watch correlation. */
  id: string;
  base: string;
  candidate: string;
  /** The local change the request's last element carries. */
  tip: string;
  /** Every element digest in prefix order. */
  digests: string[];
}

export interface AuthorityResult {
  conflicted?: boolean;
  kind: "accepted" | "merged" | "current";
  root: string;
  update: string;
  cursor?: string;
  /** Digests the accepted history now incorporates. */
  digests: string[];
}

export type Availability = { kind: "transport" } | { kind: "authentication"; reason?: string };

/** Why a request is held; neither reason is retried automatically. */
export type HeldReason = "rejected" | "unsupported";

interface Base {
  base?: AcceptedBase;
  transportAvailable: boolean;
  /** Idle has elapsed, including while another request was in flight. */
  publicationReady?: boolean;
  sourcePending?: boolean;
  /** A first unsent change has started the optional maximum-delay window. */
  publicationWindowOpen?: boolean;
  /** A due maximum or explicit flush remains latched until preparation. */
  publicationForced?: boolean;
}

export type UpdateState =
  | (Base & { kind: "unplaced" })
  | (Base & { kind: "current"; base: AcceptedBase })
  | (Base & { kind: "locally-pending"; base: AcceptedBase; tip: LocalTip; preparing?: boolean })
  | (Base & { kind: "prepared"; base: AcceptedBase; request: PreparedRequest; tip?: LocalTip })
  | (Base & { kind: "submitting"; base: AcceptedBase; request: PreparedRequest })
  | (Base & { kind: "submitting-pending"; base: AcceptedBase; request: PreparedRequest; tip: LocalTip })
  | (Base & { kind: "accepted-pending-apply"; base: AcceptedBase; result: AuthorityResult; request?: PreparedRequest; tip?: LocalTip })
  | (Base & {
    kind: "offline";
    base: AcceptedBase;
    availability: Availability;
    /** The request whose transmission may have started; immutable. */
    request?: PreparedRequest;
    transmitted: boolean;
    tip?: LocalTip;
  })
  | (Base & { kind: "held"; base: AcceptedBase; reason: HeldReason; detail?: string; request: PreparedRequest; tip?: LocalTip })
  | (Base & { kind: "terminal"; reason: string });

export type UpdateEvent =
  | { type: "bootstrapInstalled"; conflicted?: boolean; root: string; update: string; cursor?: string }
  /** A retained request found at startup: held again, or resubmitted exactly. */
  | { type: "recovered"; request: PreparedRequest; held?: HeldReason; detail?: string }
  /** A local change is durable in the change log. */
  | { type: "localChange"; change: string; root: string; settleIfUnchanged?: boolean }
  | { type: "sourceActivity"; pending: boolean }
  | { type: "publishDelayElapsed" }
  | { type: "maxDelayElapsed" }
  | { type: "pollElapsed" }
  /** Explicit synchronization or a shutdown drain: publish now, retry, or catch up. */
  | { type: "syncRequested" }
  | { type: "requestPersisted"; request: PreparedRequest }
  | { type: "submitStarted"; id: string }
  | { type: "accepted"; id: string; result: AuthorityResult }
  /** The host definitively refused the request. */
  | { type: "rejected"; id: string; detail?: string }
  /** The request uses an operation the host does not support. */
  | { type: "unsupported"; id: string; detail?: string }
  /** The runner durably discarded the held request and every change authored on it. */
  | { type: "heldDiscarded" }
  | { type: "watch"; conflicted?: boolean; cursor: string; root: string; update: string; digests: string[]; transitions: boolean }
  | { type: "watchGap" }
  /** The apply or catch-up is durable; `installed` names the accepted state actually installed when it differs from the expected result. */
  | { type: "applied"; installed?: AcceptedBase }
  | { type: "transportFailed"; id?: string }
  | { type: "authenticationFailed"; reason?: string }
  | { type: "validationFailed"; reason: string }
  | { type: "transportAvailable"; available: boolean }
  | { type: "credentialsRefreshed" };

export type UpdateEffect =
  | { type: "schedule"; timer: "trailing" | "max" | "poll"; delay: number }
  /** Cancel the trailing and maximum publication timers; the poll timer is independent. */
  | { type: "cancelTimers" }
  /** Persist one exact request: the change log's chain from `base` through `tip`. */
  | { type: "persistRequest"; base: AcceptedBase; tip: LocalTip }
  | { type: "submit"; request: PreparedRequest }
  /** Validate, durably materialize, then dispatch `applied`. */
  | { type: "apply"; result: AuthorityResult }
  /** Clean catch-up: apply a contiguous transition batch or pull the current snapshot, then dispatch `applied`. */
  | { type: "catchUp"; cursor?: string }
  /** The chain through `tip` reproduces the accepted root: acknowledge it locally without a request. */
  | { type: "settle"; tip: LocalTip }
  | { type: "stop"; reason: string };

export interface UpdateOptions {
  publicationDelayMs?: number;
  publicationMaxDelayMs?: number;
  /** When set, the machine polls for freshness and retries transport failures at this interval. */
  pollIntervalMs?: number;
}

export interface UpdateTransition {
  state: UpdateState;
  effects: UpdateEffect[];
}

function ctx(state: Base): Base {
  return { ...(state.sourcePending === undefined ? {} : {sourcePending: state.sourcePending}), ...(state.base ? { base: state.base } : {}), transportAvailable: state.transportAvailable, ...(state.publicationReady === undefined ? {} : { publicationReady: state.publicationReady }), ...(state.publicationWindowOpen === undefined ? {} : { publicationWindowOpen: state.publicationWindowOpen }), ...(state.publicationForced === undefined ? {} : { publicationForced: state.publicationForced }) };
}

function pollEffects(options: UpdateOptions): UpdateEffect[] {
  return options.pollIntervalMs === undefined ? [] : [{ type: "schedule", timer: "poll", delay: options.pollIntervalMs }];
}

function successor(tip: LocalTip | undefined, request: PreparedRequest): LocalTip | undefined {
  return tip && tip.change !== request.tip ? tip : undefined;
}

function pendingFrom(state: Base & { base: AcceptedBase }, latest: LocalTip, effects: UpdateEffect[]): UpdateTransition {
  return { state: state.transportAvailable
    ? { ...ctx(state), kind: "locally-pending", base: state.base, tip: latest }
    : { ...ctx(state), kind: "offline", base: state.base, availability: { kind: "transport" }, transmitted: false, tip: latest }, effects };
}

function prepare(input: Base & { base: AcceptedBase }, tip: LocalTip): UpdateTransition {
  if (input.sourcePending && !input.publicationForced) return {state: {...input, kind: "locally-pending", tip}, effects: []};
  const state = { ...input, publicationWindowOpen: false, publicationForced: false };
  if (tip.root === state.base.root && tip.settleIfUnchanged !== false) {
    return { state: { ...ctx(state), kind: "current", base: state.base }, effects: [{ type: "cancelTimers" }, { type: "settle", tip }] };
  }
  return {
    state: { ...ctx(state), kind: "locally-pending", base: state.base, tip, preparing: true },
    effects: [{ type: "cancelTimers" }, { type: "persistRequest", base: state.base, tip }],
  };
}

function catchUp(state: Base & { base: AcceptedBase }, cursor?: string): UpdateTransition {
  return {
    state: { ...ctx(state), kind: "accepted-pending-apply", base: state.base, result: { kind: "current", root: state.base.root, update: state.base.update, digests: [] } },
    effects: [cursor === undefined ? { type: "catchUp" } : { type: "catchUp", cursor }],
  };
}

function hold(state: UpdateState, id: string, reason: HeldReason, detail?: string): UpdateTransition {
  let request: PreparedRequest | undefined;
  let tip: LocalTip | undefined;
  switch (state.kind) {
    case "prepared":
    case "submitting-pending":
      request = state.request; tip = state.tip; break;
    case "submitting":
      request = state.request; break;
    case "offline":
      request = state.request; tip = state.tip; break;
    default:
      return { state, effects: [] };
  }
  if (!request || request.id !== id) return { state, effects: [] };
  return {
    state: { ...ctx(state), kind: "held", base: state.base, reason, ...(detail === undefined ? {} : { detail }), request, ...(tip ? { tip } : {}) },
    effects: [],
  };
}

/** A freshness tick or explicit synchronization: catch up when clean, publish unsent work, repeat an unfinished apply, and retry a transport failure while the network is believed available. */
function poll(state: UpdateState): UpdateTransition {
  switch (state.kind) {
    case "current":
      return catchUp(state, state.base.cursor);
    case "accepted-pending-apply":
      // The decision is durable knowledge; only its local apply is repeated.
      return { state, effects: [state.request ? { type: "apply", result: state.result } : state.result.cursor === undefined ? { type: "catchUp" } : { type: "catchUp", cursor: state.result.cursor }] };
    case "locally-pending":
      if (state.preparing) return { state, effects: [] };
      return prepare(state, state.tip);
    case "offline":
      if (!state.transportAvailable || state.availability.kind !== "transport") return { state, effects: [] };
      return resume(state);
    default:
      return { state, effects: [] };
  }
}

export function reduceUpdate(input: UpdateState, event: UpdateEvent, options: UpdateOptions = {}): UpdateTransition {
  if (input.kind === "terminal") return { state: input, effects: [] };
  const state: UpdateState = event.type === "localChange" && input.kind !== "unplaced"
    ? { ...input, publicationReady: false, publicationWindowOpen: true, publicationForced: input.publicationWindowOpen ? input.publicationForced : false }
    : event.type === "publishDelayElapsed" && !input.sourcePending ? { ...input, publicationReady: true } : input;

  switch (event.type) {
    case "bootstrapInstalled": {
      if (state.kind !== "unplaced") return { state, effects: [] };
      const base: AcceptedBase = { root: event.root, update: event.update, ...(event.conflicted === undefined ? {} : { conflicted: event.conflicted }), ...(event.cursor ? { cursor: event.cursor } : {}) };
      return {
        state: state.transportAvailable
          ? { ...ctx(state), kind: "current", base }
          : { ...ctx(state), kind: "offline", base, availability: { kind: "transport" }, transmitted: false },
        effects: pollEffects(options),
      };
    }

    case "recovered": {
      const cleanOffline = state.kind === "offline" && state.availability.kind === "transport" && !state.request && !state.tip;
      if (state.kind !== "current" && !(state.kind === "offline" && cleanOffline)) return { state, effects: [] };
      if (event.held) {
        return {
          state: { ...ctx(state), kind: "held", base: state.base, reason: event.held, ...(event.detail === undefined ? {} : { detail: event.detail }), request: event.request },
          effects: [],
        };
      }
      if (!state.transportAvailable) {
        // A retained request may have reached the host before the restart.
        return { state: { ...ctx(state), kind: "offline", base: state.base, availability: { kind: "transport" }, request: event.request, transmitted: true }, effects: [] };
      }
      return { state: { ...ctx(state), kind: "prepared", base: state.base, request: event.request }, effects: [{ type: "submit", request: event.request }] };
    }

    case "sourceActivity":
      return {state: {...state, sourcePending: event.pending, publicationReady: false}, effects: event.pending ? [] : [{type: "schedule", timer: "trailing", delay: options.publicationDelayMs ?? PUBLICATION_DELAY_MS}]};

    case "localChange": {
      const latest: LocalTip = { change: event.change, root: event.root, ...(event.settleIfUnchanged === false ? { settleIfUnchanged: false } : {}) };
      const delay: UpdateEffect[] = [{ type: "schedule", timer: "trailing", delay: options.publicationDelayMs ?? PUBLICATION_DELAY_MS }, ...(!input.publicationWindowOpen && options.publicationMaxDelayMs !== undefined ? [{type: "schedule" as const, timer: "max" as const, delay: options.publicationMaxDelayMs}] : [])];
      switch (state.kind) {
        case "unplaced":
          return { state, effects: [] };
        case "current":
          return pendingFrom(state, latest, delay);
        case "locally-pending":
          if (state.preparing) return { state: { ...state, tip: latest }, effects: delay };
          return {
            state: { ...state, tip: latest },
            effects: delay,
          };
        case "submitting":
          return { state: { ...ctx(state), kind: "submitting-pending", base: state.base, request: state.request, tip: latest }, effects: delay };
        case "prepared":
        case "submitting-pending":
        case "accepted-pending-apply":
        case "offline":
        case "held":
          // Later local work replaces one successor tip; the log keeps every change.
          return { state: { ...state, tip: latest }, effects: delay };
      }
      return { state, effects: [] };
    }

    case "publishDelayElapsed": {
      if (state.sourcePending) return {state, effects: []};
      if (state.kind === "offline" && state.availability.kind === "transport" && state.transportAvailable) return resume(state);
      if (state.kind !== "locally-pending" || state.preparing) return { state, effects: [] };
      return prepare(state, state.tip);
    }
    case "maxDelayElapsed": {
      if (options.publicationMaxDelayMs === undefined || !state.publicationWindowOpen) return { state, effects: [] };
      const next = {...state, publicationForced: true};
      if (next.kind === "offline" && next.availability.kind === "transport" && next.transportAvailable) return resume(next);
      if (next.kind !== "locally-pending" || next.preparing) return {state: next, effects: []};
      return prepare(next, next.tip);
    }

    case "pollElapsed": {
      if (state.kind === "unplaced") return { state, effects: [] };
      if ("tip" in state && state.tip && !state.publicationReady && !state.publicationForced) return { state, effects: pollEffects(options) };
      const polled = poll(state);
      return { state: polled.state, effects: [...polled.effects, ...pollEffects(options)] };
    }

    case "syncRequested":
      return poll({ ...state, publicationForced: true });

    case "requestPersisted": {
      if (state.kind === "locally-pending" || (state.kind === "offline" && state.transportAvailable)) {
        const tip = successor(state.tip, event.request);
        return {
          state: { ...ctx(state), kind: "prepared", base: state.base, request: event.request, ...(tip ? { tip } : {}) },
          effects: [{ type: "submit", request: event.request }],
        };
      }
      return { state, effects: [] };
    }

    case "submitStarted": {
      if (state.kind !== "prepared" || state.request.id !== event.id) return { state, effects: [] };
      if (state.tip) {
        return { state: { ...ctx(state), kind: "submitting-pending", base: state.base, request: state.request, tip: state.tip }, effects: [] };
      }
      return { state: { ...ctx(state), kind: "submitting", base: state.base, request: state.request }, effects: [] };
    }

    case "accepted": {
      // A request repeated after reconnection may be answered by the attempt
      // that was still in flight, before the repeat starts.
      if (state.kind !== "submitting" && state.kind !== "submitting-pending" && state.kind !== "prepared") return { state, effects: [] };
      if (state.request.id !== event.id) return { state, effects: [] };
      const tip = state.kind === "submitting" ? undefined : state.tip;
      return {
        state: { ...ctx(state), kind: "accepted-pending-apply", base: state.base, result: event.result, request: state.request, ...(tip ? { tip } : {}) },
        effects: [{ type: "apply", result: event.result }],
      };
    }

    case "rejected":
      return hold(state, event.id, "rejected", event.detail);

    case "unsupported":
      return hold(state, event.id, "unsupported", event.detail);

    case "heldDiscarded": {
      if (state.kind !== "held") return { state, effects: [] };
      // The discarded chain leaves no local work; the host may have moved meanwhile.
      return catchUp(state, state.base.cursor);
    }

    case "watch": {
      const result: AuthorityResult = {
        kind: "accepted",
        root: event.root,
        update: event.update,
        cursor: event.cursor,
        digests: event.digests,
        ...(event.conflicted === undefined ? {} : { conflicted: event.conflicted }),
      };
      switch (state.kind) {
        case "current": {
          if (event.cursor === state.base.cursor) return { state, effects: [] };
          if (event.update === state.base.update) {
            // Our own or an already installed update: only observation progress is new.
            if (event.root !== state.base.root) return { state, effects: [] };
            return { state: { ...state, base: { ...state.base, cursor: event.cursor } }, effects: [] };
          }
          return {
            state: { ...ctx(state), kind: "accepted-pending-apply", base: state.base, result },
            effects: [{ type: "catchUp", cursor: event.cursor }],
          };
        }
        case "submitting":
        case "submitting-pending": {
          // Racing evidence for the in-flight request: the watch may win.
          if (!event.digests.some((digest) => state.request.digests.includes(digest))) return { state, effects: [] };
          const tip = state.kind === "submitting-pending" ? state.tip : undefined;
          return {
            state: { ...ctx(state), kind: "accepted-pending-apply", base: state.base, result, request: state.request, ...(tip ? { tip } : {}) },
            effects: [{ type: "apply", result }],
          };
        }
        case "locally-pending": {
          if (state.preparing || (!state.publicationReady && !state.publicationForced)) return { state, effects: [] };
          // Remote history advanced under local work: publish now; the authority merges.
          return prepare(state, state.tip);
        }
        case "offline": {
          if (state.request && state.transmitted && event.digests.some((digest) => state.request!.digests.includes(digest))) {
            // The lost response is recoverable from accepted history.
            return {
              state: { ...ctx(state), kind: "accepted-pending-apply", base: state.base, result, request: state.request, ...(state.tip ? { tip: state.tip } : {}) },
              effects: [{ type: "apply", result }],
            };
          }
          // A watch frame is evidence that transport works again.
          if (state.availability.kind !== "transport") return { state, effects: [] };
          return resume({ ...state, transportAvailable: true });
        }
        default:
          return { state, effects: [] };
      }
    }

    case "watchGap": {
      if (state.kind !== "current") return { state, effects: [] };
      return catchUp(state);
    }

    case "applied": {
      if (state.kind !== "accepted-pending-apply") return { state, effects: [] };
      const base: AcceptedBase = event.installed ?? { root: state.result.root, update: state.result.update, ...(state.result.conflicted === undefined ? {} : { conflicted: state.result.conflicted }), ...(state.result.cursor ? { cursor: state.result.cursor } : {}) };
      const next: Base = { ...ctx(state), base };
      if (state.tip) {
        // The quiet period runs from the last change, also while submitting.
        return (state.publicationReady || state.publicationForced) ? prepare({ ...next, base }, state.tip) : {
          state: { ...next, kind: "locally-pending", base, tip: state.tip }, effects: [],
        };
      }
      return { state: { ...next, kind: "current", base }, effects: [] };
    }

    case "transportFailed": {
      switch (state.kind) {
        case "prepared":
          return {
            state: { ...ctx(state), kind: "offline", base: state.base, availability: { kind: "transport" }, request: state.request, transmitted: false, ...(state.tip ? { tip: state.tip } : {}) },
            effects: [],
          };
        case "submitting":
        case "submitting-pending":
          if (event.id !== undefined && event.id !== state.request.id) return { state, effects: [] };
          return {
            state: {
              ...ctx(state),
              kind: "offline",
              base: state.base,
              availability: { kind: "transport" },
              request: state.request,
              transmitted: true,
              ...(state.kind === "submitting-pending" ? { tip: state.tip } : {}),
            },
            effects: [],
          };
        case "locally-pending":
          return {
            state: { ...ctx(state), kind: "offline", base: state.base, availability: { kind: "transport" }, transmitted: false, tip: state.tip },
            effects: [],
          };
        case "accepted-pending-apply":
          // A catch-up that could not finish is retried on reconnection like
          // everything else. An accepted request's apply is durable knowledge
          // and is retried locally.
          if (state.request || event.id !== undefined) return { state, effects: [] };
          return {
            state: { ...ctx(state), kind: "offline", base: state.base, availability: { kind: "transport" }, transmitted: false, ...(state.tip ? { tip: state.tip } : {}) },
            effects: [],
          };
        default:
          return { state, effects: [] };
      }
    }

    case "authenticationFailed": {
      const availability: Availability = { kind: "authentication", ...(event.reason ? { reason: event.reason } : {}) };
      switch (state.kind) {
        case "prepared":
          return { state: { ...ctx(state), kind: "offline", base: state.base, availability, request: state.request, transmitted: false, ...(state.tip ? { tip: state.tip } : {}) }, effects: [] };
        case "submitting":
        case "submitting-pending":
          return {
            state: { ...ctx(state), kind: "offline", base: state.base, availability, request: state.request, transmitted: true, ...(state.kind === "submitting-pending" ? { tip: state.tip } : {}) },
            effects: [],
          };
        case "locally-pending":
          return { state: { ...ctx(state), kind: "offline", base: state.base, availability, transmitted: false, tip: state.tip }, effects: [] };
        case "accepted-pending-apply":
          if (state.request) return { state, effects: [] };
          return { state: { ...ctx(state), kind: "offline", base: state.base, availability, transmitted: false, ...(state.tip ? { tip: state.tip } : {}) }, effects: [] };
        default:
          return { state, effects: [] };
      }
    }

    case "validationFailed":
      return { state: { ...ctx(state), kind: "terminal", reason: event.reason }, effects: [{ type: "cancelTimers" }, { type: "stop", reason: event.reason }] };

    case "transportAvailable": {
      const next = { ...state, transportAvailable: event.available } as UpdateState;
      if (!event.available) {
        if (state.kind === "locally-pending") {
          return {
            state: { ...ctx(next), kind: "offline", base: state.base, availability: { kind: "transport" }, transmitted: false, tip: state.tip },
            effects: [],
          };
        }
        if (state.kind === "current") {
          // A clean tree offline may fall behind; reconnection catches it up.
          return { state: { ...ctx(next), kind: "offline", base: state.base, availability: { kind: "transport" }, transmitted: false }, effects: [] };
        }
        if (state.kind === "prepared" || state.kind === "submitting" || state.kind === "submitting-pending") {
          // A hanging attempt may or may not have reached the host.
          const tip = state.kind === "submitting" ? undefined : state.tip;
          return {
            state: { ...ctx(next), kind: "offline", base: state.base, availability: { kind: "transport" }, request: state.request, transmitted: state.kind !== "prepared", ...(tip ? { tip } : {}) },
            effects: [],
          };
        }
        return { state: next, effects: [] };
      }
      if (state.kind !== "offline") return { state: next, effects: [] };
      if (state.availability.kind === "authentication") return { state: next, effects: [] };
      return resume({ ...state, transportAvailable: true });
    }

    case "credentialsRefreshed": {
      if (state.kind !== "offline" || state.availability.kind !== "authentication") return { state, effects: [] };
      return resume({ ...state, transportAvailable: true });
    }
  }
  return { state, effects: [] };
}

/** Reconnection: retry the exact retained request. A request that may have
 * reached the host is only ever repeated unchanged; later work waits for its
 * answer and then publishes as one update. */
function resume(state: Extract<UpdateState, { kind: "offline" }>): UpdateTransition {
  if (state.request) {
    const tip = successor(state.tip, state.request);
    return {
      state: { ...ctx(state), kind: "prepared", base: state.base, request: state.request, ...(tip ? { tip } : {}) },
      effects: [{ type: "submit", request: state.request }],
    };
  }
  if (state.tip) {
    if (!state.publicationReady && !state.publicationForced) return {
      state: { ...ctx(state), kind: "locally-pending", base: state.base, tip: state.tip }, effects: [],
    };
    return prepare(state, state.tip);
  }
  // A clean offline replica may still be behind: reconnection is an authoritative catch-up boundary.
  return catchUp(state, state.base.cursor);
}
