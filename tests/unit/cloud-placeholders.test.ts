import { expect, test } from "bun:test";
import { join } from "node:path";
import { allowCloudPlaceholderDownloads, isCloudPlaceholderError } from "../../packages/arborsync/src/cloud-placeholders.ts";
import { objectReadError } from "../../packages/arborsync/src/object-read-diagnostics.ts";

test("placeholder downloads are a process-wide macOS policy and inert elsewhere", async () => {
  const calls: number[][] = [];
  const load = async () => ({ setiopolicy_np: (...args: number[]) => { calls.push(args); return 0; } });
  expect(await allowCloudPlaceholderDownloads({ platform: "linux", load })).toEqual({ kind: "unsupported", platform: "linux" });
  expect(calls).toEqual([]);
  expect(await allowCloudPlaceholderDownloads({ platform: "darwin", load })).toEqual({ kind: "enabled" });
  // IOPOL_TYPE_VFS_MATERIALIZE_DATALESS_FILES, IOPOL_SCOPE_PROCESS, IOPOL_MATERIALIZE_DATALESS_FILES_ON
  expect(calls).toEqual([[3, 0, 2]]);
  expect(await allowCloudPlaceholderDownloads({ platform: "darwin", load: async () => ({ setiopolicy_np: () => -1 }) }))
    .toEqual({ kind: "failed", reason: "setiopolicy_np returned -1" });
  expect(await allowCloudPlaceholderDownloads({ platform: "darwin", load: async () => { throw new Error("no ffi"); } }))
    .toEqual({ kind: "failed", reason: "no ffi" });
});

test.skipIf(process.platform !== "darwin")("the daemon policy survives a process that starts with materialization off", async () => {
  const module = join(import.meta.dir, "../../packages/arborsync/src/cloud-placeholders.ts");
  // Model a launchd agent: start from the system default (off), then opt in and read it back.
  const script = `
    import { dlopen, FFIType } from "bun:ffi";
    const { symbols } = dlopen("/usr/lib/libSystem.B.dylib", {
      getiopolicy_np: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      setiopolicy_np: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    });
    if (symbols.setiopolicy_np(3, 0, 1) !== 0) throw new Error("could not model the launchd default");
    const before = symbols.getiopolicy_np(3, 0);
    const { allowCloudPlaceholderDownloads } = await import(${JSON.stringify(module)});
    const result = await allowCloudPlaceholderDownloads();
    console.log(JSON.stringify({ before, result, after: symbols.getiopolicy_np(3, 0) }));
  `;
  const child = Bun.spawnSync([process.execPath, "-e", script]);
  expect(child.stderr.toString()).toBe("");
  expect(JSON.parse(child.stdout.toString())).toEqual({ before: 1, result: { kind: "enabled" }, after: 2 });
});

test("a placeholder the process could not download is its own diagnostic, not a generic I/O error", () => {
  const error = Object.assign(new Error("Resource deadlock avoided, /private/path"), { code: "EDEADLK" });
  expect(isCloudPlaceholderError(error)).toBe(true);
  expect(isCloudPlaceholderError(Object.assign(new Error("x"), { code: "EIO" }))).toBe(false);
  const diagnostic = objectReadError({ source: "filesystem", path: "/tree/Assets" }, error);
  expect(diagnostic).toEqual({ source: "filesystem", path: "/tree/Assets", reason: "cloud-placeholder", code: "EDEADLK" });
});
