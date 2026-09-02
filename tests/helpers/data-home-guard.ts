// Preloaded by bunfig.toml before every test file. The test suite must never
// touch the developer's real ~/.arbor: preparing that home discards rebuildable
// private state when its version stamp is missing. Every worker therefore gets
// an isolated default data home, private-state code refuses the built-in
// default while tests run, and each test starts with the variable verified.
import { afterAll, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const realDataHome = join(homedir(), ".arbor");
const defaultTestDataHome = mkdtempSync(join(tmpdir(), "arbor-test-home-"));

process.env.ARBOR_DATA_HOME = defaultTestDataHome;
process.env.ARBOR_REQUIRE_DATA_HOME = "1";

afterAll(() => {
  rmSync(defaultTestDataHome, { recursive: true, force: true });
});

beforeEach(() => {
  const home = process.env.ARBOR_DATA_HOME;
  if (!home) {
    throw new Error("ARBOR_DATA_HOME is unset at the start of a test; a previous test cleared it without restoring it");
  }
  const resolved = resolve(home);
  if (resolved === realDataHome || resolved.startsWith(`${realDataHome}/`)) {
    throw new Error(`ARBOR_DATA_HOME points at the real Arbor data home (${home}); tests must use a temporary directory`);
  }
});
