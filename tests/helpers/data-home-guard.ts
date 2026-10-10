// Preloaded by bunfig.toml before every test file. The test suite must never
// touch the developer's real ~/.story: preparing that home discards rebuildable
// private state when its version stamp is missing. Every worker therefore gets
// an isolated default data home, private-state code refuses the built-in
// default while tests run, and each test starts with the variable verified.
//
// Nor may it touch the developer's real credential store: every identity and
// account a test creates would otherwise leave a Keychain record behind. The
// file store is the default for the worker and every process it spawns, and
// the OS store itself refuses in-process calls; a test that exercises the
// Keychain path mocks `Bun.secrets` with `spyOn`.
import { afterAll, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const realDataHome = join(homedir(), ".story");
const defaultTestDataHome = mkdtempSync(join(tmpdir(), "story-test-home-"));

process.env.STORY_HOME = defaultTestDataHome;
process.env.STORY_REQUIRE_HOME = "1";
process.env.STORY_CREDENTIAL_STORE = "file";

const refuse = (operation: string) => async ({ service, name }: { service: string; name: string }): Promise<never> => {
  throw new Error(`A test reached the real OS credential store (Bun.secrets.${operation} ${service}/${name}); `
    + "keep STORY_CREDENTIAL_STORE=file or mock Bun.secrets with spyOn");
};
const refusingSecrets = { get: refuse("get"), set: refuse("set"), delete: refuse("delete") } as unknown as typeof Bun.secrets;
// Declared read-only, but the runtime property is writable.
(Bun as { secrets: typeof Bun.secrets }).secrets = refusingSecrets;

afterAll(() => {
  rmSync(defaultTestDataHome, { recursive: true, force: true });
});

beforeEach(() => {
  const home = process.env.STORY_HOME;
  if (!home) {
    throw new Error("STORY_HOME is unset at the start of a test; a previous test cleared it without restoring it");
  }
  const resolved = resolve(home);
  if (resolved === realDataHome || resolved.startsWith(`${realDataHome}/`)) {
    throw new Error(`STORY_HOME points at the real Story data home (${home}); tests must use a temporary directory`);
  }
  if (process.env.STORY_CREDENTIAL_STORE !== "file") {
    throw new Error("STORY_CREDENTIAL_STORE is not \"file\" at the start of a test; a previous test changed it without restoring it");
  }
  if (Bun.secrets !== refusingSecrets) {
    throw new Error("Bun.secrets was replaced; tests must mock it with spyOn so the refusing store is restored");
  }
});
