/**
 * Working-tree updates: the state machine a working tree runs against Arbor
 * Wire to turn its local changes into accepted updates (docs/overstory-spec/09).
 *
 * The reducer is pure and language-neutral: roots, updates, cursors, change
 * identities and request digests are opaque tokens. A runner appends local
 * changes to its change log, persists what each state says it retains, and
 * executes every effect the reducer returns. The Swift twin is
 * `UpdateMachine` in `CanopyWorkingTree`; both execute `working-tree-updates`
 * in `docs/overstory-spec/conformance/client-state-machines.json`. No
 * TypeScript runner exists yet; Clients 001 phase 4 adds one.
 */

/** Trailing delay before unsent durable local work is published. */
export const PUBLICATION_DELAY_MS = 250;
/** Maximum delay from the first unsent durable change to its publication. */
export const PUBLICATION_MAX_DELAY_MS = 1_000;

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
  | { type: "localChange"; change: string; root: string }
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
  /** Persist one exact request: the change log's chain from `base` through `tip`; `extends` names a transmitted request it repeats exactly as its prefix. */
  | { type: "persistRequest"; base: AcceptedBase; tip: LocalTip; extends?: PreparedRequest }
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
  return { ...(state.base ? { base: state.base } : {}), transportAvailable: state.transportAvailable };
}

function pollEffects(options: UpdateOptions): UpdateEffect[] {
  return options.pollIntervalMs === undefined ? [] : [{ type: "schedule", timer: "poll", delay: options.pollIntervalMs }];
}

function successor(tip: LocalTip | undefined, request: PreparedRequest): LocalTip | undefined {
  return tip && tip.change !== request.tip ? tip : undefined;
}

function pendingFrom(state: Base & { base: AcceptedBase }, latest: LocalTip, options: UpdateOptions): UpdateTransition {
  if (!state.transportAvailable) {
    return {
      state: { ...ctx(state), kind: "offline", base: state.base, availability: { kind: "transport" }, transmitted: false, tip: latest },
      effects: [],
    };
  }
  return {
    state: { ...ctx(state), kind: "locally-pending", base: state.base, tip: latest },
    effects: [
      { type: "schedule", timer: "trailing", delay: options.publicationDelayMs ?? PUBLICATION_DELAY_MS },
      { type: "schedule", timer: "max", delay: options.publicationMaxDelayMs ?? PUBLICATION_MAX_DELAY_MS },
    ],
  };
}

function prepare(state: Base & { base: AcceptedBase }, tip: LocalTip): UpdateTransition {
  if (tip.root === state.base.root) {
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

export function reduceUpdate(state: UpdateState, event: UpdateEvent, options: UpdateOptions = {}): UpdateTransition {
  if (state.kind === "terminal") return { state, effects: [] };

  switch (event.type) {
    case "bootstrapInstalled": {
      if (state.kind !== "unplaced") return { state, effects: [] };
      return {
        state: { ...ctx(state), kind: "current", base: { root: event.root, update: event.update, ...(event.conflicted === undefined ? {} : { conflicted: event.conflicted }), ...(event.cursor ? { cursor: event.cursor } : {}) } },
        effects: pollEffects(options),
      };
    }

    case "recovered": {
      if (state.kind !== "current") return { state, effects: [] };
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

    case "localChange": {
      const latest: LocalTip = { change: event.change, root: event.root };
      switch (state.kind) {
        case "unplaced":
          return { state, effects: [] };
        case "current":
          return pendingFrom(state, latest, options);
        case "locally-pending":
          if (state.preparing) return { state: { ...state, tip: latest }, effects: [] };
          return {
            state: { ...state, tip: latest },
            effects: [{ type: "schedule", timer: "trailing", delay: options.publicationDelayMs ?? PUBLICATION_DELAY_MS }],
          };
        case "submitting":
          return { state: { ...ctx(state), kind: "submitting-pending", base: state.base, request: state.request, tip: latest }, effects: [] };
        case "prepared":
        case "submitting-pending":
        case "accepted-pending-apply":
        case "offline":
        case "held":
          // Later local work replaces one successor tip; the log keeps every change.
          return { state: { ...state, tip: latest }, effects: [] };
      }
      return { state, effects: [] };
    }

    case "publishDelayElapsed":
    case "maxDelayElapsed": {
      if (state.kind !== "locally-pending" || state.preparing) return { state, effects: [] };
      return prepare(state, state.tip);
    }

    case "pollElapsed": {
      if (state.kind === "unplaced") return { state, effects: [] };
      const polled = poll(state);
      return { state: polled.state, effects: [...polled.effects, ...pollEffects(options)] };
    }

    case "syncRequested":
      return poll(state);

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
      if (state.kind !== "submitting" && state.kind !== "submitting-pending") return { state, effects: [] };
      if (state.request.id !== event.id) return { state, effects: [] };
      const tip = state.kind === "submitting-pending" ? state.tip : undefined;
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
          if (state.preparing) return { state, effects: [] };
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
          return { state, effects: [] };
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
        // Publish the retained successor against the new applied base without waiting.
        return {
          state: { ...next, kind: "locally-pending", base, tip: state.tip },
          effects: [{ type: "schedule", timer: "trailing", delay: 0 }],
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
            effects: [{ type: "cancelTimers" }],
          };
        default:
          // An accepted decision is durable knowledge; its apply is retried locally.
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
          return { state: { ...ctx(state), kind: "offline", base: state.base, availability, transmitted: false, tip: state.tip }, effects: [{ type: "cancelTimers" }] };
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
            effects: [{ type: "cancelTimers" }],
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

/** Reconnection: retry the exact retained request, or append the latest tip to an ambiguous prefix once. */
function resume(state: Extract<UpdateState, { kind: "offline" }>): UpdateTransition {
  if (state.request) {
    if (state.transmitted && state.tip && state.tip.change !== state.request.tip) {
      // Ambiguous-recovery transition: the only place a longer append-only request is issued.
      return {
        state,
        effects: [{ type: "persistRequest", base: state.base, tip: state.tip, extends: state.request }],
      };
    }
    const tip = successor(state.tip, state.request);
    return {
      state: { ...ctx(state), kind: "prepared", base: state.base, request: state.request, ...(tip ? { tip } : {}) },
      effects: [{ type: "submit", request: state.request }],
    };
  }
  if (state.tip) {
    if (state.tip.root === state.base.root) {
      return { state: { ...ctx(state), kind: "current", base: state.base }, effects: [{ type: "settle", tip: state.tip }] };
    }
    // Bypass the trailing delay: reconnection is a publication boundary.
    return {
      state: { ...ctx(state), kind: "locally-pending", base: state.base, tip: state.tip, preparing: true },
      effects: [{ type: "persistRequest", base: state.base, tip: state.tip }],
    };
  }
  // A clean offline replica may still be behind: reconnection is an authoritative catch-up boundary.
  return catchUp(state, state.base.cursor);
}
