import {
  decodePathReadPath,
  encodeAcceptedWatchChange,
  encodePathReadBundle,
  encodePathReadPath,
  encodeSnapshotBundle,
  encodeSSEFrame,
  ProtocolError,
  type ObjectHash,
} from "@ovst/protocol";
import { json } from "./http.ts";
import type { StorySyncDaemon } from "./service.ts";

type ReadHTTPService = Pick<StorySyncDaemon, "acceptedTree" | "snapshot" | "pathRead" | "objectBytes" | "entryMetadata" | "hostClient">;

const TREE = "([^/]+)";
const HASH = "(sha256:[a-f0-9]{64})";
const routes = {
  descriptor: new RegExp(`^/\\.overstory/trees/${TREE}$`),
  snapshot: new RegExp(`^/\\.overstory/trees/${TREE}/snapshots/${HASH}$`),
  path: new RegExp(`^/\\.overstory/trees/${TREE}/snapshots/${HASH}/path(/.*)?$`),
  object: new RegExp(`^/\\.overstory/trees/${TREE}/objects/${HASH}$`),
  metadata: new RegExp(`^/\\.overstory/trees/${TREE}/entry-metadata$`),
  watch: new RegExp(`^/\\.overstory/trees/${TREE}/watch$`),
};

/** Immutable bodies: content-addressed, private to this data home's caller. */
function immutable(contentType: string, etag: string): HeadersInit {
  return { "content-type": contentType, "cache-control": "private, immutable, max-age=31536000", etag: `"${etag}"` };
}

/**
 * Story Sync serves the standard Overstory read routes for the trees placed
 * on this device (Clients 003 step 2): the current tree is the daemon's
 * recorded accepted base, and objects come from the folder's index, the
 * pending changes, or the host, each verified by hash. Code written for
 * overstoryd reads through Story Sync with the same client. Writes and
 * presence still go to the host; the watch here is the host's, passed through.
 *
 * Only a caller holding the data home's token gets here (data-home.md).
 */
export function readHandler(service: ReadHTTPService) {
  return async (request: Request, url: URL, server: { timeout(request: Request, seconds: number): void }): Promise<Response | undefined> => {
    if (!url.pathname.startsWith("/.overstory/trees/")) return undefined;
    if (request.method !== "GET") throw new ProtocolError("invalid-request", "Story Sync serves only reads of placed trees", 405);
    let match: RegExpExecArray | null;
    if ((match = routes.descriptor.exec(url.pathname))) {
      return json(await service.acceptedTree(decodeURIComponent(match[1]!)));
    }
    if ((match = routes.snapshot.exec(url.pathname))) {
      const root = match[2] as ObjectHash;
      const tree = decodeURIComponent(match[1]!);
      // Entry times are the host's acceptance times (§1.1.2a): a timed read
      // is the host's, checked by the client and passed on.
      if (url.searchParams.has("times")) {
        const { snapshot, times } = await (await service.hostClient(tree)).timedSnapshot(tree, root);
        return new Response(encodeSnapshotBundle(snapshot, times) as Uint8Array<ArrayBuffer>, { headers: immutable("application/cbor", `${root};times`) });
      }
      const snapshot = await service.snapshot(tree, root);
      return new Response(encodeSnapshotBundle(snapshot) as Uint8Array<ArrayBuffer>, { headers: immutable("application/cbor", root) });
    }
    if ((match = routes.path.exec(url.pathname))) {
      const root = match[2] as ObjectHash;
      let path: string;
      try { path = decodePathReadPath(match[3] ?? "/"); }
      catch { throw new ProtocolError("invalid-request", "The path is not a valid logical path", 400); }
      const tree = decodeURIComponent(match[1]!);
      if (url.searchParams.has("times")) {
        const { objects, times } = await (await service.hostClient(tree)).timedPathRead(tree, root, path);
        return new Response(encodePathReadBundle(objects, times) as Uint8Array<ArrayBuffer>, { headers: immutable("application/cbor", `${root}${encodePathReadPath(path)};times`) });
      }
      const objects = await service.pathRead(tree, root, path);
      return new Response(encodePathReadBundle(objects) as Uint8Array<ArrayBuffer>, { headers: immutable("application/cbor", `${root}${encodePathReadPath(path)}`) });
    }
    if ((match = routes.object.exec(url.pathname))) {
      const tree = decodeURIComponent(match[1]!);
      const hash = match[2] as ObjectHash;
      const bytes = await service.objectBytes(tree, hash);
      if (!bytes) throw new ProtocolError("not-found", `Object is not available: ${hash}`, 404, { tree });
      return new Response(Buffer.from(bytes), {
        headers: { ...immutable("application/octet-stream", hash), "content-length": String(bytes.byteLength) },
      });
    }
    if ((match = routes.metadata.exec(url.pathname))) {
      return json(await service.entryMetadata(decodeURIComponent(match[1]!)));
    }
    if ((match = routes.watch.exec(url.pathname))) {
      const tree = decodeURIComponent(match[1]!);
      const objects = url.searchParams.get("objects");
      if (objects !== null && objects !== "none") throw new ProtocolError("invalid-request", "objects must be none when present", 400);
      const client = await service.hostClient(tree);
      const after = url.searchParams.get("after");
      server.timeout(request, 0);
      const encoder = new TextEncoder();
      const abort = new AbortController();
      request.signal.addEventListener("abort", () => abort.abort(), { once: true });
      let opened!: () => void;
      let failed!: (error: unknown) => void;
      const open = new Promise<void>((resolve, reject) => { opened = resolve; failed = reject; });
      const events = client.watch(tree, after, { signal: abort.signal, onOpen: () => opened(), ...(objects === "none" ? { objects: "none" as const } : {}) });
      // The first frame is asked for now: the host's refusal (401, 404) is this
      // route's answer, not a stream that ends at once.
      let pending: ReturnType<typeof events.next> | undefined = events.next();
      pending.catch(failed);
      await open;
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(encoder.encode(": ready\n\n")); },
        async pull(controller) {
          try {
            const step = await (pending ?? events.next());
            pending = undefined;
            if (step.done) return controller.close();
            const event = step.value;
            if (event.kind === "resync-required") {
              controller.enqueue(encoder.encode(encodeSSEFrame({ event: "resync-required", data: { reason: event.reason } })));
              return controller.close();
            }
            controller.enqueue(encoder.encode(encodeSSEFrame({
              id: event.cursor,
              event: "tree.update",
              data: encodeAcceptedWatchChange({ transition: event.transition, access: event.access, canonical: event.canonical }),
            })));
          } catch (error) {
            if (abort.signal.aborted) return controller.close();
            controller.error(error);
          }
        },
        cancel() { abort.abort(); },
      }), { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" } });
    }
    throw new ProtocolError("not-found", "Not a read route Story Sync serves", 404);
  };
}
