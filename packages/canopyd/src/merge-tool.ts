import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stableJSONString, hashObject, type ObjectHash } from "@overstory/protocol";
import { ObjectStore } from "@overstory/object-store";
import {
  CheckpointBatchLimitError,
  parseResponse,
  type IntentRequestInput,
  type IntentResponse,
  type MergeObjects,
  type MergeRequest,
  type MergeResult,
  type ProjectionRequest,
  type ProjectionResponse,
} from "@overstory/canopyd-merge";
import type {
  CheckpointBatchRequest, CheckpointBatchResponse,
  CheckpointRequest,
  CheckpointResponse,
} from "@overstory/canopyd-merge/checkpoint";
import type { ValidatedMaterial } from "@overstory/canopyd-merge/intent-engine";
import { changeIdentity, parseIntentRequest, type IntentState } from "@overstory/canopyd-merge/intent-model";
import { RetentionCache, verifyIntentRetention } from "@overstory/canopyd-merge/retention";
import { StateMapValidationCache, type MapProof } from "@overstory/canopyd-merge/state-map";
import { jsonHash } from "@overstory/canopyd-merge/state-value";
import { absentFrom, holdsObject } from "@overstory/canopyd-merge/worker-objects";
import { PersistentMergeWorker } from "./merge-worker.ts";

type EvaluatedResponse =
  | CheckpointResponse
  | CheckpointBatchResponse
  | ProjectionResponse
  | Extract<IntentResponse, { outcome: "evaluated" }>;
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
  /** History-proof cache ceiling; default 256 MB. */
  historyCacheBytes?: number;
  /** Validated-state proof memory ceiling; default 64 MB. */
  stateProofBytes?: number;
  /** Wall-clock budget for validating one state at the authority boundary;
   * default 60 s. Cold validation of a large history on slow storage can
   * exceed the evaluator's 5 s default. */
  validationMillis?: number;
  timeoutMs?: number;
  /** Host evaluation budget; defaults to 20 s, bounded by the worker timeout. */
  evaluationMillis?: number;
  /** Presentation policy; source choices remain coupled when the format requires it. */
  contentChoices?: "source" | "file";
}

type StateProof = {hash: string; object: string; state: IntentState; bytes: number; material: ValidatedMaterial; history: readonly MapProof[]};

/** The merge worker evaluated the request and failed: a budget, an invalid
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

export class MergeTool {
  private worker?: PersistentMergeWorker;
  private readonly jobs = new Set<Promise<unknown>>();
  private closing = false;
  private readonly retentionCache = new RetentionCache();
  private readonly historyValidation: StateMapValidationCache;
  private readonly validatedStates = new Map<string, StateProof>();
  private validatedBytes = 0;
  private readonly proofLeases = new Map<string, () => void>();
  private readonly resultProofs = new WeakMap<object, StateProof>();
  validationProof(tree: string, ref: {object: string; state: string}): StateProof | undefined {
    const proof = this.resultProofs.get(ref) ?? this.validatedStates.get(JSON.stringify([tree, ref.object, ref.state]));
    return proof?.state.tree === tree && proof.hash === ref.state && proof.object === ref.object ? proof : undefined;
  }
  private proofStats = { remembered: 0, rejected: 0, evicted: 0, hits: 0, validated: 0 };
  private forgetProof(key: string) {
    this.validatedBytes -= this.validatedStates.get(key)!.bytes;
    this.validatedStates.delete(key);
    this.proofLeases.get(key)?.();
    this.proofLeases.delete(key);
  }
  private rememberProof(key: string, proof: StateProof) {
    const limit = this.options.stateProofBytes ?? 64 * 1024 * 1024;
    if (proof.bytes > limit) { this.proofStats.rejected++; return; }
    if (this.validatedStates.has(key)) this.forgetProof(key);
    while (this.validatedStates.size >= 8 || this.validatedBytes + proof.bytes > limit) {
      this.proofStats.evicted++;
      this.forgetProof(this.validatedStates.keys().next().value!);
    }
    let release = this.historyValidation.pin(proof.history);
    while (!release && this.validatedStates.size) {
      this.proofStats.evicted++;
      this.forgetProof(this.validatedStates.keys().next().value!);
      release = this.historyValidation.pin(proof.history);
    }
    if (!release) { this.proofStats.rejected++; return; }
    this.proofStats.remembered++;
    this.proofLeases.set(key, release);
    this.validatedStates.set(key, proof);
    this.validatedBytes += proof.bytes;
  }
  /** Immutable semantic proof only; callers must still verify retention before
   * committing. This is not proof that a discarded job's objects are present. */
  validatedState(tree: string, ref: {object: string; state: string}): IntentState | undefined {
    return this.validationProof(tree, ref)?.state;
  }
  verifyRetention(roots: string[], available: ReadonlyMap<string, Uint8Array>, trusted: ReadonlySet<string> = new Set()) {
    return verifyIntentRetention(roots, (hash) => this.shared.load(hash, available), {
      cache: this.retentionCache, durable: (hash) => !available.has(hash),
      staged: available, frontierOnly: true, onCount: this.options.onCount,
      trusted: (ref) => ref.kind === "change" || trusted.has(ref.hash),
    });
  }
  /** Validate one state. Retention walks the stored graph itself, so only the
   * active state, its material and its shared history proofs are kept. */
  private async proveState(
    tree: string,
    ref: {object: string; state: string},
    objects: MergeObjects,
    previous?: ValidatedMaterial,
  ): Promise<StateProof> {
    const { validateIntentState } = await import("@overstory/canopyd-merge/intent-engine");
    let stateBytes = 0;
    let history: readonly MapProof[] = [];
    const material: ValidatedMaterial = new Map();
    const state = await validateIntentState(ref, tree, objects, {
      historyCache: this.historyValidation, retained: () => {},
      material: {previous, next: material},
      summary: {bytes: count => {stateBytes = count;}, references: () => {}, history: proofs => {history = proofs;}},
      maxMillis: this.validationMillis,
    });
    return {hash: ref.state, object: ref.object, state, bytes: stateBytes * 2 + material.size * 256, material, history};
  }
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
  private get validationMillis(): number { return this.options.validationMillis ?? 60_000; }

  /** Validate one accepted state and its retention ahead of any request, so the
   * first edit after a restart finds warm history proofs and closures. Nothing
   * here is trusted by later jobs beyond what a job would have cached itself. */
  async warm(tree: string, ref: { object: string; state: string }): Promise<{ reads: number; milliseconds: number }> {
    const started = performance.now();
    const before = this.shared.readCounters.reads;
    const key = JSON.stringify([tree, ref.object, ref.state]);
    if (!this.validatedStates.has(key))
      this.rememberProof(key, await this.proveState(tree, ref, {
        read: (hash) => this.shared.read(hash),
        store: async () => {},
      }));
    await this.verifyRetention([ref.state], new Map());
    return { reads: this.shared.readCounters.reads - before, milliseconds: performance.now() - started };
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
    this.historyValidation = new StateMapValidationCache(options.historyCacheBytes ?? 256 * 1024 * 1024);
  }

  evaluate(request: CheckpointBatchRequest, inputs: ReadonlyMap<ObjectHash, Uint8Array>): Promise<{response:CheckpointBatchResponse;objects:Map<ObjectHash,Uint8Array>}>;
  evaluate(
    request: CheckpointRequest,
    inputs: ReadonlyMap<ObjectHash, Uint8Array>
  ): Promise<{
    response: CheckpointResponse;
    objects: Map<ObjectHash, Uint8Array>;
  }>;
  evaluate(
    request: IntentRequestInput,
    inputs: ReadonlyMap<ObjectHash, Uint8Array>
  ): Promise<{
    response: Extract<IntentResponse, { outcome: "evaluated" }>;
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
    request: MergeRequest,
    inputs: ReadonlyMap<ObjectHash, Uint8Array>
  ): Promise<{
    response: EvaluatedResponse;
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
    for (const key of this.validatedStates.keys()) this.forgetProof(key);
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
    // Input states come from Canopy's own accepted records or from output this
    // process already validated and published; they are never client-supplied.
    // Those present in durable storage are trusted leaves for the output walk
    // rather than re-audited history. Proposed intermediates are excluded:
    // they may disappear when this job fails.
    const retained = ["base" in request ? request.base : undefined, "current" in request ? request.current : undefined]
      .flatMap((ref) => ref && typeof ref === "object" && "state" in ref && typeof ref.state === "string" ? [ref.state] : []);
    const trusted = new Set<string>();
    for (const state of new Set(retained))
      if (await holdsObject(this.shared, state)) trusted.add(state);
    mark("retained-inputs");
    let worker: PersistentMergeWorker | undefined;
    let healthy = false;
    try {
      const unavailable = (error: unknown) => new MergeWorkerError(
        `Merge worker unavailable: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`, "unavailable");
      worker = await this.currentWorker().catch((error) => { throw unavailable(error); });
      const staging = new ObjectStore(join(worker.directory, "objects"));
      await this.stageInputs(inputs, staging);
      mark("stage-inputs");
      const stdout = await worker.request(request, this.options.timeoutMs ?? 30_000).catch((error) => { throw unavailable(error); });
      mark("worker-process");
      try {
        for (const [key, value] of Object.entries(worker.lastTimings ?? {})) {
          if (key.endsWith("-ms")) this.options.onTiming?.(`w-${key.slice(0, -3)}`, value);
          else this.options.onCount?.(`w-${key}`, value);
        }
      } catch { /* diagnostics only */ }
      const raw = JSON.parse(stdout);
      if (raw && typeof raw === "object" && "error" in raw) {
        if (request.kind === "checkpoint-batch" && raw.error?.code === "checkpoint-batch-too-large")
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
      for (const hash of response.objects)
        objects.set(hash, (await staging.find(hash)) ?? await this.shared.read(hash));
      // Validate the referenced closure before releasing staging. Canopy still
      // applies its graph/schema/boundary checks and owns publication/acceptance.
      const available = new Map([...inputs, ...objects]);
      // Semantic retention below already checks the complete typed graph. Do
      // not walk the same material tree again before validating that state.
      if (!("state" in response.result))
        await this.shared.verifyReachable([response.result.object], available);
      else await this.shared.load(response.result.object, available);
      mark("output-objects");
      if (
        "state" in response.result &&
        typeof response.result.state === "string"
      ) {
        const tree = "tree" in request ? request.tree : undefined;
        if (!tree) throw new Error("Semantic result without tree scope");
        const reads = new Map<string, Uint8Array>();
        const access = {
          read: async (hash: string) => {
            const known = reads.get(hash);
            if (known) return known;
            const bytes = await this.shared.load(hash, available);
            reads.set(hash, bytes);
            return bytes;
          },
          store: async () => {},
        };
        // Pin input proofs for this job: publishing its output proof must not
        // evict the very current state that the final decision check still uses.
        const jobProofs = new Map(this.validatedStates);
        const historyBefore = { ...this.historyValidation.stats }, proofsBefore = { ...this.proofStats };
        const validate = async (ref: {object: string; state: string}) => {
          const key = JSON.stringify([tree, ref.object, ref.state]);
          const known = jobProofs.get(key);
          if (known) { this.proofStats.hits++; return known.state; }
          this.proofStats.validated++;
          const priorRef = "current" in request ? request.current : undefined;
          const prior = priorRef && "state" in priorRef
            ? jobProofs.get(JSON.stringify([tree, priorRef.object, priorRef.state])) : undefined;
          const proof = await this.proveState(tree, ref, access, prior?.material);
          jobProofs.set(key, proof);
          this.rememberProof(key, proof);
          return proof.state;
        };
        const retained = await validate({ object: response.result.object, state: response.result.state });
        const roots = [response.result.state];
        if (request.kind === "checkpoint-batch" && "checkpoints" in response) {
          // Each projection stays bound to its authoritative step. Verify the
          // union of retained dependencies once, sharing the graph walk's cache.
          for (const ref of response.checkpoints) {
            await validate(ref);
            roots.push(ref.state);
          }
        }
        if (request.kind === "checkpoint" && "authored" in response && response.authored &&
          response.authored.state !== response.result.state) {
          await validate(response.authored);
          roots.push(response.authored.state);
        }
        if (
          "outcome" in response &&
          request.kind !== "checkpoint" && request.kind !== "checkpoint-batch" &&
          // Either shape the engine accepts states authored evidence: the wire
          // sends a trace, an in-process caller may state one flat step.
          ("trace" in request.incoming || "operations" in request.incoming)
        ) {
          // The engine hashes the request's canonical frame form; parse the
          // same request here rather than hashing the shape it was sent in.
          const intent = parseIntentRequest(request);
          const authored = await validate(response.authored);
          roots.push(response.authored.state);
          if (
            stableJSONString(retained.decisions) !==
            stableJSONString(response.decisions)
          )
            throw new Error("Decision response differs from retained state");
          const signature = jsonHash(changeIdentity(intent));
          if (
            authored.changes[intent.incoming.change] !== signature ||
            retained.changes[intent.incoming.change] !== signature
          )
            throw new Error("Semantic state is not bound to request");
          if (intent.current.state) {
            const current = await validate({ object: intent.current.object, state: intent.current.state });
            for (const decision of current.decisions)
              if (
                !intent.incoming.resolves?.includes(decision.key) &&
                !retained.decisions.some((d) => d.key === decision.key)
              )
                throw new Error("Merge omitted an unresolved decision");
          }
        }
        // Keep proofs with the response through acceptance even if the optional
        // cross-job cache cannot hold them. Prefer the new head over its input.
        const results = ["authored" in response ? response.authored : undefined, response.result];
        for (const ref of results) if (ref && "state" in ref) {
          const key = JSON.stringify([tree, ref.object, ref.state]);
          const proof = jobProofs.get(key)!;
          this.resultProofs.set(ref, proof);
          this.rememberProof(key, proof);
        }
        mark("validate-state");
        try {
          const count = this.options.onCount;
          if (count) {
            const history = this.historyValidation.stats, proofs = this.proofStats;
            for (const k of Object.keys(history) as Array<keyof typeof history>) count(`history-${k}`, history[k] - historyBefore[k]);
            for (const k of Object.keys(proofs) as Array<keyof typeof proofs>) count(`proof-${k}`, proofs[k] - proofsBefore[k]);
            count("history-mb", Math.round(this.historyValidation.size.bytes / 1048576));
            count("proof-mb", Math.round(this.validatedBytes / 1048576));
            count("proof-bytes-last", Math.round((jobProofs.get(JSON.stringify([tree, response.result.object, response.result.state]))?.bytes ?? 0) / 1048576));
          }
        } catch { /* diagnostics only */ }
        await this.verifyRetention(roots, available, trusted);
        mark("retention");
      }
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
    rule = "tree-default"
  ): Promise<MergeResult> {
    try {
      const { response, objects } = await this.evaluate(
        {
          kind: "tree",
          base: { object: base },
          current: { object: current },
          incoming: { object: candidate },
          rules: { id: rule, revision: 1 },
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
      // Ordinary content becomes an accepted whole-root choice that keeps the
      // current tree displayed. Account policy retains its existing rejection
      // semantics; no authorization is delegated.
      return {
        root: rule.startsWith("account-config") ? candidate : current,
        objects: new Map(),
        conflicts: [
          {
            path: "/",
            reason: rule.startsWith("account-config")
              ? "account-configuration"
              : "node-conflict",
          },
        ],
        unresolvedDirectories: ["/"],
      };
    }
  }

}
