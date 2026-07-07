import {
  state, notify, subscribe, activeClip, serializeDoc, deserializeDoc, EditorMode,
  selectPart, canMoveSelectedInDrawOrder, moveSelectedInDrawOrder, deleteParts,
} from './model';
import { importSvg } from './importSvg';
import {
  buildCanvas, renderPose, resetView, reorderCanvas, cancelBonePlacement, clearGroupEntry,
  hasSelectedNode, deleteSelectedNodes, nudgeSelectedNodes, unregisterPart,
} from './view';
import { checkpoint } from './history';
import {
  buildLayersPanel, buildInspector, buildCanvasTools, flipAction, groupAction, ungroupAction,
} from './panels';
import {
  buildTimeline, render as renderTimeline, togglePlay,
  copySelectedKeys, pasteKeysAtPlayhead, deleteSelectedKeys, nudgeSelectedKeys,
  hasKeySelection, clearKeySelection,
} from './timeline';
import { exportCompose } from './exportCompose';
import { exportLottie } from './exportLottie';
import { undo, redo, canUndo, canRedo, resetHistory, setRestoreHandler } from './history';

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
    alert(`Could not import SVG: ${err instanceof Error ? err.message : err}`);
  }
}

function loadProjectText(text: string): boolean {
  try {
    state.doc = deserializeDoc(text);
    afterDocReplaced();
    return true;
  } catch (err) {
    alert(`Could not load project: ${err instanceof Error ? err.message : err}`);
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
    alert('Sample not found — copy PIP_MASTER.svg into public/');
    return;
  }
  loadSvgText(await res.text(), 'pip');
};

// ---- Project save / autosave ----

document.getElementById('btn-save')!.onclick = () => {
  if (!state.doc) {
    alert('Nothing to save yet.');
    return;
  }
  download(`${state.doc.name}.rig.json`, serializeDoc(state.doc), 'application/json');
};

function download(filename: string, content: string, type: string): void {
  const blob = new Blob([content], { type });
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

document.getElementById('btn-export')!.onclick = () => {
  if (!state.doc) {
    alert('Import an SVG first.');
    return;
  }
  const pkg =
    localStorage.getItem('rig-studio-package') ?? 'com.austinwasinger.dosey.ui.components';
  const packageName = prompt('Kotlin package for the generated file?', pkg);
  if (!packageName) return;
  localStorage.setItem('rig-studio-package', packageName);

  const kotlin = exportCompose(state.doc, packageName);
  const rigName = state.doc.name.replace(/[^A-Za-z0-9]/g, '');
  download(
    `${rigName.charAt(0).toUpperCase()}${rigName.slice(1)}Rig.kt`,
    kotlin,
    'text/plain',
  );
};

document.getElementById('btn-export-lottie')!.onclick = () => {
  if (!state.doc) {
    alert('Import an SVG first.');
    return;
  }
  try {
    const json = exportLottie(state.doc, state.activeClipIndex);
    download(`${state.doc.name}_${activeClip()?.name ?? 'clip'}.json`, json, 'application/json');
  } catch (err) {
    alert(`Lottie export failed: ${err instanceof Error ? err.message : err}`);
  }
};

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

function syncModeToggle(): void {
  setupBtn.classList.toggle('active', state.editorMode === 'setup');
  animateBtn.classList.toggle('active', state.editorMode === 'animate');
}

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
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;

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
    // fully undoable).
    if (
      state.editorMode === 'setup' && state.mode === 'rig' &&
      state.selectedPartIds.length > 0
    ) {
      ev.preventDefault();
      checkpoint();
      const removed = deleteParts([...state.selectedPartIds]);
      removed.forEach(unregisterPart);
      notify();
      renderPose();
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
    // Cancel bone placement first; then leave the "entered" path; then clear the
    // selection (and step out of any entered groups).
    if (cancelBonePlacement()) {
      notify();
      return;
    }
    if (state.selectedPathId) {
      state.selectedPathId = null;
    } else {
      clearGroupEntry();
      selectPart(null);
    }
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
  if (ev.key.toLowerCase() === 'f') {
    resetView();
    renderPose();
    return;
  }
  if (ev.key === ' ') {
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

// Console/debug hook: window.__rigStudio.exportCompose(window.__rigStudio.state.doc, "pkg")
declare global {
  interface Window {
    __rigStudio: {
      state: typeof state;
      exportCompose: typeof exportCompose;
      exportLottie: typeof exportLottie;
      renderPose: typeof renderPose;
      serializeDoc: typeof serializeDoc;
      loadProjectText: typeof loadProjectText;
      setEditorMode: typeof setEditorMode;
    };
  }
}
window.__rigStudio = {
  state, exportCompose, exportLottie, renderPose, serializeDoc, loadProjectText, setEditorMode,
};
