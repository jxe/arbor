import type { ArborEvent } from "@arbor/core";

export class EventBus {
  private seq = 0;
  private listeners = new Set<(event: ArborEvent) => void>();

  emit(event: Omit<ArborEvent, "seq">): ArborEvent {
    const sequenced = { ...event, seq: ++this.seq };
    for (const listener of this.listeners) listener(sequenced);
    return sequenced;
  }

  stream(signal?: AbortSignal): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    return new ReadableStream({
      start: (controller) => {
        const listener = (event: ArborEvent) => controller.enqueue(encoder.encode(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
        this.listeners.add(listener);
        controller.enqueue(encoder.encode(": connected\n\n"));
        signal?.addEventListener("abort", () => { this.listeners.delete(listener); controller.close(); }, { once: true });
      },
    });
  }
}
