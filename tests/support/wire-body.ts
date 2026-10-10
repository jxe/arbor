import { decodeUpdateRequestJSON, decodeWireBody, wireEncodingOf, type UpdateRequest, type WireEncoding } from "@ovst/protocol";

/**
 * An intercepted request's body as a wire value, whichever encoding carried it
 * (tree operations §4.4); undefined for a body that is neither text nor bytes.
 */
export function interceptedBody(init: RequestInit | undefined): { value: any; encoding: WireEncoding } | undefined {
  const body = init?.body;
  if (typeof body !== "string" && !(body instanceof Uint8Array)) return undefined;
  const encoding = wireEncodingOf(new Headers(init!.headers).get("content-type"));
  return { value: decodeWireBody(typeof body === "string" ? new TextEncoder().encode(body) : body, encoding), encoding };
}

/** An intercepted update POST's request, decoded from either encoding. */
export function interceptedUpdateRequest(init: RequestInit | undefined): UpdateRequest | undefined {
  const body = interceptedBody(init);
  return body && decodeUpdateRequestJSON(body.value, body.encoding);
}

/** A success response's wire value, read in the encoding its `Content-Type` names. */
export async function wireResponseValue(response: Response): Promise<any> {
  return decodeWireBody(new Uint8Array(await response.arrayBuffer()), wireEncodingOf(response.headers.get("content-type")));
}
