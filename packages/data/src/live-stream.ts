import { semanticRequestDigest, type Hash, type QueryStreamEvent } from "@arbor/core";
import type { ArborUser, QueryHandle } from "./authoring.ts";

export interface MountedQuery {
  id: string;
  tree?: string;
  handle: QueryHandle<unknown, unknown>;
  input?: unknown;
  knownOutputHash?: Hash;
}

export type QueryStreamError = Extract<QueryStreamEvent, { error: unknown }>["error"];

export interface LiveQueryContext {
  signal: AbortSignal;
  user: ArborUser | null;
}

/**
 * Backing-specific half of a live query: how to evaluate a mount, what it is
 * sensitive to, and which observed events are relevant to it. The shared
 * stream owns the race-free snapshot-then-follow state machine.
 */
export interface LiveQueryAdapter<Execution, Sensitivity, Event> {
  currentCursor(): string;
  subscribe(listener: (event: Event) => void): () => void;
  /** Sensitivity derivable before the first evaluation (for example from the plan). */
  initialSensitivity?(mount: MountedQuery): Sensitivity;
  execute(mount: MountedQuery): Promise<Execution>;
  sensitivity(mount: MountedQuery, execution: Execution): Sensitivity;
  relevant(event: Event, mount: MountedQuery, sensitivity: Sensitivity | undefined, execution: Execution | undefined): boolean;
  result(execution: Execution): unknown;
  safeError(error: unknown): QueryStreamError;
  /** When an event demands a complete reload, its reason; the stream then closes. */
  reload?(event: Event): "source-changed" | "access-changed" | undefined;
}

export function outputHash(value: unknown): Hash {
  return semanticRequestDigest(value);
}

/**
 * Race-free live evaluation shared by every backing: the listener is attached
 * before the initial snapshot, events racing an evaluation are checked against
 * both the former and the new sensitivities, identical output hashes publish
 * nothing, and `ready` follows every established snapshot boundary.
 */
export function liveQueryStream<Execution, Sensitivity, Event>(
  mounts: readonly MountedQuery[],
  context: LiveQueryContext,
  adapter: LiveQueryAdapter<Execution, Sensitivity, Event>,
): ReadableStream<QueryStreamEvent> {
  let cancelStream: (() => void) | undefined;
  return new ReadableStream<QueryStreamEvent>({
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
        cursor: adapter.currentCursor(),
      }));
      type State = typeof states[number];
      const closeStream = () => { try { controller.close(); } catch {} };
      const emit = (event: QueryStreamEvent) => {
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
              state.cursor = adapter.currentCursor();
              emit({ type: "result", id: state.mount.id, observedThrough: state.cursor, error: adapter.safeError(error) });
              return;
            }
            const invalidated = state.pending.some((event) =>
              adapter.relevant(event, state.mount, oldSensitivity, oldExecution)
              || adapter.relevant(event, state.mount, sensitivity, execution));
            if (invalidated) continue;
            state.execution = execution;
            state.sensitivity = sensitivity;
            state.cursor = adapter.currentCursor();
            const hash = outputHash(adapter.result(execution));
            if (publish && hash !== state.hash) {
              emit({ type: "result", id: state.mount.id, observedThrough: state.cursor, outputHash: hash, value: adapter.result(execution) });
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
            emit({ type: "result", id: state.mount.id, observedThrough: state.cursor, outputHash: state.hash, value: adapter.result(state.execution) });
          }
        }
        ready = true;
        emit({ type: "ready", queries: states.map((state) => ({
          id: state.mount.id,
          observedThrough: state.cursor,
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
