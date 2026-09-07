import { describe, expect, test } from "bun:test";
import {
  WireClient,
  encodeSnapshotBundle,
  encodeWireObject,
  hashObject,
} from "@arbor/wire";

function snapshotResponse(delays: readonly number[]) {
  const object = encodeWireObject({ type: "file", bytes: new TextEncoder().encode("slow snapshot\n") });
  const root = hashObject(object);
  const body = encodeSnapshotBundle({ root, objects: new Map([[root, object]]) });
  const chunkSize = Math.ceil(body.byteLength / delays.length);
  const server = Bun.serve({
    port: 0,
    fetch() {
      let offset = 0;
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          const send = (index: number) => {
            if (offset >= body.byteLength) {
              try { controller.close(); } catch {}
              return;
            }
            const next = Math.min(offset + chunkSize, body.byteLength);
            controller.enqueue(body.slice(offset, next));
            offset = next;
            setTimeout(() => send(index + 1), delays[index] ?? 0);
          };
          send(0);
        },
        cancel() {
          offset = body.byteLength;
        },
      }), { headers: { "content-type": "application/cbor" } });
    },
  });
  return { server, root };
}

describe("Wire snapshot transfer", () => {
  test("uses an inactivity deadline rather than aborting a transfer that keeps progressing", async () => {
    const { server, root } = snapshotResponse([25, 25, 25, 25, 25]);
    try {
      const started = performance.now();
      const snapshot = await new WireClient(`http://127.0.0.1:${server.port}`, undefined, { timeoutMs: 40 })
        .snapshot("tr_slow", root);
      expect(snapshot.root).toBe(root);
      expect(performance.now() - started).toBeGreaterThan(80);
    } finally {
      server.stop(true);
    }
  });

  test("still fails when a snapshot body stops making progress", async () => {
    const { server, root } = snapshotResponse([100]);
    try {
      await expect(new WireClient(`http://127.0.0.1:${server.port}`, undefined, { timeoutMs: 30 })
        .snapshot("tr_stalled", root)).rejects.toThrow("stopped making progress");
    } finally {
      server.stop(true);
    }
  });
});
