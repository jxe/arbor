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

type EvaluatedResponse =
  | CheckpointResponse
  | CheckpointBatchResponse
  | ProjectionResponse
  | Extract<IntentResponse, { outcome: "evaluated" }>;
export interface MergeToolOptions {
  /** Executable and fixed arguments. No shell interpretation. */
  command?: string[];
  timeoutMs?: number;
  maxConcurrent?: number;
  /** Presentation policy; source choices remain coupled when the format requires it. */
  contentChoices?: "source" | "file";
}

export class CheckpointBatchTooLargeError extends Error {}

export class MergeTool {
  get contentChoices(): "source" | "file" { return this.options.contentChoices ?? "source"; }
  private readonly shared: ObjectStore;
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  constructor(
    private readonly dataRoot: string,
    private readonly options: MergeToolOptions = {}
  ) {
    if (
      !Number.isInteger(options.maxConcurrent ?? 4) ||
      (options.maxConcurrent ?? 4) < 1 ||
      !Number.isInteger(options.timeoutMs ?? 30_000) ||
      (options.timeoutMs ?? 30_000) < 1
    )
      throw new Error("Invalid merge worker limits");
    this.shared = new ObjectStore(join(dataRoot, "objects"));
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
    if (this.waiting.length >= 64)
      throw new Error("Merge worker queue is full");
    if (this.active >= (this.options.maxConcurrent ?? 4))
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.active++;
    try {
      return await this.evaluateJob(request, inputs);
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }

  private async evaluateJob(
    request: MergeRequest,
    inputs: ReadonlyMap<ObjectHash, Uint8Array>
  ): Promise<{
    response: EvaluatedResponse;
    objects: Map<ObjectHash, Uint8Array>;
  }> {
    const jobs = join(this.dataRoot, "merge-jobs");
    await mkdir(jobs, { recursive: true });
    const job = await mkdtemp(join(jobs, "job-"));
    try {
      const stagingPath = join(job, "objects");
      const staging = new ObjectStore(stagingPath);
      for (const [hash, bytes] of inputs) {
        if (hashObject(bytes) !== hash) throw new Error(`Object hash mismatch: ${hash}`);
        if (!(await this.shared.find(hash))) await staging.store([{ hash, bytes }]);
      }
      // Retained history is currently append-only (no object GC). This manifest
      // names live job inputs for a future collector; a collector must honor it.
      await writeFile(join(job, "request.json"), JSON.stringify(request));
      const command =
        this.options.command ??
        (process.env.ARBOR_MERGE_EXECUTABLE
          ? [process.env.ARBOR_MERGE_EXECUTABLE]
          : [
              process.execPath,
              fileURLToPath(new URL("../../merge/src/cli.ts", import.meta.url)),
            ]);
      if (!command.length) throw new Error("Empty merge command");
      const stdout = await new Promise<string>((resolve, reject) => {
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
      const response = parseResponse(JSON.parse(stdout), request);
      const objects = new Map<ObjectHash, Uint8Array>();
      for (const hash of response.objects)
        objects.set(hash, (await staging.find(hash)) ?? await this.shared.read(hash));
      // Validate the referenced closure before releasing staging. Canopy still
      // applies its graph/schema/boundary checks and owns publication/acceptance.
      const available = new Map([...inputs, ...objects]);
      if (request.kind !== "source")
        await this.shared.verifyReachable([response.result.object], available);
      else await this.shared.load(response.result.object, available);
      if (
        "state" in response.result &&
        typeof response.result.state === "string"
      ) {
        const { validateIntentState } = await import(
          "../../merge/src/intent-engine.ts"
        );
        const tree = "tree" in request ? request.tree : undefined;
        if (!tree) throw new Error("Semantic result without tree scope");
        const access = {
          read: (hash: string) => this.shared.load(hash, available),
          store: async () => {},
        };
        const retained = await validateIntentState(
          { object: response.result.object, state: response.result.state },
          tree,
          access
        );
        const { verifyIntentRetention } = await import(
          "../../merge/src/retention.ts"
        );
        const roots = [response.result.state];
        if (request.kind === "checkpoint-batch" && "checkpoints" in response) {
          // Each projection stays bound to its authoritative step. Verify the
          // union of retained dependencies once, sharing the graph walk's cache.
          for (const ref of response.checkpoints) {
            await validateIntentState(ref, tree, access);
            roots.push(ref.state);
          }
        }
        if (
          "authored" in response &&
          request.kind !== "checkpoint" && request.kind !== "checkpoint-batch" &&
          "operations" in request.incoming
        ) {
          const intent = request as IntentRequest;
          const authored = await validateIntentState(
            response.authored,
            tree,
            access
          );
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
            const current = await validateIntentState(
              { object: intent.current.object, state: intent.current.state },
              tree,
              access
            );
            for (const decision of current.decisions)
              if (
                !intent.incoming.resolves?.includes(decision.key) &&
                !retained.decisions.some((d) => d.key === decision.key)
              )
                throw new Error("Merge omitted an unresolved decision");
          }
        }
        await verifyIntentRetention(roots, (hash) =>
          this.shared.load(hash, available)
        );
      }
      return { response, objects };
    } finally {
      await rm(job, { recursive: true, force: true });
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
