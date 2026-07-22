import { mkdir, readFile, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, join, relative, posix } from "node:path";
import * as watcher from "@parcel/watcher";
import type {
  ArborBlock,
  CollectionPage,
  NodeWriteRequest,
  SearchResult,
  TreeChild,
  TreeNode,
} from "@arbor/core";
import { canonicalNodePath, ensureContainedPath, markdownTreePath, nodeDisplayName, nodePathFromPhysical, normalizeTreePath, resolveTreePath, revisionOf, sha256, toTreePath } from "@arbor/core";
import { mintPageID, parseMarkdown, serializeMarkdown } from "@arbor/editor";
import { CollectionStore, WorkspaceIndex, workspaceStateDirectory } from "@arbor/stores";
import { EventBus } from "./events.ts";
import { moveCollisionSafe, writeAtomic } from "./file-ops.ts";
import { WriteJournal } from "./journal.ts";

const RESERVED = new Set(["schema.ts", "_store.csv", "_store.jsonl", "_store.postgres", "_store.sqlite3"]);
const IGNORED = new Set([".git", "node_modules", ".arbor", "Trash"]);
const EMPTY_REVISION = revisionOf("");
type FileInfo = Awaited<ReturnType<typeof stat>>;

interface ResolvedPhysicalNode {
  path: string;
  absolute: string;
  info: FileInfo | null;
  representation: "directory" | "markdown" | "file" | "missing";
  collision: boolean;
}

export class RevisionConflictError extends Error {
  constructor(public current: TreeNode) { super("The file changed since it was opened"); }
}

export class Workspace implements AsyncDisposable {
  readonly root: string;
  readonly events = new EventBus();
  private stateDirectory!: string;
  private index!: WorkspaceIndex;
  private journal!: WriteJournal;
  private collections = new CollectionStore();
  private subscription?: watcher.AsyncSubscription;
  private ownWrites = new Map<string, string>();
  private knownIDs = new Set<string>();
  private idOwners = new Map<string, string>();
  private healingTimers = new Map<string, ReturnType<typeof setTimeout>>();

  private constructor(root: string) { this.root = root; }

  static async open(path: string): Promise<Workspace> {
    const root = await realpath(path);
    const info = await stat(root);
    if (!info.isDirectory()) throw new Error("arbor dev requires a directory");
    const workspace = new Workspace(root);
    await workspace.initialize();
    return workspace;
  }

  async node(inputPath: string): Promise<TreeNode> {
    const resolved = await this.resolvePhysicalNode(inputPath);
    const treePath = resolved.path;
    const { absolute, info } = resolved;
    if (!info) {
      const virtual = await this.postgresVirtualNode(treePath);
      if (virtual) return virtual;
      throw new Error(`Node not found: ${treePath}`);
    }
    if (info.isDirectory()) return this.directoryNode(treePath, absolute, resolved.collision);
    const source = await readFile(absolute);
    const materialization = basename(absolute).endsWith(".icloud") ? "placeholder" as const : "available" as const;
    if (extname(absolute).toLowerCase() !== ".md") {
      return {
        path: treePath,
        name: nodeDisplayName(treePath),
        kind: "file",
        revision: revisionOf(source),
        writable: materialization === "available",
        materialization,
        diagnostics: [],
      };
    }
    const text = source.toString("utf8");
    let document = parseMarkdown(text);
    const pageID = typeof document.frontmatter.id === "string" && /^[a-z0-9]{6}$/.test(document.frontmatter.id) ? document.frontmatter.id : null;
    if (pageID) {
      const existingOwner = this.idOwners.get(pageID);
      if (!existingOwner) this.idOwners.set(pageID, treePath);
      const reconciled = await this.journal.reconcile(pageID, document.blocks, Number(info.mtimeMs) / 1_000);
      if (reconciled.restored) {
        const repaired = serializeMarkdown(document, reconciled.blocks);
        await writeAtomic(absolute, repaired);
        await this.journal.markMaterialized(pageID);
        document = parseMarkdown(repaired);
      }
      this.scheduleLinkHealing(treePath, revisionOf(text), document);
    }
    return {
      path: treePath,
      name: nodeDisplayName(treePath),
      kind: "markdown",
      revision: revisionOf(text),
      writable: materialization === "available",
      materialization,
      document,
      diagnostics: [
        ...(resolved.collision ? [{ code: "duplicate-node-representation", message: `${treePath} exists as both ${treePath}.md and ${treePath}/; keep only one representation.`, path: treePath, severity: "error" as const }] : []),
        ...(pageID && this.idOwners.get(pageID) !== treePath ? [{ code: "duplicate-page-id", message: `Page ID ${pageID} is also used by ${this.idOwners.get(pageID)}`, path: treePath, severity: "error" as const }] : []),
      ],
    };
  }

  async collection(inputPath: string, cursor = 0, limit = 100, table?: string): Promise<CollectionPage> {
    const treePath = canonicalNodePath(inputPath);
    let absolute = await ensureContainedPath(this.root, treePath);
    try {
      if (!(await stat(absolute)).isDirectory()) throw new Error("Collection path is not a directory");
    } catch {
      const parentPath = treePath.slice(0, treePath.lastIndexOf("/")) || "/";
      absolute = resolveTreePath(this.root, parentPath);
      table ??= treePath.slice(treePath.lastIndexOf("/") + 1);
    }
    return this.collections.page(absolute, treePath, cursor, limit, table);
  }

  search(query: string, limit = 30): SearchResult[] { return this.index.search(query, limit); }

  async write(inputPath: string, request: NodeWriteRequest): Promise<TreeNode> {
    const resolved = await this.resolvePhysicalNode(inputPath);
    const treePath = resolved.path;
    if (resolved.collision) throw new Error(`${treePath} has both a .md file and a same-named directory; resolve the duplicate before editing`);
    let absolute = resolved.absolute;
    if (resolved.representation === "directory") absolute = join(absolute, "_index.md");
    else if (resolved.representation === "missing") absolute = resolveTreePath(this.root, markdownTreePath(treePath));
    else if (resolved.representation !== "markdown") throw new Error("Only Markdown nodes are editable");
    let source = "";
    try { source = await readFile(absolute, "utf8"); } catch {}
    const currentRevision = revisionOf(source);
    if (request.baseRevision !== currentRevision) throw new RevisionConflictError(await this.node(treePath));
    const document = parseMarkdown(source);
    const patch = { ...(request.frontmatterPatch ?? {}) };
    let pageID = typeof document.frontmatter.id === "string" ? document.frontmatter.id : undefined;
    if (!pageID || !/^[a-z0-9]{6}$/.test(pageID)) {
      pageID = mintPageID(this.knownIDs);
      patch.id = pageID;
      this.knownIDs.add(pageID);
      this.idOwners.set(pageID, treePath);
    }
    await this.journal.commit(pageID, document.blocks, request.blocks);
    const output = serializeMarkdown(document, request.blocks, patch);
    await writeAtomic(absolute, output);
    await this.journal.markMaterialized(pageID);
    const revision = revisionOf(output);
    this.ownWrites.set(treePath, revision);
    await this.index.updateAbsolute(absolute);
    this.events.emit({ type: source ? "updated" : "created", path: treePath, revision, classification: "echo" });
    return this.node(treePath);
  }

  async delete(inputPath: string): Promise<{ trashPath: string }> {
    const resolved = await this.resolvePhysicalNode(inputPath);
    const treePath = resolved.path;
    if (treePath === "/" || treePath.startsWith("/Trash/")) throw new Error("This node cannot be trashed");
    if (resolved.collision) throw new Error(`${treePath} has two physical representations; resolve the duplicate before deleting`);
    if (!resolved.info) throw new Error(`Node not found: ${treePath}`);
    const absolute = resolved.absolute;
    const destination = resolved.representation === "markdown" || resolved.representation === "directory"
      ? await this.availableLogicalDestination(`/Trash${treePath}`, resolved.representation)
      : resolveTreePath(this.root, `/Trash${toTreePath(this.root, absolute)}`);
    const moved = await moveCollisionSafe(absolute, destination);
    const trashPath = nodePathFromPhysical(toTreePath(this.root, moved));
    this.events.emit({ type: "deleted", path: treePath });
    return { trashPath };
  }

  async restore(trashPathInput: string): Promise<{ path: string }> {
    const resolved = await this.resolvePhysicalNode(trashPathInput);
    const trashPath = resolved.path;
    if (!trashPath.startsWith("/Trash/")) throw new Error("Restore path must be inside Trash");
    if (resolved.collision) throw new Error(`${trashPath} has two physical representations; resolve the duplicate before restoring`);
    if (!resolved.info) throw new Error(`Trash node not found: ${trashPath}`);
    const source = resolved.absolute;
    const destinationPath = trashPath.slice("/Trash".length);
    const destination = resolved.representation === "markdown" || resolved.representation === "directory"
      ? await this.availableLogicalDestination(destinationPath, resolved.representation)
      : resolveTreePath(this.root, destinationPath);
    const moved = await moveCollisionSafe(source, destination);
    const path = nodePathFromPhysical(toTreePath(this.root, moved));
    this.events.emit({ type: "created", path });
    return { path };
  }

  async addAsset(directoryInput: string, filename: string, bytes: Uint8Array): Promise<{ path: string; markdownPath: string }> {
    const directoryPath = normalizeTreePath(directoryInput || "/");
    const pageDirectory = resolveTreePath(this.root, directoryPath);
    const extension = extname(filename).toLowerCase().replace(/[^a-z0-9.]/g, "");
    const safeName = `${sha256(bytes).slice(0, 16)}${extension}`;
    const absolute = join(this.root, "Assets", safeName);
    try { await stat(absolute); } catch { await writeAtomic(absolute, bytes); }
    const markdownPath = relative(pageDirectory, absolute).split("/").join("/");
    return { path: toTreePath(this.root, absolute), markdownPath };
  }

  async recovery(inputPath: string) {
    const node = await this.node(inputPath);
    if (!node.document) throw new Error("Recovery is available only for Markdown nodes");
    const pageID = node.document.frontmatter.id;
    if (typeof pageID !== "string") return [];
    return this.journal.list(pageID, node.document.blocks);
  }

  async restoreBlock(inputPath: string, hash: string): Promise<TreeNode> {
    const node = await this.node(inputPath);
    if (!node.document || typeof node.document.frontmatter.id !== "string") throw new Error("Page has no durable identity");
    const blocks = await this.journal.restore(node.document.frontmatter.id, hash, node.document.blocks);
    return this.write(inputPath, { baseRevision: node.revision, blocks });
  }

  async generateTypes(): Promise<void> {
    const imports: string[] = [];
    const declarations: string[] = [];
    const mappings: string[] = [];
    let schemaIndex = 0;
    let databaseIndex = 0;
    let temporaryFailure = false;
    const walk = async (directory: string) => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (!entry.isDirectory() || IGNORED.has(entry.name)) continue;
        const absolute = join(directory, entry.name);
        const summary = await this.collections.summary(absolute).catch(() => { temporaryFailure = true; return null; });
        if (summary) {
          const treePath = toTreePath(this.root, absolute);
          const schemaPath = join(absolute, "schema.ts");
          if (summary.backing === "postgres") {
            try {
              const schema = await this.collections.postgresSchema(absolute);
              const name = `PostgresDatabase${databaseIndex++}`;
              declarations.push(`interface ${name} {`);
              for (const [table, columns] of Object.entries(schema)) {
                declarations.push(`  ${JSON.stringify(table)}: { ${Object.entries(columns).map(([column, type]) => `${JSON.stringify(column)}: ${type}`).join("; ")} };`);
                mappings.push(`    ${JSON.stringify(`${treePath}/${table}`)}: Collection<${name}[${JSON.stringify(table)}]>;`);
              }
              declarations.push("}");
              mappings.push(`    ${JSON.stringify(treePath)}: Database<${name}>;`);
            } catch {
              temporaryFailure = true;
              mappings.push(`    ${JSON.stringify(treePath)}: Database<Record<string, Record<string, unknown>>>;`);
            }
          } else {
            try {
              await stat(schemaPath);
              const name = `Schema${schemaIndex++}`;
              imports.push(`import type { schema as ${name} } from ${JSON.stringify(`../${relative(this.root, schemaPath).split("/").join("/")}`)};`);
              mappings.push(`    ${JSON.stringify(treePath)}: Collection<z.infer<typeof ${name}>>;`);
            } catch { mappings.push(`    ${JSON.stringify(treePath)}: Collection<Record<string, unknown>>;`); }
          }
        }
        await walk(absolute);
      }
    };
    await walk(this.root);
    const source = [
      "// Generated by arbor dev. Do not edit.",
      'import type { z } from "zod";',
      ...imports,
      "type Collection<T> = { readonly __row?: T };",
      "type Database<T> = { readonly __tables?: T };",
      ...declarations,
      'declare module "arbor/runtime" {',
      "  interface TreeRegistry {",
      ...mappings,
      "  }",
      "}",
      "export {};",
      "",
    ].join("\n");
    const target = join(this.root, ".arbor", "tree.gen.d.ts");
    if (temporaryFailure) {
      try { await stat(target); return; } catch {}
    }
    await mkdir(join(this.root, ".arbor"), { recursive: true });
    await writeAtomic(target, source);
  }

  async [Symbol.asyncDispose](): Promise<void> {
    for (const timer of this.healingTimers.values()) clearTimeout(timer);
    await this.subscription?.unsubscribe();
    this.index.close();
  }

  private async initialize(): Promise<void> {
    this.stateDirectory = await workspaceStateDirectory(this.root);
    this.journal = new WriteJournal(join(this.stateDirectory, "journal"));
    this.index = new WorkspaceIndex(this.root, join(this.stateDirectory, "index.sqlite"));
    await Promise.all([this.index.rebuild(), this.scanIDs()]);
    await this.generateTypes();
    this.subscription = await watcher.subscribe(this.root, async (error, events) => {
      if (error) { this.events.emit({ type: "diagnostic", path: "/" }); return; }
      for (const event of events) await this.handleWatch(event.path, event.type);
    }, { ignore: ["**/.git/**", "**/node_modules/**", "**/.arbor/**", "**/Trash/**"] });
  }

  private async resolvePhysicalNode(inputPath: string): Promise<ResolvedPhysicalNode> {
    const path = canonicalNodePath(inputPath);
    const direct = await ensureContainedPath(this.root, path);
    let directInfo: FileInfo | null = null;
    try { directInfo = await stat(direct); } catch {}
    if (path === "/") return { path, absolute: direct, info: directInfo, representation: directInfo?.isDirectory() ? "directory" : directInfo ? "file" : "missing", collision: false };

    const markdownPath = markdownTreePath(path);
    const markdown = await ensureContainedPath(this.root, markdownPath);
    let markdownInfo: FileInfo | null = null;
    try { markdownInfo = await stat(markdown); } catch {}
    const collision = Boolean(directInfo && markdownInfo);
    if (directInfo) {
      return { path, absolute: direct, info: directInfo, representation: directInfo.isDirectory() ? "directory" : "file", collision };
    }
    if (markdownInfo) return { path, absolute: markdown, info: markdownInfo, representation: "markdown", collision: false };
    return { path, absolute: direct, info: null, representation: "missing", collision: false };
  }

  private async availableLogicalDestination(inputPath: string, representation: "markdown" | "directory"): Promise<string> {
    const base = canonicalNodePath(inputPath);
    const slash = base.lastIndexOf("/");
    const parent = base.slice(0, slash) || "/";
    const name = base.slice(slash + 1);
    for (let suffix = 1; ; suffix += 1) {
      const candidate = `${parent === "/" ? "" : parent}/${name}${suffix === 1 ? "" : `-${suffix}`}`;
      const direct = resolveTreePath(this.root, candidate);
      const markdown = resolveTreePath(this.root, markdownTreePath(candidate));
      let occupied = false;
      try { await stat(direct); occupied = true; } catch {}
      try { await stat(markdown); occupied = true; } catch {}
      if (!occupied) return representation === "markdown" ? markdown : direct;
    }
  }

  private async directoryNode(treePath: string, absolute: string, collision = false): Promise<TreeNode> {
    const collection = await this.collections.summary(absolute).catch(() => null);
    const indexPath = join(absolute, "_index.md");
    let source = "";
    let indexMtime = 0;
    try {
      source = await readFile(indexPath, "utf8");
      indexMtime = (await stat(indexPath)).mtimeMs / 1_000;
    } catch {}
    let document = parseMarkdown(source);
    const pageID = typeof document.frontmatter.id === "string" && /^[a-z0-9]{6}$/.test(document.frontmatter.id) ? document.frontmatter.id : null;
    if (pageID) {
      const existingOwner = this.idOwners.get(pageID);
      if (!existingOwner) this.idOwners.set(pageID, treePath);
      const reconciled = await this.journal.reconcile(pageID, document.blocks, indexMtime);
      if (reconciled.restored) {
        const repaired = serializeMarkdown(document, reconciled.blocks);
        await writeAtomic(indexPath, repaired);
        await this.journal.markMaterialized(pageID);
        source = repaired;
        document = parseMarkdown(repaired);
      }
      this.scheduleLinkHealing(treePath, revisionOf(source), document);
    }
    const listing = await this.directoryChildren(treePath, absolute, collection?.tables ?? []);
    return {
      path: treePath,
      name: treePath === "/" ? basename(this.root) : nodeDisplayName(treePath),
      kind: collection ? "collection" : "directory",
      revision: revisionOf(source),
      writable: true,
      materialization: "available",
      document,
      children: listing.children,
      collection: collection ?? undefined,
      diagnostics: [
        ...(collision ? [{ code: "duplicate-node-representation", message: `${treePath} exists as both ${treePath}.md and ${treePath}/; keep only one representation.`, path: treePath, severity: "error" as const }] : []),
        ...(pageID && this.idOwners.get(pageID) !== treePath ? [{ code: "duplicate-page-id", message: `Page ID ${pageID} is also used by ${this.idOwners.get(pageID)}`, path: treePath, severity: "error" as const }] : []),
        ...listing.diagnostics,
      ],
    };
  }

  private async directoryChildren(treePath: string, absolute: string, virtualTables: string[]): Promise<{ children: TreeChild[]; diagnostics: TreeNode["diagnostics"] }> {
    const entries = await readdir(absolute, { withFileTypes: true });
    const childrenByPath = new Map<string, TreeChild>();
    const diagnostics: TreeNode["diagnostics"] = [];
    for (const entry of entries.filter((entry) => !IGNORED.has(entry.name) && !RESERVED.has(entry.name) && entry.name !== "_index.md")) {
      const physicalPath = `${treePath === "/" ? "" : treePath}/${entry.name}`;
      const path = entry.isFile() && entry.name.endsWith(".md") ? canonicalNodePath(physicalPath) : normalizeTreePath(physicalPath);
      const isPlaceholder = entry.name.endsWith(".icloud");
      let kind: TreeChild["kind"] = entry.isDirectory() ? "directory" : entry.name.endsWith(".md") ? "markdown" : "file";
      if (entry.isDirectory() && await this.collections.summary(join(absolute, entry.name)).catch(() => null)) kind = "collection";
      const child = { name: nodeDisplayName(path), path, kind, materialization: isPlaceholder ? "placeholder" : "available" } satisfies TreeChild;
      const existing = childrenByPath.get(path);
      if (existing) {
        diagnostics.push({ code: "duplicate-node-representation", message: `${path} exists as both ${path}.md and ${path}/; keep only one representation.`, path, severity: "error" });
        if (kind === "directory" || kind === "collection") childrenByPath.set(path, child);
      } else childrenByPath.set(path, child);
    }
    for (const table of virtualTables) {
      const path = `${treePath === "/" ? "" : treePath}/${table}`;
      childrenByPath.set(path, { name: table, path, kind: "collection", materialization: "available" });
    }
    return { children: [...childrenByPath.values()].sort((a, b) => a.name.localeCompare(b.name)), diagnostics };
  }

  private async postgresVirtualNode(treePath: string): Promise<TreeNode | null> {
    const slash = treePath.lastIndexOf("/");
    if (slash <= 0) return null;
    const parentPath = treePath.slice(0, slash) || "/";
    const table = treePath.slice(slash + 1);
    const parent = resolveTreePath(this.root, parentPath);
    const summary = await this.collections.summary(parent).catch(() => null);
    if (summary?.backing !== "postgres" || !summary.tables?.includes(table)) return null;
    return {
      path: treePath,
      name: table,
      kind: "collection",
      revision: EMPTY_REVISION,
      writable: false,
      materialization: "available",
      collection: { ...summary, tables: undefined },
      diagnostics: [],
    };
  }

  private async scanIDs(): Promise<void> {
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (IGNORED.has(entry.name)) continue;
        const absolute = join(directory, entry.name);
        if (entry.isDirectory()) await walk(absolute);
        else if (entry.isFile() && entry.name.endsWith(".md")) {
          try {
            const id = parseMarkdown(await readFile(absolute, "utf8")).frontmatter.id;
            if (typeof id === "string" && /^[a-z0-9]{6}$/.test(id)) {
              this.knownIDs.add(id);
              if (!this.idOwners.has(id)) this.idOwners.set(id, nodePathFromPhysical(toTreePath(this.root, absolute)));
            }
          } catch {}
        }
      }
    };
    await walk(this.root);
  }

  private async handleWatch(absolute: string, type: watcher.EventType): Promise<void> {
    let treePath: string;
    try { treePath = nodePathFromPhysical(toTreePath(this.root, absolute)); } catch { return; }
    await this.index.updateAbsolute(absolute);
    let revision: string | undefined;
    try { revision = revisionOf(await readFile(absolute)); } catch {}
    const expected = this.ownWrites.get(treePath);
    const classification = expected && expected === revision ? "echo" : expected ? "stomp" : "external";
    if (classification === "echo") this.ownWrites.delete(treePath);
    if (classification === "external" && (absolute.endsWith(".md") || basename(absolute) === "_index.md")) {
      try {
        const document = parseMarkdown(await readFile(absolute, "utf8"));
        const id = document.frontmatter.id;
        if (typeof id === "string" && /^[a-z0-9]{6}$/.test(id)) await this.journal.observe(id, document.blocks);
      } catch {}
    }
    this.events.emit({ type: type === "delete" ? "deleted" : type === "create" ? "created" : "updated", path: treePath, revision, classification });
  }

  private scheduleLinkHealing(treePath: string, revision: string, document: NonNullable<TreeNode["document"]>): void {
    if (this.healingTimers.has(treePath)) return;
    const healBlock = (block: ArborBlock): ArborBlock => {
      if (block.type === "rawMarkdown") return block;
      let changed = false;
      const content = (block.content ?? "").replace(/\]\(([^)#]+)#([a-z0-9]{6})\)/g, (match, oldPath: string, id: string) => {
        const owner = this.idOwners.get(id);
        if (!owner) return match;
        let desired = posix.relative(posix.dirname(treePath), owner);
        if (!desired) desired = posix.basename(owner);
        if (oldPath === desired) return match;
        changed = true;
        return `](${desired}#${id})`;
      });
      const children = block.children.map(healBlock);
      if (children.some((child, index) => child !== block.children[index])) changed = true;
      return changed ? { ...block, content, children } : block;
    };
    const blocks = document.blocks.map(healBlock);
    if (!blocks.some((block, index) => block !== document.blocks[index])) return;
    const timer = setTimeout(async () => {
      this.healingTimers.delete(treePath);
      try { await this.write(treePath, { baseRevision: revision, blocks }); } catch {}
    }, 750);
    this.healingTimers.set(treePath, timer);
  }
}
