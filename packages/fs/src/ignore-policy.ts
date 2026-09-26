import { lstat, readFile, realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { decodeProtocolDirectory, type Diagnostic, type ObjectHash, type ProtocolDirectoryEntry } from "@overstory/protocol";

/**
 * Filesystem membership: which local paths belong to a tree. Discovery,
 * listing, watching, snapshots, object reads and materialization all ask one
 * policy, so a path is either tree content everywhere or nowhere.
 *
 * Mandatory exclusions are tooling and platform state that is never tree
 * content. User rules come from `.arborignore` (Overstory's portable
 * spelling) and `.gitignore` (read for compatibility) in the directory they
 * apply from; both use Git's pattern grammar. Git itself, its index,
 * `.git/info/exclude` and machine-global ignore files are never consulted, so
 * the same folder yields the same tree on every device.
 */

/** Directory names that are never tree content, wherever they appear. */
export const MANDATORY_DIRECTORY_NAMES: ReadonlySet<string> = new Set([
  ".git",
  "node_modules",
  ".arbor",
  "Trash",
  ".build",
  "DerivedData",
]);

/** Ignore-rule files, lowest precedence first: `.arborignore` wins over `.gitignore` beside it. */
export const IGNORE_FILE_NAMES = [".gitignore", ".arborignore"] as const;

export function isIgnoreFileName(name: string): boolean {
  return (IGNORE_FILE_NAMES as readonly string[]).includes(name);
}

/** An Overstory write or transaction temporary. */
export function isTransactionTemporaryName(name: string): boolean {
  return name.includes(".arbor-write-") || name.includes(".arbor-txn-");
}

/**
 * macOS Finder and filesystem metadata: `.DS_Store`, and the AppleDouble
 * `._name` companions written on volumes without extended attributes. The
 * system rewrites them on its own, so they are never tree content.
 */
export function isPlatformMetadataName(name: string): boolean {
  return name === ".DS_Store" || (name.startsWith("._") && name.length > 2);
}

/** iCloud's stand-in `.name.icloud` for an evicted file. */
export function isCloudPlaceholderName(name: string): boolean {
  return name.startsWith(".") && name.endsWith(".icloud") && name.length > ".icloud".length + 1;
}

export type Membership = "included" | "mandatory" | "ignored";

export interface IgnoreDecision {
  membership: Membership;
  /** For `ignored`: the tree path of the ignore file whose rule decided. */
  source?: string;
  /** For `ignored`: that rule as written. */
  pattern?: string;
}

interface Rule {
  pattern: string;
  negative: boolean;
  directoryOnly: boolean;
  /** Match the basename at any depth, rather than the path from the rule's directory. */
  basename: boolean;
  regex: RegExp;
}

interface RuleFile { source: string; rules: Rule[] }
interface ChainedRules { depth: number; file: RuleFile }

const INCLUDED: IgnoreDecision = { membership: "included" };
const MANDATORY: IgnoreDecision = { membership: "mandatory" };

function escapeLiteral(character: string): string {
  return /[\^$\\.*+?()[\]{}|/]/.test(character) ? `\\${character}` : character;
}

function escapeClassMember(character: string): string {
  return /[\\\]\[^\-]/.test(character) ? `\\${character}` : character;
}

const POSIX_CLASSES: Record<string, string> = {
  alnum: "a-zA-Z0-9",
  alpha: "a-zA-Z",
  blank: " \\t",
  digit: "0-9",
  lower: "a-z",
  space: " \\t\\n\\r\\f\\x0B",
  upper: "A-Z",
  xdigit: "0-9a-fA-F",
};

/**
 * A bracket expression beginning at `characters[start]` (the `[`), as a
 * regular-expression fragment and the index after it. Null when the
 * expression is malformed, which makes the whole pattern match nothing, as in
 * Git.
 */
function bracket(characters: readonly string[], start: number): { source: string; next: number } | null {
  let index = start + 1;
  const negated = characters[index] === "!" || characters[index] === "^";
  if (negated) index++;
  let members = "";
  let first = true;
  while (index < characters.length) {
    let character = characters[index]!;
    if (character === "]" && !first) {
      // A bracket expression never matches `/`; one with no members matches nothing.
      if (!negated && !members) return null;
      return { source: negated ? `[^/${members}]` : `(?:(?!/)[${members}])`, next: index + 1 };
    }
    first = false;
    if (character === "[" && characters[index + 1] === ":") {
      const close = characters.indexOf(":", index + 2);
      if (close < 0 || characters[close + 1] !== "]") return null;
      const range = POSIX_CLASSES[characters.slice(index + 2, close).join("")];
      if (range === undefined) return null;
      members += range;
      index = close + 2;
      continue;
    }
    if (character === "\\") {
      index++;
      if (index >= characters.length) return null;
      character = characters[index]!;
    }
    if (characters[index + 1] === "-" && characters[index + 2] !== undefined && characters[index + 2] !== "]") {
      let end = characters[index + 2]!;
      let after = index + 3;
      if (end === "\\") {
        end = characters[index + 3] ?? "";
        after = index + 4;
        if (!end) return null;
      }
      // An inverted range matches nothing.
      if (character.codePointAt(0)! <= end.codePointAt(0)!) members += `${escapeClassMember(character)}-${escapeClassMember(end)}`;
      index = after;
      continue;
    }
    members += escapeClassMember(character);
    index++;
  }
  return null;
}

/** Git's wildmatch with `WM_PATHNAME`, as a regular-expression body; null when the pattern can match nothing. */
function wildmatchSource(glob: string): string | null {
  const characters = Array.from(glob);
  let source = "";
  let index = 0;
  while (index < characters.length) {
    const character = characters[index]!;
    if (character === "*") {
      let end = index;
      while (characters[end] === "*") end++;
      const doubled = end - index >= 2;
      const opensSegment = index === 0 || characters[index - 1] === "/";
      const closesSegment = end === characters.length || characters[end] === "/";
      if (doubled && opensSegment && closesSegment) {
        if (end === characters.length) { source += "[\\s\\S]*"; index = end; continue; }
        source += "(?:[\\s\\S]*/)?";
        index = end + 1;
        continue;
      }
      source += "[^/]*";
      index = end;
      continue;
    }
    if (character === "?") { source += "[^/]"; index++; continue; }
    if (character === "[") {
      const parsed = bracket(characters, index);
      if (!parsed) return null;
      source += parsed.source;
      index = parsed.next;
      continue;
    }
    if (character === "\\") {
      if (index + 1 >= characters.length) return null;
      source += escapeLiteral(characters[index + 1]!);
      index += 2;
      continue;
    }
    source += escapeLiteral(character);
    index++;
  }
  return source;
}

/** Remove trailing spaces that are not escaped with a backslash. */
function trimTrailingSpaces(line: string): string {
  let end = 0;
  for (let index = 0; index < line.length; index++) {
    if (line[index] === "\\") { index++; end = Math.min(index + 1, line.length); continue; }
    if (line[index] !== " ") end = index + 1;
  }
  return line.slice(0, end);
}

/** One ignore file's rules, in file order. */
function parseIgnoreRules(text: string): Rule[] {
  const rules: Rule[] = [];
  for (const raw of text.replace(/^\uFEFF/, "").split("\n")) {
    const line = trimTrailingSpaces(raw.endsWith("\r") ? raw.slice(0, -1) : raw);
    if (!line || line.startsWith("#")) continue;
    let body = line;
    const negative = body.startsWith("!");
    if (negative) body = body.slice(1);
    const directoryOnly = body.endsWith("/");
    if (directoryOnly) body = body.slice(0, -1);
    if (!body) continue;
    const basename = !body.includes("/");
    if (body.startsWith("/")) body = body.slice(1);
    const source = wildmatchSource(body);
    if (source === null) continue;
    rules.push({ pattern: line, negative, directoryOnly, basename, regex: new RegExp(`^${source}$`, "u") });
  }
  return rules;
}

function ruleMatches(rule: Rule, relativePath: string, isDirectory: boolean): boolean {
  if (rule.directoryOnly && !isDirectory) return false;
  if (rule.basename) return rule.regex.test(relativePath.slice(relativePath.lastIndexOf("/") + 1));
  return rule.regex.test(relativePath);
}

function segmentsOf(treePath: string): string[] {
  return treePath.split("/").filter(Boolean);
}

function treePathOf(segments: readonly string[]): string {
  return `/${segments.join("/")}`;
}

/**
 * One operation's view of a folder's membership. Rule files are read once, on
 * first use beneath their directory, and never re-read: load a new policy to
 * see edits. Paths are tree paths (`/a/b`) relative to `root`.
 */
export class IgnorePolicy {
  readonly diagnostics: Diagnostic[] = [];
  private readonly files = new Map<string, Promise<RuleFile[]>>();
  private readonly chains = new Map<string, Promise<ChainedRules[]>>();
  private readonly directories = new Map<string, Promise<IgnoreDecision>>();

  constructor(
    readonly root: string,
    private readonly excluded: readonly string[],
    private readonly read?: IgnoreFileReader,
  ) {}

  /** Whether `treePath` is tree content, never tree content, or kept out by a user rule. */
  async decision(treePath: string, isDirectory: boolean): Promise<IgnoreDecision> {
    const segments = segmentsOf(treePath);
    if (!segments.length) return INCLUDED;
    if (this.mandatory(segments, isDirectory)) return MANDATORY;
    return this.ruled(segments, isDirectory);
  }

  private mandatory(segments: readonly string[], isDirectory: boolean): boolean {
    const path = treePathOf(segments);
    if (this.excluded.some((excluded) => path === excluded || path.startsWith(`${excluded}/`))) return true;
    return segments.some((name, index) =>
      isTransactionTemporaryName(name)
      || isCloudPlaceholderName(name)
      || isPlatformMetadataName(name)
      || ((index < segments.length - 1 || isDirectory) && MANDATORY_DIRECTORY_NAMES.has(name))
    );
  }

  private async ruled(segments: readonly string[], isDirectory: boolean): Promise<IgnoreDecision> {
    if (segments.length > 1) {
      const parent = await this.directory(segments.slice(0, -1));
      if (parent.membership !== "included") return parent;
    }
    if (!isDirectory && isIgnoreFileName(segments.at(-1)!)) return INCLUDED;
    // Deeper files override shallower ones, and within a file the last matching rule wins.
    const chain = await this.chain(segments.slice(0, -1));
    for (let index = chain.length - 1; index >= 0; index--) {
      const { depth, file } = chain[index]!;
      const relativePath = segments.slice(depth).join("/");
      for (let ruleIndex = file.rules.length - 1; ruleIndex >= 0; ruleIndex--) {
        const rule = file.rules[ruleIndex]!;
        if (!ruleMatches(rule, relativePath, isDirectory)) continue;
        return rule.negative ? INCLUDED : { membership: "ignored", source: file.source, pattern: rule.pattern };
      }
    }
    return INCLUDED;
  }

  /** The rule files that apply within a directory, shallowest first, each with the depth it applies from. */
  private chain(segments: readonly string[]): Promise<ChainedRules[]> {
    const key = treePathOf(segments);
    let chain = this.chains.get(key);
    if (!chain) {
      const parent = segments.length ? this.chain(segments.slice(0, -1)) : Promise.resolve([]);
      chain = Promise.all([parent, this.rulesIn(segments)]).then(([above, own]) =>
        own.length ? [...above, ...own.map((file) => ({ depth: segments.length, file }))] : above
      );
      this.chains.set(key, chain);
    }
    return chain;
  }

  private directory(segments: readonly string[]): Promise<IgnoreDecision> {
    const key = treePathOf(segments);
    let decision = this.directories.get(key);
    if (!decision) {
      decision = this.ruled(segments, true);
      this.directories.set(key, decision);
    }
    return decision;
  }

  private rulesIn(segments: readonly string[]): Promise<RuleFile[]> {
    const key = treePathOf(segments);
    let files = this.files.get(key);
    if (!files) {
      files = Promise.all(IGNORE_FILE_NAMES.map((name) => this.readRules([...segments, name])))
        .then((loaded) => loaded.filter((file): file is RuleFile => file !== null));
      this.files.set(key, files);
    }
    return files;
  }

  private async readRules(segments: readonly string[]): Promise<RuleFile | null> {
    const source = treePathOf(segments);
    const absolute = join(this.root, ...segments);
    let bytes: Uint8Array;
    try {
      if (this.read) {
        const read = await this.read(source);
        if (!read) return null;
        bytes = read;
      } else {
        // A symbolic link is not tree content, so its target contributes no rules.
        if (!(await lstat(absolute)).isFile()) return null;
        bytes = await readFile(absolute);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return null;
      this.diagnostics.push({
        code: "ignore-file-unreadable",
        path: source,
        severity: "warning",
        message: `${source} could not be read, so none of its ignore rules apply.`,
      });
      return null;
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      this.diagnostics.push({
        code: "ignore-file-not-utf8",
        path: source,
        severity: "warning",
        message: `${source} is not valid UTF-8, so none of its ignore rules apply.`,
      });
      return null;
    }
    return { source, rules: parseIgnoreRules(text) };
  }
}

/** An ignore file's bytes by tree path, or null when there is none. */
export type IgnoreFileReader = (treePath: string) => Promise<Uint8Array | null>;

/**
 * Load a folder's membership policy for one operation. `excludedRoots` are
 * nested tree mounts: absolute paths whose content belongs to another tree.
 * `read` takes ignore files from elsewhere than the folder, such as a root
 * about to be written to it.
 */
export async function loadIgnorePolicy(
  path: string,
  options: { excludedRoots?: readonly string[]; read?: IgnoreFileReader } = {},
): Promise<IgnorePolicy> {
  const root = await realpath(path);
  const excluded: string[] = [];
  for (const item of options.excludedRoots ?? []) {
    const absolute = await realpath(item).catch(() => resolve(item));
    const remainder = relative(root, absolute);
    if (!remainder || remainder === ".." || remainder.startsWith(`..${sep}`)) continue;
    excluded.push(`/${remainder.split(sep).join("/")}`);
  }
  return new IgnorePolicy(root, excluded, options.read);
}

/**
 * Whether a walk leaves out a path, by tree path relative to the walked root.
 * `snapshotDirectory` and `materializeTree` call it only for ordinary entries
 * they would otherwise include or delete.
 */
export type SkipPath = (treePath: string, isDirectory: boolean) => Promise<boolean>;

/** Whether a path of that kind is in the root a folder last held; tracked paths stay synchronized when a rule matches them. */
export type TrackedLookup = (treePath: string, isDirectory: boolean) => Promise<boolean>;

/**
 * The walk filter for a policy: an ignored path is left out unless it is
 * tracked. Tracked is asked only for ignored paths, so an ordinary walk loads
 * nothing extra. `prefix` is the walked root's tree path under the policy's
 * root.
 */
export function membershipSkip(policy: IgnorePolicy, tracked: TrackedLookup | null, prefix = "/"): SkipPath {
  const base = segmentsOf(prefix);
  return async (treePath, isDirectory) => {
    const path = treePathOf([...base, ...segmentsOf(treePath)]);
    const { membership } = await policy.decision(path, isDirectory);
    if (membership === "included") return false;
    if (membership === "mandatory") return true;
    return !(tracked && await tracked(path, isDirectory));
  };
}

/**
 * Tracked paths of `root`: an entry of the same kind at the path. A file that
 * became a directory (or the reverse) is a new, untracked entry. Directory
 * objects are loaded on demand and remembered for this lookup's lifetime.
 */
export function trackedEntries(root: ObjectHash, load: (hash: ObjectHash) => Promise<Uint8Array>): TrackedLookup {
  const entryAt = entries(root, load);
  return async (treePath, isDirectory) => {
    const entry = await entryAt(treePath);
    return isDirectory ? entry?.directory !== undefined : entry?.file !== undefined;
  };
}

/** Ignore files as a root holds them, for the policy a folder will have once that root is written. */
export function ignoreFilesIn(root: ObjectHash, load: (hash: ObjectHash) => Promise<Uint8Array>): IgnoreFileReader {
  const entryAt = entries(root, load);
  return async (treePath) => {
    const entry = await entryAt(treePath);
    return entry?.file === undefined ? null : load(entry.file as ObjectHash);
  };
}

/** The entry at a tree path beneath `root`, loading and remembering directories on demand. */
function entries(root: ObjectHash, load: (hash: ObjectHash) => Promise<Uint8Array>): (treePath: string) => Promise<ProtocolDirectoryEntry | undefined> {
  const directories = new Map<ObjectHash, Promise<Map<string, ProtocolDirectoryEntry>>>();
  const children = (hash: ObjectHash) => {
    let entries = directories.get(hash);
    if (!entries) {
      entries = load(hash).then((bytes) => {
        const object = decodeProtocolDirectory(bytes);
        if (object.type !== "directory") throw new Error(`Expected a directory: ${hash}`);
        return new Map(object.entries.map((entry) => [entry.name, entry]));
      });
      entries.catch(() => directories.delete(hash));
      directories.set(hash, entries);
    }
    return entries;
  };
  return async (treePath) => {
    let entry: ProtocolDirectoryEntry | undefined = { name: "", directory: root };
    for (const name of segmentsOf(treePath)) {
      if (!entry?.directory) return undefined;
      entry = (await children(entry.directory as ObjectHash)).get(name);
    }
    return entry;
  };
}
