import { SQLiteError } from "bun:sqlite";

/** Errors whose HTTP status the host maps by type. A server fault, a database
 * error or a storage system error is a logged 500; a full host resource is a
 * retryable 503; anything else a request
 * handler throws is an invalid request (400). */

/** 401: the route needs an authenticated account or device. */
export class AuthenticationRequiredError extends Error {
  override readonly name = "AuthenticationRequiredError";
}

/** 403: the caller is known but may not do this. */
export class PermissionDeniedError extends Error {
  override readonly name = "PermissionDeniedError";
}

/** 404: the named resource does not exist (or is not disclosed). */
export class NotFoundError extends Error {
  override readonly name = "NotFoundError";
}

/** 400 with `details.challenge: "expired"`: a signed challenge outlived its
 * window; the client asks for a fresh one and signs again. */
export class ExpiredChallengeError extends Error {
  override readonly name = "ExpiredChallengeError";
}

/** 503, retryable: a bounded host resource is full; nothing is wrong with the
 * request or with canopyd's state. */
export class ServerBusyError extends Error {
  override readonly name = "ServerBusyError";
}

/** 500: canopyd's own state or a component it trusts broke an invariant.
 * Nothing the client sent can cause it. */
export class ServerFaultError extends Error {
  override readonly name = "ServerFaultError";
}

/** Whether an error is canopyd's fault rather than the request's: a declared
 * fault, a database error (a constraint violation or SQLITE_BUSY, whose SQL
 * text must not reach the client), or a failed system call (Node's errno
 * errors carry `syscall`) other than ENOENT, which is how a request naming an
 * absent object fails. */
export function isServerFault(error: unknown): boolean {
  if (error instanceof ServerFaultError || error instanceof SQLiteError) return true;
  const system = error as NodeJS.ErrnoException | null;
  return error instanceof Error && typeof system?.syscall === "string" && system.code !== "ENOENT";
}
