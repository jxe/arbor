/**
 * macOS cloud-storage placeholders ("dataless" files and directories).
 *
 * iCloud Drive with Optimize Mac Storage, and any other File Provider, may
 * evict a placed file's bytes and leave a dataless placeholder. Whether a read
 * of that placeholder downloads it or fails is a per-process kernel policy
 * (`IOPOL_TYPE_VFS_MATERIALIZE_DATALESS_FILES`). Processes started from an
 * interactive session usually inherit "on"; a launchd agent starts with the
 * system default, which is "off", so every read, including `readdir` of a
 * dataless directory, fails with `EDEADLK` instead of downloading.
 *
 * Arbor Sync must hash the bytes it synchronizes, so the daemon opts in once
 * at startup. Reads of a placeholder then block only the file-system worker
 * performing them until the provider has downloaded the bytes.
 */

// <sys/resource.h>
const IOPOL_TYPE_VFS_MATERIALIZE_DATALESS_FILES = 3;
const IOPOL_SCOPE_PROCESS = 0;
const IOPOL_MATERIALIZE_DATALESS_FILES_ON = 2;

export interface IOPolicyFunctions {
  setiopolicy_np(type: number, scope: number, policy: number): number;
}

export type CloudPlaceholderPolicy =
  | { kind: "enabled" }
  | { kind: "unsupported"; platform: string }
  | { kind: "failed"; reason: string };

async function loadSystemIOPolicy(): Promise<IOPolicyFunctions> {
  const { dlopen, FFIType } = await import("bun:ffi");
  const library = dlopen("/usr/lib/libSystem.B.dylib", {
    setiopolicy_np: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  });
  return library.symbols;
}

/** Let this process (and children it spawns) download placeholders on read. Inert off macOS. */
export async function allowCloudPlaceholderDownloads(options: {
  platform?: string;
  load?: () => Promise<IOPolicyFunctions>;
} = {}): Promise<CloudPlaceholderPolicy> {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") return { kind: "unsupported", platform };
  try {
    const system = await (options.load ?? loadSystemIOPolicy)();
    const result = system.setiopolicy_np(
      IOPOL_TYPE_VFS_MATERIALIZE_DATALESS_FILES,
      IOPOL_SCOPE_PROCESS,
      IOPOL_MATERIALIZE_DATALESS_FILES_ON,
    );
    return result === 0 ? { kind: "enabled" } : { kind: "failed", reason: `setiopolicy_np returned ${result}` };
  } catch (error) {
    return { kind: "failed", reason: error instanceof Error ? error.message : String(error) };
  }
}

/** The kernel's answer to reading a placeholder this process may not download. */
export function isCloudPlaceholderError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "EDEADLK";
}
