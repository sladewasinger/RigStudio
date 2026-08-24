/**
 * Undo/redo history.
 *
 * The document is plain JSON data, so history is snapshot-based: call [checkpoint]
 * immediately BEFORE any mutation (one call per user gesture — a whole drag is a single
 * checkpoint at pointer-down, so undo reverts the entire drag). Undo/redo swap the live
 * document with a snapshot and rebuild the canvas via the restore handler.
 *
 * checkpoint() is also the unsaved-changes guard's single chokepoint: it marks
 * state.dirty (model.ts's markDirty) since every doc mutation in the app is preceded
 * by a checkpoint() call. See the `dirty` field's doc comment on AppState for the
 * full set/clear rule.
 */

import { state, notify, markDirty, RigDoc } from './model';

const MAX_ENTRIES = 100;

let undoStack: RigDoc[] = [];
let redoStack: RigDoc[] = [];
let restoreHandler: (() => void) | null = null;

/** main.ts registers the canvas rebuild here (avoids a view <-> history import cycle). */
export function setRestoreHandler(fn: () => void): void {
  restoreHandler = fn;
}

export function checkpoint(): void {
  if (!state.doc) return;
  markDirty();
  undoStack.push(structuredClone(state.doc));
  if (undoStack.length > MAX_ENTRIES) undoStack.shift();
  redoStack = [];
  announce();
}

export interface CheckpointTransaction {
  commit(): void;
  /**
   * Discard this checkpoint after the caller has restored any live mutations it made.
   * This is for cancelable pointer gestures: Escape/pointercancel must leave neither a
   * document edit nor a phantom undo/dirty entry behind.
   */
  cancel(): void;
}

/**
 * Start one checkpoint that can still be discarded while a gesture is in flight.
 * Callers must restore their own live model fields before `cancel()`; keeping that
 * restoration local avoids replacing `state.doc` and invalidating pointer-held object
 * references. A settled transaction is idempotent.
 */
export function beginCheckpointTransaction(): CheckpointTransaction {
  const undoDepth = undoStack.length;
  const redoBefore = redoStack;
  const dirtyBefore = state.dirty;
  checkpoint();
  let settled = false;
  return {
    commit() {
      settled = true;
    },
    cancel() {
      if (settled) return;
      settled = true;
      if (undoStack.length !== undoDepth + 1) {
        throw new Error('Cannot cancel a checkpoint after another history entry was added');
      }
      undoStack.pop();
      redoStack = redoBefore;
      state.dirty = dirtyBefore;
      announce();
    },
  };
}

export function undo(): void {
  if (!state.doc || undoStack.length === 0) return;
  redoStack.push(structuredClone(state.doc));
  state.doc = undoStack.pop()!;
  restore();
}

export function redo(): void {
  if (!state.doc || redoStack.length === 0) return;
  undoStack.push(structuredClone(state.doc));
  state.doc = redoStack.pop()!;
  restore();
}

export const canUndo = (): boolean => undoStack.length > 0;
export const canRedo = (): boolean => redoStack.length > 0;

/** Clear everything (on import — there is no undoing past a document swap). */
export function resetHistory(): void {
  undoStack = [];
  redoStack = [];
  announce();
}

function restore(): void {
  const doc = state.doc!;
  // The restored snapshot may not contain the current selection/clip/time.
  if (state.selectedPartId && !doc.parts.some((p) => p.id === state.selectedPartId)) {
    state.selectedPartId = null;
  }
  if (state.activeClipIndex >= doc.clips.length) {
    state.activeClipIndex = Math.max(0, doc.clips.length - 1);
  }
  const clip = doc.clips[state.activeClipIndex];
  if (clip && state.currentTime > clip.duration) state.currentTime = clip.duration;

  restoreHandler?.();
  notify();
  announce();
}

function announce(): void {
  document.dispatchEvent(new CustomEvent('rig-history-changed'));
}
