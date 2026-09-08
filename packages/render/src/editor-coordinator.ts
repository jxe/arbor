import type { ArborBlock } from "@arbor/core";
import type { NodeResponse } from "@arbor/arborsync-client";
import {
  ADMISSION_DEBOUNCE_MS,
  DocumentAdmissionController,
  admissionIsDirty,
  initialAdmissionState,
  type AdmissionClock,
  type AdmissionFailure,
  type AdmissionObservation,
  type AdmissionResult,
  type AdmissionState,
  type AdmissionTransport,
} from "@arbor/arborsync-client";
import { mergeBlocks } from "@arbor/editor";
import { nodeDocument } from "./node-presentation.ts";

/** Persistence debounce: the admission machine's reference value. */
export const AUTOSAVE_DELAY_MS = ADMISSION_DEBOUNCE_MS;
/** Undo grouping is a separate clock from persistence. */
export const HISTORY_GROUP_DELAY_MS = 750;

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

export type EditorClock = AdmissionClock;

export interface ExternalObservationAnchor {
  generation: number;
  revision: string;
}

interface EditorCoordinatorCallbacks {
  capture(): DocumentSnapshot;
  write(path: string, baseRevision: string, snapshot: DocumentSnapshot, base: DocumentSnapshot): Promise<NodeResponse>;
  applySnapshot(snapshot: DocumentSnapshot): void;
  acceptNode(node: NodeResponse): void;
  notify(): void;
}

interface EditorCoordinatorOptions extends EditorCoordinatorCallbacks {
  path: string;
  revision: string;
  baseBlocks: ArborBlock[];
  baseFrontmatter: Record<string, unknown>;
  initialSnapshot: DocumentSnapshot;
  /** Explicit transport kind. A Canopy-backed document never runs the local block merge. */
  transport?: AdmissionTransport;
  admissionBasis?: string;
  autosaveDelay?: number;
  historyDelay?: number;
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

function snapshotOf(node: NodeResponse): DocumentSnapshot {
  const document = nodeDocument(node);
  return {
    blocks: structuredClone(document?.blocks ?? []),
    frontmatter: structuredClone(document?.frontmatter ?? {}),
  };
}

function observationOf(node: NodeResponse): AdmissionObservation<DocumentSnapshot> {
  return {
    source: snapshotOf(node),
    revision: node.capabilities.content?.revision!,
    ...(node.admissionBasis ? { admissionBasis: node.admissionBasis } : {}),
    acceptedRequestDigests: node.acceptedRequestDigests ?? [],
  };
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

/**
 * Web editor host for the Arbor Sync document admission machine. It keeps
 * BlockNote capture, serialization, undo history, and presentation; the
 * machine in `@arbor/arborsync-client` owns every timer, in-flight, successor,
 * flush, observation, failure, and conflict transition.
 */
export class EditorCoordinator {
  readonly path: string;
  private callbacks: EditorCoordinatorCallbacks;
  private readonly clock: EditorClock;
  private readonly historyDelay: number;
  private readonly machine: DocumentAdmissionController<DocumentSnapshot>;
  private messageValue: string | null = null;
  private applying = false;
  private observed: DocumentSnapshot;
  private documentDraft: { before: DocumentSnapshot; after: DocumentSnapshot } | null = null;
  private historyTimer: unknown = null;
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private disposed = false;
  /** Nodes keyed by revision so an accepted result or observation can be handed back to the view. */
  private readonly nodes = new Map<string, NodeResponse>();

  constructor(options: EditorCoordinatorOptions) {
    this.path = options.path;
    this.observed = cloneSnapshot(options.initialSnapshot);
    this.callbacks = options;
    this.clock = options.clock ?? systemClock;
    this.historyDelay = options.historyDelay ?? HISTORY_GROUP_DELAY_MS;
    const base = {
      blocks: structuredClone(options.baseBlocks),
      frontmatter: structuredClone(options.baseFrontmatter),
    };
    this.machine = new DocumentAdmissionController<DocumentSnapshot>(
      initialAdmissionState(
        { source: base, revision: options.revision, ...(options.admissionBasis ? { admissionBasis: options.admissionBasis } : {}) },
        options.transport ?? (options.admissionBasis ? "canopy" : "local"),
      ),
      { equal: sameSnapshot, debounceMs: options.autosaveDelay ?? AUTOSAVE_DELAY_MS },
      {
        admit: async (effect) => {
          const saved = await this.callbacks.write(this.path, effect.baseRevision, effect.source, this.base);
          this.nodes.set(saved.capabilities.content!.revision, saved);
          return {
            source: snapshotOf(saved),
            revision: saved.capabilities.content!.revision,
            ...(saved.admissionBasis ? { admissionBasis: saved.admissionBasis } : {}),
            ...(saved.admissionRequestDigest ? { requestDigest: saved.admissionRequestDigest } : {}),
          };
        },
        classify: (error) => {
          const failure = error as Error & { status?: number; payload?: { current?: NodeResponse } };
          if (failure.status === 409) {
            const current = failure.payload?.current;
            if (current?.content) this.nodes.set(current.capabilities.content!.revision, current);
            return { conflict: true, current: current?.content ? observationOf(current) : undefined };
          }
          return {
            conflict: false,
            error: { message: error instanceof Error ? error.message : String(error), retryable: true },
          };
        },
        acknowledge: (result) => this.acknowledge(result),
        apply: (source, revision) => this.applyAuthoritative(source, revision),
        mergeLocally: (effect) => this.mergeLocally(effect.current, effect.submitted, effect.base),
        surfaceConflict: () => this.setMessage("This document changed elsewhere. Use the current version or keep this version."),
        surfaceFailure: (error: AdmissionFailure) => this.setMessage(error.message),
        changed: () => this.notify(),
      },
      this.clock,
    );
  }

  configure(callbacks: Partial<EditorCoordinatorCallbacks>): void {
    this.callbacks = { ...this.callbacks, ...callbacks };
  }

  get admissionState(): AdmissionState<DocumentSnapshot> { return this.machine.state; }
  get saveState(): SaveState {
    switch (this.machine.state.kind) {
      case "clean":
      case "admitted-awaiting-authority":
      case "closed":
        return "saved";
      case "dirty":
        return "changed";
      case "submitting":
      case "submitting-dirty":
        return "saving";
      case "conflict":
        return "conflict";
      case "failed":
        return "error";
    }
  }
  get message(): string | null { return this.messageValue; }
  get currentRevision(): string { return this.machine.state.accepted.revision; }
  get isApplying(): boolean { return this.applying; }
  get isDirty(): boolean { return admissionIsDirty(this.machine.state); }
  get canUndo(): boolean { return this.undoStack.length > 0 || this.documentDraft !== null; }
  get canRedo(): boolean { return this.redoStack.length > 0; }
  private get base(): DocumentSnapshot { return this.machine.state.accepted.source; }

  captureExternalObservation(): ExternalObservationAnchor {
    return this.machine.anchor();
  }

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

  markAuthored(snapshot: DocumentSnapshot): void {
    if (this.applying) {
      this.observed = cloneSnapshot(snapshot);
      return;
    }
    if (this.disposed) return;
    const after = cloneSnapshot(snapshot);
    const before = this.observed;
    this.observed = after;
    if (sameSnapshot(after, before)) return;
    if (!this.documentDraft) this.documentDraft = { before, after };
    else this.documentDraft.after = after;
    if (this.historyTimer !== null) this.clock.clearTimeout(this.historyTimer);
    this.historyTimer = this.clock.setTimeout(() => {
      this.historyTimer = null;
      this.flushHistory();
    }, this.historyDelay);
    this.messageValue = null;
    this.machine.dispatch({ type: "edit", source: after });
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
    } finally {
      this.applying = false;
    }
    this.messageValue = null;
    this.machine.dispatch({ type: "edit", source: cloneSnapshot(snapshot) });
    // History navigation is an explicit user action: admit it without waiting for the debounce.
    this.machine.dispatch({ type: "flush" });
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

  /** The view re-rendered from server props; treat it as an observation of that node with the displayed content. */
  reconcileServer(node: NodeResponse, displayed: DocumentSnapshot): void {
    this.nodes.set(node.capabilities.content?.revision!, node);
    const observation = { ...observationOf(node), source: cloneSnapshot(displayed) };
    const before = this.machine.state;
    this.machine.dispatch({ type: "observed", observation });
    if (before.kind === "clean" && this.machine.state.kind === "clean" && before.accepted.revision === observation.revision) {
      // Same revision, freshly displayed: keep the observed tree aligned with the view.
      this.applying = true;
      try {
        if (!sameSnapshot(this.observed, displayed)) this.callbacks.applySnapshot(cloneSnapshot(displayed));
        this.observed = cloneSnapshot(displayed);
      } finally {
        this.applying = false;
      }
    }
  }

  observeExternal(node: NodeResponse, anchor?: ExternalObservationAnchor): void {
    this.nodes.set(node.capabilities.content?.revision!, node);
    this.machine.dispatch({ type: "observed", observation: observationOf(node), ...(anchor ? { anchor } : {}) });
  }

  /** Explicit save; `forceRevision` resubmits the latest local source against that revision after a conflict. */
  async save(forceRevision?: string): Promise<void> {
    if (forceRevision !== undefined && this.machine.state.kind === "conflict") {
      const current = this.nodes.get(forceRevision);
      if (current) {
        this.machine.dispatch({
          type: "admissionConflicted",
          generation: this.machine.state.submitted.generation,
          current: observationOf(current),
        });
      }
      this.machine.dispatch({ type: "resolveConflict", choice: "keep-submitted" });
    } else if (this.machine.state.kind === "failed") {
      this.machine.dispatch({ type: "retry" });
    }
    await this.machine.flush();
  }

  /** Drain: force the latest source through and fail loudly if it could not become durable. */
  async flush(): Promise<void> {
    await this.machine.flush();
    if (this.isDirty) throw new Error("Resolve or retry the unsaved document changes before changing the filesystem.");
  }

  private acknowledge(result: AdmissionResult<DocumentSnapshot>): void {
    const node = this.nodes.get(result.revision);
    if (node) this.callbacks.acceptNode(node);
  }

  private applyAuthoritative(source: DocumentSnapshot, revision: string): void {
    const node = this.nodes.get(revision);
    this.applying = true;
    try {
      this.callbacks.applySnapshot(cloneSnapshot(source));
      this.observed = cloneSnapshot(source);
    } finally {
      this.applying = false;
    }
    if (node) this.callbacks.acceptNode(node);
    this.messageValue = null;
  }

  /** Local transport only: try the block-level merge, then resubmit the merged tree or surface the conflict. */
  private mergeLocally(
    current: AdmissionObservation<DocumentSnapshot> | undefined,
    submitted: DocumentSnapshot,
    base: DocumentSnapshot,
  ): void {
    if (!current) {
      this.setMessage("This document changed on disk. Use the disk version or keep this version.");
      return;
    }
    const merged = mergeBlocks(base.blocks, submitted.blocks, current.source.blocks);
    if (merged.conflicts.length) {
      this.setMessage(`${merged.conflicts.length} block conflict${merged.conflicts.length === 1 ? "" : "s"}. Use the disk version or keep this version.`);
      return;
    }
    const mergedSnapshot = { blocks: merged.blocks, frontmatter: submitted.frontmatter };
    // Rebase on the current revision, then put the merged tree back in the
    // editor and resubmit it at once as one new generation.
    this.machine.dispatch({ type: "resolveConflict", choice: "use-current" });
    this.applying = true;
    try {
      this.callbacks.applySnapshot(cloneSnapshot(mergedSnapshot));
      this.observed = cloneSnapshot(mergedSnapshot);
    } finally {
      this.applying = false;
    }
    if (!sameSnapshot(mergedSnapshot, submitted)) {
      this.pushHistory({
        label: "Merge external changes",
        undo: () => this.applyHistorySnapshot(submitted),
        redo: () => this.applyHistorySnapshot(mergedSnapshot),
      });
    }
    this.messageValue = "Merged an external edit.";
    this.machine.dispatch({ type: "edit", source: cloneSnapshot(mergedSnapshot) });
    this.machine.dispatch({ type: "flush" });
  }

  useDisk(node: NodeResponse, local: DocumentSnapshot, disk: DocumentSnapshot): void {
    this.flushHistory();
    this.pushHistory({
      label: "Use disk version",
      undo: () => this.applyHistorySnapshot(local),
      redo: () => this.applyHistorySnapshot(disk),
    });
    this.nodes.set(node.capabilities.content?.revision!, node);
    if (this.machine.state.kind === "conflict") {
      this.machine.dispatch({
        type: "admissionConflicted",
        generation: this.machine.state.submitted.generation,
        current: { ...observationOf(node), source: cloneSnapshot(disk) },
      });
      this.machine.dispatch({ type: "resolveConflict", choice: "use-current" });
    } else {
      this.machine.dispatch({ type: "observed", observation: { ...observationOf(node), source: cloneSnapshot(disk) } });
    }
    this.messageValue = null;
    this.notify();
  }

  /**
   * Release history timers and close the machine. App-owned navigation and
   * lifecycle paths should call `flush()` first and surface failure; if the
   * view unmounts with pending intent anyway, the machine drains it before
   * closing so nothing authored is silently dropped. The result is observable
   * through `admissionState` until close.
   */
  dispose(): Promise<void> {
    this.disposed = true;
    if (this.historyTimer !== null) this.clock.clearTimeout(this.historyTimer);
    this.historyTimer = null;
    this.documentDraft = null;
    const close = () => this.machine.dispatch({ type: "close" });
    if (!this.isDirty) {
      close();
      return Promise.resolve();
    }
    return this.machine.flush().finally(close);
  }
}
