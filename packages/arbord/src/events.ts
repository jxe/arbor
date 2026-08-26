import type { EventCursor, WorkspaceChange, WorkspaceEvent } from "@arbor/core";

export class ResyncRequiredError extends Error {
  constructor(public cursor: string) {
    super("The event cursor is no longer available; visible state must be refetched");
    this.name = "ResyncRequiredError";
  }
}

function cursorOf(epoch: string, sequence: number): EventCursor {
  return `${epoch}:${sequence}`;
}

function parseCursor(cursor: string): { epoch: string; sequence: number } | null {
  const separator = cursor.lastIndexOf(":");
  if (separator <= 0) return null;
  const sequence = Number(cursor.slice(separator + 1));
  if (!Number.isSafeInteger(sequence) || sequence < 0) return null;
  return { epoch: cursor.slice(0, separator), sequence };
}

export class EventBus {
  readonly epoch = crypto.randomUUID();
  private sequence = 0;
  private replay: WorkspaceEvent[] = [];
  private listeners = new Set<(event: WorkspaceEvent) => void>();

  constructor(private replayLimit = 1_024) {}

  currentCursor(): EventCursor {
    return cursorOf(this.epoch, this.sequence);
  }

  emit(event: { tree: WorkspaceEvent["tree"]; kind: WorkspaceEvent["kind"] } & WorkspaceChange): WorkspaceEvent {
    const { tree, kind, ...change } = event;
    const sequenced: WorkspaceEvent = { tree, kind, change, cursor: cursorOf(this.epoch, ++this.sequence) };
    this.replay.push(sequenced);
    if (this.replay.length > this.replayLimit) this.replay.splice(0, this.replay.length - this.replayLimit);
    for (const listener of this.listeners) listener(sequenced);
    return sequenced;
  }

  validate(after?: string | null): number {
    if (!after) return this.sequence;
    const parsed = parseCursor(after);
    const oldest = this.replay[0] ? parseCursor(this.replay[0].cursor)!.sequence : this.sequence + 1;
    if (
      !parsed
      || parsed.epoch !== this.epoch
      || parsed.sequence > this.sequence
      || parsed.sequence < oldest - 1
    ) throw new ResyncRequiredError(after);
    return parsed.sequence;
  }

  stream(after?: string | null, signal?: AbortSignal): ReadableStream<Uint8Array> {
    const sequence = this.validate(after);
    const encoder = new TextEncoder();
    let listener: ((event: WorkspaceEvent) => void) | undefined;
    return new ReadableStream({
      start: (controller) => {
        const enqueue = (event: WorkspaceEvent) => {
          controller.enqueue(encoder.encode(
            `id: ${event.cursor}\nevent: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`,
          ));
        };
        for (const event of this.replay) {
          const parsed = parseCursor(event.cursor)!;
          if (parsed.sequence > sequence) enqueue(event);
        }
        const activeListener = (event: WorkspaceEvent) => enqueue(event);
        listener = activeListener;
        this.listeners.add(activeListener);
        controller.enqueue(encoder.encode(": connected\n\n"));
        signal?.addEventListener("abort", () => {
          this.listeners.delete(activeListener);
          try { controller.close(); } catch {}
        }, { once: true });
      },
      cancel: () => {
        if (listener) this.listeners.delete(listener);
      },
    });
  }
}
