// The execution sidecar process (Apps 005 step 4): overstoryd starts it, asks
// it questions one JSON line at a time, and restarts it when it exits, misses
// a deadline or writes a line that is not a well-formed answer. Answers come
// back in any order, matched by id. A failed sidecar fails only the questions
// in flight; nothing else in overstoryd waits on it.

import { parseExecAnswer, parseExecReady, type ExecAnswer, type ExecAsk, type ExecReady } from "@ovst/exec-protocol";

/** The sidecar is down, busy or too slow: a retryable 503. */
export class ExecUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecUnavailableError";
  }
}

export interface ExecProcessOptions {
  /** How long one question may take before the process is restarted (default 30 s). */
  deadlineMs?: number;
  /** How many questions may be in flight at once (default 64). */
  maxInFlight?: number;
}

interface Running {
  process: ReturnType<typeof Bun.spawn<"pipe", "pipe", "pipe">>;
  ready: Promise<ExecReady["ready"]>;
  /** Fails `ready` when the process ends before its handshake. */
  unready: (error: Error) => void;
  pending: Map<string, { resolve: (answer: ExecAnswer) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>;
  exited: Promise<void>;
}

let sequence = 0;

export class ExecProcess implements AsyncDisposable {
  private running?: Running;
  private disposed = false;

  /** `command` is asked for each start, so it can name what is known only once the host listens. */
  constructor(private readonly command: () => readonly string[], private readonly options: ExecProcessOptions = {}) {}

  /** What the sidecar can run, from its handshake; starts it when it isn't running. */
  handles(): Promise<ExecReady["ready"]> {
    return this.start().ready;
  }

  /** Ask one question. Aborting cancels it; the sidecar drops its answer. */
  async ask(question: ExecAsk, signal?: AbortSignal): Promise<ExecAnswer> {
    const running = this.start();
    await running.ready;
    if (running !== this.running) throw new ExecUnavailableError("The execution sidecar stopped");
    if (running.pending.size >= (this.options.maxInFlight ?? 64)) throw new ExecUnavailableError("The execution sidecar is busy");
    signal?.throwIfAborted();
    const id = `q${++sequence}`;
    return new Promise<ExecAnswer>((resolve, reject) => {
      const timer = setTimeout(() => {
        console.error("overstoryd execution sidecar missed its deadline; restarting it");
        this.stop(running, new ExecUnavailableError("The execution sidecar took too long"));
      }, this.options.deadlineMs ?? 30_000);
      const abort = () => {
        if (!running.pending.delete(id)) return;
        clearTimeout(timer);
        this.write(running, { cancel: id });
        reject(signal!.reason ?? new Error("Aborted"));
      };
      running.pending.set(id, {
        resolve: (answer) => { signal?.removeEventListener("abort", abort); resolve(answer); },
        reject: (error) => { signal?.removeEventListener("abort", abort); reject(error); },
        timer,
      });
      signal?.addEventListener("abort", abort, { once: true });
      this.write(running, { ...question, id });
    });
  }

  /** End the process, failing what is in flight; the next question starts a new one. */
  kill(): Promise<void> {
    const running = this.running;
    if (!running) return Promise.resolve();
    this.stop(running, new ExecUnavailableError("The execution sidecar stopped"));
    return running.exited;
  }

  private write(running: Running, message: unknown): void {
    try {
      running.process.stdin.write(`${JSON.stringify(message)}\n`);
      running.process.stdin.flush();
    } catch {
      this.stop(running, new ExecUnavailableError("The execution sidecar stopped"));
    }
  }

  private start(): Running {
    if (this.disposed) throw new ExecUnavailableError("The host is stopping");
    if (this.running) return this.running;
    const child = Bun.spawn([...this.command()], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      // Never the host's credentials or configuration.
      env: Object.fromEntries(["PATH", "HOME", "TMPDIR", "LANG", "TZ"].flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]!]])),
    });
    let ready!: (handles: ExecReady["ready"]) => void, unready!: (error: Error) => void;
    const running: Running = {
      process: child,
      ready: new Promise((resolve, reject) => { ready = resolve; unready = reject; }),
      unready,
      pending: new Map(),
      exited: child.exited.then(() => {}),
    };
    running.ready.catch(() => {});
    this.running = running;
    let handshaken = false;
    void (async () => {
      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of child.stdout) {
        buffer += decoder.decode(chunk, { stream: true });
        for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          let value: unknown;
          try { value = JSON.parse(line); } catch { value = undefined; }
          if (!handshaken) {
            const handshake = parseExecReady(value);
            if (!handshake || handshake.ready.version !== 1) {
              this.stop(running, new ExecUnavailableError("The execution sidecar's handshake is not one overstoryd speaks"));
              return;
            }
            handshaken = true;
            ready(handshake.ready);
            continue;
          }
          const answer = parseExecAnswer(value);
          if (!answer) {
            console.error("overstoryd execution sidecar wrote a line that is not an answer; restarting it");
            this.stop(running, new ExecUnavailableError("The execution sidecar failed"));
            return;
          }
          const pending = running.pending.get(answer.id);
          // A cancelled question's late answer.
          if (!pending) continue;
          running.pending.delete(answer.id);
          clearTimeout(pending.timer);
          pending.resolve(answer);
        }
      }
    })().catch(() => {});
    void (async () => {
      const decoder = new TextDecoder();
      for await (const chunk of child.stderr) {
        const text = decoder.decode(chunk).trimEnd();
        if (text) console.error(`[overstoryd-exec] ${text}`);
      }
    })().catch(() => {});
    void running.exited.then(() => this.stop(running, new ExecUnavailableError("The execution sidecar stopped")));
    return running;
  }

  private stop(running: Running, reason: Error): void {
    if (this.running === running) this.running = undefined;
    running.process.kill();
    for (const [id, pending] of running.pending) {
      running.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(reason);
    }
    running.unready(reason);
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.disposed = true;
    await this.kill();
  }
}
