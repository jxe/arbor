import type {
  MutationCallRequest,
  MutationCallRuntime,
  QueryStreamEvent,
  QueryStreamRequest,
  QueryStreamRuntime,
} from "@arbor/core";
import { encodeSSEFrame } from "@arbor/core";

/** Stateless full-POST query execution encoded as a standard SSE response. */
export function queryStreamResponse(
  runtime: QueryStreamRuntime,
  input: QueryStreamRequest,
  signal: AbortSignal,
  user: { profile: string } | null,
): Promise<Response> | Response {
  const encoder = new TextEncoder();
  const response = (events: ReadableStream<QueryStreamEvent>) => new Response(events.pipeThrough(new TransformStream({
    transform(event, controller) {
      const { type, ...data } = event;
      controller.enqueue(encoder.encode(encodeSSEFrame({ event: type, data })));
    },
  })), {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
  const events = runtime.stream(input, { signal, user });
  return events instanceof Promise ? events.then(response) : response(events);
}

function invalidRequest(error: unknown, fallback: string, tree: string): Response {
  return Response.json({
    error: "invalid-request",
    message: error instanceof Error ? error.message : fallback,
    retryable: false,
    tree,
  }, { status: 400, headers: { "cache-control": "no-store" } });
}

export async function treeQueryResponse(
  runtime: QueryStreamRuntime,
  request: Request,
  tree: string,
  user: { profile: string } | null,
): Promise<Response> {
  try {
    const input = await request.json() as QueryStreamRequest;
    if (input.document.tree !== tree || input.queries.some((query) => query.handle.tree !== tree)) {
      throw new Error("The route tree must own the document and every query handle");
    }
    return await queryStreamResponse(runtime, input, request.signal, user);
  } catch (error) {
    return invalidRequest(error, "Invalid query stream request", tree);
  }
}

export async function treeMutationResponse(
  runtime: MutationCallRuntime,
  request: Request,
  tree: string,
  user: { profile: string } | null,
): Promise<Response> {
  try {
    const input = await request.json() as MutationCallRequest;
    if (input.document.tree !== tree || input.handle.tree !== tree) {
      throw new Error("The route tree must own the document and mutation handle");
    }
    return Response.json(await runtime.call(input, { user }), {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return invalidRequest(error, "Invalid mutation request", tree);
  }
}
