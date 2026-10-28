import type { Hash } from "@ovst/protocol";
import type { QueryHandle } from "./authoring.ts";

export { liveQueryStream, outputHash, type LiveQueryAdapter, type LiveQueryContext, type QueryStreamError } from "@ovst/protocol";

export interface MountedQuery {
  id: string;
  tree?: string;
  handle: QueryHandle<unknown, unknown>;
  input?: unknown;
  knownOutputHash?: Hash;
}
