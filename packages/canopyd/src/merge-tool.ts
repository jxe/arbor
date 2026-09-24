import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { hashObject, type ObjectHash } from "@overstory/protocol";
import { absentFrom, ObjectStore } from "@overstory/object-store";
import {
  CHECKPOINT_BATCH_TOO_LARGE,
  CheckpointBatchLimitError,
  MAX_AUDIT_ROOTS,
  parseResponse,
  type CheckpointBatchRequest,
  type CheckpointBatchResponse,
  type CheckpointRequest,
  type CheckpointResponse,
  type IntentEvaluation,
  type IntentRequest,
  type MergeRequest,
  type ProjectionRequest,
  type ProjectionResponse,
  type RetentionAuditRequest,
  type RetentionAuditResponse,
} from "@overstory/merge-protocol";
import { PersistentMergeWorker } from "./merge-worker.ts";
import type { MergeResult } from "./updates/reconcile.ts";

type EvaluatedResponse =
  | CheckpointResponse
  | CheckpointBatchResponse
  | ProjectionResponse
  | IntentEvaluation
  | RetentionAuditResponse;
export interface MergeToolOptions {
  /** Executable and fixed arguments, run as `<command> serve --objects DIR
   * --staging DIR`: one sequential JSON-lines worker. No shell interpretation. */
  command?: string[];
  /** Optional phase timings; no request content or object identities. */
  onTiming?: (phase: string, milliseconds: number) => void;
  /** Shared object store to read through (Canopy passes its cached store). */
  objects?: ObjectStore;
  /** Optional diagnostic counters per job; no request content or identities. */
  onCount?: (name: string, value: number) => void;
  timeoutMs?: number;
  /** Host evaluation budget; defaults to 20 s, bounded by the worker timeout. */
  evaluationMillis?: number;
  /** Presentation policy; source choices remain coupled when the format requires it. */
  contentChoices?: "source" | "file";
}

/** The merge worker evaluated the request and failed: a budget, an invalid
 * state or an unsupported input. Its message is the worker's own. */
export class MergeWorkerError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
    this.name = "MergeWorkerError";
  }
  /** Budget failures (the worker's `limit` code) may pass on a retry once the host is less loaded. */
  get retryable(): boolean {
    return this.code === "limit";
  }
}

/** canopyd's side of the merge worker: one persistent process, a bounded
 * FIFO queue, staged inputs, and generic checks on each response (its shape,
 * its correspondence to the request, hash-checked generated objects). The
 * worker's retained state is opaque here; canopyd trusts the worker it runs. */
export class MergeTool {
  private worker?: PersistentMergeWorker;
  private readonly jobs = new Set<Promise<unknown>>();
  private closing = false;
  /** Remove job and worker directories left by an earlier process. Each job
   * removes its own directory when it settles, so anything present at startup
   * belonged to a process that died mid-job; nothing accepted lives there. */
  async clearStaleJobs(): Promise<void> {
    if (this.active || this.worker) throw new Error("Stale job cleanup runs before any job");
    for (const name of ["merge-jobs", "merge-workers"])
      await rm(join(this.dataRoot, name), { recursive: true, force: true });
  }
  get contentChoices(): "source" | "file" { return this.options.contentChoices ?? "source"; }
  get evaluationMillis(): number { return this.options.evaluationMillis ?? Math.min(20_000, this.options.timeoutMs ?? 30_000); }

  /** Have the worker walk the complete retained closure of these states in
   * the shared store; it owns their format. Used by the integrity audit. */
  async auditRetention(roots: Iterable<string>): Promise<number> {
    const all = [...new Set(roots)];
    let checked = 0;
    for (let i = 0; i < all.length; i += MAX_AUDIT_ROOTS) {
      const { response } = await this.evaluate({ kind: "retention-audit", roots: all.slice(i, i + MAX_AUDIT_ROOTS) }, new Map());
      checked += response.checked;
    }
    return checked;
  }
  private readonly shared: ObjectStore;
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  constructor(
    private readonly dataRoot: string,
    private readonly options: MergeToolOptions = {}
  ) {
    if (
      !Number.isInteger(options.timeoutMs ?? 30_000) ||
      (options.timeoutMs ?? 30_000) < 1 ||
      !Number.isInteger(this.evaluationMillis) || this.evaluationMillis < 1 ||
      this.evaluationMillis > Math.min(30_000, options.timeoutMs ?? 30_000)
    )
      throw new Error("Invalid merge worker limits");
    this.shared = options.objects ?? new ObjectStore(join(dataRoot, "objects"));
  }

  evaluate(request: RetentionAuditRequest, inputs: ReadonlyMap<ObjectHash, Uint8Array>): Promise<{response:RetentionAuditResponse;objects:Map<ObjectHash,Uint8Array>}>;
  evaluate(request: CheckpointBatchRequest, inputs: ReadonlyMap<ObjectHash, Uint8Array>): Promise<{response:CheckpointBatchResponse;objects:Map<ObjectHash,Uint8Array>}>;
  evaluate(
    request: CheckpointRequest,
    inputs: ReadonlyMap<ObjectHash, Uint8Array>
  ): Promise<{
    response: CheckpointResponse;
    objects: Map<ObjectHash, Uint8Array>;
  }>;
  evaluate(
    request: IntentRequest,
    inputs: ReadonlyMap<ObjectHash, Uint8Array>
  ): Promise<{
    response: IntentEvaluation;
    objects: Map<ObjectHash, Uint8Array>;
  }>;
  evaluate(
    request: ProjectionRequest,
    inputs: ReadonlyMap<ObjectHash, Uint8Array>
  ): Promise<{
    response: ProjectionResponse;
    objects: Map<ObjectHash, Uint8Array>;
  }>;
  evaluate(
    request: Exclude<MergeRequest, RetentionAuditRequest>,
    inputs: ReadonlyMap<ObjectHash, Uint8Array>
  ): Promise<{
    response: Exclude<EvaluatedResponse, RetentionAuditResponse>;
    objects: Map<ObjectHash, Uint8Array>;
  }>;
  async evaluate(
    request: MergeRequest,
    inputs: ReadonlyMap<ObjectHash, Uint8Array>
  ): Promise<{
    response: EvaluatedResponse;
    objects: Map<ObjectHash, Uint8Array>;
  }> {
    if (this.closing) throw new Error("Merge tool is closing");
    if (this.waiting.length >= 64)
      throw new Error("Merge worker queue is full");
    const queuedAt = performance.now();
    if (this.active)
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.active++;
    try {
      if (this.closing) throw new Error("Merge tool is closing");
      try { this.options.onTiming?.("queue-wait", performance.now() - queuedAt); } catch { /* diagnostic only */ }
      const job = this.evaluateJob(request, inputs);
      this.jobs.add(job);
      try { return await job; } finally { this.jobs.delete(job); }
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.closing = true;
    await Promise.allSettled([...this.jobs]);
    const worker = this.worker;
    if (worker) {
      await worker.close();
      await rm(worker.directory, {recursive: true, force: true});
      this.worker = undefined;
    }
  }

  private async evaluateJob(
    request: MergeRequest,
    inputs: ReadonlyMap<ObjectHash, Uint8Array>
  ): Promise<{
    response: EvaluatedResponse;
    objects: Map<ObjectHash, Uint8Array>;
  }> {
    let phaseStart = performance.now();
    const mark = (phase: string) => {
      const now = performance.now();
      try { this.options.onTiming?.(phase, now - phaseStart); } catch { /* diagnostics cannot affect acceptance */ }
      phaseStart = now;
    };
    let worker: PersistentMergeWorker | undefined;
    let healthy = false;
    try {
      worker = await this.currentWorker();
      const staging = new ObjectStore(join(worker.directory, "objects"));
      await this.stageInputs(inputs, staging);
      mark("stage-inputs");
      const stdout = await worker.request(request, this.options.timeoutMs ?? 30_000);
      mark("worker-process");
      try {
        for (const [key, value] of Object.entries(worker.lastTimings ?? {})) {
          if (key.endsWith("-ms")) this.options.onTiming?.(`w-${key.slice(0, -3)}`, value);
          else this.options.onCount?.(`w-${key}`, value);
        }
      } catch { /* diagnostics only */ }
      const raw = JSON.parse(stdout);
      if (raw && typeof raw === "object" && "error" in raw) {
        if (request.kind === "checkpoint-batch" && raw.error?.code === CHECKPOINT_BATCH_TOO_LARGE)
          throw new CheckpointBatchLimitError("Historical checkpoint batch exceeds its byte budget");
        // The worker reports evaluation failures as {error}; never let that
        // shape reach the response schema, whose complaint would hide it.
        throw new MergeWorkerError(
          typeof raw.error?.message === "string" ? raw.error.message : "Merge evaluation failed",
          typeof raw.error?.code === "string" ? raw.error.code : undefined,
        );
      }
      const response = parseResponse(raw, request);
      const objects = new Map<ObjectHash, Uint8Array>();
      // Generated objects are hash-checked as they are read back.
      for (const hash of "objects" in response ? response.objects : [])
        objects.set(hash, (await staging.find(hash)) ?? await this.shared.read(hash));
      if ("result" in response) {
        const available = new Map([...inputs, ...objects]);
        // A snapshot merge's result is an ordinary tree: check its closure. A
        // stateful result's tree is the worker's own output over retained
        // material; its root must at least be present.
        if (!("state" in response.result))
          await this.shared.verifyReachable([response.result.object], available);
        else await this.shared.load(response.result.object, available);
      }
      mark("output-objects");
      healthy = true;
      return { response, objects };
    } finally {
      if (worker) {
        if (!healthy || !worker.alive) {
          this.worker = undefined;
          await worker.close();
          await rm(worker.directory, {recursive: true, force: true});
        } else {
          try {
            await rm(join(worker.directory, "objects"), {recursive: true, force: true});
          } catch (error) {
            // Never let a cleanup failure expose an earlier job's proposal to
            // its successor. Retire the process before releasing the queue.
            this.worker = undefined;
            await worker.close();
            throw error;
          }
        }
      }
    }
  }

  /** The live worker, replacing one that exited or failed. */
  private async currentWorker(): Promise<PersistentMergeWorker> {
    let worker = this.worker;
    if (worker && !worker.alive) {
      await worker.close(); await rm(worker.directory, {recursive: true, force: true});
      this.worker = worker = undefined;
    }
    if (worker) return worker;
    const command = this.options.command ?? (process.env.ARBOR_MERGE_EXECUTABLE
      ? [process.env.ARBOR_MERGE_EXECUTABLE]
      : [process.execPath, fileURLToPath(new URL("../../canopyd-merge/src/cli.ts", import.meta.url))]);
    if (!command.length) throw new Error("Empty merge command");
    const parent = join(this.dataRoot, "merge-workers");
    await mkdir(parent, {recursive: true});
    const directory = await mkdtemp(join(parent, "worker-"));
    worker = new PersistentMergeWorker(command, directory, join(this.dataRoot, "objects"), join(directory, "objects"));
    this.worker = worker;
    return worker;
  }

  /** Stage the inputs durable storage lacks, in one publish. Every input is
   * hash-checked: those already durable here, the rest as they are staged. */
  private async stageInputs(inputs: ReadonlyMap<ObjectHash, Uint8Array>, staging: ObjectStore): Promise<void> {
    const values = [...inputs].map(([hash, bytes]) => ({hash, bytes}));
    const missing = await absentFrom(this.shared, values);
    const staged = new Set(missing);
    for (const value of values)
      if (!staged.has(value) && hashObject(value.bytes) !== value.hash)
        throw new Error(`Object hash mismatch: ${value.hash}`);
    await staging.stage(missing);
  }

  async tree(
    base: ObjectHash,
    candidate: ObjectHash,
    current: ObjectHash,
    proposed: ReadonlyMap<ObjectHash, Uint8Array>,
  ): Promise<MergeResult> {
    try {
      const { response, objects } = await this.evaluate(
        {
          kind: "tree",
          base: { object: base },
          current: { object: current },
          incoming: { object: candidate },
          rules: { id: "tree-default", revision: 1 },
        },
        proposed
      );
      return {
        root: response.result.object,
        objects,
        conflicts: response.decisions.flatMap((d) =>
          d.kind === "conflict" && d.scope === "entry"
            ? [{ path: d.path, reason: d.reason }]
            : []
        ),
        unresolvedDirectories: response.decisions.flatMap((d) =>
          d.kind === "conflict" && d.scope === "directory" ? [d.path] : []
        ),
        ...(response.evidence.summary
          ? { summary: response.evidence.summary }
          : {}),
      };
    } catch (error) {
      console.warn(
        "Merge tool unavailable; preserving ambiguity:",
        error instanceof Error ? error.message.split("\n")[0] : "invalid result"
      );
      // Ordinary content becomes an accepted whole-root choice.
      return {
        root: candidate,
        objects: new Map(),
        conflicts: [{ path: "/", reason: "node-conflict" }],
        unresolvedDirectories: ["/"],
      };
    }
  }

}
