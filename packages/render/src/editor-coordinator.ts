import type { ArborBlock } from "@arbor/core";
import type { NodeSnapshot } from "@arbor/client";
import { mergeBlocks } from "@arbor/editor";

export const AUTOSAVE_DELAY_MS = 750;

export type SaveState = "saved" | "changed" | "saving" | "external" | "conflict" | "error";

export interface DocumentSnapshot {
  blocks: ArborBlock[];
  frontmatter: Record<string, unknown>;
}

export interface HistoryEntry {
  label: string;
  undo(): Promise<void>;
  redo(): Promise<void>;
}

export interface EditorClock {
  setTimeout(callback: () => void, delay: number): unknown;
  clearTimeout(handle: unknown): void;
}

interface EditorCoordinatorCallbacks {
  capture(): DocumentSnapshot;
  write(path: string, baseRevision: string, snapshot: DocumentSnapshot, base: DocumentSnapshot): Promise<NodeSnapshot>;
  applySnapshot(snapshot: DocumentSnapshot): void;
  acceptNode(node: NodeSnapshot): void;
  notify(): void;
}

interface EditorCoordinatorOptions extends EditorCoordinatorCallbacks {
  path: string;
  revision: string;
  baseBlocks: ArborBlock[];
  baseFrontmatter: Record<string, unknown>;
  initialSnapshot: DocumentSnapshot;
  autosaveDelay?: number;
  clock?: EditorClock;
}

const systemClock: EditorClock = {
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function cloneSnapshot(snapshot: DocumentSnapshot): DocumentSnapshot {
  return structuredClone(snapshot);
}

function sameSnapshot(left: DocumentSnapshot, right: DocumentSnapshot): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function frontmatterPatch(
  base: Record<string, unknown>,
  value: Record<string, unknown>,
): Record<string, unknown | null> {
  const result: Record<string, unknown | null> = {};
  for (const key of new Set([...Object.keys(base), ...Object.keys(value)])) {
    if (!(key in value)) result[key] = null;
    else if (JSON.stringify(base[key]) !== JSON.stringify(value[key])) result[key] = value[key];
  }
  return result;
}

export class EditorCoordinator {
  readonly path: string;
  private callbacks: EditorCoordinatorCallbacks;
  private readonly clock: EditorClock;
  private readonly autosaveDelay: number;
  private generationValue = 0;
  private durableGenerationValue = 0;
  private revision: string;
  private base: DocumentSnapshot;
  private stateValue: SaveState = "saved";
  private messageValue: string | null = null;
  private saveTimer: unknown = null;
  private saveInFlight: Promise<void> | null = null;
  private applying = false;
  private observed: DocumentSnapshot;
  private documentDraft: { before: DocumentSnapshot; after: DocumentSnapshot } | null = null;
  private historyTimer: unknown = null;
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private disposed = false;

  constructor(options: EditorCoordinatorOptions) {
    this.path = options.path;
    this.revision = options.revision;
    this.base = {
      blocks: structuredClone(options.baseBlocks),
      frontmatter: structuredClone(options.baseFrontmatter),
    };
    this.observed = cloneSnapshot(options.initialSnapshot);
    this.callbacks = options;
    this.clock = options.clock ?? systemClock;
    this.autosaveDelay = options.autosaveDelay ?? AUTOSAVE_DELAY_MS;
  }

  configure(callbacks: Partial<EditorCoordinatorCallbacks>): void {
    this.callbacks = { ...this.callbacks, ...callbacks };
  }

  get saveState(): SaveState { return this.stateValue; }
  get message(): string | null { return this.messageValue; }
  get currentRevision(): string { return this.revision; }
  get isApplying(): boolean { return this.applying; }
  get isDirty(): boolean { return this.generationValue > this.durableGenerationValue; }
  get canUndo(): boolean { return this.undoStack.length > 0 || this.documentDraft !== null; }
  get canRedo(): boolean { return this.redoStack.length > 0; }

  runNormalization<T>(callback: () => T): T {
    this.applying = true;
    try {
      return callback();
    } finally {
      this.applying = false;
    }
  }

  applyNormalizationSnapshot(snapshot: DocumentSnapshot): void {
    this.runNormalization(() => this.callbacks.applySnapshot(cloneSnapshot(snapshot)));
    this.observed = cloneSnapshot(snapshot);
  }

  setMessage(message: string | null): void {
    this.messageValue = message;
    this.notify();
  }

  private notify(): void {
    this.callbacks.notify();
  }

  private setStatus(state: SaveState, message = this.messageValue): void {
    this.stateValue = state;
    this.messageValue = message;
    this.notify();
  }

  private scheduleSave(delay = this.autosaveDelay): void {
    if (this.disposed) return;
    if (this.saveTimer !== null) this.clock.clearTimeout(this.saveTimer);
    this.saveTimer = this.clock.setTimeout(() => {
      this.saveTimer = null;
      void this.save();
    }, delay);
  }

  markAuthored(snapshot: DocumentSnapshot): void {
    if (this.applying) {
      this.observed = cloneSnapshot(snapshot);
      return;
    }
    const after = cloneSnapshot(snapshot);
    const before = this.observed;
    this.observed = after;
    if (!this.documentDraft) this.documentDraft = { before, after };
    else this.documentDraft.after = after;
    if (this.historyTimer !== null) this.clock.clearTimeout(this.historyTimer);
    this.historyTimer = this.clock.setTimeout(() => {
      this.historyTimer = null;
      this.flushHistory();
    }, this.autosaveDelay);
    this.generationValue += 1;
    this.setStatus("changed", null);
    this.scheduleSave();
  }

  flushHistory(): void {
    if (this.historyTimer !== null) {
      this.clock.clearTimeout(this.historyTimer);
      this.historyTimer = null;
    }
    const draft = this.documentDraft;
    this.documentDraft = null;
    if (!draft || sameSnapshot(draft.before, draft.after)) return;
    this.pushHistory({
      label: "Edit document",
      undo: () => this.applyHistorySnapshot(draft.before),
      redo: () => this.applyHistorySnapshot(draft.after),
    });
  }

  pushHistory(entry: HistoryEntry): void {
    this.undoStack.push(entry);
    this.redoStack = [];
    this.notify();
  }

  private async applyHistorySnapshot(snapshot: DocumentSnapshot): Promise<void> {
    this.applying = true;
    try {
      this.callbacks.applySnapshot(cloneSnapshot(snapshot));
      this.observed = cloneSnapshot(snapshot);
      this.generationValue += 1;
      this.setStatus("changed", null);
      this.scheduleSave(0);
    } finally {
      this.applying = false;
    }
  }

  async undo(): Promise<void> {
    this.flushHistory();
    const entry = this.undoStack.at(-1);
    if (!entry) return;
    try {
      this.setMessage(null);
      await entry.undo();
      this.undoStack.pop();
      this.redoStack.push(entry);
      this.notify();
    } catch (error) {
      this.setMessage(`Could not undo ${entry.label.toLowerCase()}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async redo(): Promise<void> {
    const entry = this.redoStack.at(-1);
    if (!entry) return;
    try {
      this.setMessage(null);
      await entry.redo();
      this.redoStack.pop();
      this.undoStack.push(entry);
      this.notify();
    } catch (error) {
      this.setMessage(`Could not redo ${entry.label.toLowerCase()}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  reconcileServer(node: NodeSnapshot, displayed: DocumentSnapshot): void {
    this.revision = node.contentRevision!;
    this.base = {
      blocks: structuredClone(node.document?.blocks ?? []),
      frontmatter: structuredClone(node.document?.frontmatter ?? {}),
    };
    if (this.isDirty || this.saveInFlight) return;
    this.applying = true;
    try {
      if (!sameSnapshot(this.observed, displayed)) this.callbacks.applySnapshot(cloneSnapshot(displayed));
      this.observed = cloneSnapshot(displayed);
      this.setStatus("saved", null);
    } finally {
      this.applying = false;
    }
  }

  observeExternal(node: NodeSnapshot): void {
    if (this.isDirty || this.saveInFlight) {
      this.setStatus("external");
      this.scheduleSave(0);
      return;
    }
    this.revision = node.contentRevision!;
    this.base = {
      blocks: structuredClone(node.document?.blocks ?? []),
      frontmatter: structuredClone(node.document?.frontmatter ?? {}),
    };
    this.callbacks.acceptNode(node);
    this.setStatus("saved", null);
  }

  async save(forceRevision?: string): Promise<void> {
    if (this.saveInFlight) {
      await this.saveInFlight;
      if (this.isDirty) return this.save(forceRevision);
      return;
    }
    const savingGeneration = this.generationValue;
    if (savingGeneration <= this.durableGenerationValue && !forceRevision) return;
    const local = cloneSnapshot(this.callbacks.capture());
    const execute = async () => {
      this.setStatus("saving", null);
      try {
        let saved: NodeSnapshot;
        try {
          saved = await this.callbacks.write(this.path, forceRevision ?? this.revision, local, this.base);
        } catch (error) {
          const conflict = error as Error & { status?: number; payload?: { current?: NodeSnapshot } };
          if (conflict.status !== 409 || !conflict.payload?.current?.document) throw error;
          const current = conflict.payload.current;
          const currentDocument = current.document!;
          const merged = mergeBlocks(this.base.blocks, local.blocks, currentDocument.blocks);
          if (merged.conflicts.length) {
            this.setStatus(
              "conflict",
              `${merged.conflicts.length} block conflict${merged.conflicts.length === 1 ? "" : "s"}. Use the disk version or keep this version.`,
            );
            return;
          }
          const mergedSnapshot = { blocks: merged.blocks, frontmatter: local.frontmatter };
          saved = await this.callbacks.write(this.path, current.contentRevision!, mergedSnapshot, this.base);
          if (!sameSnapshot(mergedSnapshot, local)) {
            this.applying = true;
            try {
              this.callbacks.applySnapshot(cloneSnapshot(mergedSnapshot));
              this.observed = cloneSnapshot(mergedSnapshot);
            } finally {
              this.applying = false;
            }
            this.pushHistory({
              label: "Merge external changes",
              undo: () => this.applyHistorySnapshot(local),
              redo: () => this.applyHistorySnapshot(mergedSnapshot),
            });
          }
          this.setMessage("Merged an external edit.");
        }
        this.revision = saved.contentRevision!;
        this.base = {
          blocks: structuredClone(saved.document?.blocks ?? []),
          frontmatter: structuredClone(saved.document?.frontmatter ?? {}),
        };
        this.durableGenerationValue = Math.max(this.durableGenerationValue, savingGeneration);
        this.callbacks.acceptNode(saved);
        if (this.generationValue === savingGeneration) this.setStatus("saved", this.messageValue);
        else {
          this.setStatus("changed", this.messageValue);
          this.scheduleSave(0);
        }
      } catch (error) {
        this.setStatus("error", error instanceof Error ? error.message : String(error));
      }
    };
    const running = execute().finally(() => {
      if (this.saveInFlight === running) this.saveInFlight = null;
    });
    this.saveInFlight = running;
    await running;
  }

  async flush(): Promise<void> {
    if (this.saveTimer !== null) {
      this.clock.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.isDirty) await this.save();
    if (this.saveInFlight) await this.saveInFlight;
    if (this.isDirty) await this.save();
    if (this.isDirty) throw new Error("Resolve or retry the unsaved document changes before changing the filesystem.");
  }

  useDisk(node: NodeSnapshot, local: DocumentSnapshot, disk: DocumentSnapshot): void {
    this.flushHistory();
    this.pushHistory({
      label: "Use disk version",
      undo: () => this.applyHistorySnapshot(local),
      redo: () => this.applyHistorySnapshot(disk),
    });
    this.generationValue = this.durableGenerationValue;
    this.revision = node.contentRevision!;
    this.base = cloneSnapshot(disk);
    this.applying = true;
    try {
      this.callbacks.applySnapshot(cloneSnapshot(disk));
      this.observed = cloneSnapshot(disk);
    } finally {
      this.applying = false;
    }
    this.callbacks.acceptNode(node);
    this.setStatus("saved", null);
  }

  dispose(): void {
    this.disposed = true;
    if (this.saveTimer !== null) this.clock.clearTimeout(this.saveTimer);
    if (this.historyTimer !== null) this.clock.clearTimeout(this.historyTimer);
    this.saveTimer = null;
    this.historyTimer = null;
    this.documentDraft = null;
    if (this.isDirty) void this.save();
  }
}
