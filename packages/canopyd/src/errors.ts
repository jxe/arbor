/** Errors whose HTTP status the host maps by type. Anything else a request
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
