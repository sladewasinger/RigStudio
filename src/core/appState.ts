// ---- Application state ----

import { Clip, RigDoc, RigPart, RigPath } from './docTypes';

/** The canvas tool within Setup mode: pose the rig or edit path nodes. */
export type Mode = 'rig' | 'nodes';

/**
 * The global editing mode. Setup edits the character itself (rest pose, pivots, nodes)
 * and never touches keyframes; Animate records keyframes at the playhead.
 */
export type EditorMode = 'setup' | 'animate';

/** Canvas transform tool. select = classic drags; the rest add gizmos/solvers. */
export type Tool = 'select' | 'translate' | 'rotate' | 'ik';

export interface AppState {
  doc: RigDoc | null;
  tool: Tool;
  /** Primary selection (inspector target). */
  selectedPartId: string | null;
  /** Full selection set for multi-part posing; always contains selectedPartId when set. */
  selectedPartIds: string[];
  /** A single path within the selected part ("entered" like an SVG editor group), or null. */
  selectedPathId: string | null;
  activeClipIndex: number;
  currentTime: number;
  playing: boolean;
  mode: Mode;
  editorMode: EditorMode;
  playbackSpeed: number;
  pingPong: boolean;
  /** Playback direction, flipped by ping-pong looping. */
  playDirection: 1 | -1;
  onionSkin: boolean;
  /**
   * Whether Setup-mode drags snap (node↔node, pivot↔pivot, bbox features). An EDITOR
   * preference — never serialized into a project; persisted separately in localStorage.
   */
  snapEnabled: boolean;
  /**
   * Freeze (origin-editing) mode: when TRUE the canvas unlocks pivot/origin/joint handle
   * drags (and shows their move cursors plus an unmissable banner + canvas tint); when
   * FALSE — the default — those handles stay VISIBLE but INERT so a stray drag never
   * moves a joint (the constant-accidental-origin-drag complaint). A MOMENTARY app-state
   * flag: toggled by Y / the canvas-tools button / Escape, and — unlike snapEnabled, a
   * saved preference — never serialized into a project and never persisted to localStorage.
   */
  freezeMode: boolean;
  /**
   * Clean-preview (Animate-mode "watch the final animation" toggle, AI Animate System
   * v2 A0): while TRUE every overlay chrome element (selection boxes, handles, pivots,
   * bone/group glyphs+lines, gizmos, snap markers, hints) plus the artboard rect and
   * onion ghosts are hidden — everything that is editor metadata, never part of the
   * exported/played animation. Artwork itself, and selection/drag interactions, are
   * UNCHANGED (chrome just isn't drawn) — see view/overlay.ts and view/render.ts. A
   * MOMENTARY app-state flag exactly like freezeMode: never serialized into a project,
   * never persisted to localStorage. UNLIKE freezeMode it has no explicit reset call in
   * main.ts's afterDocReplaced (main.ts is owned by a different work stream) — instead
   * view/render.ts's renderPose() detects a genuine doc REPLACE (as opposed to an
   * undo/redo, which also swaps `state.doc`'s reference) by checking that the history
   * stacks were just emptied by resetHistory(), which only afterDocReplaced calls, and
   * clears this flag itself at that moment. See render.ts for the detection.
   */
  cleanPreview: boolean;
  /**
   * Unsaved-changes flag backing main.ts's "replace project" confirm guard and the
   * beforeunload warning. Set by history.ts's checkpoint() — the single chokepoint
   * every doc mutation already flows through per this codebase's convention
   * ("checkpoint() before every mutation, once per gesture") — via markDirty()
   * below. Cleared via markClean() when the in-memory doc is known to match
   * something durable: a fresh doc load/replace completes (main.ts's
   * afterDocReplaced, covering New/Open/Load sample, and the boot-time autosave
   * restore) or an explicit project save completes (main.ts's saveProject —
   * downloading the .rig.json). Lottie/.riv export do NOT clear it: they're lossy
   * one-way renders, not project saves, so losing further edits after one of those
   * would still lose real work. Undo/redo don't specially clear it either
   * (deliberate simplification: undoing back past the last save can leave
   * dirty=true even though the doc now matches disk — a safe false positive, never
   * a false negative). Never serialized into a project, never persisted.
   */
  dirty: boolean;
}

/** localStorage key for the snapping preference (a UI setting, not project data). */
const SNAP_STORAGE_KEY = 'rig-studio-snap-enabled';

function readSnapEnabled(): boolean {
  try {
    const v = localStorage.getItem(SNAP_STORAGE_KEY);
    return v === null ? true : v === 'true'; // default ON
  } catch {
    return true; // no localStorage (tests/node) — default ON
  }
}

/** Toggle snapping and persist the choice. */
export function setSnapEnabled(enabled: boolean): void {
  state.snapEnabled = enabled;
  try {
    localStorage.setItem(SNAP_STORAGE_KEY, String(enabled));
  } catch {
    /* persistence unavailable — keep the in-memory flag */
  }
}

export const state: AppState = {
  doc: null,
  tool: 'select',
  selectedPartId: null,
  selectedPartIds: [],
  selectedPathId: null,
  activeClipIndex: 0,
  currentTime: 0,
  playing: false,
  mode: 'rig',
  editorMode: 'setup',
  playbackSpeed: 1,
  pingPong: false,
  playDirection: 1,
  onionSkin: false,
  snapEnabled: readSnapEnabled(),
  freezeMode: false,
  cleanPreview: false,
  dirty: false,
};

/** Toggle freeze (origin-editing) mode. App state only — never serialized or persisted. */
export function setFreezeMode(on: boolean): void {
  state.freezeMode = on;
}

/** Toggle clean-preview mode. App state only — never serialized or persisted; see the
 *  `cleanPreview` field's doc comment on AppState for the reset-on-doc-replace rule. */
export function setCleanPreview(on: boolean): void {
  state.cleanPreview = on;
}

/** Mark the document as having unsaved changes. Called from history.ts's
 *  checkpoint() — see the `dirty` field's doc comment on AppState for the full rule. */
export function markDirty(): void {
  state.dirty = true;
}

/** Mark the document clean (matches something durable) — called after a full doc
 *  replace completes (main.ts's afterDocReplaced) or a project save completes
 *  (main.ts's saveProject). See the `dirty` field's doc comment for the full rule. */
export function markClean(): void {
  state.dirty = false;
}

type Listener = () => void;
const listeners: Listener[] = [];

/** Subscribe to any state/document change. Panels re-render on notify(). */
export function subscribe(fn: Listener): void {
  listeners.push(fn);
}

export function notify(): void {
  for (const fn of listeners) fn();
}

export function activeClip(): Clip | null {
  if (!state.doc) return null;
  return state.doc.clips[state.activeClipIndex] ?? null;
}

export function selectedPart(): RigPart | null {
  if (!state.doc || !state.selectedPartId) return null;
  return state.doc.parts.find((p) => p.id === state.selectedPartId) ?? null;
}

export function selectedParts(): RigPart[] {
  if (!state.doc) return [];
  return state.selectedPartIds
    .map((id) => state.doc!.parts.find((p) => p.id === id))
    .filter((p): p is RigPart => !!p);
}

/** Set or extend the selection. Additive keeps existing parts (shift-click). */
export function selectPart(id: string | null, additive = false): void {
  if (id !== state.selectedPartId) state.selectedPathId = null;
  if (id === null) {
    state.selectedPartId = null;
    state.selectedPartIds = [];
    return;
  }
  if (additive) {
    if (!state.selectedPartIds.includes(id)) state.selectedPartIds.push(id);
    state.selectedPartId = id;
  } else {
    state.selectedPartId = id;
    state.selectedPartIds = [id];
  }
}

export function selectedPath(): { part: RigPart; path: RigPath } | null {
  const part = selectedPart();
  if (!part || !state.selectedPathId) return null;
  const path = part.paths.find((p) => p.id === state.selectedPathId);
  return path ? { part, path } : null;
}

/**
 * Select every part in the document (Ctrl+A in Setup/Animate) — the same additive
 * selection mechanism a chain of Shift+clicks would produce, just applied at once.
 */
export function selectAllParts(): void {
  if (!state.doc) return;
  state.selectedPartIds = state.doc.parts.map((p) => p.id);
  state.selectedPartId = state.selectedPartIds[state.selectedPartIds.length - 1] ?? null;
  state.selectedPathId = null;
}
