import type { ArborErrorCode, NodeResponse } from "./protocol.ts";

/**
 * One protocol-level failure with the Local Arbor REST status it maps to.
 * Raised by the daemon and by the Canopy client library it embeds, so both
 * share one type that the REST layer can turn into a response.
 */
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
