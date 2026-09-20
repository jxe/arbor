import type { ArborErrorCode, ArborError } from "@overstory/protocol";
import { ProtocolError } from "@overstory/protocol";

export function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

export function errorResponse(
  code: ArborErrorCode,
  message: string,
  status: number,
  details: Partial<Omit<ArborError, "error" | "message">> = {},
): Response {
  const normalized = (() => {
    switch (code) {
      case "invalid-reference":
      case "unsafe-path":
      case "duplicate-body-representation": return "invalid-request";
      case "credential-unavailable": return "unauthenticated";
      case "not-materialized": return "not-found";
      case "reserved-boundary":
      case "duplicate-page-id":
      case "stale-content-revision":
      case "stale-properties-revision":
      case "stale-directory-revision":
      case "occupied-destination":
      case "mutation-mismatch": return "conflict";
      default: return code;
    }
  })();
  const { retryable = false, tree, path, details: typedDetails } = details;
  const normalizedDetails = normalized === "conflict" && normalized !== code
    ? { kind: "workspace-revision", reason: code, ...(typeof typedDetails === "object" && typedDetails !== null ? typedDetails : {}) }
    : typedDetails;
  return json({
    error: normalized,
    message,
    retryable,
    ...(tree ? { tree } : {}),
    ...(path ? { path } : {}),
    ...(normalizedDetails === undefined ? {} : { details: normalizedDetails }),
  } satisfies ArborError, status);
}

export function assertSameOrigin(request: Request, url: URL): void {
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost" && url.hostname !== "[::1]") {
    throw new ProtocolError("invalid-request", "Arbor Sync accepts only loopback Host headers", 400, { path: url.pathname });
  }
  if (request.method === "GET" || request.method === "HEAD") return;
  const origin = request.headers.get("origin");
  if (origin && origin !== url.origin) {
    throw new ProtocolError("invalid-request", "Cross-origin requests are not allowed", 400, { path: url.pathname });
  }
}

