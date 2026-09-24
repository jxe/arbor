import { isCloudPlaceholderError } from "./cloud-placeholders.ts";
import { WireHTTPError, WireTransportError, type ObjectHash } from "@overstory/protocol";

/** Local operational evidence, not a Wire response or retained user content. */
export interface ObjectReadDiagnostic {
  source: "filesystem" | "workspace" | "pending" | "canopy-client" | "canopy";
  reason: "missing" | "permission-denied" | "unauthenticated" | "cloud-placeholder" | "io-error" | "network-error" | "http-error" | "hash-mismatch" | "invalid-data";
  hash?: ObjectHash;
  tree?: string;
  path?: string;
  code?: string;
  status?: number;
}

export type ObjectReadReporter = (diagnostic: ObjectReadDiagnostic) => void;

export function objectReadError(
  context: Omit<ObjectReadDiagnostic, "reason" | "code" | "status">,
  error: unknown,
): ObjectReadDiagnostic {
  if (error instanceof WireHTTPError) {
    const status = error.status;
    return { ...context, reason: status === 404 ? "missing" : status === 401 ? "unauthenticated" : status === 403 ? "permission-denied" : "http-error", status };
  }
  if (error instanceof WireTransportError) return { ...context, reason: "network-error" };
  const value = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  // Keep error text, response bodies, URLs and credentials out of diagnostics.
  const code = typeof value === "string" && /^[A-Z][A-Z0-9_]{0,39}$/.test(value) ? value : undefined;
  return {
    ...context,
    reason: code === "ENOENT" || code === "ENOTDIR" ? "missing"
      : code === "EACCES" || code === "EPERM" ? "permission-denied"
      // An evicted cloud file this process could not download; retried on the next sync.
      : isCloudPlaceholderError(error) ? "cloud-placeholder"
      : "io-error",
    ...(code ? { code } : {}),
  };
}

export const reportObjectRead: ObjectReadReporter = (diagnostic) => {
  // A file moving on or an uncached historical hash is an ordinary fallback.
  if (diagnostic.reason !== "missing") console.warn("[arborsync:object-read]", JSON.stringify(diagnostic));
};
