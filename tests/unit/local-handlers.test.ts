import { expect, test } from "bun:test";
import { CommunityConfigStore } from "@arbor/stores";
import { accountHandler } from "../../packages/arborsync/src/account-http.ts";
import { LocalAccountService } from "../../packages/arborsync/src/account-service.ts";
import { browserHandler } from "../../packages/arborsync/src/browser-http.ts";

// Neither handler needs a running daemon, watcher, synchronizer or private index.
test("browser handler preserves conditional/ranged bytes independently of sync", async () => {
  const bytes = new TextEncoder().encode("unchanged source");
  const handler = browserHandler({
    fileSurface: async () => ({ bytes, revision: "revision", path: "/asset.txt" }),
    fileSurfaceInScopeOf: async () => null,
  });
  const url = new URL("http://127.0.0.1/render/asset.txt");
  const response = await handler(new Request(url, { headers: { range: "bytes=0-8" } }), url);
  expect(response.status).toBe(206);
  expect(await response.text()).toBe("unchanged");
  const unchanged = await handler(new Request(url, { headers: { "if-none-match": '"revision"' } }), url);
  expect(unchanged.status).toBe(304);
  const head = await handler(new Request(url, { method: "HEAD" }), url);
  expect(await head.text()).toBe("");
  expect(head.headers.get("etag")).toBe('"revision"');
});

test("account handler takes only account bootstrap ports and leaves sync routes alone", async () => {
  const unexpected = () => { throw new Error("Unrelated account dependency was used"); };
  const handler = accountHandler(new LocalAccountService({
    communityConfig: new CommunityConfigStore(),
    trees: { openSession: unexpected, refreshConfiguration: unexpected, invalidateDescriptors: unexpected },
    events: { emit: unexpected },
  }));
  const sync = new URL("http://127.0.0.1/v1/sync");
  expect(await handler(new Request(sync, { method: "POST" }), sync)).toBeUndefined();
  const invalid = new URL("http://127.0.0.1/v1/credential?configurationTree=invalid");
  await expect(handler(new Request(invalid), invalid)).rejects.toMatchObject({ code: "invalid-request" });
});
