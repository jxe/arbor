import type { ArbordErrorCode } from "@arbor/core";
import { FsConflictError } from "@arbor/fs";

export function fsErrorCode(error: FsConflictError): { code: ArbordErrorCode; status: number; retryable?: boolean } {
  switch (error.details.code) {
    case "stale-revision": return { code: "stale-content-revision", status: 409 };
    case "missing-insertion-anchor": return { code: "missing-insertion-anchor", status: 409 };
    case "occupied-destination": return { code: "occupied-destination", status: 409 };
    case "duplicate-body": return { code: "duplicate-body-representation", status: 409 };
    case "unsafe-path":
    case "recursive-move": return { code: "unsafe-path", status: 400 };
    case "not-found": return { code: "not-found", status: 404 };
    case "read-only": return { code: "read-only", status: 422 };
    case "offline": return { code: "not-materialized", status: 409, retryable: true };
    default: return { code: "invalid-reference", status: 400 };
  }
}
