#!/usr/bin/env bun
// Clients 003 step 7: list each client-library module's public types in
// TypeScript and Swift, and flag the ones only one side has.
//
//   bun tools/client-parity.ts            every module
//   bun tools/client-parity.ts sync       one module (protocol, objects, tree, sync, session, accounts, workspace)
//   bun tools/client-parity.ts --strict   exit 1 when a required twin is missing
//
// Names are compared after each language's habits are set aside (a `Protocol`
// or `Overstory` prefix, `Error`/`Errors` suffixes, case). `docs/implementing-sync-services/parity.json`
// pairs names that differ and lists the surface both ports must have; only
// that list fails `--strict`. Everything else is reported for a person to read.

import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const root = join(import.meta.dir, "..");

interface Module {
  key: string;
  title: string;
  ts: string[];
  swift: string[];
}

/** Which files make up each module (porting guide, "Seven modules"). */
const MODULES: Module[] = [
  { key: "protocol", title: "1 protocol", ts: ["packages/protocol/src"], swift: ["swift/Packages/Overstory/Sources/Overstory"] },
  { key: "objects", title: "2 objects", ts: ["packages/object-store/src/sources.ts"], swift: ["swift/Packages/OverstoryObjectStore/Sources/OverstoryObjectStore"] },
  {
    key: "tree", title: "3 tree",
    ts: ["packages/working-tree/src/node-index.ts"],
    swift: [
      "swift/Packages/OverstoryWorkingTree/Sources/OverstoryWorkingTree/WorkingTree.swift",
      "swift/Packages/OverstoryWorkingTree/Sources/OverstoryWorkingTree/WorkingTreeModels.swift",
      "swift/Packages/OverstoryWorkingTree/Sources/OverstoryWorkingTree/WorkingTreeStateStore.swift",
      "swift/Packages/OverstoryWorkingTree/Sources/OverstoryWorkingTree/SnapshotBridge.swift",
    ],
  },
  {
    key: "sync", title: "4 sync",
    ts: [
      "packages/working-tree/src/coordinator.ts", "packages/working-tree/src/update-machine.ts", "packages/working-tree/src/control.ts",
      "packages/working-tree/src/local-change.ts", "packages/working-tree/src/publication.ts", "packages/working-tree/src/entry-transfer.ts",
      "packages/working-tree/src/node",
    ],
    swift: [
      "swift/Packages/OverstoryWorkingTree/Sources/OverstoryWorkingTree/UpdateCoordinator.swift",
      "swift/Packages/OverstoryWorkingTree/Sources/OverstoryWorkingTree/UpdateMachine.swift",
      "swift/Packages/OverstoryWorkingTree/Sources/OverstoryWorkingTree/UpdateModels.swift",
      "swift/Packages/OverstoryWorkingTree/Sources/OverstoryWorkingTree/UpdateDurability.swift",
      "swift/Packages/OverstoryWorkingTree/Sources/OverstoryWorkingTree/ChangeLog.swift",
      "swift/Packages/OverstoryWorkingTree/Sources/OverstoryWorkingTree/ChangePublication.swift",
      "swift/Packages/OverstoryWorkingTree/Sources/OverstoryWorkingTree/PublicationTransport.swift",
      "swift/Packages/OverstoryWorkingTree/Sources/OverstoryWorkingTree/EntryTransfer.swift",
    ],
  },
  { key: "session", title: "5 session", ts: ["packages/working-tree/src/tree-session.ts"], swift: ["swift/Packages/OverstoryClient/Sources/OverstoryClient/TreeSession.swift"] },
  {
    key: "accounts", title: "6 accounts",
    ts: ["packages/client/src"],
    swift: ["swift/Packages/OverstoryClient/Sources/OverstoryClient"],
  },
  { key: "workspace", title: "7 workspace", ts: ["packages/story-sync/src/workspace.ts"], swift: ["swift/Packages/OverstoryWorkspace/Sources/OverstoryWorkspace"] },
];

/** Files that belong to another module though they sit in a module's directory. */
const ELSEWHERE = new Set(["swift/Packages/OverstoryClient/Sources/OverstoryClient/TreeSession.swift"]);

async function files(path: string, extension: string): Promise<string[]> {
  const full = join(root, path);
  if (full.endsWith(extension)) return [full];
  const out: string[] = [];
  for (const entry of await readdir(full, { withFileTypes: true }).catch(() => [])) {
    const child = join(full, entry.name);
    if (entry.isDirectory()) out.push(...await files(relative(root, child), extension));
    else if (entry.name.endsWith(extension) && !entry.name.endsWith(".test.ts")) out.push(child);
  }
  return out;
}

const TS_EXPORT = /^export\s+(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(class|interface|type|function|enum|const)\s+([A-Za-z_][A-Za-z0-9_]*)/gm;
const SWIFT_PUBLIC = /^(?:@\w+(?:\([^)]*\))?\s+)*public\s+(?:final\s+)?(?:nonisolated\s+)?(struct|class|enum|protocol|actor|func|typealias)\s+([A-Za-z_][A-Za-z0-9_]*)/gm;

async function names(paths: string[], extension: string, pattern: RegExp, skip = new Set<string>()): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  for (const path of paths) {
    for (const file of await files(path, extension)) {
      const rel = relative(root, file);
      if (skip.has(rel)) continue;
      const source = await readFile(file, "utf8");
      for (const match of source.matchAll(pattern)) {
        const name = match[2]!;
        if (match[1] === "const" && !/^[A-Z]/.test(name)) continue;
        if (!found.has(name)) found.set(name, rel);
      }
    }
  }
  return found;
}

/** The comparable spelling of a name: no language prefixes or suffixes, no case. */
export function normalized(name: string): string {
  return name
    .replace(/^(Protocol|Overstory|Native)(?=[A-Z])/, "")
    .replace(/(Errors?|Error)$/, "Error")
    .toLowerCase();
}

interface ParityFile {
  /** TypeScript name → Swift name, for twins spelled differently. */
  twins: Record<string, string>;
  /** Per module, the TypeScript names both ports must have. */
  required: Record<string, string[]>;
}

async function parityFile(): Promise<ParityFile> {
  return JSON.parse(await readFile(join(root, "docs/implementing-sync-services/parity.json"), "utf8")) as ParityFile;
}

export interface ModuleParity {
  module: string;
  both: string[];
  onlyTypeScript: string[];
  onlySwift: string[];
  missingRequired: string[];
}

export async function parity(module: Module, file: ParityFile): Promise<ModuleParity> {
  const ts = await names(module.ts, ".ts", TS_EXPORT);
  const swift = await names(module.swift, ".swift", SWIFT_PUBLIC, new Set([...ELSEWHERE].filter((path) => !module.swift.includes(path))));
  const swiftByKey = new Map([...swift.keys()].map((name) => [normalized(name), name]));
  const matchedSwift = new Set<string>();
  const both: string[] = [];
  const onlyTypeScript: string[] = [];
  for (const name of [...ts.keys()].sort()) {
    const twin = file.twins[name] ?? swiftByKey.get(normalized(name));
    if (twin && swift.has(twin)) {
      both.push(name === twin ? name : `${name} ↔ ${twin}`);
      matchedSwift.add(twin);
    } else onlyTypeScript.push(name);
  }
  const onlySwift = [...swift.keys()].filter((name) => !matchedSwift.has(name)).sort();
  const missingRequired = (file.required[module.key] ?? []).filter((name) => {
    const twin = file.twins[name] ?? swiftByKey.get(normalized(name));
    return !ts.has(name) || !twin || !swift.has(twin);
  });
  return { module: module.title, both, onlyTypeScript, onlySwift, missingRequired };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const strict = args.includes("--strict");
  const wanted = args.filter((arg) => !arg.startsWith("--"));
  const file = await parityFile();
  let failed = false;
  for (const module of MODULES.filter((candidate) => !wanted.length || wanted.includes(candidate.key))) {
    const result = await parity(module, file);
    console.log(`\n== ${result.module}: ${result.both.length} in both, ${result.onlyTypeScript.length} only in TypeScript, ${result.onlySwift.length} only in Swift`);
    if (result.missingRequired.length) {
      failed = true;
      console.log(`  required but missing a twin: ${result.missingRequired.join(", ")}`);
    }
    if (result.onlyTypeScript.length) console.log(`  only TypeScript: ${result.onlyTypeScript.join(", ")}`);
    if (result.onlySwift.length) console.log(`  only Swift: ${result.onlySwift.join(", ")}`);
  }
  if (strict && failed) process.exit(1);
}
