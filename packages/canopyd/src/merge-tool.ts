import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { hashObject, type ObjectHash } from "@overstory/protocol";
import { absentFrom, ObjectStore } from "@overstory/object-store";
import { MergeRefusal, parseAnswer, type LogDecision, type MergeAnswer, type MergeQuestion } from "@overstory/merge-protocol";
import { PersistentMergeWorker } from "./merge-worker.ts";
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

/** The merge sidecar evaluated the question and failed: a budget, an invalid
 * state or an unsupported input. Its message is the worker's own. */
export class MergeWorkerError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
    this.name = "MergeWorkerError";
  }
  /** Budget failures (the worker's `limit` code) may pass on a retry once the
   * host is less loaded; so may a worker that could not start, exited or timed
   * out (`unavailable`). Nothing was accepted, so the client keeps its request. */
  get retryable(): boolean {
    return this.code === "limit" || this.code === "unavailable";
  }
}

/** canopyd's side of the merge sidecar: one persistent process, a bounded
 * FIFO queue, staged inputs, and generic checks on each answer (its shape,
 * hash-checked generated objects, complete accepted and alternative trees).
 * canopyd trusts the sidecar it runs and keeps none of its state. */
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

  /** Ask the sidecar one question. `inputs` are objects the question needs
   * that durable storage may lack; they are staged for it. */
  async ask(
    question: MergeQuestion,
    inputs: ReadonlyMap<ObjectHash, Uint8Array>
  ): Promise<{ answer: MergeAnswer; objects: Map<ObjectHash, Uint8Array> }> {
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
      const job = this.askJob(question, inputs);
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

  private async askJob(
    question: MergeQuestion,
    inputs: ReadonlyMap<ObjectHash, Uint8Array>
  ): Promise<{ answer: MergeAnswer; objects: Map<ObjectHash, Uint8Array> }> {
    let phaseStart = performance.now();
    const mark = (phase: string) => {
      const now = performance.now();
      try { this.options.onTiming?.(phase, now - phaseStart); } catch { /* diagnostics cannot affect acceptance */ }
      phaseStart = now;
    };
    let worker: PersistentMergeWorker | undefined;
    // Whether the worker stays in service, keeping its cache: it answered in
    // form (a verified answer, a refusal or an `{error}` line). A transport
    // failure, unparseable or malformed output, or an answer that fails
    // verification retires it.
    let healthy = false;
    try {
      const unavailable = (error: unknown) => new MergeWorkerError(
        `Merge worker unavailable: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`, "unavailable");
      worker = await this.currentWorker().catch((error) => { throw unavailable(error); });
      const staging = new ObjectStore(join(worker.directory, "objects"));
      await this.stageInputs(inputs, staging);
      mark("stage-inputs");
      const stdout = await worker.request(question, this.options.timeoutMs ?? 30_000).catch((error) => { throw unavailable(error); });
      mark("worker-process");
      try {
        for (const [key, value] of Object.entries(worker.lastTimings ?? {})) {
          if (key.endsWith("-ms")) this.options.onTiming?.(`w-${key.slice(0, -3)}`, value);
          else this.options.onCount?.(`w-${key}`, value);
        }
      } catch { /* diagnostics only */ }
      const raw = JSON.parse(stdout);
      if (raw && typeof raw === "object" && "error" in raw) {
        // The worker reports evaluation failures as {error}; never let that
        // shape reach the response schema, whose complaint would hide it. A
        // well-formed one is the worker answering, so it stays in service
        // with its cache; a malformed one retires it.
        const { message, code } = (raw.error ?? {}) as { message?: unknown; code?: unknown };
        if (typeof message === "string" && (code === undefined || typeof code === "string")) healthy = true;
        throw new MergeWorkerError(
          typeof message === "string" ? message : "Merge evaluation failed",
          typeof code === "string" ? code : undefined,
        );
      }
      let answer: MergeAnswer;
      try {
        answer = parseAnswer(raw);
      } catch (error) {
        // A typed refusal is an answer too; a malformed one retires the worker.
        if (error instanceof MergeRefusal) healthy = true;
        throw error;
      }
      const objects = new Map<ObjectHash, Uint8Array>();
      // Generated objects are hash-checked as they are read back.
      for (const hash of answer.objects)
        objects.set(hash, (await staging.find(hash)) ?? await this.shared.read(hash));
      // The accepted root and every alternative root must be complete trees;
      // a range alternative is one object.
      const available = new Map([...inputs, ...objects]);
      await this.shared.verifyReachable(answerRoots(answer.root, answer.decisions), available);
      for (const d of answer.decisions)
        if (d.range) for (const hash of [...d.alternatives.map((a) => a.object), ...(d.at ? [d.at] : [])]) await this.shared.load(hash, available);
      mark("output-objects");
      healthy = true;
      return { answer, objects };
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
}

/** Every root an answer names: the projection and each whole-root or entry alternative. */
export function answerRoots(root: ObjectHash, decisions: readonly LogDecision[]): ObjectHash[] {
  return [...new Set([root, ...decisions.flatMap((d) => (d.range ? [] : d.alternatives.map((a) => a.object)))])];
}
