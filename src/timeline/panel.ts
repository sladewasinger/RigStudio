/**
 * Timeline panel composition: `buildTimeline` (called once from main.ts) wires the
 * shell + cross-cutting listeners, and `render()` rebuilds `tlCtx.bodyEl` from the
 * transport bar, key-property row, keyframe lanes, and (mode-dependent) the curve
 * editor or the state-machine `🔀 logic` panel — pulling each cluster from its own
 * layer (transport/lanes/keyProps) rather than building markup itself.
 *
 * Keyframe editing: click selects a diamond (Shift+click adds, drag on empty lane space
 * box-selects), dragging retimes the whole selection, double-click deletes. A property
 * row above the lanes edits the selected keys' time/value/easing. Ctrl+C / Ctrl+V copy
 * and paste keyframes at the playhead (wired from main.ts), arrow keys nudge them.
 *
 * The whole panel is disabled in Setup mode — keyframes only exist in Animate mode.
 */

import { state, activeClip, Keyframe } from '../core/model';
import { renderPose } from '../view';
import { buildGraphPanel, onGraphChange } from './graph';
import { buildSMPanel, stopPreview, setLogicVisible } from '../panels/smPanel';
import { tlCtx, setupShell, div, divider } from './tlState';
import { buildTransportBar, startPlayback } from './transport';
import { buildLanesPanel } from './lanes';
import { buildKeyBar } from './keyProps';
import './timeline.css';

export function buildTimeline(el: HTMLElement): void {
  tlCtx.container = el;
  setupShell();
  document.addEventListener('rig-keys-changed', render);
  // Curve-editor mutations preview live on the canvas.
  onGraphChange(() => {
    renderPose();
  });
  // Fired by the AI panel after applying a clip with playing=true.
  document.addEventListener('rig-play', () => {
    if (state.playing) startPlayback();
  });
  render();
}

export function render(): void {
  if (!tlCtx.container || !tlCtx.bodyEl) return;
  tlCtx.bodyEl.innerHTML = '';
  tlCtx.container.classList.toggle('disabled', state.editorMode !== 'animate');
  // The logic (state-machine) view + its live preview only exist in Animate mode with a
  // doc. Any time it is NOT on screen, tear the preview down (restores the pose sampler).
  const showingLogic = !!state.doc && state.editorMode === 'animate' && tlCtx.panelMode === 'logic';
  if (!showingLogic) {
    stopPreview();
    setLogicVisible(false);
  }
  const doc = state.doc;
  if (!doc) {
    tlCtx.bodyEl.innerHTML = '<div class="tl-empty">Import an SVG to start animating.</div>';
    return;
  }
  if (state.editorMode !== 'animate') {
    const note = div('tl-setup-note');
    note.innerHTML =
      'Edit mode — you are editing the character\'s rest pose, pivots, and paths. ' +
      'Switch to <b>Animate</b> (top right) to record keyframes.';
    tlCtx.bodyEl.appendChild(note);
    return;
  }
  const clip = activeClip();

  // Prune selection: drop keys that no longer exist (deleted, undone, clip switched).
  if (clip) {
    const live = new Set<Keyframe>();
    tlCtx.trackOfKey = new WeakMap();
    for (const track of clip.tracks) {
      for (const key of track.keyframes) {
        tlCtx.trackOfKey.set(key, track);
        if (tlCtx.selectedKeys.has(key)) live.add(key);
      }
    }
    tlCtx.selectedKeys = live;
  } else {
    tlCtx.selectedKeys.clear();
  }
  tlCtx.diamondEls = [];

  tlCtx.bodyEl.appendChild(buildTransportBar(doc, clip));
  tlCtx.bodyEl.appendChild(divider());

  // Logic view swaps the whole lanes area for the state-machine editor (mutually
  // exclusive with curves; needs no clip, so it precedes the no-clip bail-out).
  if (tlCtx.panelMode === 'logic') {
    setLogicVisible(true);
    const smHost = div('sm-panel-host');
    tlCtx.bodyEl.appendChild(smHost);
    buildSMPanel(smHost);
    return;
  }

  if (!clip) return;

  tlCtx.bodyEl.appendChild(buildKeyBar());
  tlCtx.bodyEl.appendChild(divider());

  tlCtx.bodyEl.appendChild(buildLanesPanel(clip));

  if (tlCtx.panelMode === 'curves') {
    tlCtx.bodyEl.appendChild(divider());
    const graphHost = div('graph-panel');
    const first = [...tlCtx.selectedKeys][0];
    const track = (first && tlCtx.trackOfKey.get(first)) ?? clip.tracks[0] ?? null;
    buildGraphPanel(graphHost, track, clip.duration);
    tlCtx.bodyEl.appendChild(graphHost);
  }
}

// Installed so transport/lanes/keyProps can trigger a full panel re-render without
// importing this top layer back (which would cycle) — see tlState.ts's tlCtx.rerender.
tlCtx.rerender = render;
