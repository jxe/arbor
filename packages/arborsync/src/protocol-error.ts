import type { ArborErrorCode, NodeResponse } from "@arbor/core";
import type { ExpandedNode } from "./node-sampling.ts";

export class RevisionConflictError extends Error {
  constructor(public current: ExpandedNode) { super("The file changed since it was opened"); }
}

export class ProtocolError extends Error {
  constructor(
    public code: ArborErrorCode,
    message: string,
    public status: number,
    public details: Partial<{
      tree: string;
      path: string;
      current: NodeResponse;
      owners: string[];
      mutationID: string;
      retryable: boolean;
      details: unknown;
    }> = {},
  ) {
    super(message);
    this.name = "ProtocolError";
  }
}
