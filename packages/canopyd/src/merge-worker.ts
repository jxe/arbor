import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

/** One sequential JSON-lines worker. The caller owns its fixed staging path and
 * must not reuse or remove staged inputs until request() has settled. Failures
 * settle only after process close, so a timed-out worker cannot race cleanup. */
export class PersistentMergeWorker {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly exited: Promise<void>;
  private pending?: {
    resolve: (line: string) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  };
  private output: Buffer[] = [];
  private outputBytes = 0;
  private stderrBytes = 0;
  private stderrPending = "";
  /** Diagnostics the worker reported for its most recent request, if any. */
  lastTimings?: Record<string, number>;
  private failure?: Error;
  private closed = false;
  private readonly limit = 8 * 1024 * 1024;
  constructor(
    command: string[],
    readonly directory: string,
    shared: string,
    staging: string,
  ) {
    this.child = spawn(
      command[0]!,
      [...command.slice(1), "serve", "--objects", shared, "--staging", staging],
      {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          PATH: process.env.PATH,
          TMPDIR: process.env.TMPDIR,
          LANG: process.env.LANG,
          TZ: process.env.TZ,
          // The sidecar's own cache budgets; never credentials.
          ...Object.fromEntries(["ARBOR_MERGE_CACHE_MB", "ARBOR_OBJECT_CACHE_MB"]
            .flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]]])),
        },
      },
    );
    this.exited = new Promise((resolve) => {
      this.child.on("close", (code, signal) => {
        this.closed = true;
        if (this.pending) {
          clearTimeout(this.pending.timer);
          this.pending.reject(
            this.failure ??
              new Error(`Merge worker exited (${code ?? signal})`),
          );
          this.pending = undefined;
        }
        resolve();
      });
    });
    this.child.on("error", (error) => this.fail(error));
    this.child.stdin.on("error", (error) => this.fail(error));
    this.child.stdout.on("data", (chunk: Buffer) => {
      if (!this.pending) {
        this.fail(new Error("Unsolicited merge worker output"));
        return;
      }
      if (this.outputBytes + chunk.length > this.limit) {
        this.fail(new Error("Merge worker output exceeds byte budget"));
        return;
      }
      // Earlier chunks hold no newline, so this chunk ends the response.
      const end = chunk.indexOf(10);
      if (end < 0) {
        this.output.push(chunk);
        this.outputBytes += chunk.length;
        return;
      }
      if (end !== chunk.length - 1) {
        this.fail(new Error("Multiple merge worker responses"));
        return;
      }
      const pending = this.pending;
      clearTimeout(pending.timer);
      this.pending = undefined;
      const line = Buffer.concat([...this.output, chunk.subarray(0, end)]).toString("utf8");
      this.output = [];
      this.outputBytes = 0;
      pending.resolve(line);
    });
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderrBytes += chunk.length;
      if (this.stderrBytes > this.limit) {
        this.fail(new Error("Merge worker diagnostics exceed byte budget"));
        return;
      }
      // Timing lines are diagnostics only; anything else on stderr is ignored.
      this.stderrPending += chunk.toString("utf8");
      let end: number;
      while ((end = this.stderrPending.indexOf("\n")) !== -1) {
        const line = this.stderrPending.slice(0, end);
        this.stderrPending = this.stderrPending.slice(end + 1);
        if (!line.startsWith("{\"timings\":")) continue;
        try {
          const parsed = JSON.parse(line) as { timings?: Record<string, unknown> };
          if (parsed.timings && typeof parsed.timings === "object") {
            const timings: Record<string, number> = {};
            for (const [key, value] of Object.entries(parsed.timings)) if (typeof value === "number" && Number.isFinite(value)) timings[key] = value;
            this.lastTimings = timings;
          }
        } catch { /* malformed diagnostics are ignored */ }
      }
    });
  }
  get alive(): boolean {
    return !this.closed && !this.failure;
  }
  private fail(error: Error) {
    this.failure ??= error;
    this.child.kill("SIGKILL");
  }
  request(value: unknown, timeoutMs: number): Promise<string> {
    if (!this.alive || this.pending)
      return Promise.reject(new Error("Merge worker is unavailable or busy"));
    this.stderrBytes = 0;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => this.fail(new Error("Merge worker timed out")),
        timeoutMs,
      );
      this.pending = { resolve, reject, timer };
      this.child.stdin.write(JSON.stringify(value) + "\n", (error) => {
        if (error) this.fail(error);
      });
    });
  }
  async close(): Promise<void> {
    if (!this.closed) this.fail(new Error("Merge worker stopped"));
    await this.exited;
  }
}
