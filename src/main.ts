import {
  state, notify, subscribe, activeClip, serializeDoc, deserializeDoc,
  selectPart, partById, newBlankDoc, markClean, RigPart,
} from './core/model';
import { importSvg } from './io/importSvg';
import {
  buildCanvas, renderPose, resetView, cancelBonePlacement,
  enterGroupsFor, clearGroupEntry, resetInteractionState, resetSkinRenderWarnings,
  artworkUnderPointer,
} from './view';
import { buildLayersPanel, buildInspector, buildCanvasTools } from './panels';
import { buildTimeline, render as renderTimeline, clearKeySelection } from './timeline/timeline';
import { exportLottie } from './io/exportLottie';
import { exportRiv } from './io/riv';
import { stopPreview } from './panels/smPanel';
import { undo, redo, canUndo, canRedo, resetHistory, setRestoreHandler } from './core/history';
import { toggleHelp } from './ui/help';
import { installShortcuts, setEditorMode, saveProject, saveProjectAs } from './ui/shortcuts';
import { dialog } from './ui/dialogs';
import { showContextMenu } from './ui/contextMenu';
import { buildPartContextMenu } from './ui/actions';
import { buildPathContextMenu } from './ui/pathActions';
import { download } from './ui/download';
import { exportPngFlow, exportSvgFlow, canExportImage } from './ui/imageExport';
import { buildEmptyState } from './ui/emptyState';
import { wireOpenButton } from './ui/openFlow';
import './pwa';

const layersEl = document.getElementById('layers')!;
const canvasEl = document.getElementById('canvas')!;
const canvasToolsEl = document.getElementById('canvas-tools')!;
const inspectorEl = document.getElementById('inspector')!;
const timelineEl = document.getElementById('timeline')!;

// BOOT-ORDER FIX (2026-07-13 giant-chrome regression): #layout's CSS grid
// (style.css) declares FOUR columns — `var(--layers-width,200px) 6px 1fr 260px` —
// where the 6px column exists only for the `#layers-splitter` div that
// `buildLayersPanel` (via `ensureLayersSplitter`, panels/layersResize.ts) inserts as
// #layers' next sibling. That insertion normally happens on the first `notify()`.
// But every doc-loading path (the autosave restore below, and afterDocReplaced for
// New/Open/Load-sample) calls buildCanvas() — a synchronous render-then-measure pass
// (view/canvas.ts's pivot seeding, plus the first renderPose()) — BEFORE its own
// trailing notify(). If state.doc is already set the FIRST time buildCanvas() ever
// runs in a page session (precisely the autosave-restore case just below), #layout
// still has only 3 static children, so implicit grid auto-placement squeezes
// #canvas-col into the splitter's 6px column instead of `1fr` — handleSize()/
// screenScaleOf() (view/coords.ts) then bake wildly oversized radii into every
// overlay chrome element (pivot ghosts, bone kites, gizmos) for that one render; they
// stay wrong until the next renderPose() (any zoom/pan/click) recomputes them —
// exactly the reported "giant translucent circles/blob, self-healing on first
// interaction" bug. Calling buildLayersPanel() here — idempotent, doc-independent
// (ensureLayersSplitter runs before its `if (!doc) return`) — inserts the splitter
// and fixes the grid before ANY buildCanvas() call can ever measure it degenerate.
buildLayersPanel(layersEl);

const AUTOSAVE_KEY = 'rig-studio-autosave';

/**
 * The single doc-swap path (New / Open / Load sample / loadProjectText, incl. the
 * autosave-driven interaction-test harness's resetRig). Resets EVERY piece of
 * session-only editing state, not just the doc-level selection: a confirmed live bug
 * had `state.mode` ('nodes') and `state.selectedPathId` survive Load Sample into the
 * fresh doc (a stale path id from the OLD doc). Order: tear down anything that still
 * references the old doc (SM preview, entered groups, in-flight drag/node selection,
 * an armed bone placement) BEFORE buildCanvas discards the old DOM.
 */
function afterDocReplaced(): void {
  state.selectedPartId = null;
  state.selectedPartIds = [];
  state.selectedPathId = null;
  state.mode = 'rig'; // no node/path scope survives a doc swap — the old ids are gone
  state.freezeMode = false; // momentary app state (CLAUDE.md) — never carries across docs
  state.activeClipIndex = 0;
  state.currentTime = 0;
  state.playing = false;
  state.projectFileHandle = null; // D1: a fresh/replaced doc has no on-disk file yet —
  // openFlow.ts re-establishes it right after for a project (.json) open.
  clearKeySelection();
  clearGroupEntry(); // entered-group ids from the old doc don't resolve in the new one
  cancelBonePlacement(); // an armed placement mid-gesture makes no sense across a swap
  resetInteractionState(); // node selection, in-flight drag, handle mode, snap marker
  // A running SM preview owns the OLD doc's SMInstance AND capture-phase listeners on
  // #canvas that survive buildCanvas (the container itself isn't recreated) — left
  // running, every canvas click after the swap is silently swallowed (zombie input).
  stopPreview();
  resetSkinRenderWarnings(); // a fresh doc's parts get their own first warning, never
  // silently suppressed by a same-id part from a prior document.
  resetHistory(); // no undoing past a document swap
  buildCanvas(canvasEl);
  resetView(); // fit the fresh document (zoom/pan otherwise survives rebuilds)
  markClean(); // a freshly loaded/blank doc has no unsaved edits yet
  notify();
}

/** Unsaved-changes guard for every doc-REPLACING UI action (New / Open / Load
 *  sample): confirm only when there's something to lose. Deliberately NOT called by
 *  loadProjectText/loadSvgText themselves — those are also the programmatic path
 *  (window.__rigStudio.loadProjectText, the interaction-test harness's resetRig)
 *  which must swap docs silently. */
async function confirmReplaceIfDirty(): Promise<boolean> {
  if (!state.dirty) return true;
  return dialog.confirm(
    'You have unsaved changes — replace the current project?',
    { title: 'Replace project', okText: 'Replace' },
  );
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

/** File → New: replace the current document with a fresh blank one (confirming first if
 *  there's work to lose), through the SAME afterDocReplaced path Open uses. The debounced
 *  autosave then overwrites the saved session with the blank doc — it IS the current doc. */
async function newProject(): Promise<void> {
  if (!(await confirmReplaceIfDirty())) return;
  state.doc = newBlankDoc();
  state.editorMode = 'setup';
  afterDocReplaced();
}
document.getElementById('btn-new')!.onclick = () => { void newProject(); };

// D1: the storage interface (io/storage) owns file picking — no page-level <input
// type=file> to wire up (ui/openFlow.ts's downloadFallbackStorage creates its own
// transient one per call, decoupling the picker from any specific page markup).
wireOpenButton(document.getElementById('btn-open') as HTMLButtonElement, {
  confirmReplaceIfDirty, loadProjectText, loadSvgText,
});

document.getElementById('btn-sample')!.onclick = async () => {
  if (!(await confirmReplaceIfDirty())) return;
  const res = await fetch(`${import.meta.env.BASE_URL}PIP_MASTER.svg`);
  if (!res.ok) {
    void dialog.alert('Sample not found — copy PIP_MASTER.svg into public/');
    return;
  }
  loadSvgText(await res.text(), 'pip');
};

// ---- Project save / autosave ----
// saveProject/saveProjectAs (the toolbar Save/Save As buttons and Ctrl+S/Ctrl+Shift+S)
// live in ./ui/shortcuts now.

document.getElementById('btn-save')!.onclick = () => { void saveProject(); };
document.getElementById('btn-save-as')!.onclick = () => { void saveProjectAs(); };

let autosaveTimer = 0;
function scheduleAutosave(): void {
  if (!state.doc) return;
  window.clearTimeout(autosaveTimer);
  autosaveTimer = window.setTimeout(() => {
    if (state.doc) localStorage.setItem(AUTOSAVE_KEY, serializeDoc(state.doc));
  }, 800);
}
// Autosave to localStorage unconditionally (never loses data on close), and ADDITIONALLY
// warn via the browser's native prompt when there are unsaved changes relative to the
// last project save/replace (state.dirty) — the autosave slot round-trips on reload, but
// it isn't the same as the user's own "Save project" .rig.json, and closing without either
// discards undo history. preventDefault() + returnValue is the standard cross-browser
// pattern; the string content of returnValue is ignored by modern browsers (they show
// their own fixed wording), but is set for older-browser compatibility.
window.addEventListener('beforeunload', (ev: BeforeUnloadEvent) => {
  if (state.doc) localStorage.setItem(AUTOSAVE_KEY, serializeDoc(state.doc));
  if (state.dirty) {
    ev.preventDefault();
    ev.returnValue = '';
  }
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

const exportPngBtn = document.getElementById('btn-export-png') as HTMLButtonElement;
const exportSvgBtn = document.getElementById('btn-export-svg') as HTMLButtonElement;
exportPngBtn.onclick = () => { void exportPngFlow(); };
exportSvgBtn.onclick = () => { void exportSvgFlow(); };

/** No document loaded → still-image export has nothing to render; disable rather
 *  than pop an alert (mirrors the undo/redo button pattern below). */
function syncExportImageButtons(): void {
  const enabled = canExportImage();
  exportPngBtn.disabled = !enabled;
  exportSvgBtn.disabled = !enabled;
}

// ---- Setup / Animate mode toggle ----

const setupBtn = document.getElementById('btn-mode-setup') as HTMLButtonElement;
const animateBtn = document.getElementById('btn-mode-animate') as HTMLButtonElement;
// setEditorMode (Tab's action too) lives in ./ui/shortcuts now.

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

/**
 * A right-click resolves to a PATH context (not just the part) exactly where a
 * double-click would already drill down to a path: the part is already the primary
 * selection (`enterGroupsFor` already opened its ancestor groups the first time it was
 * picked, whether via this same handler, a Layers row, or a canvas dblclick — see
 * `focus.ts`'s `artworkUnderPointer`/dblclick drill logic, reused rather than
 * re-implemented), so a right-click on the SAME already-entered part's fill scopes to
 * that path; a right-click on a not-yet-selected part falls through to the part menu
 * below (which selects it — a second right-click there then reaches the path).
 */
function pathContextAt(ev: MouseEvent): { part: RigPart; pathId: string } | null {
  if (state.editorMode !== 'setup') return null;
  const hit = artworkUnderPointer(ev);
  const pathId = hit?.pathEl?.dataset.pathId;
  if (!hit || !pathId || state.selectedPartId !== hit.part.id) return null;
  return { part: hit.part, pathId };
}

// Capture phase per the assignment's spec; contextmenu only fires on a real right-click,
// so this can never interfere with the interaction-test suite's synthetic pointer
// gestures (which only dispatch pointerdown/move/up and click/dblclick). Native-menu
// suppression is the ui/contextMenu.ts chokepoint's job — this listener only decides
// WHICH in-app menu (if any) to show.
canvasEl.addEventListener('contextmenu', (ev) => {
  const pathHit = pathContextAt(ev);
  if (pathHit) {
    const path = pathHit.part.paths.find((p) => p.id === pathHit.pathId);
    if (path) {
      selectPart(pathHit.part.id);
      state.selectedPathId = pathHit.pathId;
      notify();
      renderPose();
      showContextMenu(buildPathContextMenu(pathHit.part, path, ev.clientX, ev.clientY), ev.clientX, ev.clientY);
      return;
    }
  }
  const partId = hitPartIdAt(ev.clientX, ev.clientY);
  if (!partId) return; // blank canvas — the chokepoint already suppressed the native menu
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
// The whole keydown handler (registry + the two Delete/Escape priority cascades + the
// early ownership guards) lives in ./ui/shortcuts (Pattern-driven redesign pass) — this
// is main.ts's entire keyboard wiring.
installShortcuts();

// Re-render panels on every state change; the canvas pose is updated separately (and
// far more often) by renderPose().
subscribe(() => {
  syncModeToggle();
  syncExportImageButtons();
  buildLayersPanel(layersEl);
  buildCanvasTools(canvasToolsEl);
  buildInspector(inspectorEl);
  renderTimeline();
  scheduleAutosave();
  // buildCanvas() (which populates #canvas for a real doc, clearing it first) only runs
  // on doc replace/undo-redo, not on every notify() — so this is the one place that
  // needs its own empty-state check rather than delegating to a panel's own build
  // function. Cleared+rebuilt every notify() while doc stays null (cheap, idempotent) so
  // repeated notifications never stack duplicate CTAs.
  if (!state.doc) {
    canvasEl.innerHTML = '';
    buildEmptyState(canvasEl, 'No document loaded — open an SVG, load the sample, or start a new project.');
  }
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
    markClean(); // restoring the autosave slot IS the durable state — nothing unsaved yet
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
