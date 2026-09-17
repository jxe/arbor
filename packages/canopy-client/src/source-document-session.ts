import { canonicalCBORHash } from "@arbor/core";
import { decodeTreeSnapshotJSON, decodeWireDirectory, type TreeSnapshot, type WireClient } from "@arbor/wire";
import { prepareSourceAdmission, SourceAdmissionQueue, type SourceAdmissionBasis, type SourceAdmissionIntent,
  type SourceAdmissionRecord } from "./source-admission-queue.ts";
import { SourceAdmissionPublisher } from "./source-admission-publisher.ts";

type Document = SourceAdmissionIntent["basis"];
type Revision = { tree: string; path: string; sourcePath: string; root: string; basis: SourceAdmissionBasis };
const prefix = "source-basis:";
function source(graph: TreeSnapshot, path: string): string {
  const parts = path.slice(1).split("/");
  if (!path.startsWith("/") || parts.some(part => !part || part === "." || part === "..")) throw new Error("Invalid source path");
  let hash = graph.root;
  for (let index = 0; index < parts.length; index++) {
    const entry = decodeWireDirectory(graph.objects.get(hash)!).entries.find(entry => entry.name === parts[index]);
    if (!entry && index === parts.length - 1 && parts[index] === "_index.md") return "";
    if (!entry) throw new Error("Source is missing from basis");
    if (index === parts.length - 1) {
      if (!entry.file || !graph.objects.has(entry.file)) throw new Error("Source bytes unavailable");
      return new TextDecoder("utf8", { fatal: true, ignoreBOM: true }).decode(graph.objects.get(entry.file));
    }
    if (!entry.directory) throw new Error("Source crosses a tree boundary");
    hash = entry.directory;
  }
  throw new Error("Invalid source path");
}

/** Document admission bound to immutable accepted or authored material, never
 * to a mutable current revision. Logical and physical paths remain distinct.
 * The caller owns scheduling the shared publisher after durable acknowledgement.
 */
export class SourceDocumentSession {
  readonly admissionPolicy = "retainedBasis" as const;
  private readonly captured = new Map<string, TreeSnapshot>();
  private readonly prepared = new Map<string, SourceAdmissionRecord>();
  constructor(private readonly queue: SourceAdmissionQueue,
    private readonly publisher: SourceAdmissionPublisher,
    private readonly transport: Pick<WireClient, "descriptor" | "snapshot">,
    readonly path: string, readonly sourcePath: string) {
    if (publisher.queue.path !== queue.path || publisher.queue.tree !== queue.tree) throw new Error("Session publisher has a different queue");
  }

  private document(graph: TreeSnapshot, basis: SourceAdmissionBasis): Document {
    const revision: Revision = { tree: this.queue.tree, path: this.path, sourcePath: this.sourcePath, root: graph.root, basis };
    const token = prefix + Buffer.from(JSON.stringify(revision)).toString("base64url");
    this.captured.set(token, structuredClone(graph));
    return { tree: this.queue.tree, path: this.path, source: source(graph, this.sourcePath), revision: token };
  }

  async snapshot(): Promise<Document> {
    const pending = new Set(await this.publisher.pending());
    const local = (await this.queue.retained()).findLast(record => pending.has(record.change) && record.sourcePath === this.sourcePath);
    if (local) return this.document(decodeTreeSnapshotJSON(local.candidate), { kind: "authored", change: local.change });
    const current = await this.transport.descriptor(this.queue.tree);
    if (current.tree.id !== this.queue.tree || !current.tree.update) throw new Error("Wrong source tree");
    const graph = await this.transport.snapshot(this.queue.tree, current.tree.root);
    if (graph.root !== current.tree.root) throw new Error("Wrong source graph");
    return this.document(graph, { kind: "accepted", root: graph.root, update: current.tree.update });
  }

  async admit(intent: SourceAdmissionIntent): Promise<Document> {
    // Copy before any suspension: editor mutation cannot change retained intent.
    intent = structuredClone(intent);
    if (intent.basis.tree !== this.queue.tree || intent.basis.path !== this.path || !intent.basis.revision.startsWith(prefix)) throw new Error("Intent belongs to another source session");
    const revision = JSON.parse(Buffer.from(intent.basis.revision.slice(prefix.length), "base64url").toString()) as Revision;
    if (revision.tree !== this.queue.tree || revision.path !== this.path || revision.sourcePath !== this.sourcePath) throw new Error("Source revision scope mismatch");
    const key = canonicalCBORHash(intent);
    const records = await this.queue.retained();
    let record = records.find(record => canonicalCBORHash(record.intent) === key) ?? this.prepared.get(key);
    if (!record) {
      let graph: TreeSnapshot;
      if (revision.basis.kind === "authored") {
        const predecessor = revision.basis.change;
        const parent = records.find(record => record.change === predecessor);
        if (!parent) throw new Error("Original source predecessor is unavailable");
        graph = decodeTreeSnapshotJSON(parent.candidate);
      } else if (revision.basis.kind === "accepted" && revision.basis.root === revision.root && revision.basis.update) {
        graph = this.captured.get(intent.basis.revision) ?? await this.transport.snapshot(this.queue.tree, revision.root);
      } else throw new Error("Invalid source revision basis");
      if (graph.root !== revision.root) throw new Error("Original source graph changed");
      // Recheck after suspension so concurrent identical admissions share identity.
      record = this.prepared.get(key) ?? prepareSourceAdmission({ change: canonicalCBORHash({ domain: "arbor-source-admission", tree: this.queue.tree, intent }).replace("sha256:", "source-"), tree: this.queue.tree, graph,
        basis: revision.basis, sourcePath: this.sourcePath, intent });
      this.prepared.set(key, record);
    }
    await this.queue.retain(record);
    return this.document(decodeTreeSnapshotJSON(record.candidate), { kind: "authored", change: record.change });
  }
}
