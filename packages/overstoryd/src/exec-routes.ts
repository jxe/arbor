// The `/queries` and `/mutate` routes' HTTP side: a query stream as SSE, a
// mutation's receipt as JSON, and refusals and an unavailable sidecar as the
// errors a client can act on.

import { encodeSSEFrame, type MutationCallRequest, type MutationCallRuntime, type QueryStreamEvent, type QueryStreamRequest, type QueryStreamRuntime } from "@ovst/protocol";
import { ExecRefusal } from "./collections.ts";
import { ExecUnavailableError } from "./exec-process.ts";

function failed(error: unknown, fallback: string, tree: string): Response {
  const headers = { "cache-control": "no-store" };
  if (error instanceof ExecUnavailableError) {
    return Response.json({ error: "internal-error", message: "Queries and mutations are unavailable for now", retryable: true, tree }, { status: 503, headers });
  }
  if (error instanceof ExecRefusal) return Response.json({ error: error.value.code, message: error.value.message, retryable: error.value.retryable, tree }, { status: 400, headers });
  return Response.json({ error: "invalid-request", message: error instanceof Error ? error.message : fallback, retryable: false, tree }, { status: 400, headers });
}

export async function treeQueryResponse(runtime: QueryStreamRuntime, request: Request, tree: string, user: { profile: string } | null): Promise<Response> {
  try {
    const input = await request.json() as QueryStreamRequest;
    if (input.document.tree !== tree || input.queries.some((query) => query.handle.tree !== tree)) {
      throw new Error("The route tree must own the document and every query handle");
    }
    const encoder = new TextEncoder();
    const events: ReadableStream<QueryStreamEvent> = await runtime.stream(input, { signal: request.signal, user });
    return new Response(events.pipeThrough(new TransformStream<QueryStreamEvent, Uint8Array>({
      transform(event, controller) {
        const { type, ...data } = event;
        controller.enqueue(encoder.encode(encodeSSEFrame({ event: type, data })));
      },
    })), {
      headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" },
    });
  } catch (error) {
    return failed(error, "Invalid query stream request", tree);
  }
}

export async function treeMutationResponse(
  runtime: MutationCallRuntime,
  request: Request,
  tree: string,
  user: { profile: string } | null,
  /** More of the call's context, for a runtime that uses it (the host passes its caller). */
  context: Record<string, unknown> = {},
): Promise<Response> {
  try {
    const input = await request.json() as MutationCallRequest;
    if (input.document.tree !== tree || input.handle.tree !== tree) {
      throw new Error("The route tree must own the document and mutation handle");
    }
    return Response.json(await runtime.call(input, { ...context, user }), { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return failed(error, "Invalid mutation request", tree);
  }
}
