// The race-free live view state machine every view backing shares: the
// runtime's own brokers, and overstoryd streaming answers from its execution
// sidecar. It knows nothing about how a query is evaluated.

import type { Hash } from "./identifiers.ts";
import { semanticRequestDigest, type ResultShape, type ViewEvent } from "./protocol.ts";

/** What the state machine needs of a mounted query. */
export interface LiveMount {
  id: string;
  knownOutputHash?: Hash;
}

export type ViewStreamError = Extract<ViewEvent, { error: unknown }>["error"];

export interface LiveViewContext {
  signal: AbortSignal;
  user: { profile: string } | null;
}

/**
 * Backing-specific half of a live query: how to evaluate a mount, what it is
 * sensitive to, and which observed events are relevant to it. The shared
 * stream owns the race-free snapshot-then-follow state machine.
 */
export interface LiveViewAdapter<Execution, Sensitivity, Event, Mount extends LiveMount = LiveMount> {
  subscribe(listener: (event: Event) => void): () => void;
  /** Sensitivity derivable before the first evaluation (for example from the plan). */
  initialSensitivity?(mount: Mount): Sensitivity;
  execute(mount: Mount): Promise<Execution>;
  sensitivity(mount: Mount, execution: Execution): Sensitivity;
  relevant(event: Event, mount: Mount, sensitivity: Sensitivity | undefined, execution: Execution | undefined): boolean;
  result(execution: Execution): unknown;
  /** The result's field types and row identity, when it has them. */
  shape?(execution: Execution): ResultShape | undefined;
  /** The result's hash, when the backing knows it without the value; otherwise {@link outputHash} of the result. */
  outputHash?(execution: Execution): Hash;
  safeError(error: unknown): ViewStreamError;
  /** When an event demands a complete reload, its reason; the stream then closes. */
  reload?(event: Event): "source-changed" | "access-changed" | undefined;
}

export function outputHash(value: unknown): Hash {
  return semanticRequestDigest(value);
}

/** A view result's hash: its value, and its shape when it has one (07 §12.1). */
export function viewOutputHash(value: unknown, shape?: ResultShape): Hash {
  return outputHash(shape ? { value, shape } : value);
}

/**
 * Race-free live evaluation shared by every backing: the listener is attached
 * before the initial snapshot, events racing an evaluation are checked against
 * both the former and the new sensitivities, identical output hashes publish
 * nothing, and `ready` follows every established snapshot boundary.
 */
export function liveViewStream<Execution, Sensitivity, Event, Mount extends LiveMount = LiveMount>(
  mounts: readonly Mount[],
  context: LiveViewContext,
  adapter: LiveViewAdapter<Execution, Sensitivity, Event, Mount>,
): ReadableStream<ViewEvent> {
  let cancelStream: (() => void) | undefined;
  return new ReadableStream<ViewEvent>({
    start(controller) {
      let closed = false;
      let ready = false;
      const states = mounts.map((mount) => ({
        mount,
        sensitivity: adapter.initialSensitivity?.(mount),
        execution: undefined as Execution | undefined,
        pending: [] as Event[],
        running: undefined as Promise<void> | undefined,
        hash: undefined as Hash | undefined,
      }));
      type State = typeof states[number];
      const resultEvent = (id: string, hash: Hash, execution: Execution): ViewEvent => {
        const shape = adapter.shape?.(execution);
        return { type: "result", id, outputHash: hash, value: adapter.result(execution), ...(shape ? { shape } : {}) };
      };
      const closeStream = () => { try { controller.close(); } catch {} };
      const emit = (event: ViewEvent) => {
        if (closed) return;
        if ((controller.desiredSize ?? 1) <= 0) {
          cleanup();
          closeStream();
          return;
        }
        controller.enqueue(event);
      };
      const evaluate = (state: State, publish: boolean): Promise<void> => {
        if (state.running) return state.running;
        state.running = (async () => {
          while (!closed) {
            const oldSensitivity = state.sensitivity;
            const oldExecution = state.execution;
            state.pending = [];
            let execution: Execution;
            let sensitivity: Sensitivity;
            try {
              execution = await adapter.execute(state.mount);
              sensitivity = adapter.sensitivity(state.mount, execution);
            } catch (error) {
              emit({ type: "result", id: state.mount.id, error: adapter.safeError(error) });
              return;
            }
            const invalidated = state.pending.some((event) =>
              adapter.relevant(event, state.mount, oldSensitivity, oldExecution)
              || adapter.relevant(event, state.mount, sensitivity, execution));
            if (invalidated) continue;
            state.execution = execution;
            state.sensitivity = sensitivity;
            const hash = adapter.outputHash?.(execution) ?? viewOutputHash(adapter.result(execution), adapter.shape?.(execution));
            if (publish && hash !== state.hash) {
              emit(resultEvent(state.mount.id, hash, execution));
            }
            state.hash = hash;
            return;
          }
        })().finally(() => { state.running = undefined; });
        return state.running;
      };
      const stop = adapter.subscribe((event) => {
        const reason = adapter.reload?.(event);
        if (reason) {
          emit({ type: "reload", reason });
          cleanup();
          closeStream();
          return;
        }
        for (const state of states) {
          if (!adapter.relevant(event, state.mount, state.sensitivity, state.execution)) continue;
          state.pending.push(event);
          if (ready && !state.running) void evaluate(state, true);
        }
      });
      const cleanup = () => {
        if (closed) return;
        closed = true;
        stop();
        context.signal.removeEventListener("abort", abort);
      };
      cancelStream = cleanup;
      const abort = () => {
        cleanup();
        closeStream();
      };
      context.signal.addEventListener("abort", abort, { once: true });
      if (context.signal.aborted) {
        abort();
        return;
      }
      void (async () => {
        await Promise.all(states.map((state) => evaluate(state, false)));
        if (closed) return;
        // No event can cross this synchronous publication boundary without
        // first being queued by the already-attached listener.
        for (const state of states) {
          if (!state.execution || !state.hash) continue;
          if (state.hash !== state.mount.knownOutputHash) {
            emit(resultEvent(state.mount.id, state.hash, state.execution));
          }
        }
        ready = true;
        emit({ type: "ready", views: states.map((state) => ({
          id: state.mount.id,
          ...(state.hash ? { outputHash: state.hash } : {}),
        })) });
        for (const state of states) if (state.pending.length && !state.running) void evaluate(state, true);
      })().catch((error) => {
        if (!closed) controller.error(error);
        cleanup();
      });
    },
    cancel() { cancelStream?.(); },
  }, { highWaterMark: 64 });
}
