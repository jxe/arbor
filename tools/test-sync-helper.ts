import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [runtime, script] = process.argv.slice(2);
if (!runtime || !script) throw new Error("Usage: test-sync-helper runtime script");
const scratch = await mkdtemp(join(tmpdir(), "arbor-helper-check-"));
const child = Bun.spawn([runtime, script, "--control", "--port", "0"], {
  cwd: scratch,
  env: { ...process.env, PATH: "/usr/bin:/bin", ARBOR_DATA_HOME: join(scratch, "data"), ARBOR_CREDENTIAL_STORE: "file" },
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
  const status = await (await fetch(`${origin}/v1/status`)).json();
  if (status.service !== "arborsync") throw new Error("Unexpected service");
  const accounts = await (await fetch(`${origin}/v1/accounts`)).json();
  if (accounts.identity !== null || accounts.accounts.length !== 0) throw new Error("Expected a fresh data home");
  const create = await fetch(`${origin}/v1/me`, { method: "POST", body: JSON.stringify({ path: join(scratch, "profile") }) });
  if (!create.ok || !(await create.json()).identity.keyAvailable) throw new Error("Helper could not create an isolated identity");
  console.log("Helper starts without shell Bun/CLI and creates an isolated identity.");
} finally {
  child.kill("SIGTERM");
  await child.exited;
  await rm(scratch, { recursive: true, force: true });
}
