import { appendFile, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { decodeControl, type ControlStore, type UpdateControl } from "../control.ts";

/** `<root>/sync/update-control.json` and its diagnostic `events.jsonl`, the same files Swift's runner keeps. */
export class FileControlStore implements ControlStore {
  readonly path: string;
  readonly eventsPath: string;
  constructor(stateRoot: string) {
    this.path = resolve(stateRoot, "sync", "update-control.json");
    this.eventsPath = resolve(stateRoot, "sync", "events.jsonl");
  }

  async load(): Promise<UpdateControl> {
    let text: string;
    try { text = await readFile(this.path, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schema: 4, settled: [] };
      throw error;
    }
    return decodeControl(JSON.parse(text));
  }

  async write(control: UpdateControl, phase: string): Promise<void> {
    const directory = dirname(this.path), temporary = `${this.path}.${crypto.randomUUID()}.tmp`;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(JSON.stringify({ ...control, schema: 4 })); await file.sync(); } finally { await file.close(); }
      await rename(temporary, this.path);
      const dir = await open(directory, "r"); try { await dir.sync(); } finally { await dir.close(); }
    } finally { await rm(temporary, { force: true }); }
    // Scheduling and persistence evidence that outlives the cleared control.
    // Never authored source or credentials: the change log holds the work.
    await appendFile(this.eventsPath, JSON.stringify({ timestamp: Date.now() / 1000, phase, schema: 4,
      attempt: control.attempt?.digest ?? "", tip: control.attemptTip ?? "", candidate: control.attempt?.candidate ?? "",
      held: control.held?.reason ?? "", settled: control.settled.length }) + "\n", { mode: 0o600 });
  }
}
