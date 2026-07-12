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
