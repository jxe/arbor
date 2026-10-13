import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { storySyncHeaders } from "../packages/protocol/src/config/story-sync-access.ts";

const [runtime, script] = process.argv.slice(2);
if (!runtime || !script) throw new Error("Usage: test-sync-helper runtime script");
const scratch = await mkdtemp(join(tmpdir(), "story-helper-check-"));
const dataHome = join(scratch, "data");
const child = Bun.spawn([runtime, script, "--control", "--port", "0"], {
  cwd: scratch,
  env: { ...process.env, PATH: "/usr/bin:/bin", STORY_HOME: dataHome, STORY_CREDENTIAL_STORE: "file" },
  stdout: "pipe", stderr: "pipe",
});
try {
  const readOrigin = async () => {
    let output = "";
    for await (const chunk of child.stdout) {
      output += new TextDecoder().decode(chunk);
      const origin = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
      if (origin) return origin;
    }
    throw new Error("Helper exited without readiness: " + await new Response(child.stderr).text());
  };
  let timer: ReturnType<typeof setTimeout>;
  const origin = await Promise.race([
    readOrigin(),
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Helper readiness timed out")), 15000); }),
  ]).finally(() => clearTimeout(timer));
  // Story Sync answers only the holder of its data home's caller token.
  if ((await fetch(`${origin}/v1/status`)).status !== 401) throw new Error("Helper answered a caller without its token");
  const headers = await storySyncHeaders(dataHome);
  const status = await (await fetch(`${origin}/v1/status`, { headers })).json();
  if (status.service !== "story-sync") throw new Error("Unexpected service");
  const accounts = await (await fetch(`${origin}/v1/accounts`, { headers })).json();
  if (accounts.identity !== null || accounts.accounts.length !== 0) throw new Error("Expected a fresh data home");
  const create = await fetch(`${origin}/v1/me`, { method: "POST", headers, body: JSON.stringify({ path: join(scratch, "profile") }) });
  if (!create.ok || !(await create.json()).identity.keyAvailable) throw new Error("Helper could not create an isolated identity");
  console.log("Helper starts without shell Bun/CLI and creates an isolated identity.");
} finally {
  child.kill("SIGTERM");
  await child.exited;
  await rm(scratch, { recursive: true, force: true });
}
