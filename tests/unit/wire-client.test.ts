import { describe, expect, test } from "bun:test";
import {
  WireClient,
  encodeSnapshotBundle,
  encodeWireDirectory,
  hashObject,
} from "@arbor/wire";

function snapshotResponse(delays: readonly number[]) {
  const object = new TextEncoder().encode("slow snapshot\n");
  const fileHash = hashObject(object);
  const directory = encodeWireDirectory({ type: "directory", entries: [{ name: "payload.bin", file: fileHash }] });
  const root = hashObject(directory);
  const body = encodeSnapshotBundle({ root, objects: new Map([[root, directory], [fileHash, object]]) });
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

describe("Wire alternative material", () => {
  test("pins authorization to state, decision and alternative and verifies exact bytes", async () => {
    const bytes = new TextEncoder().encode("Hidden alternative\r\n  exact spaces  \r\n");
    const hash = hashObject(bytes);
    const urls: URL[] = [];
    let corrupt = false;
    const server = Bun.serve({ port: 0, fetch(request) {
      urls.push(new URL(request.url));
      expect(request.headers.get("authorization")).toBe("Bearer review-test");
      return new Response(corrupt ? new TextEncoder().encode("changed") : bytes);
    } });
    try {
      const client = new WireClient(`http://127.0.0.1:${server.port}`, "review-test");
      expect(await client.conflictObject("tr_review", "state with spaces", "decision", "alternative", hash)).toEqual(bytes);
      expect(urls[0]!.pathname).toBe(`/.arbor/trees/tr_review/conflicts/decision/alternatives/alternative/objects/${hash}`);
      expect(urls[0]!.searchParams.get("state")).toBe("state with spaces");
      corrupt = true;
      await expect(client.conflictObject("tr_review", "state", "decision", "alternative", hash)).rejects.toThrow("hash mismatch");
    } finally { server.stop(true); }
  });
});
