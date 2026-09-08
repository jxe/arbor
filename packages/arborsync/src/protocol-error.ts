import type { ExpandedNode } from "./node-sampling.ts";

export { ProtocolError } from "@arbor/core";

export class RevisionConflictError extends Error {
  constructor(public current: ExpandedNode) { super("The file changed since it was opened"); }
}
