import { AsyncLocalStorage } from "node:async_hooks";
import { PermissionDeniedError } from "./errors.ts";
import { randomBytes } from "node:crypto";
import {
  operationAllowed,
  scopeContains,
  parseResourceRule,
  type AccessOperation,
  type ResourceCapability,
} from "@overstory/protocol";
export interface ExecutionGrant extends ResourceCapability {
  account: string;
  role: "author" | "user";
}
export interface ExecutionContext {
  code: string;
  version: string;
  caller: string | null;
  linkDigest?: string;
  sponsor: string;
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
  invalidate(): void {
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
      !context.subject ||
      !context.sponsor
    )
      throw new PermissionDeniedError("Execution permission is not allowed");
    const copy = {
      ...context,
      grants: context.grants.map((g) => ({ ...g, allow: [...g.allow] })),
    };
    for (const grant of copy.grants) {
      parseResourceRule({
        who: "me",
        via: copy.code,
        within: grant.within,
        allow: grant.allow,
      });
      parseResourceRule({ who: { profile: grant.tree }, allow: ["read"] });
      if (
        grant.role === "author"
          ? grant.account !== copy.sponsor
          : grant.account !== copy.caller
      )
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
  allows(
    tree: string,
    path: string,
    operation: AccessOperation,
    context = this.current
  ): boolean {
    return (
      !!context &&
      this.covered(context) &&
      context.grants.some(
        (g) =>
          g.tree === tree &&
          scopeContains(g.within, path) &&
          operationAllowed(g.allow, operation) &&
          this.permits(context, g, path, operation)
      )
    );
  }
  canSubmit(tree: string): boolean {
    const c = this.current;
    return (
      !!c &&
      c.grants.some(
        (g) =>
          g.tree === tree &&
          g.allow.some(
            (op) => op !== "read" && this.allows(tree, g.within, op, c)
          )
      )
    );
  }
}
