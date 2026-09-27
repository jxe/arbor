import { expect, test } from "bun:test";
import { encodeProtocolDirectory, hashObject, ProtocolClient, ProtocolHTTPError } from "@overstory/protocol";

async function withHost<T>(respond: () => Response, run: (client: ProtocolClient) => Promise<T>): Promise<T> {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: respond });
  try { return await run(new ProtocolClient(server.url.toString().replace(/\/$/, ""))); } finally { server.stop(true); }
}

test("an HTTP failure keeps the envelope's code, retryability and details", async () => {
  const error = await withHost(
    () => Response.json({ error: "invalid-request", message: "Account challenge is expired", retryable: false, details: { challenge: "expired" } }, { status: 400 }),
    client => client.account().catch((caught: unknown) => caught),
  );
  expect(error).toBeInstanceOf(ProtocolHTTPError);
  expect(error).toMatchObject({ status: 400, code: "invalid-request", retryable: false, details: { challenge: "expired" } });
});

test("a refused update other than a conflict is a ProtocolHTTPError with its code", async () => {
  const error = await withHost(
    () => Response.json({ error: "resync-required", message: "Base update is not retained for this tree", retryable: true, details: { kind: "server-update" } }, { status: 409 }),
    client => {
      const directory = encodeProtocolDirectory({ type: "directory", entries: [] });
      return client.submitUpdate("tr_transporterrorsaaaaaaaaaaaa", "up_base", { root: hashObject(directory), objects: new Map([[hashObject(directory), directory]]) })
        .catch((caught: unknown) => caught);
    },
  );
  expect(error).toBeInstanceOf(ProtocolHTTPError);
  expect(error).toMatchObject({ status: 409, code: "resync-required", retryable: true });
});

test("a plain-text failure still reports its status", async () => {
  const error = await withHost(() => new Response("Not found", { status: 404 }), client => client.account().catch((caught: unknown) => caught));
  expect(error).toBeInstanceOf(ProtocolHTTPError);
  expect(error).toMatchObject({ status: 404 });
  expect((error as ProtocolHTTPError).code).toBeUndefined();
});
