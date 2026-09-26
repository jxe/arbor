import { AsyncLocalStorage } from "node:async_hooks";
import { PermissionDeniedError } from "./errors.ts";
import { randomBytes } from "node:crypto";
import {
  ACCESS_OPERATIONS,
  isTreeID,
  operationAllowed,
  resourcePath,
  scopeContains,
  type AccessOperation,
  type ResourceCapability,
} from "@overstory/protocol";
/**
 * One capability an execution uses. `lender` is null for the caller's own
 * access (or a tree's own `app` rule); otherwise it names the profile whose
 * `apps.yaml` lends it. A grant from one lender never widens another's.
 */
export interface ExecutionGrant extends ResourceCapability {
  lender: string | null;
}
export interface ExecutionContext {
  code: string;
  version: string;
  /** The caller's account (its profile TreeID), or null for an anonymous caller. */
  caller: string | null;
  linkDigest?: string;
  subject: string;
  expiresAt: number;
  grants: readonly ExecutionGrant[];
  /** Host callback binds credential/session/activation validity; never supplied over HTTP. */
  active: () => boolean;
}
/** Host-private token registry: restart invalidates tokens; durable receipts use stable subjects. */
export class ExecutionAuthority {
  private readonly local = new AsyncLocalStorage<ExecutionContext>();
  private readonly revoked = new WeakSet<ExecutionContext>();
  private readonly tokens = new Map<string, ExecutionContext>();
  constructor(
    private readonly permits: (
      context: ExecutionContext,
      grant: ExecutionGrant,
      path: string,
      operation: AccessOperation
    ) => boolean
  ) {}
  private readonly listeners = new Set<() => void>();
  private invalidations = 0;
  /** Advances on every invalidation, before listeners run. */
  get epoch(): number {
    return this.invalidations;
  }
  invalidate(): void {
    this.invalidations++;
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        this.listeners.delete(listener);
      }
    }
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  covered(context: ExecutionContext): boolean {
    return (
      this.valid(context) &&
      context.grants.every((g) =>
        g.allow.every((op) => this.permits(context, g, g.within, op))
      )
    );
  }
  get current(): ExecutionContext | undefined {
    return this.local.getStore();
  }
  valid(context: ExecutionContext): boolean {
    return (
      !this.revoked.has(context) &&
      context.expiresAt > Date.now() &&
      context.active()
    );
  }
  issue(context: ExecutionContext): string {
    if (
      !Number.isFinite(context.expiresAt) ||
      !this.valid(context) ||
      !context.code ||
      !context.version ||
      !context.subject
    )
      throw new PermissionDeniedError("Execution permission is not allowed");
    const copy = {
      ...context,
      grants: context.grants.map((g) => ({ ...g, allow: [...g.allow] })),
    };
    for (const grant of copy.grants) {
      resourcePath(grant.within);
      if (!isTreeID(copy.code) || !isTreeID(grant.tree) || grant.allow.some((op) => !ACCESS_OPERATIONS.includes(op)))
        throw new Error("Invalid execution grant");
      if (grant.lender !== null && !isTreeID(grant.lender))
        throw new Error("Invalid execution grant provenance");
      if (
        !grant.allow.length ||
        grant.allow.some((op) => !this.permits(copy, grant, grant.within, op))
      )
        throw new PermissionDeniedError("Execution permission is not allowed");
      Object.freeze(grant.allow);
      Object.freeze(grant);
    }
    Object.freeze(copy.grants);
    Object.freeze(copy);
    for (const [key, value] of this.tokens)
      if (!this.valid(value)) this.tokens.delete(key);
    if (this.tokens.size >= 4096)
      throw new Error("Execution token capacity exceeded");
    const token = `execution_${randomBytes(32).toString("base64url")}`;
    this.tokens.set(token, copy);
    return token;
  }
  revoke(token: string): void {
    const context = this.tokens.get(token);
    if (context) this.revoked.add(context);
    this.tokens.delete(token);
    this.invalidate();
  }
  resolve(token: string): ExecutionContext | undefined {
    const context = this.tokens.get(token);
    return context && this.valid(context) ? context : undefined;
  }
  run<T>(context: ExecutionContext | undefined, operation: () => T): T {
    return this.local.run(context as ExecutionContext, operation);
  }
  /** One operation, with the context's coverage checked again. A caller
   * checking several effects checks `covered` once, then each with `granted`. */
  allows(
    tree: string,
    path: string,
    operation: AccessOperation,
    context = this.current
  ): boolean {
    return !!context && this.covered(context) && this.granted(tree, path, operation, context);
  }
  /**
   * Whether a grant of a context the caller has just found `covered` names
   * this operation. Coverage already asked `permits` for every operation of
   * every grant at the grant's scope, and a permission at a scope holds at
   * every path within it (rules match by scope containment; the ordinary
   * read/write decisions are whole-tree), as a `write` grant's holds for every
   * operation it implies (`write` permits whatever `read` or any other
   * operation does). So only the grants themselves remain to be matched.
   */
  granted(
    tree: string,
    path: string,
    operation: AccessOperation,
    context: ExecutionContext
  ): boolean {
    return context.grants.some(
      (g) =>
        g.tree === tree &&
        scopeContains(g.within, path) &&
        operationAllowed(g.allow, operation)
    );
  }
  canSubmit(tree: string): boolean {
    const c = this.current;
    return (
      !!c &&
      c.grants.some((g) => g.tree === tree && g.allow.some((op) => op !== "read")) &&
      this.covered(c)
    );
  }
}
