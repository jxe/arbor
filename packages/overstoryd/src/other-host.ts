import { ProtocolClient, ProtocolHTTPError } from "@ovst/protocol";

/**
 * The client overstoryd reads another host with (device keys, remote groups,
 * profile locators): anonymous, bounded by the client's request timeout, and
 * never following a redirect elsewhere.
 */
export function otherHost(origin: string): ProtocolClient {
  return new ProtocolClient(origin, undefined, { redirect: "error" });
}

/** Whether a failure is the host's refusal (a 4xx), as opposed to an outage. */
export function refusedByHost(error: unknown): boolean {
  return error instanceof ProtocolHTTPError && error.status >= 400 && error.status < 500;
}
