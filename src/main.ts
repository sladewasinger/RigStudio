import {
  state, notify, subscribe, activeClip, serializeDoc, deserializeDoc, EditorMode,
  selectPart, canMoveSelectedInDrawOrder, moveSelectedInDrawOrder,
  setSnapEnabled, selectAllParts, partById,
} from './core/model';
import { importSvg } from './io/importSvg';
import {
  buildCanvas, renderPose, resetView, reorderCanvas, cancelBonePlacement, stepOutFocus,
  hasSelectedNode, deleteSelectedNodes, nudgeSelectedNodes, nudgeSelectedParts,
  zoomBy, selectAllNodes, enterGroupsFor,
} from './view';
import { checkpoint } from './core/history';
import {
  buildLayersPanel, buildInspector, buildCanvasTools, flipAction, groupAction, ungroupAction,
} from './panels';
import {
  buildTimeline, render as renderTimeline, togglePlay,
  copySelectedKeys, pasteKeysAtPlayhead, deleteSelectedKeys, nudgeSelectedKeys,
  hasKeySelection, clearKeySelection,
} from './timeline/timeline';
import { exportLottie } from './io/exportLottie';
import { exportRiv } from './io/exportRiv';
import { smHandleEscape, smHandleDelete } from './panels/smPanel';
import { undo, redo, canUndo, canRedo, resetHistory, setRestoreHandler } from './core/history';
import { toggleHelp, closeHelp, isHelpOpen } from './ui/help';
import { dialog, isDialogOpen, closeActiveDialog } from './ui/dialogs';
import { showContextMenu, isMenuOpen, closeMenu } from './ui/contextMenu';
import { canDuplicateSelection, duplicateSelectedParts, deleteSelectedParts, buildPartContextMenu } from './ui/actions';

const layersEl = document.getElementById('layers')!;
const canvasEl = document.getElementById('canvas')!;
const canvasToolsEl = document.getElementById('canvas-tools')!;
const inspectorEl = document.getElementById('inspector')!;
const timelineEl = document.getElementById('timeline')!;
const fileInput = document.getElementById('file-input') as HTMLInputElement;

const AUTOSAVE_KEY = 'rig-studio-autosave';

function afterDocReplaced(): void {
  state.selectedPartId = null;
  state.selectedPartIds = [];
  state.activeClipIndex = 0;
  state.currentTime = 0;
  state.playing = false;
  clearKeySelection();
  resetHistory(); // no undoing past a document swap
  buildCanvas(canvasEl);
  resetView(); // fit the fresh document (zoom/pan otherwise survives rebuilds)
  notify();
}

function loadSvgText(text: string, name: string): void {
  try {
    state.doc = importSvg(text, name);
    state.editorMode = 'setup'; // fresh art starts in rig-setup
    afterDocReplaced();
  } catch (err) {
    void dialog.alert(`Could not import SVG: ${err instanceof Error ? err.message : err}`);
  }
}

function loadProjectText(text: string): boolean {
  try {
    state.doc = deserializeDoc(text);
    afterDocReplaced();
    return true;
  } catch (err) {
    void dialog.alert(`Could not load project: ${err instanceof Error ? err.message : err}`);
    return false;
  }
}

document.getElementById('btn-open')!.onclick = () => fileInput.click();
fileInput.onchange = async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  const text = await file.text();
  if (/\.json$/i.test(file.name)) loadProjectText(text);
  else loadSvgText(text, file.name);
  fileInput.value = '';
};

document.getElementById('btn-sample')!.onclick = async () => {
  const res = await fetch('/PIP_MASTER.svg');
  if (!res.ok) {
    void dialog.alert('Sample not found — copy PIP_MASTER.svg into public/');
    return;
  }
  loadSvgText(await res.text(), 'pip');
};

// ---- Project save / autosave ----

/** Download the project as .rig.json — the toolbar Save button and Ctrl+S share this.
 *  Shows a filename dialog (default = the doc name) before downloading. */
async function saveProject(): Promise<void> {
  if (!state.doc) {
    await dialog.alert('Nothing to save yet — import an SVG first.');
    return;
  }
  const filename = await dialog.prompt('Save project as', `${state.doc.name}.rig.json`);
  if (!filename) return;
  download(filename, serializeDoc(state.doc), 'application/json');
}
document.getElementById('btn-save')!.onclick = () => { void saveProject(); };

function download(filename: string, content: string | Uint8Array, type: string): void {
  const blob = new Blob([content as BlobPart], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

let autosaveTimer = 0;
function scheduleAutosave(): void {
  if (!state.doc) return;
  window.clearTimeout(autosaveTimer);
  autosaveTimer = window.setTimeout(() => {
    if (state.doc) localStorage.setItem(AUTOSAVE_KEY, serializeDoc(state.doc));
  }, 800);
}
window.addEventListener('beforeunload', () => {
  if (state.doc) localStorage.setItem(AUTOSAVE_KEY, serializeDoc(state.doc));
});

// ---- Exports ----
// Both share the save-project pattern: a filename dialog (default name pre-filled) before
// the download fires.

document.getElementById('btn-export-lottie')!.onclick = () => { void exportLottieFlow(); };
async function exportLottieFlow(): Promise<void> {
  if (!state.doc) {
    await dialog.alert('Import an SVG first.');
    return;
  }
  const defaultName = `${state.doc.name}_${activeClip()?.name ?? 'clip'}.json`;
  const filename = await dialog.prompt('Export Lottie as', defaultName);
  if (!filename) return;
  try {
    const json = exportLottie(state.doc, state.activeClipIndex);
    download(filename, json, 'application/json');
  } catch (err) {
    await dialog.alert(`Lottie export failed: ${err instanceof Error ? err.message : err}`);
  }
}

document.getElementById('btn-export-riv')!.onclick = () => { void exportRivFlow(); };
async function exportRivFlow(): Promise<void> {
  if (!state.doc) {
    await dialog.alert('Import an SVG first.');
    return;
  }
  const filename = await dialog.prompt('Export Rive as', `${state.doc.name}.riv`);
  if (!filename) return;
  try {
    const bytes = exportRiv(state.doc);
    download(filename, bytes, 'application/octet-stream');
  } catch (err) {
    await dialog.alert(`Rive export failed: ${err instanceof Error ? err.message : err}`);
  }
}

// ---- Setup / Animate mode toggle ----

const setupBtn = document.getElementById('btn-mode-setup') as HTMLButtonElement;
const animateBtn = document.getElementById('btn-mode-animate') as HTMLButtonElement;

export function setEditorMode(mode: EditorMode): void {
  if (state.editorMode === mode) return;
  state.editorMode = mode;
  state.playing = false;
  if (mode === 'animate') state.mode = 'rig'; // node editing is Setup-only
  if (mode === 'setup') clearKeySelection();
  notify();
  renderPose();
}

setupBtn.onclick = () => setEditorMode('setup');
animateBtn.onclick = () => setEditorMode('animate');

document.getElementById('btn-help')!.onclick = () => toggleHelp();

function syncModeToggle(): void {
  setupBtn.classList.toggle('active', state.editorMode === 'setup');
  animateBtn.classList.toggle('active', state.editorMode === 'animate');
}

// ---- Canvas context menu ----

/** True hit-target resolution (elementsFromPoint + closest('[data-part-id]'), not the
 *  event's own target) — the same pattern smPanel.ts's preview click-to-listener
 *  dispatch uses, so overlay elements drawn on top of the artwork don't swallow the hit.
 *  Kept in main.ts (not view/) since it's read-only hit-testing against the DOM the
 *  canvas already renders, not a view/ internal. */
function hitPartIdAt(clientX: number, clientY: number): string | null {
  for (const el of document.elementsFromPoint(clientX, clientY)) {
    const partEl = (el as Element).closest?.('[data-part-id]') as HTMLElement | null;
    if (partEl?.dataset.partId) return partEl.dataset.partId;
  }
  return null;
}

// Capture phase per the assignment's spec; contextmenu only fires on a real right-click,
// so this can never interfere with the interaction-test suite's synthetic pointer
// gestures (which only dispatch pointerdown/move/up and click/dblclick).
canvasEl.addEventListener('contextmenu', (ev) => {
  ev.preventDefault();
  const partId = hitPartIdAt(ev.clientX, ev.clientY);
  if (!partId) return; // blank canvas — suppress the browser menu, no app menu
  const part = partById(partId);
  if (!part) return;
  if (!state.selectedPartIds.includes(partId)) {
    selectPart(partId);
    enterGroupsFor(partId);
  } else {
    state.selectedPartId = partId;
  }
  notify();
  renderPose();
  showContextMenu(buildPartContextMenu(part, { canvasExtras: true }), ev.clientX, ev.clientY);
}, true);

// ---- History wiring ----

setRestoreHandler(() => buildCanvas(canvasEl));

const undoBtn = document.getElementById('btn-undo') as HTMLButtonElement;
const redoBtn = document.getElementById('btn-redo') as HTMLButtonElement;
undoBtn.onclick = undo;
redoBtn.onclick = redo;
document.addEventListener('rig-history-changed', () => {
  undoBtn.disabled = !canUndo();
  redoBtn.disabled = !canRedo();
});

// ---- Keyboard shortcuts ----

document.addEventListener('keydown', (ev) => {
  const target = ev.target as HTMLElement;

  // A context menu or dialog owns Escape first — this must win over every other tier
  // below, INCLUDING the input-focus guard right after it, so Escape closes a dialog
  // even while its own text field has focus (mirrors the help-overlay precedence, one
  // level higher since a dialog can itself contain an input).
  if (ev.key === 'Escape' && (isMenuOpen() || isDialogOpen())) {
    ev.preventDefault();
    closeMenu();
    closeActiveDialog();
    return;
  }
  // While a menu or dialog is open, no other shortcut should leak through to the app
  // underneath (e.g. Ctrl+S while the save-filename dialog itself is showing).
  if (isMenuOpen() || isDialogOpen()) return;

  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;

  // Help overlay owns Escape while it's open — this must win over every other Escape
  // tier below (bone placement / node exit / selection clear) so closing it never also
  // fires one of those.
  if (isHelpOpen() && ev.key === 'Escape') {
    ev.preventDefault();
    closeHelp();
    return;
  }

  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'z') {
    ev.preventDefault();
    if (ev.shiftKey) redo();
    else undo();
    return;
  }
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'y') {
    ev.preventDefault();
    redo();
    return;
  }
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 's') {
    ev.preventDefault(); // never let the browser's save-page dialog open
    void saveProject();
    return;
  }
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'o') {
    ev.preventDefault();
    fileInput.click();
    return;
  }
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'a') {
    ev.preventDefault();
    // Node-editing mode selects nodes; Setup/Animate select every part (same
    // multi-selection mechanism Shift+click extends) — never keyframes.
    if (state.editorMode === 'setup' && state.mode === 'nodes') selectAllNodes();
    else selectAllParts();
    notify();
    renderPose();
    return;
  }
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'd') {
    if (canDuplicateSelection()) {
      ev.preventDefault();
      duplicateSelectedParts();
    }
    return;
  }
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'g') {
    ev.preventDefault();
    if (ev.shiftKey) ungroupAction();
    else groupAction();
    return;
  }
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'c') {
    if (state.editorMode === 'animate' && hasKeySelection()) {
      ev.preventDefault();
      copySelectedKeys();
    }
    return;
  }
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'v') {
    if (state.editorMode === 'animate') {
      ev.preventDefault();
      pasteKeysAtPlayhead();
    }
    return;
  }
  if (ev.key === 'Delete' || ev.key === 'Backspace') {
    // State-machine editor owns Delete while the logic view is on screen (removes the
    // selected transition/state before any keyframe/node/part handling below).
    if (smHandleDelete()) {
      ev.preventDefault();
      return;
    }
    if (state.editorMode === 'animate' && hasKeySelection()) {
      ev.preventDefault();
      deleteSelectedKeys();
      return;
    }
    // Node mode: delete the selected path nodes.
    if (state.editorMode === 'setup' && state.mode === 'nodes' && hasSelectedNode()) {
      ev.preventDefault();
      checkpoint();
      deleteSelectedNodes();
      notify();
      return;
    }
    // Setup pose mode: delete the selected layers (children re-adopt grandparents;
    // fully undoable). Node-editing mode with nothing selected falls through to here
    // too, so the mode check stays explicit rather than folding into canDeleteSelection().
    if (
      state.editorMode === 'setup' && state.mode === 'rig' &&
      state.selectedPartIds.length > 0
    ) {
      ev.preventDefault();
      deleteSelectedParts();
    }
    return;
  }
  if (ev.key === 'Tab') {
    ev.preventDefault();
    setEditorMode(state.editorMode === 'setup' ? 'animate' : 'setup');
    return;
  }
  if (ev.key === 'PageUp' || ev.key === 'PageDown') {
    // Step the entered path (within its part) or the selected part through the
    // draw order: PageUp = bring forward (up the layer list), PageDown = send back.
    const delta = ev.key === 'PageUp' ? 1 : -1;
    if (!canMoveSelectedInDrawOrder(delta)) return;
    ev.preventDefault();
    checkpoint();
    moveSelectedInDrawOrder(delta);
    reorderCanvas();
    notify();
    return;
  }
  if (ev.key === 'Escape') {
    // State-machine editor first: cancel an armed transition or stop a running preview.
    if (smHandleEscape()) {
      ev.preventDefault();
      return;
    }
    // Cancel bone placement first, then step out one drill-down level at a time
    // (entered path → deselect → pop the innermost entered group) — Inkscape parity.
    if (cancelBonePlacement()) {
      notify();
      return;
    }
    stepOutFocus();
    notify();
    renderPose();
    return;
  }
  // Help overlay toggle: '?' (Shift+/ on US layouts — browsers already report the
  // shifted character in ev.key) and F1.
  if (ev.key === '?' && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
    ev.preventDefault();
    toggleHelp();
    return;
  }
  if (ev.key === 'F1') {
    ev.preventDefault();
    toggleHelp();
    return;
  }
  // Snapping toggle (%): Inkscape's binding. On US layouts % is Shift+5, so match the
  // resulting character and allow Shift (only ctrl/meta/alt are excluded, per the tool
  // block's guarded pattern).
  if (ev.key === '%' && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
    ev.preventDefault();
    setSnapEnabled(!state.snapEnabled);
    notify();
    renderPose();
    return;
  }
  // Tools: V select, T translate, R rotate, I inverse kinematics.
  if (!ev.ctrlKey && !ev.metaKey && !ev.altKey && !ev.shiftKey) {
    const tool = ({ v: 'select', t: 'translate', r: 'rotate', i: 'ik' } as const)[
      ev.key.toLowerCase() as 'v' | 't' | 'r' | 'i'
    ];
    if (tool) {
      state.tool = tool;
      notify();
      renderPose();
      return;
    }
  }
  // Flips moved to Shift+H / Shift+V (plain V/T/R/I are tools now).
  if (ev.shiftKey && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
    const axis = ev.key.toLowerCase();
    if ((axis === 'h' || axis === 'v') && state.editorMode === 'setup') {
      flipAction(axis);
      return;
    }
  }
  // Zoom in/out ~1.25x, centered on the canvas (guarded the same way as F/Space below —
  // Ctrl+=/Ctrl+- are the browser's own page-zoom shortcuts and must pass through).
  if ((ev.key === '+' || ev.key === '=') && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
    ev.preventDefault();
    zoomBy(1.25);
    return;
  }
  if (ev.key === '-' && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
    ev.preventDefault();
    zoomBy(1 / 1.25);
    return;
  }
  // Guarded against ctrl/meta/alt (mirrors the V/T/R/I tool block's pattern) so
  // Ctrl+F doesn't ALSO fit the view while the browser's find bar opens.
  if (ev.key.toLowerCase() === 'f' && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
    resetView();
    renderPose();
    return;
  }
  if (ev.key === ' ' && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
    ev.preventDefault();
    togglePlay();
    return;
  }
  if (ev.key.startsWith('Arrow')) {
    // Node mode: arrows nudge the selected nodes in document units.
    if (state.editorMode === 'setup' && state.mode === 'nodes' && hasSelectedNode()) {
      ev.preventDefault();
      const step = ev.shiftKey ? 5 : 0.5;
      const dx = ev.key === 'ArrowLeft' ? -step : ev.key === 'ArrowRight' ? step : 0;
      const dy = ev.key === 'ArrowUp' ? -step : ev.key === 'ArrowDown' ? step : 0;
      checkpoint();
      nudgeSelectedNodes(dx, dy);
      return;
    }
    // Setup pose mode: arrows nudge the selected parts, 2 screen px per press
    // (Shift = 20) so the step follows the zoom level. Animate keeps arrows for
    // keyframe nudge / playhead scrub below.
    if (
      state.editorMode === 'setup' && state.mode === 'rig' &&
      state.selectedPartIds.length > 0
    ) {
      ev.preventDefault();
      const px = ev.shiftKey ? 20 : 2;
      const dx = ev.key === 'ArrowLeft' ? -px : ev.key === 'ArrowRight' ? px : 0;
      const dy = ev.key === 'ArrowUp' ? -px : ev.key === 'ArrowDown' ? px : 0;
      checkpoint();
      if (nudgeSelectedParts(dx, dy)) notify();
      return;
    }
    if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
    const clip = activeClip();
    if (!clip || state.editorMode !== 'animate') return;
    ev.preventDefault();
    const step = (ev.shiftKey ? 100 : 10) * (ev.key === 'ArrowLeft' ? -1 : 1);
    // With keyframes selected the arrows nudge them; otherwise they step the playhead.
    if (nudgeSelectedKeys(step)) return;
    state.currentTime = Math.min(clip.duration, Math.max(0, state.currentTime + step));
    renderPose();
    renderTimeline();
  }
});

// Re-render panels on every state change; the canvas pose is updated separately (and
// far more often) by renderPose().
subscribe(() => {
  syncModeToggle();
  buildLayersPanel(layersEl);
  buildCanvasTools(canvasToolsEl);
  buildInspector(inspectorEl);
  renderTimeline();
  scheduleAutosave();
});

document.addEventListener('rig-play', () => {
  // The AI panel starts playback after applying a clip; the timeline owns the RAF loop,
  // so just re-render it with playing=true and let its play button state pick it up.
  renderTimeline();
  renderPose();
});

buildTimeline(timelineEl);

// Restore the previous session, if any.
const autosaved = localStorage.getItem(AUTOSAVE_KEY);
if (autosaved) {
  try {
    state.doc = deserializeDoc(autosaved);
    buildCanvas(canvasEl);
    resetView();
  } catch {
    localStorage.removeItem(AUTOSAVE_KEY);
  }
}
notify();

// Console/debug hook: window.__rigStudio.exportLottie(window.__rigStudio.state.doc, clipIndex)
declare global {
  interface Window {
    __rigStudio: {
      state: typeof state;
      exportLottie: typeof exportLottie;
      exportRiv: typeof exportRiv;
      renderPose: typeof renderPose;
      serializeDoc: typeof serializeDoc;
      loadProjectText: typeof loadProjectText;
      setEditorMode: typeof setEditorMode;
    };
  }
}
window.__rigStudio = {
  state, exportLottie, exportRiv, renderPose, serializeDoc, loadProjectText,
  setEditorMode,
};
