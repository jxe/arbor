/** Errors whose HTTP status the host maps by type. A server fault or a
 * storage system error is a logged 500; anything else a request handler
 * throws is an invalid request (400). */

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

/** 500: canopyd's own state or a component it trusts broke an invariant.
 * Nothing the client sent can cause it. */
export class ServerFaultError extends Error {
  override readonly name = "ServerFaultError";
}

/** Whether an error is canopyd's fault rather than the request's: a declared
 * fault, or a failed system call (Node's errno errors carry `syscall`) other
 * than ENOENT, which is how a request naming an absent object fails. */
export function isServerFault(error: unknown): boolean {
  if (error instanceof ServerFaultError) return true;
  const system = error as NodeJS.ErrnoException | null;
  return error instanceof Error && typeof system?.syscall === "string" && system.code !== "ENOENT";
}
