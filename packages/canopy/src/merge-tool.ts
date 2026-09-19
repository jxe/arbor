import type { ValidatedMaterial } from "../../merge/src/intent-engine.ts";
import type { IntentState } from "../../merge/src/intent-model.ts";
import { RetentionCache, verifyIntentRetention } from "../../merge/src/retention.ts";
import { CHECKPOINT_BATCH_TOO_LARGE_EXIT } from "../../merge/src/checkpoint.ts";
import { stableJSONString } from "@arbor/core";
import type {
  CheckpointBatchRequest, CheckpointBatchResponse,
  CheckpointRequest,
  CheckpointResponse,
} from "../../merge/src/checkpoint.ts";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ObjectStore } from "@arbor/object-store";
import {
  parseResponse,
  type MergeRequest,
  type ProjectionRequest,
  type ProjectionResponse,
  type IntentRequest,
  type IntentResponse,
} from "@arbor/merge";
import { hashObject, type ObjectHash } from "@arbor/wire";
import type { MergeResult } from "./updates/merge.ts";
import { PersistentMergeWorker } from "./merge-worker.ts";
import { StateMapValidationCache } from "../../merge/src/state-map.ts";

type EvaluatedResponse =
  | CheckpointResponse
  | CheckpointBatchResponse
  | ProjectionResponse
  | Extract<IntentResponse, { outcome: "evaluated" }>;
export interface MergeToolOptions {
  /** Executable and fixed arguments. No shell interpretation. */
  command?: string[];
  /** Reuse one sequential stdin worker. Canopy enables this for the built-in tool. */
  persistent?: boolean;
  /** Optional phase timings; no request content or object identities. */
  onTiming?: (phase: string, milliseconds: number) => void;
  /** Shared object store to read through (Canopy passes its cached store). */
  objects?: ObjectStore;
  timeoutMs?: number;
  /** Presentation policy; source choices remain coupled when the format requires it. */
  contentChoices?: "source" | "file";
}

export class CheckpointBatchTooLargeError extends Error {}

type StateProof = {hash: string; object: string; state: IntentState; bytes: number; dependencies: Set<string>; material: ValidatedMaterial; references: ReadonlySet<string>};

export class MergeTool {
  private worker?: PersistentMergeWorker;
  private readonly jobs = new Set<Promise<unknown>>();
  private closing = false;
  private readonly retentionCache = new RetentionCache();
  private readonly historyValidation = new StateMapValidationCache();
  private readonly validatedStates = new Map<string, StateProof>();
  private validatedBytes = 0;
  private readonly resultProofs = new WeakMap<object, StateProof>();
  validationProof(tree: string, ref: {object: string; state: string}): StateProof | undefined {
    const proof = this.resultProofs.get(ref) ?? this.validatedStates.get(JSON.stringify([tree, ref.object, ref.state]));
    return proof?.state.tree === tree && proof.hash === ref.state && proof.object === ref.object ? proof : undefined;
  }
  private rememberProof(key: string, proof: StateProof) {
    if (proof.bytes > 16 * 1024 * 1024) return;
    this.validatedBytes -= this.validatedStates.get(key)?.bytes ?? 0;
    this.validatedStates.delete(key);
    this.validatedStates.set(key, proof); this.validatedBytes += proof.bytes;
    while (this.validatedStates.size > 8 || this.validatedBytes > 16 * 1024 * 1024) {
      const oldest = this.validatedStates.keys().next().value!;
      this.validatedBytes -= this.validatedStates.get(oldest)!.bytes;
      this.validatedStates.delete(oldest);
    }
  }
  /** Immutable semantic proof only; callers must still verify retention before
   * committing. This is not proof that a discarded job's objects are present. */
  validatedState(tree: string, ref: {object: string; state: string}): IntentState | undefined {
    return this.validationProof(tree, ref)?.state;
  }
  verifyRetention(roots: string[], available: ReadonlyMap<string, Uint8Array>, proofs: ReadonlyMap<string, StateProof> = this.validatedStates, trusted: ReadonlySet<string> = new Set()) {
    return verifyIntentRetention(roots, (hash) => this.shared.load(hash, available), {
      cache: this.retentionCache, durable: (hash) => !available.has(hash),
      trusted: (hash) => trusted.has(hash),
      state: (hash) => {
        for (const proof of proofs.values())
          if (proof.hash === hash) return {value: proof.state, dependencies: proof.dependencies, references: proof.references};
      },
    });
  }
  get contentChoices(): "source" | "file" { return this.options.contentChoices ?? "source"; }
  private readonly shared: ObjectStore;
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  constructor(
    private readonly dataRoot: string,
    private readonly options: MergeToolOptions = {}
  ) {
    if (
      !Number.isInteger(options.timeoutMs ?? 30_000) ||
      (options.timeoutMs ?? 30_000) < 1
    )
      throw new Error("Invalid merge worker limits");
    this.shared = options.objects ?? new ObjectStore(join(dataRoot, "objects"));
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
    request: IntentRequest,
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
    for (const state of new Set(retained)) {
      if (await this.shared.find(state)) trusted.add(state);
    }
    mark("retained-inputs");
    const jobs = join(this.dataRoot, "merge-jobs");
    await mkdir(jobs, { recursive: true });
    const job = await mkdtemp(join(jobs, "job-"));
    let worker: PersistentMergeWorker | undefined;
    let healthy = false;
    try {
      const command = this.options.command ?? (process.env.ARBOR_MERGE_EXECUTABLE
        ? [process.env.ARBOR_MERGE_EXECUTABLE]
        : [process.execPath, fileURLToPath(new URL("../../merge/src/cli.ts", import.meta.url))]);
      if (!command.length) throw new Error("Empty merge command");
      if (this.options.persistent) {
        worker = this.worker;
        if (worker && !worker.alive) {
          await worker.close(); await rm(worker.directory, {recursive: true, force: true});
          this.worker = worker = undefined;
        }
        if (!worker) {
          const parent = join(this.dataRoot, "merge-workers");
          await mkdir(parent, {recursive: true});
          const directory = await mkdtemp(join(parent, "worker-"));
          worker = new PersistentMergeWorker(command, directory, join(this.dataRoot, "objects"), join(directory, "objects"));
          this.worker = worker;
        }
      }
      const stagingPath = join(worker?.directory ?? job, "objects");
      const staging = new ObjectStore(stagingPath);
      for (const [hash, bytes] of inputs) {
        if (hashObject(bytes) !== hash) throw new Error(`Object hash mismatch: ${hash}`);
        if (!(await this.shared.find(hash))) await staging.stage([{ hash, bytes }]);
      }
      // Retained history is currently append-only (no object GC). This manifest
      // names live job inputs for a future collector; a collector must honor it.
      await writeFile(join(job, "request.json"), JSON.stringify(request));
      mark("stage-inputs");
      const stdout = worker ? await worker.request(request, this.options.timeoutMs ?? 30_000) : await new Promise<string>((resolve, reject) => {
        let inputError: Error | undefined;
        const child = execFile(
          command[0]!,
          [
            ...command.slice(1),
            "evaluate",
            "--objects",
            join(this.dataRoot, "objects"),
            "--staging",
            stagingPath,
          ],
          {
            timeout: this.options.timeoutMs ?? 30_000,
            killSignal: "SIGKILL",
            maxBuffer: 8 * 1024 * 1024,
            encoding: "utf8",
            env: {
              PATH: process.env.PATH,
              TMPDIR: process.env.TMPDIR,
              LANG: process.env.LANG,
              TZ: process.env.TZ,
            },
          },
          (error, stdout) => {
            if (request.kind === "checkpoint-batch" && (error as (Error & {code?:unknown}) | null)?.code === CHECKPOINT_BATCH_TOO_LARGE_EXIT)
              reject(new CheckpointBatchTooLargeError("Historical checkpoint batch exceeds its byte budget"));
            else if (error || inputError) reject(error ?? inputError);
            else resolve(stdout);
          }
        );
        // Wait for process exit before removing staging or releasing the slot,
        // even if the worker closes stdin before reading the entire request.
        child.stdin!.on("error", (error) => {
          inputError = error;
          child.kill("SIGKILL");
        });
        child.stdin!.end(JSON.stringify(request));
      });
      mark("worker-process");
      const raw = JSON.parse(stdout);
      if (request.kind === "checkpoint-batch" && raw.error?.code === "checkpoint-batch-too-large")
        throw new CheckpointBatchTooLargeError("Historical checkpoint batch exceeds its byte budget");
      const response = parseResponse(raw, request);
      const objects = new Map<ObjectHash, Uint8Array>();
      for (const hash of response.objects)
        objects.set(hash, (await staging.find(hash)) ?? await this.shared.read(hash));
      // Validate the referenced closure before releasing staging. Canopy still
      // applies its graph/schema/boundary checks and owns publication/acceptance.
      const available = new Map([...inputs, ...objects]);
      // Semantic retention below already checks the complete typed graph. Do
      // not walk the same material tree again before validating that state.
      if (!("state" in response.result) && request.kind !== "source")
        await this.shared.verifyReachable([response.result.object], available);
      else await this.shared.load(response.result.object, available);
      mark("output-objects");
      if (
        "state" in response.result &&
        typeof response.result.state === "string"
      ) {
        const { validateIntentState } = await import(
          "../../merge/src/intent-engine.ts"
        );
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
        const validate = async (ref: {object: string; state: string}) => {
          const key = JSON.stringify([tree, ref.object, ref.state]);
          const known = jobProofs.get(key);
          if (known) return known.state;
          const dependencies = new Set<string>();
          let stateBytes = 0, references: ReadonlySet<string> = new Set();
          const priorRef = "current" in request ? request.current : undefined;
          const prior = priorRef && "state" in priorRef
            ? jobProofs.get(JSON.stringify([tree, priorRef.object, priorRef.state])) : undefined;
          const material: ValidatedMaterial = new Map();
          const state = await validateIntentState(ref, tree, {
            read: (hash) => { dependencies.add(hash); return access.read(hash); },
            store: access.store,
          }, {historyCache: this.historyValidation, retained: hash => dependencies.add(hash), material: {previous: prior?.material, next: material}, summary: {bytes: count => {stateBytes = count;}, references: refs => {references = refs;}}});
          const bytes = stateBytes * 2 + (dependencies.size + references.size) * 160 + material.size * 256;
          const proof = {hash: ref.state, object: ref.object, state, bytes, dependencies, material, references};
          jobProofs.set(key, proof);
          this.rememberProof(key, proof);
          return state;
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
        if (
          "authored" in response &&
          request.kind !== "checkpoint" && request.kind !== "checkpoint-batch" &&
          "operations" in request.incoming
        ) {
          const intent = request as IntentRequest;
          const authored = await validate(response.authored);
          roots.push(response.authored.state);
          if (
            stableJSONString(retained.decisions) !==
            stableJSONString(response.decisions)
          )
            throw new Error("Decision response differs from retained state");
          const signature = hashObject(
            new TextEncoder().encode(
              stableJSONString({
                base: intent.base,
                incoming: intent.incoming,
                alternatives: intent.alternatives,
                rules: intent.rules,
              })
            )
          );
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
        await this.verifyRetention(roots, available, jobProofs, trusted);
        mark("retention");
      }
      healthy = true;
      return { response, objects };
    } finally {
      try {
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
      } finally {
        await rm(job, { recursive: true, force: true });
      }
    }
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
      // Ordinary content becomes an accepted whole-root choice. Account policy
      // retains its existing rejection semantics; no authorization is delegated.
      return {
        root: candidate,
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
