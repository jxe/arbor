import { mkdir, readdir, stat } from "node:fs/promises";
import { basename, dirname, join, posix, relative } from "node:path";
import type {
  ArborBlock,
  CollectionPage,
  NodeWriteRequest,
  SearchResult,
  TreeChild,
  TreeNode,
} from "@arbor/core";
import { canonicalNodePath, nodeDisplayName, resolveTreePath, sha256 } from "@arbor/core";
import { type FsEvent, FsConflictError, type FsImportEntry, type FsMutationRequest, WorkspaceFS } from "@arbor/fs";
import { CollectionStore, WorkspaceIndex, workspaceStateDirectory } from "@arbor/stores";
import { EventBus } from "./events.ts";

const EMPTY_REVISION = sha256("");
const PAGE_ID = /^[a-z0-9]{6}$/;

export class RevisionConflictError extends Error {
  constructor(public current: TreeNode) { super("The file changed since it was opened"); }
}

export class Workspace implements AsyncDisposable {
  readonly root: string;
  readonly events = new EventBus();
  readonly fs: WorkspaceFS;
  private stateDirectory: string;
  private index: WorkspaceIndex;
  private collections = new CollectionStore();
  private idOwners = new Map<string, string>();
  private healingTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private unsubscribeFS: () => void;

  private constructor(root: string, stateDirectory: string, fs: WorkspaceFS, index: WorkspaceIndex) {
    this.root = root;
    this.stateDirectory = stateDirectory;
    this.fs = fs;
    this.index = index;
    this.unsubscribeFS = fs.subscribe((event) => { void this.handleFsEvent(event); });
  }

  static async open(path: string): Promise<Workspace> {
    const stateDirectory = await workspaceStateDirectory(path);
    const fs = await WorkspaceFS.open(path, { stateDirectory });
    const index = new WorkspaceIndex(fs.root, join(stateDirectory, "index.sqlite"));
    const workspace = new Workspace(fs.root, stateDirectory, fs, index);
    await Promise.all([index.rebuild(), workspace.scanIDs()]);
    await workspace.generateTypes();
    return workspace;
  }

  async node(inputPath: string): Promise<TreeNode> {
    const read = await this.fs.read(inputPath);
    const resolved = read.node;
    if (resolved.kind === "missing") {
      const virtual = await this.postgresVirtualNode(resolved.path);
      if (virtual) return virtual;
      throw new Error(`Node not found: ${resolved.path}`);
    }

    if (resolved.kind === "file") {
      return {
        path: resolved.path,
        name: nodeDisplayName(resolved.path),
        kind: "file",
        revision: read.byteRevision,
        writable: resolved.writable,
        materialization: resolved.materialization,
        diagnostics: resolved.diagnostics,
      };
    }

    if (resolved.kind === "markdown") {
      const document = read.document!;
      const pageID = this.registerPageID(resolved.path, document.frontmatter.id);
      if (pageID) this.scheduleLinkHealing(resolved.path, read.byteRevision, document);
      return {
        path: resolved.path,
        name: nodeDisplayName(resolved.path),
        kind: "markdown",
        revision: read.byteRevision,
        writable: resolved.writable,
        materialization: resolved.materialization,
        document,
        diagnostics: [
          ...resolved.diagnostics,
          ...this.pageIDDiagnostics(resolved.path, pageID),
        ],
      };
    }

    const collection = await this.collections.summary(resolved.directoryPath!).catch(() => null);
    const children = await this.directoryChildren(resolved.path, collection?.tables ?? []);
    const document = read.document!;
    const pageID = this.registerPageID(resolved.path, document.frontmatter.id);
    if (pageID) this.scheduleLinkHealing(resolved.path, read.byteRevision, document);
    return {
      path: resolved.path,
      name: resolved.path === "/" ? basename(this.root) : nodeDisplayName(resolved.path),
      kind: collection ? "collection" : "directory",
      revision: read.byteRevision,
      writable: resolved.writable,
      materialization: resolved.materialization,
      document,
      children: children.children,
      collection: collection ?? undefined,
      diagnostics: [
        ...resolved.diagnostics,
        ...this.pageIDDiagnostics(resolved.path, pageID),
        ...children.diagnostics,
      ],
    };
  }

  async collection(inputPath: string, cursor = 0, limit = 100, table?: string): Promise<CollectionPage> {
    const treePath = canonicalNodePath(inputPath);
    const resolved = await this.fs.resolve(treePath);
    let absolute = resolved.directoryPath;
    if (!absolute) {
      const parent = await this.fs.resolve(treePath.slice(0, treePath.lastIndexOf("/")) || "/");
      absolute = parent.directoryPath;
      table ??= treePath.slice(treePath.lastIndexOf("/") + 1);
    }
    if (!absolute) throw new Error("Collection path is not a directory");
    return this.collections.page(absolute, treePath, cursor, limit, table);
  }

  search(query: string, limit = 30): SearchResult[] { return this.index.search(query, limit); }

  async write(inputPath: string, request: NodeWriteRequest): Promise<TreeNode> {
    try {
      await this.fs.writeMarkdown(inputPath, request);
      return this.node(inputPath);
    } catch (error) {
      if (error instanceof FsConflictError && error.details.code === "stale-revision") {
        throw new RevisionConflictError(await this.node(inputPath));
      }
      throw error;
    }
  }

  async mutate(request: FsMutationRequest) {
    return this.fs.mutate(request);
  }

  async import(destination: string, entries: FsImportEntry[]) {
    return this.fs.mutate({ operations: [{ op: "import", destination, entries }] });
  }

  async delete(inputPath: string): Promise<{ trashPath: string }> {
    const path = canonicalNodePath(inputPath);
    if (path === "/" || path.startsWith("/Trash/")) throw new Error("This node cannot be trashed");
    await this.fs.mutate({ operations: [{ op: "trash", paths: [path] }] });
    return { trashPath: `/Trash${path}` };
  }

  async restore(trashPathInput: string): Promise<{ path: string }> {
    const trashPath = canonicalNodePath(trashPathInput);
    const result = await this.fs.mutate({ operations: [{ op: "restore", paths: [trashPath] }] });
    return { path: result.changes[0]?.path ?? trashPath.slice("/Trash".length) };
  }

  async addAsset(directoryInput: string, filename: string, bytes: Uint8Array): Promise<{ path: string; markdownPath: string }> {
    const extension = filename.includes(".") ? `.${filename.split(".").pop()!.toLowerCase().replace(/[^a-z0-9]/g, "")}` : "";
    const safeName = `${sha256(bytes).slice(0, 16)}${extension}`;
    const assets = await this.fs.resolve("/Assets");
    if (assets.kind === "missing") await this.fs.mutate({ operations: [{ op: "createDirectory", path: "/Assets" }] });
    const path = `/Assets/${safeName}`;
    const existing = await this.fs.resolve(path);
    if (existing.kind === "missing") await this.fs.mutate({ operations: [{ op: "createFile", path, bytes }] });
    const directory = (await this.fs.resolve(directoryInput)).directoryPath
      ?? dirname((await this.fs.resolve(directoryInput)).bodyPath ?? this.root);
    return { path, markdownPath: relative(directory, resolveTreePath(this.root, path)).split("/").join("/") };
  }

  recovery(inputPath: string) { return this.fs.recovery(inputPath); }

  async restoreBlock(inputPath: string, hash: string): Promise<TreeNode> {
    await this.fs.restoreBlock(inputPath, hash);
    return this.node(inputPath);
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
        if (!entry.isDirectory() || [".git", "node_modules", ".arbor", "Trash"].includes(entry.name)) continue;
        const absolute = join(directory, entry.name);
        const summary = await this.collections.summary(absolute).catch(() => { temporaryFailure = true; return null; });
        if (summary) {
          const treePath = `/${relative(this.root, absolute).split("/").join("/")}`;
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
    await this.fs.writeFile("/.arbor/tree.gen.d.ts", new TextEncoder().encode(source));
  }

  async [Symbol.asyncDispose](): Promise<void> {
    for (const timer of this.healingTimers.values()) clearTimeout(timer);
    this.unsubscribeFS();
    this.index.close();
    await this.fs[Symbol.asyncDispose]();
  }

  private async directoryChildren(treePath: string, virtualTables: string[]): Promise<{ children: TreeChild[]; diagnostics: TreeNode["diagnostics"] }> {
    const entries = await this.fs.list(treePath);
    const children: TreeChild[] = [];
    const diagnostics: TreeNode["diagnostics"] = [];
    for (const entry of entries) {
      let kind: TreeChild["kind"] = entry.kind;
      if (entry.kind === "directory") {
        const resolved = await this.fs.resolve(entry.path);
        if (resolved.directoryPath && await this.collections.summary(resolved.directoryPath).catch(() => null)) kind = "collection";
      }
      children.push({ name: entry.name, path: entry.path, kind, materialization: entry.materialization });
      diagnostics.push(...entry.diagnostics);
    }
    for (const table of virtualTables) {
      const path = `${treePath === "/" ? "" : treePath}/${table}`;
      children.push({ name: table, path, kind: "collection", materialization: "available" });
    }
    return { children: children.sort((a, b) => a.name.localeCompare(b.name)), diagnostics };
  }

  private async postgresVirtualNode(treePath: string): Promise<TreeNode | null> {
    const slash = treePath.lastIndexOf("/");
    if (slash <= 0) return null;
    const parentPath = treePath.slice(0, slash) || "/";
    const table = treePath.slice(slash + 1);
    const parent = await this.fs.resolve(parentPath);
    if (!parent.directoryPath) return null;
    const summary = await this.collections.summary(parent.directoryPath).catch(() => null);
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

  private registerPageID(path: string, candidate: unknown): string | null {
    if (typeof candidate !== "string" || !PAGE_ID.test(candidate)) return null;
    if (!this.idOwners.has(candidate)) this.idOwners.set(candidate, path);
    return candidate;
  }

  private pageIDDiagnostics(path: string, pageID: string | null): TreeNode["diagnostics"] {
    return pageID && this.idOwners.get(pageID) !== path
      ? [{ code: "duplicate-page-id", message: `Page ID ${pageID} is also used by ${this.idOwners.get(pageID)}`, path, severity: "error" }]
      : [];
  }

  private async scanIDs(): Promise<void> {
    const walk = async (path: string): Promise<void> => {
      const node = await this.fs.read(path);
      const id = node.document?.frontmatter.id;
      if (typeof id === "string" && PAGE_ID.test(id) && !this.idOwners.has(id)) this.idOwners.set(id, path);
      if (node.node.kind === "directory") {
        for (const child of await this.fs.list(path)) {
          if (child.kind === "markdown" || child.kind === "directory") await walk(child.path);
        }
      }
    };
    await walk("/");
  }

  private async handleFsEvent(event: FsEvent): Promise<void> {
    const updateIndex = async (path: string) => {
      const resolved = await this.fs.resolve(path);
      const absolute = resolved.kind === "directory" ? resolved.bodyPath : resolved.kind === "markdown" ? resolved.bodyPath : resolved.absolutePath;
      if (absolute) await this.index.updateAbsolute(absolute);
      else if (event.previousPath) {
        const oldBody = resolveTreePath(this.root, `${event.previousPath}.md`);
        await this.index.updateAbsolute(oldBody);
      }
    };
    if (event.type === "batch") {
      await this.index.rebuild().catch(() => {});
      await this.generateTypes().catch(() => {});
    } else if (event.type === "moved" || event.type === "deleted") await this.index.rebuild().catch(() => {});
    else if (event.type !== "diagnostic") await updateIndex(event.path).catch(() => {});
    this.events.emit({
      type: event.type,
      path: event.path,
      previousPath: event.previousPath,
      revision: event.byteRevision,
      classification: event.classification,
      changes: event.changes,
    });
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
