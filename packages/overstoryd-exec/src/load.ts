// Code loaded from trees (Apps 005 step 3). overstoryd reads each activated
// module's import graph from the tree at a pinned root and hands the sidecar
// the files. The sidecar compiles them with Sucrase, the compiler Story uses on
// the device, links their imports, and imports the module. Each module gets its
// own `overstory/data`, whose `node()` resolves paths from that module's own
// logical path, so an imported helper keeps its own place in its tree.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { transform } from "sucrase";
import {
  isView,
  nodesNamedIn,
  type MutationHandle,
  type View,
} from "@ovst/apps-runtime";
import {
  DEVICE_ONLY_PACKAGES,
  importCandidates,
  TREE_CODE_PACKAGES,
  type ExecActivation,
  type ExecActivations,
  type ExecHandleRef,
} from "@ovst/exec-protocol";

/** A handle the sidecar runs: its name, and the nodes its modules name. */
export interface ExecEntry<Handle> {
  ref: ExecHandleRef;
  handle: Handle;
  /** Every logical path `node()` named in the handle's import graph. */
  sources: string[];
}

export interface LoadedCode {
  views: ExecEntry<View<unknown, unknown>>[];
  mutations: ExecEntry<MutationHandle<unknown, unknown>>[];
}

/** Where each package tree code may import comes from: the sidecar's own copy, so views share its runtime. */
const PACKAGE_TARGETS: Record<(typeof TREE_CODE_PACKAGES)[number], string> = {
  "overstory/data": "@ovst/apps-runtime",
  "overstory/ui/jsx-runtime": "@ovst/apps-runtime/ui/jsx-runtime",
  "overstory/ui/jsx-dev-runtime": "@ovst/apps-runtime/ui/jsx-dev-runtime",
  zod: "zod",
};

const SPECIFIER = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])([^"']+)\2/g;
const NAMED_IMPORT = /\bimport\s+(?:([A-Za-z_$][\w$]*)\s*,?\s*)?(?:\{([^}]*)\}|\*\s+as\s+[A-Za-z_$][\w$]*)?\s*from\s*["']([^"']+)["']/g;

function compiledName(path: string): string {
  return `${path.replace(/^\//, "")}.mjs`;
}

/** Load every activation; one that fails to load is reported and left out. */
export async function loadActivations(manifestPath: string, compiledRoot: string): Promise<LoadedCode> {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ExecActivations;
  const loaded: LoadedCode = { views: [], mutations: [] };
  for (const activation of manifest.activations) {
    try {
      const code = await loadActivation(manifest.code, activation, compiledRoot);
      loaded.views.push(...code.views);
      loaded.mutations.push(...code.mutations);
    } catch (error) {
      console.error(`overstoryd-exec: ${activation.path} in ${activation.tree} did not load: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return loaded;
}

export async function loadActivation(codeRoot: string, activation: ExecActivation, compiledRoot: string): Promise<LoadedCode> {
  const out = join(compiledRoot, activation.tree, activation.version.replace(/[^\w-]/g, "_"));
  const keys: string[] = [];
  const stubs = new Map<string, Set<string>>();
  const runtime = Bun.resolveSync(PACKAGE_TARGETS["overstory/data"], import.meta.dir);
  for (const [path, file] of Object.entries(activation.files)) {
    const source = await readFile(join(codeRoot, file), "utf8");
    const jsx = /\.[jt]sx$/.test(path);
    const compiled = transform(source, {
      transforms: jsx ? ["typescript", "jsx"] : ["typescript"],
      jsxRuntime: "automatic",
      jsxImportSource: "overstory/ui",
      production: true,
      filePath: path,
    }).code;
    const target = join(out, compiledName(path));
    const shim = `${target.slice(0, -".mjs".length)}.overstory-data.mjs`;
    for (const match of compiled.matchAll(NAMED_IMPORT)) {
      const specifier = match[3]!;
      if (!(DEVICE_ONLY_PACKAGES as readonly string[]).includes(specifier)) continue;
      const names = stubs.get(specifier) ?? new Set();
      if (match[1]) names.add("default");
      for (const part of (match[2] ?? "").split(",")) {
        const name = part.trim().split(/\s+as\s+/)[0]!.trim();
        if (name) names.add(name);
      }
      stubs.set(specifier, names);
    }
    const linked = compiled.replace(SPECIFIER, (_whole, lead: string, quote: string, specifier: string) => {
      let resolved: string;
      if (specifier.startsWith(".")) {
        const found = importCandidates(path, specifier).find((candidate) => candidate in activation.files);
        if (!found) throw new Error(`${path} imports ${specifier}, which the activation does not include`);
        resolved = join(out, compiledName(found));
      } else if (specifier === "overstory/data") {
        resolved = shim;
      } else if (specifier in PACKAGE_TARGETS) {
        resolved = Bun.resolveSync(PACKAGE_TARGETS[specifier as keyof typeof PACKAGE_TARGETS], import.meta.dir);
      } else if ((DEVICE_ONLY_PACKAGES as readonly string[]).includes(specifier)) {
        resolved = join(out, "__device-only", `${specifier.replaceAll("/", "_")}.mjs`);
      } else {
        throw new Error(`${path} imports ${specifier}, which tree code can't use on the host`);
      }
      return `${lead}${quote}${resolved}${quote}`;
    });
    const key = `${activation.tree}\0${activation.version}\0${path}`;
    keys.push(key);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(shim, [
      `export * from ${JSON.stringify(runtime)};`,
      `import { nodeIn } from ${JSON.stringify(runtime)};`,
      `export function node(path) { return nodeIn(${JSON.stringify({ key, path })}, path); }`,
      "",
    ].join("\n"));
    await writeFile(target, linked);
  }
  for (const [specifier, names] of stubs) {
    const file = join(out, "__device-only", `${specifier.replaceAll("/", "_")}.mjs`);
    await mkdir(dirname(file), { recursive: true });
    const unavailable = `function unavailable() { throw new Error(${JSON.stringify(`${specifier} is not available on the host`)}); }`;
    await writeFile(file, [
      unavailable,
      ...[...names].map((name) => name === "default" ? "export default unavailable;" : `export const ${name} = unavailable;`),
      "",
    ].join("\n"));
  }
  const module = await import(join(out, compiledName(activation.path))) as Record<string, unknown>;
  const sources = [...new Set(keys.flatMap((key) => nodesNamedIn(key)))].sort();
  const code: LoadedCode = { views: [], mutations: [] };
  for (const [name, value] of Object.entries(module)) {
    const ref = { tree: activation.tree, path: activation.path, name, version: activation.version };
    if (isView(value)) code.views.push({ ref, handle: value as View<unknown, unknown>, sources });
    else if (value && typeof value === "object" && (value as { kind?: unknown }).kind === "mutation") {
      code.mutations.push({ ref, handle: value as MutationHandle<unknown, unknown>, sources });
    }
  }
  return code;
}
