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

/** 403 with `details.homeHost`: the route reads or edits a profile's own
 * configuration (its devices, pairing, recovery), which a placement account
 * does not have here; the home host holds it (accounts §1.3). */
export class PlacementAccountError extends Error {
  override readonly name = "PlacementAccountError";
  constructor(readonly homeHost: string, message: string) {
    super(message);
  }
}

/** 503, retryable, with `details.homeHost`: a placement host's copy of a
 * profile's device keys is too old and the home host cannot be read, so it
 * opens no session (accounts §5.4). */
export class HomeHostUnavailableError extends Error {
  override readonly name = "HomeHostUnavailableError";
  constructor(readonly homeHost: string, message: string) {
    super(message);
  }
}

/** 409 `already-claimed`: the handle, or with a null handle the profile,
 * already has an account or a tree here. */
export class AlreadyClaimedError extends Error {
  override readonly name = "AlreadyClaimedError";
  constructor(readonly handle: string | null) {
    super(handle ? `Profile ~${handle} is already claimed` : "This profile is already claimed or hosted on this Canopy");
  }
}

/** 409 `conflict` with `details.current`: a tree's ref moved under a
 * server-side rewrite. */
export class RefConflictError extends Error {
  override readonly name = "RefConflictError";
  constructor(readonly current: string | null) {
    super("Tree ref changed");
  }
}

/** An update the protocol refuses: `base-not-retained` is a retryable 409
 * `resync-required`, `unsupported-operation` a 422, and
 * `activation-conflict` a 409 `conflict`. */
export class UpdateProtocolError extends Error {
  override readonly name = "UpdateProtocolError";
  constructor(readonly code: "base-not-retained" | "activation-conflict" | "unsupported-operation", message: string) {
    super(message);
  }
}

/** 409 `conflict` naming the tree and path: an update would move or remove
 * a canonical boundary. */
export class ReservedBoundaryConflictError extends Error {
  override readonly name = "ReservedBoundaryConflictError";
  constructor(readonly path: string, readonly tree: string) {
    super(`Canonical boundary must remain mounted at ${path}`);
  }
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
