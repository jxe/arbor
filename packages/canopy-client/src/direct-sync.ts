/**
 * Direct Canopy synchronization: the state machine a durable replica or Arbor
 * Sync itself runs against Arbor Wire (Reliability 005, machine B).
 *
 * The reducer is pure and language-neutral: roots, updates, cursors, and
 * request digests are opaque tokens. Every durable store (Arbor Sync's
 * per-tree sync state, the native `DurableSyncControl`) maps onto these
 * states; the runner persists what each state says it retains and executes
 * the effects the reducer returns.
 */

/** Trailing delay before unsent durable local work is published. */
export const PUBLICATION_DELAY_MS = 250;
/** Maximum delay from the first unsent durable head to its publication. */
export const PUBLICATION_MAX_DELAY_MS = 1_000;

/** Who may create a local candidate from disk right now (Arbor Sync only). */
export type SyncRole = "source" | "editor-mirror";

export interface AcceptedBase {
  root: string;
  update: string;
  cursor?: string;
}

export type LocalHeadOrigin = "editor" | "filesystem" | "api";

export interface LocalHead {
  root: string;
  origin: LocalHeadOrigin;
}

export interface PreparedRequest {
  /** Digest of the last element; the request's identity for response and watch correlation. */
  id: string;
  base: string;
  candidate: string;
  /** Every element digest in prefix order. */
  digests: string[];
}

export interface AuthorityResult {
  kind: "accepted" | "merged" | "current";
  root: string;
  update: string;
  cursor?: string;
  /** Digests the accepted history now incorporates. */
  digests: string[];
}

export interface ConflictEvidence {
  current: AcceptedBase;
  draft?: string;
  localRoot: string;
  failedIndex?: number;
}

export type Availability = { kind: "transport" } | { kind: "authentication"; reason?: string };

interface Base {
  base?: AcceptedBase;
  role: SyncRole;
  transportAvailable: boolean;
}

export type SyncState =
  | (Base & { kind: "unplaced" })
  | (Base & { kind: "current"; base: AcceptedBase })
  | (Base & { kind: "locally-pending"; base: AcceptedBase; head: LocalHead; preparing?: boolean })
  | (Base & { kind: "prepared"; base: AcceptedBase; request: PreparedRequest; head?: LocalHead })
  | (Base & { kind: "submitting"; base: AcceptedBase; request: PreparedRequest })
  | (Base & { kind: "submitting-pending"; base: AcceptedBase; request: PreparedRequest; head: LocalHead })
  | (Base & { kind: "accepted-pending-apply"; base: AcceptedBase; result: AuthorityResult; request?: PreparedRequest; head?: LocalHead })
  | (Base & { kind: "conflict"; base: AcceptedBase; request: PreparedRequest; conflict: ConflictEvidence; head?: LocalHead })
  | (Base & { kind: "conflict-preparing"; base: AcceptedBase; request: PreparedRequest; conflict: ConflictEvidence; choice: "local" | "remote" | "draft"; head?: LocalHead })
  | (Base & {
    kind: "offline";
    base: AcceptedBase;
    availability: Availability;
    /** The request whose transmission may have started; immutable. */
    request?: PreparedRequest;
    transmitted: boolean;
    head?: LocalHead;
  })
  | (Base & { kind: "terminal"; reason: string });

export type SyncEvent =
  | { type: "bootstrapInstalled"; root: string; update: string; cursor?: string }
  | { type: "setRole"; role: SyncRole }
  | { type: "localHead"; root: string; origin: LocalHeadOrigin }
  | { type: "publishDelayElapsed" }
  | { type: "maxDelayElapsed" }
  | { type: "requestPersisted"; request: PreparedRequest }
  | { type: "submitStarted"; id: string }
  | { type: "accepted"; id: string; result: AuthorityResult }
  | { type: "watch"; cursor: string; root: string; update: string; digests: string[]; transitions: boolean }
  | { type: "watchGap" }
  | { type: "conflicted"; id: string; conflict: ConflictEvidence }
  | { type: "applied" }
  | { type: "transportFailed"; id?: string }
  | { type: "authenticationFailed"; reason?: string }
  | { type: "validationFailed"; reason: string }
  | { type: "transportAvailable"; available: boolean }
  | { type: "credentialsRefreshed" }
  | { type: "resolveConflict"; choice: "local" | "remote" | "draft" }
  | { type: "conflictResolutionFailed" };

export type SyncEffect =
  | { type: "schedule"; timer: "trailing" | "max"; delay: number }
  | { type: "cancelTimers" }
  /** Persist one exact request from `base` to `candidate`; `extends` names the transmitted prefix it appends to. */
  | { type: "persistRequest"; base: AcceptedBase; candidate: string; extends?: PreparedRequest }
  | { type: "submit"; request: PreparedRequest }
  /** Validate, durably materialize, then dispatch `applied`. */
  | { type: "apply"; result: AuthorityResult }
  /** Clean catch-up: apply a contiguous transition batch or pull the current snapshot, then dispatch `applied`. */
  | { type: "catchUp"; cursor?: string }
  /** A filesystem observation arrived while disk is an editor mirror: reconcile disk to accepted state, create no candidate. */
  | { type: "discardMirrorHead"; root: string }
  | { type: "persistConflictResolution"; request: PreparedRequest; conflict: ConflictEvidence; choice: "local" | "remote" | "draft" }
  | { type: "surfaceConflict"; conflict: ConflictEvidence }
  | { type: "stop"; reason: string };

export interface SyncOptions {
  publicationDelayMs?: number;
  publicationMaxDelayMs?: number;
}

export interface SyncTransition {
  state: SyncState;
  effects: SyncEffect[];
}

export function initialSyncState(role: SyncRole = "source", transportAvailable = true): SyncState {
  return { kind: "unplaced", role, transportAvailable };
}

function ctx(state: Base): Base {
  return { ...(state.base ? { base: state.base } : {}), role: state.role, transportAvailable: state.transportAvailable };
}

function head(root: string, origin: LocalHeadOrigin): LocalHead {
  return { root, origin };
}

function pendingFrom(state: Base & { base: AcceptedBase }, latest: LocalHead, options: SyncOptions): SyncTransition {
  if (!state.transportAvailable) {
    return {
      state: { ...ctx(state), kind: "offline", base: state.base, availability: { kind: "transport" }, transmitted: false, head: latest },
      effects: [],
    };
  }
  return {
    state: { ...ctx(state), kind: "locally-pending", base: state.base, head: latest },
    effects: [
      { type: "schedule", timer: "trailing", delay: options.publicationDelayMs ?? PUBLICATION_DELAY_MS },
      { type: "schedule", timer: "max", delay: options.publicationMaxDelayMs ?? PUBLICATION_MAX_DELAY_MS },
    ],
  };
}

function prepare(state: Base & { base: AcceptedBase; head: LocalHead }): SyncTransition {
  if (state.head.root === state.base.root) {
    return { state: { ...ctx(state), kind: "current", base: state.base }, effects: [{ type: "cancelTimers" }] };
  }
  return {
    state: { ...ctx(state), kind: "locally-pending", base: state.base, head: state.head, preparing: true },
    effects: [{ type: "cancelTimers" }, { type: "persistRequest", base: state.base, candidate: state.head.root }],
  };
}

export function reduceSync(state: SyncState, event: SyncEvent, options: SyncOptions = {}): SyncTransition {
  if (state.kind === "terminal") return { state, effects: [] };

  switch (event.type) {
    case "bootstrapInstalled": {
      if (state.kind !== "unplaced") return { state, effects: [] };
      return {
        state: { ...ctx(state), kind: "current", base: { root: event.root, update: event.update, ...(event.cursor ? { cursor: event.cursor } : {}) } },
        effects: [],
      };
    }

    case "setRole":
      return { state: { ...state, role: event.role }, effects: [] };

    case "localHead": {
      if (event.origin === "filesystem" && state.role === "editor-mirror") {
        return { state, effects: [{ type: "discardMirrorHead", root: event.root }] };
      }
      const latest = head(event.root, event.origin);
      switch (state.kind) {
        case "unplaced":
          return { state, effects: [] };
        case "current":
          return pendingFrom(state, latest, options);
        case "locally-pending":
          if (state.preparing) return { state: { ...state, head: latest }, effects: [] };
          return {
            state: { ...state, head: latest },
            effects: [{ type: "schedule", timer: "trailing", delay: options.publicationDelayMs ?? PUBLICATION_DELAY_MS }],
          };
        case "prepared":
          return { state: { ...state, head: latest }, effects: [] };
        case "submitting":
          return { state: { ...ctx(state), kind: "submitting-pending", base: state.base, request: state.request, head: latest }, effects: [] };
        case "submitting-pending":
        case "accepted-pending-apply":
        case "conflict":
        case "conflict-preparing":
        case "offline":
          // Later local work replaces one successor head; intermediate generations are compacted.
          return { state: { ...state, head: latest }, effects: [] };
      }
      return { state, effects: [] };
    }

    case "publishDelayElapsed":
    case "maxDelayElapsed": {
      if (state.kind !== "locally-pending" || state.preparing) return { state, effects: [] };
      return prepare(state);
    }

    case "requestPersisted": {
      if (state.kind === "conflict-preparing") {
        const successor = state.head && state.head.root !== event.request.candidate ? state.head : undefined;
        return {
          state: { ...ctx(state), kind: "prepared", base: state.conflict.current, request: event.request, ...(successor ? { head: successor } : {}) },
          effects: [{ type: "submit", request: event.request }],
        };
      }
      if (state.kind === "locally-pending") {
        const successor = state.head.root !== event.request.candidate ? state.head : undefined;
        return {
          state: { ...ctx(state), kind: "prepared", base: state.base, request: event.request, ...(successor ? { head: successor } : {}) },
          effects: [{ type: "submit", request: event.request }],
        };
      }
      if (state.kind === "offline" && state.transportAvailable) {
        const successor = state.head && state.head.root !== event.request.candidate ? state.head : undefined;
        return {
          state: { ...ctx(state), kind: "prepared", base: state.base, request: event.request, ...(successor ? { head: successor } : {}) },
          effects: [{ type: "submit", request: event.request }],
        };
      }
      return { state, effects: [] };
    }

    case "submitStarted": {
      if (state.kind !== "prepared" || state.request.id !== event.id) return { state, effects: [] };
      if (state.head) {
        return { state: { ...ctx(state), kind: "submitting-pending", base: state.base, request: state.request, head: state.head }, effects: [] };
      }
      return { state: { ...ctx(state), kind: "submitting", base: state.base, request: state.request }, effects: [] };
    }

    case "accepted": {
      if (state.kind !== "submitting" && state.kind !== "submitting-pending") return { state, effects: [] };
      if (state.request.id !== event.id) return { state, effects: [] };
      const successor = state.kind === "submitting-pending" ? state.head : undefined;
      return {
        state: {
          ...ctx(state),
          kind: "accepted-pending-apply",
          base: state.base,
          result: event.result,
          request: state.request,
          ...(successor ? { head: successor } : {}),
        },
        effects: [{ type: "apply", result: event.result }],
      };
    }

    case "watch": {
      const result: AuthorityResult = {
        kind: "accepted",
        root: event.root,
        update: event.update,
        cursor: event.cursor,
        digests: event.digests,
      };
      switch (state.kind) {
        case "current": {
          if (event.cursor === state.base.cursor || event.update === state.base.update) return { state, effects: [] };
          return {
            state: { ...ctx(state), kind: "accepted-pending-apply", base: state.base, result },
            effects: [{ type: "catchUp", cursor: event.cursor }],
          };
        }
        case "submitting":
        case "submitting-pending": {
          // Racing evidence for the in-flight request: the watch may win.
          if (!event.digests.some((digest) => state.request.digests.includes(digest))) return { state, effects: [] };
          const successor = state.kind === "submitting-pending" ? state.head : undefined;
          return {
            state: {
              ...ctx(state),
              kind: "accepted-pending-apply",
              base: state.base,
              result,
              request: state.request,
              ...(successor ? { head: successor } : {}),
            },
            effects: [{ type: "apply", result }],
          };
        }
        case "locally-pending": {
          if (state.preparing) return { state, effects: [] };
          // Remote history advanced under local work: publish now; the authority merges.
          return prepare(state);
        }
        case "offline": {
          if (state.request && state.transmitted && event.digests.some((digest) => state.request!.digests.includes(digest))) {
            // The lost response is recoverable from accepted history.
            return {
              state: { ...ctx(state), kind: "accepted-pending-apply", base: state.base, result, request: state.request, ...(state.head ? { head: state.head } : {}) },
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
      return {
        state: { ...ctx(state), kind: "accepted-pending-apply", base: state.base, result: { kind: "current", root: state.base.root, update: state.base.update, digests: [] } },
        effects: [{ type: "catchUp" }],
      };
    }

    case "conflicted": {
      if (state.kind !== "submitting" && state.kind !== "submitting-pending") return { state, effects: [] };
      if (state.request.id !== event.id) return { state, effects: [] };
      const successor = state.kind === "submitting-pending" ? state.head : undefined;
      return {
        state: { ...ctx(state), kind: "conflict", base: state.base, request: state.request, conflict: event.conflict, ...(successor ? { head: successor } : {}) },
        effects: [{ type: "surfaceConflict", conflict: event.conflict }],
      };
    }

    case "applied": {
      if (state.kind !== "accepted-pending-apply") return { state, effects: [] };
      const base: AcceptedBase = { root: state.result.root, update: state.result.update, ...(state.result.cursor ? { cursor: state.result.cursor } : {}) };
      const next: Base = { ...ctx(state), base };
      if (state.head && state.head.root !== base.root) {
        // Publish the retained successor against the new applied base without waiting.
        return {
          state: { ...next, kind: "locally-pending", base, head: state.head },
          effects: [{ type: "schedule", timer: "trailing", delay: 0 }],
        };
      }
      return { state: { ...next, kind: "current", base }, effects: [] };
    }

    case "transportFailed": {
      switch (state.kind) {
        case "prepared":
          return {
            state: { ...ctx(state), kind: "offline", base: state.base, availability: { kind: "transport" }, request: state.request, transmitted: false, ...(state.head ? { head: state.head } : {}) },
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
              ...(state.kind === "submitting-pending" ? { head: state.head } : {}),
            },
            effects: [],
          };
        case "locally-pending":
          return {
            state: { ...ctx(state), kind: "offline", base: state.base, availability: { kind: "transport" }, transmitted: false, head: state.head },
            effects: [{ type: "cancelTimers" }],
          };
        case "accepted-pending-apply":
          // The authority decision is durable knowledge; the apply is retried locally.
          return { state, effects: [] };
        default:
          return { state, effects: [] };
      }
    }

    case "authenticationFailed": {
      const availability: Availability = { kind: "authentication", ...(event.reason ? { reason: event.reason } : {}) };
      switch (state.kind) {
        case "prepared":
          return { state: { ...ctx(state), kind: "offline", base: state.base, availability, request: state.request, transmitted: false, ...(state.head ? { head: state.head } : {}) }, effects: [] };
        case "submitting":
        case "submitting-pending":
          return {
            state: { ...ctx(state), kind: "offline", base: state.base, availability, request: state.request, transmitted: true, ...(state.kind === "submitting-pending" ? { head: state.head } : {}) },
            effects: [],
          };
        case "locally-pending":
          return { state: { ...ctx(state), kind: "offline", base: state.base, availability, transmitted: false, head: state.head }, effects: [{ type: "cancelTimers" }] };
        default:
          return { state, effects: [] };
      }
    }

    case "validationFailed":
      return { state: { ...ctx(state), kind: "terminal", reason: event.reason }, effects: [{ type: "cancelTimers" }, { type: "stop", reason: event.reason }] };

    case "transportAvailable": {
      const next = { ...state, transportAvailable: event.available } as SyncState;
      if (!event.available) {
        if (state.kind === "locally-pending") {
          return {
            state: { ...ctx(next), kind: "offline", base: state.base, availability: { kind: "transport" }, transmitted: false, head: state.head },
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

    case "resolveConflict": {
      if (state.kind !== "conflict") return { state, effects: [] };
      return {
        state: { ...ctx(state), kind: "conflict-preparing", base: state.base, request: state.request, conflict: state.conflict, choice: event.choice, ...(state.head ? { head: state.head } : {}) },
        effects: [{ type: "persistConflictResolution", request: state.request, conflict: state.conflict, choice: event.choice }],
      };
    }

    case "conflictResolutionFailed": {
      if (state.kind !== "conflict-preparing") return { state, effects: [] };
      return {
        state: { ...ctx(state), kind: "conflict", base: state.base, request: state.request, conflict: state.conflict, ...(state.head ? { head: state.head } : {}) },
        effects: [{ type: "surfaceConflict", conflict: state.conflict }],
      };
    }
  }
  return { state, effects: [] };
}

/** Reconnection: retry the exact retained request, or append the latest head to an ambiguous prefix once. */
function resume(state: Extract<SyncState, { kind: "offline" }>): SyncTransition {
  if (state.request) {
    if (state.transmitted && state.head && state.head.root !== state.request.candidate) {
      // Ambiguous-recovery transition: the only place a longer append-only request is issued.
      return {
        state: { ...ctx(state), kind: "offline", base: state.base, availability: state.availability, request: state.request, transmitted: true, head: state.head },
        effects: [{ type: "persistRequest", base: state.base, candidate: state.head.root, extends: state.request }],
      };
    }
    const successor = state.head && state.head.root !== state.request.candidate ? state.head : undefined;
    return {
      state: { ...ctx(state), kind: "prepared", base: state.base, request: state.request, ...(successor ? { head: successor } : {}) },
      effects: [{ type: "submit", request: state.request }],
    };
  }
  if (state.head) {
    // Bypass the trailing delay: reconnection is a publication boundary.
    if (state.head.root === state.base.root) return { state: { ...ctx(state), kind: "current", base: state.base }, effects: [] };
    return {
      state: { ...ctx(state), kind: "locally-pending", base: state.base, head: state.head, preparing: true },
      effects: [{ type: "persistRequest", base: state.base, candidate: state.head.root }],
    };
  }
  // A clean offline replica may still be behind: reconnection is an authoritative catch-up boundary.
  return {
    state: { ...ctx(state), kind: "accepted-pending-apply", base: state.base, result: { kind: "current", root: state.base.root, update: state.base.update, digests: [] } },
    effects: [{ type: "catchUp", cursor: state.base.cursor }],
  };
}

/** Whether the machine holds a request whose outcome may already be known to the authority. */
export function syncRequestMayHaveReachedAuthority(state: SyncState): boolean {
  return state.kind === "submitting" || state.kind === "submitting-pending" || (state.kind === "offline" && state.transmitted);
}
