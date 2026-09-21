import { afterEach, beforeEach, describe, expect, test, spyOn } from "bun:test";
import { mkdtemp, readFile, rm, writeFile, rename, mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { arborPrivateRoot, loadWorkspaceRegistry, sha256 } from "@overstory/protocol";
import { ProfileIdentityStore } from "../../packages/arborsync/src/state/profile-identity.ts";

let root: string;
let previousHome: string | undefined;
let previousStore: string | undefined;
beforeEach(async () => {
  previousHome = process.env.ARBOR_DATA_HOME;
  previousStore = process.env.ARBOR_CREDENTIAL_STORE;
  root = await mkdtemp(join(tmpdir(), "canopy-identity-"));
  process.env.ARBOR_DATA_HOME = join(root, "home");
  process.env.ARBOR_CREDENTIAL_STORE = "file";
});
afterEach(async () => {
  if (previousHome === undefined) delete process.env.ARBOR_DATA_HOME; else process.env.ARBOR_DATA_HOME = previousHome;
  if (previousStore === undefined) delete process.env.ARBOR_CREDENTIAL_STORE; else process.env.ARBOR_CREDENTIAL_STORE = previousStore;
  await rm(root, { recursive: true, force: true });
});

describe("onboarding identity preservation", () => {
  test("creation is idempotent and backup recovery preserves identity", async () => {
    const store = new ProfileIdentityStore();
    expect(await store.status()).toBeNull();
    const profile = join(root, "profile");
    const first = await store.create(profile);
    expect(await store.create(profile)).toEqual(first);
    const backup = join(root, "backup.json");
    await store.backup(backup);
    process.env.ARBOR_DATA_HOME = join(root, "recovered");
    const restored = await store.restore(backup, join(root, "new-profile"));
    expect(restored.profileTree).toBe(first.profileTree);
    expect(restored.publicKey).toBe(first.publicKey);
    expect(restored.keyAvailable).toBe(true);
  });

  test("malformed metadata blocks creation and retains exact bytes", async () => {
    const store = new ProfileIdentityStore();
    await store.create(join(root, "profile"));
    const path = join(arborPrivateRoot(), "self.json");
    await writeFile(path, "{broken");
    await expect(store.status()).rejects.toThrow();
    await expect(store.create(join(root, "profile"))).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe("{broken");
  });

  test("missing and mismatched keys are never treated as absent identity", async () => {
    const store = new ProfileIdentityStore();
    const profile = join(root, "profile");
    const first = await store.create(profile);
    const key = join(arborPrivateRoot(), "self.identity.json");
    const record = JSON.parse(await readFile(key, "utf8"));
    await rm(key);
    expect(await store.status()).toMatchObject({ profileTree: first.profileTree, keyAvailable: false });
    await expect(store.create(profile)).rejects.toThrow("restore a backup");
    await writeFile(key, JSON.stringify({ ...record, privateKey: Buffer.alloc(32).toString("base64url") }));
    await expect(store.status()).rejects.toThrow("does not match");
  });

  test("a locked keychain propagates failure", async () => {
    const store = new ProfileIdentityStore();
    await store.create(join(root, "profile"));
    delete process.env.ARBOR_CREDENTIAL_STORE;
    const lookup = spyOn(Bun.secrets, "get").mockRejectedValue(new Error("Keychain locked"));
    try { await expect(store.status()).rejects.toThrow("Keychain locked"); }
    finally { lookup.mockRestore(); }
  });

  test("recovery rejects mismatched material without modifying the identity", async () => {
    const store = new ProfileIdentityStore();
    const first = await store.create(join(root, "profile"));
    const backup = join(root, "backup.json");
    await store.backup(backup);
    const value = JSON.parse(await readFile(backup, "utf8"));
    value.publicKey = Buffer.alloc(32).toString("base64url");
    await expect(store.restoreValue(value, first.profilePath)).rejects.toThrow("does not match");
    expect(await store.status()).toEqual(first);
  });
  test("concurrent creation commits exactly one identity", async () => {
    const profile = join(root, "profile");
    const results = await Promise.all(Array.from({ length: 6 }, () => new ProfileIdentityStore().create(profile)));
    expect(new Set(results.map((result) => result.profileTree)).size).toBe(1);
    const attempts = await Promise.allSettled(["other-a", "other-b"].map((name) => new ProfileIdentityStore().create(join(root, name))));
    expect(attempts.every((result) => result.status === "rejected")).toBe(true);
  });

  test("Keychain write denial leaves the folder unbound and setup retryable", async () => {
    delete process.env.ARBOR_CREDENTIAL_STORE;
    const records = new Map<string, string>();
    const get = spyOn(Bun.secrets, "get").mockImplementation(async ({ name }) => records.get(name) ?? null);
    const set = spyOn(Bun.secrets, "set").mockRejectedValueOnce(new Error("Keychain denied"))
      .mockImplementation(async ({ name, value }) => { records.set(name, String(value)); });
    try {
      const store = new ProfileIdentityStore();
      const profile = join(root, "profile");
      await expect(store.create(profile)).rejects.toThrow("Keychain denied");
      expect(Object.keys((await loadWorkspaceRegistry()).registry)).toHaveLength(0);
      expect(await store.status()).toBeNull();
      expect((await store.create(profile)).keyAvailable).toBe(true);
    } finally { get.mockRestore(); set.mockRestore(); }
  });

  test("interruption after secure save resumes the same identity", async () => {
    delete process.env.ARBOR_CREDENTIAL_STORE;
    const records = new Map<string, string>();
    const get = spyOn(Bun.secrets, "get").mockImplementation(async ({ name }) => records.get(name) ?? null);
    const set = spyOn(Bun.secrets, "set").mockImplementation(async ({ name, value }) => {
      records.set(name, String(value));
      await mkdir(join(arborPrivateRoot(), "self.json")); // interrupt metadata publication
    });
    try {
      const store = new ProfileIdentityStore();
      await expect(store.create(join(root, "profile"))).rejects.toThrow();
      const saved = JSON.parse([...records.values()][0]!);
      await rm(join(arborPrivateRoot(), "self.json"), { recursive: true });
      expect((await store.status())?.profileTree).toBe(saved.profileTree);
      expect((await store.create(join(root, "profile"))).profileTree).toBe(saved.profileTree);
    } finally { get.mockRestore(); set.mockRestore(); }
  });

  test("missing metadata recovers the secure record and moved homes retain credential references", async () => {
    delete process.env.ARBOR_CREDENTIAL_STORE;
    const records = new Map<string, string>();
    const get = spyOn(Bun.secrets, "get").mockImplementation(async ({ name }) => records.get(name) ?? null);
    const set = spyOn(Bun.secrets, "set").mockImplementation(async ({ name, value }) => { records.set(name, String(value)); });
    try {
      const store = new ProfileIdentityStore();
      const first = await store.create(join(root, "profile"));
      await rm(join(arborPrivateRoot(), "self.json"));
      expect(await store.status()).toEqual(first);
      await rename(process.env.ARBOR_DATA_HOME!, join(root, "moved-home"));
      process.env.ARBOR_DATA_HOME = join(root, "moved-home");
      expect(await store.status()).toEqual(first);
      expect(records.size).toBe(1);
    } finally { get.mockRestore(); set.mockRestore(); }
  });

  test("legacy credentials migrate without deleting the original", async () => {
    const store = new ProfileIdentityStore();
    const first = await store.create(join(root, "profile"));
    const recordPath = join(arborPrivateRoot(), "self.identity.json");
    const record = JSON.parse(await readFile(recordPath, "utf8"));
    const metadataPath = join(arborPrivateRoot(), "self.json");
    const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
    metadata.credential = `org.arbor.person-profile/self-${sha256(`${arborPrivateRoot()}\0${first.profileTree}`).slice(0, 24)}`;
    await writeFile(metadataPath, JSON.stringify(metadata));
    await writeFile(join(arborPrivateRoot(), "self.key"), record.privateKey);
    await rm(recordPath);
    expect((await store.status())?.profileTree).toBe(first.profileTree);
    expect(await readFile(join(arborPrivateRoot(), "self.key"), "utf8")).toBe(record.privateKey);
  });

  test("explicit matching backup repairs metadata and preserves damaged bytes", async () => {
    const store = new ProfileIdentityStore();
    const profile = join(root, "profile");
    const first = await store.create(profile);
    const backup = join(root, "backup.json");
    await store.backup(backup);
    await writeFile(join(arborPrivateRoot(), "self.json"), "{damaged");
    expect(await store.restore(backup, profile)).toEqual(first);
    const retained = (await readdir(arborPrivateRoot())).find((name) => name.startsWith("self.json.damaged-"));
    expect(await readFile(join(arborPrivateRoot(), retained!), "utf8")).toBe("{damaged");
  });

  test("separate processes share one creation lock", async () => {
    const source = new URL("../../packages/arborsync/src/state/profile-identity.ts", import.meta.url).pathname;
    const profile = join(root, "profile");
    const script = `import { ProfileIdentityStore } from ${JSON.stringify(source)}; console.log((await new ProfileIdentityStore().create(${JSON.stringify(profile)})).profileTree);`;
    const processes = Array.from({ length: 3 }, () => Bun.spawn([process.execPath, "-e", script], { env: process.env, stdout: "pipe", stderr: "pipe" }));
    const values = await Promise.all(processes.map(async (child) => {
      const output = await new Response(child.stdout).text();
      const errors = await new Response(child.stderr).text();
      expect(await child.exited).toBe(0);
      expect(errors).toBe("");
      return output.trim();
    }));
    expect(new Set(values).size).toBe(1);
    expect((await new ProfileIdentityStore().status())?.profileTree).toBe(values[0]);
  });

});
