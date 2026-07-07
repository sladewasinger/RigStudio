import { state, notify, subscribe, activeClip } from './model';
import { importSvg } from './importSvg';
import { buildCanvas, renderPose } from './view';
import { buildLayersPanel, buildInspector } from './panels';
import { buildTimeline, render as renderTimeline, togglePlay } from './timeline';
import { exportCompose } from './exportCompose';
import { undo, redo, canUndo, canRedo, resetHistory, setRestoreHandler } from './history';

const layersEl = document.getElementById('layers')!;
const canvasEl = document.getElementById('canvas')!;
const inspectorEl = document.getElementById('inspector')!;
const timelineEl = document.getElementById('timeline')!;
const fileInput = document.getElementById('file-input') as HTMLInputElement;

function loadSvgText(text: string, name: string): void {
  try {
    state.doc = importSvg(text, name);
    state.selectedPartId = null;
    state.activeClipIndex = 0;
    state.currentTime = 0;
    state.playing = false;
    resetHistory(); // no undoing past a document swap
    buildCanvas(canvasEl);
    notify();
  } catch (err) {
    alert(`Could not import SVG: ${err instanceof Error ? err.message : err}`);
  }
}

document.getElementById('btn-open')!.onclick = () => fileInput.click();
fileInput.onchange = async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  loadSvgText(await file.text(), file.name);
  fileInput.value = '';
};

document.getElementById('btn-sample')!.onclick = async () => {
  const res = await fetch('/PIP_MASTER.svg');
  if (!res.ok) {
    alert('Sample not found — copy PIP_MASTER.svg into tools/rig-studio/public/');
    return;
  }
  loadSvgText(await res.text(), 'pip');
};

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
  const blob = new Blob([kotlin], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const rigName = state.doc.name.replace(/[^A-Za-z0-9]/g, '');
  a.download = `${rigName.charAt(0).toUpperCase()}${rigName.slice(1)}Rig.kt`;
  a.click();
  URL.revokeObjectURL(a.href);
};

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
  if (ev.key === ' ') {
    ev.preventDefault();
    togglePlay();
    return;
  }
  if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') {
    const clip = activeClip();
    if (!clip) return;
    ev.preventDefault();
    const step = (ev.shiftKey ? 100 : 10) * (ev.key === 'ArrowLeft' ? -1 : 1);
    state.currentTime = Math.min(clip.duration, Math.max(0, state.currentTime + step));
    renderPose();
    renderTimeline();
  }
});

// Re-render panels on every state change; the canvas pose is updated separately (and
// far more often) by renderPose().
subscribe(() => {
  buildLayersPanel(layersEl);
  buildInspector(inspectorEl);
  renderTimeline();
});

document.addEventListener('rig-play', () => {
  // The AI panel starts playback after applying a clip; the timeline owns the RAF loop,
  // so just re-render it with playing=true and let its play button state pick it up.
  renderTimeline();
  renderPose();
});

buildTimeline(timelineEl);
notify();

// Console/debug hook: window.__rigStudio.exportCompose(window.__rigStudio.state.doc, "pkg")
declare global {
  interface Window {
    __rigStudio: {
      state: typeof state;
      exportCompose: typeof exportCompose;
      renderPose: typeof renderPose;
    };
  }
}
window.__rigStudio = { state, exportCompose, renderPose };
