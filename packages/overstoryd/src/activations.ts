// Activations (Apps 005 step 3): which modules in which trees the host runs,
// each pinned to a root. The host reads a module's import graph from retained
// objects at that root and hands the files to the execution sidecar, which
// compiles and runs them. Until Apps 010, an activation is host configuration,
// and its code runs with each caller's own authority.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { decodeProtocolDirectory, type ObjectHash } from "@ovst/protocol";
import {
  codeVersion,
  DEVICE_ONLY_PACKAGES,
  importCandidates,
  TREE_CODE_PACKAGES,
  type ExecActivation,
} from "@ovst/exec-protocol";

/** One module the host runs: its tree, its logical path, and the root its code is read at. */
export interface Activation {
  tree: string;
  path: string;
  root: string;
}

type Read = (hash: ObjectHash) => Promise<Uint8Array>;

const LOADERS: Record<string, "ts" | "tsx" | "js" | "jsx"> = { ".ts": "ts", ".tsx": "tsx", ".js": "js", ".jsx": "jsx", ".mjs": "js" };
/** How many modules one activation's graph may hold. */
const MAX_MODULES = 256;

/** The file at a logical path under `root`, or null. */
async function fileAt(read: Read, root: ObjectHash, path: string): Promise<Uint8Array | null> {
  const names = path.split("/").filter(Boolean);
  let directory = decodeProtocolDirectory(await read(root));
  for (const [index, name] of names.entries()) {
    const entry = directory.entries.find((candidate) => candidate.name === name);
    if (!entry) return null;
    if (index === names.length - 1) return entry.file ? await read(entry.file as ObjectHash) : null;
    if (!entry.directory) return null;
    directory = decodeProtocolDirectory(await read(entry.directory as ObjectHash));
  }
  return null;
}

/**
 * Read an activated module's import graph at its pinned root, and write the
 * files under `codeRoot` for the sidecar. Relative imports stay inside the
 * tree; other imports must be packages the sidecar provides.
 */
export async function loadActivation(read: Read, activation: Activation, codeRoot: string): Promise<ExecActivation> {
  if (!activation.path.startsWith("/")) throw new Error("An activation's path is a logical path");
  const files: Record<string, Uint8Array> = {};
  const queue = [activation.path];
  while (queue.length) {
    const path = queue.shift()!;
    if (path in files) continue;
    const loader = LOADERS[path.slice(path.lastIndexOf("."))];
    if (!loader) throw new Error(`${path} is not a module`);
    const bytes = await fileAt(read, activation.root as ObjectHash, path);
    if (!bytes) throw new Error(`${path} is not in the tree at the pinned root`);
    files[path] = bytes;
    if (Object.keys(files).length > MAX_MODULES) throw new Error("The module imports too many files");
    const imports = new Bun.Transpiler({ loader }).scanImports(new TextDecoder().decode(bytes));
    for (const { path: specifier } of imports) {
      if (specifier.startsWith(".")) {
        let found: string | undefined;
        for (const candidate of importCandidates(path, specifier)) {
          if (candidate in files || await fileAt(read, activation.root as ObjectHash, candidate)) { found = candidate; break; }
        }
        if (!found) throw new Error(`${path} imports ${specifier}, which is not in the tree`);
        queue.push(found);
      } else if (![...TREE_CODE_PACKAGES, ...DEVICE_ONLY_PACKAGES].includes(specifier as never)) {
        throw new Error(`${path} imports ${specifier}, which tree code can't use on the host`);
      }
    }
  }
  const version = codeVersion(files);
  const directory = join(activation.tree, version.replace(/[^\w-]/g, "_"));
  const written: Record<string, string> = {};
  for (const [path, bytes] of Object.entries(files)) {
    const file = join(directory, path.replace(/^\//, ""));
    await mkdir(dirname(join(codeRoot, file)), { recursive: true });
    await writeFile(join(codeRoot, file), bytes);
    written[path] = file;
  }
  return { tree: activation.tree, path: activation.path, root: activation.root, version, files: written };
}
