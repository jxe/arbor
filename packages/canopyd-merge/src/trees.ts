import {
  compareProtocolNames,
  decodeProtocolDirectory,
  encodeProtocolDirectory,
  type ProtocolDirectory,
  type ProtocolDirectoryEntry,
} from "@overstory/protocol";

/** Tree reads and path-copying writes over the object store. */
export interface TreeIO {
  read(hash: string): Promise<Uint8Array>;
  /** Record a new object; returns its hash. */
  put(bytes: Uint8Array): string;
}

export async function directory(io: TreeIO, hash: string): Promise<ProtocolDirectory> {
  return decodeProtocolDirectory(await io.read(hash));
}

/** The entry at `names` below `root`, or null. */
export async function entryAt(io: TreeIO, root: string, names: readonly string[]): Promise<ProtocolDirectoryEntry | null> {
  let object = root;
  for (const [index, name] of names.entries()) {
    const entry = (await directory(io, object)).entries.find((e) => e.name === name);
    if (!entry || index === names.length - 1) return entry ?? null;
    if (!entry.directory) return null;
    object = entry.directory;
  }
  return null;
}

/** Replace (or, with null, remove) the entry at `names` below `root`; null
 * when a parent directory is absent. */
export async function withEntry(
  io: TreeIO,
  root: string,
  names: readonly string[],
  entry: ProtocolDirectoryEntry | null,
): Promise<string | null> {
  const value = await directory(io, root);
  const [name, ...rest] = names as [string, ...string[]];
  const prior = value.entries.find((e) => e.name === name);
  let next: ProtocolDirectoryEntry | null = entry;
  if (rest.length) {
    if (!prior?.directory) return null;
    const child = await withEntry(io, prior.directory, rest, entry);
    if (!child) return null;
    next = { ...prior, directory: child };
  }
  value.entries = [...value.entries.filter((e) => e.name !== name), ...(next ? [next] : [])]
    .sort((a, b) => compareProtocolNames(a.name, b.name));
  return io.put(encodeProtocolDirectory(value));
}

/** The value an entry holds: a file or a directory, or null (absent or a nested tree). */
export function entryValue(entry: ProtocolDirectoryEntry | null | undefined): { file: string } | { directory: string } | null {
  if (entry?.file) return { file: entry.file };
  if (entry?.directory) return { directory: entry.directory };
  return null;
}

/** The paths whose entries differ between two roots: a changed file, nested
 * tree or entry kind at its entry, and a directory whose own metadata changed
 * at the directory. */
export async function changedEntryPaths(io: TreeIO, before: string, after: string): Promise<string[]> {
  const paths: string[] = [];
  const metadata = ({ entries: _entries, ...rest }: ProtocolDirectory) => JSON.stringify(rest);
  const value = (entry?: ProtocolDirectoryEntry) =>
    entry?.file ? `file:${entry.file}` : entry?.directory ? `directory:${entry.directory}` : entry?.tree ? `tree:${entry.tree}` : "absent";
  const walk = async (left: string, right: string, path: string): Promise<void> => {
    if (left === right) return;
    const [a, b] = await Promise.all([directory(io, left), directory(io, right)]);
    if (metadata(a) !== metadata(b)) paths.push(path || "/");
    const old = new Map(a.entries.map((e) => [e.name, e]));
    const next = new Map(b.entries.map((e) => [e.name, e]));
    for (const name of [...new Set([...old.keys(), ...next.keys()])].sort(compareProtocolNames)) {
      const x = old.get(name), y = next.get(name), child = `${path}/${name}`;
      if (x?.directory && y?.directory) await walk(x.directory, y.directory, child);
      else if (value(x) !== value(y)) paths.push(child);
    }
  };
  await walk(before, after, "");
  return paths;
}

/** Every object a tree names, below `root`, that `present` does not report;
 * a present directory's subtree is not walked. */
export async function absentClosure(
  io: TreeIO,
  roots: Iterable<string>,
  present: (hash: string) => Promise<boolean>,
): Promise<Set<string>> {
  const found = new Set<string>(), seen = new Set<string>();
  const visit = async (hash: string, isDirectory: boolean): Promise<void> => {
    if (seen.has(hash)) return;
    seen.add(hash);
    if (await present(hash)) return;
    found.add(hash);
    if (!isDirectory) return;
    for (const entry of (await directory(io, hash)).entries) {
      if (entry.directory) await visit(entry.directory, true);
      else if (entry.file) await visit(entry.file, false);
    }
  };
  for (const root of roots) await visit(root, true);
  return found;
}
