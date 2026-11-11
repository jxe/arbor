// The `/views` and `/mutate` routes' HTTP side: a view stream as SSE, a
// mutation's receipt as JSON, and refusals and an unavailable sidecar as the
// errors a client can act on.

import { encodeSSEFrame, type MutationCallRequest, type MutationCallRuntime, type ViewEvent, type ViewsRequest, type ViewsRuntime } from "@ovst/protocol";
import { ExecRefusal } from "./collections.ts";
import { ExecUnavailableError } from "./exec-process.ts";

function failed(error: unknown, fallback: string, tree: string): Response {
  const headers = { "cache-control": "no-store" };
  if (error instanceof ExecUnavailableError) {
    return Response.json({ error: "internal-error", message: "Views and mutations are unavailable for now", retryable: true, tree }, { status: 503, headers });
  }
  if (error instanceof ExecRefusal) return Response.json({ error: error.value.code, message: error.value.message, retryable: error.value.retryable, tree }, { status: 400, headers });
  return Response.json({ error: "invalid-request", message: error instanceof Error ? error.message : fallback, retryable: false, tree }, { status: 400, headers });
}

export async function treeViewsResponse(
  runtime: ViewsRuntime,
  request: Request,
  tree: string,
  user: { profile: string } | null,
  /** More of the stream's context, for a runtime that uses it (the host passes its caller). */
  context: Record<string, unknown> = {},
): Promise<Response> {
  try {
    const input = await request.json() as ViewsRequest;
    // No document: each handle carries its tree, path and version (07 §12.1).
    if (!input || typeof input !== "object" || Object.hasOwn(input, "document") || !Array.isArray(input.views) || input.views.length === 0
      || input.views.some((view) => view?.handle?.tree !== tree)) {
      throw new Error("The route tree must own every view handle");
    }
    const encoder = new TextEncoder();
    const events: ReadableStream<ViewEvent> = await runtime.stream(input, { ...context, signal: request.signal, user });
    return new Response(events.pipeThrough(new TransformStream<ViewEvent, Uint8Array>({
      transform(event, controller) {
        const { type, ...data } = event;
        controller.enqueue(encoder.encode(encodeSSEFrame({ event: type, data })));
      },
    })), {
      // User- and access-dependent and long-lived (07 §12.1).
      headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive" },
    });
  } catch (error) {
    return failed(error, "Invalid views request", tree);
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
    if (!input || typeof input !== "object" || Object.hasOwn(input, "document") || input.handle?.tree !== tree) {
      throw new Error("The route tree must own the mutation handle");
    }
    return Response.json(await runtime.call(input, { ...context, user }), { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return failed(error, "Invalid mutation request", tree);
  }
}
