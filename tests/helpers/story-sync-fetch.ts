import { readStorySyncAccess, storySyncAuthorization } from "@ovst/protocol";

/**
 * A request to a Story Sync from its data home's own user: it answers no one
 * else. `dataHome` defaults to the selected one (`STORY_HOME`).
 */
export async function storySyncFetch(input: string, init: RequestInit = {}, dataHome?: string): Promise<Response> {
  const access = await readStorySyncAccess(dataHome);
  if (!access) throw new Error(`No Story Sync caller token in ${dataHome ?? "the selected data home"}`);
  const headers = new Headers(init.headers);
  headers.set("authorization", storySyncAuthorization(access));
  return fetch(input, { ...init, headers });
}
